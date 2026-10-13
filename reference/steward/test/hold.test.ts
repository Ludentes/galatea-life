import { describe, expect, it } from "vitest";
import { occupancyOf, type Sensor } from "../src/gate/occupancy.js";
import { HOLD_DEFAULTS, type HoldPolicy } from "../src/house/model.js";
import { directionOf, directionOfChange, judgeHold, shiftHold, vacantFrom, type HoldState, type RoomNow } from "../src/leases/hold.js";

const S = 1000;
const P: HoldPolicy = { ...HOLD_DEFAULTS, vacant_ends: false };
const hall = (o: Partial<RoomNow> = {}): RoomNow => ({ room: "hall", sources: ["m"], adopted: ["m"], busy: false, occupancy: "unknown", ...o });
const hold = (o: Partial<HoldState> = {}): HoldState => ({ kind: "person", direction: "on", changeMs: 0, quietFromMs: 0, floorMs: null,
  fixedFromMs: 0, vacantAtChange: false, seenNotVacant: false, room: "hall", sources: ["m"], adopted: ["m"], ...o });

describe("directions (GA-LEASE-7)", () => {
  it("an apply's from what its action sets, toggles being other; an outside change's from what changed", () => {
    expect(directionOf("onoff.turn_on")).toBe("on");
    expect(directionOf("onoff.turn_off")).toBe("off");
    expect(directionOf("onoff.turn_off", { toggles: true })).toBe("other");
    expect(directionOf("climate.set_mode")).toBe("other");
    expect(directionOf("level.set_level")).toBe("other");
    expect(directionOf("org.galatea.test.push.off", { confirmed_by: { key: "on", value: false } })).toBe("off");
    expect(directionOf("org.galatea.test.push.mode", { confirmed_by: { key: "on", value: { arg: "on" } } })).toBe("other");
    expect(directionOfChange("on", true, false)).toBe("on");
    expect(directionOfChange("on", false, true)).toBe("off");
    expect(directionOfChange("on", true, true)).toBe("other");
    expect(directionOfChange("level", 40, 20)).toBe("other");
  });
});

