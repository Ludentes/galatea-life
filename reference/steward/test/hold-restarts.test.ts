import { describe, expect, it } from "vitest";
import { RECOVERY_AHEAD_MS } from "../src/link/link.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { validLeaseEvents } from "./lease-events.js";
import { hall, HALL_DEVICES, hallState, iso, MOTION, PLUG, sensor } from "./hall.js";
import { SECRETS, up } from "./house.js";
import { eventsSince, LAMP, on, quiet } from "./setup.js";

type Body = Record<string, any>;
const S = 1000;
const OCCUPANCY = "sim-bridge:presence";

/** The first life stopped, its store kept and closed, as a restart finds it. */
async function stop(t: Awaited<ReturnType<typeof hall>>): Promise<void> {
  await quiet(t.store);
  t.steward.stop();
  await t.store.close();
}

/** The `lease` events in the steward's history from `fromMs` on, across its lives, each checked against its schema (R-38). */
async function leaseHistory(t: Awaited<ReturnType<typeof hall>>, fromMs: number): Promise<Body[]> {
  const events = ((await t.ok(SECRETS.owner, "history", { from: iso(fromMs), to: t.at() })).events as Body[]).filter((e) => e.type === "lease");
  validLeaseEvents(events);
  return events;
}

/** A second life over the same store and applier, its first state not yet read: the test reads its gap. */
async function again(a: Awaited<ReturnType<typeof hall>>, o: Parameters<typeof hall>[0] = {}) {
  const b = await hall({ db: a.db, clock: a.clock, define: false, applier: a.applier, sync: false, fromNow: true, ...o });
  const begun = String((await b.ok(SECRETS.owner, "events")).cursor);
  /** The link's start-up read: the applier's history since the last event kept, then `state`. */
  const recover = async (state: Body) => {
    const missed = (await b.port.history({ from: iso(0), to: iso(b.clock.now()) })).events;
    b.steward.recover(missed, state, String(missed.at(-1)?.seq ?? 0));
    await quiet(b.store);
  };
  return { ...b, begun, recover };
}

/**
 * A clock whose reads jitter by microseconds within its millisecond, as the harness's SNTP-fed clock does when
 * each sync moves its offset: two reads in one judgement differ, either way (R-73).
 */
class JitterClock extends FakeClock {
  private reads = 0;
  override now(): number {
    this.reads += 1;
    return super.now() + ((this.reads * 7919) % 10) * 0.0001;
  }
}

