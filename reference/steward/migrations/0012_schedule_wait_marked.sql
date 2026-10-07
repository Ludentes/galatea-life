-- Slice 11: a schedule's wait whose date is marked already (steward, Schedules; GA-PERSIST-2): a start
-- that found its single scenario just started, between its date's mark committing and its run, waits
-- within the grace with the date marked (the milestone 5+6 review, M10), and is kept too, so a restart
-- inside the grace goes on waiting, and one after it records the date missed. A wait not marked is the
-- one of a date not yet marked, as before. Never edit this file once applied; add the next one.
ALTER TABLE schedule_pending ADD COLUMN marked boolean NOT NULL DEFAULT false;
