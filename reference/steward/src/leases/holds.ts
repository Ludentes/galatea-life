import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { HoldPolicy } from "../house/model.js";
import type { Mutation } from "../mutations.js";
import { LATE_ACK_WINDOW_MS } from "../rules/outcomes.js";
import { judgeHold, type Direction, type HoldState, type Judged, type RoomNow } from "./hold.js";
import type { EndInfo, Lease, LeaseTable } from "./table.js";

export interface HoldsOptions {
  table: LeaseTable;
  /** The wall clock; a hold's windows run on the elapsed clock the table's time base relates to it (R-74). */
  clock: Clock;
  policy: () => HoldPolicy;
  /**
   * The device's room and presence as of `atWallMs` (a replayed event's or a fired timer's instant,
   * R-49), else as of now; `vacantAtMs` on the wall clock. `unknown`: the room's sources not known yet as
   * of then (a start, before its first state: no gap's event spoke of them), left out of `sources` and
   * `busy` (R-55); `readBackLive`: those of them the state read back shows `live`, if it was read;
   * `unread`: live sources (in `sources`) whose reading is not known yet, left out of `busy`.
   */
  roomNow: (target: string, atWallMs?: number) => Omit<RoomNow, "vacantAtMs"> & { vacantAtWallMs?: number; unknown?: string[]; readBackLive?: string[];
    unread?: string[] };
  /**
   * The device's room in the house now, which is how `judgeRoom` finds a room's holds without reading
   * presence for each. The house keeps no history, so a define during a gap moves a device for the
   * whole replay; a hold's own room (`HoldState.room`) still finds it in the room it was in.
   */
  roomOf: (target: string) => string | undefined;
  /**
   * A guest's hold's floor passed, by a success or by time: what it refused may pass it now (GA-LEASE-10,
   * R-63). One that passed while a gap was replayed is told once the gap is read (`begin`), if that hold
   * is still the device's lease.
   */
  floorPassed?: (target: string) => void;
  /** Where Holds' own lines go: a change in a gap that takes no lease. Optional, as the link's `log`. */
  logger?: (line: string) => void;
  mutation?: Mutation;
}

const iso = (ms: number) => new Date(Math.floor(ms)).toISOString();
/**
 * The last instant a `date-time` can show, 9999-12-31T23:59:59.999Z: a window past it is shown and armed
 * there (GA-LEASE-8, R-60). JavaScript's own last date, 8.64e15 ms, prints as `+275760-…`, which is no
 * RFC 3339 `date-time`.
 */
const LAST_DATE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** An outside change read back from a gap, held until `begin` grants it or finds its end passed (GA-LEASE-2). */
interface Pending {
  cause: "external" | "load_cap";
  hold: HoldState;
  /** The change's time, on the wall clock: the grant's `sinceMs`. */
  sinceWallMs: number;
  /** When to judge it again, on the wall clock, as a lease's timer would. */
  timerWallMs: number;
  /** Its end passed in the gap: it takes no lease. */
  ended?: true;
  /** It replaced a lease in the gap: the rules that lease refused, passed on to it (R-48), maybe none. */
  refused?: string[];
}

/**
 * Every person's hold and `load_cap` lease, judged by the declared policy whenever something it
 * rests on moves: a presence report in its room, a define (the policy, a room), the applier's model
 * (a source adopted or removed, a device gone), an ack, or its own timer (the design, *Leases*).
 * Judged only once the first state read after a start has come (`begin`), or as of a gap's event
 * while that gap is replayed (`replayAt`).
 */
export class Holds {
  private ready = false;
  /** The elapsed instant judged as of while a gap's event is replayed; none: now. */
  private atEl?: number;
  private readonly pending = new Map<string, Pending>();
  /** The guest's holds whose floor passed while a gap was replayed, told at `begin` (R-63). */
  private readonly floorsPassed = new Map<string, Lease>();

  constructor(private readonly o: HoldsOptions) {}

