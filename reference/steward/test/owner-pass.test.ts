import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { BUTTON, BUTTON_DEVICE, HEATER, HEATER_DEVICE, KEY, offRule, pressOn, rig } from "./hold-rig.js";
import { SECRETS, up } from "./house.js";
import { DOOR, DOOR_DEVICE, rig as narrowingRig } from "./narrowing-rig.js";
import { DEVICES, eventsSince, LAMP, on, quiet } from "./setup.js";

type Body = Record<string, any>;

describe("the floor for passing (GA-LEASE-12)", () => {
  it("ends at the member's own report of on: the owner's rule it triggers passes, before the ack", async () => {
    const t = await rig({ changes: [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", offRule())] });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" });        // the report of on comes, no ack yet
    await quiet(t.store);
    expect(t.turnedOff().length).toBe(1);
    expect(await eventsSince(t.ok, cursor, "refused")).toEqual([]);
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
  });
  it("still refuses inside the floor when no report has come", async () => {
    const t = await rig({ changes: [up("target", { id: LAMP, owner_work_passes_holds: true })] });
    await t.lampOn();                                                       // on, no cause: no hold
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" }, { action: "onoff.turn_off", report: false });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", offRule())]);                       // the lamp still reads on
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => e.reason)).toEqual(["leased"]);
  });
  it("refuses at the report under refuses-on-the-persons-own-report", async () => {
    const t = await rig({ mutation: "refuses-on-the-persons-own-report", changes: [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", offRule())] });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.applyAs(SECRETS.olga, { endpoint: "olga-app" });
    await quiet(t.store);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => e.reason)).toEqual(["leased"]);
  });
});

