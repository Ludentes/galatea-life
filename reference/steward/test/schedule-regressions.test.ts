// Regressions from the milestone 5+6 review of schedules (slice 6): each case failed before its fix.
import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb, type Db } from "./db.js";
import { SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, eventsSince, LAMP, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const MINUTE = 60_000;
const DOOR = "sim-bridge:door";
const ALL = [...DEVICES, { id: DOOR, label: "door", class: "sensor", capabilities: ["sensor"], sensor_keys: ["opening"], adopted: true, actions: [] }];
const STATE = { targets: Object.fromEntries(ALL.map((d) => [d.id, { liveness: "live", values: d.id === LAMP || d.id === DIMMER
  ? [{ key: "on", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : d.id === DOOR ? [{ key: "opening", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : [] }])),
transports: [], latches: [] };
const sceneOf = (id: string, steps: unknown[], extra: Body = {}) => up("scenario", { id, name: id, mode: "single", steps, ...extra });
const lampOn = { target: LAMP, action: "onoff.turn_on", args: {} };
const dimmerOn = { target: DIMMER, action: "onoff.turn_on", args: {} };

/** A store whose transactions wait while held, as a slow commit: `hold()` returns its release. */
async function slowDb(): Promise<{ db: Db; hold: () => () => void }> {
  const db = lasting(await memoryDb());
  const transaction = db.transaction.bind(db);
  let gate: Promise<void> | undefined;
  (db as unknown as { transaction: typeof transaction }).transaction = (async (fn: never) => {
    if (gate) await gate;
    return transaction(fn);
  }) as typeof transaction;
  return { db, hold: () => {
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    return () => { gate = undefined; open(); };
  } };
}

/** A steward at 2030-01-01 11:00 Moscow with `changes` defined; `runs()` are the applies a run sent. */
async function scheduled(changes: unknown[], o: { db?: Db } = {}) {
  const s = await setup({ state: STATE, devices: ALL, db: o.db, options: { pruneEveryMs: 24 * 3_600_000 } });
  s.applier.answerOutcome = "acked";
  if (changes.length) await s.define(changes);
  const runs = () => s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith("run:"));
  return { ...s, runs };
}

describe("a schedule's time, late or waiting", () => {
  it("never starts a waiting run after its grace has closed, though its timer fired a few seconds late: the date is recorded missed (GA-SCHED-2)", async () => {
    // a runs `long` at 11:05 for 360 s (until 11:11:00); b's time is 11:06, its grace until 11:11:00.
    const { clock, runs, ok, store } = await scheduled([sceneOf("long", [lampOn, { delay: 360 }]), up("schedule", { id: "a", scenario: "long", time: "11:05" }),
      up("schedule", { id: "b", scenario: "long", time: "11:06" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    await quiet(store);
    // b's timer fires 5 s late (inside LATE_MS): its tries fall at 11:06:15, …, 11:10:55, then at the grace's close.
    clock.advance(MINUTE - 1);
    clock.jump(5_001);
    clock.advance(0);
    for (let i = 0; i < 310; i++) {
      clock.advance(1_000);
      await quiet(store, 1);
    }
    const missed = await vi.waitFor(async () => {
      const e = (await eventsSince(ok, cursor, "schedule_missed")).filter((x: Body) => x.schedule === "b");
      expect(e.length).toBe(1);
      return e[0];
    });
    expect([missed.date, missed.reason]).toEqual(["2030-01-01", "scenario_running"]);
    expect((await eventsSince(ok, cursor, "scenario")).filter((e: Body) => e.change === "started" && e.cause.schedule === "b")).toEqual([]);
    expect(runs().length).toBe(1);
  });

  it("records a skipped date whose timer fires late schedule_skipped, not schedule_missed", async () => {
    const { clock, ok } = await scheduled([sceneOf("evening", [lampOn]),
      up("schedule", { id: "dusk", scenario: "evening", time: "11:05", exceptions: [{ date: "2030-01-01", action: "skip" }] })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.jump(30 * MINUTE);
    clock.advance(0);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "schedule_skipped")).map((e: Body) => e.date)).toEqual(["2030-01-01"]));
    expect(await eventsSince(ok, cursor, "schedule_missed")).toEqual([]);
  });

  it("records every date a timer days late passed over, and runs none of them (GA-SCHED-2)", async () => {
    const { clock, ok, runs, store } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    // The host sleeps from 11:00 on the 1st to 12:00 on the 3rd.
    clock.jump((2 * 24 + 1) * 60 * MINUTE);
    clock.advance(0);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "schedule_missed")).map((e: Body) => e.date))
      .toEqual(["2030-01-01", "2030-01-02", "2030-01-03"]));
    await quiet(store);
    expect(runs()).toEqual([]);
    expect((await store.query("SELECT mark FROM schedule_marks")).rows).toEqual([{ mark: "2030-01-03" }]);
  });

  it("never runs a date twice when a define changing the schedule commits as its timer fires: the later mark stands", async () => {
    const { db, hold } = await slowDb();
    const { clock, runs, ok, store, call } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })], { db });
    await store.settled();
    clock.advance(5 * MINUTE - 1_000);
    // 11:04:59: the owner moves the schedule to 11:30; the store is slow to commit it.
    const release = hold();
    const revision = (await ok(SECRETS.owner, "describe")).revision;
    const defining = call(SECRETS.owner, "define", { endpoint: "owner-app", expected_revision: revision, dry_run: false,
      changes: [up("schedule", { id: "dusk", scenario: "evening", time: "11:30" })] });
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    // 11:05: the old time fires before the change is in.
    clock.advance(1_000);
    release();
    await defining;
    await vi.waitFor(() => expect(runs().length).toBe(1));
    for (let i = 0; i < 26; i++) {
      clock.advance(MINUTE);
      await quiet(store, 1);
    }
    await quiet(store);
    expect(runs().length).toBe(1);
    expect((await store.query("SELECT mark FROM schedule_marks")).rows).toEqual([{ mark: "2030-01-01" }]);
  });

  it("sends a scheduled start that finds its scenario just started by another back to waiting: it runs once that run ends within the grace, else is recorded missed", async () => {
    for (const [delay, runs] of [[60, 1], [600, 0]] as const) {
      const { db, hold } = await slowDb();
      const s = await scheduled([sceneOf("long", [{ delay }]), sceneOf("lit", [lampOn]), up("schedule", { id: "dusk", scenario: "long", time: "11:05" }),
        up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "long" }] })], { db });
      await s.store.settled();
      const { cursor } = await s.ok(SECRETS.owner, "events");
      // The schedule's mark waits for its commit; meanwhile the door's rule starts the scenario.
      const release = hold();
      s.clock.advance(5 * MINUTE);
      s.steward.onEvents([{ seq: 1, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);
      release();
      await quiet(s.store);
      for (let i = 0; i < 31; i++) {
        s.clock.advance(10_000);
        await quiet(s.store, 2);
      }
      const events = await eventsSince(s.ok, cursor);
      const started = events.filter((e: Body) => e.type === "scenario" && e.change === "started").map((e: Body) => e.cause.rule ?? e.cause.schedule);
      const missed = events.filter((e: Body) => e.type === "schedule_missed").map((e: Body) => [e.schedule, e.date, e.reason]);
      expect([delay, started, missed]).toEqual([delay, runs ? ["door", "dusk"] : ["door"], runs ? [] : [["dusk", "2030-01-01", "scenario_running"]]]);
      expect(events.filter((e: Body) => e.type === "scenario" && e.change === "ignored")).toEqual([]);
    }
  });
});

