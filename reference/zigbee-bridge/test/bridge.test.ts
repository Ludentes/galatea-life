import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { LEAVE_MS, READ_BACK_LEAD_MS, SAVE_MS, ZigbeeBridge, type ZigbeeBridgeOptions } from "../src/bridge.js";
import { closedActions } from "../src/vocabulary.js";
import { FakeClock, FakeDoer, FakeWire, lamp, MemoryStore, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/zigbee`;
const SUBS = `subscribe ${BASE}/devices/+/command ${BASE}/request/+`;
const UNSUBS = `unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`;
const HW = "0x00158d0001a2b3c4";
const COMMAND = `${BASE}/devices/${HW}/command`;
const ACK = `${BASE}/devices/${HW}/ack`;
const STATUS = `${BASE}/devices/${HW}/status`;

const bridges: ZigbeeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function bridge(extra: Partial<ZigbeeBridgeOptions> & { before?: (doer: FakeDoer, wire: FakeWire) => void } = {}) {
  const clock = (extra.clock as FakeClock | undefined) ?? new FakeClock();
  const wire = new FakeWire();
  const doer = new FakeDoer(clock);
  doer.initial = [lamp()];
  extra.before?.(doer, wire);
  const store = (extra.store as MemoryStore | undefined) ?? new MemoryStore();
  const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store,
    ...(extra.runId ? { runId: extra.runId } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, doer, store };
}

/** Takes a bridge out of the afterEach list, for a test that stops it itself. */
function own(b: ZigbeeBridge): void {
  bridges.splice(bridges.indexOf(b), 1);
}

const command = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value, ...extra,
});
const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;
const coordinatorOf = (wire: FakeWire) => status(wire).transports[0];
const rosterOf = (wire: FakeWire) => status(wire).devices[0];
const at = (ms: number) => new Date(ms).toISOString();

describe("the bridge's start", () => {
  it("subscribes before anything, clears lwt, then publishes devices and a valid status", async () => {
    const { wire } = await bridge();
    // The lamp has no reading yet: its bare status, reachable, replaces whatever an earlier instance left retained.
    expect(wire.calls.slice(0, 5)).toEqual([SUBS, `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${STATUS}`, `publish ${BASE}/status`]);
    expect(wire.last(`${BASE}/lwt`)).toEqual({ topic: `${BASE}/lwt`, payload: "", retain: true });
    const s = wire.last(`${BASE}/status`)!;
    expect(s.retain).toBe(true);
    expect(validate("bridge/status.json", s.payload)).toEqual([]);
    expect(s.payload).toMatchObject({ levels: ["Serve", "Provision"], faults: [], ungoverned: [], blocked: [] });
    expect(s.payload.testRunId).toBeUndefined();
    expect(coordinatorOf(wire)).toMatchObject({ id: "coordinator", kind: "zigbee", state: "up" });
  });

  it("declares each device the doer describes under its hardware id, and its roster entry not yet observable", async () => {
    const { wire, clock } = await bridge();
    const devices = wire.last(`${BASE}/devices`)!;
    expect(devices.retain).toBe(true);
    expect(validate("bridge/devices.json", devices.payload)).toEqual([]);
    expect(devices.payload.devices).toEqual([{
      id: HW, stableIdentifier: HW, transport: "coordinator", model: { vendor: "acme", model: "bulb-1" },
      capabilities: ["onoff", "level"], actions: [...closedActions("onoff", true), ...closedActions("level", true)],
      feedback: "closed", reachMs: 0, proposedClass: "light", classEvidence: "model_db", otherAdmins: "unknown",
    }]);
    expect(rosterOf(wire)).toEqual({ id: HW, transport: "coordinator", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000,
      timestamp: null, lastCheckIn: null, observable: false, since: at(clock.now()) });
    expect(status(wire).state).toBe("offline");
    // No reading yet: only its bare status, reachable, stamped now since it never checked in.
    expect(wire.all(STATUS).map((p) => p.payload)).toEqual([{ deviceId: HW, timestamp: at(clock.now()), available: true }]);
  });

  it("carries the run id under a run", async () => {
    const { wire } = await bridge({ runId: "run-1" });
    expect(status(wire).testRunId).toBe("run-1");
  });

  it("reports a refused subscription as a fault", async () => {
    const { wire } = await bridge({ before: (_d, w) => { w.refuseSubscribe = [`${BASE}/request/+`]; } });
    expect(status(wire).faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/request/+` }]);
  });

  it("keeps a device's id and lastCheckIn across a restart", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock });
    await first.doer.observe(HW, { on: true });
    own(first.b);
    await first.b.stop();
    const { wire } = await bridge({ store, clock });
    expect(rosterOf(wire)).toMatchObject({ id: HW, lastCheckIn: at(clock.now()), observable: true });
  });

  it("puts a device described after the start in devices, then in the roster, at once", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock });
    await first.doer.observe(HW, {});
    own(first.b);
    await first.b.stop();
    const { wire, doer } = await bridge({ store, clock, before: (d) => { d.initial = []; } });
    expect(status(wire).devices).toEqual([]);
    const mark = wire.calls.length;
    await doer.describe(lamp());
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/status`]);
    expect(rosterOf(wire)).toMatchObject({ id: HW, lastCheckIn: at(clock.now()), observable: true });
  });

  it("gives hardware whose id another device once took an id never used", async () => {
    const store = new MemoryStore();
    await store.admit("lamp");
    await store.admit("lamp");
    const { wire } = await bridge({ store, before: (d) => { d.initial = [lamp({ hardwareId: "lamp-2", stableIdentifier: "lamp-2" })]; } });
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual(["lamp-2-2"]);
  });
});

describe("the announcement", () => {
  it("is made once the start reached its first devices, and not while the doer starts", async () => {
    let release!: () => void;
    let b!: ZigbeeBridge;
    const started = bridge({ before: (doer) => {
      const start = doer.start.bind(doer);
      doer.start = async (events, settings) => {
        await new Promise<void>((r) => { release = r; });
        return start(events, settings);
      };
    } });
    await settle();
    b = bridges.at(-1)!;
    expect(b.announced).toBe(false);
    release();
    await started;
    expect(b.announced).toBe(true);
  });
});

describe("a device's readings", () => {
  it("are stamped with their observation's time, and only declared keys of their type go out", async () => {
    const { wire, doer, clock } = await bridge();
    const observed = clock.now() - 5000;
    await doer.observe(HW, { on: true, level: "high", power: 3.5 }, observed);
    const s = wire.last(STATUS)!;
    expect(s.retain).toBe(true);
    expect(s.payload).toEqual({ deviceId: HW, state: "on", timestamp: at(observed), on: true, available: true });
    expect(validate("bridge/device-status.json", s.payload)).toEqual([]);
  });

  it("restamp only the keys a read brought", async () => {
    const { wire, doer, clock } = await bridge();
    const first = clock.now() - 5000;
    await doer.observe(HW, { on: true, level: 40 }, first);
    await doer.observe(HW, { level: 60 });
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: HW, state: "on", timestamp: at(clock.now()), on: true, level: 60,
      available: true, timestamps: { on: at(first) } });
  });

  it("are never stamped ahead of the bridge's clock, and an older message does not replace a newer reading", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.observe(HW, { on: true }, clock.now() + 60_000);
    expect(wire.last(STATUS)!.payload.timestamp).toBe(at(clock.now()));
    await doer.observe(HW, { on: false }, clock.now() - 1000);
    expect(wire.last(STATUS)!.payload.on).toBe(true);
  });

  it("go with the key when a re-description drops it", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true, level: 40 });
    const mark = wire.calls.length;
    await doer.describe(lamp({ capabilities: ["onoff"], actions: closedActions("onoff", true) }));
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${STATUS}`, `publish ${BASE}/status`]);
    expect(wire.last(STATUS)!.payload.level).toBeUndefined();
    await doer.observe(HW, { level: 50, on: false });
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: HW, state: "off", timestamp: expect.any(String), on: false, available: true });
  });
});

