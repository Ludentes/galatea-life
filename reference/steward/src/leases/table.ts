import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";
import { matcher } from "@ludentes/galatea-life-schemas";
import type { Mutation } from "../mutations.js";
import { shiftHold, type HoldEnd, type HoldState } from "./hold.js";
import { TimeBase } from "./time-base.js";

/** A lease's precedence, highest first (steward, *Leases*). */
export type Precedence = "safety_rule" | "person" | "scheduled_run" | "rule";
const RANK: Record<Precedence, number> = { safety_rule: 3, person: 2, scheduled_run: 1, rule: 0 };

/**
 * Who holds a lease: a principal (`{ person?, endpoint }`, `{ rule }`, `{ run }`), `external` or
 * `load_cap`, or a safety rule, `{ safety_rule: <its id> }`.
 */
export type Holder = Record<string, unknown> | "external" | "load_cap" | "safety_rule";

/** One device's lease (steward, *Leases*): a group is expanded to its members, so a lease is per device here. */
export interface Lease {
  target: string;
  holder: Holder;
  precedence: Precedence;
  /** When it was granted: from dispatch for an apply's step, from the report for an outside change. */
  sinceMs: number;
  /** When it ends; null: at the end of its run (`run_end`, slice 5), or, a safety rule's, when the rule releases it (GA-LEASE-6). */
  expiresMs: number | null;
  /** The steward's apply whose step it came from, so a later `unreachable` of that step ends it (GA-LEASE-1). */
  apply?: string;
  /** The rules it refused an action of while it held, re-evaluated at its end (GA-LEASE-4), in code-point order. */
  refused?: string[];
  /** A person's hold's or a load_cap lease's own state, its instants on the elapsed clock (GA-LEASE-7, GA-PERSIST-2). */
  hold?: HoldState;
  /**
   * When the table's timer falls due for a hold, on the wall clock: the hold judged again, which may be
   * before `expiresMs` (a predicted vacancy, which `expires` never shows). In memory only; none: at `expiresMs`.
   */
  timerAtMs?: number;
  /** The whole person's hold a press's hold replaced, its hold and the rules it refused with it (GA-LEASE-9). */
  replaced?: Lease;
}

/** What a hold's `lease` event says of its end (GA-LEASE-7, *Explained*). */
export interface EndInfo { end: HoldEnd; quiet_since?: string; end_time?: string; run?: string }

/** Whether `l` is a person's hold: an endpoint principal's, `external`, or a press's (GA-LEASE-7). */
export function personsHold(l: Pick<Lease, "holder" | "precedence">): boolean {
  if (l.precedence !== "person") return false;
  const h = l.holder;
  if (h === "external") return true;
  return typeof h === "object" && (typeof h.endpoint === "string" || isPress(h));
}

/** A press rule's holder, `{ rule, press }` (GA-LEASE-9). */
export const isPress = (h: Holder): h is { rule: string; press: { target: string; key: string; value: unknown } } => typeof h === "object" && typeof h.rule === "string" && typeof h.press === "object" && h.press !== null;

/** The longest delay a host's timer keeps (2^31 - 1 ms); a later end is reached by re-arming. */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * A lease laid at dispatch over a device's lease until the applier answers (the design, *Apply and
 * dispatch*); `refused` once a change it outranked was refused by it, so lifting it re-evaluates.
 */
interface Provisional { apply: string; step: string; holder: Holder; precedence: Precedence; refused?: true; rules?: string[];
  /** The apply's derived role, which its hold will keep (GA-LEASE-10). */
  role?: HoldState["role"];
  /** The report the step's ack is matched on (R-6), and whether it has come, which its hold keeps (GA-LEASE-12). */
  expect?: HoldState["expect"]; reported?: true }

/** Whether a change at `p` meets `lease` as lower precedence, so it is refused (GA-LEASE-3); equal or higher replaces. */
export function refusedBy(lease: Pick<Lease, "precedence"> | undefined, p: Precedence): boolean {
  return lease !== undefined && RANK[lease.precedence] > RANK[p];
}

/**
 * What a change on a device meets: its provisional lease, else its lease (GA-LEASE-3), with a hold's
 * derived role and whether its floor has passed (a provisional lease's has not) (GA-LEASE-10); under a
 * provisional lease, the device's lease `beneath` it, which a narrowing action is judged against too (R-67).
 */
export type Met = Pick<Lease, "holder" | "precedence"> & { role?: HoldState["role"]; floorPassed?: boolean; sinceMs?: number; beneath?: Met };

