import type { StewardAnswerRequest } from "@ludentes/galatea-life-schemas";
import type { Principal } from "../auth/principal.js";
import { RequestError } from "../core/errors.js";
import type { Credential, House } from "../house/model.js";
import type { Mutation } from "../mutations.js";

/** The clock tolerance (steward, *Constants*): an utterance's time is judged against an ask's and the arrival with it (GA-CONF-2). */
export const CLOCK_TOLERANCE_MS = 1000;

export type Answer = "yes" | "no";
/** An utterance record (steward, *The confirmation dialogue*), as `answer` carries it. */
export type UtteranceRecord = NonNullable<StewardAnswerRequest["utterance"]>;

/** What an answer is judged against: a plan with an ask, as the steward holds it. */
export interface AskedPlan {
  planId: string;
  credential: string;
  endpoint: string;
  speaker?: string;
  revision: number;
  expiresMs: number;
  /** The endpoint the question was put on: the plan's, or the `confirm_on` that applied (GA-CONF-5). */
  askedAt: string;
  /** The step ids the plan's `ask` event named, and when each was last asked. */
  asked: string[];
  askedMs: Record<string, number>;
  /** The answers that stand, by step. */
  answers: Record<string, Answer>;
  /** Applied: no longer open (GA-CONF-1). */
  applied: boolean;
  /** A run's toggle steps asked again (GA-SCN-3): open to an answer until `untilMs`, though the plan was run and its revision may have moved. */
  reopened?: { steps: string[]; untilMs: number };
}

/** An utterance record that answered a plan, as the steward keeps it for the reuse check (GA-CONF-2). */
export interface Heard {
  utterance_id: string;
  plan_id: string;
  endpoint: string;
  time_ms: number;
  transcript: string;
}

export interface AnswerInput {
  /** The plan the answer names, or undefined when the steward holds none of that id. */
  held: AskedPlan | undefined;
  house: House;
  credential: Credential;
  endpoint: string;
  answers: Record<string, Answer>;
  record?: UtteranceRecord;
  /** The records kept, for the reuse check. */
  heard: Iterable<Heard>;
  now: number;
  revision: number;
  mutation?: Mutation;
  /** The answer's principal (GA-AUTH-1, GA-AUTH-2); throws `not_permitted` or `invalid_request`. */
  principal: () => Principal;
}

/**
 * Judges an answer in the standard's error order (steward, *Apply*): `invalid_request` (no such plan,
 * a bad utterance record, a step not asked), `not_permitted` (another credential, endpoint or speaker,
 * GA-CONF-1, and GA-CONF-6's checks), then the build's own `invalid_request` for a `yes` after a
 * `no`, `plan_expired`, `stale_revision`. A pure function: it changes nothing, and returns the answer's principal when the
 * answer counts. GA-CONF-2's `asked_by` clauses, and GA-CONF-6's against a voice record and its
 * narrowings, come with listening (slice 9).
 */
export function judgeAnswer(x: AnswerInput): Principal {
  const { held, record } = x;
  if (!held) throw new RequestError("invalid_request", "no plan of that id is held, or it asked nothing");
  // The principal's own invalid_request (a speaker no brain may name) is the first group's; an
  // endpoint not bound to the credential is not_permitted, which comes after it.
  let principal: Principal | undefined;
  let unbound: RequestError | undefined;
  try {
    principal = x.principal();
  } catch (err) {
    if (!(err instanceof RequestError) || err.code !== "not_permitted") throw err;
    unbound = err;
  }
  const named = Object.keys(x.answers);
  const unasked = named.filter((s) => !held.asked.includes(s));
  if (unasked.length && x.mutation !== "answers-unasked-steps") {
    throw new RequestError("invalid_request", `the plan's ask names no step ${unasked.join(", ")} (GA-CONF-2)`);
  }
  const e = x.house.endpoints.get(x.endpoint);
  if (e?.served_by || record) judgeRecord(x, held, record, named);
  if (unbound) throw unbound;
  const p = principal!;
  // An answer to a run's toggle steps asked again: open for them alone, timed from their new ask (the design, *Standards problems found*).
  const re = held.reopened !== undefined && named.length > 0 && named.every((s) => held.reopened!.steps.includes(s)) && x.now <= held.reopened.untilMs;
  if (held.applied && !re) throw new RequestError("not_permitted", "the plan was applied: it takes no answer (GA-CONF-1)");
  if (x.mutation !== "takes-any-answer") {
    if (held.askedAt !== held.endpoint) {
      // The question was put on the endpoint confirm_on names: only a credential bound to it answers.
      if (p.endpoint !== held.askedAt) throw new RequestError("not_permitted", `this plan is answered at ${held.askedAt} only (GA-CONF-1)`);
    } else if (x.credential.id !== held.credential || p.endpoint !== held.endpoint) {
      throw new RequestError("not_permitted", "a plan is answered from the credential and endpoint it was made from (GA-CONF-1)");
    }
    if (held.speaker !== undefined && p.brain && p.speaker !== held.speaker) {
      throw new RequestError("not_permitted", "the plan named a speaker: an answer through a brain names the same one (GA-CONF-1)");
    }
  }
  if (record) judgeAddressing(x, held, record);
  // The build's own pick (*Standards fixes*), judged only once the answer is permitted, so a credential
  // that may not answer never learns that the person said no.
  const again = named.filter((s) => x.answers[s] === "yes" && held.answers[s] === "no");
  if (again.length) throw new RequestError("invalid_request", `step ${again.join(", ")} was answered no: a yes after a no needs a new plan`);
  if (re) return p;
  if (x.now > held.expiresMs) throw new RequestError("plan_expired", "the plan expired");
  if (held.revision !== x.revision) throw new RequestError("stale_revision", `the plan was made at revision ${held.revision}, the house is at ${x.revision}`);
  return p;
}