describe("a device the doer cannot reach (a mains device that stopped answering)", () => {
  it("goes out available: false, its readings kept with their old times, and a command for it is failed(unreachable) at once", async () => {
    const { wire, doer, clock } = await bridge();
    const observed = clock.now() - 5000;
    await doer.observe(HW, { on: true }, observed);
    await clock.advance(60_000);
    await doer.availability(HW, false);
    const s = wire.last(STATUS)!;
    expect(s.retain).toBe(true);
    expect(s.payload).toEqual({ deviceId: HW, state: "on", timestamp: at(observed), on: true, available: false });
    expect(validate("bridge/device-status.json", s.payload)).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
  });

  it("goes out available: true at its return, before the readings of the frame that brought it, and is commanded again", async () => {
    const { wire, doer, clock } = await bridge();
    const observed = clock.now() - 5000;
    await doer.observe(HW, { on: true }, observed);
    await doer.availability(HW, false);
    const mark = wire.all(STATUS).length;
    await doer.availability(HW, true);
    await doer.observe(HW, { on: false });
    const after = wire.all(STATUS).slice(mark).map((p) => p.payload);
    expect(after).toEqual([{ deviceId: HW, state: "on", timestamp: at(observed), on: true, available: true },
      { deviceId: HW, state: "off", timestamp: at(clock.now()), on: false, available: true }]);
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toHaveLength(1);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied" });
  });

  it("goes out as a bare status when it has no reading: stamped when the doer found it gone, and again at its return", async () => {
    const { wire, doer, clock } = await bridge();
    const gone = clock.now() - 1000;
    await doer.availability(HW, false, gone);
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: HW, timestamp: at(gone), available: false });
    expect(validate("bridge/device-status.json", wire.last(STATUS)!.payload)).toEqual([]);
    await clock.advance(5000);
    await doer.availability(HW, true);
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: HW, timestamp: at(clock.now()), available: true });
  });

  it("publishes nothing for a word that changes nothing, or for hardware it has no device for", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true });
    const mark = wire.calls.length;
    await doer.availability(HW, true);
    await doer.availability("0x00158d00000000ff", false);
    expect(wire.calls.slice(mark)).toEqual([]);
    await doer.availability(HW, false);
    await doer.availability(HW, false);
    expect(wire.calls.slice(mark)).toEqual([`publish ${STATUS}`]);
  });

  it("replaces, at a restart, the retained available: false of a device with no reading (the review, M1)", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock });
    await first.doer.observe(HW, {});
    const checkedIn = clock.now();
    await first.doer.availability(HW, false);
    expect(first.wire.last(STATUS)!.payload).toMatchObject({ available: false });
    own(first.b);
    await first.b.stop();
    // The broker keeps that retained status; the restarted bridge takes the device as reachable, its rows at zero.
    const { wire } = await bridge({ store, clock });
    expect(wire.all(STATUS).map((p) => p.payload)).toEqual([{ deviceId: HW, timestamp: at(checkedIn), available: true }]);
    expect(validate("bridge/device-status.json", wire.last(STATUS)!.payload)).toEqual([]);
  });

  it("keeps available: false through a reconnection's statuses", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true });
    await doer.availability(HW, false);
    const mark = wire.all(STATUS).length;
    await wire.reconnected();
    await settle();
    expect(wire.all(STATUS).slice(mark).map((p) => p.payload.available)).toEqual([false]);
  });
});