/** A switch by which the owner's work passes a person's hold: GA-LEASE-12's three, then GA-LEASE-10's guest flag. */
export type Switch = "rule" | "device" | "home" | "guest";

/** The hold a step passed and the first switch covering it, its `passed_hold` (GA-LEASE-12). */
export interface PassedHold { holder: Holder; switch: Switch }

/**
 * How a change passes a lease beside its precedence: `press`, a press rule's own action (GA-LEASE-9);
 * `ownerWork`, a step of a rule, a scheduled run or a rule-started run not `brain_authored` for the device (GA-LEASE-10);
 * `narrowing`, a narrowing action not `brain_authored` for the device (GA-LEASE-11).
 */
/**
 * `switches`: GA-LEASE-12's switches covering this step on this device, in the order rule, device, home;
 * `undoesNarrowing`: the step undoes a narrowing (`undoesNarrowing` in narrowing.ts), which the home's switch does not pass.
 */
export interface Passing { press?: true; ownerWork?: true; narrowing?: true; switches?: Exclude<Switch, "guest">[]; undoesNarrowing?: true }

/**
 * What else a lease judgement reads: the mutation; whether the steward declares
 * `owner_work_passes_guest_holds` (`guestsPass`); when the home's `owner_work_passes_holds` was last
 * set `true` (`homeSetMs`, on the wall clock), which only `switch-spares-held-holds` reads.
 */
export interface PassOptions { mutation?: Mutation; guestsPass?: boolean; homeSetMs?: number }

/** Whether `l` is a guest's hold: one an apply took whose derived role was `guest` (GA-LEASE-10). */
export const guestsHold = (l: Met) => l.role === "guest";

/**
 * Whether `l` refuses a change at `p` (GA-LEASE-3). A press passes only a person's hold: a `load_cap`
 * lease, a safety rule's and a run's refuse it, though `load_cap` and a person-started run's are at its
 * own precedence (GA-LEASE-9); its narrowing action goes by that too. Any other narrowing action passes
 * a person's hold, and any other lease by its principal's precedence (GA-LEASE-11). The owner's work
 * passes what `passedBy` names (GA-LEASE-10, GA-LEASE-12); any other change, by its precedence.
 */
export function leaseRefuses(l: Met | undefined, p: Precedence, pass: Passing, o: PassOptions = {}): boolean {
  if (!l) return false;
  if (pass.press) {
    if (personsHold(l)) return false;
    if (o.mutation === "press-over-safety" && l.precedence === "safety_rule") return false;
    if (o.mutation === "press-over-the-cap" && l.holder === "load_cap") return false;
    return true;
  }
  if (pass.narrowing) {
    // It passes a person's hold, replacing none (GA-LEASE-11).
    if (personsHold(l)) return false;
    if (o.mutation === "narrows-over-safety" && l.precedence === "safety_rule") return false;
    if (o.mutation === "narrows-over-a-run" && typeof l.holder === "object" && "run" in l.holder) return false;
    return refusedBy(l, p);
  }
  if (passedBy(l, pass, o)) return false;
  return refusedBy(l, p);
}

/**
 * The first switch by which the owner's work passes `l`, or undefined (GA-LEASE-10, GA-LEASE-12). Only a
 * person's hold is passed, never a `load_cap` lease, a safety rule's or a run's, and only once its floor
 * has passed: by the first of the step's switches, rule, device, home, the home's not for a step undoing a narrowing; else, while the steward declares
 * `owner_work_passes_guest_holds`, a guest's hold by `guest`.
 */
export function passedBy(l: Met, pass: Passing, o: PassOptions = {}): Switch | undefined {
  if (!pass.ownerWork) return undefined;
  const run = typeof l.holder === "object" && "run" in l.holder;
  const counts = personsHold(l) || (o.mutation === "owner-passes-the-cap" && l.holder === "load_cap") || (o.mutation === "owner-passes-a-run" && run)
    || (o.mutation === "owner-passes-safety" && l.precedence === "safety_rule");
  // The floor is a person's hold's (GA-LEASE-7); a lease counted only under its mutation has none to wait out.
  const pastFloor = !personsHold(l) || l.floorPassed === true || o.mutation === "passes-a-hold-in-its-floor";
  if (counts && pastFloor) {
    for (const s of pass.switches ?? []) {
      // The home's switch passes no hold for a step undoing a narrowing (*What no switch passes*, R-9); the mutation lets it.
      if (s === "home" && pass.undoesNarrowing === true && o.mutation !== "home-switch-reopens") continue;
      if (s === "home" && o.mutation === "switch-spares-held-holds" && l.sinceMs !== undefined && o.homeSetMs !== undefined && l.sinceMs < o.homeSetMs) continue;
      return s;
    }
  }
  if ((o.guestsPass || o.mutation === "passes-undeclared") && o.mutation !== "guest-hold-blocks-the-owner"
    && (l.floorPassed === true || o.mutation === "passes-inside-the-floor")
    && (guestsHold(l) || (o.mutation === "passes-a-member-hold" && personsHold(l) && typeof l.holder === "object" && "endpoint" in l.holder))) return "guest";
  return undefined;
}

