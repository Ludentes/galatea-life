import type { Clock } from "@ludentes/galatea-life-test-clock";
import { RequestError } from "./errors.js";
import { getMeta, RisingMeta, setMeta, type Store } from "./store.js";
import type { Mutation } from "../mutations.js";

export const EVENT_RETENTION_MS = 3_600_000;
export const HISTORY_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * How far each life of the applier moves `seq` on when it starts: past any `seq` its last life could
 * have handed out and not kept, so a cursor from before a restart never skips a new event.
 */
export const SEQ_LIFE_GAP = 1_000_000;

/** The kinds `history` returns (GA-EVT-5); `history_v` in `0010_occurrences.sql` lists the same. */
const HISTORY_TYPES = new Set(["state", "outcome", "late_ack", "liveness", "rule_fired", "latch", "model",
  "route_conflict", "provision", "freshness", "transport", "other_admins", "bridge_fault", "occurrence"]);

/** How an event is kept: `eventsOnly`, served by `events` and never by `history` (GA-EVT-5's personal occurrence). */
export type Keep = { eventsOnly?: boolean };

export type AppEvent = { seq: number; time: string; type: string } & Record<string, unknown>;

type Row = { seq: number | string; time_ms: number | string; type: string; body: Record<string, unknown>; events_only?: boolean };
type Kept = { event: AppEvent; ms: number };

/** The meta key a clean stop leaves, and the next start clears (the design, *Restart loss*). */
export const CLEAN_STOP = "clean_stop";

/** A body without the event's own `seq`, `time` and `type`: the log's always win (the design, *Reserved keys*). */
function unreserved(body: Record<string, unknown>): Record<string, unknown> {
  const { seq: _seq, time: _time, type: _type, ...rest } = body;
  return rest;
}

// `pg` gives a bigint as a string, PGlite as a number.
const toKept = (r: Row): Kept => ({
  event: { ...unreserved(r.body), seq: Number(r.seq), time: new Date(Number(r.time_ms)).toISOString(), type: r.type },
  ms: Number(r.time_ms),
});

/**
 * The event log. `events` is served from memory (GA-EVT-4), so it answers while the store is down;
 * each event is written behind (the storage design: events don't wait). `history` reads the store
 * (GA-EVT-5). `seq` is given in memory, in the order events happen, and the writer keeps that order.
 */
