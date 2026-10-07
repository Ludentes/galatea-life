import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { magicPacket } from "../src/packet.js";
import { COMMAND_MEMORY_MS, LEAVE_MS, Relay, RELAY_ENTRY_CLOSED, type RelayOptions } from "../src/relay.js";
import { TestLink } from "../src/test-link.js";
import { FakeClock, FakeLink, FakeWire, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/wake-relay`;
const CONTROL = `${ROOT}/test/wake-relay/control`;
const ENTRIES = [{ id: "desk-pc", mac: "D4A651A1B2C3" }, { id: "media-pc", mac: "001B44113AB7" }];

const relays: Relay[] = [];
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop();
});

async function relay(extra: Partial<RelayOptions> = {}) {
  const clock = new FakeClock();
  const wire = new FakeWire();
  const link = new FakeLink();
  const r = new Relay({ bridgeId: "wake-relay", instanceId: randomUUID(), root: ROOT, clock, entries: ENTRIES, link, wire, ...extra });
  relays.push(r);
  await r.start();
  return { r, clock, wire, link };
}

const command = (value: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value, ...extra,
});
const wake = () => command({ action: "power.wake" });
const transportOf = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.transports[0];

describe("the relay's start", () => {
  it("subscribes before anything, clears lwt, then publishes devices and a valid status", async () => {
    const { wire } = await relay();
    expect(wire.calls.slice(0, 4)).toEqual([
      `subscribe ${BASE}/devices/+/command ${BASE}/request/+`,
      `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${BASE}/status`,
    ]);
    expect(wire.last(`${BASE}/lwt`)).toEqual({ topic: `${BASE}/lwt`, payload: "", retain: true });
    const status = wire.last(`${BASE}/status`)!;
    expect(status.retain).toBe(true);
    expect(validate("bridge/status.json", status.payload)).toEqual([]);
    expect(status.payload.state).toBe("online");
    expect(status.payload.levels).toEqual(["Serve"]);
    expect(status.payload.testRunId).toBeUndefined();
    expect(transportOf(wire)).toMatchObject({ id: "lan", kind: "other", state: "up" });
  });

  it("declares each entry open, internal, unclassed, with power.wake alone and confirms false", async () => {
    const { wire } = await relay();
    const devices = wire.last(`${BASE}/devices`)!;
    expect(devices.retain).toBe(true);
    expect(validate("bridge/devices.json", devices.payload)).toEqual([]);
    expect(devices.payload.devices.map((d: { id: string }) => d.id)).toEqual(["desk-pc", "media-pc"]);
    for (const d of devices.payload.devices) {
      expect(d).toMatchObject({ feedback: "open", internal: true, proposedClass: null, reachMs: 0, capabilities: ["power"] });
      expect(d.actions).toEqual([{ action: "power.wake", idempotent: true, stateless: true, confirms: false }]);
    }
    expect(devices.payload.devices[0].stableIdentifier).toBe("D4A651A1B2C3");
    expect(devices.payload.devices[0].connections).toEqual(["mac:D4A651A1B2C3"]);
  });

  it("carries the run id under a run, and honours a mutation only there", async () => {
    const under = await relay({ runId: "run-1", mutation: RELAY_ENTRY_CLOSED });
    expect(under.wire.last(`${BASE}/status`)!.payload.testRunId).toBe("run-1");
    expect(under.wire.last(`${BASE}/devices`)!.payload.devices[0]).toMatchObject({ feedback: "closed" });
    const home = await relay({ mutation: RELAY_ENTRY_CLOSED });
    expect(home.wire.last(`${BASE}/devices`)!.payload.devices[0]).toMatchObject({ feedback: "open", internal: true });
  });

  it("reports a refused subscription as a fault", async () => {
    const clock = new FakeClock();
    const wire = new FakeWire();
    wire.refuseSubscribe = [`${BASE}/request/+`];
    const r = new Relay({ bridgeId: "wake-relay", instanceId: randomUUID(), root: ROOT, clock, entries: ENTRIES, link: new FakeLink(), wire });
    relays.push(r);
    await r.start();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/request/+` }]);
  });
});

