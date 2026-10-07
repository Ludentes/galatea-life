import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMAND_MEMORY_MS, COMPUTER, LEAVE_MS, PcBridge, type PcBridgeOptions } from "../src/bridge.js";
import { StateStore } from "../src/state-store.js";
import { FakeClock, FakePort, FakeWire, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/desk-pc`;
const SUBS = `subscribe ${BASE}/devices/+/command ${BASE}/request/+`;
const UNSUBS = `unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`;
const COMMAND = `${BASE}/devices/${COMPUTER}/command`;
const ACK = `${BASE}/devices/${COMPUTER}/ack`;

let dir: string;
const bridges: PcBridge[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pc-bridge-"));
});
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function bridge(extra: Partial<PcBridgeOptions> & { before?: (port: FakePort, wire: FakeWire) => void } = {}) {
  const clock = (extra.clock as FakeClock | undefined) ?? new FakeClock();
  const wire = new FakeWire();
  const port = new FakePort();
  port.pluginsPath = join(dir, "plugins");
  extra.before?.(port, wire);
  const store = extra.store ?? StateStore.load(dir);
  const b = new PcBridge({ bridgeId: "desk-pc", instanceId: randomUUID(), root: ROOT, clock, port, wire, store,
    ...(extra.runId ? { runId: extra.runId } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, port, store };
}

/** Takes a bridge out of the afterEach list, for a test that stops it itself. */
function own(b: PcBridge): void {
  bridges.splice(bridges.indexOf(b), 1);
}

const command = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value, ...extra,
});
const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;
const hostOf = (wire: FakeWire) => status(wire).transports[0];
const rosterOf = (wire: FakeWire) => status(wire).devices[0];

describe("the bridge's start", () => {
  it("subscribes before anything, clears lwt, then publishes devices, the computer's status and a valid status", async () => {
    const { wire, clock } = await bridge();
    expect(wire.calls.slice(0, 5)).toEqual([
      SUBS, `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${BASE}/devices/${COMPUTER}/status`, `publish ${BASE}/status`,
    ]);
    expect(wire.last(`${BASE}/lwt`)).toEqual({ topic: `${BASE}/lwt`, payload: "", retain: true });
    const s = wire.last(`${BASE}/status`)!;
    expect(s.retain).toBe(true);
    expect(validate("bridge/status.json", s.payload)).toEqual([]);
    expect(s.payload).toMatchObject({ state: "online", levels: ["Serve", "Host"], faults: [], ungoverned: [], blocked: [] });
    expect(s.payload.testRunId).toBeUndefined();
    expect(hostOf(wire)).toMatchObject({ id: "host", kind: "other", state: "up" });
    const at = new Date(clock.now()).toISOString();
    expect(rosterOf(wire)).toEqual({ id: COMPUTER, transport: "host", basis: "poll", cadenceMs: 10_000, basisMaxAgeMs: 30_000,
      timestamp: at, lastCheckIn: at, observable: true, since: at });
    const computer = wire.last(`${BASE}/devices/${COMPUTER}/status`)!;
    expect(computer.retain).toBe(true);
    expect(computer.payload).toEqual({ deviceId: COMPUTER, timestamp: at, available: true });
    expect(validate("bridge/device-status.json", computer.payload)).toEqual([]);
  });

  it("declares the computer: its class read from the host, closed, its machine id, power without wake, session and notify", async () => {
    const { wire } = await bridge();
    const devices = wire.last(`${BASE}/devices`)!;
    expect(devices.retain).toBe(true);
    expect(validate("bridge/devices.json", devices.payload)).toEqual([]);
    expect(devices.payload.devices).toHaveLength(1);
    const d = devices.payload.devices[0];
    const sensors = ["app", "camera_in_use", "microphone_in_use"];
    expect(d).toEqual({
      id: COMPUTER, stableIdentifier: "0123456789abcdef0123456789abcdef", transport: "host",
      model: { vendor: "acme", model: "desk-1" }, capabilities: ["power", "session", "notify", "sensor"], sensorKeys: sensors,
      actions: d.actions, feedback: "closed", reachMs: 0, proposedClass: "computer", classEvidence: "protocol",
      otherAdmins: [{ vendor: "os", label: "root" }], accounts: {}, personal: sensors, selfChanging: sensors,
    });
    expect(d.actions).toEqual([
      { action: "power.sleep", idempotent: true, stateless: true, confirms: true },
      { action: "power.shutdown", idempotent: false, stateless: true, confirms: true, args: { delay_s: { min: 0, optional: true } } },
      { action: "power.cancel", idempotent: true, stateless: true, confirms: true },
      { action: "session.lock", idempotent: true, stateless: false, confirms: true, args: { account: [] } },
      { action: "notify.notify", idempotent: false, stateless: true, confirms: true,
        args: { text: "any", urgency: ["info", "warning", "critical"], from: "any" } },
    ]);
  });

  it("carries the run id under a run", async () => {
    const { wire } = await bridge({ runId: "run-1" });
    expect(status(wire).testRunId).toBe("run-1");
  });

  it("reports a refused subscription as a fault", async () => {
    const { wire } = await bridge({ before: (_port, w) => { w.refuseSubscribe = [`${BASE}/request/+`]; } });
    expect(status(wire).faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/request/+` }]);
  });

  it("keeps the computer's lastCheckIn across a restart, and saves each new one", async () => {
    const clock = new FakeClock();
    const kept = new Date(clock.now() - 60_000).toISOString();
    const store = StateStore.load(dir);
    store.state.lastCheckIn[COMPUTER] = kept;
    const { wire, port } = await bridge({ clock, store, before: (p) => { p.observeFails = new Error("logind: timed out"); } });
    expect(rosterOf(wire)).toMatchObject({ lastCheckIn: kept, observable: false });
    expect(status(wire).state).toBe("offline");
    expect(status(wire).faults).toEqual([{ code: "host_unobserved", detail: "logind: timed out" }]);
    port.observeFails = undefined;
    await clock.advance(10_000);
    const at = new Date(clock.now()).toISOString();
    expect(rosterOf(wire)).toMatchObject({ lastCheckIn: at, observable: true });
    expect(status(wire).faults).toEqual([]);
    await store.flush();
    expect(StateStore.load(dir).state.lastCheckIn[COMPUTER]).toBe(at);
  });
});

