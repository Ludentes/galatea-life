import { describe, expect, it, vi } from "vitest";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { NoticePump } from "../src/notices/pump.js";
import { afterOutcome, heldWaitMs, LATE_ACK_SLACK_MS, RETRY_SPACING_MS, retrySpacingMs, RuleOutcomes, type Firing } from "../src/rules/outcomes.js";
import { FakeClock } from "./fake-clock.js";
import { del, SECRETS, up } from "./house.js";
import { describeOf, DEVICES, eventsSince, LAMP, setup, TV } from "./setup.js";

type Body = Record<string, any>;
const MOTION = "sim-bridge:motion";
const LAPTOP = "pc-bridge:laptop";
const PULSE = "sim-bridge:pulse";
const AC = "sim-bridge:ac";
const ACK_S = 12;
/**
 * The fake applier's devices with what a rule's outcome reads of them: a laptop whose lock is
 * idempotent, a pulse relay whose `turn_on` is not, an IR air conditioner (open) whose `set_mode` is,
 * each acked within 12 s; and a motion sensor. Each with a bound.
 */
const ALL = [...DEVICES.map((d) => ({ ...d, fresh_s: 60 })),
  { id: MOTION, label: "motion", class: "sensor", capabilities: ["sensor"], sensor_keys: ["motion"], adopted: true, fresh_s: 60, actions: [] },
  { id: LAPTOP, label: "laptop", class: "computer", capabilities: ["session"], adopted: true, fresh_s: 60, accounts: { liza: "Лиза" },
    actions: [{ action: "session.lock", tier: "reversible", stateless: false, idempotent: true, ack_within_s: ACK_S }] },
  { id: PULSE, label: "pulse", class: "socket", capabilities: ["onoff"], adopted: true, fresh_s: 60,
    actions: [{ action: "onoff.turn_on", tier: "reversible", idempotent: false, ack_within_s: ACK_S }] },
  { id: AC, label: "ac", class: "ac", capabilities: ["climate"], adopted: true, feedback: "open", fresh_s: null,
    actions: [{ action: "climate.set_mode", tier: "reversible", idempotent: true, ack_within_s: ACK_S }] }];
const NOT_LOCKED = ["locked", "disconnected", "none"];
/** HS20's limit: while Лиза's session is open, lock it. */
const LIMIT = { id: "limit", name: "Лиза: лимит", conditions: [{ target: LAPTOP, key: "session.liza", not_in: NOT_LOCKED }],
  actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };
/** A rule of conditions only on the motion sensor, acting on `target`. */
const onMotion = (id: string, target: string, action: string, args: Body = {}) => ({ id, name: id,
  conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }], actions: [{ target, action, args }] });

/** A steward over the fake applier with the devices above, the rules defined and every device live. */
async function ruled(rules: Body[], o: { mutation?: Mutation } = {}) {
  const clock = new FakeClock();
  const at = new Date(clock.now()).toISOString();
  const values: Record<string, Body> = { [LAMP]: { on: false }, [MOTION]: { motion: false }, [LAPTOP]: { "session.liza": "locked" },
    [PULSE]: { on: false }, [AC]: {}, "sim-bridge:channel": {} };
  const state = { targets: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, { liveness: "live",
    values: Object.entries(v).map(([key, value]) => ({ key, value, basis_time: at })) }])), transports: [], latches: [] };
  const s = await setup({ mutation: o.mutation, clock, devices: ALL, state, options: { pruneEveryMs: 3_600_000 } });
  await s.define(rules.map((r) => up("rule", r)));
  const change = async (target: string, key: string, value: unknown, cause: unknown = "device") => {
    s.applier.emit({ type: "state", target, key, value, basis_time: new Date(s.clock.now()).toISOString(), cause });
    await s.pump();
  };
  const fired = () => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("rule:"));
  const firedKeys = () => [...new Set(fired().map((a) => a.idempotency_key as string))];
  const settle = async () => { for (let i = 0; i < 5; i++) { s.clock.advance(0); await new Promise((r) => setTimeout(r, 0)); } };
  const keys = async (want: string[]) => vi.waitFor(() => { s.clock.advance(0); expect(firedKeys()).toEqual(want); });
  /** The applier's apply id of the firing keyed `key`: the fake numbers its applies by their keys, in order. */
  const applierId = (key: string) => `applier-apply-${[...new Set(s.applier.applies.map((a) => a.idempotency_key))].indexOf(key) + 1}`;
  /** The applier settles the firing keyed `key`'s first step: an `outcome` event, followed. */
  const ends = async (key: string, target: string, outcome: string, reason?: string) => {
    s.applier.emit({ type: "outcome", apply_id: applierId(key), step_id: "s1", target, outcome, ...(reason ? { reason } : {}) });
    await s.pump();
  };
  /** The firing keyed `key` takes effect after all: a `late_ack` event, followed. */
  const lateAck = async (key: string, target: string) => {
    s.applier.emit({ type: "late_ack", apply_id: applierId(key), step_id: "s1", target, key: "session.liza", value: "locked" });
    await s.pump();
  };
  /** The notices raised since `cursor` for a rule's action that failed (GA-RULE-8). */
  const failures = async (cursor: string) => (await eventsSince(s.ok, cursor, "notice")).filter((e) => e.change === "raised" && e.cause === "rule_failed");
  /** Moves the clock in steps of five seconds, shorter than any spacing here, the steward's work settling at each. */
  const walk = async (ms: number) => { for (let t = 0; t < ms; t += 5_000) { s.clock.advance(Math.min(5_000, ms - t)); await settle(); } };
  return { ...s, change, fired, firedKeys, keys, settle, ends, lateAck, walk, failures };
}

