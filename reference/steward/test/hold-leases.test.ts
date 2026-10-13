import { describe, expect, it } from "vitest";
import { HOLD_DEFAULTS } from "../src/house/model.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock, WallStepClock } from "./fake-clock.js";
import { validLeaseEvents } from "./lease-events.js";
import { SECRETS, up } from "./house.js";
import { FAN, hall, HALL_DEVICES, hallState, iso, LOOSE, MOTION, PLUG } from "./hall.js";
import { describeOf, DEVICES, eventsSince, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const S = 1000;
const ONE_S = { on_s: 1, off_s: 1, other_s: 1, fixed_s: 1 };
let n = 0;
const key = () => `hold-${++n}`;

describe("holds over the wire (GA-LEASE-1, GA-LEASE-2, GA-LEASE-7)", () => {
  it("holds a member's turn_on in the hall until the hall has been quiet for on_s, motion renewing it", async () => {
    const t = await hall();
    const t0 = t.clock.now();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    await t.pump();
    expect((await t.leases())[LAMP]).toMatchObject({ precedence: "person", expires: new Date(t0 + 3600 * S).toISOString() });
    t.clock.advance(3000 * S);
    await t.motion(true);
    t.clock.advance(30 * S);
    await t.motion(false);
    t.clock.advance(3600 * S - 1);
    expect((await t.leases())[LAMP]).toBeDefined();
    t.clock.advance(1);
    expect((await t.leases())[LAMP]).toBeUndefined();
    // Two hours on, the events' cursor is gone: the hold's events from history.
    const h = (await t.ok(SECRETS.owner, "history", { from: new Date(t0).toISOString(), to: t.at() })).events as Body[];
    const ev = h.filter((e) => e.type === "lease");
    validLeaseEvents(ev);
    expect(ev.map((e) => [e.change, e.direction, e.end])).toEqual([["granted", "on", undefined], ["ended", undefined, "quiet"]]);
    // The apply's derived role, named in its granted event (GA-LEASE-10, R-37); the quiet's moment in its end.
    expect(ev[0]).toMatchObject({ role: "member" });
    expect(ev[1]).toMatchObject({ quiet_since: new Date(t0 + 3030 * S).toISOString() });
  });

  it("holds a turn_off off_s; a policy change applies at once (GA-LEASE-8)", async () => {
    const t = await hall();
    t.applier.answerOutcome = "acked";
    const t0 = t.clock.now();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    expect((await t.leases())[LAMP].expires).toBe(new Date(t0 + 600 * S).toISOString());
    await t.define([up("home", { hold: { off_s: 30 } })]);
    expect((await t.leases())[LAMP].expires).toBe(new Date(t0 + 30 * S).toISOString());
    t.clock.advance(30 * S);
    expect((await t.leases())[LAMP]).toBeUndefined();
  });

  it("names a toggling action's hold other, whatever the action (GA-LEASE-7)", async () => {
    const t = await hall();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(FAN, "onoff.turn_off")] }, idempotency_key: key() });
    expect((await eventsSince(t.ok, cursor, "lease"))[0]).toMatchObject({ target: FAN, change: "granted", direction: "other" });
  });

  it("names a guest's hold guest: a panel with no person (GA-LEASE-10, R-37)", async () => {
    const t = await hall();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.panel, "apply", { request: { endpoint: "hall-panel", actions: [on(LAMP)] }, idempotency_key: key() });
    expect((await eventsSince(t.ok, cursor, "lease"))[0]).toMatchObject({ target: LAMP, change: "granted", role: "guest", holder: { endpoint: "hall-panel" } });
  });

  it("keeps the floor: a turn_on that fails no_ack holds until ack_within_s plus 60 s, even with 1 s windows", async () => {
    const t = await hall();
    await t.define([up("home", { hold: ONE_S })]);
    t.applier.emitsOutcomes = false;
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    t.clock.advance(69 * S);
    expect((await t.leases())[LAMP]).toBeDefined();
    t.clock.advance(1 * S);
    expect((await t.leases())[LAMP]).toBeUndefined();
  });

  it("ends a turn_on's hold at the floor though motion came after its 1 s window lapsed inside the floor (R-60)", async () => {
    const t = await hall();
    await t.define([up("home", { hold: ONE_S })]);
    t.applier.emitsOutcomes = false;
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    t.clock.advance(30 * S);
    await t.motion(true);
    t.clock.advance(39 * S);
    expect((await t.leases())[LAMP]).toBeDefined();
    t.clock.advance(1 * S);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).filter((e) => e.target === LAMP).map((e) => [e.change, e.end])).toEqual([["granted", undefined], ["ended", "quiet"]]);
  });

  it("lets an ack end the floor at once", async () => {
    const t = await hall();
    await t.define([up("home", { hold: ONE_S })]);
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    t.clock.advance(2 * S);
    t.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await t.pump();
    expect((await t.leases())[LAMP]).toBeUndefined();
  });

  it("ends the floor at sent, and only past it under floor-waits-past-sent", async () => {
    for (const mutation of [undefined, "floor-waits-past-sent"] as const) {
      const t = await hall({ mutation });
      await t.define([up("home", { hold: ONE_S })]);
      await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
      t.clock.advance(2 * S);
      t.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "sent" });
      await t.pump();
      expect((await t.leases())[LAMP] === undefined, String(mutation)).toBe(mutation === undefined);
      t.steward.stop();
    }
  });

  it("ends an apply's hold unreachable when its step later ends so, naming the end (GA-LEASE-1, R-45)", async () => {
    const t = await hall();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    t.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "unreachable" });
    await t.pump();
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end])).toEqual([["granted", undefined], ["ended", "unreachable"]]);
  });

  it("takes an outside hold only on a key an action sets, on an adopted device (GA-LEASE-2)", async () => {
    const t = await hall();
    t.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, cause: "external", time: t.at() });
    t.applier.emit({ type: "state", target: PLUG, key: "power", value: 40, cause: "external", time: t.at() });
    t.applier.emit({ type: "state", target: LOOSE, key: "on", value: true, cause: "external", time: t.at() });
    await t.pump();
    expect(await t.leases()).toEqual({});
    await t.outside(PLUG, "on", true);
    expect(Object.keys(await t.leases())).toEqual([PLUG]);
  });

  it("takes a hold on a sensor reading, a metering key or a device not adopted only under their mutations", async () => {
    const cases: [Mutation, string, string, unknown][] = [["sensor-reading-holds", MOTION, "motion", true], ["metering-holds", PLUG, "power", 40],
      ["unadopted-holds", LOOSE, "on", true]];
    for (const [mutation, target, k, value] of cases) {
      expect(MUTATIONS).toContain(mutation);
      const t = await hall({ mutation });
      await t.outside(target, k, value);
      expect(Object.keys(await t.leases()), mutation).toEqual([target]);
      t.steward.stop();
    }
  });

  it("times an outside change by its receipt and names its direction from what changed", async () => {
    const t = await hall();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: "2029-12-31T08:00:00.000Z" });
    await t.pump();
    expect((await t.leases())[LAMP].expires).toBe(new Date(t.clock.now() + 3600 * S).toISOString());
    expect((await eventsSince(t.ok, cursor, "lease"))[0]).toMatchObject({ direction: "on" });
  });

  it("holds a load cap's change load_cap_s, ending it window, naming no direction (GA-LEASE-7, R-45)", async () => {
    const t = await hall();
    await t.define([up("home", { hold: { load_cap_s: 120 } })]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.outside(PLUG, "on", false, "load_cap");
    t.clock.advance(120 * S - 1);
    expect((await t.leases())[PLUG]).toMatchObject({ holder: "load_cap" });
    t.clock.advance(1);
    expect((await t.leases())[PLUG]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.direction, e.end])).toEqual([["granted", undefined, undefined], ["ended", undefined, "window"]]);
  });

  it("ends an outside change's hold replaced by a member's apply in two events (GA-LEASE-7, R-44)", async () => {
    const t = await hall();
    await t.outside(LAMP, "on", true);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.direction])).toEqual([["ended", "replaced", undefined], ["granted", undefined, "off"]]);
  });

  it("moves no hold on a step of the wall clock: windows run on elapsed time", async () => {
    const clock = new FakeClock();
    let jumped = 0;
    const t = await hall({ clock, options: { elapsed: () => clock.now() - jumped } });
    await t.outside(LAMP, "on", true);
    jumped = 7200 * S;
    t.clock.jump(7200 * S);
    await t.motion(false);
    expect((await t.leases())[LAMP]).toBeDefined();
    // It ends on_s after the change on the elapsed clock, the step aside.
    t.clock.advance(3600 * S - 1);
    expect((await t.leases())[LAMP]).toBeDefined();
    t.clock.advance(1);
    expect((await t.leases())[LAMP]).toBeUndefined();
  });

  it("moves no hold on a backward step of the wall clock between its timer's arming and firing (R-60)", async () => {
    const clock = new WallStepClock();
    const t = await hall({ clock, options: { elapsed: () => clock.elapsed() } });
    await t.outside(LAMP, "on", true);
    clock.step(-7200 * S);
    t.clock.advance(3600 * S - 1);
    expect((await t.leases())[LAMP]).toBeDefined();
    t.clock.advance(1);
    expect((await t.leases())[LAMP]).toBeUndefined();
  });

  it("anchors fixed_s where the hall's only source went dead; under renews-on-a-dead-sensor the dead source keeps the quiet window", async () => {
    for (const mutation of [undefined, "renews-on-a-dead-sensor"] as const) {
      const t = await hall({ mutation });
      await t.outside(LAMP, "on", true);
      t.applier.emit({ type: "liveness", target: MOTION, old: "live", new: "dead", time: t.at() });
      await t.pump();
      // Its only source dead, the lamp takes fixed_s from the moment the hall lost it; the mutation keeps counting the hall's quiet.
      await t.define([up("home", { hold: { on_s: 60, fixed_s: 7200 } })]);
      t.clock.advance(60 * S);
      expect((await t.leases())[LAMP] === undefined, String(mutation)).toBe(mutation !== undefined);
      t.steward.stop();
    }
  });

  it("ends a hold removed when its device stops being adopted", async () => {
    const t = await hall();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.outside(LAMP, "on", true);
    t.steward.onDescribe(describeOf(HALL_DEVICES.map((d) => (d.id === LAMP ? { ...d, adopted: false } : d)), 3));
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end])).toEqual([["granted", undefined], ["ended", "removed"]]);
  });

  it("grants a hold under a window past the last date, showing the last date (GA-LEASE-8, R-60)", async () => {
    const t = await hall();
    await t.define([up("home", { hold: { on_s: 1e13, cap_s: 0 } })]);
    await t.outside(LAMP, "on", true);
    expect((await t.leases())[LAMP].expires).toBe("9999-12-31T23:59:59.999Z");
  });

  it("describes the policy's reference values (GA-LEASE-8)", async () => {
    const t = await hall();
    expect((await t.ok(SECRETS.owner, "describe")).home.hold).toEqual(HOLD_DEFAULTS);
  });
});

