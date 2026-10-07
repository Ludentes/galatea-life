import { describe, expect, it } from "vitest";
import { occupancyOf, type Sensor } from "../src/gate/occupancy.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, LAMP, on, setup, TV } from "./setup.js";

type Body = Record<string, any>;
const HOLD_MS = 300_000;
const NOW = Date.parse("2030-01-01T08:00:00Z");

/** An occupancy sensor live for a day, declared 60 s with 11 s of slack, reading no presence for a day. */
const presence = (o: Partial<Sensor> = {}): Sensor => ({ id: "p", key: "occupancy", value: false, lastTrueMs: NOW - 86_400_000,
  liveSinceMs: NOW - 86_400_000, freshS: 60, slackS: 11, ...o });
const motion = (o: Partial<Sensor> = {}): Sensor => ({ ...presence(), id: "m", key: "motion", ...o });
const of = (sensors: Sensor[], mutation?: Mutation) => occupancyOf(sensors, NOW, HOLD_MS, mutation);

describe("occupancyOf (GA-OCC-1)", () => {
  it("is occupied while a presence sensor reads presence, or a motion sensor reported motion within the hold", () => {
    expect(of([presence({ value: true })])).toBe("occupied");
    expect(of([presence(), motion({ value: true })])).toBe("occupied");
    expect(of([presence(), motion({ lastTrueMs: NOW - HOLD_MS + 1 })])).toBe("occupied");
    expect(of([presence(), motion({ lastTrueMs: NOW - HOLD_MS })])).toBe("vacant");
  });

  it("is vacant only with a presence sensor, every one live throughout the hold with a bound within it and no presence in it", () => {
    expect(of([presence()])).toBe("vacant");
    expect(of([motion()])).toBe("unknown");
    expect(of([])).toBe("unknown");
    expect(of([presence(), presence({ id: "q", liveSinceMs: undefined })])).toBe("unknown");
    expect(of([presence({ liveSinceMs: NOW - HOLD_MS + 1 })])).toBe("unknown");
    expect(of([presence({ liveSinceMs: NOW - HOLD_MS })])).toBe("vacant");
    expect(of([presence({ freshS: 290 })])).toBe("unknown");
    expect(of([presence({ freshS: 289 })])).toBe("vacant");
    expect(of([presence({ freshS: null })])).toBe("unknown");
    expect(of([presence({ slackS: null })])).toBe("unknown");
    expect(of([presence({ lastTrueMs: NOW - 1000 })])).toBe("unknown");
  });

  it("takes a slow sensor's bound as within the hold under vacant-on-a-slow-sensor", () => {
    expect(MUTATIONS).toContain("vacant-on-a-slow-sensor");
    expect(of([presence({ freshS: 600 })], "vacant-on-a-slow-sensor")).toBe("vacant");
    expect(of([presence({ freshS: null })], "vacant-on-a-slow-sensor")).toBe("vacant");
  });
});

const PRESENCE = "sim-bridge:presence";
const MOTION = "sim-bridge:motion";
const SPOT = "sim-bridge:spot";
const sensor = (id: string, key: string, extra: Body = {}) => ({ id, label: id, class: "sensor", capabilities: ["sensor"], sensor_keys: [key],
  adopted: true, fresh_s: 60, fresh_slack_s: 11, actions: [], ...extra });
const SENSORS = [sensor(PRESENCE, "occupancy"), sensor(MOTION, "motion"),
  { id: SPOT, label: "spot", class: "light", capabilities: ["onoff"], adopted: true, actions: [{ action: "onoff.turn_on", tier: "reversible" }] }];
const live = (values: Record<string, Body[]> = {}) => ({ targets: Object.fromEntries([PRESENCE, MOTION].map((id) => [id,
  { values: values[id] ?? [], liveness: "live", fresh_s: 60, fresh_basis: "declared" }])), transports: [], latches: [] });

