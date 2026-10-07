import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "@ludentes/galatea-life-test-clock";
import { backoffMs, Bus, BRIDGE_TOPICS, connectOptions, FINDER_TOPICS, KEEPALIVE_S, pubackOf, subackFault } from "../src/bus/client.js";

describe("the bus client", () => {
  it("pins its options: the identity as ClientID, a session that expires at once, keepalive ≤ 10 s, no reconnect or queue of its own", () => {
    expect(connectOptions("applier-1")).toEqual({
      protocolVersion: 5, clientId: "applier-1", username: "applier-1", clean: true, keepalive: KEEPALIVE_S,
      reconnectPeriod: 0, connectTimeout: 5000, resubscribe: false, queueQoSZero: false,
      properties: { sessionExpiryInterval: 0 },
    });
    expect(KEEPALIVE_S).toBeLessThanOrEqual(10);
  });

  it("never subscribes to a filter matching a command or a request (GA-BUS-9)", () => {
    const matches = (filter: string, topic: string) => new RegExp(`^${filter.replace(/\+/g, "[^/]+").replace(/#$/, ".*")}$`).test(topic);
    for (const f of BRIDGE_TOPICS) {
      expect(matches(f, "devices/lamp/command"), f).toBe(false);
      expect(matches(f, "request/snapshot"), f).toBe(false);
    }
  });

  it("backs off exponentially from 0.5 s to 30 s, jittered down by up to half (lesson 9)", () => {
    expect([0, 1, 2, 3].map((a) => backoffMs(a, 1))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffMs(0, 0)).toBe(250);
    expect(backoffMs(20, 1)).toBe(30_000);
    expect(backoffMs(20, 0)).toBe(15_000);
  });

  it("reads a PUBACK: success, 0x10 no subscriber, a failure code refused, and an error without a code the connection lost (GA-BUS-9)", () => {
    expect(pubackOf(null, 0)).toEqual({ kind: "ok" });
    expect(pubackOf(null, undefined)).toEqual({ kind: "ok" });
    expect(pubackOf(null, 0x10)).toEqual({ kind: "no_subscribers" });
    expect(pubackOf(Object.assign(new Error("Publish error: Not authorized"), { code: 0x87 }), 0x87)).toEqual({ kind: "refused", code: 0x87 });
    expect(pubackOf(null, 0x97)).toEqual({ kind: "refused", code: 0x97 });
    expect(pubackOf(new Error("Connection closed"), undefined)).toEqual({ kind: "lost" });
  });

  it("takes a SUBACK as heard only when every topic is granted QoS 1 (lessons 5 and 6)", () => {
    expect(subackFault([{ topic: "a", qos: 1 }, { topic: "b", qos: 1 }])).toBeUndefined();
    expect(subackFault([{ topic: "a", qos: 0 }])).toBe("a granted QoS 0");
    expect(subackFault([{ topic: "a", qos: 1 }, { topic: "b", qos: 0x87 }])).toBe("b refused (0x87)");
  });
});

describe("a failed connect", () => {
  let server: Server | undefined;
  let bus: Bus | undefined;
  afterEach(async () => {
    await bus?.close();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    bus = undefined;
  });

  const options = (url: string, lines: string[]) => ({
    url, identity: "applier-1", password: "s3cret-pw", root: "galatea", clock: systemClock(),
    onMessage: () => undefined, onListening: () => undefined, onLost: () => undefined, onFault: () => undefined,
    random: () => 1, log: (l: string) => lines.push(l),
  });

  it("logs a CONNACK refusal once, with its reason code and no password", async () => {
    server = createServer((sock) => {
      // CONNACK, MQTT 5: session present 0, reason 0x87 (not authorized), no properties.
      sock.once("data", () => sock.write(Buffer.from([0x20, 0x03, 0x00, 0x87, 0x00])));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const lines: string[] = [];
    bus = new Bus(options(`mqtt://applier-1:s3cret-pw@127.0.0.1:${port}`, lines));
    await bus.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/135|0x87|[Nn]ot authorized/);
    expect(lines[0]).not.toContain("s3cret-pw");
  });

  it("logs a network error once, with no password", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const lines: string[] = [];
    bus = new Bus(options(`mqtt://applier-1:s3cret-pw@127.0.0.1:${port}`, lines));
    await bus.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("127.0.0.1");
    expect(lines[0]).not.toContain("s3cret-pw");
  });
});