describe("the transport", () => {
  it("publishes status every 10 s of its clock", async () => {
    const { wire, clock } = await relay();
    const before = wire.all(`${BASE}/status`).length;
    await clock.advance(30_000);
    expect(wire.all(`${BASE}/status`).length - before).toBeGreaterThanOrEqual(3);
  });

  it("goes down within a second of losing the carrier, and offline with its entries unobservable", async () => {
    const { wire, clock, link } = await relay();
    link.hasCarrier = false;
    await clock.advance(1000);
    const status = wire.last(`${BASE}/status`)!.payload;
    expect(status.transports[0].state).toBe("down");
    expect(status.state).toBe("offline");
    expect(status.devices.every((d: { observable: boolean }) => !d.observable)).toBe(true);
    expect(validate("bridge/status.json", status)).toEqual([]);
  });

  it("goes down within a second of losing the carrier even while a probe is pending", async () => {
    const { wire, clock, link } = await relay();
    let release!: () => void;
    link.arpHeld = new Promise((r) => { release = r; });
    try {
      const arps = link.arps;
      await clock.advance(10_000);
      expect(link.arps).toBe(arps + 1);
      link.hasCarrier = false;
      await clock.advance(1000);
      expect(transportOf(wire).state).toBe("down");
    } finally {
      link.arpHeld = undefined;
      release();
    }
  });

  it("goes down once the gateway has been silent for 30 s, with a growing retryIntervalMs", async () => {
    const { wire, clock, link } = await relay();
    link.gatewayAnswers = false;
    await clock.advance(29_000);
    expect(transportOf(wire).state).toBe("up");
    await clock.advance(2000);
    expect(transportOf(wire).state).toBe("down");
    const first = transportOf(wire).retryIntervalMs;
    await clock.advance(120_000);
    expect(transportOf(wire).retryIntervalMs).toBeGreaterThan(first);
    expect(transportOf(wire).retryIntervalMs).toBeLessThanOrEqual(60_000);
  });

  it("comes back up at once when the carrier returns, probing without waiting for its cadence", async () => {
    const { wire, clock, link } = await relay();
    link.hasCarrier = false;
    await clock.advance(1000);
    link.hasCarrier = true;
    await clock.advance(1000);
    expect(transportOf(wire).state).toBe("up");
  });
});

describe("a command", () => {
  it("wakes an entry with its magic packet, acked sent", async () => {
    const { wire, link } = await relay();
    const cmd = wake();
    await wire.deliver(`${BASE}/devices/desk-pc/command`, cmd);
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]!.entry.id).toBe("desk-pc");
    expect(link.sent[0]!.packet.equals(magicPacket("D4A651A1B2C3"))).toBe(true);
    const ack = wire.last(`${BASE}/devices/desk-pc/ack`)!;
    expect(ack.retain).toBe(false);
    expect(validate("bridge/ack.json", ack.payload)).toEqual([]);
    expect(ack.payload).toMatchObject({ commandId: cmd.commandId, source: "wake-relay", result: "sent" });
  });

  it("answers a repeated commandId with the first ack and sends nothing more", async () => {
    const { wire, link } = await relay();
    const cmd = wake();
    await wire.deliver(`${BASE}/devices/desk-pc/command`, cmd);
    await wire.deliver(`${BASE}/devices/desk-pc/command`, cmd);
    expect(link.sent).toHaveLength(1);
    const acks = wire.all(`${BASE}/devices/desk-pc/ack`).map((a) => a.payload);
    expect(acks).toHaveLength(2);
    expect(acks[1]).toEqual(acks[0]);
  });

  it("never acts on a retained command", async () => {
    const { wire, link } = await relay();
    await wire.deliver(`${BASE}/devices/desk-pc/command`, wake(), { retained: true });
    expect(link.sent).toHaveLength(0);
    expect(wire.all(`${BASE}/devices/desk-pc/ack`)).toHaveLength(0);
  });

  it.each([
    ["an unknown device", "nas", wake(), { result: "failed", reason: "unknown_device" }],
    ["another action", "desk-pc", command({ action: "power.off" }), { result: "unsupported" }],
    ["an argument", "desk-pc", command({ action: "power.wake", value: 1 }), { result: "failed", reason: "invalid_request" }],
    ["an invalid command", "desk-pc", { commandId: randomUUID(), value: { action: "power.wake" } }, { result: "failed", reason: "invalid_request" }],
  ])("refuses %s without sending", async (_name, device, cmd, expected) => {
    const { wire, link } = await relay();
    await wire.deliver(`${BASE}/devices/${device}/command`, cmd);
    expect(link.sent).toHaveLength(0);
    const ack = wire.last(`${BASE}/devices/${device}/ack`)!.payload;
    expect(ack).toMatchObject(expected);
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });

  it("is failed(unreachable) while the transport is down", async () => {
    const { wire, clock, link } = await relay();
    link.hasCarrier = false;
    await clock.advance(1000);
    await wire.deliver(`${BASE}/devices/desk-pc/command`, wake());
    expect(link.sent).toHaveLength(0);
    expect(wire.last(`${BASE}/devices/desk-pc/ack`)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
  });

  it("is failed(send_failed) when the packet cannot be sent", async () => {
    const { wire, link } = await relay();
    link.failSend = new Error("eth0 has no IPv4 address");
    await wire.deliver(`${BASE}/devices/desk-pc/command`, wake());
    const ack = wire.last(`${BASE}/devices/desk-pc/ack`)!.payload;
    expect(ack).toMatchObject({ result: "failed", reason: "send_failed", detail: "eth0 has no IPv4 address" });
    expect(validate("bridge/ack.json", ack)).toEqual([]);
  });
});

