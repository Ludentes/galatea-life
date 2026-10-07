-- Slice 5: each scenario run (steward, Scenario runs): a client's run keyed by its credential's
-- idempotency key, kept 3600 s (GA-SCN-6) and committed before the run starts; a rule-started run's
-- written behind; its status and failed steps written behind as they change. A run the store holds as
-- running at a start ended interrupted (GA-PERSIST-2). Never edit this file once applied; add the next one.
CREATE TABLE runs (run_id text PRIMARY KEY, credential text, key text, body text, at_ms bigint NOT NULL, scenario text NOT NULL, doc jsonb NOT NULL);
CREATE UNIQUE INDEX runs_key ON runs (credential, key);
CREATE INDEX runs_at ON runs (at_ms);
-- The key of a start that a running `single` scenario ignored (GA-SCN-1), answered as the run it
-- named: committed before the answer, kept 3600 s, so a restart answers it the same (GA-SCN-6).
CREATE TABLE run_keys (credential text NOT NULL, key text NOT NULL, body text NOT NULL, at_ms bigint NOT NULL, run_id text NOT NULL, PRIMARY KEY (credential, key));
