import type { Schedule } from "../house/model.js";
import { addDays, instantOf, localDate, weekday, type LocalDate } from "../rules/window.js";

/**
 * The schedules' decision core (the design, *Schedules*): pure, given the clock's now, the
 * home's timezone, a schedule and its mark. A schedule has at most one run a date; its **mark** is the
 * latest date (`YYYY-MM-DD` in the home's timezone) whose run is handled (run, skipped or recorded
 * missed), so a date is never run twice, though its run is moved later after it ran.
 */

/** One date's run of a schedule: when, and whether its exception skips it or moved it. */
export interface Occurrence { date: string; at: number; skipped: boolean; moved?: true }

/** The most runs missed in one absence that are recorded one by one; the earlier ones are counted. */
export const MISSED_KEPT = 64;
/** How far back an absence is looked at: a run missed earlier than this is not counted. */
const LOOK_BACK_DAYS = 366;
/** How far ahead the next run is looked for: a schedule of any day has one within a week. */
const LOOK_AHEAD_DAYS = 8;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
/** A local date as `YYYY-MM-DD`. */
export const dateOf = (x: LocalDate): string => `${pad(x.y, 4)}-${pad(x.m)}-${pad(x.d)}`;
const parse = (date: string): LocalDate => {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
};

/**
 * The schedule's run on `date`, or none when its `days` leave the date out: its time on that date, or
 * the time its exception moves it to, or its time marked skipped (GA-SCHED-1). A time a daylight-saving
 * gap leaves out is the first minute after the gap, and one that occurs twice its first occurrence
 * (GA-SCHED-3, `instantOf`).
 */
export function occurrenceOn(s: Schedule, date: string, tz: string): Occurrence | undefined {
  const x = parse(date);
  if (s.days && !s.days.includes(weekday(x))) return undefined;
  const ex = s.exceptions.find((e) => e.date === date);
  if (ex?.action === "move" && ex.time) return { date, at: instantOf(x, ex.time, tz), skipped: false, moved: true };
  return { date, at: instantOf(x, s.time, tz), skipped: ex?.action === "skip" };
}

/** The schedule's next run: the first after `now`, on a date past `mark`; none when it has no day in the next eight. */
export function nextOccurrence(s: Schedule, tz: string, now: number, mark: string | undefined): Occurrence | undefined {
  const today = localDate(now, tz);
  let next: Occurrence | undefined;
  for (let i = -1; i <= LOOK_AHEAD_DAYS; i++) {
    const date = dateOf(addDays(today, i));
    if (mark !== undefined && date <= mark) continue;
    const o = occurrenceOn(s, date, tz);
    if (o && o.at > now && (!next || o.at < next.at)) next = o;
  }
  return next;
}

/**
 * The mark a schedule takes when it is defined or changed, so a change takes effect from the next run
 * after it and no run it would have had before is ever counted missed: today once today's run is past
 * or today has none, otherwise yesterday; never earlier than the mark it had.
 */
export function markAt(s: Schedule, tz: string, now: number, mark?: string): string {
  const today = localDate(now, tz);
  const o = occurrenceOn(s, dateOf(today), tz);
  const at = !o || o.at <= now ? dateOf(today) : dateOf(addDays(today, -1));
  return mark !== undefined && mark > at ? mark : at;
}

/**
 * The runs due since `mark` (exclusive) up to `now` (inclusive), oldest first: the runs a steward that
 * was down missed (GA-SCHED-2), a skipped one marked so. At most the latest `MISSED_KEPT`, the earlier
 * ones counted in `earlier`; an absence is looked at over its last `LOOK_BACK_DAYS` days.
 */
export function dueSince(s: Schedule, tz: string, mark: string, now: number): { runs: Occurrence[]; earlier: number } {
  const today = localDate(now, tz);
  const runs: Occurrence[] = [];
  for (let i = -LOOK_BACK_DAYS; i <= 0; i++) {
    const date = dateOf(addDays(today, i));
    if (date <= mark) continue;
    const o = occurrenceOn(s, date, tz);
    if (o && o.at <= now) runs.push(o);
  }
  const earlier = Math.max(0, runs.length - MISSED_KEPT);
  return { runs: runs.slice(earlier), earlier };
}
