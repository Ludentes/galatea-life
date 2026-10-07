import type { Clock } from "@ludentes/galatea-life-test-clock";
import { StoreError } from "../src/db.js";
import type { Admission, Description, DoerEvents, DoerPort, HardwareId, ProtocolResult } from "../src/port.js";
import { deviceIdFor, type DeviceStore, type StoredDevice, type StoredSetting } from "../src/store.js";
import type { TransportState } from "../src/transport.js";
import { closedActions } from "../src/vocabulary.js";
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

  /** How many timers are set: none while the bridge is offline. */
  get pending(): number {
    return this.timers.size;
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

  /**
   * Jumps `ms` forward and fires each timer then due once, in order, as a process finds its timers
   * after a long wait: for a bound of hours, which `advance` would reach a second at a time.
   */
  async leap(ms: number): Promise<void> {
    this.t += ms;
    const due = [...this.timers.entries()].filter(([, x]) => x.due <= this.t).sort((a, b) => a[1].due - b[1].due);
    for (const [h, timer] of due) {
      if (!this.timers.has(h)) continue;
      if (timer.every) timer.due = this.t + timer.every;
      else this.timers.delete(h);
      timer.fn();
      await settle();
    }
    await settle();
  }
}

/** Lets queued promise callbacks run: the bridge's handlers chain several awaits. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

export interface Published {
  topic: string;
  payload: any;
  retain: boolean;
}

/** The broker as the bridge sees it: records every call, delivers what a test hands it. */
export class FakeWire implements Wire {
  readonly published: Published[] = [];
  readonly calls: string[] = [];
  refuseSubscribe: string[] = [];
  refusePublish: string[] = [];
  isConnected = true;
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

  /** While set, a subscription waits on it, as on a SUBACK not yet come. */
  subscribeHeld?: Promise<void>;

  /** How many of the next subscribes reject with no SUBACK, as MQTT.js does when the connection closes before it. */
  failSubscribe = 0;

  /** The Retain Handling of each subscribe, in order. */
  readonly retainHandling: number[] = [];

  async subscribe(filters: string[], retainHandling: 0 | 1 | 2 = 2): Promise<string[]> {
    this.calls.push(`subscribe ${filters.join(" ")}`);
    this.retainHandling.push(retainHandling);
    if (this.subscribeHeld) await this.subscribeHeld;
    if (this.failSubscribe > 0) {
      this.failSubscribe -= 1;
      throw new Error("Connection closed");
    }
    return filters.filter((f) => this.refuseSubscribe.includes(f));
  }

  /** Runs while the UNSUBACK is awaited: a message the broker delivers before it. */
  duringUnsubscribe?: () => void;
  /** While set, the UNSUBACK waits on it. */
  unsubscribeHeld?: Promise<void>;