describe("judgeHold (GA-LEASE-7)", () => {
  it("ends once the room has been quiet for the change's window, from the later of the change and the last quiet", () => {
    const early = judgeHold(hold(), P, hall(), 3599 * S);
    expect(early).toMatchObject({ expiresMs: 3600 * S });
    expect(early.end).toBeUndefined();
    expect(judgeHold(hold(), P, hall(), 3600 * S).end).toEqual({ why: "quiet", atMs: 3600 * S });
    // busy from 1000 s: no end, expires now plus the window, moving
    const busy = judgeHold(hold(), P, hall({ busy: true }), 1000 * S);
    expect(busy).toMatchObject({ expiresMs: 4600 * S, state: { quietFromMs: null } });
    expect(busy.end).toBeUndefined();
    // quiet again at 2000 s: quiet_since 2000 s, ends at 5600 s
    const again = judgeHold(busy.state, P, hall(), 2000 * S);
    expect(again.state).toMatchObject({ quietFromMs: 2000 * S, quietSinceMs: 2000 * S });
    expect(judgeHold(again.state, P, hall(), 5600 * S).end).toEqual({ why: "quiet", atMs: 5600 * S });
  });

  it("holds an off change off_s and any other other_s", () => {
    expect(judgeHold(hold({ direction: "off" }), P, hall(), 599 * S).end).toBeUndefined();
    expect(judgeHold(hold({ direction: "off" }), P, hall(), 600 * S).end?.why).toBe("quiet");
    expect(judgeHold(hold({ direction: "other" }), { ...P, other_s: 900 }, hall(), 899 * S).end).toBeUndefined();
    expect(judgeHold(hold({ direction: "other" }), { ...P, other_s: 900 }, hall(), 900 * S).end).toEqual({ why: "quiet", atMs: 900 * S });
  });

  it("takes fixed_s from its anchor with no room, or no live source, whatever the direction", () => {
    expect(judgeHold(hold({ room: null, sources: [] }), { ...P, fixed_s: 600 }, hall({ room: null, sources: [] }), 600 * S).end)
      .toEqual({ why: "window", atMs: 600 * S });
    // the room's last live source lost at 1000 s: fixed_s from then, not from the change
    const lost = judgeHold(hold(), { ...P, fixed_s: 600 }, hall({ sources: [] }), 1000 * S);
    expect(lost).toMatchObject({ expiresMs: 1600 * S, state: { fixedFromMs: 1000 * S } });
    expect(lost.end).toBeUndefined();
    // moved to a roomless place at 2000 s: fixed_s from the move
    expect(judgeHold(lost.state, { ...P, fixed_s: 600 }, hall({ room: null, sources: [] }), 2000 * S).expiresMs).toBe(2600 * S);
  });

  it("restarts the quiet count when a source comes back to live, no earlier than then", () => {
    const gone = judgeHold(hold(), P, hall({ sources: [] }), 1000 * S).state;
    expect(judgeHold(gone, P, hall(), 3000 * S).expiresMs).toBe(6600 * S);
  });

  it("without presence_renews counts the window from the change alone", () => {
    const busy = hall({ busy: true });
    expect(judgeHold(hold(), { ...P, presence_renews: false }, busy, 3600 * S).end).toEqual({ why: "window", atMs: 3600 * S });
  });

  it("moves the quiet anchor to a room or source change (GA-LEASE-7)", () => {
    const moved = judgeHold(hold(), P, hall({ sources: ["m", "p"] }), 3000 * S);
    expect(moved).toMatchObject({ expiresMs: 6600 * S });
    expect(moved.end).toBeUndefined();
  });

  it("ends a load_cap lease load_cap_s after the change, presence, vacancy and fixed_s aside (heater's guard)", () => {
    const cap = hold({ kind: "load_cap", direction: undefined });
    expect(judgeHold(cap, { ...P, fixed_s: 20, vacant_ends: true }, hall({ busy: true, occupancy: "vacant" }), 3599 * S).end).toBeUndefined();
    expect(judgeHold(cap, P, hall({ busy: true }), 3600 * S).end).toEqual({ why: "window", atMs: 3600 * S });
  });

  it("ends at cap_s after the change whatever presence does, never before the floor; 0 is no cap", () => {
    expect(judgeHold(hold(), { ...P, cap_s: 7200 }, hall({ busy: true }), 7200 * S).end).toEqual({ why: "cap", atMs: 7200 * S });
    expect(judgeHold(hold(), { ...P, cap_s: 0 }, hall({ busy: true }), 86_400 * S).end).toBeUndefined();
    const before = judgeHold(hold({ floorMs: 70 * S }), { ...P, cap_s: 1 }, hall({ busy: true }), 10 * S);
    expect(before).toMatchObject({ expiresMs: 70 * S });
    expect(before.end).toBeUndefined();
    expect(judgeHold(hold({ floorMs: 70 * S }), { ...P, cap_s: 1 }, hall({ busy: true }), 70 * S).end).toEqual({ why: "cap", atMs: 70 * S });
    // expires never later than the change plus cap_s, however busy the room
    expect(judgeHold(hold(), { ...P, cap_s: 5000 }, hall({ busy: true }), 4000 * S).expiresMs).toBe(5000 * S);
  });

  it("with vacant_ends, ends when the room becomes vacant after the change, not when vacant already at it", () => {
    const V = { ...P, vacant_ends: true };
    expect(judgeHold(hold(), V, hall({ occupancy: "vacant" }), 100 * S).end).toEqual({ why: "vacant", atMs: 100 * S });
    const already = hold({ vacantAtChange: true });
    expect(judgeHold(already, V, hall({ occupancy: "vacant" }), 100 * S).end).toBeUndefined();
    const seen = judgeHold(already, V, hall({ occupancy: "occupied", busy: true }), 200 * S).state;
    expect(judgeHold(seen, V, hall({ occupancy: "vacant" }), 900 * S).end?.why).toBe("vacant");
    // predicted: the timer is the moment the room would turn vacant, but expires foresees no vacancy
    const predicted = judgeHold(hold(), V, hall({ vacantAtMs: 500 * S }), 100 * S);
    expect(predicted).toMatchObject({ timerAtMs: 500 * S, expiresMs: 3600 * S });
    // a stale prediction never blocks a due end
    expect(judgeHold(hold(), V, hall({ vacantAtMs: 100 * S }), 3600 * S).end?.why).toBe("quiet");
  });

  it("never ends by its policy before the floor, and never shows expires before it (GA-LEASE-7)", () => {
    const one = { ...P, on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 };
    const floored = hold({ floorMs: 70 * S });
    const early = judgeHold(floored, one, hall(), 10 * S);
    expect(early).toMatchObject({ expiresMs: 70 * S });
    expect(early.end).toBeUndefined();
    expect(judgeHold(floored, one, hall(), 70 * S).end).toEqual({ why: "quiet", atMs: 70 * S });
    expect(judgeHold(floored, { ...one, vacant_ends: true }, hall({ occupancy: "vacant" }), 10 * S).end).toBeUndefined();
    expect(judgeHold(hold({ floorMs: null }), one, hall(), 10 * S).end).toEqual({ why: "quiet", atMs: 1 * S });
  });

  it("shows expires at the floor throughout it, not the window's end (GA-LEASE-7)", () => {
    const one = { ...P, on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 };
    const floored = hold({ floorMs: 70 * S });
    const pending = judgeHold(floored, one, hall(), 5 * S).state;
    expect(judgeHold(pending, one, hall(), 30 * S).expiresMs).toBe(70 * S);
    expect(judgeHold(pending, one, hall(), 30 * S, "fixed-expires").expiresMs).toBeLessThan(70 * S);
    expect(judgeHold(floored, one, hall(), 0, "fixed-expires").expiresMs).toBeLessThan(70 * S);
  });

  it("keeps a policy end that came inside the floor, whatever presence does before the floor passes (R-41)", () => {
    const one = { ...P, on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 };
    const floored = hold({ floorMs: 70 * S });
    const first = judgeHold(floored, one, hall(), 5 * S);
    expect(first.state.pendingEnd).toEqual({ why: "quiet" });
    expect(first).toMatchObject({ expiresMs: 70 * S, timerAtMs: 70 * S });
    expect(first.end).toBeUndefined();
    const busy = judgeHold(first.state, one, hall({ busy: true }), 30 * S);
    expect(busy.end).toBeUndefined();
    expect(judgeHold(busy.state, one, hall({ busy: true }), 70 * S).end).toEqual({ why: "quiet", atMs: 70 * S });
    // an ack clearing the floor ends it at once
    expect(judgeHold({ ...busy.state, floorMs: null }, one, hall({ busy: true }), 40 * S).end).toEqual({ why: "quiet", atMs: 40 * S });
    // vacancy inside the floor, occupied again before it passes
    const V = { ...P, vacant_ends: true };
    const vac = judgeHold(floored, V, hall({ occupancy: "vacant" }), 10 * S);
    expect(vac.end).toBeUndefined();
    const back = judgeHold(vac.state, V, hall({ occupancy: "occupied", busy: true }), 30 * S);
    expect(judgeHold(back.state, V, hall({ occupancy: "occupied", busy: true }), 70 * S).end).toEqual({ why: "vacant", atMs: 70 * S });
  });

  it("judges an end that comes inside the floor when it comes, so presence before the floor revives nothing (R-60)", () => {
    const one = { ...P, on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 };
    const floored = hold({ floorMs: 70 * S });
    // The timer arms at the window's end inside the floor, not at the floor; judged there, the end is kept.
    const grant = judgeHold(floored, one, hall(), 0);
    expect(grant).toMatchObject({ expiresMs: 70 * S, timerAtMs: 1 * S });
    expect(judgeHold(grant.state, one, hall(), 1 * S)).toMatchObject({ timerAtMs: 70 * S, state: { pendingEnd: { why: "quiet" } } });
    // Motion at 30 s, before that timer fired: the lapsed quiet end is kept all the same, and ends the hold at the floor.
    const motion = judgeHold(grant.state, one, hall({ busy: true, occupancy: "occupied" }), 30 * S);
    expect(motion.state.pendingEnd).toEqual({ why: "quiet" });
    expect(judgeHold(motion.state, one, hall({ busy: true, occupancy: "occupied" }), 70 * S).end).toEqual({ why: "quiet", atMs: 70 * S });
    // A cap, a fixed window and a window from the change alone, lapsed inside the floor, are kept the same way.
    expect(judgeHold(grant.state, { ...P, cap_s: 1 }, hall({ busy: true }), 30 * S).state.pendingEnd).toEqual({ why: "cap" });
    const roomless = hold({ floorMs: 70 * S, room: null, sources: [], adopted: [] });
    expect(judgeHold(roomless, one, hall({ room: null, sources: [], adopted: [] }), 0).timerAtMs).toBe(1 * S);
    expect(judgeHold(hold({ floorMs: 70 * S }), { ...one, presence_renews: false }, hall({ room: "kitchen" }), 30 * S).state.pendingEnd)
      .toEqual({ why: "window" });
    // A busy room's moving end waits for the floor: no timer every window.
    expect(judgeHold(motion.state, one, hall({ busy: true, occupancy: "occupied" }), 31 * S).timerAtMs).toBe(70 * S);
  });

  it("judges a vacancy predicted inside the floor when it comes, so the room occupied again before the floor revives nothing (R-60)", () => {
    const V = { ...P, vacant_ends: true };
    const floored = hold({ floorMs: 70 * S });
    const grant = judgeHold(floored, V, hall({ occupancy: "occupied", vacantAtMs: 20 * S }), 0);
    expect(grant).toMatchObject({ expiresMs: 3600 * S, timerAtMs: 20 * S });
    const vacant = judgeHold(grant.state, V, hall({ occupancy: "vacant" }), 20 * S);
    expect(vacant).toMatchObject({ timerAtMs: 70 * S, state: { pendingEnd: { why: "vacant" } } });
    expect(vacant.end).toBeUndefined();
    const back = judgeHold(vacant.state, V, hall({ occupancy: "occupied", busy: true }), 40 * S);
    expect(back.end).toBeUndefined();
    expect(judgeHold(back.state, V, hall({ occupancy: "occupied", busy: true }), 70 * S).end).toEqual({ why: "vacant", atMs: 70 * S });
  });

  it("restarts the quiet count on a move, an adopted or returning source or a removed one, not on one going stale (R-43)", () => {
    const two = { sources: ["m", "p"], adopted: ["m", "p"] };
    const base = hold({ ...two });
    const stale = judgeHold(base, P, hall({ sources: ["m"], adopted: ["m", "p"] }), 1000 * S);
    expect(stale.expiresMs).toBe(3600 * S);
    expect(judgeHold(stale.state, P, hall({ adopted: ["m", "p"] }), 3600 * S).end?.why).toBe("quiet");
    const removed = judgeHold(base, P, hall({ sources: ["m"], adopted: ["m"] }), 1000 * S);
    expect(removed.expiresMs).toBe(4600 * S);
    const moved = judgeHold(hold(), P, hall({ room: "kitchen" }), 2000 * S);
    expect(moved.expiresMs).toBe(5600 * S);
    expect(moved.state.room).toBe("kitchen");
  });

  it("leaves fixed_s at its anchor when a source returns, and the cap cuts a fixed window or a window alone", () => {
    const F = { ...P, fixed_s: 600 };
    const lost = judgeHold(hold(), F, hall({ sources: [] }), 1000 * S).state;
    const back = judgeHold(lost, F, hall(), 1200 * S);
    expect(back.state.fixedFromMs).toBe(1000 * S);
    expect(judgeHold(hold({ room: null, sources: [], adopted: [] }), { ...P, fixed_s: 5000, cap_s: 100 }, hall({ room: null, sources: [], adopted: [] }), 100 * S).end)
      .toEqual({ why: "cap", atMs: 100 * S });
    expect(judgeHold(hold(), { ...P, presence_renews: false, cap_s: 100 }, hall({ busy: true }), 100 * S).end).toEqual({ why: "cap", atMs: 100 * S });
  });

  it("leaves quiet_since absent when quiet throughout, and the heater's guard ignores cap_s", () => {
    expect(judgeHold(hold(), P, hall(), 10 * S).state.quietSinceMs).toBeUndefined();
    const cap = hold({ kind: "load_cap", direction: undefined });
    expect(judgeHold(cap, { ...P, cap_s: 10 }, hall(), 3000 * S).end).toBeUndefined();
  });

  it("shifts fixedFromMs and a pending end by a delta too", () => {
    const k = shiftHold(hold({ fixedFromMs: 3, pendingEnd: { why: "quiet", quietSinceMs: 9 } }), 100);
    expect(k).toMatchObject({ fixedFromMs: 103, pendingEnd: { why: "quiet", quietSinceMs: 109 } });
  });

  it("shifts every instant it keeps by a delta, for the store's wall clock", () => {
    expect(shiftHold(hold({ quietSinceMs: 5, floorMs: 7 }), 100)).toMatchObject({ changeMs: 100, quietFromMs: 100, quietSinceMs: 105, floorMs: 107 });
    expect(shiftHold(hold({ quietFromMs: null }), 100).quietFromMs).toBeNull();
  });
});