describe("what a rule's outcome does: retries (GA-RULE-7)", () => {
  it("declares its mutations", () => {
    for (const m of ["locks-once-and-gives-up", "retries-hours-later", "leaves-it-unanswered", "retries-a-shutdown"]) expect(MUTATIONS).toContain(m);
  });

  it("tries again an idempotent action's skipped(dead), unreachable and failed(no_ack), and once its unanswered; nothing else, and nothing not idempotent", () => {
    const after = (outcome: string, reason?: string, idempotent = true, unanswered = 0, m?: Mutation) =>
      afterOutcome({ outcome, ...(reason ? { reason } : {}), idempotent, unanswered }, m).kind;
    expect(["acked", "delivered", "sent", "confirmed"].map((x) => after(x))).toEqual(["landed", "landed", "landed", "landed"]);
    expect(after("skipped", "already")).toBe("landed");
    expect([after("skipped", "dead"), after("unreachable"), after("failed", "no_ack"), after("unanswered")]).toEqual(["retry", "retry", "retry", "retry"]);
    expect(after("unanswered", undefined, true, 1)).toBe("notice");
    expect([after("failed", "not_locked"), after("failed", "invalid_request"), after("failed", "unsupported_action"), after("refused", "leased"),
      after("skipped", "occupied"), after("skipped", "toggle_only")]).toEqual(["hold", "notice", "notice", "none", "none", "none"]);
    expect([after("skipped", "dead", false), after("unreachable", undefined, false), after("failed", "no_ack", false),
      after("unanswered", undefined, false)]).toEqual(["notice", "notice", "hold", "notice"]);
    expect(after("failed", "no_ack", true, 0, "locks-once-and-gives-up")).toBe("none");
    expect(after("unanswered", undefined, true, 0, "leaves-it-unanswered")).toBe("none");
    expect([after("failed", "no_ack", false, 0, "retries-a-shutdown"), after("failed", "invalid_request", true, 0, "retries-a-shutdown")]).toEqual(["retry", "retry"]);
    expect(after("failed", "not_locked", true, 0, "retries-a-shutdown")).toBe("hold");
  });

  it("spaces tries a minute apart, or the ack_within_s when longer: never sooner than it, never later than 300 s, or its ack_within_s plus 60 s when that is longer than 300 s (GA-RULE-7)", () => {
    expect(RETRY_SPACING_MS).toBe(60_000);
    for (const ack of [1, 10, 60, 299, 300, 301, 400, 600]) {
      const ms = retrySpacingMs(ack);
      expect(ms).toBeGreaterThanOrEqual(ack * 1000);
      expect(ms).toBeLessThanOrEqual((ack > 300 ? ack + 60 : 300) * 1000);
    }
    expect(retrySpacingMs(10, "retries-hours-later")).toBe(3_600_000);
    expect(retrySpacingMs(10, "retries-a-shutdown")).toBe(10_000);
  });

  it("fires a lock that ended failed(no_ack) again a minute after its last try, while the session stays open, until it lands", async () => {
    const { change, keys, ends, walk, ok, settle } = await ruled([LIMIT]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await walk(ACK_S * 1000);
    await ends("rule:limit:0", LAPTOP, "failed", "no_ack");
    await walk(RETRY_SPACING_MS - ACK_S * 1000 - 1_000);
    await keys(["rule:limit:0"]);
    await walk(1_000);
    await keys(["rule:limit:0", "rule:limit:1"]);
    const retry = (await eventsSince(ok, cursor, "rule_fired")).at(-1)!;
    expect([retry.firing, retry.retry]).toEqual([1, true]);
    // Its lost ack again: tried again; then it lands, and no more.
    await ends("rule:limit:1", LAPTOP, "failed", "no_ack");
    await walk(RETRY_SPACING_MS);
    await keys(["rule:limit:0", "rule:limit:1", "rule:limit:2"]);
    await ends("rule:limit:2", LAPTOP, "acked");
    await walk(600_000);
    await settle();
    await keys(["rule:limit:0", "rule:limit:1", "rule:limit:2"]);
  });

  it("never tries a failed(no_ack) again under locks-once-and-gives-up, and only an hour later under retries-hours-later", async () => {
    for (const [m, want] of [["locks-once-and-gives-up", ["rule:limit:0"]], ["retries-hours-later", ["rule:limit:0"]]] as const) {
      const { change, keys, ends, walk } = await ruled([LIMIT], { mutation: m });
      await change(LAPTOP, "session.liza", "active");
      await keys(["rule:limit:0"]);
      await ends("rule:limit:0", LAPTOP, "failed", "no_ack");
      await walk(300_000);
      await keys([...want]);
    }
  });

  it("drops a retry once the conditions stop holding, and a late_ack lands the action", async () => {
    const { change, keys, ends, lateAck, walk } = await ruled([LIMIT]);
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await ends("rule:limit:0", LAPTOP, "failed", "no_ack");
    await change(LAPTOP, "session.liza", "disconnected");
    await walk(300_000);
    await keys(["rule:limit:0"]);
    // Open again: a new becoming true fires; its lost ack, then its late ack, and no retry.
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0", "rule:limit:1"]);
    await ends("rule:limit:1", LAPTOP, "failed", "no_ack");
    await lateAck("rule:limit:1", LAPTOP);
    await walk(300_000);
    await keys(["rule:limit:0", "rule:limit:1"]);
  });

  it("drops a retry owed to an earlier becoming true: the rule false and true again fires afresh, and only that", async () => {
    const { change, keys, ends, walk } = await ruled([LIMIT]);
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await ends("rule:limit:0", LAPTOP, "failed", "no_ack");
    await change(LAPTOP, "session.liza", "locked");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0", "rule:limit:1"]);
    await walk(300_000);
    await keys(["rule:limit:0", "rule:limit:1"]);
  });

  it("tries again a step that ended skipped(dead) or unreachable, each a minute on, while the conditions hold", async () => {
    const { change, keys, ends, walk, applier } = await ruled([onMotion("lamp", LAPTOP, "session.lock", { account: "liza" })]);
    applier.planner = (a) => (a.target === LAPTOP ? { verdict: "skip", reason: "dead" } : {});
    await change(MOTION, "motion", true);
    await keys(["rule:lamp:0"]);
    await walk(RETRY_SPACING_MS);
    await keys(["rule:lamp:0", "rule:lamp:1"]);
    applier.planner = () => ({});
    await walk(RETRY_SPACING_MS);
    await keys(["rule:lamp:0", "rule:lamp:1", "rule:lamp:2"]);
    await ends("rule:lamp:2", LAPTOP, "unreachable");
    await walk(RETRY_SPACING_MS);
    await keys(["rule:lamp:0", "rule:lamp:1", "rule:lamp:2", "rule:lamp:3"]);
    await change(MOTION, "motion", false);
    await ends("rule:lamp:3", LAPTOP, "unreachable");
    await walk(300_000);
    await keys(["rule:lamp:0", "rule:lamp:1", "rule:lamp:2", "rule:lamp:3"]);
  });

  it("fires an unanswered action on an open device again once, and no more while the conditions hold; never under leaves-it-unanswered", async () => {
    for (const [m, want] of [[undefined, ["rule:cool:0", "rule:cool:1"]], ["leaves-it-unanswered", ["rule:cool:0"]]] as const) {
      const { change, keys, ends, walk } = await ruled([onMotion("cool", AC, "climate.set_mode", { mode: "off" })], { mutation: m });
      await change(MOTION, "motion", true);
      await keys(["rule:cool:0"]);
      await ends("rule:cool:0", AC, "unanswered");
      await walk(RETRY_SPACING_MS);
      await keys([...want]);
      if (want.length > 1) await ends("rule:cool:1", AC, "unanswered");
      await walk(600_000);
      await keys([...want]);
    }
  });

  it("never fires again an action that is not idempotent, nor one that failed for another reason; does under retries-a-shutdown", async () => {
    for (const [m, extra] of [[undefined, 0], ["retries-a-shutdown", 1]] as const) {
      const { change, keys, ends, walk, firedKeys } = await ruled([onMotion("pulse", PULSE, "onoff.turn_on"), LIMIT], { mutation: m });
      await change(MOTION, "motion", true);
      await change(LAPTOP, "session.liza", "active");
      await keys(["rule:pulse:0", "rule:limit:0"]);
      await ends("rule:pulse:0", PULSE, "failed", "no_ack");
      await ends("rule:limit:0", LAPTOP, "failed", "invalid_request");
      await walk(ACK_S * 1000);
      expect(firedKeys().length).toBe(2 + 2 * extra);
      await walk(300_000);
      if (!m) await keys(["rule:pulse:0", "rule:limit:0"]);
    }
  });

  it("tries again only a rule of conditions only: an edge rule's lost ack is not", async () => {
    const edge = { id: "edge", name: "edge", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
      actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };
    const { change, keys, ends, walk } = await ruled([edge]);
    await change(MOTION, "motion", true);
    await keys(["rule:edge:0"]);
    await ends("rule:edge:0", LAPTOP, "failed", "no_ack");
    await walk(300_000);
    await keys(["rule:edge:0"]);
  });
});

describe("what a rule's outcome does: failure notices (GA-RULE-8)", () => {
  it("declares its mutations", () => {
    for (const m of ["fails-the-limit-silently", "notices-a-slow-lock", "holds-an-ssh-only-lock", "times-the-lock", "drops-a-held-notice",
      "notices-a-slow-late-ack", "notices-every-skipped-toggle", "notices-a-late-launch", "notices-every-lease"]) expect(MUTATIONS).toContain(m);
  });

  it("holds a lock's notice for its ack_within_s from dispatch and a failed(no_ack)'s for the 60 s window, each with the 11 s slack", () => {
    expect(LATE_ACK_SLACK_MS).toBe(11_000);
    expect(heldWaitMs("dispatch", 12)).toBe(23_000);
    expect(heldWaitMs("outcome", 12)).toBe(71_000);
    expect(heldWaitMs("outcome", 12, "notices-a-slow-late-ack")).toBe(60_000);
    const after = (outcome: string, reason: string, m?: Mutation) => afterOutcome({ outcome, reason, idempotent: false, unanswered: 0 }, m);
    expect(after("failed", "no_graphical_session").kind).toBe("notice");
    expect(after("failed", "no_graphical_session", "holds-an-ssh-only-lock")).toEqual({ kind: "hold", from: "dispatch" });
    expect([after("failed", "not_locked", "times-the-lock").kind, after("failed", "not_locked", "fails-the-limit-silently").kind]).toEqual(["notice", "none"]);
    expect([after("refused", "leased", "notices-every-lease").kind, after("skipped", "toggle_only", "notices-every-skipped-toggle").kind]).toEqual(["notice", "notice"]);
    expect([after("skipped", "in_use").kind, after("skipped", "occupancy_unknown").kind, after("refused", "tier").kind]).toEqual(["none", "notice", "notice"]);
  });

  it("raises one notice for an action each time its rule becomes true, however many of its firings fail", () => {
    const clock = new FakeClock();
    const raised: string[] = [];
    const o = new RuleOutcomes({ clock, holds: () => true, episode: () => 0, retry: () => undefined, notice: (id) => raised.push(id) });
    const step = { target: PULSE, action: "onoff.turn_on", args: {}, respect: false, idempotent: false, ackWithinS: ACK_S, unanswered: 0 };
    const firing = (n: number, episode: number): Firing => ({ rule: "pulse", name: "pulse", n, episode, conditionsOnly: true, atMs: clock.now(), steps: { s1: step } });
    o.settled(firing(0, 0), "s1", "failed", "rejected");
    o.settled(firing(1, 0), "s1", "failed", "rejected");
    o.settled(firing(2, 1), "s1", "failed", "rejected");
    expect(raised).toEqual(["steward:rule:pulse:0:s1", "steward:rule:pulse:2:s1"]);
    // A rule that is not of conditions only, or no longer holds, raises none.
    o.settled({ ...firing(3, 2), conditionsOnly: false }, "s1", "failed", "rejected");
    const off = new RuleOutcomes({ clock, holds: () => false, episode: () => 0, retry: () => undefined, notice: (id) => raised.push(id) });
    off.settled(firing(4, 3), "s1", "failed", "rejected");
    expect(raised.length).toBe(2);
  });

  it("raises at once, naming the rule, the action, its target and the outcome, a failure no retry fixes; none once the conditions stopped", async () => {
    const { change, keys, ends, ok, failures, settle, steward } = await ruled([LIMIT]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await ends("rule:limit:0", LAPTOP, "failed", "rejected");
    const [n] = await failures(cursor);
    expect(n).toMatchObject({ notice_id: "steward:rule:limit:0:s1", source: "steward", rule: "limit", action: "session.lock", target: LAPTOP,
      outcome: "failed", reason: "rejected" });
    expect(n!.text).toContain("limit");
    expect(n!.text).toContain("failed(rejected)");
    // Opened again: a new becoming true, a second notice; one whose failure comes after the session closed raises none.
    await change(LAPTOP, "session.liza", "locked");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0", "rule:limit:1"]);
    await ends("rule:limit:1", LAPTOP, "failed", "rejected");
    await change(LAPTOP, "session.liza", "locked");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0", "rule:limit:1", "rule:limit:2"]);
    await change(LAPTOP, "session.liza", "disconnected");
    await ends("rule:limit:2", LAPTOP, "failed", "rejected");
    await settle();
    // The second, while the first still waits for delivery, is taken into it: one notice, counted (ruled Q1).
    expect((await failures(cursor)).map((e) => e.notice_id)).toEqual(["steward:rule:limit:0:s1"]);
    expect((steward as any).notices.all().map((n: Body) => [n.notice_id, n.doc.count])).toEqual([["steward:rule:limit:0:s1", 2]]);
  });

  it("raises an unanswered action's notice after its one further try", async () => {
    const { change, keys, ends, walk, ok, failures } = await ruled([onMotion("cool", AC, "climate.set_mode", { mode: "off" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(MOTION, "motion", true);
    await keys(["rule:cool:0"]);
    await ends("rule:cool:0", AC, "unanswered");
    expect(await failures(cursor)).toEqual([]);
    await walk(RETRY_SPACING_MS);
    await keys(["rule:cool:0", "rule:cool:1"]);
    await ends("rule:cool:1", AC, "unanswered");
    expect((await failures(cursor)).map((e) => [e.notice_id, e.outcome])).toEqual([["steward:rule:cool:1:s1", "unanswered"]]);
  });

  it.each([[undefined, false, true], [undefined, true, true], ["drops-a-held-notice", true, false], ["fails-the-limit-silently", false, false]] as const)("holds a failed(not_locked) until the lock's ack_within_s from dispatch and the slack pass, raising it then, though the session closed meanwhile: %s, %s", async (m, closes, want) => {
    const { change, keys, ends, walk, ok, failures } = await ruled([LIMIT], { mutation: m });
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await walk(1_000);
    await ends("rule:limit:0", LAPTOP, "failed", "not_locked");
    if (closes) {
      await walk(5_000);
      await change(LAPTOP, "session.liza", "disconnected");
    }
    await walk(22_000 - (closes ? 6_000 : 1_000));
    expect(await failures(cursor), `${m}: before the wait`).toEqual([]);
    await walk(1_000);
    expect((await failures(cursor)).length, `${m}, closing ${closes}`).toBe(want ? 1 : 0);
  });

  it("raises a failed(not_locked) at once under times-the-lock", async () => {
    const { change, keys, ends, walk, ok, failures } = await ruled([LIMIT], { mutation: "times-the-lock" });
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await walk(1_000);
    await ends("rule:limit:0", LAPTOP, "failed", "not_locked");
    expect((await failures(cursor)).length).toBe(1);
  });

  it("raises none for a lock that takes late, within the wait; does under notices-a-slow-lock", async () => {
    for (const [m, want] of [[undefined, 0], ["notices-a-slow-lock", 1]] as const) {
      const { change, keys, ends, lateAck, walk, ok, failures } = await ruled([LIMIT], { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      await change(LAPTOP, "session.liza", "active");
      await keys(["rule:limit:0"]);
      await walk(1_000);
      await ends("rule:limit:0", LAPTOP, "failed", "not_locked");
      await walk(3_000);
      await lateAck("rule:limit:0", LAPTOP);
      await walk(60_000);
      expect((await failures(cursor)).length, String(m)).toBe(want);
    }
  });

  it("raises a failed(no_graphical_session) at once; holds it for the lock's wait under holds-an-ssh-only-lock", async () => {
    for (const [m, want] of [[undefined, 1], ["holds-an-ssh-only-lock", 0]] as const) {
      const { change, keys, ends, walk, ok, failures } = await ruled([LIMIT], { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      await change(LAPTOP, "session.liza", "active");
      await keys(["rule:limit:0"]);
      await walk(1_000);
      await ends("rule:limit:0", LAPTOP, "failed", "no_graphical_session");
      await walk(1_000);
      expect((await failures(cursor)).length, String(m)).toBe(want);
    }
  });

  // Without a late ack: raised at 71 s. A late ack seen at 62 s: none, but under notices-a-slow-late-ack (raised at 60 s);
  // one at 20 s: none, but under notices-a-late-launch.
  it.each([[undefined, undefined, [70_000, 1]], [undefined, 62_000, [70_000, 0]], ["notices-a-slow-late-ack", 62_000, [61_000, 1]], [undefined, 20_000, [70_000, 0]], ["notices-a-late-launch", 20_000, [70_000, 1]]] as const)("holds a non-idempotent action's failed(no_ack) for the 60 s late-ack window and the slack; a late_ack inside it raises none: %s, %s", async (m, ackAt, want) => {
    const { change, keys, ends, lateAck, walk, ok, failures } = await ruled([onMotion("pulse", PULSE, "onoff.turn_on")], { mutation: m });
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(MOTION, "motion", true);
    await keys(["rule:pulse:0"]);
    await walk(ACK_S * 1000);
    await ends("rule:pulse:0", PULSE, "failed", "no_ack");
    let at = 0;
    if (ackAt !== undefined) {
      await walk(Math.min(ackAt, want[0]));
      at = Math.min(ackAt, want[0]);
      if (at === ackAt) await lateAck("rule:pulse:0", PULSE);
    }
    await walk(want[0] - at);
    if (at < (ackAt ?? 0)) {
      expect((await failures(cursor)).length, `${m} at ${want[0]}`).toBe(want[1]);
      return;
    }
    expect(await failures(cursor), `${m}: before 71 s`).toEqual([]);
    await walk(1_000);
    expect((await failures(cursor)).length, `${m} at 71 s`).toBe(want[1]);
  });

  it("raises none for refused(leased) or skipped(toggle_only); does under notices-every-lease and notices-every-skipped-toggle", async () => {
    for (const m of [undefined, "notices-every-lease", "notices-every-skipped-toggle"] as const) {
      const rules = [onMotion("lamp", LAMP, "onoff.turn_on"), onMotion("tv", "sim-bridge:tv", "onoff.turn_off")];
      const { change, ok, failures, settle } = await ruled(rules, { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      // Someone turned the lamp off by hand: an outside change, a lease at a person's precedence (GA-LEASE-2).
      await change(LAMP, "on", false, "external");
      await change(MOTION, "motion", true);
      // Neither step reaches the applier: both rules fired, each step ending at the steward.
      await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "rule_fired")).length).toBe(2));
      await settle();
      const got = (await failures(cursor)).map((e) => `${e.rule} ${e.outcome}(${e.reason})`).sort();
      expect(got, String(m)).toEqual(m === "notices-every-lease" ? ["lamp refused(leased)"] : m === "notices-every-skipped-toggle" ? ["tv skipped(toggle_only)"] : []);
    }
  });
});

describe("what a rule's outcome does: the toggle notice (GA-RULE-8)", () => {
  /** The toggle notices raised since `cursor`, each `rule target action`. */
  async function toggles(ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string): Promise<string[]> {
    return (await eventsSince(ok, cursor, "notice")).filter((e) => e.change === "raised" && e.cause === "rule_toggle")
      .map((e) => `${e.rule} ${e.target} ${e.action}`);
  }

  it("declares its mutations", () => {
    for (const m of ["defines-a-toggle-rule-silently", "re-declares-a-toggle-silently"]) expect(MUTATIONS).toContain(m);
  });

  it("issues one notice at define for a rule acting on a toggle of an open-loop device, again when it is changed, none for other rules; none under defines-a-toggle-rule-silently", async () => {
    for (const m of [undefined, "defines-a-toggle-rule-silently"] as const) {
      const { ok, define } = await ruled([], { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      const tv = onMotion("tv", TV, "onoff.turn_off");
      await define([up("rule", tv), up("rule", onMotion("lamp", LAMP, "onoff.turn_on"))]);
      await define([up("rule", { ...tv, name: "Телевизор" })]);
      const said = await toggles(ok, cursor);
      expect(said, String(m)).toEqual(m ? [] : [`tv ${TV} onoff.turn_off`, `tv ${TV} onoff.turn_off`]);
      expect((await eventsSince(ok, cursor, "notice")).find((e) => e.cause === "rule_toggle")?.text ?? "never").toMatch(m ? /never/ : /will never run/);
    }
  });

  it("issues one when a selector it acts on comes to take such an action, and none when nothing new comes", async () => {
    const den = { id: "den", name: "Гостиная", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ selector: { room: "den", capability: "onoff" }, action: "onoff.turn_off", args: {} }] };
    const { ok, define } = await ruled([]);
    await define([up("room", { id: "den", name: "Гостиная" }), up("rule", den)]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await define([up("target", { id: TV, room: "den" })]);
    await define([up("target", { id: LAMP, room: "den" })]);
    expect(await toggles(ok, cursor)).toEqual([`den ${TV} onoff.turn_off`]);
  });

  it("issues one when a device's declaration makes an action a rule names a toggle; none under re-declares-a-toggle-silently, and none on a describe that changes nothing", async () => {
    for (const m of [undefined, "re-declares-a-toggle-silently"] as const) {
      const { ok, steward } = await ruled([onMotion("cool", AC, "climate.set_mode", { mode: "off" })], { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      const redeclared = ALL.map((d) => (d.id === AC ? { ...d, actions: d.actions.map((a) => ({ ...a, toggles: true })) } : d));
      steward.onDescribe(describeOf(redeclared, 2));
      steward.onDescribe(describeOf(redeclared, 3));
      expect(await toggles(ok, cursor), String(m)).toEqual(m ? [] : [`cool ${AC} climate.set_mode`]);
    }
  });

  it("takes the toggles it finds at its first describe as told: a restart says none again", async () => {
    const own = vi.spyOn(NoticePump.prototype, "own");
    try {
      const told = () => own.mock.calls.filter((c) => c[1] === "rule_toggle").length;
      const first = await ruled([onMotion("tv", TV, "onoff.turn_off")]);
      expect(told()).toBe(1);
      first.steward.stop();
      const again = await setup({ db: first.db, clock: first.clock, devices: ALL, define: false });
      again.steward.onDescribe(describeOf(ALL, 2));
      expect(told()).toBe(1);
    } finally {
      own.mockRestore();
    }
  });
});

describe("what a rule's outcome does: a firing whose answer was lost (the milestone review, I1)", () => {
  it("asks again with the same key, and tries the lock again once the answer says failed(no_ack) (probe p02)", async () => {
    const s = await ruled([LIMIT]);
    s.applier.loseAnswers = 1000;
    await s.change(LAPTOP, "session.liza", "active");
    await s.walk(11_000);
    s.applier.loseAnswers = 0;
    await s.walk(ACK_S * 1000);
    await s.ends("rule:limit:0", LAPTOP, "failed", "no_ack");
    await s.walk(180_000);
    expect(s.firedKeys()).toContain("rule:limit:1");
  });
});

describe("what a rule's outcome does: firing records past the cap (the milestone review, I2)", () => {
  it("keeps a firing whose notice is held past 300 later firings, so its late ack still cancels the notice", async () => {
    const { change, keys, ends, lateAck, walk, ok, failures, steward } = await ruled([onMotion("pulse", PULSE, "onoff.turn_on")]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(MOTION, "motion", true);
    await keys(["rule:pulse:0"]);
    await walk(ACK_S * 1000);
    await ends("rule:pulse:0", PULSE, "failed", "no_ack");
    for (let i = 0; i < 300; i++) {
      (steward as any).keepFiring({ apply_id: `other-${i}`, applierApplyId: `applier-other-${i}`, firing: { rule: "other", n: i, steps: {} } });
    }
    await lateAck("rule:pulse:0", PULSE);
    await walk(80_000);
    expect(await failures(cursor)).toEqual([]);
  });
});

describe("what a rule's outcome does: a define before the first describe (the milestone review, M2)", () => {
  it("tells no toggle again at the first describe after a define made while nothing was described", async () => {
    const own = vi.spyOn(NoticePump.prototype, "own");
    try {
      const told = () => own.mock.calls.filter((c) => c[1] === "rule_toggle").length;
      const s = await ruled([onMotion("tv", TV, "onoff.turn_off")]);
      expect(told()).toBe(1);
      // As after a start, before the applier is described.
      const st = s.steward as any;
      st.mirror.applier = undefined;
      st.mirror.devices.clear();
      st.togglesTold = undefined;
      // A define reaching the toggles step then (its own checks aside: one that names no device).
      st.sayToggles(() => false);
      s.steward.onDescribe(describeOf(ALL, 3));
      expect(told()).toBe(1);
    } finally {
      own.mockRestore();
    }
  });
});

describe("what a rule's outcome does: a deleted rule (the milestone review, M3)", () => {
  it("forgets a deleted rule's retries, held notices, noticed marks and live state, keeping its firing numbers", async () => {
    const s = await ruled([LIMIT, onMotion("pulse", PULSE, "onoff.turn_on")]);
    await s.change(LAPTOP, "session.liza", "active");
    await s.change(MOTION, "motion", true);
    await s.keys(["rule:limit:0", "rule:pulse:0"]);
    await s.walk(ACK_S * 1000);
    await s.ends("rule:limit:0", LAPTOP, "failed", "no_ack");
    await s.ends("rule:pulse:0", PULSE, "failed", "no_ack");
    const st = s.steward as any;
    expect(st.after.pending()).toEqual({ retries: 1, held: 1 });
    await s.define([del("rule", { id: "limit" }), del("rule", { id: "pulse" })]);
    expect(st.after.pending()).toEqual({ retries: 0, held: 0 });
    expect(st.after.noticed.size).toBe(0);
    expect([...st.rules.live.keys()]).toEqual([]);
    expect(st.rules.kept.get("limit").reserved).toBeGreaterThan(0);
  });
});

describe("what a rule's outcome does: an action that keeps failing (the maintainer, 2026-10-05; the 10-minute notice)", () => {
  it("tells the owner once when an action has failed for 10 minutes, and goes on trying it quietly", async () => {
    const s = await ruled([onMotion("lock", LAPTOP, "session.lock", { account: "liza" })]);
    s.applier.planner = (a) => (a.target === LAPTOP ? { verdict: "skip", reason: "dead" } : {});
    const { cursor } = await s.ok(SECRETS.owner, "events");
    await s.change(MOTION, "motion", true);
    await s.keys(["rule:lock:0"]);
    await s.walk(9 * 60_000);
    expect(await s.failures(cursor)).toEqual([]);
    await s.walk(2 * 60_000);
    const told = await s.failures(cursor);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ rule: "lock", action: "session.lock", target: LAPTOP, outcome: "skipped", reason: "dead", still_tried: true });
    const tries = s.firedKeys().length;
    await s.walk(20 * 60_000);
    expect(await s.failures(cursor)).toHaveLength(1);
    expect(s.firedKeys().length).toBeGreaterThan(tries + 15);
  });
});

describe("what a rule's outcome does: a room not known (the maintainer, 2026-10-05; ruled Q4)", () => {
  it("notices a skipped(occupancy_unknown) once per rule and room, not each time the rule becomes true", async () => {
    const rule = { ...onMotion("lamp", LAMP, "onoff.turn_on"), actions: [{ target: LAMP, action: "onoff.turn_on", args: {}, respect_occupancy: true }] };
    const own = vi.spyOn(NoticePump.prototype, "own");
    const s = await ruled([rule]);
    await s.define([up("room", { id: "attic", name: "Чердак" }), up("target", { id: LAMP, room: "attic" })]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    for (let i = 0; i < 3; i++) {
      await s.change(MOTION, "motion", true);
      await s.settle();
      await s.change(MOTION, "motion", false);
      await s.settle();
    }
    const outcomes = (await eventsSince(s.ok, cursor, "outcome")).filter((e: Body) => e.cause?.rule === "lamp").map((e: Body) => `${e.outcome}(${e.reason})`);
    expect(outcomes).toEqual(["skipped(occupancy_unknown)", "skipped(occupancy_unknown)", "skipped(occupancy_unknown)"]);
    const told = await s.failures(cursor);
    expect(told.map((e) => `${e.rule} ${e.outcome}(${e.reason})`)).toEqual(["lamp skipped(occupancy_unknown)"]);
    // Told once, not three times folded into one waiting notice.
    expect(own.mock.calls.filter((c) => c[1] === "rule_failed")).toHaveLength(1);
    own.mockRestore();
  });
});

describe("what a rule's outcome does: coalesced only while the room stays unknown (GA-RULE-8: steward 0.11)", () => {
  const LIGHT = { id: "light", name: "Свет", conditions: LIMIT.conditions, actions: [{ target: LAMP, action: "onoff.turn_on", args: {}, respect_occupancy: true }] };
  const told = (own: { mock: { calls: unknown[][] } }) => own.mock.calls.filter((c) => c[1] === "rule_failed").length;

  it("notices a skipped(occupancy_unknown) again once the room was known in between; not under never-notices-again", async () => {
    for (const [mutation, want] of [[undefined, 2], ["never-notices-again", 1]] as const) {
      const own = vi.spyOn(NoticePump.prototype, "own");
      const s = await ruled([LIGHT], { mutation });
      await s.define([up("room", { id: "attic", name: "Чердак" }), up("target", { id: LAMP, room: "attic" }), up("target", { id: MOTION, room: "attic" })]);
      const hold = Number((await s.ok(SECRETS.owner, "describe")).home.occupancy_hold_s) * 1000;
      const again = async () => {
        await s.change(LAPTOP, "session.liza", "locked");
        await s.change(LAPTOP, "session.liza", "active");
        await s.settle();
      };
      await again();
      await again();
      expect(told(own)).toBe(1);
      // Motion: the room is occupied, known; then quiet past the hold, unknown again.
      await s.change(MOTION, "motion", true);
      await s.change(MOTION, "motion", false);
      s.clock.advance(hold + 1_000);
      await again();
      expect(told(own), String(mutation)).toBe(want);
      own.mockRestore();
    }
  });

  it("notices it again once the room was known in a gap, its sensor's events recovered (the code review, CR8)", async () => {
    const own = vi.spyOn(NoticePump.prototype, "own");
    const s = await ruled([LIGHT]);
    await s.define([up("room", { id: "attic", name: "Чердак" }), up("target", { id: LAMP, room: "attic" }), up("target", { id: MOTION, room: "attic" })]);
    const hold = Number((await s.ok(SECRETS.owner, "describe")).home.occupancy_hold_s) * 1000;
    const again = async () => {
      await s.change(LAPTOP, "session.liza", "locked");
      await s.change(LAPTOP, "session.liza", "active");
      await s.settle();
    };
    await again();
    expect(told(own)).toBe(1);
    // Motion in a gap: the applier forgets the events, and the steward recovers them from its history.
    const at = new Date(s.clock.now()).toISOString();
    s.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: true, basis_time: at, time: at, cause: "device" });
    s.applier.emitUnseen({ type: "state", target: MOTION, key: "motion", value: false, basis_time: at, time: at, cause: "device" });
    const missed = (await s.port.history({ from: new Date(0).toISOString(), to: at })).events;
    // The state after the gap: the laptop as the last change left it.
    const now = (values: Body) => ({ liveness: "live", values: Object.entries(values).map(([key, value]) => ({ key, value, basis_time: at })) });
    const state = { targets: { [LAMP]: now({ on: false }), [MOTION]: now({ motion: false }), [LAPTOP]: now({ "session.liza": "active" }) },
      transports: [], latches: [] };
    s.steward.recover(missed, state, String(missed.at(-1)!.seq));
    await s.settle();
    s.clock.advance(hold + 1_000);
    await again();
    expect(told(own)).toBe(2);
    own.mockRestore();
  });

  it("does not let a state or describe read stand for the room becoming known (a guard for the code review, CR8)", async () => {
    const own = vi.spyOn(NoticePump.prototype, "own");
    const s = await ruled([LIGHT]);
    await s.define([up("room", { id: "attic", name: "Чердак" }), up("target", { id: LAMP, room: "attic" }), up("target", { id: MOTION, room: "attic" })]);
    const again = async () => {
      await s.change(LAPTOP, "session.liza", "locked");
      await s.change(LAPTOP, "session.liza", "active");
      await s.settle();
    };
    await again();
    for (let i = 0; i < 3; i++) {
      await s.ok(SECRETS.owner, "state");
      await s.ok(SECRETS.owner, "describe");
      await again();
    }
    expect(told(own)).toBe(1);
    own.mockRestore();
  });

  it("notices a failed(not_locked) each night; coalesces the second under coalesces-a-failed-lock", async () => {
    for (const [mutation, want] of [[undefined, 2], ["coalesces-a-failed-lock", 1]] as const) {
      const own = vi.spyOn(NoticePump.prototype, "own");
      const { change, keys, ends, walk } = await ruled([LIMIT], { mutation });
      for (const n of [0, 1]) {
        await change(LAPTOP, "session.liza", "active");
        await keys(Array.from({ length: n + 1 }, (_, i) => `rule:limit:${i}`));
        await walk(1_000);
        await ends(`rule:limit:${n}`, LAPTOP, "failed", "not_locked");
        await walk(25_000);
        await change(LAPTOP, "session.liza", "locked");
      }
      expect(told(own), String(mutation)).toBe(want);
      own.mockRestore();
    }
  });
});

describe("what a rule's outcome does: held and edge rules (G3, ratified by the maintainer 2026-10-05; a departure proposed for the next steward revision)", () => {
  it("fires a held rule's idempotent action again while its reading holds, and stops once it does not", async () => {
    const held = { id: "quiet", name: "quiet", trigger: { held: { target: MOTION, key: "motion", op: "eq", value: false, for_s: 60 } },
      actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };
    const s = await ruled([held]);
    s.applier.planner = (a) => (a.target === LAPTOP ? { verdict: "skip", reason: "dead" } : {});
    await s.change(MOTION, "motion", true);
    await s.change(MOTION, "motion", false);
    await s.walk(60_000);
    await s.keys(["rule:quiet:0"]);
    await s.walk(RETRY_SPACING_MS);
    await s.keys(["rule:quiet:0", "rule:quiet:1"]);
    await s.change(MOTION, "motion", true);
    await s.walk(300_000);
    await s.keys(["rule:quiet:0", "rule:quiet:1"]);
  });
});

describe("what a rule's outcome does: edge rules (G3, ratified by the maintainer 2026-10-05; a departure proposed for the next steward revision)", () => {
  it("notices an edge rule's failed firing, coalescing one action's notices while one waits, and never fires it again", async () => {
    const edge = { id: "ring", name: "ring", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
      actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };
    const own = vi.spyOn(NoticePump.prototype, "own");
    try {
      const s = await ruled([edge]);
      s.applier.planner = (a) => (a.target === LAPTOP ? { verdict: "skip", reason: "dead" } : {});
      const { cursor } = await s.ok(SECRETS.owner, "events");
      await s.change(MOTION, "motion", true);
      await s.keys(["rule:ring:0"]);
      await s.change(MOTION, "motion", false);
      await s.change(MOTION, "motion", true);
      await s.keys(["rule:ring:0", "rule:ring:1"]);
      await s.walk(300_000);
      await s.keys(["rule:ring:0", "rule:ring:1"]);
      expect(own.mock.calls.filter((c) => c[1] === "rule_failed")).toHaveLength(2);
      const told = await s.failures(cursor);
      expect(told.map((e) => `${e.rule} ${e.outcome}(${e.reason})`)).toEqual(["ring skipped(dead)"]);
    } finally {
      own.mockRestore();
    }
  });
});

describe("what a rule's outcome does: a flapping rule's failures (the milestone review, B2; probe p03)", () => {
  it("keeps one waiting notice for a flapping rule's failing action, tried in one apply a minute", async () => {
    const flap = { id: "flap", name: "flap", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: PULSE, action: "onoff.turn_on", args: {} }] };
    const s = await ruled([flap]);
    s.applier.emitsOutcomes = false;
    const { cursor } = await s.ok(SECRETS.owner, "events");
    const N = 30;
    for (let i = 0; i < N; i++) {
      await s.change(MOTION, "motion", true);
      await s.keys(Array.from({ length: i + 1 }, (_, k) => `rule:flap:${k}`));
      await s.ends(`rule:flap:${i}`, PULSE, "failed", "invalid_request");
      await s.change(MOTION, "motion", false);
      await s.settle();
    }
    expect(await s.failures(cursor)).toHaveLength(1);
    expect((s.steward as any).notices.all().map((n: Body) => n.doc.count)).toEqual([N]);
    const notifies = () => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:")).length;
    const before = notifies();
    await s.walk(60_000);
    expect(notifies() - before).toBeLessThanOrEqual(1);
  });
});
