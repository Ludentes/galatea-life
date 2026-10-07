import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { OsAccount, OsPort, OsSession } from "../port.js";
import { type StateStore, syncDir } from "../state-store.js";
import type { SuspendClock } from "../suspend-clock.js";
import { checkManifest, type Manifest, MANIFEST_FILE, MANIFEST_MAX_BYTES, packagePath } from "./manifest.js";
import { fetchPackage, PackageError, unpack } from "./package.js";
import {
  currentVersion, deviceIdOf, deviceIdsOf, emptyPlugins, type InFlight, type InstalledVersion, type Outcome, type PluginsState,
} from "./record.js";
import { type DeviceView, type Fault, PluginServer, type StopReason } from "./server.js";

/** An install not ended within this of its `accepted` ends `install_failed(timeout)` (GA-BRIDGE-68; ⚠️ a guess). */
export const INSTALL_MS = 600_000;
/** Where a package is fetched and unpacked before it is moved into place: inside the plugins directory, so the move is a rename. */
export const STAGING = ".staging";

/** An install that cannot finish: the `install_failed` reason and its detail. */
class Failure extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

/** What the host answers a request with; the bridge makes the reply of it. */
export interface Answer {
  status: "ok" | "accepted" | "failed";
  reason?: string;
  detail?: string;
  data?: unknown;
}

export interface PluginHostOptions {
  port: OsPort;
  clock: Clock;
  store: StateStore;
  /** `http:` packages as well as `https:`: only under a run. */
  allowHttp: boolean;
  /** The account a token names, as the last observation listed it; undefined when `accounts` does not list it now. */
  account(token: string): OsAccount | undefined;
  /** Whether the token was retired: its account deleted (GA-BRIDGE-67). */
  retired(token: string): boolean;
  /** The record changed, a request ended, or a server's devices or faults changed: what the bridge publishes may have changed. */
  changed(): void;
  /** The core's suspend-aware clock, for the servers' times (GA-BRIDGE-58). */
  serverClock: SuspendClock;
  /** The sessions of the last observation, for a `needsSession` server (GA-BRIDGE-49). */
  sessions(): OsSession[];
}

const wireTime = (ms: number) => new Date(ms).toISOString();

/** JSON with every object's keys sorted: two manifests compare equal whatever order their keys came in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A directory and each one above it: `/usr/local/bin`, `/usr/local`, `/usr`, `/`. */
function upwards(dir: string): string[] {
  const out: string[] = [];
  for (let d = posix.normalize(dir); ; d = posix.dirname(d)) {
    out.push(d);
    if (d === "/") return out;
  }
}

/**
 * The plugin host's packages (plan 3c): `install`, a reinstall, `uninstall` and `activate`, the
 * installed record and the requests in flight, kept in the state file (GA-BRIDGE-31) and ended once
 * after a restart (GA-BRIDGE-68). Installs and uninstalls run one at a time, never on a request's
 * path, so every reply goes out within 1 s (GA-BRIDGE-4). And the servers (plan 3d): one per
 * activated version, and one for a version whose activation waits for its swap, each started once
 * `reconcile` finds it wanted, and the swap once the waiting version's server has served.
 */
export class PluginHost {
  readonly state: PluginsState;
  private readonly dir: string;
  /** The jobs, one at a time, in the order accepted. */
  private chain: Promise<void> = Promise.resolve();
  /** The running install's abort, by requestId: its 600 s, or the bridge's stop. */
  private readonly aborts = new Map<string, AbortController>();
  /** Installs a restart cut short and this start resumed: any end but `installed` is `restart` (GA-BRIDGE-68). */
  private readonly resumed = new Set<string>();
  /** An install moving its files into place: its 600 s no longer cut it. */
  private readonly committing = new Set<string>();
  /** Requests whose end is set but not yet on disk: their events wait for the save (GA-BRIDGE-68). */
  private readonly unsaved = new Set<string>();
  /** The last save of an end failed: the bridge names `state_unsaved`, and each tick tries again. */
  private saveFailed = false;
  private retryingSave = false;
  /** Why the plugins directory is not ready, while it is not: `plugins_unready`, tried again each tick. */
  private notReady?: string;
  private retryingDir = false;
  private closed = false;
  /** Each version's server, by `<plugin> <version>`: kept while the version is installed, a stopped one included, for its devices' view. */
  private readonly servers = new Map<string, PluginServer>();
  /**
   * A swap under way, by plugin: one at a time. An `activate` of the plugin waits for `saved`, its
   * record settled (the saves done), never for `done`, which includes the old server's stop and so
   * can take the whole grace: `activate` is answered within 1 s (GA-BRIDGE-42).
   */
  private readonly swapping = new Map<string, { saved: Promise<void>; done: Promise<void> }>();
  /**
   * Plugins whose record a reinstall or an uninstall is changing, from the stop of their servers
   * until the record changed: `reconcile` leaves their servers alone meanwhile, so none is made
   * again from the record as it was.
   */
  private readonly busy = new Set<string>();
  /** Servers `reconcile` found of a record no longer kept, while they stop: none is made for their version until they have. */
  private readonly draining = new Map<string, Promise<void>>();
  /** Each plugin device's last successful read, and whether it is observable since when (the roster). */
  private readonly seen = new Map<string, { lastCheckIn: number | null; observable: boolean; since: number }>();