describe("the roster", () => {
  it("stamps lastCheckIn when the check-in reached the bridge, never with the device's own time", async () => {
    const { wire, doer, clock } = await bridge();
    const stamped = clock.now() - 3_600_000;
    await doer.observe(HW, { on: true }, stamped);
    expect(rosterOf(wire)).toMatchObject({ lastCheckIn: at(clock.now()), observable: true });
    expect(wire.last(STATUS)!.payload.timestamp).toBe(at(stamped));
  });

  it("makes a device observable on its check-in, and not once its bound has passed, each within the second", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.observe(HW, {});
    expect(rosterOf(wire)).toMatchObject({ lastCheckIn: at(clock.now()), observable: true });
    expect(status(wire).state).toBe("online");
    await clock.advance(60_000);
    expect(rosterOf(wire).observable).toBe(true);
    await clock.advance(1000);
    expect(rosterOf(wire)).toMatchObject({ observable: false, since: at(clock.now()) });
    expect(status(wire).state).toBe("offline");
  });

  it("counts a message that is no check-in toward no lastCheckIn", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true }, undefined, false);
    expect(rosterOf(wire)).toMatchObject({ lastCheckIn: null, observable: false });
  });

  it("reads an open device by its transport, with no bound and no check-in", async () => {
    const { wire, doer } = await bridge({ before: (d) => {
      d.initial = [lamp({ feedback: "open", actions: closedActions("onoff", false), capabilities: ["onoff"], basisMaxAgeMs: null })];
    } });
    expect(rosterOf(wire)).toMatchObject({ basisMaxAgeMs: null, lastCheckIn: null, observable: true });
    await doer.transport("down", 10_000);
    expect(rosterOf(wire).observable).toBe(false);
  });

  it("publishes status every 10 s of its clock", async () => {
    const { wire, clock } = await bridge();
    const before = wire.all(`${BASE}/status`).length;
    await clock.advance(30_000);
    expect(wire.all(`${BASE}/status`).length - before).toBe(3);
  });
});

describe("the coordinator", () => {
  it("goes down in the status at once, with the doer's retry, and a command is failed(unreachable)", async () => {
    const { wire, doer } = await bridge();
    await doer.transport("down", 10_000);
    expect(coordinatorOf(wire)).toMatchObject({ state: "down", retryIntervalMs: 10_000 });
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
  });

  it("serves nothing on a state mismatch: transport down, commands unreachable, status still going", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.fault("state_mismatch", "the coordinator answered with another network");
    expect(status(wire).faults).toEqual([{ code: "state_mismatch", detail: "the coordinator answered with another network" }]);
    expect(coordinatorOf(wire).state).toBe("down");
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
    const before = wire.all(`${BASE}/status`).length;
    await clock.advance(10_000);
    expect(wire.all(`${BASE}/status`).length).toBeGreaterThan(before);
    await doer.fault("state_mismatch", null);
    expect(status(wire).faults).toEqual([]);
    expect(coordinatorOf(wire).state).toBe("up");
  });
});

