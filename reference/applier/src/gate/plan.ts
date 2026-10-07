import type { ApplierPlan } from "@ludentes/galatea-life-schemas";
import type { ConfirmedBy, Constraint } from "../bus/wire.js";
import { canonical } from "../core/canonical.js";
import type { Tier } from "../model/declarations.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";
import { argsFault, holds } from "./actions.js";
import { authorsOwn, tokenFault, type Asked } from "./token.js";

/** One action of a request (applier, *Requests*). */
export type Requested = Asked & { token?: unknown };
/** One step of a plan (applier/plan.json). */
export type Step = ApplierPlan["steps"][number];
type Reason = NonNullable<Step["reason"]>;

/** What the gate reads of one device: a snapshot the applier takes at plan, and again at dispatch. */
export type GateDevice = {
  /** Each action it offers, with its effective tier (GA-DESC-3) and what its declaration says. */
  actions: ReadonlyMap<string, Decl>;
  adopted: boolean;
  liveness: Liveness;
  feedback: "open" | "closed";
  /** One piece of hardware two bridges report, not yet routed (GA-BUS-11). */
  duplicateRoute: boolean;
  /** Its observed values: none for an open device, whose state is assumed (GA-STATE-4). */
  values: ReadonlyMap<string, unknown>;
  /** A safety rule that actuates it runs, from firing until complete (GA-SAFE-2). */
  guarded?: boolean;
  /** Whether an action with these args undoes a held latch over it: `refuse(latched)` (GA-SAFE-7). */
  latched?: (action: string, args: Record<string, unknown>) => boolean;
  /** Whether it undoes a latch that cleared, the undo not yet run: its tier `no_voice`, its token's `for` a person's (GA-SAFE-7). */
  raised?: (action: string, args: Record<string, unknown>) => boolean;
};

/** One action's declaration as the gate reads it: its effective tier, what its bridge declares, and an extension action's `confirmed_by`. */
type Decl = { tier: Tier; stateless: boolean; toggles: boolean; args?: Record<string, Constraint>; confirmed_by?: ConfirmedBy };

/** The applier's state as the reasons read it: devices by id, the sending client and its key, the clock, used tokens. */
export interface Gate {
  device(id: string): GateDevice | undefined;
  client: string;
  key?: string;
  now: number;
  used(issuer: string, tokenId: string): boolean;
  mutation?: Mutation;
}

/**
 * One step being judged: the action asked, its device and declaration (its tier raised for a latch's
 * undo), whether it undoes a latch, and whether its token stands.
 */
type Judged = { a: Requested; d?: GateDevice; decl?: Decl; g: Gate; undo: boolean;
  token: () => boolean };

/**
 * The reason order (applier, *Reason order*, GA-PLAN-4): one ordered list, each reason a pure
 * function of the step and the snapshot, so a new reason is one entry and the order is visible here.
 */
const REASONS: { reason: Reason; verdict: "skip" | "refuse"; applies: (j: Judged) => boolean }[] = [
  { reason: "unknown_target", verdict: "skip", applies: (j) => !j.d },
  { reason: "unsupported_action", verdict: "skip", applies: (j) => !j.decl },
  { reason: "not_adopted", verdict: "refuse", applies: (j) => !j.d!.adopted },
  { reason: "invalid_args", verdict: "refuse", applies: (j) => argsFault(j.a.action, j.a.args, j.decl!.args, j.decl!.confirmed_by) !== undefined },
  { reason: "dead", verdict: "skip", applies: (j) => j.d!.liveness === "dead" },
  { reason: "duplicate_route", verdict: "refuse", applies: (j) => j.d!.duplicateRoute },
  // Nothing a request asks undoes a running safety rule's action (GA-SAFE-2).
  { reason: "safety", verdict: "refuse", applies: (j) => !!j.d!.guarded && j.g.mutation !== "lets-a-client-undo-safety" },
  // A held latch's undo, and any extension action on a device its rule actuated (GA-SAFE-7).
  { reason: "latched", verdict: "refuse", applies: (j) => !!j.d!.latched?.(j.a.action, j.a.args as Record<string, unknown>) },
  { reason: "tier", verdict: "refuse", applies: (j) => j.decl!.tier === "no_voice" && (j.a.via === "voice" || j.a.brain) },
  // Only on a live, observed value of a closed device, never for a stateless action (GA-PLAN-4, GA-STATE-4).
  { reason: "already", verdict: "skip", applies: (j) => !j.decl!.stateless && j.d!.feedback === "closed" && j.d!.liveness === "live"
    && holds(j.a.action, j.a.args as Record<string, unknown>, j.d!.values, j.decl!.confirmed_by) },
  { reason: "toggle_only", verdict: "refuse", applies: (j) => j.decl!.toggles && togglesBlind(j) && !personsYes(j) },
  // A latch's undo, once it cleared, runs only with a token whose `for` has a person (GA-SAFE-7).
  { reason: "token", verdict: "refuse", applies: (j) => j.decl!.tier !== "reversible" && (!j.token() || (j.undo && !forsPerson(j.a.token)))
    && j.g.mutation !== "applies-without-token" },
];