  constructor(private readonly o: PluginHostOptions) {
    this.state = o.store.state.plugins ??= emptyPlugins();
    this.dir = o.port.pluginsDir();
  }

  /**
   * At the bridge's start, after its first observation and before its first `devices`: the plugins
   * directory made root's, every staged or unrecorded directory removed (so nothing half-installed
   * stays), each accepted `uninstall` finished, each `install` whose 600 s passed while the bridge
   * was down ended `restart` at once, and each other one resumed from its fetch.
   */
  async start(): Promise<void> {
    try {
      await this.prepare();
    } catch (err) {
      this.notReady = String((err as Error).message ?? err);
      console.error(`plugins: ${this.notReady}`);
    }
    const now = this.o.clock.now();
    for (const r of this.state.requests) {
      if (r.ended) continue;
      if (r.op === "uninstall") {
        // Without its directory an uninstall cannot remove the files: it stays in flight, run once the directory is ready.
        if (this.notReady === undefined) await this.remove(r).catch((err) => console.error(`uninstall ${r.plugin}: ${err}`));
      } else if (now >= this.deadline(r)) {
        await this.end(r, { type: "install_failed", reason: "restart", detail: "its 600 s passed while the bridge was down" });
      } else if (this.notReady !== undefined) {
        await this.end(r, { type: "install_failed", reason: "restart", detail: `plugins_unready: ${this.notReady}` });
      } else {
        this.resumed.add(r.requestId);
        this.enqueue(r);
      }
    }
  }

  /** The plugins directory made root's, its staging emptied, and every directory no record names removed. */
  private async prepare(): Promise<void> {
    await this.o.port.makeRootOnlyDir(this.dir);
    await rm(join(this.dir, STAGING), { recursive: true, force: true });
    await mkdir(join(this.dir, STAGING), { mode: 0o700 });
    for (const id of await readdir(this.dir)) {
      if (id === STAGING) continue;
      const p = this.state.installed[id];
      if (!p) {
        await rm(join(this.dir, id), { recursive: true, force: true });
        continue;
      }
      for (const v of await readdir(join(this.dir, id))) if (!Object.hasOwn(p.versions, v)) await rm(join(this.dir, id, v), { recursive: true, force: true });
    }
  }

  /** Why the plugins directory is not ready, or undefined when it is (the bridge's fault `plugins_unready`). */
  unready(): string | undefined {
    return this.notReady;
  }

  /** Whether an end could not be saved: its event is held (the bridge's fault `state_unsaved`). */
  unsavedEnds(): boolean {
    return this.saveFailed;
  }

  /** The plugins directory again, after a start that could not make it; then the uninstalls it held. */
  private async retryPrepare(): Promise<void> {
    try {
      await this.prepare();
    } catch (err) {
      this.notReady = String((err as Error).message ?? err);
      return;
    }
    this.notReady = undefined;
    for (const r of this.state.requests) if (r.op === "uninstall" && !r.ended) this.enqueue(r);
    this.o.changed();
    this.reconcile();
  }

  /** A request accepted and not yet announced, by its requestId: one repeated after a restart is a duplicate too. */
  request(requestId: string): InFlight | undefined {
    return this.state.requests.find((r) => r.requestId === requestId);
  }

  /**
   * `install`: kept on disk before the `accepted`, then fetched, checked and unpacked after the
   * reply. A save that fails is `failed(state_unsaved)`, nothing accepted.
   */
  async install(requestId: string, pkg: { url: string; sha256: string }, account: string): Promise<Answer> {
    if (this.notReady !== undefined) return { status: "failed", reason: "plugins_unready", detail: this.notReady };
    const r: InFlight = { requestId, op: "install", acceptedAt: wireTime(this.o.clock.now()), package: pkg, account };
    return this.accept(r);
  }

