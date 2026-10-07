-- Slice 7b: what Safe held only in memory, kept across a restart (GA-PERSIST-1). It names no schema
-- (the storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- A running rule's actuations: each one's attempt, state and what was said of it; and what its
-- standing waiting notice last said, so a restart does not say it again (GA-SAFE-8, GA-SAFE-12).
ALTER TABLE safety_state ADD COLUMN acts jsonb, ADD COLUMN wait_said text;

-- An own run's commands published for each action slot: a start names the next command by it, so a
-- command a crash lost is sent again under its first id (the maintainer's ruling 2).
ALTER TABLE applies ADD COLUMN pubs jsonb;

-- A rule's device whose stop was said (GA-SAFE-10): said once, not again after a restart.
CREATE TABLE safety_said (key text PRIMARY KEY);

-- A socket's cap at work: its run, attempt and state while it turns the socket off, what its notice said,
-- what stopped it, and the on-time it ends (GA-LOAD-2).
CREATE TABLE load_caps (device text PRIMARY KEY, apply_id text, attempt integer NOT NULL, state text NOT NULL,
  began_ms bigint NOT NULL, said text, stuck text, since_ms bigint);

-- A socket's on-time keeps the cap's last attempt on it, apart from the cap's row, which goes when the
-- cap stops: a cap armed again on the same on-time goes on from it (the 7b preflight's I1).
ALTER TABLE load_on ADD COLUMN attempt integer;

-- A witness's watch: what judging it `unknown` after a restart needs, and nothing more (GA-WIT-1).
CREATE TABLE witness_watches (apply_id text NOT NULL, step_id text NOT NULL, run jsonb NOT NULL, target text NOT NULL,
  action text NOT NULL, witness jsonb NOT NULL, due_ms bigint NOT NULL, PRIMARY KEY (apply_id, step_id));
