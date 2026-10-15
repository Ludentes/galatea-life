import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { DIMMER, eventsSince, heardAt, LAMP, on, setup } from "./setup.js";

type Body = Record<string, any>;
type Ok = (s: string, t: string, a?: Body) => Promise<Body>;

const attic = up("room", { id: "attic", name: "Чердак" });
const night = up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [{ target: LAMP, action: "onoff.turn_off", args: {} }] });

/** A steward whose house has the owner's chat window. */
async function withChat(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  if (o.define !== false) await s.define([OWNER_CHAT]);
  return s;
}

const revision = async (ok: Ok) => (await ok(SECRETS.owner, "describe")).revision as number;

/** `define` from the brain at `endpoint`, at the current revision. */
async function brainDefine(ok: Ok, call: (s: string, t: string, a?: Body) => Promise<any>, changes: unknown[],
  o: { endpoint?: string; speaker?: string; dry_run?: boolean } = {}) {
  return call(SECRETS.brain, "define", { endpoint: o.endpoint ?? "owner-chat", ...(o.speaker ? { speaker: o.speaker } : {}), changes,
    expected_revision: await revision(ok), dry_run: o.dry_run ?? false });
}

/** The owner's yes to the plan, typed in the chat window, relayed by the brain. */
const yes = (ok: Ok, clock: FakeClock, plan_id: string, answer = "yes") =>
  ok(SECRETS.brain, "answer", { plan_id, endpoint: "owner-chat", answers: { s1: answer }, utterance: heardAt(clock, "owner-chat", { addressed_by: "typed" }) });

