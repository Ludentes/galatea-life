-- Slice 3a: each device's lease (steward, Leases; GA-PERSIST-2): its holder, precedence, when it was
-- granted and when it ends (null: at its run's end), and the steward's apply it came from. Written
-- behind, one row per device; a lease whose end passed while the steward was down ends at start.
-- Never edit this file once applied; add the next one.
CREATE TABLE leases (target text PRIMARY KEY, holder jsonb NOT NULL, precedence text NOT NULL, since_ms bigint NOT NULL, expires_ms bigint,
  apply text);
