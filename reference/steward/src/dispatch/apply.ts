import type { ApplierOutcome } from "@ludentes/galatea-life-schemas";
import type { Answer } from "../confirm/answer.js";
import { unplanned, type StewardStep } from "../gate/reasons.js";
import type { HoldState } from "../leases/hold.js";
import type { Holder } from "../leases/table.js";
import type { Mutation } from "../mutations.js";
import type { Firing } from "../rules/outcomes.js";

/** An idempotency key, and an apply's outcomes, are kept this long (steward, *Constants*; GA-STW-6). */
export const KEY_RETENTION_MS = 3_600_000;
/** An applier call whose answer was lost is repeated with its key until this long after the first try, never later (the design, *The applier call*). */
export const REPEAT_WINDOW_MS = 10_000;

export type OutcomeName = ApplierOutcome["outcome"];
/** One step's outcome as the steward returns it: always with its `time` (GA-STW-12). */
export type Outcome = { step_id: string; target: string; outcome: OutcomeName; reason?: string; detail?: string; time: string };

/** The steward's own reasons that stand at dispatch: a step refused for one of them is never sent to the applier. */
const OWN = new Set(["conflict", "role", "tier"]);
/** The steward's own reasons a plan's step is judged on again at dispatch, as it is then (GA-STW-8). */
const AGAIN = new Set(["leased", "occupied"]);

/**
 * What the steward finds on a step at dispatch (GA-STW-8): the holder of a lease that refuses it, and
 * its room's occupancy where the request respects occupancy and the room is not vacant.
 */
export interface Found { leased?: Holder; occupancy?: "occupied" | "unknown" }

export type Decision = { send: true; token: boolean } | { send: false; outcome: "skipped" | "refused"; reason: string }
  | { send: false; outcome: "unreachable"; detail: string };

/**
 * The applier's own skip or refusal at plan, where the steward's lease or room as they are now stand
 * in the way: it is not sent, so nothing reaches the leased device or the room, and it ends with the
 * applier's reason, which the order puts before `leased` and occupancy (GA-STW-4; the milestone review, B4).
 */
function standsAsPlanned(s: StewardStep, found: Found): Decision | undefined {
  if (found.leased === undefined && found.occupancy === undefined) return undefined;
  return { send: false, outcome: s.verdict === "skip" ? "skipped" : "refused", reason: s.reason! };
}

/** What a step the steward could not plan on the applier ends as: nothing was sent, and nothing judged its lease or room. */
const UNPLANNED: Decision = { send: false, outcome: "unreachable", detail: "the applier's plan could not be had, so the steward could not judge the step's lease and room: not sent" };

/**
 * What the steward decides for one step at dispatch (steward, *Apply*, GA-APPLY-3, GA-TIER-2,
 * GA-STW-4, GA-STW-8), or `send` with whether it carries a token. A refusal for the steward's own
 * reason (conflict, role, tier) is that refusal; a step the applier's own reasons skipped or refused
 * at plan is sent, the applier judging it again at dispatch. An ask with no `yes` is
 * `skipped(not_confirmed)`, or inline, with no plan to answer, `refused(tier)`, a toggle's
 * `refused(toggle_only)`. Then the lease and the room as they are now (`found`), the answers given
 * kept: a lease that outranks the step refuses it `refused(leased)`; an occupied room skips it
 * `skipped(occupied)`; a room not known is an ask the step was not answered for, so
 * `skipped(not_confirmed)` (GA-APPLY-3), unless its `yes` was to `ask(occupancy_unknown)`, or to the
 * `ask(toggle_only)` that stands in its place (GA-STW-4). An answered ask is sent with its token.
 * `tokens-without-a-yes` sends every step above `reversible` with a token.
 */
