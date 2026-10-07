-- Slice 4c: idempotency keys (GA-APPLY-4, GA-APPLY-10). It names no schema (the storage design,
-- *Inside a build*). Never edit this file once applied; add the next one.

-- An apply's idempotency key, and its body as GA-APPLY-4 compares it (RFC 8785, without the key and
-- without the actions' tokens), kept with its outcomes while the apply is held, 3600 s
-- (GA-PERSIST-1's idempotency keys with outcomes). Written, and committed, before any of its steps
-- is dispatched. An apply kept before this file has neither. No unique index: once its 3600 s are
-- over a key is free again, while the old row may still wait for the prune.
ALTER TABLE applies ADD COLUMN idempotency_key text;
ALTER TABLE applies ADD COLUMN body text;
