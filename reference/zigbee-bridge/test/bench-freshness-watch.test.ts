import { describe, expect, it } from "vitest";
// @ts-expect-error: the bench's script is plain JavaScript, outside the build.
import { sample, summarise } from "../bench/freshness-watch.mjs";

/** The bench's freshness watch (plan 5b): what it makes of the statuses it reads. */
describe("the bench's freshness watch", () => {
  const at = (s: number) => new Date(Date.parse("2026-10-07T00:00:00.000Z") + s * 1000).toISOString();
  const entry = (id: string, lastCheckIn: number | null, observable: boolean, bound: number | null = 7_200_000) =>
    ({ id, basis: "report", cadenceMs: null, basisMaxAgeMs: bound, lastCheckIn: lastCheckIn === null ? null : at(lastCheckIn), observable });

  it("takes a roster entry as a sample, named by the model the devices document gave", () => {
    expect(sample({ publishedAt: at(10) }, entry("sensor", 5, true), new Map([["sensor", "_TZ3000_fkxmyics/TS0210"]])))
      .toEqual({ at: at(10), id: "sensor", model: "_TZ3000_fkxmyics/TS0210", basis: "report", cadenceMs: null, basisMaxAgeMs: 7_200_000,
        lastCheckIn: at(5), observable: true });
  });

  it("counts distinct check-ins, the longest and median gaps, the time not observable, and whether every gap fit the bound", () => {
    const statuses = [
      [0, entry("sensor", null, false)], [10, entry("sensor", 5, true)], [20, entry("sensor", 5, true)],
      [3_610, entry("sensor", 3_605, true)], [7_220, entry("sensor", 7_215, true)], [16_000, entry("sensor", 7_215, false)],
      [16_010, entry("sensor", 16_005, true)],
    ] as const;
    const samples = statuses.map(([t, e]) => sample({ publishedAt: at(t) }, e, new Map()));
    expect(summarise(samples)).toEqual([{ id: "sensor", model: null, basis: "report", cadenceMs: null, basisMaxAgeMs: 7_200_000,
      from: at(0), to: at(16_010), checkIns: 4, longestGapS: 8_790, medianGapS: 3_610, unobservableS: 20, withinBound: false }]);
  });

  it("says nothing of a bound for a device with none, or with fewer than two check-ins", () => {
    const one = summarise([sample({ publishedAt: at(0) }, entry("probe", 0, false, null), new Map())]);
    expect(one[0]).toMatchObject({ checkIns: 1, longestGapS: null, withinBound: null, unobservableS: 0 });
  });
});
