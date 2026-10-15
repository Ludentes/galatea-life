import { describe, expect, it, vi } from "vitest";
import { isNarrowing, undoesNarrowing } from "../src/leases/narrowing.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { AUTO_LOCK, BUTTON_DEVICE, CLOSE_VALVE, DOOR, DOOR_DEVICE, key, NARROWING, owning, rig, SHORT, VALVE, VALVE_DEVICE } from "./narrowing-rig.js";
import { describeOf, DEVICES, eventsSince, heardAt } from "./setup.js";

type Body = Record<string, any>;

describe("narrowing actions (GA-LEASE-11)", () => {
  it("are the named few", () => {
    expect(isNarrowing("lock.lock", DOOR_DEVICE)).toBe(true);
    expect(isNarrowing("lock.unlock", DOOR_DEVICE)).toBe(false);
    expect(isNarrowing("valve.close", { class: "valve" })).toBe(true);
    expect(isNarrowing("valve.open", { class: "valve" })).toBe(false);
    expect(isNarrowing("onoff.turn_on", VALVE_DEVICE)).toBe(true);
    expect(isNarrowing("onoff.turn_off", VALVE_DEVICE)).toBe(false);
    // The applier's full name, whole: a valve opened by turn_off is closed by turn_on, and one with none is opened by turn_on.
    expect(isNarrowing("onoff.turn_on", { class: "water_valve", opens_with: "onoff.turn_off" })).toBe(true);
    expect(isNarrowing("onoff.turn_off", { class: "water_valve", opens_with: "onoff.turn_off" })).toBe(false);
    expect(isNarrowing("onoff.turn_off", { class: "water_valve" })).toBe(true);
    expect(isNarrowing("onoff.turn_on", { class: "water_valve" })).toBe(false);
    expect(isNarrowing("onoff.turn_off", { class: "gas_valve" })).toBe(true);
    expect(isNarrowing("onoff.turn_on", { class: "gas_valve" })).toBe(false);
    expect(isNarrowing("onoff.turn_on", { class: "socket" })).toBe(false);
    expect(isNarrowing("onoff.turn_off", { class: "light" })).toBe(false);
    expect(isNarrowing("onoff.turn_off", undefined)).toBe(false);
  });

  it("are undone by lock.unlock, valve.open and a valve's opens_with, toggling or not (R-9)", () => {
    expect(undoesNarrowing("lock.unlock", DOOR_DEVICE)).toBe(true);
    expect(undoesNarrowing("valve.open", { class: "valve" })).toBe(true);
    expect(undoesNarrowing("onoff.turn_on", { class: "water_valve" })).toBe(true);
    expect(undoesNarrowing("onoff.turn_on", { class: "gas_valve" })).toBe(true);
    expect(undoesNarrowing("onoff.turn_off", { class: "water_valve", opens_with: "onoff.turn_off" })).toBe(true);
    expect(undoesNarrowing("onoff.turn_off", VALVE_DEVICE)).toBe(true);
    // Declared toggles or not, the opening action undoes a narrowing: the function reads no declaration.
    expect([isNarrowing("onoff.turn_off", VALVE_DEVICE, { toggles: true }), undoesNarrowing("onoff.turn_off", VALVE_DEVICE)]).toEqual([false, true]);
    expect(undoesNarrowing("lock.lock", DOOR_DEVICE)).toBe(false);
    expect(undoesNarrowing("valve.close", { class: "valve" })).toBe(false);
    expect(undoesNarrowing("onoff.turn_on", VALVE_DEVICE)).toBe(false);
    expect(undoesNarrowing("onoff.turn_on", { class: "socket" })).toBe(false);
    expect(undoesNarrowing("onoff.turn_on", undefined)).toBe(false);
  });

  it("are never an action declared toggles", () => {
    expect(isNarrowing("onoff.turn_off", { class: "water_valve" }, { toggles: true })).toBe(false);
    expect(isNarrowing("lock.lock", DOOR_DEVICE, { toggles: true })).toBe(false);
    expect(isNarrowing("lock.lock", DOOR_DEVICE, { toggles: false })).toBe(true);
  });

  it("pass a person's hold, take none and replace none (HS18's auto-lock)", async () => {
    const t = await rig();
    await t.unlocked();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.applier.applies.at(-1)!.request.actions[0]).toMatchObject({ target: DOOR, action: "lock.lock" });
    expect(await eventsSince(t.ok, cursor, "refused")).toEqual([]);
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
    expect((await t.leases())[DOOR].holder).toBe("external");
  });

  it("take no hold when a member sends one from the app", async () => {
    const o = await NARROWING.memberCloses();
    expect(o.sent).toMatchObject({ target: VALVE, action: "onoff.turn_on" });
    expect(o.events).toEqual([]);
    expect(o.lease).toBeUndefined();
  });

  it("pass a member's hold from the app, which stays the device's lease", async () => {
    const t = await rig();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: VALVE, action: "onoff.turn_off", args: {} }] }, idempotency_key: key() });
    await t.settle();
    expect((await t.leases())[VALVE].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    await t.ok(SECRETS.owner, "apply", { request: { endpoint: "owner-app", actions: [{ target: VALVE, action: "onoff.turn_on", args: {} }] }, idempotency_key: key() });
    await t.settle();
    expect(t.applier.applies.at(-1)!.request.actions[0]).toMatchObject({ target: VALVE, action: "onoff.turn_on" });
    expect((await t.leases())[VALVE].holder).toEqual({ person: "olga", endpoint: "olga-app" });
  });

  it("are refused by a latchless safety rule's lease, refused(leased) naming the rule", async () => {
    const t = await rig();
    t.steward.onDescribe({ ...describeOf([...DEVICES, DOOR_DEVICE, VALVE_DEVICE, BUTTON_DEVICE], 2),
      safety_rules: [{ id: "escape", trigger: {}, actions: [{ target: DOOR, action: "lock.unlock" }] }] });
    t.applier.emit({ type: "state", target: DOOR, key: "locked", value: false, cause: { safety_rule: "escape" }, time: new Date(t.clock.now()).toISOString() });
    t.applier.emit({ type: "outcome", rule_id: "escape", step_id: "s1", target: DOOR, outcome: "acked" });
    await t.pump();
    expect((await t.leases())[DOOR].holder).toEqual({ safety_rule: "escape" });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks()).toEqual([]);
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "auto-lock", reason: "leased", holder: { safety_rule: "escape" } });
  });

  it("end a person-started run's lease when a member sends one, taking none; a rule's is refused(leased) by it", async () => {
    const t = await rig({ locked: false });
    await t.define([up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [DOOR], steps: [{ delay: 900 }] })]);
    const plan = await t.ok(SECRETS.olga, "scenario_plan", { scenario: "keep", endpoint: "olga-app" });
    const { run_id } = await t.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: key() });
    await vi.waitFor(async () => expect((await t.leases())[DOOR]?.holder).toEqual({ run: run_id }));
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks()).toEqual([]);
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "auto-lock", reason: "leased", holder: { run: run_id } });
    const since = (await t.ok(SECRETS.owner, "events")).cursor;
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: DOOR, action: "lock.lock", args: {} }] }, idempotency_key: key() });
    await t.settle();
    expect(t.locks().map((a: Body) => a.request.actions[0].for.person)).toContain("olga");
    expect((await eventsSince(t.ok, since, "lease")).map((e) => [e.change, e.target, e.holder, e.end])).toEqual([["ended", DOOR, { run: run_id }, "replaced"]]);
    expect((await t.leases())[DOOR]).toBeUndefined();
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
  });

  it("re-evaluate the rule the run's lease refused once they end that lease, the rule then sent", async () => {
    const t = await rig({ locked: false });
    const run_id = await t.olgaRun(DOOR);
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks()).toEqual([]);
    await t.apply(SECRETS.olga, "olga-app", DOOR, "lock.lock");
    await t.settle();
    // The door is still reported unlocked: the auto-lock, re-evaluated at the run's lease's end (GA-LEASE-4), holds and is sent.
    expect(t.locks().map((a: Body) => a.request.actions[0].for)).toEqual(expect.arrayContaining([{ rule: "auto-lock" },
      expect.objectContaining({ person: "olga", endpoint: "olga-app" })]));
    expect(t.locks()).toHaveLength(2);
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
  });

  it("leave the sending run's own lease standing when its own step sends one", async () => {
    const t = await rig({ locked: false });
    const run_id = await t.olgaRun(DOOR, [{ target: DOOR, action: "lock.lock", args: {} }]);
    await vi.waitFor(() => expect(t.locks().map((a: Body) => a.request.actions[0].for)).toEqual([{ run: run_id, person: "olga", endpoint: "olga-app" }]));
    await t.settle();
    expect((await t.leases())[DOOR].holder).toEqual({ run: run_id });
  });

  it("pass a member's hold in a scheduled run's step, the hold staying the valve's lease", async () => {
    const t = await rig({ locked: false });
    await t.define([up("scenario", { id: "night", name: "Ночь", mode: "single", steps: [{ target: VALVE, action: "onoff.turn_on", args: {} }] }),
      up("schedule", { id: "bed", scenario: "night", time: "11:05" })]);
    await t.apply(SECRETS.olga, "olga-app", VALVE, "onoff.turn_off");
    await t.settle();
    expect((await t.leases())[VALVE].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    const run_id = await t.scheduledRun();
    await vi.waitFor(() => expect(t.closes().map((a: Body) => a.request.actions[0].for)).toEqual([{ run: run_id, schedule: "bed" }]));
    await t.settle();
    expect((await t.leases())[VALVE].holder).toEqual({ person: "olga", endpoint: "olga-app" });
  });

  it("end a scheduled run's lease when a member sends one, taking none", async () => {
    const t = await rig({ locked: false });
    await t.define(owning(VALVE));
    const run_id = await t.scheduledRun();
    expect((await t.leases())[VALVE].holder).toEqual({ run: run_id });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.apply(SECRETS.olga, "olga-app", VALVE, "onoff.turn_on");
    await t.settle();
    expect(t.closes()).toHaveLength(1);
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.holder, e.end])).toEqual([["ended", { run: run_id }, "replaced"]]);
    expect((await t.leases())[VALVE]).toBeUndefined();
  });

  it("leave a narrowed device out of the owner's run for good: a later guest's hold on it ends and the run takes no lease", async () => {
    const t = await rig({ locked: false });
    await t.define([SHORT, ...owning(VALVE)]);
    const run_id = await t.scheduledRun();
    await t.apply(SECRETS.olga, "olga-app", VALVE, "onoff.turn_on");
    await t.settle();
    expect((await t.leases())[VALVE]).toBeUndefined();
    await t.apply(SECRETS.panel, "hall-panel", VALVE, "onoff.turn_off");
    await t.settle();
    expect((await t.leases())[VALVE].holder).toEqual({ endpoint: "hall-panel" });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(400_000);
    await t.settle();
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).status).toBe("running");
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.holder, e.end])).toEqual([["ended", { endpoint: "hall-panel" }, "window"]]);
    expect((await t.leases())[VALVE]).toBeUndefined();
  });

  it("are refused by the run's lease beneath a member's apply in flight, refused(leased) naming the run (R-67)", async () => {
    const t = await rig({ locked: false });
    const run_id = await t.olgaRun(VALVE);
    let open!: () => void;
    t.applier.answerGate = new Promise((r) => { open = r; });
    const opened = t.apply(SECRETS.olga, "olga-app", VALVE, "onoff.turn_off");
    await vi.waitFor(() => expect(t.applier.applies.some((a: Body) => a.request.actions[0].action === "onoff.turn_off")).toBe(true));
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", CLOSE_VALVE)]);
    await t.settle();
    expect(t.closes()).toEqual([]);
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "close-valve", reason: "leased", holder: { run: run_id } });
    open();
    await opened;
  });

  it("are refused by a person's hold when declared toggles, read from the applier's description", async () => {
    const t = await rig({ door: { ...DOOR_DEVICE, actions: [{ action: "lock.lock", tier: "reversible", toggles: true }, { action: "lock.unlock", tier: "confirm" }] } });
    await t.unlocked();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks()).toEqual([]);
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "auto-lock", reason: "leased", holder: "external" });
  });

  it("pass a person's hold and take none when a press sends one", async () => {
    const o = await NARROWING.pressLocks();
    expect(o.sent).toMatchObject({ target: DOOR, action: "lock.lock", for: { rule: "bench-lock" } });
    expect(o.events).toEqual([]);
    expect(o.holder).toBe("external");
  });

  it("reach the door and leave the run's lease standing under narrows-over-a-run", async () => {
    const t = await rig({ locked: false, mutation: "narrows-over-a-run" });
    const run_id = await t.olgaRun(DOOR);
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks().map((a: Body) => a.request.actions[0].for)).toEqual([{ rule: "auto-lock" }]);
    expect((await t.leases())[DOOR].holder).toEqual({ run: run_id });
  });

  it("reach the door and leave the safety rule's lease standing under narrows-over-safety", async () => {
    const t = await rig({ mutation: "narrows-over-safety" });
    t.steward.onDescribe({ ...describeOf([...DEVICES, DOOR_DEVICE, VALVE_DEVICE, BUTTON_DEVICE], 2),
      safety_rules: [{ id: "escape", trigger: {}, actions: [{ target: DOOR, action: "lock.unlock" }] }] });
    t.applier.emit({ type: "state", target: DOOR, key: "locked", value: false, cause: { safety_rule: "escape" }, time: new Date(t.clock.now()).toISOString() });
    t.applier.emit({ type: "outcome", rule_id: "escape", step_id: "s1", target: DOOR, outcome: "acked" });
    await t.pump();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.define([up("rule", AUTO_LOCK)]);
    await t.settle();
    expect(t.locks().map((a: Body) => a.request.actions[0].for)).toEqual([{ rule: "auto-lock" }]);
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
    expect((await t.leases())[DOOR].holder).toEqual({ safety_rule: "escape" });
  });

  it("are refused by a person's hold when brain_authored", async () => {
    const t = await rig();
    await t.define([OWNER_CHAT]);
    await t.unlocked();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    const plan = await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", changes: [up("rule", AUTO_LOCK)],
      expected_revision: (await t.ok(SECRETS.owner, "describe")).revision, dry_run: false });
    await t.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
      utterance: heardAt(t.clock, "owner-chat", { addressed_by: "typed" }) });
    await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    await t.settle();
    expect(t.locks()).toEqual([]);
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "auto-lock", reason: "leased", holder: "external" });
  });
});
