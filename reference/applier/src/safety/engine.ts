import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Store } from "../core/store.js";
import type { Tx } from "../core/db.js";
import type { HeldApply, Outcome } from "../dispatch/records.js";
import { MAY_HAVE_ACTED } from "../dispatch/rules.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";
import { actuated, devicesOf, evaluate, evaluate3, terms, type RuleAction, type SafetyRule } from "./language.js";
import { Latches } from "./latches.js";
import { LivenessNotices } from "./liveness-notices.js";

/** What the rules ask of the applier around them. */
export interface SafetyPorts {
  store: Store;
  mutation?: Mutation;
  /** The applier's clock: its time, and the re-sends' timers. */
  clock: Clock;
  /** A device's liveness as the applier judges it now; undefined when the model does not hold it. */
  liveness(device: string): Liveness | undefined;
  /** The bridge of a device `dead` only because that bridge's death was planned (GA-SAFE-10's grace). */
  planned(device: string): string | undefined;
  /** A device's effective bound and its declared one (GA-SAFE-10). */
  bound(device: string): { fresh_s: number | null; declared: number | null } | undefined;
  /** A device's latest reported value of `key`; never an assumed one (GA-SAFE-11). */
  reported(device: string, key: string): unknown;
  /** The `basis_time` of that latest reported value: the applier has seen the report, whether or not a rule read it then. */
  basis(device: string, key: string): number | undefined;
  /** An open device's assumed value of `key`: read only under `fires-on-an-assumed-value`. */
  assumed(device: string, key: string): unknown;
  /**
   * Dispatches a rule's actions through the dispatcher, under no client (GA-SAFE-2): its run, held from
   * now, named by the report that made its trigger true (the maintainer's ruling 2).
   */
  actuate(ruleId: string, actions: RuleAction[], cause: { device: string; basis: number }): HeldApply;
  /** Sends a run's action `index` again, as attempt `attempt`, through the dispatcher (GA-SAFE-12): its slot in the run now this attempt's. */
  resend(applyId: string, index: number, action: RuleAction, attempt: number): void;
  /** What a re-send reads of an action on a device: whether it is idempotent, and its bound; undefined when it is gone. */
  action(device: string, action: string): { idempotent: boolean; ack_within_s: number } | undefined;
  /**
   * Whether the device's latest report, its `basis_time` no earlier than `since`, matches what the
   * action sets: it landed (GA-SAFE-12). A report from before the rule fired says nothing of its run.
   */
  landed(device: string, action: string, args: Record<string, unknown>, since: number): boolean;
  /** The run held under `applyId`, as it is now. */
  run(applyId: string): HeldApply | undefined;
  /**
   * A start found attempt `attempt` of a run's action `index` kept, above its last recorded outcome:
   * that attempt's step is the slot's again, waiting on its row where one was kept, and else ended
   * `failed(no_ack)`, since it may have been published (the maintainer's ruling 1; the 7b preflight's I2).
   */
  takeUp(applyId: string, index: number, attempt: number): void;
  /** Raises a notice, with a `key` once while it stands; returns its id. */
  notice(n: Record<string, unknown> & { cause: string; text: string }, key?: string): string | undefined;
  /** A later notice replaces those raised with `key`: the untaken ones go. */
  withdraw(key: string): void;
  /** Serves an event (and hands it to the writer). */
  emit(type: string, body: Record<string, unknown>): void;
}

/**
 * One actuation of a running rule, by its place in the rule's actions: its attempt in flight, or one
 * waiting to be sent again (GA-SAFE-12), or done; when its last attempt began, and why it is not sent
 * again where a person should know.
 */
type Act = { action: RuleAction; attempt: number; began: number; state: "flight" | "wait" | "done"; timer?: number;
  /** An `unanswered` attempt was sent once more: the next is not. */
  again?: boolean;
  /** A `late_ack` or a matching report said a `failed` attempt landed after all. */
  late?: boolean;
  /**
   * It may have run while its action's declaration was not yet known in this life (a start, before its
   * bridge describes the device): whether it is sent again is judged once the declaration is known.
   */
  unsure?: boolean;
  why?: string };
/** A rule as it runs: the run holding its actuations, from firing until complete; its apply id once the dispatcher gave it. */
type Running = { rule_id: string; apply_id?: string; devices: Set<string>; acts: Act[];
  /** When it fired, on the applier's clock: a report older than this never says an actuation landed. */
  fired: number;
  /** What the standing waiting notice says waits: a new one only when that changes (GA-SAFE-8). */
  waitSaid?: string };

/** What an attempt's final outcome leaves to do (applier, *Safety rules*, GA-SAFE-12's classes). */
type Ending = "landed" | "final" | "nothing_ran" | "may_have_run" | "unanswered";

