import { proofHolds } from "@ludentes/galatea-life-binding";
import { describe, expect, it, vi } from "vitest";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { FIRING_BLOCK } from "../src/rules/engine.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, DIMMER, eventsSince, judgeAction, LAMP, setup, TOKEN_KEY, TV, type Db } from "./setup.js";

type Body = Record<string, any>;
const MOTION = "sim-bridge:motion";
const LAPTOP = "pc-bridge:laptop";
const CHANNEL = "sim-bridge:channel";
const AC = "sim-bridge:ac";
const HOLD_MS = 7_200_000;
/** The fake applier's devices with a motion sensor, a laptop with two accounts, and an IR air conditioner. */
// Each with a bound, so no rule here is a notice for a device whose fresh_s is not known.
const ALL = [...DEVICES.map((d) => ({ ...d, fresh_s: 60 })),
  { id: MOTION, label: "motion", class: "sensor", capabilities: ["sensor"], sensor_keys: ["motion"], adopted: true, fresh_s: 60, actions: [] },
  { id: LAPTOP, label: "laptop", class: "computer", capabilities: ["session"], adopted: true, fresh_s: 60, accounts: { liza: "Лиза", dmitry: "Дмитрий" },
    actions: [{ action: "session.lock", tier: "reversible", stateless: false }] },
  { id: AC, label: "ac", class: "ac", capabilities: ["climate"], adopted: true, feedback: "open", fresh_s: null,
    actions: [{ action: "climate.set_mode", tier: "reversible" }] }];
const LIMIT = { id: "limit", name: "Лиза: лимит", conditions: [{ target: LAPTOP, key: "session.liza", not_in: ["locked", "disconnected", "none"] }],
  actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };

/** The values each device reports at the start, all live. */
const START: Record<string, Body> = { [LAMP]: { on: false }, [DIMMER]: { on: false }, [MOTION]: { motion: false },
  [LAPTOP]: { "session.liza": "locked", "session.dmitry": "locked" }, [CHANNEL]: {}, [TV]: {}, [AC]: {} };

/** A steward over the fake applier with the devices above, a rule set defined, and the applier's state read. */
async function ruled(rules: Body[], o: { mutation?: Mutation; db?: Db; clock?: FakeClock; define?: boolean; values?: Record<string, Body>;
  devices?: Body[] } = {}) {
  const clock = o.clock ?? new FakeClock();
  const at = new Date(clock.now()).toISOString();
  const values = o.values ?? START;
  const state = { targets: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, { liveness: "live",
    values: Object.entries(v).map(([key, value]) => (value && typeof value === "object" && "assumed" in value
      ? { key, value: value.value, basis_time: at, assumed: true } : { key, value, basis_time: at })) }])), transports: [], latches: [] };
  // The clock moves by days here: the periodic prune runs hourly, not every minute.
  const s = await setup({ mutation: o.mutation, db: o.db, clock, define: o.define, devices: o.devices ?? ALL, state, options: { pruneEveryMs: 3_600_000 } });
  if (o.define !== false) await s.define([up("target", { id: MOTION, room: "hall" }), ...rules.map((r) => up("rule", r))]);
  const change = async (target: string, key: string, value: unknown, cause: unknown = "device") => {
    s.applier.emit({ type: "state", target, key, value, basis_time: new Date(s.clock.now()).toISOString(), cause });
    await s.pump();
  };
  const liveness = async (target: string, old: string, now: string) => {
    s.applier.emit({ type: "liveness", target, old, new: now });
    await s.pump();
  };
  /** The applies the steward sent for rule firings, in order. */
  const fired = () => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("rule:"));
  const firedKeys = () => fired().map((a) => a.idempotency_key);
  const settle = async () => { for (let i = 0; i < 5; i++) { s.clock.advance(0); await new Promise((r) => setTimeout(r, 0)); } };
  const keys = async (want: string[]) => vi.waitFor(() => { s.clock.advance(0); expect(firedKeys()).toEqual(want); });
  return { ...s, change, liveness, fired, firedKeys, keys, settle };
}

