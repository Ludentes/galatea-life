import type { Body, Link, Reply } from "./link.js";

/** A change in a change set: `{ op, kind, value }`, as both servers take them. */
export interface Change {
  op: "upsert" | "delete";
  kind: string;
  value?: unknown;
}

/**
 * The applier, as the owner's configuration credential reaches it (GA-CFG-1, GA-PROV-1): `describe`
 * and `configure` (plan A), `events` and `provision` (plan B). The commands take this interface, so
 * their tests use a fake.
 */
export interface Applier {
  describe(): Promise<Reply>;
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply>;
  /** The events after `cursor`, waiting up to `wait_s` (0 to 30) for one; no cursor answers the current one and no events. */
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply>;
  /** One provisioning operation (`join`, `join_close`, `remove`, ...), with an optional `idempotency_key` (GA-PROV-3). */
  provision(a: Record<string, unknown>): Promise<Reply>;
}

/** One action of a steward request: a target's id, the action, and its arguments as an object (steward, *Requests and selectors*). */
export interface Requested {
  target: string;
  action: string;
  args: Record<string, unknown>;
}

/**
 * The steward, as the owner's app credential reaches it at endpoint `owner-app` (steward, *Clients,
 * endpoints and principals*): `describe` (with its wait), `state`, `history` and `define` in plan A;
 * `plan`, `answer`, `apply`, `outcome` and `events` in plan C; the four scenario operations for
 * `galatea scenario`. Every call that names an endpoint names
 * `owner-app`, which the implementation adds.
 */
export interface Steward {
  describe(a?: { since_revision?: number; wait_s?: number }): Promise<Reply>;
  state(a?: { targets?: string[] }): Promise<Reply>;
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply>;
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply>;
  /** A plan of the request's actions at `owner-app`. */
  plan(a: { actions: Requested[] }): Promise<Reply>;
  /** Answers steps of an open plan from `owner-app`. */
  answer(a: { plan_id: string; answers: Record<string, "yes" | "no"> }): Promise<Reply>;
  /** Applies a plan this credential made, under an idempotency key (GA-STW-5, GA-STW-6). */
  apply(a: { plan_id: string; idempotency_key: string }): Promise<Reply>;
  /** An apply's current outcomes (GA-STW-12). */
  outcome(a: { apply_id: string }): Promise<Reply>;
  /** The events after `cursor`, waiting up to `wait_s` (0 to 30) for one; no cursor answers the current one and no events. */
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply>;
  /** A plan of a scenario's run at `owner-app` (steward, *Scenario runs*): one step per action step, nothing changed. */
  scenarioPlan(a: { scenario: string }): Promise<Reply>;
  /** Starts a run from a scenario's plan this credential made, under an idempotency key (GA-SCN-6). */
  scenarioRun(a: { plan_id: string; idempotency_key: string }): Promise<Reply>;
  /** A run's status: `running` or `ended` with its reason, `failed_steps` and `sent_steps` (GA-SCN-11). */
  scenarioStatus(a: { run_id: string }): Promise<Reply>;
  /** Stops a run, as asked at `owner-app` (GA-SCN-9); the answer is its status. */
  scenarioStop(a: { run_id: string }): Promise<Reply>;
}

/** The owner's own endpoint at the steward, which every call of the tool names. */
export const OWNER_APP = "owner-app";

export class McpApplier implements Applier {
  constructor(private readonly link: Link) {}
  describe(): Promise<Reply> {
    return this.link.call("describe");
  }
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply> {
    return this.link.call("configure", a as unknown as Body);
  }
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply> {
    // The long-poll's own wait, and a margin for the answer to travel.
    return this.link.call("events", a, ((a.wait_s ?? 0) + 30) * 1000);
  }
  provision(a: Record<string, unknown>): Promise<Reply> {
    return this.link.call("provision", a);
  }
}

export class McpSteward implements Steward {
  constructor(private readonly link: Link) {}
  describe(a: { since_revision?: number; wait_s?: number } = {}): Promise<Reply> {
    // The long-poll's own wait, and a margin for the answer to travel.
    return this.link.call("describe", a, ((a.wait_s ?? 0) + 30) * 1000);
  }
  state(a: { targets?: string[] } = {}): Promise<Reply> {
    return this.link.call("state", a);
  }
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply> {
    return this.link.call("history", a);
  }
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply> {
    return this.link.call("define", { endpoint: OWNER_APP, ...a });
  }
  plan(a: { actions: Requested[] }): Promise<Reply> {
    return this.link.call("plan", { endpoint: OWNER_APP, actions: a.actions as unknown as Body[] });
  }
  answer(a: { plan_id: string; answers: Record<string, "yes" | "no"> }): Promise<Reply> {
    return this.link.call("answer", { plan_id: a.plan_id, endpoint: OWNER_APP, answers: a.answers });
  }
  apply(a: { plan_id: string; idempotency_key: string }): Promise<Reply> {
    return this.link.call("apply", a);
  }
  outcome(a: { apply_id: string }): Promise<Reply> {
    return this.link.call("outcome", a);
  }
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply> {
    // The long-poll's own wait, and a margin for the answer to travel.
    return this.link.call("events", a, ((a.wait_s ?? 0) + 30) * 1000);
  }
  scenarioPlan(a: { scenario: string }): Promise<Reply> {
    return this.link.call("scenario_plan", { scenario: a.scenario, endpoint: OWNER_APP });
  }
  scenarioRun(a: { plan_id: string; idempotency_key: string }): Promise<Reply> {
    return this.link.call("scenario_run", a);
  }
  scenarioStatus(a: { run_id: string }): Promise<Reply> {
    return this.link.call("scenario_status", a);
  }
  scenarioStop(a: { run_id: string }): Promise<Reply> {
    return this.link.call("scenario_stop", { run_id: a.run_id, endpoint: OWNER_APP });
  }
}
