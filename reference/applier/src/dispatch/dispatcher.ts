import { randomUUID } from "node:crypto";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Bridge } from "../config/config.js";
import type { Puback } from "../bus/client.js";
import type { Ack } from "../bus/wire.js";
import { Keys, type KeyClaim } from "../core/keys.js";
import { GATE_MS, within, type Store } from "../core/store.js";
import { argsFault, commandValue, sets, sideEffects, towards } from "../gate/actions.js";
import { judge, tokenStands, type Gate, type GateDevice, type Requested, type Step } from "../gate/plan.js";
import type { DispatchTarget } from "../model/home.js";
import type { Mutation } from "../mutations.js";
import {
  causeOf, clientOf, dropLate, dropWaiting, HELD_MS, loadRecords, pruneRecords, releaseToken, saveApply, saveAssumed, saveLate, saveWaiting, useToken,
  type ApplyCause, type Assumed, type HeldApply, type Late, type Outcome, type Waiting,
} from "./records.js";
import { uuidV5 } from "./command-id.js";
import { onAck, onBound, onBridgeDead, type Final, type StepKind } from "./rules.js";

/** The reasons judged before `declaration_changed` at dispatch: none of them hangs on the action's declarations. */
const OUTRANKS_A_CHANGE = new Set<string>(["not_adopted", "safety", "latched", "dead"]);

/** What the dispatcher asks of the applier around it. */
export interface DispatchPorts {
  store: Store;
  clock: Clock;
  mutation?: Mutation;
  /** The install's namespace for derived ids (the maintainer's ruling 2): a UUID kept in `meta`, read once the store is loaded. */
  namespace(): string;
  /** The gate as it stands now for `client` (applier, *Reason order*). */
  gate(client: string): Gate;
  /** What dispatch reads of a device for an action; undefined when it is not in the model. */
  target(id: string, action: string): DispatchTarget | undefined;
  /** An action's declarations as they stand, as a fingerprint (GA-DESC-18); none, a dispatch never refuses `declaration_changed`. */
  fingerprint?(id: string, action: string): string | undefined;
  /** Publishes a command; undefined when the applier has no bus (resolves `offline`). */
  command?(bridge: Bridge, device: string, body: Record<string, unknown>, expiryS: number): Promise<Puback>;
  /** What the broker made of a command to `bridge`: only a `0x87` refusal is the bridge's fault, a success clears it (GA-BUS-9). */
  published(bridge: string, refusedCode: number | undefined): void;
  /** Serves an event (and hands it to the writer). */
  emit(type: string, body: Record<string, unknown>): void;
  /** An attempt of a safety rule's run has its final outcome: the rule judges what it leaves to do (GA-SAFE-3, GA-SAFE-12). */
  stepEnded?(run: HeldApply, index: number): void;
  /** A `late_ack` of a safety rule's actuation that ended `failed`, by the step it acks (GA-SAFE-8). */
  lateAck?(ruleId: string, applyId: string, target: string, stepId: string): void;
  /** Whether a safety rule's run or a heating cap's still runs: it is held past its hour while it does (GA-SAFE-12, GA-LOAD-2). */
  running?(applyId: string): boolean;
  /** A client's step was dispatched: a latch's undo it is runs at its own tier again (GA-SAFE-7). */
  ran?(target: string, action: string, args: Record<string, unknown>): void;
  /** An open device's assumed state moved: only `fires-on-an-assumed-value` lets a rule read it (GA-SAFE-11). */
  assumedChanged?(device: string, keys: string[]): void;
  /** A heating cap's turn-off has its final outcome: the cap judges what it leaves to do (GA-LOAD-2). */
  capEnded?(run: HeldApply, index: number): void;
  /** A step was dispatched, at `dispatchedMs`: a witness of its action watches from then (GA-WIT-1). */
  dispatched?(applyId: string, run: Record<string, string>, stepId: string, target: string, action: string, args: Record<string, unknown>, dispatchedMs: number): void;
  /** Any dispatched step has its final outcome, from whichever apply or run: an open socket's on-time reads it (GA-LOAD-2). */
  ended?(target: string, action: string, outcome: Outcome["outcome"], dispatchedMs: number): void;
}

/**
 * A safety rule's actuation at dispatch (applier, *Safety rules*, *The applier's own actuations*): no
 * tier, token, `already` or request's refusal binds it, and it is always sent, never judged in place;
 * only what makes it impossible ends it first: a device or action gone, a device not adopted or dead,
 * args its device's declarations now refuse, which a client's step is refused for too, and an action
 * declared `toggles: true`, which the applier never sends on its own (GA-SAFE-13).
 */
export function judgeOwn(r: Requested, d: GateDevice | undefined): { verdict: "op" | "skip" | "refuse"; reason?: string } {
  const decl = d?.actions.get(r.action);
  if (!d) return { verdict: "skip", reason: "unknown_target" };
  if (!decl) return { verdict: "skip", reason: "unsupported_action" };
  if (!d.adopted) return { verdict: "refuse", reason: "not_adopted" };
  if (argsFault(r.action, r.args, decl.args, decl.confirmed_by) !== undefined) return { verdict: "refuse", reason: "invalid_args" };
  if (decl.toggles) return { verdict: "refuse", reason: "toggle_only" };
  if (d.liveness === "dead") return { verdict: "skip", reason: "dead" };
  return { verdict: "op" };
}

/**
 * How long past its bound a step still takes an ack (GA-BUS-4: "within the 1 s after it", since a
 * bridge on MQTT 3.1.1 counts the time from receipt), kept under GA-APPLY-8's 1 s, so that a step
 * nothing answered is `failed(no_ack)` no later than 1 s after its bound.
 */
export const ACK_GRACE_MS = 900;

/** How long after a step's `failed(no_ack)` a report matching its action is still a `late_ack` (GA-APPLY-11). */
export const LATE_ACK_MS = 60_000;

/**
 * A step's attempts in all, its first dispatch and its reissues (GA-APPLY-6), and the time between the
 * end of one attempt's bound and the next: the per-step retry deployed dispatchers run, "up to 3 attempts"
 * with 500 ms between them, here only once each attempt's bound has passed (GA-BUS-4).
 */
export const MAX_ATTEMPTS = 3;
export const REISSUE_GAP_MS = 500;

/**
 * Whether an action may be reissued at all (GA-APPLY-6): one whose effective declaration is idempotent,
 * on a closed device. An extension action never is, being declared not idempotent (GA-DESC-4).
 */
export function reissuable(target: Pick<DispatchTarget, "idempotent" | "feedback">): boolean {
  return target.idempotent && target.feedback === "closed";
}

/** A window in which a report on `key` moving towards the action is the apply's (applier, *Causes*). */
type Window = { command_id: string; target: string; action: string; args: Record<string, unknown>; cause: ApplyCause;
  until: number; closed: boolean; confirmed_by?: Waiting["confirmed_by"] };

/** What an action sets, as the step it is part of was dispatched with (GA-EVT-3). */
const setsOf = (x: { action: string; args: Record<string, unknown>; confirmed_by?: Waiting["confirmed_by"] }) =>
  sets(x.action, x.args, x.confirmed_by);

/**
 * A waiting step as memory holds it: its timer, and what waits on its PUBACK; the action as asked,
 * without its token, which a reissue is judged by again, and whether its device has since reported a
 * value moving away from it. Neither is kept across a restart, so a step that waited across one is
 * never reissued.
 */
type Live = Waiting & { timer?: number; published: boolean; pending?: Final; asked?: Requested; away?: boolean };

/** The reissues of a step that ended `failed(no_ack)`, while its late window stands (GA-APPLY-6). */
type Reissue = { late: Late; asked: Requested; attempts: number; away: boolean; timer?: number };

