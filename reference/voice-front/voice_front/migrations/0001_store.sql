-- The front's store: utterances and `played` reports for its brains, the
-- pieces said, and an index of kept audio (the bytes are files).
CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE log (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('utterance', 'played')),
    brain text NOT NULL,
    item_id text NOT NULL,
    body jsonb NOT NULL,
    kept_at double precision NOT NULL,
    UNIQUE (kind, item_id)      -- a retried add is one item; the index serves the lookups by id
);
CREATE INDEX log_brain ON log (brain, seq);
CREATE INDEX log_kept ON log (kept_at);

CREATE TABLE says (
    say_id text PRIMARY KEY,
    brain text NOT NULL,
    endpoint text NOT NULL,
    kept_at double precision NOT NULL
);

CREATE TABLE audio (
    utterance_id text PRIMARY KEY,
    path text NOT NULL,
    sha256 text NOT NULL,
    until double precision NOT NULL
);
