import { describe, expect, it, vi } from "vitest";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { LATE_ACK_SLACK_MS, LATE_ACK_WINDOW_MS } from "../src/rules/outcomes.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { del, SECRETS, up } from "./house.js";
import { DEVICES, eventsSince, quiet, setup, type Db } from "./setup.js";

type Body = Record<string, any>;
const MOTION = "sim-bridge:motion";
const LAPTOP = "pc-bridge:laptop";
const PULSE = "sim-bridge:pulse";
const ACK_S = 12;
/** A pulse relay whose `turn_on` is not idempotent, a laptop whose lock is, each acked within 12 s; a motion sensor. */
const ALL = [...DEVICES.map((d) => ({ ...d, fresh_s: 60 })),
  { id: MOTION, label: "motion", class: "sensor", capabilities: ["sensor"], sensor_keys: ["motion"], adopted: true, fresh_s: 60, actions: [] },
  { id: LAPTOP, label: "laptop", class: "computer", capabilities: ["session"], adopted: true, fresh_s: 60, accounts: { liza: "Лиза" },
    actions: [{ action: "session.lock", tier: "reversible", stateless: false, idempotent: true, ack_within_s: ACK_S }] },
  { id: PULSE, label: "pulse", class: "socket", capabilities: ["onoff"], adopted: true, fresh_s: 60,
    actions: [{ action: "onoff.turn_on", tier: "reversible", idempotent: false, ack_within_s: ACK_S }] }];
const PULSE_RULE = { id: "pulse", name: "pulse", conditions: [{ target: MOTION, key: "motion", op: "eq", value: true }],
  actions: [{ target: PULSE, action: "onoff.turn_on", args: {} }] };
const LIMIT = { id: "limit", name: "Лиза: лимит", conditions: [{ target: LAPTOP, key: "session.liza", not_in: ["locked", "disconnected", "none"] }],
  actions: [{ target: LAPTOP, action: "session.lock", args: { account: "liza" } }] };
/** The window a `failed(no_ack)`'s notice waits, from that outcome: 60 s and the slack. */
const NO_ACK_WAIT = LATE_ACK_WINDOW_MS + LATE_ACK_SLACK_MS;

/** The applier's state with every device live: the motion sensor reading `motion`, Лиза's session `session`. */
function stateOf(at: number, motion: boolean, session = "locked"): Body {
  const values: Record<string, Body> = { [MOTION]: { motion }, [LAPTOP]: { "session.liza": session }, [PULSE]: { on: false }, "sim-bridge:channel": {} };
  return { targets: Object.fromEntries(Object.entries(values).map(([id, v]) => [id, { liveness: "live",
    values: Object.entries(v).map(([key, value]) => ({ key, value, basis_time: new Date(at).toISOString() })) }])), transports: [], latches: [] };
}

/**
 * A steward over the fake applier, with these devices and rules, on `db`; `restart` stops it and starts
 * another on the same store and applier, its follower from the applier's latest event, the gap read
 * first as a restart's link reads it (`recover`), unless `sync` is false.
 */
