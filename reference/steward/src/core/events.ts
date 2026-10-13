import type { Clock } from "@ludentes/galatea-life-test-clock";
import { RequestError } from "./errors.js";
import type { Tx } from "./db.js";
import { getMeta, RisingMeta, setMeta, type Store } from "./store.js";

export const EVENT_RETENTION_MS = 3_600_000;
/** `history` keeps 90 days, past the standard's floor of 7 (the design, *Event log*). */
export const HISTORY_RETENTION_MS = 90 * 24 * 3_600_000;
/** A personal key's `state` events are kept 7 days, the standard's floor, not 90: the design's choice, for privacy. */
export const PERSONAL_RETENTION_MS = 7 * 24 * 3_600_000;
/**
 * The most events one `history` answer holds; past it the answer says `more`, and the caller reads on
 * with `after_seq`, its last event's `seq` (the build's pick; the milestone 7+10+11 review, I4).
 */
export const HISTORY_CAP = 10_000;
/**
 * The kinds `history` returns (GA-STW-7): the steward's own and the applier's relayed. `history_v` in
 * `0011_history.sql` lists the same.
 */
export const HISTORY_TYPES = ["define", "ask", "answer", "lease", "narrowed", "refused", "rule_fired", "scenario", "schedule_missed",
  "schedule_skipped", "notice", "state", "outcome", "late_ack", "latch", "liveness", "model", "route_conflict", "provision", "freshness",
  "transport", "other_admins", "bridge_fault", "occurrence", "undescribed"];
/**
 * How far each life of the steward moves `seq` on when it starts: past any `seq` its last life could
 * have handed out and not kept, so a cursor from before a restart never skips a new event.
 */
export const SEQ_LIFE_GAP = 1_000_000;

/**
 * How an event is kept: `eventsOnly`, served by `events` and never by `history` (GA-STW-7: speech, a
 * personal key's occurrence); `personal`, a personal key's `state` or `occurrence` event, pruned from
 * `history` at 7 days and never in the reader role's view; null when it was not known (its device not
 * described when it came), which counts as personal (the milestone 7+10+11 review, B5). `withheld`, fields
 * of the body kept apart from it, beside its readers, so that neither the event as served nor the reader
 * role's view carries them: the caller serves them only where they may be read (a personal press's
 * holder, GA-AUTH-7, GA-LEASE-9).
 */
export type Keep = { eventsOnly?: boolean; personal?: boolean | null; readers?: Readers; withheld?: string[] };

/**
 * Who may read an `ask` event's `steps` or a `define` event's `diff` (GA-CONF-5, GA-STW-7): a read at
 * `endpoint`, one whose derived role is `owner`, and one whose derived person is `speaker`.
 */
export type Readers = { endpoint: string; speaker?: string };

/** An event as the log serves it, with its `personal` mark and its readers as it was kept (`Keep`). */
export type Marked = { event: AppEvent; personal: boolean | null; readers?: Readers; withheld?: Record<string, unknown> };

export type AppEvent = { seq: number; time: string; type: string } & Record<string, unknown>;

type Row = { seq: number | string; time_ms: number | string; type: string; body: Record<string, unknown>; events_only?: boolean;
  personal: boolean | null; readers?: (Partial<Readers> & { withheld?: Record<string, unknown> }) | null };
type Kept = { event: AppEvent; ms: number; personal: boolean | null; readers?: Readers; withheld?: Record<string, unknown> };

/** The meta key a clean stop leaves, and the next start clears (the reference applier's design, *Restart loss*). */
export const CLEAN_STOP = "clean_stop";

/** A body without the event's own `seq`, `time` and `type`: the log's always win (the reference applier's design, *Reserved keys*). */
function unreserved(body: Record<string, unknown>): Record<string, unknown> {
  const { seq: _seq, time: _time, type: _type, ...rest } = body;
  return rest;
}

// `pg` gives a bigint as a string, PGlite as a number. The `readers` column keeps an event's withheld fields beside its readers.
const toKept = (r: Row): Kept => {
  const { withheld, ...readers } = r.readers ?? {};
  return {
    event: { ...unreserved(r.body), seq: Number(r.seq), time: new Date(Number(r.time_ms)).toISOString(), type: r.type },
    ms: Number(r.time_ms),
    personal: r.personal,
    ...(readers.endpoint !== undefined ? { readers: readers as Readers } : {}),
    ...(withheld ? { withheld } : {}),
  };
};