describe("a request", () => {
  const request = () => ({ requestId: randomUUID(), issuedAt: new Date().toISOString() });

  it("answers snapshot with devices and status again, then ok", async () => {
    const { wire } = await relay();
    const devices = wire.all(`${BASE}/devices`).length;
    const req = request();
    await wire.deliver(`${BASE}/request/snapshot`, req);
    expect(wire.all(`${BASE}/devices`).length).toBe(devices + 1);
    expect(wire.calls.at(-2)).toBe(`publish ${BASE}/status`);
    const reply = wire.last(`${BASE}/reply`)!.payload;
    expect(reply).toEqual({ requestId: req.requestId, op: "snapshot", status: "ok", data: {} });
    expect(validate("bridge/reply.json", reply)).toEqual([]);
  });

  it("answers an op it does not serve invalid_request, and a repeat with the first reply", async () => {
    const { wire } = await relay();
    const req = request();
    await wire.deliver(`${BASE}/request/join`, req);
    await wire.deliver(`${BASE}/request/join`, req);
    const replies = wire.all(`${BASE}/reply`).map((r) => r.payload);
    expect(replies).toEqual([
      { requestId: req.requestId, op: "join", status: "invalid_request" },
      { requestId: req.requestId, op: "join", status: "invalid_request" },
    ]);
  });
});

