-- Slice 3: adoption. It names no schema (the storage design, *Inside a build*). Never edit this file
-- once applied; add the next one.

-- The identifiers of the hardware each device replaced, oldest first (applier, *Adoption*): retired,
-- so they never take the id back (GA-ADOPT-2, GA-PERSIST-1). The owner's, like the adoptions: a
-- replacement also re-points the device's row in `devices`, the id map, in the same write set.
CREATE TABLE previous_identifiers (device text PRIMARY KEY, identifiers jsonb NOT NULL);