  async unsubscribe(filters: string[]): Promise<void> {
    this.calls.push(`unsubscribe ${filters.join(" ")}`);
    this.duringUnsubscribe?.();
    if (this.unsubscribeHeld) await this.unsubscribeHeld;
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

  /** How many of the next reopens are refused. */
  failReopen = 0;
  /** While set, a reopen waits on it, as a connection attempt the broker does not answer; `abort` cuts it. */
  reopenHeld?: Promise<void>;
  private cutAttempt?: () => void;

  async reopen(): Promise<void> {
    this.calls.push("reopen");
    if (this.reopenHeld) {
      const cut = new Promise<"cut">((r) => { this.cutAttempt = () => r("cut"); });
      const outcome = await Promise.race([this.reopenHeld, cut]);
      this.cutAttempt = undefined;
      if (outcome === "cut") throw new Error("the connection attempt was cut");
    }
    if (this.failReopen > 0) {
      this.failReopen -= 1;
      throw new Error("connection refused");
    }
    this.isConnected = true;
  }

  async abort(): Promise<void> {
    if (!this.cutAttempt) return;
    this.calls.push("abort");
    this.cutAttempt();
  }

  /** Hands the bridge a message as the broker would, and waits for its handling. */
  async deliver(topic: string, body: unknown, opts: { retained?: boolean; expirySeconds?: number } = {}): Promise<void> {
    this.hand(topic, body, opts);
    await settle();
  }

  /** Hands the bridge a message as the broker would, without waiting. */
  hand(topic: string, body: unknown, opts: { retained?: boolean; expirySeconds?: number } = {}): void {
    // A connection ended (or not yet made) delivers nothing.
    if (!this.isConnected) return;
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

/** The store as the core sees it, in memory: `down` makes every write fail, as a store that went away. */
export class MemoryStore implements DeviceStore {
  down = false;
  /** Every device ever admitted, with whether it is its hardware's device now. */
  readonly rows: { present: boolean; d: StoredDevice }[] = [];
  readonly kept = new Map<string, Record<string, StoredSetting>>();
  readonly reportedKeys = new Map<string, Set<string>>();
  readonly unnamed = new Map<string, { name: string; at: number }[]>();
  readonly metas = new Map<string, string>();
  readonly blocks = new Map<string, number>();
  /** Every write that changed a device or a setting, in order, as `<call> <what>`. */
  readonly writes: string[] = [];

  device(hardwareId: string): StoredDevice | undefined {
    return this.rows.find((r) => r.present && r.d.hardwareId === hardwareId)?.d;
  }

  devices(): StoredDevice[] {
    return this.rows.filter((r) => r.present).map((r) => r.d);
  }

  async admit(hardwareId: string): Promise<StoredDevice> {
    this.check();
    const before = this.rows.filter((r) => r.d.hardwareId === hardwareId);
    for (const r of before) r.present = false;
    const d = { deviceId: deviceIdFor(hardwareId, new Set(this.rows.map((r) => r.d.deviceId))), hardwareId,
      admission: before.length + 1, lastCheckIn: null };
    this.rows.push({ present: true, d });
    this.writes.push(`admit ${d.deviceId}`);
    return { ...d };
  }

  async remove(hardwareId: string): Promise<void> {
    this.check();
    for (const r of this.rows) if (r.d.hardwareId === hardwareId) r.present = false;
    this.writes.push(`remove ${hardwareId}`);
  }

  /** While set, check-in saves fail and every other call succeeds. */
  failCheckIns = false;

  async saveCheckIns(entries: { deviceId: string; at: number }[]): Promise<void> {
    this.check();
    if (this.failCheckIns) throw new StoreError(new Error("the check-in write timed out"));
    for (const e of entries) for (const r of this.rows) if (r.d.deviceId === e.deviceId) r.d.lastCheckIn = e.at;
  }

  settings(deviceId: string): Record<string, StoredSetting> {
    return { ...(this.kept.get(deviceId) ?? {}) };
  }

  async saveSettings(entries: { deviceId: string; key: string; value: unknown; at: number }[]): Promise<void> {
    this.check();
    for (const e of entries) {
      this.kept.set(e.deviceId, { ...(this.kept.get(e.deviceId) ?? {}), [e.key]: { value: e.value, at: e.at } });
      this.writes.push(`setting ${e.deviceId} ${e.key}=${JSON.stringify(e.value)}`);
    }
  }

  reported(deviceId: string): string[] {
    return [...(this.reportedKeys.get(deviceId) ?? [])].sort();
  }

  async saveReported(entries: { deviceId: string; key: string; at: number }[]): Promise<void> {
    this.check();
    for (const e of entries) {
      this.reportedKeys.set(e.deviceId, (this.reportedKeys.get(e.deviceId) ?? new Set()).add(e.key));
      this.writes.push(`reported ${e.deviceId} ${e.key}`);
    }
  }

  undescribed(deviceId: string): { name: string; at: number }[] {
    return [...(this.unnamed.get(deviceId) ?? [])];
  }

  async forgetSettings(deviceId: string): Promise<void> {
    this.check();
    this.kept.delete(deviceId);
    this.writes.push(`forget settings ${deviceId}`);
  }

  async saveUndescribed(added: { deviceId: string; name: string; at: number }[], gone: { deviceId: string; name: string }[]): Promise<void> {
    this.check();
    for (const g of gone) this.unnamed.set(g.deviceId, (this.unnamed.get(g.deviceId) ?? []).filter((u) => u.name !== g.name));
    for (const a of added) {
      const of = this.unnamed.get(a.deviceId) ?? [];
      if (!of.some((u) => u.name === a.name)) this.unnamed.set(a.deviceId, [...of, { name: a.name, at: a.at }]);
    }
  }

  async meta(key: string): Promise<string | undefined> {
    this.check();
    return this.metas.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.check();
    this.metas.set(key, value);
  }

  hardwareOf(deviceId: string): string | undefined {
    return this.rows.find((r) => r.d.deviceId === deviceId)?.d.hardwareId;
  }

  lastDeviceOf(hardwareId: string): string | undefined {
    return this.rows.filter((r) => r.d.hardwareId === hardwareId).at(-1)?.d.deviceId;
  }

  blocked(): { hardwareId: string; since: number }[] {
    return [...this.blocks].map(([hardwareId, since]) => ({ hardwareId, since }));
  }

  async block(hardwareId: string, at: number): Promise<void> {
    this.check();
    if (!this.blocks.has(hardwareId)) this.blocks.set(hardwareId, at);
    this.writes.push(`block ${hardwareId}`);
  }

  async unblock(hardwareId: string): Promise<void> {
    this.check();
    this.blocks.delete(hardwareId);
    this.writes.push(`unblock ${hardwareId}`);
  }

  /** How many calls reached the store, failed ones included. */
  tries = 0;

  private check(): void {
    this.tries += 1;
    if (this.down) throw new StoreError(new Error("the store is unreachable"));
  }
}

/** A closed lamp as a doer describes it: on/off and level, reporting on its own, a bound of 60 s, every action confirmed by the protocol. */
export function lamp(over: Partial<Description> = {}): Description {
  return {
    hardwareId: "0x00158d0001a2b3c4", stableIdentifier: "0x00158d0001a2b3c4", model: { vendor: "acme", model: "bulb-1" },
    capabilities: ["onoff", "level"], actions: [...closedActions("onoff", true), ...closedActions("level", true)],
    feedback: "closed", reachMs: 0, proposedClass: "light", classEvidence: "model_db", otherAdmins: "unknown",
    basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, ...over,
  };
}

/** The doer as the core sees it: what a test makes it report, and every call the core made. */
export class FakeDoer implements DoerPort {
  events?: DoerEvents;
  /** What the doer describes as it starts. */
  initial: Description[] = [];
  /** The next results of `execute`, in order; `confirmed` once they run out. */
  results: ProtocolResult[] = [];
  /** While set, an execute waits on it, as a frame waiting for its answer. */
  executeHeld?: Promise<void>;
  /** Called on each read, as a device answering it. */
  onRead?: (hardwareId: HardwareId, keys: string[]) => void;
  /** Why the doer hands no lock a PIN, if it does not (`DoerPort.withholdsPins`). */
  withholdsPins?: string;
  /** Whether the doer opens windows and removes devices (`DoerPort.provisions`). */
  provisions = true;
  /** Every execute, with the PIN where the core gave one. */
  readonly executed: { hardwareId: HardwareId; action: string; args: Record<string, unknown>; deadline: number; pin?: string }[] = [];
  readonly reads: { hardwareId: HardwareId; keys: string[]; deadline: number; at: number }[] = [];
  stopped = false;

  constructor(private readonly clock: Clock) {}

  /** The settings the core gave at the start. */
  startSettings?: ReadonlyMap<HardwareId, Record<string, unknown>>;
  /** The awaited keys reported, as the core gave them at the start (GA-BRIDGE-80). */
  startReported?: ReadonlyMap<HardwareId, string[]>;

  async start(events: DoerEvents, settings?: ReadonlyMap<HardwareId, Record<string, unknown>>,
    reported?: ReadonlyMap<HardwareId, string[]>): Promise<void> {
    this.events = events;
    this.startSettings = settings;
    this.startReported = reported;
    events.transport("up", this.clock.now());
    for (const d of this.initial) events.described(d);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async execute(hardwareId: HardwareId, action: string, args: Record<string, unknown>, deadline: number, pin?: string): Promise<ProtocolResult> {
    this.executed.push({ hardwareId, action, args, deadline, ...(pin !== undefined ? { pin } : {}) });
    if (this.executeHeld) await this.executeHeld;
    return this.results.shift() ?? { kind: "confirmed" };
  }

  async read(hardwareId: HardwareId, keys: string[], deadline: number): Promise<void> {
    this.reads.push({ hardwareId, keys, deadline, at: this.clock.now() });
    this.onRead?.(hardwareId, keys);
  }

  /** Every window the core opened, and every close, in order, as `join <ms> [near]` and `close`. */
  readonly windows: string[] = [];
  /** While set, the next join fails with it, as a coordinator that did not open the window. */
  joinFails?: Error;

  /** While set, a join waits on it once called, as a coordinator slow to answer. */
  joinHeld?: Promise<void>;

  async join(windowMs: number, near?: HardwareId): Promise<void> {
    this.windows.push(`join ${windowMs}${near !== undefined ? ` ${near}` : ""}`);
    if (this.joinHeld) await this.joinHeld;
    const fails = this.joinFails;
    this.joinFails = undefined;
    if (fails) throw fails;
  }

  /** While set, a close waits on it, as a coordinator slow to answer. */
  closeHeld?: Promise<void>;

  async joinClose(): Promise<void> {
    if (this.closeHeld) await this.closeHeld;
    this.windows.push(this.stopped ? "close after stop" : "close");
  }
  /** Every removal the core asked for, in order, as `<hardware> [force]`. */
  readonly removed: string[] = [];
  /** While set, a removal waits on it, as a device that does not answer. */
  removeHeld?: Promise<void>;
  /** Whether the doer reports `left` for a removal, as a doer that had the hardware does. */
  removeReportsLeft = true;

  /** While set, every removal fails with it, as a doer that cannot remove the hardware. */
  removeFails?: Error;

  async remove(hardwareId: HardwareId, force: boolean): Promise<void> {
    this.removed.push(`${hardwareId}${force ? " force" : ""}`);
    if (this.removeHeld && !force) await this.removeHeld;
    if (this.removeFails) throw this.removeFails;
    if (this.removeReportsLeft) this.events!.left(hardwareId);
  }

  async describe(d: Description): Promise<void> {
    this.events!.described(d);
    await settle();
  }

  async observe(hardwareId: HardwareId, readings: Record<string, unknown>, time = this.clock.now(), checkIn = true): Promise<void> {
    this.events!.observed(hardwareId, readings, time, checkIn);
    await settle();
  }

  async occur(hardwareId: HardwareId, key: string, value: unknown, frameId: string, time = this.clock.now()): Promise<void> {
    this.events!.occurred(hardwareId, key, value, time, frameId);
    await settle();
  }

  async undescribe(hardwareId: HardwareId, names: string[]): Promise<void> {
    this.events!.undescribed(hardwareId, names);
    await settle();
  }

  async admit(hardwareId: HardwareId, how: Admission): Promise<void> {
    this.events!.admitted(hardwareId, how);
    await settle();
  }

  /** Asks the core whether the hardware may be admitted now, as a join handler does, and lets what it publishes go out. */
  async mayAdmit(hardwareId: HardwareId): Promise<boolean> {
    const may = this.events!.mayAdmit(hardwareId);
    await settle();
    return may;
  }

  async leave(hardwareId: HardwareId): Promise<void> {
    this.events!.left(hardwareId);
    await settle();
  }

  async transport(state: TransportState, retryIntervalMs?: number): Promise<void> {
    this.events!.transport(state, this.clock.now(), retryIntervalMs);
    await settle();
  }

  async fault(code: string, detail: string | null): Promise<void> {
    this.events!.fault(code, detail);
    await settle();
  }

  async ungoverned(ways: string[]): Promise<void> {
    this.events!.ungoverned(ways);
    await settle();
  }
}
