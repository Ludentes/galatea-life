-- Slice 2b: a plan's answers, where its question was put, and whether it was applied, read back at
-- start with the plan (GA-PERSIST-2, ruled 2026-10-04); and the utterance records that answered a
-- plan, kept until no plan could still take them again (GA-CONF-2). Never edit this file once
-- applied; add the next one.
ALTER TABLE plans ADD COLUMN asked_at text NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN answers jsonb NOT NULL DEFAULT '{}';
ALTER TABLE plans ADD COLUMN applied boolean NOT NULL DEFAULT false;
CREATE TABLE utterances (utterance_id text PRIMARY KEY, plan_id text NOT NULL, endpoint text NOT NULL, time_ms bigint NOT NULL,
  transcript text NOT NULL);