describe("vacantFrom", () => {
  const NOW = 10_000_000;
  const presence = (o: Partial<Sensor> = {}): Sensor => ({ id: "p", key: "occupancy", value: false, lastTrueMs: NOW - 100_000,
    liveSinceMs: NOW - 86_400_000, freshS: 60, slackS: 11, ...o });
  it("is the first moment occupancyOf reads vacant with no new report, or undefined", () => {
    const at = vacantFrom([presence()], NOW, 300_000)!;
    expect(at).toBe(NOW + 200_000);
    expect(occupancyOf([presence()], at, 300_000)).toBe("vacant");
    expect(occupancyOf([presence()], at - 1, 300_000)).not.toBe("vacant");
    expect(vacantFrom([presence({ value: true })], NOW, 300_000)).toBeUndefined();
    expect(vacantFrom([presence({ liveSinceMs: undefined })], NOW, 300_000)).toBeUndefined();
    expect(vacantFrom([{ ...presence(), key: "motion" }], NOW, 300_000)).toBeUndefined();
    expect(vacantFrom([presence({ freshS: null })], NOW, 300_000)).toBeUndefined();
    expect(vacantFrom([presence({ freshS: 290, slackS: 11 })], NOW, 300_000)).toBeUndefined();
  });
  it("takes a motion sensor's last report as a bound, and the latest of several occupancy sensors", () => {
    const motion: Sensor = { id: "m", key: "motion", value: false, lastTrueMs: NOW - 10_000, liveSinceMs: NOW - 86_400_000, freshS: 60, slackS: 11 };
    expect(vacantFrom([presence(), motion], NOW, 300_000)).toBe(NOW + 290_000);
    const late = presence({ id: "q", liveSinceMs: NOW - 50_000, lastTrueMs: undefined });
    expect(vacantFrom([presence(), late], NOW, 300_000)).toBe(NOW + 250_000);
  });
});
