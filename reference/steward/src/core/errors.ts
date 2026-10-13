/** The standard's request errors (steward, *Operations*: the applier's, plus `unknown_run`). */
export type ErrorCode = "invalid_request" | "not_claimed" | "not_permitted" | "unknown_plan" | "unknown_apply"
  | "plan_expired" | "stale_revision" | "plan_not_yours" | "cursor_expired" | "idempotency_conflict" | "cycle" | "unknown_run";

/** A request the steward cannot act on at all; the MCP layer turns it into `{ error, message }`. */
export class RequestError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * A call the steward could not settle: what was asked may be held (`pending`). The MCP layer answers
 * it as an internal error, JSON-RPC -32603, with `data.pending`.
 */
export class Unsettled extends Error {
  constructor(message: string, readonly pending: boolean) {
    super(message);
  }
}

/**
 * The store did not keep a write in time, or cannot be read. No standard names a code for it, so the
 * MCP layer answers an internal error, JSON-RPC -32603, whose `data` carries `pending` (the design,
 * *The store unreachable*): `false`, not applied and never will be; `true`, held, and taking effect
 * when the store returns, unless the steward restarts first.
 */
export class StoreUnavailable extends Unsettled {
  constructor(message: string, pending = false) {
    super(message, pending);
  }
}

/**
 * An apply the steward sent to its applier, whose answer was lost and not recovered within 10 s: the
 * apply is kept and its outcomes are not known, so it may have dispatched (the design, *The applier
 * call*). The MCP layer answers it as -32603 with `data: { pending: true, outcome_unknown: true }`.
 */
export class OutcomeUnknown extends Unsettled {
  constructor(message: string) {
    super(message, true);
  }
}
