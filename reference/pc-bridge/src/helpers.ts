import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { HelperConnection, HelperMessage, HelperValues, OsPort, OsSession } from "./port.js";

/** A helper that went is started again after 1 s, then 2, 4 … never more than 60 s apart (the design's *Error handling*). */
export const HELPER_RETRY_MS = 1_000;
export const HELPER_RETRY_CEILING_MS = 60_000;
/** A helper bound this long before it went starts its backoff again from HELPER_RETRY_MS. */
export const HELPER_STEADY_MS = 60_000;

/** What a helper may report, each checked for its type: a field of another type is dropped, the rest of the report kept. */
const PERSONAL: Record<string, (v: unknown) => boolean> = {
  app: (v) => typeof v === "string" || v === null,
  camera_in_use: (v) => typeof v === "boolean",
  microphone_in_use: (v) => typeof v === "boolean",
};

/** The helper the bridge started in one graphical session, and what it last reported. */
interface Started {
  session: string;
  osId: number;
  /** Its process, null while none runs (gone, or not started yet). */
  pid: number | null;
  starting: boolean;
  /** Its connection once bound; nothing else's word is taken for the session. */
  conn: number | null;
  boundAt: number | null;
  values: HelperValues;
  /** When each value was reported, on the bridge's clock. */
  at: Record<string, number>;
  retryMs: number;
  timer: number | null;
}

export interface HelpersOptions {
  port: OsPort;
  clock: Clock;
  /** A connection refused or a report ignored, with why, naming the session (GA-BRIDGE-61). */
  refused(detail: string): void;
  /** A helper was bound, reported or went: the computer's keys may have changed. */
  changed(): void;
  /** Whether the bridge is running; a restart that falls due while it is not waits for the next observation. */
  running(): boolean;
}

/**
 * The session helpers (GA-BRIDGE-61): one started in each graphical session the OS reports, bound
 * by the OS's identity for its connection, and only there. A connection is bound only when it comes
 * from the pid the bridge started, in the session it started it in, as that session's account, and
 * that session has no helper bound yet; anything else is refused and named. A report counts only
 * from a bound connection and only for its own session. A connection is lost only when the OS
 * reports that connection gone: another connection's end, from the same pid or not, changes nothing.
 */
export class Helpers {
  private readonly started = new Map<string, Started>();
  /**
   * What connections the bridge could not yet judge sent, in order: a helper may connect before its
   * start has resolved in the bridge (the port resolves the pid before it releases the helper, but the
   * connection's message can still come first). Judged again as each start settles.
   */
  private readonly early: Exclude<HelperMessage, { kind: "exited" }>[] = [];
  /**
   * The pids of helpers whose process ended before they were bound, by session: a connection the
   * endpoint was still identifying when its process ended is closed, not named (review M1). Forgotten
   * once that connection has gone, or when the session's helper is started again.
   */
  private readonly ended = new Map<number, string>();
  /** Set by `stopAll`: from then on nothing is started, and a start that resolves after it is stopped. */
  private closed = false;

  constructor(private readonly o: HelpersOptions) {}

  /** Starts a helper in each graphical session that has none, and stops the helper of each session gone. */
  async sync(sessions: OsSession[]): Promise<void> {
    if (this.closed) return;
    const graphical = new Map(sessions.filter((s) => s.graphical).map((s) => [s.id, s]));
    for (const [id, h] of this.started) {
      if (graphical.has(id)) continue;
      this.started.delete(id);
      if (h.timer !== null) this.o.clock.clear(h.timer);
      if (h.pid !== null) await this.o.port.stopHelper(h.pid).catch((err) => console.error(`helper ${id}: stop: ${err}`));
      if (h.conn !== null) this.o.changed();
    }
    // Stopped while a gone session's helper was being stopped: nothing new is started.
    if (this.closed) return;
    const starts: Promise<void>[] = [];
    for (const s of graphical.values()) {
      let h = this.started.get(s.id);
      if (!h) {
        h = { session: s.id, osId: s.osId, pid: null, starting: false, conn: null, boundAt: null, values: {}, at: {},
          retryMs: HELPER_RETRY_MS, timer: null };
        this.started.set(s.id, h);
      }
      // A helper gone while the bridge was not running is started at the next observation.
      if (h.pid === null && !h.starting && h.timer === null) starts.push(this.start(h));
    }
    await Promise.all(starts);
  }

