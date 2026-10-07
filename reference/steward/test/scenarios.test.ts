import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, eventsSince, LAMP, quiet, setup, TV, type Db } from "./setup.js";

type Body = Record<string, any>;
const AC = "sim-bridge:ac";
const DOOR = "sim-bridge:door";
const PRESENCE = "sim-bridge:presence";
/** The fake applier's devices, each with a bound, with an IR air conditioner whose bound is not known and a door sensor. */
const ALL = [...DEVICES.map((d) => ({ ...d, fresh_s: 60 })),
  { id: AC, label: "ac", class: "ac", capabilities: ["climate"], adopted: true, feedback: "open", fresh_s: null,
    actions: [{ action: "climate.set_mode", tier: "reversible" }] },
  { id: DOOR, label: "door", class: "sensor", capabilities: ["sensor"], sensor_keys: ["opening"], adopted: true, fresh_s: 60, actions: [] },
  { id: PRESENCE, label: "presence", class: "sensor", capabilities: ["sensor"], sensor_keys: ["occupancy"], adopted: true, fresh_s: 60, fresh_slack_s: 5, actions: [] }];

/** The values each device reports at the start, all live. */
const START: Record<string, Body> = { [LAMP]: { on: false }, [DIMMER]: { on: false }, [DOOR]: { opening: false }, [TV]: {}, [AC]: {},
  [PRESENCE]: { occupancy: false }, "sim-bridge:channel": {} };

/** A steward over the fake applier with the devices above, the furnished house, and the applier's state read. */
export async function scened(o: { mutation?: Mutation; db?: Db; clock?: FakeClock; values?: Record<string, Body>; devices?: Body[] } = {}) {
  const clock = o.clock ?? new FakeClock();
  const at = new Date(clock.now()).toISOString();
  const values = o.values ?? START;
  const state = { targets: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, { liveness: "live",
    values: Object.entries(v).map(([key, value]) => (value && typeof value === "object" && "assumed" in value
      ? { key, value: value.value, basis_time: at, assumed: true } : { key, value, basis_time: at })) }])), transports: [], latches: [] };
  const s = await setup({ clock, db: o.db, mutation: o.mutation, devices: o.devices ?? ALL, state, options: { pruneEveryMs: 3_600_000 } });
  return { ...s, state };
}

const off = { target: LAMP, action: "onoff.turn_off", args: {} };

describe("scenarios at define", () => {
  it("lists the scenarios in describe with the one mode it runs, and reads them back after a restart (GA-SCN-5)", async () => {
    const db = lasting(await memoryDb());
    const { ok, define, steward, store } = await scened({ db });
    const sc = { id: "night", name: "Ночь", mode: "single", steps: [off, { delay: 5 }] };
    await define([up("scenario", sc)]);
    const d = await ok(SECRETS.owner, "describe");
    expect(d.modes).toEqual(["single"]);
    expect(d.scenarios).toEqual([{ ...sc, owned: [], respect_occupancy: false }]);
    await store.settled();
    steward.stop();
    const again = await scened({ db });
    expect((await again.ok(SECRETS.owner, "describe")).scenarios).toEqual([{ ...sc, owned: [], respect_occupancy: false }]);
  });

  it("refuses a run step cycle with cycle, changing nothing (GA-DEF-4)", async () => {
    const { ok, call, define } = await scened();
    await define([up("scenario", { id: "a", name: "A", mode: "single", steps: [off] })]);
    const before = await ok(SECRETS.owner, "describe");
    const r = await call(SECRETS.owner, "define", { endpoint: "owner-app", expected_revision: before.revision, dry_run: false,
      changes: [up("scenario", { id: "a", name: "A", mode: "single", steps: [{ run: "b" }] }), up("scenario", { id: "b", name: "B", mode: "single", steps: [{ run: "a" }] })] });
    expect(r).toMatchObject({ ok: false, error: "cycle" });
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
  });

  it("raises a notice naming the scenario and each device its if steps read whose fresh_s is not known (GA-RULE-2)", async () => {
    const { ok, define, clock } = await scened();
    const { cursor } = await ok(SECRETS.owner, "events");
    await define([up("scenario", { id: "cool", name: "Прохлада", mode: "single", steps: [
      { if: { target: AC, key: "mode", op: "eq", value: "cool" }, then: [off], else: [{ if: { target: LAMP, key: "on", op: "eq", value: true }, then: [off] }] },
      { wait: { target: AC, key: "mode", value: "heat", timeout_s: 5 } }] })]);
    await vi.waitFor(async () => {
      clock.advance(0);
      const raised = (await eventsSince(ok, cursor, "notice")).filter((e: Body) => e.change === "raised");
      expect(raised.map((e: Body) => [e.cause, e.text])).toEqual([["scenario_unbounded",
        `scenario cool has an if reading ${AC}, whose fresh_s is not known: the if can never hold on it until a bound is set (GA-RULE-2)`]]);
    });
  });

  it("takes a rule's action that starts a scenario, and refuses one naming none", async () => {
    const { ok, call, define } = await scened();
    await define([up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [off] }),
      up("rule", { id: "door", name: "Дверь", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "night" }] })]);
    expect((await ok(SECRETS.owner, "describe")).rules.map((r: Body) => r.actions)).toEqual([[{ scenario: "night" }]]);
    const r = await call(SECRETS.owner, "define", { endpoint: "owner-app", expected_revision: (await ok(SECRETS.owner, "describe")).revision, dry_run: false,
      changes: [{ op: "delete", kind: "scenario", value: { id: "night" } }] });
    expect(r).toMatchObject({ ok: false, error: "invalid_request" });
  });
});


