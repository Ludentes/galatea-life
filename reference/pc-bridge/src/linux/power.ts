import { spawn } from "node:child_process";
import type { PowerEvent } from "../port.js";
import { readText } from "./etc.js";
import { COMMAND_ENV, type Runner } from "./run.js";

/**
 * `systemd-inhibit`'s arguments for the bridge's delay lock (GA-BRIDGE-22): sleep and shutdown,
 * `delay` mode, held for as long as its child runs. The child is `cat` reading a pipe from the
 * bridge, so the lock also ends when the bridge's process does, however it ends.
 */
export const INHIBIT_ARGS: readonly string[] = [
  "--what=sleep:shutdown", "--mode=delay", "--who=galatea-pc-bridge", "--why=The PC bridge acknowledges and goes offline first", "cat",
];

/** A running `systemd-inhibit`: settles once it has exited (`missing` when it is not installed); `release` ends it. */
export interface InhibitorChild {
  exited: Promise<{ missing: boolean }>;
  release(): void;
}

export type SpawnInhibitor = () => InhibitorChild;

/** The real one: `systemd-inhibit … cat`, `cat` reading the bridge's pipe. */
export const spawnInhibitor: SpawnInhibitor = () => {
  const child = spawn("systemd-inhibit", [...INHIBIT_ARGS], { env: { ...COMMAND_ENV }, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin!.on("error", () => {});
  const exited = new Promise<{ missing: boolean }>((resolve) => {
    child.once("error", (e: NodeJS.ErrnoException) => resolve({ missing: e.code === "ENOENT" }));
    child.once("exit", () => resolve({ missing: false }));
  });
  return {
    exited,
    release() {
      child.stdin!.end();
      child.kill("SIGTERM");
    },
  };
};

/** How soon a lock that ended on its own (its process killed) is taken again. */
export const INHIBIT_RETRY_MS = 1_000;

/**
 * The delay lock, held at all times by a child process (*The OS port*): `release` ends it once
 * the bridge's part of a suspend or shutdown is done; `take` holds it again, at resume. One that
 * ends on its own is taken again after a second; `systemd-inhibit` not installed is said once, and
 * the bridge then runs without the lock (a suspend is not held).
 */
export class Inhibitor {
  private child?: InhibitorChild;
  private wanted = false;
  private closed = false;
  private missing = false;
  private retry?: NodeJS.Timeout;

  constructor(private readonly o: { spawn?: SpawnInhibitor; retryMs?: number; log?: (line: string) => void } = {}) {}

  held(): boolean {
    return this.child !== undefined;
  }

  take(): void {
    this.wanted = true;
    if (this.child || this.closed || this.missing) return;
    const child = (this.o.spawn ?? spawnInhibitor)();
    this.child = child;
    void child.exited.then(({ missing }) => {
      if (this.child === child) this.child = undefined;
      if (missing) {
        this.missing = true;
        (this.o.log ?? console.error)("systemd-inhibit is not installed: suspends and shutdowns are not held");
        return;
      }
      if (this.wanted && !this.closed && !this.retry) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (this.wanted) this.take();
        }, this.o.retryMs ?? INHIBIT_RETRY_MS);
      }
    });
  }

  release(): void {
    this.wanted = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const child = this.child;
    this.child = undefined;
    child?.release();
  }

  close(): void {
    this.closed = true;
    this.release();
  }
}

/** `/proc/uptime`'s first field in ms: the time since boot, suspend included (CLOCK_BOOTTIME). */
export async function readUptimeMs(root: string): Promise<number> {
  const first = (await readText(root, "/proc/uptime")).trim().split(/\s+/)[0] ?? "";
  if (!/^\d+(\.\d+)?$/.test(first)) throw new Error(`/proc/uptime reads "${first}"`);
  return Math.round(Number(first) * 1000);
}

/** Node's monotonic clock in ms, which stops while the machine sleeps (CLOCK_MONOTONIC). */
export const monoMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/**
 * The time asleep (*The OS port*): the growth of `/proc/uptime`, which counts a suspend, less that
 * of Node's monotonic clock, which does not, between two samples. Sampled every second, so that a
 * suspend nobody announced is measured too.
 */
export class SleepMeter {
  private last?: { up: number; mono: number };

  constructor(private readonly read: { uptimeMs(): Promise<number>; monoMs(): number }) {}

  /** The time asleep since the last sample (0 at the first), never below 0; a failed read of uptime throws, the last sample kept. */
  async gap(): Promise<number> {
    const up = await this.read.uptimeMs();
    const mono = this.read.monoMs();
    const last = this.last;
    this.last = { up, mono };
    if (!last) return 0;
    return Math.max(0, up - last.up - (mono - last.mono));
  }
}

