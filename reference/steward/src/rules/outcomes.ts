import type { Clock } from "@ludentes/galatea-life-test-clock";
import { canonical } from "../core/canonical.js";
import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";
import type { Mutation } from "../mutations.js";

/**
 * The least spacing between a rule's tries of one action (steward, *Constants*: at least the action's
 * `ack_within_s`, at most 300 s or the `ack_within_s` when longer; ⚠️ a guess). A pick within that
 * range: once a minute, as the notice pump retries, so a dead device costs one firing a minute.
 */
export const RETRY_SPACING_MS = 60_000;
/**
 * How long a rule's action may keep failing, tried again each time, before the owner is told once
 * (the maintainer, 2026-10-05; proposed for the next steward revision): the retries go on quietly after it.
 */
export const RETRY_NOTICE_AFTER_MS = 600_000;
/** `retries-hours-later`'s spacing: an hour, past the 300 s the standard allows. */
const HOURS_LATER_MS = 3_600_000;
/**
 * The late-ack slack (steward, *Constants*: 11 s, as the applier's `fresh_slack_s` for a bridged
 * device, plus 6 s for each meta-applier hop; ⚠️ a guess): this build's applier is no meta-applier.
 */
export const LATE_ACK_SLACK_MS = 11_000;
/** The late-ack window after a `failed(no_ack)` (applier GA-APPLY-11). */
export const LATE_ACK_WINDOW_MS = 60_000;
/** The most notices held for a late ack at once; past it the oldest is raised at once, never dropped. */
export const HELD_CAP = 1024;
/** How many of a rule's "noticed" marks are kept, the oldest forgotten first: one per action and becoming true. */
const NOTICED_KEPT = 64;

/** One step of a firing, as resolved when it fired: what a retry sends again (GA-RULE-7). */
export interface FiringStep {
  target: string;
  action: string;
  args: Record<string, unknown>;
  /** Whether the rule's action respects occupancy, so its room is judged at each try. */
  respect: boolean;
  /** Whether its device declares the action `idempotent: true`. */
  idempotent: boolean;
  /** The action's `ack_within_s`, as its device declares it. */
  ackWithinS: number;
  /** How many times this action already ended `unanswered` since the rule last became true. */
  unanswered: number;
  /** A step of `brain_authored` work, sent with `brain: true` on every try (GA-DEF-7). */
  brain?: true;
}

/** What the rule outcome bookkeeping knows of one firing (the design, *Rules*, *After the outcome*). */
export interface Firing {
  rule: string;
  /** The rule's name, for its notices. */
  name: string;
  n: number;
  /** The rule's becoming true it fired in (`RuleEngine.episode`): a retry of an earlier one is dropped. */
  episode: number;
  /** Whether the rule is of conditions only: only those are fired again (GA-RULE-7). */
  conditionsOnly: boolean;
  /**
   * A held rule's (G3, ratified by the maintainer 2026-10-05; a departure from GA-RULE-7 and GA-RULE-8 proposed for
   * the next steward revision): fired again and noticed as a rule of conditions only is, while its reading still holds.
   */
  held?: true;
  /**
   * An edge rule's (G3, ratified by the maintainer 2026-10-05; proposed for the next steward revision): never fired again, but each failed
   * firing noticed, the notices of one action coalesced while one waits for delivery.
   */
  edge?: true;
  /** When it fired: its tries' last, which a retry's spacing runs from. */
  atMs: number;
  /** When the applier's answer came: its steps were dispatched by then, which a lock's late-ack wait runs from. */
  answeredMs?: number;
  /** Its steps by the steward's step id. */
  steps: Record<string, FiringStep>;
  /**
   * The apply it was sent as: the steward's id, and, once the applier answered, the applier's apply id
   * and its step ids to the steward's. Kept with a held notice, so a late ack after a restart, followed
   * or read from the applier's history, still finds its firing (GA-PERSIST-2).
   */
  apply?: { id: string; applier?: string; steps?: Record<string, string> };
}

/**
 * What one step's final outcome calls for: nothing more, a try again, a notice now, a notice held
 * for a late ack (its wait from the step's dispatch, or from the outcome), or nothing at all.
 */