/**
 * GA-CONF-2: an answer from a brain-served endpoint carries a record of its own endpoint, timed after
 * the latest `ask` of each step it answers less the tolerance and not after the arrival plus it, and
 * never one that answered another plan, by its id or by its endpoint, time and transcript together.
 */
function judgeRecord(x: AnswerInput, held: AskedPlan, record: UtteranceRecord | undefined, named: string[]): void {
  if (!record) throw new RequestError("invalid_request", "an answer through a brain carries its utterance record (GA-CONF-2)");
  if (record.endpoint !== x.endpoint) throw new RequestError("invalid_request", "the utterance record names another endpoint than the answer (GA-CONF-2)");
  const t = Date.parse(record.time);
  const latest = Math.max(...named.map((s) => held.askedMs[s] ?? 0));
  if (!(t > latest - CLOCK_TOLERANCE_MS)) throw new RequestError("invalid_request", "the utterance came before the question (GA-CONF-2)");
  if (t > x.now + CLOCK_TOLERANCE_MS) throw new RequestError("invalid_request", "the utterance is timed after the answer arrived (GA-CONF-2)");
  if (x.mutation === "reuses-an-utterance") return;
  for (const h of x.heard) {
    if (h.plan_id === held.planId) continue;
    if (h.utterance_id === record.utterance_id || (h.endpoint === record.endpoint && h.time_ms === t && h.transcript === record.transcript)) {
      throw new RequestError("invalid_request", "this utterance already answered another plan (GA-CONF-2)");
    }
  }
}

/**
 * GA-CONF-6, its clauses that need no voice record: a follow-up or a skill's turn (a record without
 * `addressed_by` counts as a follow-up) counts only with a `gate` hint naming the plan's speaker, or
 * a registered person for a plan that named none; `typed` only from an app; `skill` only at an
 * endpoint with a `skill_account`; a `person` basis only naming the endpoint's own person.
 */
function judgeAddressing(x: AnswerInput, held: AskedPlan, record: UtteranceRecord): void {
  const by = record.addressed_by ?? "follow_up";
  const e = x.house.endpoints.get(x.endpoint);
  if ((by === "follow_up" || by === "skill") && x.mutation !== "follow-up-yes") {
    const hint = record.speaker_hint;
    const named = hint !== undefined && (held.speaker !== undefined ? hint === held.speaker : x.house.persons.has(hint));
    if (record.hint_basis !== "gate" || !named) {
      throw new RequestError("not_permitted", `a ${by} answer counts only with a gate hint naming ${held.speaker ?? "a registered person"} (GA-CONF-6)`);
    }
  }
  if (by === "typed" && e?.type !== "app") throw new RequestError("not_permitted", "a typed answer comes only from an app (GA-CONF-6)");
  if (by === "skill" && !e?.voice?.skill_account) throw new RequestError("not_permitted", "a skill's answer comes only from an endpoint with a skill_account (GA-CONF-6)");
  if (record.hint_basis === "person" && e?.person && record.speaker_hint !== e.person) {
    throw new RequestError("not_permitted", "a person hint names another than the endpoint's person (GA-CONF-6)");
  }
}

/**
 * Whether a kept record can still answer a plan (GA-CONF-2's timing): while a plan not yet expired was
 * asked before the record's time plus the tolerance, or while a plan could still be asked before it.
 */
export function stillNeeded(h: Heard, plans: Iterable<AskedPlan>, now: number): boolean {
  const until = h.time_ms + CLOCK_TOLERANCE_MS;
  if (now < until) return true;
  for (const p of plans) if (p.expiresMs >= now && p.asked.some((s) => (p.askedMs[s] ?? Infinity) < until)) return true;
  return false;
}