/** An actuation as `safety_state.acts` keeps it, by its place in the rule's actions: what a resumed run numbers its attempts on. */
type KeptAct = { attempt: number; state: Act["state"]; again?: true; late?: true; why?: string };

/** GA-SAFE-12's class of a final outcome. */
export function ending(o: Pick<Outcome, "outcome" | "reason">): Ending {
  switch (o.outcome) {
    case "acked": case "delivered": case "sent": return "landed";
    case "unanswered": return "unanswered";
    case "unreachable": return "nothing_ran";
    case "skipped": return o.reason === "dead" ? "nothing_ran" : "final";
    case "failed":
      // A lock nothing can take, or nothing to lock: a rule does not try it for ever (GA-BRIDGE-66).
      if (o.reason === "not_locked" || o.reason === "no_graphical_session") return "final";
      if (o.reason === "no_ack" || MAY_HAVE_ACTED.has(o.reason ?? "")) return "may_have_run";
      return o.reason === "unsupported_action" || o.reason === "invalid_request" || o.reason === "unknown_device" ? "final" : "nothing_ran";
    default: return "final";
  }
}

/** Why a final outcome is not sent again, where a person should know (GA-BRIDGE-66). */
const FINAL_WHY: Record<string, string> = {
  not_locked: "not sent again: the computer did not lock (not_locked), and a lock nothing can take is not tried for ever",
  no_graphical_session: "not sent again: the account has no graphical session to lock (no_graphical_session)",
};

/** The key the waiting notice of a rule stands under, until its completion notice replaces it (GA-SAFE-8). */
const waitKey = (rule: string) => `safety_wait:${rule}`;

const seenKey = (device: string, key: string) => `${device}\u0000${key}`;

/**
 * The safety rules as they run (applier, *Safety rules*): each fires once each time its trigger
 * becomes true on a new report (GA-SAFE-11), with no client (GA-SAFE-1); its actuations go through
 * the dispatcher, and from firing until each has a final outcome every device it actuates is guarded
 * (GA-SAFE-2, GA-SAFE-3); on completion, a notice saying each outcome, and a `rule_fired` event
 * (GA-SAFE-8). Every method is one step: synchronous, in memory, its writes behind. Slice 6b adds
 * latches, GA-SAFE-12's re-sends and the liveness notices.
 */
export class SafetyRules {
  private rules = new Map<string, SafetyRule>();
  /** The rules a change of their devices' declarations disabled, with why: they fire no more (GA-SAFE-13). */
  private disabled: ReadonlyMap<string, string> = new Map();
  /** The latest basis_time seen for each key a rule reads (GA-SAFE-11): kept across a restart. */
  private readonly seen = new Map<string, number>();
  /** Each rule's trigger as it last read: true only after a new report made it true. */
  private readonly triggered = new Map<string, boolean>();
  private readonly running = new Map<string, Running>();
  /** The rules' latches (GA-SAFE-7, GA-SAFE-9). */
  readonly latches: Latches;
  /** GA-SAFE-10's notices on the rules' devices. */
  private readonly watch: LivenessNotices;

  constructor(private readonly o: SafetyPorts) {
    this.latches = new Latches({ store: o.store, now: () => o.clock.now(), mutation: o.mutation, reported: o.reported, assumed: o.assumed,
      liveness: o.liveness, emit: o.emit });
    this.watch = new LivenessNotices({ clock: o.clock, store: o.store, mutation: o.mutation, liveness: o.liveness, planned: o.planned, bound: o.bound,
      notice: o.notice, withdraw: o.withdraw });
    this.watch.rules = (device) => this.touching(device);
  }

  /** The rules reading or actuating `device`; a disabled one does nothing, and is said nothing of. */
  private touching(device: string): string[] {
    return [...this.rules.values()].filter((r) => !this.disabled.has(r.id) && devicesOf(r).includes(device)).map((r) => r.id);
  }

  /** Every rule not disabled, with the devices it reads or actuates. */
  private pairs(): { rule: string; device: string }[] {
    return [...this.rules.values()].filter((r) => !this.disabled.has(r.id))
      .flatMap((r) => devicesOf(r).map((device) => ({ rule: r.id, device })));
  }

  /** A bridge alive until now was found dead: a planned death counts towards a reload loop (GA-SAFE-10). */
  bridgeDead(bridge: string, planned: boolean): void {
    this.watch.bridgeDead(bridge, planned);
  }

  /** A device's bound changed, or the devices held did: each rule's devices' bounds judged again (GA-SAFE-10). */
  boundChanged(): void {
    this.watch.bounds(this.pairs());
  }

  /** The runs the last life left, which `resume` takes up: each actuation's kept state, and what the waiting notice said. */
  private left: { rule_id: string; apply_id: string; acts?: KeptAct[]; wait_said?: string }[] = [];