describe("rules", () => {
  it("declares its mutations", () => {
    for (const m of ["rule-on-stale-reading", "rule-on-an-assumed-value", "authors-a-toggle", "rules-a-wake-relay", "window-on-the-end-day",
      "not-in-skips-unknown", "fires-on-a-retired-token", "conditions-fire-once", "fires-in-an-exception"]) expect(MUTATIONS).toContain(m);
  });

  it("fires a rule of conditions only when they become true, once, and again each time after being false, as one apply keyed rule:<id>:<n> (GA-RULE-5, GA-STW-10, GA-AUTH-5)", async () => {
    const { change, keys, fired, settle, ok } = await ruled([LIMIT]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await settle();
    await keys([]);
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    expect(fired()[0]).toEqual({ idempotency_key: "rule:limit:0", request: { actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" },
      via: "rule", brain: false, for: { rule: "limit" } }] } });
    await change(LAPTOP, "session.liza", "idle");
    await settle();
    await keys(["rule:limit:0"]);
    await change(LAPTOP, "session.liza", "locked");
    await change(LAPTOP, "session.liza", "unknown");
    await keys(["rule:limit:0", "rule:limit:1"]);
    const events = await eventsSince(ok, cursor, "rule_fired");
    expect(events.map((e: Body) => [e.rule, e.firing, e.cause])).toEqual([["limit", 0, { rule: "limit" }], ["limit", 1, { rule: "limit" }]]);
  });

  it("fires once and never again while it stays true under conditions-fire-once", async () => {
    const { change, keys, settle } = await ruled([LIMIT], { mutation: "conditions-fire-once" });
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    await change(LAPTOP, "session.liza", "locked");
    await change(LAPTOP, "session.liza", "unknown");
    await settle();
    await keys(["rule:limit:0"]);
  });

  it("fires on entering its window and not before, leaving it being false; a window held at the start fires at once (GA-RULE-3)", async () => {
    // The clock starts at 2030-01-01 11:00 in Moscow, a Tuesday.
    const window = { ...LIMIT, conditions: [{ between: { from: "11:30", until: "12:00", days: [2, 3] } }, ...LIMIT.conditions] };
    const { clock, keys, settle } = await ruled([window], { values: { ...START, [LAPTOP]: { "session.liza": "active" } } });
    clock.advance(29 * 60_000);
    await settle();
    await keys([]);
    clock.advance(60_000);
    await keys(["rule:limit:0"]);
    clock.advance(24 * 3_600_000);
    await keys(["rule:limit:0", "rule:limit:1"]);
    clock.advance(24 * 3_600_000);
    await settle();
    await keys(["rule:limit:0", "rule:limit:1"]);
  });

  it("fires a time trigger at its minute on its days while its conditions hold", async () => {
    // 11:30 in Moscow on Tuesdays only; the clock starts on Tuesday at 11:00.
    const morning = { id: "morning", name: "Утро", trigger: { time: { at: "11:30", days: [2] } },
      conditions: [{ target: DIMMER, key: "on", op: "eq", value: false }], actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] };
    const { clock, keys, settle } = await ruled([morning]);
    clock.advance(29 * 60_000);
    await settle();
    await keys([]);
    clock.advance(60_000);
    await keys(["rule:morning:0"]);
    clock.advance(6 * 24 * 3_600_000);
    await settle();
    await keys(["rule:morning:0"]);
    clock.advance(24 * 3_600_000);
    await keys(["rule:morning:0", "rule:morning:1"]);
  });

  it("fires a held trigger once held for its duration while live, starting afresh after its device was not live (GA-RULE-2)", async () => {
    const night = { id: "night", name: "Ночник гаснет", trigger: { held: { target: MOTION, key: "motion", op: "eq", value: false, for_s: 180 } },
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const { clock, change, liveness, keys, settle } = await ruled([night]);
    clock.advance(179_000);
    await settle();
    await keys([]);
    clock.advance(1_000);
    await keys(["rule:night:0"]);
    await change(MOTION, "motion", true);
    await change(MOTION, "motion", false);
    clock.advance(100_000);
    await liveness(MOTION, "live", "stale");
    clock.advance(200_000);
    await settle();
    await keys(["rule:night:0"]);
    await liveness(MOTION, "stale", "live");
    clock.advance(179_000);
    await settle();
    await keys(["rule:night:0"]);
    clock.advance(1_000);
    await keys(["rule:night:0", "rule:night:1"]);
  });

  it("never fires on a device that is not live, nor on an assumed value; does under their mutations (GA-RULE-2)", async () => {
    const cool = { id: "cool", name: "Кондиционер", conditions: [{ target: AC, key: "mode", op: "eq", value: "cool" }],
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] };
    const values = { ...START, [AC]: { mode: { value: "cool", assumed: true } } };
    const a = await ruled([cool, LIMIT], { values });
    await a.liveness(LAPTOP, "live", "stale");
    await a.change(LAPTOP, "session.liza", "active");
    await a.settle();
    await a.keys([]);
    const b = await ruled([cool], { values, mutation: "rule-on-an-assumed-value" });
    await b.keys(["rule:cool:0"]);
    const c = await ruled([LIMIT], { mutation: "rule-on-stale-reading" });
    await c.liveness(LAPTOP, "live", "stale");
    await c.change(LAPTOP, "session.liza", "active");
    await c.keys(["rule:limit:0"]);
  });

  it("reads a retired account's key false, so the limit stops; fires on it under fires-on-a-retired-token (GA-RULE-4)", async () => {
    const retired = ALL.map((d) => (d.id === LAPTOP ? { ...d, accounts: { dmitry: "Дмитрий" } } : d));
    const values = { ...START, [LAPTOP]: { "session.liza": "active" } };
    const a = await ruled([LIMIT], { devices: retired, values });
    await a.settle();
    await a.keys([]);
    const b = await ruled([LIMIT], { devices: retired, values, mutation: "fires-on-a-retired-token" });
    await b.keys(["rule:limit:0"]);
  });

  it("fires an edge trigger on a change into it while its conditions hold, never on a state read again; loses one inside an exception", async () => {
    const at = (ms: number) => new Date(Date.parse("2030-01-01T08:00:00Z") + ms).toISOString();
    const on = { id: "on", name: "Свет по движению", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
      conditions: [{ target: DIMMER, key: "on", op: "eq", value: false }], actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }],
      exceptions: [{ from: at(600_000), until: at(1_200_000) }] };
    const { change, keys, clock, settle, steward } = await ruled([on]);
    await change(MOTION, "motion", true);
    await keys(["rule:on:0"]);
    steward.onState({ targets: { [MOTION]: { liveness: "live", values: [{ key: "motion", value: true }] },
      [DIMMER]: { liveness: "live", values: [{ key: "on", value: false }] } }, transports: [], latches: [] });
    await change(MOTION, "motion", false);
    await change(DIMMER, "on", true);
    await change(MOTION, "motion", true);
    await settle();
    await keys(["rule:on:0"]);
    await change(DIMMER, "on", false);
    await change(MOTION, "motion", false);
    clock.advance(600_000);
    await change(MOTION, "motion", true);
    await settle();
    await keys(["rule:on:0"]);
    clock.advance(600_000);
    await settle();
    await keys(["rule:on:0"]);
  });

  it("never fires a level rule inside an exception, fires it when the exception ends if it holds, and inside under fires-in-an-exception (GA-RULE-6)", async () => {
    const at = (ms: number) => new Date(Date.parse("2030-01-01T08:00:00Z") + ms).toISOString();
    const granted = { ...LIMIT, exceptions: [{ from: at(0), until: at(1_800_000) }] };
    const a = await ruled([granted]);
    await a.change(LAPTOP, "session.liza", "active");
    a.clock.advance(1_799_000);
    await a.settle();
    await a.keys([]);
    a.clock.advance(1_000);
    await a.keys(["rule:limit:0"]);
    const b = await ruled([granted], { mutation: "fires-in-an-exception" });
    await b.change(LAPTOP, "session.liza", "active");
    await b.keys(["rule:limit:0"]);
  });

  it("is refused at rule precedence by a person's lease, saying so, and fires again when the lease ends; an edge rule does not (GA-LEASE-1, GA-LEASE-3, GA-LEASE-4)", async () => {
    const off = { id: "off", name: "Гасить свет", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const edge = { id: "edge", name: "Гасить по движению", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const { ok, change, keys, clock, settle } = await ruled([off, edge]);
    await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(MOTION, "motion", true);
    await settle();
    await keys([]);
    await vi.waitFor(async () => {
      const refused = await eventsSince(ok, cursor, "refused");
      expect(refused.map((e: Body) => [e.rule, e.target, e.reason, e.holder]).sort()).toEqual([
        ["edge", LAMP, "leased", { person: "olga", endpoint: "olga-app" }], ["off", LAMP, "leased", { person: "olga", endpoint: "olga-app" }]]);
    });
    const outcomes = (await eventsSince(ok, cursor, "outcome")).filter((e: Body) => e.cause?.rule);
    expect(outcomes.map((e: Body) => `${e.cause.rule} ${e.outcome}(${e.reason})`).sort()).toEqual(["edge refused(leased)", "off refused(leased)"]);
    clock.advance(HOLD_MS);
    await keys(["rule:off:1"]);
  });

  it("takes no lease with a rule's action (GA-LEASE-5), and its session.lock is refused by no lease and replaces none (GA-LEASE-3)", async () => {
    const off = { id: "off", name: "Гасить свет", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const { ok, change, keys } = await ruled([off, LIMIT]);
    await change(LAPTOP, "session.dmitry", "active", "external");
    expect(Object.keys((await ok(SECRETS.owner, "state")).leases)).toEqual([LAPTOP]);
    await change(MOTION, "motion", true);
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:off:0", "rule:limit:0"]);
    expect((await ok(SECRETS.owner, "state")).leases).toEqual({ [LAPTOP]: expect.objectContaining({ holder: "external", precedence: "person" }) });
  });

  it("sends a confirm step with an authored token for the rule, skips a toggle and an unknown room, and sends the toggle under authors-a-toggle (GA-SCN-4, GA-CONF-3)", async () => {
    const both = { id: "both", name: "Всё сразу", conditions: LIMIT.conditions,
      actions: [{ target: DIMMER, action: "onoff.turn_on", args: {} }, { target: TV, action: "onoff.turn_off", args: {} },
        { target: LAMP, action: "onoff.turn_on", args: {}, respect_occupancy: true }] };
    const a = await ruled([both]);
    const { cursor } = await a.ok(SECRETS.owner, "events");
    const at = a.clock.now();
    await a.change(LAPTOP, "session.liza", "active");
    await a.keys(["rule:both:0"]);
    const [step] = a.fired()[0].request.actions as Body[];
    expect(a.fired()[0].request.actions).toHaveLength(1);
    expect({ ...step, token: undefined }).toEqual({ target: DIMMER, action: "onoff.turn_on", args: {}, via: "rule", brain: false, for: { rule: "both" }, token: undefined });
    expect(proofHolds(step.token, TOKEN_KEY)).toBe(true);
    expect(step.token).toMatchObject({ issuer: "steward", for: { rule: "both" }, via: "rule", brain: false, expires: new Date(at + 60_000).toISOString() });
    await vi.waitFor(async () => expect((await eventsSince(a.ok, cursor, "outcome")).filter((e: Body) => e.cause?.rule)
      .map((e: Body) => `${e.target} ${e.outcome}${e.reason ? `(${e.reason})` : ""}`).sort())
      .toEqual([`${DIMMER} dispatched`, `${LAMP} skipped(occupancy_unknown)`, `${TV} skipped(toggle_only)`].sort()));
    const b = await ruled([both], { mutation: "authors-a-toggle" });
    await b.change(LAPTOP, "session.liza", "active");
    await b.keys(["rule:both:0"]);
    expect((b.fired()[0].request.actions as Body[]).map((x) => `${x.target} ${x.token ? "token" : "none"}`)).toEqual([`${DIMMER} token`, `${TV} token`]);
  });

  it("judges a rule's confirm step as answered, so a lease still refuses it and an occupied room still skips it (GA-SCN-4, GA-STW-4)", async () => {
    const confirm = { id: "confirm", name: "Подтверждено", conditions: LIMIT.conditions,
      actions: [{ target: DIMMER, action: "onoff.turn_on", args: {} }, { target: LAMP, action: "onoff.turn_on", args: {}, respect_occupancy: true }] };
    const { ok, change, settle, keys, clock } = await ruled([confirm]);
    clock.advance(301_000);
    await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: DIMMER, action: "level.set_level", args: { level: 5 } }] },
      idempotency_key: "k-1" });
    await change(MOTION, "motion", true);
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(LAPTOP, "session.liza", "active");
    await settle();
    await keys([]);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "outcome")).filter((e: Body) => e.cause?.rule)
      .map((e: Body) => `${e.target} ${e.outcome}(${e.reason})`).sort()).toEqual([`${DIMMER} refused(leased)`, `${LAMP} skipped(occupied)`]));
  });

  it("sends a rule's notify with its own from, a caller's overwritten (GA-NOTE-2)", async () => {
    const say = { id: "say", name: "Сказать", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: CHANNEL, action: "notify.notify", args: { text: "Движение", urgency: "info", from: { endpoint: "olga-app", role: "owner" } } }] };
    const { change, keys, fired } = await ruled([say]);
    await change(MOTION, "motion", true);
    await keys(["rule:say:0"]);
    expect((fired()[0].request.actions as Body[])[0].args).toEqual({ text: "Движение", urgency: "info", from: { rule: "say" } });
  });

  it("keeps a rule's fired state and its firing numbers across a restart: one that fired does not fire again, and keys never repeat (GA-RULE-1, GA-STW-10)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await ruled([LIMIT], { db, clock });
    await a.change(LAPTOP, "session.liza", "active");
    await a.keys(["rule:limit:0"]);
    a.steward.stop();
    await a.store.close();
    const b = await ruled([], { db, clock, define: false, values: { ...START, [LAPTOP]: { "session.liza": "active" } } });
    await b.settle();
    await b.keys([]);
    await b.change(LAPTOP, "session.liza", "locked");
    await b.change(LAPTOP, "session.liza", "active");
    await b.keys([`rule:limit:${FIRING_BLOCK}`]);
    // A stop that was not clean skips a block: one reserved and never written is not used twice.
    await b.store.settled();
    b.steward.stop();
    const c = await ruled([], { db, clock, define: false });
    await c.change(LAPTOP, "session.liza", "active");
    await c.keys([`rule:limit:${3 * FIRING_BLOCK}`]);
  });

  it("fires once at start a rule that holds and had not fired, as after a gap (GA-RULE-1)", async () => {
    const { keys } = await ruled([LIMIT], { values: { ...START, [LAPTOP]: { "session.liza": "active" } } });
    await keys(["rule:limit:0"]);
  });

  it("fires while the store is down, its state written once the store returns (ruled, Q6)", async () => {
    const { change, keys, db, store, clock, steward } = await ruled([LIMIT]);
    await store.settled();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await change(LAPTOP, "session.liza", "active");
    await keys(["rule:limit:0"]);
    expect(steward.ruleFired("limit")).toBe(true);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.down).toBe(false); });
    await store.settled();
    expect((await store.query("SELECT rule_id, fired, reserved FROM rule_states")).rows).toEqual([{ rule_id: "limit", fired: true, reserved: FIRING_BLOCK }]);
    expect(Number((await store.query<{ fired_at: string }>("SELECT fired_at FROM rule_states")).rows[0]!.fired_at)).toBeGreaterThan(0);
  });

  it("keeps session.lock steps of different accounts on one computer apart, and refuses one account's two locks a conflict (GA-STW-2)", async () => {
    const { ok } = await ruled([]);
    const plan = await ok(SECRETS.owner, "plan", { endpoint: "owner-app", actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } },
      { target: LAPTOP, action: "session.lock", args: { account: "dmitry" } }] });
    expect(plan.steps.map((x: Body) => `${x.args.account} ${x.verdict}`)).toEqual(["liza op", "dmitry op"]);
    const twice = await ok(SECRETS.owner, "plan", { endpoint: "owner-app", actions: [{ target: LAMP, action: "level.set_level", args: { level: 1 } },
      { target: LAMP, action: "level.set_level", args: { level: 2 } }] });
    expect(twice.steps.map((x: Body) => `${x.verdict}(${x.reason})`)).toEqual(["refuse(conflict)", "refuse(conflict)"]);
  });
});

