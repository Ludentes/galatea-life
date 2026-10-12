import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { planDefine, type Change } from "../src/house/define.js";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import type { FakeClock } from "./fake-clock.js";
import { quiet } from "./setup.js";
import { context, del, furnished, SECRETS, up } from "./house.js";
import { describeOf, DEVICES, DIMMER, eventsSince, LAMP, setup, TV, type Db } from "./setup.js";

type Body = Record<string, any>;

const off = { target: LAMP, action: "onoff.turn_off", args: {} };
const scene = up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [off] });
/** A schedule `id` running `scenario` at `time`, with `extra` over it, as an upsert. */
const schedule = (id: string, time: string, extra: Body = {}, scenario = "night") => up("schedule", { id, scenario, time, ...extra });

const refused = (changes: Change[], message: RegExp, h = furnished()) =>
  expect(() => planDefine(h, changes, context())).toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(message) }));

describe("schedules at define", () => {
  it("takes a schedule of a scenario, its days and exceptions, the exceptions in date order, and shows it in the diff", () => {
    const { draft, diff } = planDefine(furnished(), [scene, schedule("bed", "22:30", { days: [7, 1, 2, 3, 4],
      exceptions: [{ date: "2030-01-08", action: "move", time: "23:30" }, { date: "2030-01-06", action: "skip" }] })], context());
    expect(draft.schedules.get("bed")).toEqual({ id: "bed", scenario: "night", time: "22:30", days: [7, 1, 2, 3, 4],
      exceptions: [{ date: "2030-01-06", action: "skip" }, { date: "2030-01-08", action: "move", time: "23:30" }] });
    expect(diff.find((l) => l.startsWith("+ schedule bed"))).toContain("scenario \"night\"");
  });

  it("refuses a schedule of no scenario, and deleting a scenario a schedule runs", () => {
    refused([schedule("bed", "22:30", {}, "nowhere")], /schedule bed: it runs no scenario nowhere/);
    const h = planDefine(furnished(), [scene, schedule("bed", "22:30")], context()).draft;
    refused([del("scenario", { id: "night" })], /schedule bed: it runs no scenario night/, h);
    expect(planDefine(h, [del("schedule", { id: "bed" }), del("scenario", { id: "night" })], context()).draft.schedules.size).toBe(0);
  });

  it("refuses an exception on a date that does not exist, two on one date, a move with no time and a skip with one", () => {
    refused([scene, schedule("bed", "22:30", { exceptions: [{ date: "2030-02-30", action: "skip" }] })], /no date 2030-02-30/);
    refused([scene, schedule("bed", "22:30", { exceptions: [{ date: "2030-01-06", action: "skip" }, { date: "2030-01-06", action: "move", time: "23:00" }] })],
      /two exceptions on 2030-01-06/);
    refused([scene, schedule("bed", "22:30", { exceptions: [{ date: "2030-01-06", action: "move" }] })], /exceptions\/0 must match exactly one schema/);
    refused([scene, schedule("bed", "22:30", { exceptions: [{ date: "2030-01-06", action: "skip", time: "23:00" }] })], /exceptions\/0 must match exactly one schema/);
  });

  it("adds, replaces and removes one exception by its date with the kind schedule_exception (GA-SCHED-1)", () => {
    const h = planDefine(furnished(), [scene, schedule("bed", "22:30")], context()).draft;
    const skip = { schedule: "bed", date: "2030-01-06", action: "skip" };
    const move = { schedule: "bed", date: "2030-01-06", action: "move", time: "23:00" };
    const added = planDefine(h, [up("schedule_exception", skip)], context()).draft;
    expect(added.schedules.get("bed")!.exceptions).toEqual([{ date: "2030-01-06", action: "skip" }]);
    const moved = planDefine(added, [up("schedule_exception", move)], context()).draft;
    expect(moved.schedules.get("bed")!.exceptions).toEqual([{ date: "2030-01-06", action: "move", time: "23:00" }]);
    // A delete names the exception by its key, its schedule and date (GA-DEF-14).
    refused([del("schedule_exception", skip)], /change 1 \(delete schedule_exception\)/, moved);
    refused([del("schedule_exception", { schedule: "bed", date: "2030-01-07" })], /schedule bed has no exception on 2030-01-07/, moved);
    expect(planDefine(moved, [del("schedule_exception", { schedule: "bed", date: "2030-01-06" })], context()).draft.schedules.get("bed")!.exceptions).toEqual([]);
    refused([up("schedule_exception", { ...skip, schedule: "day" })], /no schedule day/, h);
  });

  it("validates the schemas' examples of a schedule and an exception", () => {
    expect(validate("steward/define.schedule.json", { id: "bed", scenario: "night", time: "22:30", days: [1], exceptions: [] })).toEqual([]);
    expect(validate("steward/define.schedule.json", { id: "bed", scenario: "night", time: "24:00" })).not.toEqual([]);
    expect(validate("steward/define.schedule_exception.json", { schedule: "bed", date: "2030-01-06", action: "move", time: "07:00" })).toEqual([]);
  });

  it("lists the schedules in describe, in id order, and reads them back after a restart", async () => {
    const db = lasting(await memoryDb());
    const { ok, define, steward, store } = await setup({ db });
    await define([scene, schedule("wake", "07:00", { days: [1, 2, 3, 4, 5] }), schedule("bed", "22:30")]);
    const want = [{ id: "bed", scenario: "night", time: "22:30", exceptions: [] }, { id: "wake", scenario: "night", time: "07:00", days: [1, 2, 3, 4, 5], exceptions: [] }];
    expect((await ok(SECRETS.owner, "describe")).schedules).toEqual(want);
    await store.settled();
    steward.stop();
    const again = await setup({ db, define: false });
    expect((await again.ok(SECRETS.owner, "describe")).schedules).toEqual(want);
  });
});