describe("a scheduled start's second wait across a restart (the milestone 5+6 review, M10)", () => {
  it("keeps the wait of a start that found its scenario just started: after a restart inside the grace it runs once, after the grace it is recorded missed once", async () => {
    for (const [downMs, want] of [[MINUTE, 1], [10 * MINUTE, 0]] as const) {
      const { db, hold } = await slowDb();
      const s = await scheduled([sceneOf("long", [{ delay: 7200 }]), up("schedule", { id: "dusk", scenario: "long", time: "11:05" }),
        up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "long" }] })], { db });
      await s.store.settled();
      // The schedule's mark waits for its commit; meanwhile the door's rule starts the scenario: the start goes back to waiting, its date marked.
      const release = hold();
      s.clock.advance(5 * MINUTE);
      s.steward.onEvents([{ seq: 1, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);
      release();
      await quiet(s.store);
      expect((await s.store.query("SELECT schedule_id, date FROM schedule_pending")).rows).toEqual([{ schedule_id: "dusk", date: "2030-01-01" }]);
      s.steward.stop();
      await s.store.close();
      s.clock.advance(downMs);
      // The restart ends the rule's run interrupted, so the scenario no longer runs.
      const b = await setup({ db, clock: s.clock, define: false, state: { ...STATE, targets: { ...STATE.targets,
        [DOOR]: { liveness: "live", values: [{ key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString() }] } } },
      devices: ALL, options: { pruneEveryMs: 24 * 3_600_000 } });
      for (let i = 0; i < 31; i++) {
        b.clock.advance(10_000);
        await quiet(b.store, 2);
      }
      const events = (await b.store.query<{ type: string; body: Body }>("SELECT type, body FROM events ORDER BY seq")).rows.map((r) => ({ type: r.type, ...r.body }));
      const started = events.filter((e: Body) => e.type === "scenario" && e.change === "started" && e.cause?.schedule === "dusk");
      const missed = events.filter((e: Body) => e.type === "schedule_missed").map((e: Body) => [e.schedule, e.date, e.reason]);
      expect([downMs, started.length, missed]).toEqual([downMs, want, want ? [] : [["dusk", "2030-01-01", "scenario_running"]]]);
      expect((await b.store.query("SELECT schedule_id FROM schedule_pending")).rows).toEqual([]);
    }
  });
});

