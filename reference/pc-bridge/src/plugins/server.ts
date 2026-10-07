import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OsAccount, OsPort, OsSession, ServerProcess } from "../port.js";
import type { SuspendClock } from "../suspend-clock.js";
import { type Manifest, packagePath } from "./manifest.js";
import { McpSession, type ToolOutcome } from "./mcp.js";
import type { InstalledVersion } from "./record.js";
import { capText, declaredKeys, type KeyType, toReadings } from "./state.js";

/** A server that has served answers each read and probe within this, or it is hung (GA-BRIDGE-58; ⚠️ a guess). */
export const ANSWER_MS = 10_000;
/** A server that has served is probed when no state read has passed within this (GA-BRIDGE-58; ⚠️ a guess). */
export const PROBE_EVERY_MS = 10_000;
/** A started server that has not served within this failed its start (GA-BRIDGE-58; ⚠️ a guess). */
export const START_MS = 120_000;
/** A read that fails is tried again within this, whatever the device's cadence (GA-BRIDGE-60; ⚠️ a guess). */
export const READ_RETRY_MS = 10_000;
/** The wait before a start again, from 1 s doubling to 60 s: at 60 s within 180 s, never over 300 s (GA-BRIDGE-58). */
export const BACKOFF_MS = 1_000;
export const BACKOFF_CEILING_MS = 60_000;
/** Starts failed in a row before `crash_loop` (GA-BRIDGE-58; ⚠️ a guess). */
export const CRASH_LOOP_STARTS = 5;
/** The only display variables a `needsSession` server is given, whatever the port reads. */
export const DISPLAY_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
/** Every server's locale: the port reads none. */
export const SERVER_LANG = "C.UTF-8";
/** The variable naming the plugin's own directory. */
export const PLUGIN_DIR_VAR = "GALATEA_PLUGIN_DIR";

/**
 * Where one server is: not started; waiting for a graphical session; started and not yet served;
 * served; waiting to start again after a failure; stopped for a mismatch of files or tools, never
 * started again (GA-BRIDGE-45); stopped by the bridge.
 */
export type Phase = "idle" | "waiting" | "starting" | "served" | "backoff" | "mismatch" | "stopped";

/**
 * What a device of the server reads now: `available: true` with its readings (or none yet) and the
 * time of the observation they rest on, `checkIn`, the time of the device's own last successful
 * read (null before its first: its server's having served is no check-in of it, GA-BRIDGE-37), and
 * `seq`, counting the reads a command asked for, each of which goes out even when nothing changed
 * (GA-BRIDGE-34); `available: false` since `at`; or undefined while nothing about it is to be
 * published (starting, stopped by the bridge).
 */
export type DeviceView =
  | { available: true; at: number; checkIn: number | null; values: Record<string, string | number | boolean>; seq: number }
  | { available: false; at: number }
  | undefined;

export interface Fault {
  code: string;
  device: string;
  detail: string;
}

/** Why the bridge stops a server: its own leave, the version no longer activated, its account deleted, a swap, or its session ended. */
export type StopReason = "bridge" | "deactivated" | "account_deleted" | "swap" | "uninstall" | "reinstall";

export interface PluginServerOptions {
  port: OsPort;
  /** The core's suspend-aware clock, for every time of the server's (GA-BRIDGE-58). */
  clock: SuspendClock;
  /** Wall time, for the readings' and statuses' stamps. */
  wall: () => number;
  plugin: string;
  version: string;
  /** The version's directory. */
  dir: string;
  installed: InstalledVersion;
  /** Each device's id. */
  deviceId(key: string): string;
  /** The account the version runs as, as the last observation listed it. */
  account(): OsAccount | undefined;
  /** The sessions of the last observation. */
  sessions(): OsSession[];
  /** A device's view or a fault changed: the bridge publishes what changed. */
  changed(): void;
  /** This start served: the swap may go on. */
  served(): void;
  /** A mismatch of files or tools, kept with the version until a reinstall that verifies or a new version (GA-BRIDGE-45). */
  mismatched(detail: string, at: number): void;
  /** The era the server spoke, when it differs from the one kept with the version. */
  eraFound(era: string): void;
}

interface Device {
  key: string;
  uri: string;
  cadenceMs: number;
  keys: Map<string, KeyType>;
  values?: Record<string, string | number | boolean>;
  /** Wall time of its last successful read. */
  at: number | null;
  dropped: string[];
  reading: boolean;
  again: boolean;
  /** A command asked for this read: it goes out whatever it found. */
  force: boolean;
  seq: number;
  timer: number | null;
}