  private now(): number { return this.atEl ?? this.o.table.time.now(); }
  // One offset both ways, shared with the table (R-74): a wall-born instant comes back as the same integer
  // millisecond, and a shown instant is rounded, never floored.
  private wall(el: number): number { return this.o.table.time.wall(el); }
  private el(wall: number): number { return this.o.table.time.el(wall); }

  /**
   * The room as judged for `kept` (none: a hold starting). A source not known yet counts as the hold kept
   * it: live if it was live then; one newly adopted, or any for a hold starting in the gap, live if the
   * state read back shows it so, a liveness the gap did not move; it, or a live source whose reading the
   * gap did not give, reads presence only if the hold was kept busy. So a restart's mirror, which knows
   * only the read-back, moves neither the `fixed_s` anchor nor the quiet, and only time-based ends are
   * found (GA-PERSIST-2; R-55).
   */
  private room(target: string, kept?: HoldState): RoomNow {
    const { vacantAtWallMs, unknown = [], readBackLive = [], unread = [], ...r } = this.atEl !== undefined ? this.o.roomNow(target, this.wall(this.atEl)) : this.o.roomNow(target);
    const assumed = unknown.filter((id) => (kept ? kept.sources.includes(id) || (!kept.adopted.includes(id) && readBackLive.includes(id)) : readBackLive.includes(id)));
    const sources = assumed.length ? [...new Set([...r.sources, ...assumed])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) : r.sources;
    const busy = r.busy || (kept?.quietFromMs === null && (assumed.length > 0 || unread.length > 0));
    return { ...r, sources, busy, ...(vacantAtWallMs !== undefined ? { vacantAtMs: this.el(vacantAtWallMs) } : {}) };
  }

  private judged(target: string, h: HoldState): Judged {
    return judgeHold(h, this.o.policy(), this.room(target, h), this.now(), this.o.mutation);
  }

  /**
   * What the lease table keeps of a judgement: the shown end and the timer, on the wall clock (R-46);
   * the timer rounded up, so it never falls before the end it judges; both no later than the last date.
   */
  private ends(j: Judged): { expiresMs: number; timerAtMs: number } {
    // A guest's hold is judged again at its floor too, which the owner's work passes after (GA-LEASE-10, R-63).
    const timer = j.state.role === "guest" && j.state.floorMs !== null ? Math.min(j.timerAtMs, j.state.floorMs) : j.timerAtMs;
    return { expiresMs: Math.min(LAST_DATE_MS, this.wall(j.expiresMs)), timerAtMs: Math.min(LAST_DATE_MS, Math.ceil(this.o.table.time.wallExact(timer))) };
  }

  /**
   * Runs `fn` as of `atWallMs` (a gap's event time, already clamped by the caller); ends found then
   * carry `end_time`. Every hold whose timer fell due before that time is judged first, as of its
   * timer, as the timer would have judged it: a hold whose end passed before a later report is
   * ended, and that report revives nothing (GA-LEASE-7, GA-PERSIST-2).
   */
  replayAt(atWallMs: number, fn: () => void): void {
    try {
      this.fireDue(atWallMs);
      this.atEl = this.el(atWallMs);
      fn();
    } finally { this.atEl = undefined; }
  }

  /**
   * Judges every hold the store gave back as of `atWallMs`, the steward's last live reading before the
   * gap (GA-LEASE-7's lower clamp; R-51), against the room as each hold kept it (R-55): its timer is
   * computed again, so an end that fell in the gap is found as the gap is replayed, or at `begin`.
   */
  reloaded(atWallMs: number): void {
    this.replayAt(Math.min(atWallMs, this.o.clock.now()), () => {
      for (const l of this.o.table.all()) if (l.hold) this.judge(l.target);
    });
  }

