import { afterEach, beforeEach, describe as group, expect, it, type MockInstance, vi } from "vitest";
import { Zcl } from "zigbee-herdsman";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import { CONFIGURE_CALL_MS, type ConfigureCall, runConfigure } from "../src/herdsman/configure.js";
import { boundOf, configureVersion, describe, versionOf } from "../src/herdsman/describe.js";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { HerdsmanDoer } from "../src/herdsman/doer.js";
import { BATTERY_REPORT, type Override, overrideFor } from "../src/herdsman/overrides.js";
import { poll, POLL_BOUND_MS, POLL_CALL_MS, POLL_MS, POLL_REACH_MS, polls } from "../src/herdsman/polling.js";
import { EXCHANGE_MS } from "../src/transport.js";
import { FakeClock, settle } from "./fakes.js";
import { core, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { reply, responseTimeout, stubAdapter } from "./zigbee-adapter.js";
import { COORDINATOR_ROW, devices, LIGHT, LIGHT_ROW, message, PRESENCE, PRESENCE_ROW, PUSHER, PUSHER_ROW, row, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

/**
 * Freshness (plan 5b; the design, *Freshness*): every device declares a bound the bridge can stand
 * behind (GA-BRIDGE-13). A device in reach is polled, `basis: poll`, its bound three times the poll's
 * cadence, each poll a read of genBasic whose answer is a check-in; a sleeping device whose definition
 * sets up no reporting gets the override table's report, its bound twice the report's maximum once the
 * device accepted it; a model the bench measured gives its rhythm; and with none of these the bound is
 * null.
 */

let db: ReturnType<typeof devices> | undefined;
let stub: ReturnType<typeof stubAdapter>;
let errors: MockInstance;
/** Every frame handed to herdsman's adapter, as `cluster.command`. */
const frames = () => stub.handed.map((h) => `${h.cluster}.${h.command}`);
/** A read answered with the ZCL version, a reporting set-up with its success, anything else a Default Response. */
const answersAll = (f: Zcl.Frame) => (f.command.name === "read" ? reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: 0x20, attrData: 8 }])
  : f.command.name === "configReport" ? reply(f, "configReportRsp", [{ status: 0 }]) : reply(f, "defaultRsp", { cmdId: f.command.ID, statusCode: 0 }));
beforeEach(() => {
  stub = stubAdapter();
  stub.answer(answersAll);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stub.restore();
  errors.mockRestore();
  db?.close();
  db = undefined;
});

const COORDINATOR = COORDINATOR_ROW.ieeeAddr as string;
const coordinatorEndpoint = () => db!.get(COORDINATOR).endpoints[0]!;
/** A router no model database knows, whose endpoint serves no genBasic: nothing for a poll to read. */
const BARE = "0x00000000000a0009";
const BARE_ROW = row(12, BARE, "Router", "test-bare", "galatea-test", "Mains (single phase)", [6]);
/** The vibration sensor's override, the bench's model. */
const TS0210 = overrideFor("TS0210")!;
/** The radar's override. */
const ZG204ZV = overrideFor("ZG-204ZV")!;

/** Describes `ieee` from a database of `rows`, as the doer does: polling unless `polls` is false. */
async function described(ieee: string, rows: Record<string, unknown>[], o: { polls?: boolean; override?: Override } = {}) {
  db = devices(rows);
  const device = db.get(ieee);
  const definition = (await findByDevice(device, true))!;
  const override = o.override ?? overrideFor(definition.model);
  return { device, definition, ...(await describe(device, definition, { polls: o.polls ?? true, ...(override ? { override } : {}) })) };
}

