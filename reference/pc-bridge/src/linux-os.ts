import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isOwnAddress } from "./own-address.js";
import type {
  AdminFacts, HelperMessage, Identity, Observation, OsAccount, OsPort, PathInfo, PowerEvent, ServerProcess, ServerSpec, Urgency,
} from "./port.js";
import { getentPasswd, LoginPaths, readAccounts, readIdentity } from "./linux/accounts.js";
import { readAdminFacts } from "./linux/admins.js";
import { dbusNextBus, type Bus, type BusSignal } from "./linux/bus.js";
import { HelperEndpoint } from "./linux/endpoint.js";
import { parseGroup, parsePasswd, readText, under, type PasswdEntry } from "./linux/etc.js";
import { canWrite, exists, makeRootOnlyDir, type Writer } from "./linux/files.js";
import { dropArgs, launch, untilRunning, type Launched } from "./linux/launch.js";
import { GRAPHICAL_TYPES, Logind, toOsSessions } from "./linux/logind.js";
import { parseShowEnvironment, scopeProcs } from "./linux/session-env.js";
import {
  Inhibitor, monoMs, PowerWatch, readUptimeMs, runShutdown, shutdownArgs, SleepMeter, stepClock, type SpawnInhibitor,
} from "./linux/power.js";
import { COMMAND_ENV, run as realRun, RunError, type Runner } from "./linux/run.js";
import { Watches } from "./linux/watch.js";
import { groupStop, serverProcess, STOP_GRACE_MS } from "./spawn-server.js";

/** Where plugins are installed on Linux, owned by root, mode 0755 (*Plugins on Linux*). */
export const LINUX_PLUGINS_DIR = "/var/lib/galatea-pc-bridge/plugins";
/** How soon a lost or refused bus connection is tried again. */
export const BUS_RETRY_MS = 5_000;
/** How often the time asleep is sampled. */
export const SAMPLE_MS = 1_000;

/** How long a helper has, once released, to call the endpoint: one that has not is stopped, and its end reported (plan 4b). */
export const HELPER_CONNECT_MS = 10_000;
/** The idle threshold the helpers apply, the bridge's own setting (`standard/bridge.md` *Sessions*: 300 s by default). */
export const IDLE_AFTER_S = 300;
/** The cgroup v2 hierarchy, under which logind's session scopes are. */
export const CGROUP_ROOT = "/sys/fs/cgroup";
/** The session helper's entry point, beside this module in the package's build. */
export const HELPER_ENTRY = fileURLToPath(new URL("./helper.js", import.meta.url));
/** The descriptor on which the launcher hands a helper its start token (review N1). */
export const HELPER_TOKEN_FD = 4;

export interface LinuxOsOptions {
  /** The root directory the OS's files are read under: `/`, or a fake one in the tests. */
  root?: string;
  run?: Runner;
  bus?: () => Promise<Bus>;
  /** This process's effective uid: root reads sudo and PATHs and makes the plugins directory. */
  euid?: number;
  pluginsDir?: string;
  spawnInhibitor?: SpawnInhibitor;
  /** The monotonic clock the sampler reads, in ms. */
  mono?: () => number;
  sampleMs?: number;
  busRetryMs?: number;
  /** Stands in for chown(2) in the plugins directory's tests. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  log?: (line: string) => void;
  /** The cgroup hierarchy the session scopes are under (plan 4b); a temporary directory in the tests. */
  cgroupRoot?: string;
  /** Moves a pid into a scope; the tests' stand-in for the cgroup file system. */
  writeProcs?: (path: string, pid: number) => Promise<void>;
  /** The privilege drop for an account (`dropArgs`); the tests drop to their own account, or not at all. */
  dropFor?: (uid: number, gid: number) => string[];
  /** The helper's command: `node`, then its entry point; the tests give a stand-in. */
  helperCommand?: string[];
  idleAfterS?: number;
  helperConnectMs?: number;
  /** Starts the launcher; the tests wrap it to see the order of the release (review M5). */
  launch?: typeof launch;
  /** How long a stop waits for a group to empty before it kills it. */
  graceMs?: number;
}