/**
 * A broker of a few lines: it accepts the connection, answers PINGREQ, and answers each SUBSCRIBE
 * with the reason code `grant(n, t)` gives the nth's topic filter t.
 */
type Published = { topic: string; retain: boolean; expiryS?: number };

function fakeBroker(grant: (n: number, topic: number) => number, puback: (topic: string) => number | "close" = () => 0):
  Promise<{ server: Server; port: number; subscribes: () => number; published: Published[]; filters: string[][];
    deliver: (topic: string, payload: string, retain?: boolean) => void }> {
  let subscribes = 0;
  const published: Published[] = [];
  const filters: string[][] = [];
  let last: import("node:net").Socket | undefined;
  const deliver = (topic: string, payload: string, retain = false) => {
    // PUBLISH at QoS 0, MQTT 5: topic, an empty property length, the payload.
    const t = Buffer.from(topic);
    const body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 0xff]), t, Buffer.from([0x00]), Buffer.from(payload)]);
    const lenBytes: number[] = [];
    let n = body.length;
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; lenBytes.push(b); } while (n > 0);
    last?.write(Buffer.concat([Buffer.from([0x30 | (retain ? 1 : 0), ...lenBytes]), body]));
  };
  const server = createServer((sock) => {
    last = sock;
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        // Fixed header, then the remaining length as a variable byte integer.
        let len = 0;
        let mul = 1;
        let i = 1;
        for (; i < buf.length; i++) {
          len += (buf[i]! & 0x7f) * mul;
          mul *= 128;
          if (!(buf[i]! & 0x80)) break;
        }
        if (i >= buf.length || buf.length < i + 1 + len) return;
        const type = buf[0]! >> 4;
        const buf0 = buf[0]!;
        const body = buf.subarray(i + 1, i + 1 + len);
        buf = buf.subarray(i + 1 + len);
        if (type === 1) sock.write(Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00])); // CONNACK, success
        if (type === 12) sock.write(Buffer.from([0xd0, 0x00])); // PINGRESP
        if (type === 3) {
          // PUBLISH at QoS 1: topic, packet id, properties (0x02 is the Message Expiry, 4 bytes); answered by the test's code.
          const topic = body.subarray(2, 2 + body.readUInt16BE(0)).toString();
          const at = 2 + body.readUInt16BE(0);
          const props = body.subarray(at + 3, at + 3 + body[at + 2]!);
          const expiry = props[0] === 0x02 ? props.readUInt32BE(1) : undefined;
          published.push({ topic, retain: (buf0 & 0x01) === 1, ...(expiry !== undefined ? { expiryS: expiry } : {}) });
          const rc = puback(topic);
          if (rc === "close") sock.destroy();
          else sock.write(Buffer.from([0x40, 0x03, body[at]!, body[at + 1]!, rc]));
        }
        if (type === 8) {
          // SUBSCRIBE: packet id, properties, then each filter (2-byte length, name, 1 option byte).
          const n = subscribes++;
          let at = 2 + 1 + body[2]!;
          const codes: number[] = [];
          const names: string[] = [];
          while (at < body.length) {
            names.push(body.subarray(at + 2, at + 2 + body.readUInt16BE(at)).toString());
            at += 2 + body.readUInt16BE(at) + 1;
            codes.push(grant(n, codes.length));
          }
          filters.push(names);
          sock.write(Buffer.from([0x90, 3 + codes.length, body[0]!, body[1]!, 0x00, ...codes]));
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () =>
    r({ server, port: (server.address() as AddressInfo).port, subscribes: () => subscribes, published, filters, deliver })));
}

