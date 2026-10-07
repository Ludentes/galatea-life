import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";
import { KEY_HELD_MS } from "../core/keys.js";

/**
 * What provisioning keeps in the store (GA-PERSIST-1, GA-PROV-3): each request, committed before its
 * publish, and its result. Every write here is safe to run twice.
 */

/** A provisioning request's result, as `provision` returns it. */
export type ProvisionResult = {
  request_id: string;
  op: string;
  status: "ok" | "accepted" | "invalid_request" | "failed" | "unreachable";
  data?: unknown;
  reason?: string;
};

/** A request as it is kept: its bridge, its key and body when keyed, its result, and when it was made. */
export type ProvisionRow = {
  request_id: string;
  op: string;
  bridge: string;
  key?: string;
  body?: string;
  result: ProvisionResult;
  created_ms: number;
  /** A `connect`'s: when its wait ends (slice 5b); none for an operation that ends at its reply. */
  ends_ms?: number;
};

/**
 * A new request. A keyed one first deletes the row its key still names past its 3600 s, so a key
 * names one row; a row already there (its request id, or its key) is left as it is: a conflict never
 * stops the writer.
 */
export async function saveRequest(tx: Tx, r: ProvisionRow): Promise<void> {
  if (r.key !== undefined) {
    await tx.query("DELETE FROM provisions WHERE idempotency_key = $1 AND request_id <> $2 AND created_ms + $3 <= $4",
      [r.key, r.request_id, KEY_HELD_MS, r.created_ms]);
  }
  await tx.query("INSERT INTO provisions (request_id, op, bridge, idempotency_key, body, result, created_ms, ends_ms, ended) "
    + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING",
  [r.request_id, r.op, r.bridge, r.key ?? null, r.body ?? null, JSON.stringify(r.result), r.created_ms, r.ends_ms ?? null,
    r.ends_ms === undefined]);
}

/** A request's result replaced: a later reply carrying its requestId; `ended`, a `connect` whose wait is over. */
export async function saveResult(tx: Tx, result: ProvisionResult, ended?: boolean): Promise<void> {
  if (ended) await tx.query("UPDATE provisions SET result = $2, ended = true WHERE request_id = $1", [result.request_id, JSON.stringify(result)]);
  else await tx.query("UPDATE provisions SET result = $2 WHERE request_id = $1", [result.request_id, JSON.stringify(result)]);
}

/** A result in the order `provision` gives its fields, whatever order the store's jsonb gave them back in. */
function inOrder(r: ProvisionResult): ProvisionResult {
  return { request_id: r.request_id, op: r.op, status: r.status, ...(r.data !== undefined ? { data: r.data } : {}),
    ...(r.reason !== undefined ? { reason: r.reason } : {}) };
}

/** A request as a start reads it back. */
export type LoadedRow = ProvisionRow & { ended: boolean };

/** The requests of the last 3600 s, and any not yet ended, oldest first: a key used again names its latest. */
export async function loadRequests(store: Store, nowMs: number): Promise<LoadedRow[]> {
  const r = await store.query<{ request_id: string; op: string; bridge: string; idempotency_key: string | null; body: string | null;
    result: ProvisionResult; created_ms: number | string; ended: boolean }>(
    "SELECT request_id, op, bridge, idempotency_key, body, result, created_ms, ended FROM provisions "
    + "WHERE created_ms > $1 OR NOT ended ORDER BY created_ms, request_id", [nowMs - KEY_HELD_MS]);
  return r.rows.map((x) => ({ request_id: x.request_id, op: x.op, bridge: x.bridge,
    ...(x.idempotency_key !== null ? { key: x.idempotency_key } : {}), ...(x.body !== null ? { body: x.body } : {}),
    result: inOrder(x.result), created_ms: Number(x.created_ms), ended: x.ended }));
}

/** Requests past their 3600 s, never one not ended (a connect's wait, slice 5b). Safe to run twice. */
export async function pruneRequests(tx: Tx, beforeMs: number): Promise<void> {
  await tx.query("DELETE FROM provisions WHERE created_ms <= $1 AND ended", [beforeMs]);
}
