import type { Clock } from "@ludentes/galatea-life-test-clock";
import { mkdir } from "node:fs/promises";
import type {
  AdminFacts, HelperConnection, HelperMessage, Identity, Observation, OsAccount, OsPort, OsSession, PathInfo, PowerEvent, ServerProcess,
  ServerSpec, Urgency,
} from "../src/port.js";
import { spawnServer } from "../src/spawn-server.js";
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

  async subscribe(filters: string[]): Promise<string[]> {
    this.calls.push(`subscribe ${filters.join(" ")}`);
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

/** A session as a test writes it: a graphical console session of uid 1000, active, unless it says otherwise. */
export function osSession(over: Partial<OsSession> = {}): OsSession {
  return { id: "2", osId: 1000, graphical: true, remote: false, seat0Active: true, state: "active", idleHint: false, startedAt: 0, ...over };
}

/** An account's `PATH` when a test gives none. */
export const DEFAULT_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];

/** The OS as the bridge sees it: an observer, accounts, sessions, administrators and power the test sets, and every call it was asked. */
export class FakePort implements OsPort {
  present = true;
  observeFails?: Error;
  /** While set, an observation waits on it, as a call to logind still waiting for its answer. */
  observeHeld?: Promise<void>;
  observations = 0;
  /** The accounts listed; one a test writes without `path` has DEFAULT_PATH, and without `home` `/home/<name>`. */
  listed: (Omit<OsAccount, "path" | "home"> & { path?: string[]; home?: string })[] = [];
  /** The osIds the OS answers do not exist: an observation reports those of them the core asks about. */
  deleted: number[] = [];
  /** The osIds the core asked about, at each observation. */
  readonly known: number[][] = [];
  sessions: OsSession[] = [];
  facts: AdminFacts = { groups: [], sudo: [], polkit: { users: [], groups: [], unresolved: [], unrecognised: false } };
  adminsFail?: Error;
  /** While set, a read of the administrators waits on it. */
  adminsHeld?: Promise<void>;
  adminsReads = 0;
  keys = ["app", "camera_in_use", "microphone_in_use"];
  own = false;
  /** Whether a lock takes: the OS then reports the sessions locked at the next observation. */
  lockTakes = true;
  /** While set, a lock waits on it before the OS takes it. */
  lockHeld?: Promise<void>;
  osRefuses?: Error;
  scheduled = false;
  stepResult: boolean | Promise<boolean> = true;
  closed = false;
  readonly asked: string[] = [];
  /** The helpers the bridge started, by pid. */
  readonly helpers = new Map<number, string>();
  readonly closedConns: number[] = [];
  readonly notified: { conn: number; text: string; urgency: Urgency }[] = [];
  /** The connections whose helper fails to show a notification. */
  notifyFails = new Set<number>();
  /** The connections whose helper never answers a notification. */
  notifyHangs = new Set<number>();
  /** While set, a helper's start waits on it, its pid given already, as a launcher not yet released. */
  startHeld?: Promise<void>;
  /** The files as the write check and `PATH` resolution see them: a path not here is not there, and only root writes it. */
  readonly files = new Map<string, { exists?: boolean; executable?: boolean; writableBy?: number[] }>();
  /** Where plugins are installed: a test that installs one sets it to a directory of its own. */
  pluginsPath?: string;
  /** Every open connection to the helper endpoint, as the OS identifies it. */
  private readonly conns = new Map<number, HelperConnection>();
  private nextPid = 500;
  private change?: () => void;
  private adminsChange?: () => void;
  private helper?: (m: HelperMessage) => void;
  private power?: (e: PowerEvent) => Promise<void>;

  async identity(): Promise<Identity> {
    return { machineId: "0123456789abcdef0123456789abcdef", vendor: "acme", model: "desk-1" };
  }

  observerPresent(): boolean {
    return this.present;
  }

  /** Reads the OS when asked, as a call to logind does, and answers after any hold. */
  async observe(known: readonly number[]): Promise<Observation> {
    this.observations += 1;
    this.known.push([...known]);
    const reading = {
      accounts: {
        listed: this.listed.map((a) => ({ ...a, home: a.home ?? `/home/${a.name}`, path: [...(a.path ?? DEFAULT_PATH)] })),
        deleted: known.filter((id) => this.deleted.includes(id)),
      },
      sessions: this.sessions.map((s) => ({ ...s })),
    };
    if (this.observeHeld) await this.observeHeld;
    if (this.observeFails) throw this.observeFails;
    return reading;
  }

  onChange(handler: () => void): void {
    this.change = handler;
  }

  async admins(): Promise<AdminFacts> {
    this.adminsReads += 1;
    if (this.adminsHeld) await this.adminsHeld;
    if (this.adminsFail) throw this.adminsFail;
    return structuredClone(this.facts);
  }

  onAdminsChange(handler: () => void): void {
    this.adminsChange = handler;
  }

  /** The OS reports a change of the administrator facts. */
  async adminsChanged(): Promise<void> {
    this.adminsChange!();
    await settle();
  }

  personalKeys(): string[] {
    return this.keys;
  }

  async isOwnAddress(host: string): Promise<boolean> {
    this.asked.push(`isOwnAddress ${host}`);
    return this.own;
  }

  async lock(sessionIds: string[]): Promise<void> {
    this.asked.push(`lock ${sessionIds.join(",")}`);
    if (this.lockHeld) await this.lockHeld;
    if (this.osRefuses) throw this.osRefuses;
    if (!this.lockTakes) return;
    // A disconnected session stays disconnected, as the scripted OS leaves it.
    for (const s of this.sessions) if (sessionIds.includes(s.id) && s.state === "active") s.state = "locked";
  }