/** `session.lock` is never refused by a lease and replaces none; nor does it take one (GA-LEASE-1, GA-LEASE-3). */
export const LEASE_EXEMPT = "session.lock";

/** The safety rule holding `l`, or undefined (GA-LEASE-6). */
export function safetyRuleOf(l: Pick<Lease, "holder">): string | undefined {
  const h = l.holder;
  return typeof h === "object" && typeof h.safety_rule === "string" ? h.safety_rule : undefined;
}

/**
 * The lease as `state` and the `lease` event show it. A safety rule's has no time: it `expires`
 * `safety_rule`, when its latch clears or, latchless, the rule completes (the build's word; the
 * standard's `expires` is a time or `run_end`).
 */
export function leaseView(l: Lease): { holder: Holder; precedence: Precedence; expires: string } {
  return { holder: l.holder, precedence: l.precedence,
    expires: l.expiresMs !== null ? new Date(l.expiresMs).toISOString() : safetyRuleOf(l) !== undefined ? "safety_rule" : "run_end" };
}

export interface LeaseOptions {
  clock: Clock;
  store: Store;
  /**
   * Puts a `lease` event (granted, replaced, ended) in the steward's log; `other`, the holder on the
   * other side of it, where one is: the lease replacing the one ended, or the press's hold a restored hold
   * comes back from (a personal press's moment is withheld through either; GA-LEASE-9).
   */
  event: (body: Record<string, unknown>, other?: Holder) => void;
  /**
   * Told when a lease comes off a device, or a provisional lease that refused a change is lifted, with
   * the rules it refused: GA-LEASE-4's re-evaluation hangs here. A provisional lease lifted that
   * refused nothing held nothing off, and is no lease ending.
   */
  ended: (target: string, rules: string[], lease?: Lease) => void;
  /**
   * Told whenever a lease comes off a device, a lease beneath it taking its place or none: a safety
   * rule's that ran out its time ended early (GA-LEASE-6; the code review, CR4).
   */
  cameOff?: (target: string, lease: Lease) => void;
  /** Told when a grant replaced `old` on `target` with `by`: a run whose lease a guest's hold replaced waits for it (GA-LEASE-10, R-62). */
  replaced?: (target: string, old: Lease, by: Lease) => void;
  /** A hold's timer fell due: the caller re-judges it rather than the table ending it. */
  due?: (target: string) => void;
  /** The elapsed clock a hold's instants are kept on in memory; the store keeps wall instants. */
  elapsed?: () => number;
  /** This life's wall and elapsed clocks related by one offset (R-74); none: one made from `clock` and `elapsed`. */
  time?: TimeBase;
  mutation?: Mutation;
}

/** `a` and `b` together, once each, in code-point order. */
const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/**
 * The lease table (the design, *Leases*): each device's lease, in memory and in the store, with one
 * clock timer per lease's end, and the provisional leases an apply lays at dispatch on top of them.
 * Every change is synchronous; each device's row is written behind, coalesced, one write in the
 * writer's line per device at a time, writing its latest (none: the row taken out), so an outage
 * queues at most one write per device.
 */
export class LeaseTable {
  private readonly leases = new Map<string, Lease>();
  /**
   * Each device's other safety rules' leases, beneath the one it holds, oldest first: a safety rule's
   * lease replaced by another rule's still stands, and comes back when that one ends, so one rule's end
   * never ends another's (GA-LEASE-6; the milestone 7+10+11 review, B4). In memory only: at a restart
   * the latches `state` lists grant theirs again.
   */
  private readonly beneath = new Map<string, Lease[]>();
  private readonly timers = new Map<string, number>();
  private readonly provisional = new Map<string, Provisional[]>();
  private readonly saving = new Map<string, boolean>();

