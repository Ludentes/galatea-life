import { afterEach, describe as group, expect, it, vi } from "vitest";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import * as globalStore from "zigbee-herdsman-converters/lib/store";
import { describe, NAMESPACE } from "../src/herdsman/describe.js";
import { overrideFor } from "../src/herdsman/overrides.js";
import { type Heard, Pipeline, REPEAT_MS } from "../src/herdsman/pipeline.js";
import { FakeClock } from "./fakes.js";
import { datapoints, devices, message, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices> | undefined;
afterEach(() => { db?.close(); db = undefined; vi.useRealTimers(); });

const SENSOR_CAP = `${NAMESPACE}.ts0210`;
const PUSHER_CAP = `${NAMESPACE}.ts0001_fingerbot`;

/** A pipeline reading the bench's two models, each described as the doer describes it; its late publishes and exposes changes kept. */
async function pipeline() {
  db = devices([SENSOR_ROW, PUSHER_ROW]);
  const clock = new FakeClock();
  const late: Heard[] = [];
  const changed: string[] = [];
  const p = new Pipeline({ clock, late: (h) => late.push(h), exposesChanged: (hw) => changed.push(hw) });
  for (const ieee of [SENSOR, PUSHER]) {
    const device = db.get(ieee);
    const definition = (await findByDevice(device, true))!;
    const override = overrideFor(definition.model);
    // The Tuya custom clusters, as the definition's `start` adds them.
    await definition.onEvent?.({ type: "start", data: { device, state: {}, options: {}, deviceExposesChanged: () => {} } });
    p.set(ieee, { definition, keys: (await describe(device, definition, { override })).keys, ...(override ? { override } : {}) });
  }
  return { p, clock, late, changed, sensor: db.get(SENSOR), pusher: db.get(PUSHER) };
}

const statusChange = (device: Parameters<typeof message>[0], tsn: number, zonestatus: number) =>
  message(device, { cluster: "ssIasZone", command: "statusChangeNotification", tsn, payload: { zonestatus, extendedstatus: 0, zoneID: 23, delay: 0 } });

group("Pipeline: a device's messages through its converters", () => {
  it("reads the button pusher's datapoint report as its keys, stamped with when it came, a check-in", async () => {
    const { p, clock, pusher } = await pipeline();
    const h = await p.message(datapoints(pusher, 11, [[101, 4, [1]], [102, 2, [0, 0, 0, 80]], [104, 4, [1]]]) as never);
    expect(h).toEqual({ hardwareId: PUSHER, time: clock.now(), readings: { [`${PUSHER_CAP}.mode`]: "switch", [`${PUSHER_CAP}.lower`]: 80,
      [`${PUSHER_CAP}.reverse`]: "ON" }, occurrences: [], frameId: expect.stringMatching(/^1\/manuSpecificTuya\/11\/[0-9a-f]{16}$/), undescribed: [],
      checkIn: true });
  });

  it("reads a genOnOff report as onoff's key", async () => {
    const { p, pusher } = await pipeline();
    const h = await p.message(message(pusher, { cluster: "genOnOff", command: "report", global: true, tsn: 12,
      payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never);
    expect(h!.readings).toEqual({ on: true });
  });

  it("names the datapoints its definition does not know, and a value of no scalar, undescribed (GA-BRIDGE-76)", async () => {
    const { p, pusher } = await pipeline();
    const h = await p.message(datapoints(pusher, 13, [[108, 1, [0]], [121, 1, [1]], [109, 0, [255, 255, 255, 0]], [105, 2, [0, 0, 0, 33]]]) as never);
    expect(h!.readings).toEqual({ battery: 33 });
    expect(h!.undescribed.sort()).toEqual(["dp108", "dp121", "program"]);
  });

  it("makes the vibration sensor's status change an occurrence, its zone bits readings, and drops its converter's timed vibration: false", async () => {
    vi.useFakeTimers();
    const { p, sensor, late } = await pipeline();
    const h = await p.message(statusChange(sensor, 40, 1025) as never);
    expect(h!.occurrences).toEqual([{ key: `${SENSOR_CAP}.vibration`, value: true }]);
    expect(h!.readings).toEqual({ [`${SENSOR_CAP}.tamper`]: false, battery_low: false });
    // The converter publishes vibration: false 90 s later, from its own timer: no message of the device's.
    await vi.advanceTimersByTimeAsync(91_000);
    expect(late).toEqual([]);
  });

  it("names an attribute report on a cluster no converter takes, housekeeping clusters aside", async () => {
    const { p, sensor } = await pipeline();
    const report = (cluster: string, attrId: number, tsn: number) =>
      message(sensor, { cluster, command: "report", global: true, tsn, payload: [{ attrId, dataType: 32, attrData: 7 }] });
    expect((await p.message(report("ssIasZone", 0x0000, 41) as never))!.undescribed).toEqual(["ssIasZone.zoneState"]);
    const basic = await p.message(report("genBasic", 0x0001, 42) as never);
    expect(basic).toMatchObject({ undescribed: [], readings: {}, checkIn: true });
  });

  it("takes a frame repeated with the same transaction and bytes within REPEAT_MS once, and the same transaction with other bytes again (spike S7)", async () => {
    const { p, clock, sensor } = await pipeline();
    expect(await p.message(statusChange(sensor, 50, 1025) as never)).toBeDefined();
    await clock.advance(1_000);
    expect(await p.message(statusChange(sensor, 50, 1025) as never)).toBeUndefined();
    // A device restarts its numbering after a rejoin: the same number on other content is another message.
    expect((await p.message(statusChange(sensor, 50, 2049) as never))!.occurrences).toHaveLength(1);
    await clock.advance(REPEAT_MS);
    expect(await p.message(statusChange(sensor, 50, 1025) as never)).toBeDefined();
  });

  it("reads nothing from a device it does not describe", async () => {
    const { p, sensor } = await pipeline();
    p.delete(SENSOR);
    expect(await p.message(statusChange(sensor, 60, 1025) as never)).toBeUndefined();
  });
});

group("Pipeline: the converters' own ways", () => {
  /** The button pusher's entry with its converters replaced by `fromZigbee`. */
  async function made(fromZigbee: unknown[]) {
    const r = await pipeline();
    const definition = { ...(await findByDevice(r.pusher, true))!, fromZigbee } as Definition;
    const keys = (await describe(r.pusher, definition, { override: overrideFor(definition.model) })).keys;
    r.p.set(PUSHER, { definition, keys, override: overrideFor(definition.model)! });
    return r;
  }
  const onOff = (tsn: number, v: number) => (pusher: Parameters<typeof message>[0]) =>
    message(pusher, { cluster: "genOnOff", command: "report", global: true, tsn, payload: [{ attrId: 0, dataType: 16, attrData: v }] });

  it("drops a throwing converter's output and keeps the others' (GA-BRIDGE-9)", async () => {
    const { p, pusher } = await made([
      { cluster: "genOnOff", type: "attributeReport", convert: () => { throw new Error("bad frame"); } },
      { cluster: "genOnOff", type: "attributeReport", convert: () => ({ state: "ON" }) },
    ]);
    expect((await p.message(onOff(70, 1)(pusher) as never))!.readings).toEqual({ on: true });
  });

  it("stamps a converter's later publish with its message's time, as no check-in, and hands the converters their own state", async () => {
    let publishLater: ((x: Record<string, unknown>) => void) | undefined;
    const states: unknown[] = [];
    const { p, clock, pusher, late } = await made([{ cluster: "genOnOff", type: "attributeReport",
      convert: (_m: unknown, msg: { data: { onOff: number } }, publish: (x: Record<string, unknown>) => void, _o: unknown, meta: { state: unknown }) => {
        states.push({ ...(meta.state as object) });
        publishLater = publish;
        return { state: msg.data.onOff ? "ON" : "OFF" };
      } }]);
    const at = clock.now();
    await p.message(onOff(71, 1)(pusher) as never);
    await clock.advance(5_000);
    publishLater!({ state: "OFF", mode: "click" });
    expect(late).toEqual([{ hardwareId: PUSHER, time: at, readings: { on: false, [`${PUSHER_CAP}.mode`]: "click" }, occurrences: [],
      frameId: expect.stringMatching(/^1\/genOnOff\/71\/[0-9a-f]{16}$/), undescribed: [], checkIn: false }]);
    await p.message(onOff(72, 0)(pusher) as never);
    expect(states).toEqual([{}, { state: "ON" }]);
  });

  it("tells the doer when a converter says the device's exposes changed", async () => {
    const { p, pusher, changed } = await made([{ cluster: "genOnOff", type: "attributeReport",
      convert: (_m: unknown, _msg: unknown, _p: unknown, _o: unknown, meta: { deviceExposesChanged(): void }) => { meta.deviceExposesChanged(); } }]);
    await p.message(onOff(73, 1)(pusher) as never);
    expect(changed).toEqual([PUSHER]);
  });
});

group("Pipeline: the plan 2c-1 review's findings", () => {
  it("reads a frame that reuses a transaction number with other bytes within REPEAT_MS: the converters' own repeat check is off (I2)", async () => {
    const { p, clock, pusher } = await pipeline();
    const a = await p.message(datapoints(pusher, 20, [[101, 4, [0]]]) as never);
    await clock.advance(1_000);
    const b = await p.message(datapoints(pusher, 20, [[101, 4, [1]]]) as never);
    expect(a!.readings).toEqual({ [`${PUSHER_CAP}.mode`]: "click" });
    expect(b!.readings).toEqual({ [`${PUSHER_CAP}.mode`]: "switch" });
  });

  it("names a message by its endpoint, cluster, transaction number and a hash of its bytes, so the core's repeat check keeps both (I2)", async () => {
    const { p, sensor } = await pipeline();
    const a = await p.message(statusChange(sensor, 30, 1) as never);
    const b = await p.message(statusChange(sensor, 30, 5) as never);
    expect(a!.frameId).toMatch(/^1\/ssIasZone\/30\/[0-9a-f]{16}$/);
    expect(b!.frameId).toMatch(/^1\/ssIasZone\/30\/[0-9a-f]{16}$/);
    expect(a!.frameId).not.toBe(b!.frameId);
    expect(a!.occurrences).toEqual(b!.occurrences);
  });

  it("drops a reading the override names as a duplicate by another path, its message still a check-in (GA-BRIDGE-76, 37)", async () => {
    const { p, sensor } = await pipeline();
    const light = (tsn: number) => message(sensor, { cluster: "msIlluminanceMeasurement", command: "report", global: true, tsn,
      payload: [{ attrId: 0x0000, dataType: 0x21, attrData: 1000 }] });
    expect((await p.message(light(50) as never))!.undescribed).toEqual(["msIlluminanceMeasurement.measuredValue"]);
    const definition = (await findByDevice(sensor, true))!;
    const override = { ...overrideFor(definition.model)!, duplicates: ["msIlluminanceMeasurement.measuredValue"] };
    p.set(SENSOR, { definition, keys: (await describe(sensor, definition, { override })).keys, override });
    const h = await p.message(light(51) as never);
    expect(h!.undescribed).toEqual([]);
    expect(h!.checkIn).toBe(true);
  });

  it("reads the vibration sensor's sensitivity report as its declared key, not undescribed (I3)", async () => {
    const { p, sensor } = await pipeline();
    const h = await p.message(message(sensor, { cluster: "ssIasZone", command: "report", global: true, tsn: 40,
      payload: [{ attrId: 0x0013, dataType: 0x20, attrData: 20 }] }) as never);
    expect(h!.readings).toEqual({ [`${SENSOR_CAP}.sensitivity`]: 20 });
    expect(h!.undescribed).toEqual([]);
  });

  it("leaves out a reading outside its key's schema, and reads the vibration sensor's sensitivity of 200, its own range (GA-BRIDGE-1; plan 2c-2 review M3)", async () => {
    const { p, sensor, pusher } = await pipeline();
    const sensitivity = (tsn: number, level: number) => message(sensor, { cluster: "ssIasZone", command: "report", global: true, tsn,
      payload: [{ attrId: 0x0013, dataType: 0x20, attrData: level }] });
    const high = await p.message(sensitivity(42, 201) as never);
    expect(high!.readings).toEqual({});
    expect(high!.undescribed).toEqual([]);
    // Set by another controller beyond the 0 to 50 its converter declares: reported, never stale.
    expect((await p.message(sensitivity(43, 200) as never))!.readings).toEqual({ [`${SENSOR_CAP}.sensitivity`]: 200 });
    expect((await p.message(sensitivity(44, 50) as never))!.readings).toEqual({ [`${SENSOR_CAP}.sensitivity`]: 50 });
    // The key's schema is the expose's: the button pusher's program mode is read, though its set is not offered.
    expect((await p.message(datapoints(pusher, 45, [[101, 4, [2]]]) as never))!.readings).toEqual({ [`${PUSHER_CAP}.mode`]: "program" });
  });

  it("makes no occurrence of a zone status with the alarm bit clear, and sets the converter no timer (M5)", async () => {
    const { p, sensor } = await pipeline();
    const h = await p.message(statusChange(sensor, 41, 4) as never);
    expect(h!.occurrences).toEqual([]);
    expect(h!.readings).toEqual({ [`${SENSOR_CAP}.tamper`]: true, battery_low: false });
    expect(globalStore.getValue(sensor.getEndpoint(1)!, "timers")).toEqual([]);
  });

  it("drops a converter's later publish of a key the override names (dropLate)", async () => {
    const r = await pipeline();
    let publishLater: ((x: Record<string, unknown>) => void) | undefined;
    const definition = { ...(await findByDevice(r.pusher, true))!, fromZigbee: [{ cluster: "genOnOff", type: "attributeReport",
      convert: (_m: unknown, _msg: unknown, publish: (x: Record<string, unknown>) => void) => { publishLater = publish; return { state: "ON" }; } }] } as
      unknown as Definition;
    const override = { ...overrideFor(definition.model)!, dropLate: ["state"] };
    r.p.set(PUSHER, { definition, keys: (await describe(r.pusher, definition, { override })).keys, override });
    await r.p.message(message(r.pusher, { cluster: "genOnOff", command: "report", global: true, tsn: 74,
      payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never);
    publishLater!({ state: "OFF", mode: "click" });
    expect(r.late.map((h) => h.readings)).toEqual([{ [`${PUSHER_CAP}.mode`]: "click" }]);
  });
});
