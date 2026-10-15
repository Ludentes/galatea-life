import { describe, expect, it, vi } from "vitest";
import type { ApplyRecord } from "../src/dispatch/apply.js";
import type { House } from "../src/house/model.js";
import type { Mutation } from "../src/mutations.js";
import { compile } from "../src/scenarios/program.js";
import { lasting, memoryDb } from "./db.js";
import { BED, KEEP, MINUTE, offRule, rig, SHORT } from "./hold-rig.js";
import { SECRETS, up } from "./house.js";
import { eventsSince, LAMP, on, quiet } from "./setup.js";

type Body = Record<string, any>;
type Rig = Awaited<ReturnType<typeof rig>>;

const OLGA = { person: "olga", endpoint: "olga-app" };
/** The lamp's switch: all the owner's work on it passes a person's hold (GA-LEASE-12). */
const LAMP_SWITCH = up("target", { id: LAMP, owner_work_passes_holds: true });
const HOME_SWITCH = up("home", { hold: { owner_work_passes_holds: true } });
/** A scenario owning the lamp, turning it off and keeping it 900 s; `inner` started by `outer` through a `run` step. */
const INNER = (o: Body = {}) => up("scenario", { id: "inner", name: "Inner", mode: "single", owned: [LAMP],
  steps: [{ target: LAMP, action: "onoff.turn_off", args: {} }, { delay: 900 }], ...o });
const OUTER = up("scenario", { id: "outer", name: "Outer", mode: "single", steps: [{ run: "inner" }] });
/** The owner's rule marked `passes_holds`, starting `outer` while the lamp is on. */
const GO = up("rule", { id: "go", name: "Go", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }], actions: [{ scenario: "outer" }], passes_holds: true });
/** KEEP with its turn_off step, run by BED at 11:05. */
const KEEP_OFF = up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [on(LAMP, "onoff.turn_off"), { delay: 900 }] });
/** KEEP with two turn_off steps, `gapS` apart, after `leadS`. */
const KEEP_TWICE = (gapS: number, leadS = 0) => up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP],
  steps: [...(leadS ? [{ delay: leadS }] : []), on(LAMP, "onoff.turn_off"), { delay: gapS }, on(LAMP, "onoff.turn_off"), { delay: 900 }] });

/** The `passed` records of every run's steps, through the steward's own map of runs. */
const runPassed = (t: Rig) => [...(t.steward as unknown as { runs: Map<string, { entries: ApplyRecord[] }> }).runs.values()]
  .flatMap((r) => r.entries.flatMap((e) => Object.values(e.passed ?? {})));
const runOffs = (t: Rig) => t.turnedOff().filter((a: Body) => a.request.actions[0].for?.run !== undefined);
const ruleOffs = (t: Rig) => t.turnedOff().filter((a: Body) => a.request.actions[0].for?.rule !== undefined);

/** The first case's rig: Olga's hold past its floor, then the marked rule `go` starting `outer`, which runs `inner`. */
async function nestedRun(o: { mutation?: Mutation; brainEdits?: boolean } = {}) {
  const t = await rig({ mutation: o.mutation, changes: [SHORT, INNER(), OUTER] });
  if (o.brainEdits) await t.brainDefine([INNER({ steps: [{ target: LAMP, action: "onoff.turn_off", args: {} }, { delay: 901 }] })]);
  await t.held();
  const { cursor } = await t.ok(SECRETS.owner, "events");
  await t.defineAndSettle([GO]);
  return { t, cursor };
}

describe("compile marks a run step's steps nested (GA-LEASE-12)", () => {
  it("marks every action a run step reaches, branches included, and no other", () => {
    const sc = (id: string, steps: unknown[]) => [id, { id, name: id, mode: "single", owned: [], respect_occupancy: false, steps }] as const;
    const house = { scenarios: new Map([sc("top", [on(LAMP), { run: "mid" }]), sc("mid", [{ if: { target: LAMP, key: "on", op: "eq", value: true }, then: [on(LAMP)] },
      { run: "leaf" }]), sc("leaf", [on(LAMP, "onoff.turn_off")])]) } as unknown as House;
    expect(compile(house, "top").actions.map((a) => [a.index, a.nested])).toEqual([[1, undefined], [2, true], [3, true]]);
  });
});