describe("rules at define (GA-RULE-2)", () => {
  it("raises a notice naming the rule and each device it reads whose fresh_s is not known, and none for one with a bound", async () => {
    const { ok, steward, define, clock } = await setup();
    steward.onDescribe(describeOf(DEVICES.map((d) => (d.id === DIMMER ? { ...d, fresh_s: 60, fresh_basis: "declared" } : d)), 2));
    const { cursor } = await ok(SECRETS.owner, "events");
    await define([up("rule", { id: "night", name: "Ночник", trigger: { state: { target: DIMMER, key: "on", op: "eq", value: true } },
      conditions: [{ target: LAMP, key: "on", op: "eq", value: false }], actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] })]);
    // A liveness trigger reads no value: none for the channel it watches.
    await define([up("rule", { id: "gone", name: "Канал пропал", trigger: { event: { target: "sim-bridge:channel", type: "liveness", new: "dead" } },
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] })]);
    await vi.waitFor(async () => {
      clock.advance(0);
      const raised = (await eventsSince(ok, cursor, "notice")).filter((e: Body) => e.change === "raised");
      expect(raised.map((e: Body) => [e.cause, e.text])).toEqual([["rule_unbounded",
        `rule night reads ${LAMP}, whose fresh_s is not known: the rule can never hold on it until a bound is set (GA-RULE-2)`]]);
    });
  });
});