describe("a command", () => {
  it.each([
    ["onoff.turn_on", command({ action: "onoff.turn_on" }), {}],
    ["level.set_level", command({ action: "level.set_level", value: 40 }), { level: 40 }],
  ])("hands %s to the doer with its arguments named, acked applied once confirmed", async (action, cmd, args) => {
    const { wire, doer } = await bridge();
    await wire.deliver(COMMAND, cmd);
    expect(doer.executed).toEqual([{ hardwareId: HW, action, args, deadline: expect.any(Number) }]);
    const ack = wire.last(ACK)!;
    expect(ack.retain).toBe(false);
    expect(validate("bridge/ack.json", ack.payload)).toEqual([]);
    expect(ack.payload).toMatchObject({ commandId: cmd.commandId, source: "zigbee", result: "applied" });
  });

  it("gives the doer the lesser of the Message Expiry left and resultWithinMs as its deadline", async () => {
    const { wire, doer, clock } = await bridge();
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }, { resultWithinMs: 8000 }), { expirySeconds: 3 });
    expect(doer.executed[0]!.deadline).toBe(clock.now() + 3000);
  });

  it.each([
    ["transmitted, where the action confirms", { kind: "transmitted" }, { result: "failed", reason: "no_confirmation" }],
    ["refused", { kind: "refused", reason: "refused", detail: "UNSUP_COMMAND" }, { result: "failed", reason: "refused", detail: "UNSUP_COMMAND" }],
    ["lost", { kind: "lost", detail: "MAC_NO_ACK" }, { result: "failed", reason: "no_confirmation", detail: "MAC_NO_ACK" }],
    ["not sent", { kind: "notSent", reason: "unreachable", detail: "the converter threw" }, { result: "failed", reason: "unreachable", detail: "the converter threw" }],
  ] as const)("acks a result %s as the design's table says", async (_name, result, expected) => {
    const { wire, doer } = await bridge();
    doer.results = [result];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    const ack = wire.last(ACK)!.payload;
    expect(ack).toMatchObject(expected);
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });

  it("acks sent for an action declared confirms: false", async () => {
    const { wire, doer } = await bridge({ before: (d) => {
      d.initial = [lamp({ feedback: "open", capabilities: ["onoff"], actions: closedActions("onoff", false), basisMaxAgeMs: null })];
    } });
    doer.results = [{ kind: "transmitted" }];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(wire.last(ACK)!.payload.result).toBe("sent");
  });

  it("is failed(no_confirmation) when the doer throws, or does not answer within the command's time", async () => {
    const { wire, doer, clock } = await bridge();
    doer.execute = async () => { throw new Error("Data request failed with error: 'MAC_CHANNEL_ACCESS_FAILURE'"); };
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "no_confirmation",
      detail: "Data request failed with error: 'MAC_CHANNEL_ACCESS_FAILURE'" });
    doer.execute = () => new Promise(() => {});
    await wire.deliver(COMMAND, command({ action: "onoff.turn_off" }));
    expect(wire.all(ACK)).toHaveLength(1);
    await clock.advance(5000);
    expect(wire.all(ACK)).toHaveLength(2);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "no_confirmation" });
  });

  it("acks a command whose doer threw before answering failed(no_confirmation), once", async () => {
    const { wire, doer } = await bridge();
    doer.execute = () => { throw new Error("a bug in the doer"); };
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(wire.all(ACK).map((a) => a.payload)).toEqual([expect.objectContaining({ result: "failed", reason: "no_confirmation",
      detail: "a bug in the doer" })]);
  });

  it("answers a repeated commandId with the first ack and hands the doer nothing more", async () => {
    const { wire, doer } = await bridge();
    const cmd = command({ action: "onoff.turn_on" });
    await wire.deliver(COMMAND, cmd);
    await wire.deliver(COMMAND, cmd);
    expect(doer.executed).toHaveLength(1);
    const acks = wire.all(ACK).map((a) => a.payload);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
  });

  it("never acts on a retained command", async () => {
    const { wire, doer } = await bridge();
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }), { retained: true });
    expect(doer.executed).toEqual([]);
    expect(wire.all(ACK)).toHaveLength(0);
  });

  it.each([
    ["an unknown device", "nas", command({ action: "onoff.turn_on" }), { result: "failed", reason: "unknown_device" }],
    ["an action the device does not offer", HW, command({ action: "cover.open" }), { result: "unsupported" }],
    ["an argument out of its range", HW, command({ action: "level.set_level", value: 101 }), { result: "failed", reason: "invalid_request" }],
    ["an argument to an action with none", HW, command({ action: "onoff.turn_on", value: true }), { result: "failed", reason: "invalid_request" }],
    ["an unknown key in the value", HW, command({ action: "onoff.turn_on", force: true }), { result: "failed", reason: "invalid_request" }],
    ["an invalid command", HW, { commandId: randomUUID(), value: { action: "onoff.turn_on" } }, { result: "failed", reason: "invalid_request" }],
    ["an expired command", HW, command({ action: "onoff.turn_on" }, { resultWithinMs: 0 }), { result: "failed", reason: "expired" }],
  ])("refuses %s, handing the doer nothing", async (_name, device, cmd, expected) => {
    const { wire, doer, clock } = await bridge();
    wire.hand(`${BASE}/devices/${device}/command`, cmd);
    if ((cmd as { resultWithinMs?: number }).resultWithinMs === 0) await clock.advance(1);
    await settle();
    expect(doer.executed).toEqual([]);
    const ack = wire.last(`${BASE}/devices/${device}/ack`)!.payload;
    expect(ack).toMatchObject(expected);
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });

  it("answers unreachable for a device the store keeps that the doer has not described yet, and runs it once described", async () => {
    const store = new MemoryStore();
    const other = "0x00158d0009f8e7d6";
    await store.admit(other);
    const { wire, doer } = await bridge({ store });
    const topic = `${BASE}/devices/${other}`;
    await wire.deliver(`${topic}/command`, command({ action: "onoff.turn_on" }));
    expect(wire.last(`${topic}/ack`)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
    expect(doer.executed).toEqual([]);
    await doer.describe(lamp({ hardwareId: other, stableIdentifier: other }));
    await wire.deliver(`${topic}/command`, command({ action: "onoff.turn_on" }));
    expect(wire.last(`${topic}/ack`)!.payload).toMatchObject({ result: "applied" });
  });

  it("answers unreachable for a command that comes while the doer is still starting", async () => {
    const store = new MemoryStore();
    await store.admit(HW);
    let wire!: FakeWire;
    let release!: () => void;
    const started = bridge({ store, before: (doer, w) => {
      wire = w;
      const start = doer.start.bind(doer);
      doer.start = async (events, settings) => {
        await new Promise<void>((r) => { release = r; });
        return start(events, settings);
      };
    } });
    await settle();
    wire.hand(COMMAND, command({ action: "onoff.turn_on" }));
    await settle();
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
    release();
    await started;
  });

  it("counts a command expired when the clock steps back after its receipt, never stretching its time", async () => {
    const { wire, doer, clock } = await bridge();
    wire.hand(COMMAND, command({ action: "onoff.turn_on" }));
    clock.step(-60_000);
    await settle();
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "expired" });
  });
});

