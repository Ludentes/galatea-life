// The applier's free helpers and bounds: plan bounds, meta keys, the idempotency body, model events (moved from applier.ts; Applier stays whole).
import type { Config } from "./config/config.js";
import { canonical } from "./core/canonical.js";
import type { HeldDevice } from "./model/home.js";
import type { Replacement, Routed } from "./config/configure.js";
import type { GateDevice } from "./gate/plan.js";
import type { Args } from "./applier.js";

export const STANDARD_VERSION = "0.16";

/**
 * A plan expires this long after it is made, on the applier's clock (applier, *Planning changes
 * nothing*); it is held as long again, so applying it says `plan_expired` rather than `unknown_plan`.
 */
export const PLAN_EXPIRY_MS = 60_000;

/** The most plans one client may have held at once; past it, its oldest is dropped (`unknown_plan`). */
export const MAX_PLANS_PER_CLIENT = 64;

export const PRUNE_EVERY_MS = 60_000;

/** The meta key set once the devices adopted before this build said a second door have been judged (GA-ADOPT-3). */
export const OTHER_ADMINS_SAID = "other_admins_said";

/** The meta key of the install's namespace for derived command and run ids (the maintainer's ruling 2). */
export const COMMAND_NAMESPACE = "command_namespace";

/** How often liveness is judged again: well inside GA-STATE-2's and GA-STATE-5's 1 s. */
export const TICK_MS = 500;

/** `plans-on-a-candidate`'s device: any action, reversible, on a live open device. */
export function asDevice(): GateDevice {
  const decl = { tier: "reversible" as const, stateless: false, toggles: false };
  const actions = { get: () => decl, has: () => true } as unknown as ReadonlyMap<string, typeof decl>;
  return { actions, adopted: true, liveness: "live", feedback: "open", duplicateRoute: false, values: new Map() };
}

/** The key a `rule_disabled` notice stands under, until the owner sets the rule again or deletes it. */
export const disabledKey = (rule: string) => `rule_disabled:${rule}`;

/**
 * An apply's body as GA-APPLY-4 compares it: its RFC 8785 form without the key and without the
 * actions' tokens, so a retry carrying freshly issued tokens is the same body.
 */
export function idempotencyBody(a: Args): string {
  const { idempotency_key: _, ...rest } = a;
  if (Array.isArray(rest.request?.actions)) {
    rest.request = { ...rest.request, actions: rest.request.actions.map(({ token: _t, ...x }: Args) => x) };
  }
  return canonical(rest);
}

/**
 * The `model` events of an owner's change set, one per device it changed (applier, *Events and
 * history*): an adoption or a new class `{ device, class }`, an adoption deleted `{ device, adopted:
 * false }`, a device forgotten `{ device, forgotten: true }`, a replacement `{ device, class, replaces }`
 * (the new hardware's id before it took the old one), and any other change to a device's
 * declarations `{ device }`; one bare event when it changed no device.
 */
export function modelEvents(before: Config, after: Config, o: { forgotten: string[]; replaced: Replacement[]; kept: string[];
  routed: Routed[]; placed: HeldDevice[]; unrouted: string[] }, more = false): Record<string, unknown>[] {
  const { forgotten, replaced, kept } = o;
  const named = new Set(forgotten);
  // A device its bridge listed again while its forget committed stays, unadopted: not forgotten.
  const events: Record<string, unknown>[] = forgotten.map((device) => kept.includes(device) ? { device, adopted: false } : { device, forgotten: true });
  for (const r of replaced) {
    events.push({ device: r.device, class: after.adoptions.get(r.replaces)?.class ?? null, replaces: r.replaces });
    named.add(r.device).add(r.replaces);
  }
  for (const [device, x] of after.adoptions) {
    if (before.adoptions.get(device)?.class === x.class) continue;
    events.push({ device, class: x.class });
    named.add(device);
  }
  for (const device of before.adoptions.keys()) {
    if (after.adoptions.has(device) || named.has(device)) continue;
    events.push({ device, adopted: false });
    named.add(device);
  }
  // A route: its device now names the route's copy, and each copy folded into it leaves `describe` (GA-BUS-11).
  for (const r of o.routed) {
    if (named.has(r.device)) continue;
    events.push({ device: r.device });
    named.add(r.device);
  }
  // A route deleted: its device is the one device of its copies still, but no longer routed.
  for (const device of o.unrouted) {
    if (named.has(device)) continue;
    events.push({ device });
    named.add(device);
  }
  for (const d of o.placed) {
    if (named.has(d.id) || d.into === undefined) continue;
    events.push({ device: d.id, folded_into: d.into });
    named.add(d.id);
  }
  for (const device of new Set([...before.declarations.keys(), ...after.declarations.keys()])) {
    if (named.has(device) || canonical(before.declarations.get(device)) === canonical(after.declarations.get(device))) continue;
    events.push({ device });
  }
  return events.length || more ? events : [{}];
}
