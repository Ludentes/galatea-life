import { canonical } from "../core/canonical.js";
import type { House } from "../house/model.js";
import type { Mutation } from "../mutations.js";

type Body = Record<string, any>;

/** One action of a request (steward, *Requests and selectors*): a target id, a group's or a device's, or a selector. */
export interface Requested {
  target?: string;
  selector?: { room?: string; class?: string; capability?: string };
  action: string;
  args: Record<string, unknown>;
}

/**
 * One step after resolution: a device, an action and its args; `conflict` when the same device and
 * action has other args too (GA-STW-2); `brain` when the step is `brain_authored` work (GA-DEF-7).
 */
export interface Resolved { target: string; action: string; args: Record<string, unknown>; conflict: boolean; brain?: true }

/** What resolution reads: the applier's devices as the mirror holds them, and the house's overlay and groups. */
export interface ResolveView {
  devices: ReadonlyMap<string, Body>;
  house: House;
  mutation?: Mutation;
  /**
   * Authored work (a rule's action, a run no person started): a step reaching a device through a room
   * or a group it joined through a brain is `brain` (GA-DEF-7). `authors-a-moved-device` never marks one.
   */
  authored?: boolean;
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Whether a selector or a group may reach a device (GA-PLAN-6): one the applier describes, adopted, and
 * neither `infrastructure` nor `internal`. Such a device is reached only by its own id;
 * `selects-internal` lets an internal one through.
 */
function reachable(d: Body | undefined, mutation?: Mutation): boolean {
  return d !== undefined && d.adopted === true && d.infrastructure !== true && (d.internal !== true || mutation === "selects-internal");
}

/** The capabilities a device has: its standard ones and its extensions' (a bridge's own). */
function capabilities(d: Body): string[] {
  return [...(Array.isArray(d.capabilities) ? d.capabilities : []),
    ...(Array.isArray(d.extensions) ? (d.extensions as Body[]).map((e) => e.capability) : [])];
}

/**
 * The devices one action names, in the order it names them: a selector's and a group's in code-point
 * order of their ids; each `brain` when, for authored work, it is reached through a room or a group it
 * joined through a brain (GA-DEF-7). A device named by its own id is reached through neither.
 */
function targetsOf(a: Requested, v: ResolveView): { id: string; brain: boolean }[] {
  const marks = v.authored === true && v.mutation !== "authors-a-moved-device";
  if (a.selector) {
    const s = a.selector;
    // Every device and channel matching all its fields; a group is no device, so never one (GA-PLAN-5).
    return [...v.devices.values()].filter((d) => reachable(d, v.mutation)
      && (s.room === undefined || v.house.targets.get(d.id)?.room === s.room)
      && (s.class === undefined || d.class === s.class)
      && (s.capability === undefined || capabilities(d).includes(s.capability)))
      .map((d) => d.id as string).sort(byCodePoint)
      .map((id) => ({ id, brain: marks && s.room !== undefined && v.house.targets.get(id)?.room_brain_authored === true }));
  }
  const id = a.target!;
  // A device's id is the device, even where a group was once given the same id.
  const g = v.devices.has(id) ? undefined : v.house.groups.get(id);
  if (!g) return [{ id, brain: false }];
  return g.members.filter((m) => reachable(v.devices.get(m), v.mutation)).map((m) => ({ id: m, brain: marks && g.brain_joined?.includes(m) === true }));
}

/**
 * A request's actions as steps (steward, *Steps*): each action resolved to its devices, one step per
 * distinct target, action and args in the order of their first appearance, a target reached twice
 * identically counting once (GA-STW-2). One target and action with different args marks each such step
 * a conflict, but `session.lock` steps on one computer whose `account` differs, which are distinct steps.
 */
export function resolveRequest(actions: Requested[], v: ResolveView): Resolved[] {
  const seen = new Map<string, Resolved>();
  const out: Resolved[] = [];
  for (const a of actions) {
    for (const { id: target, brain } of targetsOf(a, v)) {
      const key = canonical([target, a.action, a.args]);
      const was = seen.get(key);
      // Reached twice identically, one step; marked if either way reached it through a brain's move.
      if (was) {
        if (brain) was.brain = true;
        continue;
      }
      const r: Resolved = { target, action: a.action, args: a.args, conflict: false, ...(brain ? { brain: true as const } : {}) };
      seen.set(key, r);
      out.push(r);
    }
  }
  const per = new Map<string, number>();
  const same = (r: Resolved) => canonical([r.target, r.action, ...(r.action === "session.lock" ? [r.args.account ?? null] : [])]);
  for (const r of out) per.set(same(r), (per.get(same(r)) ?? 0) + 1);
  for (const r of out) r.conflict = per.get(same(r))! > 1;
  return out;
}