/**
 * An idempotency key a client is using (GA-APPLY-4, GA-APPLY-10), on `core/keys.ts` (its scope the
 * client, its record the apply id): the body it came with, and its apply once that is kept.
 */
export type Claim = KeyClaim<string>;

const FINAL = new Set<Outcome["outcome"]>(["skipped", "refused", "unreachable", "acked", "delivered", "sent", "unanswered", "failed"]);
const tokenKey = (issuer: string, tokenId: string) => `${issuer}\u0000${tokenId}`;

/**
 * Apply and dispatch (applier, *Apply and outcomes*): each step re-judged at dispatch, published in
 * request order once the one before it has its PUBACK, its token used only when it is dispatched,
 * and its final outcome from its acks, its reports, its bound and its bridge's death, by the rules
 * in `rules.ts`. Each method is one step: synchronous and in memory, but `apply`, which awaits the
 * used tokens' commit and each PUBACK between its steps. What must be kept goes to the writer behind.
 */
export class Dispatcher {
  /** Each apply held for `outcome`, 3600 s (GA-PERSIST-1). */
  private readonly applies = new Map<string, HeldApply>();
  /**
   * Each dispatched step still waiting for its final outcome, by its command's id. Until its PUBACK,
   * `published` is false and a final outcome it meets is held in `pending`: a success takes it, a
   * refusal drops it, since nothing was delivered (GA-BUS-9, GA-EVT-3).
   */
  private readonly waiting = new Map<string, Live>();
  /** The attribution windows, in dispatch order: the latest naming a key decides (applier, *Causes*). */
  private readonly windows = new Map<string, Window>();
  /** Each token used, until 3600 s after its use (GA-TOKEN-4). */
  private readonly used = new Map<string, number>();
  /** Each idempotency key in use, by client and key, while its apply is held (GA-APPLY-4). */
  private readonly keys: Keys<string>;
  /** Each step that ended `failed(no_ack)`, by its command's id, for the 60 s its `late_ack` may come in (GA-APPLY-11). */
  private readonly late = new Map<string, Late>();
  /** The steps that may still be reissued, by their first command's id (GA-APPLY-6). */
  private readonly reissues = new Map<string, Reissue>();
  /** The steps with a reissue sent, while their late window stands: the first command's `failed` ack no longer closes it. */
  private readonly reissued = new Set<string>();
  /** Each open device's assumed state, by device and key (GA-STATE-4). */
  private readonly assumed = new Map<string, Map<string, { value: unknown; basis_ms: number; seq: number }>>();
  /**
   * Each device's actions dispatched and not yet ended, in dispatch order, with the key each sets and
   * the value it asks for: a whole-state command takes them over the assumed state (GA-APPLY-16).
   */
  private readonly inflight = new Map<string, { command_id: string; key: string; value: unknown; seq: number }[]>();
  /**
   * The next dispatch's place among them, past every one the store still holds (GA-APPLY-16): commands
   * and assumed values are ordered by it, not by when their outcomes came.
   */
  private seq = 1;
  /**
   * Each held run's action slot, by apply id and index: how many commands for it a bridge may have seen.
   * A command is named by that count, not by the attempt: an attempt ended before it was published
   * (`skipped(dead)`, refused at dispatch) sent nothing, so the next command is still the same one, and
   * a firing a crash lost, fired again on a device dead until its bridge is heard, sends its first
   * command under the first life's id (the maintainer's ruling 2).
   */
  private readonly published = new Map<string, number>();
  /** Under `assumes-a-failed-write`, what `state` shows of a write that failed. */
  private readonly shown = new Map<string, Map<string, { value: unknown; basis_ms: number }>>();

  constructor(private readonly o: DispatchPorts) {
    this.keys = new Keys<string>(() => this.now());
  }

  /**
   * The id of the command or run `name` names, in the install's namespace: the same command gets the
   * same id in every life (the maintainer's ruling 2), so a bridge drops one sent again after a crash
   * (GA-BRIDGE-4). `draws-a-fresh-command-id`: a random one, as before slice 7b.
   */
  private idOf(name: string): string {
    return this.o.mutation === "draws-a-fresh-command-id" ? randomUUID() : uuidV5(name, this.o.namespace());
  }

  /** The applier's clock in whole ms: a test clock's time is fractional, and the store keeps bigint ms. */
  private now(): number {
    return Math.floor(this.o.clock.now());
  }

  /** The waiting rows `load` read, which `resume` arms. */
  private loaded: { w: Waiting; deadline_ms: number }[] = [];

  /**
   * Reads what a restart keeps into memory, and nothing else: held applies, used tokens, late acks,
   * assumed state and the waiting rows; no step is judged, no timer armed (GA-PERSIST-1).
   */
  async load(): Promise<void> {
    const now = this.now();
    const r = await loadRecords(this.o.store, now);
    for (const a of r.applies) {
      this.applies.set(a.apply_id, a);
      // A run's slots count on from the commands its record says were published, never from its
      // attempts: an attempt ended before it was published sent nothing, and counting it would give a
      // command a crash lost a new id (the 7b preflight's I2). A waiting row may know of a later one.
      if (a.pubs) a.pubs.forEach((n, i) => this.published.set(slotOf(a.apply_id, i), n));
      // Loaded oldest first: a key used again after its 3600 s names its latest apply.
      // `forgets-an-idempotency-key`: a key's apply is held, the key not.
      if (a.idempotency_key !== undefined && a.body !== undefined && this.o.mutation !== "forgets-an-idempotency-key") {
        this.keys.hold(a.client, a.idempotency_key, a.body, a.apply_id, a.created_ms);
      }
    }
    // `forgets-a-used-token`: the tokens used before the restart are not read back.
    if (this.o.mutation !== "forgets-a-used-token") for (const u of r.used) this.used.set(tokenKey(u.issuer, u.token_id), u.until_ms);
    for (const l of r.late) if (this.applies.has(l.apply_id)) this.late.set(l.command_id, l);
    // `sends-a-bare-setpoint`: the assumed state is not read back (applier, *Negative subjects*).
    if (this.o.mutation !== "sends-a-bare-setpoint") for (const x of r.assumed) {
      this.held(this.assumed, x.device).set(x.key, { value: x.value, basis_ms: x.basis_ms, seq: x.source_seq });
      this.seq = Math.max(this.seq, x.source_seq + 1);
    }
    for (const { w } of r.waiting) {
      this.seq = Math.max(this.seq, (w.seq ?? 0) + 1);
      const i = Number(/^s(\d+)/.exec(w.step_id)?.[1] ?? 0) - 1;
      if (w.pub !== undefined && i >= 0) {
        const slot = slotOf(w.apply_id, i);
        this.published.set(slot, Math.max(this.published.get(slot) ?? 0, w.pub));
      }
    }
    // `forgets-an-ack-deadline`: the steps waiting before the restart are not read back.
    this.loaded = this.o.mutation === "forgets-an-ack-deadline" ? [] : r.waiting;
  }

  /**
   * Every module has loaded: each waiting step waits again for its deadline, kept on the applier's
   * clock, and a step still `dispatched` with no waiting row ends `failed(no_ack)` (slice 4b), its
   * hooks now reaching modules that hold their rows.
   */
  resume(): void {
    for (const { w } of this.loaded) {
      // Its apply is gone: nothing could read it (a delete written behind was lost).
      if (!this.applies.has(w.apply_id)) {
        void this.o.store.write((tx) => dropWaiting(tx, w.command_id));
        continue;
      }
      // Its command may have been published before the stop: it waits as one that was.
      const live: Live = { ...w, published: true };
      this.waiting.set(w.command_id, live);
      this.fly(live);
      this.openWindow(live);
      this.arm(live);
    }
    this.loaded = [];
    // `forgets-an-ack-deadline`: a step whose deadline is forgotten is never ended.
    if (this.o.mutation === "forgets-an-ack-deadline") return;
    // A step still `dispatched` with no waiting row was published, or not, by a process that died before
    // its row landed: nothing says it acted, and nothing will answer it here (GA-APPLY-8, GA-PERSIST-1).
    const rows = new Set([...this.waiting.values()].map((w) => `${w.apply_id}\u0000${w.step_id}`));
    for (const a of this.applies.values()) {
      a.outcomes.forEach((x, i) => {
        if (x.outcome === "dispatched" && !rows.has(`${a.apply_id}\u0000${x.step_id}`)) this.settle(a, i, { outcome: "failed", reason: "no_ack" });
      });
    }
  }

