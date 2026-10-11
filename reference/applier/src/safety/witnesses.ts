import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Store } from "../core/store.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";

/**
 * What a witness expects of its sensor once its action is dispatched (applier, *Safety rules*): that the
 * sensor's reading rises, falls, becomes a value, or moves at least `by` towards the value of the step's
 * argument `arg` (an air conditioner's setpoint). The provisional shape of `configure.witness.json`.
 */
export type Expect = "rises" | "falls" | { becomes: string | number | boolean } | { toward: { arg: string; by: number } };
/**
 * A witness (applier, *Safety rules*): the sensor that says whether an action did what it asked, the key
 * of it that it reads (its first sensor key where the owner names none), and how long it may take.
 */
export type Witness = { sensor: string; key?: string; expect: Expect; within_s: number;
  /** Why a change of its sensor's declarations disabled it (GA-SAFE-14): it judges nothing until the owner sets it again. */
  disabled?: string };
export type Verdict = "confirmed" | "unconfirmed" | "unknown";
/** A witness's verdict on a step, as `outcome` carries it beside the step's own outcome and its event carries it. */
export type Witnessed = Witness & { verdict: Verdict };

/** What the witnesses ask of the applier around them. */
export interface WitnessPorts {
  clock: Clock;
  /** Where each watch is kept until its verdict, so a restart still says one (the maintainer's ruling 3). */
  store: Store;
  mutation?: Mutation;
  /** The witness the owner declared on `device`'s `action`; undefined where none. */
  witness(device: string, action: string): Witness | undefined;
  /** Every witness declared, with its device and action. */
  all(): { device: string; action: string; witness: Witness }[];
  /** The key a witness reads of its sensor: the one it names, or else the sensor's first; undefined where it has none. */
  key(witness: Witness): string | undefined;
  /** A device's latest reported value of `key`; never an assumed one. */
  reported(device: string, key: string): unknown;
  liveness(device: string): Liveness | undefined;
  /** A closed device's effective bound and its declared one; undefined for an open one, or one the model does not hold. */
  bound(device: string): { fresh_s: number | null; declared: number | null } | undefined;
  /** Serves an event (and hands it to the writer). */
  emit(type: string, body: Record<string, unknown>): void;
  /** Keeps a step's verdict beside its outcome, which `outcome` serves (GA-WIT-1). */
  witnessed(applyId: string, stepId: string, w: Witnessed): void;
  /** Whether a step's verdict is kept already: a watch a crash left is never judged twice. */
  judged(applyId: string, stepId: string): boolean;
  notice(n: Record<string, unknown> & { cause: string; text: string }, key?: string): string | undefined;
  withdraw(key: string): void;
}

/** A witnessed step being watched: from its dispatch until its `within_s`, whether its sensor stayed `live` throughout. */
type Watch = { apply_id: string; run: Record<string, string>; step_id: string; target: string; action: string; args: Record<string, unknown>;
  witness: Witness; key?: string; baseline: unknown; live: boolean };

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * A witness's verdict on a sensor `live` throughout (GA-WIT-1): its latest reading against the one it held
 * at dispatch. `rises` and `falls` compare the two; `becomes` the latest with its value; `toward` asks the
 * latest to be at least `by` nearer the step's argument than the reading at dispatch was, as the text
 * says, a reading that moved away never confirmed. A room already within `by` of it at dispatch has
 * nothing to show, and is `unknown`; so is what cannot be compared, a reading that is no number or none.
 */
export function verdict(expect: Expect, baseline: unknown, latest: unknown, args: Record<string, unknown>): Verdict {
  if (expect === "rises" || expect === "falls") {
    if (!num(baseline) || !num(latest)) return "unknown";
    return (expect === "rises" ? latest > baseline : latest < baseline) ? "confirmed" : "unconfirmed";
  }
  if ("becomes" in expect) return latest === undefined ? "unknown" : latest === expect.becomes ? "confirmed" : "unconfirmed";
  const target = args[expect.toward.arg];
  if (!num(target) || !num(latest) || !num(baseline)) return "unknown";
  const by = expect.toward.by;
  if (Math.abs(baseline - target) <= by) return "unknown";
  return Math.abs(baseline - target) - Math.abs(latest - target) >= by ? "confirmed" : "unconfirmed";
}

