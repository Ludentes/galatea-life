import { ApplierRefused, type ApplierPort } from "../src/link/port.js";

type Body = Record<string, any>;

/** The stateless actions of the applier's capability table, for a fixture that does not say. */
const STATELESS = new Set(["cover.stop", "media.duck", "media.announce", "notify.notify"]);
/**
 * A fixture device as `applier/device.json` requires it (the milestone review, M4): what it leaves
 * out filled with `feedback: closed`, and each action not idempotent, stateless as the capability
 * table has it, acked within 10 s. What it says is kept.
 */
export const complete = (d: Body): Body => ({ feedback: "closed", ...d, actions: (Array.isArray(d.actions) ? d.actions : []).map((a: Body) => ({
  idempotent: false, stateless: STATELESS.has(String(a.action)) || String(a.action).startsWith("power."), ack_within_s: 10, ...a })) });
/**
 * An applier in memory, behind the link's port: a test sets its model and state, appends events, and
 * makes its next call fail. Its `events` long-poll answers at once with what it has.
 */
export class FakeApplier {
  revision = 1;
  devices: Body[] = [];
  targets: Record<string, Body> = {};
  testRunId?: string = "run-test";
  standardVersion = "0.14";
  private log: Body[] = [];
  private waiters: (() => void)[] = [];
  /** The next calls of these tools throw this, once each. */
  readonly failNext = new Map<string, Error>();
  connects = 0;
  calls: string[] = [];
  /** Every `history` range the steward asked for, in order. */
  readonly histories: { from: string; to: string }[] = [];
  /** Every `plan` request the steward made, in order. */
  readonly plans: Body[] = [];
  /** How the applier judges one action of a plan: its step, an op at `reversible` unless this says otherwise. */
  planner: (a: Body) => Body = () => ({});
  /** Every `apply` body the steward sent, in order, a repeat included. */
  readonly applies: Body[] = [];
  /** The first answer to each idempotency key, as the applier keeps it (applier GA-APPLY-4). */
  private readonly keys = new Map<string, Body>();
  /** The next this many applies are taken and their answers lost, as a session that drops after sending. */
  loseAnswers = 0;
  /** Whether an apply's outcomes come as `outcome` events too, as the reference applier puts each it settles. */
  emitsOutcomes = true;
  /** When set, an apply's answer waits for it, its events already put: an answer slower than its events. */
  answerGate?: Promise<void>;
  /** When set, the answer gives each dispatched step this outcome, as an applier that settles before it answers. */
  answerOutcome?: string;
  /** The notices not yet taken, carried in every `events` answer (applier, *Notices*). */
  notices: Body[] = [];
  /** Each id a `notice_taken` named, in order. */
  readonly taken: string[] = [];

  /** Raises a notice: carried in every `events` answer until a `notice_taken` names it; a waiting long-poll is answered. */
  raise(notice: Body): void {
    this.notices.push(notice);
    for (const w of this.waiters.splice(0)) w();
  }

  describeBody(): Body {
    return { applier_id: "fake-applier", standard_version: this.standardVersion, levels: ["Act"], revision: this.revision,
      devices: this.devices.map(complete), ungoverned: [], ...(this.testRunId ? { test_run_id: this.testRunId } : {}) };
  }

  /** Appends an event; a `model` event moves the revision first. */
  emit(e: Body): void {
    if (e.type === "model") this.revision++;
    this.log.push({ seq: this.log.length + 1, ...e });
    for (const w of this.waiters.splice(0)) w();
  }

  /** Appends an event the steward's follower misses, as in a gap: in the history, never in an `events` answer. */
  emitUnseen(e: Body): void {
    this.unseen.add(this.log.length + 1);
    this.emit(e);
  }
  private readonly unseen = new Set<number>();

  /** Forgets every event so far: the next cursor read before now is `cursor_expired`. */
  expire(): void {
    this.expiredThrough = this.log.length;
  }
  private expiredThrough = 0;

  port(): ApplierPort {
    this.connects++;
    const take = (tool: string) => {
      this.calls.push(tool);
      const e = this.failNext.get(tool);
      if (e) {
        this.failNext.delete(tool);
        throw e;
      }
    };
    let closed = false;
    return {
      protocolVersion: "2026-07-28",
      describe: async () => { take("describe"); return this.describeBody(); },
      state: async () => { take("state"); return { targets: this.targets, transports: [], latches: [] }; },
      plan: async (request) => {
        take("plan");
        this.plans.push(request);
        return { plan_id: `applier-plan-${this.plans.length}`, expires_at: "2030-01-01T08:01:00.000Z", revision: this.revision, client: "steward",
          request, steps: (request.actions as Body[]).map((a, i) => ({ step_id: `s${i + 1}`, target: a.target, action: a.action, args: a.args,
            verdict: "op", tier: "reversible", stale: false, basis: "real", ...this.planner(a) })) };
      },
      apply: async (body) => {
        take("apply");
        this.applies.push(body);
        const key = String(body.idempotency_key);
        let answer = this.keys.get(key);
        if (!answer) {
          const apply_id = `applier-apply-${this.keys.size + 1}`;
          const outcomes = (body.request.actions as Body[]).map((a, i) => {
            const j = { verdict: "op", ...this.planner(a) };
            const outcome = j.verdict === "op" ? "dispatched" : j.verdict === "skip" ? "skipped" : "refused";
            return { step_id: `s${i + 1}`, target: a.target, outcome, ...(j.reason ? { reason: j.reason } : {}), time: "2030-01-01T08:00:00.000Z" };
          });
          answer = { apply_id, outcomes };
          this.keys.set(key, answer);
          if (this.emitsOutcomes) for (const o of outcomes) this.emit({ type: "outcome", apply_id, ...o });
        }
        if (this.answerGate) await this.answerGate;
        if (this.loseAnswers > 0) {
          this.loseAnswers--;
          throw new Error("the session dropped before the answer came");
        }
        const out = structuredClone(answer);
        if (this.answerOutcome) for (const o of out.outcomes as Body[]) if (o.outcome === "dispatched") o.outcome = this.answerOutcome;
        return out;
      },
      events: async (cursor, waitS, taken = []) => {
        take("events");
        if (taken.length) {
          this.taken.push(...taken);
          this.notices = this.notices.filter((n) => !taken.includes(String(n.notice_id)));
        }
        const notices = () => this.notices.map((n) => ({ ...n }));
        if (cursor === undefined) return { events: [], cursor: String(this.log.length), notices: notices() };
        if (Number(cursor) < this.expiredThrough) throw new ApplierRefused("cursor_expired", "gone");
        if (Number(cursor) >= this.log.length && waitS > 0 && !closed) await new Promise<void>((r) => this.waiters.push(r));
        if (closed) throw new Error("the session closed");
        if (Number(cursor) < this.expiredThrough) throw new ApplierRefused("cursor_expired", "gone");
        const events = this.log.slice(Number(cursor)).filter((e) => !this.unseen.has(e.seq));
        return { events, cursor: String(this.log.length), notices: notices() };
      },
      history: async (range) => {
        take("history");
        this.histories.push(range);
        // Every event kept, those with a time within the range: what the applier's history gives.
        const from = Date.parse(range.from);
        const to = Date.parse(range.to);
        return { events: this.log.filter((e) => typeof e.time !== "string" || (Date.parse(e.time) >= from && Date.parse(e.time) <= to)) };
      },
      close: async () => { closed = true; for (const w of this.waiters.splice(0)) w(); },
    };
  }
}
