import type { ApplierOutcome } from "@ludentes/galatea-life-schemas";
import type { ConfirmedBy } from "../bus/wire.js";
import type { Tx } from "../core/db.js";
import type { StepKind } from "./rules.js";

/**
 * What dispatch keeps in the store (GA-PERSIST-1): the tokens used, each held apply's outcomes, and
 * each step still waiting, with its deadline. Every write here is safe to run twice.
 */

/** How long an apply is held for `outcome`, and a used token remembered (GA-APPLY-4's 3600 s, GA-TOKEN-4). */
export const HELD_MS = 3_600_000;

export type Outcome = ApplierOutcome;
/**
 * An apply as it is held: its client, when it was made, and one outcome per step, in the plan's
 * order; with its idempotency key and the body that key was given with (GA-APPLY-4, GA-APPLY-10).
 */
export type HeldApply = { apply_id: string; client: string; created_ms: number; outcomes: Outcome[]; idempotency_key?: string; body?: string;
  /** A safety rule's run: its actuations under no client (applier, *The applier's own actuations*). */
  rule_id?: string;
  /** A heating cap's turn-off: the socket it caps, under no client (GA-LOAD-2). */
  load_cap?: string;
  /**
   * An own run's commands published for each action slot, as far as this record knows: a start names the
   * next command of a slot by it, never by the attempts, so a command a crash lost is sent again under
   * its first id and never under a new one (the maintainer's ruling 2; the 7b preflight's I2).
   */
  pubs?: number[] };
/** The cause of a state change an apply made, a safety rule's actuation, or a heating cap's turn-off (applier, *Causes*). */
export type ApplyCause = { apply: string; client: string; for: unknown } | { safety_rule: string } | { load_cap: string };
/**
 * A cause as a state or `late_ack` event carries it (applier, *Causes*): an apply's and a safety rule's as
 * objects, a cap's as the bare `load_cap`, which names no apply and no rule.
 */
export const causeOf = (c: ApplyCause): Record<string, unknown> | string => "load_cap" in c ? "load_cap" : { ...c };
/** The client whose apply caused it, or none for the applier's own actuation. */
export const clientOf = (c: ApplyCause): string | undefined => "client" in c ? c.client : undefined;

/** A dispatched step still waiting for its final outcome: what its rules and its window read. */
export type Waiting = {
  command_id: string;
  apply_id: string;
  step_id: string;
  target: string;
  action: string;
  args: Record<string, unknown>;
  /** An own run's step: which command of its action slot this is (1 for the first published), its name's count. */
  pub?: number;
  /** The bridge the command went to, and its own id for the device: its ack is taken from them only. */
  bridge: string;
  bridge_device: string;
  kind: StepKind;
  cause: ApplyCause;
  /** When it was dispatched, in whole ms on the applier's clock. */
  dispatched_ms: number;
  /**
   * Its place among the dispatches, across restarts: a whole-state command and the assumed state follow
   * it, not the order outcomes end in (GA-APPLY-16). Absent in a row from before it was kept: 0.
   */
  seq?: number;
  /** When its `ack_within_s` passes. */
  bound_ms: number;
  /** Whether a terminal ack was taken: a second one is a duplicate (GA-BUS-6). */
  terminal: boolean;
  /** The `detail` of the terminal ack taken, for the final outcome (GA-APPLY-15). */
  detail?: string;
  /** The token it used, if any: released only when the broker refused the command (GA-BUS-9). */
  token?: { issuer: string; token_id: string };
  /** A whole-state command's `state`: every key it carried becomes assumed when it ends sent or unanswered (GA-APPLY-16). */
  state?: Record<string, unknown>;
  /** An extension action's `confirmed_by` as it was dispatched with: what acks it (GA-EVT-3), kept whatever its bridge declares later. */
  confirmed_by?: ConfirmedBy;
  /**
   * Whether its declaration said idempotent when it was dispatched: a reissue needs this and the
   * declaration as it stands now (GA-DESC-18). Absent in a row from before it was kept: the latter alone.
   */
  idempotent?: boolean;
  /**
   * Its action's declarations when it was dispatched, as a fingerprint: a reissue goes only on these,
   * so its bound, its `already` and its `confirmed_by` are the dispatched step's (GA-DESC-18).
   */
  fingerprint?: string;
};

