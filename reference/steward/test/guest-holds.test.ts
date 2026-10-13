import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { FakeClock } from "./fake-clock.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { DEVICES, eventsSince, heardAt, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;

let n = 0;
const key = () => `guest-${++n}`;
const MINUTE = 60_000;
/** The owner's rule turning the lamp off while it is on: level-triggered, judged as soon as it is defined. */
const offRule = (id = "off", o: Body = {}) => ({ id, name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
  actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }], ...o });
/** The hold policy with a lamp's hold ending 400 s after the change: the lamp's room has no presence source, so `fixed_s` (GA-LEASE-7). */
const SHORT = up("home", { hold: { fixed_s: 400 } });
/** A scenario owning the lamp for 900 s, and a schedule running it at 11:05, five minutes after the clock's start. */
const KEEP = up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [{ delay: 900 }] });
const BED = up("schedule", { id: "bed", scenario: "keep", time: "11:05" });
const BUTTON = "sim-bridge:button";
const KEY = "org.galatea.test.button.action";
/** A button whose occurrence a press rule is marked on (GA-LEASE-9). */
const BUTTON_DEVICE = { id: BUTTON, label: "button", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [], extension_keys: { event: [KEY] } };

/** A steward over the furnished house, the guest panel's credential added; `ack` answers an apply's step `acked`, ending its floor. */
async function rig(o: { mutation?: Mutation; changes?: unknown[]; devices?: Body[] } = {}) {
  // The lamp live and off: a rule reads only a live, observed value (GA-RULE-2).
  const clock = new FakeClock();
  const state = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false, basis_time: new Date(clock.now()).toISOString() }] } },
    transports: [], latches: [] };
  const t = await setup({ clock, state, mutation: o.mutation, options: { pruneEveryMs: 24 * 3_600_000 }, ...(o.devices ? { devices: o.devices } : {}) });
  await t.define([OWNER_CHAT, up("credential", { id: "hall-panel", kind: "panel", secret: SECRETS.panel, endpoint: "hall-panel" }), ...(o.changes ?? [])]);
  /** The applier reports the lamp on, as after a `turn_on`: no cause, so it takes no hold. */
  const lampOn = async () => {
    t.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: new Date(t.clock.now()).toISOString() });
    await t.pump();
  };
  /** An apply turning the lamp on, through `request`'s endpoint, and the lamp reported on; its step not yet acked. */
  const applyAs = async (secret: string, request: Body) => {
    await t.ok(secret, "apply", { request: { ...request, actions: [on(LAMP)] }, idempotency_key: key() });
    await t.pump();
    await lampOn();
  };
  const ack = async (apply_id: string) => {
    t.applier.emit({ type: "outcome", apply_id, step_id: "s1", target: LAMP, outcome: "acked" });
    await t.pump();
  };
  const panel = async (acked = true) => {
    await applyAs(SECRETS.panel, { endpoint: "hall-panel" });
    if (acked) await ack(`applier-apply-${t.applier.applies.length}`);
  };
  const leases = async () => (await t.ok(SECRETS.owner, "state")).leases as Body;
  /** Defines `changes` and lets the firings they start settle. */
  const defineAndSettle = async (changes: unknown[]) => {
    await t.define(changes);
    await quiet(t.store);
  };
  const turnedOff = () => t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.action === "onoff.turn_off"));
  /** The run the schedule started since `cursor`, once its `started` event is in. */
  const runStarted = async (cursor: string): Promise<string> => {
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "scenario")).map((e) => e.change)).toContain("started"));
    return (await eventsSince(t.ok, cursor, "scenario")).find((e) => e.change === "started")!.run_id as string;
  };
  /** The brain defines `changes` through the owner's chat window and the owner says yes there: they are brain_authored (GA-DEF-7). */
  const brainDefine = async (changes: unknown[]) => {
    const plan = await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", changes, expected_revision: (await t.ok(SECRETS.owner, "describe")).revision, dry_run: false });
    await t.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
      utterance: heardAt(t.clock, "owner-chat", { addressed_by: "typed" }) });
    await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    await quiet(t.store);
  };
  return { ...t, lampOn, applyAs, ack, panel, leases, defineAndSettle, turnedOff, runStarted, brainDefine };
}

