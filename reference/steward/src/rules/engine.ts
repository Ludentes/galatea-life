import type { Clock } from "@ludentes/galatea-life-test-clock";
import { canonical } from "../core/canonical.js";
import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";
import type { Rule } from "../house/model.js";
import type { Mutation } from "../mutations.js";
import { conditionsHold, readingHolds, type View } from "./conditions.js";
import type { FiringStep } from "./outcomes.js";
import { nextTime, windowBoundary } from "./window.js";

type Body = Record<string, unknown>;

/**
 * Firing numbers are reserved in blocks this long (ruled, Q6): a rule's next block is written behind
 * when its last one is reached, so a store that is down never holds a firing up; a start after a
 * stop that was not clean skips one block, so a block taken but never written is not used twice.
 */
export const FIRING_BLOCK = 1000;
/**
 * How old an edge missed in a gap may be and still fire once the gap is read (ruled by the
 * maintainer, 2026-10-04: replayed, bounded in age): the schedules' 5-minute grace, the one bound the steward keeps
 * for work missed while it was not looking (its schedules after a restart). Older edges are lost, as the
 * standard has every edge in a gap.
 */
export const EDGE_REPLAY_MS = 300_000;
/** A rule's timer waits at most this long, and is set again when it fires: a far exception never overflows a timer. */
const MAX_WAIT_MS = 86_400_000;

/**
 * What the store keeps of a rule (GA-RULE-1, GA-STW-10): whether it fired since it last became true,
 * and the firing numbers reserved; `durable`, the reservation the store is known to hold.
 */
interface Kept { fired: boolean; firedAt?: number; reserved: number; durable: number }

/** What this life knows of a rule beside what is kept. */
interface Live {
  /** The next firing number. */
  next: number;
  /** Since when a held trigger's reading has held, its device live; undefined while it does not. */
  heldSince?: number;
  /** Whether an edge trigger on a state held at the last look, so only a change into it fires. */
  edge?: boolean;
  /** Whether the rule was inside an exception at the last look: leaving one re-evaluates (GA-RULE-6). */
  excepted?: boolean;
  timer?: number;
  /** Whether this life has looked at the rule: its first look reads what passed while the steward was down. */
  seen?: boolean;
  /** The minute a time trigger's timer was set for. */
  timerAt?: number;
  /**
   * One firing at a time; an edge trigger meanwhile is kept, one deep, and so is a level rule's new
   * becoming true, which is fired once the firing in flight is over.
   */
  firing?: boolean;
  pending?: boolean;
}

export interface EngineOptions {
  clock: Clock;
  store: Store;
  /** Where the engine's own lines go, injected (the milestone 7+10+11 review, M6). */
  logger: (line: string) => void;
  /** The rules of the house model as it stands. */
  rules(): Rule[];
  /** What a rule reads now: the mirror and the clock, in the home's timezone. */
  view(): View;
  /** Whether the mirror has the applier's state: before, nothing is evaluated, so no rule reads an empty mirror as false. */
  ready(): boolean;
  /** Fires a rule as firing `n`, all its actions or, a retry, `only` these steps; resolves once the firing is over. */
  fire(rule: Rule, n: number, only?: FiringStep[]): Promise<void>;
  /** The devices a rule names, read or acted on, for GA-LEASE-4. */
  names(rule: Rule): string[];
  /** Whether the last stop was clean: if not, a block of firing numbers is skipped. */
  clean(): boolean;
  /** A rule was deleted: what else is kept of it is forgotten. */
  forget?(rule: string): void;
  mutation?: Mutation;
}

const isLevel = (r: Rule) => r.trigger === undefined || "held" in r.trigger;
/** A rule's logic: what it watches and does. A change of it makes the rule new; its name, or an exception, does not. */
const logicOf = (r: Rule) => canonical({ trigger: r.trigger ?? null, conditions: r.conditions ?? null, actions: r.actions });

/**
 * The rules (the design, *Rules*): each rule's condition over the mirror and the clock, evaluated on
 * the events that touch the devices it reads, at its windows' and exceptions' boundaries and its held
 * duration's end (one clock timer per rule), when a lease on a device it names ends, and over all
 * rules when the applier's state is read (a start, a `cursor_expired`). A level-triggered rule (a held
 * trigger, or conditions only) fires once per becoming true and keeps "fired since it last became
 * true" in the store; an edge-triggered one fires on its trigger while its conditions hold. Nothing
 * fires inside an exception. Each rule's row is written behind, coalesced.
 */
