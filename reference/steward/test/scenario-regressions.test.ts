// Regressions from the milestone 5+6 review of scenarios (slice 5): each case failed before its fix.
import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb, type Db } from "./db.js";
import { SECRETS, up } from "./house.js";
import { DEVICES, judgeAction, LAMP, setup, TV } from "./setup.js";

type Body = Record<string, any>;
const DOOR = "sim-bridge:door";
const ALL = [...DEVICES.map((d) => ({ ...d, fresh_s: 60 })),
  { id: DOOR, label: "door", class: "sensor", capabilities: ["sensor"], sensor_keys: ["opening"], adopted: true, fresh_s: 60, actions: [] }];
const STATE = { targets: Object.fromEntries([...DEVICES.map((d) => d.id), DOOR].map((id) => [id, { liveness: "live",
  values: id === DOOR ? [{ key: "opening", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : [] }])), transports: [], latches: [] };
const scene = (id: string, steps: unknown[], extra: Body = {}) => up("scenario", { id, name: id, mode: "single", steps, ...extra });
const lampOn = { target: LAMP, action: "onoff.turn_on", args: {} };
const tvOff = { target: TV, action: "onoff.turn_off", args: {} };
const sends = (s: { applier: { applies: Body[] } }, prefix: string) => s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith(prefix));
const doorRule = (actions: unknown[]) => up("rule", { id: "door", name: "door", conditions: [{ target: DOOR, key: "opening", op: "eq", value: true }], actions });
const turns = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

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

/** The door opens, as the applier's event. */
const opens = (s: { steward: { onEvents(e: Body[]): void }; clock: { now(): number } }, seq = 1) =>
  s.steward.onEvents([{ seq, type: "state", target: DOOR, key: "opening", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" }]);

describe("a run's keys and who reads it", () => {
  it("counts an ignored start's key against the credential's cap, so one plan reused under new keys is refused past it (GA-SCN-1, GA-SCN-6)", async () => {
    const s = await setup({ devices: ALL, state: STATE, options: { maxAppliesPerCredential: 3, pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("long", [lampOn, { delay: 3600 }])]);
    const p0 = await s.ok(SECRETS.owner, "scenario_plan", { scenario: "long", endpoint: "owner-app" });
    const first = await s.ok(SECRETS.owner, "scenario_run", { plan_id: p0.plan_id, idempotency_key: "k0" });
    const plan = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "long", endpoint: "olga-app" });
    for (let i = 0; i < 3; i++) {
      expect(await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: `x${i}` })).toEqual({ run_id: first.run_id, ignored: true });
    }
    expect(await s.error(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "x3" })).toBe("invalid_request");
    // A key she holds is still answered.
    expect(await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "x0" })).toEqual({ run_id: first.run_id, ignored: true });
    expect((s.steward as unknown as { runKeys: Map<string, unknown> }).runKeys.size).toBe(4);
  });

  it("keeps an ignored start's key across a restart: the same key answers the same run (GA-SCN-6, GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const s = await setup({ db, devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    // A toggle step makes the plan ask, so the plan is committed and survives the restart.
    await s.define([scene("long", [{ delay: 600 }, tvOff])]);
    const p0 = await s.ok(SECRETS.owner, "scenario_plan", { scenario: "long", endpoint: "owner-app" });
    const first = await s.ok(SECRETS.owner, "scenario_run", { plan_id: p0.plan_id, idempotency_key: "k0" });
    const plan = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "long", endpoint: "olga-app" });
    expect(await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "same" })).toEqual({ run_id: first.run_id, ignored: true });
    await s.store.settled();
    s.steward.stop();
    await s.store.close(3000);
    const again = await setup({ db, clock: s.clock, define: false, devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    expect(await again.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "same" })).toEqual({ run_id: first.run_id, ignored: true });
  });

  it("lets only the starting credential and the owner's app read a run (ruled 2026-10-05)", async () => {
    const s = await setup({ devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("long", [lampOn, { delay: 3600 }])]);
    const plan = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "long", endpoint: "olga-app" });
    const { run_id } = await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    expect((await s.ok(SECRETS.olga, "scenario_status", { run_id })).status).toBe("running");
    expect((await s.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect(await s.error(SECRETS.panel, "scenario_status", { run_id })).toBe("unknown_run");
  });
});

