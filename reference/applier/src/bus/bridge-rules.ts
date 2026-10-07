import type { BridgeEvent, Status } from "./wire.js";

/** A bridge is dead this long after its last `status` arrived (GA-STATE-2). */
export const DEAD_AFTER_MS = 30_000;
/** GA-BUS-2's tolerance, which GA-BUS-8's revival reuses (⚠️ a guess, in the standard). */
export const SKEW_MS = 5_000;
/** How many of a bridge's process instances the duplicate and gap checks remember. */
const INSTANCES_KEPT = 8;

/** What a message did to a bridge: the faults to report, whether its liveness changed, whether to ask for a snapshot. */
export type Outcome = { faults: string[]; changed: boolean; snapshot: boolean; take: boolean };
const none = (): Outcome => ({ faults: [], changed: false, snapshot: false, take: false });

export type RuleSwitches = {
  /** `trusts-retained-online`: a retained status delivered on subscribing revives. */
  trustsRetained?: boolean;
  /** `plans-for-a-faulted-bridge`: a status without v, or with another v or bridgeId, is taken. */
  takesBadStatus?: boolean;
  /** `ignores-seq-gap`: a gap in an event's seq asks for nothing. */
  ignoresGaps?: boolean;
  /** `trusts-a-fast-clock`: a publishedAt far from its arrival is no fault. */
  trustsFastClock?: boolean;
  /** The finder's (slice 5b): no identity is checked, a finder's `finderId` being nobody's below Box. */
  anyIdentity?: boolean;
};

/**
 * One bridge's liveness, by the applier's side of the binding (applier, *Bridges*; bridge,
 * *Liveness*, *The will*, *Gaps*): a function of the messages that arrived and the applier's clock,
 * and nothing else, so each rule is tested on its own. A bridge is dead until a status arrives live,
 * at its first registration as after a reconnection, and a death ends only on a live status
 * published no earlier than the death less 5 s (GA-BUS-8).
 */
export class BridgeRules {
  alive = false;
  /** Whether its latest death was planned: a graceful `offline`, or the applier's loss of its broker (GA-SAFE-10's grace). */
  planned = false;
  /** When it was last found dead, on the applier's clock; for a bridge never live, when listening began. */
  diedAt: number;
  lastStatusAt?: number;
  /** The `instanceId` of the latest status, live or retained: a will naming another is ignored. */
  instanceId?: string;
  private faulted = false;
  /** A skew fault stands from the status that raised it to the next one within tolerance (the finder's `clock` reads it). */
  skewed = false;
  /** Likewise for a `publishedAt` that is not a time. */
  private badTime = false;
  /** Each instance seen, with the last event seq taken from it (0 before its first event). */
  private readonly instances = new Map<string, number>();

  constructor(private readonly identity: string, now: number, private readonly switches: RuleSwitches = {}) {
    this.diedAt = now;
  }

  /** Listening began (every SUBACK in): until a live status, the bridge is dead, with no fault (lesson 15). */
  listening(now: number): Outcome {
    // The switch's revival on a retained status may land before this SUBACK; it is not undone here, so
    // the mutation shows whatever the broker's order.
    if (this.switches.trustsRetained && this.alive) return none();
    return this.die(now);
  }

  /** The applier lost the broker: every bridge is dead, and each needs a live status to come back (GA-BUS-7, 8). */
  lost(now: number): Outcome {
    return this.die(now, true);
  }

  status(s: Status, retained: boolean, now: number): Outcome {
    const bad = s.v === undefined ? "a status without v"
      : s.v !== 1 ? `a status with v ${JSON.stringify(s.v)}`
      : !s.instance_id ? "a status without an instanceId"
      : s.bridge_id !== this.identity && !this.switches.anyIdentity ? `a status naming bridge ${JSON.stringify(s.bridge_id)}`
      : undefined;
    if (bad && !this.switches.takesBadStatus) {
      const o = this.die(now);
      if (!this.faulted) o.faults.push(bad);
      this.faulted = true;
      return o;
    }
    if (retained && !this.switches.trustsRetained) {
      // A retained status says who the latest instance is, and its facts, but never that it lives now.
      this.instanceId = s.instance_id;
      return { ...none(), take: true };
    }
    if (s.published_at === undefined) {
      const first = !this.badTime;
      this.badTime = true;
      return { ...none(), faults: first ? ["a status whose publishedAt is not a time"] : [] };
    }
    this.badTime = false;
    // GA-BUS-2: a skewed publishedAt is a fault whether or not the status revives; raised once while it stands.
    const faults: string[] = [];
    const skew = s.published_at - now;
    if (Math.abs(skew) > SKEW_MS && !this.switches.trustsFastClock) {
      if (!this.skewed) faults.push(`a status published ${Math.round(skew / 1000)} s from its arrival`);
      this.skewed = true;
    } else this.skewed = false;
    if (!this.alive && s.published_at < this.diedAt - SKEW_MS) return { ...none(), faults };
    const o = none();
    o.faults = faults;
    o.take = true;
    if (s.instance_id && !this.instances.has(s.instance_id)) {
      this.remember(s.instance_id, 0);
      o.snapshot = true;
    }
    if (s.instance_id) this.instanceId = s.instance_id;
    this.faulted = false;
    if (s.graceful) {
      const d = this.die(now, true);
      return { ...o, changed: d.changed };
    }
    this.lastStatusAt = now;
    o.changed = !this.alive;
    this.alive = true;
    return o;
  }

  /** A will on `lwt`; `undefined` is the empty retained payload, a will cleared, never a death. */
  will(instanceId: string | undefined, now: number): Outcome {
    if (instanceId === undefined || instanceId !== this.instanceId || !this.alive) return none();
    return this.die(now); // a will is never a bridge_fault (the bridge standard, *The will*)
  }

  /** The periodic check: 30 s without a status is a death, of a silent bridge, with no fault. */
  tick(now: number): Outcome {
    if (this.alive && this.lastStatusAt !== undefined && now - this.lastStatusAt > DEAD_AFTER_MS) return this.die(now);
    return none();
  }

  /**
   * An event: `take` false for a duplicate (an `(instanceId, seq)` already seen); a snapshot for an
   * instance not seen before or a gap in its `seq` (GA-BUS-6).
   */
  event(e: BridgeEvent): Outcome {
    const last = this.instances.get(e.instance_id);
    if (last === undefined) {
      this.remember(e.instance_id, e.seq);
      return { ...none(), take: true, snapshot: true };
    }
    if (e.seq <= last) return none();
    this.remember(e.instance_id, e.seq);
    return { ...none(), take: true, snapshot: e.seq > last + 1 && !this.switches.ignoresGaps };
  }

  private remember(instance: string, seq: number): void {
    this.instances.delete(instance);
    this.instances.set(instance, seq);
    while (this.instances.size > INSTANCES_KEPT) this.instances.delete(this.instances.keys().next().value!);
  }

  private die(now: number, planned = false): Outcome {
    const changed = this.alive;
    if (changed) this.planned = planned;
    this.alive = false;
    this.diedAt = Math.max(this.diedAt, now);
    this.lastStatusAt = undefined;
    return { ...none(), changed };
  }
}