  stop(): void {
    for (const w of this.waiting.values()) if (w.timer !== undefined) this.o.clock.clear(w.timer);
    for (const x of this.reissues.values()) if (x.timer !== undefined) this.o.clock.clear(x.timer);
  }

  /** An open device's assumed state as `state` gives it, each value marked `assumed` (GA-STATE-4). */
  assumedState(device: string): { key: string; value: unknown; basis_time: string; assumed: true }[] {
    const values = new Map([...this.assumed.get(device) ?? [], ...this.shown.get(device) ?? []]);
    return [...values].map(([key, x]) => ({ key, value: x.value, basis_time: iso(x.basis_ms), assumed: true as const }));
  }

  /** An open device's assumed value of `key`, or undefined. */
  assumedValue(device: string, key: string): unknown {
    return this.assumed.get(device)?.get(key)?.value;
  }

  /** Whether `(issuer, token_id)` was used and is still remembered (GA-TOKEN-2, GA-TOKEN-4). */
  isUsed(issuer: string, tokenId: string): boolean {
    return (this.used.get(tokenKey(issuer, tokenId)) ?? -Infinity) > this.now();
  }

  /** `outcome` (applier, *Operations*): the apply's outcomes as they are now, to the client that made it only. */
  outcome(client: string, applyId: string): { apply_id: string; outcomes: Outcome[] } | undefined {
    const a = this.applies.get(applyId);
    if (!a || a.client !== client || a.created_ms + HELD_MS <= this.now()) return undefined;
    return { apply_id: a.apply_id, outcomes: a.outcomes.map((x) => ({ ...x })) };
  }

  /**
   * An idempotency key as an apply finds it (GA-APPLY-4, GA-APPLY-10), in one step: `held`, the apply
   * the client made with it in the last 3600 s, with the same body, once that apply has returned; `wait`,
   * while the apply that claimed it still runs, kept or not; or `new`, claimed now for this apply, which `release` gives up unless it was kept.
   * The same key with another body is `idempotency_conflict`, while the key is in use either way.
   */
  claim(client: string, key: string, body: string): { kind: "held"; apply_id: string } | { kind: "wait"; done: Promise<void> }
    | { kind: "new"; claim: Claim } {
    // Kept, but its apply still running (its PUBACKs out): a repeat waits for what the first returns.
    const c = this.keys.claim(client, key, body);
    return c.kind === "held" ? { kind: "held", apply_id: c.record } : c;
  }

  /** The apply that claimed `c` returned or failed: an apply waiting on it goes on, and a key never kept is free again. */
  release(c: Claim): void {
    this.keys.release(c);
  }

  /**
   * `apply` of `steps`, as planned for `client`, `requested[i]` being step i's action (GA-PLAN-2),
   * under the idempotency key `claim` holds. The tokens it will use are reserved in memory at once, so
   * applies running at once never use one twice; they are committed with the apply and its key before
   * any step is dispatched; the store not keeping them within 10 s is `StoreUnavailable`, and nothing
   * is dispatched or told (GA-TOKEN-4, GA-APPLY-4). An `inline` request is planned in the same call,
   * judged only at dispatch: its `dead` target is `skipped(dead)`, as a planned one is.
   */
  async apply(client: string, steps: Step[], requested: Requested[], inline = false, claim?: Claim): Promise<{ apply_id: string; outcomes: Outcome[] }> {
    const now = this.now();
    // Each step's declarations as the plan saw them: a plan of an older revision is stale_revision before
    // this, and nothing has awaited since it was checked, so these are the plan's (GA-DESC-18).
    const basis = requested.map((r) => this.o.fingerprint?.(r.target, r.action));
    const a: HeldApply = { apply_id: randomUUID(), client, created_ms: now, outcomes: [],
      ...(claim ? { idempotency_key: claim.key, body: claim.body } : {}) };
    const live = steps.map((s) => inline || s.verdict === "op" || s.reason === "already");
    // Each live step's outcome before it has one: `dispatched` with no time, served as it is only after
    // a restart that met it with no waiting row, which `load` then ends. A step planned `skip` or
    // `refuse`, but for `already`, keeps its plan's reason (applier, *Outcomes*), told once the apply is kept.
    a.outcomes = steps.map((s, i) => live[i] ? { step_id: s.step_id, target: s.target, outcome: "dispatched" }
      : { step_id: s.step_id, target: s.target, outcome: s.verdict === "skip" ? "skipped" : "refused",
        ...(s.reason !== undefined ? { reason: s.reason } : {}), time: iso(now) });
    // Reserved now, in memory: an apply running beside this one finds them used.
    const gate = this.o.gate(client);
    const reserved = new Map<number, { issuer: string; token_id: string }>();
    steps.forEach((_, i) => {
      const r = requested[i]!;
      const t = r.token as { issuer?: unknown; token_id?: unknown } | undefined;
      if (!live[i] || !t || !tokenStands(r, gate) || typeof t.issuer !== "string" || typeof t.token_id !== "string") return;
      // Held already, by an apply running beside this one or by a step before this one: not this step's.
      if (this.isUsed(t.issuer, t.token_id)) return;
      this.used.set(tokenKey(t.issuer, t.token_id), now + HELD_MS);
      reserved.set(i, { issuer: t.issuer, token_id: t.token_id });
    });
    const tokens = [...reserved.values()];
    const row = { ...a, outcomes: a.outcomes.map((x) => ({ ...x })) };
    const kept = this.o.store.write(async (tx) => {
      for (const t of tokens) await useToken(tx, t.issuer, t.token_id, now + HELD_MS);
      await saveApply(tx, row);
    });
    try {
      // `uses-a-token-behind`: the apply and its tokens are written behind its dispatch, as a step's other records are.
      if (this.o.mutation === "uses-a-token-behind") void kept.catch(() => undefined);
      else await within(this.o.clock, GATE_MS, kept);
    } catch (err) {
      // Not kept in time: none of them is used, and the key is not held. A write that lands later only
      // keeps them used and the apply held, its steps ended failed(no_ack) by the next start: the safe way.
      for (const t of tokens) this.releaseToken(t, false);
      throw err;
    }
    this.applies.set(a.apply_id, a);
    if (claim) this.keys.kept(claim, a.apply_id, now);
    steps.forEach((_, i) => { if (!live[i]) this.tell(a, i); });
    for (let i = 0; i < steps.length; i++) {
      if (!live[i]) continue;
      await this.dispatch(a, i, requested[i]!, reserved.get(i), inline, basis[i]);
    }
    this.save(a);
    return { apply_id: a.apply_id, outcomes: a.outcomes.map((x) => ({ ...x })) };
  }