/** A gap this long between two samples with no suspend announced is a suspend nobody announced. */
export const UNANNOUNCED_MS = 1_000;
/**
 * How long the machine may stay awake after a suspend or shutdown was announced before the
 * announcement is taken as over with no word from logind (its `PrepareForSleep(false)` lost with
 * the bus): the lock is taken again and a resume reported (review M11). logind's own delay is 5 s.
 */
export const ANNOUNCED_MAX_MS = 60_000;

/**
 * logind's power announcements and the sampler, one at a time:
 * - `PrepareForSleep(true)` and `PrepareForShutdown(true)`: the core's handler runs, and only once
 *   it has settled is the delay lock released, so the ack and the graceful `offline` are out first;
 * - `PrepareForSleep(false)`: the lock taken again, then a resume with the time asleep since the
 *   announcement;
 * - `PrepareForShutdown(false)`, a shutdown called off: the lock taken again, and a resume with
 *   nothing asleep, so the bridge comes back;
 * - each second, a sample: a gap of a second or more with no suspend announced is reported as a
 *   resume from a suspend nobody announced (the bridge could not go offline before it).
 * The core's handler for a resume is not waited for (it may reconnect for long); for a suspend or
 * shutdown it is, which is what holds the OS. An announcement logind never ends (its resume lost
 * with the bus) ends after `ANNOUNCED_MAX_MS` awake, or at once when the bus comes back
 * (`recover`), so the lock is never left released for good (review M11). At the bound logind is
 * asked first (`preparing`): while it says it is still preparing (a shutdown's long stop phase,
 * a suspend another delay lock holds), the announcement stands (review N4), and so at `recover`;
 * the pure bound is kept for when it cannot be asked.
 */
export class PowerWatch {
  private queue: Promise<void> = Promise.resolve();
  private busy = 0;
  private announced: "sleep" | "shutdown" | null = null;
  private asleep = 0;
  /** The monotonic time (which a suspend does not advance) of the last announcement. */
  private announcedAt = 0;
  /** Whether this announcement's wait on logind was logged. */
  private waitLogged = false;

  constructor(private readonly o: {
    inhibitor: Inhibitor;
    meter: SleepMeter;
    handler: () => ((e: PowerEvent) => Promise<void>) | undefined;
    mono?: () => number;
    log?: (line: string) => void;
    /** Whether logind is still preparing for a sleep or a shutdown; undefined (or a throw) when it cannot be asked. */
    preparing?: () => Promise<boolean | undefined>;
  }) {}

  private mono(): number {
    return (this.o.mono ?? monoMs)();
  }

  /** Ends an open announcement as its resume would: the lock taken again, a resume with the time asleep measured so far. */
  private end(): void {
    const asleep = this.announced === "sleep" ? this.asleep : 0;
    this.announced = null;
    this.asleep = 0;
    this.o.inhibitor.take();
    void this.emit({ kind: "resume", asleepMs: asleep });
  }

