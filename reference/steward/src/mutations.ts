/** The negative subjects this build implements (steward, *Negative subjects*), one switch each. */
export const MUTATIONS = [
  // Slice 1: the skeleton.
  "speaks-only-2025", "calls-its-applier-at-2025", "trusts-any-applier", "app-without-person", "serves-the-confirm-on",
  // Slice 2a: targets, principals, plans.
  "defines-unadopted", "rooms-an-internal-device", "selects-internal", "trusts-asserted-via", "takes-any-speaker", "unlocks-by-voice",
  "visitor-acts", "refuses-the-toggle", "skips-the-ask-event",
  // Slice 2b: answers, tokens, apply.
  "takes-any-answer", "reuses-an-utterance", "answers-unasked-steps", "follow-up-yes", "tokens-without-a-yes",
  "folds-the-toggle-into-the-tier", "outcome-without-a-time",
  // Slice 3a: leases, occupancy, notices.
  "ignores-leases", "vacant-on-a-slow-sensor", "trusts-the-callers-from", "sends-from-to-an-old-applier",
  // Slice 3b: rules.
  "rules-a-wake-relay", "rule-on-stale-reading", "rule-on-an-assumed-value", "window-on-the-end-day", "not-in-skips-unknown",
  "fires-on-a-retired-token", "authors-a-toggle", "conditions-fire-once", "fires-in-an-exception",
  // Slice 4: what a rule's outcome does.
  "locks-once-and-gives-up", "retries-hours-later", "leaves-it-unanswered", "retries-a-shutdown",
  "fails-the-limit-silently", "notices-a-slow-lock", "holds-an-ssh-only-lock", "times-the-lock", "drops-a-held-notice",
  "notices-a-slow-late-ack", "notices-every-skipped-toggle", "notices-a-late-launch", "notices-every-lease",
  "defines-a-toggle-rule-silently", "re-declares-a-toggle-silently",
  // Slice 5: scenarios.
  "drops-the-starting-endpoint", "branches-on-an-assumed-value", "stales-an-assumed-if", "toggles-on-an-old-yes",
  // Slice 6: schedules.
  "passes-a-skipped-toggle", "schedules-a-toggle-silently",
  // Slice 10: work through a brain.
  "authors-a-moved-device",
  // Slice 11: restarts.
  "forgets-a-held-notice",
] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** `GALATEA_MUTATION`, honoured only under the harness (`GALATEA_TEST_RUN_ID` set). */
export function mutationFromEnv(env: NodeJS.ProcessEnv): Mutation | undefined {
  const m = env.GALATEA_MUTATION;
  if (!env.GALATEA_TEST_RUN_ID || !m) return undefined;
  if (!(MUTATIONS as readonly string[]).includes(m)) throw new Error(`unknown mutation ${m}`);
  return m as Mutation;
}