  /** This life's one relation of the wall clock to the elapsed clock, which `Holds` shares (R-74). */
  readonly time: TimeBase;

  constructor(private readonly o: LeaseOptions) {
    this.time = o.time ?? new TimeBase(o.clock, o.elapsed);
  }

  /** The lease a device holds, or undefined. */
  of(target: string): Lease | undefined {
    return this.leases.get(target);
  }

  /**
   * What a change on `target` meets: the latest provisional lease laid on it, which sits on top of
   * its lease, inside its floor; else its lease, a hold's role and whether its floor has passed
   * (the design, *Apply and dispatch*; GA-LEASE-10).
   */
  holding(target: string): Met | undefined {
    const p = this.provisional.get(target);
    const top = p?.length ? p[p.length - 1] : undefined;
    const l = this.leases.get(target);
    const floor = l?.hold?.floorMs ?? null;
    // The floor for passing ends at the floor, a success, or the person's own report (GA-LEASE-10, GA-LEASE-12; R-6).
    const own: Met | undefined = l && { holder: l.holder, precedence: l.precedence, ...(l.hold?.role ? { role: l.hold.role } : {}),
      floorPassed: floor === null || this.time.now() >= floor || l.hold?.reported === true, sinceMs: l.sinceMs };
    if (top) return { holder: top.holder, precedence: top.precedence, ...(top.role ? { role: top.role } : {}), floorPassed: top.reported === true,
      ...(own ? { beneath: own } : {}) };
    return own;
  }