  /** Reads the rules, the latches, the seen bases and each trigger's reading, and nothing else (GA-PERSIST-1). */
  async load(rules: ReadonlyMap<string, SafetyRule>, disabled: ReadonlyMap<string, string> = new Map()): Promise<void> {
    this.rules = new Map(rules);
    this.disabled = new Map(disabled);
    await this.latches.load();
    await this.watch.load();
    const seen = await this.o.store.query<{ device: string; key: string; basis_ms: number | string }>("SELECT device, key, basis_ms FROM safety_seen");
    // `forgets-what-it-saw`: the seen bases are not read back.
    if (this.o.mutation !== "forgets-what-it-saw") for (const r of seen.rows) this.seen.set(seenKey(r.device, r.key), Number(r.basis_ms));
    const state = await this.o.store.query<{ rule_id: string; trigger_true: boolean; apply_id: string | null; acts: KeptAct[] | null;
      wait_said: string | null }>("SELECT rule_id, trigger_true, apply_id, acts, wait_said FROM safety_state");
    for (const r of state.rows) {
      if (!this.rules.has(r.rule_id)) continue;
      this.triggered.set(r.rule_id, r.trigger_true);
      // `forgets-a-running-rule`: a run the last life left is not read back.
      if (r.apply_id === null || this.o.mutation === "forgets-a-running-rule") continue;
      this.left.push({ rule_id: r.rule_id, apply_id: r.apply_id, ...(r.acts ? { acts: r.acts } : {}),
        ...(r.wait_said !== null ? { wait_said: r.wait_said } : {}) });
    }
  }

  /**
   * Every module has loaded: each bound seeded without a notice (a restart is no change of the owner's),
   * and each run the last life left guards its devices again until each actuation has a final outcome
   * (GA-SAFE-3, GA-SAFE-12), whatever its age. Each actuation goes on from its kept state: its attempts
   * numbered on, an `unanswered` one already sent once more not sent again, a `late_ack` kept, a waiting
   * one waiting again (sent at once on its device's return from `dead`), and a waiting notice already
   * said not said again. An actuation with no kept state, or still in flight, is judged by its outcome
   * as it ended; one with no final outcome and no waiting row ended `failed(no_ack)` at the dispatcher's
   * resume: it may have run (the maintainer's ruling 1), so only an idempotent one is sent again.
   */
  resume(): void {
    this.watch.bounds(this.pairs(), true);
    // A start is the broker's loss for GA-SAFE-10 (the maintainer's ruling 4).
    this.watch.resume(this.pairs());
    for (const { rule_id, apply_id, acts: kept, wait_said } of this.left) {
      const rule = this.rules.get(rule_id);
      const run = this.o.run(apply_id);
      if (!rule || !run) continue;
      const now = this.o.clock.now();
      const acts: Act[] = rule.actions.map((action, i) => {
        const k = kept?.length === rule.actions.length ? kept[i] : undefined;
        // The run's step id names the attempt sent last (`s1.2`): a re-send whose state's write was lost still counts.
        const sent = Number(/^s\d+\.(\d+)$/.exec(run.outcomes[i]?.step_id ?? "")?.[1] ?? 1);
        return { action, attempt: Math.max(k?.attempt ?? 1, sent), began: now, state: k?.state === "done" ? "done" : "flight",
          ...(k?.again ? { again: true } : {}), ...(k?.late ? { late: true } : {}), ...(k?.why !== undefined ? { why: k.why } : {}) };
      });
      const r: Running = { rule_id, apply_id: run.apply_id, devices: new Set(actuated(rule)), acts, fired: run.created_ms,
        ...(wait_said !== undefined ? { waitSaid: wait_said } : {}) };
      this.running.set(rule_id, r);
      // Each actuation already final is judged as it ended: done, or waiting to be sent again (GA-SAFE-12).
      // One whose kept attempt is above its last outcome's was sent again before the stop, and the
      // outcome is an earlier attempt's: that attempt is taken up, never the earlier one judged again.
      run.outcomes.forEach((o, i) => {
        const sent = Number(/^s\d+\.(\d+)$/.exec(o.step_id)?.[1] ?? 1);
        if (acts[i]!.state === "flight" && acts[i]!.attempt > sent) this.o.takeUp(run.apply_id, i, acts[i]!.attempt);
        else this.stepEnded(run, i);
      });
      this.settle(r);
    }
    this.left = [];
  }

  /** The rules configured, as `describe` lists them: a disabled one with why. */
  list(): (SafetyRule & { disabled?: string })[] {
    return [...this.rules.values()].map((r) => this.disabled.has(r.id) ? { ...r, disabled: this.disabled.get(r.id)! } : r);
  }