describe("a marked wait past its grace at a restart (the milestone 7+10+11 review, M2)", () => {
  it("forgets the wait's row before it records the date missed, so a crash between them never records it twice", async () => {
    const { db, hold } = await slowDb();
    const s = await scheduled([sceneOf("long", [{ delay: 7200 }]), up("schedule", { id: "dusk", scenario: "long", time: "11:05" }),
      up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "long" }] })], { db });
    await s.store.settled();
    const release = hold();
    s.clock.advance(5 * MINUTE);
    s.steward.onEvents([{ seq: 1, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);
    release();
    await quiet(s.store);
    s.steward.stop();
    await s.store.close();
    s.clock.advance(10 * MINUTE);
    // Watch every commit of the restart: never the date recorded missed while its wait's row is still kept.
    const seen: string[] = [];
    const transaction = db.transaction.bind(db);
    (db as unknown as { transaction: typeof transaction }).transaction = (async (fn: never) => {
      const r = await transaction(fn);
      const missed = (await db.query("SELECT 1 FROM events WHERE type = 'schedule_missed' AND body->>'schedule' = 'dusk'")).rows.length > 0;
      const pending = (await db.query("SELECT 1 FROM schedule_pending WHERE schedule_id = 'dusk'")).rows.length > 0;
      if (missed && pending) seen.push("missed recorded, the wait still kept");
      return r;
    }) as typeof transaction;
    const b = await setup({ db, clock: s.clock, define: false, state: { ...STATE, targets: { ...STATE.targets,
      [DOOR]: { liveness: "live", values: [{ key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString() }] } } },
    devices: ALL, options: { pruneEveryMs: 24 * 3_600_000 } });
    await quiet(b.store);
    const missed = (await b.store.query<{ body: Body }>("SELECT body FROM events WHERE type = 'schedule_missed'")).rows.map((r) => [r.body.schedule, r.body.reason]);
    expect(missed).toEqual([["dusk", "scenario_running"]]);
    expect(seen).toEqual([]);
  });
});