export type After = { kind: "landed" } | { kind: "retry" } | { kind: "notice"; perRoom?: true } | { kind: "hold"; from: "dispatch" | "outcome" } | { kind: "none" };

/** The outcomes that are a success (GA-RULE-7): the action took effect, or was in effect already. */
const LANDED = new Set(["acked", "delivered", "sent", "confirmed"]);

/**
 * What a rule's step that ended `outcome` calls for (steward, *Rules*). A success lands it. An
 * idempotent action that ended `skipped(dead)`, `unreachable` or `failed(no_ack)` is tried again, and
 * one that ended `unanswered` once (GA-RULE-7). Every other outcome is a notice (GA-RULE-8): none for
 * `refused(leased)`, which the lease's end re-evaluates, nor `skipped(occupied)`, `skipped(in_use)` or
 * `skipped(toggle_only)`, whose notice is the one at `define`; `failed(not_locked)` held for a late ack
 * from its dispatch, a `failed(no_ack)` (an action not idempotent) from the outcome; a second
 * `unanswered` after its one further try, at once. Mutations: `locks-once-and-gives-up` tries no
 * `failed(no_ack)` again, `leaves-it-unanswered` no `unanswered`, `retries-a-shutdown` a `failed(no_ack)`
 * and a `failed(invalid_request)`, idempotent or not (its row's two);
 * `notices-every-lease` and `notices-every-skipped-toggle` notice those; `fails-the-limit-silently`
 * raises nothing for `failed(not_locked)` and `times-the-lock` raises it at once;
 * `holds-an-ssh-only-lock` holds `failed(no_graphical_session)` as a lock that may yet take.
 */
export function afterOutcome(o: { outcome: string; reason?: string; idempotent: boolean; unanswered: number }, mutation?: Mutation): After {
  const is = (outcome: string, reason?: string) => o.outcome === outcome && (reason === undefined || o.reason === reason);
  if (LANDED.has(o.outcome) || is("skipped", "already")) return { kind: "landed" };
  if (mutation === "retries-a-shutdown" && (is("failed", "no_ack") || is("failed", "invalid_request"))) return { kind: "retry" };
  if (is("refused", "leased")) return mutation === "notices-every-lease" ? { kind: "notice" } : { kind: "none" };
  if (is("skipped", "toggle_only")) return mutation === "notices-every-skipped-toggle" ? { kind: "notice" } : { kind: "none" };
  if (is("skipped", "occupied") || is("skipped", "in_use")) return { kind: "none" };
  // A room not known: noticed (the maintainer, 2026-10-05), once per rule and room, not each time it becomes true (ruled Q4).
  if (is("skipped", "occupancy_unknown")) return { kind: "notice", perRoom: true };
  if (o.idempotent) {
    if (is("unreachable") || is("skipped", "dead")) return { kind: "retry" };
    if (is("failed", "no_ack")) return mutation === "locks-once-and-gives-up" ? { kind: "none" } : { kind: "retry" };
    if (is("unanswered") && o.unanswered === 0) return mutation === "leaves-it-unanswered" ? { kind: "none" } : { kind: "retry" };
  }
  if (is("failed", "not_locked")) {
    return mutation === "fails-the-limit-silently" ? { kind: "none" } : mutation === "times-the-lock" ? { kind: "notice" } : { kind: "hold", from: "dispatch" };
  }
  if (is("failed", "no_graphical_session")) return mutation === "holds-an-ssh-only-lock" ? { kind: "hold", from: "dispatch" } : { kind: "notice" };
  if (is("failed", "no_ack")) return { kind: "hold", from: "outcome" };
  return { kind: "notice" };
}

/**
 * How long a held notice waits for a late ack (GA-RULE-8): a lock's `ack_within_s` from its dispatch,
 * or the 60 s late-ack window from a `failed(no_ack)`, and the late-ack slack after either.
 * `notices-a-slow-late-ack` leaves the slack out.
 */
export function heldWaitMs(from: "dispatch" | "outcome", ackWithinS: number, mutation?: Mutation): number {
  const slack = mutation === "notices-a-slow-late-ack" ? 0 : LATE_ACK_SLACK_MS;
  return (from === "dispatch" ? ackWithinS * 1000 : LATE_ACK_WINDOW_MS) + slack;
}