describe("rules: a level rule becoming true while its firing is in flight (the milestone review, B1)", () => {
  it("fires again once the firing in flight is over, when the rule went false and true meanwhile (GA-RULE-1, GA-RULE-5)", async () => {
    const s = await ruled([LIMIT]);
    let open!: () => void;
    s.applier.answerGate = new Promise<void>((r) => { open = r; });
    await s.change(LAPTOP, "session.liza", "active");
    await s.keys(["rule:limit:0"]);
    await s.change(LAPTOP, "session.liza", "locked");
    await s.change(LAPTOP, "session.liza", "unknown");
    s.applier.answerGate = undefined;
    open();
    await s.keys(["rule:limit:0", "rule:limit:1"]);
    expect(s.steward.ruleFired("limit")).toBe(true);
  });

  it("fires no more when the rule went false again before the firing in flight was over", async () => {
    const s = await ruled([LIMIT]);
    let open!: () => void;
    s.applier.answerGate = new Promise<void>((r) => { open = r; });
    await s.change(LAPTOP, "session.liza", "active");
    await s.keys(["rule:limit:0"]);
    await s.change(LAPTOP, "session.liza", "locked");
    await s.change(LAPTOP, "session.liza", "unknown");
    await s.change(LAPTOP, "session.liza", "locked");
    s.applier.answerGate = undefined;
    open();
    for (let i = 0; i < 4; i++) await s.settle();
    expect(s.firedKeys()).toEqual(["rule:limit:0"]);
  });
});