export async function saveApply(tx: Tx, a: HeldApply): Promise<void> {
  await tx.query("INSERT INTO applies (apply_id, client, created_ms, outcomes, idempotency_key, body, rule_id, load_cap, pubs) "
    + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (apply_id) DO UPDATE SET outcomes = EXCLUDED.outcomes, pubs = EXCLUDED.pubs",
  [a.apply_id, a.client, a.created_ms, JSON.stringify(a.outcomes), a.idempotency_key ?? null, a.body ?? null, a.rule_id ?? null,
    a.load_cap ?? null, a.pubs ? JSON.stringify(a.pubs) : null]);
}

export async function saveWaiting(tx: Tx, w: Waiting, deadlineMs: number): Promise<void> {
  const { command_id, apply_id, ...step } = w;
  await tx.query("INSERT INTO waiting (command_id, apply_id, step, deadline_ms) VALUES ($1, $2, $3, $4) "
    + "ON CONFLICT (command_id) DO UPDATE SET step = EXCLUDED.step", [command_id, apply_id, JSON.stringify(step), deadlineMs]);
}

export async function dropWaiting(tx: Tx, commandId: string): Promise<void> {
  await tx.query("DELETE FROM waiting WHERE command_id = $1", [commandId]);
}

/**
 * A step that ended `failed(no_ack)` on a closed device, while a report matching its action is still a
 * `late_ack` (GA-APPLY-11): until `until_ms`, 60 s after that outcome.
 */
export type Late = Pick<Waiting, "command_id" | "apply_id" | "step_id" | "target" | "action" | "args" | "cause" | "confirmed_by" | "idempotent" | "fingerprint">
  & { until_ms: number };

export async function saveLate(tx: Tx, l: Late): Promise<void> {
  const { command_id, apply_id, until_ms, ...step } = l;
  await tx.query("INSERT INTO late (command_id, apply_id, step, until_ms) VALUES ($1, $2, $3, $4) ON CONFLICT (command_id) DO NOTHING",
    [command_id, apply_id, JSON.stringify(step), until_ms]);
}

export async function dropLate(tx: Tx, commandId: string): Promise<void> {
  await tx.query("DELETE FROM late WHERE command_id = $1", [commandId]);
}

/**
 * A key of an open device's assumed state, when the action that set it ended (GA-STATE-4), and the
 * dispatch order of the command it came from, which orders it against the commands still in flight
 * (GA-APPLY-16).
 */
export type Assumed = { device: string; key: string; value: unknown; basis_ms: number; source_seq: number };

export async function saveAssumed(tx: Tx, rows: Assumed[]): Promise<void> {
  for (const r of rows) {
    await tx.query("INSERT INTO assumed (device, key, value, basis_ms, source_seq) VALUES ($1, $2, $3, $4, $5) "
      + "ON CONFLICT (device, key) DO UPDATE SET value = EXCLUDED.value, basis_ms = EXCLUDED.basis_ms, source_seq = EXCLUDED.source_seq",
    [r.device, r.key, JSON.stringify(r.value), r.basis_ms, r.source_seq]);
  }
}

/** The assumed state of devices the owner forgot: no one's. Safe to run twice. */
export async function forgetAssumed(tx: Tx, devices: string[]): Promise<void> {
  if (devices.length) await tx.query("DELETE FROM assumed WHERE device = ANY($1)", [devices]);
}

