-- Slice 4c: late acks (GA-APPLY-11). It names no schema (the storage design, *Inside a build*).
-- Never edit this file once applied; add the next one.

-- Each step that ended failed(no_ack) on a closed device, for the 60 s after it in which a report
-- matching its action is a late_ack with its apply's cause, never external: what its window reads,
-- and when the window ends, so a restart keeps it (GA-PERSIST-1's pending ack deadlines). Written
-- behind, after its outcome and before its waiting row's delete; deleted by its late_ack, or pruned.
CREATE TABLE late (command_id text PRIMARY KEY, apply_id text NOT NULL, step jsonb NOT NULL, until_ms bigint NOT NULL);
