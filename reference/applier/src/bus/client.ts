import { randomUUID } from "node:crypto";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import { connect, type IClientOptions, type MqttClient } from "mqtt";
import type { Bridge } from "../config/config.js";
import { maskUrls } from "../core/db.js";

/** The topics the applier reads under a bridge's `{root}/bridges/{b}/`: never one matching `command` or `request/` (GA-BUS-9). */
export const BRIDGE_TOPICS = ["status", "lwt", "devices", "devices/+/status", "devices/+/ack", "reply", "event"];
/** The finder's topics under `{root}/finder/` (bridge, *The finder's topics*), read on every connection. */
export const FINDER_TOPICS = ["status", "lwt", "candidates"];
/** The applier's keepalive, so a half-dead link is found within 1.5 × 10 s (lesson 8). */
export const KEEPALIVE_S = 10;
/** A request's Message Expiry, in seconds (GA-BUS-5). */
export const REQUEST_EXPIRY_S = 10;
/** How long a connection must stay up before a takeover no longer lengthens the next backoff. */
export const SETTLED_MS = 60_000;
const FIRST_BACKOFF_MS = 500;
const LAST_BACKOFF_MS = 30_000;
/** DISCONNECT reason code: another client took this session over (lesson 7). */
const SESSION_TAKEN_OVER = 0x8e;

/**
 * The client's options, pinned (the design, *The bus*): MQTT 5, the identity as ClientID (never
 * generated), a clean session that expires at once, a 10 s keepalive, and no reconnect of the
 * library's own: each connection is a new client, so nothing is queued offline or replayed after it.
 */
export function connectOptions(identity: string, password?: string, ca?: string): IClientOptions {
  return {
    protocolVersion: 5,
    clientId: identity,
    username: identity,
    ...(password ? { password } : {}),
    // An `mqtts` broker's certificate is validated against this CA, else against the system's store.
    ...(ca ? { ca } : {}),
    clean: true,
    keepalive: KEEPALIVE_S,
    reconnectPeriod: 0,
    connectTimeout: 5000,
    resubscribe: false,
    queueQoSZero: false,
    properties: { sessionExpiryInterval: 0 },
  };
}

/** The wait before connection attempt `attempt` (0 first): doubling from 0.5 s to 30 s, jittered down by up to half. */
export function backoffMs(attempt: number, random: number): number {
  const full = Math.min(LAST_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** attempt);
  return Math.round(full / 2 + (random * full) / 2);
}

/**
 * What the broker made of a command or a request (GA-BUS-9): delivered to a subscriber (`ok`); no
 * subscriber, the bridge between connections (`0x10`); refused, with its reason code (`0x87`, not
 * authorised, or another failure); the connection lost before any PUBACK (`lost`: it may have been
 * delivered); or not published at all, the broker being away (`offline`).
 */
export type Puback = { kind: "ok" } | { kind: "no_subscribers" } | { kind: "refused"; code: number } | { kind: "lost" } | { kind: "offline" };

/**
 * A publish's PUBACK, from the publish callback's error and the reason code the PUBACK carried.
 * mqtt.js 5.16 calls back with no error for `0x10` and passes the publish, not the PUBACK, so the
 * code is read off the PUBACK as it arrives; a failure code comes as the error's `code` too; an error
 * with none is the connection closing before the PUBACK.
 */
export function pubackOf(err: Error | null | undefined, reasonCode: number | undefined): Puback {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "number" && code >= 0x80) return { kind: "refused", code };
  if (err) return { kind: "lost" };
  if (reasonCode !== undefined && reasonCode >= 0x80) return { kind: "refused", code: reasonCode };
  return reasonCode === 0x10 ? { kind: "no_subscribers" } : { kind: "ok" };
}

/** A SUBACK's fault, or undefined when every topic was granted QoS 1 (lessons 5 and 6). */
export function subackFault(granted: { topic: string; qos: number }[]): string | undefined {
  const bad = granted.filter((g) => g.qos !== 1);
  if (!bad.length) return undefined;
  return bad.map((g) => `${g.topic} ${g.qos >= 0x80 ? `refused (0x${g.qos.toString(16)})` : `granted QoS ${g.qos}`}`).join("; ");
}