  /**
   * The owner's rules changed: a rule deleted or changed while it runs stops running, its devices no
   * longer guarded, and the owner is told what its actuations had come to (the build's pick; the
   * standard is silent). A changed rule's trigger starts afresh. Each key a trigger reads counts as
   * seen up to the report the applier already holds: a retained status re-delivered after the rule
   * is configured (a broker reconnect, a GA-BUS-6 snapshot) carries the same `basis_time` and is no
   * new report (GA-SAFE-11).
   */
  setRules(rules: ReadonlyMap<string, SafetyRule>, disabled: ReadonlyMap<string, string> = new Map()): void {
    const before = this.rules;
    const wasDisabled = this.disabled;
    this.rules = new Map(rules);
    this.disabled = new Map(disabled);
    this.seedSeen();
    for (const [id, old] of before) {
      const now = rules.get(id);
      if (now && JSON.stringify(now) === JSON.stringify(old)) {
        // A rule the owner set again after a disable acts as one newly configured: its trigger starts afresh, so it
        // fires on the next new report that makes it true, never on values held before (GA-SAFE-11).
        if (wasDisabled.has(id) && !this.disabled.has(id)) {
          this.triggered.delete(id);
          this.keepState(id);
        }
        continue;
      }
      this.triggered.delete(id);
      const r = this.running.get(id);
      if (r) {
        this.stop(r);
        const run = r.apply_id !== undefined ? this.o.run(r.apply_id) : undefined;
        this.o.notice({ cause: "safety_rule", rule_id: id, devices: [...r.devices], outcomes: run?.outcomes ?? [],
          text: `Safety rule ${id} was ${now ? "changed" : "deleted"} while it ran; its actions so far: ${describeOutcomes(run?.outcomes ?? [])}.` });
      }
      void this.o.store.write((tx) => tx.query("DELETE FROM safety_state WHERE rule_id = $1", [id]).then(() => undefined));
    }
    // A rule deleted, or no longer declaring a latch, clears its latch as the owner's word; a changed one is judged by its new condition.
    this.latches.check(this.rules);
    this.rejudge();
    // A rule configured on a device whose fresh_s is not known, or longer than declared, is a notice (GA-SAFE-10).
    this.watch.bounds(this.pairs());
  }

  /** The owner's `clear_latch` (applier, *Latches*): the latch clears, `cleared_by_owner` (GA-SAFE-9). */
  clearLatch(ruleId: string): void {
    this.latches.clearByOwner(ruleId);
    // The rule no longer wants what waits: its run completes, and its devices are no longer guarded (GA-SAFE-12, GA-SAFE-3).
    this.rejudge();
  }

  /**
   * A device's liveness changed: a latch whose condition reads it may clear now that it is `live`
   * (GA-SAFE-7), and an actuation waiting for it is sent at once on its return from `dead` (GA-SAFE-12).
   */
  livenessChanged(device: string, old?: Liveness, next?: Liveness): void {
    this.latches.check(this.rules, device);
    this.rejudge(old === "dead" && next !== "dead" ? device : undefined);
    if (old !== undefined && next !== undefined) this.watch.changed(this.touching(device), device, old, next);
  }

  /**
   * The seen rows `rules` would seed: each key a trigger reads whose latest report is newer than the
   * last basis seen, computed without writing. `configure` writes them in its own transaction, so a
   * crash right after it cannot fire a new rule on a report held before it (GA-SAFE-11).
   */
  seedRows(rules: ReadonlyMap<string, SafetyRule>): { device: string; key: string; basis: number }[] {
    const rows = new Map<string, { device: string; key: string; basis: number }>();
    for (const rule of rules.values()) {
      for (const t of terms(rule.trigger)) {
        const basis = this.o.basis(t.device, t.key);
        const k = seenKey(t.device, t.key);
        if (basis === undefined || basis <= (this.seen.get(k) ?? -Infinity)) continue;
        rows.set(k, { device: t.device, key: t.key, basis });
      }
    }
    return [...rows.values()];
  }

  /**
   * Raises the last basis seen of each key a trigger reads to the model's latest report of it. Written
   * behind too, safe to write twice: a rule set again by a declaration change seeds here alone.
   */
  private seedSeen(): void {
    const rows = this.seedRows(this.rules);
    for (const r of rows) this.seen.set(seenKey(r.device, r.key), r.basis);
    if (!rows.length) return;
    void this.o.store.write(async (tx) => {
      for (const r of rows) await saveSeen(tx, r.device, r.key, r.basis);
    });
  }

  /** Stops a run: its timers cleared, its waiting notice withdrawn, and its devices no longer guarded. */
  private stop(r: Running): void {
    for (const a of r.acts) if (a.timer !== undefined) this.o.clock.clear(a.timer);
    this.o.withdraw(waitKey(r.rule_id));
    this.running.delete(r.rule_id);
  }

