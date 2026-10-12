/** The negative subjects this build implements (applier, *Negative subjects*), one switch each. */
export const MUTATIONS = [
  "speaks-only-2025", "session-outlives-revocation",
  // Slice 2a: the bus.
  "one-bad-entry-silences", "trusts-a-fast-clock", "rejects-unknown-kind", "ignores-seq-gap", "plans-through-broker-loss",
  "trusts-retained-online", "fresh-by-arrival", "plans-for-a-faulted-bridge", "live-before-known",
  // Slice 2b: declarations and notices.
  "ignores-owner-bound", "keeps-a-tier-below-a-new-load", "kills-a-mute-transmitters-devices", "swallows-device-fault",
  // Slice 3: adoption.
  "replaces-without-rules", "merges-a-claimant", "hides-a-second-door", "adopts-a-mute-device-quietly",
  "upgrades-a-mute-device-quietly",
  // Slice 4a: plans, the reason order and tokens.
  "plans-with-side-effect", "applies-without-token", "trusts-any-token", "toggles-to-reach-a-state", "answers-a-toggle-by-rule",
  "asks-a-closed-loop-toggle", "refuses-a-panel-toggle",
  // Slice 4b: apply and dispatch.
  "never-fails-a-silent-ack", "acks-without-state", "reuses-token-after-late-unreachable", "reissues-inside-the-bound",
  "retains-request", "resends-after-reconnect", "trusts-a-foreign-ack", "sends-from-to-an-old-bridge",
  "drops-the-ack-detail",
  // Slice 4c: idempotency keys, late acks, reissue and whole_state.
  "reissues-on-timeout", "sends-the-old-mode", "keeps-a-failed-mode", "forgets-what-the-frame-said", "assumes-a-failed-write",
  "forgets-the-unanswered",
  // Applier 0.14: extensions on any device, occurrences, and declarations that change.
  "lowers-a-lock-extension", "stores-an-occurrence-as-state", "history-keeps-a-personal-occurrence",
  "plans-on-a-stale-declaration", "dispatches-a-changed-step",
  // Slice 6a: safety rules fire and guard.
  "lets-a-client-undo-safety", "toggles-by-safety-rule", "fires-on-an-assumed-value",
  // Slice 6b: it holds.
  "keeps-a-rule-on-a-re-taught-code", "latch-misses-an-extension", "clears-a-latch-on-an-assumed-value",
  "gives-up-on-dead", "resends-what-may-have-run",
  "floods-reload-notices", "silent-on-liveness",
  // Slice 6c: loads, witnesses and computers.
  "leaves-heat-on", "never-caps-a-silent-heater", "retries-a-pulse-off", "toggles-a-cap-off", "adopts-an-uncappable-socket-quietly",
  "ignores-the-broker-hosts-admins", "counts-the-applier-hosts-admins", "marks-two-applier-hosts",
  // Slice 7a: restarts, the gate and dispatch.
  "forgets-an-ack-deadline", "forgets-a-retired-identifier", "forgets-a-used-token", "uses-a-token-behind",
  "forgets-an-idempotency-key", "sends-a-bare-setpoint", "skips-lost-events",
  // Slice 5a: provisioning.
  "provisions-for-anyone", "provisions-twice", "hides-new-devices",
  // Slice 5a, proposed for 0.16 (proposed-rows.json): a restart forgets the owner's provisioning keys.
  "forgets-a-provision-key",
  // Slice 7b: Safe across a restart.
  "loses-a-fired-run", "draws-a-fresh-command-id", "forgets-a-running-rule", "forgets-what-it-saw", "forgets-a-latch",
  "forgets-a-notice", "forgets-a-said-stop",
  "forgets-an-on-time", "forgets-a-cap", "forgets-a-watch",
  // Slice 5b: discovery.
  "trusts-a-dead-finder", "plans-on-a-candidate", "shows-candidates-to-a-client", "hides-the-finders-sources",
  "lists-a-held-candidate", "forgets-an-ignore", "connects-to-the-wrong-bridge", "event-without-request-id",
  "never-ends-a-connect", "ignores-the-address",
  // Slice 5b, proposed for 0.16 (proposed-rows.json): a restart forgets a dead bridge's connections; an
  // ignore moves the revision; a set of only ignores is checked for its revision; a connect in flight is never ended at a restart.
  "forgets-connections", "ignore-moves-the-revision", "checks-revision-for-ignores", "forgets-a-connect",
  // The Zigbee-fidelity slice, proposed for 0.16 (proposed-rows.json): a one-argument extension action's value wrapped.
  "wraps-a-lone-argument",
  // Applier 0.15 (the fidelity slice): describe's bridge lists, the undescribed relay, keys a rule reads.
  "hides-awaited-keys", "drops-the-undescribed-event", "accepts-a-safety-rule-on-an-undeclared-key", "floors-message-expiry",
  // Proposed for 0.16 (proposed-rows.json): a restart forgets the undescribed names it announced.
  "forgets-announced-names",
  // Applier 0.16: the owner lowers a tier to its floor (HS35), judged against the end state; a key's first value.
  "keeps-an-owner-raise", "keeps-an-owner-raise-on-a-set", "keeps-a-manifest-kept-tier", "lowers-a-heater-below-the-table",
  "keeps-a-table-tier-over-a-new-load",
  "externalises-a-first-value", "externalises-a-snapshot-value", "externalises-a-rerouted-value", "devices-a-live-press",
  // A hosted device's tiers, and a computer's proposal (applier, *Plugins' actions*); a replacement's tool hash and manifest (GA-DESC-11).
  "extension-under-the-box", "sleeps-the-box-through-its-player", "sleeps-the-proposed-broker-host",
  "forgets-a-tool-hash", "lowers-by-a-new-manifest", "keeps-a-lowered-tier",
] as const;
export type Mutation = (typeof MUTATIONS)[number];

