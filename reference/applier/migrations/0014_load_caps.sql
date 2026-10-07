-- Slice 6c: the heating cap (applier, *Loads*, GA-LOAD-2). It names no schema (the storage design,
-- *Inside a build*). Never edit this file once applied; add the next one.

-- Each adopted socket that is on, and since when, on the applier's clock: a closed one from its first
-- report of on, an open one from the first turn_on the applier sent that ended sent or unanswered
-- (GA-PERSIST-1's "heating on-times"). Written behind; deleted when a closed one reports off, or an open
-- one's turn_off ends sent.
CREATE TABLE load_on (device text PRIMARY KEY, since_ms bigint NOT NULL);

-- A cap's turn-off is the applier's own run under no client, as a safety rule's is: the socket it caps.
ALTER TABLE applies ADD COLUMN load_cap text;
