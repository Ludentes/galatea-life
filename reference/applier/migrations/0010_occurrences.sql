-- Applier 0.14: occurrences (GA-EVT-8). It names no schema (the storage design, *Inside a build*).
-- Never edit this file once applied; add the next one.

-- An event kept in events only, never in history: an occurrence of a key in its device's personal
-- (GA-EVT-5), marked when it happened. The applier's `history` also hides an occurrence of a key
-- personal now; this view, the reader role's, holds only the mark.
ALTER TABLE events ADD COLUMN events_only boolean NOT NULL DEFAULT false;

-- The history the reader role may read: GA-EVT-5's kinds, occurrences among them, with a state
-- event's speech and every events-only event left out. Its columns are 0001's, so the grant stands.
CREATE OR REPLACE VIEW history_v AS
  SELECT seq, to_timestamp(time_ms / 1000.0) AS time, type, body
  FROM events
  WHERE type IN ('state', 'outcome', 'late_ack', 'liveness', 'rule_fired', 'latch', 'model', 'route_conflict',
                 'provision', 'freshness', 'transport', 'other_admins', 'bridge_fault', 'occurrence')
    AND NOT (type = 'state' AND body->>'key' = 'speech')
    AND NOT events_only;
