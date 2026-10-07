-- Slice 4: what a rule's outcome left pending (steward, Rules; GA-RULE-7, GA-PERSIST-2), so a restart
-- does not lose it (ruled Q6): one row per rule, kind and action, `step_key` the action's canonical
-- [target, action, args]. A `retry` row makes the start clear the rule's `fired`, so the rule's start
-- evaluation fires it again (GA-RULE-1). Written behind; the start reads the rows and clears them.
-- Never edit this file once applied; add the next one.
CREATE TABLE rule_pending (rule_id text NOT NULL, kind text NOT NULL, step_key text NOT NULL, due_ms bigint NOT NULL, doc jsonb NOT NULL,
  PRIMARY KEY (rule_id, kind, step_key));