export function atDispatch(s: StewardStep, answer: Answer | undefined, inline: boolean, found: Found = {}, mutation?: Mutation): Decision {
  if (mutation === "tokens-without-a-yes" && s.tier !== "reversible" && !(s.verdict === "refuse" && OWN.has(s.reason ?? ""))) {
    return { send: true, token: true };
  }
  if (s.verdict === "refuse" && OWN.has(s.reason ?? "")) return { send: false, outcome: "refused", reason: s.reason! };
  // A step the applier skipped or refused at plan is sent for it to judge again, but only past the
  // steward's own lease and room as they are now; and never one the steward could not plan on the
  // applier, whose `skip(dead)` is the steward's guess: it fails closed (the milestone review, B4).
  if ((s.verdict === "skip" || s.verdict === "refuse") && !AGAIN.has(s.reason ?? "")) {
    if (unplanned.has(s)) return UNPLANNED;
    return standsAsPlanned(s, found) ?? { send: true, token: false };
  }
  const asked = s.verdict === "ask" ? s.reason : undefined;
  if (asked !== undefined && (inline || answer !== "yes")) {
    if (inline && asked !== "occupancy_unknown") return { send: false, outcome: "refused", reason: asked === "toggle_only" ? "toggle_only" : "tier" };
    return { send: false, outcome: "skipped", reason: "not_confirmed" };
  }
  if (found.leased !== undefined) return { send: false, outcome: "refused", reason: "leased" };
  if (found.occupancy === "occupied") return { send: false, outcome: "skipped", reason: "occupied" };
  if (found.occupancy === "unknown" && asked !== "occupancy_unknown" && asked !== "toggle_only") {
    return { send: false, outcome: "skipped", reason: "not_confirmed" };
  }
  return { send: true, token: asked !== undefined };
}

/** The asks authored work turns into the matching skip (GA-SCN-4). */
const MATCHING_SKIPS = new Set(["occupancy_unknown", "in_use", "in_use_unknown", "toggle_only"]);

/**
 * What a rule's firing does with one step judged as authored work (steward, *Rules*; GA-SCN-4): an op
 * is sent, a `confirm` or `no_voice` one with an authored token; an `ask(occupancy_unknown)`,
 * `ask(in_use)` or `ask(in_use_unknown)` becomes the matching skip, a toggle's `skipped(toggle_only)`
 * whatever its tier, never answered by the authored token; any other ask, which authored work never
 * meets and no one can answer, is `skipped(not_confirmed)` (GA-APPLY-3); the steward's own refusals
 * (`leased`, `conflict`, `role`, `tier`) and an occupied room stand; the applier's own skips and
 * refusals are sent, the applier judging them again, once the lease and the room as they are now
 * (`found`) let them, but never one the steward could not plan;
 * an applier's `skip(already)` is the steward's own `skipped(already)`, nothing to do.
 * `authors-a-toggle` sends the toggle with the authored token.
 */
export function ruleDecision(s: StewardStep, mutation?: Mutation, found: Found = {}): Decision {
  if (s.verdict === "op") return { send: true, token: s.tier !== "reversible" };
  if (s.verdict === "ask") {
    if (s.reason === "toggle_only" && mutation === "authors-a-toggle") return { send: true, token: true };
    if (MATCHING_SKIPS.has(s.reason ?? "")) return { send: false, outcome: "skipped", reason: s.reason! };
    return { send: false, outcome: "skipped", reason: "not_confirmed" };
  }
  if (s.reason === "leased" || OWN.has(s.reason ?? "")) return { send: false, outcome: "refused", reason: s.reason! };
  if (s.reason === "occupied") return { send: false, outcome: "skipped", reason: "occupied" };
  // The applier's refuse(toggle_only), however the plan reported it, is a skip for authored work.
  if (s.reason === "toggle_only") return { send: false, outcome: "skipped", reason: "toggle_only" };
  // Sent for the applier to judge again only past the steward's own lease and room as they are now,
  // and never a step it could not plan on the applier, which fails closed: GA-RULE-7 tries an
  // idempotent one again (the milestone review, B4).
  if (unplanned.has(s)) return UNPLANNED;
  const stands = standsAsPlanned(s, found);
  if (stands) return stands;
  // The applier's `skip(already)`, planned in the same step: the steward's own skip, nothing sent (the milestone 5+6 review, M8).
  if (s.verdict === "skip" && s.reason === "already") return { send: false, outcome: "skipped", reason: "already" };
  // With the token it would need: authored work passed the tier, and an applier's skip or refusal
  // judged again at dispatch must find the step as it would an op, not refuse it `token`.
  return { send: true, token: s.tier !== "reversible" };
}