describe("the computer's observability", () => {
  it("reads the computer unobservable when its kept check-in lies in the future", async () => {
    const clock = new FakeClock();
    const store = StateStore.load(dir);
    store.state.lastCheckIn[COMPUTER] = new Date(clock.now() + 600_000).toISOString();
    const { wire } = await bridge({ clock, store, before: (p) => { p.observeFails = new Error("logind: timed out"); } });
    expect(rosterOf(wire).observable).toBe(false);
    expect(status(wire).state).toBe("offline");
  });
});

describe("the host", () => {
  it("publishes status every 10 s of its clock, and observes the host as often", async () => {
    const { wire, clock, port } = await bridge();
    const before = wire.all(`${BASE}/status`).length;
    const observations = port.observations;
    await clock.advance(30_000);
    expect(wire.all(`${BASE}/status`).length - before).toBeGreaterThanOrEqual(3);
    expect(port.observations - observations).toBe(3);
  });

  it("goes down at once when the OS reports its observer gone, and offline with the computer unobservable soon after", async () => {
    const { wire, clock, port } = await bridge();
    port.present = false;
    await port.changed();
    expect(hostOf(wire).state).toBe("down");
    expect(hostOf(wire).retryIntervalMs).toBeUndefined();
    await clock.advance(31_000);
    expect(rosterOf(wire).observable).toBe(false);
    expect(status(wire).state).toBe("offline");
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
  });

  it("goes down within a second of losing the observer even while an observation is pending", async () => {
    const { wire, clock, port } = await bridge();
    let release!: () => void;
    port.observeHeld = new Promise((r) => { release = r; });
    try {
      const observations = port.observations;
      await clock.advance(10_000);
      expect(port.observations).toBe(observations + 1);
      port.present = false;
      await clock.advance(1000);
      expect(hostOf(wire).state).toBe("down");
    } finally {
      port.observeHeld = undefined;
      release();
    }
  });

  it("stays up 30 s through failing observations, naming the failure, then goes down with a growing retryIntervalMs", async () => {
    const { wire, clock, port } = await bridge();
    port.observeFails = new Error("logind: no reply");
    await clock.advance(10_000);
    expect(status(wire).faults).toEqual([{ code: "host_unobserved", detail: "logind: no reply" }]);
    await clock.advance(19_000);
    expect(hostOf(wire).state).toBe("up");
    await clock.advance(2000);
    expect(hostOf(wire).state).toBe("down");
    expect(rosterOf(wire).observable).toBe(false);
    const first = hostOf(wire).retryIntervalMs;
    await clock.advance(120_000);
    expect(hostOf(wire).retryIntervalMs).toBeGreaterThan(first);
    expect(hostOf(wire).retryIntervalMs).toBeLessThanOrEqual(60_000);
  });

  it("stays up through a small step back of the wall clock, and a command still reaches the OS", async () => {
    const { wire, clock, port } = await bridge();
    const mark = wire.all(`${BASE}/status`).length;
    clock.step(-2000);
    await port.changed();
    await clock.advance(10_000);
    const after = wire.all(`${BASE}/status`).slice(mark).map((s) => s.payload);
    expect(after.length).toBeGreaterThan(0);
    for (const s of after) {
      expect(s.transports[0].state).toBe("up");
      expect(s.devices[0].observable).toBe(true);
    }
    await wire.deliver(COMMAND, command({ action: "power.sleep" }));
    expect(port.asked).toEqual(["sleep"]);
    expect(wire.last(ACK)!.payload.result).toBe("applied");
  });

  it("observes at once when the observer returns, and is up again", async () => {
    const { wire, port } = await bridge();
    port.present = false;
    await port.changed();
    port.present = true;
    await port.changed();
    expect(hostOf(wire).state).toBe("up");
  });
});

