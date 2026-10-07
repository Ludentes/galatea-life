-- Slice 2a: each plan with an ask, kept from before it is returned until it is forgotten, held as long
-- again as it lived, with when it was made and when each step was asked (GA-PERSIST-2, GA-CONF-1,
-- GA-CONF-2): slice 2b reads them back at start, with the answers. A plan with no ask lives 60 s in
-- memory only, an accepted loss across a restart. Never edit this file once applied; add the next one.
CREATE TABLE plans (plan_id text PRIMARY KEY, credential text NOT NULL, made_ms bigint NOT NULL, expires_ms bigint NOT NULL,
  forget_ms bigint NOT NULL, asked jsonb NOT NULL, doc jsonb NOT NULL);
CREATE INDEX plans_forget ON plans (forget_ms);
