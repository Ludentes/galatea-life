/** The standard's request errors (applier, *Operations*). */
export type ErrorCode = "invalid_request" | "not_claimed" | "not_permitted" | "unknown_plan" | "unknown_apply"
  | "plan_expired" | "stale_revision" | "plan_not_yours" | "cursor_expired" | "idempotency_conflict" | "cycle";

/** A request the applier cannot act on at all; the MCP layer turns it into `{ error, message }`. */
export class RequestError extends Error {
  /** `data`: the structured details a requirement names (applier, *Errors*; GA-SAFE-14). */
  constructor(readonly code: ErrorCode, message: string, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * The store did not keep a write in time, or cannot be read. No standard names a code for it, so
 * the MCP layer answers an internal error (the storage design, *When the store is unreachable*).
 */
export class StoreUnavailable extends Error {}
