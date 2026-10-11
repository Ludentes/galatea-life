import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Store } from "../core/store.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";

/** A planned death's grace before its notice: a reload, or the broker's loss (⚠️ a guess, GA-SAFE-10). */
export const GRACE_MS = 60_000;
/** A bridge's second planned death within this is a loop, noticed at once (⚠️ a guess, GA-SAFE-10). */
export const LOOP_MS = 10 * 60_000;

/** What the liveness notices ask of the applier around them. */
export interface LivenessPorts {
  clock: Clock;
  /** Where a said stop is kept, so a restart neither says it again nor misses its return. */
  store: Store;
  mutation?: Mutation;
  liveness(device: string): Liveness | undefined;
  /** The bridge of a device `dead` only because that bridge's death was planned; undefined otherwise. */
  planned(device: string): string | undefined;
  /** A closed device's effective bound and its declared one; undefined for an open one, or one the model does not hold. */
  bound(device: string): { fresh_s: number | null; declared: number | null } | undefined;
  notice(n: Record<string, unknown> & { cause: string; text: string }, key?: string): string | undefined;
  withdraw(key: string): void;
}

/** What a rule's device's bound says to a person: nothing, unknown, or the owner's longer than the declared. */
type BoundSay = "ok" | "unknown" | "longer";

const key = (rule: string, device: string) => `liveness:${rule}:${device}`;

/**
 * GA-SAFE-10's notices, for every device a safety rule reads or actuates: when it stops being `live`,
 * and when it is `live` again after such a notice; when its `fresh_s` is not known, or the owner's is
 * longer than the declared one. A device `dead` only because its bridge went `offline` gracefully, or
 * the applier lost the broker, is noticed only if still not `live` 60 s later, unless it is that
 * bridge's second such death within 10 min. A newer notice for a rule and device replaces an untaken
 * older one. Every method is one step: synchronous, in memory, its writes behind. A said stop is
 * kept across a restart (`safety_said`), and a start is read as the broker's loss: each rule's device
 * not `live` 60 s after it, whose stop was not already said, is noticed then (the maintainer's ruling 4).
 */
export class LivenessNotices {
  /** The rule and device pairs whose stop was noticed: only these get a `live again` notice. */
  private readonly stopped = new Set<string>();
  /** The grace timers of devices dead by a planned death. */
  private readonly graced = new Map<string, number>();
  /** Each bridge's planned deaths within the loop window, on the applier's clock. */
  private readonly deaths = new Map<string, number[]>();
  /** What each rule and device pair's bound last said: a notice when it starts to say something. */
  private readonly says = new Map<string, BoundSay>();

  constructor(private readonly o: LivenessPorts) {}

  /** A bridge alive until now was found dead: a planned death counts towards a loop. */
  bridgeDead(bridge: string, planned: boolean): void {
    if (!planned) return;
    const now = this.o.clock.now();
    this.deaths.set(bridge, [...(this.deaths.get(bridge) ?? []).filter((t) => now - t < LOOP_MS), now]);
  }

  /** A device's liveness changed: each rule reading or actuating it, in `rules`, is told as GA-SAFE-10 says. */
  changed(rules: string[], device: string, old: Liveness, next: Liveness): void {
    if (next === "live") {
      const t = this.graced.get(device);
      if (t !== undefined) this.o.clock.clear(t);
      this.graced.delete(device);
      for (const rule of rules) {
        const k = key(rule, device);
        if (!this.stopped.delete(k)) continue;
        void this.o.store.write((tx) => tx.query("DELETE FROM safety_said WHERE key = $1", [k]).then(() => undefined));
        this.say(rule, device, `${device} is live again.`);
      }
      return;
    }
    if (old !== "live") return;
    const bridge = this.o.mutation === "floods-reload-notices" ? undefined : this.o.planned(device);
    if (bridge !== undefined && (this.deaths.get(bridge)?.length ?? 0) < 2) {
      if (this.graced.has(device)) return;
      this.graced.set(device, this.o.clock.setTimeout(() => {
        this.graced.delete(device);
        // `silent-on-liveness`: a device still dead after its grace is never noticed.
        if (this.o.mutation === "silent-on-liveness" || this.o.liveness(device) === "live") return;
        for (const rule of this.rules(device)) this.sayStopped(rule, device, `${device} has not been live for ${GRACE_MS / 1000} s, since its bridge went offline.`);
      }, GRACE_MS));
      return;
    }
    const why = bridge !== undefined ? `; its bridge ${bridge} went offline again within ${LOOP_MS / 60_000} min` : "";
    for (const rule of rules) this.sayStopped(rule, device, `${device} is ${next}${why}.`);
  }

