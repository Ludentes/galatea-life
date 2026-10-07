import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { SAVE_MS, STORE_RETRY_MS, ZigbeeBridge, type Mutation } from "../src/bridge.js";
import type { Description } from "../src/port.js";
import { closedActions } from "../src/vocabulary.js";
import { FakeClock, FakeDoer, FakeWire, lamp, MemoryStore, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/zigbee`;
const HW = "0x00158d0001a2b3c4";
const PUSHER = "0xa4c138f1e2d3c4b5";
const NS = "org.galatea.zigbee.ts0001_fingerbot";
const MODE = `${NS}.mode`;

const bridges: ZigbeeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function bridge(opts: { mutation?: Mutation; store?: MemoryStore; clock?: FakeClock; initial?: Description[] } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const wire = new FakeWire();
  const doer = new FakeDoer(clock);
  doer.initial = opts.initial ?? [lamp()];
  const store = opts.store ?? new MemoryStore();
  const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store,
    ...(opts.mutation ? { runId: "run-1", mutation: opts.mutation } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, doer, store };
}

const ids = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id);
const roster = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.devices.map((d: { id: string }) => d.id);
const events = (wire: FakeWire, type: string) => wire.all(`${BASE}/event`).map((p) => p.payload).filter((e) => e.type === type);
const command = (value: Record<string, unknown>) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value,
});

/**
 * A button pusher whose `onoff` depends on its mode (the design's Fingerbot): not offered before the
 * mode is observed, idempotent in switch mode, not in click mode (GA-BRIDGE-74).
 */
function pusher(mode?: "click" | "switch"): Description {
  const setMode = { action: `${NS}.set_mode`, idempotent: true, stateless: false, confirms: false,
    args: { mode: ["click", "switch"] }, confirmedBy: { key: MODE, value: { arg: "mode" } } };
  const onoff = mode ? closedActions("onoff", true).map((a) => ({ ...a, idempotent: mode === "switch" })) : [];
  return {
    hardwareId: PUSHER, stableIdentifier: PUSHER, model: { vendor: "_TZ3210_dse8ogfy", model: "TS0001_fingerbot" },
    capabilities: mode ? ["onoff"] : [], actions: [...onoff, setMode], feedback: "closed", reachMs: 2500, proposedClass: null,
    classEvidence: "model_db", otherAdmins: "unknown", basis: "report", cadenceMs: null, basisMaxAgeMs: null,
    extensions: [{ capability: NS, description: "A button pusher's mode",
      actions: [{ action: `${NS}.set_mode`, description: "Sets the mode", schema: { enum: ["click", "switch"] } }],
      keys: [{ key: MODE, kind: "state", description: "click presses on every turn_on; switch holds a position", schema: { enum: ["click", "switch"] } }] }],
    settings: [MODE],
  };
}

describe("admissions (GA-BRIDGE-35)", () => {
  it("admits new hardware described after the start, with a joined event naming its id", async () => {
    const { wire, doer } = await bridge();
    await doer.describe(lamp({ hardwareId: "0x00158d0001a2b3c5", stableIdentifier: "0x00158d0001a2b3c5" }));
    expect(ids(wire)).toEqual([HW, "0x00158d0001a2b3c5"]);
    const [joined] = events(wire, "joined");
    expect(joined).toMatchObject({ seq: 1, type: "joined", device: "0x00158d0001a2b3c5" });
    expect(validate("bridge/event.json", joined)).toEqual([]);
  });

  it("does not admit again a secured rejoin, or one under the device's own key, of hardware in devices", async () => {
    const { wire, doer, store } = await bridge();
    await doer.admit(HW, "securedRejoin");
    await doer.admit(HW, "tcRejoinUniqueKey");
    await doer.describe(lamp());
    expect(ids(wire)).toEqual([HW]);
    expect(events(wire, "joined")).toEqual([]);
    expect(store.writes).toEqual([`admit ${HW}`]);
  });

  for (const how of ["association", "tcRejoinWellKnown"] as const) {
    it(`gives an ${how} of hardware in devices a new id, the old one leaving with its status cleared`, async () => {
      const { wire, doer } = await bridge();
      await doer.observe(HW, { on: true });
      const mark = wire.calls.length;
      await doer.admit(HW, how);
      expect(ids(wire)).toEqual([]);
      expect(roster(wire)).toEqual([]);
      expect(wire.last(`${BASE}/devices/${HW}/status`)).toEqual({ topic: `${BASE}/devices/${HW}/status`, payload: "", retain: true });
      expect(events(wire, "joined")).toMatchObject([{ device: `${HW}-2` }]);
      await doer.describe(lamp());
      expect(ids(wire)).toEqual([`${HW}-2`]);
      expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/devices/${HW}/status`,
        `publish ${BASE}/status`, `publish ${BASE}/event`, `publish ${BASE}/devices`, `publish ${BASE}/status`]);
      await wire.deliver(`${BASE}/devices/${HW}/command`, command({ action: "onoff.turn_on" }));
      expect(wire.last(`${BASE}/devices/${HW}/ack`)!.payload).toMatchObject({ result: "failed", reason: "unknown_device" });
    });
  }

  it("does not admit again a secured rejoin of hardware the store keeps, not yet described: still in devices (plan 3b review, gap b)", async () => {
    const KEPT = "0x00158d0001a2b3c9";
    const store = new MemoryStore();
    await store.admit(KEPT);
    const { wire, doer } = await bridge({ store, initial: [] });
    await doer.admit(KEPT, "securedRejoin");
    await doer.describe(lamp({ hardwareId: KEPT, stableIdentifier: KEPT }));
    expect(ids(wire)).toEqual([KEPT]);
    expect(events(wire, "joined")).toEqual([]);
    expect(store.writes).toEqual([`admit ${KEPT}`]);
  });

  it("admits anew a secured rejoin of hardware whose leave the store has not written yet", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.down = true;
    await doer.leave(HW);
    await doer.admit(HW, "securedRejoin");
    store.down = false;
    await clock.advance(STORE_RETRY_MS);
    await settle();
    expect(events(wire, "joined")).toHaveLength(1);
  });

  it("admits hardware no longer in devices whatever way it rejoins", async () => {
    const { wire, doer } = await bridge();
    await doer.leave(HW);
    await doer.admit(HW, "securedRejoin");
    await doer.describe(lamp());
    expect(ids(wire)).toEqual([`${HW}-2`]);
    expect(events(wire, "joined")).toMatchObject([{ device: `${HW}-2` }]);
  });

  it("keeps hardware admitted and not yet described out of devices, and names it on a leave", async () => {
    const { wire, doer } = await bridge();
    await doer.admit("0x00158d0001a2b3c9", "association");
    expect(ids(wire)).toEqual([HW]);
    expect(events(wire, "joined")).toMatchObject([{ device: "0x00158d0001a2b3c9" }]);
    await doer.leave("0x00158d0001a2b3c9");
    expect(events(wire, "left")).toMatchObject([{ device: "0x00158d0001a2b3c9" }]);
    await doer.describe(lamp({ hardwareId: "0x00158d0001a2b3c9", stableIdentifier: "0x00158d0001a2b3c9" }));
    expect(ids(wire)).toEqual([HW, "0x00158d0001a2b3c9-2"]);
  });
});

