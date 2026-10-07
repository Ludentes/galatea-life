-- Slice 2a: the devices and transports the bridges report, each keyed by its bridge and its bridge's own id (the id
-- map; never the device id alone), and the owner's adoptions. Values and liveness are state, not
-- kept: they come back from the bridges' retained topics.
CREATE TABLE devices (
  id text PRIMARY KEY,
  bridge text NOT NULL,
  bridge_device text NOT NULL,
  doc jsonb NOT NULL,
  UNIQUE (bridge, bridge_device)
);
CREATE TABLE adoptions (device text PRIMARY KEY, class text);
-- A transport of the model: its kind is the model; whether it is up is state, and not kept.
CREATE TABLE transports (
  id text PRIMARY KEY,
  bridge text NOT NULL,
  bridge_transport text NOT NULL,
  kind text NOT NULL,
  UNIQUE (bridge, bridge_transport)
);
