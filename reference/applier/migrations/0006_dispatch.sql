-- Slice 4b: apply and dispatch. It names no schema (the storage design, *Inside a build*). Never
-- edit this file once applied; add the next one.

-- Each confirmation token used, until 3600 s after its use (GA-TOKEN-4). Written, and committed,
-- before its command is published; deleted when the broker refused the command (GA-BUS-9).
CREATE TABLE used_tokens (issuer text NOT NULL, token_id text NOT NULL, until_ms bigint NOT NULL, PRIMARY KEY (issuer, token_id));

-- Each apply held for `outcome`, 3600 s after it was made: its client and each step's outcome as
-- `outcome` gives it (GA-PERSIST-1's held outcomes). Written behind as the outcomes change.
CREATE TABLE applies (apply_id text PRIMARY KEY, client text NOT NULL, created_ms bigint NOT NULL, outcomes jsonb NOT NULL);

-- Each dispatched step still waiting for its final outcome, with what its rules read and its
-- deadline, so a restart resumes it (GA-PERSIST-1's pending ack deadlines). Written behind.
CREATE TABLE waiting (command_id text PRIMARY KEY, apply_id text NOT NULL, step jsonb NOT NULL, deadline_ms bigint NOT NULL);
