import type { Clock } from "@ludentes/galatea-life-test-clock";
import { canonical } from "../core/canonical.js";
import type { Tx } from "../core/db.js";
import { GATE_MS, within, type Store } from "../core/store.js";
import type { House, Schedule } from "../house/model.js";
import { dueSince, markAt, nextOccurrence, occurrenceOn, type Occurrence } from "./core.js";

/**
 * A run's timer that fires later than this past its time does not run it: the run is recorded
 * `schedule_missed`, never run late (GA-SCHED-2's rule, for a clock that jumped or a process that stalled).
 */
export const LATE_MS = 60_000;
/**
 * How long after its time a run whose `single` scenario was running is tried again (ruled 2026-10-05:
 * 5 minutes): once the grace closes with no start, the date is recorded missed.
 */
export const GRACE_MS = 300_000;
/** How often a waiting run is tried again: every 10 s. */
export const RETRY_MS = 10_000;
/** A timer is set at most this far ahead, and set again when it fires early, so no timer outgrows the platform's. */
const MAX_TIMER_MS = 86_400_000;

/** The marks a `define` sets (a schedule's new mark) and drops (a schedule deleted), written in its change set. */
export interface MarkChanges { set: [string, string][]; gone: string[] }

export interface ScheduleDeps {
  clock: Clock;
  store: Store;
  house(): House;
  /** Starts a run of the schedule's scenario: a step. */
  run(s: Schedule, o: Occurrence): void;
  /** Whether the schedule's scenario is running, so a start of it would be ignored (`single`). */
  busy(s: Schedule): boolean;
  /** Appends one of the steward's events. */
  event(type: "schedule_skipped" | "schedule_missed", body: Record<string, unknown>): void;
}

/** Writes a schedule's mark as handled through `mark`, unless a later one is kept: safe to run twice, and in any order. */
export function raiseMark(tx: Pick<Tx, "query">, id: string, mark: string): Promise<unknown> {
  return tx.query("INSERT INTO schedule_marks (schedule_id, mark) VALUES ($1, $2) ON CONFLICT (schedule_id) "
    + "DO UPDATE SET mark = GREATEST(schedule_marks.mark, EXCLUDED.mark)", [id, mark]);
}

/**
 * Writes that a schedule waits for its scenario to end, to run the date's run within the grace;
 * `marked`, a wait whose date is marked already (M10). Safe to run twice.
 */
export function keepPending(tx: Pick<Tx, "query">, id: string, o: Occurrence, marked = false): Promise<unknown> {
  return tx.query("INSERT INTO schedule_pending (schedule_id, date, at_ms, marked) VALUES ($1, $2, $3, $4) ON CONFLICT (schedule_id) "
    + "DO UPDATE SET date = EXCLUDED.date, at_ms = EXCLUDED.at_ms, marked = EXCLUDED.marked", [id, o.date, o.at, marked]);
}

/** Forgets a schedule's wait for `date`, if it is still that date's. Safe to run twice. */
export function dropPending(tx: Pick<Tx, "query">, id: string, date: string): Promise<unknown> {
  return tx.query("DELETE FROM schedule_pending WHERE schedule_id = $1 AND date = $2", [id, date]);
}

/**
 * Writes a `define`'s marks: each dropped gone, each set raised as `raiseMark` does, so a define that
 * commits as its schedule fires never puts an older mark back (the milestone 5+6 review, B4). Safe to
 * run twice.
 */
export async function saveMarks(tx: Pick<Tx, "query">, m: MarkChanges): Promise<void> {
  for (const id of m.gone) await tx.query("DELETE FROM schedule_marks WHERE schedule_id = $1", [id]);
  for (const [id, mark] of m.set) await raiseMark(tx, id, mark);
}

/**
 * The house's schedules at work (the design, *Schedules*): one clock timer each, to its next run past
 * its mark. At its time a run's date is marked first, then the run starts once the mark commits
 * (at most once: a crash between the two loses the run, never repeats it), or at once while the
 * store is known down, the mark written behind (ruled, Q6); a
 * skipped date is a `schedule_skipped` event.
 */