describe("holds over a gap replayed (GA-LEASE-2, GA-LEASE-7; R-49)", () => {
  it("ends an apply's hold whose step ended unreachable in a following gap, with that outcome's time as end_time", async () => {
    const t = await hall();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "gap-unreachable" });
    await t.pump();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * S);
    const at = t.at();
    t.applier.emitUnseen({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "unreachable", time: at });
    t.clock.advance(60 * S);
    const missed = (await t.port.history({ from: iso(0), to: t.at() })).events;
    t.steward.recover(missed, hallState(false, t.clock.now()), String(missed.at(-1)?.seq ?? 0));
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.end_time])).toEqual([["ended", "unreachable", at]]);
  });

  it("ends a hold whose quiet end fell before a gap's motion at that end, not revived by the motion", async () => {
    const t = await hall();
    const t0 = t.clock.now();
    await t.outside(LAMP, "on", true);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.jump(3700 * S);
    t.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, cause: "device", time: iso(t0 + 3650 * S) });
    const missed = (await t.port.history({ from: iso(0), to: iso(t.clock.now()) })).events;
    t.steward.recover(missed, hallState(true, t.clock.now()), String(missed.at(-1)?.seq ?? 0));
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).filter((e) => e.target === LAMP).map((e) => [e.change, e.end, e.end_time]))
      .toEqual([["ended", "quiet", iso(t0 + 3600 * S)]]);
  });

  it("names a restart gap's outside change by what changed, though the read-back shows it already (GA-LEASE-7)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await hall({ db, clock });
    // An event the steward keeps, so the restart reads the gap after it.
    await a.motion(false);
    await quiet(a.store);
    a.steward.stop();
    await a.store.close();
    clock.jump(100 * S);
    const changed = clock.now();
    a.applier.emitUnseen({ type: "state", target: LAMP, key: "on", value: false, cause: "external", time: iso(changed) });
    clock.jump(100 * S);
    const b = await hall({ db, clock, define: false, applier: a.applier, sync: false, fromNow: true });
    const begun = String((await b.ok(SECRETS.owner, "events")).cursor);
    const missed = (await b.port.history({ from: iso(0), to: iso(clock.now()) })).events;
    const readBack = hallState(false, clock.now());
    readBack.targets[LAMP as typeof MOTION] = { values: [{ key: "on", value: false, basis_time: iso(clock.now()) }], liveness: "live", fresh_s: 60, fresh_basis: "declared" };
    b.steward.recover(missed, readBack, String(missed.at(-1)?.seq ?? 0));
    await quiet(b.store);
    expect((await eventsSince(b.ok, begun, "lease"))[0]).toMatchObject({ target: LAMP, change: "granted", direction: "off" });
    expect((await b.leases())[LAMP].expires).toBe(iso(changed + 600 * S));
  });
});