/** How long after its last try an action is tried again: `RETRY_SPACING_MS`, or its `ack_within_s` when longer. */
export function retrySpacingMs(ackWithinS: number, mutation?: Mutation): number {
  if (mutation === "retries-hours-later") return HOURS_LATER_MS;
  if (mutation === "retries-a-shutdown") return ackWithinS * 1000;
  return Math.max(ackWithinS * 1000, RETRY_SPACING_MS);
}

export interface RuleOutcomeOptions {
  clock: Clock;
  mutation?: Mutation;
  /** Whether the rule's conditions hold now: active, of conditions only, outside an exception, with its conditions true. */
  holds(rule: string): boolean;
  /** The rule's current becoming true (`RuleEngine.episode`). */
  episode(rule: string): number;
  /** The room a target is in, if any, for a `skipped(occupancy_unknown)` noticed once per rule and room. */
  roomOf?(target: string): string | undefined;
  /** Where a pending retry's row is written behind (ruled Q6); none in a unit test of the table alone. */
  store?: Store;
  /** Fires `rule` again with these steps only (GA-RULE-7). */
  retry(rule: string, steps: FiringStep[]): void;
  /** Raises the steward's own notice `id` (GA-RULE-8), delivered as GA-NOTE-1's. */
  notice(id: string, doc: { rule: string; action: string; target: string; outcome: string; reason?: string; still_tried?: true; text: string }): void;
}

/** A notice held for a late ack: its step, its outcome, the end of its wait, and its timer (none while one read back waits for the first sync). */
interface Held { f: Firing; stepId: string; outcome: string; reason?: string; dueMs: number; timer?: number }

/**
 * What a rule's outcome does (the design, *Rules*, *After the outcome*), for rules of conditions
 * only, each pending item's row in the store written behind (`rule_pending`): a retry table of the actions to fire again
 * (GA-RULE-7), one timer each, a retry dropped when its rule has since become false (a new becoming
 * true fires afresh) or its conditions no longer hold when it is due, a success, a `late_ack`
 * included, ending it; and the failure notices (GA-RULE-8), raised at once or held for a late ack,
 * a held one raised once its wait passes with none, even if the conditions stopped holding meanwhile,
 * and at most one for an action each time its rule becomes true.
 */
export class RuleOutcomes {
  /** One pending retry per rule and action, by `rule\u0000[target, action, args]`. */
  private readonly retries = new Map<string, number>();
  /** The notices held for a late ack, by `rule\u0000firing\u0000step`, in the order held; at most `HELD_CAP`. */
  private readonly held = new Map<string, Held>();
  /** The rooms each rule's `skipped(occupancy_unknown)` was noticed for (ruled Q4); forgotten with the rule. */
  private readonly roomsNoticed = new Map<string, Set<string>>();
  /** When each action tried again began failing in its rule's current becoming true, by the retry's key. */
  private readonly failing = new Map<string, { episode: number; sinceMs: number }>();
  /** Each pending retry's and held notice's row as it should stand, by its kind and key; absent once written away. */
  private readonly rows = new Map<string, PendingRow>();
  private readonly writing = new Map<string, boolean>();
  /** Each rule's actions noticed, by `episode\u0000[target, action, args]`, the latest `NOTICED_KEPT`. */
  private readonly noticed = new Map<string, Set<string>>();

  constructor(private readonly o: RuleOutcomeOptions) {}

  stop(): void {
    for (const t of this.retries.values()) this.o.clock.clear(t);
    for (const h of this.held.values()) if (h.timer !== undefined) this.o.clock.clear(h.timer);
    this.retries.clear();
    this.held.clear();
  }

