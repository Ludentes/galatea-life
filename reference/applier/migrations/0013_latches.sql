-- Slice 6b: safety rules' latches (applier, *Latches*, GA-SAFE-7, GA-SAFE-9). It names no schema (the
-- storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- Each held latch: its rule, when it was set, the devices its rule actuated and the keys its actions
-- set there, with their values (GA-PERSIST-1's "latches"). Written behind; the owner's clear_latch
-- deletes it in the change set's own write.
CREATE TABLE safety_latches (rule_id text PRIMARY KEY, set_ms bigint NOT NULL, devices jsonb NOT NULL, keys jsonb NOT NULL);

-- After a latch cleared, each device whose undo of it is no_voice, with a person's token, until such an
-- action next runs (GA-SAFE-7): the keys it guards. Written behind.
CREATE TABLE safety_raised (device text PRIMARY KEY, keys jsonb NOT NULL);