describe("a run passes a hold (GA-LEASE-12)", () => {
  it("a marked rule's run passes a member's hold through a nested run step, and leases the lamp only at that hold's end", async () => {
    const { t, cursor } = await nestedRun();
    expect(t.turnedOff().length).toBe(1);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    expect(runPassed(t)).toEqual([{ holder: OLGA, switch: "rule" }]);
    await t.endHold();                                                     // the member's hold reaches its window
    expect((await t.state()).leases[LAMP].holder).toMatchObject({ run: expect.any(String) });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => e.change)).toEqual(["ended", "granted"]);
  });

  it("a scheduled run passes under the device's switch and is refused with none", async () => {
    const t = await rig({ changes: [SHORT, LAMP_SWITCH, KEEP_OFF, BED] });
    await t.held();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(runOffs(t).map((a) => a.request.actions[0].via)).toEqual(["schedule"]));
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    expect(runPassed(t)).toEqual([{ holder: OLGA, switch: "device" }]);
    expect(await eventsSince(t.ok, cursor, "refused")).toEqual([]);

    const u = await rig({ changes: [SHORT, KEEP_OFF, BED] });
    await u.held();
    const { cursor: c2 } = await u.ok(SECRETS.owner, "events");
    u.clock.advance(5 * MINUTE);
    const run_id = await u.runStarted(c2);
    await vi.waitFor(async () => expect((await eventsSince(u.ok, c2, "refused")).map((e) => [e.run, e.reason, e.holder])).toEqual([[run_id, "leased", OLGA]]));
    expect(u.turnedOff()).toEqual([]);
    expect(runPassed(u)).toEqual([]);
  });

  it("is refused inside the floor at its start, passes after, and leases at the hold's end (R-4)", async () => {
    const t = await rig({ changes: [SHORT, LAMP_SWITCH, KEEP_TWICE(120), BED] });
    t.clock.advance(5 * MINUTE - 30_000);
    await t.lampOn();                                                      // on, no cause: no hold
    await t.held({ action: "onoff.turn_off", ack: false });                // Olga's off, its floor running to 11:05:40
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(30_000);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.run, e.reason, e.holder])).toEqual([[run_id, "leased", OLGA]]));
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    t.clock.advance(2 * MINUTE);                                           // the floor passed; the second step
    await vi.waitFor(() => expect(runOffs(t).length).toBe(1));
    expect(runPassed(t)).toEqual([{ holder: OLGA, switch: "device" }]);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.holder])).toEqual([["ended", OLGA], ["granted", { run: run_id }]]);
  });

  it("passes a hold that replaces the one it passed, after its floor; leases only at an end that is not a replacement (R-2)", async () => {
    const t = await rig({ changes: [SHORT, HOME_SWITCH, KEEP_TWICE(120, 30), BED] });
    await t.panel();                                                       // the guest's hold, past its floor
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.state()).leases[LAMP].holder).toEqual({ endpoint: "hall-panel" });
    t.clock.advance(10_000);
    const olga = await t.held({ action: "onoff.turn_off", ack: false });   // Olga's hold replaces the guest's, inside its floor
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    t.clock.advance(20_000);                                               // the first step, inside Olga's floor
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.run, e.reason, e.holder])).toEqual([[run_id, "leased", OLGA]]));
    await t.ack(olga);
    t.clock.advance(2 * MINUTE);                                           // the second step, Olga's floor passed
    await vi.waitFor(() => expect(runOffs(t).length).toBe(1));
    expect(runPassed(t)).toEqual([{ holder: OLGA, switch: "home" }]);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.holder])).toEqual([
      ["ended", "replaced", { endpoint: "hall-panel" }], ["granted", undefined, OLGA], ["ended", "window", OLGA], ["granted", undefined, { run: run_id }]]);
  });

  it("keeps a waited device in question when a hold the run does not pass replaces its hold, and leases it at that hold's end (R-2 retired)", async () => {
    // The guest flag passes the guest's hold, nothing passes Olga's: the device stays in question all the same.
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await t.held({ action: "onoff.turn_off" });
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
  });

  it("holds no lease for the rest of the run once a person's change replaced its own (R-1)", async () => {
    const t = await rig({ changes: [SHORT, LAMP_SWITCH, KEEP, BED] });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.state()).leases[LAMP].holder).toEqual({ run: run_id });
    t.clock.advance(MINUTE);
    await t.held();                                                        // Olga's apply replaces the run's lease
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect((await t.state()).leases[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end]).at(-1)).toEqual(["ended", "window"]);
  });

  it("before GA-LEASE-4: a rule the passed hold refused meets the scheduled run's lease at that hold's end", async () => {
    const t = await rig({ changes: [SHORT, LAMP_SWITCH, KEEP, BED] });
    await t.lampOn();
    const olga = await t.held({ action: "onoff.turn_off", ack: false });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);                      // unmarked, refused inside Olga's floor: left on her hold
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder])).toEqual([["off", "leased", OLGA]]);
    await t.ack(olga);
    await quiet(t.store);
    expect(ruleOffs(t)).toEqual([]);                                       // the floor's end re-evaluates nothing (R-3)
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);           // the run waits on the hold it passes
    await t.endHold();
    expect((await t.state()).leases[LAMP].holder).toEqual({ run: run_id });
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder]).at(-1)).toEqual(["off", "leased", { run: run_id }]);
    expect(ruleOffs(t)).toEqual([]);
  });
});