group("polling: which devices, at what cadence, with what bound", () => {
  it("polls a router: basis poll, cadenceMs POLL_MS, basisMaxAgeMs three times it", async () => {
    const { description: d } = await described(LIGHT, [LIGHT_ROW]);
    expect(d).toMatchObject({ reachMs: 0, basis: "poll", cadenceMs: POLL_MS, basisMaxAgeMs: POLL_BOUND_MS });
    expect(POLL_BOUND_MS).toBe(3 * POLL_MS);
    // At most three times the cadence (GA-BRIDGE-13), and a cadence a person would call "every few minutes".
    expect(d.basisMaxAgeMs! <= 3 * d.cadenceMs!).toBe(true);
    expect(POLL_MS).toBe(300_000);
  });

  it("polls the button pusher, whose reach the bench measured within POLL_REACH_MS, though it sleeps on a battery", async () => {
    const { description: d } = await described(PUSHER, [PUSHER_ROW]);
    expect(d.reachMs).toBe(2_500);
    expect(d.reachMs <= POLL_REACH_MS).toBe(true);
    expect(d).toMatchObject({ basis: "poll", cadenceMs: POLL_MS, basisMaxAgeMs: POLL_BOUND_MS });
  });

  it("polls no sleeping sensor whose reach is not known: the vibration sensor and the radar report on their own", async () => {
    for (const [ieee, r] of [[SENSOR, SENSOR_ROW], [PRESENCE, PRESENCE_ROW]] as const) {
      const { description: d } = await described(ieee, [r]);
      expect(d).toMatchObject({ basis: "report", cadenceMs: null, basisMaxAgeMs: null });
      db!.close();
      db = undefined;
    }
  });

  it("polls no device whose endpoints serve no genBasic: its bound is the reporting's, or null", async () => {
    const { device, description: d } = await described(BARE, [BARE_ROW]);
    expect(polls(device, 0)).toBe(false);
    expect(d).toMatchObject({ reachMs: 0, basis: "report", cadenceMs: null, basisMaxAgeMs: null });
  });

  it("polls no model the bench saw answer no poll (`poll: false`)", async () => {
    const { description: d } = await described(PUSHER, [PUSHER_ROW], { override: { ...overrideFor("TS0001_fingerbot")!, poll: false } });
    expect(d).toMatchObject({ reachMs: 2_500, basis: "report", cadenceMs: null, basisMaxAgeMs: null });
  });

  it("polls nothing where the doer does not poll (the owner's switch): a router then reports on its own", async () => {
    const { description: d } = await described(LIGHT, [LIGHT_ROW], { polls: false });
    expect(d).toMatchObject({ basis: "report", cadenceMs: null, basisMaxAgeMs: null });
  });

  it("reads genBasic's ZCL version, once, at once, waiting POLL_CALL_MS at most; an answer with an error status is an answer", async () => {
    db = devices([LIGHT_ROW]);
    expect(await poll(db.get(LIGHT))).toEqual({ answered: true });
    expect(stub.handed.map((h) => ({ frame: `${h.cluster}.${h.command}`, payload: h.payload, timeout: h.timeout, disableRecovery: h.disableRecovery })))
      .toEqual([{ frame: "genBasic.read", payload: [{ attrId: 0 }], timeout: POLL_CALL_MS, disableRecovery: true }]);
    stub.answer((f) => reply(f, "readRsp", [{ attrId: 0, status: Zcl.Status.UNSUPPORTED_ATTRIBUTE }]));
    expect(await poll(db.get(LIGHT))).toEqual({ answered: true });
    stub.answer(() => responseTimeout());
    expect(await poll(db.get(LIGHT))).toEqual({ answered: false, detail: "the device did not answer in time" });
  });
});

