import type { Ack } from "../bus/wire.js";

/**
 * The rules that turn a dispatched step's acks, reports and bound into its final outcome (applier,
 * *Outcomes*; the bridge standard's table, *What the applier makes of it*), as pure functions of
 * what the step is, so each is tested on its own. The PC build's rules for `power.wake`,
 * `media.launch` and `session.lock` register beside these (the design, *Ack rules by action*).
 */

/** What a waiting step's outcome reads of its action and device. */
export type StepKind = {
  feedback: "open" | "closed";
  stateless: boolean;
  /** The action's declared `confirms`: whether its bridge can say `applied` for it. */
  confirms: boolean;
};

export type Final = { outcome: "acked" | "delivered" | "sent" | "unanswered" | "failed" | "unreachable"; reason?: string };

/**
 * What an ack does to a waiting step: nothing (`ignore`: not terminal, the bridge standard's optional `received` or a result
 * not known); a final outcome; or `wait`, a terminal ack after which the step waits for its report or
 * its bound. `acted` is false when the ack says the device did not act, which ends the step's
 * attribution window (GA-EVT-1). `fault` names a bridge fault the ack is.
 */
export type AckEffect =
  | { kind: "ignore" }
  | { kind: "final"; final: Final; acted: boolean }
  | { kind: "wait"; fault?: string };

/** A failed ack whose device may still have acted: no ack for the outcome, and its window stays open (GA-EVT-1). */
export const MAY_HAVE_ACTED = new Set(["no_confirmation", "not_locked"]);

/**
 * An ack's effect (applier, *Outcomes*). `failed(unreachable)` and `failed(expired)` are
 * `unreachable`: nothing was sent. `failed(no_confirmation)` is taken as no ack. Any other
 * `failed(r)` is `failed(r)`, and `unsupported` `failed(unsupported_action)`. `applied` and `sent` end
 * an open device's step `sent`, and a stateless one on a closed device `delivered` and `sent` (where
 * it is declared `confirms: false`); a stateful one on a closed device waits for its report (GA-EVT-3).
 * A `sent` for an action declared `confirms: true` is a bridge fault, and the step waits (GA-APPLY-7).
 * `acksWithoutState` is the mutation `acks-without-state`: `applied` acks a stateful step at once.
 */
export function onAck(k: StepKind, ack: Ack, acksWithoutState = false): AckEffect {
  switch (ack.result) {
    case "received":
    case "unknown":
      return { kind: "ignore" };
    case "unsupported":
      return { kind: "final", final: { outcome: "failed", reason: "unsupported_action" }, acted: false };
    case "failed": {
      const reason = ack.reason ?? "no_confirmation";
      if (reason === "unreachable" || reason === "expired") return { kind: "final", final: { outcome: "unreachable" }, acted: false };
      if (reason === "no_confirmation") return { kind: "wait" };
      return { kind: "final", final: { outcome: "failed", reason }, acted: MAY_HAVE_ACTED.has(reason) };
    }
    case "applied":
    case "sent": {
      if (k.feedback === "open") return { kind: "final", final: { outcome: "sent" }, acted: true };
      // The fault names no command id: one stands per device while its bridge keeps doing it.
      const fault = ack.result === "sent" && k.confirms ? "a sent ack for an action declared confirms: true" : undefined;
      if (fault) return { kind: "wait", fault };
      if (k.stateless) return { kind: "final", final: { outcome: ack.result === "applied" ? "delivered" : "sent" }, acted: true };
      if (acksWithoutState && ack.result === "applied") return { kind: "final", final: { outcome: "acked" }, acted: true };
      return { kind: "wait" };
    }
  }
}

/**
 * The step's bound passed with no final outcome: an open device's step is `unanswered`, a closed
 * device's `failed(no_ack)` (GA-APPLY-8, GA-STATE-4).
 */
export function onBound(k: StepKind): Final {
  return k.feedback === "open" ? { outcome: "unanswered" } : { outcome: "failed", reason: "no_ack" };
}

/**
 * The step's bridge was found dead while it waits: a closed device's step is `failed(no_ack)` at
 * once, since waiting out the bound would say no more (GA-APPLY-8); an open device's waits for its
 * bound, as nothing it could hear would end it sooner.
 */
export function onBridgeDead(k: StepKind): Final | undefined {
  return k.feedback === "closed" ? { outcome: "failed", reason: "no_ack" } : undefined;
}