/**
 * Whether an outcome of a step the applier took leaves its device leased (GA-LEASE-1): every one but
 * those that say nothing was sent (`unreachable`, a skip, a refusal) and `unknown`.
 */
export function leaves(outcome: unknown): boolean {
  return !["unreachable", "skipped", "refused", "unknown"].includes(String(outcome));
}

/**
 * An apply as the steward keeps it (the design, *Apply and dispatch*): its key and body for the
 * credential's idempotency (GA-STW-6), its outcomes in the order of its steps, the steps it sent to
 * the applier in order, and, once the applier answered, the applier's apply id and its step ids, so
 * the applier's later `outcome` and `late_ack` events update it.
 */
export interface ApplyRecord {
  apply_id: string;
  credential: string;
  key: string;
  /** The request's body, canonical, without its key: what a repeat is compared by. */
  body: string;
  atMs: number;
  plan_id?: string;
  /** The steward's cause on every action it sent (steward, *Causes and history*). */
  cause: Record<string, unknown>;
  outcomes: Outcome[];
  /** The steward's step ids it sent to the applier, in the order sent. */
  sent: string[];
  applierApplyId?: string;
  /** The applier's step id of each step sent, to the steward's. */
  steps: Record<string, string>;
  /** Resolves once the apply has its answer, for a repeat that arrives while it is in flight. */
  done: Promise<void>;
  /** When it was dispatched: the leases its steps take run from then (GA-LEASE-1). */
  dispatchMs?: number;
  /**
   * The steps that laid a provisional lease on their device at dispatch, until the applier answers:
   * each with its action and args, which give its hold's direction, and the apply's derived role,
   * kept with the hold (GA-LEASE-7, GA-LEASE-10).
   */
  laid?: { step: string; target: string; action: string; args: Record<string, unknown>; role?: HoldState["role"] }[];
  /** The steps of an inline request whose caller-set `from` the steward overwrote, marked on their outcomes (GA-NOTE-2). */
  fromReplaced?: string[];
  /** The key the applier call carries when it is not the apply's id: a rule firing's `rule:<id>:<n>` (GA-STW-10). */
  applierKey?: string;
  /** A rule firing's record: kept in memory only, for its later events; no client reads it (the design, *Rules*). */
  memoryOnly?: boolean;
  /** A rule firing's steps as resolved, for what its outcomes do (GA-RULE-7). */
  firing?: Firing;
  /** A scenario run's action step: the run, and the step's place among its action steps (GA-STW-10). */
  run?: { id: string; index: number };
}

/** A record's document in the store: what a restart reads back. */
export function docOf(r: ApplyRecord): Record<string, unknown> {
  return { plan_id: r.plan_id, cause: r.cause, outcomes: r.outcomes, sent: r.sent, applier_apply_id: r.applierApplyId, steps: r.steps,
    ...(r.fromReplaced?.length ? { from_replaced: r.fromReplaced } : {}) };
}

/**
 * Where an outcome stands in a step's life: not yet known, dispatched, then final. An applier's
 * `outcome` event moves a step's outcome only to a later place, so an event that comes late, or one
 * the applier's answer gave already (whose `outcome` event the steward put itself), changes nothing
 * and is not relayed again (GA-STW-12's "current outcomes").
 */
export function outcomeRank(outcome: unknown): number {
  return outcome === "unknown" ? 0 : outcome === "dispatched" ? 1 : 2;
}
