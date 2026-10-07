import { afterEach, describe as group, expect, it } from "vitest";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { NAMESPACE } from "../src/herdsman/describe.js";
import type { Override } from "../src/herdsman/overrides.js";
import type { Description } from "../src/port.js";
import { FakeClock } from "./fakes.js";
import { core } from "./herdsman-fakes.js";
import { CLIMATE_SENSOR, CLIMATE_SENSOR_ROW, datapoints, devices, message, PUSHER, PUSHER_ROW, row, SENSOR,
  SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices> | undefined;
afterEach(() => { db?.close(); db = undefined; });

const PUSHER_CAP = `${NAMESPACE}.ts0001_fingerbot`;
const MODE = `${PUSHER_CAP}.mode`;

/** The devices over the bench's two models, the core recording what it hears; `wrap` changes a definition as it is found. */
function setup(o: { wrap?: (d: Definition) => Definition; rows?: Record<string, unknown>[]; override?: Override } = {}) {
  db = devices(o.rows ?? [SENSOR_ROW, PUSHER_ROW]);
  const clock = new FakeClock();
  const { events, seen } = core();
  const hooks: string[] = [];
  const layer = new HerdsmanDevices({
    clock, events: () => events,
    ...(o.override ? { overrideOf: () => o.override } : {}),
    definitionOf: async (d) => {
      const def = (await findByDevice(d, true))!;
      const wrapped = o.wrap ? o.wrap(def) : def;
      const inner = wrapped.onEvent;
      return { ...wrapped, onEvent: async (e) => { hooks.push(`${d.ieeeAddr} ${e.type}`); await inner?.(e); } } as Definition;
    },
  });
  const d = db;
  return { layer, clock, seen, hooks, get sensor() { return d.get(SENSOR); }, get pusher() { return d.get(PUSHER); } };
}

const kinds = (seen: unknown[][]) => seen.map((e) => e[0]);
const descriptions = (seen: unknown[][]) => seen.filter((e) => e[0] === "described").map((e) => e[1] as Description);

group("HerdsmanDevices: describing what herdsman has", () => {
  it("describes an interviewed device after telling its converters start, with the actions the doer carries out (plan 2c-2)", async () => {
    const { layer, seen, hooks, pusher } = setup();
    await layer.add(pusher);
    expect(hooks).toEqual([`${PUSHER} start`]);
    const [d] = descriptions(seen);
    expect(d).toMatchObject({ hardwareId: PUSHER, capabilities: ["onoff", "sensor"], reachMs: 2500 });
    // Its onoff waits for its mode to be observed (GA-BRIDGE-74); its own settings are offered.
    expect(d!.actions.map((a) => a.action)).toEqual(["mode", "lower", "upper", "delay", "reverse", "touch"].map((x) => `${PUSHER_CAP}.set_${x}`));
    expect(d).toEqual(layer.description(PUSHER));
  });

  it("leaves a device whose interview did not succeed, and the coordinator, undescribed", async () => {
    const { layer, seen } = setup({ rows: [{ ...SENSOR_ROW, interviewState: "FAILED", interviewCompleted: false }] });
    await layer.add(db!.get(SENSOR));
    expect(seen).toEqual([]);
  });

  it("describes a device from the settings the core kept across the restart (GA-BRIDGE-74)", async () => {
    const { layer, pusher } = setup();
    layer.keep(new Map([[PUSHER, { [MODE]: "click" }]]));
    await layer.add(pusher);
    expect(layer.description(PUSHER)!.actions.filter((a) => a.action.startsWith("onoff.") || a.action.endsWith(".press")).map((a) => [a.action.split(".").pop(), a.stateless])).toEqual([["press", true]]);
  });

  it("forgets the kept settings of a device interviewed again, and declares by their worst case (GA-BRIDGE-79)", async () => {
    const { layer, pusher } = setup();
    layer.keep(new Map([[PUSHER, { [MODE]: "switch" }]]));
    await layer.add(pusher);
    expect(layer.description(PUSHER)!.actions.some((a) => a.action === "onoff.turn_on")).toBe(true);
    await layer.add(pusher, true);
    expect(layer.description(PUSHER)!.actions.some((a) => a.action === "onoff.turn_on")).toBe(false);
  });

  it("sends no description again for the same hardware unchanged, as after a controller's close", async () => {
    const { layer, seen, hooks, pusher } = setup();
    await layer.add(pusher);
    await layer.clear();
    await layer.add(pusher);
    expect(kinds(seen)).toEqual(["described"]);
    expect(hooks).toEqual([`${PUSHER} start`, `${PUSHER} stop`, `${PUSHER} start`]);
  });
});

group("HerdsmanDevices: what the devices say", () => {
  it("tells the core a message's readings, occurrences and undescribed names, in that order", async () => {
    const { layer, seen, clock, sensor } = setup();
    await layer.add(sensor);
    seen.length = 0;
    await layer.heard(message(sensor, { cluster: "ssIasZone", command: "statusChangeNotification", tsn: 5,
      payload: { zonestatus: 1025, extendedstatus: 0, zoneID: 1, delay: 0 } }) as never);
    const cap = `${NAMESPACE}.ts0210`;
    expect(seen).toEqual([
      ["observed", SENSOR, { [`${cap}.tamper`]: false, battery_low: false }, clock.now(), true],
      ["occurred", SENSOR, `${cap}.vibration`, true, clock.now(), expect.stringMatching(/^1\/ssIasZone\/5\/[0-9a-f]{16}$/)],
    ]);
    await layer.heard(message(sensor, { cluster: "ssIasZone", command: "report", global: true, tsn: 6,
      payload: [{ attrId: 0x0000, dataType: 48, attrData: 1 }] }) as never);
    expect(seen.slice(2)).toEqual([["observed", SENSOR, {}, clock.now(), true], ["undescribed", SENSOR, ["ssIasZone.zoneState"]]]);
  });

  it("declares an awaited key before the observation that carries its first value, and keeps it declared (GA-BRIDGE-80)", async () => {
    const { layer, seen } = setup({ rows: [CLIMATE_SENSOR_ROW], override: { awaited: ["temperature", "humidity"] } });
    const climate = db!.get(CLIMATE_SENSOR);
    await layer.add(climate);
    expect(layer.description(CLIMATE_SENSOR)!.awaitedKeys).toEqual(["temperature", "humidity"]);
    seen.length = 0;
    const report = (tsn: number, centi: number) => message(climate, { cluster: "msTemperatureMeasurement", command: "report", global: true, tsn,
      payload: [{ attrId: 0x0000, dataType: 41, attrData: centi }] });
    await layer.heard(report(7, 2150) as never);
    expect(kinds(seen)).toEqual(["described", "observed"]);
    expect(descriptions(seen)[0]!.awaitedKeys).toEqual(["humidity"]);
    expect(descriptions(seen)[0]!.sensorKeys).toContain("temperature");
    expect(seen[1]![2]).toMatchObject({ temperature: 21.5 });
    await layer.heard(report(8, 2200) as never);
    expect(kinds(seen)).toEqual(["described", "observed", "observed"]);
  });

  it("declares a key the core kept as reported across the restart (GA-BRIDGE-80)", async () => {
    const { layer } = setup({ rows: [CLIMATE_SENSOR_ROW], override: { awaited: ["temperature", "humidity"] } });
    layer.keep(undefined, new Map([[CLIMATE_SENSOR, ["temperature"]]]));
    await layer.add(db!.get(CLIMATE_SENSOR));
    expect(layer.description(CLIMATE_SENSOR)!.awaitedKeys).toEqual(["humidity"]);
  });

  it("describes the device again before the observation that carries a changed setting, and only when it changed (GA-BRIDGE-74)", async () => {
    const { layer, seen, pusher } = setup();
    await layer.add(pusher);
    seen.length = 0;
    await layer.heard(datapoints(pusher, 20, [[101, 4, [1]]]) as never);
    expect(kinds(seen)).toEqual(["described", "observed"]);
    expect(layer.description(PUSHER)!.actions.filter((a) => a.action.startsWith("onoff.")).map((a) => a.idempotent)).toEqual([true, true]);
    expect(seen[1]![2]).toEqual({ [MODE]: "switch" });
    await layer.heard(datapoints(pusher, 21, [[101, 4, [1]], [105, 2, [0, 0, 0, 30]]]) as never);
    expect(kinds(seen)).toEqual(["described", "observed", "observed"]);
    await layer.heard(datapoints(pusher, 22, [[101, 4, [0]]]) as never);
    expect(kinds(seen)).toEqual(["described", "observed", "observed", "described", "observed"]);
    expect(layer.description(PUSHER)!.actions.filter((a) => a.action.startsWith("onoff.") || a.action.endsWith(".press")).map((a) => [a.action.split(".").pop(), a.stateless])).toEqual([["press", true]]);
  });

  it("stops a device that left: its converters' stop, its messages read no more, its settings forgotten", async () => {
    const { layer, seen, hooks, pusher } = setup();
    layer.keep(new Map([[PUSHER, { [MODE]: "click" }]]));
    await layer.add(pusher);
    await layer.remove(PUSHER);
    expect(hooks).toEqual([`${PUSHER} start`, `${PUSHER} stop`]);
    seen.length = 0;
    await layer.heard(datapoints(pusher, 30, [[105, 2, [0, 0, 0, 30]]]) as never);
    expect(seen).toEqual([]);
    await layer.add(pusher);
    expect(layer.description(PUSHER)!.actions.filter((a) => a.action.startsWith("onoff."))).toEqual([]);
    expect(kinds(seen)).toEqual(["described"]);
  });

  it("tells a converter's later publish after what came before it, and describes again when a converter says the exposes changed", async () => {
    let later: ((x: Record<string, unknown>) => void) | undefined;
    let exposesChanged: (() => void) | undefined;
    const { layer, seen, clock, pusher } = setup({ wrap: (d) => ({ ...d, fromZigbee: [{ cluster: "genOnOff", type: "attributeReport",
      convert: (_m: unknown, _msg: unknown, publish: (x: Record<string, unknown>) => void, _o: unknown, meta: { deviceExposesChanged(): void }) => {
        later = publish;
        exposesChanged = () => meta.deviceExposesChanged();
        return { battery: 50 };
      } }] } as unknown as Definition) });
    await layer.add(pusher);
    seen.length = 0;
    const at = clock.now();
    await layer.heard(message(pusher, { cluster: "genOnOff", command: "report", global: true, tsn: 40, payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never);
    later!({ battery: 49 });
    await layer.idle();
    expect(seen).toEqual([["observed", PUSHER, { battery: 50 }, at, true], ["observed", PUSHER, { battery: 49 }, at, false]]);
    exposesChanged!();
    await layer.idle();
    // Described again; unchanged, so nothing is sent.
    expect(seen).toHaveLength(2);
  });

  it("logs a converter hook that throws, and describes the device still", async () => {
    const { layer, seen, sensor } = setup({ wrap: (d) => ({ ...d, onEvent: async () => { throw new Error("hook failed"); } }) });
    await layer.add(sensor);
    expect(kinds(seen)).toEqual(["described"]);
  });
});

group("HerdsmanDevices: the plan 2c-1 review's findings", () => {
  it("tells a device's converters stop before start again when herdsman interviews it again (M4)", async () => {
    const { layer, hooks, pusher } = setup();
    await layer.add(pusher);
    await layer.add(pusher);
    expect(hooks).toEqual([`${PUSHER} start`, `${PUSHER} stop`, `${PUSHER} start`]);
  });

  it("sends the core an extension's actions with the actions it offers, the same ones (M1)", async () => {
    const { layer, seen, pusher } = setup();
    await layer.add(pusher);
    const [d] = descriptions(seen);
    const offered = d!.actions.map((a) => a.action).filter((a) => a.startsWith(`${PUSHER_CAP}.`));
    expect(offered).toContain(`${PUSHER_CAP}.set_mode`);
    expect(d!.extensions![0]!.actions!.map((a) => a.action)).toEqual(offered);
  });
});

group("HerdsmanDevices: the converters' deviceJoined and deviceInterview (plan 3b)", () => {
  const LEGRAND = "0x00000000000a0021";
  const LEGRAND_ROW = row(21, LEGRAND, "Router", "test-legrand", "Legrand", "Mains (single phase)", [0, 6], 0x1021);

  it("tells a device herdsman let in its converters' deviceJoined: their common hook, no definition yet, which sets a Legrand device's read handler", async () => {
    const { layer, hooks } = setup({ rows: [LEGRAND_ROW] });
    const model = db!.get(LEGRAND);
    expect(model.customReadResponse).toBeUndefined();
    await layer.joined(model);
    expect(typeof model.customReadResponse).toBe("function");
    expect(hooks).toEqual([]);
  });

  it("tells deviceInterview at each status, the definition's own hook with it once the device is described", async () => {
    const statuses: string[] = [];
    const { layer, hooks, pusher } = setup({ wrap: (d) => ({ ...d, onEvent: async (e) => {
      if (e.type === "deviceInterview") statuses.push(e.data.status);
    } }) });
    await layer.interview(pusher, "started");
    await layer.add(pusher, true);
    await layer.interview(pusher, "successful");
    await layer.interview(pusher, "failed");
    expect(hooks).toEqual([`${PUSHER} start`, `${PUSHER} deviceInterview`, `${PUSHER} deviceInterview`]);
    expect(statuses).toEqual(["successful", "failed"]);
  });

  it("logs a deviceJoined or deviceInterview hook that throws, and goes on", async () => {
    const { layer, seen, pusher } = setup({ wrap: (d) => ({ ...d, onEvent: async (e) => {
      if (e.type === "deviceInterview") throw new Error("hook failed");
    } }) });
    await layer.add(pusher, true);
    await layer.interview(pusher, "successful");
    await layer.joined(pusher);
    await layer.heard(datapoints(pusher, 50, [[105, 2, [0, 0, 0, 30]]]) as never);
    expect(kinds(seen)).toEqual(["described", "observed"]);
  });
});