describe("a new admission while the store is away (the maintainer's ruling, 2026-10-04)", () => {
  const faults = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.faults as { code: string; device?: string; detail?: string }[];
  const refusal = (wire: FakeWire) => faults(wire).filter((f) => f.code === "admission_refused");
  /** The store goes away: a description of new hardware finds it gone, and its retry is due. */
  async function storeAway(doer: FakeDoer, store: MemoryStore): Promise<void> {
    store.down = true;
    await doer.describe(lamp({ hardwareId: "0x00158d0001a2b3d0", stableIdentifier: "0x00158d0001a2b3d0" }));
  }

  it("lets hardware in while the store is there, known or not", async () => {
    const { wire, doer } = await bridge();
    expect(await doer.mayAdmit(HW)).toBe(true);
    expect(await doer.mayAdmit("0x00158d0001a2b3d1")).toBe(true);
    expect(refusal(wire)).toEqual([]);
  });

  it("refuses hardware it has a device for while the store is away, and names it until the hardware is admitted again", async () => {
    const { wire, doer, store, clock } = await bridge();
    await storeAway(doer, store);
    expect(await doer.mayAdmit(HW)).toBe(false);
    expect(refusal(wire)).toEqual([{ code: "admission_refused",
      detail: `${HW}: the hardware of ${HW} came in again while the store was away; pair it again once the store is back` }]);
    expect(validate("bridge/status.json", wire.last(`${BASE}/status`)!.payload)).toEqual([]);
    // Unknown hardware has no id to inherit: it is let in, and held in memory.
    expect(await doer.mayAdmit("0x00158d0001a2b3d1")).toBe(true);
    // The store back, the refusal stands: the device must still be paired again.
    store.down = false;
    await clock.advance(STORE_RETRY_MS);
    expect(faults(wire).map((f) => f.code)).toEqual(["admission_refused"]);
    await doer.admit(HW, "association");
    expect(events(wire, "joined").at(-1)).toEqual(expect.objectContaining({ device: `${HW}-2` }));
    expect(refusal(wire)).toEqual([]);
  });

  it("refuses while the store's retry is running: no retry is due, but the store is not back yet", async () => {
    const { doer, store, clock } = await bridge();
    await storeAway(doer, store);
    store.down = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const admit = store.admit.bind(store);
    store.admit = async (hw, previous) => { await gate; return admit(hw, previous); };
    // The retry starts, and waits on the store's answer for the held hardware.
    void clock.advance(STORE_RETRY_MS);
    await settle();
    expect(await doer.mayAdmit(HW)).toBe(false);
    release();
    await settle();
  });

  it("refuses hardware whose leave the store has not written: the store still gives it its old id", async () => {
    const { wire, doer, store } = await bridge();
    await storeAway(doer, store);
    await doer.leave(HW);
    expect(ids(wire)).toEqual([]);
    expect(await doer.mayAdmit(HW)).toBe(false);
  });

  it("refuses hardware admitted and waiting for its description, and hardware the store keeps that is not described yet", async () => {
    const store = new MemoryStore();
    const kept = await store.admit("0x00158d0001a2b3d2");
    const { doer } = await bridge({ store, initial: [] });
    await doer.admit("0x00158d0001a2b3d3", "association");
    await storeAway(doer, store);
    expect(await doer.mayAdmit("0x00158d0001a2b3d3")).toBe(false);
    expect(await doer.mayAdmit(kept.hardwareId)).toBe(false);
  });
});

