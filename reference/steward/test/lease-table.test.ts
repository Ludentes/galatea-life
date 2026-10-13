import { describe, expect, it } from "vitest";
import { Store } from "../src/core/store.js";
import type { HoldState } from "../src/leases/hold.js";
import { guestsHold, LeaseTable, leaseRefuses, personsHold, type Lease, type Met } from "../src/leases/table.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { memoryDb } from "./db.js";
import { FakeClock, WallStepClock } from "./fake-clock.js";
import { validLeaseEvents as valid } from "./lease-events.js";
import { quiet } from "./setup.js";

const LAMP = "sim-bridge:lamp";
const hold = (at: number, o: Partial<HoldState> = {}): HoldState => ({ kind: "person", direction: "on", changeMs: at, quietFromMs: at, floorMs: null,
  fixedFromMs: 0, vacantAtChange: false, seenNotVacant: false, room: "hall", sources: ["m"], adopted: ["m"], ...o });

/** A clock that refuses a delay a host's timer could not keep, as Node's setTimeout overflows past 2^31 - 1 ms. */
class StrictClock extends FakeClock {
  armed = 0;
  override setTimeout(fn: () => void, ms: number): number {
    if (ms > 2 ** 31 - 1) throw new Error(`a delay of ${ms} ms overflows a timer`);
    this.armed++;
    return super.setTimeout(fn, ms);
  }
}

async function table(o: { db?: Awaited<ReturnType<typeof memoryDb>>; clock?: FakeClock; elapsed?: () => number; mutation?: Mutation } = {}) {
  const clock = o.clock ?? new FakeClock();
  const db = o.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const events: Record<string, unknown>[] = [];
  const due: string[] = [];
  const ended: string[] = [];
  const t = new LeaseTable({ clock, store, event: (b) => events.push(b), ended: (target) => ended.push(target), due: (x) => due.push(x),
    ...(o.elapsed ? { elapsed: o.elapsed } : {}), ...(o.mutation ? { mutation: o.mutation } : {}) });
  return { t, clock, db, store, events, due, ended };
}

