import { mkdir } from "node:fs/promises";
import { posix } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";
import { isOwnAddress } from "./own-address.js";
import type {
  AdminFacts, HelperConnection, HelperMessage, HelperValues, Identity, Observation, OsPort, OsSession, PathInfo, PowerEvent, ServerProcess,
  ServerSpec, Urgency,
} from "./port.js";
import { spawnServer } from "./spawn-server.js";
import type { Delivery, Wire } from "./wire.js";

/** The harness asked for an op this scripted OS cannot play; the reply says so (`unsupported`). */
export class UnsupportedOp extends Error {}

/** What the OS was asked, as the harness reads it on `received`: wave 0's shape. */
export interface Received {
  device: string;
  action: string;
  args: Record<string, unknown>;
}

/** The scripted machine: a fixed identifier of 32 hex digits, as `/etc/machine-id` holds one. */
export const SCRIPTED_IDENTITY: Identity = { machineId: "5c1e6a0d7b2f4e3a9c8d1b0a2f3e4d5c", vendor: "galatea", model: "scripted-os" };
/** Every personal key: the scripted helpers read them all. */
export const SCRIPTED_PERSONAL_KEYS = ["app", "camera_in_use", "microphone_in_use"];
/** An account's `PATH` when the harness names none: a Debian login shell's for an ordinary user. */
export const SCRIPTED_DEFAULT_PATH: readonly string[] = ["/usr/local/bin", "/usr/bin", "/bin"];

export interface ScriptedOsOptions {
  /** The computer's device id, which `received` names. */
  device: string;
  /** Publishes what the OS was asked on the control topic's `received`. */
  onReceived(r: Received): Promise<void>;
  /** The harness's `stall`: the bridge's main loop waits that long. */
  onStall(ms: number): void;
  /** Where plugins are installed: a plain directory of the harness's user (GA-BRIDGE-70 is graded on a real OS). */
  pluginsDir: string;
}

interface ScriptedAccount {
  name: string;
  interactive: boolean;
  primaryGid: number;
  path: string[];
  /** Whether the OS lists it now: `absent` and `lookupFails` take it off the listing without deleting it. */
  listed: boolean;
}

