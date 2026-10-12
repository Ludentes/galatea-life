-- Steward 0.11: the rules a lease refused an action of while it held (GA-LEASE-4), re-evaluated at its
-- end, handed to the lease that replaces it, and kept across a restart (GA-PERSIST-2). Never edit this
-- file once applied; add the next one.
ALTER TABLE leases ADD COLUMN refused jsonb NOT NULL DEFAULT '[]';
