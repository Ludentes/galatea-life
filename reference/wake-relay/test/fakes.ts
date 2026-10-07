import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Entry } from "../src/config.js";
import type { Link } from "../src/link.js";
import { Refused, type Delivery, type Wire } from "../src/wire.js";

/** A clock that moves only when told, firing what falls due in order. */
export class FakeClock implements Clock {
  private t: number;
  private next = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void; every?: number }>();

  constructor(start = Date.parse("2026-09-28T12:00:00Z")) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): number {
    const h = this.next++;
    this.timers.set(h, { due: this.t + ms, fn });
    return h;
  }

  setInterval(fn: () => void, ms: number): number {
    const h = this.next++;
    this.timers.set(h, { due: this.t + ms, fn, every: ms });
    return h;
  }

  clear(h: number): void {
    this.timers.delete(h);
  }

  close(): void {
    this.timers.clear();
  }

  /**
   * Steps the wall clock by `ms` (back when negative) with no timer firing, as an OS's clock step
   * does; timers keep their distance from now, as Node's run on the monotonic clock.
   */
  step(ms: number): void {
    this.t += ms;
    for (const timer of this.timers.values()) timer.due += ms;
  }

  /** Moves `ms` forward a timer at a time, letting each fired handler's promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, x]) => x.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      const [h, timer] = due;
      this.t = Math.max(this.t, timer.due);
      if (timer.every) timer.due += timer.every;
      else this.timers.delete(h);
      timer.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

/** Lets queued promise callbacks run: the relay's handlers chain several awaits. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export interface Published {
  topic: string;
  payload: any;
  retain: boolean;
}

/** The broker as the relay sees it: records every call, delivers what a test hands it. */
export class FakeWire implements Wire {
  readonly published: Published[] = [];
  readonly calls: string[] = [];
  refuseSubscribe: string[] = [];
  refusePublish: string[] = [];
  isConnected = true;
  /** How many of the next subscribes reject with no SUBACK, as MQTT.js does when the connection closes before it. */
  failSubscribe = 0;
  private handler?: (d: Delivery) => void;
  private reconnect?: () => void;

  connected(): boolean {
    return this.isConnected;
  }

  async publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
    if (this.refusePublish.includes(topic)) throw new Refused(topic, 0x87);
    this.calls.push(`publish ${topic}`);
    this.published.push({ topic, payload, retain });
  }

  async subscribe(filters: string[]): Promise<string[]> {
    this.calls.push(`subscribe ${filters.join(" ")}`);
    if (this.failSubscribe > 0) {
      this.failSubscribe -= 1;
      throw new Error("Connection closed");
    }
    return filters.filter((f) => this.refuseSubscribe.includes(f));
  }

  /** Runs while the UNSUBACK is awaited: a message the broker delivers before it. */
  duringUnsubscribe?: () => void;

  async unsubscribe(filters: string[]): Promise<void> {
    this.calls.push(`unsubscribe ${filters.join(" ")}`);
    this.duringUnsubscribe?.();
  }

  onMessage(handler: (d: Delivery) => void): void {
    this.handler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnect = handler;
  }

  async end(): Promise<void> {
    this.calls.push("end");
    this.isConnected = false;
  }

  async drop(): Promise<void> {
    this.calls.push("drop");
    this.isConnected = false;
  }

  /** Hands the relay a message as the broker would, and waits for its handling. */
  async deliver(topic: string, body: unknown, opts: { retained?: boolean; expirySeconds?: number } = {}): Promise<void> {
    this.hand(topic, body, opts);
    await settle();
  }

  /** Hands the relay a message as the broker would, without waiting. */
  hand(topic: string, body: unknown, opts: { retained?: boolean; expirySeconds?: number } = {}): void {
    this.handler!({ topic, payload: Buffer.from(JSON.stringify(body)), retained: opts.retained ?? false,
      ...(opts.expirySeconds !== undefined ? { expirySeconds: opts.expirySeconds } : {}) });
  }

  async reconnected(): Promise<void> {
    this.reconnect!();
    await settle();
  }

  last(topic: string): Published | undefined {
    return this.published.filter((p) => p.topic === topic).at(-1);
  }

  all(topic: string): Published[] {
    return this.published.filter((p) => p.topic === topic);
  }
}

/** The interface: a carrier and a gateway the test sets, and every packet sent. */
export class FakeLink implements Link {
  hasCarrier = true;
  gatewayAnswers = true;
  arps = 0;
  failSend?: Error;
  closed = false;
  readonly sent: { entry: Entry; packet: Buffer }[] = [];

  async carrier(): Promise<boolean> {
    return this.hasCarrier;
  }

  /** While set, a probe waits on it, as an `arping` still waiting for its answer. */
  arpHeld?: Promise<void>;

  async arp(): Promise<boolean> {
    this.arps += 1;
    if (this.arpHeld) await this.arpHeld;
    return this.hasCarrier && this.gatewayAnswers;
  }

  async send(entry: Entry, packet: Buffer): Promise<void> {
    if (this.failSend) throw this.failSend;
    this.sent.push({ entry, packet });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