describe("what a run leases", () => {
  const LOCK = "sim-bridge:lock";
  const LOCKED = [...ALL, { id: LOCK, label: "lock", class: "door_lock", capabilities: ["lock"], adopted: true, fresh_s: 60,
    actions: [{ action: "lock.lock", tier: "confirm" }, { action: "lock.unlock", tier: "no_voice" }] }];
  const LOCK_STATE = { ...STATE, targets: { ...STATE.targets, [LOCK]: { liveness: "live", values: [] } } };

  it("leases only the owned devices its starter's role could act on: a guest's run not the lock, a member's both (ruled 2026-10-05)", async () => {
    const s = await setup({ devices: LOCKED, state: LOCK_STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("away", [{ delay: 3600 }], { owned: [LAMP, LOCK] }), scene("home", [{ delay: 3600 }], { owned: [LAMP, LOCK] })]);
    // The hall panel has no person: a guest.
    const guest = await s.ok(SECRETS.panel, "scenario_plan", { scenario: "away", endpoint: "hall-panel" });
    await s.ok(SECRETS.panel, "scenario_run", { plan_id: guest.plan_id, idempotency_key: "g" });
    expect(Object.keys((await s.ok(SECRETS.owner, "state")).leases as Body)).toEqual([LAMP]);
    const member = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "home", endpoint: "olga-app" });
    await s.ok(SECRETS.olga, "scenario_run", { plan_id: member.plan_id, idempotency_key: "m" });
    expect(Object.keys((await s.ok(SECRETS.owner, "state")).leases as Body).sort()).toEqual([LAMP, LOCK].sort());
  });
});

