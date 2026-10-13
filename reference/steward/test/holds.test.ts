import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store.js";
import { HOLD_DEFAULTS, type HoldPolicy } from "../src/house/model.js";
import { Holds } from "../src/leases/holds.js";
import { LeaseTable } from "../src/leases/table.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { validLeaseEvents } from "./lease-events.js";

const LAMP = "sim-bridge:lamp";
const S = 1000;

type RoomFn = ConstructorParameters<typeof Holds>[0]["roomNow"];

/**
 * A rig over a real lease table. `restart`: as after a start, nothing judged until the test calls
 * `begin`, the gap's reports replayed first.
 */
async function rig(policy: Partial<HoldPolicy> = {}, mutation?: Mutation,
  o: { restart?: true; roomNow?: (clock: FakeClock) => RoomFn; elapsed?: (clock: FakeClock) => () => number } = {}) {
  const clock = new FakeClock();
  const store = await Store.open(await memoryDb(), clock, (err) => { throw err; });
  const events: Record<string, any>[] = [];
  const lines: string[] = [];
  const room = { room: "hall" as string | null, sources: ["m"], adopted: ["m"], busy: false, occupancy: "unknown" as const,
    vacantAtWallMs: undefined as number | undefined };
  const p: HoldPolicy = { ...HOLD_DEFAULTS, vacant_ends: false, ...policy };
  let holds!: Holds;
  const ended: [string, string[]][] = [];
  const table = new LeaseTable({ clock, store, event: (b) => events.push(b), ended: (t, rules) => ended.push([t, rules]), due: (t) => holds.judge(t),
    elapsed: o.elapsed?.(clock) ?? (() => clock.now()) });
  holds = new Holds({ table, clock, policy: () => p,
    roomNow: o.roomNow?.(clock) ?? (() => ({ ...room })), roomOf: () => room.room ?? undefined, logger: (l) => lines.push(l), ...(mutation ? { mutation } : {}) });
  if (!o.restart) holds.begin();
  return { clock, table, holds, room, p, events, lines, ended };
}

