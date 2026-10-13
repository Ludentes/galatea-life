-- Steward 0.12: a person's hold's state (its change's time and direction, the moment its room last
-- became quiet, its ack floor), kept as wall-clock instants so a restart judges it again from them
-- (GA-LEASE-7, GA-PERSIST-2). A person's lease kept from before has no such state, so it is not
-- carried: the rows at person precedence that are not a run's lease are dropped, and the device is
-- free until its next change. Never edit this file once applied; add the next one.
ALTER TABLE leases ADD COLUMN hold jsonb;
DELETE FROM leases WHERE precedence = 'person' AND NOT (holder ? 'run');