  private async start(h: Started): Promise<void> {
    h.starting = true;
    let pid: number;
    try {
      pid = await this.o.port.startHelper(h.session);
    } catch (err) {
      h.starting = false;
      console.error(`helper ${h.session}: start: ${err}`);
      if (!this.closed) this.retry(h);
      this.replay();
      return;
    }
    h.starting = false;
    // The session went, or the helpers were stopped, while the helper was starting.
    if (this.closed || this.started.get(h.session) !== h) {
      this.replay();
      await this.o.port.stopHelper(pid).catch((err) => console.error(`helper ${h.session}: stop: ${err}`));
      return;
    }
    // Registered before anything else runs, then the connections that came early are judged against it.
    for (const [old, session] of this.ended) if (session === h.session || old === pid) this.ended.delete(old);
    h.pid = pid;
    this.replay();
  }

  /** Judges again what came before a start settled. */
  private replay(): void {
    for (const m of this.early.splice(0)) this.onMessage(m);
  }

  /** Schedules a restart after the backoff; a helper that ran steadily starts it again from 1 s. */
  private retry(h: Started): void {
    const now = this.o.clock.now();
    if (h.boundAt !== null && now - h.boundAt >= HELPER_STEADY_MS) h.retryMs = HELPER_RETRY_MS;
    const wait = h.retryMs;
    h.retryMs = Math.min(wait * 2, HELPER_RETRY_CEILING_MS);
    h.timer = this.o.clock.setTimeout(() => {
      h.timer = null;
      if (!this.closed && this.started.get(h.session) === h && this.o.running()) void this.start(h);
    }, wait);
  }

  onMessage(m: HelperMessage): void {
    if (m.kind === "exited") return this.exited(m.pid);
    // A connection held until a start settles holds its later messages too, in order; its end drops them all.
    if (m.kind !== "connected" && this.early.some((e) => e.kind === "connected" && e.from.conn === m.from.conn)) {
      if (m.kind === "gone") this.early.splice(0, this.early.length, ...this.early.filter((e) => e.from.conn !== m.from.conn));
      else this.early.push(m);
      return;
    }
    if (m.kind === "connected") return this.connected(m.from);
    if (m.kind === "report") return this.report(m.from, m.session, m.values);
    // What the endpoint could not read is named, from a bound connection or not; a bound helper stays bound.
    if (m.kind === "malformed") return this.o.refused(`session ${m.from.session ?? "none"}: ${m.detail}`);
    return this.gone(m.from);
  }

  /**
   * A helper's process ended: one that never connected is started again after the backoff, as one
   * whose connection went is; a bound one goes now, and its connection's end then names no helper.
   * The end of a process the bridge no longer holds (one it stopped) changes nothing.
   */
  private exited(pid: number): void {
    const h = [...this.started.values()].find((x) => x.pid === pid);
    if (!h) return;
    const bound = h.conn !== null;
    if (!bound) this.ended.set(pid, h.session);
    h.pid = null;
    h.conn = null;
    h.values = {};
    h.at = {};
    this.retry(h);
    h.boundAt = null;
    if (bound) this.o.changed();
  }