async function life(o: { db: Db; clock: FakeClock; rules?: Body[]; mutation?: Mutation; motion?: boolean; session?: string;
  applier?: Awaited<ReturnType<typeof setup>>["applier"]; recover?: boolean }) {
  const restarted = o.applier !== undefined;
  const state = stateOf(o.clock.now(), o.motion ?? false, o.session);
  const s = await setup({ db: o.db, clock: o.clock, mutation: o.mutation, devices: ALL, state, define: !restarted, sync: !(restarted && o.recover !== false),
    ...(o.applier ? { applier: o.applier, fromNow: true } : {}), options: { pruneEveryMs: 3_600_000 } });
  if (!restarted) await s.define((o.rules ?? []).map((r) => up("rule", r)));
  /** This life's first cursor: what it raises is read from here. */
  const begun = String((await s.ok(SECRETS.owner, "events")).cursor);
  const settle = async () => { for (let i = 0; i < 5; i++) { s.clock.advance(0); await new Promise((r) => setTimeout(r, 0)); } };
  const walk = async (ms: number) => { for (let t = 0; t < ms; t += 5_000) { s.clock.advance(Math.min(5_000, ms - t)); await settle(); } };
  const keys = () => [...new Set(s.applier.applies.map((a) => String(a.idempotency_key)).filter((k) => k.startsWith("rule:")))];
  const applierId = (key: string) => `applier-apply-${[...new Set(s.applier.applies.map((a) => a.idempotency_key))].indexOf(key) + 1}`;
  const change = async (target: string, key: string, value: unknown) => {
    s.applier.emit({ type: "state", target, key, value, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
    await s.pump();
  };
  const ends = async (key: string, target: string, outcome: string, reason?: string) => {
    s.applier.emit({ type: "outcome", apply_id: applierId(key), step_id: "s1", target, outcome, ...(reason ? { reason } : {}),
      time: new Date(s.clock.now()).toISOString() });
    await s.pump();
  };
  const failures = async (cursor = begun) => (await eventsSince(s.ok, cursor, "notice")).filter((e) => e.change === "raised" && e.cause === "rule_failed");
  const rows = async () => (await s.store.query<{ rule_id: string; kind: string; due_ms: string | number }>(
    "SELECT rule_id, kind, due_ms FROM rule_pending ORDER BY rule_id, kind")).rows.map((r) => ({ rule_id: r.rule_id, kind: r.kind, due_ms: Number(r.due_ms) }));
  /** Reads the gap since the store's last event, as a restart's link does, and then the state. */
  const sync = async (motion: boolean, session?: string) => {
    const missed = (await s.port.history({ from: new Date(0).toISOString(), to: new Date(s.clock.now()).toISOString() })).events;
    s.steward.recover(missed, stateOf(s.clock.now(), motion, session), String(missed.at(-1)?.seq ?? 0));
    await quiet(s.store);
  };
  /** Stops this steward cleanly, its writes committed. */
  const stop = async () => {
    await quiet(s.store);
    s.steward.stop();
    await s.store.close();
  };
  return { ...s, begun, settle, walk, keys, applierId, change, ends, failures, rows, sync, stop };
}

/** The pulse relay's turn_on fired at motion and ended failed(no_ack) at its ack_within_s: its notice is held. */
async function heldPulse(mutation?: Mutation) {
  const db = lasting(await memoryDb());
  const clock = new FakeClock();
  const a = await life({ db, clock, rules: [PULSE_RULE], mutation });
  await a.change(MOTION, "motion", true);
  await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toEqual(["rule:pulse:0"]); });
  await a.walk(ACK_S * 1000);
  await a.ends("rule:pulse:0", PULSE, "failed", "no_ack");
  const failedAt = a.clock.now();
  await quiet(a.store);
  return { db, clock, a, failedAt };
}