describe("the lease table's holds", () => {
  it("names a person's hold: an endpoint's, external, a press's; not load_cap, a run's or a safety rule's", () => {
    const p = (holder: Lease["holder"], precedence: Lease["precedence"] = "person") => personsHold({ holder, precedence });
    expect([p({ person: "olga", endpoint: "olga-app" }), p({ endpoint: "hall-panel" }), p("external"),
      p({ rule: "bench-on", press: { target: "b", key: "k", value: 1 } })]).toEqual([true, true, true, true]);
    expect([p("load_cap"), p({ run: "r1" }), p({ safety_rule: "night" }, "safety_rule"), p({ rule: "x" }, "rule")]).toEqual([false, false, false, false]);
  });

  it("tells a hold's due timer to the caller instead of ending it, and re-arms on update", async () => {
    const { t, clock, due, ended, events } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
    clock.advance(1000);
    expect(due).toEqual([LAMP]);
    expect(ended).toEqual([]);
    t.update(LAMP, { hold: hold(now), expiresMs: clock.now() + 500, timerAtMs: undefined });
    clock.advance(500);
    expect(due).toEqual([LAMP, LAMP]);
    expect(events.map((e) => e.change)).toEqual(["granted"]);
    valid(events);
  });

  it("arms a hold's timer at its timerAtMs, showing its expiresMs (R-42)", async () => {
    const { t, clock, due, events } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 10_000, timerAtMs: now + 2_000, hold: hold(now) });
    expect(events[0]).toMatchObject({ expires: new Date(now + 10_000).toISOString() });
    clock.advance(1_999);
    expect(due).toEqual([]);
    clock.advance(1);
    expect(due).toEqual([LAMP]);
    t.update(LAMP, { hold: hold(now), expiresMs: now + 10_000, timerAtMs: now + 5_000 });
    clock.advance(2_999);
    expect(due).toEqual([LAMP]);
    clock.advance(1);
    expect(due).toEqual([LAMP, LAMP]);
    // An update with no timerAtMs arms at expiresMs.
    t.update(LAMP, { hold: hold(now), expiresMs: now + 10_000, timerAtMs: undefined });
    clock.advance(4_999);
    expect(due).toEqual([LAMP, LAMP]);
    clock.advance(1);
    expect(due).toEqual([LAMP, LAMP, LAMP]);
    valid(events);
  });

  it("ends a replaced person's hold with end: replaced, then grants; a grant names its direction and role, an end its info", async () => {
    const { t, clock, events } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", sinceMs: now, expiresMs: now + 1000,
      hold: hold(now, { role: "owner" }) });
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now, { direction: "off" }) });
    t.end(LAMP, undefined, { end: "quiet", quiet_since: new Date(now).toISOString() });
    expect(events.map((e) => [e.change, e.direction, e.end])).toEqual(
      [["granted", "on", undefined], ["ended", undefined, "replaced"], ["granted", "off", undefined], ["ended", undefined, "quiet"]]);
    expect(events[0]).toMatchObject({ role: "owner" });
    expect(events[1]).toMatchObject({ holder: { person: "olga", endpoint: "olga-app" } });
    expect(events[3]).toMatchObject({ quiet_since: new Date(now).toISOString() });
    valid(events);
  });

  it("keeps one replaced event, with no end, only when neither lease is a person's hold (R-44)", async () => {
    const { t, clock, events } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: { rule: "r" }, precedence: "rule", sinceMs: now, expiresMs: now + 1000 });
    t.grant({ target: LAMP, holder: { run: "r1" }, precedence: "scheduled_run", sinceMs: now, expiresMs: null });
    expect(events.map((e) => [e.change, e.end])).toEqual([["granted", undefined], ["replaced", undefined]]);
    valid(events);
  });

  it("ends a run's lease replaced by a person's hold before the hold's granted event: an outside change's, a guest's naming its role (R-44)", async () => {
    for (const [holder, role] of [["external", undefined], [{ endpoint: "hall-panel" }, "guest"]] as const) {
      const { t, clock, events } = await table();
      const now = clock.now();
      t.grant({ target: LAMP, holder: { run: "r1" }, precedence: "person", sinceMs: now, expiresMs: null });
      t.grant({ target: LAMP, holder, precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now, role ? { role } : {}) });
      expect(events.map((e) => [e.change, e.end, e.direction])).toEqual([["granted", undefined, undefined], ["ended", "replaced", undefined], ["granted", undefined, "on"]]);
      expect(events[1]).toMatchObject({ holder: { run: "r1" } });
      expect(events[2].role).toBe(role);
      valid(events);
    }
  });

  it("puts restored on a restored grant", async () => {
    const { t, clock, events } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) }, { restored: true });
    expect(events[0]).toMatchObject({ change: "granted", restored: true });
    valid(events);
  });

  it("keeps the person's hold a press replaced, and only that", async () => {
    const { t, clock, events } = await table();
    const now = clock.now();
    const press = { rule: "bench-on", press: { target: "b", key: "k", value: 1 } };
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now), refused: ["r"] });
    const before = t.of(LAMP)!;
    t.grant({ target: LAMP, holder: press, precedence: "person", sinceMs: now, expiresMs: now + 2000, hold: hold(now, { direction: "off" }) });
    expect(t.of(LAMP)!.replaced).toEqual(before);
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
    expect(t.of(LAMP)!.replaced).toBeUndefined();
    valid(events);
  });

  it("keeps one level of replaced holds: a press over a press keeps the first press's hold without the hold it replaced (R-47)", async () => {
    const { t, clock } = await table();
    const now = clock.now();
    const press = (value: number) => ({ rule: "bench-on", press: { target: "b", key: "k", value } });
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
    t.grant({ target: LAMP, holder: press(1), precedence: "person", sinceMs: now, expiresMs: now + 2000, hold: hold(now), apply: "a1" });
    t.grant({ target: LAMP, holder: press(2), precedence: "person", sinceMs: now, expiresMs: now + 3000, hold: hold(now), apply: "a2" });
    expect(t.of(LAMP)!.replaced).toMatchObject({ holder: press(1), apply: "a1" });
    expect(t.of(LAMP)!.replaced!.replaced).toBeUndefined();
  });

  it("restore ends the press's hold unreachable unre-evaluated and grants the replaced hold back, refusing both holds' rules (R-58)", async () => {
    const { t, clock, events, ended } = await table();
    const now = clock.now();
    const press = { rule: "bench-on", press: { target: "b", key: "k", value: 1 } };
    t.grant({ target: LAMP, holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", sinceMs: now, expiresMs: now + 1000, timerAtMs: now + 500,
      hold: hold(now, { role: "member" }), refused: ["a"] });
    t.grant({ target: LAMP, holder: press, precedence: "person", sinceMs: now, expiresMs: now + 2000, hold: hold(now), apply: "p1" });
    t.refused(LAMP, "b");
    events.length = 0;
    expect(t.restore(LAMP, "other", () => ({ expiresMs: now + 9000 }))).toBe(false);
    expect(t.of(LAMP)!.holder).toEqual(press);
    expect(t.restore(LAMP, "p1", () => ({ expiresMs: now + 4000 }))).toBe(true);
    expect(t.of(LAMP)).toMatchObject({ holder: { person: "olga", endpoint: "olga-app" }, expiresMs: now + 4000, refused: ["a", "b"] });
    expect(t.of(LAMP)!.timerAtMs).toBeUndefined();
    expect(ended).toEqual([]);
    expect(events.map((e) => [e.change, e.end, e.restored, e.role])).toEqual([["ended", "unreachable", undefined, undefined], ["granted", undefined, true, "member"]]);
    expect(events[1]!.expires).toBe(new Date(now + 4000).toISOString());
    valid(events);
  });

  it("restores nothing over a press's hold that replaced no person's hold", async () => {
    const { t, clock } = await table();
    const now = clock.now();
    t.grant({ target: LAMP, holder: { rule: "bench-on", press: { target: "b", key: "k", value: 1 } }, precedence: "person", sinceMs: now, expiresMs: now + 2000,
      hold: hold(now), apply: "p1" });
    expect(t.restore(LAMP, "p1", () => ({ expiresMs: now + 4000 }))).toBe(false);
  });

  it("drops end, end_time and direction under their mutations", async () => {
    for (const [mutation, key] of [["ends-without-a-reason", "end"], ["gap-end-without-time", "end_time"], ["grants-no-direction", "direction"]] as const) {
      expect(MUTATIONS).toContain(mutation);
      const { t, clock, events } = await table({ mutation });
      const now = clock.now();
      t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
      t.end(LAMP, undefined, { end: "quiet", end_time: new Date(now).toISOString() });
      expect(events.some((e) => key in e), mutation).toBe(false);
      const clean = await table();
      clean.t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
      clean.t.end(LAMP, undefined, { end: "quiet", end_time: new Date(now).toISOString() });
      expect(clean.events.some((e) => key in e), mutation).toBe(true);
      valid(clean.events);
    }
  });

  it("hands a lease's refused rules on from a gap's replacement, none under forgets-a-replaced-lease", async () => {
    for (const [mutation, rules] of [[undefined, ["r"]], ["forgets-a-replaced-lease", []]] as const) {
      const { t, clock, events, ended } = await table(mutation ? { mutation } : {});
      const now = clock.now();
      t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now), refused: ["r"] });
      expect(t.replacedInGap(LAMP, new Date(now).toISOString()), mutation).toEqual(rules);
      expect(events.at(-1)).toMatchObject({ change: "ended", end: "replaced", end_time: new Date(now).toISOString() });
      expect(ended).toEqual([]);
      valid(events);
    }
  });

  it("arms a hold's timer 30 s late under ends-a-hold-late, and no other lease's", async () => {
    expect(MUTATIONS).toContain("ends-a-hold-late");
    const { t, clock, due, ended, events } = await table({ mutation: "ends-a-hold-late" });
    const now = clock.now();
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
    t.grant({ target: "sim-bridge:tv", holder: { run: "r1" }, precedence: "scheduled_run", sinceMs: now, expiresMs: now + 1000 });
    clock.advance(1000);
    expect([due, ended]).toEqual([[], ["sim-bridge:tv"]]);
    clock.advance(30_000);
    expect(due).toEqual([LAMP]);
    valid(events);
  });

  it("clamps a timer past the host's limit and re-arms it, ending nothing early and never looping (R-40)", async () => {
    const clock = new StrictClock();
    const { t, due, ended, events } = await table({ clock });
    const now = clock.now();
    const far = now + 3_000_000 * 1000;                    // on_s 3000000, cap_s 0
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: far, hold: hold(now) });
    t.grant({ target: "sim-bridge:tv", holder: { run: "r1" }, precedence: "scheduled_run", sinceMs: now, expiresMs: far });
    clock.advance(far - now - 1);
    expect([due, ended]).toEqual([[], []]);
    expect(clock.armed).toBeLessThan(10);
    clock.advance(1);
    expect([due, ended]).toEqual([[LAMP], ["sim-bridge:tv"]]);
    valid(events);
  });

  it("hands a hold's timer to the caller when it fires though the wall clock stepped back; another lease's re-arms on the wall (R-60)", async () => {
    const clock = new WallStepClock();
    const { t, due, ended } = await table({ clock, elapsed: () => clock.elapsed() });
    const now = clock.now();
    t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 1000, hold: hold(now) });
    t.grant({ target: "sim-bridge:tv", holder: { run: "r1" }, precedence: "scheduled_run", sinceMs: now, expiresMs: now + 1000 });
    clock.step(-5000);
    clock.advance(1000);
    expect([due, ended]).toEqual([[LAMP], []]);
    clock.advance(5000);
    expect(ended).toEqual(["sim-bridge:tv"]);
  });

  it("settles an apply's step into a hold's lease", async () => {
    const { t, clock, events } = await table();
    const now = clock.now();
    t.lay(LAMP, { apply: "a1", step: "s1", holder: { person: "olga", endpoint: "olga-app" }, precedence: "person" });
    t.settle(LAMP, "a1", "s1", { sinceMs: now, expiresMs: now + 5000, hold: hold(now, { role: "member" }) });
    expect(t.of(LAMP)).toMatchObject({ apply: "a1", expiresMs: now + 5000, hold: { role: "member" } });
    expect(events[0]).toMatchObject({ change: "granted", role: "member", direction: "on" });
    valid(events);
  });

  it("keeps a hold's instants on the wall clock in the store, and reads them back onto the elapsed clock, unarmed", async () => {
    const clock = new FakeClock();
    let el = 5_000;
    const a = await table({ clock, elapsed: () => el });
    const now = clock.now();
    a.t.grant({ target: LAMP, holder: "external", precedence: "person", sinceMs: now, expiresMs: now + 60_000,
      hold: hold(el, { quietSinceMs: el, floorMs: el + 10, pendingEnd: { why: "quiet", quietSinceMs: el } }) });
    await quiet(a.store);
    a.t.stop();
    el = 1_000;                                 // a new life: its elapsed clock starts elsewhere
    const b = await table({ clock, db: a.db, elapsed: () => el });
    await b.t.load();
    const l = b.t.of(LAMP)!;
    expect(l.hold).toEqual({ ...hold(1_000, { quietSinceMs: 1_000, floorMs: 1_010, pendingEnd: { why: "quiet", quietSinceMs: 1_000 } }), fixedFromMs: -4_000 });
    clock.advance(120_000);
    expect(b.due).toEqual([]);                  // not armed until Holds.begin
    expect(b.ended).toEqual([]);
    expect(b.t.of(LAMP)).toBeDefined();
    valid([...a.events, ...b.events]);
  });

  it("keeps the hold a press replaced across a restart, shifted the same way", async () => {
    const clock = new FakeClock();
    let el = 5_000;
    const a = await table({ clock, elapsed: () => el });
    const now = clock.now();
    a.t.grant({ target: LAMP, holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", sinceMs: now, expiresMs: now + 60_000,
      apply: "a1", refused: ["r"], hold: hold(el, { role: "owner" }) });
    a.t.grant({ target: LAMP, holder: { rule: "bench-on", press: { target: "b", key: "k", value: 1 } }, precedence: "person", sinceMs: now,
      expiresMs: now + 30_000, hold: hold(el, { direction: "off" }) });
    await quiet(a.store);
    a.t.stop();
    el = 1_000;
    const b = await table({ clock, db: a.db, elapsed: () => el });
    await b.t.load();
    expect(b.t.of(LAMP)!.replaced).toEqual({ target: LAMP, holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", sinceMs: now,
      expiresMs: now + 60_000, apply: "a1", refused: ["r"], hold: { ...hold(1_000, { role: "owner" }), fixedFromMs: -4_000 } });
    expect(b.t.of(LAMP)!.refused).toEqual(["r"]);
    valid([...a.events, ...b.events]);
  });
});

