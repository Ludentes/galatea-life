import { describe, expect, it } from "vitest";
import type { Reading } from "../src/house/model.js";
import { conditionsHold, readingHolds, type DeviceRead, type View } from "../src/rules/conditions.js";
import { instantOf, nextTime, windowBoundary, windowHolds } from "../src/rules/window.js";

const MSK = "Europe/Moscow";
const BERLIN = "Europe/Berlin";
const at = (iso: string) => Date.parse(iso);

describe("time windows (GA-RULE-3)", () => {
  // 2030-01-06 is a Sunday.
  const LIMIT = { from: "21:00", until: "07:00", days: [7, 1, 2, 3, 4] };

  it("holds from from up to, not including, until, the next day when until is not later", () => {
    expect(windowHolds(LIMIT, at("2030-01-06T20:59:00+03:00"), MSK)).toBe(false);
    expect(windowHolds(LIMIT, at("2030-01-06T21:00:00+03:00"), MSK)).toBe(true);
    expect(windowHolds(LIMIT, at("2030-01-07T06:59:00+03:00"), MSK)).toBe(true);
    expect(windowHolds(LIMIT, at("2030-01-07T07:00:00+03:00"), MSK)).toBe(false);
    const day = { from: "09:00", until: "17:00" };
    expect(windowHolds(day, at("2030-01-08T08:59:00+03:00"), MSK)).toBe(false);
    expect(windowHolds(day, at("2030-01-08T12:00:00+03:00"), MSK)).toBe(true);
    expect(windowHolds(day, at("2030-01-08T17:00:00+03:00"), MSK)).toBe(false);
  });

  it("names by days the day a window starts: Sunday to Thursday 21:00–07:00 runs Sunday evening to Friday morning", () => {
    expect(windowHolds(LIMIT, at("2030-01-05T22:00:00+03:00"), MSK)).toBe(false); // Saturday evening
    expect(windowHolds(LIMIT, at("2030-01-06T05:00:00+03:00"), MSK)).toBe(false); // Sunday morning
    expect(windowHolds(LIMIT, at("2030-01-11T05:00:00+03:00"), MSK)).toBe(true); // Friday morning
    expect(windowHolds(LIMIT, at("2030-01-11T22:00:00+03:00"), MSK)).toBe(false); // Friday evening
  });

  it("reads days as the day a window ends under window-on-the-end-day: Saturday evening to Thursday morning", () => {
    const m = "window-on-the-end-day" as const;
    expect(windowHolds(LIMIT, at("2030-01-05T22:00:00+03:00"), MSK, m)).toBe(true);
    expect(windowHolds(LIMIT, at("2030-01-11T05:00:00+03:00"), MSK, m)).toBe(false);
    expect(windowHolds({ from: "09:00", until: "17:00", days: [2] }, at("2030-01-08T12:00:00+03:00"), MSK, m)).toBe(true);
  });

  it("takes the first minute after a time in a daylight-saving gap, and the first occurrence of one that occurs twice", () => {
    // Berlin: 2030-03-31 02:00 → 03:00; 2030-10-27 03:00 → 02:00.
    expect(new Date(instantOf({ y: 2030, m: 3, d: 31 }, "02:30", BERLIN)).toISOString()).toBe("2030-03-31T01:00:00.000Z");
    expect(new Date(instantOf({ y: 2030, m: 10, d: 27 }, "02:30", BERLIN)).toISOString()).toBe("2030-10-27T00:30:00.000Z");
    expect(new Date(instantOf({ y: 2030, m: 1, d: 6 }, "21:00", MSK)).toISOString()).toBe("2030-01-06T18:00:00.000Z");
    const gap = { from: "02:30", until: "04:00" };
    expect(windowHolds(gap, at("2030-03-31T00:59:00Z"), BERLIN)).toBe(false);
    expect(windowHolds(gap, at("2030-03-31T01:00:00Z"), BERLIN)).toBe(true);
    const twice = { from: "01:00", until: "02:30" };
    expect(windowHolds(twice, at("2030-10-27T00:29:00Z"), BERLIN)).toBe(true);
    expect(windowHolds(twice, at("2030-10-27T00:30:00Z"), BERLIN)).toBe(false);
    expect(windowHolds(twice, at("2030-10-27T01:15:00Z"), BERLIN)).toBe(false);
  });

  it("gives the next boundary, a start or an end, and the next time of a time trigger", () => {
    expect(new Date(windowBoundary(LIMIT, at("2030-01-06T12:00:00+03:00"), MSK)!).toISOString()).toBe("2030-01-06T18:00:00.000Z");
    expect(new Date(windowBoundary(LIMIT, at("2030-01-06T21:00:00+03:00"), MSK)!).toISOString()).toBe("2030-01-07T04:00:00.000Z");
    expect(new Date(windowBoundary(LIMIT, at("2030-01-11T07:00:00+03:00"), MSK)!).toISOString()).toBe("2030-01-13T18:00:00.000Z");
    expect(new Date(nextTime("07:30", [1], at("2030-01-06T12:00:00+03:00"), MSK)!).toISOString()).toBe("2030-01-07T04:30:00.000Z");
    expect(new Date(nextTime("07:30", undefined, at("2030-01-07T07:30:00+03:00"), MSK)!).toISOString()).toBe("2030-01-08T04:30:00.000Z");
  });
});

