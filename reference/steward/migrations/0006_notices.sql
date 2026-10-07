-- Slice 3a: each notice not yet delivered, and each of the applier's delivered but not yet released
-- (steward, Notices; GA-NOTE-1): where it came from, the notice as given, how many attempts were made
-- (the next attempt's key), and whether it was delivered. Written behind, one row per notice; a
-- notice not delivered is tried again at start.
-- Never edit this file once applied; add the next one.
CREATE TABLE notices (notice_id text PRIMARY KEY, source text NOT NULL, doc jsonb NOT NULL, attempts integer NOT NULL, delivered boolean NOT NULL);
