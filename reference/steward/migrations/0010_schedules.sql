-- Slice 6: each schedule's mark (steward, Schedules; the design, Schedules): the latest date, in the
-- home's timezone, whose run is handled (run, skipped, or recorded missed), so no date runs twice and
-- a run missed while the steward was down is recorded at its start, never run late (GA-SCHED-2). Set
-- with the define that makes or changes a schedule, and committed before a run starts unless the
-- store is known down (ruled, Q6). Never edit this file once applied; add the next one.
CREATE TABLE schedule_marks (schedule_id text PRIMARY KEY, mark text NOT NULL);
-- A schedule whose time came while its single scenario was running waits, trying again, until the
-- grace after its time closes (ruled): the date and time it waits for, so a restart within
-- the grace goes on waiting.
CREATE TABLE schedule_pending (schedule_id text PRIMARY KEY, date text NOT NULL, at_ms bigint NOT NULL);