/** The standard's order, for anyone who wants to see it whole. */
export const REASON_ORDER: Reason[] = REASONS.map((r) => r.reason);

/** A toggle is blind on an open device, whose state is assumed; `asks-a-closed-loop-toggle` takes a closed one so too. */
function togglesBlind(j: Judged): boolean {
  return j.d!.feedback === "open" || j.g.mutation === "asks-a-closed-loop-toggle";
}

/** Whether the step carries a person's yes to its toggle: a token that stands and is no author's (GA-PLAN-8). */
function personsYes(j: Judged): boolean {
  if (j.g.mutation === "toggles-to-reach-a-state") return true;
  if (!j.token()) return false;
  const f = (j.a.token as { for?: unknown }).for;
  if (j.g.mutation === "answers-a-toggle-by-rule") return true;
  if (j.g.mutation === "refuses-a-panel-toggle" && typeof f === "object" && f !== null && "run" in f && !("person" in f)) return false;
  return !authorsOwn(f);
}

/** Whether a token's `for` names a person (GA-SAFE-7). */
function forsPerson(token: unknown): boolean {
  const f = (token as { for?: unknown } | undefined)?.for;
  return typeof f === "object" && f !== null && typeof (f as { person?: unknown }).person === "string";
}

/** Whether a step's token stands (GA-TOKEN-2); `trusts-any-token` takes any token given. */
export function tokenStands(a: Requested, g: Gate): boolean {
  if (a.token === undefined) return false;
  if (g.mutation === "trusts-any-token") return true;
  return tokenFault(a.token, a, { client: g.client, key: g.key, now: g.now, used: g.used }) === undefined;
}

/** One step, with the first reason that applies (GA-PLAN-4). */
export function judge(stepId: string, a: Requested, g: Gate): Step {
  const d = g.device(a.target);
  const args = a.args as Record<string, unknown>;
  // A latch's undo is `no_voice` while the latch holds and, once it cleared, until such an action next runs (GA-SAFE-7).
  const undo = !!d && (!!d.latched?.(a.action, args) || !!d.raised?.(a.action, args));
  const own = d?.actions.get(a.action);
  const decl = own && undo ? { ...own, tier: "no_voice" as const } : own;
  let stands: boolean | undefined;
  const j: Judged = { a, d, decl, g, undo, token: () => (stands ??= tokenStands(a, g)) };
  const step: Step = { step_id: stepId, target: a.target, action: a.action, args: a.args, verdict: "op",
    tier: decl?.tier ?? "reversible", stale: d?.liveness === "stale", basis: "real" };
  const hit = REASONS.find((r) => r.applies(j));
  return hit ? { ...step, verdict: hit.verdict, reason: hit.reason } : step;
}

/**
 * The steps of a request: one per distinct target, action, args, `via`, `brain`, `for` and token,
 * identical ones merged, in the order of their first appearance (GA-PLAN-2). An unknown target is a
 * step, never an error.
 */
export function planSteps(actions: Requested[], g: Gate): Step[] {
  return distinct(actions).map((a, i) => judge(`s${i + 1}`, a, g));
}

/** The distinct actions of a request, in the order of their first appearance: step `s{n}` is the nth (GA-PLAN-2). */
export function distinct(actions: Requested[]): Requested[] {
  const seen = new Set<string>();
  return actions.filter((a) => {
    const key = canonical([a.target, a.action, a.args, a.via, a.brain, a.for, a.token ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
