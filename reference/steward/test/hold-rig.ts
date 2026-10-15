import { expect, vi } from "vitest";
import { reportOf } from "../src/house/action-keys.js";
import type { ApplyRecord } from "../src/dispatch/apply.js";
import type { Mutation } from "../src/mutations.js";
import { FakeClock } from "./fake-clock.js";
import { OWNER_CHAT, SECRETS, up } from "./house.js";
import { eventsSince, heardAt, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;

let n = 0;
/** A fresh idempotency key. */
export const key = () => `hold-${++n}`;
export const MINUTE = 60_000;
/**
 * The owner's rule turning the lamp off while it is on: level-triggered, judged as soon as it is defined. `offRule(o)` is
 * `offRule("off", o)`.
 */
export function offRule(id: string | Body = "off", o: Body = {}) {
  if (typeof id === "object") return offRule("off", id);
  return { id, name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }], ...o };
}
/** The hold policy with a lamp's hold ending 400 s after the change: the lamp's room has no presence source, so `fixed_s` (GA-LEASE-7). */
export const SHORT = up("home", { hold: { fixed_s: 400 } });
/** A scenario owning the lamp for 900 s, and a schedule running it at 11:05, five minutes after the clock's start. */
export const KEEP = up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [{ delay: 900 }] });
export const BED = up("schedule", { id: "bed", scenario: "keep", time: "11:05" });
export const BUTTON = "sim-bridge:button";
export const KEY = "org.galatea.test.button.action";
/** A button whose occurrence a press rule is marked on (GA-LEASE-9). */
export const BUTTON_DEVICE = { id: BUTTON, label: "button", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [], extension_keys: { event: [KEY] } };
/** A press rule turning the lamp on, fired by the button's single press (GA-LEASE-9). */
export const pressOn = (o: Body = {}) => ({ id: "press-on", name: "press-on", trigger: { event: { target: BUTTON, type: "occurrence", key: KEY, value: "1_single",
  press: true } }, actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }], ...o });
export const HEATER = "sim-bridge:heater";
/** A heater on a smart socket, which the applier's load cap may switch off (GA-LEASE-2). */
export const HEATER_DEVICE = { id: HEATER, label: "heater", class: "socket", capabilities: ["onoff"], adopted: true,
  actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "reversible" }] };

/** A steward over the furnished house, the guest panel's credential added; `ack` answers an apply's step `acked`, ending its floor. */
export async function rig(o: { mutation?: Mutation; changes?: unknown[]; devices?: Body[]; options?: Body; db?: NonNullable<Parameters<typeof setup>[0]>["db"] } = {}) {
  // The lamp live and off: a rule reads only a live, observed value (GA-RULE-2).
  const clock = new FakeClock();
  const initial = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false, basis_time: new Date(clock.now()).toISOString() }] } },
    transports: [], latches: [] };
  const t = await setup({ clock, state: initial, mutation: o.mutation, options: { pruneEveryMs: 24 * 3_600_000, ...o.options }, ...(o.devices ? { devices: o.devices } : {}),
    ...(o.db ? { db: o.db } : {}) });
  await t.define([OWNER_CHAT, up("credential", { id: "hall-panel", kind: "panel", secret: SECRETS.panel, endpoint: "hall-panel" }), ...(o.changes ?? [])]);
  /** The applier reports the lamp's `key` at `value`, no cause: as after a step, so it takes no hold. */
  const report = async (key: string, value: unknown) => {
    t.applier.emit({ type: "state", target: LAMP, key, value, time: new Date(t.clock.now()).toISOString() });
    await t.pump();
  };
  /** The applier reports the lamp on, as after a `turn_on`: no cause, so it takes no hold. */
  const lampOn = () => report("on", true);
  /**
   * An apply of `o.action` (`onoff.turn_on`) on the lamp, through `request`'s endpoint, its step not yet acked; unless
   * `report: false`, the lamp's report of the value it sets follows, the report its ack is matched on (GA-LEASE-12, R-6).
   */
  const applyAs = async (secret: string, request: Body, x: { action?: string; report?: boolean } = {}) => {
    const action = x.action ?? "onoff.turn_on";
    await t.ok(secret, "apply", { request: { ...request, actions: [on(LAMP, action)] }, idempotency_key: key() });
    await t.pump();
    const r = reportOf(action, {});
    if (x.report !== false && r) await report(r.key, r.value);
  };
  const ack = async (apply_id: string) => {
    t.applier.emit({ type: "outcome", apply_id, step_id: "s1", target: LAMP, outcome: "acked" });
    await t.pump();
  };
  /** The guest panel turns the lamp on; acked unless `acked` is false, reported unless `report` is false. */
  const panel = async (acked = true, x: { report?: boolean } = {}) => {
    await applyAs(SECRETS.panel, { endpoint: "hall-panel" }, x);
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
  /** The applier's id of the latest apply, as the fake applier numbers them. */
  const lastApply = () => `applier-apply-${new Set(t.applier.applies.map((a: Body) => a.idempotency_key)).size}`;
  /**
   * A member's hold: Olga's `o.action` (`onoff.turn_on`) on the lamp from her app, the lamp's report of it, then
   * her step acked, so its floor has passed. With `ack: false`, neither the report nor the ack comes: the hold is
   * inside its floor until `ack_within_s` plus 60 s from dispatch, or until `ack()` of the apply it returns.
   */
  const held = async (o: { action?: string; ack?: boolean } = {}): Promise<string> => {
    const action = o.action ?? "onoff.turn_on";
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, action)] }, idempotency_key: key() });
    await t.pump();
    const id = lastApply();
    if (o.ack !== false) {
      const r = reportOf(action, {});
      if (r) await report(r.key, r.value);
      await ack(id);
    }
    await quiet(t.store);
    return id;
  };
  /** The clock stepped past the lamp's lease's `expires` plus the hold end lateness (2 s, GA-LEASE-7), and settled. */
  const endHold = async () => {
    const expires = Date.parse(((await t.ok(SECRETS.owner, "state")).leases as Body)[LAMP].expires as string);
    t.clock.advance(Math.max(0, expires - t.clock.now()) + 2_001);
    await quiet(t.store);
  };
  /** The lamp turned on outside: an external hold, which has no floor (GA-LEASE-2). */
  const ext = async () => {
    t.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
    await quiet(t.store);
  };
  /** The owner's `state`. */
  const state = async () => t.ok(SECRETS.owner, "state");
  /** The lamp's `on` reported false then true, no cause: a level rule on it becomes true again, and no hold is taken. */
  const retrigger = async () => {
    await report("on", false);
    await report("on", true);
    await quiet(t.store);
  };
  /** The button's single press. */
  const press = async () => {
    t.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value: "1_single", cause: "device", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
    await quiet(t.store);
    await t.pump();
  };
  /** The latest apply's step acked, as the applier's `outcome` event of it. */
  const ackLast = () => ack(lastApply());
  /** The latest rule firing's record, through the steward's own map of them. */
  const lastRuleApply = (): ApplyRecord => [...(t.steward as unknown as { firings: Map<string, ApplyRecord> }).firings.values()].at(-1)!;
  return { ...t, report, lampOn, applyAs, ack, panel, leases, defineAndSettle, turnedOff, runStarted, brainDefine, lastApply, held, endHold, ext, state, retrigger,
    press, lastRuleApply, ackLast };
}