  async startHelper(sessionId: string): Promise<number> {
    const pid = this.nextPid++;
    this.helpers.set(pid, sessionId);
    this.asked.push(`startHelper ${sessionId}`);
    if (this.startHeld) await this.startHeld;
    return pid;
  }

  /** Stops the helper; its connection, if it made one, closes, and the OS reports it gone, as the scripted OS does. */
  async stopHelper(pid: number): Promise<void> {
    this.asked.push(`stopHelper ${this.helpers.get(pid)}`);
    this.helpers.delete(pid);
    for (const c of [...this.conns.values()].filter((x) => x.pid === pid)) {
      this.conns.delete(c.conn);
      setImmediate(() => this.helper?.({ kind: "gone", from: c }));
    }
  }

  /** Ends a connection; the OS then reports it gone, as the bus does for any connection that closes. */
  async closeHelper(conn: number): Promise<void> {
    this.closedConns.push(conn);
    const from = this.conns.get(conn);
    this.conns.delete(conn);
    if (from) setImmediate(() => this.helper?.({ kind: "gone", from }));
  }

  onHelper(handler: (m: HelperMessage) => void): void {
    this.helper = handler;
  }

  /** The pid of the helper the bridge started last in that session. */
  pidOf(session: string): number {
    const found = [...this.helpers.entries()].filter(([, s]) => s === session).at(-1);
    if (!found) throw new Error(`no helper started in ${session}`);
    return found[0];
  }

  /** A connection to the helper endpoint does something, as the OS identifies it. */
  async helperSays(m: HelperMessage): Promise<void> {
    if (m.kind === "connected") this.conns.set(m.from.conn, m.from);
    if (m.kind === "gone") this.conns.delete(m.from.conn);
    this.helper!(m);
    await settle();
  }

  /** The helper the bridge started in that session connects as its session's account, on connection `conn`. */
  async helperConnects(session: string, conn: number): Promise<HelperConnection> {
    const s = this.sessions.find((x) => x.id === session)!;
    const from = { conn, pid: this.pidOf(session), osId: s.osId, session };
    await this.helperSays({ kind: "connected", from });
    return from;
  }

  async notify(conn: number, text: string, urgency: Urgency): Promise<void> {
    if (this.notifyHangs.has(conn)) return new Promise<void>(() => {});
    if (this.notifyFails.has(conn)) throw new Error("org.freedesktop.Notifications is not there");
    this.notified.push({ conn, text, urgency });
  }

  onPower(handler: (e: PowerEvent) => Promise<void>): void {
    this.power = handler;
  }

  /** The OS reports a change, as logind's name leaving the bus would. */
  async changed(): Promise<void> {
    this.change!();
    await settle();
  }

  /** The OS announces power, and holds it until the bridge is done. */
  async emit(e: PowerEvent): Promise<void> {
    await this.power!(e);
    await settle();
  }

  async sleep(): Promise<void> {
    this.asked.push("sleep");
    if (this.osRefuses) throw this.osRefuses;
  }

  async shutdown(delayS?: number): Promise<void> {
    this.asked.push(delayS === undefined ? "shutdown" : `shutdown ${delayS}`);
    if (this.osRefuses) throw this.osRefuses;
    if (delayS !== undefined && delayS > 0) this.scheduled = true;
  }

  async cancelShutdown(): Promise<boolean> {
    this.asked.push("cancel");
    const was = this.scheduled;
    this.scheduled = false;
    return was;
  }

  async stepClock(): Promise<boolean> {
    this.asked.push("stepClock");
    return this.stepResult;
  }

  async canWrite(osId: number, path: string): Promise<boolean> {
    if (osId === 0) return true;
    return this.files.get(path)?.writableBy?.includes(osId) ?? false;
  }

  async exists(path: string): Promise<PathInfo> {
    const f = this.files.get(path);
    const there = f ? (f.exists ?? true) : false;
    return { exists: there, executable: there && (f?.executable ?? false) };
  }

  pluginsDir(): string {
    if (!this.pluginsPath) throw new Error("the test set no pluginsPath");
    return this.pluginsPath;
  }

  /** The directories the core asked to make writable by the service alone. */
  readonly rootOnly: string[] = [];

  async makeRootOnlyDir(path: string): Promise<void> {
    this.rootOnly.push(path);
    await mkdir(path, { recursive: true, mode: 0o755 });
  }

  /** Each session's display variables, as a user manager would give them; a session not here has none. */
  readonly display = new Map<string, Record<string, string>>();
  /** While set, reading a session's display variables fails, as a user manager that does not answer. */
  displayFails?: Error;

  async displayEnv(sessionId: string): Promise<Record<string, string>> {
    if (this.displayFails) throw this.displayFails;
    return { ...(this.display.get(sessionId) ?? {}) };
  }

  /** Every server the core asked for, in order. */
  readonly servers: ServerSpec[] = [];
  /** How a server starts: a real child process unless the test gives its own (an in-process one, or a failure). */
  serverFactory: (spec: ServerSpec) => Promise<ServerProcess> = (spec) => spawnServer(spec, 500);

  async startServer(spec: ServerSpec): Promise<ServerProcess> {
    this.servers.push(spec);
    this.asked.push(`startServer ${spec.plugin} ${spec.version}`);
    return this.serverFactory(spec);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