const CHANNEL = "sim-bridge:channel";
const MINUTE = 60_000;
/** Every device live, the lamp and the dimmer off. */
const STATE = { targets: Object.fromEntries(DEVICES.map((d) => [d.id, { liveness: "live", values: d.id === LAMP || d.id === DIMMER
  ? [{ key: "on", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : [] }])), transports: [], latches: [] };
const sceneOf = (id: string, steps: unknown[], extra: Body = {}) => up("scenario", { id, name: id, mode: "single", steps, ...extra });
const lampOn = { target: LAMP, action: "onoff.turn_on", args: {} };

/**
 * A steward over the fake applier, which settles each step `acked` in its answer, with `changes`
 * defined at 2030-01-01 11:00 in Moscow (a Tuesday); `runs()` are the applies a run sent, `until` waits
 * for a run's status.
 */
async function scheduled(changes: unknown[], o: { mutation?: Mutation; db?: Db; clock?: FakeClock; define?: boolean } = {}) {
  const s = await setup({ state: STATE, mutation: o.mutation, db: o.db, clock: o.clock, define: o.define, options: { pruneEveryMs: 24 * 3_600_000 } });
  s.applier.answerOutcome = "acked";
  if (changes.length) await s.define(changes);
  const runs = () => s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith("run:"));
  const until = async (run_id: string, want: string) => vi.waitFor(async () => {
    s.clock.advance(0);
    const st = await s.ok(SECRETS.owner, "scenario_status", { run_id });
    expect(`${st.status}${st.reason ? `(${st.reason})` : ""}`).toBe(want);
    return st;
  });
  return { ...s, runs, until };
}

describe("scheduled runs", () => {
  it("runs the schedule's scenario at its time, as the scenario at scheduled_run precedence: via schedule, cause { run, schedule }, authored, a toggle skipped and in failed_steps, a notify from the scenario (GA-SCN-4, GA-AUTH-5, GA-NOTE-2, GA-SCN-11)", async () => {
    const { clock, runs, until, ok, applier, store } = await scheduled([sceneOf("evening", [lampOn, { target: DIMMER, action: "onoff.turn_on", args: {} },
      { target: TV, action: "onoff.turn_off", args: {} }, { target: CHANNEL, action: "notify.notify", args: { text: "вечер", from: { rule: "x" } } }, { delay: 60 }], { owned: [LAMP] }),
    up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(4 * MINUTE + 59_000);
    await quiet(store);
    expect(runs()).toEqual([]);
    clock.advance(1_000);
    await vi.waitFor(() => expect(runs().length).toBeGreaterThan(0));
    const run_id = String(runs()[0].idempotency_key).split(":")[1]!;
    expect(runs()[0].request.actions).toEqual([{ target: LAMP, action: "onoff.turn_on", args: {}, via: "schedule", brain: false, for: { run: run_id, schedule: "dusk" } }]);
    expect((await ok(SECRETS.owner, "state")).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    await vi.waitFor(() => expect(runs().length).toBe(3));
    clock.advance(60_000);
    const st = await until(run_id, "ended(done)");
    expect(st.failed_steps.map((x: Body) => `${x.step_id} ${x.outcome}(${x.reason})`)).toEqual(["s3 skipped(toggle_only)"]);
    // The dimmer's confirm step went with the schedule's authored token; the notify's from is the scenario's, the caller's overwritten.
    expect(runs().map((a: Body) => [a.request.actions[0].target, a.request.actions[0].token !== undefined])).toEqual([[LAMP, false], [DIMMER, true], [CHANNEL, false]]);
    expect(runs()[2].request.actions[0].args).toEqual({ text: "вечер", from: { scenario: "evening" } });
    const started = (await eventsSince(ok, cursor, "scenario")).map((e: Body) => [e.change, e.cause]);
    expect(started[0]).toEqual(["started", { run: run_id, schedule: "dusk" }]);
    expect(applier.applies.every((a: Body) => !String(a.idempotency_key).startsWith("rule:"))).toBe(true);
  });

  it("runs once a day, on its days only", async () => {
    const { clock, runs, store } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05", days: [2, 4] })]);
    clock.advance(10 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    // Wednesday is not one of its days; Thursday is.
    clock.advance(24 * 3_600_000);
    await quiet(store);
    expect(runs().length).toBe(1);
    clock.advance(24 * 3_600_000);
    await vi.waitFor(() => expect(runs().length).toBe(2));
  });

  it("skips the date its exception skips with a schedule_skipped event, and runs a moved date at its new time only (GA-SCHED-1)", async () => {
    const { clock, runs, ok, store } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05",
      exceptions: [{ date: "2030-01-01", action: "skip" }, { date: "2030-01-02", action: "move", time: "12:00" }] })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(10 * MINUTE);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "schedule_skipped")).map((e: Body) => [e.schedule, e.scenario, e.date, e.at, e.cause]))
      .toEqual([["dusk", "evening", "2030-01-01", "2030-01-01T08:05:00.000Z", { schedule: "dusk" }]]));
    expect(runs()).toEqual([]);
    // Wednesday: nothing at 11:05, the run at 12:00.
    clock.advance(24 * 3_600_000);
    await quiet(store);
    expect(runs()).toEqual([]);
    clock.advance(50 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
  });

  it("waits while its single scenario runs, trying again, and starts it once the scenario ends within the grace, the date then marked (ruled)", async () => {
    const { clock, runs, ok, store } = await scheduled([sceneOf("long", [lampOn, { delay: 90 }]), up("schedule", { id: "a", scenario: "long", time: "11:05" }),
      up("schedule", { id: "b", scenario: "long", time: "11:06" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    clock.advance(MINUTE);
    await store.settled();
    // b's time came while a's run runs: no run, its date not marked, the wait kept in the store.
    const kept = async () => (await store.query("SELECT schedule_id, mark FROM schedule_marks ORDER BY schedule_id")).rows;
    expect(await kept()).toEqual([{ schedule_id: "a", mark: "2030-01-01" }, { schedule_id: "b", mark: "2029-12-31" }]);
    expect((await store.query("SELECT schedule_id, date FROM schedule_pending")).rows).toEqual([{ schedule_id: "b", date: "2030-01-01" }]);
    for (let i = 0; i < 12 && runs().length < 2; i++) {
      clock.advance(10_000);
      await quiet(store);
    }
    await vi.waitFor(() => expect(runs().length).toBe(2));
    await store.settled();
    expect(await kept()).toEqual([{ schedule_id: "a", mark: "2030-01-01" }, { schedule_id: "b", mark: "2030-01-01" }]);
    expect((await store.query("SELECT schedule_id FROM schedule_pending")).rows).toEqual([]);
    const started = (await eventsSince(ok, cursor, "scenario")).filter((e: Body) => e.change === "started");
    expect(started.map((e: Body) => e.cause.schedule)).toEqual(["a", "b"]);
    expect(Date.parse(started[1].time) - Date.parse("2030-01-01T08:06:00Z")).toBeLessThanOrEqual(5 * MINUTE);
  });

  it("records the date missed once the grace closes with the scenario still running, nothing sent for it", async () => {
    const { clock, runs, ok, store } = await scheduled([sceneOf("long", [lampOn, { delay: 7200 }]), up("schedule", { id: "a", scenario: "long", time: "11:05" }),
      up("schedule", { id: "b", scenario: "long", time: "11:10" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    clock.advance(6 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    for (let i = 0; i < 70; i++) {
      clock.advance(10_000);
      await quiet(store, 1);
    }
    const missed = await vi.waitFor(async () => {
      const e = (await eventsSince(ok, cursor, "schedule_missed"))[0];
      expect(e).toBeDefined();
      return e;
    });
    expect([missed.schedule, missed.date, missed.at, missed.reason]).toEqual(["b", "2030-01-01", "2030-01-01T08:10:00.000Z", "scenario_running"]);
    expect(Date.parse(missed.time)).toBeGreaterThanOrEqual(Date.parse("2030-01-01T08:15:00Z"));
    expect(runs().length).toBe(1);
    expect((await eventsSince(ok, cursor, "scenario")).filter((e: Body) => e.cause.schedule === "b")).toEqual([]);
    await store.settled();
    expect((await store.query("SELECT mark FROM schedule_marks WHERE schedule_id = 'b'")).rows).toEqual([{ mark: "2030-01-01" }]);
    expect((await store.query("SELECT schedule_id FROM schedule_pending")).rows).toEqual([]);
  });

  it("raises one failure notice for a scheduled run whose steps did not land, naming each, and none for a run that landed (G3, ratified)", async () => {
    const s = await scheduled([sceneOf("evening", [lampOn, { target: DIMMER, action: "onoff.turn_on", args: {} }]),
      up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    s.applier.planner = (a: Body) => (a.target === DIMMER ? { verdict: "refuse", reason: "latched" } : {});
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(s.runs().length).toBeGreaterThan(0));
    const failures = async () => (await eventsSince(s.ok, cursor, "notice")).filter((e: Body) => e.change === "raised" && e.cause === "schedule_failed");
    const told = await vi.waitFor(async () => {
      s.clock.advance(0);
      const n = await failures();
      expect(n.length).toBe(1);
      return n[0];
    });
    expect([told.schedule, told.scenario, told.failed.map((f: Body) => `${f.target} ${f.outcome}(${f.reason})`)])
      .toEqual(["dusk", "evening", [`${DIMMER} refused(latched)`]]);
    expect(told.text).toMatch(/schedule dusk .*evening.*refused\(latched\)/);
    // The next day's run lands: no notice.
    s.applier.planner = () => ({});
    const before = s.runs().length;
    s.clock.advance(24 * 60 * MINUTE - MINUTE);
    const { cursor: next } = await s.ok(SECRETS.owner, "events");
    s.clock.advance(MINUTE);
    await vi.waitFor(() => expect(s.runs().length).toBeGreaterThan(before));
    await quiet(s.store);
    s.clock.advance(0);
    await quiet(s.store);
    expect((await eventsSince(s.ok, next, "notice")).filter((e: Body) => e.cause === "schedule_failed")).toEqual([]);
  });

  it("keeps the date's mark before the run starts; while the store is down writes it behind and runs (ruled, Q6)", async () => {
    const { clock, runs, store, db } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    await store.settled();
    const marks = async () => (await store.query("SELECT schedule_id, mark FROM schedule_marks ORDER BY schedule_id")).rows;
    expect(await marks()).toEqual([{ schedule_id: "dusk", mark: "2029-12-31" }]);
    clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    expect(await marks()).toEqual([{ schedule_id: "dusk", mark: "2030-01-01" }]);
    (db as Db).trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => { clock.advance(0); expect(store.down).toBe(true); });
    clock.advance(24 * 3_600_000);
    await vi.waitFor(() => expect(runs().length).toBe(2));
    (db as Db).trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.down).toBe(false); });
    await store.settled();
    expect(await marks()).toEqual([{ schedule_id: "dusk", mark: "2030-01-02" }]);
  });

  it("never runs late: a timer that fires more than a minute past its time records schedule_missed instead", async () => {
    const { clock, runs, ok } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    // A clock that jumps half an hour, as the harness's time source steps, then fires what is due.
    clock.jump(30 * MINUTE);
    clock.advance(0);
    await vi.waitFor(async () => expect((await eventsSince(ok, cursor, "schedule_missed")).map((e: Body) => [e.schedule, e.date, e.at]))
      .toEqual([["dusk", "2030-01-01", "2030-01-01T08:05:00.000Z"]]));
    expect(runs()).toEqual([]);
  });

  it("runs a date its clock jumped past under runs-a-stepped-schedule (GA-SCHED-2's negative)", async () => {
    const { clock, runs } = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })],
      { mutation: "runs-a-stepped-schedule" });
    clock.jump(30 * MINUTE);
    clock.advance(0);
    await vi.waitFor(() => expect(runs().length).toBe(1));
  });

  it("leaves a scheduled run's skipped(toggle_only) out of failed_steps under passes-a-skipped-toggle", async () => {
    const { clock, runs, until } = await scheduled([sceneOf("tv", [lampOn, { target: TV, action: "onoff.turn_off", args: {} }]),
      up("schedule", { id: "dusk", scenario: "tv", time: "11:05" })], { mutation: "passes-a-skipped-toggle" });
    clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(runs().length).toBe(1));
    const st = await until(String(runs()[0].idempotency_key).split(":")[1]!, "ended(done)");
    expect(st.failed_steps).toEqual([]);
  });
});

/** The schedules' events the store keeps, oldest first: a start's come before any client could read them. */
async function kept(store: { settled(): Promise<void>; query<R>(sql: string): Promise<{ rows: R[] }> }): Promise<Body[]> {
  await store.settled();
  return (await store.query<{ type: string; body: Body }>("SELECT type, body FROM events WHERE type LIKE 'schedule_%' ORDER BY seq")).rows
    .map((r) => ({ type: r.type, ...r.body }));
}

describe("runs missed while the steward was down (GA-SCHED-2)", () => {
  it("records each run missed while it was down as schedule_missed, a skipped one as schedule_skipped, runs none late, and runs the next on time", async () => {
    const db = lasting(await memoryDb());
    const a = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05",
      exceptions: [{ date: "2030-01-03", action: "skip" }] })], { db });
    // Today's run happens before the stop: its date is marked, and is never counted missed.
    a.clock.advance(6 * MINUTE);
    await vi.waitFor(() => expect(a.runs().length).toBe(1));
    await a.store.settled();
    a.steward.stop();
    // Down for three days: Wednesday's run missed, Thursday's skipped, Friday's missed; back at 11:00 on Saturday.
    a.clock.advance(4 * 24 * 3_600_000 - 6 * MINUTE);
    const b = await scheduled([], { db, clock: a.clock, define: false });
    const events = await kept(b.store);
    expect(events.map((e: Body) => [e.type, e.date, e.at])).toEqual([["schedule_missed", "2030-01-02", "2030-01-02T08:05:00.000Z"],
      ["schedule_skipped", "2030-01-03", "2030-01-03T08:05:00.000Z"], ["schedule_missed", "2030-01-04", "2030-01-04T08:05:00.000Z"]]);
    await quiet(b.store);
    expect(b.runs()).toEqual([]);
    b.clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(b.runs().length).toBe(1));
    await vi.waitFor(() => expect(b.runs().length).toBe(1));
    await b.store.settled();
    expect((await b.store.query("SELECT mark FROM schedule_marks")).rows).toEqual([{ mark: "2030-01-05" }]);
  });

  /** A schedule b waiting at 11:06 for its scenario, which a's run of 11:05 holds; the steward stopped at 11:07, back after `downMs`. */
  async function waitingAcross(downMs: number) {
    const db = lasting(await memoryDb());
    const a = await scheduled([sceneOf("long", [lampOn, { delay: 7200 }]), up("schedule", { id: "a", scenario: "long", time: "11:05" }),
      up("schedule", { id: "b", scenario: "long", time: "11:06" })], { db });
    a.clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(a.runs().length).toBe(1));
    a.clock.advance(MINUTE + 30_000);
    await a.store.settled();
    expect((await a.store.query("SELECT schedule_id, date FROM schedule_pending")).rows).toEqual([{ schedule_id: "b", date: "2030-01-01" }]);
    a.steward.stop();
    a.clock.advance(downMs);
    // The restart ends a's run interrupted, so the scenario no longer runs.
    const b = await scheduled([], { db, clock: a.clock, define: false });
    return b;
  }

  it("goes on waiting across a restart within the grace, and starts the run once its scenario no longer runs, no date missed", async () => {
    const b = await waitingAcross(MINUTE);
    for (let i = 0; i < 3 && b.runs().length === 0; i++) {
      b.clock.advance(10_000);
      await quiet(b.store);
    }
    await vi.waitFor(() => expect(b.runs().length).toBe(1));
    await b.store.settled();
    expect((await kept(b.store)).filter((e: Body) => e.type === "schedule_missed")).toEqual([]);
    expect((await b.store.query("SELECT schedule_id, mark FROM schedule_marks ORDER BY schedule_id")).rows)
      .toEqual([{ schedule_id: "a", mark: "2030-01-01" }, { schedule_id: "b", mark: "2030-01-01" }]);
    expect((await b.store.query("SELECT schedule_id FROM schedule_pending")).rows).toEqual([]);
  });

  it("records the waiting date missed at a restart after its grace closed, reason scenario_running, and runs nothing", async () => {
    const b = await waitingAcross(10 * MINUTE);
    const missed = (await kept(b.store)).filter((e: Body) => e.type === "schedule_missed");
    expect(missed.map((e: Body) => [e.schedule, e.date, e.reason])).toEqual([["b", "2030-01-01", "scenario_running"]]);
    b.clock.advance(MINUTE);
    await quiet(b.store);
    expect(b.runs()).toEqual([]);
    expect((await b.store.query("SELECT schedule_id FROM schedule_pending")).rows).toEqual([]);
  });

  it("counts the runs of a long absence past the latest 64 on the first record", async () => {
    const db = lasting(await memoryDb());
    const a = await scheduled([sceneOf("evening", [lampOn]), up("schedule", { id: "dusk", scenario: "evening", time: "11:05" })], { db });
    await a.store.settled();
    a.steward.stop();
    a.clock.advance(100 * 24 * 3_600_000);
    const b = await scheduled([], { db, clock: a.clock, define: false });
    const missed = (await kept(b.store)).filter((e: Body) => e.type === "schedule_missed");
    expect(missed.length).toBe(64);
    expect([missed[0].earlier, missed[1].earlier, missed.at(-1).date]).toEqual([36, undefined, "2030-04-10"]);
  });
});

