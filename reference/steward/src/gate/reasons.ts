import type { ApplierPlan } from "@ludentes/galatea-life-schemas";
import type { Principal } from "../auth/principal.js";
import { LEASE_EXEMPT, refusedBy, type Holder, type Lease, type Precedence } from "../leases/table.js";
import type { Occupancy } from "./occupancy.js";
import type { Mutation } from "../mutations.js";
import type { Resolved } from "./resolve.js";

/** One step of the applier's plan (applier/plan.json). */
export type ApplierStep = ApplierPlan["steps"][number];
type Tier = ApplierStep["tier"];
type Reason = NonNullable<ApplierStep["reason"]>;

/** One step of a steward plan (steward, *Steps*). */
export interface StewardStep {
  step_id: string;
  target: string;
  action: string;
  args: Record<string, unknown>;
  verdict: "op" | "skip" | "ask" | "refuse";
  reason?: string;
  /** The lease's holder, with `refuse(leased)` (steward, *Steps*). */
  holder?: Holder;
  /** On a `notify` whose caller-set `from` the steward overwrote (GA-NOTE-2). */
  from_replaced?: true;
  /** A step of `brain_authored` work: above `reversible` it is `refuse(tier)`, and it goes with `brain: true` (GA-DEF-7). */
  brain_authored?: true;
  tier: Tier;
  stale: boolean;
  basis: "real" | "emulated";
}

/** The applier's first reasons the mirror can establish from the applier's last description, before `dead`. */
export type Described = "unknown_target" | "unsupported_action" | "not_adopted";

/**
 * What the reasons read beside the step: the principal, the mutation, and, for a step the applier did
 * not plan, the tier and the first reasons as the mirror read them.
 */
export interface Judge {
  principal: Principal;
  /** The precedence the principal acts at (steward, *Leases*): a person at an endpoint, `person`. */
  precedence: Precedence;
  /** What a change on a device meets: its provisional lease, else its lease (GA-LEASE-3). */
  leaseOf: (target: string) => Pick<Lease, "holder" | "precedence"> | undefined;
  /** The occupancy of a device's room, where the request respects occupancy; absent, occupancy is not consulted (GA-OCC-1). */
  occupancyOf?: (target: string) => Occupancy;
  mutation?: Mutation;
  /**
   * Work its author answered (a rule's action): its `confirm` and `no_voice` steps count as answered, so
   * neither the tier nor the applier's `token` asks, and the reasons after them still apply (GA-SCN-4).
   */
  authored?: true;
  /** Whether a device is `internal`: authored work never reaches one, at firing as at `define` (GA-DEF-10). */
  internal?: (target: string) => boolean;
  tierOf: (target: string, action: string) => Tier;
  described: (target: string, action: string) => Described | undefined;
}

type Hit = { verdict: StewardStep["verdict"]; reason: string; holder?: Holder };
type Judged = { r: Resolved; a?: ApplierStep; tier: Tier; j: Judge };

const FIRST: Reason[] = ["unknown_target", "unsupported_action", "not_adopted", "invalid_args"];
const SECOND: Reason[] = ["dead", "duplicate_route", "safety", "latched"];
const above = (t: Tier) => t !== "reversible";
const applierSays = (x: Judged, reasons: Reason[]): Hit | undefined =>
  x.a?.reason !== undefined && reasons.includes(x.a.reason) ? { verdict: x.a.verdict, reason: x.a.reason } : undefined;

/** The applier's verdicts for the reasons the mirror can establish (applier, *Reason order*). */
const mirrorSays = (d: Described | undefined): Hit | undefined =>
  d === undefined ? undefined : { verdict: d === "not_adopted" ? "refuse" : "skip", reason: d };

/**
 * The steward's reason order (steward, *Steps*, GA-STW-4): one ordered list, each entry a pure function
 * of the step, the principal and the applier's step, so the order is visible here, as the reference
 * applier's gate is built. The applier's reasons come first in their places; `leased` and occupancy
 * come between `already` and `toggle_only`; `token` is never reported.
 */
