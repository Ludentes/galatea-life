import { randomUUID } from "node:crypto";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";

type Body = Record<string, unknown>;

/** The notice retry interval: a notice not yet delivered is tried again this often, for ever (GA-NOTE-1). */
export const NOTICE_RETRY_MS = 60_000;
/**
 * How many of the steward's own notices wait for delivery at most (the milestone review, B2, ruled
 * Q1): past it, one summary notice counts the ones folded in. The applier's are never folded.
 */
export const OWN_PENDING_CAP = 1024;
/** The summary notice's id. */
export const SUMMARY_ID = "steward:summary";
/** How many of the latest attempts the pump keeps the applier's apply ids of, for their late outcome events. */
const ATTEMPTS_KEPT = 5;

/** One notice (steward, *Notices*): the applier's, or the steward's own. */
export interface Notice {
  notice_id: string;
  source: "applier" | "steward";
  /** As the applier gave it (`cause`, `text`, …), or the steward's own `cause` and `text`. */
  doc: Body;
  /** How many attempts it was in. */
  attempts: number;
  delivered: boolean;
}

export interface PumpOptions {
  clock: Clock;
  store: Store;
  /** Puts a `notice` event (raised, delivered) in the steward's log. */
  event: (body: Body) => void;
  /**
   * Makes one attempt for every notice waiting: a `notify` on each of the home's channels for each
   * notice, all as one applier apply keyed `key`, calling `answered` with its answer, if one comes,
   * before it resolves.
   */
  send: (batch: Notice[], key: string) => Promise<void>;
}

/**
 * The notice pump (the design, *Notices*): every notice not yet delivered, tried on the home's
 * `notify` channels at once and again every 60 s, for ever, until one attempt's `notify` for it is
 * delivered (on its answer, or on a later outcome event of a kept attempt); then the applier's is
 * `notice_taken` on the next `events` call, until the applier stops listing it. One attempt carries
 * every notice waiting, as one apply keyed `notices:<life>:<n>`, so the cost of a tick does not grow
 * with the number of applies (the milestone review, B2). The steward's own waiting are capped at
 * `OWN_PENDING_CAP`, the rest folded into one summary. Each notice's row is written behind, coalesced
 * per notice; the steward's own, once delivered, is forgotten.
 */
export class NoticePump {
  private readonly notices = new Map<string, Notice>();
  private timer?: number;
  private trying = false;
  /** This life's id, so an attempt's key never repeats across a restart. */
  private readonly life = randomUUID();
  private tick = 0;
  /** The applier's apply id of each kept attempt, to its steps' notices by step id. */
  private readonly byApplier = new Map<string, Map<string, string>>();
  private readonly saving = new Map<string, boolean>();
  private stopped = false;

  constructor(private readonly o: PumpOptions) {}

  /** The notices not yet delivered, and the applier's delivered ones not yet released, in id order. */
  all(): Notice[] {
    return [...this.notices.values()].sort((a, b) => (a.notice_id < b.notice_id ? -1 : a.notice_id > b.notice_id ? 1 : 0));
  }

  /**
   * A step: the `notices` of one of the applier's `events` responses. Each not yet known is raised;
   * an applier notice delivered and no longer listed was taken, and is forgotten.
   */
  listed(notices: Body[]): void {
    const ids = new Set(notices.map((n) => String(n.notice_id)));
    for (const n of [...this.notices.values()]) {
      if (n.source === "applier" && n.delivered && !ids.has(n.notice_id)) this.forget(n.notice_id);
    }
    for (const n of notices) {
      const id = String(n.notice_id ?? "");
      if (id && !this.notices.has(id)) this.raise({ notice_id: id, source: "applier", doc: { ...n }, attempts: 0, delivered: false });
    }
  }

  /** The ids `notice_taken` names on the next `events` call: every applier notice delivered and still listed. */
  taken(): string[] {
    return this.all().filter((n) => n.source === "applier" && n.delivered).map((n) => n.notice_id);
  }

  /**
   * A step: the steward raises its own notice, with `extra` fields beside its text, unless one of that
   * id waits for delivery. With a `subject`, a notice of that subject still waiting takes this one in
   * instead: its count goes up and its text and fields become the latest (ruled Q1).
   */
  own(id: string, cause: string, text: string, extra: Body = {}, subject?: string): void {
    if (this.notices.has(id)) return;
    const same = subject === undefined ? undefined
      : [...this.notices.values()].find((n) => n.source === "steward" && !n.delivered && n.doc.subject === subject);
    if (same) {
      const count = Number(same.doc.count ?? 1) + 1;
      same.doc = { cause, ...extra, subject, count, text: `${text} (${count} times)` };
      this.save(same.notice_id);
      return;
    }
    if (subject !== undefined) extra = { ...extra, subject };
    if (this.ownWaiting() >= OWN_PENDING_CAP) {
      this.fold();
      return;
    }
    this.raise({ notice_id: id, source: "steward", doc: { cause, ...extra, text }, attempts: 0, delivered: false });
  }

  /** A step: an outcome event of the applier's; true when it is a notice attempt's, which the pump takes and the steward does not relay. */
  outcome(applierApplyId: string, stepId: string, delivered: boolean): boolean {
    const steps = this.byApplier.get(applierApplyId);
    if (steps === undefined) return false;
    const id = steps.get(stepId);
    if (id !== undefined && delivered) this.delivered(id);
    return true;
  }