/**
 * The console session of the account if it has one, else its graphical session the OS started
 * first, a tie going to the lower id, as numbers where both read as integers, else in byte order
 * (GA-BRIDGE-42; the port marks the console session `seat0Active`). An SSH login is none.
 */
export function chosenSession(sessions: OsSession[], osId: number): OsSession | undefined {
  const mine = sessions.filter((s) => s.osId === osId && s.graphical);
  const console = mine.find((s) => s.seat0Active);
  if (console) return console;
  const byId = (a: string, b: string) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
  return mine.sort((a, b) => a.startedAt - b.startedAt || byId(a.id, b.id))[0];
}

/** The installed files against the hashes kept at install: null when they agree, else what differs (GA-BRIDGE-43). */
export async function verifyFiles(dir: string, files: Record<string, string>): Promise<string | null> {
  const found = new Map<string, string>();
  const problems: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) {
      const p = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(dir, p));
      if (st.isDirectory()) await walk(p);
      else if (st.isFile()) found.set(p, await sha256File(join(dir, p)));
      else problems.push(`${p} is not a file`);
    }
  };
  try {
    await walk("");
  } catch (err) {
    return `the files cannot be read: ${(err as Error).message}`;
  }
  for (const [p, h] of Object.entries(files)) {
    if (!found.has(p)) problems.push(`${p} is missing`);
    else if (found.get(p) !== h) problems.push(`${p} changed`);
  }
  for (const p of found.keys()) if (!Object.hasOwn(files, p)) problems.push(`${p} is not in the package`);
  return problems.length ? problems.slice(0, 5).join("; ") + (problems.length > 5 ? `; ${problems.length - 5} more` : "") : null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/**
 * The command as the server is started by it: the interpreter's absolute path from the record, or
 * the package's own command, then the rest, each element that is a file of the package as an
 * absolute path (GA-BRIDGE-68: never by name).
 */
export function serverArgv(m: Manifest, v: InstalledVersion, dir: string): string[] {
  const [first, ...rest] = m.command;
  const abs = (el: string) => {
    const p = packagePath(el);
    return p !== null && Object.hasOwn(v.files, p) ? join(dir, p) : el;
  };
  return [v.interpreter ?? join(dir, packagePath(first!)!), ...rest.map(abs)];
}

/**
 * The environment built from nothing (GA-BRIDGE-48): `HOME`, the account's `PATH`, `LANG`, the
 * plugin's directory, and for a `needsSession` server its session's display variables, of the
 * names DISPLAY_VARS lists only. Never a credential or a token.
 */
export function serverEnv(account: OsAccount, dir: string, display: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HOME: account.home, PATH: account.path.join(":"), LANG: SERVER_LANG, [PLUGIN_DIR_VAR]: dir };
  for (const k of DISPLAY_VARS) if (typeof display[k] === "string") env[k] = display[k];
  return env;
}

const message = (err: unknown) => String((err as Error)?.message ?? err);

/**
 * One activated version's server (*A server that stops*, GA-BRIDGE-43 to 45, 49, 58, 60): verified
 * and started, in the chosen graphical session for `needsSession`; served at its first successful
 * state read; read at once, then at each device's cadence and on each change it announces, a read
 * that fails tried again within 10 s; probed when no read passed for 10 s; failed when it exits,
 * closes its output (a flood included), answers neither a read nor a probe within 10 s once served,
 * or has not served within 120 s of its start; started again after a backoff of 1 s doubling to
 * 60 s, reset once a start served; `crash_loop` after 5 failed starts in a row, cleared once a start
 * served; stopped for good on a mismatch. Every time is on the suspend-aware clock.
 *
 * Each start is a generation: whatever an earlier start's process or connection does after the
 * next began is ignored.
 */