/** A plan's steps as `step_id target verdict(reason)`, a conditional one marked `?`. */
const shown = (plan: Body) => (plan.steps as Body[]).map((x) => `${x.step_id} ${x.target} ${x.verdict}${x.reason ? `(${x.reason})` : ""}${x.conditional ? "?" : ""}`);

describe("scenario_plan (GA-SCN-6)", () => {
  const scenes = [up("scenario", { id: "inner", name: "Внутри", mode: "single", steps: [{ target: TV, action: "onoff.turn_off", args: {} }] }),
    up("scenario", { id: "evening", name: "Вечер", mode: "single", steps: [{ target: LAMP, action: "onoff.turn_on", args: {} }, { delay: 5 },
      { if: { target: LAMP, key: "on", op: "eq", value: true }, then: [{ target: DIMMER, action: "onoff.turn_on", args: {} }],
        else: [{ run: "inner" }] },
      { target: "hall-lights", action: "onoff.turn_off", args: {} }, { run: "inner" }] })];

  it("gives one step per action step in order, run steps expanded, an if's planned as taken and marked conditional, a group's members each a step", async () => {
    const { ok, define } = await scened();
    await define(scenes);
    const plan = await ok(SECRETS.olga, "scenario_plan", { scenario: "evening", endpoint: "olga-app" });
    expect(validate("steward/scenario_plan.response.json", plan)).toEqual([]);
    expect(plan.request).toEqual({ endpoint: "olga-app", scenario: "evening" });
    expect(shown(plan)).toEqual([`s1 ${LAMP} op`, `s2 ${DIMMER} ask(confirm_tier)?`, `s3 ${TV} ask(toggle_only)?`,
      `s4.1 ${DIMMER} ask(confirm_tier)`, `s4.2 ${LAMP} op`, `s5 ${TV} ask(toggle_only)`]);
  });

  it("judges as the principal of the endpoint named: a guest's confirm step refuse(role), and puts the plan's asks as its ask event", async () => {
    const { ok, define } = await scened();
    await define(scenes);
    const { cursor } = await ok(SECRETS.owner, "events");
    const plan = await ok(SECRETS.panel, "scenario_plan", { scenario: "evening", endpoint: "hall-panel" });
    expect(shown(plan)).toEqual([`s1 ${LAMP} op`, `s2 ${DIMMER} refuse(role)?`, `s3 ${TV} ask(toggle_only)?`,
      `s4.1 ${DIMMER} refuse(role)`, `s4.2 ${LAMP} op`, `s5 ${TV} ask(toggle_only)`]);
    expect((await eventsSince(ok, cursor, "ask")).map((e: Body) => [e.plan_id, e.step_ids, e.endpoint])).toEqual([[plan.plan_id, ["s3", "s5"], "hall-panel"]]);
  });

  it("refuses an unknown scenario with invalid_request, an endpoint not bound to the credential with not_permitted, and an apply of a scenario's plan", async () => {
    const { ok, error, define } = await scened();
    await define(scenes);
    expect(await error(SECRETS.olga, "scenario_plan", { scenario: "nowhere", endpoint: "olga-app" })).toBe("invalid_request");
    expect(await error(SECRETS.olga, "scenario_plan", { scenario: "evening", endpoint: "hall-panel" })).toBe("not_permitted");
    const plan = await ok(SECRETS.olga, "scenario_plan", { scenario: "evening", endpoint: "olga-app" });
    expect(await error(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: "k" })).toBe("invalid_request");
  });

  it("keeps a step it could not plan on the applier failing closed though it is marked conditional: the run sends nothing for it (the milestone review, B4)", async () => {
    const { ok, define, applier } = await scened();
    applier.answerOutcome = "acked";
    await define([up("scenario", { id: "maybe", name: "Может быть", mode: "single", steps: [{ if: { target: LAMP, key: "on", op: "eq", value: false },
      then: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }] })]);
    applier.failNext.set("plan", new Error("the plan call timed out"));
    const plan = await ok(SECRETS.olga, "scenario_plan", { scenario: "maybe", endpoint: "olga-app" });
    expect(shown(plan)).toEqual([`s1 ${LAMP} skip(dead)?`]);
    const { run_id } = await ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    const st = await vi.waitFor(async () => {
      const x = await ok(SECRETS.olga, "scenario_status", { run_id });
      expect(x.status).toBe("ended");
      return x;
    });
    expect(st.failed_steps.map((x: Body) => x.outcome)).toEqual(["unreachable"]);
    expect(applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith("run:"))).toEqual([]);
  });

  it("overwrites a notify's from with the endpoint's and its role, marked from_replaced (GA-NOTE-2)", async () => {
    const { ok, define } = await scened();
    await define([up("scenario", { id: "say", name: "Сказать", mode: "single", steps: [{ target: "sim-bridge:channel", action: "notify.notify",
      args: { text: "привет", from: { notice: "x" } } }] })]);
    const plan = await ok(SECRETS.olga, "scenario_plan", { scenario: "say", endpoint: "olga-app" });
    expect(plan.steps.map((x: Body) => [x.args, x.from_replaced])).toEqual([[{ text: "привет", from: { endpoint: "olga-app", role: "member" } }, true]]);
  });
});

