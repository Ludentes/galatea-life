import { isExtension } from "../bus/wire.js";
import type { Store } from "../core/store.js";
import { sets, sideEffects } from "../gate/actions.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";
import { actuated, evaluate, terms, type SafetyRule } from "./language.js";

/** A key a rule's action set on a device it actuated, with the value it set: what its latch keeps (GA-SAFE-7). */
type Kept = { device: string; key: string; value?: unknown };

/** A latch held: from its rule's firing until its condition is true on reported values, every device it reads `live`. */
export type Latch = { rule_id: string; set_ms: number; devices: string[]; keys: Kept[] };

/** What the latches ask of the applier around them. */
export interface LatchPorts {
  store: Store;
  now(): number;
  mutation?: Mutation;
  /** A device's latest reported value of `key`; never an assumed one (GA-SAFE-7). */
  reported(device: string, key: string): unknown;
  /** An open device's assumed value of `key`: read only under `clears-a-latch-on-an-assumed-value`. */
  assumed(device: string, key: string): unknown;
  liveness(device: string): Liveness | undefined;
  /** Serves an event (and hands it to the writer). */
  emit(type: string, body: Record<string, unknown>): void;
}

/**
 * The safety rules' latches (applier, *Safety rules*, *Latches*). A rule with a latch holds it from
 * firing until its condition is true on reported values, never an assumed one, and every device the
 * condition reads is `live` (GA-SAFE-7); while it is held, a request's action changing a key the rule
 * set on a device it actuated, or any extension action on such a device, is `refuse(latched)`; once it
 * clears, such an action's tier is `no_voice`, its token's `for` naming a person, until one of them
 * next runs. Each is a `latch` event, and `state` lists the held ones (GA-SAFE-9). Every method is one
 * step: synchronous, in memory, its writes behind.
 */
export class Latches {
  private readonly held = new Map<string, Latch>();
  /** After a latch cleared, the keys whose undo is `no_voice` on each device, until such an action next runs (GA-SAFE-7). */
  private readonly raised = new Map<string, Kept[]>();

  constructor(private readonly o: LatchPorts) {}

  /** Loads what a restart keeps: the latches held and the undos still raised (GA-PERSIST-1). */
  async load(): Promise<void> {
    // `forgets-a-latch`: the latches held before the restart are not read back.
    if (this.o.mutation === "forgets-a-latch") return;
    const held = await this.o.store.query<{ rule_id: string; set_ms: number | string; devices: string[]; keys: Kept[] }>(
      "SELECT rule_id, set_ms, devices, keys FROM safety_latches");
    for (const r of held.rows) this.held.set(r.rule_id, { rule_id: r.rule_id, set_ms: Number(r.set_ms), devices: r.devices, keys: r.keys });
    const raised = await this.o.store.query<{ device: string; keys: Kept[] }>("SELECT device, keys FROM safety_raised");
    for (const r of raised.rows) this.raised.set(r.device, r.keys);
  }

  /** Whether `ruleId`'s latch is held: then the rule does not fire again (GA-SAFE-11). */
  holds(ruleId: string): boolean {
    return this.held.has(ruleId);
  }

  /** The latches held, as `state` lists them (GA-SAFE-9). */
  list(): { rule_id: string; devices: string[]; since: string }[] {
    return [...this.held.values()].map((l) => ({ rule_id: l.rule_id, devices: [...l.devices], since: new Date(l.set_ms).toISOString() }));
  }

  /** A rule with a latch fired: its latch is held from now, over the keys its actions set (GA-SAFE-7, GA-SAFE-9). */
  set(rule: SafetyRule): void {
    if (!rule.latch || this.held.has(rule.id)) return;
    const keys = rule.actions.flatMap((a): Kept[] => {
      const s = sets(a.action, a.args ?? {});
      return s ? [{ device: a.target, key: s.key, ...(s.value !== undefined ? { value: s.value } : {}) }] : [];
    });
    const l: Latch = { rule_id: rule.id, set_ms: Math.floor(this.o.now()), devices: actuated(rule), keys };
    this.held.set(rule.id, l);
    this.o.emit("latch", { rule_id: rule.id, latch: "set", devices: [...l.devices] });
    void this.o.store.write((tx) => tx.query("INSERT INTO safety_latches (rule_id, set_ms, devices, keys) VALUES ($1, $2, $3, $4) "
      + "ON CONFLICT (rule_id) DO NOTHING", [l.rule_id, l.set_ms, JSON.stringify(l.devices), JSON.stringify(l.keys)]).then(() => undefined));
  }