describe("a command and its PUBACK (GA-BUS-5, GA-BUS-9)", () => {
  let broker: Awaited<ReturnType<typeof fakeBroker>> | undefined;
  let bus: Bus | undefined;
  afterEach(async () => {
    await bus?.close();
    await new Promise<void>((r) => (broker ? broker.server.close(() => r()) : r()));
    broker = undefined;
    bus = undefined;
  });
  const hall = { id: "hall", identity: "hall-bridge" };
  const start = async (puback: (topic: string) => number | "close", retainsRequests = false) => {
    broker = await fakeBroker(() => 0x01, puback);
    const lost: number[] = [];
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: () => undefined, onLost: () => lost.push(1), onFault: () => undefined,
      random: () => 0, log: () => undefined, retainsRequests });
    await bus.start();
    return lost;
  };

  it("publishes a command unretained with its Message Expiry, and a snapshot with 10 s; each resolves with its PUBACK", async () => {
    const codes = [0x00, 0x10, 0x87];
    await start(() => codes.shift() ?? 0);
    expect(await bus!.command(hall, "lamp", { commandId: "c-1" }, 12)).toEqual({ kind: "ok" });
    expect(await bus!.command(hall, "lamp", { commandId: "c-2" }, 12)).toEqual({ kind: "no_subscribers" });
    expect(await bus!.snapshot(hall)).toEqual({ kind: "refused", code: 0x87 });
    expect(broker!.published).toEqual([
      { topic: "galatea/bridges/hall-bridge/devices/lamp/command", retain: false, expiryS: 12 },
      { topic: "galatea/bridges/hall-bridge/devices/lamp/command", retain: false, expiryS: 12 },
      { topic: "galatea/bridges/hall-bridge/request/snapshot", retain: false, expiryS: 10 }]);
  });

  it("resolves lost when the connection closes before the PUBACK, never sends it again, and offline while disconnected", async () => {
    const lost = await start(() => "close");
    expect(await bus!.command(hall, "lamp", { commandId: "c-1" }, 12)).toEqual({ kind: "lost" });
    await vi.waitFor(() => expect(lost).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(await bus!.command(hall, "lamp", { commandId: "c-2" }, 12)).toEqual({ kind: "offline" });
    // The next connection (after its backoff) sends nothing the last one left unanswered.
    await vi.waitFor(() => expect(bus!.connected).toBe(true), { timeout: 3000, interval: 20 });
    await new Promise((r) => setTimeout(r, 200));
    expect(broker!.published.map((p) => p.topic)).toEqual(["galatea/bridges/hall-bridge/devices/lamp/command"]);
  });

  it("publishes a request on request/{op}, unretained, with 10 s; resolves with its PUBACK", async () => {
    await start(() => 0);
    expect(await bus!.request(hall, "join", { requestId: "r-1", issuedAt: "2030-01-01T00:00:00Z", transport: "radio" })).toEqual({ kind: "ok" });
    expect(broker!.published).toEqual([{ topic: "galatea/bridges/hall-bridge/request/join", retain: false, expiryS: 10 }]);
  });

  it("publishes retained under the mutation retains-request", async () => {
    await start(() => 0, true);
    await bus!.command(hall, "lamp", { commandId: "c-1" }, 12);
    expect(broker!.published[0]).toMatchObject({ retain: true });
  });
});

