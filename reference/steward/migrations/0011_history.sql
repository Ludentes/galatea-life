-- Slice 7: history (GA-STW-7). It names no schema (the storage design, *Inside a build*). Never edit
-- this file once applied; add the next one.

-- A personal key's state or occurrence event (steward, *Personal keys*), marked when it happened:
-- `history` keeps it 7 days, not 90 (the design's choice, for privacy), and the reader role never sees
-- it. Null: not known when it happened (its device not described then), which counts as personal.
ALTER TABLE events ADD COLUMN personal boolean DEFAULT false;

-- The history the reader role may read (the storage design, *Inside a build*): GA-STW-7's kinds, with
-- every events-only event (a state event's speech, a personal key's occurrence) and every personal
-- key's event left out, since reader is no principal the personal floor can judge (the design, *Event log*).
CREATE VIEW history_v AS
  SELECT seq, to_timestamp(time_ms / 1000.0) AS time, type, body
  FROM events
  WHERE type IN ('define', 'ask', 'answer', 'lease', 'narrowed', 'refused', 'rule_fired', 'scenario', 'schedule_missed',
                 'schedule_skipped', 'notice', 'state', 'outcome', 'late_ack', 'latch', 'liveness', 'model', 'route_conflict',
                 'provision', 'freshness', 'transport', 'other_admins', 'bridge_fault', 'occurrence',
                 'undescribed')
    AND NOT events_only
    AND personal IS FALSE;
GRANT SELECT ON history_v TO reader;