  /**
   * Reads back what the steward's rules had pending when it stopped (GA-PERSIST-2): the notices held
   * for a late ack, each with the end of its wait (GA-RULE-8), and the firings sent whose steps had no
   * final outcome yet. No held notice waits on a timer yet: a late ack may be in the gap the first sync
   * reads, so `resume` arms them then. Returns each with its firing and apply, so the steward can find
   * them by a later event of the applier's. `forgets-a-held-notice` reads no held notice, and drops their rows.
   *
   * A rule's becoming true is counted afresh in each life (`RuleEngine.episode`), so each firing read
   * back takes this life's count from `episodeOf`, told whether it is its rule's latest firing read
   * back: kept as the last life counted it, its retry would be dropped and its marks skewed (the code
   * review, CR1).
   */
  async load(episodeOf: (rule: string, latest: boolean) => number = () => -1): Promise<{ held: HeldDoc[]; sent: SentDoc[] }> {
    if (!this.o.store) return { held: [], sent: [] };
    const rows = await this.o.store.query<{ rule_id: string; step_key: string; due_ms: number | string; doc: HeldDoc }>(
      "SELECT rule_id, step_key, due_ms, doc FROM rule_pending WHERE kind = 'held' ORDER BY due_ms, rule_id, step_key");
    const open = await this.o.store.query<{ rule_id: string; step_key: string; due_ms: number | string; doc: SentDoc }>(
      "SELECT rule_id, step_key, due_ms, doc FROM rule_pending WHERE kind = 'sent' ORDER BY due_ms, rule_id, step_key");
    const latest = new Map<string, number>();
    for (const { doc } of [...rows.rows, ...open.rows]) latest.set(doc.rule, Math.max(latest.get(doc.rule) ?? -Infinity, doc.n));
    for (const { doc } of [...rows.rows, ...open.rows]) doc.episode = episodeOf(doc.rule, doc.n === latest.get(doc.rule));
    const sent: SentDoc[] = [];
    for (const r of open.rows) {
      this.rows.set(`sent\u0000${r.doc.rule}\u0000${r.doc.n}`, { kind: "sent", rule: r.rule_id, step: r.step_key, dueMs: Number(r.due_ms), doc: r.doc });
      sent.push(r.doc);
    }
    if (this.o.mutation === "forgets-a-held-notice") {
      if (rows.rows.length) await this.o.store.write((tx) => tx.query("DELETE FROM rule_pending WHERE kind = 'held'").then(() => undefined));
      return { held: [], sent };
    }
    const held: HeldDoc[] = [];
    for (const r of rows.rows) {
      const { stepId, outcome, reason, ...f } = r.doc;
      const k = `${f.rule}\u0000${f.n}\u0000${stepId}`;
      this.held.set(k, { f, stepId, outcome, ...(reason !== undefined ? { reason } : {}), dueMs: Number(r.due_ms) });
      this.rows.set(`held\u0000${k}`, { kind: "held", rule: f.rule, step: r.step_key, dueMs: Number(r.due_ms), doc: r.doc });
      held.push(r.doc);
    }
    return { held, sent };
  }

  /**
   * A step: a firing the applier answered, `open` its steps sent with no final outcome yet. Its row is
   * kept while any is open (GA-PERSIST-2), so an outcome the applier gives while the steward is down, or
   * after its restart, still goes to what a rule's outcome does (GA-RULE-7, GA-RULE-8); gone once none is.
   */
  inFlight(f: Firing, open: string[]): void {
    const key = `${f.rule}\u0000${f.n}`;
    if (!open.length) {
      this.record("sent", key, null);
      return;
    }
    const was = this.rows.get(`sent\u0000${key}`);
    if (was && !("gone" in was) && canonical((was.doc as SentDoc).open) === canonical(open)) return;
    this.record("sent", key, { rule: f.rule, step: canonical([f.n]), dueMs: f.atMs, doc: { ...f, open } });
  }

  /** A step: a firing's record is forgotten (the cap): its row goes too. */
  closed(f: Firing): void {
    this.record("sent", `${f.rule}\u0000${f.n}`, null);
  }

  /** A step: the first sync after a start: each held notice read back waits on its timer, one whose wait has passed raised now. */
  resume(): void {
    for (const [k, h] of [...this.held]) if (h.timer === undefined) this.arm(k, h);
  }

  /**
   * Whether a firing's record must be kept for a later event: a notice of one of its steps is held
   * for a late ack, or one of its actions waits for a retry a late ack would cancel (the milestone
   * review, I2).
   */
  pins(f: Firing): boolean {
    for (const [id, s] of Object.entries(f.steps)) {
      if (this.held.has(`${f.rule}\u0000${f.n}\u0000${id}`) || this.retries.has(keyOf(f.rule, s))) return true;
    }
    return false;
  }