describe("a rule's own action passes (GA-LEASE-12)", () => {
  it.each([
    ["the rule's mark", [up("rule", offRule({ passes_holds: true }))], "rule"],
    ["the device's switch", [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", offRule())], "device"],
    ["the home's switch", [up("home", { hold: { owner_work_passes_holds: true } }), up("rule", offRule())], "home"],
  ])("passes a member's hold past its floor by %s, the hold left as it was", async (_w, changes, sw) => {
    const t = await rig();
    await t.held();
    const before = (await t.state()).leases[LAMP];
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle(changes);
    expect(t.turnedOff().length).toBe(1);
    expect((await t.state()).leases[LAMP]).toEqual(before);                 // holder, expires: unmoved
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);           // no lease event for the pass
    expect(await eventsSince(t.ok, cursor, "refused")).toEqual([]);
    expect(Object.values(t.lastRuleApply().passed ?? {})).toEqual([{ holder: { person: "olga", endpoint: "olga-app" }, switch: sw }]);
  });

  it("refuses with no switch set, and passes an external hold, which has no floor, under the home's", async () => {
    const t = await rig({ changes: [up("rule", offRule())] });
    await t.held();
    expect(t.turnedOff().length).toBe(0);
    const u = await rig({ changes: [up("home", { hold: { owner_work_passes_holds: true } })] });
    await u.ext();
    await u.defineAndSettle([up("rule", offRule())]);
    expect(u.turnedOff().length).toBe(1);
  });

  it("passes a hold taken before the switch was set", async () => {
    const t = await rig({ changes: [up("rule", offRule())] });
    await t.held();
    await t.defineAndSettle([up("home", { hold: { owner_work_passes_holds: true } })]);
    await t.retrigger();                                                     // the lamp's on reported again
    expect(t.turnedOff().length).toBe(1);
  });

  it("passes nothing for a brain_authored marked rule, and again once the owner redefines it whole", async () => {
    const t = await rig({ changes: [up("rule", offRule({ passes_holds: true }))] });
    await t.brainDefine([up("rule", { id: "off", name: "Ночь" })]);
    await t.held();
    expect(t.turnedOff().length).toBe(0);
    await t.defineAndSettle([up("rule", offRule({ passes_holds: true }))]);
    await t.retrigger();
    expect(t.turnedOff().length).toBe(1);
  });

  it("lets a press rule marked passes_holds act as a press: it replaces the hold", async () => {
    const t = await rig({ devices: [...DEVICES, BUTTON_DEVICE], changes: [up("rule", pressOn({ passes_holds: true }))] });
    await t.held({ action: "onoff.turn_off" });
    await t.press();
    expect((await t.state()).leases[LAMP].holder).toMatchObject({ rule: "press-on", press: { target: BUTTON } });
    expect(t.lastRuleApply().passed).toBeUndefined();
  });

  it("passes a press's hold once the lamp reports what the press set, before its ack", async () => {
    const t = await rig({ devices: [...DEVICES, BUTTON_DEVICE], changes: [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", pressOn())] });
    await t.press();                                                         // the press's hold, its step not acked
    await t.report("on", true);                                              // the report its step expects ends its floor for passing
    await t.defineAndSettle([up("rule", offRule())]);
    expect(t.turnedOff().length).toBe(1);
    expect(Object.values(t.lastRuleApply().passed ?? {}))
      .toEqual([{ holder: { rule: "press-on", press: { target: BUTTON, key: KEY, value: "1_single" } }, switch: "device" }]);
  });

  it("passes a press's step in flight once the lamp reports what the press sets, before the applier answers", async () => {
    // Events are parked while an apply is in flight; a cap of none relays them at once, so the report meets the press's provisional lease.
    const t = await rig({ devices: [...DEVICES, BUTTON_DEVICE], options: { parkedCap: 0 },
      changes: [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", pressOn()), up("rule", offRule())] });
    let open!: () => void;
    t.applier.answerGate = new Promise((r) => { open = r; });
    t.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value: "1_single", cause: "device", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
    await vi.waitFor(() => expect(t.applier.applies.length).toBe(1));
    await t.report("on", true);                                              // before the applier answers the press
    await vi.waitFor(() => expect(t.turnedOff().length).toBe(1));
    expect(Object.values(t.lastRuleApply().passed ?? {}))
      .toEqual([{ holder: { rule: "press-on", press: { target: BUTTON, key: KEY, value: "1_single" } }, switch: "device" }]);
    open();
    await quiet(t.store);
  });

  it("refuses the heater's rule over its load cap's lease, all three switches set", async () => {
    const t = await rig({ devices: [...DEVICES, HEATER_DEVICE], changes: [up("home", { hold: { owner_work_passes_holds: true } }),
      up("target", { id: HEATER, owner_work_passes_holds: true })] });
    t.applier.emit({ type: "state", target: HEATER, key: "on", value: false, cause: "load_cap", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.defineAndSettle([up("rule", { id: "warm", name: "Тепло", passes_holds: true, conditions: [{ between: { from: "00:00", until: "23:59" } }],
      actions: [on(HEATER)] })]);
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder])).toEqual([["warm", "leased", "load_cap"]]);
    expect(t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.target === HEATER))).toEqual([]);
  });
});

/** The rule's mark passing Olga's hold, as the first case above: the lamp's lease before and after, and the events between. */
async function markPasses(mutation?: Mutation, o: { advanceMs?: number } = {}) {
  const t = await rig({ mutation });
  await t.held();
  const before = (await t.state()).leases[LAMP];
  if (o.advanceMs) t.clock.advance(o.advanceMs);
  const { cursor } = await t.ok(SECRETS.owner, "events");
  await t.defineAndSettle([up("rule", offRule({ passes_holds: true }))]);
  return { t, before, after: (await t.state()).leases[LAMP], cursor };
}

/** A rule (marked unless `marked` is false) acting on a group whose lamp a brain joined, over Olga's hold: whether the lamp was turned off. */
async function brainJoined(mutation?: Mutation, o: { marked?: boolean; changes?: unknown[] } = {}): Promise<boolean> {
  const t = await rig({ mutation, devices: [...DEVICES, HEATER_DEVICE], changes: [...(o.changes ?? []), up("group", { id: "bench", name: "Стол", room: null, members: [HEATER],
    aggregate: "any" }), up("rule", offRule({ passes_holds: o.marked !== false, actions: [{ target: "bench", action: "onoff.turn_off", args: {} }] }))] });
  await t.brainDefine([up("group", { id: "bench", members: [HEATER, LAMP] })]);
  await t.held();
  return t.applier.applies.some((a: Body) => a.request.actions.some((x: Body) => x.target === LAMP && x.action === "onoff.turn_off"));
}

describe("a rule's own action under its mutations (GA-LEASE-12)", () => {
  it("passes with no switch set under unmarked-rule-passes", async () => {
    const t = await rig({ mutation: "unmarked-rule-passes", changes: [up("rule", offRule())] });
    await t.held();
    expect(t.turnedOff().length).toBe(1);
  });

  it("refuses by the device's switch under ignores-the-device-switch", async () => {
    const t = await rig({ mutation: "ignores-the-device-switch" });
    await t.held();
    await t.defineAndSettle([up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", offRule())]);
    expect(t.turnedOff().length).toBe(0);
  });

  it("refuses by the home's switch under ignores-the-home-switch", async () => {
    const t = await rig({ mutation: "ignores-the-home-switch" });
    await t.held();
    await t.defineAndSettle([up("home", { hold: { owner_work_passes_holds: true } }), up("rule", offRule())]);
    expect(t.turnedOff().length).toBe(0);
  });

  it("refuses a hold taken before the home's switch was set under switch-spares-held-holds", async () => {
    const t = await rig({ mutation: "switch-spares-held-holds", changes: [up("rule", offRule())] });
    await t.held();
    t.clock.advance(1_000);
    await t.defineAndSettle([up("home", { hold: { owner_work_passes_holds: true } })]);
    await t.retrigger();
    expect(t.turnedOff().length).toBe(0);
  });

  it("passes for a brain_authored marked rule under brain-rule-passes-holds", async () => {
    const t = await rig({ mutation: "brain-rule-passes-holds", changes: [up("rule", offRule({ passes_holds: true }))] });
    await t.brainDefine([up("rule", { id: "off", name: "Ночь" })]);
    await t.held();
    expect(t.turnedOff().length).toBe(1);
  });

  it("passes the hold on a device a brain joined to the rule's group only under brain-groups-past-a-hold", async () => {
    expect([await brainJoined(), await brainJoined("brain-groups-past-a-hold")]).toEqual([false, true]);
  });

  it("passes nothing for an unmarked rule's joined step under brain-groups-past-a-hold, the home's switch set: the row's effect only", async () => {
    expect(await brainJoined("brain-groups-past-a-hold", { marked: false, changes: [up("home", { hold: { owner_work_passes_holds: true } })] })).toBe(false);
  });

  it("passes nothing for a brain_authored unmarked rule under brain-rule-passes-holds, the device's switch set: the row's effect only", async () => {
    const t = await rig({ mutation: "brain-rule-passes-holds", changes: [up("target", { id: LAMP, owner_work_passes_holds: true }), up("rule", offRule())] });
    await t.brainDefine([up("rule", { id: "off", name: "Ночь" })]);
    await t.held();
    expect(t.turnedOff().length).toBe(0);
  });

  it("passes the hold by the rule's mark, not replacing it, under marked-press-passes", async () => {
    const t = await rig({ mutation: "marked-press-passes", devices: [...DEVICES, BUTTON_DEVICE], changes: [up("rule", pressOn({ passes_holds: true }))] });
    await t.held({ action: "onoff.turn_off" });
    await t.press();
    expect((await t.state()).leases[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    expect(Object.values(t.lastRuleApply().passed ?? {})).toEqual([{ holder: { person: "olga", endpoint: "olga-app" }, switch: "rule" }]);
  });

  it("ends the passed hold under passing-ends-the-hold", async () => {
    const { t, before, after } = await markPasses("passing-ends-the-hold");
    expect(t.turnedOff().length).toBe(1);
    expect(before).toBeDefined();
    expect(after).toBeUndefined();
  });

  it("keeps the passed hold's end, and moves it under pass-moves-the-end", async () => {
    const kept = await markPasses(undefined, { advanceMs: 10_000 });
    expect(kept.after).toEqual(kept.before);
    const { t, before, after } = await markPasses("pass-moves-the-end", { advanceMs: 10_000 });
    expect(t.turnedOff().length).toBe(1);
    expect(after.holder).toEqual(before.holder);
    expect(Date.parse(after.expires) - Date.parse(before.expires)).toBe(10_000);
  });

  it("re-evaluates the rules the passed hold refused only under pass-re-evaluates-early", async () => {
    const fired = async (mutation?: Mutation) => {
      const t = await rig({ mutation, changes: [up("rule", offRule("b"))] });
      await t.held();                                                        // b refused, left on Olga's hold
      const { cursor } = await t.ok(SECRETS.owner, "events");
      await t.defineAndSettle([up("rule", offRule("a", { passes_holds: true }))]);
      expect(t.lastRuleApply().firing?.rule).toBeDefined();
      return (await eventsSince(t.ok, cursor, "rule_fired")).map((e) => e.rule);
    };
    expect(await fired()).toEqual(["a"]);
    expect(await fired("pass-re-evaluates-early")).toEqual(["a", "b"]);
  });
});

/**
 * The doorlock locked at its keypad (`locked` reported `true`, cause `external`: an external hold, which has no floor), then
 * the owner's rule unlocking it while it reads locked, defined with `changes`: the rule's outcome and whether the unlock was sent.
 */
async function unlockOverTheKeypad(changes: unknown[], mutation?: Mutation, rule: Body = {}) {
  // lock.unlock reversible here, so only the lease decides the rule's step.
  const door = { ...DOOR_DEVICE, actions: [{ action: "lock.lock", tier: "reversible" }, { action: "lock.unlock", tier: "reversible" }] };
  const t = await narrowingRig({ locked: false, door, mutation });
  t.applier.emit({ type: "state", target: DOOR, key: "locked", value: true, cause: "external", time: new Date(t.clock.now()).toISOString() });
  await t.settle();
  expect((await t.leases())[DOOR]?.holder).toBe("external");
  const { cursor } = await t.ok(SECRETS.owner, "events");
  await t.define([...changes, up("rule", { id: "open-door", name: "Открыть", conditions: [{ target: DOOR, key: "locked", op: "eq", value: true }],
    actions: [{ target: DOOR, action: "lock.unlock", args: {} }], ...rule })]);
  await t.settle();
  const unlocks = t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.target === DOOR && x.action === "lock.unlock"));
  return { refused: (await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason, e.holder]), sent: unlocks.length };
}

describe("a step undoing a narrowing (GA-LEASE-12, the maintainer's M6 ruling)", () => {
  const HOME = up("home", { hold: { owner_work_passes_holds: true } });
  it("is not passed by the home's switch alone: the doorlock locked at its keypad stays locked", async () => {
    expect(await unlockOverTheKeypad([HOME])).toEqual({ refused: [["open-door", "leased", "external"]], sent: 0 });
  });
  it("is passed by the doorlock's own switch", async () => {
    expect(await unlockOverTheKeypad([HOME, up("target", { id: DOOR, owner_work_passes_holds: true })])).toEqual({ refused: [], sent: 1 });
  });
  it("is passed by the rule's mark", async () => {
    expect(await unlockOverTheKeypad([HOME], undefined, { passes_holds: true })).toEqual({ refused: [], sent: 1 });
  });
  it("is passed by the home's switch under home-switch-reopens", async () => {
    expect(await unlockOverTheKeypad([HOME], "home-switch-reopens")).toEqual({ refused: [], sent: 1 });
  });
});