  /** `uninstall` of a plugin installed here; `failed(unknown_plugin)` at once, nothing done, for one that is not. */
  async uninstall(requestId: string, plugin: string): Promise<Answer> {
    if (!Object.hasOwn(this.state.installed, plugin)) return { status: "failed", reason: "unknown_plugin", detail: `${plugin} is not installed` };
    if (this.notReady !== undefined) return { status: "failed", reason: "plugins_unready", detail: this.notReady };
    return this.accept({ requestId, op: "uninstall", acceptedAt: wireTime(this.o.clock.now()), plugin });
  }

  private async accept(r: InFlight): Promise<Answer> {
    this.state.requests.push(r);
    try {
      await this.o.store.save();
    } catch (err) {
      this.state.requests.splice(this.state.requests.indexOf(r), 1);
      return { status: "failed", reason: "state_unsaved", detail: String((err as Error).message ?? err) };
    }
    this.enqueue(r);
    return { status: "accepted" };
  }

  /**
   * `activate`, recorded before the `ok` (GA-BRIDGE-42). The plugin's current version (`currentVersion`:
   * the activated one, else the one installed first) is activated at once. Any other version waits
   * as the plugin's pending activation, which the swap ends: while another is activated, and, by the
   * maintainer's ruling M6, while none is, so that activating a later version is a switch-over that
   * removes the earlier one once the later has served. Naming the current version while another waits
   * cancels the pending one (GA-BRIDGE-69). Idempotent: activating what is activated, or pending,
   * changes nothing.
   */
  async activate(plugin: string, version: string): Promise<Answer> {
    // A swap's save under way: the answer comes from the record as it settles, the old version kept if the save fails.
    await this.swapping.get(plugin)?.saved;
    const p = this.state.installed[plugin];
    const v = p?.versions[version];
    if (!p || !v) return { status: "failed", reason: "unknown_plugin", detail: `${plugin} ${version} is not installed` };
    const ok: Answer = { status: "ok", data: { plugin, version } };
    const before = { pending: p.pending, activated: v.activated };
    if (version === p.pending) return ok;
    if (version === currentVersion(p)) {
      if (v.activated && p.pending === undefined) return ok;
      v.activated = true;
      delete p.pending;
    } else {
      p.pending = version;
    }
    try {
      await this.o.store.save();
    } catch (err) {
      if (before.pending === undefined) delete p.pending;
      else p.pending = before.pending;
      v.activated = before.activated;
      return { status: "failed", reason: "state_unsaved", detail: String((err as Error).message ?? err) };
    }
    this.o.changed();
    this.reconcile();
    return ok;
  }

  // --- The servers ----------------------------------------------------------------------------

  /** The versions whose servers run: each plugin's activated one and its pending one, not a deleted account's (GA-BRIDGE-67). */
  private wanted(): Map<string, { plugin: string; version: string }> {
    const out = new Map<string, { plugin: string; version: string }>();
    for (const [plugin, p] of Object.entries(this.state.installed)) {
      for (const [version, v] of Object.entries(p.versions)) {
        if (!(v.activated || version === p.pending) || this.o.retired(v.account)) continue;
        out.set(`${plugin} ${version}`, { plugin, version });
      }
    }
    return out;
  }