/** What a witness's sensor's bound says to a person: nothing, unknown, or the owner's longer than the declared; and of which sensor. */
type BoundSay = { say: "ok" | "unknown" | "longer"; sensor: string };
const boundKey = (device: string, action: string) => `witness:${device}:${action}`;

/**
 * Witnesses (applier, *Safety rules*, GA-WIT-1). Each dispatched step of a witnessed action, from any
 * apply, rule or cap, is watched from its dispatch: `within_s` later its verdict is a second `outcome`
 * event of that step, `confirmed`, `unconfirmed`, or `unknown` when the sensor was not `live`
 * throughout, and kept beside the step's outcome, which `outcome` serves; the step's own outcome, which a
 * client may have read, never changes. A witness whose
 * sensor has no known `fresh_s`, or an owner's longer than the declared one, is a notice with cause
 * `liveness`. Every method is one step: synchronous, in memory, its writes behind. A watch is kept
 * (`witness_watches`) until its verdict: one armed before a restart is judged `unknown` at its due,
 * its sensor not seen `live` throughout (the maintainer's ruling 3).
 */
export class Witnesses {
  /** Each watch by a number of its own: a rule's or a cap's runs share their `run` and their step ids. */
  private readonly watches = new Map<number, Watch & { timer: number }>();
  private next = 0;
  /** What each witness's sensor's bound last said: a notice when it starts to say something. */
  private readonly says = new Map<string, BoundSay>();

  /** The watches a restart kept, armed by `resume`. */
  private kept: { apply_id: string; step_id: string; run: Record<string, string>; target: string; action: string; witness: Witness; due: number }[] = [];

  constructor(private readonly o: WitnessPorts) {}

  /** The watches kept by the last life, each awaiting its verdict. */
  async load(): Promise<void> {
    // `forgets-a-watch`: the watches are not read back.
    if (this.o.mutation === "forgets-a-watch") return;
    const rows = await this.o.store.query<{ apply_id: string; step_id: string; run: Record<string, string>; target: string; action: string;
      witness: Witness; due_ms: number | string }>("SELECT apply_id, step_id, run, target, action, witness, due_ms FROM witness_watches");
    this.kept = rows.rows.map((r) => ({ apply_id: r.apply_id, step_id: r.step_id, run: r.run, target: r.target, action: r.action,
      witness: r.witness, due: Number(r.due_ms) }));
  }

  /** Every module has loaded: each kept watch is judged `unknown` at its due, at once if that is past; its sensor was not seen throughout. */
  resume(): void {
    for (const k of this.kept) {
      // Its verdict kept, its row's delete lost: judged already, never again (the 7b preflight's M2).
      if (this.o.judged(k.apply_id, k.step_id)) {
        this.forget(k.apply_id, k.step_id);
        continue;
      }
      const timer = this.o.clock.setTimeout(() => {
        this.resumed.delete(timer);
        const witnessed: Witnessed = { ...k.witness, verdict: "unknown" };
        // The verdict, its event and the watch's delete commit as one write set.
        this.o.store.group(() => {
          this.o.witnessed(k.apply_id, k.step_id, witnessed);
          this.o.emit("outcome", { ...k.run, step_id: k.step_id, target: k.target, outcome: "unknown", witness: witnessed });
          this.forget(k.apply_id, k.step_id);
        });
      }, Math.max(0, k.due - this.o.clock.now()));
      this.resumed.add(timer);
    }
    this.kept = [];
  }

  /** The timers `resume` set for the watches a restart found, until each fires. */
  private readonly resumed = new Set<number>();

  /** The applier stops (an embedding host's stop): every watch's timer is cleared, `resume`'s too; the watches stay as the store keeps them. */
  stop(): void {
    for (const w of this.watches.values()) this.o.clock.clear(w.timer);
    this.watches.clear();
    for (const t of this.resumed) this.o.clock.clear(t);
    this.resumed.clear();
  }

  /** A watch judged: its row goes. */
  private forget(applyId: string, stepId: string): void {
    void this.o.store.write((tx) => tx.query("DELETE FROM witness_watches WHERE apply_id = $1 AND step_id = $2", [applyId, stepId])
      .then(() => undefined));
  }

