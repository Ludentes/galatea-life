import type { Clock } from "@ludentes/galatea-life-test-clock";
import { ApplierRefused, NotSent, type ApplierPort } from "./port.js";

type Body = Record<string, any>;

export const FIRST_BACKOFF_MS = 250;
export const LAST_BACKOFF_MS = 5000;
/** The follower's long-poll on the applier's `events` (the design, *The events follower*). */
export const EVENTS_WAIT_S = 30;
/**
 * How far back a recovery reads the applier's history at most: the 7 days an applier keeps it
 * (applier GA-EVT-5). A gap longer than that is read from its last 7 days.
 */
export const RECOVERY_WINDOW_MS = 7 * 24 * 3_600_000;
/**
 * How far past the steward's own now a recovery reads the applier's history: the read is bounded by
 * the sync's cursor (`seq`), not by time, and the applier's clock may run ahead of the steward's (the
 * milestone 7+10+11 review, B2), so `to` is only far enough to hold every event up to the cursor.
 */
export const RECOVERY_AHEAD_MS = 24 * 3_600_000;

/**
 * The most of the applier's missed events one recovery takes, those `mustRecover` names aside; past it
 * the oldest are dropped (the steward says so once), and the devices they named handed on, so a level
 * rule reading one counts as having become false and fires again rather than never.
 */
export const RECOVERY_CAP = 4096;
/** The first page of a recovery's read of the applier's history, back from now; each next one sized by how full the last was. */
export const RECOVERY_PAGE_MS = 3_600_000;

/**
 * Whether a missed event is one the recovery cap never drops (the milestone 7+10+11 review, I2): what
 * grants or ends a lease, a safety rule's actuation, latch and completion (GA-LEASE-6), and an outside
 * or a load cap's change (GA-LEASE-2).
 */
export function mustRecover(e: Body): boolean {
  if (e.type === "latch" || e.type === "rule_fired") return true;
  if (e.type === "outcome" && typeof e.rule_id === "string") return true;
  if (e.type !== "state") return false;
  return e.cause === "external" || e.cause === "load_cap" || (typeof e.cause === "object" && e.cause !== null && typeof e.cause.safety_rule === "string");
}

/** What a recovery's read left out past the cap: how many events, and the devices they named. */
export type Dropped = { count: number; targets: string[] };

/** What the link hands the steward, each call one synchronous step of the steward's. */
export interface LinkSteps {
  describe(d: Body): void;
  state(s: Body): void;
  events(events: Body[]): void;
  /** The `notices` of every `events` response, the sync's and an empty batch's included (GA-NOTE-1). */
  notices?(notices: Body[]): void;
  /** The notice ids to send as `notice_taken` on the next `events` call. */
  taken?(): string[];
  /** The applier's event the steward last had, its `seq` and time: a sync reads the applier's history from it (the design, *Recovery*). */
  since?(): { seq: number; timeMs: number } | undefined;
  /**
   * In place of `state` on a sync after a gap: the applier's events in its history since `since`
   * (`missed`, up to the sync's `cursor`), then its `state` (GA-LEASE-2, GA-LEASE-6, GA-RULE-1).
   */
  recover?(missed: Body[], state: Body, cursor: string, dropped?: Dropped): void;
}

export interface LinkOptions {
  clock: Clock;
  /** Makes a session to the applier; the MCP client in production, a fake in tests. */
  connect: () => Promise<ApplierPort>;
  steps: LinkSteps;
  log?: (line: string) => void;
  /** `RECOVERY_CAP`, smaller in tests. */
  recoveryCap?: number;
}

/**
 * The steward's one session to its applier, and the loop outside the steps that keeps it (the
 * design, *The applier link*). On each session: the applier's events cursor, then `describe` and
 * `state`, then the events from that cursor, long-polled, each batch handed to a step. A `model`
 * event re-reads `describe`, which does not long-poll, and `state`; `cursor_expired` reads the model
 * and the state again. A failed session is made again with backoff, 250 ms to 5 s, on the clock.
 * Every `events` call carries the notices the steward delivered as `notice_taken`, and every answer's
 * `notices` are handed on, after the model and the state on a sync, so a notice finds its channels.
 */
