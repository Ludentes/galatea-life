-- Slice 5a: provisioning (applier, *Provisioning*, GA-PROV-1 to 3). It names no schema (the storage
-- design, *Inside a build*). Never edit this file once applied; add the next one. Slice 7b holds 0015.

-- Each provisioning request, committed before its publish, keyed or not (the maintainer's ruling K1), with
-- the record GA-PROV-3 keeps for its idempotency_key: the bridge's reply, or unreachable. A later
-- reply carrying the request's requestId replaces it, written behind. A keyed request whose key's
-- last use is past its 3600 s deletes that row in the write set that inserts the new one, so a key
-- names one row (the spec review's I4). Rows are pruned 3600 s after created_ms, never before ended.
CREATE TABLE provisions (
  request_id text PRIMARY KEY,
  op text NOT NULL,
  bridge text NOT NULL,
  idempotency_key text,
  -- The request without its key, RFC 8785, as GA-PROV-3 compares it; only for a keyed request.
  body text,
  -- { request_id, op, status, data?, reason? }, as provision returned it or would have.
  result jsonb NOT NULL,
  created_ms bigint NOT NULL,
  -- When a connect's wait ends (slice 5b); null for every operation that ends at its reply.
  ends_ms bigint,
  ended boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX provisions_key ON provisions (idempotency_key) WHERE idempotency_key IS NOT NULL;