group("configured reports: the override table's, on a sleeping device whose definition sets up none", () => {
  it("names an hourly battery report for the vibration sensor and the radar, and none for the button pusher, which is polled", () => {
    expect(BATTERY_REPORT).toEqual({ cluster: "genPowerCfg", attribute: "batteryPercentageRemaining", minimumReportInterval: 3_600,
      maximumReportInterval: 3_600, reportableChange: 0 });
    expect(TS0210.reports).toEqual([BATTERY_REPORT]);
    expect(ZG204ZV.reports).toEqual([BATTERY_REPORT]);
    expect(overrideFor("TS0001_fingerbot")!.reports).toBeUndefined();
    // No model's rhythm and no ignored report is recorded until the bench measures one (the bench guide's freshness checks).
    for (const m of ["TS0210", "ZG-204ZV", "TS0001_fingerbot"]) {
      expect(overrideFor(m)!.rhythm).toBeUndefined();
      expect(overrideFor(m)!.reportsIgnored).toBeUndefined();
    }
  });

  it("keeps a configure with the table's reports under a version of its own, so a changed table configures again", async () => {
    db = devices([SENSOR_ROW, PRESENCE_ROW]);
    const sensor = (await findByDevice(db.get(SENSOR), true))!;
    expect(configureVersion(sensor)).toBe("0.0.0");
    const v = configureVersion(sensor, TS0210);
    expect(v).toMatch(/^0\.0\.0\+galatea\.[0-9a-f]{8}$/);
    expect(configureVersion(sensor, { ...TS0210, reports: [{ ...BATTERY_REPORT, maximumReportInterval: 1_800 }] })).not.toBe(v);
    // The radar configured on the bench under its definition's version alone is configured again for its report.
    const radar = (await findByDevice(db.get(PRESENCE), true))!;
    expect(configureVersion(radar, ZG204ZV)).not.toBe(versionOf(radar));
  });

  it("sets the vibration sensor's battery report up, though its definition has no configure, and keeps the version", async () => {
    db = devices([SENSOR_ROW]);
    const device = db.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    expect(definition.configure).toBeUndefined();
    const calls: ConfigureCall[] = [];
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), calls, override: TS0210 }))
      .toEqual({ outcome: "configured" });
    expect(calls.map((c) => `${c.call} ${String(c.cluster)}`)).toEqual(["configureReporting genPowerCfg"]);
    expect(stub.handed.map((h) => ({ frame: `${h.cluster}.${h.command}`, payload: h.payload, timeout: h.timeout, disableRecovery: h.disableRecovery })))
      .toEqual([{ frame: "genPowerCfg.configReport", timeout: CONFIGURE_CALL_MS, disableRecovery: true,
        payload: [{ direction: 0, attrId: 0x21, dataType: 0x20, minRepIntval: 3_600, maxRepIntval: 3_600, repChange: 0 }] }]);
    expect(device.meta.configured).toBe(configureVersion(definition, TS0210));
    expect(boundOf(device, definition, TS0210)).toBe(7_200_000);
  });

  it("runs the radar's own configure first, then its report", async () => {
    db = devices([PRESENCE_ROW]);
    const device = db.get(PRESENCE);
    const definition = (await findByDevice(device, true))!;
    const calls: ConfigureCall[] = [];
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), calls, override: ZG204ZV }))
      .toEqual({ outcome: "configured" });
    expect(calls.at(-1)).toMatchObject({ call: "configureReporting", cluster: "genPowerCfg" });
    expect(calls.slice(0, -1).every((c) => c.call !== "configureReporting")).toBe(true);
    expect(boundOf(device, definition, ZG204ZV)).toBe(7_200_000);
  });

  it("keeps no version and no bound when the device refuses the report: tried again as a failed configure", async () => {
    db = devices([SENSOR_ROW]);
    const device = db.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    stub.answer((f) => reply(f, "configReportRsp", [{ status: Zcl.Status.UNSUPPORTED_ATTRIBUTE, direction: 0, attrId: 0x21 }]));
    const r = await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), override: TS0210 });
    expect(r).toMatchObject({ outcome: "failed" });
    expect(device.meta.configured).toBeUndefined();
    expect(boundOf(device, definition, TS0210)).toBeNull();
  });

  it("leaves out a report whose cluster no endpoint serves: configured, with no bound from it", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const definition = (await findByDevice(device, true))!;
    const override: Override = { reports: [BATTERY_REPORT] };
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), override })).toEqual({ outcome: "configured" });
    expect(frames()).toEqual([]);
    expect(boundOf(device, definition, override)).toBeNull();
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${LIGHT}: no endpoint serves genPowerCfg: its report is not set up, and gives no bound`);
  });

  it("declares null for a model the bench saw accept a report and not report by it, whatever it accepted", async () => {
    db = devices([SENSOR_ROW]);
    const device = db.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), override: TS0210 });
    expect(boundOf(device, definition, TS0210)).toBe(7_200_000);
    const ignored: Override = { ...TS0210, reportsIgnored: { measured: "2026-10-07", seen: "no battery report in 12 h after accepting an hourly one" } };
    expect(configureVersion(definition, ignored)).toBe(configureVersion(definition, TS0210));
    expect(boundOf(device, definition, ignored)).toBeNull();
  });
});

group("a model's measured rhythm, where no report is configured", () => {
  const rhythm = { everyMs: 60_000, measured: "2026-10-07", seen: "its light every 60 s for 12 h, nothing happening" };

  it("gives twice the measured interval, allowing one missed report, where nothing is configured", async () => {
    db = devices([PRESENCE_ROW]);
    const device = db.get(PRESENCE);
    const definition = (await findByDevice(device, true))!;
    expect(boundOf(device, definition, { rhythm })).toBe(120_000);
    expect((await describe(device, definition, { override: { rhythm }, polls: true })).description)
      .toMatchObject({ basis: "report", cadenceMs: null, basisMaxAgeMs: 120_000 });
  });

  it("gives way to a configured report the device accepted", async () => {
    db = devices([SENSOR_ROW]);
    const device = db.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    const override: Override = { ...TS0210, rhythm };
    expect(boundOf(device, definition, override)).toBe(120_000);
    await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), override });
    expect(boundOf(device, definition, override)).toBe(7_200_000);
  });
});

group("HerdsmanDevices: polls, and configured reports at a sleeping device's next message", () => {
  /** A device layer over herdsman's models of `rows`, by their real definitions and the override table. */
  function layer(rows: Record<string, unknown>[], extra: { noActions?: boolean; definitionOf?: (d: never) => Promise<Definition | undefined> } = {}) {
    db = devices(rows);
    const clock = new FakeClock();
    const { events, seen } = core();
    const l = new HerdsmanDevices({ clock, events: () => events, coordinator: () => coordinatorEndpoint(),
      ...(extra.noActions ? { noActions: true } : {}), ...(extra.definitionOf ? { definitionOf: extra.definitionOf } : {}) });
    const flush = async () => {
      await settle();
      await l.idle();
      await settle();
      await l.idle();
    };
    return { l, clock, seen, flush };
  }
  /** The device's answer to a poll, as herdsman emits it: a Read Attributes Response on genBasic. */
  const answer = (ieee: string, tsn: number) => message(db!.get(ieee), { cluster: "genBasic", command: "readRsp", global: true, tsn,
    payload: [{ attrId: 0, status: 0, dataType: 0x20, attrData: 8 }] }) as never;
  const report = (ieee: string, tsn: number) => message(db!.get(ieee), { cluster: "genOnOff", command: "report", global: true, tsn,
    payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never;
  const reads = () => stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read").map((h) => h.ieee);

  it("polls each polled device at once, then POLL_MS after its last poll, the answer a check-in", async () => {
    const { l, clock, seen, flush } = layer([LIGHT_ROW, PUSHER_ROW, SENSOR_ROW]);
    for (const ieee of [LIGHT, PUSHER, SENSOR]) await l.add(db!.get(ieee));
    await flush();
    stub.handed.length = 0;
    await l.pollDue();
    expect(reads().sort()).toEqual([LIGHT, PUSHER].sort());
    await l.heard(answer(LIGHT, 1));
    await flush();
    expect(seen.filter((e) => e[0] === "observed" && e[1] === LIGHT)).toEqual([["observed", LIGHT, {}, clock.now(), true]]);
    await clock.advance(POLL_MS - 1);
    await l.pollDue();
    expect(reads()).toHaveLength(2);
    await clock.advance(1);
    await l.pollDue();
    expect(reads()).toHaveLength(4);
  });

  it("reads no device heard within POLL_MS: its message was the check-in a read would bring", async () => {
    const { l, clock, flush } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.handed.length = 0;
    await l.heard(report(LIGHT, 2));
    await flush();
    await l.pollDue();
    expect(reads()).toEqual([]);
    await clock.advance(POLL_MS - 1);
    await l.heard(report(LIGHT, 3));
    await flush();
    await clock.advance(POLL_MS - 1);
    await l.pollDue();
    expect(reads()).toEqual([]);
    await clock.advance(1);
    await l.pollDue();
    expect(reads()).toEqual([LIGHT]);
  });

  it("polls one device at a time, and runs one round at a time", async () => {
    const { l, flush } = layer([LIGHT_ROW, PUSHER_ROW]);
    await l.add(db!.get(LIGHT));
    await l.add(db!.get(PUSHER));
    await flush();
    stub.handed.length = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    stub.answer(async (f) => {
      await held;
      return answersAll(f);
    });
    const first = l.pollDue();
    const second = l.pollDue();
    await settle();
    expect(reads()).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(reads()).toHaveLength(2);
  });

  it("says once that a device's polls go unanswered, and once that they are answered again", async () => {
    const { l, clock, flush } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 3; i++) {
      await l.pollDue();
      await clock.advance(POLL_MS);
    }
    stub.answer(answersAll);
    await l.pollDue();
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("poll"));
    expect(logged).toEqual([`zigbee: ${LIGHT}: its poll was not answered: the device did not answer in time; read again every ${POLL_MS} ms`,
      `zigbee: ${LIGHT}: its poll is answered again`]);
  });

  it("polls nothing under the owner's switch: every device described as reporting on its own", async () => {
    const { l, seen, flush } = layer([LIGHT_ROW, PUSHER_ROW], { noActions: true });
    await l.add(db!.get(LIGHT));
    await l.add(db!.get(PUSHER));
    await flush();
    await l.pollDue();
    expect(stub.handed).toEqual([]);
    expect(seen.filter((e) => e[0] === "described").map((e) => (e[1] as { basis: string }).basis)).toEqual(["report", "report"]);
  });

  it("configures the vibration sensor's report at its next message, and describes it again with the bound", async () => {
    const { l, seen, flush } = layer([SENSOR_ROW]);
    await l.add(db!.get(SENSOR));
    await flush();
    expect(frames()).toEqual([]);
    await l.heard(message(db!.get(SENSOR), { cluster: "genPowerCfg", command: "report", global: true, tsn: 4,
      payload: [{ attrId: 0x21, dataType: 0x20, attrData: 200 }] }) as never);
    await flush();
    expect(frames()).toEqual(["genPowerCfg.configReport"]);
    const bounds = seen.filter((e) => e[0] === "described").map((e) => (e[1] as { basisMaxAgeMs: number | null }).basisMaxAgeMs);
    expect(bounds).toEqual([null, 7_200_000]);
  });

  it("configures again hardware admitted anew, its bound null until the device accepts again", async () => {
    const { l, seen, flush } = layer([SENSOR_ROW]);
    const device = db!.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), override: TS0210 });
    await l.add(device);
    await flush();
    expect((seen.at(-1)![1] as { basisMaxAgeMs: number | null }).basisMaxAgeMs).toBe(7_200_000);
    stub.handed.length = 0;
    // A reset device's report is gone: it accepts none until told again.
    stub.answer(() => responseTimeout());
    await l.resend(SENSOR);
    await flush();
    const bounds = seen.filter((e) => e[0] === "described").map((e) => (e[1] as { basisMaxAgeMs: number | null }).basisMaxAgeMs);
    expect(bounds).toEqual([7_200_000, null]);
    expect(device.meta.configured).toBeUndefined();
    expect(frames()).toEqual(["genPowerCfg.configReport"]);
  });

  it("forgets herdsman's mark of an earlier configure at a join: configured again at the interview", async () => {
    const { l, flush } = layer([SENSOR_ROW]);
    const device = db!.get(SENSOR);
    device.meta.configured = configureVersion((await findByDevice(device, true))!, TS0210);
    await l.joined(device);
    await flush();
    expect(device.meta.configured).toBeUndefined();
    await l.add(device, true);
    await flush();
    expect(frames()).toEqual(["genPowerCfg.configReport"]);
  });
});

group("HerdsmanDoer: polls at its health exchanges", () => {
  it("polls the devices in reach within one health exchange of its start, then every POLL_MS at an exchange", async () => {
    db = devices([LIGHT_ROW, SENSOR_ROW]);
    const clock = new FakeClock();
    const { made, make } = stacks((s) => {
      s.had.add(LIGHT);
      s.had.add(SENSOR);
      s.lookup = (ieee) => db!.get(ieee);
      s.coordinator = () => coordinatorEndpoint();
    });
    const doer = new HerdsmanDoer({ clock, coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES });
    await doer.start(core().events, new Map());
    await settle();
    await doer.idle();
    // The devices are described as the controller resumes; the next exchange finds the router due.
    await clock.advance(EXCHANGE_MS);
    await settle();
    const reads = () => stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read").map((h) => h.ieee);
    expect(reads()).toEqual([LIGHT]);
    // Polled again POLL_MS later, at an exchange, never in between.
    stub.handed.length = 0;
    await clock.advance(POLL_MS - EXCHANGE_MS);
    await settle();
    expect(reads()).toEqual([]);
    await clock.advance(EXCHANGE_MS);
    await settle();
    expect(reads()).toEqual([LIGHT]);
    await doer.stop();
  });
});