describe("leaves (GA-BRIDGE-21)", () => {
  it("writes the removal, then takes the device out of devices and the roster, clears its status and names it", async () => {
    const { wire, doer, store } = await bridge();
    await doer.observe(HW, { on: true });
    const mark = wire.calls.length;
    await doer.leave(HW);
    expect(store.writes).toEqual([`admit ${HW}`, `remove ${HW}`]);
    expect(store.device(HW)).toBeUndefined();
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/devices/${HW}/status`, `publish ${BASE}/status`,
      `publish ${BASE}/event`]);
    expect(ids(wire)).toEqual([]);
    expect(roster(wire)).toEqual([]);
    expect(wire.last(`${BASE}/devices/${HW}/status`)!.payload).toBe("");
    expect(events(wire, "left")).toMatchObject([{ seq: 1, type: "left", device: HW }]);
  });

  it("takes the device out while the store is away, and writes the removal when it is back", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.down = true;
    await doer.leave(HW);
    expect(ids(wire)).toEqual([]);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toMatchObject([{ code: "store_fault" }]);
    store.down = false;
    await clock.advance(STORE_RETRY_MS);
    expect(store.device(HW)).toBeUndefined();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
  });

  it("takes out, at the start, a device the store kept that the doer reports gone, clearing its retained status", async () => {
    const GONE = "0x00158d0001a2b3c9";
    const store = new MemoryStore();
    await store.admit(HW);
    await store.admit(GONE);
    const clock = new FakeClock();
    const wire = new FakeWire();
    const doer = new FakeDoer(clock);
    doer.initial = [lamp()];
    // A leave the store missed: the doer, comparing the store's hardware with its network, reports it.
    const start = doer.start.bind(doer);
    doer.start = async (events, settings) => {
      await start(events, settings);
      for (const hw of settings!.keys()) if (hw !== HW) events.left(hw);
    };
    const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store });
    bridges.push(b);
    await b.start();
    expect([...doer.startSettings!.keys()]).toEqual([HW, GONE]);
    expect(store.device(GONE)).toBeUndefined();
    expect(ids(wire)).toEqual([HW]);
    expect(roster(wire)).toEqual([HW]);
    const devices = wire.calls.indexOf(`publish ${BASE}/devices`);
    const cleared = wire.calls.indexOf(`publish ${BASE}/devices/${GONE}/status`);
    expect(cleared).toBeGreaterThan(devices);
    expect(wire.last(`${BASE}/devices/${GONE}/status`)).toEqual({ topic: `${BASE}/devices/${GONE}/status`, payload: "", retain: true });
  });

  it("clears the retained status of a device that leaves before the doer describes it", async () => {
    const LATE = "0x00158d0001a2b3c9";
    const store = new MemoryStore();
    await store.admit(LATE);
    const { wire, doer } = await bridge({ store });
    await doer.leave(LATE);
    expect(store.device(LATE)).toBeUndefined();
    expect(wire.last(`${BASE}/devices/${LATE}/status`)).toEqual({ topic: `${BASE}/devices/${LATE}/status`, payload: "", retain: true });
    expect(events(wire, "left")).toMatchObject([{ device: LATE }]);
  });

  it("does nothing for hardware it never had", async () => {
    const { wire, doer } = await bridge();
    await doer.leave("0x0000000000000001");
    expect(events(wire, "left")).toEqual([]);
  });
});

describe("settings and re-description (GA-BRIDGE-74)", () => {
  it("publishes the new devices before the status that carries the setting, and keeps the setting", async () => {
    const { wire, doer, store } = await bridge({ initial: [pusher()] });
    expect(wire.last(`${BASE}/devices`)!.payload.devices[0].actions.map((a: { action: string }) => a.action)).toEqual([`${NS}.set_mode`]);
    const mark = wire.calls.length;
    await doer.describe(pusher("click"));
    await doer.observe(PUSHER, { [MODE]: "click" });
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/status`, `publish ${BASE}/devices/${PUSHER}/status`]);
    const turnOn = wire.last(`${BASE}/devices`)!.payload.devices[0].actions.find((a: { action: string }) => a.action === "onoff.turn_on");
    expect(turnOn.idempotent).toBe(false);
    expect(wire.last(`${BASE}/devices/${PUSHER}/status`)!.payload[MODE]).toBe("click");
    expect(store.settings(PUSHER)).toEqual({ [MODE]: { value: "click", at: expect.any(Number) } });
  });

  it("gives the kept settings to the doer at the next start, and publishes them with their observation's time", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, initial: [pusher()] });
    const at = clock.now();
    await first.doer.describe(pusher("click"));
    await first.doer.observe(PUSHER, { [MODE]: "click" });
    await first.b.stop();
    await clock.advance(60_000);
    const second = await bridge({ store, clock, initial: [pusher("click")] });
    expect(second.doer.startSettings).toEqual(new Map([[PUSHER, { [MODE]: "click" }]]));
    expect(second.wire.last(`${BASE}/devices/${PUSHER}/status`)!.payload).toEqual({ deviceId: PUSHER,
      timestamp: new Date(at).toISOString(), [MODE]: "click", available: true });
  });

  it("drops every kept setting of a device interviewed again, and keeps them over anything else (GA-BRIDGE-79)", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, initial: [pusher()] });
    await first.doer.describe(pusher("click"));
    await first.doer.observe(PUSHER, { [MODE]: "click" });
    await first.b.stop();
    const second = await bridge({ store, clock, initial: [pusher("click")] });
    // A secured rejoin is no interview: an announce and messages keep what was kept.
    await second.doer.observe(PUSHER, {});
    expect(second.wire.last(`${BASE}/devices/${PUSHER}/status`)!.payload[MODE]).toBe("click");
    const interviewedAt = clock.now();
    second.doer.events!.interviewed(PUSHER);
    await settle();
    // Not an empty payload, which is a removal (GA-BRIDGE-21): the device is still listed, and its
    // status now carries no reading, stamped with the interview (GA-BRIDGE-79, GA-BRIDGE-1).
    expect(second.wire.last(`${BASE}/devices/${PUSHER}/status`)!.payload).toEqual({ deviceId: PUSHER,
      timestamp: new Date(interviewedAt).toISOString(), available: true });
    expect(store.settings(PUSHER)).toEqual({});
  });

  it("writes a setting observed while the store is away once it is back", async () => {
    const { doer, store, clock } = await bridge({ initial: [pusher("switch")] });
    store.down = true;
    await doer.observe(PUSHER, {});
    await clock.advance(STORE_RETRY_MS);
    await doer.observe(PUSHER, { [MODE]: "switch" });
    expect(store.settings(PUSHER)).toEqual({});
    store.down = false;
    await clock.advance(10 * STORE_RETRY_MS);
    expect(store.settings(PUSHER)[MODE]!.value).toBe("switch");
  });
});