  /** Whether `applyId` is a rule's run still running: the dispatcher keeps it past its hour (GA-SAFE-12). */
  runs(applyId: string): boolean {
    for (const r of this.running.values()) if (r.apply_id === applyId) return true;
    return false;
  }

  /** Whether a running rule actuates `device`: then every request for it is `refuse(safety)` (GA-SAFE-2). */
  guarded(device: string): boolean {
    for (const r of this.running.values()) if (r.devices.has(device)) return true;
    return false;
  }

  /** The devices the rules name, for the history of a `rule_fired` event. */
  devicesOf(ruleId: string): string[] {
    const r = this.rules.get(ruleId);
    return r ? devicesOf(r) : [];
  }

  /**
   * Readings of `device` the applier took: those with a `basis_time` later than the last seen for
   * their key are new reports, whatever the device's liveness (GA-SAFE-11), and each rule whose trigger
   * reads one is judged again. A value from a fast clock never comes here (GA-BUS-2).
   */
  reported(device: string, readings: { key: string; basis: number }[]): void {
    // A firing's records (its seen basis, latch, run, waiting row and state) commit as one write set, or
    // none of them: a crash never keeps a latch whose run was lost (GA-SAFE-3). `loses-a-fired-run`
    // hands them one by one, as before slice 7b.
    if (this.o.mutation === "loses-a-fired-run") this.judgeReport(device, readings);
    else this.o.store.group(() => this.judgeReport(device, readings));
  }

  private judgeReport(device: string, readings: { key: string; basis: number }[]): void {
    // A latch reads the latest reported values, new to it or not (GA-SAFE-7).
    this.latches.check(this.rules, device);
    // A re-send waits while its rule wants it, and until a report says it landed (GA-SAFE-12).
    this.rejudge();
    const fresh: string[] = [];
    const rows: { key: string; basis: number }[] = [];
    const bases = new Map<string, number>();
    for (const r of readings) {
      const k = seenKey(device, r.key);
      if (r.basis <= (this.seen.get(k) ?? -Infinity)) continue;
      if (!this.reads(device, r.key)) continue;
      this.seen.set(k, r.basis);
      fresh.push(r.key);
      rows.push(r);
      bases.set(r.key, r.basis);
    }
    if (!fresh.length) return;
    void this.o.store.write(async (tx) => {
      for (const r of rows) await saveSeen(tx, device, r.key, r.basis);
    });
    this.judge(device, fresh, bases);
  }

  /** An open device's assumed state moved: a rule never reads it (GA-SAFE-11, GA-SAFE-7), but under its mutations. */
  assumedChanged(device: string, keys: string[]): void {
    if (this.o.mutation === "fires-on-an-assumed-value") this.judge(device, keys);
    if (this.o.mutation === "clears-a-latch-on-an-assumed-value") this.latches.check(this.rules, device);
  }

  /**
   * Each rule whose trigger reads one of `keys` of `device`: fired when its trigger becomes true, not
   * while it runs. `bases` gives each new key's `basis_time`: the report a firing is named by.
   */
  private judge(device: string, keys: string[], bases: ReadonlyMap<string, number> = new Map()): void {
    for (const rule of this.rules.values()) {
      if (!terms(rule.trigger).some((t) => t.device === device && keys.includes(t.key))) continue;
      const now = evaluate(rule.trigger, this.read);
      const was = this.triggered.get(rule.id) ?? false;
      if (now !== was) {
        this.triggered.set(rule.id, now);
        this.keepState(rule.id);
      }
      // A disabled rule does not fire; set again, its trigger starts afresh (`setRules`).
      if (!now || was || this.running.has(rule.id) || this.disabled.has(rule.id) || this.latches.holds(rule.id)) continue;
      // Its conditions are read at the moment its trigger becomes true: false then, it waits for the next time.
      if (rule.conditions && !evaluate(rule.conditions, this.read)) continue;
      // The report that made the trigger true: the latest of the keys it reads that came new now; an
      // assumed value (only under `fires-on-an-assumed-value`) has none, and the reported basis or now stands in.
      const read = terms(rule.trigger).filter((t) => t.device === device && keys.includes(t.key));
      const basis = Math.max(...read.map((t) => bases.get(t.key) ?? this.o.basis(device, t.key) ?? this.o.clock.now()));
      this.fire(rule, { device, basis });
    }
  }

  /** What a rule reads: the reported value; an assumed one only under `fires-on-an-assumed-value`. */
  private readonly read = (device: string, key: string): unknown => {
    const v = this.o.reported(device, key);
    return v === undefined && this.o.mutation === "fires-on-an-assumed-value" ? this.o.assumed(device, key) : v;
  };