const REASONS: { name: string; hit: (x: Judged) => Hit | undefined }[] = [
  // With no applier step, what the mirror can establish from the applier's last description, in the order.
  { name: FIRST.join(", "), hit: (x) => (x.a ? applierSays(x, FIRST) : mirrorSays(x.j.described(x.r.target, x.r.action))) },
  { name: "conflict", hit: (x) => (x.r.conflict ? { verdict: "refuse", reason: "conflict" } : undefined) },
  // With no applier step the steward cannot know more: the step is dead (the design, *The applier out of reach*).
  { name: SECOND.join(", "), hit: (x) => (x.a ? applierSays(x, SECOND) : { verdict: "skip", reason: "dead" }) },
  // A guest's step above reversible, and a visitor's every step (GA-TIER-3); `visitor-acts` takes a visitor for a guest.
  { name: "role", hit: (x) => {
    if (x.j.authored && x.j.internal?.(x.r.target)) return { verdict: "refuse", reason: "role" };
    const role = x.j.principal.role === "visitor" && x.j.mutation === "visitor-acts" ? "guest" : x.j.principal.role;
    return role === "visitor" || (role === "guest" && above(x.tier)) ? { verdict: "refuse", reason: "role" } : undefined;
  } },
  // A no_voice step through a brain or by voice is refused (GA-TIER-1), and a brain_authored step above
  // reversible, whoever applies or runs it (GA-DEF-7); any other unanswered step above reversible is
  // asked (GA-TIER-2), but authored work's, which its author answered (GA-SCN-4).
  { name: "tier", hit: (x) => {
    if (x.r.brain && above(x.tier)) return { verdict: "refuse", reason: "tier" };
    const p = x.j.principal;
    const throughBrain = x.tier === "no_voice" && (p.brain || p.via === "voice");
    if ((throughBrain || x.a?.reason === "tier") && x.j.mutation !== "unlocks-by-voice") return { verdict: "refuse", reason: "tier" };
    if (x.j.authored) return undefined;
    return above(x.tier) || x.a?.reason === "tier" ? { verdict: "ask", reason: "confirm_tier" } : undefined;
  } },
  { name: "already", hit: (x) => applierSays(x, ["already"]) },
  // A lower-precedence change to a leased device is refused, never a `session.lock` (GA-LEASE-3).
  { name: "leased", hit: (x) => leased(x.r.target, x.r.action, x.j) },
  // With respect_occupancy, an occupied room skips the step and an unknown one asks (GA-OCC-1).
  { name: "occupancy", hit: (x) => occupied(x.j.occupancyOf?.(x.r.target)) },
  // Asked in its own words, never a refusal (GA-STW-4); `refuses-the-toggle` passes the applier's refusal on.
  { name: "toggle_only", hit: (x) => (x.a?.reason !== "toggle_only" ? undefined
    : x.j.mutation === "refuses-the-toggle" ? { verdict: "refuse", reason: "toggle_only" } : { verdict: "ask", reason: "toggle_only" }) },
  // The applier's `token` is never reported (GA-STW-4). Above `reversible` the tier entry has asked
  // already; here only on a reversible step, which a conforming applier never refuses `token`
  // (applier GA-TOKEN-1): a fault the steward logs, failed closed as `refuse(tier)`, never asked.
  { name: "token", hit: (x) => (x.a?.reason === "token" && !(x.j.authored && above(x.tier)) ? { verdict: "refuse", reason: "tier" } : undefined) },
];

/**
 * `refuse(leased)` with the lease's holder, when a change at the judge's precedence meets a lease that
 * outranks it on `target` (GA-LEASE-3); none for `session.lock`, which no lease refuses.
 * `ignores-leases` never refuses.
 */
export function leased(target: string, action: string, j: Pick<Judge, "leaseOf" | "precedence" | "mutation">): Hit | undefined {
  if (action === LEASE_EXEMPT || j.mutation === "ignores-leases") return undefined;
  const l = j.leaseOf(target);
  return l && refusedBy(l, j.precedence) ? { verdict: "refuse", reason: "leased", holder: l.holder } : undefined;
}

/** `skip(occupied)` for an occupied room, `ask(occupancy_unknown)` for one not known, none for a vacant one or none consulted (GA-OCC-1). */
export function occupied(o: Occupancy | undefined): Hit | undefined {
  return o === "occupied" ? { verdict: "skip", reason: "occupied" } : o === "unknown" ? { verdict: "ask", reason: "occupancy_unknown" } : undefined;
}

/**
 * The steps judged with no applier step because the applier's plan could not be had: their `skip(dead)`
 * is the steward's guess, not the applier's word, so they are never sent (the milestone review, B4).
 */
export const unplanned = new WeakSet<StewardStep>();

/** The steward's order, for anyone who wants to see it whole. */
export const REASON_ORDER: string[] = REASONS.map((r) => r.name);

/**
 * One steward step: the first reason of the order that applies, the applier's step merged in. The
 * applier's `refuse(toggle_only)` stands in place of any ask the step would otherwise have, so the person
 * always hears that the code toggles (GA-STW-4). `a` undefined: the applier gave no plan.
 */
export function judge(stepId: string, r: Resolved, a: ApplierStep | undefined, j: Judge): StewardStep {
  const tier = a?.tier ?? j.tierOf(r.target, r.action);
  const x: Judged = { r, a, tier, j };
  let hit: Hit | undefined;
  for (const reason of REASONS) if ((hit = reason.hit(x))) break;
  // `folds-the-toggle-into-the-tier` leaves the tier's ask in its place, so the person never hears that the code toggles.
  const folds = j.mutation === "folds-the-toggle-into-the-tier" && hit?.reason === "confirm_tier";
  if (hit?.verdict === "ask" && a?.reason === "toggle_only" && j.mutation !== "refuses-the-toggle" && !folds) hit = { verdict: "ask", reason: "toggle_only" };
  const step: StewardStep = { step_id: stepId, target: r.target, action: r.action, args: r.args, verdict: hit?.verdict ?? "op", ...(hit ? { reason: hit.reason } : {}),
    ...(hit?.holder !== undefined ? { holder: hit.holder } : {}), tier, stale: a?.stale ?? false, basis: a?.basis ?? "real",
    ...(r.brain ? { brain_authored: true as const } : {}) };
  if (!a && hit?.verdict === "skip" && hit.reason === "dead") unplanned.add(step);
  return step;
}
