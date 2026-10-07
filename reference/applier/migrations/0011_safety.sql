-- Slice 6a: safety rules (applier, *Safety rules*). It names no schema (the storage design, *Inside a
-- build*). Never edit this file once applied; add the next one.

-- The owner's safety rules, each as configure took it: part of the configuration, written with it.
CREATE TABLE safety_rules (id text PRIMARY KEY, body jsonb NOT NULL);

-- The latest basis_time the applier saw for each key a safety rule reads (GA-SAFE-11: "the last seen
-- is kept across a restart"), so a report a restart finds again is not a new one. Written behind.
CREATE TABLE safety_seen (device text NOT NULL, key text NOT NULL, basis_ms bigint NOT NULL, PRIMARY KEY (device, key));

-- Each rule's trigger as it last read, and its run while it runs: the apply row holding its
-- actuations' outcomes. A restart finds a trigger already true not becoming true again, and a rule
-- still running still guarding its devices (GA-SAFE-2, GA-SAFE-11). Written behind.
CREATE TABLE safety_state (rule_id text PRIMARY KEY, trigger_true boolean NOT NULL, apply_id text);

-- A safety rule's run is held with the applies, under no client: its rule.
ALTER TABLE applies ADD COLUMN rule_id text;