  private connected(from: HelperConnection): void {
    const where = `session ${from.session ?? "none"}`;
    const h = [...this.started.values()].find((x) => x.pid === from.pid);
    // Maybe the helper of a start not yet settled: judged when it has.
    if (!h && [...this.started.values()].some((x) => x.starting)) {
      this.early.push({ kind: "connected", from });
      return;
    }
    // Its helper's process ended while the endpoint identified it: closed, and nothing forged to name.
    if (!h && this.ended.has(from.pid)) {
      this.o.port.closeHelper(from.conn).catch((err) => console.error(`helper: close: ${err}`));
      return;
    }
    let why: string | undefined;
    if (!h) why = `pid ${from.pid} is no helper the bridge started`;
    else if (from.session !== h.session) why = `the helper started in session ${h.session} connected from ${where}`;
    else if (from.osId !== h.osId) why = `uid ${from.osId} is not the session's account`;
    else if (h.conn !== null) why = "a second connection from its helper";
    if (why !== undefined || !h) {
      this.o.port.closeHelper(from.conn).catch((err) => console.error(`helper: close: ${err}`));
      this.o.refused(`${where}: ${why}`);
      return;
    }
    h.conn = from.conn;
    h.boundAt = this.o.clock.now();
    this.o.changed();
  }

  private report(from: HelperConnection, session: string, values: HelperValues): void {
    const h = [...this.started.values()].find((x) => x.conn === from.conn);
    if (!h) return this.o.refused(`session ${from.session ?? "none"}: a report from a connection not bound as its helper`);
    if (session !== h.session) return this.o.refused(`session ${h.session}: its helper reported for session ${session}`);
    const now = this.o.clock.now();
    const kept = h.values as Record<string, unknown>;
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (k === "activity") {
        // Only `active` or `idle`: anything else is no reading, and the session reads `unknown` (GA-BRIDGE-52).
        if (v === "active" || v === "idle") {
          kept.activity = v;
          h.at.activity = now;
        } else {
          delete kept.activity;
          delete h.at.activity;
        }
        continue;
      }
      // A key the helper may not report, or a value of the wrong type, is dropped; the rest stands.
      if (!Object.hasOwn(PERSONAL, k) || !PERSONAL[k]!(v)) continue;
      kept[k] = v;
      h.at[k] = now;
    }
    this.o.changed();
  }

  /** The bound connection went: its process is stopped (it may outlive its connection), then started again after the backoff. */
  private gone(from: HelperConnection): void {
    this.ended.delete(from.pid);
    const h = [...this.started.values()].find((x) => x.conn !== null && x.conn === from.conn);
    // A refused connection's end (from the bound helper's pid or not), or a helper stopped already: nothing changes.
    if (!h) return;
    if (h.pid !== null) this.o.port.stopHelper(h.pid).catch((err) => console.error(`helper ${h.session}: stop: ${err}`));
    h.pid = null;
    h.conn = null;
    h.values = {};
    h.at = {};
    this.retry(h);
    h.boundAt = null;
    this.o.changed();
  }

  /** The bound helper's `activity` for that session, if it has reported one. */
  activity(session: string): "active" | "idle" | undefined {
    const h = this.started.get(session);
    return h && h.conn !== null ? h.values.activity : undefined;
  }

  /** The connection of the helper bound in that session. */
  conn(session: string): number | undefined {
    const h = this.started.get(session);
    return h && h.conn !== null ? h.conn : undefined;
  }

  /** What the bound helper of that session reported of `keys`, each with when; a key it never reported is left out. */
  readings(session: string, keys: string[]): Record<string, { value: unknown; at: number }> {
    const h = this.started.get(session);
    const out: Record<string, { value: unknown; at: number }> = {};
    if (!h || h.conn === null) return out;
    for (const k of keys) {
      const v = (h.values as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = { value: v, at: h.at[k]! };
    }
    return out;
  }

  /** At the bridge's stop: every helper it started is stopped. */
  async stopAll(): Promise<void> {
    this.closed = true;
    const all = [...this.started.values()];
    this.started.clear();
    this.early.splice(0);
    for (const h of all) {
      if (h.timer !== null) this.o.clock.clear(h.timer);
      if (h.pid !== null) await this.o.port.stopHelper(h.pid).catch((err) => console.error(`helper ${h.session}: stop: ${err}`));
    }
  }
}
