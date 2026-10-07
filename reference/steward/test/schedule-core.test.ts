import { describe, expect, it } from "vitest";
import type { Schedule } from "../src/house/model.js";
import { dueSince, markAt, nextOccurrence, occurrenceOn } from "../src/schedules/core.js";

const BERLIN = "Europe/Berlin";
const MOSCOW = "Europe/Moscow";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const sched = (time: string, extra: Partial<Schedule> = {}): Schedule => ({ id: "s", scenario: "night", time, exceptions: [], ...extra });

describe("a schedule's occurrence on a date", () => {
  it("is its time on that date in the home's timezone, none on a day it leaves out", () => {
    // 2030-01-06 is a Sunday.
    expect(iso(occurrenceOn(sched("22:30"), "2030-01-06", MOSCOW)?.at)).toBe("2030-01-06T19:30:00.000Z");
    expect(occurrenceOn(sched("22:30", { days: [1, 2, 3, 4, 5] }), "2030-01-06", MOSCOW)).toBeUndefined();
    expect(occurrenceOn(sched("22:30", { days: [7] }), "2030-01-06", MOSCOW)?.date).toBe("2030-01-06");
  });

  it("is skipped, or moved to another time that date, by the date's exception (GA-SCHED-1)", () => {
    const s = sched("07:00", { exceptions: [{ date: "2030-01-07", action: "skip" }, { date: "2030-01-08", action: "move", time: "09:15" }] });
    expect(occurrenceOn(s, "2030-01-07", MOSCOW)).toEqual({ date: "2030-01-07", at: at("2030-01-07T04:00:00Z"), skipped: true });
    expect(occurrenceOn(s, "2030-01-08", MOSCOW)).toEqual({ date: "2030-01-08", at: at("2030-01-08T06:15:00Z"), skipped: false, moved: true });
    expect(occurrenceOn(s, "2030-01-09", MOSCOW)).toEqual({ date: "2030-01-09", at: at("2030-01-09T04:00:00Z"), skipped: false });
  });

  it("takes the first minute after a time a daylight-saving gap leaves out, and the first of a time that occurs twice (GA-SCHED-3)", () => {
    // Berlin: 2030-03-31 02:00 CET jumps to 03:00 CEST; 2030-10-27 03:00 CEST falls back to 02:00 CET.
    expect(iso(occurrenceOn(sched("02:30"), "2030-03-31", BERLIN)?.at)).toBe("2030-03-31T01:00:00.000Z");
    expect(iso(occurrenceOn(sched("02:30"), "2030-10-27", BERLIN)?.at)).toBe("2030-10-27T00:30:00.000Z");
    // A move into the gap is moved on as well.
    const moved = sched("06:00", { exceptions: [{ date: "2030-03-31", action: "move", time: "02:10" }] });
    expect(iso(occurrenceOn(moved, "2030-03-31", BERLIN)?.at)).toBe("2030-03-31T01:00:00.000Z");
  });
});

describe("a schedule's next run", () => {
  it("is the first occurrence after now on a date past the mark", () => {
    const s = sched("07:00", { days: [1, 2, 3, 4, 5] });
    // Tuesday 2030-01-01 11:00 Moscow: today's 07:00 is past, so Wednesday's.
    expect(nextOccurrence(s, MOSCOW, at("2030-01-01T08:00:00Z"), "2029-12-31")?.date).toBe("2030-01-02");
    // Friday evening: Monday's.
    expect(nextOccurrence(s, MOSCOW, at("2030-01-04T18:00:00Z"), "2030-01-04")?.date).toBe("2030-01-07");
    // A date marked already is never run again, though its run was moved later.
    const later = sched("07:00", { exceptions: [{ date: "2030-01-01", action: "move", time: "23:00" }] });
    expect(nextOccurrence(later, MOSCOW, at("2030-01-01T08:00:00Z"), "2030-01-01")?.date).toBe("2030-01-02");
    expect(nextOccurrence(later, MOSCOW, at("2030-01-01T08:00:00Z"), "2029-12-31")?.date).toBe("2030-01-01");
  });

  it("runs a time that occurs twice once: after its first occurrence the next is the next day's (GA-SCHED-3)", () => {
    const s = sched("02:30");
    const first = nextOccurrence(s, BERLIN, at("2030-10-27T00:00:00Z"), "2030-10-26")!;
    expect(iso(first.at)).toBe("2030-10-27T00:30:00.000Z");
    // Marked at its first occurrence; at the second 02:30 (01:30Z) the next run is the 28th's.
    expect(iso(nextOccurrence(s, BERLIN, at("2030-10-27T01:29:00Z"), first.date)?.at)).toBe("2030-10-28T01:30:00.000Z");
  });

  it("is none for a schedule of no day within the next eight", () => {
    expect(nextOccurrence(sched("07:00", { days: [] as number[] }), MOSCOW, at("2030-01-01T08:00:00Z"), "2030-01-01")).toBeUndefined();
  });
});

describe("the mark a schedule takes when it is defined", () => {
  it("is today once today's occurrence is past, or today has none; otherwise yesterday; never earlier than the mark it had", () => {
    const now = at("2030-01-01T08:00:00Z"); // 11:00 in Moscow, a Tuesday.
    expect(markAt(sched("07:00"), MOSCOW, now)).toBe("2030-01-01");
    expect(markAt(sched("12:00"), MOSCOW, now)).toBe("2029-12-31");
    expect(markAt(sched("12:00", { days: [3] }), MOSCOW, now)).toBe("2030-01-01");
    expect(markAt(sched("12:00"), MOSCOW, now, "2030-01-01")).toBe("2030-01-01");
  });
});

describe("the runs due since a mark", () => {
  it("lists each occurrence on a date past the mark that is not after now, a skipped one marked, oldest first", () => {
    const s = sched("07:00", { exceptions: [{ date: "2030-01-03", action: "skip" }] });
    const due = dueSince(s, MOSCOW, "2030-01-01", at("2030-01-04T05:00:00Z"));
    expect(due.earlier).toBe(0);
    expect(due.runs.map((o) => [o.date, iso(o.at), o.skipped])).toEqual([
      ["2030-01-02", "2030-01-02T04:00:00.000Z", false], ["2030-01-03", "2030-01-03T04:00:00.000Z", true], ["2030-01-04", "2030-01-04T04:00:00.000Z", false]]);
    expect(dueSince(s, MOSCOW, "2030-01-04", at("2030-01-04T05:00:00Z")).runs).toEqual([]);
  });

  it("keeps the latest 64 of a long absence, counting the earlier ones", () => {
    const due = dueSince(sched("07:00"), MOSCOW, "2029-01-01", at("2030-01-01T05:00:00Z"));
    expect(due.runs.length).toBe(64);
    expect(due.runs.at(-1)!.date).toBe("2030-01-01");
    expect(due.earlier).toBe(365 - 64);
  });
});