  /**
   * Brings the servers in line with the record: each wanted version's started, each other one's
   * stopped (`account_deleted` for a deleted account's, `deactivated` for a cancelled pending one),
   * and a swap made whose waiting version's server has served (tried again at each call, so a swap
   * whose save failed is made later). Not while the plugins directory is not ready or once closed.
   */
  reconcile(): void {
    if (this.closed || this.notReady !== undefined) return;
    const want = this.wanted();
    const pluginOf = (key: string) => key.split(" ")[0]!;
    // A server of a record no longer kept (its version removed, or replaced by a reinstall) is
    // stopped and forgotten; its version gets a server of the record as it is once it has stopped.
    for (const [key, srv] of [...this.servers]) {
      const [plugin, version] = key.split(" ") as [string, string];
      if (this.busy.has(plugin) || this.state.installed[plugin]?.versions[version] === srv.installed) continue;
      this.servers.delete(key);
      const stopped = srv.stop(this.state.installed[plugin]?.versions[version] ? "reinstall" : "uninstall")
        .finally(() => {
          this.draining.delete(key);
          this.reconcile();
        });
      this.draining.set(key, stopped);
    }
    let made = false;
    for (const [key, { plugin, version }] of want) {
      if (this.busy.has(plugin) || this.draining.has(key)) continue;
      let srv = this.servers.get(key);
      if (!srv) {
        srv = this.newServer(plugin, version);
        this.servers.set(key, srv);
        made = true;
      }
      srv.start();
    }
    for (const [key, srv] of this.servers) {
      if (want.has(key) || this.busy.has(pluginOf(key)) || srv.phase === "stopped" || srv.phase === "idle" || srv.phase === "mismatch") continue;
      const [plugin, version] = key.split(" ") as [string, string];
      const v = this.state.installed[plugin]?.versions[version];
      void srv.stop(v && this.o.retired(v.account) ? "account_deleted" : "deactivated");
    }
    for (const [plugin, p] of Object.entries(this.state.installed)) {
      if (this.busy.has(plugin)) continue;
      if (p.pending !== undefined && this.servers.get(`${plugin} ${p.pending}`)?.serving) void this.swap(plugin);
    }
    // A server made now may show at once (a mismatch kept across a restart): the next status carries it.
    if (made) this.o.changed();
  }

  private newServer(plugin: string, version: string): PluginServer {
    const v = this.state.installed[plugin]!.versions[version]!;
    const key = `${plugin} ${version}`;
    return new PluginServer({
      port: this.o.port,
      clock: this.o.serverClock,
      wall: () => this.o.clock.now(),
      plugin, version,
      dir: join(this.dir, plugin, version),
      installed: v,
      deviceId: (k) => deviceIdOf(plugin, version, k),
      account: () => this.o.account(v.account),
      sessions: () => this.o.sessions(),
      changed: () => this.o.changed(),
      served: () => this.reconcile(),
      mismatched: (detail, at) => {
        if (this.servers.get(key) === undefined || this.state.installed[plugin]?.versions[version] !== v) return;
        v.mismatch = { detail, at: wireTime(at) };
        this.o.store.save().catch((err) => console.error(`state: ${err}`));
      },
      eraFound: (era) => {
        if (this.state.installed[plugin]?.versions[version] !== v) return;
        v.era = era;
        this.o.store.save().catch((err) => console.error(`state: ${err}`));
      },
    }, v.mismatch ? { detail: v.mismatch.detail, at: Date.parse(v.mismatch.at) } : undefined);
  }

  /**
   * The swap (GA-BRIDGE-69, the maintainer's ruling M6): the waiting version is activated and the
   * version it replaces, the current one, is removed, its activation, record and files, with no
   * `uninstalled`; its devices' ids kept to be cleared (GA-BRIDGE-21), and its keys kept so the new
   * version's devices keep their `stagedFor`. The record first, in one save; a save that fails
   * changes nothing, and the next `reconcile` tries again. Then its server stopped and its files removed.
   */
  private swap(plugin: string): Promise<void> {
    const under = this.swapping.get(plugin);
    if (under) return under.done;
    let saved!: () => void;
    const settled = new Promise<void>((resolve) => { saved = resolve; });
    const done = this.swapNow(plugin, saved).finally(() => {
      saved();
      this.swapping.delete(plugin);
    });
    this.swapping.set(plugin, { saved: settled, done });
    return done;
  }