/**
 * `GALATEA_MUTATION`, honoured only under the harness (`GALATEA_TEST_RUN_ID` set). A mutation that
 * defeats a safety floor (a token, a safety rule's guard) is taken only with the harness's clock
 * (`GALATEA_TIME_SOURCE`) as well, so a production image never runs one because a single variable was
 * set. Throws for a mutation this build does not have, or one it will not take here. (Its list lives in
 * here, where the reach lint reads no mutation site.)
 */
export function mutationFromEnv(env: NodeJS.ProcessEnv): Mutation | undefined {
  const m = env.GALATEA_MUTATION;
  if (!env.GALATEA_TEST_RUN_ID || !m) return undefined;
  if (!(MUTATIONS as readonly string[]).includes(m)) throw new Error("GALATEA_MUTATION names no mutation this build has");
  const defeatsSafety = ["trusts-any-token", "applies-without-token", "lets-a-client-undo-safety"];
  if (defeatsSafety.includes(m) && !env.GALATEA_TIME_SOURCE) {
    throw new Error(`GALATEA_MUTATION ${m} defeats a safety floor, and is taken only with the harness's clock (GALATEA_TIME_SOURCE)`);
  }
  return m as Mutation;
}

/** A mutation's name as a flag: `trusts-any-token` is `trustsAnyToken`, `speaks-only-2025` is `speaksOnly2025`. */
type Flag<S extends string> = S extends `${infer H}-${infer T}` ? `${H}${Capitalize<Flag<T>>}` : S;

/**
 * The mutation as the build reads it: a frozen record of one flag per mutation, every flag false but
 * the mutation's (`mutant.trustsAnyToken`). `start.ts` builds it once (`mutantOf`); production, and
 * any host, runs on `Mutant.none`. The reach lint finds a mutation's sites by its flag.
 */
export type Mutant = Readonly<Record<Flag<Mutation>, boolean>>;

/** The record for `mutation`: every flag false without one. (The reach lint reads no site in here.) */
export function mutantOf(mutation?: Mutation): Mutant {
  return Object.freeze(Object.fromEntries(MUTATIONS.map((m) => [m.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()), m === mutation]))) as Mutant;
}

/** The record with no mutation: what production runs on. */
export const Mutant = Object.freeze({ none: mutantOf() });