describe("keys a device has not yet sent (GA-BRIDGE-80)", () => {
  const radar = (awaitedKeys?: string[]): Description => lamp({ hardwareId: "radar", stableIdentifier: "radar", capabilities: ["sensor"],
    actions: [], sensorKeys: ["occupancy", "illuminance", ...["temperature"].filter((k) => !awaitedKeys?.includes(k))],
    ...(awaitedKeys ? { awaitedKeys } : {}) });

  it("lists the awaited keys on the entry, drops a reading of one, and keeps a key once its devices declares it", async () => {
    const { wire, doer, store } = await bridge({ initial: [radar(["temperature"])] });
    const entry = () => wire.last(`${BASE}/devices`)!.payload.devices.find((d: { id: string }) => d.id === "radar");
    expect(entry().awaitedKeys).toEqual(["temperature"]);
    expect(entry().sensorKeys).not.toContain("temperature");
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    await doer.observe("radar", { temperature: 21.5, occupancy: true });
    expect(wire.last(`${BASE}/devices/radar/status`)!.payload).not.toHaveProperty("temperature");
    const mark = wire.calls.length;
    await doer.describe(radar());
    await doer.observe("radar", { temperature: 21.5 });
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/status`, `publish ${BASE}/devices/radar/status`]);
    expect(entry()).not.toHaveProperty("awaitedKeys");
    expect(wire.last(`${BASE}/devices/radar/status`)!.payload.temperature).toBe(21.5);
    await settle();
    expect(store.reported("radar")).toEqual(["temperature"]);
  });

  it("gives the reported keys to the doer at the next start", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, initial: [radar(["temperature"])] });
    await first.doer.describe(radar());
    await settle();
    await first.b.stop();
    const second = await bridge({ store, clock, initial: [radar()] });
    expect(second.doer.startReported).toEqual(new Map([["radar", ["temperature"]]]));
  });
});

describe("the store's backoff around admissions", () => {
  it("does not try the store for a description while a retry is pending, and admits it with the retry", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.down = true;
    await doer.describe(lamp({ hardwareId: "a", stableIdentifier: "a" }));
    const tries = store.tries;
    await doer.describe(lamp({ hardwareId: "b", stableIdentifier: "b" }));
    await doer.admit("c", "association");
    expect(store.tries).toBe(tries);
    store.down = false;
    await clock.advance(STORE_RETRY_MS);
    expect(ids(wire)).toEqual([HW, "a", "b"]);
    expect(events(wire, "joined").map((e) => e.device)).toEqual(["a", "b", "c"]);
  });

  it("keeps the description of a re-admission held while the store is away, and admits the hardware with it", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.down = true;
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    store.down = false;
    await clock.advance(STORE_RETRY_MS);
    expect(ids(wire)).toEqual([`${HW}-2`]);
    expect(events(wire, "joined")).toMatchObject([{ device: `${HW}-2` }]);
  });

  it("keeps store_fault, and its backoff, while check-in saves fail though an admission succeeds", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.failCheckIns = true;
    await doer.observe(HW, { on: true });
    expect(wire.last(`${BASE}/status`)!.payload.faults).toMatchObject([{ code: "store_fault" }]);
    // Held for the retry, which admits it and then fails the check-in save again.
    await doer.describe(lamp({ hardwareId: "a", stableIdentifier: "a" }));
    await clock.advance(STORE_RETRY_MS);
    expect(ids(wire)).toEqual([HW, "a"]);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toMatchObject([{ code: "store_fault" }]);
    // The backoff stands: the next retry is 2 s on, not 1 s.
    store.failCheckIns = false;
    await clock.advance(STORE_RETRY_MS);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toMatchObject([{ code: "store_fault" }]);
    await clock.advance(STORE_RETRY_MS);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
  });

  it("clears store_fault when every device whose check-in went unsaved has left, and saves check-ins again", async () => {
    const { wire, doer, store, clock } = await bridge();
    store.failCheckIns = true;
    await doer.observe(HW, { on: true });
    expect(wire.last(`${BASE}/status`)!.payload.faults).toMatchObject([{ code: "store_fault" }]);
    // The only unsaved check-in leaves before the retry: nothing waits for the store any more.
    await doer.leave(HW);
    store.failCheckIns = false;
    await clock.advance(STORE_RETRY_MS);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
    // A device that checks in later has its check-in saved while running.
    const NEW = "0x00158d0001a2b3c9";
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    await doer.observe(NEW, { on: true });
    expect(store.device(NEW)!.lastCheckIn).not.toBeNull();
  });

  it("holds an indication that comes after the retry is due but before it runs, and admits the hardware once", async () => {
    const { wire, doer, store, clock } = await bridge({ initial: [] });
    const NEW = "0x00158d0001a2b3c9";
    // Off the second, so that no tick of the bridge's own lets the chain run before the retry is due.
    await clock.advance(500);
    store.down = true;
    await doer.admit(NEW, "association");
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    store.down = false;
    // A second announce, queued on the doer's chain just before the retry timer fires.
    await clock.advance(STORE_RETRY_MS - 1);
    doer.events!.admitted(NEW, "securedRejoin");
    await clock.advance(1);
    await settle();
    expect(events(wire, "joined")).toMatchObject([{ device: NEW }]);
    expect(store.writes.filter((w) => w.startsWith("admit"))).toHaveLength(1);
    expect(ids(wire)).toEqual([NEW]);
  });
});

describe("the mutations", () => {
  it("keeps-a-stale-description: a re-description changes nothing", async () => {
    const { wire, doer } = await bridge({ mutation: "keeps-a-stale-description", initial: [pusher("switch")] });
    await doer.describe(pusher("click"));
    const turnOn = wire.last(`${BASE}/devices`)!.payload.devices[0].actions.find((a: { action: string }) => a.action === "onoff.turn_on");
    expect(turnOn.idempotent).toBe(true);
  });

  it("leaves-retained-state: a device that left keeps its retained status", async () => {
    const { wire, doer } = await bridge({ mutation: "leaves-retained-state" });
    await doer.observe(HW, { on: true });
    await doer.leave(HW);
    expect(ids(wire)).toEqual([]);
    expect(wire.last(`${BASE}/devices/${HW}/status`)!.payload.on).toBe(true);
  });

  it("reuses-id-on-join: a new admission keeps the hardware's old id", async () => {
    const { wire, doer } = await bridge({ mutation: "reuses-id-on-join" });
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    expect(events(wire, "joined")).toMatchObject([{ device: HW }]);
    expect(ids(wire)).toEqual([HW]);
  });
});