describe("readings (GA-RULE-2, GA-RULE-4)", () => {
  const LAPTOP = "sim-bridge:laptop";
  const values: Record<string, { value: unknown; assumed?: boolean }> = { "session.liza": { value: "active" }, "session.gone": { value: "active" },
    on: { value: true }, level: { value: 40 }, mode: { value: "cool", assumed: true }, unk: { value: "unknown" } };
  const device = (o: Partial<DeviceRead> = {}): DeviceRead => ({ live: true, value: (k) => (values[k] ? { value: values[k]!.value, assumed: values[k]!.assumed ?? false } : undefined),
    retired: (k) => k === "session.gone", ...o });
  const view = (d: DeviceRead | undefined = device(), mutation?: View["mutation"]): View => ({ device: () => d, now: 0, tz: MSK, mutation });
  const r = (x: Partial<Reading>): Reading => ({ target: LAPTOP, key: "on", op: "eq", value: true, ...x });
  const notIn = (key: string) => ({ target: LAPTOP, key, not_in: ["locked", "disconnected", "none"] });

  it("compares a value with op: eq and ne by value, an order between numbers only, never on an absent key", () => {
    expect(readingHolds(r({}), view())).toBe(true);
    expect(readingHolds(r({ op: "ne", value: false }), view())).toBe(true);
    expect(readingHolds(r({ key: "level", op: "ge", value: 40 }), view())).toBe(true);
    expect(readingHolds(r({ key: "level", op: "gt", value: 40 }), view())).toBe(false);
    expect(readingHolds(r({ key: "on", op: "gt", value: 0 }), view())).toBe(false);
    expect(readingHolds(r({ key: "absent", op: "ne", value: 1 }), view())).toBe(false);
  });

  it("reads not_in true when the key reads none of its values, unknown and an absent key included, and false under not-in-skips-unknown", () => {
    expect(readingHolds(notIn("session.liza"), view())).toBe(true);
    expect(readingHolds(notIn("unk"), view())).toBe(true);
    expect(readingHolds({ ...notIn("unk"), not_in: ["unknown"] }, view())).toBe(false);
    expect(readingHolds(notIn("session.absent"), view())).toBe(true);
    expect(readingHolds(notIn("unk"), view(device(), "not-in-skips-unknown"))).toBe(false);
    expect(readingHolds(notIn("session.absent"), view(device(), "not-in-skips-unknown"))).toBe(false);
    expect(readingHolds(notIn("session.liza"), view(device(), "not-in-skips-unknown"))).toBe(true);
  });

  it("reads a retired account's key false, not_in included, and as absent under fires-on-a-retired-token", () => {
    expect(readingHolds(notIn("session.gone"), view())).toBe(false);
    expect(readingHolds(r({ key: "session.gone", op: "eq", value: "active" }), view())).toBe(false);
    expect(readingHolds(notIn("session.gone"), view(device(), "fires-on-a-retired-token"))).toBe(true);
  });

  it("never holds on an assumed value, but under rule-on-an-assumed-value", () => {
    expect(readingHolds(r({ key: "mode", value: "cool" }), view())).toBe(false);
    expect(readingHolds({ target: LAPTOP, key: "mode", not_in: ["heat"] }, view())).toBe(false);
    expect(readingHolds(r({ key: "mode", value: "cool" }), view(device(), "rule-on-an-assumed-value"))).toBe(true);
  });

  it("never holds on a device that is not live, nor one the applier does not describe, but under rule-on-stale-reading", () => {
    expect(readingHolds(r({}), view(device({ live: false })))).toBe(false);
    expect(readingHolds(notIn("session.liza"), view(device({ live: false })))).toBe(false);
    expect(readingHolds(r({}), { ...view(), device: () => undefined })).toBe(false);
    expect(readingHolds(r({}), view(device({ live: false }), "rule-on-stale-reading"))).toBe(true);
  });

  it("takes conditions whole: every one holds, a window among them", () => {
    const v = { ...view(), now: at("2030-01-06T22:00:00+03:00") };
    expect(conditionsHold([r({}), { between: { from: "21:00", until: "07:00" } }], v)).toBe(true);
    expect(conditionsHold([r({}), { between: { from: "08:00", until: "20:00" } }], v)).toBe(false);
    expect(conditionsHold([r({}), r({ key: "level", op: "lt", value: 10 })], v)).toBe(false);
    expect(conditionsHold(undefined, v)).toBe(true);
  });
});
