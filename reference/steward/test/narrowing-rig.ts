// Narrowing actions (GA-LEASE-11): a door, a valve and a button, and the conforming scenarios the
// narrowing tests assert and their negative subjects run under their mutations (R-35).
import { expect, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { SECRETS, up } from "./house.js";
import { DEVICES, eventsSince, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
export const DOOR = "sim-bridge:door";
export const VALVE = "sim-bridge:valve";
export const BUTTON = "sim-bridge:button";
export const KEY = "org.galatea.test.button.action";
export const DOOR_DEVICE = { id: DOOR, label: "door", class: "door_lock", capabilities: ["lock"], adopted: true,
  actions: [{ action: "lock.lock", tier: "reversible" }, { action: "lock.unlock", tier: "confirm" }] };
export const VALVE_DEVICE = { id: VALVE, label: "valve", class: "water_valve", capabilities: ["onoff"], adopted: true, opens_with: "onoff.turn_off",
  actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "no_voice" }] };
export const BUTTON_DEVICE = { id: BUTTON, label: "button", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [],
  extension_keys: { event: [KEY] } };
/** The rule locking the door while it is reported unlocked (HS18). */
export const AUTO_LOCK = { id: "auto-lock", name: "Замок", conditions: [{ target: DOOR, key: "locked", op: "eq", value: false }],
  actions: [{ target: DOOR, action: "lock.lock", args: {} }] };
let n = 0;
export const key = () => `narrow-${++n}`;

/** A rule closing the valve while the door is reported unlocked: a rule's narrowing step on the valve. */
export const CLOSE_VALVE = { id: "close-valve", name: "Кран", conditions: [{ target: DOOR, key: "locked", op: "eq", value: false }],
  actions: [{ target: VALVE, action: "onoff.turn_on", args: {} }] };
/** The hold policy with a hold ending 400 s after the change: the devices' rooms have no presence source, so `fixed_s` (GA-LEASE-7). */
export const SHORT = up("home", { hold: { fixed_s: 400 } });
/** A scenario owning `target` for 900 s, and a schedule running it at 11:05, five minutes after the clock's start. */
export const owning = (target: string, steps: unknown[] = []) => [up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [target], steps: [...steps, { delay: 900 }] }),
  up("schedule", { id: "bed", scenario: "keep", time: "11:05" })];

/** A steward over the door, the valve and a button; `unlocked` has a phone unlock the door, an external change taking a person's hold. */
export async function rig(o: { locked?: boolean; mutation?: Mutation; door?: Body } = {}) {
  // The door live, reported locked (or not) by no one, so it holds no lease: a rule reads only a live, observed value (GA-RULE-2).
  const state = { targets: { [DOOR]: { liveness: "live", values: [{ key: "locked", value: o.locked ?? true }] } }, transports: [], latches: [] };
  const t = await setup({ devices: [...DEVICES, o.door ?? DOOR_DEVICE, VALVE_DEVICE, BUTTON_DEVICE], state, mutation: o.mutation });
  const leases = async () => (await t.ok(SECRETS.owner, "state")).leases as Record<string, Body>;
  const unlocked = async () => {
    t.applier.emit({ type: "state", target: DOOR, key: "locked", value: false, cause: "external", time: new Date(t.clock.now()).toISOString() });
    await t.pump();
  };
  const settle = async () => {
    await t.pump();
    await quiet(t.store);
    await t.pump();
  };
  const locks = () => t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.target === DOOR && x.action === "lock.lock"));
  const closes = () => t.applier.applies.filter((a: Body) => a.request.actions.some((x: Body) => x.target === VALVE && x.action === "onoff.turn_on"));
  /** A person-started run of a scenario owning `target`, by Olga from her app, once it holds its lease. */
  const olgaRun = async (target: string, steps: unknown[] = []) => {
    await t.define([up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [target], steps: [...steps, { delay: 900 }] })]);
    const plan = await t.ok(SECRETS.olga, "scenario_plan", { scenario: "keep", endpoint: "olga-app" });
    const { run_id } = await t.ok(SECRETS.olga, "scenario_run", { plan_id: plan.plan_id, idempotency_key: key() });
    await vi.waitFor(async () => expect((await leases())[target]?.holder).toEqual({ run: run_id }));
    return run_id as string;
  };
  /** The scheduled run the clock's 11:05 starts, once its `started` event is in. */
  const scheduledRun = async () => {
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * 60_000);
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "scenario")).map((e) => e.change)).toContain("started"));
    return (await eventsSince(t.ok, cursor, "scenario")).find((e) => e.change === "started")!.run_id as string;
  };
  const apply = (secret: string, endpoint: string, target: string, action: string) =>
    t.ok(secret, "apply", { request: { endpoint, actions: [{ target, action, args: {} }] }, idempotency_key: key() });
  return { ...t, leases, unlocked, settle, locks, closes, olgaRun, scheduledRun, apply };
}

/** The conforming scenarios, by name: each run as the conforming build by the narrowing tests, and under a mutation by its subject's. */
export const NARROWING = {
  /** Olga closes the valve from her app: the step sent, the valve's lease and the lease events since. */
  async memberCloses(mutation?: Mutation) {
    const t = await rig({ mutation });
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: VALVE, action: "onoff.turn_on", args: {} }] }, idempotency_key: key() });
    await t.settle();
    return { sent: t.applier.applies.at(-1)!.request.actions[0], events: await eventsSince(t.ok, cursor, "lease"), lease: (await t.leases())[VALVE] };
  },

  /** A phone's unlock holds the door; a press rule locks it: the lock sent, the lease events since and the door's holder. */
  async pressLocks(mutation?: Mutation) {
    const t = await rig({ mutation });
    await t.unlocked();
    await t.define([up("rule", { id: "bench-lock", name: "bench-lock", trigger: { event: { target: BUTTON, type: "occurrence", key: KEY, value: "1_single", press: true } },
      actions: [{ target: DOOR, action: "lock.lock", args: {} }] })]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value: "1_single", cause: "device", time: new Date(t.clock.now()).toISOString() });
    await t.settle();
    return { sent: t.locks()[0]?.request.actions[0], events: (await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end]),
      holder: (await t.leases())[DOOR]?.holder };
  },
};
