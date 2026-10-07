import { randomUUID } from "node:crypto";
import { signToken, type Token } from "@ludentes/galatea-life-binding";

/** A token expires this long after issue (steward, *Constants*; GA-CONF-3). */
export const TOKEN_EXPIRY_MS = 60_000;

/** What a token names, as the step it confirms is sent to the applier (applier GA-TOKEN-2). */
export interface Sent {
  target: string;
  action: string;
  args: Record<string, unknown>;
  via: string;
  brain: boolean;
  for: Record<string, unknown>;
}

/**
 * A confirmation token for `step` (steward, *The confirmation dialogue*; GA-CONF-3), issued at
 * dispatch: bound to its target, action, args, `via`, `brain` and `for`, expiring 60 s after `now`,
 * proved with the key the applier holds for the steward by the shared package's proof. The key and
 * the proof are never logged.
 */
export function mintToken(step: Sent, o: { issuer: string; key: string; now: number }): Token {
  return signToken({ token_id: randomUUID(), issuer: o.issuer, target: step.target, action: step.action, args: step.args, via: step.via,
    brain: step.brain, for: step.for, expires: new Date(o.now + TOKEN_EXPIRY_MS).toISOString() }, o.key);
}
