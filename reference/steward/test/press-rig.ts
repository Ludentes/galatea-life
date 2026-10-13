// A press (GA-LEASE-9): the hall with a button whose occurrence a press rule fires on, and the conforming
// scenarios the press's tests assert and its negative subjects run under their mutations (R-35).
import type { Mutation } from "../src/mutations.js";
import { hall, PLUG } from "./hall.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { DIMMER, eventsSince, heardAt, LAMP, on, quiet } from "./setup.js";

type Body = Record<string, any>;
export const BUTTON = "sim-bridge:button";
export const KEY = "org.galatea.test.button.action";
export const BUTTON_DEVICE = { id: BUTTON, label: "button", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [],
  extension_keys: { event: [KEY] } };
export const press = (id: string, o: Body = {}, value = "1_single") => ({ id, name: id,
  trigger: { event: { target: BUTTON, type: "occurrence", key: KEY, value, press: true } },
  actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }], ...o });
/** A rule of conditions only that turns the lamp off all day: a hold on the lamp refuses it. */
export const OFF = { id: "off", name: "off", conditions: [{ between: { from: "00:00", until: "23:59" } }], actions: [on(LAMP, "onoff.turn_off")] };
export const HOLDER = { rule: "bench-on", press: { target: BUTTON, key: KEY, value: "1_single" } };
/** A personal press's holder as the owner is shown it until slice 8: its value withheld (R-67). */
export const WITHHELD = { rule: "bench-on", press: { target: BUTTON, key: KEY, value: "withheld" } };
/** Olga's hold from her app. */
export const OLGA = { person: "olga", endpoint: "olga-app" };
let n = 0;
export const key = () => `press-${++n}`;

export async function rig(o: { button?: Body; mutation?: Mutation } = {}) {
  const t = await hall({ extraDevices: [o.button ?? BUTTON_DEVICE], mutation: o.mutation });
  const pressIt = async (value = "1_single") => {
    t.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value, cause: "device", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
    await quiet(t.store);
    await t.pump();
  };
  const settle = async () => {
    await t.pump();
    await quiet(t.store);
    await t.pump();
  };
  const turnedOff = () => t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.action === "onoff.turn_off")).length;
  /** The applier's id of the latest apply, as the fake applier numbers them. */
  const lastApply = () => `applier-apply-${new Set(t.applier.applies.map((a: Body) => a.idempotency_key)).size}`;
  /** Olga turns the lamp off (or on) from her app: a member's hold. */
  const olgaOff = async (action = "onoff.turn_off") => {
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, action)] }, idempotency_key: key() });
    await t.pump();
  };
  /** `changes` defined through the brain from the owner's chat window, its plan answered yes (GA-DEF-7). */
  const brainDefine = async (changes: unknown[]) => {
    const plan = await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", changes, expected_revision: (await t.ok(SECRETS.owner, "describe")).revision,
      dry_run: false });
    await t.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
      utterance: heardAt(t.clock, "owner-chat", { addressed_by: "typed" }) });
    await t.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
    await quiet(t.store);
  };
  return { ...t, pressIt, settle, turnedOff, lastApply, olgaOff, brainDefine };
}

/** The lamp's lease holder as the owner's `state` shows it, undefined when none. */
const holderOf = async (t: Awaited<ReturnType<typeof rig>>, target = LAMP) => (await t.leases())[target]?.holder;

/** The conforming scenarios, by name: each run as the conforming build by the press's tests, and under a mutation by its subject's. */
export const PRESS = {
  /** Olga holds the lamp; button 1's press rule fires: the step it sends, the lease events since, and the lamp's lease. */
  async overAMembersHold(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.olgaOff();
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    return { sent: t.applier.applies.at(-1)!.request.actions[0], events: (await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end]),
      refused: (await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason]), lease: (await t.leases())[LAMP] };
  },

  /** Button 1's press rule fires on a lamp no one holds: the lamp's holder. */
  async pressed(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    return holderOf(t);
  },

  /** Olga holds the lamp on; the press's turn_on ends skipped(already): the lamp's holder. */
  async alreadyDone(mutation?: Mutation) {
    const t = await rig({ mutation });
    t.applier.planner = (a) => (a.via === "rule" ? { verdict: "skip", reason: "already" } : {});
    await t.olgaOff("onoff.turn_on");
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    return holderOf(t);
  },

  /** A press rule whose conditions hold 18:00 to 23:00, pressed at 11:00 Moscow: how many applies it sent. */
  async outsideItsConditions(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([up("rule", press("late", { conditions: [{ between: { from: "18:00", until: "23:00" } }] }))]);
    const before = t.applier.applies.length;
    await t.pressIt();
    return t.applier.applies.length - before;
  },

  /** Olga holds the lamp on and the off rule waits; the press replaces her hold and ends unreachable: the holders, lease events and turn_offs. */
  async endsUnreachable(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.olgaOff("onoff.turn_on");
    await t.define([up("rule", OFF)]);
    await t.settle();
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    const pressed = await holderOf(t);
    t.applier.emit({ type: "outcome", apply_id: t.lastApply(), step_id: "s1", target: LAMP, outcome: "unreachable", time: t.at() });
    await t.settle();
    return { pressed, events: (await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.restored, e.role]),
      turnedOff: t.turnedOff(), holder: await holderOf(t) };
  },

  /** The press holds the lamp; the owner deletes its rule: the lamp's holder. */
  async ruleDeleted(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    await t.define([{ op: "delete", kind: "rule", value: { id: "bench-on" } }]);
    return holderOf(t);
  },

  /** A press rule the owner defined from the app turns on the dimmer, whose turn_on is confirm: the outcomes of its steps. */
  async confirmStep(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([up("rule", press("bench-on", { actions: [on(DIMMER)] }))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    const outcomes = (await eventsSince(t.ok, cursor, "outcome")).filter((e) => e.cause?.rule === "bench-on").map((e) => [e.outcome, e.reason]);
    const sent = t.applier.applies.flatMap((a: Body) => a.request.actions).filter((x: Body) => x.target === DIMMER).map((x: Body) => x.token !== undefined);
    return { outcomes, sent };
  },

  /** Olga holds the lamp; a brain writes the press rule from the owner's chat, and the button is pressed: the lamp's holder. */
  async brainWritten(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([OWNER_CHAT]);
    await t.olgaOff();
    await t.brainDefine([up("rule", press("bench-on"))]);
    await t.pressIt();
    return holderOf(t);
  },

  /**
   * Olga holds the lamp; the owner's press rule turns on a group of the plug alone, and a brain adds the lamp
   * to that group: the lamp's holder after the press.
   */
  async brainJoinedGroup(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.define([OWNER_CHAT, up("group", { id: "bench", name: "Стол", room: null, members: [PLUG], aggregate: "any" }),
      up("rule", press("bench-on", { actions: [{ target: "bench", action: "onoff.turn_on", args: {} }] }))]);
    await t.brainDefine([up("group", { id: "bench", members: [PLUG, LAMP] })]);
    await t.olgaOff();
    await t.pressIt();
    return holderOf(t);
  },
};