/** A scenario `id` of `steps`, with `extra` over it, as an upsert. */
const scene = (id: string, steps: unknown[], extra: Body = {}) => up("scenario", { id, name: id, mode: "single", steps, ...extra });
const on = { target: LAMP, action: "onoff.turn_on", args: {} };

/** A steward whose fake applier settles each step `acked` in its answer, with `scenes` defined; `start` plans and runs one as Ольга. */
async function running(scenes: unknown[], o: Parameters<typeof scened>[0] = {}) {
  const s = await scened(o);
  s.applier.answerOutcome = "acked";
  await s.define(scenes);
  let n = 0;
  const start = async (scenario: string, as: { secret?: string; endpoint?: string; answers?: Body } = {}) => {
    const plan = await s.ok(as.secret ?? SECRETS.olga, "scenario_plan", { scenario, endpoint: as.endpoint ?? "olga-app" });
    if (as.answers) await s.ok(as.secret ?? SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: as.endpoint ?? "olga-app", answers: as.answers });
    const r = await s.ok(as.secret ?? SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: `k${++n}` });
    return { plan, run_id: r.run_id as string, r };
  };
  // Read as the owner's app, which reads every run (ruled 2026-10-05).
  const status = (run_id: string) => s.ok(SECRETS.owner, "scenario_status", { run_id });
  const until = async (run_id: string, want: string) => vi.waitFor(async () => {
    s.clock.advance(0);
    const st = await status(run_id);
    expect(`${st.status}${st.reason ? `(${st.reason})` : ""}`).toBe(want);
    return st;
  });
  return { ...s, start, status, until };
}