describe("rules: a person's step that sent nothing (the milestone review, B6)", () => {
  const OFF = { id: "off", name: "off", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
  it("does not fire a level rule again when a person's step on its device ends skipped(already) and no lease stood (GA-RULE-1, GA-RULE-5)", async () => {
    const s = await ruled([OFF]);
    await s.change(MOTION, "motion", true);
    await s.keys(["rule:off:0"]);
    s.applier.planner = (a) => (a.target === LAMP && a.action === "onoff.turn_on" ? { verdict: "skip", reason: "already", tier: "confirm" } : judgeAction(a));
    await s.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    for (let i = 0; i < 5; i++) await s.settle();
    expect(s.firedKeys()).toEqual(["rule:off:0"]);
  });
});

describe("rules: a lease that ended while the steward was down (the milestone review, B3)", () => {
  it("fires at start a level rule whose refusing lease ended while the steward was down (GA-LEASE-4, GA-PERSIST-2)", async () => {
    const OFF = { id: "off", name: "off", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await ruled([OFF], { db, clock });
    await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    await a.change(MOTION, "motion", true);
    await a.settle();
    expect(a.firedKeys()).toEqual([]);
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(HOLD_MS + 1_000);
    const b = await ruled([], { db, clock, define: false, values: { ...START, [LAMP]: { on: true }, [MOTION]: { motion: true } } });
    // One firing at start (its number past a block skipped, the stop here not being clean).
    await vi.waitFor(() => { b.clock.advance(0); expect(b.firedKeys()).toHaveLength(1); });
    expect(Object.keys((await b.ok(SECRETS.owner, "state")).leases)).toEqual([]);
  });
});

describe("rules: a return to life, or a restart, is no change (the milestone review, M1; G4)", () => {
  const night = { id: "night", name: "Ночник гаснет", trigger: { held: { target: MOTION, key: "motion", op: "eq", value: false, for_s: 180 } },
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
  it("does not fire a held rule that fired again after its device was not live for a while and returned reading the same", async () => {
    const { clock, liveness, keys, settle } = await ruled([night]);
    clock.advance(180_000);
    await keys(["rule:night:0"]);
    await liveness(MOTION, "live", "stale");
    clock.advance(60_000);
    await liveness(MOTION, "stale", "live");
    clock.advance(400_000);
    await settle();
    await keys(["rule:night:0"]);
  });

  it("does not fire a held rule that fired again after a restart, its duration started afresh", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await ruled([night], { db, clock });
    clock.advance(180_000);
    await a.keys(["rule:night:0"]);
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(10_000);
    const b = await ruled([], { db, clock, define: false });
    clock.advance(400_000);
    for (let i = 0; i < 4; i++) await b.settle();
    expect(b.firedKeys()).toEqual([]);
    expect(b.steward.ruleFired("night")).toBe(true);
  });

  it("does not fire an edge rule when its device returns to life reading what it read before; does when it returns changed", async () => {
    const on = { id: "on", name: "Свет по движению", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] };
    const { change, liveness, keys, settle } = await ruled([on]);
    await change(MOTION, "motion", true);
    await keys(["rule:on:0"]);
    await liveness(MOTION, "live", "stale");
    await liveness(MOTION, "stale", "live");
    await settle();
    await keys(["rule:on:0"]);
    await change(MOTION, "motion", false);
    await liveness(MOTION, "live", "dead");
    await change(MOTION, "motion", true);
    await liveness(MOTION, "dead", "live");
    await keys(["rule:on:0", "rule:on:1"]);
  });
});

describe("rules: a time trigger whose timer runs late (the milestone review, M6)", () => {
  it("fires at its minute when an event's look comes between the minute and the late timer", async () => {
    /** A clock whose timers run half a second late, as a busy process's may. */
    class LateClock extends FakeClock {
      override setTimeout(fn: () => void, ms: number): number { return super.setTimeout(fn, ms + 500); }
    }
    const morning = { id: "morning", name: "Утро", trigger: { time: { at: "11:30", days: [2] } },
      conditions: [{ target: DIMMER, key: "on", op: "eq", value: false }], actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] };
    const clock = new LateClock();
    const { change, keys, settle } = await ruled([morning], { clock });
    clock.advance(30 * 60_000 + 200);
    await change(DIMMER, "on", false);
    clock.advance(1_000);
    await settle();
    await keys(["rule:morning:0"]);
  });
});

