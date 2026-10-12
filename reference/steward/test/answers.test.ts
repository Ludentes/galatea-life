import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { CLOCK_TOLERANCE_MS } from "../src/confirm/answer.js";
import { MUTATIONS } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { DIMMER, eventsSince, heardAt, LAMP, on, setup } from "./setup.js";

type Body = Record<string, any>;

/** The brain's plan at the kitchen's voice endpoint, naming Olga, asking for the dimmer and turning the lamp on. */
async function brainPlan(ok: (s: string, t: string, a?: Body) => Promise<Body>, speaker: string | undefined = "olga") {
  return ok(SECRETS.brain, "plan", { endpoint: "kitchen-voice", ...(speaker ? { speaker } : {}), actions: [on(DIMMER), on(LAMP)] });
}

describe("answer", () => {
  it("is built, and its mutations are declared", () => {
    for (const m of ["takes-any-answer", "reuses-an-utterance", "answers-unasked-steps", "follow-up-yes"]) expect(MUTATIONS).toContain(m);
  });

  it("takes a yes from the plan's own credential and endpoint, returns the plan with it, puts an answer event and keeps it", async () => {
    const { ok, store } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER), on(LAMP)] });
    const { cursor } = await ok(SECRETS.owner, "events");
    const answered = await ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    expect(validate("steward/answer.response.json", answered)).toEqual([]);
    expect(answered.steps.map((s: Body) => [s.step_id, s.verdict, s.answer])).toEqual([["s1", "ask", "yes"], ["s2", "op", undefined]]);
    expect(answered.plan_id).toBe(plan.plan_id);
    const events = await eventsSince(ok, cursor);
    expect(events.map((e) => [e.type, e.plan_id, e.endpoint, e.answers])).toEqual([["answer", plan.plan_id, "olga-app", { s1: "yes" }]]);
    await store.settled();
    expect((await store.query("SELECT answers FROM plans WHERE plan_id = $1", [plan.plan_id])).rows).toEqual([{ answers: { s1: "yes" } }]);
  });

  it("lets a no replace a yes, and refuses a yes after a no as invalid_request, changing nothing", async () => {
    const { ok, error } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER)] });
    const answer = (a: string) => ({ plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: a } });
    await ok(SECRETS.olga, "answer", answer("yes"));
    expect((await ok(SECRETS.olga, "answer", answer("no"))).steps[0].answer).toBe("no");
    expect(await error(SECRETS.olga, "answer", answer("yes"))).toBe("invalid_request");
    expect((await ok(SECRETS.olga, "answer", answer("no"))).steps[0].answer).toBe("no");
    // A credential not permitted to answer learns nothing of the no: not_permitted comes first.
    expect(await error(SECRETS.owner, "answer", { ...answer("yes"), endpoint: "owner-app" })).toBe("not_permitted");
  });

  it("puts an unknown plan as unknown_plan (GA-PERSIST-2), a plan with no ask and a step not asked as invalid_request (GA-CONF-2)", async () => {
    const { ok, error } = await setup();
    const asked = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER), on(LAMP)] });
    const plain = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(LAMP)] });
    expect(await error(SECRETS.olga, "answer", { plan_id: "no-such-plan", endpoint: "olga-app", answers: { s1: "yes" } })).toBe("unknown_plan");
    expect(await error(SECRETS.olga, "answer", { plan_id: plain.plan_id, endpoint: "olga-app", answers: { s1: "yes" } })).toBe("invalid_request");
    expect(await error(SECRETS.olga, "answer", { plan_id: asked.plan_id, endpoint: "olga-app", answers: { s2: "yes" } })).toBe("invalid_request");
    expect(await error(SECRETS.olga, "answer", { plan_id: asked.plan_id, endpoint: "olga-app", answers: { s1: "yes", s2: "yes" } })).toBe("invalid_request");
  });

  it("refuses a credential an endpoint not bound to it the same way whether or not the plan exists (the code review, CR10)", async () => {
    const { ok, error } = await setup();
    const asked = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER)] });
    const probe = (plan_id: string) => error(SECRETS.panel, "answer", { plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    expect(await probe(asked.plan_id)).toBe("not_permitted");
    expect(await probe("no-such-plan")).toBe("not_permitted");
  });

  it("takes an unasked step's yes under answers-unasked-steps", async () => {
    const { ok } = await setup({ mutation: "answers-unasked-steps" });
    const asked = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER), on(LAMP)] });
    const r = await ok(SECRETS.olga, "answer", { plan_id: asked.plan_id, endpoint: "olga-app", answers: { s2: "yes" } });
    expect(r.steps[1].answer).toBe("yes");
  });

  it("takes an answer only from the plan's credential and endpoint, and through a brain only naming the plan's speaker (GA-CONF-1)", async () => {
    const { ok, error, clock, define } = await setup();
    const plan = await brainPlan(ok);
    const yes = (o: Body = {}) => ({ plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" },
      utterance: heardAt(clock, "kitchen-voice"), ...o });
    // Olga's app is bound to her credential, not to the kitchen; her own endpoint is not where the plan was made.
    expect(await error(SECRETS.olga, "answer", yes({ endpoint: "olga-app", speaker: undefined, utterance: undefined }))).toBe("not_permitted");
    expect(await error(SECRETS.olga, "answer", yes({ speaker: undefined }))).toBe("not_permitted");
    expect(await error(SECRETS.brain, "answer", yes({ speaker: "owner" }))).toBe("not_permitted");
    expect(await error(SECRETS.brain, "answer", yes({ speaker: undefined }))).toBe("not_permitted");
    // At another endpoint the brain serves: not the plan's.
    expect(await error(SECRETS.brain, "answer", yes({ endpoint: "olga-chat", speaker: undefined, utterance: heardAt(clock, "olga-chat") }))).toBe("not_permitted");
    expect((await ok(SECRETS.brain, "answer", yes())).steps[0].answer).toBe("yes");
    // A plan whose question was put on the owner's app, by the endpoint's confirm_on, is answered there only.
    await define([up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain", confirm_on: "owner-app" })]);
    const there = await brainPlan(ok);
    const owners = { plan_id: there.plan_id, endpoint: "owner-app", answers: { s1: "yes" } };
    expect(await error(SECRETS.brain, "answer", { ...yes(), plan_id: there.plan_id, utterance: heardAt(clock, "kitchen-voice") })).toBe("not_permitted");
    expect(await error(SECRETS.olga, "answer", { ...owners, endpoint: "olga-app" })).toBe("not_permitted");
    expect((await ok(SECRETS.owner, "answer", owners)).steps[0].answer).toBe("yes");
  });

  it("takes anyone's answer under takes-any-answer", async () => {
    const { ok } = await setup({ mutation: "takes-any-answer" });
    const plan = await brainPlan(ok);
    expect((await ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } })).steps[0].answer).toBe("yes");
  });

  it("checks a spoken answer's record: there, of its endpoint, after the ask, not after the arrival, never reused (GA-CONF-2)", async () => {
    const { ok, error, clock } = await setup();
    const plan = await brainPlan(ok);
    clock.advance(5000);
    const yes = (utterance?: Body) => ({ plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" },
      ...(utterance ? { utterance } : {}) });
    const asked = clock.now() - 5000;
    const at = (ms: number, extra: Body = {}) => heardAt(clock, "kitchen-voice", extra, ms - clock.now());
    expect(await error(SECRETS.brain, "answer", yes())).toBe("invalid_request");
    expect(await error(SECRETS.brain, "answer", yes(heardAt(clock, "olga-chat")))).toBe("invalid_request");
    expect(await error(SECRETS.brain, "answer", yes(at(asked - CLOCK_TOLERANCE_MS)))).toBe("invalid_request");
    expect(await error(SECRETS.brain, "answer", yes(at(clock.now() + CLOCK_TOLERANCE_MS + 1)))).toBe("invalid_request");
    // Within the tolerance either side: counted.
    const first = at(asked - CLOCK_TOLERANCE_MS + 1);
    expect((await ok(SECRETS.brain, "answer", yes(first))).steps[0].answer).toBe("yes");
    expect((await ok(SECRETS.brain, "answer", yes(at(clock.now() + CLOCK_TOLERANCE_MS)))).steps[0].answer).toBe("yes");
    // The same record answers its own plan again, never another: by its id, or by endpoint, time and transcript.
    expect((await ok(SECRETS.brain, "answer", yes(first))).steps[0].answer).toBe("yes");
    const other = await brainPlan(ok);
    const again = (utterance: Body) => ({ ...yes(utterance), plan_id: other.plan_id });
    expect(await error(SECRETS.brain, "answer", again({ ...first, time: new Date(clock.now()).toISOString() }))).toBe("invalid_request");
    expect(await error(SECRETS.brain, "answer", again({ ...at(Date.parse(first.time)), transcript: first.transcript }))).toBe("invalid_request");
    expect((await ok(SECRETS.brain, "answer", again(at(clock.now())))).steps[0].answer).toBe("yes");
  });

  it("puts an invalid record before not_permitted, and not_permitted before an expired or stale plan", async () => {
    const { ok, error, clock, define } = await setup();
    const plan = await brainPlan(ok);
    // The member at the kitchen is not_permitted, and her record is missing: invalid_request first.
    expect(await error(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", answers: { s1: "yes" } })).toBe("invalid_request");
    await define([up("room", { id: "attic", name: "Чердак" })]);
    expect(await error(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } })).toBe("not_permitted");
    const yes = () => ({ plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: heardAt(clock, "kitchen-voice") });
    expect(await error(SECRETS.brain, "answer", yes())).toBe("stale_revision");
    clock.advance(300_001);
    expect(await error(SECRETS.brain, "answer", yes())).toBe("plan_expired");
  });

  it("reuses an utterance under reuses-an-utterance", async () => {
    const { ok, clock } = await setup({ mutation: "reuses-an-utterance" });
    const record = heardAt(clock, "kitchen-voice");
    for (const plan of [await brainPlan(ok), await brainPlan(ok)]) {
      const r = await ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: record });
      expect(r.steps[0].answer).toBe("yes");
    }
  });

  it("counts a follow-up or a skill's turn only with a gate hint naming the speaker, and checks typed, skill and a person hint (GA-CONF-6)", async () => {
    const { ok, error, clock, define } = await setup();
    // A skill's endpoint is a visitor's by default; this one is capped at member, so its plan asks.
    await define([up("endpoint", { id: "skill", name: "Навык", type: "voice", room: "hall", person: null, served_by: "brain", max_role: "member" }),
      up("voice", { endpoint: "skill", listening: "wake_server", wake_words: [{ word: "Галатея", model: "transcript" }], zone: "downstairs",
        output: "speech", follow_up: true, heard_by: "front", skill_account: "demo" })]);
    const named = await brainPlan(ok);
    const unnamed = await brainPlan(ok, undefined);
    const answer = (plan: Body, extra: Body, o: Body = {}) => ({ plan_id: plan.plan_id, endpoint: "kitchen-voice", ...(plan.speaker ? { speaker: plan.speaker } : {}),
      answers: { s1: "yes" }, utterance: heardAt(clock, o.endpoint ?? "kitchen-voice", extra), ...o });
    const cases: [string, Body, Body, Body, string][] = [
      ["a follow-up with no hint", named, { addressed_by: "follow_up" }, {}, "not_permitted"],
      ["a record with no addressed_by, a follow-up", named, { addressed_by: undefined }, {}, "not_permitted"],
      ["a follow-up with a person hint", named, { addressed_by: "follow_up", hint_basis: "person", speaker_hint: "olga" }, {}, "not_permitted"],
      ["a follow-up whose gate hint names another", named, { addressed_by: "follow_up", hint_basis: "gate", speaker_hint: "owner" }, {}, "not_permitted"],
      ["a follow-up whose gate hint names no registered person", unnamed, { addressed_by: "follow_up", hint_basis: "gate", speaker_hint: "nobody" }, {}, "not_permitted"],
      ["typed at a voice endpoint", named, { addressed_by: "typed" }, {}, "not_permitted"],
      ["a skill's turn at an endpoint with no skill_account", named, { addressed_by: "skill", hint_basis: "gate", speaker_hint: "olga" }, {}, "not_permitted"],
      ["a person hint naming another than the chat's person", unnamed, { addressed_by: "wake", hint_basis: "person", speaker_hint: "owner" },
        { endpoint: "olga-chat" }, "not_permitted"],
      ["a follow-up whose gate hint names the speaker", named, { addressed_by: "follow_up", hint_basis: "gate", speaker_hint: "olga" }, {}, "ok"],
    ];
    for (const [what, plan, extra, o, want] of cases) {
      const p = o.endpoint === "olga-chat" ? await ok(SECRETS.brain, "plan", { endpoint: "olga-chat", actions: [on(DIMMER)] }) : plan;
      expect([what, await error(SECRETS.brain, "answer", answer(p, extra, o))]).toEqual([what, want]);
    }
    expect(await error(SECRETS.brain, "answer", answer(unnamed, { addressed_by: "follow_up", hint_basis: "gate", speaker_hint: "olga" }))).toBe("ok");
    const skilled = await ok(SECRETS.brain, "plan", { endpoint: "skill", speaker: "olga", actions: [on(DIMMER)] });
    expect(await error(SECRETS.brain, "answer", answer(skilled, { addressed_by: "skill", hint_basis: "gate", speaker_hint: "olga" }, { endpoint: "skill" })))
      .toBe("ok");
  });

  it("counts a television's follow-up under follow-up-yes", async () => {
    const { ok, clock } = await setup({ mutation: "follow-up-yes" });
    const plan = await brainPlan(ok);
    const r = await ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" },
      utterance: heardAt(clock, "kitchen-voice", { addressed_by: "follow_up" }) });
    expect(r.steps[0].answer).toBe("yes");
  });

  it("refuses an answer at once while the store is known down, and answers pending: true when its commit outlasts 10 s, the answer standing", async () => {
    const { ok, call, db, store, clock } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER)] });
    const answer = (a: string) => call(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: a } });
    await store.settled();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(answer("yes")).rejects.toEqual(expect.objectContaining({ pending: false }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.down).toBe(false); });
    await store.settled();
    // A stall the writer does not know as down: the caller hears pending: true after 10 s, and the yes stands.
    db.trouble.down = true;
    const late = answer("yes");
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    clock.advance(10_000);
    await expect(late).rejects.toEqual(expect.objectContaining({ pending: true }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    expect((await store.query("SELECT answers FROM plans WHERE plan_id = $1", [plan.plan_id])).rows).toEqual([{ answers: { s1: "yes" } }]);
  });

  it("refuses a request holding U+0000 before it reaches the store", async () => {
    const { ok, error, clock } = await setup();
    const plan = await brainPlan(ok);
    expect(await error(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" },
      utterance: heardAt(clock, "kitchen-voice", { transcript: "да\u0000" }) })).toBe("invalid_request");
  });

  it("reads asked plans back at start with their answers and records; a restart alone makes none stale (GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    const plan = await brainPlan(a.ok);
    const record = heardAt(clock, "kitchen-voice");
    await a.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: record });
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false });
    const again = await b.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "no" },
      utterance: heardAt(clock, "kitchen-voice") });
    expect(again.steps[0].answer).toBe("no");
    const other = await brainPlan(b.ok);
    expect(await b.error(SECRETS.brain, "answer", { plan_id: other.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: record }))
      .toBe("invalid_request");
    // An applier whose model moved while the steward was away moves the house: the plan is stale.
    b.steward.stop();
    await b.store.close();
    const c = await setup({ db, clock, define: false, applierRevision: 2 });
    expect(await c.error(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "no" },
      utterance: heardAt(clock, "kitchen-voice") })).toBe("stale_revision");
  });

  it("keeps a plan with an ask across a restart, and loses one with none, its apply and answer unknown_plan; loses both under forgets-an-asked-plan (GA-PERSIST-2)", async () => {
    for (const mutation of [undefined, "forgets-an-asked-plan"] as const) {
      const db = lasting(await memoryDb());
      const clock = new FakeClock();
      const a = await setup({ db, clock, mutation });
      const asked = await a.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(DIMMER)] });
      const plain = await a.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(LAMP)] });
      await a.ok(SECRETS.olga, "answer", { plan_id: asked.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
      await a.store.settled();
      a.steward.stop();
      await a.store.close();
      const b = await setup({ db, clock, define: false, mutation });
      const apply = (plan_id: string) => b.error(SECRETS.olga, "apply", { plan_id, idempotency_key: `k-${plan_id}` });
      expect(await apply(plain.plan_id)).toBe("unknown_plan");
      expect(await b.error(SECRETS.olga, "answer", { plan_id: plain.plan_id, endpoint: "olga-app", answers: { s1: "yes" } })).toBe("unknown_plan");
      expect(await apply(asked.plan_id)).toBe(mutation ? "unknown_plan" : "ok");
    }
  });

  it("moves the house at a start against another applier, even at the same revision", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    const plan = await brainPlan(a.ok);
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false, applierId: "another-applier" });
    expect(await b.error(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" },
      utterance: heardAt(clock, "kitchen-voice") })).toBe("stale_revision");
  });

  it("forgets a record, in memory and the store, once no plan could take it", async () => {
    const { ok, error, clock, store } = await setup();
    const plan = await brainPlan(ok);
    const record = heardAt(clock, "kitchen-voice");
    await ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: record });
    clock.advance(300_000 + 60_000);
    await store.settled();
    expect((await store.query("SELECT utterance_id FROM utterances")).rows).toEqual([]);
    // Forgotten, and harmless: a plan asked now refuses it by its time.
    const later = await brainPlan(ok);
    expect(await error(SECRETS.brain, "answer", { plan_id: later.plan_id, endpoint: "kitchen-voice", speaker: "olga", answers: { s1: "yes" }, utterance: record }))
      .toBe("invalid_request");
  });
});