  /**
   * Judges every hold whose timer fell due at or before `atWallMs` (a gap's event time, clamped), as of
   * its timer, before that event moves the mirror: a hold whose end passed before a later report is
   * ended there, the report not yet seen (GA-LEASE-7; R-49).
   */
  catchUp(atWallMs: number): void {
    try { this.fireDue(atWallMs); } finally { this.atEl = undefined; }
  }

  /** Judges, in order of time, every hold and pending change whose timer falls at or before `atWallMs`. */
  private fireDue(atWallMs: number): void {
    const fired = new Set<string>();
    for (;;) {
      let next: { target: string; at: number; pending: boolean } | undefined;
      const consider = (target: string, at: number, pending: boolean) => {
        if (at <= atWallMs && !fired.has(`${pending ? "p" : "l"}:${target}@${at}`) && (!next || at < next.at)) next = { target, at, pending };
      };
      for (const l of this.o.table.all()) if (l.hold && l.expiresMs !== null) consider(l.target, l.timerAtMs ?? l.expiresMs, false);
      for (const [target, p] of this.pending) if (!p.ended) consider(target, p.timerWallMs, true);
      if (!next) return;
      // One judgement per item per instant: a timer the rounding left in place is not judged again.
      fired.add(`${next.pending ? "p" : "l"}:${next.target}@${next.at}`);
      this.atEl = this.el(next.at);
      if (next.pending) this.judgePending(next.target);
      else this.judge(next.target);
    }
  }

  start(target: string, kind: "person" | "load_cap", direction: Direction | undefined,
    floor?: { dispatchWallMs: number; ackWithinS: number }, role?: HoldState["role"], expect?: HoldState["expect"]): HoldState {
    const now = this.now();
    const r = this.room(target);
    const at = floor ? this.el(floor.dispatchWallMs) : now;
    return { kind, ...(kind === "person" && direction ? { direction } : {}), changeMs: at, quietFromMs: r.busy ? null : at,
      floorMs: floor ? at + floor.ackWithinS * 1000 + LATE_ACK_WINDOW_MS : null, fixedFromMs: at,
      vacantAtChange: r.occupancy === "vacant", seenNotVacant: false, room: r.room, sources: r.sources, adopted: r.adopted, ...(role ? { role } : {}),
      ...(expect ? { expect } : {}) };
  }

  /** A hold just started's `expires` and its timer (a predicted vacancy may be sooner), on the wall clock, for the grant. */
  expires(target: string, h: HoldState): { expiresMs: number; timerAtMs: number } {
    return this.ends(this.judged(target, h));
  }