  private reads(device: string, key: string): boolean {
    for (const r of this.rules.values()) if (terms(r.trigger).some((t) => t.device === device && t.key === key)) return true;
    return false;
  }

  /** A rule fires: its run is held, and guards its devices from now (GA-SAFE-2). */
  private fire(rule: SafetyRule, cause: { device: string; basis: number }): void {
    // Its latch is held from firing (GA-SAFE-7, GA-SAFE-9).
    this.latches.set(rule);
    const now = this.o.clock.now();
    // Running before the dispatcher holds it: an actuation it ends at once is this run's.
    const r: Running = { rule_id: rule.id, devices: new Set(actuated(rule)), fired: now,
      acts: rule.actions.map((action) => ({ action, attempt: 1, began: now, state: "flight" })) };
    this.running.set(rule.id, r);
    const run = this.o.actuate(rule.id, rule.actions, cause);
    r.apply_id ??= run.apply_id;
    if (this.running.get(rule.id) === r) this.keepState(rule.id);
  }

  /**
   * The dispatcher's word that an attempt of a run has its final outcome (GA-SAFE-3): what it leaves to
   * do, by GA-SAFE-12's classes. Landed or final, the actuation is done. Nothing ran: sent again once its
   * device is not `dead`. It may have run: an idempotent action sent again while its device's report does
   * not match, a non-idempotent one not, its notice saying so. Unanswered: an idempotent action once
   * more. Each only while the rule still wants it. The rule is complete once every actuation is done.
   */
  stepEnded(run: HeldApply, i: number): void {
    if (run.rule_id === undefined) return;
    const r = this.running.get(run.rule_id);
    if (!r) return;
    r.apply_id ??= run.apply_id;
    const act = r.acts[i];
    const o = run.outcomes[i];
    if (r.apply_id !== run.apply_id || !act || !o || act.state !== "flight" || o.outcome === "dispatched") return;
    const rule = this.rules.get(r.rule_id);
    const kind = ending(o);
    const decl = this.o.action(act.action.target, act.action.action);
    const done = (why?: string) => {
      act.state = "done";
      if (why) act.why = why;
    };
    // A late_ack of an earlier attempt said the action ran: it landed, whatever this attempt says.
    if (kind === "landed" || act.late || !rule || !this.wants(rule)) done();
    else if (kind === "final") done(FINAL_WHY[o.reason ?? ""]);
    else if (kind === "nothing_ran") {
      // `gives-up-on-dead`: an actuation that did not run is final, and no waiting notice says it waits.
      if (this.o.mutation === "gives-up-on-dead") done();
      else this.wait(r, i);
    } else if (kind === "may_have_run" && !decl && this.o.liveness(act.action.target) === "dead") {
      // Not described yet in this life (a start): judged on its return, its declaration known by then.
      act.unsure = true;
      this.wait(r, i);
    } else if (kind === "may_have_run") {
      const idempotent = decl?.idempotent === true || this.o.mutation === "resends-what-may-have-run";
      if (!idempotent) done("not sent again: it may have run, and is not idempotent");
      else if (this.o.landed(act.action.target, act.action.action, act.action.args ?? {}, r.fired)) done();
      else this.wait(r, i);
    } else if (decl?.idempotent && !act.again) {
      act.again = true;
      this.wait(r, i);
    } else done(decl?.idempotent ? "sent once more and unanswered again: nothing will say whether it ran" : undefined);
    if (this.running.get(r.rule_id) === r) this.keepState(r.rule_id);
    this.settle(r);
  }

  /** Whether a rule still wants its actuations: its latch held, or, with none, its trigger true on the latest reports (GA-SAFE-12). */
  private wants(rule: SafetyRule): boolean {
    if (this.disabled.has(rule.id)) return false;
    if (rule.latch) return this.latches.holds(rule.id);
    // Unknown is not false (the maintainer's ruling 8): a key with no report in this life, lost in a restart or
    // never reported, leaves its terms undetermined, and the run is wanted while the trigger is true or
    // undetermined; a known term that makes it false ends it (the 7b preflight's M1).
    return evaluate3(rule.trigger, this.read) !== false;
  }

  /**
   * An actuation waits to be sent again (GA-SAFE-12): no sooner than its bound after its last attempt
   * began, and only while its device is not `dead`, then at once on its return; a notice says so at
   * once (GA-SAFE-8). A live device that keeps failing is so sent one attempt each `ack_within_s`, for as
   * long as the rule wants it; the notice is not raised again for each attempt.
   */
  private wait(r: Running, i: number): void {
    const act = r.acts[i]!;
    act.state = "wait";
    const ms = Math.round((this.o.action(act.action.target, act.action.action)?.ack_within_s ?? 0) * 1000);
    const at = Math.max(this.o.clock.now(), act.began + ms);
    act.timer = this.o.clock.setTimeout(() => {
      act.timer = undefined;
      this.tryResend(r, i);
    }, at - this.o.clock.now());
    this.waitingNotice(r);
  }