export class PluginServer {
  phase: Phase = "idle";
  private gen = 0;
  private readonly devices = new Map<string, Device>();
  private readonly timers = new Set<number>();
  private abort?: AbortController;
  private proc?: ServerProcess;
  private mcp?: McpSession;
  /** Every process started and not yet stopped, one that exited on its own included: its group may live on, and a stop ends it. */
  private readonly live = new Set<ServerProcess>();
  /** The session the server runs in, for `needsSession`. */
  private session: string | null = null;
  private failures = 0;
  private backoffMs = BACKOFF_MS;
  private crashLoop = false;
  private mismatch?: string;
  /** Wall time since the devices cannot be served, and why; null while they can or have not been told otherwise. */
  private downSince: number | null = null;
  private downWhy?: string;
  /** When the current start served, on the wall clock. */
  private servedAt: number | null = null;
  /** When the last read or probe was sent, on the suspend-aware clock: the next probe is due 10 s after it. */
  private lastRequest = 0;
  private probing = false;
  /** An attempt is under way, from before its wait for the old process: `start` makes no second one. */
  private attempting = false;
  /** The attempts not yet ended: a stop waits for them, so no process it started outlives the stop. */
  private readonly attempts = new Set<Promise<void>>();

  constructor(private readonly o: PluginServerOptions, mismatch?: { detail: string; at: number }) {
    const m = o.installed.manifest;
    for (const d of m.devices) {
      this.devices.set(d.key, { key: d.key, uri: d.stateUri, cadenceMs: d.cadenceMs, keys: declaredKeys(m, d), at: null, dropped: [], reading: false, again: false, force: false, seq: 0, timer: null });
    }
    if (mismatch !== undefined) {
      this.phase = "mismatch";
      this.mismatch = mismatch.detail;
      this.downSince = mismatch.at;
      this.downWhy = mismatch.detail;
    }
  }

  private get needsSession(): boolean {
    return this.o.installed.manifest.needsSession === true;
  }

  /** Starts it, unless it runs, waits, is being started, or was stopped for a mismatch. */
  start(): void {
    if ((this.phase === "idle" || this.phase === "stopped") && !this.attempting) void this.attempt();
  }

  /** The record it was made from: the host makes another once a reinstall replaces it. */
  get installed(): InstalledVersion {
    return this.o.installed;
  }

  /** Whether it has served since its start: a command may call a tool. */
  get serving(): boolean {
    return this.phase === "served";
  }

  /** The connection a command's tool is called on, while serving. */
  get connection(): McpSession | undefined {
    return this.phase === "served" ? this.mcp : undefined;
  }

  /** A device's view now (see DeviceView). */
  view(key: string): DeviceView {
    const d = this.devices.get(key);
    if (!d) return undefined;
    if (this.phase === "served") return { available: true, at: d.at ?? this.servedAt!, checkIn: d.at, values: d.values ?? {}, seq: d.seq };
    if (this.downSince !== null) return { available: false, at: this.downSince };
    return undefined;
  }

  /** Why its devices cannot be served now, for a command's `unreachable`; capped, since the server's own text may be in it. */
  get why(): string {
    if (this.phase === "starting") return "its server is still starting";
    if (this.phase === "waiting") return "its account has no graphical session";
    return capText(this.downWhy ?? `its server is ${this.phase}`);
  }

  /** `pin_mismatch`, `crash_loop` and `reading_dropped`, one per device each. */
  faults(): Fault[] {
    const out: Fault[] = [];
    for (const d of this.devices.values()) {
      const device = this.o.deviceId(d.key);
      if (this.mismatch !== undefined) out.push({ code: "pin_mismatch", device, detail: capText(this.mismatch) });
      if (this.crashLoop) out.push({ code: "crash_loop", device, detail: capText(`its last ${this.failures} starts failed: ${this.downWhy ?? ""}`) });
      if (d.dropped.length && this.phase === "served") out.push({ code: "reading_dropped", device, detail: capText(d.dropped.join("; ")) });
    }
    return out;
  }

  /** The OS's sessions changed: a waiting server starts in a new graphical session; one whose session ended stops, and starts in the next. */
  sessionsChanged(): void {
    if (!this.needsSession) return;
    if (this.phase === "waiting") {
      void this.attempt();
      return;
    }
    if ((this.phase === "starting" || this.phase === "served") && this.session !== null
      && !this.o.sessions().some((s) => s.id === this.session && s.graphical)) {
      // It ends with its session, at a logout, and starts again in the next one; not a failure.
      this.phase = "stopped";
      this.down("its session ended");
      this.o.changed();
      void this.attempt();
    }
  }

  /** After a resume, a server that slept with the OS is read within 10 s, again every 10 s until a read succeeds (GA-BRIDGE-60). */
  resumed(): void {
    if (this.phase !== "served") return;
    for (const d of this.devices.values()) void this.read(this.gen, d);
  }