export interface BusOptions {
  /** `mqtt://host:port`, without the identity. */
  url: string;
  identity: string;
  password?: string;
  /** The CA (PEM) an `mqtts` broker's certificate is validated against (`GALATEA_BROKER_CA`); the system's store without it. */
  ca?: string;
  root: string;
  clock: Clock;
  /** One message from a bridge's tree, by the identity in its topic. */
  onMessage(identity: string, path: string, payload: Buffer, retained: boolean): void;
  /** Every subscription of a bridge was granted: listening begins. */
  onListening(bridge: string): void;
  /** The connection was lost. */
  onLost(): void;
  /** A fault of the bus itself, or of one bridge (`bridge` set). */
  onFault(what: string, bridge?: string): void;
  random?: () => number;
  /** Where a connect failure is logged (default: stderr). Never carries the broker URL's password. */
  log?: (line: string) => void;
  /** The mutation `retains-request`: commands and requests are published retained (GA-BUS-5). */
  retainsRequests?: boolean;
  /** One message on `{root}/finder/{path}` (slice 5b). */
  onFinder?(path: string, payload: Buffer, retained: boolean): void;
  /** Every finder topic was granted: the finder is heard from now. */
  onFinderListening?(): void;
  /** A finder topic was refused or granted below QoS 1: never a bridge's fault (the spec review's M5). */
  onFinderRefused?(reason: string): void;
}

/**
 * The applier's one MQTT 5 client. It subscribes per registered bridge to the topics it reads, at
 * QoS 1, Retain Handling 0 and Retain As Published off, so a retained delivery can be told from a
 * live one, and checks each SUBACK. On losing the broker it tells the applier at once, and
 * reconnects with exponential backoff and jitter, reset once connected and subscribed; a
 * reconnection asks every bridge for a snapshot (GA-BUS-6).
 */
export class Bus {
  private client?: MqttClient;
  private bridges = new Map<string, Bridge>();
  private attempt = 0;
  private takeovers = 0;
  private everUp = false;
  private closed = false;
  private retry?: number;
  private settled?: number;
  /** The finder's subscription refused, and the timer that asks again, as a bridge's. */
  private finderRefusal?: { attempt: number; timer?: number };
  /** Per bridge, a subscription refused, and the timer that asks again (the final review's M3). */
  private readonly refusals = new Map<string, { attempt: number; timer?: number }>();
  /** The reason code of each PUBACK the connection received, by packet id, until its publish's callback reads it. */
  private readonly reasons = new Map<number, number>();
  /** The publishes still waiting for their PUBACK: each ends `lost` if the connection closes first. */
  private readonly inflight = new Set<(p: Puback) => void>();

  constructor(private readonly o: BusOptions) {}

  /** Connects; resolves once the first attempt has connected or failed. Later attempts go on by themselves. */
  start(): Promise<void> {
    return new Promise((resolve) => this.connect(resolve));
  }

  get connected(): boolean {
    return !!this.client?.connected;
  }

  /** Follows the registered bridges: a new one is subscribed, a removed one unsubscribed. */
  follow(bridges: Map<string, Bridge>): void {
    const before = this.bridges;
    this.bridges = new Map(bridges);
    if (!this.client?.connected) return;
    for (const [id, b] of before) {
      const now = bridges.get(id);
      if (!now || now.identity !== b.identity) this.client.unsubscribe(this.topics(b));
    }
    for (const [id, b] of bridges) {
      const was = before.get(id);
      if (!was || was.identity !== b.identity) this.subscribe(this.client, b, false);
    }
  }

  /**
   * Asks `bridge` for a snapshot, unretained with a 10 s expiry; not sent, and never queued, while
   * disconnected (`offline`). Resolves with its PUBACK.
   */
  snapshot(bridge: Bridge): Promise<Puback> {
    return this.request(bridge, "snapshot", { requestId: randomUUID(), issuedAt: new Date(Math.floor(this.o.clock.now())).toISOString() });
  }

  /**
   * Publishes a request `op` to `bridge` on `request/{op}`, unretained, at QoS 1, with a 10 s Message
   * Expiry (bridge, *Requests and replies*); `body` carries its own `requestId` and `issuedAt`. Not
   * sent, and never queued, while disconnected (`offline`). Resolves with its PUBACK.
   */
  request(bridge: Bridge, op: string, body: Record<string, unknown>): Promise<Puback> {
    return this.send(`${this.o.root}/bridges/${bridge.identity}/request/${op}`, body, REQUEST_EXPIRY_S);
  }