describe("a hold across a restart (GA-PERSIST-2)", () => {
  it("keeps a member's hold's expires to the millisecond across a restart, on a clock whose reads jitter (R-73)", async () => {
    const db = lasting(await memoryDb());
    const clock = new JitterClock();
    const a = await hall({ db, clock });
    const dispatched = Math.floor(clock.now());
    await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "restart-expires" });
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: a.at() });
    await a.pump();
    const before = (await a.leases())[LAMP];
    // The hall quiet throughout: on_s (3600 s, the steward's own) after the dispatch, to the millisecond.
    expect(before?.expires).toBe(new Date(dispatched + 3600 * S).toISOString());
    await stop(a);
    clock.advance(10 * S);
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true });
    for (let i = 0; i < 20; i++) expect((await b.leases())[LAMP]?.expires).toBe(before.expires);
  });

  it("keeps a member's hold's expires to the millisecond across a restart, its elapsed clock apart from the wall and jittering (R-74)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    // A monotonic clock read beside an integer wall clock: their difference moves within a millisecond between reads.
    let reads = 0;
    const elapsed = () => clock.now() + (((reads += 1) * 7919) % 10) * 0.09;
    const a = await hall({ db, clock, options: { elapsed } });
    const dispatched = clock.now();
    await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "restart-expires-elapsed" });
    clock.advance(3 * S);
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: a.at() });
    await a.pump();
    const before = (await a.leases())[LAMP];
    expect(before?.expires).toBe(new Date(dispatched + 3600 * S).toISOString());
    // Each quiet report judges the hold again, its end converted once more.
    for (let i = 0; i < 20; i++) {
      clock.advance(1);
      await a.motion(false);
      expect((await a.leases())[LAMP]?.expires).toBe(before.expires);
    }
    await stop(a);
    clock.advance(10 * S);
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true, options: { elapsed } });
    for (let i = 0; i < 20; i++) expect((await b.leases())[LAMP]?.expires).toBe(before.expires);
  });

  it("tells a guest's floor passing in a restart's gap at begin, the owner's rule it refused then sent (R-63)", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    await a.ok(SECRETS.panel, "apply", { request: { endpoint: "hall-panel", actions: [on(LAMP)] }, idempotency_key: "restart-guest" });
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: a.at() });
    await a.pump();
    await a.define([up("rule", { id: "off", name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }], actions: [on(LAMP, "onoff.turn_off")] })]);
    await quiet(a.store);
    const offs = () => a.applier.applies.filter((x: Body) => x.request.actions.some((y: Body) => y.action === "onoff.turn_off"));
    expect(offs()).toEqual([]);
    await stop(a);
    // Down: the guest's step is acked, ending its floor; read back from the gap at the restart.
    a.clock.advance(2 * S);
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: a.at() });
    a.clock.advance(10 * S);
    const b = await again(a);
    const readBack = hallState(false, b.clock.now());
    await b.recover({ ...readBack, targets: { ...readBack.targets, [LAMP]: { liveness: "live", values: [{ key: "on", value: true, basis_time: b.at() }] } } });
    expect(offs().map((x) => x.request.actions[0].for)).toEqual([{ rule: "off" }]);
    expect((await b.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("keeps its quiet: a hold whose room was quiet 3000 s ends 600 s after the restart, not a whole on_s", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await hall({ db, clock });
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: iso(clock.now()) });
    await a.pump();
    clock.advance(3000 * S);
    await stop(a);
    // The source read back live and false at the restart (R-55).
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true });
    clock.advance(600 * S - 1);
    expect((await b.leases())[LAMP]).toBeDefined();
    clock.advance(1);
    expect((await b.leases())[LAMP]).toBeUndefined();
  });

  it("under restarts-the-quiet holds a whole on_s from the restart instead", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await hall({ db, clock });
    await a.outside(LAMP, "on", true);
    clock.advance(3000 * S);
    await stop(a);
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true, mutation: "restarts-the-quiet" });
    clock.advance(600 * S);
    expect((await b.leases())[LAMP]).toBeDefined();
    clock.advance(3000 * S);
    expect((await b.leases())[LAMP]).toBeUndefined();
  });

  it("ends a hold whose end fell in the gap at the restart, its event with end_time", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await hall({ db, clock });
    const t0 = clock.now();
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: iso(t0) });
    await a.pump();
    await stop(a);
    clock.jump(4000 * S);
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true });
    const ended = (await leaseHistory(b, t0)).filter((e) => e.change === "ended");
    expect(ended.at(-1)).toMatchObject({ target: LAMP, end: "quiet", end_time: iso(t0 + 3600 * S) });
  });

  it("ends a hold whose quiet end fell in the downtime though motion is read back true, not revived by it (R-55)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await hall({ db, clock });
    const t0 = clock.now();
    await a.outside(LAMP, "on", true);
    await stop(a);
    clock.jump(4000 * S);
    const b = await hall({ db, clock, define: false, applier: a.applier, fromNow: true, state: hallState(true, clock.now()) });
    await quiet(b.store);
    expect((await b.leases())[LAMP]).toBeUndefined();
    const lease = (await leaseHistory(b, t0)).filter((e) => e.target === LAMP);
    expect(lease.map((e) => [e.change, e.end, e.end_time])).toEqual([["granted", undefined, undefined], ["ended", "quiet", iso(t0 + 3600 * S)]]);
  });

  it("ends it so too when the restart reads its gap first, motion read back true (R-55)", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    const t0 = a.clock.now();
    await a.outside(LAMP, "on", true);
    await stop(a);
    a.clock.jump(4000 * S);
    const b = await again(a);
    await b.recover(hallState(true, b.clock.now()));
    expect((await b.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(b.ok, b.begun, "lease"))).toMatchObject([{ target: LAMP, change: "ended", end: "quiet", end_time: iso(t0 + 3600 * S) }]);
  });

  it("times a restart gap's change in a room whose only source the read-back shows not live from fixed_s at the change", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    await a.motion(false);
    await stop(a);
    a.clock.jump(100 * S);
    const changed = a.clock.now();
    a.applier.emitUnseen({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: iso(changed) });
    a.clock.jump(100 * S);
    const b = await again(a);
    const readBack = hallState(false, b.clock.now());
    await b.recover({ ...readBack, targets: { [MOTION]: { ...readBack.targets[MOTION], liveness: "stale" } } });
    expect((await b.leases())[LAMP].expires).toBe(iso(changed + 3600 * S));
  });

  for (const variant of ["liveness", "illuminance"] as const) {
    it(`does not take the read-back's motion as the gap's after a ${variant} event of the sensor (GA-PERSIST-2; R-55)`, async () => {
      const a = await hall({ db: lasting(await memoryDb()) });
      const t0 = a.clock.now();
      await a.outside(LAMP, "on", true);
      await stop(a);
      a.clock.jump(100 * S);
      if (variant === "liveness") a.applier.emitUnseen({ type: "liveness", target: MOTION, old: "live", new: "live", time: a.at() });
      else a.applier.emitUnseen({ type: "state", target: MOTION, key: "illuminance", value: 40, cause: "device", time: a.at() });
      a.clock.jump(3900 * S);
      // Motion only after the hold's quiet end: it revives nothing.
      a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, cause: "device", time: a.at() });
      a.clock.jump(100 * S);
      const b = await again(a);
      await b.recover(hallState(true, b.clock.now()));
      expect((await b.leases())[LAMP]).toBeUndefined();
      expect(await eventsSince(b.ok, b.begun, "lease")).toMatchObject([{ change: "ended", end: "quiet", end_time: iso(t0 + 3600 * S) }]);
    });
  }

  it("refreshes the position a quiet house reads its gap from at each sync, read back from it by the link's skew bound (R-52)", async () => {
    const a = await hall({ db: lasting(await memoryDb()), sync: false });
    const { cursor } = await a.port.events(undefined, 0);
    a.steward.onState(hallState(false, a.clock.now()), String(cursor));
    a.clock.advance(3600 * S);
    const second = a.clock.now();
    a.steward.onState(hallState(false, a.clock.now()), String(cursor));
    expect(a.steward.lastApplierEvent()).toEqual({ seq: Number(cursor), timeMs: second - RECOVERY_AHEAD_MS });
    await stop(a);
    // Kept so across a restart.
    const b = await again(a);
    expect(b.steward.lastApplierEvent()).toEqual({ seq: Number(cursor), timeMs: second - RECOVERY_AHEAD_MS });
  });

  it("counts the gap's presence at its event time", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    const t0 = a.clock.now();
    await a.outside(LAMP, "on", true);
    await stop(a);
    a.clock.jump(3000 * S);
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, cause: "device", time: a.at() });
    a.clock.jump(30 * S);
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: false, cause: "device", time: a.at() });
    a.clock.jump(970 * S);
    const b = await again(a);
    await b.recover(hallState(false, b.clock.now()));
    // Quiet from the gap's last presence, +3030 s, not from the read-back at +4000 s.
    expect((await b.leases())[LAMP].expires).toBe(iso(t0 + (3030 + 3600) * S));
  });

  it("keeps the gap's presence past the recovery cap (R-56)", async () => {
    const a = await hall({ db: lasting(await memoryDb()), options: { recoveryCap: 2 } });
    const t0 = a.clock.now();
    await a.outside(LAMP, "on", true);
    await stop(a);
    a.clock.jump(3000 * S);
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, cause: "device", time: a.at() });
    a.clock.jump(30 * S);
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: false, cause: "device", time: a.at() });
    // The plug's readings after it, more than the cap: the oldest of the gap's events would be dropped.
    for (let i = 0; i < 5; i++) {
      a.clock.jump(10 * S);
      a.applier.emitUnseen({ type: "state", target: PLUG, key: "power", value: i, cause: "device", time: a.at() });
    }
    a.clock.jump(920 * S);
    const b = await again(a, { options: { recoveryCap: 2 } });
    await b.recover(hallState(false, b.clock.now()));
    expect((await b.leases())[LAMP].expires).toBe(iso(t0 + (3030 + 3600) * S));
  });

  it("takes no lease for a missed change whose end passed in the gap", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    // An event the steward keeps, so the restart reads the gap after it.
    await a.motion(false);
    await stop(a);
    a.clock.jump(10 * S);
    // The plug is roomless: its hold is fixed_s, 3600 s, which ends inside the two-hour gap.
    a.applier.emitUnseen({ type: "state", target: PLUG, key: "on", value: true, cause: "external", time: a.at() });
    a.clock.jump(7200 * S);
    const b = await again(a);
    await b.recover(hallState(false, b.clock.now()));
    expect((await b.leases())[PLUG]).toBeUndefined();
    expect(await eventsSince(b.ok, b.begun, "lease")).toEqual([]);
  });

  it("clamps a gap event's time to the last live reading", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    const t0 = a.clock.now();
    await a.outside(LAMP, "on", true);
    a.clock.advance(1000 * S);
    // The steward's last live reading before the gap, at +1000 s.
    await a.motion(false);
    await stop(a);
    a.clock.jump(100 * S);
    // An applier clock behind: the gap's motion stamped before the last live reading.
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, cause: "device", time: iso(t0 + 500 * S) });
    a.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: false, cause: "device", time: iso(t0 + 600 * S) });
    const b = await again(a);
    await b.recover(hallState(false, b.clock.now()));
    // Both count at +1000 s: the quiet runs from there, not from +600 s.
    expect((await b.leases())[LAMP].expires).toBe(iso(t0 + (1000 + 3600) * S));
  });

  it("lets a gap change stamped before the last live reading replace the hold taken at it: by the applier's order it came after (R-48)", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    a.applier.emitsOutcomes = false;
    const dispatched = a.clock.now();
    const applied = await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "clamped-to-dispatch" });
    expect(applied.outcomes.map((o: Body) => o.outcome)).toEqual(["dispatched"]);
    // The apply's change, the steward's last live reading, at the dispatch instant.
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(dispatched), cause: { apply: "applier-apply-1", client: "steward",
      for: { person: "olga", endpoint: "olga-app", apply: applied.apply_id } } });
    await a.pump();
    await stop(a);
    a.clock.jump(100 * S);
    // An outside change after it in the applier's order, stamped before it by an applier clock behind: clamped up to the dispatch instant.
    a.applier.emitUnseen({ type: "state", target: LAMP, key: "on", value: false, cause: "external", time: iso(dispatched - 50 * S) });
    const b = await again(a);
    await b.recover(hallState(false, b.clock.now()));
    expect((await b.leases())[LAMP]).toMatchObject({ holder: "external" });
    expect((await eventsSince(b.ok, b.begun, "lease")).map((e) => [e.change, e.holder, e.end, e.end_time]))
      .toEqual([["ended", { person: "olga", endpoint: "olga-app" }, "replaced", iso(dispatched)], ["granted", "external", undefined, undefined]]);
  });

  it("reads the gap of a steward that synced but had no applier event before it stopped (R-52)", async () => {
    const a = await hall({ db: lasting(await memoryDb()), sync: false });
    // The link's first sync: the events cursor, then the state.
    const { cursor } = await a.port.events(undefined, 0);
    a.steward.onState(hallState(false, a.clock.now()), String(cursor));
    await stop(a);
    a.clock.jump(100 * S);
    const changed = a.clock.now();
    a.applier.emitUnseen({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: iso(changed) });
    a.clock.jump(100 * S);
    const b = await again(a);
    expect(b.steward.lastApplierEvent()).toMatchObject({ seq: Number(cursor) });
    await b.recover(hallState(false, b.clock.now()));
    expect((await eventsSince(b.ok, b.begun, "lease"))).toMatchObject([{ target: LAMP, change: "granted", direction: "on", expires: iso(changed + 3600 * S) }]);
    expect((await eventsSince(b.ok, b.begun, "state")).filter((e) => e.target === LAMP)).toMatchObject([{ value: true, recovered: true }]);
  });

  // The reachable case of a hold timer falling due before `begin`: reloaded holds are not armed, so only
  // the clock passing the end before the first state can make one due then.
  it("judges at the first state a hold whose end passed while the applier was still out of reach", async () => {
    const a = await hall({ db: lasting(await memoryDb()) });
    const t0 = a.clock.now();
    await a.outside(LAMP, "on", true);
    await stop(a);
    a.clock.jump(1000 * S);
    const b = await again(a);
    // The applier out of reach a while: the clock runs past the hold's end before the first state.
    b.clock.advance(3000 * S);
    await b.recover(hallState(false, b.clock.now()));
    expect((await b.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(b.ok, b.begun, "lease"))).toMatchObject([{ target: LAMP, change: "ended", end: "quiet", end_time: iso(t0 + 3600 * S) }]);
  });
});