export class RuleEngine {
  private readonly kept = new Map<string, Kept>();
  private readonly live = new Map<string, Live>();
  private readonly logic = new Map<string, string>();
  private readonly active = new Map<string, boolean>();
  private readonly saving = new Map<string, boolean>();
  /** Each rule's becoming true, counted in this life: one more each time it stops having fired (GA-RULE-8's "each time"). */
  private readonly episodes = new Map<string, number>();
  private stopped = false;
  private loaded = false;
  /** The rules held back past one unwritten block, looked at again once the store takes their reservation. */
  private readonly waiting = new Set<string>();
  /** The edge rules whose edge a gap held within `EDGE_REPLAY_MS`, fired once the gap is read (`fireOwed`). */
  private readonly owed = new Set<string>();

  constructor(private readonly o: EngineOptions) {}

  async load(): Promise<void> {
    const rows = await this.o.store.query<{ rule_id: string; fired: boolean; fired_at: number | string | null; reserved: number | string }>(
      "SELECT rule_id, fired, fired_at, reserved FROM rule_states ORDER BY rule_id");
    const gap = this.o.clean() ? 0 : FIRING_BLOCK;
    for (const r of rows.rows) {
      const reserved = Number(r.reserved) + gap;
      this.kept.set(r.rule_id, { fired: r.fired, ...(r.fired_at !== null ? { firedAt: Number(r.fired_at) } : {}), reserved, durable: reserved });
      this.live.set(r.rule_id, { next: reserved });
    }
    // The skipped block is written before anything fires, so a second crash cannot start inside it.
    if (gap) for (const [id, k] of this.kept) await this.o.store.write((tx) => writeRule(tx, id, k));
    // A retry pending at the stop: the rule fires again at its start evaluation, as the retry would
    // have (GA-RULE-7, ruled Q6). The rows are read once and cleared.
    const pending = await this.o.store.query<{ rule_id: string }>("SELECT DISTINCT rule_id FROM rule_pending WHERE kind = 'retry' ORDER BY rule_id");
    if (pending.rows.length) {
      for (const p of pending.rows) {
        const k = this.kept.get(p.rule_id);
        if (k) { k.fired = false; delete k.firedAt; }
      }
      await this.o.store.write(async (tx) => {
        for (const p of pending.rows) { const k = this.kept.get(p.rule_id); if (k) await writeRule(tx, p.rule_id, k); }
        await tx.query("DELETE FROM rule_pending WHERE kind = 'retry'");
      });
    }
    for (const r of this.o.rules()) {
      this.logic.set(r.id, logicOf(r));
      this.active.set(r.id, r.active);
    }
    this.loaded = true;
  }

  stop(): void {
    this.stopped = true;
    for (const l of this.live.values()) if (l.timer !== undefined) this.o.clock.clear(l.timer);
  }

  /** Whether a rule fired since it last became true, for tests. */
  fired(id: string): boolean {
    return this.kept.get(id)?.fired ?? false;
  }

  /**
   * The rule's becoming true, as this life counts them: it moves each time the rule stops having fired
   * (its condition false, a lease's or an exception's end, a change of its logic), so what was owed to
   * an earlier becoming true can be told apart (GA-RULE-7, GA-RULE-8).
   */
  episode(id: string): number {
    return this.episodes.get(id) ?? 0;
  }

  /**
   * Whether a rule of conditions only holds now (GA-RULE-7's "while the conditions hold"): active,
   * the mirror read, outside an exception, and its conditions true.
   */
  holds(id: string): boolean {
    const r = this.o.rules().find((x) => x.id === id);
    // A held rule holds while its reading does too (G3, ratified): its retries and notices follow it.
    const held = r?.trigger && "held" in r.trigger ? r.trigger.held : undefined;
    if (!r || !r.active || (r.trigger !== undefined && !held) || this.stopped || !this.o.ready()) return false;
    const v = this.o.view();
    return !this.excepted(r, v.now) && conditionsHold(r.conditions, v) && (!held || readingHolds(held, v));
  }