export async function useToken(tx: Tx, issuer: string, tokenId: string, untilMs: number): Promise<void> {
  await tx.query("INSERT INTO used_tokens (issuer, token_id, until_ms) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [issuer, tokenId, untilMs]);
}

export async function releaseToken(tx: Tx, issuer: string, tokenId: string): Promise<void> {
  await tx.query("DELETE FROM used_tokens WHERE issuer = $1 AND token_id = $2", [issuer, tokenId]);
}

/** The applies a rule or a cap still runs: kept whatever their age, in the store and at load (GA-SAFE-12, GA-LOAD-2). */
const HELD_RUNS = "SELECT apply_id FROM safety_state WHERE apply_id IS NOT NULL UNION SELECT apply_id FROM load_caps WHERE apply_id IS NOT NULL AND state <> 'done'";

/**
 * Drops the applies held past 3600 s, but a run a rule or a cap still runs; the tokens remembered and
 * the late windows past their deadline; and a waiting step whose deadline is as old as that: its apply
 * is gone, so nothing could ever read it (a lost delete).
 */
export async function pruneRecords(tx: Tx, nowMs: number): Promise<void> {
  await tx.query(`DELETE FROM applies WHERE created_ms <= $1 AND apply_id NOT IN (${HELD_RUNS})`, [nowMs - HELD_MS]);
  await tx.query("DELETE FROM waiting WHERE deadline_ms <= $1", [nowMs - HELD_MS]);
  await tx.query("DELETE FROM used_tokens WHERE until_ms <= $1", [nowMs]);
  await tx.query("DELETE FROM late WHERE until_ms <= $1", [nowMs]);
}

// `pg` gives a bigint as a string, PGlite as a number.
type Rows = {
  applies: { apply_id: string; client: string; created_ms: number | string; outcomes: Outcome[]; idempotency_key: string | null; body: string | null;
    rule_id: string | null; load_cap: string | null; pubs: number[] | null }[];
  waiting: { command_id: string; apply_id: string; step: Omit<Waiting, "command_id" | "apply_id">; deadline_ms: number | string }[];
  used: { issuer: string; token_id: string; until_ms: number | string }[];
  late: { command_id: string; apply_id: string; step: Omit<Late, "command_id" | "apply_id" | "until_ms">; until_ms: number | string }[];
  assumed: { device: string; key: string; value: unknown; basis_ms: number | string; source_seq: number | string }[];
};

/**
 * What a start finds: the applies still held, and the runs a rule or a cap still runs whatever their age, the steps still waiting, in the order they were dispatched
 * (the latest attribution window naming a key decides), the tokens and late windows still standing at
 * `nowMs`, and every open device's assumed state.
 */
export async function loadRecords(q: Pick<Tx, "query">, nowMs: number): Promise<{ applies: HeldApply[];
  waiting: { w: Waiting; deadline_ms: number }[]; used: { issuer: string; token_id: string; until_ms: number }[]; late: Late[];
  assumed: Assumed[] }> {
  const applies = (await q.query<Rows["applies"][number]>(
    `SELECT apply_id, client, created_ms, outcomes, idempotency_key, body, rule_id, load_cap, pubs FROM applies WHERE created_ms > $1 OR apply_id IN (${HELD_RUNS}) ORDER BY created_ms`,
    [nowMs - HELD_MS])).rows;
  const waiting = (await q.query<Rows["waiting"][number]>("SELECT command_id, apply_id, step, deadline_ms FROM waiting ORDER BY (step->>'dispatched_ms')::bigint, command_id")).rows;
  const used = (await q.query<Rows["used"][number]>("SELECT issuer, token_id, until_ms FROM used_tokens WHERE until_ms > $1", [nowMs])).rows;
  const late = (await q.query<Rows["late"][number]>("SELECT command_id, apply_id, step, until_ms FROM late WHERE until_ms > $1 ORDER BY until_ms, command_id",
    [nowMs])).rows;
  const assumed = (await q.query<Rows["assumed"][number]>("SELECT device, key, value, basis_ms, source_seq FROM assumed ORDER BY device, key")).rows;
  return {
    applies: applies.map(({ idempotency_key, body, rule_id, load_cap, pubs, ...a }) => ({ ...a, created_ms: Number(a.created_ms),
      ...(pubs !== null ? { pubs } : {}),
      ...(idempotency_key !== null ? { idempotency_key } : {}), ...(body !== null ? { body } : {}), ...(rule_id !== null ? { rule_id } : {}),
      ...(load_cap !== null ? { load_cap } : {}) })),
    waiting: waiting.map((r) => ({ w: { command_id: r.command_id, apply_id: r.apply_id, ...r.step }, deadline_ms: Number(r.deadline_ms) })),
    used: used.map((u) => ({ ...u, until_ms: Number(u.until_ms) })),
    late: late.map((l) => ({ command_id: l.command_id, apply_id: l.apply_id, ...l.step, until_ms: Number(l.until_ms) })),
    assumed: assumed.map((r) => ({ ...r, basis_ms: Number(r.basis_ms), source_seq: Number(r.source_seq) })),
  };
}