describe("an authored run's failure notice", () => {
  it("raises one notice for a rule-started run whose step did not land, naming it (ruled 2026-10-05)", async () => {
    const s = await scheduled([sceneOf("night", [lampOn, dimmerOn]),
      up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "night" }] })]);
    s.applier.planner = (a: Body) => (a.target === DIMMER ? { verdict: "refuse", reason: "latched" } : {});
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.steward.onEvents([{ seq: 1, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);
    const told = await vi.waitFor(async () => {
      s.clock.advance(0);
      const n = (await eventsSince(s.ok, cursor, "notice")).filter((e: Body) => e.change === "raised" && e.cause === "rule_run_failed");
      expect(n.length).toBe(1);
      return n[0];
    });
    expect([told.rule, told.scenario, told.failed.map((f: Body) => `${f.target} ${f.outcome}(${f.reason})`)]).toEqual(["door", "night", [`${DIMMER} refused(latched)`]]);
    expect(told.notice_id ?? told.id ?? "").toContain("steward:rule-run:door:");
  });

  it("raises none for a scheduled or rule-started run's refused(leased) step, which stays in failed_steps (ruled 2026-10-05)", async () => {
    const s = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" }),
      up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions: [{ scenario: "evening" }] })]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    // A person's hand on the lamp: a person-precedence lease that outranks either run.
    s.steward.onEvents([{ seq: 1, type: "state", target: LAMP, key: "on", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "external" }]);
    s.steward.onEvents([{ seq: 2, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);
    const ended = async (n: number) => vi.waitFor(async () => {
      s.clock.advance(0);
      const e = (await eventsSince(s.ok, cursor, "scenario")).filter((x: Body) => x.change === "ended");
      expect(e.length).toBe(n);
      return e[n - 1];
    });
    const byRule = await ended(1);
    s.clock.advance(5 * MINUTE - 1_000);
    s.steward.onEvents([{ seq: 3, type: "state", target: LAMP, key: "on", value: false, basis_time: new Date(s.clock.now()).toISOString(), cause: "external" }]);
    s.clock.advance(1_000);
    const bySchedule = await ended(2);
    for (const run of [byRule, bySchedule]) {
      const st = await s.ok(SECRETS.owner, "scenario_status", { run_id: run.run_id });
      expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s1 refused(leased)"]);
    }
    await quiet(s.store);
    s.clock.advance(0);
    expect((await eventsSince(s.ok, cursor, "notice")).filter((e: Body) => e.change === "raised")).toEqual([]);
    expect(s.runs()).toEqual([]);
  });
});

describe("runs missed while the steward was down", () => {
  it("commits the marks it moves before it serves, so a crash right after the start records no date missed twice (GA-SCHED-2)", async () => {
    const db = lasting(await memoryDb());
    const a = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })], { db });
    await a.store.settled();
    a.steward.stop();
    a.clock.advance(2 * 24 * 3_600_000);
    // Note when the moved mark commits.
    let marked = false;
    const transaction = db.transaction.bind(db);
    (db as unknown as { transaction: typeof transaction }).transaction = (async (fn: (tx: any) => Promise<unknown>) => {
      let touched = false;
      const r = await transaction(async (tx: any) => fn({ ...tx, query: (sql: string, params?: unknown[]) => {
        if (sql.includes("schedule_marks")) touched = true;
        return tx.query(sql, params);
      } }));
      if (touched) marked = true;
      return r;
    }) as typeof transaction;
    const b = await setup({ db, clock: a.clock, define: false, state: STATE, devices: ALL, options: { pruneEveryMs: 24 * 3_600_000 } });
    expect(marked).toBe(true);
    expect((await b.store.query("SELECT mark FROM schedule_marks")).rows).toEqual([{ mark: "2030-01-02" }]);
  });
});