  /** A step was dispatched at `dispatchedMs`: watched if its action is witnessed, its sensor's reading then held. */
  dispatched(applyId: string, run: Record<string, string>, stepId: string, target: string, action: string, args: Record<string, unknown>,
    dispatchedMs: number): void {
    const witness = this.o.witness(target, action);
    if (!witness) return;
    const key = this.o.key(witness);
    const w: Watch = { apply_id: applyId, run, step_id: stepId, target, action, args, witness, ...(key !== undefined ? { key } : {}),
      baseline: key === undefined ? undefined : this.o.reported(witness.sensor, key),
      live: key !== undefined && this.o.liveness(witness.sensor) === "live" };
    const id = this.next++;
    const due = Math.floor(dispatchedMs + witness.within_s * 1000);
    const timer = this.o.clock.setTimeout(() => this.judge(id), Math.max(0, due - this.o.clock.now()));
    this.watches.set(id, { ...w, timer });
    // Kept until its verdict, an upsert, safe twice: a restart judges it `unknown` at its due.
    void this.o.store.write((tx) => tx.query("INSERT INTO witness_watches (apply_id, step_id, run, target, action, witness, due_ms) "
      + "VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (apply_id, step_id) DO UPDATE SET run = EXCLUDED.run, target = EXCLUDED.target, "
      + "action = EXCLUDED.action, witness = EXCLUDED.witness, due_ms = EXCLUDED.due_ms",
    [applyId, stepId, JSON.stringify(run), target, action, JSON.stringify(witness), due]).then(() => undefined));
  }

  /** A device's liveness changed: a witness reading it that is not `live` now was not `live` throughout. */
  livenessChanged(device: string, next?: Liveness): void {
    if (next === "live") return;
    for (const w of this.watches.values()) if (w.witness.sensor === device) w.live = false;
  }

  private judge(id: number): void {
    const w = this.watches.get(id);
    if (!w) return;
    this.watches.delete(id);
    const live = w.live && this.o.liveness(w.witness.sensor) === "live";
    const v: Verdict = live && w.key !== undefined ? verdict(w.witness.expect, w.baseline, this.o.reported(w.witness.sensor, w.key), w.args) : "unknown";
    const witnessed: Witnessed = { ...w.witness, verdict: v };
    // The verdict, its event and the watch's delete commit as one write set: a crash never keeps the
    // verdict and loses the delete, which would judge the step again (the 7b preflight's M2).
    this.o.store.group(() => {
      this.o.witnessed(w.apply_id, w.step_id, witnessed);
      this.o.emit("outcome", { ...w.run, step_id: w.step_id, target: w.target, outcome: v, witness: witnessed });
      this.forget(w.apply_id, w.step_id);
    });
  }

  /**
   * Each witness's sensor's bound judged again: a notice when its `fresh_s` is not known, since its
   * verdict can then only be `unknown`, or the owner's is longer than the declared one, since it can then
   * say `confirmed` from a dead sensor (GA-WIT-1). A witness moved to another sensor is judged anew, its
   * old notice withdrawn; a witness deleted takes its untaken notice with it. `silent` seeds what each
   * says without a notice (a start).
   */
  bounds(silent = false): void {
    const seen = new Set<string>();
    for (const { device, action, witness } of this.o.all()) {
      const k = boundKey(device, action);
      seen.add(k);
      const b = this.o.bound(witness.sensor);
      if (!b) continue;
      const now: BoundSay = { sensor: witness.sensor,
        say: b.fresh_s === null ? "unknown" : b.declared !== null && b.fresh_s > b.declared ? "longer" : "ok" };
      const was = this.says.get(k);
      this.says.set(k, now);
      const moved = was !== undefined && was.sensor !== now.sensor;
      if (moved && !silent) this.o.withdraw(k);
      if (silent || now.say === "ok" || (!moved && now.say === was?.say)) continue;
      this.o.withdraw(k);
      this.o.notice({ cause: "liveness", devices: [witness.sensor, device], witness: { device, action, sensor: witness.sensor },
        text: `The witness of ${device}'s ${action} reads ${witness.sensor}, ` + (now.say === "unknown"
          ? "whose fresh_s is not known: it can never be live, so the witness can only say unknown until the owner sets one."
          : `whose fresh_s, ${b.fresh_s} s, is longer than the ${b.declared} s its bridge declares: the witness can say confirmed from a dead sensor.`) }, k);
    }
    for (const k of [...this.says.keys()]) {
      if (seen.has(k)) continue;
      this.says.delete(k);
      if (!silent) this.o.withdraw(k);
    }
  }
}
