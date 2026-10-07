-- Slice 2b: the owner's declarations for each device, and the notices not yet taken. It names no
-- schema (the storage design, *Inside a build*). Never edit this file once applied; add the next one.

-- A device's declarations, as `configure` and `adopt` gave them (tiers raised, load, infrastructure,
-- fresh_s, ack_within_s, self_changing, personal, opens_with): configuration, like the adoptions.
CREATE TABLE declarations (device text PRIMARY KEY, body jsonb NOT NULL);

-- Every notice until a client takes it (GA-PERSIST-1). A notice raised "once while it stands" has a
-- key: `standing` stays true, the notice taken or not, until what it says has cleared, so it is not
-- raised again across a restart.
CREATE TABLE notices (
  id text PRIMARY KEY,
  raised_ms bigint NOT NULL,
  key text,
  body jsonb NOT NULL,
  taken boolean NOT NULL DEFAULT false,
  standing boolean NOT NULL DEFAULT false
);
CREATE INDEX notices_key ON notices (key);