describe("rules: firing numbers while the store is away (the milestone review, M5)", () => {
  it("fires no number more than one block past the reservation the store holds, and goes on once the store takes it (GA-STW-10, Q6)", async () => {
    const clock = new FakeClock();
    let land!: () => void;
    const landed = new Promise<void>((r) => { land = r; });
    const store = { query: async () => ({ rows: [] }), write: async (fn: (tx: unknown) => Promise<void>) => { await landed; await fn({ query: async () => ({ rows: [] }) }); } };
    let on = false;
    const view = () => ({ now: clock.now(), tz: "Europe/Moscow", device: () => ({ live: true, value: () => ({ value: on, assumed: false }), retired: () => false }) });
    const rule = { id: "flap", name: "flap", conditions: [{ target: MOTION, key: "motion", op: "eq" as const, value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }], active: true, exceptions: [] };
    const fired: number[] = [];
    const { RuleEngine } = await import("../src/rules/engine.js");
    const engine = new RuleEngine({ clock, store: store as never, logger: () => undefined, rules: () => [rule], view, ready: () => true, names: () => [],
      clean: () => true, fire: async (_r, n) => { fired.push(n); } });
    await engine.load();
    for (let i = 0; i < FIRING_BLOCK + 200; i++) {
      on = true;
      engine.onEvent({ type: "state", target: MOTION });
      await Promise.resolve();
      on = false;
      engine.onEvent({ type: "state", target: MOTION });
      await Promise.resolve();
    }
    expect(fired.length).toBe(FIRING_BLOCK);
    expect(fired.at(-1)).toBe(FIRING_BLOCK - 1);
    on = true;
    engine.onEvent({ type: "state", target: MOTION });
    land();
    await vi.waitFor(() => expect(fired.length).toBe(FIRING_BLOCK + 1));
    expect(fired.at(-1)).toBe(FIRING_BLOCK);
  });
});