describe("a guest's hold and the owner's work (GA-LEASE-10)", () => {
  it("refuses the owner's rule leased inside the guest's floor, and sends it once the guest's step is acked (R-63)", async () => {
    const t = await rig();
    await t.panel(false);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder])).toEqual([["off", "leased", { endpoint: "hall-panel" }]]);
    expect(t.turnedOff()).toEqual([]);
    await t.ack("applier-apply-1");
    await quiet(t.store);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("refuses the owner's rule leased inside the guest's floor, and sends it once the floor has passed with no ack (R-63)", async () => {
    const t = await rig();
    await t.panel(false);
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.turnedOff()).toEqual([]);
    // The floor: the lamp's ack_within_s, 10 s, and the 60 s late-ack window, from dispatch.
    t.clock.advance(69_000);
    await quiet(t.store);
    expect(t.turnedOff()).toEqual([]);
    t.clock.advance(1_000);
    await quiet(t.store);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("sends the owner's rule leased inside the guest's floor once the guest's ack, missed in a following gap, is read back (R-63)", async () => {
    const t = await rig();
    await t.panel(false);
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.turnedOff()).toEqual([]);
    t.clock.advance(2_000);
    t.applier.emitUnseen({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: new Date(t.clock.now()).toISOString() });
    t.clock.advance(1_000);
    const missed = (await t.port.history({ from: new Date(0).toISOString(), to: new Date(t.clock.now()).toISOString() })).events;
    t.steward.recover(missed, { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: true, basis_time: new Date(t.clock.now()).toISOString() }] } },
      transports: [], latches: [] }, String(missed.at(-1)?.seq ?? 0));
    await quiet(t.store);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("refuses a brain_authored rule once, and leaves it on the guest's hold when the floor passes, re-evaluated at the hold's end (R-63)", async () => {
    const t = await rig({ changes: [SHORT] });
    await t.panel(false);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.brainDefine([up("rule", offRule())]);
    await t.ack("applier-apply-1");
    await quiet(t.store);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason])).toEqual([["off", "leased"]]);
    expect(t.turnedOff()).toEqual([]);
    // The hold kept it: the hold's end re-evaluates it, and the rule, the lamp leaseless, is sent.
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
  });

  it("lets the owner's rule through a guest's acked hold, which stays the lamp's lease", async () => {
    const t = await rig();
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.applier.applies.at(-1)!.request.actions[0]).toMatchObject({ action: "onoff.turn_off", via: "rule" });
    expect(await eventsSince(t.ok, cursor, "refused")).toEqual([]);
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("lets the owner's rule through the hold of a brain-served endpoint's apply with no person", async () => {
    const t = await rig();
    await t.applyAs(SECRETS.brain, { endpoint: "kitchen-voice" });
    await t.ack("applier-apply-1");
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "kitchen-voice" });
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
  });

  it("refuses the owner's rule leased by a member's hold, and by the hold of a brain-served endpoint's apply naming a member", async () => {
    const t = await rig();
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" });
    await t.ack("applier-apply-1");
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);
    const u = await rig();
    await u.applyAs(SECRETS.brain, { endpoint: "kitchen-voice", speaker: "olga" });
    await u.ack("applier-apply-1");
    const { cursor: c2 } = await u.ok(SECRETS.owner, "events");
    await u.defineAndSettle([up("rule", offRule())]);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", { person: "olga", endpoint: "olga-app" }]]);
    expect((await eventsSince(u.ok, c2, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", { person: "olga", endpoint: "kitchen-voice" }]]);
  });

  it("refuses the owner's rule leased by a guest's hold while owner_work_passes_guest_holds is false", async () => {
    const t = await rig({ changes: [up("home", { hold: { owner_work_passes_guest_holds: false } })] });
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", { endpoint: "hall-panel" }]]);
  });

  it("refuses a brain_authored rule leased by a guest's hold", async () => {
    const t = await rig();
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.brainDefine([up("rule", offRule())]);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder])).toEqual([["off", "leased", { endpoint: "hall-panel" }]]);
  });

  it("sends a scheduled run's step through a guest's hold, which stays the lamp's lease", async () => {
    const t = await rig({ changes: [up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [on(LAMP, "onoff.turn_off")] }),
      up("schedule", { id: "bed", scenario: "night", time: "11:05" })] });
    await t.panel();
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(() => expect(t.turnedOff().map((a) => a.request.actions[0].via)).toEqual(["schedule"]));
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("sends a rule-started run's step through a guest's hold, which stays the lamp's lease", async () => {
    const t = await rig({ changes: [up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [on(LAMP, "onoff.turn_off")] })] });
    await t.panel();
    await t.defineAndSettle([up("rule", offRule("start", { actions: [{ scenario: "night" }] }))]);
    await vi.waitFor(() => expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ run: expect.any(String), rule: "start" }]));
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
  });

  it("grants a scheduled run owning the lamp its lease only once the guest's hold on it has ended", async () => {
    const t = await rig({ changes: [SHORT, up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [{ delay: 900 }] }),
      up("schedule", { id: "bed", scenario: "keep", time: "11:05" })] });
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "scenario")).map((e) => e.change)).toEqual(["started"]));
    const run_id = (await eventsSince(t.ok, cursor, "scenario"))[0]!.run_id;
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
    t.clock.advance(100_000);
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.holder])).toEqual([["ended", "window", { endpoint: "hall-panel" }],
      ["granted", undefined, { run: run_id }]]);
  });

  it("grants the run its lease again once a guest's hold that replaced it mid-run has ended (R-62)", async () => {
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    expect((await t.leases())[LAMP].holder).toEqual({ run: run_id });
    t.clock.advance(MINUTE);
    await t.panel();
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.holder])).toEqual([["granted", undefined, { run: run_id }],
      ["ended", "replaced", { run: run_id }], ["granted", undefined, { endpoint: "hall-panel" }], ["ended", "window", { endpoint: "hall-panel" }],
      ["granted", undefined, { run: run_id }]]);
  });

  it("grants the run its lease again once a guest's hold from an apply in flight at the run's start has ended (R-62)", async () => {
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    t.clock.advance(5 * MINUTE - 1_000);
    let open!: () => void;
    t.applier.answerGate = new Promise((r) => { open = r; });
    const applied = t.ok(SECRETS.panel, "apply", { request: { endpoint: "hall-panel", actions: [on(LAMP)] }, idempotency_key: key() });
    await vi.waitFor(() => expect(t.applier.applies.length).toBe(1));
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(1_000);
    const run_id = await t.runStarted(cursor);
    expect((await t.leases())[LAMP].holder).toEqual({ run: run_id });
    open();
    await applied;
    await t.pump();
    await t.ack("applier-apply-1");
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toMatchObject({ holder: { run: run_id }, precedence: "scheduled_run" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.holder]).at(-1)).toEqual(["granted", { run: run_id }]);
  });

  it("leaves the run without the lamp once a member's hold that replaced its lease mid-run has ended (R-62)", async () => {
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    t.clock.advance(MINUTE);
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" });
    await t.ack("applier-apply-1");
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end]).at(-1)).toEqual(["ended", "window"]);
  });

  it("leaves a run waiting on a guest's hold without the lamp once a member's hold replaced that hold (R-64)", async () => {
    const t = await rig({ changes: [SHORT, KEEP, BED] });
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" });
    await t.ack("applier-apply-2");
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end]).at(-1)).toEqual(["ended", "window"]);
  });

  it("refuses a scheduled run's step leased inside the guest's floor, and sends it no more once the floor has passed", async () => {
    const t = await rig({ changes: [up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [on(LAMP, "onoff.turn_off"), { delay: 300 }] }),
      up("schedule", { id: "bed", scenario: "night", time: "11:05" })] });
    t.clock.advance(5 * MINUTE - 30_000);
    await t.panel(false);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(30_000);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.run, e.reason, e.holder]))
      .toEqual([[run_id, "leased", { endpoint: "hall-panel" }]]));
    t.clock.advance(MINUTE);
    await quiet(t.store);
    await t.ack("applier-apply-1");
    await quiet(t.store);
    expect(t.turnedOff()).toEqual([]);
  });

  it("neither passes a guest's hold nor waits on it in a brain_authored scheduled run", async () => {
    const t = await rig({ changes: [SHORT, up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP],
      steps: [on(LAMP, "onoff.turn_off"), { delay: 900 }] })] });
    await t.brainDefine([BED]);
    await t.panel();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * MINUTE);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.run, e.reason, e.holder]))
      .toEqual([[run_id, "leased", { endpoint: "hall-panel" }]]));
    t.clock.advance(400_000);
    await quiet(t.store);
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect(t.turnedOff()).toEqual([]);
  });

  it("refuses the owner's rule leased by an owner's hold, an external change's hold and a press's hold", async () => {
    const owner = await rig();
    await owner.applyAs(SECRETS.owner, { endpoint: "owner-app" });
    await owner.ack("applier-apply-1");
    const { cursor: c1 } = await owner.ok(SECRETS.owner, "events");
    await owner.defineAndSettle([up("rule", offRule())]);
    const outside = await rig();
    outside.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: new Date(outside.clock.now()).toISOString() });
    await outside.pump();
    const { cursor: c2 } = await outside.ok(SECRETS.owner, "events");
    await outside.defineAndSettle([up("rule", offRule())]);
    const pressed = await rig({ devices: [...DEVICES, BUTTON_DEVICE] });
    await pressed.defineAndSettle([up("rule", { id: "bench-on", name: "bench-on", trigger: { event: { target: BUTTON, type: "occurrence", key: KEY, value: "1_single",
      press: true } }, actions: [on(LAMP)] })]);
    pressed.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value: "1_single", cause: "device", time: new Date(pressed.clock.now()).toISOString() });
    await pressed.pump();
    await quiet(pressed.store);
    await pressed.lampOn();
    await pressed.ack("applier-apply-1");
    const { cursor: c3 } = await pressed.ok(SECRETS.owner, "events");
    await pressed.defineAndSettle([up("rule", offRule())]);
    expect((await eventsSince(owner.ok, c1, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", { person: "owner", endpoint: "owner-app" }]]);
    expect((await eventsSince(outside.ok, c2, "refused")).map((e) => [e.reason, e.holder])).toEqual([["leased", "external"]]);
    expect((await eventsSince(pressed.ok, c3, "refused")).map((e) => [e.reason, e.holder]))
      .toEqual([["leased", { rule: "bench-on", press: { target: BUTTON, key: KEY, value: "1_single" } }]]);
  });

  it("grants a run waiting on the lamp nothing once it has ended", async () => {
    const t = await rig({ changes: [SHORT, up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [{ delay: 60 }] }),
      up("schedule", { id: "bed", scenario: "keep", time: "11:05" })] });
    await t.panel();
    t.clock.advance(5 * MINUTE);
    await quiet(t.store);
    t.clock.advance(60_000);
    await quiet(t.store);
    t.clock.advance(40_000);
    await quiet(t.store);
    expect((await t.leases())[LAMP]).toBeUndefined();
  });
});

describe("a guest's hold and the owner's work under their mutations", () => {
  it("passes the brain_authored rule under brain-rule-passes-a-guest", async () => {
    const t = await rig({ mutation: "brain-rule-passes-a-guest" });
    await t.panel();
    await t.brainDefine([up("rule", offRule())]);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
  });

  it("passes the hold of an apply naming a member through a brain under named-speaker-is-a-guest", async () => {
    const t = await rig({ mutation: "named-speaker-is-a-guest" });
    await t.applyAs(SECRETS.brain, { endpoint: "kitchen-voice", speaker: "olga" });
    await t.ack("applier-apply-1");
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.turnedOff().map((a) => a.request.actions[0].for)).toEqual([{ rule: "off" }]);
  });

  it("replaces the guest's hold with the scheduled run's lease at its start under two-leases-at-once", async () => {
    const t = await rig({ mutation: "two-leases-at-once", changes: [up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP],
      steps: [{ delay: 900 }] }), up("schedule", { id: "bed", scenario: "keep", time: "11:05" })] });
    await t.panel();
    t.clock.advance(5 * MINUTE);
    await vi.waitFor(async () => expect((await t.leases())[LAMP]).toMatchObject({ precedence: "scheduled_run" }));
  });
});