describe("a held notice across a restart (GA-PERSIST-2, GA-RULE-8)", () => {
  it("declares its mutation", () => {
    expect(MUTATIONS).toContain("forgets-a-held-notice");
  });

  it("keeps a held notice in the store with the end of its wait, and forgets the row once it is raised", async () => {
    const { a, failedAt } = await heldPulse();
    expect(await a.rows()).toEqual([{ rule_id: "pulse", kind: "held", due_ms: failedAt + NO_ACK_WAIT }]);
    await a.walk(NO_ACK_WAIT);
    expect((await a.failures()).length).toBe(1);
    await quiet(a.store);
    expect(await a.rows()).toEqual([]);
  });

  it("commits the notice's row before it forgets the held row, so a crash between them loses no notice (the milestone 7+10+11 review, I7)", async () => {
    const base = lasting(await memoryDb());
    let sawHeld = false;
    const lost: string[] = [];
    const db = { ...base, async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const r = await base.transaction(fn);
      const held = (await base.query("SELECT 1 FROM rule_pending WHERE rule_id = 'pulse' AND kind = 'held'")).rows.length > 0;
      const noticed = (await base.query("SELECT 1 FROM notices WHERE notice_id = 'steward:rule:pulse:0:s1'")).rows.length > 0;
      if (held) sawHeld = true;
      else if (sawHeld && !noticed) lost.push("the held row gone, the notice's row not yet kept");
      return r;
    } } as Db;
    const clock = new FakeClock();
    const a = await life({ db, clock, rules: [PULSE_RULE] });
    await a.change(MOTION, "motion", true);
    await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toEqual(["rule:pulse:0"]); });
    await a.walk(ACK_S * 1000);
    await a.ends("rule:pulse:0", PULSE, "failed", "no_ack");
    await quiet(a.store);
    expect(sawHeld).toBe(true);
    await a.walk(NO_ACK_WAIT);
    await quiet(a.store);
    expect((await a.failures()).length).toBe(1);
    expect(await a.rows()).toEqual([]);
    expect(lost).toEqual([]);
  });

  it("raises it after a restart inside the wait, once the wait has passed, and not before; under forgets-a-held-notice, never", async () => {
    for (const [m, want] of [[undefined, 1], ["forgets-a-held-notice", 0]] as const) {
      const { db, clock, a, failedAt } = await heldPulse(m);
      await a.walk(30_000);
      await a.stop();
      await a.walk(10_000);
      const b = await life({ db, clock, mutation: m, motion: true, applier: a.applier });
      await b.sync(true);
      await b.walk(failedAt + NO_ACK_WAIT - 5_000 - clock.now());
      expect(await b.failures(), `${m}: before the wait passed`).toEqual([]);
      await b.walk(10_000);
      const raised = await b.failures();
      expect(raised.length, String(m)).toBe(want);
      if (want) {
        expect(raised[0]).toMatchObject({ notice_id: "steward:rule:pulse:0:s1", rule: "pulse", action: "onoff.turn_on", target: PULSE, outcome: "failed",
          reason: "no_ack" });
        expect(Date.parse(raised[0]!.time)).toBeGreaterThanOrEqual(failedAt + NO_ACK_WAIT);
      }
    }
  });

  it("raises it at the restart's first sync when its wait passed while the steward was down, though the conditions stopped holding", async () => {
    const { db, clock, a } = await heldPulse();
    await a.stop();
    await a.walk(NO_ACK_WAIT);
    const b = await life({ db, clock, motion: false, applier: a.applier });
    await b.settle();
    // Not before the gap is read: a late ack may be in it.
    expect(await b.failures()).toEqual([]);
    await b.sync(false);
    await b.settle();
    expect((await b.failures()).map((e) => e.notice_id)).toEqual(["steward:rule:pulse:0:s1"]);
    await quiet(b.store);
    expect(await b.rows()).toEqual([]);
  });

  it("raises none when a late_ack came while the steward was down, read from the applier's history at the start, named by the firing's apply", async () => {
    const { db, clock, a } = await heldPulse();
    const firing = (await eventsSince(a.ok, a.begun, "rule_fired"))[0]!;
    await a.stop();
    await a.walk(20_000);
    a.applier.emit({ type: "late_ack", apply_id: a.applierId("rule:pulse:0"), step_id: "s1", target: PULSE, key: "on", value: true,
      time: new Date(clock.now()).toISOString() });
    await a.walk(NO_ACK_WAIT);
    const b = await life({ db, clock, motion: true, applier: a.applier });
    await b.sync(true);
    await b.walk(10_000);
    expect(await b.failures()).toEqual([]);
    const acked = (await eventsSince(b.ok, b.begun, "late_ack"))[0];
    expect(acked).toMatchObject({ apply_id: firing.apply_id, step_id: "s1", cause: { rule: "pulse" }, recovered: true });
    await quiet(b.store);
    expect(await b.rows()).toEqual([]);
  });

  it("raises none when a late_ack comes after the restart, inside the wait", async () => {
    const { db, clock, a, failedAt } = await heldPulse();
    await a.stop();
    const b = await life({ db, clock, motion: true, applier: a.applier });
    await b.sync(true);
    await b.walk(20_000);
    b.applier.emit({ type: "late_ack", apply_id: b.applierId("rule:pulse:0"), step_id: "s1", target: PULSE, key: "on", value: true,
      time: new Date(clock.now()).toISOString() });
    await b.pump();
    await b.walk(failedAt + NO_ACK_WAIT + 5_000 - clock.now());
    expect(await b.failures()).toEqual([]);
  });

  it("keeps a lock's failed(not_locked) held from its dispatch across a restart", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await life({ db, clock, rules: [LIMIT] });
    await a.change(LAPTOP, "session.liza", "active");
    await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toEqual(["rule:limit:0"]); });
    const sent = clock.now();
    await a.walk(1_000);
    await a.ends("rule:limit:0", LAPTOP, "failed", "not_locked");
    await quiet(a.store);
    expect((await a.rows()).map((r) => [r.kind, r.due_ms])).toEqual([["held", sent + ACK_S * 1000 + LATE_ACK_SLACK_MS]]);
    await a.stop();
    const b = await life({ db, clock, session: "active", applier: a.applier });
    await b.sync(false, "active");
    await b.walk(sent + ACK_S * 1000 + LATE_ACK_SLACK_MS - clock.now() - 1_000);
    expect(await b.failures()).toEqual([]);
    await b.walk(2_000);
    expect((await b.failures()).map((e) => [e.rule, e.reason])).toEqual([["limit", "not_locked"]]);
  });

  it("drops a deleted rule's held notice, in the store too", async () => {
    const { a } = await heldPulse();
    await a.define([del("rule", { id: "pulse" })]);
    await a.walk(NO_ACK_WAIT);
    expect(await a.failures()).toEqual([]);
    await quiet(a.store);
    expect(await a.rows()).toEqual([]);
  });

  it("drops at the start a held notice whose rule a define deleted while its row was being written", async () => {
    const { db, clock, a } = await heldPulse();
    await a.stop();
    // The house without the rule, as a define that committed before the crash left it.
    const house = await a.db.query<{ doc: Body }>("SELECT doc FROM house WHERE kind = 'rule' AND id = 'pulse'");
    expect(house.rows.length).toBe(1);
    await a.db.query("DELETE FROM house WHERE kind = 'rule' AND id = 'pulse'");
    const b = await life({ db, clock, motion: true, applier: a.applier });
    await b.sync(true);
    await b.walk(NO_ACK_WAIT);
    expect(await b.failures()).toEqual([]);
    await quiet(b.store);
    expect(await b.rows()).toEqual([]);
  });
});