  /** The stops said before a restart: said once, their return said after it (GA-SAFE-10). */
  async load(): Promise<void> {
    // `forgets-a-said-stop`: the stops said before the restart are not read back.
    if (this.o.mutation === "forgets-a-said-stop") return;
    for (const r of (await this.o.store.query<{ key: string }>("SELECT key FROM safety_said")).rows) this.stopped.add(r.key);
  }

  /**
   * Every module has loaded: a start reads as the broker's loss (the maintainer's ruling 4). Each rule's device
   * not `live` now is graced 60 s; still not `live` then, its stop is said for each rule whose stop of it
   * was not said already. One heard within the grace is no news: it was not said to stop.
   */
  resume(pairs: { rule: string; device: string }[]): void {
    for (const device of new Set(pairs.map((p) => p.device))) {
      if (this.o.liveness(device) === "live" || this.graced.has(device)) continue;
      this.graced.set(device, this.o.clock.setTimeout(() => {
        this.graced.delete(device);
        if (this.o.mutation === "silent-on-liveness" || this.o.liveness(device) === "live") return;
        for (const rule of this.rules(device)) {
          if (this.stopped.has(key(rule, device))) continue;
          this.sayStopped(rule, device, `${device} has not been live for ${GRACE_MS / 1000} s, since the applier started.`);
        }
      }, GRACE_MS));
    }
  }

  /** The rules reading or actuating a device, as the grace timer finds them when it ends. */
  rules: (device: string) => string[] = () => [];

  /**
   * Each rule and device pair's bound judged again: a notice when its `fresh_s` is not known, since it
   * can never be `live` until the owner sets one, or when the owner's is longer than the declared one.
   * `silent` seeds what each says without a notice (a load).
   */
  bounds(pairs: { rule: string; device: string }[], silent = false): void {
    const seen = new Set<string>();
    for (const { rule, device } of pairs) {
      const k = key(rule, device);
      seen.add(k);
      const b = this.o.bound(device);
      if (!b) continue;
      const now: BoundSay = b.fresh_s === null ? "unknown"
        : b.declared !== null && b.fresh_s > b.declared ? "longer" : "ok";
      const was = this.says.get(k);
      this.says.set(k, now);
      if (silent || now === "ok" || now === was) continue;
      this.say(rule, device, now === "unknown"
        ? `${device} has no known fresh_s: it can never be live until the owner sets one.`
        : `${device}'s fresh_s, ${b.fresh_s} s, is longer than the ${b.declared} s its bridge declares: a dead device reads live for longer.`);
    }
    for (const k of [...this.says.keys()]) if (!seen.has(k)) this.says.delete(k);
  }

  /** The applier stops (an embedding host's stop): every grace's timer is cleared. */
  stop(): void {
    for (const t of this.graced.values()) this.o.clock.clear(t);
    this.graced.clear();
  }

  private sayStopped(rule: string, device: string, text: string): void {
    const k = key(rule, device);
    this.stopped.add(k);
    void this.o.store.write((tx) => tx.query("INSERT INTO safety_said (key) VALUES ($1) ON CONFLICT DO NOTHING", [k]).then(() => undefined));
    this.say(rule, device, text);
  }

  private say(rule: string, device: string, text: string): void {
    this.o.withdraw(key(rule, device));
    this.o.notice({ cause: "liveness", rule_id: rule, devices: [device], text: `Safety rule ${rule}: ${text}` }, key(rule, device));
  }
}