  /**
   * A safety rule fires (applier, *Safety rules*): its actions dispatched in order through the same
   * steps as a client's apply, under no client, with cause `{ safety_rule }` (GA-SAFE-1, GA-SAFE-2).
   * Held at once, so its run guards its devices from now; written behind, never awaited: a rule does not
   * wait on the store to close a valve. Returns the run. Its id is named by its rule and the report that
   * made the trigger true (`cause`), which a rule fires on at most once (GA-SAFE-11): a firing a crash
   * lost, fired again on the same report, is the same run, and sends the same commands (the maintainer's ruling 2).
   * A run already held under that id and still in flight is that run: it is returned, and nothing is
   * dispatched again. One whose steps are all final is an earlier firing on the same basis (its trigger
   * false and true again with no newer report of the keys it read): this firing is the next name's.
   */
  actuate(ruleId: string, actions: { target: string; action: string; args?: Record<string, unknown> }[],
    cause: { device: string; basis: number }): HeldApply {
    const now = this.now();
    const named = this.named(`rule/${ruleId}/${cause.device}/${Math.floor(cause.basis)}`);
    if ("held" in named) return named.held;
    const { apply_id } = named;
    const a: HeldApply = { apply_id, client: "", rule_id: ruleId, created_ms: now,
      outcomes: actions.map((x, i) => ({ step_id: `s${i + 1}`, target: x.target, outcome: "dispatched" })) };
    this.applies.set(a.apply_id, a);
    this.save(a);
    const requested: Requested[] = actions.map((x) => ({ target: x.target, action: x.action, args: x.args ?? {}, via: "app", brain: false,
      for: { safety_rule: ruleId } } as unknown as Requested));
    void (async () => {
      for (let i = 0; i < requested.length; i++) await this.dispatch(a, i, requested[i]!, undefined, true);
      this.save(a);
    })().catch((err: unknown) => console.error(`applier bug: safety rule ${ruleId}'s dispatch threw: ${String(err)}`));
    return a;
  }

  /**
   * A heating cap's turn-off (applier, *Loads*, GA-LOAD-2): the socket's `onoff.turn_off` dispatched as a
   * safety rule's actuation is, under no client, judged at dispatch by `judgeOwn`, with cause
   * `load_cap`; held at once and written behind. Returns its run, one step. Its id is named by the
   * socket, the on-time it ends (`since`) and the cap's attempt on it (the maintainer's ruling 2); a run already
   * held under that id and still in flight is returned, and nothing is dispatched again; one whose step
   * is final is never handed back as new: this attempt is the next name's.
   */
  capOff(device: string, since: number, attempt: number): HeldApply {
    const named = this.named(`cap/${device}/${Math.floor(since)}/${attempt}`);
    if ("held" in named) return named.held;
    const { apply_id } = named;
    const a: HeldApply = { apply_id, client: "", load_cap: device, created_ms: this.now(),
      outcomes: [{ step_id: "s1", target: device, outcome: "dispatched" }] };
    this.applies.set(a.apply_id, a);
    this.save(a);
    const r = { target: device, action: "onoff.turn_off", args: {}, via: "app", brain: false, for: { load_cap: device } } as unknown as Requested;
    void this.dispatch(a, 0, r, undefined, true).then(() => this.save(a))
      .catch((err: unknown) => console.error(`applier bug: the heating cap's turn-off of ${device} threw: ${String(err)}`));
    return a;
  }

  /**
   * A safety rule's actuation sent again (GA-SAFE-12): attempt `attempt` of action `i` takes the
   * action's slot in the run, under a new step id (`s1.2`), dispatched as the first was, judged at
   * dispatch by `judgeOwn`. No client reads a run's outcomes through `outcome`; each attempt's outcome
   * is its own `outcome` event, and the run keeps the last attempt's, which the rule completes with.
   */
  resendStep(applyId: string, i: number, action: { target: string; action: string; args?: Record<string, unknown> }, attempt: number): void {
    const a = this.applies.get(applyId);
    if (!a || a.rule_id === undefined || i >= a.outcomes.length) return;
    a.outcomes[i] = { step_id: `s${i + 1}.${attempt}`, target: action.target, outcome: "dispatched" };
    this.save(a);
    const r = { target: action.target, action: action.action, args: action.args ?? {}, via: "app", brain: false,
      for: { safety_rule: a.rule_id } } as unknown as Requested;
    void this.dispatch(a, i, r, undefined, true).then(() => this.save(a))
      .catch((err: unknown) => console.error(`applier bug: safety rule ${a.rule_id}'s re-send threw: ${String(err)}`));
  }

  /**
   * The id of an own run named `name`: the run held under it while any of its steps is in flight, or
   * else the first of `name`, `name/2`, … that no run holds or whose holder is still in flight. A held
   * run whose steps are all final is never handed back as a new run's (the preflight's I1): a cap or a
   * firing that derives it again would wait on a run that will never end.
   */
  private named(name: string): { held: HeldApply } | { apply_id: string } {
    for (let n = 1; ; n++) {
      const apply_id = this.idOf(n > 1 ? `${name}/${n}` : name);
      const held = this.applies.get(apply_id);
      if (!held) return { apply_id };
      if (held.outcomes.some((o) => o.outcome === "dispatched")) return { held };
    }
  }

  /**
   * A start found attempt `attempt` of a rule's run's action `i` kept above the step its record holds
   * (its outcome's write lost to a crash): the slot is that attempt's step again, `dispatched`. Its
   * waiting row, where one was kept, ends it; with none, it ends `failed(no_ack)` at once: it may have
   * been published (the maintainer's ruling 1; the 7b preflight's I2). Once, at the safety rules' resume.
   */
  takeUp(applyId: string, i: number, attempt: number): void {
    const a = this.applies.get(applyId);
    const x = a?.outcomes[i];
    if (!a || !x) return;
    const step_id = attempt > 1 ? `s${i + 1}.${attempt}` : `s${i + 1}`;
    a.outcomes[i] = { step_id, target: x.target, outcome: "dispatched" };
    const waits = [...this.waiting.values()].some((w) => w.apply_id === applyId && w.step_id === step_id);
    if (!waits) this.settle(a, i, { outcome: "failed", reason: "no_ack" });
  }

  /** A held apply or safety rule's run, as it is now. */
  heldApply(applyId: string): HeldApply | undefined {
    return this.applies.get(applyId);
  }