export class ApplierLink {
  private port?: ApplierPort;
  private stopped = false;
  private backoffMs = FIRST_BACKOFF_MS;
  private timer?: number;
  private wake?: () => void;
  private running?: Promise<void>;
  /** The MCP revision the current session was reached at, for the health output. */
  protocolVersion?: string;
  /** Whether a session is up and the mirror was read on it. */
  connected = false;
  private lastError?: string;

  constructor(private readonly o: LinkOptions) {}

  start(): void {
    this.running ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) this.o.clock.clear(this.timer);
    this.wake?.();
    await this.port?.close().catch(() => undefined);
    await this.running;
  }

  private log(line: string): void {
    (this.o.log ?? ((l: string) => console.error(l)))(line);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.port = await this.o.connect();
        if (this.stopped) break;
        this.protocolVersion = this.port.protocolVersion;
        await this.follow(this.port);
      } catch (err) {
        if (this.stopped) break;
        const why = err instanceof Error ? err.message : String(err);
        // Said once per kind of failure, not once per retry.
        if (why !== this.lastError) this.log(`the applier is out of reach, retrying: ${why}`);
        this.lastError = why;
      }
      this.connected = false;
      await this.port?.close().catch(() => undefined);
      this.port = undefined;
      if (this.stopped) break;
      await this.pause(this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, LAST_BACKOFF_MS);
    }
  }

  /** Reads the model and the state, then follows the events; returns only by throwing. */
  private async follow(port: ApplierPort): Promise<void> {
    let cursor = await this.sync(port);
    for (;;) {
      if (this.stopped) return;
      let r: { events: Body[]; cursor: string; notices?: Body[] };
      try {
        r = await port.events(cursor, EVENTS_WAIT_S, this.o.steps.taken?.() ?? []);
      } catch (err) {
        // A gap: the model and the state again, from a fresh cursor, and what the gap held from the
        // applier's history (the design, *Recovery*).
        if (err instanceof ApplierRefused && err.code === "cursor_expired") {
          cursor = await this.sync(port);
          continue;
        }
        throw err;
      }
      if (this.stopped) return;
      cursor = r.cursor;
      this.o.steps.notices?.(r.notices ?? []);
      if (!r.events.length) continue;
      this.o.steps.events(r.events);
      // A model change may bring devices whose values no state event will report: their state too.
      if (r.events.some((e) => e.type === "model")) {
        const d = await port.describe();
        const s = await port.state();
        if (this.stopped) return;
        this.o.steps.describe(d);
        this.o.steps.state(s);
      }
    }
  }

  /** The applier's plan of `request`, on the session that is up; rejects while the applier is out of reach. */
  async plan(request: Body): Promise<Body> {
    if (!this.port || !this.connected) throw new Error("the applier is out of reach");
    return this.port.plan(request);
  }

  /**
   * The applier's apply of `body`, on the session that is up. With none up it rejects with `NotSent`,
   * so the caller knows nothing was sent; any other failure may have reached the applier.
   */
  async apply(body: Body, timeoutMs: number): Promise<Body> {
    if (!this.port || !this.connected) throw new NotSent("the applier is out of reach: nothing was sent");
    return this.port.apply(body, timeoutMs);
  }

  /**
   * A fresh cursor, then `describe` and `state`; after a gap (any sync once the steward has had an
   * event of the applier's: a start, a `cursor_expired`, a session made again), the applier's history
   * from the last event it had, up to the sync's cursor (read with `to` a day past the steward's now,
   * since the applier's clock may be ahead), handed to `recover` with the state. A history the applier
   * refuses, or that cannot be read, is said, and the sync goes on without it; a session that fails
   * meanwhile is made again.
   */
  private async sync(port: ApplierPort): Promise<string> {
    const { cursor, notices } = await port.events(undefined, 0, this.o.steps.taken?.() ?? []);
    const d = await port.describe();
    const s = await port.state();
    const since = this.o.steps.recover ? this.o.steps.since?.() : undefined;
    let missed: { events: Body[]; dropped: Dropped } | undefined;
    if (since) {
      try {
        missed = await this.readGap(port, since, cursor);
      } catch (err) {
        // Any failure to read it, not only a refusal (a timeout, a tool not served, an answer not
        // understood): the gap is lost and the sync goes on, or the link would never come up while the
        // history fails (the code review, CR2). A session that failed meanwhile fails the next call.
        if (err instanceof ApplierRefused) this.log(`the applier refused its history for the gap; what the gap held is lost: ${err.message}`);
        else this.log(`the applier's history for the gap could not be read; what the gap held is lost: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.stopped) return cursor;
    // Up before the steps run: the state's step may fire a rule, whose plan and apply need the session
    // (a rule fired at the start must not find the applier "out of reach" and fail closed; B4).
    if (!this.connected) this.log(`the applier reached at MCP revision ${this.protocolVersion ?? "unknown"}`);
    this.connected = true;
    this.o.steps.describe(d);
    if (missed && this.o.steps.recover) this.o.steps.recover(missed.events, s, cursor, missed.dropped);
    else this.o.steps.state(s);
    this.o.steps.notices?.(notices ?? []);
    this.lastError = undefined;
    this.backoffMs = FIRST_BACKOFF_MS;
    return cursor;
  }

  /**
   * The applier's history after `since` and up to `cursor`, read in pages back from now (the
   * milestone 7+10+11 review, I3): the applier's `history` has no limit, so each page is a window of
   * time, narrowed after a page past the cap and widened after a sparse one. At most `RECOVERY_CAP`
   * events are held, the newest, beside every one `mustRecover` names, for which the read goes on to
   * the gap's start; it stops at the last event the steward had, or 7 days back. Each event is taken
   * once, by `seq`.
   */
  private async readGap(port: ApplierPort, since: { seq: number; timeMs: number }, cursor: string): Promise<{ events: Body[]; dropped: Dropped }> {
    const now = this.o.clock.now();
    const floor = Math.max(since.timeMs, now - RECOVERY_WINDOW_MS);
    const upTo = /^\d+$/.test(cursor) ? Number(cursor) : Infinity;
    const cap = this.o.recoveryCap ?? RECOVERY_CAP;
    const seen = new Set<number>();
    const kept: Body[] = [];
    const must: Body[] = [];
    const dropped = { count: 0, targets: new Set<string>() };
    let width = RECOVERY_PAGE_MS;
    let to = now + RECOVERY_AHEAD_MS;
    let from = Math.max(floor, now - width);
    for (;;) {
      const page = (await port.history({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })).events;
      let reached = false;
      for (const e of page) {
        if (typeof e.seq !== "number") continue;
        if (e.seq <= since.seq) reached = true;
        if (e.seq <= since.seq || e.seq > upTo || seen.has(e.seq)) continue;
        seen.add(e.seq);
        (mustRecover(e) ? must : kept).push(e);
      }
      if (kept.length > cap) {
        kept.sort((a, b) => b.seq - a.seq);
        for (const e of kept.splice(cap)) {
          dropped.count++;
          if (typeof e.target === "string") dropped.targets.add(e.target);
        }
      }
      if (reached || from <= floor || this.stopped) break;
      width = page.length > cap ? Math.max(1000, Math.floor(width / 4)) : page.length < cap / 4 ? width * 2 : width;
      to = from - 1;
      from = Math.max(floor, to - width);
    }
    return { events: [...must, ...kept].sort((a, b) => a.seq - b.seq), dropped: { count: dropped.count, targets: [...dropped.targets].sort() } };
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = this.o.clock.setTimeout(resolve, ms);
    });
  }
}
