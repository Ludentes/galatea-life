-- Slice 4c: an open device's assumed state (GA-STATE-4, GA-APPLY-16). It names no schema (the
-- storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- Each key of a feedback: open device the applier holds an assumed value for: the value the last
-- action on it that ended sent or unanswered set (for a whole-state command, every key it carried),
-- and when that action ended, so that a whole-state command after a restart still carries it
-- (GA-PERSIST-1's assumed states). `source_seq` is the dispatch order of the command it came from, so an
-- older command that ends later never replaces it. Written behind as it changes.
CREATE TABLE assumed (device text NOT NULL, key text NOT NULL, value jsonb NOT NULL, basis_ms bigint NOT NULL,
  source_seq bigint NOT NULL, PRIMARY KEY (device, key));