/** A process the backend started in a session: stopped when logind removes the session. */
interface InSession {
  session: string;
  stop(): Promise<void>;
}

/** A helper the backend started: its launcher, whether it has called the endpoint, and its connect bound. */
interface StartedHelper extends InSession {
  pid: number;
  launched: Launched;
  connected: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Which sensor keys this machine's helpers will read (*Starting a process in a session*), known
 * before any helper runs, from what is installed: `camera_in_use` and `microphone_in_use` where
 * PipeWire is (`/usr/bin/pipewire`), whose graph the helper reads; `app` only where every graphical
 * session is X11, since GNOME on Wayland gives no focused window: GDM's `WaylandEnable=false`
 * (`/etc/gdm3/daemon.conf` on Debian, `custom.conf` on Ubuntu). Fixed for the bridge's run: a key
 * it cannot always read is not declared (GA-BRIDGE-38's declarations; the design's *Decisions*).
 */
export async function detectPersonalKeys(root: string, found: (path: string) => Promise<boolean>): Promise<string[]> {
  const keys: string[] = [];
  let x11Only = false;
  for (const conf of ["/etc/gdm3/daemon.conf", "/etc/gdm3/custom.conf"]) {
    const text = await readText(root, conf).catch(() => "");
    const daemon = text.split(/^\s*\[/m).find((s) => s.startsWith("daemon]")) ?? "";
    if (/^\s*WaylandEnable\s*=\s*false\s*$/m.test(daemon)) x11Only = true;
  }
  if (x11Only) keys.push("app");
  if (await found("/usr/bin/pipewire")) keys.push("camera_in_use", "microphone_in_use");
  return keys;
}

/**
 * The OS port on Linux (*The OS port*): identity, accounts and sessions, power, the delay lock,
 * the clock step, the administrator facts, locking, and the file checks, each read from the OS
 * itself; the processes (helpers, notifications, plugin servers) are plan 4b's, and their calls
 * throw. `open` connects to the system bus and starts the watches, the sampler and the delay lock;
 * a bus or logind that is not there is `observerPresent() === false` (the computer `down`), tried
 * again every 5 s, never an exit.
 */
export class LinuxOs implements OsPort {
  private readonly root: string;
  private readonly run: Runner;
  private readonly euid: number;
  private bus?: Bus;
  private logind?: Logind;
  private present = false;
  private closed = false;
  private keys: string[] = [];
  private changeHandler?: () => void;
  private adminsHandler?: () => void;
  private powerHandler?: (e: PowerEvent) => Promise<void>;
  private retry?: NodeJS.Timeout;
  private sampler?: NodeJS.Timeout;
  private readonly paths: LoginPaths;
  private readonly inhibitor: Inhibitor;
  private readonly power: PowerWatch;
  private readonly watches: Watches;
  private lastNotes = "";
  private endpoint?: HelperEndpoint;
  private helperHandler?: (m: HelperMessage) => void;
  private readonly helpers = new Map<number, StartedHelper>();
  /** The `needsSession` servers started, each with its session. */
  private readonly servers = new Set<InSession>();
  /** Fired by `close`: every command still running is ended, and its call settled (review M5). */
  private readonly closing = new AbortController();

  constructor(private readonly o: LinuxOsOptions = {}) {
    this.root = o.root ?? "/";
    const base = o.run ?? realRun;
    const signal = this.closing.signal;
    // Every command the backend runs, settled at close and refused after it, whatever runner it was given.
    this.run = (file, args, opts = {}) => {
      const closed = () => new RunError("failed", `${file}: the OS port is closed`);
      if (signal.aborted) return Promise.reject(closed());
      let onAbort!: () => void;
      const cut = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(closed());
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return Promise.race([base(file, args, { ...opts, signal }), cut]).finally(() => signal.removeEventListener("abort", onAbort));
    };
    this.euid = o.euid ?? process.geteuid!();
    this.paths = new LoginPaths({ run: this.run, euid: this.euid });
    this.inhibitor = new Inhibitor({ ...(o.spawnInhibitor ? { spawn: o.spawnInhibitor } : {}), log: this.log });
    const meter = new SleepMeter({ uptimeMs: () => readUptimeMs(this.root), monoMs: o.mono ?? monoMs });
    this.power = new PowerWatch({
      inhibitor: this.inhibitor, meter, handler: () => this.powerHandler, mono: o.mono ?? monoMs, log: this.log,
      // The bus away (or logind off it): the pure bound (review N4).
      preparing: async () => (this.logind && this.present ? this.logind.preparing() : undefined),
    });
    this.watches = new Watches({ root: this.root, onAccounts: () => this.changeHandler?.(), onAdmins: () => this.adminsHandler?.(), log: this.log });
  }

  private readonly log = (line: string) => (this.o.log ?? console.error)(line);

  /** Connects, watches, samples, and holds the delay lock; resolves whether or not the bus was there. */
  async open(): Promise<void> {
    this.keys = await detectPersonalKeys(this.root, async (p) => (await exists(under(this.root, p))).exists);
    this.watches.ensure();
    this.inhibitor.take();
    void this.power.tick();
    this.sampler = setInterval(() => void this.power.tick(), this.o.sampleMs ?? SAMPLE_MS);
    this.sampler.unref();
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let bus: Bus | undefined;
    try {
      bus = await (this.o.bus ?? (() => dbusNextBus()))();
      const logind = new Logind(bus);
      bus.onSignal((s) => this.onSignal(logind, s));
      bus.onClose((err) => this.lost(bus!, err));
      await logind.watch();
      this.bus = bus;
      this.logind = logind;
      await this.openEndpoint(bus);
      // watch() asked who logind is after its match rules; a change since is in the signals (review N3).
      this.present = logind.owner !== null;
      if (!this.present) this.log("logind is not on the system bus");
      // A PrepareForSleep(false) sent while the bus was away is lost: an announcement still open ends now.
      void this.power.recover();
    } catch (err) {
      this.log(`system bus: ${(err as Error).message}`);
      bus?.close();
      this.bus = undefined;
      this.logind = undefined;
      this.present = false;
      this.again();
    }
    this.changeHandler?.();
  }

  /**
   * The helper endpoint on this connection (*The helper endpoint*): a name the bus's policy refuses,
   * or another owns, is logged and left, and the computer runs on without helpers; it is asked for
   * again at the next connection.
   */
  private async openEndpoint(bus: Bus): Promise<void> {
    const endpoint = new HelperEndpoint({ bus, emit: (m) => this.fromHelper(m), log: this.log });
    bus.onSignal((s) => endpoint.onSignal(s));
    this.endpoint = endpoint;
    try {
      if (!(await endpoint.open())) this.log("helper endpoint: org.galatea.PcBridge1 is owned by another connection; no helper can connect");
    } catch (err) {
      this.log(`helper endpoint: ${(err as Error).message}; no helper can connect`);
    }
  }

  /** What the endpoint passes on: a helper's connection stops its connect bound; all of it goes to the core. */
  private fromHelper(m: HelperMessage): void {
    if (m.kind === "connected") {
      const h = this.helpers.get(m.from.pid);
      if (h) {
        h.connected = true;
        clearTimeout(h.timer);
      }
    }
    this.helperHandler?.(m);
  }

  private again(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, this.o.busRetryMs ?? BUS_RETRY_MS);
    this.retry.unref();
  }

  private lost(bus: Bus, err: Error): void {
    if (this.bus !== bus) return;
    this.log(`system bus lost: ${err.message}`);
    this.endpoint?.lost();
    this.endpoint = undefined;
    this.bus = undefined;
    this.logind = undefined;
    this.present = false;
    this.changeHandler?.();
    this.again();
  }

  /** A signal on this connection's logind, acted on only when its sender is the rightful one (`Logind.accept`). */
  private onSignal(logind: Logind, s: BusSignal): void {
    const e = logind.accept(s);
    if (!e) return;
    if (e.kind === "presence") {
      if (this.logind !== logind) return;
      this.present = logind.owner !== null;
      this.changeHandler?.();
    } else if (e.kind === "changed") {
      // What the backend started in a session goes with it (*Starting a process in a session*).
      if (s.member === "SessionRemoved" && typeof s.body[0] === "string") this.sessionRemoved(s.body[0]);
      this.changeHandler?.();
    } else {
      void this.power.announce(e.kind, e.start);
    }
  }

  identity(): Promise<Identity> {
    return readIdentity(this.root);
  }

  observerPresent(): boolean {
    return this.present;
  }

  /** logind's sessions, then the accounts (a session's uid a directory account may hold), each with its `PATH`. */
  async observe(known: readonly number[]): Promise<Observation> {
    const logind = this.logind;
    if (!logind || !this.present) throw new Error("logind is not on the system bus");
    const sessions = toOsSessions(await logind.read());
    const read = await readAccounts({ root: this.root, run: this.run }, known, sessions.map((s) => s.osId));
    const listed: OsAccount[] = await Promise.all(read.listed.map(async (e) => ({
      osId: e.uid, name: e.name, primaryGid: e.gid, home: e.home, path: await this.paths.get(e),
    })));
    return { accounts: { listed, deleted: read.deleted }, sessions };
  }

  onChange(handler: () => void): void {
    this.changeHandler = handler;
  }

  onPower(handler: (e: PowerEvent) => Promise<void>): void {
    this.powerHandler = handler;
  }

  async sleep(): Promise<void> {
    if (!this.logind) throw new Error("logind is not on the system bus");
    await this.logind.suspend();
  }

  shutdown(delayS?: number): Promise<void> {
    return runShutdown(this.run, shutdownArgs(delayS));
  }

  /** `shutdown -c` when logind shows one scheduled, or when it cannot be asked; resolves whether one was. */
  async cancelShutdown(): Promise<boolean> {
    const scheduled = await this.logind?.scheduledShutdown().catch(() => undefined);
    if (scheduled === false) return false;
    try {
      await runShutdown(this.run, ["-c"]);
    } catch (err) {
      if (scheduled) throw err;
    }
    return scheduled === true;
  }

  stepClock(): Promise<boolean> {
    return stepClock(this.run);
  }

  async admins(): Promise<AdminFacts> {
    this.watches.ensure();
    const { facts, notes } = await readAdminFacts({ root: this.root, run: this.run, euid: this.euid });
    // Each reason the set is incomplete, logged once until it changes.
    const text = notes.join("\n");
    if (text !== this.lastNotes && text) this.log(`administrators: ${notes.join("; ")}`);
    this.lastNotes = text;
    return facts;
  }

  onAdminsChange(handler: () => void): void {
    this.adminsHandler = handler;
  }

  personalKeys(): string[] {
    return [...this.keys];
  }

  isOwnAddress(host: string): Promise<boolean> {
    return isOwnAddress(host);
  }

  /** `loginctl lock-session <id>` for each, at once; throws naming each one the OS refused. */
  async lock(sessionIds: string[]): Promise<void> {
    const failed: string[] = [];
    await Promise.all(sessionIds.map(async (id) => {
      try {
        const r = await this.run("loginctl", ["lock-session", "--", id]);
        if (r.code !== 0) failed.push(`${id}: ${r.stderr.trim() || `exit ${r.code}`}`);
      } catch (err) {
        failed.push(`${id}: ${(err as Error).message}`);
      }
    }));
    if (failed.length) throw new Error(`loginctl lock-session: ${failed.join("; ")}`);
  }

  /**
   * The session helper (*Starting a process in a session*): `node <helper> --session <id> … --token-fd
   * 4` as the session's account, through the launcher moved into the session's scope, with `HOME`,
   * the system's `PATH`, `LANG` and the session's display variables, and nothing else. Before the
   * spawn, the endpoint takes the floor of the bus's names (review N2; a bus that cannot list them
   * rejects, and nothing is started); at the spawn, before the move, it expects the pid with that
   * floor and a fresh token (reviews I1, N1), which the launcher hands the helper on fd 4 at the
   * release and nowhere else. Resolves with the launcher's pid before it is released, so that the
   * core holds the pid before the helper can connect; then releases it. A helper that has not called
   * the endpoint within HELPER_CONNECT_MS is stopped; the end of the helper's process, however it
   * came, is reported as `exited`.
   */
  async startHelper(sessionId: string): Promise<number> {
    const { uid, procs } = await this.scope(sessionId);
    const account = await this.account(uid);
    const env = {
      HOME: account.home, PATH: COMMAND_ENV.PATH!, LANG: "C.UTF-8", ...(await this.displayEnv(sessionId)),
    };
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error("the helper endpoint is not on the system bus");
    const floor = await endpoint.floor();
    const token = randomBytes(32).toString("hex");
    const argv = [
      ...(this.o.helperCommand ?? [process.execPath, HELPER_ENTRY]), "--session", sessionId,
      "--idle-after", String(this.o.idleAfterS ?? IDLE_AFTER_S), "--keys", this.keys.join(","), "--token-fd", String(HELPER_TOKEN_FD),
    ];
    let spawned: number | undefined;
    let launched: Launched;
    try {
      launched = await (this.o.launch ?? launch)({
        argv, env, cwd: "/", drop: this.drop(uid, account.gid), procs, stdio: ["ignore", "ignore", "inherit"], token,
        // Fenced from its spawn, before it is in the session (review N2).
        onSpawn: (pid) => {
          spawned = pid;
          endpoint.expect(pid, floor, token);
        },
        ...(this.o.writeProcs ? { writeProcs: this.o.writeProcs } : {}),
      });
    } catch (err) {
      if (spawned !== undefined) endpoint.forget(spawned);
      throw err;
    }
    const h: StartedHelper = {
      pid: launched.pid, session: sessionId, launched, connected: false, stop: groupStop(launched.pid, launched.exited, this.o.graceMs),
    };
    this.helpers.set(h.pid, h);
    void launched.exited.then(() => {
      clearTimeout(h.timer);
      this.helpers.delete(h.pid);
      endpoint.forget(h.pid);
      this.helperHandler?.({ kind: "exited", pid: h.pid });
    });
    // Released once the core has the pid: a resolved promise's continuation runs before this.
    setImmediate(() => this.release(h, sessionId));
    return h.pid;
  }

  private release(h: StartedHelper, sessionId: string): void {
    // Stopped before its release (the session gone, the service closing): never released.
    if (!this.helpers.has(h.pid) || this.closed) return;
    h.launched.release().catch((err: Error) => this.log(`helper ${sessionId}: ${err.message}`));
    h.timer = setTimeout(() => {
      if (h.connected) return;
      this.log(`helper ${sessionId}: pid ${h.pid} did not connect within ${this.o.helperConnectMs ?? HELPER_CONNECT_MS} ms; stopped`);
      void h.stop();
    }, this.o.helperConnectMs ?? HELPER_CONNECT_MS);
    h.timer.unref();
  }

  /** Stops a helper the backend started: SIGTERM to its group, SIGKILL after the grace; resolves once it has exited. */
  async stopHelper(pid: number): Promise<void> {
    await this.helpers.get(pid)?.stop();
  }

  async closeHelper(conn: number): Promise<void> {
    this.endpoint?.close(conn);
  }

  onHelper(handler: (m: HelperMessage) => void): void {
    this.helperHandler = handler;
  }

  /** The helper on that connection shows it: a call to its own object, answered once it handed it to the session's notification service. */
  async notify(conn: number, text: string, urgency: Urgency): Promise<void> {
    if (!this.endpoint) throw new Error("the helper endpoint is not on the system bus");
    await this.endpoint.notify(conn, text, urgency);
  }

  /** The drop to an account: `setpriv` as root (*Starting a process in a session*). */
  private drop(uid: number, gid: number): string[] {
    return (this.o.dropFor ?? ((u: number, g: number) => dropArgs(u, g)))(uid, gid);
  }

  /** An account by uid: `/etc/passwd`, else NSS. Throws when neither knows it. */
  private async account(uid: number): Promise<PasswdEntry> {
    const local = parsePasswd(await readText(this.root, "/etc/passwd").catch(() => "")).find((e) => e.uid === uid);
    if (local) return local;
    const found = await getentPasswd(this.run, uid);
    if (typeof found !== "object") throw new Error(`uid ${uid}: no account (${found})`);
    return found;
  }

  /** A session's account and its scope's `cgroup.procs`, from logind; throws for a session logind does not know. */
  private async scope(sessionId: string): Promise<{ uid: number; type: string; procs: string }> {
    const logind = this.logind;
    if (!logind || !this.present) throw new Error("logind is not on the system bus");
    const s = await logind.session(sessionId);
    if (!s) throw new Error(`logind knows no session ${sessionId}`);
    return { uid: s.uid, type: s.type, procs: scopeProcs(this.o.cgroupRoot ?? CGROUP_ROOT, s.uid, sessionId, s.scope) };
  }

  /** logind removed a session: every helper and `needsSession` server started there is stopped. */
  private sessionRemoved(id: string): void {
    for (const h of this.helpers.values()) if (h.session === id) void h.stop();
    for (const s of this.servers) if (s.session === id) void s.stop();
  }

  /**
   * The account's uid and groups, from `/etc/passwd` and `/etc/group`; an account not there (a
   * directory's, systemd's userdb's) from NSS: `getent passwd` for its name, `id -G` for every group
   * NSS gives it (review M7). Throws when NSS cannot say, which `canWrite` answers as writable.
   */
  private async writer(osId: number): Promise<Writer> {
    const passwd = parsePasswd(await readText(this.root, "/etc/passwd"));
    const e = passwd.find((p) => p.uid === osId);
    const gids = new Set<number>();
    if (e) {
      const groups = parseGroup(await readText(this.root, "/etc/group"));
      gids.add(e.gid);
      for (const g of groups) if (g.members.includes(e.name)) gids.add(g.gid);
      return { uid: osId, gids };
    }
    const found = await getentPasswd(this.run, osId);
    if (typeof found !== "object") throw new Error(`uid ${osId}: NSS gives no account (${found})`);
    const r = await this.run("id", ["-G", "--", found.name]);
    const ids = r.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    if (r.code !== 0 || ids.length === 0 || ids.some((n) => !Number.isSafeInteger(n))) throw new Error(`id -G ${found.name}: exit ${r.code}`);
    gids.add(found.gid);
    for (const n of ids) gids.add(n);
    return { uid: osId, gids };
  }

  /** A failed read of the account's groups (its files, or NSS for an account not in them) is taken as writable, never as safe. */
  async canWrite(osId: number, path: string): Promise<boolean> {
    if (osId === 0) return true;
    let w: Writer;
    try {
      w = await this.writer(osId);
    } catch {
      return true;
    }
    return canWrite(w, path);
  }

  exists(path: string): Promise<PathInfo> {
    return exists(path);
  }

  pluginsDir(): string {
    return this.o.pluginsDir ?? LINUX_PLUGINS_DIR;
  }

  makeRootOnlyDir(path: string): Promise<void> {
    return makeRootOnlyDir(path, { euid: this.euid, ...(this.o.chown ? { chown: this.o.chown } : {}) });
  }

  /**
   * The session's display variables, from its account's user manager: `systemctl --user
   * --machine=<account>@.host show-environment` as root, the five names only (*Starting a process in
   * a session*). Throws for a session that is not graphical, a read that fails, and an environment
   * with neither `DISPLAY` nor `WAYLAND_DISPLAY`.
   */
  async displayEnv(sessionId: string): Promise<Record<string, string>> {
    const { uid, type } = await this.scope(sessionId);
    if (!GRAPHICAL_TYPES.includes(type)) throw new Error(`session ${sessionId} has no graphical display (Type ${type || "none"})`);
    const account = await this.account(uid);
    const r = await this.run("systemctl", ["--user", `--machine=${account.name}@.host`, "show-environment"]);
    if (r.code !== 0) throw new Error(`systemctl --user show-environment for ${account.name}: ${r.stderr.trim() || `exit ${r.code}`}`);
    const env = parseShowEnvironment(r.stdout);
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error(`session ${sessionId}: ${account.name}'s user manager has no display`);
    return env;
  }

  /**
   * A plugin's server (*Plugins on Linux*): `spec.argv` as `spec.osId`, never root, through the
   * launcher and `setpriv --reuid --regid --init-groups --no-new-privs`, its own process group, in
   * `spec.cwd`, with `spec.env` and nothing else; for a `needsSession` server, moved into its
   * session's scope first. Resolves once the launcher has become the server; rejects, nothing left
   * running, when it could not be started. `stop` is `serverProcess`'s.
   */
  async startServer(spec: ServerSpec): Promise<ServerProcess> {
    if ((spec as { noNewPrivs: unknown }).noNewPrivs !== true) throw new Error(`${spec.plugin} ${spec.version}: a server starts only with no_new_privs`);
    if (spec.osId === 0) throw new Error(`${spec.plugin} ${spec.version}: a server never runs as root`);
    const account = await this.account(spec.osId);
    let procs: string | undefined;
    if (spec.session !== null) {
      const s = await this.scope(spec.session);
      if (s.uid !== spec.osId) throw new Error(`session ${spec.session} is uid ${s.uid}'s, not ${spec.osId}'s`);
      procs = s.procs;
    }
    const launched = await launch({
      argv: spec.argv, env: spec.env, cwd: spec.cwd, drop: this.drop(spec.osId, account.gid), stdio: ["pipe", "pipe", "inherit"],
      ...(procs ? { procs } : {}), ...(this.o.writeProcs ? { writeProcs: this.o.writeProcs } : {}),
    });
    try {
      await launched.release();
      await untilRunning(launched);
    } catch (err) {
      await launched.exited;
      throw new Error(`${spec.plugin} ${spec.version}: ${(err as Error).message}`);
    }
    const server = serverProcess({ pid: launched.pid, stdin: launched.child.stdin!, stdout: launched.child.stdout!, exited: launched.exited },
      this.o.graceMs ?? STOP_GRACE_MS);
    if (spec.session !== null) {
      const entry: InSession = { session: spec.session, stop: () => server.stop() };
      this.servers.add(entry);
      void launched.exited.then(() => this.servers.delete(entry));
    }
    return server;
  }

  /** Settles at once: the bus closed (its pending calls reject), the watches, the sampler and the delay lock ended. */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    for (const h of this.helpers.values()) clearTimeout(h.timer);
    clearTimeout(this.retry);
    clearInterval(this.sampler);
    this.watches.close();
    this.inhibitor.close();
    this.bus?.close();
    this.bus = undefined;
    this.logind = undefined;
    this.present = false;
  }
}