  /** Every standing lease, in code-point order of devices. */
  all(): Lease[] {
    return [...this.leases.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  }

  /**
   * Grants `target` a lease: a device with none takes it, one whose lease has equal or lower
   * precedence has it replaced, one held higher keeps its own (GA-LEASE-3). A `lease` event says
   * which: a lease replaced by a person's hold, or a person's hold replaced, ends (`end: replaced`)
   * before the new lease's `granted`; any other lease is `replaced` in one event (R-44). A press's hold keeps the person's hold it replaced (GA-LEASE-9);
   * `restored` marks a hold granted again; `force`, a mutation's, replaces a lease held higher. Returns whether it was granted.
   */
  grant(l: Lease, o: { restored?: true; force?: true } = {}): boolean {
    const now = this.leases.get(l.target);
    if (refusedBy(now, l.precedence) && !o.force) return false;
    // A replaced lease hands the rules it refused to the one replacing it, which re-evaluates them at its end (GA-LEASE-4).
    if (now?.refused?.length && this.o.mutation !== "forgets-a-replaced-lease") l = { ...l, refused: union(l.refused, now.refused) };
    // Two events, the old lease's `ended` then the new one's `granted`, whenever either is a person's hold (R-44).
    const endsHold = now !== undefined && (personsHold(now) || personsHold(l));
    // One level: the hold it replaced keeps none of its own (R-47).
    if (now !== undefined && personsHold(now) && isPress(l.holder)) {
      const { replaced: _r, ...prev } = now;
      l = { ...l, replaced: prev };
    }
    const rule = safetyRuleOf(l);
    if (rule !== undefined) {
      const kept = (this.beneath.get(l.target) ?? []).filter((x) => safetyRuleOf(x) !== rule);
      const other = now !== undefined ? safetyRuleOf(now) : undefined;
      if (other !== undefined && other !== rule) kept.push(now!);
      this.setBeneath(l.target, kept);
    }
    if (endsHold) this.o.event({ target: l.target, change: "ended", ...leaseView(now), ...this.endInfo({ end: "replaced" }) }, l.holder);
    this.set(l);
    const change = now && !endsHold ? "replaced" : "granted";
    this.o.event(this.grantView(l, change, o.restored));
    if (now) this.o.replaced?.(l.target, now, l);
    return true;
  }

  /** A `lease` event granting or replacing with `l`: its direction and, granted, its role and whether it was restored. */
  private grantView(l: Lease, change: "granted" | "replaced", restored?: true): Record<string, unknown> {
    return { target: l.target, change, ...leaseView(l),
      ...(l.hold?.direction && this.o.mutation !== "grants-no-direction" ? { direction: l.hold.direction } : {}),
      ...(change === "granted" && l.hold?.role ? { role: l.hold.role } : {}),
      ...(change === "granted" && restored ? { restored: true } : {}) };
  }

  /**
   * A press's step ended `unreachable` (GA-LEASE-9, R-58): while `target`'s lease is still the hold
   * `apply`'s press took over a person's hold, that hold ends `unreachable`, its rules not re-evaluated,
   * and the hold it replaced is granted again as it was, `restored`, refusing the rules both refused, its
   * timer dropped and its end as `judge` finds it now. The rules the restored hold refuses stay refused,
   * so none is re-evaluated here; if the caller's judgement ends it, its end re-evaluates them all.
   * Returns whether it restored one; otherwise nothing changed.
   */
  restore(target: string, apply: string, judge: (l: Lease) => Pick<Lease, "expiresMs" | "timerAtMs">, at: Pick<EndInfo, "end_time"> = {}): boolean {
    const l = this.leases.get(target);
    if (!l || l.apply !== apply || !l.replaced) return false;
    this.o.cameOff?.(target, l);
    this.o.event({ target, change: "ended", ...leaseView(l), ...this.endInfo({ end: "unreachable", ...at }) });
    const { timerAtMs: _t, replaced: _r, ...was } = l.replaced;
    const refused = union(was.refused, l.refused);
    const back: Lease = { ...was, ...(refused.length ? { refused } : {}) };
    const { expiresMs, timerAtMs } = judge(back);
    back.expiresMs = expiresMs;
    if (timerAtMs !== undefined) back.timerAtMs = timerAtMs;
    this.set(back);
    this.o.event(this.grantView(back, "granted", true), l.holder);
    return true;
  }

  /** Changes `target`'s hold, its end and its timer (none: at `expiresMs`) in place: re-armed and saved, no event (GA-LEASE-7). */
  update(target: string, patch: Pick<Lease, "hold" | "expiresMs"> & { timerAtMs: number | undefined }): void {
    const l = this.leases.get(target);
    if (!l) return;
    // In place, so the armed timer's `x === l` still names it.
    l.hold = patch.hold;
    l.expiresMs = patch.expiresMs;
    if (patch.timerAtMs !== undefined) l.timerAtMs = patch.timerAtMs;
    else delete l.timerAtMs;
    this.arm(l);
    this.save(target);
  }

  /** What an `ended` event says of its end, less what a mutation leaves out. */
  private endInfo(info: EndInfo | undefined): Partial<EndInfo> {
    if (!info) return {};
    const { end, end_time, ...rest } = info;
    return { ...rest, ...(this.o.mutation === "ends-without-a-reason" ? {} : { end }),
      ...(end_time === undefined || this.o.mutation === "gap-end-without-time" ? {} : { end_time }) };
  }

  /**
   * Ends `target`'s lease, if it holds one and `match` says it is that one: a `lease` event, `info`
   * saying what ended a hold, and the re-evaluation hook.
   */
  end(target: string, match: (l: Lease) => boolean = () => true, info?: EndInfo): void {
    this.endLease(target, match, info, false);
  }

  /**
   * Ends `target`'s lease for a change replayed from a gap, which replaces it there (R-48): its
   * `ended` event, `end: replaced` with the change's time, and no re-evaluation; returns the rules it
   * refused, which pass to the replacement (none: it held no lease, or one the change cannot replace).
   */
  replacedInGap(target: string, endTime: string): string[] | undefined {
    if (refusedBy(this.leases.get(target), "person")) return undefined;
    return this.endLease(target, () => true, { end: "replaced", end_time: endTime }, true);
  }

  /** Re-evaluates the rules a lease ended in a gap passed on to a replacement that took no lease (R-48), as at a lease's end. */
  handBack(target: string, rules: string[]): void {
    this.o.ended(target, rules);
  }

  private endLease(target: string, match: (l: Lease) => boolean, info: EndInfo | undefined, handOn: boolean): string[] | undefined {
    const l = this.leases.get(target);
    if (!l || !match(l)) return undefined;
    // Another safety rule's lease beneath it stands: the device holds that one now.
    const now = this.o.clock.now();
    const rest = (this.beneath.get(target) ?? []).filter((x) => x.expiresMs === null || x.expiresMs > now);
    const next = rest.pop();
    this.setBeneath(target, rest);
    this.o.cameOff?.(target, l);
    if (next) {
      this.set({ ...next, ...(l.refused?.length ? { refused: union(next.refused, l.refused) } : {}) });
      this.o.event({ target, change: "replaced", ...leaseView(next) });
      return undefined;
    }
    this.drop(target);
    this.o.event({ target, change: "ended", ...leaseView(l), ...this.endInfo(info) });
    // As `grant` passes them on, so the mutation shows on both paths.
    if (handOn) return this.o.mutation === "forgets-a-replaced-lease" ? [] : l.refused ?? [];
    this.o.ended(target, l.refused ?? [], l);
    return undefined;
  }

  /** Every rule a standing lease refused (GA-LEASE-4): after a restart, a firing a lease refused does not count as fired (GA-RULE-1). */
  refusedRules(): string[] {
    return union([...this.leases.values()].flatMap((l) => l.refused ?? []));
  }

  /**
   * Ends every safety rule's lease `match` names, on every device: one beneath another rule's goes
   * quietly (it is not the device's lease), the device's own as `end` ends it.
   */
  endSafety(match: (l: Lease) => boolean): void {
    for (const [target, ls] of [...this.beneath]) this.setBeneath(target, ls.filter((l) => !match(l)));
    for (const l of this.all()) if (safetyRuleOf(l) !== undefined && match(l)) this.end(l.target, match);
  }

  /** The safety rules holding a lease on `target`, its own and those beneath it. */
  safetyRules(target: string): Lease[] {
    const own = this.leases.get(target);
    return [...(this.beneath.get(target) ?? []), ...(own && safetyRuleOf(own) !== undefined ? [own] : [])];
  }

  /** Every safety rule holding a lease on some device, beneath another's or not. */
  safetyHolders(): Set<string> {
    const all = [...this.leases.values(), ...[...this.beneath.values()].flat()];
    return new Set(all.map(safetyRuleOf).filter((r): r is string => r !== undefined));
  }

  private setBeneath(target: string, ls: Lease[]): void {
    if (ls.length) this.beneath.set(target, ls);
    else this.beneath.delete(target);
  }

  /**
   * A change on `target` was refused by what it meets (`holding`): that lease, or the provisional lease
   * on top of it, keeps `rule`, re-evaluated when it ends or is lifted (GA-LEASE-4).
   */
  refused(target: string, rule?: string): void {
    const p = this.provisional.get(target);
    if (p?.length) {
      const top = p[p.length - 1]!;
      top.refused = true;
      if (rule !== undefined) top.rules = union(top.rules, [rule]);
      return;
    }
    const l = this.leases.get(target);
    if (!l || rule === undefined || l.refused?.includes(rule)) return;
    // In place: the lease's timer ends this very lease.
    l.refused = union(l.refused, [rule]);
    this.save(target);
  }

  /**
   * Takes the rules `target`'s lease refused that `which` names off it, to be re-evaluated while it stands
   * (a guest's hold's floor passing, R-63): those it still refuses come back through `refused`; the rest
   * stay on it. None: no lease, or none refused that `which` names.
   */
  takeRefused(target: string, which: (rule: string) => boolean = () => true): string[] {
    const l = this.leases.get(target);
    const rules = (l?.refused ?? []).filter(which);
    if (!l || !rules.length) return [];
    const rest = l.refused!.filter((x) => !rules.includes(x));
    // In place: the lease's timer ends this very lease.
    if (rest.length) l.refused = rest;
    else delete l.refused;
    this.save(target);
    return rules;
  }

  /**
   * The device `target` reported `key` at `value`: each of its provisional leases, and its lease's hold, whose
   * step's ack is matched on that report (`expect`, matched as the applier matches its ack) has its floor for passing ended,
   * judged before any rule the report triggers; the hold's own floor and its ends are untouched
   * (GA-LEASE-10, GA-LEASE-12; R-6). `refuses-on-the-persons-own-report` marks nothing.
   */
  reported(target: string, key: string, value: unknown): void {
    if (this.o.mutation === "refuses-on-the-persons-own-report") return;
    // Matched as the applier matches the step's ack: within a numeric key's tolerance, a colour whatever its case (GA-EVT-3).
    const is = (e: HoldState["expect"]) => e !== undefined && e.key === key && e.match !== undefined && matcher(e.match)(value);
    for (const p of this.provisional.get(target) ?? []) if (is(p.expect)) p.reported = true;
    const l = this.leases.get(target);
    if (!l?.hold || l.hold.reported || !is(l.hold.expect)) return;
    // In place: the lease's timer ends this very lease.
    l.hold = { ...l.hold, reported: true };
    this.save(target);
  }

  /** Lays a provisional lease for `apply`'s `step` on `target`: no event, nothing written. */
  lay(target: string, p: Provisional): void {
    this.provisional.set(target, [...(this.provisional.get(target) ?? []), p]);
  }

  /**
   * Takes `apply`'s provisional lease for `step` off `target`: `grant` its lease from `sinceMs` to
   * `expiresMs`, with its hold (it was dispatched), or lift it, the device's lease standing untouched. The rules it
   * refused go to what holds the device after it: the lease granted, else the provisional lease or the
   * lease beneath it, which re-evaluates them at its own end; with nothing beneath, the re-evaluation
   * hook is told, and only if it refused a change (GA-LEASE-1, GA-LEASE-4; the code review, CR3, CR9).
   */
  settle(target: string, apply: string, step: string,
    grant: { sinceMs: number; expiresMs: number; timerAtMs?: number; hold?: HoldState } | undefined): void {
    const all = this.provisional.get(target) ?? [];
    const p = all.find((x) => x.apply === apply && x.step === step);
    if (!p) return;
    const rest = all.filter((x) => x !== p);
    if (rest.length) this.provisional.set(target, rest);
    else this.provisional.delete(target);
    if (grant && this.grant({ target, holder: p.holder, precedence: p.precedence, sinceMs: grant.sinceMs, expiresMs: grant.expiresMs,
      ...(grant.timerAtMs !== undefined ? { timerAtMs: grant.timerAtMs } : {}),
      ...(grant.hold ? { hold: p.reported ? { ...grant.hold, reported: true as const } : grant.hold } : {}),
      apply, ...(p.rules?.length ? { refused: p.rules } : {}) })) return;
    if (!p.refused) return;
    const rules = p.rules ?? [];
    const top = rest[rest.length - 1];
    if (top) {
      top.refused = true;
      if (rules.length) top.rules = union(top.rules, rules);
      return;
    }
    const l = this.leases.get(target);
    if (l) {
      if (rules.length) {
        l.refused = union(l.refused, rules);
        this.save(target);
      }
      return;
    }
    this.o.ended(target, rules);
  }

  /**
   * Reads the leases the store keeps; one whose end passed while the steward was down ends now. A
   * hold's lease comes back with its instants on this life's elapsed clock, neither armed nor ended:
   * its caller judges it again (GA-PERSIST-2).
   */
  async load(): Promise<void> {
    const rows = await this.o.store.query<{ target: string; holder: Holder; precedence: Precedence; since_ms: number | string;
      expires_ms: number | string | null; apply: string | null; refused: string[] | null; hold: StoredHold | null }>(
      "SELECT target, holder, precedence, since_ms, expires_ms, apply, refused, hold FROM leases ORDER BY target");
    // The stored wall instants onto this life's elapsed clock, by its one offset (R-74).
    const delta = -this.time.offsetMs();
    for (const r of rows.rows) {
      this.leases.set(r.target, { target: r.target, holder: r.holder, precedence: r.precedence, sinceMs: Number(r.since_ms),
        expiresMs: r.expires_ms === null ? null : Number(r.expires_ms), ...(r.apply ? { apply: r.apply } : {}),
        ...(r.refused?.length ? { refused: r.refused } : {}), ...(r.hold ? holdIn(r.target, r.hold, delta) : {}) });
    }
    // The mutation forgets the moment a hold's room last became quiet: its quiet counts afresh from the restart.
    if (this.o.mutation === "restarts-the-quiet") {
      for (const l of this.leases.values()) if (l.hold && l.hold.quietFromMs !== null) l.hold = { ...l.hold, quietFromMs: this.time.now() };
    }
    const now = this.o.clock.now();
    for (const l of [...this.leases.values()]) {
      if (l.hold) continue;
      if (l.expiresMs !== null && l.expiresMs <= now) this.end(l.target);
      else this.arm(l);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) this.o.clock.clear(t);
    this.timers.clear();
  }

  private set(l: Lease): void {
    this.leases.set(l.target, l);
    this.arm(l);
    this.save(l.target);
  }

  private drop(target: string): void {
    this.leases.delete(target);
    const t = this.timers.get(target);
    if (t !== undefined) this.o.clock.clear(t);
    this.timers.delete(target);
    this.save(target);
  }

  /**
   * Arms `l`'s timer: at its end, or a hold's at its `timerAtMs`, handed to `due` to be judged again
   * rather than ended. A delay past what a host's timer keeps is clamped, and re-armed when it fires early.
   * A hold's unclamped timer is handed to `due` whatever the wall clock reads when it fires: its windows
   * run on elapsed time, and the judgement re-arms it (R-60); any other lease's re-arms on the wall.
   */
  private arm(l: Lease): void {
    const t = this.timers.get(l.target);
    if (t !== undefined) this.o.clock.clear(t);
    this.timers.delete(l.target);
    if (l.expiresMs === null) return;
    const late = l.hold && this.o.mutation === "ends-a-hold-late" ? 30_000 : 0;
    this.schedule(l, (l.timerAtMs ?? l.expiresMs) + late);
  }

  private schedule(l: Lease, atMs: number): void {
    const delay = Math.max(0, atMs - this.o.clock.now());
    const clamped = delay > MAX_DELAY;
    this.timers.set(l.target, this.o.clock.setTimeout(() => {
      this.timers.delete(l.target);
      const judged = l.hold !== undefined && this.o.due !== undefined;
      if ((clamped || !judged) && this.o.clock.now() < atMs) return this.schedule(l, atMs);
      if (judged) {
        if (this.leases.get(l.target) === l) this.o.due!(l.target);
      } else this.end(l.target, (x) => x === l);
    }, Math.min(MAX_DELAY, delay)));
  }

  /** Writes `target`'s row as it stands when the write runs, behind; safe to run twice. */
  private save(target: string): void {
    if (this.saving.has(target)) {
      this.saving.set(target, true);
      return;
    }
    this.saving.set(target, false);
    void this.o.store.write((tx) => writeLease(tx, target, this.leases.get(target), this.time.offsetMs())).then(() => {
      const again = this.saving.get(target);
      this.saving.delete(target);
      if (again) this.save(target);
    });
  }
}

/**
 * A hold as the store keeps it (GA-PERSIST-2): its state with every instant on the wall clock, and the
 * person's hold a press's hold replaced, kept whole the same way (GA-LEASE-9).
 */
type StoredHold = HoldState & { replaced?: StoredLease };
interface StoredLease { holder: Holder; precedence: Precedence; sinceMs: number; expiresMs: number | null; apply?: string; refused?: string[];
  hold?: StoredHold }

/** `l`'s hold as the store keeps it, its instants moved by `deltaMs` (elapsed to wall). */
function holdOut(l: Lease & { hold: HoldState }, deltaMs: number): StoredHold {
  return { ...shiftHold(l.hold, deltaMs), ...(l.replaced ? { replaced: leaseOut(l.replaced, deltaMs) } : {}) };
}

function leaseOut(l: Lease, deltaMs: number): StoredLease {
  return { holder: l.holder, precedence: l.precedence, sinceMs: l.sinceMs, expiresMs: l.expiresMs, ...(l.apply ? { apply: l.apply } : {}),
    ...(l.refused?.length ? { refused: l.refused } : {}), ...(l.hold ? { hold: holdOut(l as Lease & { hold: HoldState }, deltaMs) } : {}) };
}

/** A stored hold read back, its instants moved by `deltaMs` (wall to elapsed). */
function holdIn(target: string, s: StoredHold, deltaMs: number): Pick<Lease, "hold" | "replaced"> {
  const { replaced, ...h } = s;
  return { hold: shiftHold(h, deltaMs), ...(replaced ? { replaced: leaseIn(target, replaced, deltaMs) } : {}) };
}

function leaseIn(target: string, s: StoredLease, deltaMs: number): Lease {
  return { target, holder: s.holder, precedence: s.precedence, sinceMs: s.sinceMs, expiresMs: s.expiresMs, ...(s.apply ? { apply: s.apply } : {}),
    ...(s.refused?.length ? { refused: s.refused } : {}), ...(s.hold ? holdIn(target, s.hold, deltaMs) : {}) };
}

async function writeLease(tx: Tx, target: string, l: Lease | undefined, deltaMs: number): Promise<void> {
  if (!l) {
    await tx.query("DELETE FROM leases WHERE target = $1", [target]);
    return;
  }
  await tx.query("INSERT INTO leases (target, holder, precedence, since_ms, expires_ms, apply, refused, hold) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
    + "ON CONFLICT (target) DO UPDATE SET holder = EXCLUDED.holder, precedence = EXCLUDED.precedence, since_ms = EXCLUDED.since_ms, "
    + "expires_ms = EXCLUDED.expires_ms, apply = EXCLUDED.apply, refused = EXCLUDED.refused, hold = EXCLUDED.hold",
  [target, JSON.stringify(l.holder), l.precedence, Math.floor(l.sinceMs), l.expiresMs === null ? null : Math.floor(l.expiresMs), l.apply ?? null,
    JSON.stringify(l.refused ?? []), l.hold ? JSON.stringify(holdOut(l as Lease & { hold: HoldState }, deltaMs)) : null]);
}