describe("the test transport", () => {
  async function underRun() {
    const clock = new FakeClock();
    const wire = new FakeWire();
    const received: unknown[] = [];
    const link = new TestLink("test0", async (sent) => { received.push(sent); });
    const r = new Relay({ bridgeId: "wake-relay", instanceId: randomUUID(), root: ROOT, clock, entries: ENTRIES, link, wire,
      runId: "run-1", control: { topic: CONTROL, handle: (msg) => link.control(msg) } });
    relays.push(r);
    await r.start();
    return { wire, clock, received };
  }

  it("sees a gateway answering again on its probe cadence, not at the link op", async () => {
    const { wire, clock } = await underRun();
    await wire.deliver(CONTROL, { requestId: "a", op: "link", carrier: true, gatewayAnswers: false });
    await clock.advance(31_000);
    expect(transportOf(wire).state).toBe("down");
    const retry = transportOf(wire).retryIntervalMs as number;
    await wire.deliver(CONTROL, { requestId: "b", op: "link", carrier: true, gatewayAnswers: true });
    expect(transportOf(wire).state).toBe("down");
    await clock.advance(retry);
    expect(transportOf(wire).state).toBe("up");
  });

  it("subscribes to its control topic, plays link at once, and refuses what it cannot play", async () => {
    const { wire } = await underRun();
    expect(wire.calls[0]).toBe(`subscribe ${BASE}/devices/+/command ${BASE}/request/+ ${CONTROL}`);
    await wire.deliver(CONTROL, { requestId: "a", op: "link", carrier: true, gatewayAnswers: false });
    expect(wire.last(`${CONTROL}/reply`)!.payload).toEqual({ requestId: "a", ok: true });
    await wire.deliver(CONTROL, { requestId: "b", op: "link", carrier: false, gatewayAnswers: false });
    expect(transportOf(wire).state).toBe("down");
    await wire.deliver(CONTROL, { requestId: "c", op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    const refusal = wire.last(`${CONTROL}/reply`)!.payload;
    expect(refusal).toMatchObject({ requestId: "c", ok: false, unsupported: true });
    expect(validate("harness/test-control-reply.json", refusal)).toEqual([]);
    await wire.deliver(CONTROL, { requestId: "d", op: "explode" });
    expect(wire.last(`${CONTROL}/reply`)!.payload).toMatchObject({ requestId: "d", ok: false });
    expect(wire.last(`${CONTROL}/reply`)!.payload.unsupported).toBeUndefined();
  });

  it("answers each of the Zigbee doer's ops unsupported", async () => {
    const { wire } = await underRun();
    const at = "2030-01-01T08:00:00.000Z";
    for (const msg of [
      { op: "describe", device: "lamp", entry: {} }, { op: "setting", device: "lamp", key: "x.y.mode", value: "click", observedAt: at },
      { op: "occur", device: "lamp", key: "x.y.alarm", value: true, frameId: "f1", observedAt: at },
      { op: "undescribed", device: "lamp", names: ["dp108"] }, { op: "admit", device: "lamp", how: "association" },
      { op: "leave", device: "lamp" }, { op: "windowState", open: true }, { op: "protocolResult", device: "lamp", result: "confirmed" },
      { op: "hostLink", open: true, answers: false },
      { op: "stateMismatch", disagrees: true }, { op: "reporting", device: "lamp", configuredMs: [60000], modelMs: null },
      { op: "foreignBinding", device: "remote", target: "lamp" }, { op: "classFrom", device: "lamp", proposedClass: "light", from: "modelDb" },
      { op: "nativeControl", way: "touchlink", canDisable: false }, { op: "lockPin", device: "door", requiresPin: true },
    ]) {
      await wire.deliver(CONTROL, { requestId: "z", ...msg });
      expect(wire.last(`${CONTROL}/reply`)!.payload, msg.op).toMatchObject({ requestId: "z", ok: false, unsupported: true });
    }
  });

  it("puts each packet on received, with its interface, port and bytes", async () => {
    const { wire, received } = await underRun();
    await wire.deliver(`${BASE}/devices/media-pc/command`, wake());
    expect(received).toEqual([{ device: "media-pc", action: "power.wake",
      args: { interface: "test0", port: 9, packet: magicPacket("001B44113AB7").toString("hex") } }]);
    expect(validate("harness/test-received.json", received[0])).toEqual([]);
  });
});

describe("the relay's stop", () => {
  it("unsubscribes, publishes a graceful offline, clears lwt, disconnects and closes the link", async () => {
    const { r, wire, link } = await relay();
    relays.splice(relays.indexOf(r), 1);
    const mark = wire.calls.length;
    await r.stop();
    expect(wire.calls.slice(mark)).toEqual([
      `unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`, `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end",
    ]);
    expect(wire.last(`${BASE}/status`)!.payload).toMatchObject({ state: "offline", graceful: true });
    expect(link.closed).toBe(true);
  });

  it("acks a command delivered during stop unreachable, before the graceful offline", async () => {
    const { r, wire, link } = await relay();
    relays.splice(relays.indexOf(r), 1);
    const cmd = wake();
    wire.duringUnsubscribe = () => wire.hand(`${BASE}/devices/desk-pc/command`, cmd);
    const mark = wire.calls.length;
    await r.stop();
    expect(link.sent).toHaveLength(0);
    const ack = wire.last(`${BASE}/devices/desk-pc/ack`)!.payload;
    expect(ack).toMatchObject({ commandId: cmd.commandId, result: "failed", reason: "unreachable" });
    expect(validate("bridge/ack.json", ack)).toEqual([]);
    expect(wire.calls.slice(mark)).toEqual([
      `unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`, `publish ${BASE}/devices/desk-pc/ack`,
      `publish ${BASE}/status`, `publish ${BASE}/lwt`, "end",
    ]);
  });

  it("resubscribes before it clears lwt and republishes after a reconnection", async () => {
    const { wire } = await relay();
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([`subscribe ${BASE}/devices/+/command ${BASE}/request/+`,
      `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${BASE}/status`]);
  });

  it("reports a subscription refused on a reconnection as a fault", async () => {
    const { wire } = await relay();
    wire.refuseSubscribe = [`${BASE}/devices/+/command`];
    await wire.reconnected();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/devices/+/command` }]);
  });

  it("publishes nothing on a reconnection after stop", async () => {
    const { r, wire } = await relay();
    relays.splice(relays.indexOf(r), 1);
    await r.stop();
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([]);
  });
});

describe("bounds, clock steps and memory", () => {
  const COMMAND = `${BASE}/devices/desk-pc/command`;
  const ACK = `${BASE}/devices/desk-pc/ack`;

  it("counts a command expired when the clock steps back after its receipt, never stretching its time", async () => {
    const { wire, link, clock } = await relay();
    wire.hand(COMMAND, wake());
    clock.step(-60_000);
    await settle();
    expect(link.sent).toEqual([]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "failed", reason: "expired" });
  });

  it("remembers a command still running across a forward clock step, so its repeat never sends twice", async () => {
    const { wire, link, clock } = await relay();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const send = link.send.bind(link);
    link.send = async (entry, packet) => { await held; return send(entry, packet); };
    const cmd = wake();
    await wire.deliver(COMMAND, cmd);
    clock.step(COMMAND_MEMORY_MS + 60_000);
    await wire.deliver(COMMAND, cmd);
    release();
    await settle();
    expect(link.sent).toHaveLength(1);
    expect(wire.all(ACK).map((a) => a.payload.result)).toEqual(["sent"]);
  });

  it("clears a refused subscription once the broker grants it", async () => {
    const { wire } = await relay();
    wire.refuseSubscribe = [`${BASE}/request/+`];
    await wire.reconnected();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([{ code: "subscribe_refused", topic: `${BASE}/request/+` }]);
    wire.refuseSubscribe = [];
    await wire.reconnected();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
  });

  it("clears a refused publish once the broker accepts that topic", async () => {
    const { wire } = await relay();
    wire.refusePublish = [`${BASE}/lwt`];
    await wire.reconnected();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([{ code: "publish_refused", topic: `${BASE}/lwt` }]);
    wire.refusePublish = [];
    await wire.reconnected();
    expect(wire.last(`${BASE}/status`)!.payload.faults).toEqual([]);
  });

  it("publishes no status after a resubscription with no SUBACK, and renews all at the next connect", async () => {
    const { wire } = await relay();
    wire.failSubscribe = 1;
    const mark = wire.calls.length;
    await wire.reconnected();
    expect(wire.calls.slice(mark)).toEqual([`subscribe ${BASE}/devices/+/command ${BASE}/request/+`]);
    await wire.reconnected();
    expect(wire.calls.slice(mark + 1)).toEqual([
      `subscribe ${BASE}/devices/+/command ${BASE}/request/+`, `publish ${BASE}/lwt`, `publish ${BASE}/devices`, `publish ${BASE}/status`,
    ]);
  });

  it("publishes no status while the broker is away, so none reaches it stale from the client's queue", async () => {
    const { wire, clock } = await relay();
    wire.isConnected = false;
    const statuses = wire.all(`${BASE}/status`).length;
    await clock.advance(30_000);
    expect(wire.all(`${BASE}/status`)).toHaveLength(statuses);
  });

  it("stops at once while the broker is away: nothing to announce to, the connection cut, the link closed", async () => {
    const { r, wire, link } = await relay();
    relays.splice(relays.indexOf(r), 1);
    wire.isConnected = false;
    const mark = wire.calls.length;
    await r.stop();
    expect(wire.calls.slice(mark)).toEqual(["drop"]);
    expect(link.closed).toBe(true);
  });

  it("cuts a stop not done within 5 s of its clock, and its rest never touches the connection", async () => {
    const { r, wire, link, clock } = await relay();
    relays.splice(relays.indexOf(r), 1);
    let release!: () => void;
    link.arpHeld = new Promise<void>((resolve) => { release = resolve; });
    await clock.advance(10_000);
    const mark = wire.calls.length;
    const stopping = r.stop();
    await clock.advance(LEAVE_MS);
    await stopping;
    expect(wire.calls.slice(mark)).toEqual([`unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`, "drop"]);
    expect(link.closed).toBe(true);
    release();
    await settle();
    expect(wire.calls.slice(mark)).toEqual([`unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`, "drop"]);
  });
});