  /**
   * Publishes a command to `device` of `bridge`, unretained, at QoS 1, with a Message Expiry of
   * `expiryS` (GA-BUS-5); resolves with its PUBACK (GA-BUS-9). Never queued while disconnected, and
   * never sent again: each connection is a new client, so nothing replays after a reconnect.
   */
  command(bridge: Bridge, device: string, body: Record<string, unknown>, expiryS: number): Promise<Puback> {
    return this.send(`${this.o.root}/bridges/${bridge.identity}/devices/${device}/command`, body, expiryS);
  }

  private send(topic: string, body: Record<string, unknown>, expiryS: number): Promise<Puback> {
    const c = this.client;
    if (!c?.connected) return Promise.resolve({ kind: "offline" });
    return new Promise((resolve) => {
      const done = (p: Puback) => {
        if (!this.inflight.delete(done)) return;
        resolve(p);
      };
      this.inflight.add(done);
      c.publish(topic, JSON.stringify(body), { qos: 1, retain: this.o.retainsRequests === true,
        properties: { messageExpiryInterval: expiryS } }, (err, packet) => {
        const id = packet?.messageId;
        const code = id === undefined ? undefined : this.reasons.get(id);
        if (id !== undefined) this.reasons.delete(id);
        done(pubackOf(err, code));
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const r of this.refusals.values()) if (r.timer !== undefined) this.o.clock.clear(r.timer);
    if (this.finderRefusal?.timer !== undefined) this.o.clock.clear(this.finderRefusal.timer);
    if (this.retry !== undefined) this.o.clock.clear(this.retry);
    if (this.settled !== undefined) this.o.clock.clear(this.settled);
    await this.client?.endAsync(true).catch(() => undefined);
  }

  private host(): string {
    try {
      return new URL(this.o.url).host;
    } catch {
      return "broker";
    }
  }

  private topics(b: Bridge): string[] {
    return BRIDGE_TOPICS.map((t) => `${this.o.root}/bridges/${b.identity}/${t}`);
  }

  private connect(first?: () => void): void {
    if (this.closed) return;
    const c = connect(this.o.url, connectOptions(this.o.identity, this.o.password, this.o.ca));
    this.client = c;
    this.reasons.clear();
    let up = false;
    c.on("packetreceive", (packet) => {
      if (packet.cmd === "puback" && this.client === c && packet.messageId !== undefined) this.reasons.set(packet.messageId, packet.reasonCode ?? 0);
    });
    c.on("error", (err) => {
      // A refused CONNACK or a network error: name it once, by host only, never the URL's password.
      const detail = err.message || (err as NodeJS.ErrnoException).code || String(err);
      (this.o.log ?? ((l) => console.error(l)))(`bus ${up ? "error" : "connect failed"} (${this.host()}): ${maskUrls(detail)}`);
    });
    c.on("connect", () => {
      up = true;
      // A new connection subscribes every bridge afresh: the last one's retries are void.
      for (const r of this.refusals.values()) if (r.timer !== undefined) this.o.clock.clear(r.timer);
      this.refusals.clear();
      if (this.finderRefusal?.timer !== undefined) this.o.clock.clear(this.finderRefusal.timer);
      this.finderRefusal = undefined;
      if (this.o.onFinder) this.subscribeFinder(c);
      const again = this.everUp;
      this.everUp = true;
      first?.();
      first = undefined;
      let waiting = this.bridges.size;
      if (!waiting) this.attempt = 0;
      for (const b of this.bridges.values()) {
        this.subscribe(c, b, again, () => {
          // Reset only after the CONNACK and every SUBACK (the maintainer's ruling 5).
          if (--waiting === 0) this.attempt = 0;
        });
      }
      this.settled = this.o.clock.setTimeout(() => { this.takeovers = 0; }, SETTLED_MS);
    });
    c.on("disconnect", (packet) => {
      if (packet.reasonCode === SESSION_TAKEN_OVER) {
        this.takeovers++;
        this.o.onFault(`another client took over the session of ${this.o.identity} (DISCONNECT 0x8e)`);
      }
    });
    c.on("message", (topic, payload, packet) => {
      const finder = `${this.o.root}/finder/`;
      if (topic.startsWith(finder)) {
        const path = topic.slice(finder.length);
        if (FINDER_TOPICS.includes(path)) this.o.onFinder?.(path, payload, packet.retain);
        return;
      }
      const prefix = `${this.o.root}/bridges/`;
      if (!topic.startsWith(prefix)) return;
      const rest = topic.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) return;
      this.o.onMessage(rest.slice(0, slash), rest.slice(slash + 1), payload, packet.retain);
    });
    c.on("close", () => {
      if (this.client !== c) return;
      if (this.settled !== undefined) this.o.clock.clear(this.settled);
      // A publish whose PUBACK never came may or may not have been delivered: lost, never sent again (GA-BUS-9).
      for (const done of [...this.inflight]) done({ kind: "lost" });
      c.removeAllListeners("close");
      void c.endAsync(true).catch(() => undefined);
      this.client = undefined;
      first?.();
      first = undefined;
      if (up) this.o.onLost();
      if (this.closed) return;
      const wait = backoffMs(this.attempt + this.takeovers, (this.o.random ?? Math.random)());
      this.attempt++;
      this.retry = this.o.clock.setTimeout(() => this.connect(), wait);
    });
  }

  /**
   * The finder's three topics, with a bridge's options; a refusal is logged through `onFinderRefused`,
   * never a bridge's fault, and asked for again on the backoff while this connection lasts. It never
   * holds up the connection's start, whose backoff resets on the bridges' grants alone.
   */
  private subscribeFinder(c: MqttClient): void {
    const map = Object.fromEntries(FINDER_TOPICS.map((t) => [`${this.o.root}/finder/${t}`, { qos: 1 as const, rh: 0, rap: false, nl: false }]));
    c.subscribe(map, (err, granted) => {
      if (this.client !== c) return;
      const fault = err ? `subscribe failed: ${err.message}` : subackFault(granted ?? []);
      if (!fault) {
        this.finderRefusal = undefined;
        this.o.onFinderListening?.();
        return;
      }
      this.o.onFinderRefused?.(fault);
      // A grant below QoS 1 alone is the broker's maximum, which re-asking cannot change.
      if (!err && !(granted ?? []).some((g) => g.qos >= 0x80)) return;
      const r = this.finderRefusal ?? { attempt: 0 };
      r.timer = this.o.clock.setTimeout(() => {
        r.timer = undefined;
        if (this.client === c && c.connected) this.subscribeFinder(c);
      }, backoffMs(r.attempt++, (this.o.random ?? Math.random)()));
      this.finderRefusal = r;
    });
  }

  private subscribe(c: MqttClient, b: Bridge, again: boolean, done?: () => void): void {
    const map = Object.fromEntries(this.topics(b).map((t) => [t, { qos: 1 as const, rh: 0, rap: false, nl: false }]));
    c.subscribe(map, (err, granted) => {
      if (this.client !== c) return;
      const fault = err ? `subscribe failed: ${err.message}` : subackFault(granted ?? []);
      if (fault) {
        // Not heard: the bridge stays dead, with the fault named; the applier raises it once while it
        // stands. A refusal is asked for again on the backoff, so a broker's ACL fixed later is heard
        // without a reconnect, even when a sibling topic got QoS 0. A grant below QoS 1 alone is the
        // broker's maximum, which re-asking cannot change: it stands until the next connection, and
        // ends the connection's start all the same, so the backoff resets.
        this.o.onFault(fault, b.id);
        if (!err && !(granted ?? []).some((g) => g.qos >= 0x80)) {
          this.refusals.delete(b.id);
          done?.();
          return;
        }
        const r = this.refusals.get(b.id) ?? { attempt: 0 };
        r.timer = this.o.clock.setTimeout(() => {
          r.timer = undefined;
          if (this.client === c && c.connected && this.bridges.get(b.id)?.identity === b.identity) this.subscribe(c, b, again, done);
        }, backoffMs(r.attempt++, (this.o.random ?? Math.random)()));
        this.refusals.set(b.id, r);
        return;
      }
      this.refusals.delete(b.id);
      done?.();
      this.o.onListening(b.id);
      if (again) this.snapshot(b);
    });
  }
}
