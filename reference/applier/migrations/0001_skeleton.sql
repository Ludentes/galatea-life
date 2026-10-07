-- Slice 1: the configuration, the model's counters, and the event log. It names no schema: the
-- tables land in the applier's own (the storage design, *Inside a build*). Never edit this file
-- once applied; add the next one.
CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE clients (id text PRIMARY KEY, credential text NOT NULL UNIQUE, token_key text, kind text NOT NULL);
CREATE TABLE bridges (id text PRIMARY KEY, identity text NOT NULL);
CREATE TABLE events (seq bigint PRIMARY KEY, time_ms bigint NOT NULL, type text NOT NULL, body jsonb NOT NULL);
CREATE INDEX events_time ON events (time_ms);

-- The history the reader role may read: GA-EVT-5's kinds, with a state event's speech left out.
-- The tables behind it may change; this view is the promise.
CREATE VIEW history_v AS
  SELECT seq, to_timestamp(time_ms / 1000.0) AS time, type, body
  FROM events
  WHERE type IN ('state', 'outcome', 'late_ack', 'liveness', 'rule_fired', 'latch', 'model', 'route_conflict',
                 'provision', 'freshness', 'transport', 'other_admins', 'bridge_fault')
    AND NOT (type = 'state' AND body->>'key' = 'speech');

-- reader may use this schema, whatever the installation named it, and read the view and nothing else.
DO $$ BEGIN EXECUTE format('GRANT USAGE ON SCHEMA %I TO reader', current_schema()); END $$;
GRANT SELECT ON history_v TO reader;