  /**
   * Each held latch whose condition reads `device` (or every one) judged again: it clears once the rule's
   * condition is true on reported values and every device the condition reads is `live` (GA-SAFE-7). A
   * rule gone, or no longer declaring a latch, clears it as the owner's word. Returns the rules cleared.
   */
  check(rules: ReadonlyMap<string, SafetyRule>, device?: string): string[] {
    const cleared: string[] = [];
    for (const l of [...this.held.values()]) {
      const rule = rules.get(l.rule_id);
      if (!rule?.latch) {
        this.clear(l, "cleared_by_owner");
        cleared.push(l.rule_id);
        continue;
      }
      const read = terms(rule.latch.condition);
      if (device !== undefined && !read.some((t) => t.device === device)) continue;
      if (!read.every((t) => this.o.liveness(t.device) === "live")) continue;
      if (!evaluate(rule.latch.condition, this.read)) continue;
      this.clear(l, "cleared");
      cleared.push(l.rule_id);
    }
    return cleared;
  }

  /** The owner's `clear_latch`, for a sensor that will never report again (GA-SAFE-9's `cleared_by_owner`). */
  clearByOwner(ruleId: string): void {
    const l = this.held.get(ruleId);
    if (l) this.clear(l, "cleared_by_owner");
  }

  /** What a latch's condition reads: the reported value; an assumed one only under `clears-a-latch-on-an-assumed-value`. */
  private readonly read = (device: string, key: string): unknown => {
    const v = this.o.reported(device, key);
    return v === undefined && this.o.mutation === "clears-a-latch-on-an-assumed-value" ? this.o.assumed(device, key) : v;
  };

  /** A latch clears: its undos are `no_voice`, with a person's token, until one next runs (GA-SAFE-7). */
  private clear(l: Latch, how: "cleared" | "cleared_by_owner"): void {
    this.held.delete(l.rule_id);
    const rows: { device: string; keys: Kept[] }[] = [];
    for (const device of l.devices) {
      const keys = [...this.raised.get(device) ?? [], ...l.keys.filter((k) => k.device === device)];
      this.raised.set(device, keys);
      rows.push({ device, keys });
    }
    this.o.emit("latch", { rule_id: l.rule_id, latch: how, devices: [...l.devices] });
    void this.o.store.write(async (tx) => {
      await tx.query("DELETE FROM safety_latches WHERE rule_id = $1", [l.rule_id]);
      for (const r of rows) {
        await tx.query("INSERT INTO safety_raised (device, keys) VALUES ($1, $2) ON CONFLICT (device) DO UPDATE SET keys = EXCLUDED.keys",
          [r.device, JSON.stringify(r.keys)]);
      }
    });
  }

  /**
   * Whether a request's action on `device` undoes a held latch: it changes a key the rule set there to
   * another value, or it is an extension action, whose effect the applier cannot know (a valve's own
   * countdown); `latch-misses-an-extension` lets an extension action through (GA-SAFE-7).
   */
  latched(device: string, action: string, args: Record<string, unknown>): boolean {
    for (const l of this.held.values()) if (l.devices.includes(device) && this.undoes(l.keys, device, action, args)) return true;
    return false;
  }

  /** Whether the action would undo a latch that cleared, its undo not yet run: its tier is `no_voice` (GA-SAFE-7). */
  raises(device: string, action: string, args: Record<string, unknown>): boolean {
    const keys = this.raised.get(device);
    return keys !== undefined && this.undoes(keys, device, action, args);
  }

  /**
   * A request's action on `device` ran (dispatched): the kept keys it undid are the household's again, each
   * other raised undo on the device still `no_voice` until its own runs. An extension action, whose effect the
   * applier cannot know, returns none (GA-SAFE-7).
   */
  ran(device: string, action: string, args: Record<string, unknown>): void {
    const keys = this.raised.get(device);
    if (!keys || !this.undoes(keys, device, action, args)) return;
    const undone = isExtension(action) ? [] : this.undone(keys, device, action, args);
    if (!undone.length) return;
    const left = keys.filter((k) => !undone.includes(k));
    if (left.length) this.raised.set(device, left);
    else this.raised.delete(device);
    void this.o.store.write((tx) => (left.length
      ? tx.query("INSERT INTO safety_raised (device, keys) VALUES ($1, $2) ON CONFLICT (device) DO UPDATE SET keys = EXCLUDED.keys",
        [device, JSON.stringify(left)])
      : tx.query("DELETE FROM safety_raised WHERE device = $1", [device])).then(() => undefined));
  }

  private undoes(keys: Kept[], device: string, action: string, args: Record<string, unknown>): boolean {
    if (isExtension(action)) return this.o.mutation !== "latch-misses-an-extension";
    return this.undone(keys, device, action, args).length > 0;
  }

  /**
   * The kept keys on `device` an action changes to another value: the key it sets, and its side effects
   * (`level.set_level` and `color.set_color` turn a light `on`), which change a state key as surely.
   */
  private undone(keys: Kept[], device: string, action: string, args: Record<string, unknown>): Kept[] {
    const s = sets(action, args);
    const changes = [...(s ? [{ key: s.key, matches: s.matches }] : []),
      ...sideEffects(action).map((x) => ({ key: x.key, matches: (v: unknown) => v === x.value }))];
    return keys.filter((k) => k.device === device && changes.some((c) => c.key === k.key && (!("value" in k) || !c.matches(k.value))));
  }
}
