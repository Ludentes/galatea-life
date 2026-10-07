import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { OCCURRENCE_REPEAT_MS, UNDESCRIBED_MAX, ZigbeeBridge, type Mutation } from "../src/bridge.js";
import type { Description } from "../src/port.js";
import { FakeClock, FakeDoer, FakeWire, lamp, MemoryStore, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/zigbee`;
const BED = "0x00124b0029a1c2d3";
const STATUS = `${BASE}/devices/${BED}/status`;
const EVENT = `${BASE}/event`;
const NS = "org.galatea.zigbee.ts0210";

/** A vibration sensor as the passports describe the TS0210: an event key, a battery, a sensitivity setting with no action. */
function sensor(over: Partial<Description> = {}): Description {
  return {
    hardwareId: BED, stableIdentifier: BED, model: { vendor: "_TZ3000_bmfxbjd2", model: "TS0210" },
    capabilities: ["sensor"], sensorKeys: ["battery"], actions: [], feedback: "closed", reachMs: 0, proposedClass: "sensor",
    classEvidence: "model_db", otherAdmins: "unknown", basis: "report", cadenceMs: null, basisMaxAgeMs: 3_600_000,
    extensions: [{
      capability: NS, description: "A vibration sensor's alarm and setting",
      keys: [
        { key: `${NS}.vibration`, kind: "event", description: "The sensor felt a vibration", schema: { type: "boolean" } },
        { key: `${NS}.sensitivity`, kind: "state", description: "How little shakes it", schema: { type: "integer", minimum: 0, maximum: 50 } },
      ],
    }],
    personal: [`${NS}.vibration`],
    ...over,
  };
}

const bridges: ZigbeeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function bridge(opts: { mutation?: Mutation; store?: MemoryStore; clock?: FakeClock; description?: Description } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const wire = new FakeWire();
  const doer = new FakeDoer(clock);
  doer.initial = [opts.description ?? sensor()];
  const store = opts.store ?? new MemoryStore();
  const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store,
    ...(opts.mutation ? { runId: "run-1", mutation: opts.mutation } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, doer, store };
}

const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;
const faultsOf = (wire: FakeWire) => status(wire).faults as { code: string; device?: string; detail?: string }[];
const entryOf = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices[0];
const occurrences = (wire: FakeWire) => wire.all(EVENT).map((p) => p.payload).filter((e) => e.type === "occurrence");

describe("extensions and kinds", () => {
  it("declares a device's extensions, with each extension state key no action confirms as selfChanging", async () => {
    const { wire } = await bridge();
    const entry = entryOf(wire);
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    expect(entry.extensions).toEqual(sensor().extensions);
    expect(entry.personal).toEqual([`${NS}.vibration`]);
    expect(entry.selfChanging).toEqual([`${NS}.sensitivity`]);
  });

  it("does not count a key an action confirms as selfChanging", async () => {
    const setSensitivity = { action: `${NS}.set_sensitivity`, idempotent: true, stateless: false, confirms: false,
      args: { sensitivity: { min: 0, max: 50 } }, confirmedBy: { key: `${NS}.sensitivity`, value: { arg: "sensitivity" } } };
    const ext = sensor().extensions![0]!;
    const { wire } = await bridge({ description: sensor({ actions: [setSensitivity],
      extensions: [{ ...ext, actions: [{ action: setSensitivity.action, description: "Sets it", schema: { type: "integer" } }] }] }) });
    expect(entryOf(wire).selfChanging).toBeUndefined();
    expect(entryOf(wire).actions).toEqual([setSensitivity]);
  });

  it("publishes an extension state key as a reading of its type, and never an event key", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.observe(BED, { battery: 80, [`${NS}.sensitivity`]: 20, [`${NS}.vibration`]: true });
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: BED, timestamp: new Date(clock.now()).toISOString(), battery: 80,
      [`${NS}.sensitivity`]: 20, available: true });
    expect(validate("bridge/device-status.json", wire.last(STATUS)!.payload)).toEqual([]);
    await doer.observe(BED, { [`${NS}.sensitivity`]: "high" });
    expect(wire.last(STATUS)!.payload[`${NS}.sensitivity`]).toBe(20);
    expect(faultsOf(wire)).toEqual([]);
  });
});

describe("settings and selfChanging", () => {
  it("never counts a setting as selfChanging, confirmed by an action or not (GA-BRIDGE-38, 79)", async () => {
    const { wire: unlisted } = await bridge();
    expect(entryOf(unlisted).selfChanging).toContain(`${NS}.sensitivity`);
    const { wire } = await bridge({ description: sensor({ settings: [`${NS}.sensitivity`] }) });
    expect(entryOf(wire).selfChanging ?? []).not.toContain(`${NS}.sensitivity`);
  });
});

describe("undescribed data (GA-BRIDGE-76)", () => {
  const listed = (wire: FakeWire) => entryOf(wire).undescribed as { name: string; firstSeen: string }[] | undefined;
  const announced = (wire: FakeWire) => wire.all(EVENT).map((p) => p.payload).filter((e) => e.type === "undescribed")
    .map((e) => [e.device, e.name]);

  it("lists a key the device does not declare on its entry, announces it once, never publishes it, and raises no fault", async () => {
    const { wire, doer, clock } = await bridge();
    const at = new Date(clock.now()).toISOString();
    await doer.observe(BED, { battery: 80, dp108: 3 });
    expect(wire.last(STATUS)!.payload.dp108).toBeUndefined();
    expect(listed(wire)).toEqual([{ name: "dp108", firstSeen: at }]);
    expect(announced(wire)).toEqual([[BED, "dp108"]]);
    expect(faultsOf(wire)).toEqual([]);
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    for (const e of wire.all(EVENT)) expect(validate("bridge/event.json", e.payload)).toEqual([]);
    await doer.observe(BED, { dp108: 4 });
    expect(announced(wire)).toHaveLength(1);
  });

  it("takes the doer's names in the list's form, keeps the first 32, and neither lists nor announces a later one", async () => {
    const { wire, doer } = await bridge();
    await doer.undescribe(BED, ["genBasic.0x4000", "dp 111"]);
    expect(listed(wire)!.map((u) => u.name)).toEqual(["genBasic.0x4000", "dp_111"]);
    await doer.undescribe(BED, Array.from({ length: 40 }, (_, i) => `dp${100 + i}`));
    expect(listed(wire)).toHaveLength(UNDESCRIBED_MAX);
    expect(announced(wire)).toHaveLength(UNDESCRIBED_MAX);
    expect(listed(wire)!.at(-1)!.name).toBe("dp129");
  });

  it("drops a name once a description declares it", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(BED, { [`${NS}.mode`]: "x" });
    expect(listed(wire)).toHaveLength(1);
    const ext = sensor().extensions![0]!;
    await doer.describe(sensor({ extensions: [{ ...ext, keys: [...ext.keys!, { key: `${NS}.mode`, schema: { type: "string" } }] }] }));
    expect(listed(wire)).toBeUndefined();
  });

  it("lists an occurrence of a key the device does not declare as an event", async () => {
    const { wire, doer } = await bridge();
    await doer.occur(BED, `${NS}.sensitivity`, 3, "f1");
    expect(occurrences(wire)).toEqual([]);
    expect(listed(wire)!.map((u) => u.name)).toEqual([`${NS}.sensitivity`]);
  });

  it("keeps the list across a restart with each name's first time, and announces none of it again", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock });
    const at = new Date(clock.now()).toISOString();
    await first.doer.observe(BED, { dp108: 3 });
    await settle();
    await first.b.stop();
    await clock.advance(60_000);
    const second = await bridge({ store, clock });
    expect(listed(second.wire)).toEqual([{ name: "dp108", firstSeen: at }]);
    await second.doer.observe(BED, { dp108: 3 });
    expect(announced(second.wire)).toEqual([]);
  });
});

describe("occurrences (GA-BRIDGE-75)", () => {
  it("publishes an event key once, as an occurrence with seq from 1, never in the status, and checks the device in", async () => {
    const { wire, doer, clock } = await bridge();
    const at = clock.now() - 2000;
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-17", at);
    const [e] = wire.all(EVENT);
    expect(e!.retain).toBe(false);
    expect(validate("bridge/event.json", e!.payload)).toEqual([]);
    expect(e!.payload).toMatchObject({ seq: 1, type: "occurrence", device: BED, key: `${NS}.vibration`, value: true,
      timestamp: new Date(at).toISOString() });
    expect(typeof e!.payload.instanceId).toBe("string");
    expect(wire.all(STATUS)).toHaveLength(0);
    // When the occurrence reached the bridge, not the device's stamp (GA-BRIDGE-37).
    expect(status(wire).devices[0].lastCheckIn).toBe(new Date(clock.now()).toISOString());
  });

  it("drops the same frame and payload within 10 s, and takes a new frame, a new payload or the frame after 10 s", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-17");
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-17");
    expect(occurrences(wire)).toHaveLength(1);
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-18");
    await doer.occur(BED, `${NS}.vibration`, false, "tsn-18");
    expect(occurrences(wire)).toHaveLength(3);
    await clock.advance(OCCURRENCE_REPEAT_MS + 1);
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-17");
    expect(occurrences(wire).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("drops one while the broker is away, and its seq with it, so the next shows the gap", async () => {
    const { wire, doer } = await bridge();
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-17");
    wire.isConnected = false;
    await doer.occur(BED, `${NS}.vibration`, false, "tsn-18");
    wire.isConnected = true;
    await wire.reconnected();
    await doer.occur(BED, `${NS}.vibration`, true, "tsn-19");
    expect(occurrences(wire).map((e) => [e.seq, e.value])).toEqual([[1, true], [3, true]]);
  });

  it("never publishes one again: not on a snapshot, nor after a restart", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock });
    await first.doer.occur(BED, `${NS}.vibration`, true, "tsn-17");
    await first.wire.deliver(`${BASE}/request/snapshot`, { requestId: randomUUID(), issuedAt: new Date().toISOString() });
    expect(first.wire.last(`${BASE}/reply`)!.payload.status).toBe("ok");
    expect(occurrences(first.wire)).toHaveLength(1);
    await first.b.stop();
    const second = await bridge({ store, clock });
    expect(occurrences(second.wire)).toEqual([]);
  });

  it("leaves out an occurrence whose value is not the key's type", async () => {
    const { wire, doer } = await bridge();
    await doer.occur(BED, `${NS}.vibration`, "yes", "f1");
    expect(occurrences(wire)).toEqual([]);
  });
});

describe("extension names (GA-BRIDGE-77)", () => {
  it("leaves out an extension that breaks them, with its actions, and names it in a fault for the device", async () => {
    const bad = { capability: "org.galatea.zigbee.vibe", keys: [{ key: "org.galatea.zigbee.vibe.battery", schema: { type: "number" } }],
      actions: [{ action: "org.galatea.zigbee.vibe.calibrate" }] };
    const calibrate = { action: "org.galatea.zigbee.vibe.calibrate", idempotent: true, stateless: true, confirms: true };
    const { wire, doer } = await bridge({ description: sensor({ extensions: [...sensor().extensions!, bad], actions: [calibrate] }) });
    expect(entryOf(wire).extensions.map((e: { capability: string }) => e.capability)).toEqual([NS]);
    expect(entryOf(wire).actions).toEqual([]);
    expect(faultsOf(wire)).toEqual([{ code: "invalid_extension", device: BED,
      detail: "org.galatea.zigbee.vibe: the key org.galatea.zigbee.vibe.battery reports a quantity the vocabulary names" }]);
    await doer.observe(BED, { "org.galatea.zigbee.vibe.battery": 50 });
    expect(wire.last(STATUS)?.payload["org.galatea.zigbee.vibe.battery"]).toBeUndefined();
    await doer.describe(sensor());
    expect(faultsOf(wire)).toEqual([]);
    expect(entryOf(wire).undescribed.map((u: { name: string }) => u.name)).toEqual(["org.galatea.zigbee.vibe.battery"]);
  });
});

describe("the port's descriptions", () => {
  it("never publishes an extension whose names are no strings, and names it in a fault for the device", async () => {
    const junk = [
      { capability: 7, keys: [] },
      { capability: "org.galatea.zigbee.odd", actions: [{ action: 9 }] },
      { capability: "org.galatea.zigbee.odder", keys: [{ key: null }] },
      { capability: "org.galatea.zigbee.oddest", keys: "mode" },
      null,
    ] as unknown as NonNullable<Description["extensions"]>;
    const { wire } = await bridge({ description: sensor({ extensions: [...sensor().extensions!, ...junk] }) });
    expect(entryOf(wire).extensions.map((e: { capability: string }) => e.capability)).toEqual([NS]);
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    expect(faultsOf(wire).map((f) => [f.code, f.device])).toEqual([["invalid_extension", BED]]);
  });

  it("takes no description of a new device whose shape is wrong, and admits nothing for it", async () => {
    const { wire, doer, store } = await bridge();
    const other = "0x00124b0029a1c2d4";
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    await doer.describe({ ...sensor({ hardwareId: other, stableIdentifier: other }), actions: undefined } as unknown as Description);
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED]);
    expect(store.device(other)).toBeUndefined();
    expect(wire.all(EVENT)).toEqual([]);
    // No device to name: the bridge's own fault names the hardware, until a description it can take.
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", detail: `${other}: actions is no list` }]);
    // Hardware never admitted that leaves takes its refusal with it.
    await doer.leave(other);
    expect(faultsOf(wire)).toEqual([]);
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", detail: `${other}: reachMs is no number of milliseconds` }]);
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other }));
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED, other]);
    expect(faultsOf(wire)).toEqual([]);
  });

  it("names a device admitted before its description in a fault when that description cannot be taken, until one can, or it leaves", async () => {
    const { wire, doer } = await bridge();
    const other = "0x00124b0029a1c2d4";
    // The herdsman doer's order: the admission first, the description after the interview.
    await doer.admit(other, "association");
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", device: other, detail: "reachMs is no number of milliseconds" }]);
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other }));
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED, other]);
    expect(faultsOf(wire)).toEqual([]);
    const third = "0x00124b0029a1c2d5";
    await doer.admit(third, "association");
    await doer.describe(sensor({ hardwareId: third, stableIdentifier: third, reachMs: Number.NaN }));
    expect(faultsOf(wire).map((f) => [f.code, f.device])).toEqual([["invalid_description", third]]);
    await doer.leave(third);
    expect(faultsOf(wire)).toEqual([]);
  });

  it("drops the description held for the store when a later one cannot be taken, so the retry restores no action", async () => {
    const store = new MemoryStore();
    const { wire, doer, clock } = await bridge({ store });
    const other = "0x00124b0029a1c2d4";
    store.down = true;
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other }));
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    expect(faultsOf(wire).map((f) => [f.code, f.device, f.detail])).toContainEqual(
      ["invalid_description", undefined, `${other}: reachMs is no number of milliseconds`]);
    store.down = false;
    await clock.advance(1000);
    // Admitted, waiting for a description it can take: in no `devices`, and named until then.
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED]);
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other }));
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED, other]);
    expect(faultsOf(wire)).toEqual([]);
  });

  it("clears the fault of a device the store keeps once it is described, or it leaves", async () => {
    const store = new MemoryStore();
    await store.admit(BED);
    const { wire, doer } = await bridge({ store, description: sensor({ reachMs: Number.NaN }) });
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", device: BED, detail: "reachMs is no number of milliseconds" }]);
    await doer.describe(sensor());
    expect(entryOf(wire).id).toBe(BED);
    expect(faultsOf(wire)).toEqual([]);
    const other = "0x00124b0029a1c2d4";
    await store.admit(other);
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    expect(faultsOf(wire).map((f) => [f.code, f.device])).toEqual([["invalid_description", other]]);
    await doer.leave(other);
    expect(faultsOf(wire)).toEqual([]);
  });

  it("clears the fault of an id a new admission takes out of use", async () => {
    const { wire, doer } = await bridge();
    const other = "0x00124b0029a1c2d4";
    await doer.admit(other, "association");
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    expect(faultsOf(wire).map((f) => [f.code, f.device])).toEqual([["invalid_description", other]]);
    await doer.admit(other, "association");
    expect(faultsOf(wire)).toEqual([]);
  });

  it("moves a refusal of held hardware onto its device once the store admits it", async () => {
    const store = new MemoryStore();
    const { wire, doer, clock } = await bridge({ store });
    const other = "0x00124b0029a1c2d4";
    store.down = true;
    await doer.admit(other, "association");
    await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, reachMs: Number.NaN }));
    store.down = false;
    await clock.advance(1000);
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", device: other, detail: "reachMs is no number of milliseconds" }]);
  });

  it("bounds the bridge's refusal fault: hardware ids cut, at most eight named, and the rest counted", async () => {
    const { wire, doer } = await bridge();
    for (let i = 0; i < 10; i++) await doer.describe({ ...sensor({ hardwareId: `hw-${i}` }), actions: "no" } as unknown as Description);
    await doer.describe({ ...sensor({ hardwareId: "x".repeat(300) }), actions: "no" } as unknown as Description);
    await doer.describe({ ...sensor(), hardwareId: 7 } as unknown as Description);
    const [f] = faultsOf(wire);
    expect(f!.detail!.split("; ")).toHaveLength(9);
    expect(f!.detail).toMatch(/; and 3 more$/);
    expect(f!.detail!.length).toBeLessThan(1024);
    expect(faultsOf(wire)).toHaveLength(1);
  });

  it("takes no description whose action's arguments, confirming key or flags have the wrong shape", async () => {
    const { wire, doer } = await bridge();
    const other = "0x00124b0029a1c2d4";
    const act = { action: `${NS}.set_sensitivity`, idempotent: true, stateless: false, confirms: false };
    for (const [over, why] of [
      [{ args: { sensitivity: null } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ args: { sensitivity: { min: "0" } } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ args: { sensitivity: [{}] } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ args: [] }, `${NS}.set_sensitivity: args is no map of constraints`],
      // A step is a positive finite number (plan 2c-2 review I1).
      [{ args: { sensitivity: { min: 0, step: 0 } } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ args: { sensitivity: { min: 0, step: "1" } } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ args: { sensitivity: { min: 0, step: -1 } } }, `${NS}.set_sensitivity: the argument sensitivity has no constraint`],
      [{ confirmedBy: { key: 3, value: 1 } }, `${NS}.set_sensitivity: confirmedBy is not { key, value }`],
      [{ toggles: "yes" }, `${NS}.set_sensitivity: toggles or wholeState is no boolean`],
    ] as const) {
      await doer.describe(sensor({ hardwareId: other, stableIdentifier: other, actions: [{ ...act, ...over } as never] }));
      expect(faultsOf(wire)).toEqual([{ code: "invalid_description", detail: `${other}: ${why}` }]);
    }
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([BED]);
  });

  it("offers no action on a known device whose new description has no reach, keeping its entry", async () => {
    const setSensitivity = { action: `${NS}.set_sensitivity`, idempotent: true, stateless: false, confirms: false,
      args: { sensitivity: { min: 0, max: 50 } }, confirmedBy: { key: `${NS}.sensitivity`, value: { arg: "sensitivity" } } };
    const { wire, doer } = await bridge({ description: sensor({ actions: [setSensitivity] }) });
    expect(entryOf(wire).actions).toHaveLength(1);
    await doer.describe({ ...sensor({ actions: [setSensitivity] }), reachMs: undefined } as unknown as Description);
    expect(entryOf(wire)).toMatchObject({ id: BED, reachMs: 0, actions: [] });
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    expect(faultsOf(wire)).toEqual([{ code: "invalid_description", device: BED, detail: "reachMs is no number of milliseconds" }]);
    await doer.describe(sensor({ actions: [setSensitivity] }));
    expect(entryOf(wire).actions).toHaveLength(1);
    expect(faultsOf(wire)).toEqual([]);
  });
});

describe("the port's times", () => {
  it("drops an observation or occurrence whose time is no number, and goes on serving", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.observe(BED, { battery: 80 }, Number.NaN);
    await doer.occur(BED, `${NS}.vibration`, true, "f1", Number.NaN);
    expect(wire.all(STATUS)).toHaveLength(0);
    expect(occurrences(wire)).toEqual([]);
    const before = wire.all(`${BASE}/status`).length;
    await clock.advance(10_000);
    expect(wire.all(`${BASE}/status`).length).toBeGreaterThan(before);
    await doer.observe(BED, { battery: 80 });
    expect(wire.last(STATUS)!.payload.battery).toBe(80);
  });
});

describe("the mutations", () => {
  it("publishes-an-undescribed-key: an undeclared key is a reading, and the list names it nowhere", async () => {
    const { wire, doer } = await bridge({ mutation: "publishes-an-undescribed-key" });
    await doer.observe(BED, { dp108: 3 });
    await doer.undescribe(BED, ["dp111"]);
    expect(wire.last(STATUS)!.payload.dp108).toBe(3);
    expect(entryOf(wire).undescribed).toBeUndefined();
  });

  it("retains-an-occurrence: the event key's value is in the retained status too", async () => {
    const { wire, doer } = await bridge({ mutation: "retains-an-occurrence" });
    await doer.occur(BED, `${NS}.vibration`, true, "f1");
    expect(occurrences(wire)).toHaveLength(1);
    expect(wire.last(STATUS)!.payload[`${NS}.vibration`]).toBe(true);
  });

  it("replays-an-occurrence: the next start publishes it again", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, mutation: "replays-an-occurrence" });
    await first.doer.occur(BED, `${NS}.vibration`, true, "f1");
    await first.b.stop();
    const second = await bridge({ store, clock, mutation: "replays-an-occurrence" });
    expect(occurrences(second.wire)).toHaveLength(1);
  });

  it("misnames-an-extension: an extension that breaks the names is published", async () => {
    const bad = { capability: "org.galatea.zigbee.vibe", keys: [{ key: "org.galatea.zigbee.vibe.battery" }] };
    const { wire } = await bridge({ mutation: "misnames-an-extension", description: sensor({ extensions: [bad] }) });
    expect(entryOf(wire).extensions).toEqual([bad]);
    expect(faultsOf(wire)).toEqual([]);
  });

  it("is honoured only under a run", async () => {
    const clock = new FakeClock();
    const wire = new FakeWire();
    const doer = new FakeDoer(clock);
    doer.initial = [lamp()];
    const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire,
      store: new MemoryStore(), mutation: "publishes-an-undescribed-key" });
    bridges.push(b);
    await b.start();
    await doer.observe(lamp().hardwareId, { on: true, dp108: 3 });
    expect(wire.last(`${BASE}/devices/${lamp().hardwareId}/status`)!.payload.dp108).toBeUndefined();
  });
});