  /**
   * The swap's record is written as it will be, then memory is put back as it was until the save
   * succeeds: an `activate` answered meanwhile (it waits for the swap), a `devices` published
   * meanwhile, never show a swap that a failed save undoes (3d's review, M5). Once it succeeded the
   * change is made in memory and saved again, since another save meanwhile wrote memory as it was;
   * the old version's files are removed only once that second save is on disk.
   */
  private async swapNow(plugin: string, saved: () => void): Promise<void> {
    const p = this.state.installed[plugin];
    const next = p?.pending;
    if (!p || next === undefined || !this.servers.get(`${plugin} ${next}`)?.serving) return;
    const old = currentVersion(p);
    const gone = old !== undefined && old !== next ? p.versions[old] : undefined;
    const was = { versions: { ...p.versions }, replaced: p.replaced, clears: this.state.clears && [...this.state.clears], activated: p.versions[next]!.activated };
    const apply = () => {
      p.versions[next]!.activated = true;
      delete p.pending;
      if (old === undefined || !gone) return;
      const list = (this.state.clears ??= []);
      for (const d of gone.manifest.devices) {
        const id = deviceIdOf(plugin, old, d.key);
        if (!list.includes(id)) list.push(id);
      }
      delete p.versions[old];
      p.replaced = { version: old, keys: gone.manifest.devices.map((d) => d.key) };
    };
    apply();
    const saving = this.o.store.save();
    // Put back at once: the save above has the swapped record already.
    p.versions = { ...was.versions };
    p.versions[next]!.activated = was.activated;
    p.pending = next;
    if (was.replaced) p.replaced = was.replaced;
    else delete p.replaced;
    if (was.clears) this.state.clears = was.clears;
    else delete this.state.clears;
    try {
      await saving;
    } catch (err) {
      console.error(`swap ${plugin} to ${next}: ${(err as Error).message ?? err}`);
      return;
    }
    // Nothing else changes a plugin's pending version while its swap runs; an uninstall may have removed it.
    if (this.state.installed[plugin] !== p || p.pending !== next || !p.versions[next] || (old !== undefined && p.versions[old] !== gone)) return;
    apply();
    this.o.changed();
    let kept = true;
    await this.o.store.save().catch((err) => {
      kept = false;
      console.error(`swap ${plugin} to ${next}: ${(err as Error).message ?? err}`);
    });
    // The record has settled: an `activate` waiting for this swap is answered now, not after the stop below.
    saved();
    if (old !== undefined && gone) {
      await this.dropServer(plugin, old, "swap");
      // A record on disk that may still name the old version keeps its files, for the next start's swap.
      if (kept) await rm(join(this.dir, plugin, old), { recursive: true, force: true }).catch((err) => console.error(`swap: ${err}`));
    }
  }

  /** Stops a version's server and forgets it: its version is removed or replaced on disk. */
  private async dropServer(plugin: string, version: string, why: StopReason): Promise<void> {
    const key = `${plugin} ${version}`;
    const srv = this.servers.get(key);
    // Stopped already by a tick's `reconcile` (its record gone): its stop is awaited all the same,
    // so that nothing runs from files the caller then removes.
    if (!srv) return void (await this.draining.get(key));
    this.servers.delete(key);
    await srv.stop(why);
  }

  /** Whether a version runs a server, or is to at the next `reconcile`: its devices show nothing while it starts. */
  runs(plugin: string, version: string): boolean {
    return this.servers.has(`${plugin} ${version}`) || this.wanted().has(`${plugin} ${version}`);
  }

  /** A version's server, if one was made. */
  server(plugin: string, version: string): PluginServer | undefined {
    return this.servers.get(`${plugin} ${version}`);
  }

  /** A plugin device's view (DeviceView), undefined while its version runs no server. */
  view(plugin: string, version: string, key: string): DeviceView {
    return this.server(plugin, version)?.view(key);
  }

  /**
   * A plugin device's observation for the roster, against `now`: its last successful read, and
   * whether it is observable (served, that read within three cadences), since when; kept in this
   * instance only.
   */
  observation(id: string, view: DeviceView, cadenceMs: number, since: number, now: number): { lastCheckIn: number | null; observable: boolean; since: number } {
    const was = this.seen.get(id) ?? { lastCheckIn: null, observable: false, since };
    // The device's own read, not its server's having served (GA-BRIDGE-37).
    const lastCheckIn = view?.available && view.checkIn !== null ? view.checkIn : was.lastCheckIn;
    const obs = view?.available === true && lastCheckIn !== null && now >= lastCheckIn && now - lastCheckIn <= 3 * cadenceMs;
    const next = { lastCheckIn, observable: obs, since: obs !== was.observable ? now : was.since };
    this.seen.set(id, next);
    return next;
  }

  /** Every server's faults: `pin_mismatch`, `crash_loop` and `reading_dropped` (GA-BRIDGE-45, GA-BRIDGE-58). */
  faults(): Fault[] {
    return [...this.servers.values()].flatMap((s) => s.faults());
  }

  /** The OS's sessions changed: each `needsSession` server follows them (GA-BRIDGE-49). */
  sessionsChanged(): void {
    for (const s of this.servers.values()) s.sessionsChanged();
  }

  /** The first status after a resume went out: each serving server's devices are read (GA-BRIDGE-60). */
  afterResume(): void {
    for (const s of this.servers.values()) s.resumed();
  }