export class Schedules {
  private readonly marks = new Map<string, string>();
  /** The waits the store kept at start (`schedule_pending`), for `recover`; `marked`, one whose date is marked already. */
  private readonly pendingKept = new Map<string, { date: string; at: number; marked: boolean }>();
  private readonly armed = new Map<string, { timer: number; o?: Occurrence }>();
  /** Runs waiting for their `single` scenario to end, each tried again every `RETRY_MS` until its grace closes. */
  private readonly waiting = new Map<string, { timer: number; o: Occurrence; marked?: true }>();
  private stopped = false;

  constructor(private readonly d: ScheduleDeps) {}

  /** Reads the marks the store keeps. */
  async load(): Promise<void> {
    const rows = await this.d.store.query<{ schedule_id: string; mark: string }>("SELECT schedule_id, mark FROM schedule_marks");
    for (const r of rows.rows) this.marks.set(r.schedule_id, r.mark);
    const pending = await this.d.store.query<{ schedule_id: string; date: string; at_ms: string | number; marked: boolean }>(
      "SELECT schedule_id, date, at_ms, marked FROM schedule_pending");
    for (const r of pending.rows) this.pendingKept.set(r.schedule_id, { date: r.date, at: Number(r.at_ms), marked: r.marked === true });
  }

  /** A schedule's mark, as held in memory. */
  markOf(id: string): string | undefined {
    return this.marks.get(id);
  }

