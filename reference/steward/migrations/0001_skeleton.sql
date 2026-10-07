-- Slice 1: the house model, the model's counters, and the event log. It names no schema: the tables
-- land in the steward's own (the storage design, *Inside a build*). Never edit this file once
-- applied; add the next one.
CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
-- One row per object of the house model: the home's settings (kind 'home', id 'home'), rooms,
-- persons, endpoints with their voice records, and credentials, which keep a secret's SHA-256 only.
CREATE TABLE house (kind text NOT NULL, id text NOT NULL, doc jsonb NOT NULL, PRIMARY KEY (kind, id));
-- events_only: served by `events` and never by `history` (GA-STW-7: speech, a personal key's occurrence).
CREATE TABLE events (seq bigint PRIMARY KEY, time_ms bigint NOT NULL, type text NOT NULL, body jsonb NOT NULL,
  events_only boolean NOT NULL DEFAULT false);
CREATE INDEX events_time ON events (time_ms);