describe("define through a brain (GA-DEF-3, GA-DEF-6)", () => {
  it("asks the owner first: a plan with one ask(confirm_define) step carrying the diff, its ask event, and nothing changed", async () => {
    const { ok, call } = await withChat();
    const before = await ok(SECRETS.owner, "describe");
    const { cursor } = await ok(SECRETS.owner, "events");
    const r = await brainDefine(ok, call, [attic, night]);
    expect(r.ok).toBe(true);
    const plan = r.body;
    expect(validate("steward/define.response.json", plan)).toEqual([]);
    expect(plan.steps).toEqual([{ step_id: "s1", verdict: "ask", reason: "confirm_define",
      diff: expect.stringMatching(/\+ room attic: name "Чердак"[\s\S]*\+ scenario night: brain_authored true/) }]);
    expect(plan.request).toEqual({ endpoint: "owner-chat", changes: [attic, night], expected_revision: before.revision });
    expect((await eventsSince(ok, cursor)).map((e) => [e.type, e.plan_id, e.step_ids, e.endpoint])).toEqual([["ask", plan.plan_id, ["s1"], "owner-chat"]]);
    // Its steps, the confirm_define step's own shape (GA-CONF-5).
    expect((await eventsSince(ok, cursor))[0]!.steps).toEqual([{ step_id: "s1", reason: "confirm_define", diff: plan.steps[0].diff }]);
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
  });

  it("gives a dry run's diff, the marks in it, and asks nothing", async () => {
    const { ok, call } = await withChat();
    const { cursor } = await ok(SECRETS.owner, "events");
    const r = await brainDefine(ok, call, [night], { dry_run: true });
    expect(r.body).toEqual({ diff: expect.stringContaining("+ scenario night: brain_authored true") });
    expect(await eventsSince(ok, cursor)).toEqual([]);
  });

  it("refuses not_permitted a member through a brain, the owner's role capped at an endpoint, and what the policy never takes", async () => {
    const { ok, call, error } = await withChat();
    const before = await ok(SECRETS.owner, "describe");
    const code = async (changes: unknown[], o: { endpoint?: string; speaker?: string } = {}) => {
      const r = await brainDefine(ok, call, changes, o);
      return r.ok ? "ok" : r.error;
    };
    expect(await code([attic], { endpoint: "olga-chat" })).toBe("not_permitted");
    // The owner named at the kitchen's voice endpoint is a member there, its cap.
    expect(await code([attic], { endpoint: "kitchen-voice", speaker: "owner" })).toBe("not_permitted");
    for (const c of [up("person", { id: "liza", name: "Лиза", role: "member" }), up("home", { hold: { on_s: 60 } }),
      up("endpoint", { id: "hall-panel", name: "Панель", type: "panel", room: "hall", person: null, served_by: null }),
      up("credential", { id: "spare", kind: "brain", secret: "spare-secret-0123456789" }),
      up("voice", { endpoint: "kitchen-voice", listening: "off", wake_words: [], zone: null, output: null, follow_up: false, heard_by: "front" }),
      { op: "upsert", kind: "lift_narrowing", value: { endpoint: "kitchen-voice" } }]) {
      expect(await code([attic, c])).toBe("not_permitted");
    }
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
    // The owner's own app is no brain: the change set is the owner's, applied at once.
    expect(await error(SECRETS.owner, "define", { endpoint: "owner-app", changes: [attic], expected_revision: before.revision, dry_run: false })).toBe("ok");
  });

  it("applies the change set once the owner said yes, marked, with a define event naming the plan (GA-DEF-6)", async () => {
    const { ok, call, clock } = await withChat();
    const plan = (await brainDefine(ok, call, [attic, night])).body;
    await yes(ok, clock, plan.plan_id);
    const { cursor } = await ok(SECRETS.owner, "events");
    const was = await revision(ok);
    const r = await ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    expect(r).toEqual({ revision: was + 1 });
    const d = await ok(SECRETS.owner, "describe");
    expect(d.rooms.map((x: Body) => x.id)).toContain("attic");
    expect(d.scenarios.find((x: Body) => x.id === "night").brain_authored).toBe(true);
    expect((await eventsSince(ok, cursor, "define")).map((e) => [e.revision, e.endpoint, e.person, e.plan_id])).toEqual([[was + 1, "owner-chat", "owner", plan.plan_id]]);
    // A second define of it changes nothing more: the house moved past its revision.
    expect((await call(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id })).error).toBe("stale_revision");
  });

  it("changes nothing unanswered or answered no, and spends the plan", async () => {
    const { ok, call, clock } = await withChat();
    for (const answer of [undefined, "no"]) {
      const plan = (await brainDefine(ok, call, [attic])).body;
      if (answer) await yes(ok, clock, plan.plan_id, answer);
      const was = await revision(ok);
      expect(await ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id })).toEqual({ revision: was, skipped: "not_confirmed" });
      expect((await ok(SECRETS.owner, "describe")).rooms.map((x: Body) => x.id)).not.toContain("attic");
      expect((await call(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id })).error).toBe("plan_expired");
    }
  });

  it("says a spending held past 10 s is kept when the store returns, unless the steward restarts first (the milestone 7+10+11 review, M1)", async () => {
    const { db, ok, call, clock, store } = await withChat();
    const plan = (await brainDefine(ok, call, [attic])).body;
    await store.settled();
    // A stall the writer does not know as down: the brain hears pending: true after 10 s.
    db.trouble.down = true;
    const late = call(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    clock.advance(10_000);
    await expect(late).rejects.toEqual(expect.objectContaining({ pending: true, message: expect.stringContaining("unless the steward restarts first") }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
  });

  it("checks define { plan_id } as apply checks a plan, in its order (GA-STW-5, GA-DEF-2)", async () => {
    const { ok, call, clock, define } = await withChat();
    const err = async (secret: string, a: Body) => {
      const r = await call(secret, "define", a);
      return r.ok ? "ok" : r.error;
    };
    expect(await err(SECRETS.brain, { endpoint: "owner-chat", plan_id: "nope" })).toBe("unknown_plan");
    const plan = (await brainDefine(ok, call, [attic])).body;
    await yes(ok, clock, plan.plan_id);
    expect(await err(SECRETS.owner, { endpoint: "owner-app", plan_id: plan.plan_id })).toBe("plan_not_yours");
    // The plan's endpoint and speaker govern: one naming others is invalid_request.
    expect(await err(SECRETS.brain, { endpoint: "olga-chat", plan_id: plan.plan_id })).toBe("invalid_request");
    // A request's plan is applied, not defined; a define's plan is defined, not applied or run.
    const request = await ok(SECRETS.brain, "plan", { endpoint: "owner-chat", actions: [on(LAMP)] });
    expect(await err(SECRETS.brain, { endpoint: "owner-chat", plan_id: request.plan_id })).toBe("invalid_request");
    expect((await call(SECRETS.brain, "apply", { plan_id: plan.plan_id, idempotency_key: "k1" })).error).toBe("invalid_request");
    expect((await call(SECRETS.brain, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k2" })).error).toBe("invalid_request");
    // The house moved since: stale_revision, nothing changed, and the plan not spent by it.
    await define([up("room", { id: "cellar", name: "Подвал" })]);
    expect(await err(SECRETS.brain, { endpoint: "owner-chat", plan_id: plan.plan_id })).toBe("stale_revision");
    expect((await ok(SECRETS.owner, "describe")).rooms.map((x: Body) => x.id)).not.toContain("attic");
    // Expired.
    const late = (await brainDefine(ok, call, [attic])).body;
    await yes(ok, clock, late.plan_id);
    clock.advance(300_001);
    expect(await err(SECRETS.brain, { endpoint: "owner-chat", plan_id: late.plan_id })).toBe("plan_expired");
  });

  it("is refused at once while the store is known down, pending false, asking nothing", async () => {
    const { db, ok, call, store } = await withChat();
    const was = await revision(ok);
    const { cursor } = await ok(SECRETS.owner, "events");
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(call(SECRETS.brain, "define", { endpoint: "owner-chat", changes: [attic], expected_revision: was, dry_run: false }))
      .rejects.toEqual(expect.objectContaining({ pending: false }));
    expect(await eventsSince(ok, cursor, "ask")).toEqual([]);
    db.trouble.down = false;
  });

  it("reads a define's plan back at start, with its answer, and applies it after the restart", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await withChat({ db, clock });
    const plan = (await brainDefine(a.ok, a.call, [attic])).body;
    await yes(a.ok, clock, plan.plan_id);
    a.steward.stop();
    await a.store.close();
    const b = await withChat({ db, clock, define: false });
    const was = await revision(b.ok);
    expect(await b.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id })).toEqual({ revision: was + 1 });
    expect((await b.ok(SECRETS.owner, "describe")).rooms.map((x: Body) => x.id)).toContain("attic");
  });
});

describe("the switches through a brain (GA-DEF-3)", () => {
  const marked = { id: "off", name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }], passes_holds: true };
  const rows: [string, unknown[]][] = [
    ["sets a target's switch", [up("target", { id: DIMMER, owner_work_passes_holds: true })]],
    ["deletes a switched target", [{ op: "delete", kind: "target", value: { id: LAMP } }]],
    ["deletes a marked rule", [{ op: "delete", kind: "rule", value: { id: "off" } }]],
    ["clears a rule's mark", [up("rule", { id: "off", passes_holds: false })]],
    ["creates a marked rule", [up("rule", { ...marked, id: "new" })]],
    ["sets the home's switch", [up("home", { hold: { owner_work_passes_holds: true } })]],
    ["mixes a forbidden change with an allowed one", [up("room", { id: "den", name: "Den" }), up("rule", { id: "off", passes_holds: false })]],
    // The home's switch with anything else, and another home setting: no mutation lets these through.
    ["sets the home's switch with a window", [up("home", { hold: { owner_work_passes_holds: true, on_s: 600 } })]],
    ["changes another home setting", [up("home", { other_wake_words: [] })]],
  ];
  /** The owner's marked rule and switched lamp, set from the owner's app. */
  const switched = async (o: Parameters<typeof setup>[0] = {}) => {
    const t = await withChat(o);
    await t.define([up("rule", marked), up("target", { id: LAMP, owner_work_passes_holds: true })]);
    return t;
  };

  it.each(rows)("refuses a change set that %s, not_permitted at the call", async (_w, changes) => {
    const t = await switched();
    const before = await revision(t.ok);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    const r = await brainDefine(t.ok, t.call, changes);
    expect(r.error).toBe("not_permitted");
    expect((await t.ok(SECRETS.owner, "describe")).revision).toBe(before);
    // Before any plan: nothing is asked.
    expect(await eventsSince(t.ok, cursor, "ask")).toEqual([]);
  });

  it("takes a rename of the owner's marked rule, the mark kept, the rule then brain_authored", async () => {
    const t = await withChat();
    await t.define([up("rule", marked)]);
    const plan = (await brainDefine(t.ok, t.call, [up("rule", { id: "off", name: "Ночь" })])).body;
    await yes(t.ok, t.clock, plan.plan_id);
    await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    const r = (await t.ok(SECRETS.owner, "describe")).rules.find((x: any) => x.id === "off");
    expect([r.passes_holds, r.brain_authored]).toEqual([true, true]);
  });

  it("clears a brain's mark when the owner redefines the marked rule whole, leaving passes_holds out (ruled, m1)", async () => {
    const t = await withChat();
    await t.define([up("rule", marked)]);
    const plan = (await brainDefine(t.ok, t.call, [up("rule", { id: "off", name: "Ночь" })])).body;
    await yes(t.ok, t.clock, plan.plan_id);
    await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    const { passes_holds: _, ...rest } = marked;
    await t.define([up("rule", { ...rest, active: true })]);
    const r = (await t.ok(SECRETS.owner, "describe")).rules.find((x: any) => x.id === "off");
    expect([r.passes_holds, r.brain_authored ?? false]).toEqual([true, false]);
  });

  it("takes a switch named at its current value as no change (R-7)", async () => {
    const t = await withChat();
    await t.define([up("rule", marked)]);
    expect((await brainDefine(t.ok, t.call, [up("rule", { id: "off", name: "Ночь", passes_holds: true })])).ok).toBe(true);
    // Unswitched: a target's switch named false is no change at all, an empty diff and the revision kept.
    const before = await revision(t.ok);
    const off = up("target", { id: LAMP, owner_work_passes_holds: false });
    expect((await brainDefine(t.ok, t.call, [off], { dry_run: true })).body).toEqual({ diff: "no change" });
    await t.define([off]);
    expect(await revision(t.ok)).toBe(before);
    // A new rule's mark named false is taken.
    expect((await brainDefine(t.ok, t.call, [up("rule", { ...marked, id: "new", passes_holds: false })])).ok).toBe(true);
    // Deleting an unmarked rule is no switch's.
    await t.define([up("rule", { ...marked, id: "plain", passes_holds: false })]);
    expect((await brainDefine(t.ok, t.call, [{ op: "delete", kind: "rule", value: { id: "plain" } }])).ok).toBe(true);
  });

  // Each mutation lets its rows through, to a plan, and no other.
  it.each([
    ["brain-sets-the-device-switch", [0, 1, 2]],
    ["brain-marks-a-rule", [3, 4, 6]],
    ["brain-sets-the-home-switch", [5]],
  ] as const)("under %s, returns a plan for its rows only", async (mutation, mine) => {
    for (const [i, [, changes]] of rows.entries()) {
      const t = await switched({ mutation });
      const r = await brainDefine(t.ok, t.call, changes);
      const passes = (mine as readonly number[]).includes(i);
      expect([i, r.ok ? "plan" : r.error]).toEqual([i, passes ? "plan" : "not_permitted"]);
      if (passes) expect(r.body.steps).toEqual([expect.objectContaining({ verdict: "ask", reason: "confirm_define" })]);
    }
  });
});