  /**
   * One step at dispatch (GA-APPLY-9): judged again as things stand now, its own reserved token not
   * counted as used, then published, and its PUBACK awaited before the next (GA-PLAN-7).
   */
  private async dispatch(a: HeldApply, i: number, r: Requested, token: { issuer: string; token_id: string } | undefined,
    inline: boolean, basis?: string): Promise<void> {
    const step = a.outcomes[i]!;
    const gate = this.o.gate(a.client);
    const mine = token && tokenKey(token.issuer, token.token_id);
    // `toggles-to-reach-a-state` is the planner's fault (GA-PLAN-8), which the manifest couples to no
    // other id: the judge at dispatch keeps the true rule.
    const mutation = gate.mutation === "toggles-to-reach-a-state" ? undefined : gate.mutation;
    // The applier's own actuation, a safety rule's or a heating cap's: no tier, token or request's refusal binds it.
    const own = a.rule_id !== undefined || a.load_cap !== undefined;
    const j: { verdict: string; reason?: string; tier?: string } = own ? judgeOwn(r, gate.device(r.target))
      : judge(step.step_id, r, { ...gate, mutation, used: (issuer, id) => tokenKey(issuer, id) !== mine && gate.used(issuer, id) });
    const target = this.o.target(r.target, r.action);
    // A token is dispatched at most once, whatever the token check said (GA-TOKEN-4): one this step did
    // not reserve, and another holds, is no token for an action that needs one.
    const t = r.token as { issuer?: unknown; token_id?: unknown } | undefined;
    if (j.verdict === "op" && j.tier !== "reversible" && !token && t && typeof t.issuer === "string" && typeof t.token_id === "string"
      && this.isUsed(t.issuer, t.token_id)) {
      j.verdict = "refuse";
      j.reason = "token";
    }
    // Its action's declarations changed since the plan (GA-DESC-18): refused, before every reason those
    // declarations could move (already, unsupported_action, toggle_only, the token), so a changed step is
    // never told as a success. Only what does not hang on them outranks it: not_adopted, safety, latched
    // and dead (the controller's ruling on the preflight's B1).
    if (basis !== undefined && this.o.fingerprint?.(r.target, r.action) !== basis && this.o.mutation !== "dispatches-a-changed-step") {
      const d = gate.device(r.target);
      const first = j.verdict !== "op" && j.reason !== undefined && OUTRANKS_A_CHANGE.has(j.reason) ? undefined
        : d && !d.adopted ? { verdict: "refuse" as const, reason: "not_adopted" as const }
        : d && d.liveness === "dead" ? { verdict: "skip" as const, reason: "dead" as const }
        : { verdict: "refuse" as const, reason: "declaration_changed" as const };
      if (first) {
        j.verdict = first.verdict;
        j.reason = first.reason;
      }
    }
    if (j.verdict !== "op" || !target) {
      if (token) this.releaseToken(token, true);
      // A plan's `op` whose target died since is `unreachable` (GA-APPLY-5, GA-APPLY-9); an inline step's is
      // `skipped(dead)`, as its plan, made in the same call, says.
      const at = j.verdict === "op" ? { outcome: "skipped" as const, reason: "unknown_target" }
        : j.reason === "dead" && !inline ? { outcome: "unreachable" as const }
        : { outcome: j.verdict === "skip" ? "skipped" as const : "refused" as const, ...(j.reason !== undefined ? { reason: j.reason } : {}) };
      this.settle(a, i, at);
      return;
    }
    const now = this.now();
    // Named by its run, its action and how many commands for it a bridge may have seen (`s1`, then `s1.2`):
    // the same command the same id, a deliberate new attempt that is sent a new one (the maintainer's ruling 2).
    const slot = slotOf(a.apply_id, i);
    const n = (this.published.get(slot) ?? 0) + 1;
    this.published.set(slot, n);
    // Recorded with the run, written behind as the run is. Counted before the publish, a record may count a
    // command never delivered (a name skipped); one a crash lost counts less, and its command is sent
    // again under the same name, which the bridge drops (GA-BRIDGE-4).
    if (own) (a.pubs ??= a.outcomes.map(() => 0))[i] = n;
    const command_id = this.idOf(`${a.apply_id}/s${i + 1}${n > 1 ? `.${n}` : ""}`);
    const kind: StepKind = { feedback: target.feedback, stateless: target.stateless, confirms: target.confirms };
    const resultWithinMs = Math.round(target.ack_within_s * 1000);
    const { token: _t, ...asked } = r;
    const args = r.args as Record<string, unknown>;
    const { body, expiryS, state } = this.command(command_id, now, r.target, r.action, args, target);
    const w: Live = { published: false, command_id, apply_id: a.apply_id, step_id: step.step_id, target: r.target, action: r.action,
      args, ...(own ? { pub: n } : {}), bridge: target.bridge.id, bridge_device: target.bridge_device, kind,
      cause: a.rule_id !== undefined ? { safety_rule: a.rule_id } : a.load_cap !== undefined ? { load_cap: a.load_cap }
        : { apply: a.apply_id, client: a.client, for: r.for }, dispatched_ms: now, bound_ms: now + resultWithinMs, terminal: false, seq: this.seq++,
      ...(token ? { token } : {}), ...(state ? { state } : {}), ...(target.confirmed_by ? { confirmed_by: target.confirmed_by } : {}),
      idempotent: target.idempotent, ...(basis !== undefined ? { fingerprint: basis } : {}), asked };
    // Waiting before it is published, and kept before it, so a restart finds every step that may have
    // been sent (GA-PERSIST-1); an ack or a report may come before the PUBACK does, and waits on it.
    this.waiting.set(command_id, w);
    this.supersede(w);
    this.openWindow(w);
    this.arm(w);
    this.keep(w);
    const send = () => this.o.command?.(target.bridge, target.bridge_device, body, expiryS) ?? Promise.resolve<Puback>({ kind: "offline" });
    const p = await send();
    w.published = true;
    if (p.kind === "ok" || p.kind === "lost") {
      if (p.kind === "ok") this.o.published(target.bridge.id, undefined);
      // Dispatched, its token used whatever follows (GA-TOKEN-4); a lost PUBACK is never sent again (GA-BUS-9).
      this.settle(a, i, { outcome: "dispatched" });
      this.o.dispatched?.(a.apply_id, this.runOf(a.apply_id), step.step_id, r.target, r.action, args, w.dispatched_ms);
      if (!own) this.o.ran?.(r.target, r.action, args);
      this.fly(w);
      // What it met before its PUBACK counts now.
      const pending = w.pending;
      w.pending = undefined;
      if (pending) this.end(w, pending);
      if (this.o.mutation === "reissues-inside-the-bound") this.o.clock.setTimeout(() => {
        if (this.waiting.get(command_id)?.terminal === false) void send();
      }, 1000);
      if (this.o.mutation === "resends-after-reconnect" && p.kind === "lost") this.resend.push(() => void send());
      return;
    }
    // Nothing was delivered: unreachable, the token unused, and whatever it met before is no one's (GA-BUS-9).
    if (p.kind === "refused") this.o.published(target.bridge.id, p.code);
    w.pending = undefined;
    delete w.detail;
    if (this.end(w, { outcome: "unreachable" }) && token) this.releaseToken(token, true);
  }

  /**
   * A command's body (bridge, *Commands*), with a whole-state action's `state` (GA-APPLY-16), and its
   * Message Expiry: never past its result_within_s (GA-BUS-5), and at least the 1 s MQTT can say.
   */
  private command(commandId: string, now: number, device: string, action: string, args: Record<string, unknown>, target: DispatchTarget):
    { body: Record<string, unknown>; expiryS: number; state?: Record<string, unknown> } {
    const resultWithinMs = Math.round(target.ack_within_s * 1000);
    const value = commandValue(action, args, { from: target.from || this.o.mutation === "sends-from-to-an-old-bridge" });
    const state = target.whole_state ? this.frame(device, action, args, target.confirmed_by) : undefined;
    const body = { commandId, issuedAt: iso(now), resultWithinMs,
      value: { action, ...(value !== undefined ? { value } : {}), ...(state ? { state } : {}) } };
    return { body, expiryS: Math.max(1, Math.floor(resultWithinMs / 1000)), ...(state ? { state } : {}) };
  }