describe("a refused subscription", () => {
  let broker: Awaited<ReturnType<typeof fakeBroker>> | undefined;
  let bus: Bus | undefined;
  afterEach(async () => {
    await bus?.close();
    await new Promise<void>((r) => (broker ? broker.server.close(() => r()) : r()));
    broker = undefined;
    bus = undefined;
  });

  it("is asked for again on the backoff, without a reconnect, until granted: then the bridge is heard", async () => {
    // Refused (0x87, not authorized) twice, then granted QoS 1: an ACL the owner fixes on the broker.
    broker = await fakeBroker((n) => (n < 2 ? 0x87 : 0x01));
    const faults: string[] = [];
    const heard: string[] = [];
    let lost = 0;
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: (b) => heard.push(b), onLost: () => lost++, onFault: (f, b) => faults.push(`${b}: ${f}`),
      random: () => 0, log: () => undefined });
    await bus.start();
    bus.follow(new Map([["hall", { id: "hall", identity: "hall-bridge" }]]));
    await vi.waitFor(() => expect(heard).toEqual(["hall"]), { timeout: 3000, interval: 20 });
    expect(broker.subscribes()).toBe(3);
    expect(faults).toHaveLength(2);
    expect(faults[0]).toMatch(/^hall: .*[Nn]ot authorized/);
    expect(lost).toBe(0);
  });

  it("takes a grant below QoS 1 as a standing fault, and does not ask again: re-asking cannot raise the broker's maximum", async () => {
    broker = await fakeBroker(() => 0x00);
    const faults: string[] = [];
    const heard: string[] = [];
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: (b) => heard.push(b), onLost: () => undefined, onFault: (f, b) => faults.push(`${b}: ${f}`),
      random: () => 0, log: () => undefined });
    await bus.start();
    bus.follow(new Map([["hall", { id: "hall", identity: "hall-bridge" }]]));
    await vi.waitFor(() => expect(faults).toHaveLength(1), { timeout: 3000, interval: 20 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(broker.subscribes()).toBe(1);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatch(/granted QoS 0/);
    expect(heard).toEqual([]);
  });

  const attemptOf = (b: Bus) => (b as unknown as { attempt: number }).attempt;

  it("ends the connection's start on a grant below QoS 1, so the backoff resets", async () => {
    broker = await fakeBroker(() => 0x00);
    const faults: string[] = [];
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: () => undefined, onLost: () => undefined, onFault: (f) => faults.push(f),
      random: () => 0, log: () => undefined });
    // Registered before the connection, so its SUBACK ends the connection's start; a stale attempt from earlier failures.
    bus.follow(new Map([["hall", { id: "hall", identity: "hall-bridge" }]]));
    (bus as unknown as { attempt: number }).attempt = 5;
    await bus.start();
    await vi.waitFor(() => expect(faults).toHaveLength(1), { timeout: 3000, interval: 20 });
    expect(attemptOf(bus)).toBe(0);
  });

  it("asks again for a refused topic whose sibling got QoS 0, and ends the start once nothing is refused", async () => {
    // The first topic refused once, then granted; every other topic granted QoS 0 each time.
    broker = await fakeBroker((n, t) => (t === 0 ? (n < 1 ? 0x87 : 0x01) : 0x00));
    const faults: string[] = [];
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: () => undefined, onLost: () => undefined, onFault: (f) => faults.push(f),
      random: () => 0, log: () => undefined });
    bus.follow(new Map([["hall", { id: "hall", identity: "hall-bridge" }]]));
    (bus as unknown as { attempt: number }).attempt = 5;
    await bus.start();
    await vi.waitFor(() => expect(broker!.subscribes()).toBe(2), { timeout: 3000, interval: 20 });
    await vi.waitFor(() => expect(attemptOf(bus!)).toBe(0), { timeout: 3000, interval: 20 });
    expect(faults[0]).toMatch(/[Nn]ot authorized/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(broker.subscribes()).toBe(2);
  });
});

describe("the finder's topics (slice 5b)", () => {
  let broker: Awaited<ReturnType<typeof fakeBroker>> | undefined;
  let bus: Bus | undefined;
  afterEach(async () => {
    await bus?.close();
    await new Promise<void>((r) => (broker ? broker.server.close(() => r()) : r()));
    broker = undefined;
    bus = undefined;
  });
  const start = async (grant: (n: number, t: number) => number) => {
    broker = await fakeBroker(grant);
    const got: { path: string; body: string; retained: boolean }[] = [];
    const faults: string[] = [];
    const refused: string[] = [];
    let listening = 0;
    bus = new Bus({ url: `mqtt://127.0.0.1:${broker.port}`, identity: "applier-1", root: "galatea", clock: systemClock(),
      onMessage: () => undefined, onListening: () => undefined, onLost: () => undefined, onFault: (f, b) => faults.push(`${b}: ${f}`),
      onFinder: (path, payload, retained) => got.push({ path, body: payload.toString(), retained }),
      onFinderListening: () => listening++, onFinderRefused: (r) => refused.push(r),
      random: () => 0, log: () => undefined });
    await bus.start();
    return { got, faults, refused, listening: () => listening };
  };

  it("subscribes to status, lwt and candidates on connecting, and hands their messages to onFinder", async () => {
    const s = await start(() => 0x01);
    await vi.waitFor(() => expect(s.listening()).toBe(1), { timeout: 3000, interval: 20 });
    expect(broker!.filters[0]).toEqual(FINDER_TOPICS.map((t) => `galatea/finder/${t}`));
    broker!.deliver("galatea/finder/candidates", '{"candidates":[]}', true);
    broker!.deliver("galatea/finder/other", "{}");
    await vi.waitFor(() => expect(s.got).toEqual([{ path: "candidates", body: '{"candidates":[]}', retained: true }]), { timeout: 3000, interval: 20 });
  });

  it("calls onFinderRefused for a refused finder topic, never onFault with a bridge, and asks again until granted", async () => {
    const s = await start((n) => (n < 1 ? 0x87 : 0x01));
    await vi.waitFor(() => expect(s.listening()).toBe(1), { timeout: 3000, interval: 20 });
    expect(s.refused).toHaveLength(1);
    expect(s.refused[0]).toMatch(/[Nn]ot authorized/);
    expect(s.faults).toEqual([]);
    expect(broker!.subscribes()).toBe(2);
  });
});