  /**
   * A step: fires a rule again with `steps` only, under its next firing number (GA-RULE-7, GA-STW-10).
   * A retry is no new becoming true: it waits on no firing in flight and leaves `fired` as it is.
   */
  retry(id: string, steps: FiringStep[]): void {
    const r = this.o.rules().find((x) => x.id === id);
    // Past one unwritten block a retry is dropped, as a firing waits (Q6's bound); the rule is looked at again once the store takes it.
    if (!r || this.stopped || !this.mayTake(id)) return;
    void this.o.fire(r, this.take(r.id), steps).catch(() => undefined);
  }

  /**
   * A step: the applier's state was read (a start, a model change, a `cursor_expired`): every rule is
   * looked at against it, a level rule that holds and has not fired firing (GA-RULE-1); an edge
   * trigger's changes in a gap are lost. A held duration runs on unless its device stopped being live;
   * after a restart every one starts afresh, this life having seen none (GA-PERSIST-2).
   */
  sync(): void {
    for (const r of this.o.rules()) this.look(r, { sync: true });
  }

  /**
   * A step: the house's rules after a `define`. A rule whose logic changed, or that was made active,
   * is new: it has not fired. Every rule is looked at again.
   */
  changed(): void {
    const now = new Map(this.o.rules().map((r) => [r.id, r]));
    for (const id of [...this.logic.keys()]) {
      if (now.has(id)) continue;
      this.logic.delete(id);
      this.active.delete(id);
      const l = this.live.get(id);
      if (l?.timer !== undefined) this.o.clock.clear(l.timer);
      if (l) { l.timer = undefined; l.heldSince = undefined; l.edge = undefined; l.excepted = undefined; }
      // Its firing numbers are kept: a rule made again with this id never reuses a key. The rest of
      // what is known of it goes (the milestone review, M3), but a firing in flight's live state.
      this.setFired(id, false);
      if (!l?.firing) this.live.delete(id);
      this.episodes.delete(id);
      this.waiting.delete(id);
      this.o.forget?.(id);
    }
    for (const r of now.values()) {
      const logic = logicOf(r);
      if (this.logic.get(r.id) !== logic || (r.active && this.active.get(r.id) === false)) {
        const l = this.liveOf(r.id);
        l.heldSince = undefined;
        l.edge = undefined;
        this.setFired(r.id, false);
      }
      this.logic.set(r.id, logic);
      this.active.set(r.id, r.active);
      this.look(r, { sync: true });
    }
  }

  /** A step: one of the applier's events, relayed: a rule reading its device looks again; an edge trigger it matches fires. */
  onEvent(e: Body): void {
    if (typeof e.target !== "string" || !["state", "liveness", "occurrence"].includes(String(e.type))) return;
    for (const r of this.o.rules()) {
      const t = r.trigger;
      if (t && "event" in t && t.event.target === e.target && t.event.type === e.type) {
        const matches = e.type === "liveness" ? t.event.new === undefined || t.event.new === e.new
          : (t.event.key === undefined || t.event.key === e.key) && (t.event.value === undefined || canonical(t.event.value) === canonical(e.value));
        if (matches) this.edge(r);
        continue;
      }
      const reads = [...(t && "state" in t ? [t.state.target] : t && "held" in t ? [t.held.target] : []),
        ...(r.conditions ?? []).flatMap((c) => ("target" in c ? [c.target] : []))];
      if (reads.includes(e.target)) this.look(r, {});
    }
  }

  /**
   * A step: one of the applier's events on `target`, missed in a gap and played over the mirror
   * (the design, *Recovery*): each level rule reading the device that has fired and is false on the
   * mirror as it now stands, as `look` judges it (its conditions false, or its held reading false on
   * a live device), counts as having become false, so the state read after the gap fires it if it holds
   * again (GA-RULE-1). Nothing fires here. `unknown`: the gap's events on it were dropped past the
   * cap, so the rule counts as having become false whatever the mirror says.
   */
  replayed(target: string, unknown = false): void {
    if (this.stopped || !this.loaded) return;
    const v = this.o.view();
    for (const r of this.o.rules()) {
      if (!r.active || !isLevel(r) || !this.kept.get(r.id)?.fired) continue;
      const t = r.trigger;
      const held = t && "held" in t ? t.held : undefined;
      if (![...(held ? [held.target] : []), ...(r.conditions ?? []).flatMap((c) => ("target" in c ? [c.target] : []))].includes(target)) continue;
      const falseNow = !conditionsHold(r.conditions, v) || (held !== undefined && v.device(held.target)?.live === true && !readingHolds(held, v));
      if (unknown || falseNow) this.setFired(r.id, false);
    }
  }