  /**
   * A whole-state command's `state` (GA-APPLY-16): the device's assumed value of every key it holds
   * one for, each key an earlier action still in flight sets taking the latest such action's value,
   * from any apply, and the action's own key the value it asks for. Nothing waits for an earlier step
   * to end; one that ended `failed` or `unreachable` is no longer in flight.
   */
  private frame(device: string, action: string, args: Record<string, unknown>, confirmedBy?: Waiting["confirmed_by"]): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    const from = new Map<string, number>();
    for (const [key, x] of this.assumed.get(device) ?? []) {
      state[key] = x.value;
      from.set(key, x.seq);
    }
    // In dispatch order; an action in flight dispatched before the assumed value's own command is older than it.
    if (this.o.mutation !== "sends-the-old-mode") {
      for (const x of this.inflight.get(device) ?? []) {
        if ((from.get(x.key) ?? -1) > x.seq) continue;
        state[x.key] = x.value;
        from.set(x.key, x.seq);
      }
    }
    const own = sets(action, args, confirmedBy);
    if (own?.value !== undefined) state[own.key] = own.value;
    return state;
  }

  /** A step is dispatched: the value its action asks for is in flight on its device (GA-APPLY-16). */
  private fly(w: Live): void {
    const own = setsOf(w);
    if (own?.value === undefined) return;
    this.held(this.inflight, w.target, () => []).push({ command_id: w.command_id, key: own.key, value: own.value, seq: w.seq ?? 0 });
  }

  /**
   * What a step's end does to its device's state (GA-STATE-4, GA-APPLY-16): it is no longer in flight;
   * on an open device, `sent` or `unanswered` assumes the value its action asks for, and every key its
   * whole-state command carried, while `unreachable` and `failed` change nothing; an outcome not
   * taken, the step having one already, changes nothing either. A key a command dispatched after this
   * one set already is not this one's (GA-APPLY-16). Returns the rows to keep, which `end` writes
   * with the outcome.
   */
  private assume(w: Live, f: Final, took: boolean): Assumed[] {
    const m = this.o.mutation;
    const failed = f.outcome === "failed" || f.outcome === "unreachable";
    const flying = this.inflight.get(w.target);
    if (flying && !(failed && m === "keeps-a-failed-mode")) {
      const rest = flying.filter((x) => x.command_id !== w.command_id);
      if (rest.length) this.inflight.set(w.target, rest);
      else this.inflight.delete(w.target);
    }
    if (!took || w.kind.feedback !== "open") return [];
    const own = setsOf(w);
    const now = this.now();
    if (failed) {
      if (m === "assumes-a-failed-write" && own?.value !== undefined) this.held(this.shown, w.target).set(own.key, { value: own.value, basis_ms: now });
      return [];
    }
    if (f.outcome === "unanswered" && m === "forgets-the-unanswered") return [];
    if (f.outcome !== "sent" && f.outcome !== "unanswered") return [];
    const values: Record<string, unknown> = w.state && m !== "forgets-what-the-frame-said" ? { ...w.state } : {};
    if (own?.value !== undefined) values[own.key] = own.value;
    const seq = w.seq ?? 0;
    const held = this.held(this.assumed, w.target);
    const rows: Assumed[] = Object.entries(values)
      .filter(([key]) => (held.get(key)?.seq ?? -1) <= seq)
      .map(([key, value]) => ({ device: w.target, key, value, basis_ms: now, source_seq: seq }));
    for (const r of rows) held.set(r.key, { value: r.value, basis_ms: r.basis_ms, seq });
    if (rows.length) this.o.assumedChanged?.(w.target, rows.map((r) => r.key));
    return rows;
  }

  /** Devices the owner forgot: their assumed state is no one's (GA-STATE-4); the forget's write set drops its rows. */
  forget(devices: string[]): void {
    for (const d of devices) {
      this.assumed.delete(d);
      this.shown.delete(d);
    }
  }

  /** `map`'s entry for `key`, made empty if it has none. */
  private held<V>(map: Map<string, V>, key: string, make: () => V = () => new Map() as V): V {
    let v = map.get(key);
    if (v === undefined) map.set(key, v = make());
    return v;
  }

  /** Under `resends-after-reconnect`, the commands whose PUBACK the lost connection took. */
  private resend: (() => void)[] = [];

  /** The broker is back: `resends-after-reconnect` sends again what it lost (GA-BUS-9 forbids it). */
  listening(): void {
    for (const f of this.resend.splice(0)) f();
  }

  /**
   * An ack from `bridge` on `devices/{device}/ack`. Taken only for a command sent to that bridge: a
   * folded copy's bridge was sent nothing, so its acks are no one's (GA-BUS-11). One on another
   * device's topic is a fault, and no ack. Returns the bridge's faults.
   */
  ack(bridge: string, device: string, ack: Ack): string[] {
    const w = this.waiting.get(ack.command_id);
    if (!w) {
      this.lateAck(bridge, device, ack);
      return [];
    }
    if (w.bridge !== bridge) return [];
    if (w.bridge_device !== device) return [`an ack on devices/${device}/ack for a command sent to ${w.bridge_device}`];
    const e = onAck(w.kind, ack, this.o.mutation === "acks-without-state");
    if (e.kind === "ignore") return [];
    // The first terminal ack is the one taken; a second is a duplicate (GA-BUS-6).
    if (w.terminal) return [];
    w.terminal = true;
    if (ack.detail !== undefined && this.o.mutation !== "drops-the-ack-detail") w.detail = ack.detail;
    if (e.kind === "wait") {
      this.keep(w);
      return e.fault ? [e.fault] : [];
    }
    if (!e.acted) this.closeWindow(w.command_id);
    this.end(w, e.final);
    if (e.final.outcome === "unreachable" && w.token && this.o.mutation === "reuses-token-after-late-unreachable") this.releaseToken(w.token, true);
    return [];
  }

  /**
   * A terminal ack for a step that already ended `failed(no_ack)`, its late window open: one saying the
   * device did not act (a `failed` other than one that may have acted, or `unsupported`) closes the
   * window, so a later match is someone else's change, `external` (applier, *Outcomes*, GA-BRIDGE-7).
   * Its outcome stays.
   */
  private lateAck(bridge: string, device: string, ack: Ack): void {
    const l = this.late.get(ack.command_id);
    if (!l) return;
    const target = this.o.target(l.target, l.action);
    if (!target || target.bridge.id !== bridge || target.bridge_device !== device) return;
    const e = onAck({ feedback: "closed", stateless: false, confirms: target.confirms }, ack);
    // A reissue that went out may have acted: its window stays.
    if (e.kind === "final" && !e.acted && !this.reissued.has(l.command_id)) this.endLate(l);
  }

  /**
   * A reading of `target` (applier, *Causes*, *Outcomes*). A changed value moving towards a dispatched
   * action's, inside its window, is that apply's: the latest window naming the key decides; `own` when
   * the key is the one the action sets, not a side effect (GA-EVT-1, GA-EVT-6). A value that matches a
   * waiting step's acks it (GA-EVT-3) and ends its window: judged by when it arrives, after the publish,
   * not by the bridge's clock; before the PUBACK, it waits on it.
   */
  reading(target: string, key: string, value: unknown, old: unknown, _basis: number, changed: boolean):
    { cause: Record<string, unknown> | string; own: boolean } | undefined {
    const now = this.now();
    let by: { cause: Record<string, unknown> | string; own: boolean } | undefined;
    if (changed) {
      for (const w of [...this.windows.values()].reverse()) {
        if (w.target !== target || w.closed || now >= w.until) continue;
        const s = setsOf(w);
        if (s?.key === key) {
          if (towards(s, value, old)) by = { cause: causeOf(w.cause), own: true };
          break;
        }
        const side = sideEffects(w.action).find((x) => x.key === key);
        if (side) {
          if (side.value === value) by = { cause: causeOf(w.cause), own: false };
          break;
        }
      }
    }
    // A report moving away from a waiting step's action: that step is never reissued (applier, *Reissue*).
    if (changed) {
      for (const w of this.windows.values()) {
        const s = setsOf(w);
        const step = this.waiting.get(w.command_id);
        if (step && w.target === target && !w.closed && s?.key === key && !towards(s, value, old)) step.away = true;
      }
    }
    for (const w of [...this.windows.values()]) {
      const s = setsOf(w);
      if (w.target !== target || w.closed || s?.key !== key || !s.matches(value)) continue;
      const step = this.waiting.get(w.command_id);
      this.closeWindow(w.command_id);
      if (step) this.end(step, { outcome: "acked" });
    }
    // A step that ended failed(no_ack) in the last 60 s, matched now: its late_ack, once, and a change
    // no window claims is its apply's, never external (GA-APPLY-11).
    for (const l of [...this.late.values()]) {
      const s = setsOf(l);
      if (l.target !== target || s?.key !== key || now >= l.until_ms) continue;
      if (!s.matches(value)) {
        const x = this.reissues.get(l.command_id);
        if (x && changed && !towards(s, value, old)) x.away = true;
        continue;
      }
      this.endLate(l);
      // A rule's step names its rule by its cause, which outlives its run: a run held past its hour may be pruned before its window ends.
      const rule = this.applies.get(l.apply_id)?.rule_id ?? ("safety_rule" in l.cause ? l.cause.safety_rule : undefined);
      this.o.emit("late_ack", { ...(rule !== undefined ? { rule_id: rule } : this.runOf(l.apply_id)), step_id: l.step_id, target, key, value,
        cause: causeOf(l.cause) });
      if (rule !== undefined) this.o.lateAck?.(rule, l.apply_id, target, l.step_id);
      if (changed && !by) by = { cause: causeOf(l.cause), own: true };
    }
    return by;
  }

  /** A late window ends: matched, or its 60 s over; its step is reissued no more. */
  private endLate(l: Late): void {
    if (this.late.get(l.command_id) !== l) return;
    this.late.delete(l.command_id);
    this.reissued.delete(l.command_id);
    this.stopReissue(l.command_id);
    void this.o.store.write((tx) => dropLate(tx, l.command_id));
  }

  /**
   * One reissue of a step that ended `failed(no_ack)` (applier, *Reissue*; the per-step retry above): only
   * an idempotent action (GA-APPLY-6), on a closed device, whose step used no token (a token is
   * dispatched at most once, GA-TOKEN-4), whose device has reported no value moving away from it, and
   * which the gate still lets through as it stands now; never inside an attempt's bound (GA-BUS-4); each
   * under a fresh command id, under the same apply, its whole bound inside the step's late window, so a
   * match it brings is that step's `late_ack` and its outcome never changes; at most `MAX_ATTEMPTS`
   * attempts in all. A broker that refuses it ends the reissues.
   */
  private reissue(x: Reissue): void {
    x.timer = undefined;
    const l = x.late;
    const now = this.now();
    const gate = this.o.gate(clientOf(l.cause) ?? "");
    const mutation = gate.mutation === "toggles-to-reach-a-state" ? undefined : gate.mutation;
    // A safety rule's actuation is never reissued but under `reissues-on-timeout`, which ignores the verdict (GA-SAFE-5).
    const j = clientOf(l.cause) === undefined ? judgeOwn(x.asked, gate.device(l.target)) : judge(l.step_id, x.asked, { ...gate, mutation });
    const target = this.o.target(l.target, l.action);
    const blind = this.o.mutation === "reissues-on-timeout";
    // Re-sent only where its declaration at dispatch and as it stands both say idempotent, and only on the
    // declarations it was dispatched on, so the bound, `already` and `confirmed_by` read here are its own (GA-DESC-18).
    const same = l.fingerprint === undefined || this.o.fingerprint?.(l.target, l.action) === l.fingerprint;
    const idempotent = (target !== undefined && reissuable(target) && l.idempotent !== false && same) || blind;
    if (this.reissues.get(l.command_id) !== x || x.away || (j.verdict !== "op" && !blind) || !target || !idempotent || target.feedback !== "closed"
      || now + Math.round(target.ack_within_s * 1000) + ACK_GRACE_MS > l.until_ms) {
      this.stopReissue(l.command_id);
      return;
    }
    x.attempts++;
    this.reissued.add(l.command_id);
    // "A reissue after the bound uses a fresh command_id" (GA-BUS-4): its own name, by its attempt.
    const commandId = this.idOf(`${l.command_id}/reissue/${x.attempts}`);
    // Its report moving towards the action, or showing a side effect, inside its bound, is the apply's (applier, *Causes*).
    this.windows.set(commandId, { command_id: commandId, target: l.target, action: l.action, args: l.args, cause: l.cause,
      until: now + Math.round(target.ack_within_s * 1000), closed: false, ...(l.confirmed_by ? { confirmed_by: l.confirmed_by } : {}) });
    const { body, expiryS } = this.command(commandId, now, l.target, l.action, l.args, target);
    void (this.o.command?.(target.bridge, target.bridge_device, body, expiryS) ?? Promise.resolve<Puback>({ kind: "offline" })).then((p) => {
      if (p.kind === "ok") this.o.published(target.bridge.id, undefined);
      if (p.kind === "refused") this.o.published(target.bridge.id, p.code);
      if (p.kind !== "ok" && p.kind !== "lost") this.stopReissue(l.command_id);
    });
    if (x.attempts >= MAX_ATTEMPTS) {
      this.reissues.delete(l.command_id);
      return;
    }
    x.timer = this.o.clock.setTimeout(() => this.reissue(x), Math.round(target.ack_within_s * 1000) + ACK_GRACE_MS + REISSUE_GAP_MS);
  }

  /**
   * A step is dispatched: a pending reissue on its device of the key it sets, or of a side effect it
   * has, is someone's older intent, and goes no more; its late window stays, so a report matching the
   * older step is still its `late_ack` (applier, *Reissue*, a later action as a move away).
   */
  private supersede(w: Waiting): void {
    const own = setsOf(w)?.key;
    const keys = new Set([...(own !== undefined ? [own] : []), ...sideEffects(w.action).map((x) => x.key)]);
    for (const [id, x] of this.reissues) {
      if (x.late.target === w.target && keys.has(setsOf(x.late)?.key ?? "")) this.stopReissue(id);
    }
  }

  private stopReissue(commandId: string): void {
    const x = this.reissues.get(commandId);
    if (!x) return;
    if (x.timer !== undefined) this.o.clock.clear(x.timer);
    this.reissues.delete(commandId);
  }

  /** `bridge` was found dead: each closed device's step waiting on it ends `failed(no_ack)` at once (GA-APPLY-8). */
  bridgeDead(bridge: string): void {
    for (const w of [...this.waiting.values()]) {
      if (w.bridge !== bridge) continue;
      const f = onBridgeDead(w.kind);
      if (f) this.end(w, f);
    }
  }

  /** Drops the applies, tokens and windows past their time, from memory and the store. */
  prune(): void {
    const now = this.now();
    // A safety rule's run, or a cap's, still running is held, past its hour, until it is complete (GA-SAFE-12, GA-LOAD-2).
    for (const [id, a] of this.applies) {
      if (a.created_ms + HELD_MS <= now && !((a.rule_id !== undefined || a.load_cap !== undefined) && this.o.running?.(id))) {
        this.applies.delete(id);
        a.outcomes.forEach((_, i) => this.published.delete(slotOf(id, i)));
      }
    }
    this.keys.prune(now);
    for (const [k, until] of this.used) if (until <= now) this.used.delete(k);
    for (const [id, w] of this.windows) if (w.until <= now) this.windows.delete(id);
    for (const [id, l] of this.late) {
      if (l.until_ms > now) continue;
      this.late.delete(id);
      this.reissued.delete(id);
      this.stopReissue(id);
    }
    void this.o.store.write((tx) => pruneRecords(tx, now), { droppable: true });
  }

  /** A window for a closed device's stateful action, from dispatch until its bound (applier, *Causes*). */
  private openWindow(w: Waiting): void {
    if (w.kind.feedback !== "closed" || w.kind.stateless || !setsOf(w)) return;
    this.windows.set(w.command_id, { command_id: w.command_id, target: w.target, action: w.action, args: w.args, cause: w.cause,
      until: w.bound_ms, closed: false, ...(w.confirmed_by ? { confirmed_by: w.confirmed_by } : {}) });
  }

  private closeWindow(commandId: string): void {
    const w = this.windows.get(commandId);
    if (w) w.closed = true;
  }

  /**
   * Times the step's bound, and the grace after it in which an ack still counts (GA-BUS-4): then a
   * closed device's is `failed(no_ack)`, an open one's `unanswered` (GA-APPLY-8). Its window for
   * causes still ends at the bound.
   */
  private arm(w: Live): void {
    w.timer = this.o.clock.setTimeout(() => {
      w.timer = undefined;
      if (this.waiting.get(w.command_id) !== w) return;
      if (this.o.mutation === "never-fails-a-silent-ack" && w.kind.feedback === "closed") return;
      this.end(w, onBound(w.kind));
    }, Math.max(0, w.bound_ms + ACK_GRACE_MS - this.now()));
  }

  /**
   * The step's final outcome, with the detail of the terminal ack taken (GA-APPLY-15); it waits no more.
   * Before its PUBACK it is held, the first one only, for the PUBACK to take or drop. Returns whether
   * the outcome was recorded now: the first final one wins. The outcome is written before the waiting
   * row is deleted, so a restart never finds a step neither waiting nor final.
   */
  private end(w: Live, f: Final): boolean {
    if (!w.published) {
      w.pending ??= f;
      return false;
    }
    // `unreachable` always means nothing was sent: no report is its.
    if (f.outcome === "unreachable") this.closeWindow(w.command_id);
    const a = this.applies.get(w.apply_id);
    const i = a?.outcomes.findIndex((x) => x.step_id === w.step_id) ?? -1;
    const took = a !== undefined && i >= 0 && this.settle(a, i, { ...f, ...(w.detail !== undefined ? { detail: w.detail } : {}) }, true);
    if (took) this.o.ended?.(w.target, w.action, f.outcome, w.dispatched_ms);
    // A closed device's stateful step that may have acted: a report matching it in the next 60 s is its late_ack (GA-APPLY-11).
    if (took && f.outcome === "failed" && f.reason === "no_ack" && w.kind.feedback === "closed" && setsOf(w)) {
      const l: Late = { command_id: w.command_id, apply_id: w.apply_id, step_id: w.step_id, target: w.target, action: w.action,
        args: w.args, cause: w.cause, until_ms: this.now() + LATE_ACK_MS, ...(w.confirmed_by ? { confirmed_by: w.confirmed_by } : {}),
        ...(w.idempotent !== undefined ? { idempotent: w.idempotent } : {}), ...(w.fingerprint !== undefined ? { fingerprint: w.fingerprint } : {}) };
      this.late.set(l.command_id, l);
      void this.o.store.write((tx) => saveLate(tx, l));
      // `reissues-on-timeout` is a naive retry: every step, its token and the gate's verdict ignored.
      // A safety rule's actuation is never reissued (GA-SAFE-5); GA-SAFE-12's re-send is the rule's own (slice 6b).
      const own = clientOf(w.cause) === undefined;
      if (w.asked && (own ? this.o.mutation === "reissues-on-timeout" : !w.token || this.o.mutation === "reissues-on-timeout") && !w.away) {
        const x: Reissue = { late: l, asked: w.asked, attempts: 1, away: false };
        this.reissues.set(l.command_id, x);
        // Never inside the first command's bound (GA-BUS-4), though its bridge was found dead before it.
        const at = Math.max(this.now(), w.bound_ms + ACK_GRACE_MS) + REISSUE_GAP_MS;
        x.timer = this.o.clock.setTimeout(() => this.reissue(x), at - this.now());
      }
    }
    // The outcome, what it makes assumed and the waiting row's delete go in one write set, so a restart
    // finds the step either waiting or final with its assumed values (GA-PERSIST-1).
    const row = took && a && this.applies.has(a.apply_id) ? { ...a, outcomes: a.outcomes.map((x) => ({ ...x })) } : undefined;
    const ending = this.waiting.get(w.command_id) === w;
    const rows = ending ? this.assume(w, f, took) : [];
    if (ending) {
      this.waiting.delete(w.command_id);
      if (w.timer !== undefined) this.o.clock.clear(w.timer);
    }
    if (row || ending) {
      void this.o.store.write(async (tx) => {
        if (row) await saveApply(tx, row);
        if (rows.length) await saveAssumed(tx, rows);
        if (ending) await dropWaiting(tx, w.command_id);
      });
    }
    return took;
  }

  /** Keeps a waiting step, written behind, so a restart resumes it (GA-PERSIST-1's pending ack deadlines). */
  private keep(w: Live): void {
    const { timer: _, published: _p, pending: _f, asked: _a, away: _w, ...row } = w;
    void this.o.store.write((tx) => saveWaiting(tx, row, w.bound_ms + ACK_GRACE_MS));
  }

  /**
   * A step's outcome: the first final one wins, and one a client may have read never changes. Served
   * as an `outcome` event, and the apply written behind, unless the caller writes it in its own write set.
   */
  private settle(a: HeldApply, i: number, f: { outcome: Outcome["outcome"]; reason?: string; detail?: string }, deferWrite = false): boolean {
    const x = a.outcomes[i]!;
    if (FINAL.has(x.outcome)) return false;
    const next: Outcome = { step_id: x.step_id, target: x.target, outcome: f.outcome, ...(f.reason !== undefined ? { reason: f.reason } : {}),
      ...(f.detail !== undefined ? { detail: f.detail } : {}), time: iso(this.now()), ...(x.witness !== undefined ? { witness: x.witness } : {}) };
    a.outcomes[i] = next;
    this.tell(a, i);
    if (this.applies.has(a.apply_id) && !deferWrite) this.save(a);
    // A rule's attempt that ended: the rule judges whether it is complete, or sends it again (GA-SAFE-3, GA-SAFE-12).
    if (a.rule_id !== undefined) this.o.stepEnded?.(a, i);
    // A cap's turn-off that ended: the cap judges whether it landed, or sends it again (GA-LOAD-2).
    if (a.load_cap !== undefined) this.o.capEnded?.(a, i);
    return true;
  }

  /**
   * A witness's verdict on a step (GA-WIT-1): kept beside the step's outcome, which never changes, so
   * `outcome` serves it; its own `outcome` event is the witness's to serve.
   */
  witnessed(applyId: string, stepId: string, witness: NonNullable<Outcome["witness"]>): void {
    const a = this.applies.get(applyId);
    const i = a?.outcomes.findIndex((x) => x.step_id === stepId) ?? -1;
    if (!a || i < 0) return;
    a.outcomes[i] = { ...a.outcomes[i]!, witness };
    this.save(a);
  }

  /** Serves step `i`'s outcome as it is now as an `outcome` event; a witness's verdict is an event of its own. */
  private tell(a: HeldApply, i: number): void {
    const { time: _, witness: _w, step_id, ...rest } = a.outcomes[i]!;
    this.o.emit("outcome", { ...this.runOf(a.apply_id), step_id, ...rest });
  }

  /**
   * What an outcome event names: the apply id, the safety rule id for a rule's actuation, or the socket
   * for a heating cap's turn-off (applier, *Events and history*).
   */
  runOf(applyId: string): { apply_id: string } | { rule_id: string } | { load_cap: string } {
    const a = this.applies.get(applyId);
    return a?.rule_id !== undefined ? { rule_id: a.rule_id } : a?.load_cap !== undefined ? { load_cap: a.load_cap } : { apply_id: applyId };
  }

  private save(a: HeldApply): void {
    const row = { ...a, outcomes: a.outcomes.map((x) => ({ ...x })) };
    void this.o.store.write((tx) => saveApply(tx, row));
  }

  /** A reserved or used token no longer counts as used: in memory at once, in the store behind when it was written. */
  private releaseToken(t: { issuer: string; token_id: string }, written: boolean): void {
    this.used.delete(tokenKey(t.issuer, t.token_id));
    if (written) void this.o.store.write((tx) => releaseToken(tx, t.issuer, t.token_id));
  }
}

const iso = (ms: number) => new Date(Math.floor(ms)).toISOString();
/** A held run's action slot, by apply id and index (`Dispatcher.published`). */
const slotOf = (applyId: string, i: number) => `${applyId}\u0000${i}`;