describe("the read-back", () => {
  it("reads the keys an action sets when no report came, begun in time to go out a second before the bound", async () => {
    const { wire, doer, clock } = await bridge();
    doer.onRead = (hw, keys) => doer.events!.observed(hw, Object.fromEntries(keys.map((k) => [k, true])), clock.now(), true);
    const issued = clock.now();
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }, { issuedAt: at(issued), resultWithinMs: 10_000 }));
    expect(wire.last(ACK)!.payload.result).toBe("applied");
    await clock.advance(10_000 - 1000 - READ_BACK_LEAD_MS - 1);
    expect(doer.reads).toEqual([]);
    await clock.advance(1);
    expect(doer.reads).toEqual([{ hardwareId: HW, keys: ["on"], deadline: issued + 9000, at: clock.now() }]);
    expect(wire.last(STATUS)!.payload).toMatchObject({ on: true, timestamp: at(clock.now()) });
  });

  it("reads nothing when a report of every key came after the command", async () => {
    const { wire, doer, clock } = await bridge();
    await wire.deliver(COMMAND, command({ action: "level.set_level", value: 40 }));
    await doer.observe(HW, { level: 40 });
    await clock.advance(5000);
    expect(doer.reads).toEqual([]);
  });

  it("reads back after no_confirmation too, and never for a refusal", async () => {
    const { wire, doer, clock } = await bridge();
    doer.results = [{ kind: "lost" }, { kind: "refused", reason: "refused" }];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    await wire.deliver(COMMAND, command({ action: "onoff.turn_off" }));
    await clock.advance(5000);
    expect(doer.reads.map((r) => r.keys)).toEqual([["on"]]);
  });

  it("reads nothing for a stateless action, or on an open device", async () => {
    const cover = lamp({ capabilities: ["cover"], actions: closedActions("cover", true) });
    const { wire, doer, clock } = await bridge({ before: (d) => { d.initial = [cover]; } });
    await wire.deliver(COMMAND, command({ action: "cover.stop" }));
    await clock.advance(5000);
    expect(doer.reads).toEqual([]);
    await doer.describe({ ...cover, feedback: "open", actions: closedActions("cover", false), basisMaxAgeMs: null });
    doer.results = [{ kind: "transmitted" }];
    await wire.deliver(COMMAND, command({ action: "cover.open" }));
    await clock.advance(5000);
    expect(doer.reads).toEqual([]);
  });
});

