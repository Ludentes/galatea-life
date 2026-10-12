// Dispatch's free helpers and bounds: the own-step judgement, ack and reissue bounds, keys (moved from dispatcher.ts; Dispatcher stays whole).
import { argsFault, sets } from "../gate/actions.js";
import type { GateDevice, Requested } from "../gate/plan.js";
import type { DispatchTarget } from "../model/home.js";
import type { Outcome, Waiting } from "./records.js";

/** The reasons judged before `declaration_changed` at dispatch: none of them hangs on the action's declarations. */
export const OUTRANKS_A_CHANGE = new Set<string>(["not_adopted", "safety", "latched", "dead"]);

/**
 * A safety rule's actuation at dispatch (applier, *Safety rules*, *The applier's own actuations*): no
 * tier, token, `already` or request's refusal binds it, and it is always sent, never judged in place;
 * only what makes it impossible ends it first: a device or action gone, a device not adopted or dead,
 * args its device's declarations now refuse, which a client's step is refused for too, and an action
 * declared `toggles: true`, which the applier never sends on its own (GA-SAFE-13).
 */
export function judgeOwn(r: Requested, d: GateDevice | undefined): { verdict: "op" | "skip" | "refuse"; reason?: string } {
  const decl = d?.actions.get(r.action);
  if (!d) return { verdict: "skip", reason: "unknown_target" };
  if (!decl) return { verdict: "skip", reason: "unsupported_action" };
  if (!d.adopted) return { verdict: "refuse", reason: "not_adopted" };
  if (argsFault(r.action, r.args, decl.args, decl.confirmed_by) !== undefined) return { verdict: "refuse", reason: "invalid_args" };
  if (decl.toggles) return { verdict: "refuse", reason: "toggle_only" };
  if (d.liveness === "dead") return { verdict: "skip", reason: "dead" };
  return { verdict: "op" };
}

/**
 * How long past its bound a step still takes an ack (GA-BUS-4: "within the 1 s after it", since a
 * bridge on MQTT 3.1.1 counts the time from receipt), kept under GA-APPLY-8's 1 s, so that a step
 * nothing answered is `failed(no_ack)` no later than 1 s after its bound.
 */
export const ACK_GRACE_MS = 900;

/** How long after a step's `failed(no_ack)` a report matching its action is still a `late_ack` (GA-APPLY-11). */
export const LATE_ACK_MS = 60_000;

/**
 * A step's attempts in all, its first dispatch and its reissues (GA-APPLY-6), and the time between the
 * end of one attempt's bound and the next: the per-step retry deployed dispatchers run, "up to 3 attempts"
 * with 500 ms between them, here only once each attempt's bound has passed (GA-BUS-4).
 */
export const MAX_ATTEMPTS = 3;

export const REISSUE_GAP_MS = 500;

/**
 * Whether an action may be reissued at all (GA-APPLY-6): one whose effective declaration is idempotent,
 * on a closed device. An extension action never is, being declared not idempotent (GA-DESC-4).
 */
export function reissuable(target: Pick<DispatchTarget, "idempotent" | "feedback">): boolean {
  return target.idempotent && target.feedback === "closed";
}

/** What an action sets, as the step it is part of was dispatched with (GA-EVT-3). */
export const setsOf = (x: { action: string; args: Record<string, unknown>; confirmed_by?: Waiting["confirmed_by"] }) =>
  sets(x.action, x.args, x.confirmed_by);

export const FINAL = new Set<Outcome["outcome"]>(["skipped", "refused", "unreachable", "acked", "delivered", "sent", "unanswered", "failed"]);

export const tokenKey = (issuer: string, tokenId: string) => `${issuer}\u0000${tokenId}`;

export const iso = (ms: number) => new Date(Math.floor(ms)).toISOString();

/** A held run's action slot, by apply id and index (`Dispatcher.published`). */
export const slotOf = (applyId: string, i: number) => `${applyId}\u0000${i}`;

/**
 * The applier's own step (a safety rule's, a heating cap's) in a request's shape: `for` names its
 * cause, `{ safety_rule }` or `{ load_cap }`, which no client's `for` may, hence the one cast.
 */
export function ownRequest(target: string, action: string, args: Record<string, unknown> | undefined, cause: Record<string, string>): Requested {
  return { target, action, args: args ?? {}, via: "app", brain: false, for: cause } as unknown as Requested;
}