  /**
   * The marks the `define` that turns `before` into `after` sets at `now`: a schedule made or changed
   * (every schedule, when the home's timezone changed) takes `markAt`, so the change acts from its next
   * run and nothing before it is ever counted missed; a schedule deleted loses its mark.
   */
  marksFor(before: House, after: House, now: number): MarkChanges {
    const retimed = before.home.timezone !== after.home.timezone;
    const set: [string, string][] = [];
    for (const s of [...after.schedules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (!retimed && canonical(before.schedules.get(s.id) ?? null) === canonical(s)) continue;
      set.push([s.id, markAt(s, after.home.timezone, now, before.schedules.has(s.id) ? this.marks.get(s.id) : undefined)]);
    }
    const gone = [...before.schedules.keys()].filter((id) => !after.schedules.has(id)).sort();
    return { set, gone };
  }

  /**
   * At start, before the timers are set (GA-SCHED-2): every run of each schedule due since its mark is
   * not run late but recorded, a `schedule_missed` event each, a skipped date's `schedule_skipped`, at
   * most the latest `MISSED_KEPT`, the first carrying how many earlier ones were `earlier`; the mark
   * moved past them, committed before the timers are set, so a write lost to a crash never records the
   * same dates again (the milestone 5+6 review, M6). A schedule with no mark kept takes `markAt`, missing nothing. A run
   * that was waiting for its `single` scenario (`schedule_pending`) goes on waiting while its grace is
   * open, and once it has closed is recorded missed, `reason: scenario_running`; so does one whose date
   * was marked already (M10). The wait of a schedule deleted while the steward was down is forgotten.
   */
  async recover(): Promise<void> {
    const writes: Promise<void>[] = [];
    const now = Math.floor(this.d.clock.now());
    const tz = this.d.house().home.timezone;
    for (const [id, p] of [...this.pendingKept].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const s = this.d.house().schedules.get(id);
      if (s && p.marked) {
        this.pendingKept.delete(id);
        // Its date marked already: it waits on while its grace is open, else is recorded missed, once.
        const occ = occurrenceOn(s, p.date, tz);
        const o: Occurrence = { date: p.date, at: p.at, skipped: false, ...(occ?.moved ? { moved: true as const } : {}) };
        if (now - o.at < GRACE_MS && this.wait(id, o, true)) continue;
        // Its row forgotten first, both written behind in that order, so a crash between them never records the date twice (M2).
        writes.push(this.d.store.write((tx) => dropPending(tx, id, p.date).then(() => undefined)));
        this.d.event("schedule_missed", { schedule: id, scenario: s.scenario, date: o.date, at: new Date(o.at).toISOString(), reason: "scenario_running",
          cause: { schedule: id } });
        continue;
      } else if (s) continue;
      this.pendingKept.delete(id);
      writes.push(this.d.store.write((tx) => dropPending(tx, id, p.date).then(() => undefined)));
    }
    for (const s of [...this.d.house().schedules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const kept = this.marks.get(s.id);
      const due = kept === undefined ? { runs: [], earlier: 0 } : dueSince(s, tz, kept, now);
      // A run that waited for its scenario when the steward stopped goes on waiting while its grace is open.
      const p = this.pendingKept.get(s.id);
      const waits = p ? due.runs.find((o) => o.date === p.date && !o.skipped && now - o.at < GRACE_MS) : undefined;
      const runs = due.runs.filter((o) => o !== waits);
      runs.forEach((o, i) => this.d.event(o.skipped ? "schedule_skipped" : "schedule_missed", { schedule: s.id, scenario: s.scenario, date: o.date,
        at: new Date(o.at).toISOString(), ...(i === 0 && due.earlier ? { earlier: due.earlier } : {}),
        ...(!o.skipped && p?.date === o.date ? { reason: "scenario_running" } : {}), cause: { schedule: s.id } }));
      if (p && !waits) writes.push(this.d.store.write((tx) => dropPending(tx, s.id, p.date).then(() => undefined)));
      if (waits) this.wait(s.id, waits);
      const mark = runs.length ? runs[runs.length - 1]!.date : kept ?? markAt(s, tz, now);
      if (mark === kept) continue;
      this.marks.set(s.id, mark);
      writes.push(this.d.store.write((tx) => raiseMark(tx, s.id, mark).then(() => undefined)));
    }
    this.pendingKept.clear();
    // A store that stalls past the gate holds the start no longer: the marks are then written behind.
    await within(this.d.clock, GATE_MS, Promise.all(writes)).catch(() => undefined);
  }

  /**
   * Takes a committed `define`'s marks into memory, each the later of the define's and the one held,
   * which a timer that fired while the define committed may have raised (B4); `arm` sets the timers.
   */
  adopt(m: MarkChanges): void {
    for (const id of m.gone) this.marks.delete(id);
    for (const [id, mark] of m.set) {
      const held = this.marks.get(id);
      this.marks.set(id, held !== undefined && held > mark ? held : mark);
    }
  }

  /** Sets every schedule's timer again, from the model and the clock as they are now. */
  arm(): void {
    for (const a of this.armed.values()) this.d.clock.clear(a.timer);
    this.armed.clear();
    if (this.stopped) return;
    for (const s of this.d.house().schedules.values()) this.armOne(s);
  }

  stop(): void {
    this.stopped = true;
    for (const a of [...this.armed.values(), ...this.waiting.values()]) this.d.clock.clear(a.timer);
    this.armed.clear();
    this.waiting.clear();
  }

  private armOne(s: Schedule): void {
    const old = this.armed.get(s.id);
    if (old) this.d.clock.clear(old.timer);
    const now = Math.floor(this.d.clock.now());
    const o = nextOccurrence(s, this.d.house().home.timezone, now, this.marks.get(s.id));
    const timer = this.d.clock.setTimeout(() => this.fire(s.id), o ? Math.min(Math.max(0, o.at - now), MAX_TIMER_MS) : MAX_TIMER_MS);
    this.armed.set(s.id, { timer, ...(o ? { o } : {}) });
  }

  /** A step: a schedule's timer. */
  private fire(id: string): void {
    const a = this.armed.get(id);
    this.armed.delete(id);
    const s = this.d.house().schedules.get(id);
    if (this.stopped || !s) return;
    const now = Math.floor(this.d.clock.now());
    let o = a?.o;
    const mark = this.marks.get(id);
    if (!o || now < o.at || (mark !== undefined && o.date <= mark)) return this.armOne(s);
    // A timer that fired late (a stalled host, a clock that jumped): every date since the mark whose
    // time is more than `LATE_MS` past is not run but recorded, as `recover` records them, a skipped
    // one `schedule_skipped` (the milestone 5+6 review, M1, M2); a run still within it goes on.
    const due = mark !== undefined ? dueSince(s, this.d.house().home.timezone, mark, now) : { runs: [o], earlier: 0 };
    const runs = due.runs.length ? due.runs : [o];
    const late = runs.filter((x) => now - x.at > LATE_MS);
    late.forEach((x, i) => this.d.event(x.skipped ? "schedule_skipped" : "schedule_missed", { schedule: id, scenario: s.scenario, date: x.date,
      at: new Date(x.at).toISOString(), ...(i === 0 && due.earlier ? { earlier: due.earlier } : {}), cause: { schedule: id } }));
    const current = runs.find((x) => now - x.at <= LATE_MS);
    if (late.length) this.markDone(id, late[late.length - 1]!);
    if (!current) return this.armOne(s);
    o = current;
    const body = { schedule: id, scenario: s.scenario, date: o.date, at: new Date(o.at).toISOString(), cause: { schedule: id } };
    if (!o.skipped && this.d.busy(s)) {
      // Its scenario runs: the date is not marked; the run waits, tried again, until the grace closes (ruled).
      void this.d.store.write((tx) => keepPending(tx, id, o!).then(() => undefined));
      this.armOne(s);
      if (!this.wait(id, o)) this.missedRunning(s, o);
      return;
    }
    const written = this.markDone(id, o);
    this.armOne(s);
    if (o.skipped) return this.d.event("schedule_skipped", body);
    this.start(id, o, written);
  }

  /** Marks the date handled, in memory and then in the store, its wait forgotten with it; the write. */
  private markDone(id: string, o: Occurrence): Promise<void> {
    this.marks.set(id, o.date);
    return this.d.store.write(async (tx) => {
      await raiseMark(tx, id, o.date);
      await dropPending(tx, id, o.date);
    });
  }

  /** Starts the date's run once its mark commits; a store that stalls past the gate holds it no longer, one known down not at all (Q6). */
  private start(id: string, o: Occurrence, written: Promise<void>): void {
    const s = this.d.house().schedules.get(id);
    if (!s) return;
    if (this.d.store.down) return this.d.run(s, o);
    void within(this.d.clock, GATE_MS, written).catch(() => undefined).then(() => {
      const now = this.d.house().schedules.get(id);
      if (this.stopped || !now) return;
      // Its scenario started by another while the mark committed: it goes back to waiting, its date
      // marked already, until the grace closes (the milestone 5+6 review, M10); the wait is kept, marked,
      // so a restart inside the grace goes on with it (GA-PERSIST-2).
      if (this.d.busy(now)) {
        if (!this.wait(id, o, true)) this.missedRunning(now, o);
        else void this.d.store.write((tx) => keepPending(tx, id, o, true).then(() => undefined));
        return;
      }
      this.d.run(now, o);
    });
  }

  /**
   * Waits for a run's scenario to end, trying again every `RETRY_MS`, and once more as the grace after
   * its time closes, when `retry` records it missed (the milestone 5+6 review, B2); false when the
   * grace has closed already.
   */
  private wait(id: string, o: Occurrence, marked = false): boolean {
    const old = this.waiting.get(id);
    if (old) this.d.clock.clear(old.timer);
    this.waiting.delete(id);
    const next = Math.min(RETRY_MS, o.at + GRACE_MS - Math.floor(this.d.clock.now()));
    if (next <= 0) return false;
    this.waiting.set(id, { o, timer: this.d.clock.setTimeout(() => this.retry(id), next), ...(marked ? { marked: true as const } : {}) });
    return true;
  }

  /** The grace after a run's time closed while its scenario ran: the date marked and recorded missed. */
  private missedRunning(s: Schedule, o: Occurrence): void {
    this.markDone(s.id, o);
    this.d.event("schedule_missed", { schedule: s.id, scenario: s.scenario, date: o.date, at: new Date(o.at).toISOString(), reason: "scenario_running",
      cause: { schedule: s.id } });
  }

  /**
   * A step: a waiting run tried again. Its scenario ended: the date is marked and the run started.
   * Its grace closed: the date is marked and recorded `schedule_missed`, `reason: scenario_running`.
   * The schedule deleted, or its date marked meanwhile (a change to it acts from its next run): forgotten.
   */
  private retry(id: string): void {
    const w = this.waiting.get(id);
    this.waiting.delete(id);
    if (this.stopped || !w) return;
    const { o } = w;
    const s = this.d.house().schedules.get(id);
    const mark = this.marks.get(id);
    if (!s || (!w.marked && mark !== undefined && o.date <= mark)) {
      void this.d.store.write((tx) => dropPending(tx, id, o.date).then(() => undefined));
      return;
    }
    // The grace first: a retry that fires after it has closed (a late wait, a stalled host) starts nothing (B2).
    if (Math.floor(this.d.clock.now()) - o.at >= GRACE_MS) return this.missedRunning(s, o);
    if (!this.d.busy(s)) return this.start(id, o, this.markDone(id, o));
    if (!this.wait(id, o, w.marked === true)) this.missedRunning(s, o);
  }
}