describe("a hold over a gap read while following (GA-LEASE-7; R-54)", () => {
  it("ends a hold vacant at the vacancy instant when its room turned vacant before a gap with no event in it (R-51, R-61)", async () => {
    const clock = new FakeClock();
    const occupied = hallState(false, clock.now());
    const presence = (v: boolean, at: number) => ({ values: [{ key: "occupancy", value: v, basis_time: iso(at) }], liveness: "live", fresh_s: 60, fresh_basis: "declared" });
    const t = await hall({ clock, devices: [...HALL_DEVICES, sensor(OCCUPANCY, "occupancy")],
      state: { ...occupied, targets: { ...occupied.targets, [OCCUPANCY]: presence(true, clock.now()) } } });
    await t.define([up("target", { id: OCCUPANCY, room: "hall" })]);
    const t0 = t.clock.now();
    await t.outside(LAMP, "on", true);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    // Followed live: the sensor clears; the room would turn vacant occupancy_hold_s after its last presence.
    t.clock.advance(10 * S);
    t.applier.emit({ type: "state", target: OCCUPANCY, key: "occupancy", value: false, cause: "device", time: t.at() });
    await t.pump();
    // A cursor_expired gap holding nothing, read long after the vacancy.
    t.clock.jump(1000 * S);
    const missed = (await t.port.history({ from: iso(0), to: t.at() })).events;
    const readBack = hallState(false, t.clock.now());
    t.steward.recover(missed, { ...readBack, targets: { ...readBack.targets, [OCCUPANCY]: presence(false, t.clock.now()) } }, String(missed.at(-1)?.seq ?? 0));
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).filter((e) => e.target === LAMP && e.change === "ended"))
      .toMatchObject([{ end: "vacant", end_time: iso(t0 + 300 * S) }]);
  });

  it("ends a hold vacant at the gap's last presence plus occupancy_hold_s, an occupancy sensor clearing early in the gap", async () => {
    const clock = new FakeClock();
    const occupied = hallState(false, clock.now());
    const presence = (v: boolean, at: number) => ({ values: [{ key: "occupancy", value: v, basis_time: iso(at) }], liveness: "live", fresh_s: 60, fresh_basis: "declared" });
    const t = await hall({ clock, devices: [...HALL_DEVICES, sensor(OCCUPANCY, "occupancy")],
      state: { ...occupied, targets: { ...occupied.targets, [OCCUPANCY]: presence(true, clock.now()) } } });
    await t.define([up("target", { id: OCCUPANCY, room: "hall" })]);
    await t.outside(LAMP, "on", true);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    // A cursor_expired gap: the sensor reports presence at g, then clears.
    t.clock.jump(100 * S);
    const g = t.clock.now();
    t.applier.emitUnseen({ type: "state", target: OCCUPANCY, key: "occupancy", value: true, cause: "device", time: iso(g) });
    t.clock.jump(10 * S);
    t.applier.emitUnseen({ type: "state", target: OCCUPANCY, key: "occupancy", value: false, cause: "device", time: t.at() });
    t.clock.jump(1000 * S);
    const missed = (await t.port.history({ from: iso(0), to: t.at() })).events;
    const readBack = hallState(false, t.clock.now());
    t.steward.recover(missed, { ...readBack, targets: { ...readBack.targets, [OCCUPANCY]: presence(false, t.clock.now()) } }, String(missed.at(-1)?.seq ?? 0));
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).filter((e) => e.target === LAMP && e.change === "ended"))
      .toMatchObject([{ end: "vacant", end_time: iso(g + 300 * S) }]);
  });
});
