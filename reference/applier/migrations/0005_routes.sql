-- Slice 4a: routes (GA-BUS-11). It names no schema (the storage design, *Inside a build*). Never
-- edit this file once applied; add the next one.

-- The bridge the owner routed each stable identifier to, when two bridges report it: the owner's,
-- like the adoptions, written whole with the configuration.
CREATE TABLE routes (stable_identifier text PRIMARY KEY, bridge text NOT NULL);

-- A copy of an unadopted device that another bridge reports is folded into it: the model holds the
-- copy, under an id of its own, but exposes one device, whose id `folded_into` names. Written with
-- the row, behind, as the device is.
ALTER TABLE devices ADD COLUMN folded_into text;
