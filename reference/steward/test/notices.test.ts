import { describe, expect, it, vi } from "vitest";
import { MUTATIONS } from "../src/mutations.js";
import { NOTICE_RETRY_MS, OWN_PENDING_CAP, SUMMARY_ID } from "../src/notices/pump.js";
import { lasting, memoryDb } from "./db.js";
import { FakeApplier } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS } from "./house.js";
import { describeOf, DEVICES, eventsSince, LAMP, setup } from "./setup.js";

type Body = Record<string, any>;
const CHANNEL = "sim-bridge:channel";
const LEAK = { notice_id: "n-leak", cause: "safety_rule", rule_id: "leak", devices: ["sim-bridge:valve"], text: "Протечка в ванной" };
const notify = (args: Body) => ({ target: CHANNEL, action: "notify.notify", args });

/** The applies the steward sent for notices, by key. */
const noticeApplies = (applier: FakeApplier) => applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:"));
/** An attempt's key: `notices:<life>:<n>`. */
const KEY = /^notices:[0-9a-f-]{36}:(\d+)$/;

describe("notices (GA-NOTE-1)", () => {
  it("declares its mutations", () => {
    for (const m of ["trusts-the-callers-from", "sends-from-to-an-old-applier"]) expect(MUTATIONS).toContain(m);
  });

  it("delivers an applier notice on the home's channels as one apply, then sends notice_taken, and forgets it once no longer listed", async () => {
    const { ok, applier, clock, pump, store } = await setup();
    const { cursor } = await ok(SECRETS.owner, "events");
    applier.answerOutcome = "delivered";
    applier.raise({ ...LEAK });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    expect(noticeApplies(applier)[0]!.idempotency_key).toMatch(KEY);
    expect(noticeApplies(applier)[0]).toEqual({ idempotency_key: noticeApplies(applier)[0]!.idempotency_key, request: { actions: [{ target: CHANNEL, action: "notify.notify",
      args: { text: "Протечка в ванной", urgency: "critical", from: { notice: "n-leak" } }, via: "rule", brain: false, for: { notice: "n-leak" } }] } });
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "notice")).map((e) => e.change)).toEqual(["raised", "delivered"]));
    expect(applier.taken).toEqual([]);
    await pump();
    expect(applier.taken).toEqual(["n-leak"]);
    expect(applier.notices).toEqual([]);
    await pump();
    expect(applier.taken).toEqual(["n-leak"]);
    await store.settled();
    expect((await store.query("SELECT notice_id FROM notices")).rows).toEqual([]);
  });

  it("retries every 60 s, never giving up, until a channel's notify is delivered, and takes nothing before (GA-NOTE-1)", async () => {
    const { applier, clock, pump } = await setup();
    applier.emitsOutcomes = false;
    applier.raise({ ...LEAK, notice_id: "n-1", cause: "join_window" });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    for (let n = 2; n <= 6; n++) {
      clock.advance(NOTICE_RETRY_MS - 1);
      await pump();
      expect(noticeApplies(applier)).toHaveLength(n - 1);
      await vi.waitFor(() => { clock.advance(1); expect(noticeApplies(applier)).toHaveLength(n); });
    }
    expect(noticeApplies(applier).map((a) => String(a.idempotency_key).match(KEY)?.[1])).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(noticeApplies(applier)[0]!.request.actions[0].args.urgency).toBe("warning");
    expect(applier.taken).toEqual([]);
    // A late outcome event of an earlier attempt delivers it.
    applier.emit({ type: "outcome", apply_id: "applier-apply-2", step_id: "s1", target: CHANNEL, outcome: "delivered" });
    await pump();
    await pump();
    expect(applier.taken).toEqual(["n-1"]);
    clock.advance(NOTICE_RETRY_MS * 3);
    expect(noticeApplies(applier)).toHaveLength(6);
  });

  it("takes a sent notify as delivered only on a channel that reports no receipt (GA-NOTE-1)", async () => {
    const { applier, clock, pump, steward } = await setup();
    applier.answerOutcome = "sent";
    applier.raise({ ...LEAK });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    await pump();
    expect(applier.taken).toEqual([]);
    steward.onDescribe(describeOf(DEVICES.map((d) => (d.id === CHANNEL ? { ...d, actions: [{ action: "notify.notify", tier: "reversible", confirms: false }] } : d)), 2));
    await vi.waitFor(() => { clock.advance(NOTICE_RETRY_MS); expect(noticeApplies(applier)).toHaveLength(2); });
    await pump();
    expect(applier.taken).toEqual(["n-leak"]);
  });

  it("tries again 60 s on when the applier is out of reach", async () => {
    const { applier, clock, pump, steward } = await setup({ reach: false });
    applier.raise({ ...LEAK });
    await pump();
    const tried = () => (steward as any).notices.all().map((n: Body) => `${n.notice_id} ${n.attempts} ${n.delivered}`);
    await vi.waitFor(() => { clock.advance(0); expect(tried()).toEqual(["n-leak 1 false"]); });
    // The attempt's call has failed and ended before the clock moves on.
    await vi.waitFor(() => expect((steward as any).notices.trying).toBe(false));
    clock.advance(NOTICE_RETRY_MS - 1);
    expect(tried()).toEqual(["n-leak 1 false"]);
    clock.advance(1);
    expect(tried()).toEqual(["n-leak 2 false"]);
    expect(applier.applies).toEqual([]);
  });

  it("keeps a notice not delivered across a restart, and tries it again at start, its attempts counted on (GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const applier = new FakeApplier();
    const a = await setup({ db, clock, applier });
    applier.raise({ ...LEAK });
    await a.pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    applier.answerOutcome = "delivered";
    const b = await setup({ db, clock, applier, define: false });
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(2); });
    expect(noticeApplies(applier)[1]!.idempotency_key).toMatch(KEY);
    expect(noticeApplies(applier)[1]!.idempotency_key).not.toBe(noticeApplies(applier)[0]!.idempotency_key);
    expect((b.steward as any).notices.all().map((n: Body) => n.attempts)).toEqual([2]);
    await b.pump();
    expect(applier.taken).toEqual(["n-leak"]);
  });

  it("leaves from out of a notice's notify while the applier is older than 0.10, and sets it under sends-from-to-an-old-applier (GA-NOTE-2)", async () => {
    for (const mutation of [undefined, "sends-from-to-an-old-applier"] as const) {
      const applier = new FakeApplier();
      applier.standardVersion = "0.8";
      const { clock, pump, steward } = await setup({ applier, mutation });
      steward.onDescribe({ ...describeOf(DEVICES, 2), standard_version: "0.8" });
      applier.raise({ ...LEAK });
      await pump();
      await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
      expect(noticeApplies(applier)[0]!.request.actions[0].args.from).toEqual(mutation ? { notice: "n-leak" } : undefined);
    }
  });

  it("raises its own notice when a device of the applier's takes a group's id, and forgets it once delivered", async () => {
    const { applier, clock, steward, store } = await setup();
    applier.answerOutcome = "delivered";
    steward.onDescribe(describeOf([...DEVICES, { id: "hall-lights", label: "x", class: "light", capabilities: ["onoff"], adopted: true, actions: [] }], 2));
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    expect(noticeApplies(applier)[0]!.request.actions.map((a: Body) => a.for)).toEqual([{ notice: "steward:shadowed:hall-lights" }]);
    await vi.waitFor(() => expect((steward as any).notices.all()).toEqual([]));
    await store.settled();
    expect((await store.query("SELECT notice_id FROM notices")).rows).toEqual([]);
  });
});