describe("a command", () => {
  it.each([
    ["power.sleep", command({ action: "power.sleep" }), "sleep"],
    ["power.shutdown with a delay", command({ action: "power.shutdown", value: 120 }), "shutdown 120"],
    ["power.shutdown at once", command({ action: "power.shutdown" }), "shutdown"],
  ])("carries out %s, acked applied once the OS accepted it", async (_name, cmd, asked) => {
    const { wire, port } = await bridge();
    await wire.deliver(COMMAND, cmd);
    expect(port.asked).toEqual([asked]);
    const ack = wire.last(ACK)!;
    expect(ack.retain).toBe(false);
    expect(validate("bridge/ack.json", ack.payload)).toEqual([]);
    expect(ack.payload).toMatchObject({ commandId: cmd.commandId, source: "desk-pc", result: "applied" });
  });

  it("acks cancel applied whether or not a shutdown was scheduled", async () => {
    const { wire, port } = await bridge();
    await wire.deliver(COMMAND, command({ action: "power.cancel" }));
    expect(wire.last(ACK)!.payload.result).toBe("applied");
    await wire.deliver(COMMAND, command({ action: "power.shutdown", value: 300 }));
    await wire.deliver(COMMAND, command({ action: "power.cancel" }));
    expect(wire.last(ACK)!.payload.result).toBe("applied");
    expect(port.asked).toEqual(["cancel", "shutdown 300", "cancel"]);
    expect(port.scheduled).toBe(false);
  });

  it("answers a repeated commandId with the first ack and asks the OS nothing more", async () => {
    const { wire, port } = await bridge();
    const cmd = command({ action: "power.shutdown", value: 60 });
    await wire.deliver(COMMAND, cmd);
    await wire.deliver(COMMAND, cmd);
    expect(port.asked).toEqual(["shutdown 60"]);
    const acks = wire.all(ACK).map((a) => a.payload);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
  });

  it("never acts on a retained command", async () => {
    const { wire, port } = await bridge();
    await wire.deliver(COMMAND, command({ action: "power.sleep" }), { retained: true });
    expect(port.asked).toEqual([]);
    expect(wire.all(ACK)).toHaveLength(0);
  });

  it.each([
    ["an unknown device", "nas", command({ action: "power.sleep" }), { result: "failed", reason: "unknown_device" }],
    ["power.wake, which a PC's bridge does not offer", COMPUTER, command({ action: "power.wake" }), { result: "unsupported" }],
    ["an argument to sleep", COMPUTER, command({ action: "power.sleep", value: 1 }), { result: "failed", reason: "invalid_request" }],
    ["a delay that is not a number of seconds", COMPUTER, command({ action: "power.shutdown", value: "soon" }), { result: "failed", reason: "invalid_request" }],
    ["a negative delay", COMPUTER, command({ action: "power.shutdown", value: -5 }), { result: "failed", reason: "invalid_request" }],
    ["an unknown key in the value", COMPUTER, command({ action: "power.cancel", force: true }), { result: "failed", reason: "invalid_request" }],
    ["an invalid command", COMPUTER, { commandId: randomUUID(), value: { action: "power.sleep" } }, { result: "failed", reason: "invalid_request" }],
    ["an expired command", COMPUTER, command({ action: "power.sleep" }, { resultWithinMs: 0 }), { result: "failed", reason: "expired" }],
  ])("refuses %s, asking the OS nothing", async (_name, device, cmd, expected) => {
    const { wire, port, clock } = await bridge();
    wire.hand(`${BASE}/devices/${device}/command`, cmd);
    if ((cmd as { resultWithinMs?: number }).resultWithinMs === 0) await clock.advance(1);
    await settle();
    expect(port.asked).toEqual([]);
    const ack = wire.last(`${BASE}/devices/${device}/ack`)!.payload;
    expect(ack).toMatchObject(expected);
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });

  it("counts a command expired when the clock steps back after its receipt, never stretching its time", async () => {
    const { wire, port, clock } = await bridge();
    wire.hand(COMMAND, command({ action: "power.sleep" }));
    clock.step(-60_000);
    await settle();
    expect(port.asked).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "expired" });
  });

  it("is failed(unreachable) while the host transport is down", async () => {
    const { wire, port } = await bridge();
    port.present = false;
    await port.changed();
    await wire.deliver(COMMAND, command({ action: "power.sleep" }));
    expect(port.asked).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
  });

  it("is failed(os_refused) when the OS refuses it", async () => {
    const { wire, port } = await bridge();
    port.osRefuses = new Error("Interactive authentication required");
    await wire.deliver(COMMAND, command({ action: "power.sleep" }));
    const ack = wire.last(ACK)!.payload;
    expect(ack).toMatchObject({ result: "failed", reason: "os_refused", detail: "Interactive authentication required" });
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });
});