  /**
   * The bus is back, and logind's word in the meantime may be lost: an announcement still open ends
   * here, unless logind says it is still preparing (a long shutdown), when it and the lock stay as they are.
   */
  recover(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.announced) return;
      this.asleep += await this.gap();
      if (await this.waiting()) return;
      (this.o.log ?? console.error)(`power: the bus came back with a ${this.announced} still announced; taken as over`);
      this.end();
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.busy++;
    const next = this.queue.then(work).catch((err) => (this.o.log ?? console.error)(`power: ${err}`)).finally(() => {
      this.busy--;
    });
    this.queue = next;
    return next;
  }

  private emit(e: PowerEvent): Promise<void> {
    const h = this.o.handler();
    return h ? h(e).catch((err) => (this.o.log ?? console.error)(`power handler: ${err}`)) : Promise.resolve();
  }

  /** A sample's gap; a failed read of `/proc/uptime` counts as none (logged), never an exit. */
  private async gap(): Promise<number> {
    try {
      return await this.o.meter.gap();
    } catch (err) {
      (this.o.log ?? console.error)(`time asleep: ${err}`);
      return 0;
    }
  }

  announce(kind: "sleep" | "shutdown", start: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (start) {
        // Awake until now: whatever this sample finds is not part of the coming sleep.
        await this.gap();
        this.announced = kind;
        this.asleep = 0;
        this.announcedAt = this.mono();
        this.waitLogged = false;
        await this.emit({ kind: kind === "sleep" ? "suspend" : "shutdown", announced: true });
        this.o.inhibitor.release();
        return;
      }
      const asleep = kind === "sleep" ? this.asleep + (await this.gap()) : 0;
      if (kind === "shutdown") await this.gap();
      this.announced = null;
      this.asleep = 0;
      this.o.inhibitor.take();
      void this.emit({ kind: "resume", asleepMs: asleep });
    });
  }

  /** Whether to keep the open announcement: logind still preparing for it, said once per announcement. */
  private async waiting(): Promise<boolean> {
    if (!(await this.stillPreparing())) return false;
    if (!this.waitLogged) (this.o.log ?? console.error)(`power: no resume from logind after a ${this.announced}, but it is still preparing for one; waiting`);
    this.waitLogged = true;
    return true;
  }

  /** logind's word on whether it is still preparing; one it cannot give is "no", and the announcement ends. */
  private async stillPreparing(): Promise<boolean> {
    try {
      return (await this.o.preparing?.()) === true;
    } catch (err) {
      (this.o.log ?? console.error)(`power: asking logind whether it is still preparing: ${err}`);
      return false;
    }
  }

  /** One sample, skipped while an announcement is being handled. */
  tick(): Promise<void> {
    if (this.busy) return Promise.resolve();
    return this.enqueue(async () => {
      const g = await this.gap();
      if (this.announced) {
        this.asleep += g;
        if (this.mono() - this.announcedAt >= ANNOUNCED_MAX_MS) {
          if (await this.waiting()) return;
          (this.o.log ?? console.error)(`power: no resume from logind ${ANNOUNCED_MAX_MS / 1000} s awake after a ${this.announced} was announced; taken as over`);
          this.end();
        }
        return;
      }
      if (g >= UNANNOUNCED_MS) void this.emit({ kind: "resume", asleepMs: g });
    });
  }
}

/** `shutdown`'s arguments: `+N` with the delay rounded up to whole minutes, so the warning is never shorter than asked; `now` without one. */
export function shutdownArgs(delayS?: number): string[] {
  return delayS === undefined || delayS <= 0 ? ["now"] : [`+${Math.ceil(delayS / 60)}`];
}

/** Runs `shutdown` with these arguments; resolves once it accepted them (exit 0), else throws its own words. */
export async function runShutdown(run: Runner, args: string[]): Promise<void> {
  const r = await run("shutdown", args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `shutdown ${args.join(" ")} exited ${r.code}`);
}

/** How long a clock step may take (GA-BRIDGE-59). */
export const STEP_MS = 10_000;
/** How often timesyncd is asked whether it has synchronised since its restart. */
const STEP_POLL_MS = 500;

/**
 * Has the OS step its clock to its time source, within 10 s: `chronyc makestep` where chrony runs
 * ("200 OK"); else, where NTP is on (`timedatectl show -p NTP --value` is `yes`), systemd-timesyncd
 * restarted, which steps a clock that is far off at its first answer, and taken as stepped once
 * `timedatectl show-timesync -p NTPMessage` shows a message other than the one before the restart.
 * Resolves whether it did; never throws.
 */
export async function stepClock(run: Runner, o: { mono?: () => number; delay?: (ms: number) => Promise<void>; boundMs?: number } = {}): Promise<boolean> {
  // Measured on the monotonic clock: the wall clock is the one being stepped (review M1).
  const now = o.mono ?? (() => performance.now());
  const delay = o.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (o.boundMs ?? STEP_MS);
  const left = () => Math.max(1, deadline - now());
  const tryRun = async (file: string, args: string[]) => {
    try {
      return await run(file, args, { timeoutMs: left() });
    } catch {
      return undefined;
    }
  };
  const chrony = await tryRun("chronyc", ["makestep"]);
  if (chrony?.code === 0 && /200 OK/.test(chrony.stdout)) return true;
  const ntp = await tryRun("timedatectl", ["show", "-p", "NTP", "--value"]);
  if (ntp?.code !== 0 || ntp.stdout.trim() !== "yes") return false;
  const message = async () => {
    const r = await tryRun("timedatectl", ["show-timesync", "-p", "NTPMessage", "--value"]);
    return r?.code === 0 ? r.stdout.trim() : "";
  };
  const before = await message();
  const restart = await tryRun("systemctl", ["restart", "systemd-timesyncd"]);
  if (restart?.code !== 0) return false;
  while (now() < deadline) {
    const m = await message();
    if (m !== "" && m !== before) return true;
    await delay(Math.min(STEP_POLL_MS, left()));
  }
  return false;
}
