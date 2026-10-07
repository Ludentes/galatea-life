import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { LONGEST_REACH_MS, ZigbeeBridge, type Mutation } from "../src/bridge.js";
import type { Description } from "../src/port.js";
import { closedActions } from "../src/vocabulary.js";
import { FakeClock, FakeDoer, FakeWire, lamp, MemoryStore, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/zigbee`;
const HW = "0x00158d0001a2b3c4";
const COMMAND = `${BASE}/devices/${HW}/command`;
const ACK = `${BASE}/devices/${HW}/ack`;

const bridges: ZigbeeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function bridge(opts: { mutation?: Mutation; store?: MemoryStore; clock?: FakeClock; initial?: Description[];
  exit?: (code: number) => void } = {}) {
  const clock = opts.clock ?? new FakeClock();
  const wire = new FakeWire();
  const doer = new FakeDoer(clock);
  doer.initial = opts.initial ?? [lamp()];
  const store = opts.store ?? new MemoryStore();
  const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store,
    ...(opts.mutation ? { runId: "run-1", mutation: opts.mutation } : {}), ...(opts.exit ? { exit: opts.exit } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, doer, store };
}

const command = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value, ...extra,
});
const entryOf = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices[0];

describe("a device's reach", () => {
  it("offers no action on a device it cannot reach within 145 s, and refuses a command for one unsupported", async () => {
    const { wire, doer } = await bridge({ initial: [lamp({ reachMs: LONGEST_REACH_MS + 1 })] });
    expect(entryOf(wire).actions).toEqual([]);
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "unsupported" });
  });

  it("offers the actions again once the device is described within reach", async () => {
    const { wire, doer } = await bridge({ initial: [lamp({ reachMs: 200_000 })] });
    await doer.describe(lamp({ reachMs: LONGEST_REACH_MS }));
    expect(entryOf(wire).actions.map((a: { action: string }) => a.action)).toEqual(lamp().actions.map((a) => a.action));
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    await settle();
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied" });
  });
});

const STATUS = `${BASE}/devices/${HW}/status`;
const at = (ms: number) => new Date(ms).toISOString();
const rosterOf = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.devices[0];
const events = (wire: FakeWire) => wire.all(`${BASE}/event`).map((p) => p.payload);

describe("the mutations of readings and events", () => {
  it("restamps-partial-read: a report of one key restamps every reading", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "restamps-partial-read" });
    await doer.observe(HW, { on: true, level: 40 }, clock.now() - 5000);
    await doer.observe(HW, { level: 60 });
    expect(wire.last(STATUS)!.payload).toEqual({ deviceId: HW, state: "on", timestamp: at(clock.now()), on: true, level: 60,
      available: true });
  });

  it("stamps-the-future: a reading and a check-in keep a time ahead of the bridge's clock", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "stamps-the-future" });
    const ahead = clock.now() + 60_000;
    await doer.observe(HW, { on: true }, ahead);
    expect(wire.last(STATUS)!.payload.timestamp).toBe(at(ahead));
    await clock.advance(10_000);
    expect(rosterOf(wire).lastCheckIn).toBe(at(ahead));
  });

  it("echoes-commanded-state: the commanded value is published as a reading, though the device refused it", async () => {
    const { wire, doer } = await bridge({ mutation: "echoes-commanded-state" });
    await doer.observe(HW, { on: false });
    doer.results = [{ kind: "refused", reason: "refused", detail: "BUSY" }];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "refused" });
    expect(wire.last(STATUS)!.payload.on).toBe(true);
  });

  it("restamps-check-in: a restart restamps each kept check-in with the start's time", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, mutation: "restamps-check-in" });
    const checkIn = clock.now();
    await first.doer.observe(HW, { on: true });
    bridges.splice(bridges.indexOf(first.b), 1);
    await first.b.stop();
    await clock.advance(30_000);
    const { wire } = await bridge({ store, clock, mutation: "restamps-check-in" });
    expect(rosterOf(wire).lastCheckIn).toBe(at(clock.now()));
    expect(rosterOf(wire).lastCheckIn).not.toBe(at(checkIn));
  });

  it("skips-seq: the first event's seq is 2, and each next one 2 more", async () => {
    const { wire, doer } = await bridge({ mutation: "skips-seq" });
    await doer.describe(lamp({ hardwareId: "0x00158d0009f8e7d6", stableIdentifier: "0x00158d0009f8e7d6" }));
    await doer.leave(HW);
    expect(events(wire).map((e) => [e.type, e.seq])).toEqual([["joined", 2], ["left", 4]]);
  });
});

describe("the mutations of the connection", () => {
  it("online-before-subscribed: status goes out before the subscribe, which comes 2 s later", async () => {
    const { wire, clock } = await bridge({ mutation: "online-before-subscribed" });
    expect(wire.calls.filter((c) => c.startsWith("subscribe"))).toEqual([]);
    expect(wire.calls).toContain(`publish ${BASE}/status`);
    await clock.advance(2000);
    expect(wire.calls.at(-1)).toBe(`subscribe ${BASE}/devices/+/command ${BASE}/request/+`);
  });

  it("acts-on-retained-request: subscribes with Retain Handling 0, and answers a retained request", async () => {
    const { wire } = await bridge({ mutation: "acts-on-retained-request" });
    expect(wire.retainHandling).toEqual([0]);
    await wire.deliver(`${BASE}/request/snapshot`, { requestId: "r1", issuedAt: new Date().toISOString() }, { retained: true });
    expect(wire.last(`${BASE}/reply`)!.payload).toMatchObject({ requestId: "r1", status: "ok" });
  });

  it("ignores-refusals: a refused subscribe and a refused publish leave no fault", async () => {
    const wire = new FakeWire();
    wire.refuseSubscribe = [`${BASE}/request/+`];
    wire.refusePublish = [`${BASE}/devices/${HW}/status`];
    const clock = new FakeClock();
    const doer = new FakeDoer(clock);
    doer.initial = [lamp()];
    const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store: new MemoryStore(),
      runId: "run-1", mutation: "ignores-refusals" });
    bridges.push(b);
    await b.start();
    await doer.observe(HW, { on: true });
    await clock.advance(10_000);
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
  });
});

describe("the mutations of the lifecycle", () => {
  it("exits-on-fault: the coordinator going down exits the bridge", async () => {
    const exits: number[] = [];
    const { doer } = await bridge({ mutation: "exits-on-fault", exit: (code) => void exits.push(code) });
    expect(exits).toEqual([]);
    await doer.transport("down");
    expect(exits).toEqual([1]);
  });

  it("reloads-without-graceful: a stop drops the connection, acking nothing, with no offline and no unsubscribe", async () => {
    const { b, wire, doer } = await bridge({ mutation: "reloads-without-graceful" });
    doer.executeHeld = new Promise(() => {});
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    const before = wire.published.length;
    bridges.splice(bridges.indexOf(b), 1);
    await b.stop();
    expect(wire.published.slice(before)).toEqual([]);
    expect(wire.calls.at(-1)).toBe("drop");
    expect(wire.calls.some((c) => c.startsWith("unsubscribe"))).toBe(false);
  });

  it("reloads-without-graceful: a stop still saves a check-in newer than the last periodic save", async () => {
    const store = new MemoryStore();
    const { b, doer, clock } = await bridge({ store, mutation: "reloads-without-graceful" });
    await doer.observe(HW, {});
    await clock.advance(30_000);
    await doer.observe(HW, {});
    expect(store.device(HW)!.lastCheckIn).toBe(clock.now() - 30_000);
    bridges.splice(bridges.indexOf(b), 1);
    await b.stop();
    expect(store.device(HW)!.lastCheckIn).toBe(clock.now());
  });

  it("ignores-snapshot: a snapshot is answered ok, and nothing is published again", async () => {
    const { wire } = await bridge({ mutation: "ignores-snapshot" });
    const before = wire.published.length;
    await wire.deliver(`${BASE}/request/snapshot`, { requestId: "r1", issuedAt: new Date().toISOString() });
    expect(wire.published.slice(before).map((p) => p.topic)).toEqual([`${BASE}/reply`]);
    expect(wire.last(`${BASE}/reply`)!.payload).toMatchObject({ status: "ok" });
  });

  it("forgets-on-restart: a restart drops each kept check-in", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock();
    const first = await bridge({ store, clock, mutation: "forgets-on-restart" });
    await first.doer.observe(HW, { on: true });
    bridges.splice(bridges.indexOf(first.b), 1);
    await first.b.stop();
    expect(store.device(HW)!.lastCheckIn).not.toBeNull();
    const { wire } = await bridge({ store, clock, mutation: "forgets-on-restart" });
    expect(rosterOf(wire).lastCheckIn).toBeNull();
  });
});

const OTHER = "0x00158d0009f8e7d6";
const acksOf = (wire: FakeWire, hw = HW) => wire.all(`${BASE}/devices/${hw}/ack`).map((p) => p.payload);

describe("the mutations of commands", () => {
  it("double-acks: every terminal ack goes out twice", async () => {
    const { wire } = await bridge({ mutation: "double-acks" });
    const cmd = command({ action: "onoff.turn_on" });
    await wire.deliver(COMMAND, cmd);
    expect(acksOf(wire).map((a) => [a.commandId, a.result])).toEqual([[cmd.commandId, "applied"], [cmd.commandId, "applied"]]);
  });

  it("unreachable-late: a command on a down coordinator is acked unreachable only 2 s after its receipt", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "unreachable-late" });
    await doer.transport("down");
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    await clock.advance(1999);
    expect(acksOf(wire)).toEqual([]);
    await clock.advance(1);
    expect(acksOf(wire).map((a) => a.reason)).toEqual(["unreachable"]);
  });

  it("unreachable-after-transmit: a command the stack took and lost is acked unreachable", async () => {
    const { wire, doer } = await bridge({ mutation: "unreachable-after-transmit" });
    doer.results = [{ kind: "lost", detail: "MAC_NO_ACK" }];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    expect(doer.executed).toHaveLength(1);
    expect(acksOf(wire)).toEqual([expect.objectContaining({ result: "failed", reason: "unreachable" })]);
  });

  it("runs-expired-commands: a command whose time ran out is handed to the doer", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "runs-expired-commands" });
    wire.hand(COMMAND, command({ action: "onoff.turn_on" }, { resultWithinMs: 0 }));
    await clock.advance(1);
    await settle();
    expect(doer.executed).toHaveLength(1);
    expect(acksOf(wire).map((a) => a.reason)).not.toContain("expired");
  });

  it("applied-before-confirmation: a command transmitted and never confirmed is acked applied", async () => {
    const { wire, doer } = await bridge({ mutation: "applied-before-confirmation" });
    doer.results = [{ kind: "transmitted" }, { kind: "lost" }];
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    await wire.deliver(COMMAND, command({ action: "onoff.turn_off" }));
    expect(acksOf(wire).map((a) => a.result)).toEqual(["applied", "applied"]);
  });

  it("one-fault-stops-all: a command for a healthy device waits for one stuck on another", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "one-fault-stops-all",
      initial: [lamp(), lamp({ hardwareId: OTHER, stableIdentifier: OTHER })] });
    const execute = doer.execute.bind(doer);
    doer.execute = (hw, ...rest) => (hw === HW ? new Promise(() => {}) : execute(hw, ...rest));
    wire.hand(COMMAND, command({ action: "onoff.turn_on" }));
    // Time to spare past the stuck command's 5 s, so the held one runs well before its own deadline.
    await wire.deliver(`${BASE}/devices/${OTHER}/command`, command({ action: "onoff.turn_on" }, { resultWithinMs: 10_000 }));
    expect(acksOf(wire, OTHER)).toEqual([]);
    await clock.advance(5000);
    expect(acksOf(wire).map((a) => a.reason)).toEqual(["no_confirmation"]);
    expect(acksOf(wire, OTHER).map((a) => a.result)).toEqual(["applied"]);
  });

  it("no-read-back: no read follows a command whose device did not report", async () => {
    const { wire, doer, clock } = await bridge({ mutation: "no-read-back" });
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }, { resultWithinMs: 10_000 }));
    await clock.advance(10_000);
    expect(doer.reads).toEqual([]);
  });
});

describe("the mutations of the description, the roster and the status", () => {
  const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;

  it("serves-on-mismatch: a state mismatch is named, and the bridge still serves", async () => {
    const { wire, doer } = await bridge({ mutation: "serves-on-mismatch" });
    await doer.fault("state_mismatch", "the coordinator answers with another network");
    expect(status(wire).faults).toMatchObject([{ code: "state_mismatch" }]);
    expect(status(wire).transports[0].state).toBe("up");
    await wire.deliver(COMMAND, command({ action: "onoff.turn_on" }));
    await settle();
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied" });
  });

  it("inflates-the-bound: the roster declares twice the bound the doer knows", async () => {
    const { wire } = await bridge({ mutation: "inflates-the-bound", initial: [lamp({ basisMaxAgeMs: 120_000 })] });
    expect(rosterOf(wire).basisMaxAgeMs).toBe(240_000);
  });

  it("guesses-the-bound: a closed device whose bound the doer cannot know gets one", async () => {
    const { wire } = await bridge({ mutation: "guesses-the-bound",
      initial: [lamp({ basisMaxAgeMs: null }), lamp({ hardwareId: OTHER, stableIdentifier: OTHER, feedback: "open", basisMaxAgeMs: null })] });
    const roster = status(wire).devices as { id: string; basisMaxAgeMs: number | null }[];
    expect(roster.find((d) => d.id === HW)!.basisMaxAgeMs).toBe(60_000);
    expect(roster.find((d) => d.id === OTHER)!.basisMaxAgeMs).toBeNull();
  });

  it("hides-other-admins: every device's otherAdmins is published empty", async () => {
    const { wire } = await bridge({ mutation: "hides-other-admins", initial: [lamp({ otherAdmins: "unknown" })] });
    expect(entryOf(wire).otherAdmins).toEqual([]);
  });

  it("claims-protocol-class: a proposed class claims protocol evidence, whatever the doer read", async () => {
    const { wire } = await bridge({ mutation: "claims-protocol-class",
      initial: [lamp({ proposedClass: "light", classEvidence: "model_db" })] });
    expect(entryOf(wire)).toMatchObject({ proposedClass: "light", classEvidence: "protocol" });
  });

  it("hides-native-control: a way the doer cannot disable is not listed", async () => {
    const { wire, doer } = await bridge({ mutation: "hides-native-control" });
    await doer.ungoverned(["touchlink"]);
    expect(status(wire).ungoverned).toEqual([]);
  });

  it("pin-on-the-wire: the ack of an unlock carries the PIN", async () => {
    const door = lamp({ capabilities: ["lock"], actions: closedActions("lock", true), pinRequired: true });
    const { b, wire, doer } = await bridge({ mutation: "pin-on-the-wire", initial: [door] });
    b.setPin(HW, "40719263");
    await doer.describe(door);
    await wire.deliver(COMMAND, command({ action: "lock.unlock" }));
    await settle();
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied", detail: expect.stringContaining("40719263") });
  });

  it("status-without-roster: status carries no roster", async () => {
    const { wire } = await bridge({ mutation: "status-without-roster" });
    expect(status(wire).devices).toEqual([]);
    expect(wire.last(`${BASE}/devices`)!.payload.devices).toHaveLength(1);
  });
});