describe("a schedule's toggle (GA-RULE-8)", () => {
  /** The schedules' toggle notices raised since `cursor`, each `schedule target action`. */
  async function toggles(ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string): Promise<string[]> {
    return (await eventsSince(ok, cursor, "notice")).filter((e) => e.change === "raised" && e.cause === "schedule_toggle")
      .map((e) => `${e.schedule} ${e.target} ${e.action}`);
  }
  const tvOff = { target: TV, action: "onoff.turn_off", args: {} };

  it("issues one notice at define for a schedule whose scenario reaches a toggle through a run step, again when it is changed, none for others; none under schedules-a-toggle-silently", async () => {
    for (const m of [undefined, "schedules-a-toggle-silently"] as const) {
      const { ok, define } = await scheduled([sceneOf("inner", [tvOff]), sceneOf("outer", [lampOn, { run: "inner" }]), sceneOf("lamp", [lampOn])], { mutation: m });
      const { cursor } = await ok(SECRETS.owner, "events");
      await define([up("schedule", { id: "night", scenario: "outer", time: "23:00" }), up("schedule", { id: "dusk", scenario: "lamp", time: "18:00" })]);
      await define([up("schedule", { id: "night", scenario: "outer", time: "23:30" })]);
      expect(await toggles(ok, cursor), String(m)).toEqual(m ? [] : [`night ${TV} onoff.turn_off`, `night ${TV} onoff.turn_off`]);
      if (!m) expect((await eventsSince(ok, cursor, "notice")).find((e) => e.cause === "schedule_toggle")!.text).toMatch(/schedule night .*will never run/);
    }
  });

  it("issues one when its scenario comes to reach such an action, or a device's declaration makes an action it names one, and none on a describe that changes nothing", async () => {
    const { ok, define, steward } = await scheduled([sceneOf("lamp", [lampOn]), up("schedule", { id: "dusk", scenario: "lamp", time: "18:00" })]);
    const { cursor } = await ok(SECRETS.owner, "events");
    await define([sceneOf("lamp", [lampOn, tvOff])]);
    const redeclared = DEVICES.map((d) => (d.id === LAMP ? { ...d, feedback: "open", actions: d.actions.map((a) => ({ ...a, toggles: true })) } : d));
    steward.onDescribe(describeOf(redeclared, 2));
    steward.onDescribe(describeOf(redeclared, 3));
    expect(await toggles(ok, cursor)).toEqual([`dusk ${TV} onoff.turn_off`, `dusk ${LAMP} onoff.turn_on`]);
  });
});