describe("a rule's firing in flight across a restart (GA-PERSIST-2, GA-RULE-7, GA-RULE-8)", () => {
  /** The limit fired on Лиза's session opening, the applier's answer in, no outcome yet: the steward then stops. */
  async function inFlight() {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await life({ db, clock, rules: [LIMIT] });
    await a.change(LAPTOP, "session.liza", "active");
    await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toEqual(["rule:limit:0"]); });
    await a.settle();
    await quiet(a.store);
    const firing = (await eventsSince(a.ok, a.begun, "rule_fired"))[0]!;
    return { db, clock, a, firing };
  }

  it("keeps a firing whose step has no final outcome in the store, and forgets it once the step ends", async () => {
    const { a } = await inFlight();
    expect((await a.rows()).map((r) => [r.rule_id, r.kind])).toEqual([["limit", "sent"]]);
    await a.walk(1_000);
    await a.ends("rule:limit:0", LAPTOP, "acked");
    await quiet(a.store);
    expect(await a.rows()).toEqual([]);
  });

  it("names the firing in its step's outcome the applier gave while the steward was down, and fires it again for an unreachable, as before a restart", async () => {
    const { db, clock, a, firing } = await inFlight();
    await a.stop();
    await a.walk(2_000);
    a.applier.emit({ type: "outcome", apply_id: a.applierId("rule:limit:0"), step_id: "s1", target: LAPTOP, outcome: "unreachable",
      time: new Date(clock.now()).toISOString() });
    await a.walk(5_000);
    const b = await life({ db, clock, session: "active", applier: a.applier });
    await b.sync(true, "active");
    const ended = (await eventsSince(b.ok, b.begun, "outcome")).filter((e) => e.target === LAPTOP);
    expect(ended.map((e) => [e.apply_id, e.step_id, e.outcome, e.cause, e.recovered])).toEqual([[firing.apply_id, "s1", "unreachable", { rule: "limit" }, true]]);
    await b.walk(60_000);
    expect(b.keys()).toHaveLength(2);
    expect(b.keys()[1]).toMatch(/^rule:limit:\d+$/);
    expect(b.keys()[1]).not.toBe("rule:limit:0");
  });

  it("fires none again for a step acked while the steward was down, and forgets its row", async () => {
    const { db, clock, a } = await inFlight();
    await a.stop();
    a.applier.emit({ type: "outcome", apply_id: a.applierId("rule:limit:0"), step_id: "s1", target: LAPTOP, outcome: "acked",
      time: new Date(clock.now()).toISOString() });
    const b = await life({ db, clock, session: "active", applier: a.applier });
    await b.sync(true, "active");
    await b.walk(120_000);
    expect(b.keys()).toEqual(["rule:limit:0"]);
    await quiet(b.store);
    expect(await b.rows()).toEqual([]);
  });

  it("fires again for a firing restored from a later becoming true than this life's first: it takes this life's count (the code review, CR1)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await life({ db, clock, rules: [LIMIT] });
    // Two becomings true, each acked and ended by the session locking: the third firing is in the last life's third.
    for (let i = 0; i < 2; i++) {
      await a.change(LAPTOP, "session.liza", "active");
      await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toHaveLength(i + 1); });
      await a.settle();
      await a.ends(a.keys()[i]!, LAPTOP, "acked");
      await a.change(LAPTOP, "session.liza", "locked");
      await a.settle();
    }
    await a.change(LAPTOP, "session.liza", "active");
    await vi.waitFor(() => { a.clock.advance(0); expect(a.keys()).toHaveLength(3); });
    await a.settle();
    await quiet(a.store);
    const third = a.keys()[2]!;
    await a.stop();
    await a.walk(2_000);
    a.applier.emit({ type: "outcome", apply_id: a.applierId(third), step_id: "s1", target: LAPTOP, outcome: "unreachable",
      time: new Date(clock.now()).toISOString() });
    await a.walk(5_000);
    const b = await life({ db, clock, session: "active", applier: a.applier });
    await b.sync(true, "active");
    await b.walk(60_000);
    expect(b.keys()).toHaveLength(4);
  });

  it("drops at the start a firing in flight whose rule is gone", async () => {
    const { db, clock, a } = await inFlight();
    await a.stop();
    await a.db.query("DELETE FROM house WHERE kind = 'rule' AND id = 'limit'");
    const b = await life({ db, clock, session: "active", applier: a.applier });
    await b.sync(true, "active");
    await quiet(b.store);
    expect(await b.rows()).toEqual([]);
  });
});