describe("rules: a window or an exception that ended while the steward was down (the milestone review, B7)", () => {
  it("fires the limit at start when its exception ended while the steward was down and the session is still open (GA-RULE-6)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await ruled([LIMIT], { db, clock });
    await a.change(LAPTOP, "session.liza", "active");
    await a.keys(["rule:limit:0"]);
    const from = new Date(clock.now()).toISOString();
    const until = new Date(clock.now() + 30 * 60_000).toISOString();
    await a.define([up("rule_exception", { rule: "limit", from, until })]);
    await a.settle();
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(40 * 60_000);
    const b = await ruled([], { db, clock, define: false, values: { ...START, [LAPTOP]: { "session.liza": "active", "session.dmitry": "locked" } } });
    await vi.waitFor(() => { b.clock.advance(0); expect(b.firedKeys()).toHaveLength(1); });
  });

  it("fires a window rule at start when its window ended and began again while the steward was down (GA-RULE-1, GA-RULE-3)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const W = { ...LIMIT, conditions: [{ between: { from: "11:00", until: "12:00" } }] };
    const values = { ...START, [LAPTOP]: { "session.liza": "active", "session.dmitry": "locked" } };
    const a = await ruled([W], { db, clock, values });
    await a.keys(["rule:limit:0"]);
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(24 * 3_600_000 + 10 * 60_000);
    const b = await ruled([], { db, clock, define: false, values });
    await vi.waitFor(() => { b.clock.advance(0); expect(b.firedKeys()).toHaveLength(1); });
  });

  it("does not fire at start a window rule that fired inside the window it is still in", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const W = { ...LIMIT, conditions: [{ between: { from: "11:00", until: "12:00" } }] };
    const values = { ...START, [LAPTOP]: { "session.liza": "active", "session.dmitry": "locked" } };
    const a = await ruled([W], { db, clock, values });
    await a.keys(["rule:limit:0"]);
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    clock.advance(20 * 60_000);
    const b = await ruled([], { db, clock, define: false, values });
    for (let i = 0; i < 4; i++) await b.settle();
    expect(b.firedKeys()).toEqual([]);
  });
});

describe("rules: a lease's end on a selector's match (the milestone review, M8)", () => {
  it("fires again a level rule acting through a selector when a person's lease on one of its matches ends (GA-LEASE-4)", async () => {
    const off = { id: "off", name: "Гасить в холле", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ selector: { room: "hall", capability: "onoff" }, action: "onoff.turn_off", args: {} }] };
    const { ok, change, keys, clock, settle } = await ruled([off]);
    await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    await change(MOTION, "motion", true);
    await settle();
    await keys(["rule:off:0"]);
    clock.advance(HOLD_MS);
    await keys(["rule:off:0", "rule:off:1"]);
  });
});

describe("rules: a firing whose plan on the applier fails (the milestone review, B4)", () => {
  const OFF = { id: "off", name: "off", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
  it("never sends a rule's action to a device a person leased: the step fails closed, unreachable (GA-LEASE-3)", async () => {
    const s = await ruled([OFF]);
    await s.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    await s.settle();
    s.applier.failNext.set("plan", new Error("the plan call timed out"));
    await s.change(MOTION, "motion", true);
    for (let i = 0; i < 5; i++) await s.settle();
    expect(s.fired().flatMap((a) => (a.request.actions as Body[]).map((x) => `${x.target} ${x.action}`))).toEqual([]);
  });

  it("never sends a respect_occupancy rule action into an occupied room when the plan fails (GA-OCC-1)", async () => {
    const OCC = { ...OFF, id: "occ", actions: [{ target: LAMP, action: "onoff.turn_off", args: {}, respect_occupancy: true }] };
    const s = await ruled([OCC]);
    s.applier.failNext.set("plan", new Error("the plan call timed out"));
    await s.change(MOTION, "motion", true);
    for (let i = 0; i < 5; i++) await s.settle();
    expect(s.fired().flatMap((a) => (a.request.actions as Body[]).map((x) => `${x.target} ${x.action}`))).toEqual([]);
  });

  it("never sends a step the applier skipped at plan past a person's lease: it ends with the applier's earlier reason, as the order puts it (GA-STW-4)", async () => {
    const s = await ruled([OFF]);
    await s.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }, idempotency_key: "k-1" });
    for (const reason of ["latched", "already"]) {
      s.applier.planner = (a) => (a.target === LAMP && a.action === "onoff.turn_off" ? { verdict: "skip", reason } : judgeAction(a));
      const { cursor } = await s.ok(SECRETS.owner, "events");
      await s.change(MOTION, "motion", true);
      await vi.waitFor(async () => expect((await eventsSince(s.ok, cursor, "outcome")).filter((e: Body) => e.cause?.rule === "off")
        .map((e: Body) => `${e.target} ${e.outcome}(${e.reason})`)).toEqual([`${LAMP} skipped(${reason})`]));
      expect(s.fired()).toEqual([]);
      await s.change(MOTION, "motion", false);
      await s.settle();
    }
  });
});