describe("a request", () => {
  const request = () => ({ requestId: randomUUID(), issuedAt: new Date().toISOString() });

  it("answers snapshot with devices and both statuses again, then ok", async () => {
    const { wire } = await bridge();
    const mark = wire.calls.length;
    const req = request();
    await wire.deliver(`${BASE}/request/snapshot`, req);
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/devices/${COMPUTER}/status`,
      `publish ${BASE}/status`, `publish ${BASE}/reply`]);
    const reply = wire.last(`${BASE}/reply`)!.payload;
    expect(reply).toEqual({ requestId: req.requestId, op: "snapshot", status: "ok", data: {} });
    expect(validate("bridge/reply.json", reply)).toEqual([]);
  });

  it("answers an op it does not serve invalid_request, and a repeat with the first reply", async () => {
    const { wire } = await bridge();
    const req = request();
    await wire.deliver(`${BASE}/request/install`, req);
    await wire.deliver(`${BASE}/request/install`, req);
    expect(wire.all(`${BASE}/reply`).map((r) => r.payload)).toEqual([
      { requestId: req.requestId, op: "install", status: "invalid_request" },
      { requestId: req.requestId, op: "install", status: "invalid_request" },
    ]);
  });
});

describe("going offline with the OS", () => {
  it("on an announced suspend: unsubscribes, a graceful offline, lwt cleared, a clean disconnect, no timers left", async () => {
    const { wire, clock, port } = await bridge();
    const mark = wire.calls.length;
    await port.emit({ kind: "suspend", announced: true });
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
    expect(status(wire)).toMatchObject({ state: "offline", graceful: true });
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    expect(clock.pending).toBe(0);
    const after = wire.calls.length;
    await clock.advance(60_000);
    await wire.reconnected();
    expect(wire.calls.length).toBe(after);
  });

  it("publishes a sleep's applied before the graceful offline its suspend brings (GA-BRIDGE-22)", async () => {
    const { wire, port } = await bridge();
    let accept!: () => void;
    const accepted = new Promise<void>((r) => { accept = r; });
    port.sleep = async () => { port.asked.push("sleep"); await accepted; };
    const cmd = command({ action: "power.sleep" });
    wire.hand(COMMAND, cmd);
    await settle();
    // The OS announces the suspend while the sleep is still being accepted, as logind may.
    const suspending = port.emit({ kind: "suspend", announced: true });
    await settle();
    accept();
    await suspending;
    const order = wire.calls.filter((c) => c === `publish ${ACK}` || c === `publish ${BASE}/status` || c === "end").slice(-3);
    expect(order).toEqual([`publish ${ACK}`, `publish ${BASE}/status`, "end"]);
    expect(wire.last(ACK)!.payload).toMatchObject({ commandId: cmd.commandId, result: "applied" });
    expect(status(wire)).toMatchObject({ state: "offline", graceful: true });
  });

  it("acks a command delivered while going offline unreachable, before the graceful offline", async () => {
    const { wire, port } = await bridge();
    const cmd = command({ action: "power.sleep" });
    wire.duringUnsubscribe = () => wire.hand(COMMAND, cmd);
    const mark = wire.calls.length;
    await port.emit({ kind: "shutdown", announced: true });
    expect(port.asked).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ commandId: cmd.commandId, result: "failed", reason: "unreachable" });
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${ACK}`, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
  });

  it("on a suspend the OS did not announce: publishes nothing and drops the connection, so the will fires", async () => {
    const { wire, clock, port } = await bridge();
    const mark = wire.calls.length;
    await port.emit({ kind: "suspend", announced: false });
    expect(wire.calls.slice(mark)).toEqual(["drop"]);
    expect(clock.pending).toBe(0);
  });
});

