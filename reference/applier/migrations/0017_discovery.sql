-- Slice 5b: discovery (applier, *Discovery*, GA-DISC-2, GA-DISC-3). It names no schema (the storage
-- design, *Inside a build*). Never edit this file once applied; add the next one.

-- The owner's ignored keys (GA-DISC-3): each committed with the owner's change that adds it, kept
-- across a restart, and never part of the model.
CREATE TABLE ignored_keys (
  key text PRIMARY KEY,
  added_ms bigint NOT NULL
);

-- Each registered bridge's connections as it last gave them (GA-DISC-2), on its devices and its
-- transports, so a dead bridge's still hide what it holds after a restart. Written behind and
-- droppable, as a bridge's facts are (the maintainer's ruling K5): its next retained documents give them again.
CREATE TABLE connections (
  bridge text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('device', 'transport')),
  entity text NOT NULL,
  keys jsonb NOT NULL,
  PRIMARY KEY (bridge, kind, entity)
);