describe("scenario_run and a run's steps", () => {
  it("dispatches each action step as one applier apply keyed run:<run_id>:<n>, as the starter at the starting endpoint, waiting out a delay (GA-STW-10, GA-AUTH-5, GA-SCN-3)", async () => {
    const { start, until, applier, clock, ok, store } = await running([scene("evening", [on, { delay: 30 }, off])]);
    const { cursor } = await ok(SECRETS.owner, "events");
    const { run_id } = await start("evening");
    await vi.waitFor(() => expect(applier.applies.length).toBe(1));
    expect(applier.applies[0]).toMatchObject({ idempotency_key: `run:${run_id}:1`, request: { actions: [{ target: LAMP, action: "onoff.turn_on", via: "app", brain: false,
      for: { run: run_id, person: "olga", endpoint: "olga-app" } }] } });
    clock.advance(29_000);
    await quiet(store);
    expect(applier.applies.length).toBe(1);
    clock.advance(1_000);
    const st = await until(run_id, "ended(done)");
    expect(applier.applies.map((a: Body) => a.idempotency_key)).toEqual([`run:${run_id}:1`, `run:${run_id}:2`]);
    expect(st).toEqual({ run_id, status: "ended", reason: "done", failed_steps: [], sent_steps: [] });
    const events = (await eventsSince(ok, cursor, "scenario")).map((e: Body) => [e.change, e.reason ?? null, e.cause]);
    expect(events).toEqual([["started", null, { run: run_id, person: "olga", endpoint: "olga-app" }], ["ended", "done", { run: run_id, person: "olga", endpoint: "olga-app" }]]);
  });

  it("names the starting endpoint in a run's cause, a panel's with no person; drops-the-starting-endpoint leaves it out (GA-SCN-3)", async () => {
    for (const mutation of [undefined, "drops-the-starting-endpoint"] as const) {
      const { start, until, applier } = await running([scene("evening", [on])], { mutation });
      const { run_id } = await start("evening", { secret: SECRETS.panel, endpoint: "hall-panel" });
      await until(run_id, "ended(done)");
      expect(applier.applies[0].request.actions[0].for).toEqual(mutation ? { run: run_id } : { run: run_id, endpoint: "hall-panel" });
      expect(applier.applies[0].request.actions[0]).toMatchObject({ via: "panel", brain: false });
    }
  });

  it("returns the first run for a repeated key and starts nothing; another plan under it is idempotency_conflict; a single scenario running ignores a start (GA-SCN-6, GA-SCN-1)", async () => {
    const { ok, error, applier } = await running([scene("evening", [on, { delay: 60 }])]);
    const plan = await ok(SECRETS.olga, "scenario_plan", { scenario: "evening", endpoint: "olga-app" });
    const first = await ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "same" });
    expect(await ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "same" })).toEqual({ run_id: first.run_id });
    const other = await ok(SECRETS.olga, "scenario_plan", { scenario: "evening", endpoint: "olga-app" });
    expect(await error(SECRETS.olga, "scenario_run", { plan_id: other.plan_id, idempotency_key: "same" })).toBe("idempotency_conflict");
    expect(await ok(SECRETS.olga, "scenario_run", { plan_id: other.plan_id, idempotency_key: "again" })).toEqual({ run_id: first.run_id, ignored: true });
    expect(await ok(SECRETS.olga, "scenario_run", { plan_id: other.plan_id, idempotency_key: "again" })).toEqual({ run_id: first.run_id, ignored: true });
    expect(await error(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "third" })).toBe("plan_expired");
    await vi.waitFor(() => expect(applier.applies.length).toBe(1));
    expect(await error(SECRETS.olga, "scenario_status", { run_id: "nowhere" })).toBe("unknown_run");
    const req = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on] });
    expect(await error(SECRETS.olga, "scenario_run", { plan_id: req.plan_id, idempotency_key: "req" })).toBe("invalid_request");
    expect(await error(SECRETS.panel, "scenario_run", { plan_id: other.plan_id, idempotency_key: "p" })).toBe("plan_not_yours");
  });

  it("leases its owned targets, a group's members each, until it ends, and releases only its own (GA-SCN-2)", async () => {
    const { ok, start, until, clock } = await running([scene("evening", [{ delay: 60 }], { owned: ["hall-lights", "sim-bridge:channel"] })]);
    const { run_id } = await start("evening");
    const leases = async () => Object.fromEntries(Object.entries((await ok(SECRETS.owner, "state")).leases as Body).map(([t, l]) => [t, [l.holder, l.precedence, l.expires]]));
    await vi.waitFor(async () => expect(await leases()).toEqual({ [DIMMER]: [{ run: run_id }, "person", "run_end"], [LAMP]: [{ run: run_id }, "person", "run_end"],
      "sim-bridge:channel": [{ run: run_id }, "person", "run_end"] }));
    // Ольга's own apply on the lamp replaces the run's lease there: the run releases only its own.
    await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on] }, idempotency_key: "mine" });
    clock.advance(60_000);
    await until(run_id, "ended(done)");
    expect(Object.keys(await leases())).toEqual([LAMP]);
    expect((await leases())[LAMP]![0]).toEqual({ person: "olga", endpoint: "olga-app" });
  });

  it("re-checks each step at its dispatch: occupied at plan, the room vacant by then, the step is sent; an unanswered ask is skipped(not_confirmed), a yes's step sent with its token (GA-SCN-7)", async () => {
    const { start, until, applier, clock, steward, define } = await running([scene("evening", [{ delay: 400 }, on, { target: DIMMER, action: "onoff.turn_on", args: {} },
      { target: TV, action: "onoff.turn_off", args: {} }], { respect_occupancy: false })]);
    await define([up("target", { id: PRESENCE, room: "hall" }), scene("lit", [{ delay: 400 }, { ...on, respect_occupancy: true }])]);
    steward.onEvents([{ seq: 1, type: "state", target: PRESENCE, key: "occupancy", value: true, basis_time: new Date(clock.now()).toISOString(), cause: "device" }]);
    const lit = await start("lit");
    expect(lit.plan.steps.map((x: Body) => `${x.verdict}(${x.reason})`)).toEqual(["skip(occupied)"]);
    steward.onEvents([{ seq: 2, type: "state", target: PRESENCE, key: "occupancy", value: false, basis_time: new Date(clock.now()).toISOString(), cause: "device" }]);
    const evening = await start("evening", { answers: { s2: "yes" } });
    clock.advance(400_000);
    await until(lit.run_id, "ended(done)");
    const st = await until(evening.run_id, "ended(done)");
    expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s3 skipped(not_confirmed)"]);
    const sent = applier.applies.flatMap((a: Body) => a.request.actions.map((x: Body) => `${x.target} ${x.token ? "token" : "none"}`));
    expect(sent.sort()).toEqual([`${DIMMER} token`, `${LAMP} none`, `${LAMP} none`].sort());
  });

  it("reads an if when reached: one branch; on a dead or stale device, or an assumed value, the else, or none, skipped(dead), skipped(stale) or skipped(assumed) in failed_steps (GA-SCN-8)", async () => {
    const iff = (target: string, key: string, value: unknown, withElse: boolean) => ({ if: { target, key, op: "eq", value }, then: [on],
      ...(withElse ? { else: [off] } : {}) });
    const values = { ...START, [AC]: { mode: { value: "cool", assumed: true } } };
    const { start, until, applier, steward, clock } = await running([scene("a", [iff(AC, "mode", "cool", false)]), scene("b", [iff(AC, "mode", "cool", true)]),
      scene("c", [iff(LAMP, "on", false, false)]), scene("d", [iff(DOOR, "opening", false, false)]), scene("e", [iff(DIMMER, "on", false, false)])], { values });
    steward.onEvents([{ seq: 1, type: "liveness", target: DOOR, old: "live", new: "dead" }, { seq: 2, type: "liveness", target: DIMMER, old: "live", new: "stale" }]);
    const shownOf = async (id: string) => {
      const before = applier.applies.length;
      const st = await until((await start(id)).run_id, "ended(done)");
      clock.advance(0);
      return [st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`), applier.applies.slice(before).filter((a: Body) => a.idempotency_key.startsWith("run:")).map((a: Body) => a.request.actions[0].action)];
    };
    expect(await shownOf("a")).toEqual([["if1 skipped(assumed)"], []]);
    expect(await shownOf("b")).toEqual([[], ["onoff.turn_off"]]);
    expect(await shownOf("c")).toEqual([[], ["onoff.turn_on"]]);
    expect(await shownOf("d")).toEqual([["if1 skipped(dead)"], []]);
    expect(await shownOf("e")).toEqual([["if1 skipped(stale)"], []]);
  });

  it("runs the then branch on an assumed value under branches-on-an-assumed-value, and reports skipped(stale) under stales-an-assumed-if", async () => {
    const values = { ...START, [AC]: { mode: { value: "cool", assumed: true } } };
    for (const [mutation, want] of [["branches-on-an-assumed-value", [[], 1]], ["stales-an-assumed-if", [["if1 skipped(stale)"], 0]]] as const) {
      const { start, until, applier } = await running([scene("a", [{ if: { target: AC, key: "mode", op: "eq", value: "cool" }, then: [on] }])], { values, mutation });
      const st = await until((await start("a")).run_id, "ended(done)");
      expect([st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`), applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).length]).toEqual(want);
    }
  });

  it("waits for a value, and on a timeout records it, ending the run ended(timeout) with stop and going on with continue (GA-SCN-10)", async () => {
    const wait = (on_timeout?: string) => ({ wait: { target: DOOR, key: "opening", value: true, timeout_s: 60, ...(on_timeout ? { on_timeout } : {}) } });
    const { start, until, applier, steward, clock, ok } = await running([scene("met", [wait(), on]), scene("stop", [wait(), on]), scene("go", [wait("continue"), off])]);
    const { cursor } = await ok(SECRETS.owner, "events");
    const met = await start("met");
    clock.advance(30_000);
    steward.onEvents([{ seq: 1, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(clock.now()).toISOString(), cause: "device" }]);
    await until(met.run_id, "ended(done)");
    steward.onEvents([{ seq: 2, type: "state", target: DOOR, key: "opening", value: false, basis_time: new Date(clock.now()).toISOString(), cause: "device" }]);
    const stop = await start("stop");
    const go = await start("go");
    await vi.waitFor(() => expect(applier.applies.length).toBe(1));
    clock.advance(60_000);
    await until(stop.run_id, "ended(timeout)");
    await until(go.run_id, "ended(done)");
    expect(applier.applies.map((a: Body) => a.idempotency_key)).toEqual([`run:${met.run_id}:1`, `run:${go.run_id}:1`]);
    const timeouts = (await eventsSince(ok, cursor, "scenario")).filter((e: Body) => e.change === "wait_timeout").map((e: Body) => [e.run_id, e.on_timeout]);
    expect(timeouts.sort()).toEqual([[stop.run_id, "stop"], [go.run_id, "continue"]].sort());
  });

  it("ends a run ended(timeout) at the run limit, its later steps never sent and its leases released", async () => {
    const { start, until, applier, clock, ok, store } = await running([scene("long", [{ delay: 7 * 3600 }, on], { owned: [LAMP] })]);
    const { run_id } = await start("long");
    clock.advance(6 * 3600_000);
    await until(run_id, "ended(timeout)");
    clock.advance(3600_000);
    await quiet(store);
    expect(applier.applies.length).toBe(0);
    expect((await ok(SECRETS.owner, "state")).leases).toEqual({});
  });

  it("lists in failed_steps what did not succeed, leaving out skipped(occupied) and a failed step with its late ack, sent ones in sent_steps (GA-SCN-11)", async () => {
    const { tally } = await import("../src/scenarios/run.js");
    const o = (step_id: string, outcome: string, reason?: string) => ({ step_id, target: LAMP, outcome, ...(reason ? { reason } : {}), time: "2030-01-01T08:00:00.000Z" }) as never;
    const run = { entries: [{ apply_id: "a", outcomes: [o("s1", "acked"), o("s2", "skipped", "occupied"), o("s3", "skipped", "occupancy_unknown"), o("s4", "skipped", "not_confirmed"),
      o("s5", "skipped", "toggle_only"), o("s6", "failed", "no_ack"), o("s7", "failed", "no_ack"), o("s8", "sent"), o("s9", "dispatched"), o("s10", "unanswered"),
      o("s11", "skipped", "already"), o("s12", "refused", "leased")] }, o("if1", "skipped", "assumed")], lateAcked: new Set(["s7"]), lost: new Set() } as never;
    const t = tally(run);
    expect(t.failed_steps.map((x: Body) => x.step_id)).toEqual(["s3", "s4", "s5", "s6", "s10", "s12", "if1"]);
    expect(t.sent_steps).toEqual([{ step_id: "s8" }]);
  });

  it("commits a run step's record, naming the step, before it sends the step while the store is up (the design, *Decisions*)", async () => {
    const db = await memoryDb();
    const { start, until, applier, clock } = await running([scene("later", [{ delay: 5 }, on])], { db });
    const seen: Promise<unknown>[] = [];
    const push = applier.applies.push.bind(applier.applies);
    applier.applies.push = (...b: Body[]) => {
      seen.push(db.query<{ doc: Body }>("SELECT doc FROM runs").then((x) => x.rows.map((r) => r.doc.step ?? null)));
      return push(...b);
    };
    const { run_id } = await start("later");
    clock.advance(5_000);
    await until(run_id, "ended(done)");
    expect(await Promise.all(seen)).toEqual([[1]]);
  });

  it("sends nothing for a step whose record the store did not keep within the gate, and writes it behind once the store is known down (ruled, Q6)", async () => {
    const db = await memoryDb();
    const { start, until, status, applier, clock, store } = await running([scene("later", [{ delay: 5 }, on, { delay: 5 }, off])], { db });
    const { run_id } = await start("later");
    db.trouble.down = true;
    clock.advance(5_000);
    await vi.waitFor(() => expect(store.down).toBe(true));
    clock.advance(10_000);
    await vi.waitFor(async () => expect((await status(run_id)).failed_steps).toHaveLength(1));
    clock.advance(5_000);
    const st = await until(run_id, "ended(done)");
    expect(st.failed_steps).toMatchObject([{ step_id: "s1", outcome: "unreachable" }]);
    expect(applier.applies.map((a: Body) => a.idempotency_key)).toEqual([`run:${run_id}:2`]);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1_000); expect(store.down).toBe(false); });
    await store.settled();
    expect((await db.query<{ doc: Body }>("SELECT doc FROM runs")).rows.map((r) => [r.doc.status, r.doc.step])).toEqual([["ended", 2]]);
  });

  it("ends a run a restart interrupted ended(interrupted), releases its leases, and still finds its key", async () => {
    const db = lasting(await memoryDb());
    const first = await running([scene("long", [{ delay: 600 }, on], { owned: [LAMP] })], { db });
    const plan = await first.ok(SECRETS.olga, "scenario_plan", { scenario: "long", endpoint: "olga-app" });
    const { run_id } = await first.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    await vi.waitFor(async () => expect(Object.keys((await first.ok(SECRETS.owner, "state")).leases)).toEqual([LAMP]));
    await first.store.settled();
    first.steward.stop();
    const again = await scened({ db, clock: first.clock });
    expect(await again.ok(SECRETS.olga, "scenario_status", { run_id })).toEqual({ run_id, status: "ended", reason: "interrupted", failed_steps: [], sent_steps: [] });
    expect((await again.ok(SECRETS.owner, "state")).leases).toEqual({});
    expect(await again.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" })).toEqual({ run_id });
  });

  it("stops a run ended(stopped), nothing more sent and its leases released; a lower role than the starter's is not_permitted; an unknown run unknown_run (GA-SCN-9)", async () => {
    const { start, until, applier, clock, ok, error, store } = await running([scene("long", [on, { delay: 600 }, off], { owned: [LAMP] })]);
    const { run_id } = await start("long", { secret: SECRETS.owner, endpoint: "owner-app" });
    await vi.waitFor(() => expect(applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).length).toBe(1));
    expect(await error(SECRETS.olga, "scenario_stop", { run_id, endpoint: "olga-app" })).toBe("not_permitted");
    expect(await error(SECRETS.olga, "scenario_stop", { run_id: "nowhere", endpoint: "olga-app" })).toBe("unknown_run");
    const st = await ok(SECRETS.owner, "scenario_stop", { run_id, endpoint: "owner-app" });
    expect(st).toEqual({ run_id, status: "ended", reason: "stopped", failed_steps: [], sent_steps: [] });
    clock.advance(600_000);
    await quiet(store);
    expect(applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).length).toBe(1);
    expect((await ok(SECRETS.owner, "state")).leases).toEqual({});
    expect(await until(run_id, "ended(stopped)")).toEqual(st);
    const olgas = await start("long");
    expect((await ok(SECRETS.owner, "scenario_stop", { run_id: olgas.run_id, endpoint: "owner-app" })).reason).toBe("stopped");
  });

  it("starts a run when a rule fires, as the rule (via rule, cause { run, rule }, authored, a toggle skipped), and a start while it runs is ignored as landed, no notice (GA-SCN-4, GA-AUTH-5)", async () => {
    const door = up("rule", { id: "door", name: "Дверь", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "night" }] });
    const { applier, steward, clock, ok, until } = await running([scene("night", [on, { delay: 60 }, { target: TV, action: "onoff.turn_off", args: {} },
      { target: "sim-bridge:channel", action: "notify.notify", args: { text: "дверь" } }]), door]);
    const { cursor } = await ok(SECRETS.owner, "events");
    const opening = (seq: number, value: boolean) => steward.onEvents([{ seq, type: "state", target: DOOR, key: "opening", value,
      basis_time: new Date(clock.now()).toISOString(), cause: "device" }]);
    opening(1, true);
    const runs = () => applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:"));
    await vi.waitFor(() => expect(runs().length).toBe(1));
    const run_id = runs()[0].idempotency_key.split(":")[1];
    expect(runs()[0]).toMatchObject({ idempotency_key: `run:${run_id}:1`, request: { actions: [{ target: LAMP, via: "rule", brain: false, for: { run: run_id, rule: "door" } }] } });
    opening(2, false);
    opening(3, true);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "scenario")).map((e: Body) => e.change)).toEqual(["started", "ignored"]));
    clock.advance(60_000);
    const st = await until(run_id, "ended(done)");
    expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s2 skipped(toggle_only)"]);
    expect(runs().map((a: Body) => a.request.actions[0].args)).toEqual([{}, { text: "дверь", from: { rule: "door" } }]);
    expect(await eventsSince(ok, cursor, "notice")).toEqual([]);
  });

  it("asks a toggle step again when its yes is older than ask_expiry_s, open to that answer alone though the plan was run and the house moved; no yes by then is skipped(not_confirmed) (GA-SCN-3)", async () => {
    const tvOff = { target: TV, action: "onoff.turn_off", args: {} };
    const { start, until, applier, clock, ok, error, define } = await running([scene("late", [{ delay: 400 }, tvOff]), scene("soon", [{ delay: 100 }, tvOff])]);
    const { cursor } = await ok(SECRETS.owner, "events");
    const late = await start("late", { answers: { s1: "yes" } });
    clock.advance(400_000);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "ask")).at(-1)).toMatchObject({ plan_id: late.plan.plan_id, step_ids: ["s1"], run_id: late.run_id }));
    expect(applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).length).toBe(0);
    await define([up("scenario", { id: "other", name: "other", mode: "single", steps: [{ delay: 1 }] })]);
    expect(await error(SECRETS.olga, "answer", { plan_id: late.plan.plan_id, endpoint: "olga-app", answers: { s2: "yes" } })).toBe("invalid_request");
    await ok(SECRETS.olga, "answer", { plan_id: late.plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    await until(late.run_id, "ended(done)");
    expect(applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).map((a: Body) => [a.request.actions[0].target, !!a.request.actions[0].token]))
      .toEqual([[TV, true]]);
    // Asked again and not answered: skipped(not_confirmed) once ask_expiry_s has passed; a yes given then is too late.
    const again = await start("late", { answers: { s1: "yes" } });
    clock.advance(400_000);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "ask")).at(-1)).toMatchObject({ run_id: again.run_id }));
    clock.advance(300_000);
    const st = await until(again.run_id, "ended(done)");
    expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s1 skipped(not_confirmed)"]);
    // No longer open: the plan was run (not_permitted) or, past its keeping, forgotten (invalid_request).
    expect(["not_permitted", "invalid_request"]).toContain(await error(SECRETS.olga, "answer", { plan_id: again.plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } }));
    // Within ask_expiry_s of the yes: no new ask.
    const before = (await eventsSince(ok, cursor, "ask")).length;
    const soon = await start("soon", { answers: { s1: "yes" } });
    clock.advance(100_000);
    await until(soon.run_id, "ended(done)");
    expect((await eventsSince(ok, cursor, "ask")).length).toBe(before + 1);
  });

  it("dispatches the toggle on the old yes with no new ask under toggles-on-an-old-yes", async () => {
    const { start, until, applier, clock, ok } = await running([scene("late", [{ delay: 400 }, { target: TV, action: "onoff.turn_off", args: {} }])], { mutation: "toggles-on-an-old-yes" });
    const { cursor } = await ok(SECRETS.owner, "events");
    const late = await start("late", { answers: { s1: "yes" } });
    clock.advance(400_000);
    await until(late.run_id, "ended(done)");
    expect(applier.applies.filter((a: Body) => a.idempotency_key.startsWith("run:")).length).toBe(1);
    expect((await eventsSince(ok, cursor, "ask")).length).toBe(1);
  });
});