describe("a request", () => {
  const request = () => ({ requestId: randomUUID(), issuedAt: new Date().toISOString() });

  it("answers snapshot with devices, each device's status and status again, then ok", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true });
    const mark = wire.calls.length;
    const req = request();
    await wire.deliver(`${BASE}/request/snapshot`, req);
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${STATUS}`, `publish ${BASE}/status`, `publish ${BASE}/reply`]);
    const reply = wire.last(`${BASE}/reply`)!.payload;
    expect(reply).toEqual({ requestId: req.requestId, op: "snapshot", status: "ok", data: {} });
    expect(validate("bridge/reply.json", reply)).toEqual([]);
  });

  it("answers a Host op invalid_request, Host not being claimed, and a repeat with the first reply", async () => {
    const { wire, doer } = await bridge();
    const req = { ...request(), host: "pc", package: { url: "https://example.org/p.zip", sha256: "0".repeat(64) }, account: "a" };
    await wire.deliver(`${BASE}/request/install`, req);
    await wire.deliver(`${BASE}/request/install`, req);
    const replies = wire.all(`${BASE}/reply`).map((r) => r.payload);
    expect(replies).toEqual([{ requestId: req.requestId, op: "install", status: "invalid_request" },
      { requestId: req.requestId, op: "install", status: "invalid_request" }]);
    expect(doer.executed).toEqual([]);
  });

  it("never acts on a retained request", async () => {
    const { wire } = await bridge();
    await wire.deliver(`${BASE}/request/snapshot`, request(), { retained: true });
    expect(wire.all(`${BASE}/reply`)).toHaveLength(0);
  });
});

describe("the leave", () => {
  it("unsubscribes, answers the command in flight, goes offline gracefully, clears lwt, disconnects, then stops the doer", async () => {
    const { b, wire, doer } = await bridge();
    own(b);
    doer.executeHeld = new Promise(() => {});
    wire.hand(COMMAND, command({ action: "onoff.turn_on" }));
    await settle();
    expect(doer.executed).toHaveLength(1);
    const mark = wire.calls.length;
    await b.stop();
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${ACK}`, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(status(wire)).toMatchObject({ state: "offline", graceful: true });
    expect(doer.stopped).toBe(true);
  });

  it("saves every device's latest check-in", async () => {
    const store = new MemoryStore();
    const { b, doer, clock } = await bridge({ store });
    own(b);
    await doer.observe(HW, {});
    await clock.advance(30_000);
    await doer.observe(HW, {});
    expect(store.device(HW)!.lastCheckIn).toBe(clock.now() - 30_000);
    await b.stop();
    expect(store.device(HW)!.lastCheckIn).toBe(clock.now());
  });

  it("cuts the connection when the leave cannot finish within its bound", async () => {
    const { b, wire, clock } = await bridge();
    own(b);
    wire.unsubscribeHeld = new Promise(() => {});
    const stopping = b.stop();
    await settle();
    await clock.advance(LEAVE_MS);
    await stopping;
    expect(wire.calls.at(-1)).toBe("drop");
  });
});

describe("a reconnection", () => {
  it("subscribes again, clears lwt, then publishes devices, each device's status and status", async () => {
    const { wire, doer } = await bridge();
    await doer.observe(HW, { on: true });
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([SUBS, `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${STATUS}`, `publish ${BASE}/status`]);
  });
});

