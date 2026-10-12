-- Steward 0.11: who may read an event's question or diff (GA-CONF-5, GA-STW-7). An `ask` event's
-- `steps` and a `define` event's `diff` go only to a read at its endpoint, one whose derived role is
-- `owner`, or one whose derived person is its speaker; `readers` keeps that endpoint and speaker, null
-- on every other event. Never edit this file once applied; add the next one.
ALTER TABLE events ADD COLUMN readers jsonb;

-- A `define` event kept from before this migration has its diff: its endpoint and the owner's role
-- keep it, as for a new one (its speaker is not known); an earlier `ask` event carries no steps.
UPDATE events SET readers = jsonb_build_object('endpoint', body->>'endpoint') WHERE type = 'define' AND readers IS NULL;

-- The reader role is no principal the filter can judge: it reads those events without them.
CREATE OR REPLACE VIEW history_v AS
  SELECT seq, to_timestamp(time_ms / 1000.0) AS time, type,
         CASE WHEN readers IS NULL THEN body ELSE body - 'steps' - 'diff' END AS body
  FROM events
  WHERE type IN ('define', 'ask', 'answer', 'lease', 'narrowed', 'refused', 'rule_fired', 'scenario', 'schedule_missed',
                 'schedule_skipped', 'notice', 'state', 'outcome', 'late_ack', 'latch', 'liveness', 'model', 'route_conflict',
                 'provision', 'freshness', 'transport', 'other_admins', 'bridge_fault', 'occurrence',
                 'undescribed')
    AND NOT events_only
    AND personal IS FALSE;