  /** A waiting actuation's time came, or its device returned from `dead`: sent again unless the device is `dead` (GA-SAFE-12). */
  private tryResend(r: Running, i: number): void {
    const act = r.acts[i]!;
    if (this.running.get(r.rule_id) !== r || act.state !== "wait" || r.apply_id === undefined) return;
    if (act.timer !== undefined) this.o.clock.clear(act.timer);
    act.timer = undefined;
    // Only while the rule still wants it: a latch the owner cleared, or a rule disabled, wants nothing more.
    const rule = this.rules.get(r.rule_id);
    if (!rule || !this.wants(rule)) {
      act.state = "done";
      this.settle(r);
      return;
    }
    if (this.o.liveness(act.action.target) === "dead") return;
    if (act.unsure) {
      // It may have run: sent again only if its declaration, known now, says idempotent (GA-SAFE-12).
      act.unsure = undefined;
      const decl = this.o.action(act.action.target, act.action.action);
      const done = (why?: string) => {
        act.state = "done";
        if (why) act.why = why;
        this.keepState(r.rule_id);
        this.settle(r);
      };
      if (decl?.idempotent !== true && this.o.mutation !== "resends-what-may-have-run") return done("not sent again: it may have run, and is not idempotent");
      if (this.o.landed(act.action.target, act.action.action, act.action.args ?? {}, r.fired)) return done();
    }
    act.attempt++;
    act.began = this.o.clock.now();
    act.state = "flight";
    // Its attempt kept before it is sent, so a restart never sends the same attempt under the same step id twice.
    this.keepState(r.rule_id);
    this.o.resend(r.apply_id, i, act.action, act.attempt);
  }

  /**
   * Each running rule's waiting actuations judged again: done once the rule no longer wants them or a
   * report says one landed; sent at once on `returned`'s return from `dead`, its spacing waived (GA-SAFE-12).
   */
  private rejudge(returned?: string): void {
    for (const r of [...this.running.values()]) {
      const rule = this.rules.get(r.rule_id);
      const wanted = rule !== undefined && this.wants(rule);
      let changed = false;
      r.acts.forEach((act, i) => {
        if (act.state !== "wait") return;
        // A late_ack landed it, whatever the bridge's clock stamped on the report; else a report since the firing must say so.
        if (!wanted || act.late || this.o.landed(act.action.target, act.action.action, act.action.args ?? {}, r.fired)) {
          if (act.timer !== undefined) this.o.clock.clear(act.timer);
          act.timer = undefined;
          act.state = "done";
          if (wanted) act.late = true;
          changed = true;
          return;
        }
        if (returned === act.action.target) this.tryResend(r, i);
      });
      if (changed && this.running.get(r.rule_id) === r) this.keepState(r.rule_id);
      this.settle(r);
    }
  }

  /** A run is complete once every actuation is done (GA-SAFE-3). */
  private settle(r: Running): void {
    if (this.running.get(r.rule_id) !== r || r.acts.some((a) => a.state !== "done")) return;
    const run = r.apply_id !== undefined ? this.o.run(r.apply_id) : undefined;
    this.running.delete(r.rule_id);
    if (run) this.finish(r.rule_id, run, r.acts);
  }

  /**
   * At once when an actuation waits: the rule fired, and what waits; a newer one, raised only when what
   * waits or why changes, replaces an untaken older (GA-SAFE-8).
   */
  private waitingNotice(r: Running): void {
    const run = r.apply_id !== undefined ? this.o.run(r.apply_id) : undefined;
    const rule = this.rules.get(r.rule_id);
    const waiting = r.acts.map((a, i) => ({ a, i, o: run?.outcomes[i] })).filter((x) => x.a.state === "wait");
    // The same actuations waiting for the same reasons: the standing notice still says it, so no new one per attempt.
    const said = JSON.stringify(waiting.map((x) => [x.i, x.o?.outcome, x.o?.reason]));
    if (said === r.waitSaid) return;
    r.waitSaid = said;
    this.o.withdraw(waitKey(r.rule_id));
    this.o.notice({ cause: "safety_rule", rule_id: r.rule_id, devices: rule ? actuated(rule) : [], waiting: true,
      outcomes: run ? strip(run.outcomes) : [],
      text: `Safety rule ${r.rule_id} fired. Waiting to send again: ${waiting.map((x) => `${x.a.action.target} ${x.a.action.action}`
        + (x.o ? ` (${x.o.outcome}${x.o.reason ? ` ${x.o.reason}` : ""})` : "")).join("; ")}.` }, waitKey(r.rule_id));
  }