  /** How many of the steward's own notices wait for delivery, the summary aside. */
  private ownWaiting(): number {
    let n = 0;
    for (const x of this.notices.values()) if (x.source === "steward" && !x.delivered && x.notice_id !== SUMMARY_ID) n++;
    return n;
  }

  /** Folds one more of the steward's own notices into the summary, raising it if none waits. */
  private fold(): void {
    const s = this.notices.get(SUMMARY_ID);
    const count = (s && !s.delivered ? Number(s.doc.count ?? 0) : 0) + 1;
    const text = `Ещё ${count} уведомлений не поместились в очередь: смотрите журнал событий`;
    if (s && !s.delivered) {
      s.doc = { ...s.doc, count, text };
      this.save(SUMMARY_ID);
      return;
    }
    if (s) this.forget(SUMMARY_ID);
    this.raise({ notice_id: SUMMARY_ID, source: "steward", doc: { cause: "notices_folded", count, text }, attempts: 0, delivered: false });
  }

  /** Reads the notices the store keeps; each not yet delivered is tried at once. */
  async load(): Promise<void> {
    const rows = await this.o.store.query<{ notice_id: string; source: "applier" | "steward"; doc: Body; attempts: number; delivered: boolean }>(
      "SELECT notice_id, source, doc, attempts, delivered FROM notices ORDER BY notice_id");
    for (const r of rows.rows) this.notices.set(r.notice_id, { notice_id: r.notice_id, source: r.source, doc: r.doc, attempts: r.attempts, delivered: r.delivered });
    if (this.waiting().length) this.arm(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.o.clock.clear(this.timer);
    this.timer = undefined;
  }

  private raise(n: Notice): void {
    this.notices.set(n.notice_id, n);
    this.o.event({ notice_id: n.notice_id, change: "raised", source: n.source, ...n.doc });
    this.save(n.notice_id);
    // A new notice is tried at once, unless an attempt is out: then as soon as it ends.
    if (!this.trying) this.arm(0);
  }

  /** The notices waiting for delivery, in id order. */
  private waiting(): Notice[] {
    return this.all().filter((n) => !n.delivered);
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) this.o.clock.clear(this.timer);
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, ms);
  }

  /** One attempt for every notice waiting, unless one is still out; the next is armed 60 s on. */
  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const batch = this.waiting();
    if (!batch.length) return;
    this.arm(NOTICE_RETRY_MS);
    if (this.trying) return;
    const key = `notices:${this.life}:${this.tick++}`;
    for (const n of batch) {
      n.attempts++;
      this.save(n.notice_id);
    }
    this.trying = true;
    try {
      await this.o.send(batch, key);
    } catch {
      // Nothing answered: the next attempt comes 60 s on.
    } finally {
      this.trying = false;
    }
    // A notice raised while the attempt was out is tried now.
    if (!this.stopped && this.waiting().some((n) => n.attempts === 0)) this.arm(0);
  }

  /** A step: an attempt's answer, each step's notice and whether it was delivered; the apply id kept for the attempt's later outcome events. */
  answered(applierApplyId: string | undefined, steps: { notice_id: string; step_id?: string; delivered: boolean }[]): void {
    if (applierApplyId) {
      this.byApplier.set(applierApplyId, new Map(steps.flatMap((s) => (s.step_id ? [[s.step_id, s.notice_id] as const] : []))));
      while (this.byApplier.size > ATTEMPTS_KEPT) this.byApplier.delete(this.byApplier.keys().next().value!);
    }
    for (const s of steps) if (s.delivered) this.delivered(s.notice_id);
  }

  private delivered(id: string): void {
    const n = this.notices.get(id);
    if (!n || n.delivered) return;
    n.delivered = true;
    if (!this.waiting().length && this.timer !== undefined) {
      this.o.clock.clear(this.timer);
      this.timer = undefined;
    }
    this.o.event({ notice_id: id, change: "delivered", source: n.source });
    if (n.source === "steward") this.forget(id);
    else this.save(id);
  }

  private forget(id: string): void {
    this.notices.delete(id);
    this.save(id);
  }

  /** Writes `id`'s row as it stands when the write runs, behind; safe to run twice. */
  private save(id: string): void {
    if (this.saving.has(id)) {
      this.saving.set(id, true);
      return;
    }
    this.saving.set(id, false);
    void this.o.store.write((tx) => writeNotice(tx, id, this.notices.get(id))).then(() => {
      const again = this.saving.get(id);
      this.saving.delete(id);
      if (again) this.save(id);
    });
  }
}

async function writeNotice(tx: Tx, id: string, n: Notice | undefined): Promise<void> {
  if (!n) {
    await tx.query("DELETE FROM notices WHERE notice_id = $1", [id]);
    return;
  }
  await tx.query("INSERT INTO notices (notice_id, source, doc, attempts, delivered) VALUES ($1, $2, $3, $4, $5) "
    + "ON CONFLICT (notice_id) DO UPDATE SET doc = EXCLUDED.doc, attempts = EXCLUDED.attempts, delivered = EXCLUDED.delivered",
  [id, n.source, JSON.stringify(n.doc), n.attempts, n.delivered]);
}
