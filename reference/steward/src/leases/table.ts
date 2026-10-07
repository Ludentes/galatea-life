import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Tx } from "../core/db.js";
import type { Store } from "../core/store.js";

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
}

/**
 * A lease laid at dispatch over a device's lease until the applier answers (the design, *Apply and
 * dispatch*); `refused` once a change it outranked was refused by it, so lifting it re-evaluates.
 */
interface Provisional { apply: string; step: string; holder: Holder; precedence: Precedence; refused?: true }

/** Whether a change at `p` meets `lease` as lower precedence, so it is refused (GA-LEASE-3); equal or higher replaces. */
export function refusedBy(lease: Pick<Lease, "precedence"> | undefined, p: Precedence): boolean {
  return lease !== undefined && RANK[lease.precedence] > RANK[p];
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
  /** Puts a `lease` event (granted, replaced, ended) in the steward's log. */
  event: (body: Record<string, unknown>) => void;
  /**
   * Told when a lease comes off a device, or a provisional lease that refused a change is lifted:
   * GA-LEASE-4's re-evaluation hangs here (slice 3b). A provisional lease lifted that refused nothing
   * held nothing off, and is no lease ending.
   */
  ended: (target: string) => void;
}

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

  constructor(private readonly o: LeaseOptions) {}

  /** The lease a device holds, or undefined. */
  of(target: string): Lease | undefined {
    return this.leases.get(target);
  }

  /**
   * What a change on `target` meets: the latest provisional lease laid on it, which sits on top of
   * its lease, else its lease (the design, *Apply and dispatch*).
   */
  holding(target: string): Pick<Lease, "holder" | "precedence"> | undefined {
    const p = this.provisional.get(target);
    return p?.length ? p[p.length - 1] : this.leases.get(target);
  }

  /** Every standing lease, in code-point order of devices. */
  all(): Lease[] {
    return [...this.leases.values()].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  }

  /**
   * Grants `target` a lease: a device with none takes it, one whose lease has equal or lower
   * precedence has it replaced, one held higher keeps its own (GA-LEASE-3). A `lease` event says
   * which; returns whether it was granted.
   */
  grant(l: Lease): boolean {
    const now = this.leases.get(l.target);
    if (refusedBy(now, l.precedence)) return false;
    const rule = safetyRuleOf(l);
    if (rule !== undefined) {
      const kept = (this.beneath.get(l.target) ?? []).filter((x) => safetyRuleOf(x) !== rule);
      const other = now !== undefined ? safetyRuleOf(now) : undefined;
      if (other !== undefined && other !== rule) kept.push(now!);
      this.setBeneath(l.target, kept);
    }
    this.set(l);
    this.o.event({ target: l.target, change: now ? "replaced" : "granted", ...leaseView(l) });
    return true;
  }

  /** Ends `target`'s lease, if it holds one and `match` says it is that one: a `lease` event, and the re-evaluation hook. */
  end(target: string, match: (l: Lease) => boolean = () => true): void {
    const l = this.leases.get(target);
    if (!l || !match(l)) return;
    // Another safety rule's lease beneath it stands: the device holds that one now.
    const now = this.o.clock.now();
    const rest = (this.beneath.get(target) ?? []).filter((x) => x.expiresMs === null || x.expiresMs > now);
    const next = rest.pop();
    this.setBeneath(target, rest);
    if (next) {
      this.set(next);
      this.o.event({ target, change: "replaced", ...leaseView(next) });
      return;
    }
    this.drop(target);
    this.o.event({ target, change: "ended", ...leaseView(l) });
    this.o.ended(target);
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
   * A change on `target` was refused by what it meets (`holding`): if that is a provisional lease, its
   * lifting will re-evaluate what it held off (GA-LEASE-4).
   */
  refused(target: string): void {
    const p = this.provisional.get(target);
    if (p?.length) p[p.length - 1]!.refused = true;
  }

  /** Lays a provisional lease for `apply`'s `step` on `target`: no event, nothing written. */
  lay(target: string, p: Provisional): void {
    this.provisional.set(target, [...(this.provisional.get(target) ?? []), p]);
  }

  /**
   * Takes `apply`'s provisional lease for `step` off `target`: `grant` its lease from `sinceMs` for
   * `holdMs` (it was dispatched), or lift it, the device's lease standing untouched and the
   * re-evaluation hook told only if it refused a change (GA-LEASE-1, GA-LEASE-4).
   */
  settle(target: string, apply: string, step: string, grant: { sinceMs: number; holdMs: number } | undefined): void {
    const all = this.provisional.get(target) ?? [];
    const p = all.find((x) => x.apply === apply && x.step === step);
    if (!p) return;
    const rest = all.filter((x) => x !== p);
    if (rest.length) this.provisional.set(target, rest);
    else this.provisional.delete(target);
    if (grant) this.grant({ target, holder: p.holder, precedence: p.precedence, sinceMs: grant.sinceMs, expiresMs: grant.sinceMs + grant.holdMs, apply });
    else if (p.refused) this.o.ended(target);
  }

  /** Reads the leases the store keeps; one whose end passed while the steward was down ends now. */
  async load(): Promise<void> {
    const rows = await this.o.store.query<{ target: string; holder: Holder; precedence: Precedence; since_ms: number | string;
      expires_ms: number | string | null; apply: string | null }>("SELECT target, holder, precedence, since_ms, expires_ms, apply FROM leases ORDER BY target");
    for (const r of rows.rows) {
      this.leases.set(r.target, { target: r.target, holder: r.holder, precedence: r.precedence, sinceMs: Number(r.since_ms),
        expiresMs: r.expires_ms === null ? null : Number(r.expires_ms), ...(r.apply ? { apply: r.apply } : {}) });
    }
    const now = this.o.clock.now();
    for (const l of [...this.leases.values()]) {
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

  private arm(l: Lease): void {
    const t = this.timers.get(l.target);
    if (t !== undefined) this.o.clock.clear(t);
    this.timers.delete(l.target);
    if (l.expiresMs === null) return;
    this.timers.set(l.target, this.o.clock.setTimeout(() => {
      this.timers.delete(l.target);
      this.end(l.target, (x) => x === l);
    }, Math.max(0, l.expiresMs - this.o.clock.now())));
  }

  /** Writes `target`'s row as it stands when the write runs, behind; safe to run twice. */
  private save(target: string): void {
    if (this.saving.has(target)) {
      this.saving.set(target, true);
      return;
    }
    this.saving.set(target, false);
    void this.o.store.write((tx) => writeLease(tx, target, this.leases.get(target))).then(() => {
      const again = this.saving.get(target);
      this.saving.delete(target);
      if (again) this.save(target);
    });
  }
}

async function writeLease(tx: Tx, target: string, l: Lease | undefined): Promise<void> {
  if (!l) {
    await tx.query("DELETE FROM leases WHERE target = $1", [target]);
    return;
  }
  await tx.query("INSERT INTO leases (target, holder, precedence, since_ms, expires_ms, apply) VALUES ($1, $2, $3, $4, $5, $6) "
    + "ON CONFLICT (target) DO UPDATE SET holder = EXCLUDED.holder, precedence = EXCLUDED.precedence, since_ms = EXCLUDED.since_ms, "
    + "expires_ms = EXCLUDED.expires_ms, apply = EXCLUDED.apply",
  [target, JSON.stringify(l.holder), l.precedence, Math.floor(l.sinceMs), l.expiresMs === null ? null : Math.floor(l.expiresMs), l.apply ?? null]);
}