describe("a guest's hold and the owner's work (GA-LEASE-10)", () => {
  it("shows what a change meets: a provisional lease's role inside its floor, a hold's role and whether its floor has passed", async () => {
    const { t, clock } = await table();
    const now = clock.now();
    t.lay(LAMP, { apply: "a1", step: "s1", holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest" });
    expect(t.holding(LAMP)).toEqual({ holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest", floorPassed: false });
    t.settle(LAMP, "a1", "s1", { sinceMs: now, expiresMs: now + 600_000, hold: hold(now, { role: "guest", floorMs: now + 70_000 }) });
    expect(t.holding(LAMP)).toEqual({ holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest", floorPassed: false });
    clock.advance(70_000);
    expect(t.holding(LAMP)).toMatchObject({ role: "guest", floorPassed: true });
    t.grant({ target: LAMP, holder: { run: "r1" }, precedence: "person", sinceMs: now, expiresMs: null });
    expect(t.holding(LAMP)).toEqual({ holder: { run: "r1" }, precedence: "person", floorPassed: true });
  });

  it("names a guest's hold by its role alone", () => {
    expect([guestsHold({ holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest" }),
      guestsHold({ holder: { endpoint: "hall-panel" }, precedence: "person", role: "member" }),
      guestsHold({ holder: { endpoint: "hall-panel" }, precedence: "person" })]).toEqual([true, false, false]);
  });

  it("passes the owner's work through a guest's hold whose floor passed, while declared; nothing else", () => {
    const guest: Met = { holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest", floorPassed: true };
    const member: Met = { holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", role: "member", floorPassed: true };
    const refuses = (l: Met, ownerWork: boolean, guestsPass: boolean, mutation?: Mutation) =>
      leaseRefuses(l, "rule", ownerWork ? { ownerWork: true } : {}, { guestsPass, ...(mutation ? { mutation } : {}) });
    expect([refuses(guest, true, true), refuses(guest, false, true), refuses(guest, true, false), refuses({ ...guest, floorPassed: false }, true, true),
      refuses(member, true, true)]).toEqual([false, true, true, true, true]);
    expect([refuses(guest, true, true, "guest-hold-blocks-the-owner"), refuses(guest, true, false, "passes-undeclared"),
      refuses({ ...guest, floorPassed: false }, true, true, "passes-inside-the-floor"), refuses(member, true, true, "passes-a-member-hold")])
      .toEqual([true, false, false, false]);
  });
});