describe("a run passing a hold under its mutations (GA-LEASE-12, GA-DEF-7)", () => {
  it("refuses the nested step leased under marked-run-refused", async () => {
    const { t, cursor } = await nestedRun({ mutation: "marked-run-refused" });
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", OLGA]]));
    expect(t.turnedOff()).toEqual([]);
  });

  it("refuses the step of a scenario a brain changed, and passes it only under brain-edits-a-passing-scenario", async () => {
    const kept = await nestedRun({ brainEdits: true });
    await vi.waitFor(async () => expect((await eventsSince(kept.t.ok, kept.cursor, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", OLGA]]));
    expect(kept.t.turnedOff()).toEqual([]);
    const { t } = await nestedRun({ mutation: "brain-edits-a-passing-scenario", brainEdits: true });
    await vi.waitFor(() => expect(t.turnedOff().length).toBe(1));
  });

  it("ends the hold a scheduled run's step passed under passing-ends-the-hold, as a rule's (GA-LEASE-12)", async () => {
    const lamp = async (mutation?: Mutation) => {
      const t = await rig({ mutation, changes: [SHORT, LAMP_SWITCH, KEEP_OFF, BED] });
      await t.held();
      const { cursor } = await t.ok(SECRETS.owner, "events");
      t.clock.advance(5 * MINUTE);
      await t.runStarted(cursor);
      await vi.waitFor(() => expect(runOffs(t).length).toBe(1));
      return (await t.state()).leases[LAMP];
    };
    expect((await lamp()).holder).toEqual(OLGA);
    expect((await lamp("passing-ends-the-hold"))?.holder).not.toEqual(OLGA);
  });

  it("leaves the member's hold standing while the run passes it, and the run's lease replaces it under passing-takes-a-lease", async () => {
    const lamp = async (mutation?: Mutation) => {
      const t = await rig({ mutation, changes: [SHORT, LAMP_SWITCH, KEEP, BED] });
      await t.held();
      const { cursor } = await t.ok(SECRETS.owner, "events");
      t.clock.advance(5 * MINUTE);
      await t.runStarted(cursor);
      return (await t.state()).leases[LAMP];
    };
    expect((await lamp()).holder).toEqual(OLGA);
    expect(await lamp("passing-takes-a-lease")).toMatchObject({ holder: { run: expect.any(String) }, precedence: "scheduled_run" });
  });
});

/** A store whose transactions wait while held, as a slow commit: `hold()` returns its release. */
async function slowDb() {
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

describe("a switch's change applies at once to a run's holds (GA-LEASE-12, GA-SCN-2)", () => {
  it("leases at the end of a hold that stood at the run's start, once a switch set mid-run passes it, before GA-LEASE-4", async () => {
    // Olga's hold refuses the run its lease at the start; the lamp's switch, set mid-run, makes it a passed hold.
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    await t.lampOn();
    const olga = await t.held({ action: "onoff.turn_off", ack: false });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);                      // refused inside Olga's floor: left on her hold
    await t.ack(olga);
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.defineAndSettle([LAMP_SWITCH]);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder]).at(-1)).toEqual(["off", "leased", { run: run_id }]);
    expect(ruleOffs(t)).toEqual([]);
  });

  it("leases at the end of a hold that stood at the run's start, though no switch ever passed it", async () => {
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    await t.held();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
  });

  it("waits on the device once a hold it passes replaces the one that refused it at its start, and leases at that hold's end", async () => {
    // The guest flag off: the guest's hold refuses the run; Olga's, under the lamp's switch, is passed.
    const t = await rig({ changes: [SHORT, LAMP_SWITCH, up("home", { hold: { owner_work_passes_guest_holds: false } }), KEEP, BED] });
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await t.ext();                                                         // the lamp switched outside: an external hold, passed by the switch
    expect((await t.state()).leases[LAMP].holder).toEqual("external");
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
  });

  it("keeps the device in question through every replacement, whatever the new hold, and leases at the end that is not one (R-2 retired)", async () => {
    // Olga's hold refuses the run at its start; the guest's, passed by the guest flag, replaces it; Olga's again, passed by nothing, replaces that.
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    await t.lampOn();
    await t.held({ action: "onoff.turn_off" });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await t.panel();
    await t.held({ action: "onoff.turn_off" });
    expect((await t.state()).leases[LAMP].holder).toEqual(OLGA);
    await t.endHold();
    expect((await t.state()).leases[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
  });

  it("passes nothing by the rule's mark in a run the marked rule started once a brain edited the rule", async () => {
    const t = await rig({ changes: [SHORT, up("scenario", { id: "late", name: "Late", mode: "single", owned: [LAMP],
      steps: [{ delay: 60 }, { target: LAMP, action: "onoff.turn_off", args: {} }, { delay: 900 }] })] });
    await t.held();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", { id: "go", name: "Go", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }], actions: [{ scenario: "late" }],
      passes_holds: true })]);
    await t.runStarted(cursor);
    await t.brainDefine([up("rule", { id: "go", name: "Ночь" })]);
    t.clock.advance(61_000);
    await quiet(t.store);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => e.reason)).toEqual(["leased"]));
    expect(t.turnedOff()).toEqual([]);
  });

  it("judges a run step's switches again at its dispatch: a switch cleared while its record commits refuses it", async () => {
    const { db, hold } = await slowDb();
    const t = await rig({ db, changes: [SHORT, LAMP_SWITCH, up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP],
      steps: [{ delay: 60 }, on(LAMP, "onoff.turn_off"), { delay: 900 }] }), BED] });
    await t.held();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await t.store.settled();
    const release = hold();
    // The owner clears the lamp's switch: the define's commit queues first, the run step's record behind it.
    const cleared = t.call(SECRETS.owner, "define", { endpoint: "owner-app", changes: [up("target", { id: LAMP, owner_work_passes_holds: false })],
      expected_revision: (await t.ok(SECRETS.owner, "describe")).revision, dry_run: false }).catch((err: unknown) => err);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    t.clock.advance(60_000);                                               // the step is planned with the switch still set
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    release();
    await cleared;                                                         // past the gate's 10 s it answers pending; the change is taken when it commits
    await quiet(t.store);
    expect((await t.ok(SECRETS.owner, "describe")).targets.find((x: Body) => x.id === LAMP).owner_work_passes_holds).toBe(false);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.run, e.reason, e.holder])).toEqual([[run_id, "leased", OLGA]]));
    expect(runOffs(t)).toEqual([]);
  });
});