  /** At the bridge's stop: every server stopped, its devices keeping the status they had (GA-BRIDGE-58). */
  async stopServers(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => s.stop("bridge")));
  }

  /** Ends each install past its 600 s, on the bridge's clock, `timeout` (`restart` for one resumed), nothing installed. */
  expire(now: number): void {
    for (const r of this.state.requests) {
      if (r.op !== "install" || r.ended || this.committing.has(r.requestId) || now < this.deadline(r)) continue;
      this.aborts.get(r.requestId)?.abort(new Error("timeout"));
      void this.end(r, this.failure(r, "timeout", `not ended within ${INSTALL_MS} ms of its accepted`));
    }
    // The bridge's 1 s tick: an end not yet on disk, and a plugins directory not yet made, are tried again.
    if (this.saveFailed && !this.retryingSave) {
      this.retryingSave = true;
      void this.persistEnds().finally(() => { this.retryingSave = false; });
    }
    if (this.notReady !== undefined && !this.retryingDir && !this.closed) {
      this.retryingDir = true;
      void this.retryPrepare().finally(() => { this.retryingDir = false; });
    }
  }

  /**
   * The requests ended whose events may go out, in the order accepted: each end on disk first, so that
   * a restart never ends a request a second, different way; not one whose job is still cleaning up.
   */
  ended(): (InFlight & { ended: Outcome })[] {
    return this.state.requests.filter((r): r is InFlight & { ended: Outcome } =>
      r.ended !== undefined && !this.aborts.has(r.requestId) && !this.unsaved.has(r.requestId));
  }

  /** Its event went out: the request is forgotten. */
  async announced(requestId: string): Promise<void> {
    const i = this.state.requests.findIndex((r) => r.requestId === requestId);
    if (i < 0) return;
    this.state.requests.splice(i, 1);
    await this.o.store.save().catch((err) => console.error(`state: ${err}`));
  }

  /** The device ids whose retained statuses must still be cleared, kept on disk until each clear is taken (GA-BRIDGE-21). */
  clears(): string[] {
    return [...(this.state.clears ?? [])];
  }

  /** Adds device ids whose statuses must be cleared: on disk, so a restart still clears them. */
  async toClear(ids: string[]): Promise<void> {
    const list = (this.state.clears ??= []);
    const add = ids.filter((id) => !list.includes(id));
    if (!add.length) return;
    list.push(...add);
    await this.o.store.save().catch((err) => console.error(`state: ${err}`));
  }

  /** The broker took these clears: they are forgotten. */
  async cleared(ids: string[]): Promise<void> {
    const list = this.state.clears ?? [];
    const left = list.filter((id) => !ids.includes(id));
    if (left.length === list.length) return;
    if (left.length) this.state.clears = left;
    else delete this.state.clears;
    await this.o.store.save().catch((err) => console.error(`state: ${err}`));
  }

  /**
   * At the bridge's stop: the running install is cut, and it and every queued one stay in flight for
   * the next start; every server stopped, its devices keeping the status they had (GA-BRIDGE-58).
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const a of this.aborts.values()) a.abort(new Error("the bridge is stopping"));
    await this.chain;
    await this.stopServers();
  }

  private deadline(r: InFlight): number {
    return Date.parse(r.acceptedAt) + INSTALL_MS;
  }

  private enqueue(r: InFlight): void {
    this.chain = this.chain.then(() => (r.op === "install" ? this.runInstall(r) : this.remove(r))).catch((err) => console.error(`plugins: ${err}`));
  }

  /** A failed end: a resumed install's is `restart`, its own reason in the detail (GA-BRIDGE-68 names only `installed` or `restart` after a restart). */
  private failure(r: InFlight, reason: string, detail: string): Outcome {
    return this.resumed.has(r.requestId)
      ? { type: "install_failed", reason: "restart", detail: `${reason}: ${detail}` }
      : { type: "install_failed", reason, detail };
  }

  /**
   * Ends a request once: its outcome kept on disk until its event has gone out. The event waits for
   * the save (`ended` leaves the request out until then); a save that fails is tried again each tick.
   */
  private async end(r: InFlight, outcome: Outcome): Promise<void> {
    if (r.ended) return;
    r.ended = outcome;
    this.unsaved.add(r.requestId);
    await this.persistEnds();
  }

  /** Saves every end not yet on disk; then their events may go out. */
  private async persistEnds(): Promise<void> {
    const ids = [...this.unsaved];
    if (!ids.length) return;
    try {
      await this.o.store.save();
      for (const id of ids) this.unsaved.delete(id);
      this.saveFailed = false;
    } catch (err) {
      console.error(`state: ${err}`);
      this.saveFailed = true;
    }
    this.o.changed();
  }

  /**
   * One install: fetched and checked against `sha256`, unpacked into staging, its manifest checked,
   * a reinstall checked against what is installed, the account and the interpreter checked; then
   * moved into place and recorded in one save with its `installed`. Nothing stays of one that fails.
   */
  private async runInstall(r: InFlight): Promise<void> {
    if (r.ended || this.closed) return;
    const abort = new AbortController();
    this.aborts.set(r.requestId, abort);
    let staging: string | undefined;
    let outcome: Outcome | undefined;
    try {
      staging = await mkdtemp(join(this.dir, STAGING, "install-"));
      const archive = join(staging, "package.tar.gz");
      const tree = join(staging, "tree");
      await fetchPackage(r.package!.url, r.package!.sha256, archive, { allowHttp: this.o.allowHttp, signal: abort.signal });
      await mkdir(tree, { mode: 0o755 });
      const files = await unpack(archive, tree, { signal: abort.signal });
      const m = await this.manifest(tree, files);
      const had = this.state.installed[m.id]?.versions[m.version];
      if (had) this.reinstallable(had, r, m);
      const account = this.o.account(r.account!);
      if (!account) throw new Failure("unknown_account", `${r.account} is no account the computer's accounts lists`);
      const interpreter = await this.interpreter(m, account, tree);
      if (abort.signal.aborted || r.ended) return;
      this.committing.add(r.requestId);
      await this.commit(r, m, had, { sha256: r.package!.sha256.toLowerCase(), account: r.account!, interpreter, files }, tree, staging);
    } catch (err) {
      // Cut by the bridge's stop: left in flight for the next start. Cut by its 600 s: ended already.
      if (!this.closed && !r.ended) {
        outcome = err instanceof Failure || err instanceof PackageError
          ? this.failure(r, err.reason, err.message)
          : this.failure(r, "io_error", String((err as Error).message ?? err));
      }
    } finally {
      // Nothing of it stays before its end is told: ended() leaves out a job still running.
      if (staging) await rm(staging, { recursive: true, force: true }).catch((err) => console.error(`staging: ${err}`));
      this.aborts.delete(r.requestId);
      this.committing.delete(r.requestId);
    }
    if (outcome) await this.end(r, outcome);
    else if (r.ended) this.o.changed();
  }

  /** The package's manifest, from its root, checked (`invalid_manifest`). */
  private async manifest(tree: string, files: Record<string, string>): Promise<Manifest> {
    if (!Object.hasOwn(files, MANIFEST_FILE)) throw new Failure("invalid_manifest", `the package has no ${MANIFEST_FILE} at its root`);
    if ((await stat(join(tree, MANIFEST_FILE))).size > MANIFEST_MAX_BYTES) throw new Failure("invalid_manifest", `the manifest is over ${MANIFEST_MAX_BYTES} bytes`);
    const checked = checkManifest(await readFile(join(tree, MANIFEST_FILE)), new Set(Object.keys(files)));
    if (!checked.ok) throw new Failure("invalid_manifest", checked.problems.join("; "));
    return checked.manifest;
  }

  /** A reinstall is a repair only of the same package, manifest and account, never of a deleted account's version (GA-BRIDGE-57, GA-BRIDGE-67). */
  private reinstallable(had: InstalledVersion, r: InFlight, m: Manifest): void {
    const conflict = (why: string) => new Failure("version_conflict", `${m.id} ${m.version} is installed ${why}`);
    if (this.o.retired(had.account)) throw conflict(`for ${had.account}, whose account was deleted`);
    if (had.sha256 !== r.package!.sha256.toLowerCase()) throw conflict("from another package");
    if (had.account !== r.account) throw conflict(`for ${had.account}`);
    if (canonical(had.manifest) !== canonical(m)) throw conflict("with another manifest");
  }

  /**
   * The command's first element: a file of the package, which must be executable, or an interpreter
   * by name, resolved in the account's `PATH` as the OS would, to the first executable file of that
   * name. Refused (`invalid_manifest`) when the account can write that file, a directory on its path,
   * or any directory earlier in `PATH` where the name was looked for, or one above such a directory,
   * which would let it replace the directory (GA-BRIDGE-68).
   */
  private async interpreter(m: Manifest, account: OsAccount, tree: string): Promise<string | null> {
    const first = m.command[0]!;
    if (first.includes("/")) {
      if (!((await stat(join(tree, packagePath(first)!))).mode & 0o111)) throw new Failure("invalid_manifest", `${first} is not executable in the package`);
      return null;
    }
    const writable = async (p: string) => this.o.port.canWrite(account.osId, p);
    for (const dir of account.path) {
      if (!dir.startsWith("/")) throw new Failure("invalid_manifest", `${account.name}'s PATH holds ${JSON.stringify(dir)}, not an absolute directory, before ${first} is found`);
      for (const d of upwards(dir)) {
        if (await writable(d)) throw new Failure("invalid_manifest", `${account.name} can write ${d}, where ${first} is looked for`);
      }
      const candidate = posix.join(dir, first);
      const found = await this.o.port.exists(candidate);
      if (found.exists && (await writable(candidate))) throw new Failure("invalid_manifest", `${account.name} can write ${candidate}`);
      if (found.executable) return candidate;
    }
    throw new Failure("invalid_manifest", `${first} is not found in ${account.name}'s PATH`);
  }

  /** Moves the version into place and records it, with its `installed`, in one save; a save that fails undoes the move. */
  private async commit(r: InFlight, m: Manifest, had: InstalledVersion | undefined,
    got: Pick<InstalledVersion, "sha256" | "account" | "interpreter" | "files">, tree: string, staging: string): Promise<void> {
    const pluginDir = join(this.dir, m.id);
    const target = join(pluginDir, m.version);
    const old = join(staging, "old");
    await mkdir(pluginDir, { recursive: true, mode: 0o755 });
    await chmod(pluginDir, 0o755);
    // A repair replaces the files: the old ones leave with the staging directory, the server first
    // stopped, and started afresh by the next reconcile, a mismatch no longer kept (GA-BRIDGE-57).
    // Busy until the record is changed: no tick's reconcile makes a server of the old record meanwhile.
    this.busy.add(m.id);
    try {
      await this.place(r, m, had, got, tree, staging, pluginDir, target, old);
    } finally {
      this.busy.delete(m.id);
      this.reconcile();
    }
  }

  private async place(r: InFlight, m: Manifest, had: InstalledVersion | undefined,
    got: Pick<InstalledVersion, "sha256" | "account" | "interpreter" | "files">, tree: string, staging: string,
    pluginDir: string, target: string, old: string): Promise<void> {
    if (had) await this.dropServer(m.id, m.version, "reinstall");
    if (had) await rename(target, old).catch((err) => { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; });
    await rename(tree, target);
    await syncDir(pluginDir);
    const plugin = (this.state.installed[m.id] ??= { versions: {} });
    // A repair keeps its activation and install time, so its device ids and adoption stay (GA-BRIDGE-57).
    if (had) {
      const { mismatch: _, ...kept } = had;
      plugin.versions[m.version] = { ...kept, interpreter: got.interpreter, files: got.files };
    } else {
      plugin.versions[m.version] = { ...got, manifest: m, activated: false, installedAt: wireTime(this.o.clock.now()) };
    }
    r.ended = { type: "installed", manifest: m };
    try {
      await this.o.store.save();
    } catch (err) {
      delete r.ended;
      if (had) plugin.versions[m.version] = had;
      else delete plugin.versions[m.version];
      if (!Object.keys(plugin.versions).length) delete this.state.installed[m.id];
      await rename(target, tree);
      if (had) await rename(old, target).catch(() => {});
      throw new Failure("state_unsaved", `the record could not be written: ${(err as Error).message}`);
    }
  }

  /** An uninstall: every version's files, then the record, with its `uninstalled`; the devices' ids kept for their statuses to be cleared. */
  private async remove(r: InFlight): Promise<void> {
    if (r.ended || this.closed) return;
    const id = r.plugin!;
    // Busy until the record is changed: no tick's reconcile makes a server of it again meanwhile.
    this.busy.add(id);
    try {
      // Its servers first: nothing runs from files being removed.
      for (const version of Object.keys(this.state.installed[id]?.versions ?? {})) await this.dropServer(id, version, "uninstall");
      await rm(join(this.dir, id), { recursive: true, force: true });
      const p = this.state.installed[id];
      // Saved with its end: a restart before the clears still makes them (GA-BRIDGE-21).
      if (p) {
        const list = (this.state.clears ??= []);
        for (const d of deviceIdsOf(id, p)) if (!list.includes(d)) list.push(d);
      }
      delete this.state.installed[id];
    } finally {
      this.busy.delete(id);
      this.reconcile();
    }
    await this.end(r, { type: "uninstalled", plugin: id });
  }
}
