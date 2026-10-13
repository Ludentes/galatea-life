import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, eventsSince, heardAt, LAMP, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const CHANNEL = "sim-bridge:channel";
const MINUTE = 60_000;
const STATE = { targets: Object.fromEntries(DEVICES.map((d) => [d.id, { liveness: "live", values: d.id === LAMP || d.id === DIMMER
  ? [{ key: "on", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : [] }])), transports: [], latches: [] };
const dimmerOn = { target: DIMMER, action: "onoff.turn_on", args: {} };
const lampOn = { target: LAMP, action: "onoff.turn_on", args: {} };
const note = { target: CHANNEL, action: "notify.notify", args: { text: "вечер" } };
const scene = (id: string, steps: unknown[]) => up("scenario", { id, name: id, mode: "single", steps });
/** A rule that acts once the lamp turns on. */
const whenLampOn = (id: string, actions: unknown[]) => up("rule", { id, name: id, trigger: { state: { target: LAMP, key: "on", op: "eq", value: true } }, actions });

/**
 * A steward over the fake applier, which settles each step `acked` in its answer, the owner's chat
 * window that the brain serves defined, at 2030-01-01 11:00 in Moscow; `byBrain` defines through the
 * brain at it, the owner saying yes; `sentBy(prefix)` the actions the steward sent under keys of it.
 */
async function worked(o: { mutation?: Mutation } = {}) {
  const s = await setup({ state: STATE, mutation: o.mutation, options: { pruneEveryMs: 24 * 3_600_000 } });
  s.applier.answerOutcome = "acked";
  await s.define([OWNER_CHAT]);
  const byBrain = async (changes: unknown[]) => {
    const revision = (await s.ok(SECRETS.owner, "describe")).revision;
    const plan = await s.ok(SECRETS.brain, "define", { endpoint: "owner-chat", changes, expected_revision: revision, dry_run: false });
    await s.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
      utterance: heardAt(s.clock, "owner-chat", { addressed_by: "typed" }) });
    return s.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
  };
  const sentBy = (prefix: string) => s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith(prefix))
    .flatMap((a: Body) => a.request.actions as Body[]);
  const lampTurns = async (on: boolean) => {
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: on, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
    await s.pump();
  };
  return { ...s, byBrain, sentBy, lampTurnsOn: () => lampTurns(true), lampTurnsOff: () => lampTurns(false) };
}

/** An action as `target brain token from`, what the applier is told of who wrote it. */
const shown = (a: Body) => `${a.target} brain:${a.brain} token:${a.token !== undefined}${a.args?.from ? ` from:${JSON.stringify(a.args.from)}` : ""}`;

