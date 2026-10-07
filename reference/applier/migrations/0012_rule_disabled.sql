-- Slice 6b: a safety rule disabled by a change of its devices' declarations (GA-SAFE-13). It names no
-- schema (the storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- Why the rule was disabled, or null while it runs: part of the configuration, written with it. The
-- owner setting the rule again clears it.
ALTER TABLE safety_rules ADD COLUMN disabled text;