/** A path as one key: `/usr/bin/` and `/usr//bin` are `/usr/bin`. */
function clean(path: string): string {
  const p = posix.normalize(path);
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** A path as the harness told of it: whether it is there, runs, and which accounts can write it. */
interface ScriptedFile {
  exists: boolean;
  executable: boolean;
  writableBy: number[];
}

/** The facts as the harness writes them: members and sudo entries by osId, resolved to names when read. */
interface ScriptedAdmins {
  groups: { name: string; gid: number; members: number[] }[];
  sudo: { osId: number; root: "yes" | "no" | "cannotTell" }[];
  polkit: { identities: string[]; unrecognised: boolean };
}

/**
 * The OS behind the test transport (GA-BRIDGE-16): the harness plays it with control messages on
 * a connection of its own, which stays up while the bridge is asleep, and reads on `received`
 * what the bridge asked of it. It starts as a healthy host: the observer there, powered on, a
 * clock it can step, no account, no session, root the only administrator, and no file: a path it
 * was not told of is not there, and only root can write it.
 */
export class ScriptedOs implements OsPort {
  private present = true;
  private steppable = true;
  private scheduled = false;
  private power: "on" | "asleep" | "off" = "on";
  /** Its passwd and directory: an account not here does not exist, root always excepted. */
  private readonly accounts = new Map<number, ScriptedAccount>();
  private readonly sessions = new Map<string, OsSession>();
  private facts: ScriptedAdmins = { groups: [], sudo: [], polkit: { identities: [], unrecognised: false } };
  /** The helpers the bridge started, by pid, with the connection each made, if any. */
  private readonly helpers = new Map<number, { session: string; conn: number | null }>();
  /** Every open connection to the helper endpoint, as the OS identifies it. */
  private readonly conns = new Map<number, HelperConnection>();
  private readonly lockBehaviour = new Map<string, { result: "locks" | "ignores"; afterMs: number }>();
  private readonly files = new Map<string, ScriptedFile>();
  private nextPid = 4000;
  private nextConn = 1;
  private changeHandler?: () => void;
  private adminsHandler?: () => void;
  private helperHandler?: (m: HelperMessage) => void;
  private powerHandler?: (e: PowerEvent) => Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: ScriptedOsOptions) {}

  /** Serves the control topic on the OS's own connection, one message at a time, each answered on `…/reply`. */
  async serve(wire: Wire, topic: string): Promise<void> {
    wire.onMessage((d) => {
      if (d.topic !== topic || d.retained) return;
      // The queue never rejects: one message that fails leaves every later one served.
      this.queue = this.queue.then(() => this.onControl(wire, topic, d)).catch((err) => console.error(`control: ${err}`));
    });
    const refused = await wire.subscribe([topic]);
    if (refused.length) throw new Error(`the broker refused ${topic}`);
  }

  private async onControl(wire: Wire, topic: string, d: Delivery): Promise<void> {
    let msg: unknown;
    let reply: Record<string, unknown>;
    try {
      msg = JSON.parse(d.payload.toString());
      const errors = validate("harness/test-control.json", msg);
      if (errors.length) throw new Error(errors.join("; "));
      const valid = msg as Record<string, unknown>;
      await this.control(valid);
      reply = { requestId: valid.requestId, ok: true };
    } catch (err) {
      // A message that is not an object (JSON `null`, a number) has no requestId: the reply carries "".
      const requestId = msg !== null && typeof msg === "object" ? (msg as Record<string, unknown>).requestId : undefined;
      reply = { requestId: typeof requestId === "string" ? requestId : "", ok: false, error: String((err as Error).message ?? err),
        ...(err instanceof UnsupportedOp ? { unsupported: true } : {}) };
    }
    await wire.publish(`${topic}/reply`, reply, false).catch((err) => console.error(`control reply: ${err}`));
  }

  /** One control message; resolves once the bridge has done what the OS's change asks of it. */
  async control(msg: Record<string, unknown>): Promise<void> {
    switch (msg.op) {
      case "transportState":
        if (msg.state === "unknown") throw new UnsupportedOp("a PC's host transport is never unknown");
        this.present = msg.state === "up";
        this.changeHandler?.();
        return;
      case "power":
        return this.powerOp(msg.event as string, msg.announced !== false, (msg.suspendedMs as number | undefined) ?? 0);
      case "clock":
        this.steppable = msg.steppable as boolean;
        return;
      case "stall":
        this.o.onStall(msg.ms as number);
        return;
      case "account":
        this.accountOp(msg);
        this.changeHandler?.();
        return;
      case "session":
        this.sessionOp(msg);
        this.changeHandler?.();
        return;
      case "helper":
        return this.helperOp(msg);
      case "admins":
        this.adminsOp(msg);
        if (msg.reported !== false) this.adminsHandler?.();
        return;
      case "lockBehaviour":
        this.lockBehaviour.set(msg.session as string, { result: msg.result as "locks" | "ignores", afterMs: (msg.afterMs as number | undefined) ?? 0 });
        return;
      case "file":
        this.files.set(clean(msg.path as string), {
          exists: (msg.exists as boolean | undefined) ?? true,
          executable: (msg.executable as boolean | undefined) ?? false,
          writableBy: (msg.writableBy as number[] | undefined) ?? [],
        });
        return;
      default:
        throw new UnsupportedOp(`${String(msg.op)} is not played by the PC bridge's scripted OS`);
    }
  }

  private async powerOp(event: string, announced: boolean, suspendedMs: number): Promise<void> {
    if (event === "resume") {
      if (this.power !== "asleep") throw new Error(`the host is ${this.power}, not asleep`);
      this.power = "on";
      return this.powerHandler?.({ kind: "resume", asleepMs: suspendedMs });
    }
    if (this.power !== "on") throw new Error(`the host is ${this.power}`);
    if (event === "suspend") {
      this.power = "asleep";
      return this.powerHandler?.({ kind: "suspend", announced });
    }
    this.power = "off";
    return this.powerHandler?.({ kind: "shutdown", announced });
  }

  /** An account appears or changes (`present`), is renamed, deleted on the OS's authority, or leaves the listing without a deletion. */
  private accountOp(msg: Record<string, unknown>): void {
    const osId = msg.osId as number;
    const known = this.accounts.get(osId);
    const name = msg.name as string | undefined;
    switch (msg.state) {
      case "present":
      case "renamed": {
        if (!known && !name) throw new Error(`account ${osId} is new, and has no name`);
        if (!known && msg.state === "renamed") throw new Error(`no account ${osId} to rename`);
        this.accounts.set(osId, {
          name: name ?? known!.name,
          interactive: (msg.interactive as boolean | undefined) ?? known?.interactive ?? true,
          primaryGid: (msg.primaryGid as number | undefined) ?? known?.primaryGid ?? osId,
          path: (msg.path as string[] | undefined) ?? known?.path ?? [...SCRIPTED_DEFAULT_PATH],
          listed: true,
        });
        return;
      }
      case "deleted":
        this.accounts.delete(osId);
        return;
      default:
        // `absent` (a lapse from the listing) and `lookupFails` (a directory that cannot answer) read alike here.
        if (!known) throw new Error(`no account ${osId}`);
        known.listed = false;
    }
  }

  /** A session opens or changes as the OS reports it, or closes. At most one session is active at the console. */
  private sessionOp(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    if (msg.state === "closed") {
      if (!this.sessions.delete(id)) throw new Error(`no session ${id}`);
      return;
    }
    const known = this.sessions.get(id);
    const osId = (msg.osId as number | undefined) ?? known?.osId;
    if (osId === undefined) throw new Error(`session ${id} is new, and names no account`);
    const s: OsSession = {
      id,
      osId,
      graphical: (msg.graphical as boolean | undefined) ?? known?.graphical ?? true,
      remote: (msg.remote as boolean | undefined) ?? known?.remote ?? false,
      seat0Active: (msg.seat0Active as boolean | undefined) ?? known?.seat0Active ?? false,
      state: msg.state as OsSession["state"],
      idleHint: (msg.idleHint as boolean | undefined) ?? known?.idleHint ?? false,
      startedAt: typeof msg.startedAt === "string" ? Date.parse(msg.startedAt) : known?.startedAt ?? Date.now(),
    };
    if (s.seat0Active) for (const other of this.sessions.values()) other.seat0Active = false;
    this.sessions.set(id, s);
  }

  /**
   * A helper connects (`start`), goes (`stop`), reports for its own session (`report`) or for the
   * session `claims` names (`forge`). `from` other than `helper` is another process of that session
   * (a different pid), which makes a connection of its own.
   */
  private helperOp(msg: Record<string, unknown>): void {
    const sessionId = msg.session as string;
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    const values = (msg.values as HelperValues | undefined) ?? {};
    const from = (msg.from as string | undefined) ?? "helper";
    const emit = (m: HelperMessage) => this.helperHandler?.(m);
    if (from !== "helper") {
      if (msg.action === "stop") throw new Error(`only the helper stops; ${from} is not one`);
      const c = this.connect(this.nextPid++, session);
      emit({ kind: "connected", from: c });
      if (msg.action === "report") emit({ kind: "report", from: c, session: sessionId, values });
      if (msg.action === "forge") emit({ kind: "report", from: c, session: this.claims(msg), values });
      return;
    }
    const started = [...this.helpers.entries()].filter(([, h]) => h.session === sessionId).at(-1);
    if (!started) throw new Error(`the bridge started no helper in session ${sessionId}`);
    const [pid, h] = started;
    if (msg.action === "start") {
      const c = this.connect(pid, session);
      h.conn = c.conn;
      emit({ kind: "connected", from: c });
      return;
    }
    const c = h.conn !== null ? this.conns.get(h.conn) : undefined;
    if (msg.action === "stop") {
      this.helpers.delete(pid);
      // Its connection goes with it; a helper that never connected leaves the endpoint nothing to report.
      if (c) {
        this.conns.delete(c.conn);
        emit({ kind: "gone", from: c });
      }
      return;
    }
    if (!c) throw new Error(`the helper in session ${sessionId} is not connected`);
    emit({ kind: "report", from: c, session: msg.action === "forge" ? this.claims(msg) : sessionId, values });
  }

  private claims(msg: Record<string, unknown>): string {
    if (typeof msg.claims !== "string") throw new Error("forge names the session it claims in claims");
    return msg.claims;
  }

  /** A connection as the OS identifies it: the pid's session and that session's account. */
  private connect(pid: number, session: OsSession): HelperConnection {
    const c = { conn: this.nextConn++, pid, osId: session.osId, session: session.id };
    this.conns.set(c.conn, c);
    return c;
  }

  private adminsOp(msg: Record<string, unknown>): void {
    const next: ScriptedAdmins = {
      groups: (msg.groups as ScriptedAdmins["groups"] | undefined) ?? [],
      sudo: (msg.sudo as ScriptedAdmins["sudo"] | undefined) ?? [],
      polkit: (msg.polkit as ScriptedAdmins["polkit"] | undefined) ?? { identities: [], unrecognised: false },
    };
    // Every osId named must be an account the OS knows, root always being one.
    for (const osId of [...next.groups.flatMap((g) => g.members), ...next.sudo.map((s) => s.osId)]) this.nameOf(osId);
    this.facts = next;
  }

  private nameOf(osId: number): string {
    const a = this.accounts.get(osId);
    if (a) return a.name;
    if (osId === 0) return "root";
    throw new Error(`no account ${osId}`);
  }

  /** The OS carries out what it accepted after the call returns, as logind announces a sleep it was asked for. */
  private announce(kind: "suspend" | "shutdown"): void {
    setImmediate(() => {
      if (this.power !== "on") return;
      this.power = kind === "suspend" ? "asleep" : "off";
      this.powerHandler?.({ kind, announced: true }).catch((err) => console.error(`${kind}: ${err}`));
    });
  }

  async identity(): Promise<Identity> {
    return SCRIPTED_IDENTITY;
  }

  observerPresent(): boolean {
    return this.present;
  }

  /** A known account is gone when it is no longer in the accounts, read now: nothing is remembered of a deletion. */
  async observe(known: readonly number[]): Promise<Observation> {
    if (!this.present) throw new Error("the OS's observer is gone");
    if (this.power !== "on") throw new Error(`the host is ${this.power}`);
    // Its home as Debian's `adduser` makes it: the `account` op names none.
    const listed = [...this.accounts.entries()].filter(([, a]) => a.interactive && a.listed)
      .map(([osId, a]) => ({ osId, name: a.name, primaryGid: a.primaryGid, home: `/home/${a.name}`, path: [...a.path] }));
    const deleted = known.filter((osId) => osId !== 0 && !this.accounts.has(osId));
    return { accounts: { listed, deleted }, sessions: [...this.sessions.values()].map((s) => ({ ...s })) };
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
  }

  onPower(handler: (e: PowerEvent) => Promise<void>): void {
    this.powerHandler = handler;
  }

  /**
   * The facts as the OS reads them now: an osId the harness named that is no account any more (one
   * deleted since) is in no group and has no sudo rule, as `/etc/group` and sudoers name no uid.
   */
  async admins(): Promise<AdminFacts> {
    const known = (osId: number) => osId === 0 || this.accounts.has(osId);
    const member = (osId: number) => ({ osId, name: this.nameOf(osId) });
    // polkit's identities resolved as the OS resolves them: a user by its name among the accounts, a group among the groups.
    const polkit: AdminFacts["polkit"] = { users: [], groups: [], unresolved: [], unrecognised: this.facts.polkit.unrecognised };
    for (const identity of this.facts.polkit.identities) {
      const user = identity.match(/^unix-user:(.+)$/)?.[1];
      const group = identity.match(/^unix-group:(.+)$/)?.[1];
      const osId = user === "root" ? 0 : [...this.accounts.entries()].find(([, a]) => a.name === user)?.[0];
      const gid = this.facts.groups.find((g) => g.name === group)?.gid;
      if (user !== undefined && osId !== undefined) polkit.users.push({ osId, name: user });
      else if (group !== undefined && gid !== undefined) polkit.groups.push({ name: group, gid });
      else polkit.unresolved.push(identity);
    }
    return {
      // A group's members include every account whose primary group it is, as /etc/group leaves them out.
      groups: this.facts.groups.map((g) => {
        const ids = new Set(g.members.filter(known));
        for (const [osId, a] of this.accounts) if (a.primaryGid === g.gid) ids.add(osId);
        return { name: g.name, gid: g.gid, members: [...ids].map(member) };
      }),
      sudo: this.facts.sudo.filter((s) => known(s.osId)).map((s) => ({ ...member(s.osId), root: s.root })),
      polkit,
    };
  }

  onAdminsChange(handler: () => void): void {
    this.adminsHandler = handler;
  }

  personalKeys(): string[] {
    return [...SCRIPTED_PERSONAL_KEYS];
  }

  isOwnAddress(host: string): Promise<boolean> {
    return isOwnAddress(host);
  }

  /** Each session's locker answers as `lockBehaviour` said for the next lock, else it locks at once; the OS then reports it. */
  async lock(sessionIds: string[]): Promise<void> {
    await this.o.onReceived({ device: this.o.device, action: "os.lock", args: { sessions: sessionIds } });
    for (const id of sessionIds) {
      const b = this.lockBehaviour.get(id) ?? { result: "locks", afterMs: 0 };
      this.lockBehaviour.delete(id);
      if (b.result === "ignores") continue;
      setTimeout(() => {
        const s = this.sessions.get(id);
        if (!s || s.state !== "active") return;
        s.state = "locked";
        this.changeHandler?.();
      }, b.afterMs);
    }
  }

  async startHelper(sessionId: string): Promise<number> {
    const pid = this.nextPid++;
    this.helpers.set(pid, { session: sessionId, conn: null });
    await this.o.onReceived({ device: this.o.device, action: "os.helper_start", args: { session: sessionId } });
    return pid;
  }

  async stopHelper(pid: number): Promise<void> {
    const h = this.helpers.get(pid);
    if (!h) return;
    this.helpers.delete(pid);
    if (h.conn !== null) this.hangUp(h.conn);
    await this.o.onReceived({ device: this.o.device, action: "os.helper_stop", args: { session: h.session } });
  }

  async closeHelper(conn: number): Promise<void> {
    this.hangUp(conn);
  }

  /** A connection closes, and the bus reports it gone after the call that closed it returns. */
  private hangUp(conn: number): void {
    const c = this.conns.get(conn);
    if (!c) return;
    this.conns.delete(conn);
    setImmediate(() => this.helperHandler?.({ kind: "gone", from: c }));
  }

  onHelper(handler: (m: HelperMessage) => void): void {
    this.helperHandler = handler;
  }

  /** The notification hook (GA-BRIDGE-62): what the bridge asked the helper on that connection to show. */
  async notify(conn: number, text: string, urgency: Urgency): Promise<void> {
    const c = this.conns.get(conn);
    if (!c) throw new Error(`no helper connection ${conn}`);
    await this.o.onReceived({ device: this.o.device, action: "os.notify", args: { session: c.session, text, urgency } });
  }

  async sleep(): Promise<void> {
    await this.o.onReceived({ device: this.o.device, action: "os.sleep", args: {} });
    this.announce("suspend");
  }

  async shutdown(delayS?: number): Promise<void> {
    await this.o.onReceived({ device: this.o.device, action: "os.shutdown", args: delayS !== undefined ? { delayS } : {} });
    if (delayS !== undefined && delayS > 0) this.scheduled = true;
    else this.announce("shutdown");
  }

  async cancelShutdown(): Promise<boolean> {
    await this.o.onReceived({ device: this.o.device, action: "os.cancel", args: {} });
    const was = this.scheduled;
    this.scheduled = false;
    return was;
  }

  async stepClock(): Promise<boolean> {
    await this.o.onReceived({ device: this.o.device, action: "os.step_clock", args: {} });
    return this.steppable;
  }

  /** Root writes anything; under the plugins directory no one else does; elsewhere, the accounts the `file` op named. */
  async canWrite(osId: number, path: string): Promise<boolean> {
    if (osId === 0) return true;
    const p = clean(path);
    const plugins = clean(this.o.pluginsDir);
    if (p === plugins || p.startsWith(`${plugins}/`)) return false;
    return this.files.get(p)?.writableBy.includes(osId) ?? false;
  }

  async exists(path: string): Promise<PathInfo> {
    const f = this.files.get(clean(path));
    return { exists: f?.exists ?? false, executable: (f?.exists ?? false) && (f?.executable ?? false) };
  }

  pluginsDir(): string {
    return this.o.pluginsDir;
  }

  /** A plain directory: the scripted OS is not root, and GA-BRIDGE-70 is graded on a real OS. */
  async makeRootOnlyDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o755 });
  }

  /**
   * None: a scripted session has no display, and a real process started as the harness's user must
   * not be pointed at one it cannot open. What the core passes is graded by `os.server_start`'s `env`.
   */
  async displayEnv(sessionId: string): Promise<Record<string, string>> {
    if (!this.sessions.has(sessionId)) throw new Error(`no session ${sessionId}`);
    return {};
  }

  /**
   * A real process, started as the harness's own user and without `setpriv` (*The scripted OS*),
   * after `os.server_start` tells the harness what the bridge asked: `account` is the osId it would
   * run as, `session` the session it would run in.
   */
  async startServer(spec: ServerSpec): Promise<ServerProcess> {
    await this.o.onReceived({ device: this.o.device, action: "os.server_start", args: {
      plugin: spec.plugin, version: spec.version, account: spec.osId, session: spec.session, noNewPrivs: spec.noNewPrivs, env: spec.env, argv: spec.argv,
    } });
    return spawnServer(spec);
  }

  async close(): Promise<void> {}
}