describe("rules: a confirm step the applier plans skip(already) (the milestone 5+6 review, M8)", () => {
  it("settles it as the steward's own skipped(already): nothing sent, no round trip, and the firing landed", async () => {
    const both = { id: "both", name: "Оба", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: DIMMER, action: "onoff.turn_on", args: {} }] };
    const s = await ruled([both]);
    s.applier.planner = (a) => (a.target === DIMMER && a.action === "onoff.turn_on" ? { verdict: "skip", reason: "already", tier: "confirm" } : judgeAction(a));
    const { cursor } = await s.ok(SECRETS.owner, "events");
    await s.change(MOTION, "motion", true);
    await vi.waitFor(async () => expect((await eventsSince(s.ok, cursor, "outcome")).map((e: Body) => `${e.target} ${e.outcome}(${e.reason})`))
      .toEqual([`${DIMMER} skipped(already)`]));
    await s.settle();
    expect(s.fired()).toEqual([]);
    expect(await eventsSince(s.ok, cursor, "notice")).toEqual([]);
  });
});

describe("rules: a device marked internal after a rule named it (the milestone review, M10)", () => {
  it("refuses the rule's step on it, role, and sends nothing: authored work never reaches an internal device (GA-DEF-10)", async () => {
    const off = { id: "off", name: "Гасить", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] };
    const { ok, change, settle, steward, fired } = await ruled([off]);
    steward.onDescribe(describeOf(ALL.map((d) => (d.id === LAMP ? { ...d, internal: true } : d)), 2));
    const { cursor } = await ok(SECRETS.owner, "events");
    await change(MOTION, "motion", true);
    await vi.waitFor(async () => {
      const refused = await eventsSince(ok, cursor, "refused");
      expect(refused.map((e: Body) => `${e.rule} ${e.target} ${e.reason}`)).toEqual([`off ${LAMP} role`]);
    });
    await settle();
    expect(fired().flatMap((a) => (a.request.actions as Body[]).map((x) => x.target))).toEqual([]);
  });
});

describe("rules: a retry pending across a restart (the milestone review, I3, ruled Q6)", () => {
  it("records a pending retry, and fires the rule again at the next start while its conditions hold (GA-RULE-7)", async () => {
    const devices = ALL.map((d) => (d.id === LAPTOP ? { ...d, actions: [{ action: "session.lock", tier: "reversible", stateless: false, idempotent: true, ack_within_s: 12 }] } : d));
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await ruled([LIMIT], { db, clock, devices });
    await a.change(LAPTOP, "session.liza", "active");
    await a.keys(["rule:limit:0"]);
    const id = `applier-apply-${[...new Set(a.applier.applies.map((x) => x.idempotency_key))].indexOf("rule:limit:0") + 1}`;
    a.applier.emit({ type: "outcome", apply_id: id, step_id: "s1", target: LAPTOP, outcome: "failed", reason: "no_ack" });
    await a.pump();
    await a.settle();
    await a.store.settled();
    expect((await a.store.query("SELECT rule_id, kind FROM rule_pending")).rows).toEqual([{ rule_id: "limit", kind: "retry" }]);
    a.steward.stop();
    await a.store.close();
    const values = { ...START, [LAPTOP]: { "session.liza": "active", "session.dmitry": "locked" } };
    const b = await ruled([], { db, clock, define: false, values, devices });
    await vi.waitFor(() => { b.clock.advance(0); expect(b.firedKeys()).toHaveLength(1); });
    await b.store.settled();
    // The retry's row is gone; the firing that started is in flight, kept until its step ends (slice 11).
    expect((await b.store.query("SELECT rule_id, kind FROM rule_pending")).rows).toEqual([{ rule_id: "limit", kind: "sent" }]);
  });
});