describe("a notify's from (GA-NOTE-2)", () => {
  it("overwrites a caller's from with its own, marking the plan's step, and sets it where the caller gave none", async () => {
    const { ok, applier } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [notify({ text: "a", urgency: "info", from: { notice: "fake" } }),
      { ...notify({ text: "b", urgency: "info" }) }] });
    expect(plan.steps.map((s: Body) => [s.args.from, s.from_replaced])).toEqual([[{ endpoint: "olga-app", role: "member" }, true],
      [{ endpoint: "olga-app", role: "member" }, undefined]]);
    expect(applier.plans.at(-1)!.actions.map((a: Body) => a.args.from)).toEqual([{ endpoint: "olga-app", role: "member" }, { endpoint: "olga-app", role: "member" }]);
  });

  it("marks the outcome of an inline request's overwritten notify, and sends its own from", async () => {
    const { ok, applier } = await setup();
    const r = await ok(SECRETS.panel, "apply", { request: { endpoint: "hall-panel", actions: [notify({ text: "a", urgency: "info", from: { notice: "fake" } }),
      { target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "from" });
    expect(r.outcomes.map((o: Body) => o.from_replaced)).toEqual([true, undefined]);
    expect(applier.applies.at(-1)!.request.actions[0].args.from).toEqual({ endpoint: "hall-panel", role: "guest" });
    expect((await ok(SECRETS.panel, "outcome", { apply_id: r.apply_id })).outcomes[0].from_replaced).toBe(true);
  });

  it("sends no from to an applier older than 0.10, and passes the caller's on under trusts-the-callers-from", async () => {
    const old = await setup();
    old.steward.onDescribe({ ...describeOf(DEVICES, 2), standard_version: "0.9" });
    const plan = await old.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [notify({ text: "a", urgency: "info", from: { notice: "fake" } })] });
    expect(plan.steps[0].args.from).toBeUndefined();
    expect(plan.steps[0].from_replaced).toBe(true);
    const trusting = await setup({ mutation: "trusts-the-callers-from" });
    const p = await trusting.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [notify({ text: "a", urgency: "info", from: { notice: "fake" } })] });
    expect(p.steps[0].args.from).toEqual({ notice: "fake" });
  });
});