describe("a rule's run and a rule's firing", () => {
  it("judges a run step's lease again once its record has committed: a person's lease taken while it waited refuses it (GA-LEASE-3)", async () => {
    const { db, hold } = await slowDb();
    const s = await setup({ db, devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("night", [lampOn]), doorRule([{ scenario: "night" }])]);
    await s.store.settled();
    const { cursor } = await s.ok(SECRETS.owner, "events");
    const release = hold();
    opens(s);
    await turns();
    // Someone switches the lamp by hand while the run's record waits for its commit.
    s.steward.onEvents([{ seq: 2, type: "state", target: LAMP, key: "on", value: false, basis_time: new Date(s.clock.now()).toISOString(), cause: "external" }]);
    expect(((await s.ok(SECRETS.owner, "state")).leases as Body)[LAMP]).toMatchObject({ holder: "external", precedence: "person" });
    release();
    const started = await vi.waitFor(async () => {
      const e = (await s.ok(SECRETS.owner, "events", { cursor })).events.find((x: Body) => x.type === "scenario" && x.change === "started");
      expect(e).toBeDefined();
      return e;
    });
    const st = await vi.waitFor(async () => {
      s.clock.advance(0);
      const x = await s.ok(SECRETS.owner, "scenario_status", { run_id: started.run_id });
      expect(x.status).toBe("ended");
      return x;
    });
    expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s1 refused(leased)"]);
    expect(sends(s, "run:")).toEqual([]);
  });

  it("lets only the owner's app read a run a rule started, and refuses a guest's stop of it; a member may stop it (ruled 2026-10-05)", async () => {
    const s = await setup({ devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("night", [{ delay: 3600 }]), doorRule([{ scenario: "night" }])]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    opens(s);
    const started = await vi.waitFor(async () => {
      const e = (await s.ok(SECRETS.owner, "events", { cursor })).events.find((x: Body) => x.type === "scenario" && x.change === "started");
      expect(e).toBeDefined();
      return e;
    });
    expect((await s.ok(SECRETS.owner, "scenario_status", { run_id: started.run_id })).status).toBe("running");
    expect(await s.error(SECRETS.olga, "scenario_status", { run_id: started.run_id })).toBe("unknown_run");
    expect(await s.error(SECRETS.panel, "scenario_status", { run_id: started.run_id })).toBe("unknown_run");
    // The hall panel has no person: a guest.
    expect(await s.error(SECRETS.panel, "scenario_stop", { run_id: started.run_id, endpoint: "hall-panel" })).toBe("not_permitted");
    expect((await s.ok(SECRETS.olga, "scenario_stop", { run_id: started.run_id, endpoint: "olga-app" })).reason).toBe("stopped");
  });

  it("refuses a visitor's stop of a run no person started (GA-SCN-9); takes it under visitor-stops-a-schedule", async () => {
    for (const [mutation, want] of [[undefined, "not_permitted"], ["visitor-stops-a-schedule", "ok"]] as const) {
      const s = await setup({ devices: ALL, state: STATE, mutation, options: { pruneEveryMs: 3_600_000 } });
      s.applier.answerOutcome = "acked";
      const kiosk = "a-kiosk-secret-of-twenty";
      await s.define([scene("night", [{ delay: 3600 }]), doorRule([{ scenario: "night" }]),
        up("endpoint", { id: "hall-kiosk", name: "Киоск", type: "panel", room: "hall", person: null, served_by: null, max_role: "visitor" }),
        up("credential", { id: "hall-kiosk", kind: "panel", secret: kiosk, endpoint: "hall-kiosk" })]);
      const { cursor } = await s.ok(SECRETS.owner, "events");
      opens(s);
      const started = await vi.waitFor(async () => {
        const e = (await s.ok(SECRETS.owner, "events", { cursor })).events.find((x: Body) => x.type === "scenario" && x.change === "started");
        expect(e).toBeDefined();
        return e;
      });
      expect(await s.error(kiosk, "scenario_stop", { run_id: started.run_id, endpoint: "hall-kiosk" })).toBe(want);
    }
  });

  it("commits a firing's fired before it sends while the store is up, so a crash after the send cannot fire it again (GA-RULE-1)", async () => {
    const { db, hold } = await slowDb();
    const s = await setup({ db, devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([doorRule([lampOn])]);
    await s.store.settled();
    const release = hold();
    opens(s);
    await vi.waitFor(() => expect(s.steward.ruleFired("door")).toBe(true));
    await turns(20);
    expect(sends(s, "rule:")).toEqual([]);
    release();
    await vi.waitFor(() => expect(sends(s, "rule:").length).toBe(1));
    const row = await db.query<{ fired: boolean }>("SELECT fired FROM rule_states WHERE rule_id = 'door'");
    expect(row.rows[0]?.fired).toBe(true);
  });

  it("settles an applier's skip(already) on a rule's step as its own skipped(already), sending nothing", async () => {
    const s = await setup({ devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    s.applier.planner = (a: Body) => (a.target === LAMP ? { verdict: "skip", reason: "already" } : judgeAction(a));
    await s.define([doorRule([lampOn])]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    opens(s);
    await vi.waitFor(async () => {
      const o = (await s.ok(SECRETS.owner, "events", { cursor })).events.filter((x: Body) => x.type === "outcome");
      expect(o.map((x: Body) => `${x.outcome}(${x.reason})`)).toEqual(["skipped(already)"]);
    });
    await s.store.settled();
    expect(sends(s, "rule:")).toEqual([]);
  });
});

describe("a toggle step asked again", () => {
  it("keeps a running run's plan past its keeping, so a toggle step asked again after an hour's delay takes its yes and is sent (GA-SCN-3)", async () => {
    // The steward's own prune, every 60 s as in production.
    const s = await setup({ devices: ALL, state: STATE, options: { pruneEveryMs: 60_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("film", [{ delay: 3600 }, tvOff])]);
    const plan = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "film", endpoint: "olga-app" });
    await s.ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    const { run_id } = await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    for (let i = 0; i < 59; i++) {
      s.clock.advance(60_000);
      await turns(2);
    }
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.clock.advance(60_000);
    const ask = await vi.waitFor(async () => {
      const e = (await s.ok(SECRETS.owner, "events", { cursor })).events.filter((x: Body) => x.type === "ask" && x.run_id === run_id);
      expect(e.length).toBe(1);
      return e[0];
    });
    expect(ask.plan_id).toBe(plan.plan_id);
    await s.ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    const st = await vi.waitFor(async () => {
      s.clock.advance(0);
      const x = await s.ok(SECRETS.olga, "scenario_status", { run_id });
      expect(x.status).toBe("ended");
      return x;
    });
    expect(st.failed_steps).toEqual([]);
    expect(sends(s, "run:").map((a: Body) => a.request.actions[0].target)).toEqual([TV]);
  });

  it("records nothing more of a run once the steward is stopped: a re-ask woken by the stop is not skipped(not_confirmed)", async () => {
    const s = await setup({ devices: ALL, state: STATE, options: { pruneEveryMs: 3_600_000 } });
    s.applier.answerOutcome = "acked";
    await s.define([scene("late", [{ delay: 400 }, tvOff])]);
    const plan = await s.ok(SECRETS.olga, "scenario_plan", { scenario: "late", endpoint: "olga-app" });
    await s.ok(SECRETS.olga, "answer", { plan_id: plan.plan_id, endpoint: "olga-app", answers: { s1: "yes" } });
    const { run_id } = await s.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: "k" });
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.clock.advance(400_000);
    await vi.waitFor(async () => expect((await s.ok(SECRETS.owner, "events", { cursor })).events.some((x: Body) => x.type === "ask" && x.run_id === run_id)).toBe(true));
    s.steward.stop();
    await s.store.settled();
    await turns(20);
    const st = await s.ok(SECRETS.olga, "scenario_status", { run_id });
    expect(st.status).toBe("running");
    expect(st.failed_steps).toEqual([]);
    expect(sends(s, "run:")).toEqual([]);
  });
});