  /**
   * A step: one of the applier's events, missed in a gap, which happened at `atMs`, played over the
   * mirror: an edge rule it is an edge of (its `event` trigger matching, or a change into its `state`
   * trigger's reading on a live device) is owed a firing when the edge is within `EDGE_REPLAY_MS`,
   * and its edge is lost otherwise. A `state` trigger's reading before the gap is the last this life
   * saw; after a restart none was seen, and since an applier's `state` event reports a change, the
   * reading before it counts as not holding.
   */
  replayEdge(e: Body, atMs: number): void {
    if (this.stopped || !this.loaded || typeof e.target !== "string") return;
    const v = this.o.view();
    const recent = atMs >= v.now - EDGE_REPLAY_MS;
    for (const r of this.o.rules()) {
      const t = r.trigger;
      if (!r.active || !t) continue;
      let edge = false;
      if ("event" in t && t.event.target === e.target && t.event.type === e.type) {
        edge = e.type === "liveness" ? t.event.new === undefined || t.event.new === e.new
          : (t.event.key === undefined || t.event.key === e.key) && (t.event.value === undefined || canonical(t.event.value) === canonical(e.value));
      } else if ("state" in t && t.state.target === e.target && e.type === "state" && v.device(e.target)?.live === true) {
        const l = this.liveOf(r.id);
        const now = readingHolds(t.state, v);
        edge = now && l.edge !== true;
        l.edge = now;
      }
      if (edge && recent) this.owed.add(r.id);
    }
  }

  /**
   * A step, once a gap is read and the state taken: each rule owed an edge fires once, if its
   * conditions hold now and it is outside an exception, as any edge (the design, *Recovery*).
   */
  fireOwed(): void {
    const owed = [...this.owed].sort();
    this.owed.clear();
    for (const id of owed) {
      const r = this.o.rules().find((x) => x.id === id);
      if (r) this.edge(r);
    }
  }