export class EventLog {
  private kept: Kept[] = [];
  private last = 0;
  /** No event at or below this `seq` is still served: older than the retention, or pruned. */
  private trimmedThrough = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly store: Store, private readonly clock: Clock, private readonly mutation?: Mutation) {
    this.lastSeq = new RisingMeta(store, "last_seq", () => this.last);
  }

  /** Whole ms: the test clock's readings are fractional, and the store's `time_ms` is a bigint. */
  private now(): number {
    return Math.floor(this.clock.now());
  }

  /**
   * Loads the last hour of events and starts this life's `seq`. The store must be reachable. After a
   * stop that was not clean, an event the last life served may never have been written, so every
   * cursor from before this start expires, and the steward's recovery runs.
   */
  async load(): Promise<void> {
    const since = this.now() - EVENT_RETENTION_MS;
    const last = Number((await getMeta(this.store, "last_seq")) ?? "0");
    // `skips-lost-events`: every cursor of the last life reads on, whatever its stop.
    const clean = this.mutation === "skips-lost-events" || (await getMeta(this.store, CLEAN_STOP)) !== undefined;
    const pruned = Number((await getMeta(this.store, "pruned_through")) ?? "0");
    const aged = await this.store.query<{ n: number | string | null }>("SELECT max(seq) AS n FROM events WHERE time_ms <= $1", [since]);
    const rows = await this.store.query<Row>("SELECT seq, time_ms, type, body FROM events WHERE time_ms > $1 ORDER BY seq", [since]);
    this.kept = rows.rows.map(toKept);
    this.last = last + SEQ_LIFE_GAP;
    this.trimmedThrough = clean ? Math.max(pruned, Number(aged.rows[0]?.n ?? 0)) : this.last;
    this.lastStopClean = clean || last === 0;
    await this.store.write(async (tx) => {
      await setMeta(tx, "last_seq", String(this.last));
      await tx.query("DELETE FROM meta WHERE key = $1", [CLEAN_STOP]);
    });
  }

  /** Whether the last life stopped clean (or there was none); set by `load`. */
  lastStopClean = true;

  /** `last_seq`, written behind: the highest `seq` given, so the next life starts past it. */
  private readonly lastSeq: RisingMeta;

  /**
   * Serves an event at once, releases the waiters, and hands its row to the writer, which may drop it
   * past its cap. `last_seq` is written apart (`RisingMeta`), so the next life always starts past every
   * `seq` this one gave.
   */
  append(type: string, body: Record<string, unknown>, keep: Keep = {}): AppEvent {
    const seq = ++this.last;
    const ms = this.now();
    const own = unreserved(body);
    const event: AppEvent = { ...own, seq, time: new Date(ms).toISOString(), type };
    this.kept.push({ event, ms });
    void this.store.write((tx) => tx.query("INSERT INTO events (seq, time_ms, type, body, events_only) VALUES ($1, $2, $3, $4, $5) "
      + "ON CONFLICT (seq) DO NOTHING", [seq, ms, type, JSON.stringify(own), keep.eventsOnly === true]).then(() => undefined), { droppable: true });
    this.lastSeq.schedule();
    for (const w of [...this.waiters]) w();
    return event;
  }

  /** The last `seq` given, as a cursor. */
  cursor(): string {
    return String(this.last);
  }

  /** The events after `cursor`; `cursor_expired` when any of them is past the retention or pruned. */
  read(cursor: string): AppEvent[] {
    const after = /^\d+$/.test(cursor) ? Number(cursor) : NaN;
    if (!Number.isSafeInteger(after)) throw new RequestError("invalid_request", `cursor ${cursor} is not a number`);
    // A cursor ahead of the log comes from another store: the client must re-read.
    if (after > this.last) throw new RequestError("cursor_expired", `cursor ${cursor} is not this applier's`);
    const oldest = this.now() - EVENT_RETENTION_MS;
    if (after < this.trimmedThrough || this.kept.some((k) => k.event.seq > after && k.ms <= oldest)) {
      throw new RequestError("cursor_expired", `events after cursor ${cursor} are no longer kept`);
    }
    return this.kept.filter((k) => k.event.seq > after).map((k) => k.event);
  }

  /** Resolves on the next event, or after `ms` on the clock. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        this.clock.clear(timer);
        resolve();
      };
      const timer = this.clock.setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  /**
   * The history kinds in `[fromMs, toMs]` from the store, oldest first; with `targets`, those naming
   * one of them. It waits for the writer to commit what was handed to it before, so an event served
   * by `events` is in `history` too.
   */
  /**
   * `hidden` leaves out what is to be hidden as things stand now: an occurrence of a key the device's
   * `personal` holds now, beside the rows marked events-only when they happened (GA-EVT-5).
   */
  async history(fromMs: number, toMs: number, targets?: string[], hidden?: (e: AppEvent) => boolean): Promise<AppEvent[]> {
    await this.store.settled();
    const rows = await this.store.query<Row>(
      "SELECT seq, time_ms, type, body FROM events WHERE time_ms >= $1 AND time_ms <= $2 AND NOT events_only ORDER BY seq", [fromMs, toMs]);
    return rows.rows.map((r) => toKept(r).event).filter((e) => HISTORY_TYPES.has(e.type) && !isSpeech(e)
      && (!targets || names(e).some((t) => targets.includes(t))) && !hidden?.(e));
  }

  /** Stops serving events past the retention, and hands the store's prune of the 7 days to the writer. */
  prune(): void {
    const oldest = this.now() - EVENT_RETENTION_MS;
    while (this.kept[0] && this.kept[0].ms <= oldest) this.trimmedThrough = this.kept.shift()!.event.seq;
    // A store that is down is pruned on a later round, rather than queueing a prune a minute.
    if (this.store.down) return;
    const before = this.now() - HISTORY_RETENTION_MS;
    void this.store.write(async (tx) => {
      const gone = await tx.query<{ n: number | string | null }>(
        "WITH gone AS (DELETE FROM events WHERE time_ms < $1 RETURNING seq) SELECT max(seq) AS n FROM gone", [before]);
      const n = gone.rows[0]?.n;
      if (n === null || n === undefined) return;
      await tx.query("INSERT INTO meta (key, value) VALUES ('pruned_through', $1) ON CONFLICT (key) "
        + "DO UPDATE SET value = GREATEST(meta.value::bigint, EXCLUDED.value::bigint)::text", [String(n)]);
    });
  }
}

/** A `state` event's `speech` key is kept in `events` only (GA-EVT-5). */
const isSpeech = (e: AppEvent) => e.type === "state" && e.key === "speech";

/**
 * The devices an event names: its `target`, a `model` event's `device`, and the `devices` a
 * `rule_fired` event's rule reads and actuates (GA-LEASE-6 reads them back by device); slice 6b gives
 * a `latch` event its own; a `provision` event's `transport` (slice 5a).
 */
function names(e: AppEvent): string[] {
  const devices = Array.isArray(e.devices) ? e.devices : [];
  // Only a provision event's transport: a `transport` event's is left as it was (no target reads it back).
  const transport = e.type === "provision" ? e.transport : undefined;
  return [e.target, e.device, transport, ...devices].filter((x): x is string => typeof x === "string");
}