describe("the store", () => {
  it("is a store_fault when it is away: new hardware waits for it, and is admitted once it is back", async () => {
    const store = new MemoryStore();
    const { wire, doer, clock } = await bridge({ store });
    store.down = true;
    await doer.describe(lamp({ hardwareId: "0x00158d0009f8e7d6", stableIdentifier: "0x00158d0009f8e7d6" }));
    expect(status(wire).faults).toEqual([{ code: "store_fault", detail: "the store is unreachable" }]);
    expect(wire.last(`${BASE}/devices`)!.payload.devices).toHaveLength(1);
    store.down = false;
    await clock.advance(1000);
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([HW, "0x00158d0009f8e7d6"]);
    expect(status(wire).faults).toEqual([]);
  });

  it("keeps serving from memory while a check-in cannot be saved", async () => {
    const store = new MemoryStore();
    const { wire, doer } = await bridge({ store });
    store.down = true;
    await doer.observe(HW, { on: true });
    expect(status(wire).faults).toEqual([{ code: "store_fault", detail: "the store is unreachable" }]);
    expect(rosterOf(wire).observable).toBe(true);
    await wire.deliver(COMMAND, command({ action: "onoff.turn_off" }));
    expect(wire.last(ACK)!.payload.result).toBe("applied");
  });

  it("follows the retry backoff, not the message count, while a check-in cannot be saved", async () => {
    const store = new MemoryStore();
    const { doer, clock } = await bridge({ store });
    let calls = 0;
    const save = store.saveCheckIns.bind(store);
    store.saveCheckIns = async (e) => { calls++; return save(e); };
    store.down = true;
    for (let i = 0; i < 18; i++) {
      await doer.observe(HW, {});
      await clock.advance(10_000);
    }
    // One try, then retries after 1, 2, 4, 8, 16, 32 and 60 s: 8 within 180 s, against 18 messages.
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("clears store_fault once the store is back, and saves the check-in", async () => {
    const store = new MemoryStore();
    const { wire, doer, clock } = await bridge({ store });
    store.down = true;
    await doer.observe(HW, {});
    expect(status(wire).faults).toHaveLength(1);
    store.down = false;
    await clock.advance(1000);
    await settle();
    expect(status(wire).faults).toEqual([]);
    expect(store.device(HW)!.lastCheckIn).toBe(clock.now() - 1000);
  });

  it("saves a check-in that came during a write once it is due, or at the leave, and the fault does not outlive the store's trouble", async () => {
    const store = new MemoryStore();
    const { b, wire, doer, clock } = await bridge({ store });
    own(b);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const save = store.saveCheckIns.bind(store);
    let first = true;
    store.saveCheckIns = async (e) => { if (first) { first = false; await gate; } return save(e); };
    await doer.observe(HW, {});
    const a = clock.now();
    await clock.advance(1000);
    await doer.observe(HW, {});
    const later = clock.now();
    release();
    await settle();
    // Written at its interval, not straight after the write it came during.
    expect(store.device(HW)!.lastCheckIn).toBe(a);
    expect(status(wire).faults).toEqual([]);
    await b.stop();
    expect(store.device(HW)!.lastCheckIn).toBe(later);
  });

  it("writes every check-in at the leave, whenever in the running save it comes", async () => {
    const lost: number[] = [];
    for (let k = 0; k < 20; k++) {
      const store = new MemoryStore();
      const { b, doer, clock } = await bridge({ store });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const save = store.saveCheckIns.bind(store);
      let calls = 0;
      store.saveCheckIns = async (e) => { calls++; if (calls === 1) await gate; return save(e); };
      await doer.observe(HW, {});
      await clock.advance(1000);
      // A check-in during the first write: not yet due, so written only by the leave's full save.
      await doer.observe(HW, {});
      const later = clock.now();
      release();
      for (let i = 0; i < k; i++) await Promise.resolve();
      await b.stop();
      if (store.device(HW)!.lastCheckIn !== later) lost.push(k);
    }
    expect(lost).toEqual([]);
  });

  it("writes a slow store's check-ins once per interval, not one write after another", async () => {
    const store = new MemoryStore();
    const { doer, clock } = await bridge({ store });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const save = store.saveCheckIns.bind(store);
    let calls = 0;
    store.saveCheckIns = async (e) => { calls++; if (calls === 1) await gate; return save(e); };
    await doer.observe(HW, {});
    const a = clock.now();
    // The first write hangs for 10 s while the device checks in every second.
    for (let i = 0; i < 10; i++) {
      await clock.advance(1000);
      await doer.observe(HW, {});
    }
    release();
    await settle();
    for (let i = 0; i < 40; i++) {
      await clock.advance(1000);
      await doer.observe(HW, {});
    }
    expect(calls).toBe(1);
    expect(store.device(HW)!.lastCheckIn).toBe(a);
    await clock.advance(10_000);
    await doer.observe(HW, {});
    expect(calls).toBe(2);
    expect(store.device(HW)!.lastCheckIn).toBe(a + SAVE_MS);
  });
});

describe("native control", () => {
  it("lists in status's ungoverned each way the doer cannot disable, and drops one it no longer reports", async () => {
    const { wire, doer } = await bridge();
    expect(status(wire).ungoverned).toEqual([]);
    await doer.ungoverned(["a web frontend", "touchlink"]);
    expect(status(wire).ungoverned).toEqual(["a web frontend", "touchlink"]);
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    await doer.ungoverned(["touchlink"]);
    expect(status(wire).ungoverned).toEqual(["touchlink"]);
  });
});

describe("a lock's PIN", () => {
  const DOOR = lamp({ capabilities: ["lock"], actions: closedActions("lock", true), proposedClass: "door_lock" });
  const actionsOf = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices[0].actions.map((a: { action: string }) => a.action);

  it("offers no unlock on a lock that requires a PIN the bridge does not hold, and names the lock in a fault", async () => {
    const { wire, doer } = await bridge({ before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    expect(actionsOf(wire)).toEqual(["lock.lock"]);
    expect(status(wire).faults).toEqual([{ code: "pin_missing", device: HW, detail: expect.any(String) }]);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "unsupported" });
  });

  it("offers unlock once the owner configured the PIN, which it never publishes", async () => {
    const pin = "40719263";
    const { b, wire, doer } = await bridge({ before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(actionsOf(wire)).toEqual(["lock.lock", "lock.unlock"]);
    expect(status(wire).faults).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await settle();
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied" });
    expect(JSON.stringify(wire.published)).not.toContain(pin);
  });

  it("hands the doer the owner's PIN with the unlock alone, and never with a lock, or to a lock that requires none", async () => {
    const pin = "40719263";
    const { b, wire, doer } = await bridge({ before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await wire.deliver(COMMAND, command({ action: "lock.lock" }));
    await settle();
    expect(doer.executed.map((e) => [e.action, e.pin])).toEqual([["lock.unlock", pin], ["lock.lock", undefined]]);
    // The lock no longer requires one: its PIN stays in the bridge.
    await doer.describe(DOOR);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await settle();
    expect(doer.executed.map((e) => [e.action, e.pin])).toEqual([["lock.unlock", pin], ["lock.lock", undefined], ["lock.unlock", undefined]]);
    expect(JSON.stringify(wire.published)).not.toContain(pin);
  });

  it("never hands the PIN to a new admission of the lock's hardware, which gets a new id", async () => {
    const pin = "40719263";
    const { b, wire, doer } = await bridge({ before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(actionsOf(wire)).toEqual(["lock.lock", "lock.unlock"]);
    // Something joins under the lock's address: a new admission, a new id, and no PIN for it.
    await doer.admit(HW, "association");
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([`${HW}-2`]);
    expect(actionsOf(wire)).toEqual(["lock.lock"]);
    expect(status(wire).faults).toEqual([{ code: "pin_missing", device: `${HW}-2`, detail: expect.any(String) }]);
    await wire.deliver(`${BASE}/devices/${HW}-2/command`, command({ action: "lock.unlock" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(`${BASE}/devices/${HW}-2/ack`)!.payload).toMatchObject({ result: "unsupported" });
    // The owner configures a PIN for the lock now at the hardware: it goes to the new id.
    expect(b.setPinFor(HW, pin)).toBe(true);
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(actionsOf(wire)).toEqual(["lock.lock", "lock.unlock"]);
  });

  it("sets no PIN for hardware whose new admission waits for the store", async () => {
    const store = new MemoryStore();
    const { b, doer } = await bridge({ store, before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    store.down = true;
    await doer.admit(HW, "association");
    expect(b.setPinFor(HW, "40719263")).toBe(false);
  });

  it("writes a new admission held for the store at the leave, so the next start gives the newcomer a new id and no PIN", async () => {
    const pin = "40719263";
    const store = new MemoryStore();
    const { b, doer } = await bridge({ store, before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    store.down = true;
    await doer.admit(HW, "association");
    // The store is back, the retry not yet run, and the bridge restarts.
    store.down = false;
    await b.stop();
    const clock = new FakeClock();
    const wire = new FakeWire();
    const next = new FakeDoer(clock);
    next.initial = [{ ...DOOR, pinRequired: true }];
    const again = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer: next, wire, store });
    // The owner's configuration still names the lock's old id.
    again.setPin(HW, pin);
    await again.start();
    await settle();
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([`${HW}-2`]);
    expect(actionsOf(wire)).toEqual(["lock.lock"]);
    await again.stop();
  });

  it("takes the lock out at once when a new admission of its hardware waits for the store, so its unlock never reaches the newcomer", async () => {
    const pin = "40719263";
    const store = new MemoryStore();
    const { b, wire, doer, clock } = await bridge({ store, before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; } });
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    store.down = true;
    // Something joins under the lock's address while the store is away: the admission waits for it.
    await doer.admit(HW, "association");
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(wire.last(`${BASE}/devices`)!.payload.devices).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await settle();
    expect(doer.executed).toEqual([]);
    // The old id is out of use: no device the bridge has, not one waiting for its description.
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unknown_device" });
    // The store back: the newcomer is admitted under a new id, with no PIN.
    store.down = false;
    await clock.advance(1000);
    expect(wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id)).toEqual([`${HW}-2`]);
    expect(actionsOf(wire)).toEqual(["lock.lock"]);
    expect(status(wire).faults).toEqual([{ code: "pin_missing", device: `${HW}-2`, detail: expect.any(String) }]);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unknown_device" });
    expect(doer.executed).toEqual([]);
  });

  it("takes a configured PIN as none while the doer hands no lock a PIN: no unlock, and a fault saying why (plan 2c-2 review I3)", async () => {
    const pin = "40719263";
    const withheld = "no lock is handed its PIN until spike S6 tells a new association from a rejoin";
    const { b, wire, doer } = await bridge({ before: (d) => { d.initial = [{ ...DOOR, pinRequired: true }]; d.withholdsPins = withheld; } });
    expect(status(wire).faults).toEqual([{ code: "pin_missing", device: HW,
      detail: "the lock requires a PIN for remote operation, and none is configured, so unlock is not offered" }]);
    b.setPin(HW, pin);
    await doer.describe({ ...DOOR, pinRequired: true });
    expect(actionsOf(wire)).toEqual(["lock.lock"]);
    expect(status(wire).faults).toEqual([{ code: "pin_missing", device: HW,
      detail: `the lock requires a PIN for remote operation; one is configured, but ${withheld}, so unlock is not offered` }]);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await settle();
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "unsupported" });
    expect(JSON.stringify(wire.published)).not.toContain(pin);
    // A lock that requires none is unlocked as before.
    await doer.describe(DOOR);
    expect(actionsOf(wire)).toEqual(["lock.lock", "lock.unlock"]);
    expect(status(wire).faults).toEqual([]);
  });

  it("raises no pin_missing on a device that offers no unlock, whatever its description says", async () => {
    const { wire } = await bridge({ before: (d) => { d.initial = [{ ...lamp(), pinRequired: true }]; } });
    expect(actionsOf(wire)).toEqual(lamp().actions.map((x) => x.action));
    expect(status(wire).faults).toEqual([]);
  });

  it("offers unlock on a lock that requires no PIN", async () => {
    const { wire } = await bridge({ before: (d) => { d.initial = [DOOR]; } });
    expect(actionsOf(wire)).toEqual(["lock.lock", "lock.unlock"]);
    expect(status(wire).faults).toEqual([]);
  });
});

describe("an argument's step (plan 2c-2 review I1)", () => {
  it("refuses a command whose number is off its argument's step as invalid_request, never reaching the doer", async () => {
    const [setLevel] = closedActions("level", true);
    const stepped = { ...setLevel!, args: { level: { min: 0, max: 100, step: 1 } } };
    const { wire, doer } = await bridge({ before: (d) => { d.initial = [lamp({ actions: [...closedActions("onoff", true), stepped] })]; } });
    await wire.deliver(COMMAND, command({ action: "level.set_level", value: 40.5 }));
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "invalid_request", detail: "level goes in steps of 1 from 0" });
    expect(doer.executed).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "level.set_level", value: 40 }));
    await settle();
    expect(doer.executed.map((e) => e.args)).toEqual([{ level: 40 }]);
  });
});