describe("resuming", () => {
  it("has the OS step its clock, then reconnects, subscribes and publishes as at a start, its timers back", async () => {
    const { wire, clock, port } = await bridge();
    await port.emit({ kind: "suspend", announced: true });
    const mark = wire.calls.length;
    const askedBefore = port.asked.length;
    await port.emit({ kind: "resume", asleepMs: 3_600_000 });
    expect(port.asked.slice(askedBefore)).toEqual(["stepClock"]);
    expect(wire.calls.slice(mark)).toEqual([
      "reopen", SUBS, `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${BASE}/devices/${COMPUTER}/status`,
      `publish ${BASE}/status`,
    ]);
    expect(status(wire).state).toBe("online");
    expect(status(wire).graceful).toBeUndefined();
    const statuses = wire.all(`${BASE}/status`).length;
    await clock.advance(20_000);
    expect(wire.all(`${BASE}/status`).length).toBeGreaterThan(statuses);
  });

  it("observes the host at once, whatever its cadence, so the computer's check-in is the resume's", async () => {
    const { wire, clock, port } = await bridge();
    await clock.advance(2000);
    await port.emit({ kind: "suspend", announced: true });
    const observations = port.observations;
    await port.emit({ kind: "resume", asleepMs: 2000 });
    expect(port.observations).toBe(observations + 1);
    const at = new Date(clock.now()).toISOString();
    expect(rosterOf(wire).lastCheckIn).toBe(at);
    expect(wire.last(`${BASE}/devices/${COMPUTER}/status`)!.payload.timestamp).toBe(at);
  });

  it("waits at most 10 s of its clock for a step that does not come", async () => {
    const { wire, clock, port } = await bridge();
    await port.emit({ kind: "suspend", announced: false });
    port.stepResult = new Promise<boolean>(() => {});
    const mark = wire.calls.length;
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    expect(wire.calls.slice(mark)).toEqual([]);
    await clock.advance(9_999);
    expect(wire.calls.slice(mark)).toEqual([]);
    await clock.advance(1);
    await resuming;
    expect(wire.calls.slice(mark)[0]).toBe("reopen");
    expect(wire.calls.at(-1)).toBe(`publish ${BASE}/status`);
  });

  it("after a suspend it was not told of, with the connection kept: steps the clock before the next status", async () => {
    const { wire, port } = await bridge();
    const mark = wire.calls.length;
    await port.emit({ kind: "resume", asleepMs: 5000 });
    expect(port.asked).toEqual(["stepClock"]);
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/status`]);
  });
});

describe("the bridge's stop", () => {
  it("unsubscribes, publishes a graceful offline, clears lwt, disconnects and closes the port", async () => {
    const { b, wire, port } = await bridge();
    own(b);
    const mark = wire.calls.length;
    await b.stop();
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
    expect(status(wire)).toMatchObject({ state: "offline", graceful: true });
    expect(port.closed).toBe(true);
  });

  it("after a suspend, only closes the port: the connection is gone already", async () => {
    const { b, wire, port } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    const mark = wire.calls.length;
    await b.stop();
    expect(wire.calls.slice(mark)).toEqual([]);
    expect(port.closed).toBe(true);
  });

  it("resubscribes before it clears lwt and republishes after a reconnection", async () => {
    const { wire } = await bridge();
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([SUBS, `publish ${BASE}/lwt`, `publish ${BASE}/devices`,
      `publish ${BASE}/devices/${COMPUTER}/status`, `publish ${BASE}/status`]);
  });

  it("publishes no status while the broker is away, so none reaches it stale from the client's queue", async () => {
    const { wire, clock, port } = await bridge();
    wire.isConnected = false;
    const statuses = wire.all(`${BASE}/status`).length;
    await clock.advance(30_000);
    port.present = false;
    await port.changed();
    expect(wire.all(`${BASE}/status`).length).toBe(statuses);
    port.present = true;
    wire.isConnected = true;
    await wire.reconnected();
    expect(wire.all(`${BASE}/status`).length).toBe(statuses + 1);
  });

  it("publishes nothing on a reconnection after stop", async () => {
    const { b, wire } = await bridge();
    own(b);
    await b.stop();
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([]);
  });
});

describe("the lifecycle", () => {
  it("publishes nothing after a stop that comes during a resume's clock step", async () => {
    const { b, wire, port, clock } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    let release!: (v: boolean) => void;
    port.stepResult = new Promise<boolean>((r) => { release = r; });
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    await b.stop();
    const mark = wire.calls.length;
    release(true);
    await resuming;
    expect(wire.calls.slice(mark)).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it("leaves without waiting on a pending observation, and a resume after keeps the new connection", async () => {
    const { wire, port, clock } = await bridge();
    let release!: () => void;
    port.observeHeld = new Promise((r) => { release = r; });
    let resumed: Promise<void> | undefined;
    try {
      await clock.advance(10_000);
      const mark = wire.calls.length;
      const leaving = port.emit({ kind: "suspend", announced: true });
      await settle();
      expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
      await leaving;
      // The resume's own observation waits on the OS too, as the held one does.
      resumed = port.emit({ kind: "resume", asleepMs: 1000 });
      await settle();
    } finally {
      port.observeHeld = undefined;
      release();
    }
    await resumed;
    await settle();
    expect(wire.connected()).toBe(true);
    expect(status(wire).state).toBe("online");
    expect(wire.calls.filter((c) => c === "end")).toHaveLength(1);
  });

  it("ends the new connection when a stop comes between the reconnection and running", async () => {
    const { b, wire, port, store } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    let release!: () => void;
    wire.subscribeHeld = new Promise<void>((r) => { release = r; });
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    expect(wire.calls.at(-1)).toMatch(/^subscribe /);
    let flushes = 0;
    const flush = store.flush.bind(store);
    store.flush = () => { flushes += 1; return flush(); };
    const stopping = b.stop();
    await settle();
    // The stop waits for the reconnection: while the subscription is held it has neither flushed nor closed the port.
    expect(flushes).toBe(0);
    expect(port.closed).toBe(false);
    const mark = wire.calls.length;
    wire.subscribeHeld = undefined;
    release();
    await stopping;
    expect(wire.calls.slice(mark)).toEqual(["end"]);
    expect(wire.connected()).toBe(false);
    await resuming;
    expect(wire.calls.slice(mark)).toEqual(["end"]);
  });

  it("a second resume while the reconnection resubscribes joins it, not a second one", async () => {
    const { wire, port, clock } = await bridge();
    const timers = clock.pending;
    await port.emit({ kind: "suspend", announced: true });
    const mark = wire.calls.length;
    let release!: () => void;
    wire.subscribeHeld = new Promise<void>((r) => { release = r; });
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    await port.emit({ kind: "resume", asleepMs: 1000 });
    wire.subscribeHeld = undefined;
    release();
    await resuming;
    const calls = wire.calls.slice(mark);
    expect(calls.filter((c) => c === "reopen")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("subscribe "))).toHaveLength(1);
    expect(calls.filter((c) => c === `publish ${BASE}/status`)).toHaveLength(1);
    expect(status(wire).state).toBe("online");
    expect(clock.pending).toBe(timers);
  });

  it("a second resume while reconnecting joins the running reconnection, not a second one", async () => {
    const { wire, port, clock } = await bridge();
    const timers = clock.pending;
    await port.emit({ kind: "suspend", announced: true });
    wire.failReopen = 3;
    const mark = wire.calls.length;
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    const reopens = () => wire.calls.slice(mark).filter((c) => c === "reopen").length;
    expect(reopens()).toBe(1);
    await port.emit({ kind: "resume", asleepMs: 1000 });
    expect(reopens()).toBe(2);
    await clock.advance(1000);
    expect(reopens()).toBe(3);
    await clock.advance(2000);
    await resuming;
    expect(reopens()).toBe(4);
    expect(wire.calls.slice(mark).filter((c) => c === `subscribe ${BASE}/devices/+/command ${BASE}/request/+`)).toHaveLength(1);
    expect(wire.calls.slice(mark).filter((c) => c === `publish ${BASE}/status`)).toHaveLength(1);
    expect(clock.pending).toBe(timers);
  });

  it("a stop after the reconnection is running does not wait on an observation the OS holds", async () => {
    const { b, wire, port } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    let release!: () => void;
    port.observeHeld = new Promise<void>((r) => { release = r; });
    let resuming: Promise<void> | undefined;
    try {
      const before = port.observations;
      resuming = port.emit({ kind: "resume", asleepMs: 1000 });
      await settle();
      // Running, and the resume's at-once observation waits on the OS.
      expect(wire.calls.at(-1)).toBe(`publish ${BASE}/lwt`);
      expect(port.observations).toBe(before + 1);
      const mark = wire.calls.length;
      await b.stop();
      expect(wire.calls.slice(mark)).toEqual([UNSUBS, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end"]);
      expect(status(wire).graceful).toBe(true);
      expect(wire.connected()).toBe(false);
      expect(port.closed).toBe(true);
    } finally {
      port.observeHeld = undefined;
      release();
    }
    const mark = wire.calls.length;
    await resuming;
    expect(wire.calls.slice(mark)).toEqual([]);
  });

  it("tries a failed reconnection again, 1 s later, until it succeeds", async () => {
    const { wire, port, clock } = await bridge();
    await port.emit({ kind: "suspend", announced: true });
    wire.failReopen = 1;
    const mark = wire.calls.length;
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    expect(wire.calls.slice(mark)).toEqual(["reopen"]);
    expect(status(wire).graceful).toBe(true);
    await clock.advance(1000);
    await resuming;
    expect(wire.calls.slice(mark).filter((c) => c === "reopen")).toHaveLength(2);
    expect(status(wire).state).toBe("online");
  });

  it("tries a resubscription that fails after a reconnection again after the backoff, and a stop leaves no connection", async () => {
    const { b, wire, port, clock } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    wire.failSubscribe = 1;
    const mark = wire.calls.length;
    const statuses = wire.all(`${BASE}/status`).length;
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    // The connection that lost its subscription is ended, not left for MQTT.js to reconnect unseen.
    expect(wire.calls.slice(mark)).toEqual(["reopen", SUBS, "end"]);
    expect(wire.connected()).toBe(false);
    expect(wire.all(`${BASE}/status`).length).toBe(statuses);
    await clock.advance(1000);
    await resuming;
    expect(wire.calls.slice(mark)).toEqual(["reopen", SUBS, "end", "reopen", SUBS, `publish ${BASE}/lwt`,
      `publish ${BASE}/devices`, `publish ${BASE}/devices/${COMPUTER}/status`, `publish ${BASE}/status`]);
    expect(status(wire).state).toBe("online");
    await b.stop();
    expect(wire.calls.at(-1)).toBe("end");
    expect(wire.connected()).toBe(false);
  });

  it("a resume that joins a reconnection under way observes the host at once too", async () => {
    const { wire, port, clock } = await bridge();
    await port.emit({ kind: "suspend", announced: true });
    // The reconnection is running, its observation made, and its declarations wait on the broker.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const publish = wire.publish.bind(wire);
    wire.publish = async (topic, payload, retain) => {
      if (topic === `${BASE}/devices`) await held;
      return publish(topic, payload, retain);
    };
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    const observations = port.observations;
    await clock.advance(5000);
    await port.emit({ kind: "resume", asleepMs: 1000 });
    wire.publish = publish;
    release();
    await resuming;
    // The second resume's observation is due at once: the first check after it makes it, not one 10 s after the first.
    await clock.advance(1000);
    expect(port.observations).toBe(observations + 1);
  });

  it("saves no check-in after a stop, from an observation that outlasts it", async () => {
    const { b, port, clock, store } = await bridge();
    own(b);
    let release!: () => void;
    port.observeHeld = new Promise<void>((r) => { release = r; });
    await clock.advance(10_000);
    let saves = 0;
    const save = store.save.bind(store);
    store.save = () => { saves += 1; return save(); };
    await b.stop();
    port.observeHeld = undefined;
    release();
    await settle();
    expect(saves).toBe(0);
  });
});

describe("bounds and memory", () => {
  it("stops at once while the broker is away: nothing to announce to, the connection cut, the port closed", async () => {
    const { b, wire, port } = await bridge();
    own(b);
    wire.isConnected = false;
    const mark = wire.calls.length;
    await b.stop();
    expect(wire.calls.slice(mark)).toEqual(["drop"]);
    expect(port.closed).toBe(true);
  });

  it("cuts a leave not done within 5 s of its clock, and its rest never touches the connection", async () => {
    const { wire, port, clock } = await bridge();
    let accept!: () => void;
    port.sleep = async () => { port.asked.push("sleep"); await new Promise<void>((r) => { accept = r; }); };
    wire.hand(COMMAND, command({ action: "power.sleep" }));
    await settle();
    const mark = wire.calls.length;
    const suspending = port.emit({ kind: "suspend", announced: true });
    await clock.advance(LEAVE_MS - 1);
    expect(wire.calls.slice(mark)).toEqual([UNSUBS]);
    await clock.advance(1);
    await suspending;
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, "drop"]);
    // The sleep accepted late still gets its one ack; no graceful offline or disconnect follows the cut.
    accept();
    await settle();
    expect(wire.calls.slice(mark)).toEqual([UNSUBS, "drop", `publish ${ACK}`]);
  });

  it("a stop during a connection attempt the broker does not answer cuts it, and tries no other", async () => {
    const { b, wire, port, clock } = await bridge();
    own(b);
    await port.emit({ kind: "suspend", announced: true });
    wire.reopenHeld = new Promise<void>(() => {});
    const resuming = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    const mark = wire.calls.length;
    await b.stop();
    await resuming;
    expect(wire.calls.slice(mark)).toEqual(["abort"]);
    await clock.advance(120_000);
    expect(wire.calls.slice(mark)).toEqual(["abort"]);
    expect(port.closed).toBe(true);
  });

  it("clears a refused subscription once the broker grants it", async () => {
    const { wire } = await bridge({ before: (_port, w) => { w.refuseSubscribe = [`${BASE}/request/+`]; } });
    expect(status(wire).faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/request/+` }]);
    wire.refuseSubscribe = [];
    await wire.reconnected();
    expect(status(wire).faults).toEqual([]);
  });

  it("clears a refused publish once the broker accepts that topic", async () => {
    const { wire } = await bridge({ before: (_port, w) => { w.refusePublish = [`${BASE}/lwt`]; } });
    expect(status(wire).faults).toEqual([{ code: "publish_refused", topic: `${BASE}/lwt` }]);
    wire.refusePublish = [];
    await wire.reconnected();
    expect(status(wire).faults).toEqual([]);
  });

  it("remembers a command still running across a forward clock step, so its repeat never runs it twice", async () => {
    const { wire, port, clock } = await bridge();
    let accept!: () => void;
    port.sleep = async () => { port.asked.push("sleep"); await new Promise<void>((r) => { accept = r; }); };
    const cmd = command({ action: "power.sleep" });
    await wire.deliver(COMMAND, cmd);
    clock.step(COMMAND_MEMORY_MS + 60_000);
    await wire.deliver(COMMAND, cmd);
    expect(port.asked).toEqual(["sleep"]);
    accept();
    await settle();
    expect(wire.all(ACK).map((a) => a.payload.result)).toEqual(["applied"]);
  });

  it("an earlier resume's clock step ending never lets a status out before a later resume's step", async () => {
    const { wire, port } = await bridge();
    await port.emit({ kind: "suspend", announced: false });
    let first!: (v: boolean) => void;
    let second!: (v: boolean) => void;
    port.stepResult = new Promise<boolean>((r) => { first = r; });
    const one = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    port.stepResult = new Promise<boolean>((r) => { second = r; });
    const two = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    const mark = wire.calls.length;
    first(true);
    await settle();
    expect(wire.calls.slice(mark)).not.toContain(`publish ${BASE}/status`);
    second(true);
    await Promise.all([one, two]);
    expect(wire.calls.at(-1)).toBe(`publish ${BASE}/status`);
  });

  it("a later resume's clock step ending first never lets a status out before an earlier one's", async () => {
    const { wire, port } = await bridge();
    await port.emit({ kind: "suspend", announced: false });
    let first!: (v: boolean) => void;
    let second!: (v: boolean) => void;
    port.stepResult = new Promise<boolean>((r) => { first = r; });
    const one = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    port.stepResult = new Promise<boolean>((r) => { second = r; });
    const two = port.emit({ kind: "resume", asleepMs: 1000 });
    await settle();
    const mark = wire.calls.length;
    second(true);
    await settle();
    expect(wire.calls.slice(mark)).not.toContain(`publish ${BASE}/status`);
    first(true);
    await Promise.all([one, two]);
    expect(wire.calls.at(-1)).toBe(`publish ${BASE}/status`);
  });

  it("saves the check-in at most once a minute while running, and the last one at a stop", async () => {
    const { b, clock, store } = await bridge();
    own(b);
    const started = new Date(clock.now()).toISOString();
    const saved = async () => { await store.flush(); return StateStore.load(dir).state.lastCheckIn[COMPUTER]; };
    expect(await saved()).toBe(started);
    await clock.advance(50_000);
    expect(await saved()).toBe(started);
    await clock.advance(10_000);
    expect(await saved()).toBe(new Date(clock.now()).toISOString());
    await clock.advance(20_000);
    const last = new Date(clock.now()).toISOString();
    await b.stop();
    expect(StateStore.load(dir).state.lastCheckIn[COMPUTER]).toBe(last);
  });

  it("saves the last check-in at a stop after a suspend it was not told of, which has no leave", async () => {
    const { b, clock, port } = await bridge();
    own(b);
    await clock.advance(20_000);
    const last = new Date(clock.now()).toISOString();
    await port.emit({ kind: "suspend", announced: false });
    await b.stop();
    expect(StateStore.load(dir).state.lastCheckIn[COMPUTER]).toBe(last);
  });
});