/** The furnished house, its hall holding the presence sensor and its kitchen the motion sensor and a spot; the sensors live from now. */
async function rooms(o: Parameters<typeof setup>[0] = {}) {
  const t = await setup(o);
  t.steward.onDescribe(describeOf([...DEVICES, ...SENSORS], 2));
  t.steward.onState(live({ [PRESENCE]: [{ key: "occupancy", value: false, basis_time: new Date(t.clock.now()).toISOString() }] }));
  await t.define([up("target", { id: PRESENCE, room: "hall" }), up("target", { id: MOTION, room: "kitchen" }), up("target", { id: SPOT, room: "kitchen" })]);
  const occupancy = async () => Object.fromEntries(Object.entries((await t.ok(SECRETS.owner, "state")).rooms as Body).map(([r, x]) => [r, (x as Body).occupancy]));
  const report = (target: string, key: string, value: unknown) => {
    t.applier.emit({ type: "state", target, key, value, basis_time: new Date(t.clock.now()).toISOString(), cause: "external" });
    return t.pump();
  };
  const steps = async (actions: Body[], respect = true, secret = SECRETS.olga, endpoint = "olga-app") =>
    t.ok(secret, "plan", { endpoint, actions, respect_occupancy: respect });
  const short = (p: Body) => p.steps.map((s: Body) => `${s.target} ${s.verdict}${s.reason ? `(${s.reason})` : ""}`);
  return { ...t, occupancy, report, steps, short };
}

describe("rooms' occupancy in the steward", () => {
  it("shows each room's occupancy in state, unknown for one hold after a start, then from its sensors (GA-OCC-1)", async () => {
    const { occupancy, clock, report } = await rooms();
    expect(await occupancy()).toEqual({ hall: "unknown", kitchen: "unknown" });
    clock.advance(HOLD_MS);
    expect(await occupancy()).toEqual({ hall: "vacant", kitchen: "unknown" });
    await report(PRESENCE, "occupancy", true);
    await report(MOTION, "motion", true);
    expect(await occupancy()).toEqual({ hall: "occupied", kitchen: "occupied" });
    await report(PRESENCE, "occupancy", false);
    await report(MOTION, "motion", false);
    // Presence within the hold keeps the hall from vacant; motion within it keeps the kitchen occupied.
    expect(await occupancy()).toEqual({ hall: "unknown", kitchen: "occupied" });
    clock.advance(HOLD_MS);
    expect(await occupancy()).toEqual({ hall: "vacant", kitchen: "unknown" });
  });

  it("is never vacant on a sensor that stopped being live, until it has been live again for the hold", async () => {
    const { occupancy, clock, applier, pump } = await rooms();
    clock.advance(HOLD_MS);
    applier.emit({ type: "liveness", target: PRESENCE, old: "live", new: "stale" });
    await pump();
    expect((await occupancy()).hall).toBe("unknown");
    applier.emit({ type: "liveness", target: PRESENCE, old: "stale", new: "live" });
    await pump();
    clock.advance(HOLD_MS - 1);
    expect((await occupancy()).hall).toBe("unknown");
    clock.advance(1);
    expect((await occupancy()).hall).toBe("vacant");
  });

  it("skips a step in an occupied room and asks in an unknown one with respect_occupancy, and consults nothing without it (GA-OCC-1, GA-STW-4)", async () => {
    const { steps, short, clock, report } = await rooms();
    clock.advance(HOLD_MS);
    expect(short(await steps([on(LAMP), on(SPOT), on(TV, "onoff.turn_off")]))).toEqual([`${LAMP} op`, `${SPOT} ask(occupancy_unknown)`,
      `${TV} ask(toggle_only)`]);
    await report(PRESENCE, "occupancy", true);
    expect(short(await steps([on(LAMP)]))).toEqual([`${LAMP} skip(occupied)`]);
    expect(short(await steps([on(LAMP), on(SPOT)], false))).toEqual([`${LAMP} op`, `${SPOT} op`]);
  });

  it("judges the room again at dispatch, keeping the answers: a room that filled skips, one no longer known is an unanswered ask (GA-STW-8, GA-APPLY-3)", async () => {
    const { ok, steps, clock, report, applier, pump } = await rooms();
    clock.advance(HOLD_MS);
    const apply = (plan: Body) => ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: `k-${plan.plan_id}` });
    const outcomes = (r: Body) => r.outcomes.map((o: Body) => `${o.target} ${o.outcome}${o.reason ? `(${o.reason})` : ""}`);
    const vacant = await steps([on(LAMP)]);
    await report(PRESENCE, "occupancy", true);
    expect(outcomes(await apply(vacant))).toEqual([`${LAMP} skipped(occupied)`]);
    await report(PRESENCE, "occupancy", false);
    clock.advance(HOLD_MS);
    const another = await steps([on(LAMP)]);
    applier.emit({ type: "liveness", target: PRESENCE, old: "live", new: "dead" });
    await pump();
    expect(outcomes(await apply(another))).toEqual([`${LAMP} skipped(not_confirmed)`]);
    const asked = await steps([on(SPOT)]);
    await ok(SECRETS.olga, "answer", { plan_id: asked.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    expect(outcomes(await apply(asked))).toEqual([`${SPOT} dispatched`]);
    const inline = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(SPOT)], respect_occupancy: true }, idempotency_key: "inline" });
    expect(outcomes(inline)).toEqual([`${SPOT} skipped(not_confirmed)`]);
  });

  it("asks the toggle in place of the room's question, and a yes to it answers both (GA-STW-4)", async () => {
    const { ok, steps, applier } = await rooms();
    const plan = await steps([on(TV, "onoff.turn_off")]);
    expect(plan.steps[0]).toMatchObject({ verdict: "ask", reason: "toggle_only" });
    await ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: "tv" });
    expect(r.outcomes.map((o: Body) => o.outcome)).toEqual(["dispatched"]);
    expect(applier.applies.at(-1)!.request.actions[0].token).toBeDefined();
  });

  it("never makes a room vacant on a sensor whose bound is longer than the hold, but for vacant-on-a-slow-sensor", async () => {
    for (const mutation of [undefined, "vacant-on-a-slow-sensor"] as const) {
      const { steward, occupancy, clock } = await rooms({ mutation });
      steward.onDescribe(describeOf([...DEVICES, sensor(PRESENCE, "occupancy", { fresh_s: 600 }), ...SENSORS.slice(1)], 3));
      steward.onState({ ...live(), targets: { ...live().targets, [PRESENCE]: { values: [], liveness: "live", fresh_s: 600, fresh_basis: "configured" } } });
      clock.advance(HOLD_MS);
      expect((await occupancy()).hall).toBe(mutation ? "vacant" : "unknown");
    }
  });
});