  /** A deleted rule: its retries and held notices are dropped and its noticed marks forgotten (the milestone review, M3). */
  forget(rule: string): void {
    const mine = (k: string) => k.startsWith(`${rule}\u0000`);
    for (const k of [...this.retries.keys()]) if (mine(k)) this.cancel(k);
    for (const [k, h] of [...this.held]) {
      if (!mine(k)) continue;
      this.unhold(k, h);
    }
    for (const [k, row] of [...this.rows]) if (row.kind === "sent" && !("gone" in row) && k.startsWith(`sent\u0000${rule}\u0000`)) this.record("sent", k.slice(5), null);
    this.noticed.delete(rule);
    this.roomsNoticed.delete(rule);
    for (const k of [...this.failing.keys()]) if (mine(k)) this.failing.delete(k);
  }

  /** How many retries and held notices wait, for tests. */
  pending(): { retries: number; held: number } {
    return { retries: this.retries.size, held: this.held.size };
  }

  /** A step: a firing's step reached its final outcome. */
  settled(f: Firing, stepId: string, outcome: string, reason?: string): void {
    const s = f.steps[stepId];
    if (!s || !(f.conditionsOnly || f.held || f.edge)) return;
    const key = keyOf(f.rule, s);
    const a = afterOutcome({ outcome, ...(reason !== undefined ? { reason } : {}), idempotent: s.idempotent, unanswered: s.unanswered }, this.o.mutation);
    if (a.kind === "landed") {
      this.cancel(key);
      this.failing.delete(key);
      return;
    }
    if (f.edge) {
      // An edge fired once: a failure is noticed, never fired again for (G3, ratified).
      if (a.kind === "none") return;
      if (a.kind === "hold") this.hold(f, stepId, outcome, reason, (a.from === "dispatch" ? f.answeredMs ?? f.atMs : this.o.clock.now()) + heldWaitMs(a.from, s.ackWithinS, this.o.mutation));
      else this.raise(f, stepId, outcome, reason);
      return;
    }
    // Only an outcome that ends while the conditions hold is fired again for (GA-RULE-7) or noticed (GA-RULE-8).
    if (a.kind === "none" || !this.o.holds(f.rule)) return;
    if (a.kind === "notice" && a.perRoom) {
      const rooms = this.roomsNoticed.get(f.rule) ?? new Set<string>();
      const room = this.o.roomOf?.(s.target) ?? "";
      if (rooms.has(room)) return;
      rooms.add(room);
      this.roomsNoticed.set(f.rule, rooms);
      this.raise(f, stepId, outcome, reason);
      return;
    }
    if (a.kind === "notice") {
      this.raise(f, stepId, outcome, reason);
      return;
    }
    if (a.kind === "hold") {
      this.hold(f, stepId, outcome, reason, (a.from === "dispatch" ? f.answeredMs ?? f.atMs : this.o.clock.now()) + heldWaitMs(a.from, s.ackWithinS, this.o.mutation));
      return;
    }
    const next: FiringStep = { ...s, unanswered: s.unanswered + (outcome === "unanswered" ? 1 : 0) };
    // Failing for 10 minutes in this becoming true: the owner is told once, and it is tried on.
    const was = this.failing.get(key);
    const since = was && was.episode === f.episode ? was.sinceMs : f.atMs;
    this.failing.set(key, { episode: f.episode, sinceMs: since });
    if (this.o.clock.now() - since >= RETRY_NOTICE_AFTER_MS) this.raise(f, stepId, outcome, reason, true);
    const due = f.atMs + retrySpacingMs(s.ackWithinS, this.o.mutation);
    this.cancel(key);
    this.retries.set(key, this.o.clock.setTimeout(() => {
      this.retries.delete(key);
      this.record("retry", key, null);
      if (this.o.episode(f.rule) !== f.episode || !this.o.holds(f.rule)) {
        this.failing.delete(key);
        return;
      }
      this.o.retry(f.rule, [next]);
    }, Math.max(0, due - this.o.clock.now())));
    this.record("retry", key, { rule: f.rule, step: canonical([s.target, s.action, s.args]), dueMs: due, doc: next });
  }

