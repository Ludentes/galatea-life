import type { Mutation } from "../mutations.js";
import type { Window } from "../house/model.js";

const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

/** A local date, as the home's timezone has it. */
export interface LocalDate { y: number; m: number; d: number }

function format(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric" });
    formats.set(tz, f);
  }
  return f;
}

/** The wall time at instant `t` in `tz`, as if it were UTC, to the second. */
function wallMs(t: number, tz: string): number {
  const p = Object.fromEntries(format(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The date of instant `t` in `tz`. */
export function localDate(t: number, tz: string): LocalDate {
  const w = new Date(wallMs(t, tz));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

export function addDays(x: LocalDate, n: number): LocalDate {
  const w = new Date(Date.UTC(x.y, x.m - 1, x.d) + n * DAY_MS);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

/** A date's ISO weekday: Monday 1 to Sunday 7. */
export function weekday(x: LocalDate): number {
  return ((new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay() + 6) % 7) + 1;
}

/**
 * The instant at which the wall clock in `tz` reads `hhmm` on date `x` (GA-RULE-3): its first
 * occurrence when it occurs twice; in a daylight-saving gap, where it never occurs, the first minute
 * after it, the instant the clock jumps.
 */
export function instantOf(x: LocalDate, hhmm: string, tz: string): number {
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(x.y, x.m - 1, x.d, h!, mi!);
  const offset = (t: number) => wallMs(t, tz) - Math.floor(t / 1000) * 1000;
  const candidates = [...new Set([wall - offset(wall - DAY_MS), wall - offset(wall + DAY_MS)])]
    .filter((c) => wallMs(c, tz) === wall).sort((a, b) => a - b);
  if (candidates.length) return candidates[0]!;
  // A gap: the first minute whose wall time passes `hhmm`, found between the two offsets' readings.
  let lo = Math.min(wall - offset(wall - DAY_MS), wall - offset(wall + DAY_MS));
  let hi = Math.max(wall - offset(wall - DAY_MS), wall - offset(wall + DAY_MS));
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
    if (wallMs(mid, tz) >= wall) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The window's occurrence that starts on date `x`, or none when `days` leaves the date out: from `from`
 * up to, not including, `until`, the same day when `until` is later, the next day otherwise.
 * `window-on-the-end-day` reads `days` as the day an occurrence ends.
 */
function occurrence(w: Window, x: LocalDate, tz: string, mutation?: Mutation): { start: number; end: number } | undefined {
  const overnight = w.until <= w.from;
  const named = mutation === "window-on-the-end-day" ? addDays(x, overnight ? 1 : 0) : x;
  if (w.days && !w.days.includes(weekday(named))) return undefined;
  return { start: instantOf(x, w.from, tz), end: instantOf(overnight ? addDays(x, 1) : x, w.until, tz) };
}

/** Whether the window holds at instant `now` (GA-RULE-3). */
export function windowHolds(w: Window, now: number, tz: string, mutation?: Mutation): boolean {
  const today = localDate(now, tz);
  return [addDays(today, -1), today].some((x) => {
    const o = occurrence(w, x, tz, mutation);
    return o !== undefined && o.start <= now && now < o.end;
  });
}

/** The next instant after `now` at which the window starts or ends, or undefined when none within eight days. */
export function windowBoundary(w: Window, now: number, tz: string, mutation?: Mutation): number | undefined {
  const today = localDate(now, tz);
  let next: number | undefined;
  for (let i = -1; i <= 8; i++) {
    const o = occurrence(w, addDays(today, i), tz, mutation);
    for (const t of o ? [o.start, o.end] : []) if (t > now && (next === undefined || t < next)) next = t;
  }
  return next;
}

/** The next instant after `now` of a time trigger `at` on `days` (every day when absent). */
export function nextTime(at: string, days: number[] | undefined, now: number, tz: string): number | undefined {
  const today = localDate(now, tz);
  let next: number | undefined;
  for (let i = 0; i <= 8; i++) {
    const x = addDays(today, i);
    if (days && !days.includes(weekday(x))) continue;
    const t = instantOf(x, at, tz);
    if (t > now && (next === undefined || t < next)) next = t;
  }
  return next;
}
