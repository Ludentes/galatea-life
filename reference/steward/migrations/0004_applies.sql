-- Slice 2b: each apply, keyed by its credential's idempotency key, kept 3600 s (GA-STW-6), its record
-- committed before the applier call is made, its outcomes written behind as they come. Never edit
-- this file once applied; add the next one.
CREATE TABLE applies (credential text NOT NULL, key text NOT NULL, apply_id text NOT NULL UNIQUE, at_ms bigint NOT NULL, body text NOT NULL,
  doc jsonb NOT NULL, PRIMARY KEY (credential, key));
CREATE INDEX applies_at ON applies (at_ms);
