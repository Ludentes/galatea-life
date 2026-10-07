-- Slice 3b: each rule's state (steward, Rules; GA-RULE-1, GA-STW-10): whether it fired since it last
-- became true, and when (`fired_at`, so a window or an exception that ended while the steward was down
-- is seen ending at the start), and the firing numbers reserved, whose keys `rule:<id>:<n>` never repeat. Written
-- behind, one row per rule id, kept when the rule is deleted so a rule made again never reuses a key.
-- Never edit this file once applied; add the next one.
CREATE TABLE rule_states (rule_id text PRIMARY KEY, fired boolean NOT NULL, fired_at bigint, reserved bigint NOT NULL);
