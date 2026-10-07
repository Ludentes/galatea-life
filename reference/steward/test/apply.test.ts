import { proofHolds, type Token } from "@ludentes/galatea-life-binding";
import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { TOKEN_EXPIRY_MS } from "../src/confirm/token.js";
import { REPEAT_WINDOW_MS } from "../src/dispatch/apply.js";
import { Store } from "../src/core/store.js";
import { MUTATIONS } from "../src/mutations.js";
import { Steward } from "../src/steward.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, DIMMER, eventsSince, judgeAction, LAMP, on, setup, TOKEN_KEY, TV } from "./setup.js";

type Body = Record<string, any>;
const short = (o: Body) => `${o.target} ${o.outcome}${o.reason ? `(${o.reason})` : ""}`;
let keys = 0;
const key = () => `key-${++keys}`;

/** Olga's plan for the hall's lights, the dimmer's turn_on asked, answered as `answer` unless undefined. */
async function answered(ok: (s: string, t: string, a?: Body) => Promise<Body>, answer?: "yes" | "no") {
  const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on("hall-lights")] });
  if (answer) await ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: answer } });
  return plan;
}

describe("apply", () => {
  it("is built, and its mutations are declared", () => {
    for (const m of ["tokens-without-a-yes", "folds-the-toggle-into-the-tier", "outcome-without-a-time"]) expect(MUTATIONS).toContain(m);
  });

  it("will not be built to reach an applier without a token key of 16 characters or more and a client name", async () => {
    const store = await Store.open(await memoryDb(), new FakeClock(), (e) => { throw e; });
    const base = { store, clock: new FakeClock(), stewardId: "demo", applierApply: async () => ({}) };
    expect(() => new Steward(base)).toThrow(/token key/);
    expect(() => new Steward({ ...base, applierClient: "steward", tokenKey: "short" })).toThrow(/token key/);
    expect(() => new Steward({ ...base, tokenKey: TOKEN_KEY })).toThrow(/client/);
    expect(() => new Steward({ ...base, applierClient: "steward", tokenKey: TOKEN_KEY })).not.toThrow();
    await store.close();
  });

  it("applies a plan as one inline applier apply keyed by its apply id, its steps in order, a token only on the step answered yes", async () => {
    const { ok, applier, clock } = await setup();
    const plan = await answered(ok, "yes");
    expect(plan.steps.map((s: Body) => s.target)).toEqual([DIMMER, LAMP]);
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    expect(validate("steward/apply.response.json", r)).toEqual([]);
    expect(r.outcomes.map(short)).toEqual([`${DIMMER} dispatched`, `${LAMP} dispatched`]);
    expect(applier.applies).toHaveLength(1);
    const sent = applier.applies[0]!;
    // Inline, never an applier plan's id, keyed by the steward's apply id (GA-STW-10).
    expect(sent.plan_id).toBeUndefined();
    expect(sent.idempotency_key).toBe(r.apply_id);
    const cause = { person: "olga", endpoint: "olga-app", apply: r.apply_id };
    expect(sent.request.actions.map((a: Body) => ({ ...a, token: a.token ? "token" : undefined }))).toEqual([
      { target: DIMMER, action: "onoff.turn_on", args: {}, via: "app", brain: false, for: cause, token: "token" },
      { target: LAMP, action: "onoff.turn_on", args: {}, via: "app", brain: false, for: cause, token: undefined },
    ]);
    // The token names exactly what is sent, expires 60 s after issue, and its proof holds under the key (GA-CONF-3).
    const t = sent.request.actions[0].token as Token;
    expect(validate("applier/token.json", t)).toEqual([]);
    expect(t).toMatchObject({ issuer: "steward", target: DIMMER, action: "onoff.turn_on", args: {}, via: "app", brain: false, for: cause,
      expires: new Date(clock.now() + TOKEN_EXPIRY_MS).toISOString() });
    expect(proofHolds(t, TOKEN_KEY)).toBe(true);
  });

  it("skips an ask with no yes, not_confirmed, and sends nothing for it (GA-APPLY-3)", async () => {
    for (const answer of [undefined, "no"] as const) {
      const { ok, applier } = await setup();
      const plan = await answered(ok, answer);
      const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
      expect(r.outcomes.map(short)).toEqual([`${DIMMER} skipped(not_confirmed)`, `${LAMP} dispatched`]);
      expect(applier.applies[0]!.request.actions.map((a: Body) => [a.target, a.token])).toEqual([[LAMP, undefined]]);
    }
  });

  it("refuses an inline request's asks, tier and toggle, and a visitor's steps, sending only the rest (GA-TIER-2, GA-STW-4, GA-TIER-3)", async () => {
    const { ok, applier, define } = await setup();
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(DIMMER), on(TV, "onoff.turn_off"), on(LAMP)] },
      idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${DIMMER} refused(tier)`, `${TV} refused(toggle_only)`, `${LAMP} dispatched`]);
    expect(applier.plans.at(-1)!.actions.map((a: Body) => a.target)).toEqual([DIMMER, TV, LAMP]);
    expect(applier.applies.at(-1)!.request.actions.map((a: Body) => [a.target, a.token])).toEqual([[LAMP, undefined]]);
    const kiosk = "kiosk-secret-0123456789";
    await define([up("endpoint", { id: "kiosk", name: "Киоск", type: "panel", room: "hall", person: null, served_by: null, max_role: "visitor" }),
      up("credential", { id: "kiosk", kind: "panel", secret: kiosk, endpoint: "kiosk" })]);
    const sent = applier.applies.length;
    const v = await ok(kiosk, "apply", { request: { endpoint: "kiosk", actions: [on(LAMP)] }, idempotency_key: key() });
    expect(v.outcomes.map(short)).toEqual([`${LAMP} refused(role)`]);
    expect(applier.applies).toHaveLength(sent);
  });

  it("sends a toggle a person said yes to with its token, and nothing else lifts it (GA-STW-4)", async () => {
    const { ok, applier } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(TV, "onoff.turn_off")] });
    expect(plan.steps.map((s: Body) => `${s.verdict}(${s.reason})`)).toEqual(["ask(toggle_only)"]);
    await ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${TV} dispatched`]);
    expect(proofHolds(applier.applies[0]!.request.actions[0].token, TOKEN_KEY)).toBe(true);
  });

  it("folds the toggle's ask into the tier's under folds-the-toggle-into-the-tier", async () => {
    const { ok, applier, steward } = await setup({ mutation: "folds-the-toggle-into-the-tier" });
    steward.onDescribe(describeOf(DEVICES.map((d) => (d.id === TV ? { ...d, actions: [{ action: "onoff.turn_off", tier: "confirm", toggles: true }] } : d)), 2));
    applier.planner = (a) => (a.target === TV && !a.token ? { verdict: "refuse", reason: "toggle_only", tier: "confirm" } : judgeAction(a));
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(TV, "onoff.turn_off")] });
    expect(plan.steps.map((s: Body) => `${s.verdict}(${s.reason})`)).toEqual(["ask(confirm_tier)"]);
  });

  it("refuses an unknown, foreign, expired, stale or spent plan, dispatching nothing (GA-STW-5)", async () => {
    const { ok, error, applier, clock, define } = await setup();
    const apply = (secret: string, plan_id: string) => error(secret, "apply", { plan_id, idempotency_key: key() });
    expect(await apply(SECRETS.olga, "no-such-plan")).toBe("unknown_plan");
    const plan = await answered(ok, "yes");
    expect(await apply(SECRETS.brain, plan.plan_id)).toBe("plan_not_yours");
    expect(await apply(SECRETS.olga, plan.plan_id)).toBe("ok");
    expect(await apply(SECRETS.olga, plan.plan_id)).toBe("plan_expired");
    const stale = await answered(ok, "yes");
    await define([up("room", { id: "attic", name: "Чердак" })]);
    expect(await apply(SECRETS.olga, stale.plan_id)).toBe("stale_revision");
    const old = await answered(ok, "yes");
    clock.advance(300_001);
    expect(await apply(SECRETS.olga, old.plan_id)).toBe("plan_expired");
    expect(applier.applies).toHaveLength(1);
    // An applied plan takes no answer (GA-CONF-1).
    expect(await error(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "no" } })).toBe("not_permitted");
  });

  it("returns the first apply for a repeated key with the same body, refuses another body, and keeps keys apart per credential (GA-STW-6)", async () => {
    const { ok, error, applier } = await setup();
    const plan = await answered(ok, "yes");
    const k = key();
    const first = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: k });
    expect(await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: k })).toEqual(first);
    expect(await error(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: k })).toBe("idempotency_conflict");
    const inline = { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() };
    const once = await ok(SECRETS.olga, "apply", inline);
    expect(await ok(SECRETS.olga, "apply", inline)).toEqual(once);
    expect(applier.applies).toHaveLength(2);
    // The owner's same key is another key.
    const owners = await ok(SECRETS.owner, "apply", { request: { endpoint: "owner-app", actions: [on(LAMP)] }, idempotency_key: inline.idempotency_key });
    expect(owners.apply_id).not.toBe(once.apply_id);
  });

  it("waits for an apply in flight when its key comes again, and returns that apply", async () => {
    const { ok, applier } = await setup();
    let open!: () => void;
    applier.answerGate = new Promise((r) => { open = r; });
    const body = { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() };
    const first = ok(SECRETS.olga, "apply", body);
    await vi.waitFor(() => expect(applier.applies).toHaveLength(1));
    const again = ok(SECRETS.olga, "apply", body);
    open();
    expect(await again).toEqual(await first);
    expect(applier.applies).toHaveLength(1);
  });

  it("stamps each outcome with the time of its outcome event, the steward's own with when it decided, and keeps them current (GA-STW-12)", async () => {
    const { ok, error, applier, clock, pump } = await setup();
    const plan = await answered(ok);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(1500);
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    const outcomes = await eventsSince(ok, cursor, "outcome");
    expect(outcomes.map((e) => [e.apply_id, e.step_id, e.outcome])).toEqual([[r.apply_id, "s2", "dispatched"]]);
    expect(outcomes[0]!.cause).toEqual({ person: "olga", endpoint: "olga-app", apply: r.apply_id });
    expect(r.outcomes).toEqual([{ step_id: "s1", target: DIMMER, outcome: "skipped", reason: "not_confirmed", time: new Date(clock.now()).toISOString() },
      { step_id: "s2", target: LAMP, outcome: "dispatched", time: outcomes[0]!.time }]);
    // The applier's own event of the dispatch moves nothing and is not relayed; its later ack is relayed and moves the outcome.
    clock.advance(700);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    const later = await eventsSince(ok, cursor, "outcome");
    expect(later.map((e) => [e.step_id, e.outcome])).toEqual([["s2", "dispatched"], ["s2", "acked"]]);
    const now = await ok(SECRETS.olga, "outcome", { apply_id: r.apply_id });
    expect(validate("steward/outcome.response.json", now)).toEqual([]);
    expect(now.outcomes[1]).toEqual({ step_id: "s2", target: LAMP, outcome: "acked", time: later[1]!.time });
    expect(await error(SECRETS.brain, "outcome", { apply_id: r.apply_id })).toBe("unknown_apply");
    expect(await error(SECRETS.olga, "outcome", { apply_id: "no-such-apply" })).toBe("unknown_apply");
    clock.advance(3_600_001);
    expect(await error(SECRETS.olga, "outcome", { apply_id: r.apply_id })).toBe("unknown_apply");
  });

  it("leaves an acked outcome's time out under outcome-without-a-time", async () => {
    const { ok, applier, pump } = await setup({ mutation: "outcome-without-a-time" });
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    expect((await ok(SECRETS.olga, "outcome", { apply_id: r.apply_id })).outcomes[0].time).toBeUndefined();
  });

  it("holds the applier's events back while an apply awaits its answer, so its outcome events name the steward's apply, once each", async () => {
    const { ok, applier, pump } = await setup();
    const { cursor } = await ok(SECRETS.owner, "events");
    let open!: () => void;
    applier.answerGate = new Promise((r) => { open = r; });
    const applying = ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    await vi.waitFor(() => expect(applier.applies).toHaveLength(1));
    applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: { apply: "applier-apply-1", client: "steward", for: { endpoint: "olga-app" } } });
    await pump();
    expect(await eventsSince(ok, cursor)).toEqual([]);
    open();
    const r = await applying;
    const events = await eventsSince(ok, cursor);
    // The step's lease is granted once the applier answers it dispatched (GA-LEASE-1).
    expect(events.map((e) => [e.type, e.apply_id ?? e.key ?? e.change, e.outcome ?? e.value])).toEqual([["outcome", r.apply_id, "dispatched"],
      ["lease", "granted", undefined], ["state", "on", true]]);
  });

  it("puts its own outcome before the changes the apply caused, holding every batch while the answer is awaited (I3)", async () => {
    const { ok, applier, pump } = await setup();
    applier.emitsOutcomes = false;
    const { cursor } = await ok(SECRETS.owner, "events");
    let open!: () => void;
    applier.answerGate = new Promise((r) => { open = r; });
    const applying = ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    await vi.waitFor(() => expect(applier.applies).toHaveLength(1));
    applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: { apply: "applier-apply-1", client: "steward", for: { endpoint: "olga-app" } } });
    await pump();
    expect(await eventsSince(ok, cursor)).toEqual([]);
    open();
    const r = await applying;
    await pump();
    const events = await eventsSince(ok, cursor);
    // The step's lease is granted once the applier answers it dispatched (GA-LEASE-1).
    expect(events.map((e) => [e.type, e.apply_id ?? e.key ?? e.change, e.outcome ?? e.value])).toEqual([["outcome", r.apply_id, "dispatched"],
      ["lease", "granted", undefined], ["state", "on", true]]);
  });

  it("never moves an outcome backwards: an applier's event of an earlier outcome, coming after the answer, changes nothing (I3)", async () => {
    const { ok, applier, pump } = await setup();
    applier.emitsOutcomes = false;
    applier.answerOutcome = "acked";
    const { cursor } = await ok(SECRETS.owner, "events");
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${LAMP} acked`]);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "dispatched" });
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    expect((await ok(SECRETS.olga, "outcome", { apply_id: r.apply_id })).outcomes.map(short)).toEqual([`${LAMP} acked`]);
    expect((await eventsSince(ok, cursor, "outcome")).map((e) => e.outcome)).toEqual(["acked"]);
  });

  it("holds an outcome the cap forced out before the answer, and relays it named by the steward's apply after the answer (I3)", async () => {
    const { ok, applier, pump } = await setup({ options: { parkedCap: 2 } });
    const { cursor } = await ok(SECRETS.owner, "events");
    let open!: () => void;
    applier.answerGate = new Promise((r) => { open = r; });
    const applying = ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    await vi.waitFor(() => expect(applier.applies).toHaveLength(1));
    await pump();
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    for (let i = 0; i < 3; i++) applier.emit({ type: "state", target: TV, key: "on", value: i % 2 === 0 });
    await pump();
    // The cap released the TV's changes; the outcome events stay held, never logged under the applier's apply.
    expect((await eventsSince(ok, cursor)).map((e) => e.type)).toEqual(["state", "state", "state"]);
    open();
    const r = await applying;
    expect((await ok(SECRETS.olga, "outcome", { apply_id: r.apply_id })).outcomes.map(short)).toEqual([`${LAMP} acked`]);
    const outcomes = await eventsSince(ok, cursor, "outcome");
    expect(outcomes.map((e) => [e.apply_id, e.outcome])).toEqual([[r.apply_id, "dispatched"], [r.apply_id, "acked"]]);
  });

  it("repeats a call whose answer was lost with its key and its tokens, and gives up after 10 s, its outcomes unknown", async () => {
    const { ok, call, applier, clock } = await setup();
    applier.loseAnswers = 1;
    const plan = await answered(ok, "yes");
    const r = ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    await vi.waitFor(() => { clock.advance(250); expect(applier.applies.length).toBeGreaterThanOrEqual(2); });
    expect((await r).outcomes.map(short)).toEqual([`${DIMMER} dispatched`, `${LAMP} dispatched`]);
    expect(applier.applies[1]).toEqual(applier.applies[0]);
    applier.loseAnswers = 1000;
    const lost = call(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "lost" });
    lost.catch(() => undefined);
    await vi.waitFor(() => { clock.advance(500); expect(applier.applies.length).toBeGreaterThan(3); });
    for (let i = 0; i < 30; i++) { clock.advance(500); await Promise.resolve(); }
    await expect(lost).rejects.toEqual(expect.objectContaining({ pending: true }));
    const again = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "lost" });
    expect(again.outcomes.map(short)).toEqual([`${LAMP} unknown`]);
    expect(REPEAT_WINDOW_MS).toBe(10_000);
  });

  it("ends a step unreachable when no session was up to send it on", async () => {
    const { ok } = await setup({ reach: false });
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${LAMP} unreachable`]);
  });

  it("refuses an apply at once while the store is known down, and drops one whose record outlasts 10 s, sending nothing", async () => {
    const { ok, call, db, store, clock, applier } = await setup();
    await store.settled();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(call(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() }))
      .rejects.toEqual(expect.objectContaining({ pending: false }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.down).toBe(false); });
    await store.settled();
    db.trouble.down = true;
    const body = { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() };
    const late = call(SECRETS.olga, "apply", body);
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    clock.advance(10_000);
    await expect(late).rejects.toEqual(expect.objectContaining({ pending: false }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    expect(applier.applies).toHaveLength(0);
    // A repeat tells the dropped apply from one the applier could not be reached for.
    const again = await ok(SECRETS.olga, "apply", body);
    expect(again.outcomes.map(short)).toEqual([`${LAMP} unreachable`]);
    expect(again.outcomes[0].detail).toBe("dropped: the store did not keep the apply");
  });

  it("sends an unanswered step with a token under tokens-without-a-yes", async () => {
    const { ok, applier } = await setup({ mutation: "tokens-without-a-yes" });
    const plan = await answered(ok);
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${DIMMER} dispatched`, `${LAMP} dispatched`]);
    const inline = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(DIMMER)] }, idempotency_key: key() });
    expect(inline.outcomes.map(short)).toEqual([`${DIMMER} dispatched`]);
    expect(applier.applies.map((a) => a.request.actions[0].token !== undefined)).toEqual([true, true]);
  });

  it("relays the applier's events with the steward's seq and time and their causes, withholding personal values", async () => {
    const { ok, applier, pump, steward, store } = await setup();
    steward.onDescribe(describeOf(DEVICES.map((d) => (d.id === LAMP ? { ...d, personal: ["presence"] } : d)), 2));
    const { cursor } = await ok(SECRETS.owner, "events");
    applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: { apply: "x", client: "steward", for: { person: "olga", endpoint: "olga-app", apply: "a-1" } } });
    applier.emit({ type: "state", target: LAMP, key: "on", value: false, cause: "external" });
    applier.emit({ type: "state", target: LAMP, key: "presence", value: true, cause: "device" });
    applier.emit({ type: "state", target: TV, key: "speech", value: "новости", cause: "device" });
    applier.emit({ type: "outcome", apply_id: "someone-elses", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    const events = await eventsSince(ok, cursor);
    expect(events.map((e) => [e.type, e.key ?? e.apply_id, e.value ?? e.outcome, e.cause, e.applier_seq])).toEqual([
      ["state", "on", true, { person: "olga", endpoint: "olga-app", apply: "a-1" }, 1],
      ["state", "on", false, "external", 2],
      // An outside change takes a lease (GA-LEASE-2).
      ["lease", undefined, undefined, undefined, undefined],
      ["state", "presence", "withheld", "device", 3],
      ["state", "speech", "новости", "device", 4],
      ["outcome", "someone-elses", "acked", undefined, 5],
    ]);
    expect(events.every((e) => typeof e.seq === "number" && typeof e.time === "string")).toBe(true);
    await store.settled();
    const kept = await store.query<{ events_only: boolean }>("SELECT events_only FROM events WHERE type = 'state' ORDER BY seq");
    expect(kept.rows.map((r) => r.events_only)).toEqual([false, false, false, true]);
  });

  it("reads its applies back at start: a repeated key returns the first apply, one never answered unknown", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    const body = { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() };
    const first = await a.ok(SECRETS.olga, "apply", body);
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false });
    expect(await b.ok(SECRETS.olga, "apply", body)).toEqual(first);
    expect(b.applier.applies).toHaveLength(0);
  });

  it("applies a plan answered before a restart with a token minted after it, and keeps the plan spent across restarts (GA-PERSIST-2, GA-CONF-3)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    const plan = await answered(a.ok, "yes");
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(30_000);
    const b = await setup({ db, clock, define: false });
    const r = await b.ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    expect(r.outcomes.map(short)).toEqual([`${DIMMER} dispatched`, `${LAMP} dispatched`]);
    expect(b.applier.applies).toHaveLength(1);
    const t = b.applier.applies[0]!.request.actions[0].token as Token;
    expect(t.expires).toBe(new Date(clock.now() + TOKEN_EXPIRY_MS).toISOString());
    expect(proofHolds(t, TOKEN_KEY)).toBe(true);
    expect(await b.error(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() })).toBe("plan_expired");
    await b.store.settled();
    b.steward.stop();
    await b.store.close();
    const c = await setup({ db, clock, define: false });
    expect(await c.error(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() })).toBe("plan_expired");
    expect(c.applier.applies).toHaveLength(0);
  });

  it("caps the keys a credential holds within their 3600 s, refusing a new one past the cap rather than forgetting one (GA-STW-6)", async () => {
    const { ok, error, clock } = await setup({ options: { maxAppliesPerCredential: 3 } });
    const body = (k: string) => ({ request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: k });
    const first = await ok(SECRETS.olga, "apply", body("cap-1"));
    await ok(SECRETS.olga, "apply", body("cap-2"));
    await ok(SECRETS.olga, "apply", body("cap-3"));
    expect(await error(SECRETS.olga, "apply", body("cap-4"))).toBe("invalid_request");
    expect(await ok(SECRETS.olga, "apply", body("cap-1"))).toEqual(first);
    // Another credential's keys are its own.
    await ok(SECRETS.owner, "apply", { request: { endpoint: "owner-app", actions: [on(LAMP)] }, idempotency_key: "cap-4" });
    clock.advance(3_600_001);
    await ok(SECRETS.olga, "apply", body("cap-4"));
    // The first apply is forgotten with its key, though its key was used again after it.
    await ok(SECRETS.olga, "apply", body("cap-1"));
    expect(await error(SECRETS.olga, "outcome", { apply_id: first.apply_id })).toBe("unknown_apply");
  });

  it("keeps an apply under a key reused past its retention, the old row still stored, so a restart sends nothing again (GA-STW-6)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    const k = key();
    // 30 s after start: the periodic prune that comes before the key is reused finds the old row still young.
    clock.advance(30_000);
    await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: k });
    await a.store.settled();
    clock.advance(3_600_001);
    const reused = { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: k };
    const second = await a.ok(SECRETS.olga, "apply", reused);
    await a.store.settled();
    const rows = await a.store.query<{ apply_id: string }>("SELECT apply_id FROM applies WHERE key = $1", [k]);
    expect(rows.rows.map((r) => r.apply_id)).toEqual([second.apply_id]);
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false });
    expect(await b.ok(SECRETS.olga, "apply", reused)).toEqual(second);
    expect(b.applier.applies).toHaveLength(0);
  });
});

describe("a witness's verdict (applier GA-WIT-1)", () => {
  const W = { sensor: "sim-bridge:power", expect: "rises", within_s: 5 };
  const outcomesOf = async (ok: (s: string, t: string, a?: Body) => Promise<Body>, apply_id: string) =>
    ((await ok(SECRETS.olga, "outcome", { apply_id })).outcomes as Body[]).map(short);

  it("relays a verdict that comes while the step is dispatched, keeping the step's outcome, so its ack still lands", async () => {
    const { ok, applier, pump } = await setup();
    applier.emitsOutcomes = false;
    const { cursor } = await ok(SECRETS.owner, "events");
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "confirmed", witness: { ...W, verdict: "confirmed" } });
    await pump();
    expect(await outcomesOf(ok, r.apply_id)).toEqual([`${LAMP} dispatched`]);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await pump();
    expect(await outcomesOf(ok, r.apply_id)).toEqual([`${LAMP} acked`]);
    const events = (await eventsSince(ok, cursor, "outcome")).filter((e) => e.apply_id === r.apply_id);
    expect(events.map((e) => [e.outcome, e.witness?.verdict ?? null, e.step_id, e.cause])).toEqual([
      ["dispatched", null, "s1", { person: "olga", endpoint: "olga-app", apply: r.apply_id }],
      ["confirmed", "confirmed", "s1", { person: "olga", endpoint: "olga-app", apply: r.apply_id }],
      ["acked", null, "s1", { person: "olga", endpoint: "olga-app", apply: r.apply_id }]]);
  });

  it("relays a verdict that comes after the step's ack, unchanged and named by the steward's apply, the outcome kept acked", async () => {
    const { ok, applier, pump } = await setup();
    applier.emitsOutcomes = false;
    applier.answerOutcome = "acked";
    const { cursor } = await ok(SECRETS.owner, "events");
    const r = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: key() });
    expect(await outcomesOf(ok, r.apply_id)).toEqual([`${LAMP} acked`]);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "unconfirmed", witness: { ...W, verdict: "unconfirmed" } });
    await pump();
    expect(await outcomesOf(ok, r.apply_id)).toEqual([`${LAMP} acked`]);
    const events = (await eventsSince(ok, cursor, "outcome")).filter((e) => e.apply_id === r.apply_id);
    expect(events.map((e) => [e.outcome, e.witness ?? null])).toEqual([["acked", null], ["unconfirmed", { ...W, verdict: "unconfirmed" }]]);
  });
});