  /** Notes a pending item's row as it should stand (null: gone), and writes it behind. */
  private record(kind: PendingKind, key: string, row: { rule: string; step: string; dueMs: number; doc: PendingDoc } | null): void {
    if (!this.o.store) return;
    const k = `${kind}\u0000${key}`;
    const was = this.rows.get(k);
    if (row) this.rows.set(k, { kind, ...row });
    else if (was) this.rows.set(k, { kind, rule: was.rule, step: was.step, gone: true });
    else return;
    this.flush(k);
  }

  /** Writes a row as it stands when the write runs, coalesced per row; safe to run twice. */
  private flush(key: string): void {
    if (this.writing.has(key)) {
      this.writing.set(key, true);
      return;
    }
    this.writing.set(key, false);
    void this.o.store!.write((tx) => writePending(tx, this.rows.get(key)!)).then(() => {
      const again = this.writing.get(key);
      this.writing.delete(key);
      if (again) this.flush(key);
      else if (this.rows.get(key) && "gone" in this.rows.get(key)!) this.rows.delete(key);
    });
  }

  /**
   * A step: a firing's step had a `late_ack`, a success: it is not tried again (GA-RULE-7), and a
   * notice held for it is not raised (GA-RULE-8). `notices-a-slow-lock` keeps a lock's held notice,
   * `notices-a-late-launch` a `failed(no_ack)`'s.
   */
  landed(f: Firing, stepId: string): void {
    const s = f.steps[stepId];
    if (s) {
      this.cancel(keyOf(f.rule, s));
      this.failing.delete(keyOf(f.rule, s));
    }
    const k = `${f.rule}\u0000${f.n}\u0000${stepId}`;
    const h = this.held.get(k);
    if (!h) return;
    const m = this.o.mutation;
    if ((m === "notices-a-slow-lock" && h.reason === "not_locked") || (m === "notices-a-late-launch" && h.reason === "no_ack")) return;
    this.unhold(k, h);
  }

  /** Forgets a held notice, its timer and its row. */
  private unhold(k: string, h: Held): void {
    if (h.timer !== undefined) this.o.clock.clear(h.timer);
    this.held.delete(k);
    this.record("held", k, null);
  }

  /**
   * Holds the notice for a firing's step until `dueMs`: raised then unless a late ack lands it first,
   * whether or not the conditions still hold (`drops-a-held-notice` drops it if they do not). Past
   * `HELD_CAP`, the oldest held is raised at once.
   */
  private hold(f: Firing, stepId: string, outcome: string, reason: string | undefined, dueMs: number): void {
    const k = `${f.rule}\u0000${f.n}\u0000${stepId}`;
    if (this.held.has(k)) return;
    if (this.held.size >= HELD_CAP) {
      const [oldest, h] = this.held.entries().next().value!;
      this.raise(h.f, h.stepId, h.outcome, h.reason);
      this.unhold(oldest, h);
    }
    const h: Held = { f, stepId, outcome, ...(reason !== undefined ? { reason } : {}), dueMs };
    this.held.set(k, h);
    this.arm(k, h);
    // Its row, with the end of its wait, so a restart inside the wait still raises it (GA-PERSIST-2): the
    // firing with this step only, and its apply, by which a late ack after the restart finds it.
    const s = f.steps[stepId]!;
    const doc: HeldDoc = { ...f, steps: { [stepId]: s }, stepId, outcome, ...(reason !== undefined ? { reason } : {}) };
    this.record("held", k, { rule: f.rule, step: canonical([f.n, stepId]), dueMs, doc });
  }

  /**
   * Sets a held notice's timer to the end of its wait: raised then, its row forgotten, unless a late ack
   * lands it first. Raised before its row is forgotten, both written behind in that order, so a crash
   * between them raises it again at the restart under the same notice id, which the pump already holds
   * (the milestone 7+10+11 review, I7).
   */
  private arm(k: string, h: Held): void {
    h.timer = this.o.clock.setTimeout(() => {
      this.held.delete(k);
      if (this.o.mutation !== "drops-a-held-notice" || this.o.holds(h.f.rule)) this.raise(h.f, h.stepId, h.outcome, h.reason);
      this.record("held", k, null);
    }, Math.max(0, h.dueMs - this.o.clock.now()));
  }