  change(target: string, cause: "external" | "load_cap", direction: Direction | undefined): void {
    const hold = this.start(target, cause === "load_cap" ? "load_cap" : "person", direction);
    const j = this.judged(target, hold);
    const since = this.wall(this.now());
    if (this.atEl !== undefined) {
      // Read back from a gap: it replaces the lease it meets there and then (R-48), and is held until
      // `begin`, which grants it unless its end passed (GA-LEASE-2).
      const handed = this.o.table.replacedInGap(target, iso(since));
      const before = this.pending.get(target)?.refused;
      const refused = handed === undefined && before === undefined ? undefined
        : [...new Set([...(before ?? []), ...(handed ?? [])])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      this.pending.set(target, { cause, hold: j.state, sinceWallMs: since, timerWallMs: this.ends(j).timerAtMs, ...(refused ? { refused } : {}) });
      return;
    }
    if (this.o.table.grant({ target, holder: cause, precedence: "person", sinceMs: since, ...this.ends(j), hold })) this.judge(target);
  }

  judge(target: string, o: { gap?: boolean } = {}): void {
    if (!this.ready && this.atEl === undefined) return;
    const l = this.o.table.of(target);
    if (!l?.hold) return;
    const j = this.judged(target, l.hold);
    if (j.end) {
      const now = this.now();
      const quietSince = j.state.pendingEnd ? j.state.pendingEnd.quietSinceMs : j.state.quietSinceMs;
      const info: EndInfo = { end: j.end.why,
        ...(j.end.why === "quiet" && quietSince !== undefined && this.o.mutation !== "quiet-without-its-moment" ? { quiet_since: iso(this.wall(quietSince)) } : {}),
        ...(this.atEl !== undefined || (o.gap && j.end.atMs < now) ? { end_time: iso(this.wall(j.end.atMs)) } : {}) };
      this.o.table.end(target, (x) => x === l, info);
      return;
    }
    // A guest's hold whose floor has passed by time forgets it, and what it refused is told (R-63).
    const passed = j.state.role === "guest" && j.state.floorMs !== null && this.now() >= j.state.floorMs;
    const judged = passed ? { ...j, state: { ...j.state, floorMs: null } } : j;
    this.o.table.update(target, { hold: judged.state, ...this.ends(judged) });
    if (passed) this.floorPassedOn(target, l);
  }

  /** `l`, a guest's hold on `target`, has had its floor pass: told now, or, in a gap's replay, once the gap is read (R-63). */
  private floorPassedOn(target: string, l: Lease): void {
    if (this.atEl === undefined) this.o.floorPassed?.(target);
    else this.floorsPassed.set(target, l);
  }

  /** A pending change judged in place as of now: its state moved, or marked ended when its end has come. */
  private judgePending(target: string): void {
    const p = this.pending.get(target);
    if (!p || p.ended) return;
    const j = this.judged(target, p.hold);
    if (j.end) {
      p.ended = true;
      return;
    }
    p.hold = j.state;
    p.timerWallMs = this.ends(j).timerAtMs;
  }

  judgeAll(o: { gap?: boolean } = {}): void {
    for (const l of this.o.table.all()) if (l.hold) this.judge(l.target, o);
  }

  judgeRoom(room: string): void {
    const inRoom = (target: string, h: HoldState) => h.room === room || this.o.roomOf(target) === room;
    for (const l of this.o.table.all()) if (l.hold && inRoom(l.target, l.hold)) this.judge(l.target);
    if (this.atEl !== undefined) for (const [target, p] of this.pending) if (inRoom(target, p.hold)) this.judgePending(target);
  }

  /**
   * The hold on `target` takes now as its change, its quiet and its `fixed_s` anchor (a quiet that has not
   * begun stays so), and is judged again. Called only under the mutation `pass-moves-the-end`: a pass
   * moves no hold's end (GA-LEASE-12).
   */
  touch(target: string): void {
    const l = this.o.table.of(target);
    if (!l?.hold) return;
    const now = this.now();
    const hold = { ...l.hold, changeMs: now, fixedFromMs: now, quietFromMs: l.hold.quietFromMs === null ? null : now };
    this.o.table.update(target, { hold, ...this.ends(this.judged(target, hold)) });
    this.judge(target);
  }

  acked(target: string, apply: string): void {
    const l = this.o.table.of(target);
    if (!l?.hold || l.apply !== apply || l.hold.floorMs === null) return;
    this.o.table.update(target, { hold: { ...l.hold, floorMs: null }, expiresMs: l.expiresMs, timerAtMs: l.timerAtMs });
    this.judge(target);
    // A guest's hold's floor ends at the success: what it refused is told (R-63).
    if (l.hold.role === "guest" && this.o.table.of(target) === l) this.floorPassedOn(target, l);
  }

  /**
   * The device reported `key` at `value`: a hold, or a provisional lease, whose step's ack is matched on it
   * has its floor for passing ended (`LeaseTable.reported`; GA-LEASE-10, GA-LEASE-12). A guest's hold so
   * marked inside its floor tells what it refused, as a success does (R-63, R-3); its own floor stays.
   */
  reported(target: string, key: string, value: unknown): void {
    const l = this.o.table.of(target);
    const was = l?.hold?.reported === true;
    this.o.table.reported(target, key, value);
    const h = l?.hold;
    if (!l || was || h?.reported !== true || h.role !== "guest" || h.floorMs === null || this.now() >= h.floorMs) return;
    this.floorPassedOn(target, l);
  }

  /**
   * `apply`'s step on `target` was granted its hold carrying a report that came while it was provisional:
   * a guest's tells what it refused, as `reported` does (R-63).
   */
  settledReported(target: string, apply: string): void {
    const l = this.o.table.of(target);
    const h = l?.hold;
    if (!l || l.apply !== apply || h?.reported !== true || h.role !== "guest" || h.floorMs === null || this.now() >= h.floorMs) return;
    this.floorPassedOn(target, l);
  }

  /**
   * A press's step ended `unreachable` (GA-LEASE-9, R-58): while `target`'s lease is still `apply`'s
   * press's hold, it ends and the hold it replaced is granted again, its `expires` judged as of now (a
   * gap's outcome: as of its time, the end carrying `end_time`); a restored hold whose end has passed
   * then ends at once, by the end the policy gives it. Returns whether it restored one.
   */
  restore(target: string, apply: string): boolean {
    const back = this.o.table.restore(target, apply, (l) => (l.hold ? this.ends(this.judged(target, l.hold)) : { expiresMs: l.expiresMs }),
      this.atEl !== undefined ? { end_time: iso(this.wall(this.atEl)) } : {});
    if (back) this.judge(target);
    return back;
  }

  removed(gone: (target: string) => boolean): void {
    if (this.o.mutation === "keeps-a-removed-hold") return;
    for (const [target, p] of [...this.pending]) {
      if (!gone(target)) continue;
      this.pending.delete(target);
      if (p.refused) this.o.table.handBack(target, p.refused);
    }
    const info: EndInfo = { end: "removed", ...(this.atEl !== undefined ? { end_time: iso(this.wall(this.atEl)) } : {}) };
    for (const l of this.o.table.all()) if (l.hold && gone(l.target)) this.o.table.end(l.target, (x) => x === l, info);
  }

  begin(): void {
    this.ready = true;
    // The gap's own timers first, after its last replayed event: a vacancy or a window that fell due
    // in the gap ends as of then, with end_time (R-49).
    try { this.fireDue(this.o.clock.now()); } finally { this.atEl = undefined; }
    for (const [target, p] of [...this.pending]) {
      this.pending.delete(target);
      this.settle(target, p);
    }
    this.judgeAll({ gap: true });
    // The guest's holds whose floor passed in the gap, still the device's lease: what they refused is told now (R-63).
    for (const [target, l] of [...this.floorsPassed]) {
      this.floorsPassed.delete(target);
      if (this.o.table.of(target) === l) this.o.floorPassed?.(target);
    }
  }

  /** A change read back from a gap, at the read-back: granted from its change's time, unless its end passed (GA-LEASE-2). */
  private settle(target: string, p: Pending): void {
    if (this.o.mutation === "missed-change-full-window") {
      // A fresh window at the read-back, as if the change were now.
      const hold = this.start(target, p.hold.kind, p.hold.direction);
      this.o.table.grant({ target, holder: p.cause, precedence: "person", sinceMs: Math.floor(this.o.clock.now()), ...this.ends(this.judged(target, hold)), hold,
        ...(p.refused?.length ? { refused: p.refused } : {}) });
      return;
    }
    const j = p.ended ? undefined : this.judged(target, p.hold);
    if (!j || j.end) {
      // No lease: the hold it replaced in the gap stays ended, and the rules that hold refused are re-evaluated (R-48).
      this.o.logger?.(`the ${p.cause} change on ${target} at ${iso(p.sinceWallMs)}, read back from the gap, ended there; it takes no lease`);
      if (p.refused) this.o.table.handBack(target, p.refused);
      return;
    }
    this.o.table.grant({ target, holder: p.cause, precedence: "person", sinceMs: p.sinceWallMs, ...this.ends(j), hold: j.state,
      ...(p.refused?.length ? { refused: p.refused } : {}) });
  }
}