/** An event as the log serves it, its readers and its withheld fields. */
const marked = (k: Kept): Marked => ({ event: k.event, personal: k.personal, ...(k.readers ? { readers: k.readers } : {}), ...(k.withheld ? { withheld: k.withheld } : {}) });

/**
 * The event log, copied from the reference applier's. Events are served from memory, so they answer
 * while the store is down; each is written behind (the design, *Event log*). `history` reads the
 * store, after the writer has committed what was handed to it. `seq` is given in memory, in the order
 * events happen, and the writer keeps that order.
 */
export class EventLog {
  private kept: Kept[] = [];
  private last = 0;
  /** No event at or below this `seq` is still served: older than the retention, or pruned. */
  private trimmedThrough = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly store: Store, private readonly clock: Clock) {
    this.lastSeq = new RisingMeta(store, "last_seq", () => this.last);
  }

  /** Whole ms: the test clock's readings are fractional, and the store's `time_ms` is a bigint. */
  private now(): number {
    return Math.floor(this.clock.now());
  }

  /**
   * Loads the last hour of events and starts this life's `seq`. The store must be reachable. After a
   * stop that was not clean, an event the last life served may never have been written, so every
   * cursor from before this start expires, and a client re-reads (the applier's *Restart loss*).
   */
  async load(): Promise<void> {
    const since = this.now() - EVENT_RETENTION_MS;
    const last = Number((await getMeta(this.store, "last_seq")) ?? "0");
    const clean = (await getMeta(this.store, CLEAN_STOP)) !== undefined;
    const pruned = Number((await getMeta(this.store, "pruned_through")) ?? "0");
    const aged = await this.store.query<{ n: number | string | null }>("SELECT max(seq) AS n FROM events WHERE time_ms <= $1", [since]);
    const rows = await this.store.query<Row>("SELECT seq, time_ms, type, body, personal, readers FROM events WHERE time_ms > $1 ORDER BY seq", [since]);
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
   * `seq` this one gave. `also` joins the row's write set, committed with it or dropped with it.
   */
  append(type: string, body: Record<string, unknown>, keep: Keep = {}, also?: (tx: Tx) => Promise<void>): AppEvent {
    const seq = ++this.last;
    const ms = this.now();
    const all = unreserved(body);
    const held = keep.withheld?.filter((k) => k in all) ?? [];
    const own = held.length ? Object.fromEntries(Object.entries(all).filter(([k]) => !held.includes(k))) : all;
    const withheld = held.length ? Object.fromEntries(held.map((k) => [k, all[k]])) : undefined;
    const event: AppEvent = { ...own, seq, time: new Date(ms).toISOString(), type };
    const personal = keep.personal === undefined ? false : keep.personal;
    this.kept.push({ event, ms, personal, ...(keep.readers ? { readers: keep.readers } : {}), ...(withheld ? { withheld } : {}) });
    const readers = keep.readers || withheld ? { ...keep.readers, ...(withheld ? { withheld } : {}) } : undefined;
    void this.store.write(async (tx) => {
      await tx.query("INSERT INTO events (seq, time_ms, type, body, events_only, personal, readers) VALUES ($1, $2, $3, $4, $5, $6, $7) "
        + "ON CONFLICT (seq) DO NOTHING", [seq, ms, type, JSON.stringify(own), keep.eventsOnly === true, personal,
        readers ? JSON.stringify(readers) : null]);
      await also?.(tx);
    }, { droppable: true });
    this.lastSeq.schedule();
    for (const w of [...this.waiters]) w();
    return event;
  }

  /**
   * Whether a `rule_fired` of `rule` was logged after the first event relaying an applier event at or
   * after `applierMs` (its `applier_time`), within the hour kept in memory (GA-RULE-1): the applier's
   * time is compared only with the applier's, and the firing placed by the log's order, never by the
   * steward's clock (the code review, CR3). With no such event logged, none was fired since.
   */
  firedSince(rule: string, applierMs: number): boolean {
    const at = this.kept.findIndex((k) => typeof k.event.applier_time === "string" && Date.parse(k.event.applier_time) >= applierMs);
    return at >= 0 && this.kept.slice(at + 1).some((k) => k.event.type === "rule_fired" && k.event.rule === rule);
  }

  /** The last `seq` given, as a cursor. */
  cursor(): string {
    return String(this.last);
  }

  /** The events after `cursor`; `cursor_expired` when any of them is past the retention or pruned. */
  read(cursor: string): AppEvent[] {
    return this.readMarked(cursor).map((k) => k.event);
  }

  /** As `read`, each event with its `personal` mark. */
  readMarked(cursor: string): Marked[] {
    const after = /^\d+$/.test(cursor) ? Number(cursor) : NaN;
    if (!Number.isSafeInteger(after)) throw new RequestError("invalid_request", `cursor ${cursor} is not a number`);
    // A cursor ahead of the log comes from another store: the client must re-read.
    if (after > this.last) throw new RequestError("cursor_expired", `cursor ${cursor} is not this steward's`);
    const oldest = this.now() - EVENT_RETENTION_MS;
    if (after < this.trimmedThrough || this.kept.some((k) => k.event.seq > after && k.ms <= oldest)) {
      throw new RequestError("cursor_expired", `events after cursor ${cursor} are no longer kept`);
    }
    return this.kept.filter((k) => k.event.seq > after).map(marked);
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
   * The history kinds in `[fromMs, toMs]` from the store, in the log's order (`seq`: the clock may be
   * stepped back, so time is filtered, never sorted), those after `afterSeq`, at most `cap`
   * (GA-STW-7); with `targets`, those naming one of them: an event's `target`, `device`, or one of
   * its `devices` or `targets`, or, an applier's `latch` or `rule_fired`, one of `rules` (the safety
   * rules actuating one of them). Events-only rows are never read. It waits for the writer to commit what was handed to
   * it before, so an event `events` served is in `history` too. `more`: the range held more than `cap`.
   */
  async history(fromMs: number, toMs: number, targets: string[] | undefined, cap = HISTORY_CAP, afterSeq = 0, rules: string[] = []):
  Promise<{ events: Marked[]; more: boolean }> {
    await this.store.settled();
    const params: unknown[] = [fromMs, toMs, HISTORY_TYPES, cap + 1, afterSeq];
    const named = targets === undefined ? "" : (params.push(targets, rules), " AND ((body->>'target') = ANY($6) OR (body->>'device') = ANY($6) "
      + "OR (jsonb_typeof(body->'devices') = 'array' AND (body->'devices') ?| $6) OR (jsonb_typeof(body->'targets') = 'array' AND (body->'targets') ?| $6) "
      + "OR (type IN ('latch', 'rule_fired') AND (body->>'rule_id') = ANY($7)))");
    const rows = await this.store.query<Row>("SELECT seq, time_ms, type, body, personal, readers FROM events WHERE time_ms >= $1 AND time_ms <= $2 AND type = ANY($3) "
      + `AND seq > $5 AND NOT events_only${named} ORDER BY seq LIMIT $4`, params);
    const events = rows.rows.map((r) => marked(toKept(r)));
    return { events: events.slice(0, cap), more: events.length > cap };
  }

  /**
   * Stops serving events past the retention, and hands the store's prune to the writer: past the 90
   * days of `history`, and a personal key's `state` events past 7 (the design, *Event log*).
   */
  prune(): void {
    const oldest = this.now() - EVENT_RETENTION_MS;
    while (this.kept[0] && this.kept[0].ms <= oldest) this.trimmedThrough = this.kept.shift()!.event.seq;
    // A store that is down is pruned on a later round, rather than queueing a prune a minute.
    if (this.store.down) return;
    const before = this.now() - HISTORY_RETENTION_MS;
    const personal = this.now() - PERSONAL_RETENTION_MS;
    void this.store.write(async (tx) => {
      const gone = await tx.query<{ n: number | string | null }>(
        "WITH gone AS (DELETE FROM events WHERE time_ms < $1 OR (personal IS NOT FALSE AND time_ms < $2) RETURNING seq) SELECT max(seq) AS n FROM gone", [before, personal]);
      const n = gone.rows[0]?.n;
      if (n === null || n === undefined) return;
      await tx.query("INSERT INTO meta (key, value) VALUES ('pruned_through', $1) ON CONFLICT (key) "
        + "DO UPDATE SET value = GREATEST(meta.value::bigint, EXCLUDED.value::bigint)::text", [String(n)]);
    });
  }
}