describe("Holds (GA-LEASE-7)", () => {
  it("ends an external on change once the room is quiet for on_s, renewed by presence, with end quiet and quiet_since", async () => {
    const r = await rig();
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.clock.advance(1000 * S);
    r.room.busy = true; r.holds.judgeRoom("hall");
    expect(r.table.of(LAMP)!.expiresMs).toBe(t0 + 1000 * S + 3600 * S);
    r.clock.advance(1000 * S);
    r.room.busy = false; r.holds.judgeRoom("hall");
    r.clock.advance(3600 * S - 1);
    expect(r.table.of(LAMP)).toBeDefined();
    r.clock.advance(1);
    expect(r.table.of(LAMP)).toBeUndefined();
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "quiet", quiet_since: new Date(t0 + 2000 * S).toISOString() });
    expect(r.events[0]).toMatchObject({ change: "granted", direction: "on", holder: "external" });
    validLeaseEvents(r.events);
  });

  it("finds a room's holds by the device's room alone, judging no hold of another room", async () => {
    let reads = 0;
    const r = await rig({}, undefined, { roomNow: () => () => { reads++; return { room: "hall", sources: ["m"], adopted: ["m"], busy: false, occupancy: "unknown" }; } });
    r.holds.change(LAMP, "external", "on");
    const granted = r.events.length;
    reads = 0;
    r.holds.judgeRoom("kitchen");
    expect(reads).toBe(0);
    expect(r.events.length).toBe(granted);
    r.holds.judgeRoom("hall");
    expect(reads).toBeGreaterThan(0);
  });

  it("applies a policy change at once to a hold held", async () => {
    const r = await rig();
    r.holds.change(LAMP, "external", "off");
    r.p.off_s = 20;
    r.holds.judgeAll();
    r.clock.advance(20 * S);
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "quiet" });
    validLeaseEvents(r.events);
  });

  it("gives a load_cap lease load_cap_s and no direction", async () => {
    const r = await rig({ load_cap_s: 60 });
    r.holds.change(LAMP, "load_cap", undefined);
    expect(r.events[0]).not.toHaveProperty("direction");
    r.room.busy = true; r.holds.judgeRoom("hall");
    r.clock.advance(60 * S);
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "window" });
    validLeaseEvents(r.events);
  });

  it("keeps an apply's hold to its floor, and lets it go at the ack", async () => {
    const r = await rig({ on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 });
    const now = r.clock.now();
    const h = r.holds.start(LAMP, "person", "on", { dispatchWallMs: now, ackWithinS: 10 }, "member");
    expect(h).toMatchObject({ role: "member", fixedFromMs: now, floorMs: now + 70 * S, adopted: ["m"] });
    // Shown at the floor; judged at the 1 s window's end inside it, to keep that end (R-60).
    expect(r.holds.expires(LAMP, h)).toEqual({ expiresMs: now + 70 * S, timerAtMs: now + 1 * S });
    r.table.grant({ target: LAMP, holder: { endpoint: "olga-app" }, precedence: "person", sinceMs: now, ...r.holds.expires(LAMP, h), hold: h, apply: "a1" });
    expect(r.table.of(LAMP)!.expiresMs).toBe(now + 70 * S);
    r.clock.advance(5 * S);
    expect(r.table.of(LAMP)).toBeDefined();
    r.holds.acked(LAMP, "a2");
    expect(r.table.of(LAMP)).toBeDefined();
    r.holds.acked(LAMP, "a1");
    expect(r.table.of(LAMP)).toBeUndefined();
    expect(r.events[0]).toMatchObject({ change: "granted", role: "member" });
    validLeaseEvents(r.events);
  });

  it("ends a hold removed when its device is gone, unadopted or internal, a load_cap lease too", async () => {
    const r = await rig();
    r.holds.change(LAMP, "external", "on");
    r.holds.change("sim-bridge:heater", "load_cap", undefined);
    r.holds.removed((t) => t === LAMP);
    expect(r.events.at(-1)).toMatchObject({ target: LAMP, change: "ended", end: "removed" });
    r.holds.removed(() => true);
    expect(r.events.at(-1)).toMatchObject({ target: "sim-bridge:heater", change: "ended", end: "removed" });
    validLeaseEvents(r.events);
  });

  it("ends a hold whose end fell in a gap at begin, with end_time", async () => {
    const r = await rig({ fixed_s: 60 }, undefined, { restart: true });
    r.room.room = null; r.room.sources = []; r.room.adopted = [];
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.clock.jump(120 * S);
    r.holds.begin();
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "window", end_time: new Date(t0 + 60 * S).toISOString() });
    validLeaseEvents(r.events);
  });

  it("ends a hold whose end falls between two replayed reports with end_time, the later report reviving nothing", async () => {
    const r = await rig({ on_s: 100 }, undefined, { restart: true });
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.clock.jump(300 * S);
    r.holds.replayAt(t0 + 50 * S, () => { r.room.busy = true; r.holds.judgeRoom("hall"); });
    expect(r.table.of(LAMP)!.expiresMs).toBe(t0 + 150 * S);
    r.holds.replayAt(t0 + 60 * S, () => { r.room.busy = false; r.holds.judgeRoom("hall"); });
    r.holds.replayAt(t0 + 200 * S, () => { r.room.busy = true; r.holds.judgeRoom("hall"); });
    expect(r.table.of(LAMP)).toBeUndefined();
    r.holds.begin();
    expect(r.events.map((e) => e.change)).toEqual(["granted", "ended"]);
    expect(r.events[1]).toMatchObject({ end: "quiet", quiet_since: new Date(t0 + 60 * S).toISOString(), end_time: new Date(t0 + 160 * S).toISOString() });
    validLeaseEvents(r.events);
  });

  it("takes no lease and puts no event for a change in the gap whose end passed there, however busy the room after", async () => {
    const r = await rig({ on_s: 100 }, undefined, { restart: true });
    const t0 = r.clock.now();
    r.clock.jump(300 * S);
    r.holds.replayAt(t0 + 10 * S, () => r.holds.change(LAMP, "external", "on"));
    expect(r.table.of(LAMP)).toBeUndefined();
    r.holds.replayAt(t0 + 200 * S, () => { r.room.busy = true; r.holds.judgeRoom("hall"); });
    r.holds.begin();
    expect(r.table.of(LAMP)).toBeUndefined();
    expect(r.events).toEqual([]);
    expect(r.lines.join("\n")).toContain(LAMP);
  });

  it("grants a change in the gap whose end has not passed at begin, from its change's time", async () => {
    const r = await rig({ off_s: 100 }, undefined, { restart: true });
    const t0 = r.clock.now();
    r.clock.jump(300 * S);
    r.holds.replayAt(t0 + 250 * S, () => r.holds.change(LAMP, "external", "off"));
    r.holds.replayAt(t0 + 260 * S, () => { r.room.busy = true; r.holds.judgeRoom("hall"); r.room.busy = false; r.holds.judgeRoom("hall"); });
    expect(r.events).toEqual([]);
    r.holds.begin();
    expect(r.table.of(LAMP)).toMatchObject({ holder: "external", sinceMs: t0 + 250 * S, expiresMs: t0 + 360 * S });
    expect(r.events).toMatchObject([{ change: "granted", direction: "off" }]);
    r.clock.advance(60 * S - 1);
    expect(r.table.of(LAMP)).toBeDefined();
    r.clock.advance(1);
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "quiet" });
    expect(r.events.at(-1)).not.toHaveProperty("end_time");
    validLeaseEvents(r.events);
  });

  it("ends a hold a change in the gap replaced there, end_time the change's, and grants the change at begin (R-48)", async () => {
    const r = await rig({ on_s: 1000, off_s: 100 }, undefined, { restart: true });
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.table.refused(LAMP, "r1");
    r.clock.jump(300 * S);
    r.holds.replayAt(t0 + 250 * S, () => r.holds.change(LAMP, "external", "off"));
    expect(r.table.of(LAMP)).toBeUndefined();
    expect(r.events.map((e) => [e.change, e.end, e.end_time])).toEqual(
      [["granted", undefined, undefined], ["ended", "replaced", new Date(t0 + 250 * S).toISOString()]]);
    r.holds.begin();
    expect(r.table.of(LAMP)).toMatchObject({ holder: "external", sinceMs: t0 + 250 * S, refused: ["r1"], hold: { direction: "off" } });
    expect(r.events.at(-1)).toMatchObject({ change: "granted", direction: "off" });
    expect(r.ended).toEqual([]);
    validLeaseEvents(r.events);
  });

  it("leaves the replaced hold's ended event alone when the change in the gap ended there too, its rules re-evaluated (R-48)", async () => {
    const r = await rig({ on_s: 1000, off_s: 100 }, undefined, { restart: true });
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.table.refused(LAMP, "r1");
    r.clock.jump(300 * S);
    r.holds.replayAt(t0 + 10 * S, () => r.holds.change(LAMP, "external", "off"));
    expect(r.ended).toEqual([]);
    r.holds.begin();
    expect(r.table.of(LAMP)).toBeUndefined();
    expect(r.events.map((e) => [e.change, e.end, e.end_time])).toEqual(
      [["granted", undefined, undefined], ["ended", "replaced", new Date(t0 + 10 * S).toISOString()]]);
    expect(r.ended).toEqual([[LAMP, ["r1"]]]);
    validLeaseEvents(r.events);
  });

  it("asks the room as of the instant judged, so a vacancy in the gap ends at the moment the room turned vacant (R-49)", async () => {
    let t0 = 0;
    const r = await rig({ vacant_ends: true }, undefined, { restart: true, roomNow: (clock) => (_t, at) => {
      const a = at ?? clock.now();
      const vacant = a >= t0 + 200 * S && a < t0 + 800 * S;
      return { room: "hall", sources: ["m"], adopted: ["m"], busy: false, occupancy: vacant ? "vacant" : "occupied",
        ...(a < t0 + 200 * S ? { vacantAtWallMs: t0 + 200 * S } : {}) };
    } });
    t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    expect(r.table.of(LAMP)!.timerAtMs).toBe(t0 + 200 * S);
    r.clock.jump(1000 * S);
    r.holds.replayAt(t0 + 900 * S, () => r.holds.judgeRoom("hall"));
    r.holds.begin();
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "vacant", end_time: new Date(t0 + 200 * S).toISOString() });
    validLeaseEvents(r.events);
  });

  it("ends a hold whose room turned vacant in a gap with no event after it, at begin with end_time the vacancy's (R-49)", async () => {
    let t0 = 0;
    const r = await rig({ vacant_ends: true }, undefined, { restart: true, roomNow: (clock) => (_t, at) => {
      const a = at ?? clock.now();
      return { room: "hall", sources: ["m"], adopted: ["m"], busy: false, occupancy: a >= t0 + 200 * S ? "vacant" : "occupied",
        ...(a < t0 + 200 * S ? { vacantAtWallMs: t0 + 200 * S } : {}) };
    } });
    t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    r.clock.jump(1000 * S);
    r.holds.begin();
    expect(r.events.at(-1)).toMatchObject({ change: "ended", end: "vacant", end_time: new Date(t0 + 200 * S).toISOString() });
    validLeaseEvents(r.events);
  });

  it("never arms a timer before the hold's end when the clocks differ by a fraction of a millisecond", async () => {
    for (const [first, then] of [[0.7, 0.2], [0.2, 0.7]]) {
      let frac = first;
      const r = await rig({ on_s: 100 }, undefined, { elapsed: (clock) => () => clock.now() + frac });
      const t0 = r.clock.now();
      r.holds.change(LAMP, "external", "on");
      frac = then;
      r.holds.judgeAll();
      // One offset both ways (R-74): the shown end is the change plus on_s to the millisecond, its timer not before it,
      // and the timer firing there ends the hold.
      expect(r.table.of(LAMP)!.expiresMs, `${first} then ${then}`).toBe(t0 + 100 * S);
      expect(r.table.of(LAMP)!.timerAtMs).toBeGreaterThanOrEqual(t0 + 100 * S);
      r.clock.advance(r.table.of(LAMP)!.timerAtMs! - t0);
      expect(r.table.of(LAMP), `${first} then ${then}`).toBeUndefined();
    }
  });

  it("re-samples the offset once the clocks drift apart past the step threshold, the shown end moving by the drift and its timer firing once (R-74)", async () => {
    let drift = 0;
    const r = await rig({ on_s: 100 }, undefined, { elapsed: (clock) => () => clock.now() - drift });
    let judged = 0;
    const judge = r.holds.judge.bind(r.holds);
    r.holds.judge = (...a: Parameters<typeof judge>) => { judged += 1; return judge(...a); };
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    expect(r.table.of(LAMP)!.expiresMs).toBe(t0 + 100 * S);
    // A slew under the threshold moves nothing shown.
    r.clock.advance(20 * S);
    drift = 60;
    r.holds.judgeAll();
    expect(r.table.of(LAMP)!.expiresMs).toBe(t0 + 100 * S);
    // Past it, the offset is sampled again: the end on the elapsed clock stands, and the wall instant shown moves by the drift.
    r.clock.advance(30 * S);
    drift = 150;
    r.holds.judgeAll();
    const l = r.table.of(LAMP)!;
    expect(l.expiresMs).toBe(t0 + 100 * S + 150);
    expect(l.timerAtMs).toBe(t0 + 100 * S + 150);
    judged = 0;
    r.clock.advance(l.timerAtMs! - r.clock.now() - 1);
    expect(r.table.of(LAMP)).toBeDefined();
    r.clock.advance(1);
    expect(r.table.of(LAMP)).toBeUndefined();
    // The timer fired once and judged once: no loop re-arming it at the same instant.
    expect(judged).toBe(1);
  });

  it("gives a finite end under never-ends-a-quiet-hold with no cap, so the grant stands (R-50)", async () => {
    const r = await rig({ cap_s: 0 }, "never-ends-a-quiet-hold");
    const t0 = r.clock.now();
    r.holds.change(LAMP, "external", "on");
    expect(r.table.of(LAMP)!.expiresMs).toBe(t0 + 10 * 365 * 24 * 3600 * S);
    validLeaseEvents(r.events);
  });

  it("clamps the shown end and the timer to the last date-time, so a window past it grants (R-60)", async () => {
    const r = await rig({ on_s: 1e13, cap_s: 0 });
    r.holds.change(LAMP, "external", "on");
    const last = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
    expect(r.table.of(LAMP)).toMatchObject({ expiresMs: last, timerAtMs: last });
    expect(r.events[0]).toMatchObject({ change: "granted", expires: "9999-12-31T23:59:59.999Z" });
    validLeaseEvents(r.events);
  });

  it("runs the three mutations at their sites", async () => {
    for (const m of ["quiet-without-its-moment", "keeps-a-removed-hold", "missed-change-full-window"] as const) expect(MUTATIONS).toContain(m);
    const q = await rig({ on_s: 10 }, "quiet-without-its-moment");
    q.holds.change(LAMP, "external", "on");
    q.room.busy = true; q.holds.judgeRoom("hall");
    q.room.busy = false; q.holds.judgeRoom("hall");
    q.clock.advance(10 * S);
    expect(q.events.at(-1)).toMatchObject({ change: "ended", end: "quiet" });
    expect(q.events.at(-1)).not.toHaveProperty("quiet_since");

    const k = await rig({}, "keeps-a-removed-hold");
    k.holds.change(LAMP, "external", "on");
    k.holds.removed(() => true);
    expect(k.table.of(LAMP)).toBeDefined();

    const f = await rig({ on_s: 100 }, "missed-change-full-window", { restart: true });
    const t0 = f.clock.now();
    f.clock.jump(300 * S);
    f.holds.replayAt(t0 + 10 * S, () => f.holds.change(LAMP, "external", "on"));
    f.holds.begin();
    expect(f.table.of(LAMP)).toMatchObject({ sinceMs: t0 + 300 * S, expiresMs: t0 + 400 * S });
  });
});