describe("the notice pump's cost (the milestone review, B2, ruled Q1)", () => {
  it("tries every notice waiting in one apply per tick, one notify each, whatever their number", async () => {
    const { applier, clock, pump, steward } = await setup();
    const idle = () => vi.waitFor(() => expect((steward as any).notices.trying).toBe(false));
    applier.emitsOutcomes = false;
    for (let i = 0; i < 40; i++) applier.raise({ ...LEAK, notice_id: `n-${String(i).padStart(2, "0")}`, cause: "join_window" });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    expect(noticeApplies(applier)[0]!.request.actions.map((a: Body) => a.for.notice)).toHaveLength(40);
    await idle();
    clock.advance(NOTICE_RETRY_MS);
    await vi.waitFor(() => expect(noticeApplies(applier)).toHaveLength(2));
    await idle();
    clock.advance(NOTICE_RETRY_MS);
    await vi.waitFor(() => expect(noticeApplies(applier)).toHaveLength(3));
    expect(new Set(noticeApplies(applier).map((a) => a.idempotency_key)).size).toBe(3);
  });

  it("delivers each notice of an attempt by its own step, the rest tried on", async () => {
    const { applier, clock, pump, steward } = await setup();
    applier.emitsOutcomes = false;
    applier.raise({ ...LEAK, notice_id: "n-a" });
    applier.raise({ ...LEAK, notice_id: "n-b" });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(noticeApplies(applier)).toHaveLength(1); });
    const steps = noticeApplies(applier)[0]!.request.actions.map((a: Body) => a.for.notice);
    expect(steps).toEqual(["n-a", "n-b"]);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s2", target: CHANNEL, outcome: "delivered" });
    await pump();
    expect((steward as any).notices.all().map((n: Body) => `${n.notice_id} ${n.delivered}`)).toEqual(["n-a false", "n-b true"]);
    await vi.waitFor(() => expect((steward as any).notices.trying).toBe(false));
    clock.advance(NOTICE_RETRY_MS);
    await vi.waitFor(() => expect(noticeApplies(applier)).toHaveLength(2));
    expect(noticeApplies(applier)[1]!.request.actions.map((a: Body) => a.for.notice)).toEqual(["n-a"]);
  });

  it("folds the steward's own notices past 1,024 waiting into one summary, and never folds the applier's", async () => {
    const { applier, pump, steward } = await setup({ reach: false });
    const notices = (steward as any).notices;
    for (let i = 0; i < OWN_PENDING_CAP + 5; i++) notices.own(`steward:test:${i}`, "test", `n ${i}`);
    applier.raise({ ...LEAK, notice_id: "n-applier" });
    await pump();
    const all = notices.all() as Body[];
    expect(all.filter((n) => n.source === "steward" && n.notice_id !== SUMMARY_ID)).toHaveLength(OWN_PENDING_CAP);
    expect(all.find((n) => n.notice_id === SUMMARY_ID)!.doc.count).toBe(5);
    expect(all.filter((n) => n.source === "applier").map((n) => n.notice_id)).toEqual(["n-applier"]);
  });
});

describe("the steward's own notices of one subject (the milestone review, B2, ruled Q1)", () => {
  it("takes a second notice of a subject still waiting into the first: one notice, counted, its text the latest", async () => {
    const { steward } = await setup({ reach: false });
    const notices = (steward as any).notices;
    notices.own("steward:rule:r:0:s1", "rule_failed", "first", { rule: "r", action: "a", outcome: "failed" }, "rule_failed:r:a");
    notices.own("steward:rule:r:1:s1", "rule_failed", "second", { rule: "r", action: "a", outcome: "unreachable" }, "rule_failed:r:a");
    notices.own("steward:rule:r:2:s1", "rule_failed", "other", { rule: "r", action: "b", outcome: "failed" }, "rule_failed:r:b");
    const all = notices.all() as Body[];
    expect(all.map((n) => n.notice_id)).toEqual(["steward:rule:r:0:s1", "steward:rule:r:2:s1"]);
    expect(all[0]!.doc).toMatchObject({ count: 2, outcome: "unreachable", text: "second (2 times)" });
  });
});
