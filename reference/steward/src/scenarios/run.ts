import type { ApplyRecord, Outcome } from "../dispatch/apply.js";
import { outcomeRank } from "../dispatch/apply.js";
import type { Precedence } from "../leases/table.js";
import type { Role } from "../house/model.js";
import type { Mutation } from "../mutations.js";

/**
 * Every run ends `ended(timeout)` once it has run this long (the design, *Scenarios*: the run limit,
 * 6 h, ruled 2026-10-02), its steps not yet dispatched never sent.
 */
export const RUN_LIMIT_MS = 6 * 3_600_000;

export type RunEnd = "done" | "timeout" | "stopped" | "interrupted";

/** One step of a run as `scenario_status` lists it (GA-SCN-11, GA-STW-12). */
export interface FailedStep { step_id: string; outcome: string; reason?: string; time: string }

/**
 * A scenario run (the design, *Scenarios*): who started it and how it acts (its precedence, cause,
 * `via` and `brain`), what it has dispatched, one applier apply per action step (`entries`, with an
 * `if`'s own outcome between them), and how it stands.
 */
export interface Run {
  run_id: string;
  scenario: string;
  /** A client's run: its credential, idempotency key and body (the plan's id), for GA-SCN-6. */
  credential?: string;
  key?: string;
  /** The plan a person's run was started from: held until the run ends (GA-SCN-3). */
  planId?: string;
  /** The role of the person or endpoint that started it, for `scenario_stop` (GA-SCN-9); none for a rule's. */
  starterRole?: Role;
  /** The rule that started it, for a rule-started run. */
  rule?: string;
  /** The schedule that started it, for a scheduled run. */
  schedule?: string;
  atMs: number;
  /** When it ended: an ended run is kept 3600 s from then. */
  endedMs?: number;
  precedence: Precedence;
  /** The steward's cause on every action it sends (steward, *Causes and history*). */
  cause: Record<string, unknown>;
  via: string;
  brain: boolean;
  /**
   * Started by `brain_authored` work, a rule's or a schedule's, or on a date a brain moved: every step
   * of it is `brain_authored`, whoever wrote the scenario (GA-DEF-7).
   */
  brainAuthored?: true;
  status: "running" | "ended";
  reason?: RunEnd;
  /** Each action step's apply, and each `if`'s own outcome, in the order the run reached them. */
  entries: (ApplyRecord | Outcome)[];
  /** Steps that ended `failed` and then had a `late_ack` while the run ran: left out of `failed_steps`. */
  lateAcked: Set<string>;
  /** Steps whose applier answer was lost: their outcome stays `unknown`, which ends them for the run. */
  lost: Set<string>;
  /** The devices it leased, `owned` expanded (GA-SCN-2). */
  leased: string[];
  /** Whether every step of its program was reached: it ends once its dispatched steps are final. */
  programDone: boolean;
  /** The index of the action step last sent, kept in the run's record, which commits before the step is sent while the store is up. */
  stepAt?: number;
  /** Ends what the run is waiting on (a delay, a wait), so it sees it has ended. */
  wake?: () => void;
  /** Tells the run, waiting on its action step's outcomes, that one of them moved. */
  settle?: () => void;
  bound?: number;
  /** `failed_steps` and `sent_steps` as of its end (steward, *Operations*). */
  ended?: { failed_steps: FailedStep[]; sent_steps: { step_id: string }[] };
}

const SUCCESS = new Set(["acked", "delivered", "sent", "confirmed"]);
/** Skips that are not failures: nothing to do, a room someone is in, a PC someone is using (GA-SCN-11). */
const NOT_FAILED = new Set(["already", "occupied", "in_use"]);

const isApply = (e: ApplyRecord | Outcome): e is ApplyRecord => "apply_id" in e && "outcomes" in e;

/** Every outcome of a run's steps, in the order reached. */
export function outcomesOf(run: Run): Outcome[] {
  return run.entries.flatMap((e) => (isApply(e) ? e.outcomes : [e]));
}

/** Whether a step has ended for the run: its outcome final, or its answer lost. */
export const finalFor = (run: Run, o: Outcome): boolean => outcomeRank(o.outcome) >= 2 || run.lost.has(o.step_id);

/** Whether every step a run dispatched has ended (steward, *Operations*: a run ends only then). */
export function settled(run: Run): boolean {
  return outcomesOf(run).every((o) => finalFor(run, o));
}

/**
 * `failed_steps` and `sent_steps` as they stand (GA-SCN-11, steward, *Operations*): every step that
 * ended in neither a success nor a skip that is no failure, a `failed` one that had a `late_ack`
 * while the run ran left out; every step that ended `sent`. A step still `dispatched` has not ended.
 * `passes-a-skipped-toggle` leaves a scheduled run's `skipped(toggle_only)` out.
 */
export function tally(run: Run, mutation?: Mutation): { failed_steps: FailedStep[]; sent_steps: { step_id: string }[] } {
  const failed_steps: FailedStep[] = [];
  const sent_steps: { step_id: string }[] = [];
  for (const o of outcomesOf(run)) {
    if (!finalFor(run, o)) continue;
    if (o.outcome === "sent") sent_steps.push({ step_id: o.step_id });
    if (SUCCESS.has(o.outcome) || (o.outcome === "skipped" && NOT_FAILED.has(o.reason ?? ""))) continue;
    if (o.outcome === "failed" && run.lateAcked.has(o.step_id)) continue;
    if (mutation === "passes-a-skipped-toggle" && run.schedule !== undefined && o.outcome === "skipped" && o.reason === "toggle_only") continue;
    failed_steps.push({ step_id: o.step_id, outcome: o.outcome, ...(o.reason !== undefined ? { reason: o.reason } : {}), time: o.time });
  }
  return { failed_steps, sent_steps };
}

/** A run as `scenario_status` returns it. */
export function statusOf(run: Run, mutation?: Mutation): Record<string, unknown> {
  const t = run.ended ?? tally(run, mutation);
  return { run_id: run.run_id, status: run.status, ...(run.reason ? { reason: run.reason } : {}), ...t };
}