  /**
   * A `late_ack` of a rule's actuation that ended `failed` (GA-APPLY-11), by the step it acks: while its
   * run still runs, that actuation landed, waiting or done, and the completion notice says so; once the run
   * is complete, a second notice says so, unless the run's final outcome for it already landed, a later
   * attempt acked (GA-SAFE-8).
   */
  lateAck(ruleId: string, applyId: string, target: string, stepId: string): void {
    const i = Number(/^s(\d+)/.exec(stepId)?.[1] ?? 0) - 1;
    const last = this.o.run(applyId)?.outcomes[i];
    const r = this.running.get(ruleId);
    if (r && r.apply_id === applyId) {
      const act = r.acts[i];
      if (!act || act.action.target !== target || (act.state === "done" && last && ending(last) === "landed")) return;
      act.late = true;
      this.keepState(ruleId);
      this.rejudge();
      return;
    }
    if (last && ending(last) === "landed") return;
    const rule = this.rules.get(ruleId);
    this.o.notice({ cause: "safety_rule", rule_id: ruleId, devices: [target], late_ack: true,
      text: `${rule?.notice?.text ? `${rule.notice.text} ` : ""}Safety rule ${ruleId}: ${target}, reported failed, has since done what the rule asked (a late ack).` });
  }

  /**
   * A complete run: its notice, saying each actuation's final outcome, its last attempt's, and why one
   * was not sent again, replacing the waiting notice; and its `rule_fired` event naming it (GA-SAFE-3,
   * GA-SAFE-8).
   */
  private finish(ruleId: string, run: HeldApply, acts: Act[] = []): void {
    const rule = this.rules.get(ruleId);
    const outcomes = strip(run.outcomes);
    const notes = acts.flatMap((a, i) => {
      const o = run.outcomes[i];
      if (a.late && o && ending(o) !== "landed") return [`${a.action.target} did what it was asked after its outcome ${o.outcome}`];
      return a.why ? [`${a.action.target}: ${a.why}`] : [];
    });
    this.o.withdraw(waitKey(ruleId));
    const notice_id = this.o.notice({ cause: "safety_rule", rule_id: ruleId, devices: rule ? actuated(rule) : [], outcomes,
      text: `${rule?.notice?.text ?? `Safety rule ${ruleId} fired.`} ${describeOutcomes(run.outcomes)}${notes.length ? `; ${notes.join("; ")}` : ""}.` });
    this.o.emit("rule_fired", { rule_id: ruleId, outcomes, notice: notice_id ?? null, devices: this.devicesOf(ruleId) });
    this.keepState(ruleId);
  }

  /**
   * Keeps a rule's trigger reading and, while it runs, its run, each actuation's state and what its
   * waiting notice said (applier, *Restarts*), written behind: an upsert, safe to run twice.
   */
  private keepState(ruleId: string): void {
    const trigger = this.triggered.get(ruleId) ?? false;
    const r = this.running.get(ruleId);
    const acts = r ? JSON.stringify(r.acts.map(({ attempt, state, again, late, why }): KeptAct =>
      ({ attempt, state, ...(again ? { again: true } : {}), ...(late ? { late: true } : {}), ...(why !== undefined ? { why } : {}) }))) : null;
    const row = [ruleId, trigger, r?.apply_id ?? null, acts, r?.waitSaid ?? null];
    void this.o.store.write((tx) => tx.query("INSERT INTO safety_state (rule_id, trigger_true, apply_id, acts, wait_said) VALUES ($1, $2, $3, $4, $5) "
      + "ON CONFLICT (rule_id) DO UPDATE SET trigger_true = EXCLUDED.trigger_true, apply_id = EXCLUDED.apply_id, acts = EXCLUDED.acts, "
      + "wait_said = EXCLUDED.wait_said", row).then(() => undefined));
  }
}

export async function saveSeen(tx: Tx, device: string, key: string, basis: number): Promise<void> {
  await tx.query("INSERT INTO safety_seen (device, key, basis_ms) VALUES ($1, $2, $3) ON CONFLICT (device, key) "
    + "DO UPDATE SET basis_ms = GREATEST(safety_seen.basis_ms, EXCLUDED.basis_ms)", [device, key, Math.floor(basis)]);
}

/** Outcomes as a notice and `rule_fired` carry them: without their step and time. */
const strip = (outcomes: Outcome[]) => outcomes.map(({ step_id: _s, time: _t, ...x }) => x);

/** Each actuation's outcome, as a person reads it. */
function describeOutcomes(outcomes: Outcome[]): string {
  return outcomes.map((x) => `${x.target} ${x.outcome}${x.reason ? ` (${x.reason})` : ""}`).join("; ") || "none";
}
