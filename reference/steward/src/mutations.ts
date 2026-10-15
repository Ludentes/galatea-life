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
  // Steward 0.11: notice channels and held notices.
  "refuses-the-first-define", "refuses-an-announcing-channel", "takes-a-silent-channel", "hides-no-notify-channel", "hides-the-held-notices",
  "loses-an-early-notice", "forgets-an-unsent-notice", "keeps-a-dead-channel-quiet",
  // Steward 0.11: the ask event's steps and the define event's diff.
  "asks-without-the-steps", "broadcasts-the-steps", "broadcasts-the-diff",
  // Steward 0.11: change sets merge, delete by key, and keep their shapes.
  "renames-away-the-room", "drops-confirm-on", "deletes-the-missing", "takes-a-short-secret",
  "re-fires-at-every-lease-end", "forgets-a-replaced-lease", "lease-end-fires-in-an-exception",
  "replays-on-old-conditions", "replays-undeclared", "replays-a-time-trigger", "replays-a-fired-edge", "replays-past-its-bound",
  "fires-before-the-duration", "forgets-a-restart-hand",
  "ends-a-safety-lease-early", "ends-a-safety-lease-undeclared", "forgets-a-safety-refusal",
  "never-notices-again", "coalesces-a-failed-lock", "forgets-an-asked-plan",
  "runs-a-stepped-schedule", "visitor-stops-a-schedule",
  // Steward 0.12: the hold policy.
  "null-keeps-the-window", "hides-the-hold-policy", "refuses-a-short-hold", "refuses-a-flag-unnamed",
  // Steward 0.12: how a person's hold ends.
  "ends-a-hold-while-busy", "never-ends-a-quiet-hold", "same-window-both-ways", "vacant-ends-a-remote-hold",
  "ends-a-hold-before-the-ack", "renews-a-capped-heater", "roomless-on-window",
  "renews-when-told-not-to", "fixed-expires", "ignores-the-cap", "misses-a-vacancy",
  // Steward 0.12: what a hold's lease events say, and when its timer falls due.
  "grants-no-direction", "ends-without-a-reason", "gap-end-without-time", "ends-a-hold-late",
  // Steward 0.12: judging every hold as its room and policy move.
  "quiet-without-its-moment", "keeps-a-removed-hold", "missed-change-full-window",
  // Steward 0.12: what takes and moves a hold.
  "floor-waits-past-sent", "sensor-reading-holds", "metering-holds", "unadopted-holds", "renews-on-a-dead-sensor",
  // Steward 0.12: a hold across a restart.
  "restarts-the-quiet",
  // Steward 0.12: a press is a person's.
  "refuses-the-press", "press-loses-the-hold", "brain-groups-a-press", "press-over-safety", "press-without-a-hold",
  "any-occurrence-is-a-press", "brain-press-overrides", "press-skips-conditions", "press-asks-the-tier", "names-the-presser",
  "press-on-liveness", "press-over-the-cap", "press-cancels-on-unreachable", "press-hold-dies-with-rule",
  // Steward 0.12: the owner's work passes a guest's hold.
  "guest-hold-blocks-the-owner", "passes-undeclared", "brain-rule-passes-a-guest", "passes-a-member-hold", "named-speaker-is-a-guest",
  "passes-inside-the-floor", "two-leases-at-once",
  // Steward 0.12: narrowing actions pass a person's hold.
  "press-lock-holds", "holds-the-auto-lock", "narrows-a-heater", "narrowing-takes-a-hold", "narrows-over-safety", "closes-by-opens-with",
  "narrows-over-a-run", "narrows-by-toggle",
  // Steward 0.13: the owner passes a person's hold.
  "refuses-the-owner-switch", "brain-sets-the-device-switch", "brain-marks-a-rule", "brain-sets-the-home-switch",
  "owner-passes-the-cap", "owner-passes-a-run", "owner-passes-safety", "passes-a-hold-in-its-floor", "switch-spares-held-holds", "refuses-on-the-persons-own-report",
  "unmarked-rule-passes", "ignores-the-device-switch", "ignores-the-home-switch", "brain-rule-passes-holds", "brain-groups-past-a-hold",
  "marked-press-passes", "passing-ends-the-hold", "pass-moves-the-end", "pass-re-evaluates-early",
  "marked-run-refused", "brain-edits-a-passing-scenario", "passing-takes-a-lease",
  "pass-unrecorded", "pass-as-a-lease", "pass-reveals-a-personal-press", "home-switch-reopens",
] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** `GALATEA_MUTATION`, honoured only under the harness (`GALATEA_TEST_RUN_ID` set). */
export function mutationFromEnv(env: NodeJS.ProcessEnv): Mutation | undefined {
  const m = env.GALATEA_MUTATION;
  if (!env.GALATEA_TEST_RUN_ID || !m) return undefined;
  if (!(MUTATIONS as readonly string[]).includes(m)) throw new Error(`unknown mutation ${m}`);
  return m as Mutation;
}