  /** A step: a lease on `target` ended: a level-triggered rule naming it counts as becoming true again (GA-LEASE-4). */
  leaseEnded(target: string): void {
    for (const r of this.o.rules()) {
      if (!isLevel(r) || !this.o.names(r).includes(target)) continue;
      this.setFired(r.id, false);
      this.look(r, {});
    }
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id);
    if (!l) {
      l = { next: this.kept.get(id)?.reserved ?? 0 };
      this.live.set(id, l);
    }
    return l;
  }

  private excepted(r: Rule, now: number): boolean {
    return this.o.mutation !== "fires-in-an-exception" && r.exceptions.some((x) => Date.parse(x.from) <= now && now < Date.parse(x.until));
  }

  /**
   * Looks at one rule now. A level rule: its condition (a held trigger held long enough, its device
   * live, and its conditions) false clears `fired`; true, not fired and outside an exception, fires.
   * Leaving an exception counts as becoming true (GA-RULE-6). An edge rule on a state: a change into
   * its reading fires (on `sync`, nothing fires: a change in a gap is lost, GA-RULE-1). A time trigger
   * fires at its minute. Then the rule's timer is set to its next boundary.
   */
  private look(r: Rule, o: { sync?: boolean; timer?: boolean }): void {
    if (this.stopped || !this.o.ready()) return;
    const l = this.liveOf(r.id);
    if (!r.active) {
      if (l.timer !== undefined) this.o.clock.clear(l.timer);
      l.timer = undefined;
      return;
    }
    const v = this.o.view();
    const now = v.now;
    const excepted = this.excepted(r, now);
    if (l.excepted && !excepted && isLevel(r)) this.setFired(r.id, false);
    // The first look of a life: a window that ended, or an exception that ended, between the rule's
    // firing and now made it false, or excepted, while the steward was down: it becomes true again
    // (GA-RULE-1, GA-RULE-3, GA-RULE-6). A device's own change in the gap needs history (slice 7).
    if (!l.seen) {
      l.seen = true;
      const k = this.kept.get(r.id);
      if (isLevel(r) && k?.fired && k.firedAt !== undefined && this.lapsed(r, k.firedAt, now, v)) this.setFired(r.id, false);
    }
    l.excepted = excepted;
    const t = r.trigger;
    if (isLevel(r)) {
      const conditions = conditionsHold(r.conditions, v);
      let holds = conditions;
      // A held reading that is only not yet held long enough, or not known (its device not live, or
      // this life not having seen it start), has not gone false: a fresh start of the duration delays
      // a rule that has not fired, and never fires one again that has (ruled, Q2).
      let unsettled = false;
      if (t && "held" in t) {
        const reading = readingHolds(t.held, v);
        if (!reading) l.heldSince = undefined;
        else l.heldSince ??= now;
        holds &&= l.heldSince !== undefined && now - l.heldSince >= t.held.for_s * 1000;
        unsettled = conditions && (reading || v.device(t.held.target)?.live !== true);
      }
      const kept = this.kept.get(r.id);
      if (!holds) {
        if (kept?.fired && !unsettled && !(this.o.mutation === "conditions-fire-once" && !t && this.windowsHold(r, v))) this.setFired(r.id, false);
      } else if (!kept?.fired && !excepted) {
        this.setFired(r.id, true);
        this.launch(r);
      }
    } else if (t && "state" in t) {
      // An edge is a change of the value seen while the device is live: a device that stops being
      // live and comes back reading what it read before is no change, nor is a restart.
      if (v.device(t.state.target)?.live === true) {
        const now2 = readingHolds(t.state, v);
        if (now2 && l.edge === false && !o.sync) this.edge(r);
        l.edge = now2;
      }
    } else if (t && "time" in t && l.timerAt !== undefined && now >= l.timerAt) {
      // At or past its minute, whatever looked: a timer that runs late must not lose it to an event's look.
      this.edge(r);
    }
    this.arm(r, v);
  }

  /** Whether one of the rule's windows ended, or one of its exceptions ended, after `since` and by `now`. */
  private lapsed(r: Rule, since: number, now: number, v: View): boolean {
    for (const c of r.conditions ?? []) {
      if (!("between" in c)) continue;
      const b = windowBoundary(c.between, since, v.tz, v.mutation);
      if (b !== undefined && b <= now) return true;
    }
    return r.exceptions.some((x) => { const until = Date.parse(x.until); return until > since && until <= now; });
  }

  /** Whether a rule's time windows hold, for `conditions-fire-once`, which clears `fired` only when one does not. */
  private windowsHold(r: Rule, v: View): boolean {
    return (r.conditions ?? []).every((c) => !("between" in c) || conditionsHold([c], v));
  }

  /** An edge trigger: fires when the rule's conditions hold and it is outside an exception; inside one, it is lost (GA-RULE-6). */
  private edge(r: Rule): void {
    if (!r.active || !this.o.ready()) return;
    const v = this.o.view();
    if (this.excepted(r, v.now) || !conditionsHold(r.conditions, v)) return;
    this.launch(r);
  }

  /**
   * Fires `r` with its next number, one firing at a time. A second edge meanwhile waits, one deep; so
   * does a level rule that became true again while its firing was in flight (it went false and true,
   * and `look` set `fired` for the new becoming true): once the firing is over it is fired again if it
   * still has not gone false since (GA-RULE-1, GA-RULE-5).
   */
  private launch(r: Rule): void {
    const l = this.liveOf(r.id);
    if (l.firing) {
      l.pending = true;
      return;
    }
    // Past one block the store has not taken, a crash could start inside numbers used: the rule waits
    // for the store (said once), and is looked at again once the reservation is written (Q6's bound).
    if (!this.mayTake(r.id)) {
      if (!this.waiting.has(r.id)) this.o.logger(`rule ${r.id}: its firing numbers ran a block past what the store holds; it waits for the store`);
      this.waiting.add(r.id);
      this.setFired(r.id, false);
      return;
    }
    l.firing = true;
    const n = this.take(r.id);
    void this.o.fire(r, n).catch(() => undefined).finally(() => {
      l.firing = false;
      if (!l.pending) return;
      l.pending = false;
      const again = this.o.rules().find((x) => x.id === r.id);
      if (!again || this.stopped) return;
      if (!isLevel(again)) this.edge(again);
      else if (this.kept.get(again.id)?.fired && !this.excepted(again, this.o.view().now)) this.launch(again);
    });
  }

  /** Whether the rule's next number stays within one block past the reservation the store holds. */
  private mayTake(id: string): boolean {
    const k = this.kept.get(id);
    return this.liveOf(id).next < (k?.durable ?? 0) + FIRING_BLOCK;
  }

  /** The rule's next firing number, its next block reserved, written behind, when this one is its block's last. */
  private take(id: string): number {
    const n = this.liveOf(id).next++;
    const kept = this.kept.get(id) ?? { fired: false, reserved: 0, durable: 0 };
    if (n + 1 > kept.reserved) {
      kept.reserved = Math.ceil((n + 1) / FIRING_BLOCK) * FIRING_BLOCK;
      this.kept.set(id, kept);
      this.save(id);
    }
    return n;
  }

  /** The rule's timer at its next boundary: a window's start or end, a held duration's end, an exception's start or end, a time trigger's minute. */
  private arm(r: Rule, v: View): void {
    const l = this.liveOf(r.id);
    if (l.timer !== undefined) this.o.clock.clear(l.timer);
    l.timer = undefined;
    const now = v.now;
    const at: number[] = [];
    for (const c of r.conditions ?? []) if ("between" in c) at.push(windowBoundary(c.between, now, v.tz, v.mutation) ?? Infinity);
    const t = r.trigger;
    if (t && "held" in t && l.heldSince !== undefined && l.heldSince + t.held.for_s * 1000 > now) at.push(l.heldSince + t.held.for_s * 1000);
    if (t && "time" in t) {
      const next = nextTime(t.time.at, t.time.days, now, v.tz);
      l.timerAt = next;
      if (next !== undefined) at.push(next);
    }
    for (const x of r.exceptions) for (const b of [Date.parse(x.from), Date.parse(x.until)]) if (b > now) at.push(b);
    const next = Math.min(...at);
    if (!Number.isFinite(next)) return;
    l.timer = this.o.clock.setTimeout(() => {
      l.timer = undefined;
      const now2 = this.o.rules().find((x) => x.id === r.id);
      if (now2) this.look(now2, { timer: true });
    }, Math.min(Math.max(0, next - now), MAX_WAIT_MS));
  }

  private setFired(id: string, fired: boolean): void {
    // A rule's row read after this would be read over it: nothing is set before the rows are loaded.
    if (!this.loaded) throw new Error("a rule's fired state was set before the rules were loaded");
    const kept = this.kept.get(id) ?? { fired: false, reserved: 0, durable: 0 };
    if (kept.fired === fired && this.kept.has(id)) return;
    if (kept.fired && !fired) this.episodes.set(id, this.episode(id) + 1);
    kept.fired = fired;
    if (fired) kept.firedAt = Math.floor(this.o.clock.now());
    else delete kept.firedAt;
    this.kept.set(id, kept);
    this.save(id);
  }

  /**
   * Writes a rule's row as it stands when the write runs, and resolves once it has committed: a
   * firing's `fired`, and its block if it moved, commit before it sends while the store is up (the
   * design, *Decisions*; the milestone 5+6 review, I7), so a crash after the send never fires it again.
   */
  committed(id: string): Promise<void> {
    if (!this.kept.has(id)) return Promise.resolve();
    let wrote = 0;
    return this.o.store.write((tx) => { const k = this.kept.get(id)!; wrote = k.reserved; return writeRule(tx, id, k); }).then(() => {
      const k = this.kept.get(id);
      if (k) k.durable = Math.max(k.durable, wrote);
    });
  }

  /** Writes a rule's row as it stands when the write runs, behind; safe to run twice. */
  private save(id: string): void {
    if (this.saving.has(id)) {
      this.saving.set(id, true);
      return;
    }
    this.saving.set(id, false);
    let wrote = 0;
    void this.o.store.write((tx) => { const k = this.kept.get(id)!; wrote = k.reserved; return writeRule(tx, id, k); }).then(() => {
      const k = this.kept.get(id);
      if (k) k.durable = Math.max(k.durable, wrote);
      const again = this.saving.get(id);
      this.saving.delete(id);
      if (again) this.save(id);
      // A rule that waited for its reservation is looked at again.
      if (this.waiting.delete(id)) {
        const r = this.o.rules().find((x) => x.id === id);
        if (r) this.look(r, {});
      }
    });
  }
}

async function writeRule(tx: Tx, id: string, k: Kept): Promise<void> {
  await tx.query("INSERT INTO rule_states (rule_id, fired, fired_at, reserved) VALUES ($1, $2, $3, $4) "
    + "ON CONFLICT (rule_id) DO UPDATE SET fired = EXCLUDED.fired, fired_at = EXCLUDED.fired_at, reserved = GREATEST(rule_states.reserved, EXCLUDED.reserved)",
  [id, k.fired, k.firedAt ?? null, k.reserved]);
}