  /**
   * Calls a command's tool (GA-BRIDGE-46), then reads the device at once, within 1 s of the
   * tool's result (GA-BRIDGE-51). A server that has not served is `unreachable`, nothing called
   * (GA-BRIDGE-60). A tool call has no ANSWER_MS: a launch may take its while, and the command's
   * own time, `signal`, bounds it.
   */
  async call(key: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome | { kind: "unreachable"; text: string }> {
    const mcp = this.connection;
    if (!mcp) return { kind: "unreachable", text: this.why };
    const r = await mcp.callTool(tool, args, signal);
    // After a tool call succeeds (GA-BRIDGE-51); any other outcome waits for the read-back (GA-BRIDGE-34).
    if (r.kind === "ok") this.readNow(key);
    return r;
  }

  /** Reads a device's state at once (a command's early read, or its read-back). */
  readNow(key: string): void {
    const d = this.devices.get(key);
    if (!d || this.phase !== "served") return;
    d.force = true;
    void this.read(this.gen, d);
  }

  /**
   * Stops it for good, or until `start` (`bridge`: its devices keep what they showed; any other
   * reason shows them unavailable). Resolves once every process of it has exited, one an attempt
   * under way was still starting included.
   */
  async stop(reason: StopReason): Promise<void> {
    const under = [...this.attempts];
    // Unavailable at once, not once the process has gone: `end` moves to the next generation before its first wait.
    const ending = this.end();
    // A mismatch stays one: it never starts again (GA-BRIDGE-45).
    if (this.phase !== "mismatch") this.phase = "stopped";
    if (reason !== "bridge" && this.downSince === null) {
      this.downSince = this.o.wall();
      this.downWhy = reason === "account_deleted" ? "its account was deleted" : `its server was stopped (${reason})`;
    }
    this.o.changed();
    await ending;
    await Promise.all(under);
  }

  /** Ends the current start: its timers, its requests, its connection and its process, waiting for every process to exit. */
  private async end(): Promise<void> {
    this.gen += 1;
    for (const h of this.timers) this.o.clock.clear(h);
    this.timers.clear();
    for (const d of this.devices.values()) d.timer = null;
    this.abort?.abort(new Error("the server is stopping"));
    const mcp = this.mcp;
    this.mcp = undefined;
    this.proc = undefined;
    await mcp?.close().catch(() => {});
    // Each process stopped, one that crashed too: `stop` ends what it started, a player left running (the port's contract).
    await Promise.all([...this.live].map((p) => p.stop().catch(() => {}).then(() => { this.live.delete(p); })));
  }

  private after(gen: number, ms: number, fn: () => void): number {
    const h = this.o.clock.setTimeout(() => {
      this.timers.delete(h);
      if (gen === this.gen) fn();
    }, ms);
    this.timers.add(h);
    return h;
  }

  /** One start, kept among the attempts under way until it ends. */
  private attempt(): Promise<void> {
    const run = this.attemptNow();
    this.attempts.add(run);
    void run.finally(() => this.attempts.delete(run));
    return run;
  }

  /**
   * One start: the old process ended, then the session, the files, the process, the connection, the
   * tools, and the first reads, the subscription beside them. Its generation is taken before the wait
   * for the old process, so a stop or another start meanwhile ends it; and `start` makes no second
   * attempt while it waits.
   */
  private async attemptNow(): Promise<void> {
    if (this.attempting) return;
    this.attempting = true;
    const ending = this.end();
    const gen = this.gen;
    try {
      await ending;
    } finally {
      this.attempting = false;
    }
    if (gen !== this.gen) return;
    const m = this.o.installed.manifest;
    const account = this.o.account();
    const session = this.needsSession && account ? chosenSession(this.o.sessions(), account.osId) : undefined;
    if (this.needsSession && account && !session) {
      // No graphical session: its devices are unavailable until one starts (GA-BRIDGE-49).
      this.phase = "waiting";
      this.down("its account has no graphical session");
      this.o.changed();
      return;
    }
    this.phase = "starting";
    this.session = session?.id ?? null;
    const abort = new AbortController();
    this.abort = abort;
    this.after(gen, START_MS, () => void this.failed(gen, `it did not serve within ${START_MS} ms of its start`));
    try {
      const bad = await verifyFiles(this.o.dir, this.o.installed.files);
      if (gen !== this.gen) return;
      if (bad !== null) return void this.mismatched(gen, `its files do not verify: ${bad}`);
      if (!account) throw new Error("its account is not listed now");
      const display = session ? await this.o.port.displayEnv(session.id) : {};
      if (gen !== this.gen) return;
      const proc = await this.o.port.startServer({
        plugin: this.o.plugin, version: this.o.version, osId: account.osId, session: this.session,
        argv: serverArgv(m, this.o.installed, this.o.dir), env: serverEnv(account, this.o.dir, display), cwd: this.o.dir, noNewPrivs: true,
      });
      this.live.add(proc);
      void proc.exited.then((e) => {
        void this.failed(gen, `its server exited (${e.code !== null ? `code ${e.code}` : e.signal})`);
      });
      if (gen !== this.gen) {
        await proc.stop();
        return;
      }
      this.proc = proc;
      const mcp = await McpSession.connect(proc, {
        ...(this.o.installed.era !== undefined ? { era: this.o.installed.era } : {}),
        onToolsChanged: () => void this.toolsChanged(gen),
        onResourceUpdated: (uri) => {
          if (gen !== this.gen || this.phase !== "served") return;
          for (const d of this.devices.values()) if (d.uri === uri) void this.read(gen, d);
        },
        onInputRequest: () => {},
        onClosed: (why) => void this.failed(gen, `its connection closed: ${why}`),
      }, abort.signal);
      if (gen !== this.gen) {
        await mcp.close();
        return;
      }
      this.mcp = mcp;
      // It has started: its state is read now (GA-BRIDGE-60).
      if (/^\d{4}-\d{2}-\d{2}$/.test(mcp.era) && mcp.era !== this.o.installed.era) this.o.eraFound(mcp.era);
      const mismatch = await mcp.checkTools(m.toolHashes, abort.signal);
      if (gen !== this.gen) return;
      if (mismatch !== null) return void this.mismatched(gen, `its tools do not verify: ${mismatch}`);
      // The reads first, the subscription beside them: a server slow to acknowledge it, or one that
      // never does, delays no first read (GA-BRIDGE-60); the cadence read is the floor either way.
      for (const d of this.devices.values()) void this.read(gen, d);
      void mcp.subscribe([...new Set([...this.devices.values()].map((d) => d.uri))], abort.signal).catch((err) => {
        if (gen === this.gen) this.log(`no subscription: ${message(err)}`);
      });
    } catch (err) {
      void this.failed(gen, message(err));
    }
  }

  /**
   * One read of a device's state: a success is its check-in, the server's first one of this start
   * its having served; a failure is tried again within READ_RETRY_MS. Once served, a read not answered
   * within ANSWER_MS is a hung server.
   */
  private async read(gen: number, d: Device): Promise<void> {
    const mcp = this.mcp;
    if (gen !== this.gen || !mcp) return;
    if (d.reading) {
      d.again = true;
      return;
    }
    d.reading = true;
    if (d.timer !== null) {
      this.o.clock.clear(d.timer);
      this.timers.delete(d.timer);
      d.timer = null;
    }
    let ok = false;
    try {
      this.lastRequest = this.o.clock.now();
      const text = await this.answered(gen, mcp.read(d.uri, this.abort!.signal));
      if (gen !== this.gen) return;
      const r = toReadings(text, d.keys);
      if (!r.ok) throw new Error(r.why);
      d.values = r.values;
      d.dropped = r.dropped;
      if (d.force) d.seq += 1;
      d.force = false;
      d.at = this.o.wall();
      ok = true;
      if (this.phase === "starting") this.hasServed(gen);
      else this.o.changed();
    } catch (err) {
      if (gen === this.gen) this.log(`${d.key}: read failed: ${message(err)}`);
    } finally {
      d.reading = false;
    }
    if (gen !== this.gen) return;
    if (d.again) {
      d.again = false;
      void this.read(gen, d);
      return;
    }
    d.timer = this.after(gen, ok ? d.cadenceMs : Math.min(d.cadenceMs, READ_RETRY_MS), () => {
      d.timer = null;
      void this.read(gen, d);
    });
  }

  /** A request to a served server: not answered within ANSWER_MS, the server is hung and fails (GA-BRIDGE-58). */
  private answered<T>(gen: number, p: Promise<T>): Promise<T> {
    if (this.phase !== "served") return p;
    const h = this.after(gen, ANSWER_MS, () => void this.failed(gen, `it answered nothing within ${ANSWER_MS} ms`));
    const done = () => {
      this.o.clock.clear(h);
      this.timers.delete(h);
    };
    p.then(done, done);
    return p;
  }

  private hasServed(gen: number): void {
    this.phase = "served";
    this.servedAt = this.o.wall();
    this.failures = 0;
    this.backoffMs = BACKOFF_MS;
    this.crashLoop = false;
    this.downSince = null;
    this.downWhy = undefined;
    // The start bound's timer, and any other of the start's, give way to the served server's.
    for (const h of [...this.timers]) {
      if ([...this.devices.values()].some((d) => d.timer === h)) continue;
      this.o.clock.clear(h);
      this.timers.delete(h);
    }
    this.probeLater(gen);
    this.o.changed();
    this.o.served();
  }

  /**
   * The next probe, due PROBE_EVERY_MS after the last request of any kind, a read or a probe, so
   * that no 10 s passes without one (GA-BRIDGE-58); one still in flight puts it off by PROBE_EVERY_MS.
   */
  private probeLater(gen: number): void {
    const due = this.probing ? PROBE_EVERY_MS : Math.max(0, this.lastRequest + PROBE_EVERY_MS - this.o.clock.now());
    this.after(gen, due, () => {
      if (!this.probing && this.o.clock.now() - this.lastRequest >= PROBE_EVERY_MS) {
        void this.probe(gen);
        // A probe that could not go counts as one, so the next is not due at once again.
        if (!this.probing) this.lastRequest = this.o.clock.now();
      }
      this.probeLater(gen);
    });
  }

  private async probe(gen: number): Promise<void> {
    const mcp = this.mcp;
    if (gen !== this.gen || !mcp || this.probing) return;
    this.probing = true;
    this.lastRequest = this.o.clock.now();
    try {
      await this.answered(gen, mcp.probe(this.abort!.signal));
    } catch (err) {
      // An error is an answer too: the server is there.
      if (gen === this.gen) this.log(`probe: ${message(err)}`);
    } finally {
      this.probing = false;
    }
  }

  private async toolsChanged(gen: number): Promise<void> {
    const mcp = this.mcp;
    if (gen !== this.gen || !mcp) return;
    let mismatch: string | null;
    try {
      mismatch = await mcp.checkTools(this.o.installed.manifest.toolHashes, this.abort!.signal);
    } catch (err) {
      mismatch = `its tools cannot be listed: ${message(err)}`;
    }
    if (gen === this.gen && mismatch !== null) await this.mismatched(gen, `its tools do not verify: ${mismatch}`);
  }

  private down(why: string): void {
    if (this.downSince === null) this.downSince = this.o.wall();
    this.downWhy = capText(why);
  }

  /** A line of the log, the server's own text in it capped as the whole line is. */
  private log(text: string): void {
    console.error(capText(`${this.o.plugin} ${this.o.version}: ${text}`));
  }

  /** A mismatch: stopped, its devices unavailable at once, never started again (GA-BRIDGE-45). */
  private async mismatched(gen: number, detail: string): Promise<void> {
    if (gen !== this.gen) return;
    this.phase = "mismatch";
    this.mismatch = capText(detail);
    this.down(detail);
    this.o.mismatched(this.mismatch, this.downSince!);
    this.o.changed();
    await this.end();
    this.phase = "mismatch";
  }

  /**
   * A start that failed, or a served server that stopped serving: its devices unavailable at once,
   * the process stopped, and a start again after the backoff; a failed start counts towards
   * `crash_loop`, a served one's failure does not.
   */
  private async failed(gen: number, why: string): Promise<void> {
    if (gen !== this.gen || (this.phase !== "starting" && this.phase !== "served")) return;
    const wasServed = this.phase === "served";
    this.phase = "backoff";
    this.down(why);
    this.log(why);
    if (!wasServed) {
      this.failures += 1;
      if (this.failures >= CRASH_LOOP_STARTS) this.crashLoop = true;
    }
    this.o.changed();
    // The backoff runs from the failure, not from the process's exit: `end` moves to the next generation at once.
    const ending = this.end();
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_CEILING_MS);
    this.after(this.gen, wait, () => void ending.then(() => this.attempt()));
    await ending;
  }
}