  /**
   * Raises the notice for a firing's step, unless that action was noticed already since its rule last
   * became true. The marks (`noticed`) are memory only: after a restart a held notice read back for an
   * action noticed before the stop is raised again (the design, *Restarts*; the milestone 7+10+11 review, M3).
   */
  private raise(f: Firing, stepId: string, outcome: string, reason?: string, still = false): void {
    const s = f.steps[stepId];
    if (!s) return;
    const marks = this.noticed.get(f.rule) ?? new Set<string>();
    // An edge rule's firings are each their own (G3); a level rule's, once per becoming true.
    const mark = `${f.edge ? `n${f.n}` : f.episode}\u0000${canonical([s.target, s.action, s.args])}`;
    if (marks.has(mark)) return;
    marks.add(mark);
    for (const old of marks) if (marks.size > NOTICED_KEPT) marks.delete(old);
    this.noticed.set(f.rule, marks);
    const ended = `${outcome}${reason !== undefined ? `(${reason})` : ""}`;
    this.o.notice(`steward:rule:${f.rule}:${f.n}:${stepId}`, { rule: f.rule, action: s.action, target: s.target, outcome,
      ...(reason !== undefined ? { reason } : {}),
      ...(still ? { still_tried: true } : {}),
      text: still
        ? `rule ${f.rule} (${f.name}): ${s.action} on ${s.target} has kept failing for ${RETRY_NOTICE_AFTER_MS / 60_000} minutes, last ${ended}; it is still being tried`
        : `rule ${f.rule} (${f.name}): ${s.action} on ${s.target} ended ${ended} while its conditions held, and will not be tried again (GA-RULE-8)` });
  }

  private cancel(key: string): void {
    const t = this.retries.get(key);
    if (t === undefined) return;
    this.o.clock.clear(t);
    this.retries.delete(key);
    this.record("retry", key, null);
  }
}

const keyOf = (rule: string, s: FiringStep) => `${rule}\u0000${canonical([s.target, s.action, s.args])}`;

/**
 * What a `rule_pending` row is: a retry of an action (GA-RULE-7), a notice held for a late ack
 * (GA-RULE-8), or a firing sent whose steps have no final outcome yet (GA-PERSIST-2).
 */
type PendingKind = "retry" | "held" | "sent";

/**
 * A held notice's row document (GA-PERSIST-2): its firing, with the held step only and its apply, the
 * step's id, and the outcome it ended in. `step_key` is the firing's number and the step's id.
 */
export type HeldDoc = Firing & { stepId: string; outcome: string; reason?: string };

/**
 * A firing in flight's row document (GA-PERSIST-2): its firing, with its apply, and the steps sent
 * with no final outcome yet. `step_key` is the firing's number; `due_ms` when it fired.
 */
export type SentDoc = Firing & { open: string[] };

type PendingDoc = FiringStep | HeldDoc | SentDoc;

/** A pending item's row as it should stand: kept, or gone. */
type PendingRow = { kind: PendingKind; rule: string; step: string; dueMs: number; doc: PendingDoc } | { kind: PendingKind; rule: string; step: string; gone: true };

async function writePending(tx: Tx, row: PendingRow): Promise<void> {
  if ("gone" in row) {
    await tx.query("DELETE FROM rule_pending WHERE rule_id = $1 AND kind = $2 AND step_key = $3", [row.rule, row.kind, row.step]);
    return;
  }
  await tx.query("INSERT INTO rule_pending (rule_id, kind, step_key, due_ms, doc) VALUES ($1, $2, $3, $4, $5) "
    + "ON CONFLICT (rule_id, kind, step_key) DO UPDATE SET due_ms = EXCLUDED.due_ms, doc = EXCLUDED.doc",
  [row.rule, row.kind, row.step, Math.floor(row.dueMs), JSON.stringify(row.doc)]);
}