describe("a step the steward could not plan on the applier (the milestone review, B4)", () => {
  it("never sends a person's respect_occupancy step into an occupied room when the plan fails: it fails closed, unreachable, nothing sent", async () => {
    const t = await rooms();
    await t.report(MOTION, "motion", true);
    t.applier.failNext.set("plan", new Error("the plan call timed out"));
    const r = await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", respect_occupancy: true,
      actions: [{ target: SPOT, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-occ" });
    expect(r.outcomes.map((o: Body) => `${o.target} ${o.outcome}(${o.reason})`)).toEqual([`${SPOT} unreachable(undefined)`]);
    expect(t.applier.applies.filter((a) => a.idempotency_key !== undefined && !String(a.idempotency_key).startsWith("notices:"))).toEqual([]);
  });

  it("never sends a step the applier skipped at plan into an occupied room: it ends with the applier's earlier reason, as the order puts it (GA-STW-4)", async () => {
    const t = await rooms();
    await t.report(MOTION, "motion", true);
    t.applier.planner = (a) => (a.target === SPOT ? { verdict: "skip", reason: "latched" } : {});
    const r = await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", respect_occupancy: true,
      actions: [{ target: SPOT, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-latched" });
    expect(r.outcomes.map((o: Body) => `${o.target} ${o.outcome}(${o.reason})`)).toEqual([`${SPOT} skipped(latched)`]);
    expect(t.applier.applies.filter((a) => a.idempotency_key !== undefined && !String(a.idempotency_key).startsWith("notices:"))).toEqual([]);
  });
});