describe("brain_authored work (GA-DEF-7, GA-NOTE-2)", () => {
  it("refuses a brain's rule's step above reversible refuse(tier), sends the rest with brain: true and no token, and marks its notify's from; the owner's redefinition clears it", async () => {
    const { byBrain, define, sentBy, lampTurnsOn, lampTurnsOff, ok, store } = await worked();
    await byBrain([whenLampOn("dark", [dimmerOn, note])]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await lampTurnsOn();
    await vi.waitFor(() => expect(sentBy("rule:dark:")).toHaveLength(1));
    expect(sentBy("rule:dark:").map(shown)).toEqual([`${CHANNEL} brain:true token:false from:{"rule":"dark","brain_authored":true}`]);
    const refused = await eventsSince(ok, cursor, "refused");
    expect(refused.map((e) => [e.rule, e.target, e.reason])).toEqual([["dark", DIMMER, "tier"]]);
    // The owner redefines the rule whole: the mark goes, and its confirm step gets the author's token.
    await define([whenLampOn("dark", [dimmerOn, note])]);
    expect((await ok(SECRETS.owner, "describe")).rules[0].brain_authored).toBeUndefined();
    await lampTurnsOff();
    await quiet(store);
    await lampTurnsOn();
    await vi.waitFor(() => expect(sentBy("rule:dark:")).toHaveLength(3));
    expect(sentBy("rule:dark:").slice(1).map(shown)).toEqual([`${DIMMER} brain:false token:true`, `${CHANNEL} brain:false token:false from:{"rule":"dark"}`]);
  });

  it("marks a person's run of a brain's scenario: its plan's steps brain_authored, the confirm one refuse(tier), the rest sent with brain: true; an owner's scenario running it marks only its steps", async () => {
    const { byBrain, define, ok, sentBy } = await worked();
    await byBrain([scene("cosy", [dimmerOn, lampOn])]);
    await define([scene("evening", [{ target: LAMP, action: "onoff.turn_off", args: {} }, { run: "cosy" }])]);
    const d = await ok(SECRETS.owner, "describe");
    expect(d.scenarios.map((x: Body) => [x.id, x.brain_authored ?? false])).toEqual([["cosy", true], ["evening", false]]);
    const plan = await ok(SECRETS.owner, "scenario_plan", { scenario: "evening", endpoint: "owner-app" });
    expect(validate("steward/scenario_plan.response.json", plan)).toEqual([]);
    expect(plan.steps.map((x: Body) => [x.step_id, x.target, x.verdict, x.reason ?? null, x.brain_authored ?? false])).toEqual([
      ["s1", LAMP, "op", null, false], ["s2", DIMMER, "refuse", "tier", true], ["s3", LAMP, "op", null, true]]);
    const { run_id } = await ok(SECRETS.owner, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    await vi.waitFor(() => expect(sentBy(`run:${run_id}:`)).toHaveLength(2));
    expect(sentBy(`run:${run_id}:`).map((a) => `${a.target} ${a.action} via:${a.via} brain:${a.brain}`))
      .toEqual([`${LAMP} onoff.turn_off via:app brain:false`, `${LAMP} onoff.turn_on via:app brain:true`]);
  });

  it("marks a run a brain's rule starts, though the owner wrote the scenario", async () => {
    const { byBrain, define, sentBy, lampTurnsOn, ok } = await worked();
    await define([scene("evening", [dimmerOn, note])]);
    await byBrain([whenLampOn("dusk", [{ scenario: "evening" }])]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await lampTurnsOn();
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "refused")).map((e) => [e.target, e.reason])).toEqual([[DIMMER, "tier"]]));
    await vi.waitFor(() => expect(sentBy("run:")).toHaveLength(1));
    expect(sentBy("run:").map(shown)).toEqual([`${CHANNEL} brain:true token:false from:{"rule":"dusk","brain_authored":true}`]);
  });

  it("marks the run on a date a brain moved, never the schedule's other dates, nor a brain's skip", async () => {
    const { byBrain, define, sentBy, clock, store, ok } = await worked();
    await define([scene("evening", [dimmerOn, note]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    // Today, a Tuesday, moved to 11:10 through a brain; tomorrow skipped through a brain; the day after, as the owner wrote it.
    await byBrain([up("schedule_exception", { schedule: "dusk", date: "2030-01-01", action: "move", time: "11:10" }),
      up("schedule_exception", { schedule: "dusk", date: "2030-01-02", action: "skip" })]);
    expect((await ok(SECRETS.owner, "describe")).schedules[0].brain_authored).toBeUndefined();
    clock.advance(10 * MINUTE);
    await vi.waitFor(() => expect(sentBy("run:")).toHaveLength(1));
    expect(sentBy("run:").map(shown)).toEqual([`${CHANNEL} brain:true token:false from:{"scenario":"evening","brain_authored":true}`]);
    clock.advance(48 * 60 * MINUTE);
    await quiet(store);
    await vi.waitFor(() => { clock.advance(0); expect(sentBy("run:")).toHaveLength(3); });
    expect(sentBy("run:").slice(1).map(shown)).toEqual([`${DIMMER} brain:false token:true`,
      `${CHANNEL} brain:false token:false from:{"scenario":"evening"}`]);
  });
});
