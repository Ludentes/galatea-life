import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import { principalOf, resolveCaller, boundEndpoints, maxRoleOf, lowerRole, type Caller, type Principal } from "./auth/principal.js";
import { OutcomeUnknown, RequestError, StoreUnavailable } from "./core/errors.js";
import { maskUrls, type Tx } from "./core/db.js";
import { EventLog, HISTORY_CAP, SEQ_LIFE_GAP, type AppEvent, type Marked, type Readers } from "./core/events.js";
import { SerialQueue } from "./core/queue.js";
import { GATE_MS, getMeta, raiseMeta, RisingMeta, setMeta, within, type Store } from "./core/store.js";
import { canonical, storable } from "./core/canonical.js";
import { judgeAnswer, stillNeeded, type Answer, type AskedPlan, type Heard, type UtteranceRecord } from "./confirm/answer.js";
import { mintToken } from "./confirm/token.js";
import { atDispatch, docOf, KEY_RETENTION_MS, leaves, outcomeRank, REPEAT_WINDOW_MS, ruleDecision, type ApplyRecord, type Outcome } from "./dispatch/apply.js";
import { occupancyOf, type Occupancy } from "./gate/occupancy.js";
import { judge, leased, unplanned, type ApplierStep, type StewardStep } from "./gate/reasons.js";
import { LEASE_EXEMPT, LeaseTable, leaseView, safetyRuleOf, type Lease } from "./leases/table.js";
import { NoticePump, type Notice } from "./notices/pump.js";
import { resolveRequest, type Requested } from "./gate/resolve.js";
import { brainMayDefine, deviceMarked } from "./house/brain.js";
import { hasNotifyChannel, ifReadsOf, MODES, notifyChannels, planDefine, readsOf, type Change } from "./house/define.js";
import { groupOn } from "./house/group-state.js";
import { deviceActions, startsOf, loadHouse, saveHouse, withFirstOwner, type Endpoint, type Group, type House, type Rule } from "./house/model.js";
import type { View } from "./rules/conditions.js";
import { EDGE_REPLAY_MS, RuleEngine } from "./rules/engine.js";
import { afterOutcome, HELD_CAP, RETRY_SPACING_MS, RuleOutcomes, type Firing, type FiringStep } from "./rules/outcomes.js";
import { compile, indexOf, stepIdOf, type ActionNode, type Node, type Program } from "./scenarios/program.js";
import { outcomesOf, RUN_LIMIT_MS, settled, statusOf, tally, type Run, type RunEnd } from "./scenarios/run.js";
import { saveMarks, Schedules } from "./schedules/timers.js";
import type { Occurrence } from "./schedules/core.js";
import type { Schedule } from "./house/model.js";
import { readingHolds } from "./rules/conditions.js";
import { refusedBy, type Precedence } from "./leases/table.js";
import { mustRecover, RECOVERY_CAP, type Dropped } from "./link/link.js";
import { Mirror } from "./link/mirror.js";
import { ApplierRefused, NotSent } from "./link/port.js";
import type { Mutation } from "./mutations.js";
import type { Role } from "./house/model.js";

/** In `channelsTold`: the list's loss of its last adopted notify channel was told (GA-NOTE-4). */
const NO_NOTIFY = "*notify";

export const STANDARD_VERSION = "0.11";

export type ToolResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string; message: string };

/**
 * The standard's operations, with the annotations its *Operations* gives each (`readOnlyHint`, or
 * `destructiveHint` true or false).
 */
/**
 * The steward's operations (steward, *Operations*), as its MCP binding lists them, each with a
 * one-line summary for a tool's description: a model reads it to pick the operation.
 */
export const TOOLS: { name: string; readOnly?: true; destructive?: boolean; summary: string }[] = [
  { name: "describe", readOnly: true,
    summary: "The house: rooms, targets, groups, endpoints, persons, scenarios, rules and schedules, at a revision" },
  { name: "state", readOnly: true,
    summary: "Current values of targets, with each room's occupancy, each group's state and each device's lease" },
  { name: "plan", readOnly: true,
    summary: "Plan actions on targets (by id or selector) for an endpoint; changes nothing, returns steps and any question to ask" },
  { name: "answer", destructive: true,
    summary: "Answer a plan's confirmation questions, yes or no per step, as spoken at an endpoint" },
  { name: "apply", destructive: true,
    summary: "Carry out a plan by its plan_id, or a request directly, under an idempotency key; returns the outcomes" },
  { name: "outcome", readOnly: true, summary: "The current outcomes of an apply, by its apply_id" },
  { name: "events", readOnly: true, summary: "Events since a cursor, waiting up to wait_s for one" },
  { name: "history", readOnly: true, summary: "Past events between two times, optionally for some targets" },
  { name: "scenario_plan", readOnly: true, summary: "Plan a scenario run for an endpoint; changes nothing" },
  { name: "scenario_run", destructive: true, summary: "Start a scenario from its plan, under an idempotency key" },
  { name: "scenario_status", readOnly: true, summary: "Whether a scenario run is running or ended, with its failed and unconfirmed steps" },
  { name: "scenario_stop", destructive: true, summary: "Stop a scenario run by its run_id, as asked at an endpoint" },
  { name: "define", destructive: true,
    summary: "Change the house's definitions (rooms, targets, persons, rules, schedules...), or carry out a define's plan" },
  { name: "narrow", destructive: true, summary: "Narrow what an endpoint listens for, or allow a follow-up, until a time" },
  { name: "front_status", destructive: false, summary: "A voice front reports its models, clips and skills" },
  { name: "speaking", destructive: false, summary: "A voice front says whether an endpoint is speaking" },
  { name: "zone_sources", readOnly: true, summary: "Media targets reporting speech, and announcements, for a voice front" },
];
/** What is built so far; the others are listed and answer `invalid_request` ("not built yet"). */
const BUILT = new Set(["describe", "define", "plan", "state", "events", "history", "answer", "apply", "outcome", "scenario_plan", "scenario_run",
  "scenario_status", "scenario_stop"]);
/** A front credential's operations, and those only a front may call (GA-AUTH-8). */
const FRONT_TOOLS = new Set(["describe", "zone_sources", "narrow", "front_status", "speaking"]);
const FRONT_ONLY = new Set(["front_status", "speaking", "zone_sources"]);
const PRUNE_EVERY_MS = 60_000;
/**
 * The owners' line holds at most this many changes, the one committing included (the design,
 * *Bounds*); past it a `define` is refused at once. Owners are few, and a line this long means a
 * store that stalls.
 */
export const OWNERS_CAP = 16;
/** A plan with no ask expires this long after it is made (steward, *Planning changes nothing*). */
export const PLAN_EXPIRY_MS = 60_000;
/**
 * The most plans one credential may have held at once; past it, its oldest is dropped, as the
 * reference applier holds a client's plans. A cap on what a client can make the steward hold.
 */
export const MAX_PLANS_PER_CREDENTIAL = 64;
/**
 * The applies one credential may hold under keys still within their 3600 s (GA-STW-6). A new key past
 * it is refused, never made room for: forgetting a key early would let its repeat dispatch again.
 */
export const MAX_APPLIES_PER_CREDENTIAL = 4096;
/** The answer to a plan with an ask whose commit outlasts the gate: it is never held, and no ask is put. */
const RUN_STEP_DROPPED = `the store did not keep the run's step within ${GATE_MS} ms: nothing was sent for it`;
const DROPPED_STEP = "dropped: the store did not keep the run's step";
const FIRING_DROPPED = `the store did not keep the rule's firing within ${GATE_MS} ms: nothing was sent for it`;
const PLAN_DROPPED = `the store did not keep the plan within ${GATE_MS} ms: it is not held, and no question was put; plan again`;
/** A secret's least length, as `define`'s credential schema has it; the first owner's too. */
const MIN_SECRET = 16;
/** The answer an `answer` gets when its commit outlasts 10 s: it stands in memory, and is kept when the store returns. */
const ANSWER_HELD = `the store did not keep the answer within ${GATE_MS} ms; it stands, and is kept when the store returns, unless the steward restarts first`;
/** The answer a `define` gets when its 10 s pass in the owners' line or in its commit. */
/** The answer a `define { plan_id }` left unanswered gets when the plan's spending outlasts 10 s: spent all the same, kept when the store returns. */
const SPENT_HELD = `the store did not keep the plan's spending within ${GATE_MS} ms: nothing changed, the plan is spent, and kept so when the store returns, unless the steward restarts first`;
const HELD = `the store did not commit within ${GATE_MS} ms; the change is held in the owners' line and judged at its turn `
  + "(at its expected_revision, so stale_revision if another change landed first), taking effect then unless the steward restarts first";

export interface StewardOptions {
  store: Store;
  clock: Clock;
  stewardId: string;
  /** Where the steward's own lines go (a fault said once, a notice's text); standard error when not given. */
  logger?: (line: string) => void;
  /** `GALATEA_OWNER_CREDENTIAL`: makes the first owner on a store with no person (ruled, Q2). */
  ownerCredential?: string;
  runId?: string;
  mutation?: Mutation;
  /** Moves the clock to `source`, or with null back to the source it started on (GA-HARN-2). */
  retarget?: (source: string | null) => Promise<void>;
  /** Rejects unless `source` answers, without moving the clock. */
  checkTimeSource?: (source: string) => Promise<void>;
  /** The applier's `plan` of an inline request; rejects while the applier is out of reach (the applier link). */
  applierPlan?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The applier's `apply`; rejects with `NotSent` when no session was up to send it on (the applier link). */
  applierApply?: (body: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;
  /** `GALATEA_APPLIER_CLIENT`: the steward's client id at its applier, every token's `issuer`. */
  applierClient?: string;
  /** `GALATEA_APPLIER_TOKEN_KEY`: the key the applier holds for the steward, which proves its tokens; never logged. */
  tokenKey?: string;
  /** How many of the applier's events wait at most while an apply's answer is awaited (`PARKED_CAP`; smaller in tests). */
  parkedCap?: number;
  /** `MAX_APPLIES_PER_CREDENTIAL`, smaller in tests. */
  maxAppliesPerCredential?: number;
  /** `PRUNE_EVERY_MS`, longer in tests that move the clock by days. */
  pruneEveryMs?: number;
  /** `HISTORY_CAP`, smaller in tests. */
  historyCap?: number;
  /** `RECOVERY_CAP`, smaller in tests. */
  recoveryCap?: number;
}

/** How many rule firings' records are kept for their later events; past it the oldest is forgotten. */
export const FIRINGS_KEPT = 256;
/** How long a firing whose answer was lost is asked for it again: the applier answers a repeated key from its record this long (GA-APPLY-4). */
export const REASK_FOR_MS = 3_600_000;

/** How many of the applier's events wait at most while an apply's answer is awaited; past it they are relayed as they are. */
export const PARKED_CAP = 4096;
/**
 * The bound on a latchless safety rule's lease, should its completion (`rule_fired`) never be read: past
 * every default ack bound (240 s, `power.wake`) and GA-SAFE-12's re-sends. Stated in `describe` as
 * `safety_lease_s`; a lease runs no shorter than its device's ack bound plus the late-ack window (GA-LEASE-6).
 */
export const LATCHLESS_SAFETY_MS = 15 * 60_000;
/** The applier's late-ack window after a `failed(no_ack)` (applier GA-APPLY-11). */
const LATE_ACK_WINDOW_MS = 60_000;
/** The most of the applier's missed events one recovery takes (the link's, `RECOVERY_CAP`). */
export { RECOVERY_CAP } from "./link/link.js";
/** The answer a client's apply gets when its record's commit outlasts 10 s: nothing was sent, and nothing ever will be. */
const APPLY_DROPPED = `the store did not keep the apply within ${GATE_MS} ms: nothing was sent, and its steps are unreachable`;

/** A plan the steward holds (steward, *Planning changes nothing*): until it is forgotten, held as long again as it lived. */
interface HeldPlan {
  plan: StewardPlan;
  credential: string;
  /** Who made it: the principal its endpoint and speaker gave, which an apply of it acts as. */
  principal: Principal;
  /** When the plan was made: an answer counts only after it (GA-CONF-1). */
  madeMs: number;
  expiresMs: number;
  forgetMs: number;
  /** The step ids put as a question, in the plan's `ask` event. */
  asked: string[];
  /** When each asked step's latest `ask` event was put: an utterance must come after it (GA-CONF-2); a re-ask (slice 5) moves it. */
  askedMs: Record<string, number>;
  /** Where the question was put (GA-CONF-5): the plan's endpoint, or the `confirm_on` that applied. */
  askedAt: string;
  /** The answers that stand, by step (steward, *The confirmation dialogue*). */
  answers: Record<string, Answer>;
  /** Applied once: no longer open, to an answer or another apply. */
  applied: boolean;
  /** When each step's answer was last given: a run's yes to `ask(toggle_only)` stands for `ask_expiry_s` from it (GA-SCN-3). In memory: a restart ends every run. */
  answeredMs?: Record<string, number>;
  /** A run's toggle steps asked again, open to an answer until `untilMs` (GA-SCN-3). */
  reopened?: { steps: string[]; untilMs: number };
}

/**
 * The one step of a `define` through a brain (GA-DEF-6): asked as `confirm_define`, carrying the diff
 * the change set would apply, its `brain_authored` marks in it.
 */
export interface DefineStep { step_id: string; verdict: "ask"; reason: "confirm_define"; diff: string }

/** A steward plan (steward/plan.json). */
export interface StewardPlan {
  plan_id: string;
  expires_at: string;
  revision: number;
  endpoint: string;
  speaker?: string;
  client: string;
  request: Record<string, unknown>;
  steps: (StewardStep | DefineStep)[];
}

type Args = Record<string, any>;

/**
 * The steward's state and operations (the design, *The core*). Every change is one synchronous step
 * in memory that hands its writes to the store's writer; an owner's `define` reaches memory only once
 * it commits, one at a time. The applier link hands what it reads to `onDescribe`, `onState` and
 * `onEvents`, each a step.
 */
export class Steward {
  readonly mutation?: Mutation;
  readonly mirror = new Mirror((l) => this.say(l));
  private house!: House;
  private rev = 0;
  private readonly owners = new SerialQueue(OWNERS_CAP);
  /** The groups whose id a device of the applier's now has, said once each (`sayShadowed`). */
  private readonly shadowSaid = new Set<string>();
  private readonly log: EventLog;
  private readonly revision: RisingMeta;
  private readonly waiters = new Set<() => void>();
  private pruneTimer?: number;
  /** The plans held, by id, in the order they were made. */
  private readonly plans = new Map<string, HeldPlan>();
  /** The utterance records that answered a plan, kept while one could still be reused (GA-CONF-2), by id. */
  private readonly heard = new Map<string, Heard>();
  /** Applies by credential and idempotency key, by apply id, and by the applier's apply id, kept 3600 s (GA-STW-6). */
  private readonly applies = new Map<string, ApplyRecord>();
  private readonly appliesById = new Map<string, ApplyRecord>();
  private readonly byApplier = new Map<string, ApplyRecord>();
  /** How many applies each credential holds in `applies`, for `MAX_APPLIES_PER_CREDENTIAL`. */
  private readonly keysHeld = new Map<string, number>();
  /** The applies whose applier call awaits its answer. */
  private readonly inFlight = new Set<string>();
  /** The timers of firings asked again for a lost answer. */
  private readonly reasks = new Set<number>();
  /** The firings whose answer was lost and is still asked for: an unknown apply's outcome events are held for them, as for one in flight. */
  private readonly lost = new Set<string>();
  /**
   * The applier's events held back while an apply that was in flight when they came has not been
   * answered, since an `outcome` event can come before the apply's answer names its apply id; each
   * batch waits for those applies, and behind the batches before it.
   */
  private parked: { events: Args[]; waitFor: Set<string> }[] = [];
  private parkedCount = 0;
  /**
   * The applier's `outcome` and `late_ack` events of an apply not known, held back when the cap forced
   * the parked batches out while an apply was in flight, in their order, at most `PARKED_CAP`, the
   * oldest dropped (and said once). An apply's answer relays its own, named by the steward's apply,
   * after the steward's own outcome; the rest are relayed as they are once no apply is in flight.
   */
  private orphans: Args[] = [];
  /** Applies whose record waits to be written again, coalesced: one write in the writer's line each. */
  private readonly saving = new Map<string, boolean>();
  /**
   * The applier's model the house last followed, as its id, its run id and its revision in canonical
   * JSON, so a start against the same applier at the same revision moves no revision; another applier,
   * or a reset one, at the same number does.
   */
  private followed?: string;
  /** Whether notices were held at the last look: no adopted channel offered `notify` (GA-NOTE-1). */
  private heldBefore = true;
  /**
   * The channels whose loss a notice told (GA-NOTE-4), and `NO_NOTIFY` once the list's loss of its last
   * adopted notify channel was told (or left so by define, whose answer says it); kept in `meta`.
   */
  private channelsTold = new Set<string>();
  /** Told channel losses this life, so two in one millisecond have two notice ids. */
  private channelNotices = 0;
  /** Whether a write of `followed` waits in the writer's line: one at a time, writing the latest. */
  private followedQueued = false;
  private lastPlanFailure?: string;
  /** Faults said once each, by kind. */
  private readonly said = new Set<string>();
  /** Each device's lease, and the provisional leases of applies in flight (the design, *Leases*). */
  private readonly leases: LeaseTable;
  /** The notices not yet delivered, the applier's and the steward's own (the design, *Notices*). */
  private readonly notices: NoticePump;
  /** The house's rules, evaluated and fired (the design, *Rules*). */
  private readonly rules: RuleEngine;
  /** What a rule's outcome does: its retries and failure notices (the design, *Rules*, *After the outcome*). */
  private readonly after: RuleOutcomes;
  /** Whether the mirror has read the applier's state: no rule is evaluated before. */
  private synced = false;
  /**
   * The rules' actions that can never run from them, a toggle on an open-loop device, as
   * `rule\u0000target\u0000action`, as last told (GA-RULE-8); undefined until the first `describe`, which
   * takes those it finds as told (a declaration changed while the steward was down is not seen).
   */
  private togglesTold?: Set<string>;
  /** The schedules' actions that can never run from them, as `schedule\u0000target\u0000action`, as last told (GA-RULE-8); as `togglesTold`. */
  private scheduleTogglesTold?: Set<string>;
  /** Rule firings' records, in the order fired, at most `FIRINGS_KEPT`. */
  private readonly firings = new Map<string, ApplyRecord>();
  /** Stopped: a run's steps go no further. */
  private halted = false;
  /** Scenario runs by id: running, and ended ones for 3600 s (the design, *Scenarios*). */
  private readonly runs = new Map<string, Run>();
  /** The run of each scenario that is running: `single` starts no other (GA-SCN-1). */
  private readonly runningOf = new Map<string, Run>();
  /** Each client run's key, by credential and key, for 3600 s (GA-SCN-6): the run it started, or the one its start was ignored for. */
  private readonly runKeys = new Map<string, { run_id: string; body: string; atMs: number; ignored?: true; ready: Promise<void> }>();
  /** How many run keys each credential holds, an ignored start's included, against its cap (the milestone 5+6 review, B1). */
  private readonly runKeysHeld = new Map<string, number>();
  /** A run waiting on its toggle steps asked again, by its plan's id: told of each answer to the plan. */
  private readonly reasked = new Map<string, () => void>();
  /** The `wait` steps waiting, each told of every event on its target (GA-SCN-10). */
  private readonly waiting = new Set<{ target: string; check: () => void }>();
  /** The house's schedules, their marks and timers (the design, *Schedules*). */
  private readonly schedules: Schedules;
  /**
   * The applier's event the steward last had: its `seq`, its time, and the applier it came from
   * (`applier_id` and `test_run_id`), so a sync reads the applier's history from it (the design,
   * *Recovery*). Kept beside the steward's own cursor (`applier_last`), written in the write set of
   * each relayed event's row, so it is never ahead of the rows the store kept, and read back at start,
   * so a restart reads what the applier did while the steward was down (slice 2b's preflight, M5). An
   * event relayed with no row of its own moves it in memory only: a restart reads it again.
   */
  private lastApplier?: { seq: number; timeMs: number; applier: string };
  /**
   * How far the steward's clock was ahead of the applier's at the last event followed live (its time
   * on relay less the applier's time for it); undefined until one is. A missed edge's applier time is
   * moved by it onto the steward's clock (the code review, CR2).
   */
  private applierOffset?: number;
  /**
   * The orphans (`orphans`) the last life held unrelayed when it stopped, by `seq`, with their time,
   * kept beside `applier_last` as `held`: the first sync reads the applier's history back to the oldest
   * and relays them, though behind the kept position (the code review, CR5). Cleared once read.
   */
  private heldBack = new Map<number, number>();
  /** A write of `lastApplier` alone waiting in the writer's line, with no event's row handed over after it (`saveLastApplier`). */
  private lastApplierAlone?: { value: string };
  /** Each safety rule whose latchless lease the steward ended early: the devices, and the rules refused `safety` on each since (GA-LEASE-6). */
  private readonly endedEarly = new Map<string, Map<string, Set<string>>>();
  /** The timer letting each wait of `endedEarly` go, by safety rule and device (the code review, CR1). */
  private readonly earlyTimers = new Map<string, number>();
  /** Whether the gap being played is a restart's: its outside changes lease as a cursor_expired gap's do (GA-LEASE-2). */
  private restartGap = false;
  /** While a gap is read: the rule firings' steps it ended, judged once the state is read (`recover`). */
  private settleLater?: [ApplyRecord, string][];
  /** The safety rules whose latch the steward saw set and not cleared, in this life (`latched`). */
  private readonly latchesSeen = new Set<string>();

  private sayOnce(kind: string, line: string): void {
    if (this.said.has(kind)) return;
    this.said.add(kind);
    this.say(line);
  }

  /** One of the steward's own lines, to the injected logger. */
  private say(line: string): void {
    (this.o.logger ?? ((l: string) => console.error(l)))(line);
  }

  /** The code of the applier's refusal of the steward's last plan, a fault to show, until it plans again. */
  applierFault?: string;

  constructor(private readonly o: StewardOptions) {
    if (o.applierApply) {
      // A token keyed with nothing would be refused by the applier with no clue why (GA-CONF-3).
      if (!o.tokenKey || [...o.tokenKey].length < MIN_SECRET) throw new Error(`a steward that reaches an applier needs a token key of at least ${MIN_SECRET} characters`);
      if (!o.applierClient) throw new Error("a steward that reaches an applier needs its client name there, its tokens' issuer");
    }
    this.mutation = o.mutation;
    this.log = new EventLog(o.store, o.clock);
    this.revision = new RisingMeta(o.store, "revision", () => this.rev);
    this.leases = new LeaseTable({ clock: o.clock, store: o.store, event: (body) => this.log.append("lease", body),
      // A lease's end re-evaluates the level-triggered rules it refused (GA-LEASE-4).
      ended: (target, rules) => this.rules.leaseEnded(target, rules),
      cameOff: (target, lease) => this.safetyEndedEarly(target, lease), mutation: o.mutation });
    this.notices = new NoticePump({ clock: o.clock, store: o.store, event: (body) => this.log.append("notice", body),
      send: (batch, key) => this.sendNotice(batch, key), holding: () => !this.notifyChannel() });
    this.rules = new RuleEngine({ clock: o.clock, store: o.store, logger: (l) => this.say(l), mutation: o.mutation,
      rules: () => [...this.house.rules.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      view: () => this.ruleView(), ready: () => this.synced, fire: (r, n, only) => this.fireRule(r, n, only), names: (r) => this.namesOf(r),
      clean: () => this.log.lastStopClean, forget: (id) => this.after.forget(id), firedSince: (rule, applierMs) => this.log.firedSince(rule, applierMs) });
    this.after = new RuleOutcomes({ clock: o.clock, mutation: o.mutation, store: o.store, roomOf: (t) => this.house.targets.get(t)?.room ?? undefined, holds: (id) => this.rules.holds(id), episode: (id) => this.rules.episode(id),
      retry: (id, steps) => this.rules.retry(id, steps),
      // One waiting per rule and action, counted, carrying the latest outcome (ruled Q1).
      notice: (id, { text, ...doc }) => this.notices.own(id, "rule_failed", text, doc, `rule_failed:${doc.rule}:${doc.action}`) });
    this.schedules = new Schedules({ clock: o.clock, store: o.store, house: () => this.house, run: (s, at) => this.startScheduledRun(s, at),
      busy: (s) => this.runningOf.has(s.scenario), event: (type, body) => this.log.append(type, body), mutation: o.mutation });
  }

  /** Loads what the store keeps, and makes the first owner on a store with no person; serves nothing before. */
  async start(): Promise<void> {
    this.house = await loadHouse(this.o.store);
    const secret = this.o.ownerCredential;
    if (this.house.persons.size === 0 && secret && [...secret].length < MIN_SECRET) {
      // The bootstrap path takes no secret `define` would refuse. Said once; the secret never.
      this.say(`GALATEA_OWNER_CREDENTIAL is shorter than ${MIN_SECRET} characters: no first owner is made`);
    } else if (this.house.persons.size === 0 && secret) {
      const h = withFirstOwner(this.house, secret);
      await this.o.store.write((tx) => saveHouse(tx, h));
      this.house = h;
    }
    await this.log.load();
    // A revision the last life served and never wrote may not be served again for another model.
    this.rev = Number((await getMeta(this.o.store, "revision")) ?? "0") + (this.log.lastStopClean ? 0 : SEQ_LIFE_GAP);
    if (!this.log.lastStopClean) {
      const jumped = this.rev;
      await this.o.store.write((tx) => raiseMeta(tx, "revision", jumped));
    }
    this.followed = await getMeta(this.o.store, "applier_followed");
    await this.loadLastApplier();
    // The rules first: a lease that ended while the steward was down ends as the leases load, and
    // its re-evaluation must find the rules' rows read, not have them read over it (GA-LEASE-4).
    await this.rules.load();
    await this.loadFirings();
    await this.leases.load();
    // A firing a standing lease refused does not count as fired: the start's evaluation tries it again (GA-RULE-1).
    this.rules.refusedAtStart(this.leases.refusedRules());
    await this.notices.load();
    this.channelsTold = new Set(JSON.parse(await getMeta(this.o.store, "channels_told") ?? "[]") as string[]);
    if (this.mutation === "forgets-an-unsent-notice") for (const n of this.notices.all()) this.notices.lose(n.notice_id);
    await this.loadPlans();
    await this.loadApplies();
    await this.loadRuns();
    await this.schedules.load();
    if (this.house.home.time_source && this.o.retarget && this.o.runId) await this.o.retarget(this.house.home.time_source);
    // Runs missed while the steward was down are recorded, never run late (GA-SCHED-2); then the timers.
    await this.schedules.recover();
    this.schedules.arm();
    this.schedulePrune();
  }

  stop(): void {
    this.halted = true;
    if (this.pruneTimer !== undefined) this.o.clock.clear(this.pruneTimer);
    for (const t of this.reasks) this.o.clock.clear(t);
    this.reasks.clear();
    this.leases.stop();
    for (const t of this.earlyTimers.values()) this.o.clock.clear(t);
    this.earlyTimers.clear();
    this.notices.stop();
    this.rules.stop();
    this.after.stop();
    this.schedules.stop();
    for (const r of this.runs.values()) {
      if (r.bound !== undefined) this.o.clock.clear(r.bound);
      r.wake?.();
    }
    for (const w of [...this.waiters]) w();
  }

  /** Whether a rule fired since it last became true (GA-RULE-1), for tests. */
  ruleFired(id: string): boolean {
    return this.rules.fired(id);
  }

  /** How many plans are held, for tests of the cap. */
  heldPlans(): number {
    return this.plans.size;
  }

  /** Resolved on every request, from the model as it is now (GA-AUTH-4). */
  caller(bearer: string | undefined): Caller {
    return resolveCaller(this.house, bearer);
  }

  /**
   * Resolves to a `ToolResult` for a result or a request error. Rejects with `StoreUnavailable`, or
   * the store's own error, when the store cannot keep what the call needs; the MCP layer answers that
   * with an internal error.
   */
  async call(caller: Caller, tool: string, args: unknown): Promise<ToolResult> {
    try {
      if (caller.kind !== "credential") throw new RequestError("not_permitted", "no registered credential (GA-AUTH-4)");
      const front = caller.credential.kind === "front";
      if (front ? !FRONT_TOOLS.has(tool) : FRONT_ONLY.has(tool)) {
        throw new RequestError("not_permitted", `a ${caller.credential.kind} credential may not call ${tool} (GA-AUTH-8)`);
      }
      if (!TOOLS.some((t) => t.name === tool)) throw new RequestError("invalid_request", `no operation ${tool}`);
      if (!BUILT.has(tool)) throw new RequestError("invalid_request", `${tool} is not built yet in this steward`);
      const errors = validate(`steward/${tool}.request.json`, args);
      if (errors.length) throw new RequestError("invalid_request", errors.join("; "));
      // Nothing the store would refuse reaches it: a refused statement stops the steward (the design, *A store fault*).
      if (!storable(args)) throw new RequestError("invalid_request", "a string holds U+0000 or a lone surrogate");
      const a = args as Args;
      switch (tool) {
        case "describe": return { ok: true, body: await this.describe(a, caller) };
        case "plan": return { ok: true, body: await this.plan(a, caller) as unknown as Record<string, unknown> };
        case "state": return { ok: true, body: this.state(a, caller) };
        case "events": return { ok: true, body: await this.events(a, caller) };
        case "history": return { ok: true, body: await this.history(a, caller) };
        case "answer": return { ok: true, body: await this.answer(a, caller) as unknown as Record<string, unknown> };
        case "apply": return { ok: true, body: await this.apply(a, caller) };
        case "outcome": return { ok: true, body: this.outcome(a, caller) };
        case "scenario_plan": return { ok: true, body: await this.scenarioPlan(a, caller) as unknown as Record<string, unknown> };
        case "scenario_run": return { ok: true, body: await this.scenarioRun(a, caller) };
        case "scenario_status": return { ok: true, body: this.scenarioStatus(a, caller) };
        case "scenario_stop": return { ok: true, body: this.scenarioStop(a, caller) };
        default: return { ok: true, body: await this.define(a, caller) };
      }
    } catch (err) {
      if (err instanceof RequestError) return { ok: false, error: err.code, message: err.message };
      throw err;
    }
  }

  /**
   * A step: the applier's `describe`. Its model moving moves the house's revision (GA-HOUSE-1); the
   * first read after a start moves it only when the applier (its id, its run id) or its revision is not
   * the one the house last followed, so plans read back at start are not made stale by the restart alone.
   */
  /** Writes the applier model the house followed, behind and coalesced; safe to run twice. */
  private saveFollowed(): void {
    if (this.followedQueued) return;
    this.followedQueued = true;
    let written: string | undefined;
    void this.o.store.write((tx) => { written = this.followed!; return setMeta(tx, "applier_followed", written); }).then(() => {
      this.followedQueued = false;
      if (this.followed !== written) this.saveFollowed();
    });
  }

  onDescribe(d: Args): void {
    const first = this.mirror.applier === undefined;
    if (this.mirror.setDescribe(d)) {
      const followed = canonical({ applier_id: d.applier_id ?? null, test_run_id: d.test_run_id ?? null, revision: d.revision ?? null });
      if (!first || this.followed !== followed) this.bump();
      this.followed = followed;
      this.saveFollowed();
    }
    this.sayShadowed();
    this.sayToggles();
    this.sayScheduleToggles();
    this.channelsMoved();
  }

  /** Whether the home's channels have an adopted one offering `notify`: without one, notices are held (GA-NOTE-1). */
  private notifyChannel(): boolean {
    return hasNotifyChannel(this.house.home, this.defineContext(false));
  }

  /**
   * After the house or the applier's model moved: when notices stop being held (a notify channel set,
   * or adopted again), every notice held is tried at once (GA-NOTE-1).
   */
  private channelsMoved(byDefine = false): void {
    const now = this.notifyChannel();
    this.sayChannels(byDefine);
    if (now && this.heldBefore) this.notices.retry();
    this.heldBefore = !now;
  }

  /**
   * GA-NOTE-4: a notice naming each channel of the list that leaves adoption, or offers neither `notify`
   * nor `media.announce`, once per loss; and one when the list loses its last adopted channel offering
   * `notify`. Each is delivered on the channels that remain, or held (GA-NOTE-1). A define moves only
   * what was told (`byDefine`): a channel it drops from the list is forgotten, and a list it leaves
   * with no notify channel is answered `no_notify_channel`, not noticed.
   */
  private sayChannels(byDefine: boolean): void {
    if (!this.mirror.applier) return;
    const before = canonical([...this.channelsTold].sort());
    const list = this.house.home.notice_channels;
    for (const id of [...this.channelsTold]) if (id !== NO_NOTIFY && !list.includes(id)) this.channelsTold.delete(id);
    const quiet = byDefine || this.mutation === "keeps-a-dead-channel-quiet";
    for (const id of list) {
      const d = this.mirror.deviceView(id);
      const why = !d ? "the applier no longer describes it" : !d.adopted ? "it is no longer adopted"
        : !d.actions.includes("notify.notify") && !d.actions.includes("media.announce") ? "it offers neither notify nor media.announce" : undefined;
      if (!why) {
        this.channelsTold.delete(id);
        continue;
      }
      if (this.channelsTold.has(id)) continue;
      this.channelsTold.add(id);
      if (quiet) continue;
      const name = this.house.targets.get(id)?.name ?? (this.mirror.devices.get(id)?.label as string | undefined) ?? id;
      this.notices.own(`steward:channel-lost:${id}:${Math.floor(this.o.clock.now())}:${this.channelNotices++}`, "channel_lost",
        `notice channel ${name} (${id}) no longer carries notices: ${why}; set notice_channels again (GA-NOTE-4)`, { target: id });
    }
    if (this.notifyChannel() || !list.length) this.channelsTold.delete(NO_NOTIFY);
    else if (!this.channelsTold.has(NO_NOTIFY)) {
      this.channelsTold.add(NO_NOTIFY);
      if (!quiet) {
        this.notices.own(`steward:channel-lost:notify:${Math.floor(this.o.clock.now())}:${this.channelNotices++}`, "channel_lost",
          "no notice channel offering notify is left: notices are held until one is set (GA-NOTE-4)");
      }
    }
    if (canonical([...this.channelsTold].sort()) !== before) {
      const value = JSON.stringify([...this.channelsTold].sort());
      void this.o.store.write((tx) => setMeta(tx, "channels_told", value));
    }
  }

  /**
   * Whether the caller is the owner's app, the only one an `internal` device is shown to (steward,
   * *Requests and selectors*: never shown to people, listed in `describe` for the owner's app): an app
   * credential whose endpoint's person is an owner, at a cap of `owner`.
   */
  private isOwnersApp(caller: Extract<Caller, { kind: "credential" }>): boolean {
    const app = caller.credential.kind === "app" ? this.house.endpoints.get(caller.credential.endpoint ?? "") : undefined;
    return app?.person != null && this.house.persons.get(app.person)?.role === "owner" && maxRoleOf(app) === "owner";
  }

  /**
   * A device the applier brings whose id is a group's wins: a request naming that id reaches the
   * device, and the group cannot be targeted until the owner renames it (ruled 2026-10-04). Said once
   * in the log per group while it lasts, flagged in `describe`, and a notice to the owner each time it begins.
   */
  private sayShadowed(): void {
    for (const id of this.shadowSaid) if (!this.mirror.devices.has(id) || !this.house.groups.has(id)) this.shadowSaid.delete(id);
    for (const id of this.house.groups.keys()) {
      if (!this.mirror.devices.has(id) || this.shadowSaid.has(id)) continue;
      this.shadowSaid.add(id);
      const text = `the applier now has a device ${id}, the id of group ${id}: a request naming it reaches the device; rename the group`;
      this.say(text);
      this.notices.own(`steward:shadowed:${id}`, "group_shadowed", text, { group: id });
    }
  }

  /**
   * A notice for each device a rule this `define` set or changed reads whose `fresh_s` is not known, so
   * the rule can never hold on it (GA-RULE-2); one per rule, device and revision. An owner's `fresh_s`
   * longer than the declared one is not seen: `describe` gives the effective bound only (the design,
   * *Standards problems found*).
   */
  private sayUnbounded(before: House, after: House): void {
    for (const r of [...after.rules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (canonical(before.rules.get(r.id) ?? null) === canonical(r)) continue;
      for (const id of [...new Set(readsOf(r, true))].sort()) {
        if (this.mirror.fresh(id) !== null) continue;
        this.notices.own(`steward:unbounded:${r.id}:${id}:${this.rev}`, "rule_unbounded",
          `rule ${r.id} reads ${id}, whose fresh_s is not known: the rule can never hold on it until a bound is set (GA-RULE-2)`,
          { rule: r.id, target: id });
      }
    }
  }

  /**
   * As `sayUnbounded`, for a scenario this `define` set or changed whose `if` steps read a device whose
   * `fresh_s` is not known, so the `if` can never hold on it (GA-RULE-2); one per scenario, device and revision.
   */
  private sayUnboundedIfs(before: House, after: House): void {
    for (const sc of [...after.scenarios.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (canonical(before.scenarios.get(sc.id) ?? null) === canonical(sc)) continue;
      for (const id of [...new Set(ifReadsOf(sc.steps))].sort()) {
        if (this.mirror.fresh(id) !== null) continue;
        this.notices.own(`steward:unbounded-if:${sc.id}:${id}:${this.rev}`, "scenario_unbounded",
          `scenario ${sc.id} has an if reading ${id}, whose fresh_s is not known: the if can never hold on it until a bound is set (GA-RULE-2)`,
          { scenario: sc.id, target: id });
      }
    }
  }

  /**
   * GA-RULE-8's toggle notice: one for each rule's action that is a toggle on an open-loop device,
   * saying it will never run from the rule, at the `define` that sets or changes the rule (`changed`)
   * and whenever such an action newly comes into a rule's reach, by a selector or a group taking a
   * device or a device's declaration changing. `defines-a-toggle-rule-silently` says none at
   * `define`, `re-declares-a-toggle-silently` none on a `describe`.
   */
  private sayToggles(changed?: (rule: string) => boolean): void {
    // Nothing is known of the devices before the first `describe`: a `define` then neither tells nor
    // seeds, so the first `describe` seeds silently (the milestone review, M2).
    if (this.mirror.applier === undefined) return;
    const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation };
    const now = new Map<string, { rule: string; target: string; action: string }>();
    for (const r of [...this.house.rules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const steps = resolveRequest(deviceActions(r).map(({ respect_occupancy: _r, ...a }) => a as Requested), view);
      for (const x of steps) if (this.mirror.toggleOnly(x.target, x.action)) now.set(`${r.id}\u0000${x.target}\u0000${x.action}`, { rule: r.id, target: x.target, action: x.action });
    }
    const told = this.togglesTold;
    this.togglesTold = new Set(now.keys());
    if (!told && !changed) return;
    for (const [k, t] of now) {
      const atDefine = changed?.(t.rule) === true;
      const fresh = !told?.has(k);
      if (atDefine ? this.mutation === "defines-a-toggle-rule-silently" : !fresh || (!changed && this.mutation === "re-declares-a-toggle-silently")) continue;
      this.notices.own(`steward:toggle:${t.rule}:${t.target}:${t.action}:${this.rev}`, "rule_toggle",
        `rule ${t.rule} acts on ${t.action} of ${t.target}, a toggle on a device that reports nothing: it will never run from the rule (GA-RULE-8)`,
        { rule: t.rule, target: t.target, action: t.action });
    }
  }

  /**
   * GA-RULE-8's toggle notice for schedules: one for each action a schedule's scenario reaches (through
   * its `run` steps too) that is a toggle on an open-loop device, saying it will never run from the
   * schedule, at the `define` that sets or changes the schedule (`changed`), and whenever such an action
   * newly comes into its reach (the scenario changed, a selector or a group taking a device, a
   * declaration changing), as `sayToggles` does for rules. `schedules-a-toggle-silently` says none at a `define`.
   */
  private sayScheduleToggles(changed?: (schedule: string) => boolean): void {
    const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation };
    const now = new Map<string, { schedule: string; scenario: string; target: string; action: string }>();
    for (const s of [...this.house.schedules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      for (const n of compile(this.house, s.scenario).actions) {
        for (const x of resolveRequest([n.action], view)) {
          if (this.mirror.toggleOnly(x.target, x.action)) now.set(`${s.id}\u0000${x.target}\u0000${x.action}`, { schedule: s.id, scenario: s.scenario, target: x.target, action: x.action });
        }
      }
    }
    const told = this.scheduleTogglesTold;
    this.scheduleTogglesTold = new Set(now.keys());
    if (!told && !changed) return;
    for (const [k, t] of now) {
      const atDefine = changed?.(t.schedule) === true;
      if (changed && this.mutation === "schedules-a-toggle-silently") continue;
      if (!atDefine && told?.has(k)) continue;
      this.notices.own(`steward:schedule-toggle:${t.schedule}:${t.target}:${t.action}:${this.rev}`, "schedule_toggle",
        `schedule ${t.schedule} runs scenario ${t.scenario}, which acts on ${t.action} of ${t.target}, a toggle on a device that reports nothing: it will never run from the schedule (GA-RULE-8)`,
        { schedule: t.schedule, scenario: t.scenario, target: t.target, action: t.action });
    }
  }

  /** A step: the `notices` of one of the applier's `events` answers (GA-NOTE-1). */
  onNotices(notices: Args[]): void {
    const known = new Set(this.notices.all().map((n) => n.notice_id));
    this.notices.listed(notices);
    if (this.mutation === "loses-an-early-notice" && !this.house.home.notice_channels.length) {
      for (const n of notices) if (!known.has(String(n.notice_id))) this.notices.lose(String(n.notice_id));
    }
  }

  /** The notices delivered that the next `events` call to the applier names in `notice_taken` (GA-NOTE-1). */
  noticesTaken(): string[] {
    return this.notices.taken();
  }

  /**
   * One attempt at a notice (the design, *Notices*): a `notify` on each of the home's notice channels
   * the applier has with `notify`, as one applier apply keyed `key`, sent `via: rule`, `brain: false`,
   * `for: { notice }`, with `from: { notice }` from applier 0.10 on and none before (GA-NOTE-2); a
   * `critical` notice for a safety rule's cause, else `warning`. Delivered when a channel's `notify`
   * ends `delivered`, or `sent` where it reports no receipt. Announcing channels are slice 9's.
   */
  private async sendNotice(batch: Notice[], key: string): Promise<void> {
    // The adopted channels offering notify; held, while there is none (GA-NOTE-1).
    const channels = notifyChannels(this.house.home, this.defineContext(false));
    if (!channels.length || !this.o.applierApply) return;
    const actions = batch.flatMap((n) => {
      const args = this.fromOf({ text: String(n.doc.text ?? ""), urgency: n.doc.cause === "safety_rule" ? "critical" : "warning" }, { notice: n.notice_id });
      return channels.map((target) => ({ target, action: "notify.notify", args, via: "rule", brain: false, for: { notice: n.notice_id } }));
    });
    const id = key;
    this.inFlight.add(id);
    let answer: Args | undefined;
    try {
      answer = await this.o.applierApply({ request: { actions }, idempotency_key: key }, REPEAT_WINDOW_MS);
    } catch {
      answer = undefined;
    } finally {
      this.inFlight.delete(id);
    }
    // The answer is the pump's before the events held for it are relayed, so its outcome events find it.
    if (answer) {
      const outcomes = Array.isArray(answer.outcomes) ? answer.outcomes as Args[] : [];
      this.notices.answered(typeof answer.apply_id === "string" ? answer.apply_id : undefined, actions.map((a, i) => ({ notice_id: a.for.notice,
        ...(typeof outcomes[i]?.step_id === "string" ? { step_id: outcomes[i]!.step_id as string } : {}), delivered: this.deliveredOn(a.target, outcomes[i]?.outcome) })));
    }
    for (const b of this.parked) b.waitFor.delete(id);
    this.release();
    if (!this.inFlight.size && !this.lost.size) this.adoptOrphans();
    else if (typeof answer?.apply_id === "string") this.adoptOrphans(answer.apply_id);
  }

  /** Whether a `notify` on `channel` that ended `outcome` delivered its notice (GA-NOTE-1). */
  private deliveredOn(channel: string, outcome: unknown): boolean {
    return outcome === "delivered" || (outcome === "sent" && this.mirror.noReceipt(channel, "notify.notify"));
  }

  /** The applier's identity as the steward follows it: its id and its run id. */
  private applierNow(): string {
    return canonical({ applier_id: this.mirror.applier?.applier_id ?? null, test_run_id: this.mirror.applier?.test_run_id ?? null });
  }

  /**
   * Reads back the applier's event the steward last had, and the applier it came from (`applier_last`).
   * Both it and the events are written behind, so after a crash either may be the later: the last
   * relayed event the store kept, of the same applier, counts when it is, so no event is relayed twice.
   */
  private async loadLastApplier(): Promise<void> {
    const kept = await getMeta(this.o.store, "applier_last");
    if (kept === undefined) return;
    const l = JSON.parse(kept) as Args;
    if (typeof l.seq !== "number" || typeof l.timeMs !== "number" || typeof l.applier !== "string") return;
    this.lastApplier = { seq: l.seq, timeMs: l.timeMs, applier: l.applier };
    for (const h of Array.isArray(l.held) ? l.held as Args[] : []) {
      if (typeof h.seq === "number" && typeof h.timeMs === "number") this.heldBack.set(h.seq, h.timeMs);
    }
    const f = this.followed ? JSON.parse(this.followed) as Args : undefined;
    if (!f || canonical({ applier_id: f.applier_id ?? null, test_run_id: f.test_run_id ?? null }) !== l.applier) return;
    const row = (await this.o.store.query<{ body: Args }>("SELECT body FROM events WHERE body ? 'applier_seq' ORDER BY seq DESC LIMIT 1")).rows[0];
    const seq = row?.body.applier_seq;
    if (typeof seq === "number" && seq > l.seq) {
      const t = Date.parse(String(row!.body.applier_time));
      this.lastApplier = { seq, timeMs: Number.isNaN(t) ? l.timeMs : t, applier: l.applier };
    }
  }

  /**
   * Writes the applier's event the steward last had for an event relayed with no row of its own:
   * behind, its value taken now. A write still waiting in the writer's line with no row handed over
   * after it takes the newer value instead, so a run of such events queues one write.
   */
  private saveLastApplier(): void {
    if (!this.lastApplier) return;
    const value = this.keptLastApplier();
    if (this.lastApplierAlone) {
      this.lastApplierAlone.value = value;
      return;
    }
    const slot = { value };
    this.lastApplierAlone = slot;
    void this.o.store.write((tx) => {
      if (this.lastApplierAlone === slot) this.lastApplierAlone = undefined;
      return setMeta(tx, "applier_last", slot.value);
    });
  }

  /**
   * The write of the applier's event the steward last had, as it stands now, for the write set of the
   * row of the event relayed now: every row of an event before it was handed to the writer first, so
   * the kept value is never ahead of the kept rows (the milestone 7+10+11 review, B1). Safe to run twice.
   */
  private lastApplierWrite(): ((tx: Tx) => Promise<void>) | undefined {
    if (!this.lastApplier) return undefined;
    const value = this.keptLastApplier();
    return (tx) => setMeta(tx, "applier_last", value);
  }

  /**
   * `applier_last` as it is kept: the applier's last event, and each orphan held in memory with its
   * `seq` and time (`held`), which the position has passed without relaying it, so a restart still reads
   * it (the code review, CR5); with those a restart did not read again yet (`heldBack`).
   */
  private keptLastApplier(): string {
    const held = new Map(this.heldBack);
    for (const e of this.orphans) {
      if (typeof e.seq !== "number") continue;
      const t = Date.parse(String(e.time));
      held.set(e.seq, Number.isNaN(t) ? this.lastApplier!.timeMs : t);
    }
    const list = [...held].sort((a, b) => a[0] - b[0]).map(([seq, timeMs]) => ({ seq, timeMs }));
    return JSON.stringify({ ...this.lastApplier, ...(list.length ? { held: list } : {}) });
  }

  /** The applier's event the steward last had, for the link's recovery; none before the first. */
  lastApplierEvent(): { seq: number; timeMs: number } | undefined {
    // An orphan the last life held unrelayed: the history is read back to just before it (CR5).
    const oldest = [...this.heldBack].sort((a, b) => a[0] - b[0])[0];
    if (this.lastApplier && oldest && oldest[0] <= this.lastApplier.seq) return { seq: oldest[0] - 1, timeMs: Math.min(oldest[1], this.lastApplier.timeMs) };
    // The mutation reads back the replay bound's worth of events it already had, to replay their edges again.
    if (this.lastApplier && this.mutation === "replays-a-fired-edge") return { seq: 0, timeMs: this.lastApplier.timeMs - EDGE_REPLAY_MS };
    return this.lastApplier ? { seq: this.lastApplier.seq, timeMs: this.lastApplier.timeMs } : undefined;
  }

  /**
   * A step: a sync after a gap (a `cursor_expired`, a start, a session made again; the design,
   * *Recovery*). `missed` is the applier's history since the last event the steward had; those after
   * it and up to the sync's `cursor` are what the gap held, if the applier is the one followed. Each
   * is recorded in the steward's log, marked `recovered`, with the steward's time and its own as
   * `applier_time`, and does there what a relayed event does but act: an `external` or `load_cap`
   * change's lease for what is left of its hold (GA-LEASE-2), a safety rule's lease granted or ended
   * (GA-LEASE-6), an apply's outcome moved on, and a level rule it made false counted as no longer
   * fired, and an edge within `EDGE_REPLAY_MS` owed to its rule. Then the state is read as on any
   * sync: held latches, every level rule that holds and has not fired for it fires (GA-RULE-1), and
   * each owed edge fires once. At start the state is first taken as the baseline the gap
   * is played over, since nothing older is known.
   */
  recover(missed: Args[], s: Args, cursor: string, older: Dropped = { count: 0, targets: [] }): void {
    // The gap's events come after every batch held before it; those batches are in the history read
    // too, so the gap starts after them, each event relayed once (the milestone 7+10+11 review, B3).
    this.release(true);
    const last = this.lastApplier;
    const upTo = /^\d+$/.test(cursor) ? Number(cursor) : Infinity;
    let gap = last && last.applier === this.applierNow()
      ? missed.filter((e) => typeof e.seq === "number" && (e.seq > last.seq || this.heldBack.has(e.seq)) && e.seq <= upTo).sort((a, b) => a.seq - b.seq) : [];
    // The orphans the last life held are read now, or lost (CR5): the next write keeps none of them.
    this.heldBack.clear();
    // Past the cap the oldest are dropped, but never one that grants or ends a lease (`mustRecover`; I2).
    const cap = this.o.recoveryCap ?? RECOVERY_CAP;
    const rest = gap.filter((e) => !mustRecover(e));
    const dropped = rest.slice(0, Math.max(0, rest.length - cap));
    if (dropped.length) {
      const out = new Set(dropped);
      gap = gap.filter((e) => !out.has(e));
    }
    if (dropped.length || older.count) {
      this.sayOnce("recovery-cap", `a gap held more than ${cap} of the applier's events: the oldest were not recorded`);
    }
    const atStart = !this.synced;
    if (atStart) this.mirror.setState(s, Math.floor(this.o.clock.now()));
    // The mutation replays the edges of events it had before the gap, as a steward reading back an overlap would.
    if (this.mutation === "replays-a-fired-edge" && last) {
      for (const e of missed) {
        const t = Date.parse(String(e.time));
        if (typeof e.seq === "number" && e.seq <= last.seq && !Number.isNaN(t)) this.rules.replayEdge(e, this.onStewardClock(t), t);
      }
    }
    // A rule firing's step that ended in the gap is judged once the state is read, its conditions known then (GA-RULE-7).
    const later: [ApplyRecord, string][] = [];
    this.settleLater = later;
    this.restartGap = atStart;
    try {
      for (const e of gap) this.relay(e, false, true);
    } finally {
      this.settleLater = undefined;
      this.restartGap = false;
    }
    const named = [...dropped.map((e) => e.target), ...older.targets].filter((x): x is string => typeof x === "string");
    for (const t of [...new Set(named)].sort()) this.rules.replayed(t, true);
    this.onState(s);
    for (const [r, step] of later) this.ruleOutcome(r, step);
    // A state edge the gap held within `edge_replay_s` fires now, once (GA-RULE-1).
    this.rules.fireOwed();
    for (const w of [...this.waiting]) w.check();
  }

  /** A step: the applier's `state`. A state change moves no revision (GA-HOUSE-1). */
  onState(s: Args): void {
    this.mirror.setState(s, Math.floor(this.o.clock.now()));
    this.latchesRead();
    this.synced = true;
    // The notices held when the steward stopped wait from now on their timers, the gap read first:
    // a late ack in it has landed them (GA-PERSIST-2, GA-RULE-8).
    this.after.resume();
    // Every rule against the state as read: one that holds and has not fired fires (GA-RULE-1).
    this.rules.sync();
  }

  /**
   * A step: a batch of the applier's events, relayed into the steward's log with its causes (steward,
   * *Causes and history*). While one of the steward's applies awaits its answer, every batch waits for
   * it, and every batch after it behind it: an `outcome` event may be that apply's, and the steward's
   * own `outcome` event, put when the answer comes, goes before the changes the apply caused. At most
   * `PARKED_CAP` events wait; past it the batches are relayed, their outcome events of an apply not
   * yet known held back for its answer (`orphans`).
   */
  onEvents(events: Args[]): void {
    if (this.parked.length || this.inFlight.size) {
      this.parked.push({ events, waitFor: new Set(this.inFlight) });
      this.parkedCount += events.length;
      if (this.parkedCount > (this.o.parkedCap ?? PARKED_CAP)) this.release(true);
      return;
    }
    for (const e of events) this.relay(e);
  }

  /** Relays the parked batches no awaited apply holds back any more, in order; `all`, every one. */
  private release(all = false): void {
    while (this.parked.length && (all || this.parked[0]!.waitFor.size === 0)) {
      const b = this.parked.shift()!;
      this.parkedCount -= b.events.length;
      for (const e of b.events) this.relay(e);
    }
  }

  /**
   * One of the applier's events, into the mirror and the steward's log: its `seq` and time kept as
   * `applier_seq` and `applier_time`, an apply's outcome named by the steward's apply and step with
   * the steward's cause, a change the steward's apply made given that apply's cause, other causes as
   * the applier gave them. A `state` event's `speech` and a personal key's `occurrence` are kept in
   * `events` only (GA-STW-7). An apply's `outcome` that would not move its step's outcome to a later
   * place (`outcomeRank`) is the applier's report of what the steward put already, or a late one, and is
   * not relayed. A witness's verdict, an `outcome` event carrying `witness` (applier GA-WIT-1), is relayed
   * as the applier gave it, named by the steward's apply, but never taken as the step's outcome, which
   * a client may have read: the step's own ack still lands after it. Steward 0.9 is silent on what a
   * verdict means to the steward's callers (the backlog).
   */
  private relay(e: Args, mirrored = false, recovered = false): void {
    if (!mirrored) this.mirror.applyEvent(e, Math.floor(this.o.clock.now()));
    if (typeof e.seq === "number" && (!this.lastApplier || e.seq > this.lastApplier.seq || this.lastApplier.applier !== this.applierNow())) {
      const t = Date.parse(String(e.time));
      this.lastApplier = { seq: e.seq, timeMs: Number.isNaN(t) ? Math.floor(this.o.clock.now()) : t, applier: this.applierNow() };
    }
    if (!storable(e)) {
      this.sayOnce("unstorable", `an event of the applier's holds U+0000 or a lone surrogate; it is not relayed (seq ${String(e.seq)})`);
      return this.saveLastApplier();
    }
    const { seq, time, type, ...rest } = e;
    const body: Args = { ...rest, applier_seq: seq, applier_time: time, ...(recovered ? { recovered: true } : {}) };
    const r = (type === "outcome" || type === "late_ack") ? this.byApplier.get(String(e.apply_id)) : undefined;
    const verdict = type === "outcome" && e.witness !== undefined;
    // A notice attempt's outcome is the pump's: it shows as the notice's `notice` event, not relayed.
    if (!r && type === "outcome" && !verdict && this.notices.outcome(String(e.apply_id), String(e.step_id), this.deliveredOn(String(e.target), e.outcome))) {
      return this.saveLastApplier();
    }
    // A safety rule's actuation names its rule, not an apply: never one of the steward's to wait for.
    // An orphan is held in memory, and the kept position names it (`held`) once it moves past it: a restart reads it again (CR5).
    if (!r && (type === "outcome" || type === "late_ack") && typeof e.apply_id === "string" && (this.inFlight.size || this.lost.size)) {
      this.orphan(e);
      return;
    }
    if (r) {
      const step = r.steps[String(e.step_id)] ?? String(e.step_id);
      Object.assign(body, { apply_id: r.apply_id, step_id: step, cause: r.cause });
      const now = r.outcomes.find((o) => o.step_id === step);
      if (type === "outcome" && !verdict && (!now || outcomeRank(e.outcome) <= outcomeRank(now.outcome))) return this.saveLastApplier();
    } else if (e.cause && typeof e.cause === "object" && (e.cause as Args).client === this.o.applierClient && (e.cause as Args).for) {
      body.cause = (e.cause as Args).for;
    }
    const device = this.mirror.devices.get(String(e.target));
    const personal = Array.isArray(device?.personal) ? device!.personal as string[] : [];
    const eventsOnly = (type === "state" && e.key === "speech") || (type === "occurrence" && personal.includes(String(e.key)));
    // A value's key marked personal as it happens; a device not described then is not known, and counts as personal.
    const mark = type !== "state" && type !== "occurrence" ? false : device === undefined ? null : personal.includes(String(e.key));
    this.lastApplierAlone = undefined;
    const ev = this.log.append(String(type), body, { eventsOnly, personal: mark }, this.lastApplierWrite());
    // When it happened: now, or, missed in a gap, the applier's time for it.
    const now = Math.floor(this.o.clock.now());
    const at = recovered && !Number.isNaN(Date.parse(String(time))) ? Math.min(now, Date.parse(String(time))) : now;
    if (!recovered && !Number.isNaN(Date.parse(String(time)))) this.applierOffset = now - Date.parse(String(time));
    // An outside change, or a load cap's, takes a person-precedence lease for the hold time; a device's own takes none (GA-LEASE-2).
    // One missed in a gap takes it for what is left of its hold, and never over a lease granted after it.
    const forgot = recovered && this.restartGap && this.mutation === "forgets-a-restart-hand";
    if (type === "state" && (e.cause === "external" || e.cause === "load_cap") && typeof e.target === "string" && this.mutation !== "ignores-leases" && !forgot) {
      const expiresMs = at + this.house.home.hold_time_s * 1000;
      const held = this.leases.of(e.target);
      if (expiresMs > now && !(recovered && held && held.sinceMs > at)) {
        this.leases.grant({ target: e.target, holder: e.cause, precedence: "person", sinceMs: at, expiresMs });
      }
    }
    this.safetyLeases(String(type), e, at);
    // A device seen dead lets every wait on it go: its safety rules' completions may never come (the code review, CR1).
    if (type === "liveness" && e.new === "dead" && typeof e.target === "string") {
      for (const [rule, held] of [...this.endedEarly]) if (held.has(e.target)) this.letEarlyGo(rule, e.target);
    }
    // A step that ends unreachable sent nothing: the lease it took ends (GA-LEASE-1).
    if (r && type === "outcome" && !verdict && e.outcome === "unreachable") this.leases.end(String(body.target), (l) => l.apply === r.apply_id);
    if (r && type === "outcome" && !verdict) {
      const i = r.outcomes.findIndex((o) => o.step_id === body.step_id);
      if (i >= 0) {
        r.outcomes[i] = { step_id: r.outcomes[i]!.step_id, target: r.outcomes[i]!.target, outcome: e.outcome, ...(e.reason !== undefined ? { reason: e.reason } : {}),
          ...(e.detail !== undefined ? { detail: e.detail } : {}), time: ev.time };
        this.saveApply(r);
        this.ruleOutcome(r, String(body.step_id));
      }
    }
    // A late ack is a success: the rule's action is not tried again (GA-RULE-7).
    if (r?.firing && type === "late_ack") this.after.landed(r.firing, String(body.step_id));
    // A run's failed step that has its late ack while the run runs is no failure of it (steward, *Operations*).
    if (r?.run && type === "late_ack" && this.runs.get(r.run.id)?.status === "running") this.runs.get(r.run.id)!.lateAcked.add(String(body.step_id));
    // A sensor's change may make its room's occupancy known (GA-RULE-8's coalesced notice).
    const roomOfIt = typeof e.target === "string" && (type === "state" || type === "liveness") ? this.house.targets.get(e.target)?.room : undefined;
    if (roomOfIt) this.sensorSeen(roomOfIt, e, recovered);
    // Missed in a gap: a level rule it made false counts as no longer fired; nothing acts on it now.
    if (recovered) {
      if (typeof e.target === "string" && (type === "state" || type === "liveness")) this.rules.replayed(e.target);
      const t = Date.parse(String(time));
      this.rules.replayEdge(e, Number.isNaN(t) ? now : this.onStewardClock(t), Number.isNaN(t) ? undefined : t);
      return;
    }
    // A `wait` on the device looks again (GA-SCN-10).
    for (const w of [...this.waiting]) if (w.target === e.target) w.check();
    // A rule reading the device looks again; an edge trigger it matches fires (the design, *Rules*).
    this.rules.onEvent(e);
  }

  /**
   * GA-LEASE-6 on one of the applier's events, which happened at `atMs`: a safety rule's actuation (an
   * `outcome` naming the rule, a `state` change it caused, or its latch `set`) gives each device it
   * actuated a `safety_rule` lease, held by `{ safety_rule }` with no end of its own; the rule's latch
   * `cleared` or `cleared_by_owner` ends them, and so does its `rule_fired`, issued once it completes,
   * when the rule has no latch (as `describe` lists it, else by whether `state` lists a latch held for
   * it). `ignores-leases` grants none.
   */
  private safetyLeases(type: string, e: Args, atMs: number): void {
    if (this.mutation === "ignores-leases") return;
    const cause = e.cause && typeof e.cause === "object" ? (e.cause as Args).safety_rule : undefined;
    const rule = type === "state" && typeof cause === "string" ? cause : type === "outcome" && typeof e.rule_id === "string" ? e.rule_id as string
      : (type === "latch" || type === "rule_fired") && typeof e.rule_id === "string" ? e.rule_id as string : undefined;
    if (rule === undefined) return;
    if (type === "latch") {
      if (e.latch === "set") this.latchesSeen.add(rule);
      else this.latchesSeen.delete(rule);
    }
    if (type === "latch" && e.latch !== "set") return this.endSafety(rule);
    if (type === "rule_fired") {
      // The rule's completion ends every lease it holds when the completion is relayed. The applier's
      // events are relayed in its order, live and read from a gap alike, so each of those leases was
      // granted by an event before it, and one granted after it is not there yet. Never by comparing
      // the applier's time with the steward's: the two clocks differ (the code review, CR3).
      if (!this.latched(rule)) this.endSafety(rule);
      this.safetyCompleted(rule);
      return;
    }
    const targets = type === "latch" ? this.latchDevices(rule, e.devices) : typeof e.target === "string" ? [e.target] : [];
    for (const target of targets) this.grantSafety(rule, target, atMs);
  }

  /**
   * The devices a latch of `rule` holds: those a `latch` event or `state`'s latch names, a build's
   * extension; else, as applier 0.14 gives neither, the devices the rule actuates as `describe` lists it
   * (the milestone 7+10+11 review, I6).
   */
  private latchDevices(rule: string, named: unknown): string[] {
    const listed = (Array.isArray(named) ? named as unknown[] : []).filter((t): t is string => typeof t === "string");
    return listed.length ? listed : this.mirror.safetyRules.get(rule)?.devices ?? [];
  }

  /**
   * Whether safety rule `rule` declares a latch, as `describe` lists it; for a rule `describe` does not
   * list yet (configured just before it fired, the model not yet read again), whether its latch was
   * seen set and not cleared, or `state` lists one held for it.
   */
  private latched(rule: string): boolean {
    return this.mirror.safetyRules.get(rule)?.latch ?? (this.latchesSeen.has(rule) || this.mirror.heldLatches().some((l) => l.rule_id === rule));
  }

  /**
   * `target`'s `safety_rule` lease for `rule`, from `atMs`, unless that rule holds one there already,
   * the device's or beneath another rule's (GA-LEASE-6, GA-LEASE-3).
   */
  private grantSafety(rule: string, target: string, atMs: number): void {
    // A latchless rule's lease ends at its completion, or `LATCHLESS_SAFETY_MS` after it was granted should
    // that completion never be read (the milestone 7+10+11 review, I2); a latching rule's has no end of its own.
    const ackMs = this.mirror.longestAckS(target) * 1000;
    const bound = this.mutation === "ends-a-safety-lease-early" ? ackMs : Math.max(LATCHLESS_SAFETY_MS, ackMs + LATE_ACK_WINDOW_MS);
    const expiresMs = this.latched(rule) ? null : atMs + bound;
    const now = this.o.clock.now();
    if (expiresMs !== null && expiresMs <= now) return;
    // A lease of the rule past its end, beneath another rule's, is none: it does not stand in the way (the code review, CR4).
    const held = this.leases.safetyRules(target).find((l) => safetyRuleOf(l) === rule && (l.expiresMs === null || l.expiresMs > now));
    if (held && (held.expiresMs === null || expiresMs !== null)) return;
    this.leases.grant({ target, holder: { safety_rule: rule }, precedence: "safety_rule", sinceMs: held?.sinceMs ?? atMs, expiresMs });
  }

  /** An applier time on the steward's clock, by the offset last seen (none known: the clocks taken to agree), never past now. */
  private onStewardClock(applierMs: number): number {
    return Math.min(Math.floor(this.o.clock.now()), applierMs + (this.applierOffset ?? 0));
  }

  /**
   * A lease came off `target`: a latchless safety rule's that ran out its time (`safety_lease_s`) before
   * the rule's completion was read is an early end, and the rules the applier then refuses `safety`
   * on the device wait for that completion (GA-LEASE-6).
   */
  private safetyEndedEarly(target: string, lease: Lease): void {
    const rule = safetyRuleOf(lease);
    if (rule === undefined || lease.expiresMs === null || this.o.clock.now() < lease.expiresMs) return;
    const held = this.endedEarly.get(rule) ?? new Map<string, Set<string>>();
    if (!held.has(target)) held.set(target, new Set());
    this.endedEarly.set(rule, held);
    // The wait is bounded: should the completion never be read, it goes the lease's own bound plus the
    // late-ack window after the early end, and its rules are re-evaluated (the code review, CR1).
    const k = `${rule}\u0000${target}`;
    const t = this.earlyTimers.get(k);
    if (t !== undefined) this.o.clock.clear(t);
    this.earlyTimers.set(k, this.o.clock.setTimeout(() => this.letEarlyGo(rule, target), lease.expiresMs - lease.sinceMs + LATE_ACK_WINDOW_MS));
  }

  /** The waits of the safety rules whose lease on `target` the steward ended early, their completion not yet read. */
  private earlyOn(target: string): Set<string>[] {
    return [...this.endedEarly.values()].flatMap((held) => (held.has(target) ? [held.get(target)!] : []));
  }

  /** Lets `rule`'s wait on `target` go, re-evaluating the rules refused `safety` there meanwhile (GA-LEASE-6). */
  private letEarlyGo(rule: string, target: string): void {
    const held = this.endedEarly.get(rule);
    const rules = held?.get(target);
    if (!held || !rules) return;
    held.delete(target);
    if (!held.size) this.endedEarly.delete(rule);
    const k = `${rule}\u0000${target}`;
    const t = this.earlyTimers.get(k);
    if (t !== undefined) this.o.clock.clear(t);
    this.earlyTimers.delete(k);
    if (rules.size) this.rules.leaseEnded(target, [...rules].sort());
  }

  /**
   * Safety rule `rule`'s completion was relayed: each level-triggered rule the applier refused `safety`
   * on a device whose lease of it the steward ended early is re-evaluated, and fires if it holds (GA-LEASE-6).
   */
  private safetyCompleted(rule: string): void {
    const held = this.endedEarly.get(rule);
    if (!held) return;
    for (const target of [...held.keys()].sort()) this.letEarlyGo(rule, target);
  }

  /** Ends every lease safety rule `rule` holds, each a `lease` event and GA-LEASE-4's re-evaluation. */
  private endSafety(rule: string): void {
    this.leases.endSafety((x) => safetyRuleOf(x) === rule);
  }

  /**
   * The latches `state` lists, read (GA-LEASE-6): each held latch's devices hold its rule's lease; a
   * lease of a rule `describe` says latches whose latch is no longer held ends, its clearing missed.
   * A latchless rule's lease is not judged here: its `rule_fired` ends it.
   */
  private latchesRead(): void {
    if (this.mutation === "ignores-leases") return;
    const held = this.mirror.heldLatches();
    const now = Math.floor(this.o.clock.now());
    for (const l of held) for (const target of this.latchDevices(l.rule_id, l.devices)) this.grantSafety(l.rule_id, target, now);
    const holding = new Set(held.map((l) => l.rule_id));
    const ended = new Set([...this.leases.safetyHolders()].filter((r) => !holding.has(r) && this.mirror.safetyRules.get(r)?.latch === true));
    for (const rule of [...ended].sort()) this.endSafety(rule);
  }

  /** Holds an outcome event of an apply not yet known, for its answer; the oldest dropped past the cap. */
  private orphan(e: Args): void {
    this.orphans.push(e);
    if (this.orphans.length > (this.o.parkedCap ?? PARKED_CAP)) {
      this.orphans.shift();
      this.sayOnce("orphans-dropped", "the applier's outcome events of an unknown apply passed the cap while an apply was awaited; the oldest were dropped");
    }
  }

  /** Relays the held outcome events of `applierApplyId`, or every one when none is named. */
  private adoptOrphans(applierApplyId?: string): void {
    const mine = this.orphans.filter((e) => applierApplyId === undefined || String(e.apply_id) === applierApplyId);
    if (!mine.length) return;
    this.orphans = this.orphans.filter((e) => !mine.includes(e));
    for (const e of mine) this.relay(e, true);
    // Relayed now: the kept value no longer names them (CR5).
    this.saveLastApplier();
  }

  private bump(): void {
    this.rev++;
    this.revision.schedule();
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    for (const w of [...this.waiters]) w();
  }

  /** `describe { since_revision, wait_s }` returns at the next revision, or after `wait_s` on the clock. */
  private async describe(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    if (a.since_revision === this.rev && a.wait_s) {
      await new Promise<void>((resolve) => {
        const done = () => { this.waiters.delete(done); this.o.clock.clear(timer); resolve(); };
        const timer = this.o.clock.setTimeout(done, a.wait_s * 1000);
        this.waiters.add(done);
      });
    }
    // The bound on replaying an edge from a gap (GA-RULE-1).
    const replay = this.mutation === "replays-undeclared" ? {} : { edge_replay_s: EDGE_REPLAY_MS / 1000 };
    // The bound after which a latchless safety rule's lease may end before its completion is read (GA-LEASE-6).
    const safety = this.mutation === "ends-a-safety-lease-undeclared" ? {} : { safety_lease_s: LATCHLESS_SAFETY_MS / 1000 };
    const base = { steward_id: this.o.stewardId, standard_version: STANDARD_VERSION, revision: this.rev, ...replay, ...safety,
      ...(this.o.runId ? { test_run_id: this.o.runId } : {}) };
    // The notices held, while no adopted channel offers notify (GA-NOTE-1).
    const held = this.mutation === "hides-the-held-notices" || hasNotifyChannel(this.house.home, this.defineContext(false)) ? {}
      : { held_notices: this.notices.held() };
    const empty = { scenarios: [], rules: [], schedules: [], groups: [], modes: [...MODES] };
    const applier = { applier_id: this.mirror.applier?.applier_id ?? "", levels: this.mirror.applier?.levels ?? [],
      ungoverned: this.mirror.applier?.ungoverned ?? [] };
    if (caller.credential.kind === "front") {
      // A front sees only its endpoints, the persons' ids and the two home settings it needs (GA-AUTH-8).
      return { ...base, ...empty, applier, rooms: [], targets: [],
        home: { audio_retention_s: this.house.home.audio_retention_s, other_wake_words: this.house.home.other_wake_words },
        endpoints: byId(boundEndpoints(this.house, caller.credential)).map((e) => ({ id: e.id, type: e.type, person: e.person,
          served_by: e.served_by, voice: e.voice })),
        persons: byId([...this.house.persons.values()]).map((p) => ({ id: p.id })) };
    }
    const ownersApp = this.isOwnersApp(caller);
    const shown = (id: string) => ownersApp || this.mirror.devices.get(id)?.internal !== true;
    return { ...base, ...held, ...empty, applier, home: this.house.home, rooms: byId([...this.house.rooms.values()]),
      rules: byId([...this.house.rules.values()]), scenarios: byId([...this.house.scenarios.values()]), schedules: byId([...this.house.schedules.values()]),
      // Each device as the applier describes it, with the steward's overlay (names, aliases, room) over it.
      targets: byId([...this.mirror.devices.values()].filter((d) => ownersApp || d.internal !== true).map((d) => {
        const o = this.house.targets.get(d.id as string);
        return { ...d, id: d.id as string, name: o?.name ?? d.label ?? d.id, aliases: o?.aliases ?? [], room: o?.room ?? null,
          ...(deviceMarked(this.house, d.id as string) ? { brain_authored: true } : {}) };
      })),
      // A group a device's id shadows is flagged: it cannot be targeted until it is renamed.
      // A member marked internal after it was grouped is shown in the group to the owner's app only.
      groups: byId([...this.house.groups.values()]).map(({ brain_joined: _b, ...g }: Group) => ({ ...g, members: g.members.filter(shown),
        ...(this.mirror.devices.has(g.id) ? { shadowed: true } : {}) })),
      endpoints: byId([...this.house.endpoints.values()]).map(endpointView),
      // Persons by id, name and role only; credentials never (steward, *Operations*).
      persons: byId([...this.house.persons.values()]).map((p) => ({ id: p.id, name: p.name, role: p.role })) };
  }

  /**
   * `define` (steward, *define*): an owner's, from an endpoint no brain serves (GA-DEF-3); a change set
   * applied whole or not at all (GA-DEF-5), at the current revision (GA-DEF-2), or a dry run's diff
   * (GA-DEF-1). It waits in the owners' line and reaches memory only once it commits. While the store
   * is known down, or the line is full, it is refused at once, `pending: false`. One not answered in
   * 10 s, waiting its turn or its commit, is answered `pending: true`, and is still judged and applied
   * when its turn comes; its `expected_revision` guards the race (the design, *The store unreachable*).
   * A new `time_source` is checked before, and the clock moved only once the change has committed.
   * Through a brain, what the policy takes (`brainMayDefine`) is asked first (`askDefine`, GA-DEF-6),
   * and applied by `define { plan_id }` (`defineByPlan`).
   */
  private async define(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    const p = principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    if (a.plan_id !== undefined) return this.defineByPlan(a, caller, p);
    if (p.brain) {
      brainMayDefine(p, a.changes as Change[]);
      return this.askDefine(a, caller, p);
    }
    if (p.role !== "owner") {
      throw new RequestError("not_permitted", `define is an owner's, from an endpoint no brain serves (GA-DEF-3): here ${p.role}`);
    }
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: define is refused until it returns", false);
    if (this.owners.full) throw new StoreUnavailable(`the owners' line is full: ${OWNERS_CAP} changes wait for the store; define is refused`, false);
    const change = this.owners.run(async () => {
      if (a.expected_revision !== this.rev) {
        throw new RequestError("stale_revision", `expected_revision ${a.expected_revision}, current ${this.rev}`);
      }
      const { draft, diff } = planDefine(this.house, a.changes as Change[], this.defineContext(false));
      if (a.dry_run) return this.toldOfChannels({ diff: diff.length ? diff.join("\n") : "no change" }, draft);
      if (!diff.length) return this.toldOfChannels({ revision: this.rev });
      return this.toldOfChannels(await this.commitDefine(draft, diff, p));
    });
    return within(this.o.clock, GATE_MS, change, HELD);
  }

  /**
   * A `define` answer, with `no_notify_channel: true` when the house after it (`house`, the current one
   * unless a dry run's draft) has no adopted channel offering `notify` (GA-NOTE-1).
   */
  private toldOfChannels(answer: Record<string, unknown>, house: House = this.house): Record<string, unknown> {
    if (this.mutation === "hides-no-notify-channel" || hasNotifyChannel(house.home, this.defineContext(false))) return answer;
    return { ...answer, no_notify_channel: true };
  }

  /** What `define` reads of the applier and the run, and whether the change set is a brain's (GA-DEF-7). */
  private defineContext(brain: boolean) {
    return { device: (id: string) => this.mirror.deviceView(id), underHarness: this.mirror.underHarness, mutation: this.mutation, brain };
  }

  /**
   * A `define` through a brain the policy takes (GA-DEF-6): judged now, at the current revision, outside
   * the owners' line, since it changes nothing; a dry run gives the diff, marks included, and a change
   * set that changes nothing its revision; any other is a plan with one `ask(confirm_define)` step
   * carrying the diff, held and asked as any plan with an ask (committed first, its `ask` event put).
   * Its request keeps the change set, so `define { plan_id }` applies what was asked, and a restart reads
   * it back with the plan.
   */
  private async askDefine(a: Args, caller: Extract<Caller, { kind: "credential" }>, p: Principal): Promise<Record<string, unknown>> {
    if (a.expected_revision !== this.rev) throw new RequestError("stale_revision", `expected_revision ${a.expected_revision}, current ${this.rev}`);
    const { diff } = planDefine(this.house, a.changes as Change[], this.defineContext(true));
    if (a.dry_run) return { diff: diff.length ? diff.join("\n") : "no change" };
    if (!diff.length) return { revision: this.rev };
    const request = { endpoint: p.endpoint, ...(p.speaker !== undefined ? { speaker: p.speaker } : {}), changes: a.changes, expected_revision: this.rev };
    const step: DefineStep = { step_id: "s1", verdict: "ask", reason: "confirm_define", diff: diff.join("\n") };
    return await this.keepPlan(caller.credential.id, p, this.rev, request, [step]) as unknown as Record<string, unknown>;
  }

  /**
   * `define { plan_id }` (steward, *define*, *Apply*): the plan checked as `apply` checks one
   * (`unknown_plan`, `plan_not_yours`, a plan of another kind `invalid_request`, its endpoint and speaker
   * governing, `plan_expired`, `stale_revision`; GA-STW-5, GA-DEF-2), then spent. Unanswered, or
   * answered `no`, nothing changes and the answer says `skipped: not_confirmed` (GA-DEF-6); answered
   * `yes`, its change set is judged again in the owners' line at the plan's revision and applied as the
   * brain's, marked (GA-DEF-7), with the plan's spending in the same write set.
   */
  private async defineByPlan(a: Args, caller: Extract<Caller, { kind: "credential" }>, p: Principal): Promise<Record<string, unknown>> {
    this.forgetPlans();
    const held = this.plans.get(a.plan_id);
    if (!held) throw new RequestError("unknown_plan", `no plan ${a.plan_id} is held`);
    if (held.credential !== caller.credential.id) throw new RequestError("plan_not_yours", "another credential made this plan (GA-STW-5)");
    const changes = held.plan.request.changes;
    if (!Array.isArray(changes)) {
      throw new RequestError("invalid_request", "define takes a define's plan: a request's plan is applied, a scenario's run with scenario_run");
    }
    if (held.plan.endpoint !== p.endpoint || held.plan.speaker !== p.speaker) {
      throw new RequestError("invalid_request", "a define names its plan's endpoint and speaker (steward, *Apply*)");
    }
    if (Math.floor(this.o.clock.now()) > held.expiresMs) throw new RequestError("plan_expired", "the plan expired (GA-STW-5)");
    if (held.plan.revision !== this.rev) {
      throw new RequestError("stale_revision", `the plan was made at revision ${held.plan.revision}, the house is at ${this.rev} (GA-DEF-2)`);
    }
    if (held.applied) throw new RequestError("plan_expired", "the plan was applied already: a define spends it");
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: define is refused until it returns", false);
    if (this.owners.full) throw new StoreUnavailable(`the owners' line is full: ${OWNERS_CAP} changes wait for the store; define is refused`, false);
    // Spent before anything is awaited, so a second define of it waits for nothing and finds it spent.
    held.applied = true;
    if (held.answers.s1 !== "yes") {
      // Unanswered, nothing changes (GA-DEF-6); the plan is spent, kept so before the answer is read.
      const spent = this.o.store.write((tx) => tx.query("UPDATE plans SET applied = true WHERE plan_id = $1", [held.plan.plan_id]).then(() => undefined));
      await within(this.o.clock, GATE_MS, spent, SPENT_HELD);
      return this.toldOfChannels({ revision: this.rev, skipped: "not_confirmed" });
    }
    const change = this.owners.run(async () => {
      try {
        if (held.plan.revision !== this.rev) {
          throw new RequestError("stale_revision", `the plan was made at revision ${held.plan.revision}, the house is at ${this.rev} (GA-DEF-2)`);
        }
        const { draft, diff } = planDefine(this.house, changes as Change[], this.defineContext(true));
        if (!diff.length) return this.toldOfChannels({ revision: this.rev });
        return this.toldOfChannels(await this.commitDefine(draft, diff, p, held.plan.plan_id));
      } catch (err) {
        // Judged and refused at its turn: nothing changed, and the plan is not spent.
        if (err instanceof RequestError) held.applied = false;
        throw err;
      }
    });
    return within(this.o.clock, GATE_MS, change, HELD);
  }

  /**
   * Commits a change set the owners' line judged: the model, the schedules' marks, the revision and,
   * for a brain's, its plan spent, in one write set; then memory, the `define` event with its cause
   * (the endpoint, the person, the plan), the notices `define` owes, and the clock and the schedules'
   * timers as the model now is.
   */
  private async commitDefine(draft: House, diff: string[], p: Principal, planId?: string): Promise<Record<string, unknown>> {
    const source = draft.home.time_source;
    const retime = source !== this.house.home.time_source;
    if (retime && source) {
      if (!this.o.retarget) throw new RequestError("invalid_request", "this steward cannot take a time_source");
      await this.o.checkTimeSource?.(source).catch((err: unknown) => {
        throw new RequestError("invalid_request", `time_source ${source}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    const next = this.rev + 1;
    // A schedule made or changed takes its mark in the same change set, so it acts from its next run (the design, *Schedules*).
    const marks = this.schedules.marksFor(this.house, draft, Math.floor(this.o.clock.now()));
    await this.o.store.write(async (tx) => {
      await saveHouse(tx, draft);
      await saveMarks(tx, marks);
      await raiseMeta(tx, "revision", next);
      if (planId !== undefined) await tx.query("UPDATE plans SET applied = true WHERE plan_id = $1", [planId]);
    });
    // Committed: the change reaches memory. An applier model read while it waited moved `rev` on too.
    const before = this.house;
    this.house = draft;
    this.schedules.adopt(marks);
    this.rules.changed();
    this.rev = Math.max(next, this.rev + 1);
    this.revision.schedule();
    this.log.append("define", { revision: this.rev, endpoint: p.endpoint, person: p.person, ...(planId !== undefined ? { plan_id: planId } : {}), diff },
      { readers: { endpoint: p.endpoint, ...(p.speaker !== undefined ? { speaker: p.speaker } : {}) } });
    this.sayUnbounded(before, draft);
    this.sayUnboundedIfs(before, draft);
    this.sayToggles((id) => canonical(before.rules.get(id) ?? null) !== canonical(draft.rules.get(id) ?? null));
    this.sayScheduleToggles((id) => canonical(before.schedules.get(id) ?? null) !== canonical(draft.schedules.get(id) ?? null));
    this.wakeWaiters();
    this.channelsMoved(true);
    // The clock follows the model only once it is kept: a source set, or the start-up one when cleared.
    if (retime) {
      await this.o.retarget?.(source ?? null).catch((err: unknown) => {
        this.say(`the clock could not take time_source ${source ?? "(the start-up source)"}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // The schedules' timers, from the model and the clock as they now are.
    this.schedules.arm();
    return { revision: this.rev };
  }

  /**
   * `plan` (steward, *Plans*): two steps around the applier's plan, which runs outside them. The first
   * derives the principal (GA-AUTH-1, GA-AUTH-2) and resolves the request to steps (GA-PLAN-5,
   * GA-PLAN-6, GA-STW-2); the second merges the applier's steps into the steward's reason order
   * (GA-STW-4) and holds the plan. It changes nothing but for the `ask` event a plan with an ask emits
   * (GA-STW-1, GA-CONF-5); such a plan is committed before it is returned, so a plan with an ask is
   * refused while the store is known down, and dropped, never held late, when its commit outlasts 10 s.
   */
  private async plan(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<StewardPlan> {
    const p = principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    const revision = this.rev;
    const steps = await this.stepsOf(a, p);
    const asked = steps.filter((x) => x.verdict === "ask").map((x) => x.step_id);
    // Whole milliseconds: a time source's clock reads fractions, and the store keeps bigints.
    const now = Math.floor(this.o.clock.now());
    const expiresMs = now + (asked.length ? this.house.home.ask_expiry_s * 1000 : PLAN_EXPIRY_MS);
    const plan: StewardPlan = { plan_id: randomUUID(), expires_at: new Date(expiresMs).toISOString(), revision, endpoint: p.endpoint,
      ...(p.speaker !== undefined ? { speaker: p.speaker } : {}), client: caller.credential.id, request: requestOf(a), steps };
    const held: HeldPlan = { plan, credential: caller.credential.id, principal: p, madeMs: now, expiresMs, forgetMs: expiresMs + (expiresMs - now), asked,
      askedMs: Object.fromEntries(asked.map((id) => [id, now])), askedAt: this.askedAt(p), answers: {}, applied: false };
    if (asked.length) {
      if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: a plan with an ask is refused until it returns", false);
      const kept = this.o.store.write((tx) => tx.query("INSERT INTO plans (plan_id, credential, made_ms, expires_ms, forget_ms, asked, doc, asked_at) "
        + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (plan_id) DO NOTHING",
      [plan.plan_id, held.credential, held.madeMs, held.expiresMs, held.forgetMs, JSON.stringify(held.askedMs), JSON.stringify(plan), held.askedAt])
        .then(() => undefined));
      try {
        await within(this.o.clock, GATE_MS, kept, PLAN_DROPPED, false);
      } catch (err) {
        // Dropped, never held late: the row, when it lands, is taken out again.
        void kept.then(() => this.o.store.write((tx) => dropPlans(tx, [plan.plan_id])), () => undefined);
        throw err;
      }
    }
    this.hold(held);
    return plan;
  }

  /**
   * A request's steps for principal `p` (steward, *Steps*): resolved, planned on the applier without
   * tokens for the endpoint principal (the design, *The applier's plan*), and judged in the steward's
   * order (GA-STW-4). The applier's plan runs outside the steward's steps.
   */
  private async stepsOf(a: Args, p: Principal): Promise<StewardStep[]> {
    const replaced = new Set<number>();
    const resolved = resolveRequest(a.actions as Requested[], { devices: this.mirror.devices, house: this.house, mutation: this.mutation })
      .map((r, i) => {
        if (r.action !== "notify.notify") return r;
        const { from, ...rest } = r.args as Args;
        if (from !== undefined && this.mutation === "trusts-the-callers-from") return r;
        if (from !== undefined) replaced.add(i);
        return { ...r, args: this.fromOf(rest, { endpoint: p.endpoint, role: p.role }) };
      });
    const cause = { ...(p.person ? { person: p.person } : {}), endpoint: p.endpoint };
    const request = { actions: resolved.map((r) => ({ target: r.target, action: r.action, args: r.args, via: p.via, brain: p.brain, for: cause })) };
    const theirs = resolved.length ? await this.applierPlanOf(request) : [];
    const judging = { principal: p, precedence: "person" as const, leaseOf: (t: string) => this.leases.holding(t), mutation: this.mutation,
      ...(a.respect_occupancy === true ? { occupancyOf: (t: string) => this.occupancyAt(t) } : {}),
      tierOf: (t: string, act: string) => this.mirror.tierOf(t, act), described: (t: string, act: string) => this.mirror.described(t, act) };
    return resolved.map((r, i) => {
      const theirStep = theirs?.find((x) => x.target === r.target && x.action === r.action && canonical(x.args ?? {}) === canonical(r.args));
      // The steward merged identical steps, so the applier's plan returns each: a missing one is a bug, never `dead`.
      if (theirs && !theirStep) throw new Error(`steward bug: the applier's plan did not return the step ${r.target} ${r.action}`);
      if (theirStep?.reason === "token" && theirStep.tier === "reversible") this.sayOnce("token", `the applier refused token on a reversible step, ${r.target} ${r.action}: refused tier`);
      const step = judge(`s${i + 1}`, r, theirStep, judging);
      return replaced.has(i) ? { ...step, from_replaced: true as const } : step;
    });
  }

  /**
   * A `notify`'s arguments with the steward's own `from` (GA-NOTE-2), or none while the applier's
   * `standard_version` is below 0.10, which may refuse an argument it does not know.
   * `sends-from-to-an-old-applier` sets it whatever the applier's version.
   */
  private fromOf(args: Args, from: Args): Args {
    return this.mirror.older("0.10") && this.mutation !== "sends-from-to-an-old-applier" ? args : { ...args, from };
  }

  /**
   * The applier's steps for `request`, or undefined while it is out of reach or refuses the plan (each
   * step then judged by the mirror, else dead), said once per kind of failure. A refusal is a fault the
   * steward shows in `applierFault` until the applier plans again: an out-of-reach applier is not one.
   */
  private async applierPlanOf(request: Record<string, unknown>): Promise<ApplierStep[] | undefined> {
    try {
      if (!this.o.applierPlan) throw new Error("the steward has no applier");
      const r = await this.o.applierPlan(request);
      this.lastPlanFailure = undefined;
      this.applierFault = undefined;
      if (!Array.isArray(r.steps)) throw new Error("steward bug: the applier's plan has no steps");
      return r.steps as ApplierStep[];
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("steward bug:")) throw err;
      if (err instanceof ApplierRefused) this.applierFault = err.code;
      // Said once per kind (the applier's refusal code, or out of reach), however the message varies; addresses masked.
      const kind = err instanceof ApplierRefused ? `refused ${err.code}` : "out of reach";
      const why = maskUrls(err instanceof Error ? err.message : String(err));
      if (kind !== this.lastPlanFailure) this.say(`the applier did not plan (${kind}), so each step is judged by the mirror, else skip(dead): ${why}`);
      this.lastPlanFailure = kind;
      return undefined;
    }
  }

  /**
   * A step: holds a plan, past each credential's cap dropping its oldest, forgets what is long expired,
   * and puts the question of a plan with an ask on the endpoint where it is asked (GA-CONF-5).
   */
  private hold(held: HeldPlan): void {
    this.forgetPlans();
    const running = this.runningPlans();
    const mine = [...this.plans.values()].filter((x) => x.credential === held.credential && !running.has(x.plan.plan_id));
    const over = mine.slice(0, Math.max(0, mine.length - MAX_PLANS_PER_CREDENTIAL + 1));
    for (const x of over) this.plans.delete(x.plan.plan_id);
    // Only a plan with an ask was written. Its row may stay: the periodic prune takes it out, and
    // nothing reads it first; so nothing is queued while the store is down, and the write is droppable.
    const written = over.filter((x) => x.asked.length).map((x) => x.plan.plan_id);
    if (written.length && !this.o.store.down) void this.o.store.write((tx) => dropPlans(tx, written), { droppable: true });
    this.plans.set(held.plan.plan_id, held);
    if (held.asked.length && this.mutation !== "skips-the-ask-event") this.putAsk(held, held.asked);
  }

  /**
   * The `ask` event for `ids` of `held` (GA-CONF-5): `{ plan_id, step_ids, steps, endpoint }`, a run's
   * re-ask with its `run_id`; each step as the plan gives it, `{ step_id, target, action, args, tier,
   * reason }`, a `confirm_define` step `{ step_id, reason, diff }`. Its readers kept beside it: the
   * ask's endpoint and the plan's speaker (`servedTo`).
   */
  private putAsk(held: HeldPlan, ids: string[], runId?: string): void {
    const steps = this.mutation === "asks-without-the-steps" ? undefined : ids.map((id) => {
      const x = (held.plan.steps as (StewardStep | DefineStep)[]).find((y) => y.step_id === id)!;
      return x.reason === "confirm_define" ? { step_id: x.step_id, reason: x.reason, diff: (x as DefineStep).diff }
        : { step_id: x.step_id, target: (x as StewardStep).target, action: (x as StewardStep).action, args: (x as StewardStep).args,
          tier: (x as StewardStep).tier, reason: x.reason };
    });
    this.log.append("ask", { plan_id: held.plan.plan_id, step_ids: ids, ...(steps ? { steps } : {}), endpoint: held.askedAt,
      ...(runId !== undefined ? { run_id: runId } : {}) },
    { readers: { endpoint: held.askedAt, ...(held.plan.speaker !== undefined ? { speaker: held.plan.speaker } : {}) } });
  }

  /** Where a plan's question is put: the endpoint's `confirm_on`, else its brain credential's, else the plan's endpoint (GA-CONF-5). */
  private askedAt(p: Principal): string {
    const e = this.house.endpoints.get(p.endpoint);
    return e?.confirm_on ?? (e?.served_by ? this.house.credentials.get(e.served_by)?.confirm_on : undefined) ?? p.endpoint;
  }

  /** Forgets plans held as long again as they lived, in memory; the store's rows go with the periodic prune. */
  private forgetPlans(): void {
    const now = this.o.clock.now();
    // A running run's plan stays until the run ends, so a toggle step asked again late can be answered (GA-SCN-3; the milestone 5+6 review, B3).
    const running = this.runningPlans();
    for (const [id, x] of this.plans) if (x.forgetMs <= now && !running.has(id)) this.plans.delete(id);
  }

  /** The plans running runs were started from. */
  private runningPlans(): Set<string> {
    return new Set([...this.runningOf.values()].flatMap((r) => (r.planId !== undefined ? [r.planId] : [])));
  }

  /** A held plan as the answers it needs see it. */
  private asked(x: HeldPlan): AskedPlan {
    return { planId: x.plan.plan_id, credential: x.credential, endpoint: x.plan.endpoint, ...(x.plan.speaker !== undefined ? { speaker: x.plan.speaker } : {}),
      revision: x.plan.revision, expiresMs: x.expiresMs, askedAt: x.askedAt, asked: x.asked, askedMs: x.askedMs, answers: x.answers, applied: x.applied,
      ...(x.reopened ? { reopened: x.reopened } : {}) };
  }

  /** A held plan as `answer` returns it: the plan as made, each answered step with the answer that stands. */
  private viewOf(x: HeldPlan): StewardPlan {
    return { ...x.plan, steps: x.plan.steps.map((s) => (x.answers[s.step_id] ? { ...s, answer: x.answers[s.step_id] } : s)) };
  }

  /**
   * `answer` (steward, *The confirmation dialogue*): judged in the standard's error order by
   * `judgeAnswer` (GA-CONF-1, GA-CONF-2, GA-CONF-6), then taken in memory at once, a later `no`
   * replacing a `yes`, the record kept for the reuse check, an `answer` event put; the answer is
   * acknowledged once it is kept. While the store is known down it is refused at once,
   * `pending: false`; a commit that outlasts 10 s is answered `pending: true`, the answer standing in
   * memory and kept when the store returns (an apply's record commits after it, in the writer's order,
   * so no token is minted on an answer the store lost), unless the steward restarts first.
   */
  private async answer(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<StewardPlan> {
    this.forgetPlans();
    const held = this.plans.get(a.plan_id);
    // A plan not held, never made or lost at a restart (one with no ask may be), is unknown (GA-PERSIST-2);
    // the principal and its endpoint are judged first, so a credential that may not answer there meets
    // the same error whether or not the plan exists (the code review, CR10).
    if (!held) {
      principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
      throw new RequestError("unknown_plan", `no plan ${a.plan_id} is held`);
    }
    const record = a.utterance as UtteranceRecord | undefined;
    const answers = a.answers as Record<string, Answer>;
    const p = judgeAnswer({ held: held?.asked.length || this.mutation === "answers-unasked-steps" ? held && this.asked(held) : undefined,
      house: this.house, credential: caller.credential, endpoint: a.endpoint, answers, record, heard: this.heard.values(),
      now: this.o.clock.now(), revision: this.rev, mutation: this.mutation,
      principal: () => principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation) });
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: an answer is refused until it returns", false);
    const x = held!;
    // Memory first: the answer stands at once; a no replaces a yes, and a yes after a no was refused above.
    x.answers = { ...x.answers, ...answers };
    const at = Math.floor(this.o.clock.now());
    x.answeredMs = { ...x.answeredMs, ...Object.fromEntries(Object.keys(answers).map((s) => [s, at])) };
    // A run waiting on its toggle steps asked again looks at the answer.
    this.reasked.get(x.plan.plan_id)?.();
    const heard = record && { utterance_id: record.utterance_id, plan_id: x.plan.plan_id, endpoint: record.endpoint,
      time_ms: Date.parse(record.time), transcript: record.transcript };
    if (heard && !this.heard.has(heard.utterance_id)) this.heard.set(heard.utterance_id, heard);
    this.log.append("answer", { plan_id: x.plan.plan_id, endpoint: p.endpoint, ...(p.speaker !== undefined ? { speaker: p.speaker } : {}),
      answers, ...(record ? { utterance: record } : {}) });
    const kept = JSON.stringify(x.answers);
    const write = this.o.store.write(async (tx) => {
      await tx.query("UPDATE plans SET answers = $2 WHERE plan_id = $1", [x.plan.plan_id, kept]);
      if (heard) {
        await tx.query("INSERT INTO utterances (utterance_id, plan_id, endpoint, time_ms, transcript) VALUES ($1, $2, $3, $4, $5) "
          + "ON CONFLICT (utterance_id) DO NOTHING", [heard.utterance_id, heard.plan_id, heard.endpoint, heard.time_ms, heard.transcript]);
      }
    });
    await within(this.o.clock, GATE_MS, write, ANSWER_HELD);
    return this.viewOf(x);
  }

  /**
   * `apply` (steward, *Apply*; the design, *Apply and dispatch*), by plan or inline. The first step
   * claims the credential's idempotency key (a repeat with the same body returns the first apply once
   * it has its answer, another body is `idempotency_conflict`; GA-STW-6) and checks the plan
   * (`unknown_plan`, `plan_not_yours`, `plan_expired`, `stale_revision`; GA-STW-5); an inline request
   * is planned on the applier first, outside the steps. The second decides each step at dispatch
   * (`atDispatch`: GA-APPLY-3, GA-TIER-2, GA-STW-4), mints a token for each step answered `yes`
   * (GA-CONF-3), and builds one inline applier request of the steps it sends, in order, each with
   * `via`, `brain` and the steward's cause `{ person?, endpoint, apply }` (GA-STW-3, GA-STW-10); the
   * apply's record commits before the applier call is made, and one that outlasts 10 s is dropped,
   * never sent. The applier's answer is the third step: its outcomes passed through, each stamped with
   * the time of the `outcome` event the steward puts for it, the steward's own with the moment it
   * decided them (GA-STW-12).
   */
  private async apply(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: an apply is refused until it returns", false);
    const credential = caller.credential.id;
    const now = Math.floor(this.o.clock.now());
    const body = canonical(a.plan_id !== undefined ? { plan_id: a.plan_id } : { request: requestOf(a.request) });
    const k = `${credential}\u0000${a.idempotency_key}`;
    const prior = this.applies.get(k);
    if (prior && now - prior.atMs <= KEY_RETENTION_MS) {
      if (prior.body !== body) throw new RequestError("idempotency_conflict", "this key was used with another body (GA-STW-6)");
      await prior.done;
      return this.applyView(prior);
    }
    const cap = this.o.maxAppliesPerCredential ?? MAX_APPLIES_PER_CREDENTIAL;
    if (!prior && (this.keysHeld.get(credential) ?? 0) >= cap) {
      this.forgetApplies();
      if ((this.keysHeld.get(credential) ?? 0) >= cap) {
        throw new RequestError("invalid_request", `this credential holds ${cap} applies under keys within their 3600 s; a new key waits for the oldest to pass`);
      }
    }
    let held: HeldPlan | undefined;
    let p: Principal;
    if (a.plan_id !== undefined) {
      this.forgetPlans();
      held = this.plans.get(a.plan_id);
      if (!held) throw new RequestError("unknown_plan", `no plan ${a.plan_id} is held`);
      if (held.credential !== credential) throw new RequestError("plan_not_yours", "another credential made this plan (GA-STW-5)");
      if (held.plan.request.scenario !== undefined) throw new RequestError("invalid_request", "a scenario's plan is started with scenario_run, not applied");
      if (held.plan.request.changes !== undefined) throw new RequestError("invalid_request", "a define's plan is applied with define { plan_id }, not apply");
      if (now > held.expiresMs) throw new RequestError("plan_expired", "the plan expired (GA-STW-5)");
      if (held.plan.revision !== this.rev) throw new RequestError("stale_revision", `the plan was made at revision ${held.plan.revision}, the house is at ${this.rev} (GA-STW-5)`);
      if (held.applied) throw new RequestError("plan_expired", "the plan was applied already: an apply spends it");
      p = held.principal;
    } else {
      p = principalOf(this.house, caller.credential, a.request.endpoint, a.request.speaker, this.mutation);
    }
    // The key is claimed, and a plan spent, before anything is awaited, so a repeat waits for this apply.
    let finished!: () => void;
    const r: ApplyRecord = { apply_id: randomUUID(), credential, key: a.idempotency_key, body, atMs: now, ...(held ? { plan_id: held.plan.plan_id } : {}),
      cause: {}, outcomes: [], sent: [], steps: {}, done: new Promise<void>((resolve) => { finished = resolve; }) };
    r.cause = { ...(p.person ? { person: p.person } : {}), endpoint: p.endpoint, apply: r.apply_id };
    this.keepApply(k, r);
    if (held) held.applied = true;
    try {
      // A plan's steps as judged when it was made; `judgeAtDispatch` judges their lease and room again
      // as they are now, keeping the answers given (GA-STW-8).
      const steps = held ? held.plan.steps as StewardStep[] : await this.stepsOf(a.request, p);
      const respect = (held ? held.plan.request.respect_occupancy : a.request.respect_occupancy) === true;
      const actions = this.judgeAtDispatch(r, steps, held?.answers ?? {}, !held, p, respect);
      this.appliesById.set(r.apply_id, r);
      const kept = this.o.store.write(async (tx) => {
        // A row of the same key past its retention, which the periodic prune has not yet taken, is
        // replaced in this write set; one still within it is this apply's own (a second run).
        await tx.query("INSERT INTO applies (credential, key, apply_id, at_ms, body, doc) VALUES ($1, $2, $3, $4, $5, $6) "
          + "ON CONFLICT (credential, key) DO UPDATE SET apply_id = EXCLUDED.apply_id, at_ms = EXCLUDED.at_ms, body = EXCLUDED.body, doc = EXCLUDED.doc "
          + "WHERE applies.at_ms <= EXCLUDED.at_ms - $7",
        [credential, r.key, r.apply_id, r.atMs, body, JSON.stringify(docOf(r)), KEY_RETENTION_MS]);
        if (held) await tx.query("UPDATE plans SET applied = true WHERE plan_id = $1", [held.plan.plan_id]);
      });
      try {
        await within(this.o.clock, GATE_MS, kept, APPLY_DROPPED, false);
      } catch (err) {
        // Dropped, never sent late: each step it would have sent is unreachable, and a repeat finds that.
        this.settleUnsent(r, "unreachable", "dropped: the store did not keep the apply");
        throw err;
      }
      if (actions.length) await this.callApplier(r, actions);
      return this.applyView(r);
    } catch (err) {
      if (!this.appliesById.has(r.apply_id)) {
        // Nothing was decided: the key is free again, and the plan unspent.
        this.dropApply(k);
        if (held) held.applied = false;
      }
      throw err;
    } finally {
      finished();
    }
  }

  /**
   * A step: what is sent of `steps` at dispatch, in order, each with its token if it was answered
   * `yes`; the steward's own outcomes stamped with this moment, the others `unknown` until the
   * applier answers. The one path for a plan's steps and an inline request's: each step's lease, and
   * its room where the request respects occupancy, are judged again as they are now, the answers given
   * kept (GA-STW-8, GA-APPLY-3). Each stateful step sent, but a
   * `session.lock`, lays a provisional `person` lease on its device until the applier answers, so no
   * rule acts between dispatch and the answer (the design, *Apply and dispatch*).
   */
  private judgeAtDispatch(r: ApplyRecord, steps: StewardStep[], answers: Record<string, Answer>, inline: boolean, p: Principal,
    respect: boolean): Record<string, unknown>[] {
    const now = Math.floor(this.o.clock.now());
    const time = new Date(now).toISOString();
    const actions: Record<string, unknown>[] = [];
    const judging = { precedence: "person" as const, leaseOf: (t: string) => this.leases.holding(t), mutation: this.mutation };
    r.dispatchMs = now;
    r.laid = [];
    if (inline) r.fromReplaced = steps.filter((s) => s.from_replaced).map((s) => s.step_id);
    for (const s of steps) {
      const room = respect ? this.occupancyAt(s.target) : undefined;
      const d = atDispatch(s, answers[s.step_id], inline, { leased: leased(s.target, s.action, judging)?.holder,
        ...(room === "occupied" || room === "unknown" ? { occupancy: room } : {}) }, this.mutation);
      if (!d.send) {
        r.outcomes.push({ step_id: s.step_id, target: s.target, outcome: d.outcome, ...("reason" in d ? { reason: d.reason } : { detail: d.detail }), time });
        continue;
      }
      const sent = { target: s.target, action: s.action, args: s.args, via: p.via, brain: p.brain, for: r.cause };
      const token = d.token ? mintToken(sent, { issuer: this.o.applierClient!, key: this.o.tokenKey!, now }) : undefined;
      actions.push({ ...sent, ...(token ? { token } : {}) });
      r.sent.push(s.step_id);
      r.outcomes.push({ step_id: s.step_id, target: s.target, outcome: "unknown", time });
      if (s.action !== LEASE_EXEMPT && !this.mirror.stateless(s.target, s.action) && this.mutation !== "ignores-leases") {
        this.leases.lay(s.target, { apply: r.apply_id, step: s.step_id, holder: r.cause.person !== undefined
          ? { person: r.cause.person, endpoint: r.cause.endpoint } : { endpoint: r.cause.endpoint }, precedence: "person" });
        r.laid.push({ step: s.step_id, target: s.target });
      }
    }
    return actions;
  }

  /**
   * A step: the provisional leases `r` laid come off, each step's outcome deciding: one the applier
   * took becomes the device's lease from dispatch for the hold time (GA-LEASE-1, replacing the one it
   * lay over); one that sent nothing is lifted, the earlier lease standing. `all` settles every one as
   * taken, for an apply whose answer was lost: it may have dispatched (the design, *The applier call*).
   */
  private settleLeases(r: ApplyRecord, all?: "taken" | "lifted"): void {
    const holdMs = this.house.home.hold_time_s * 1000;
    for (const x of r.laid ?? []) {
      const o = r.outcomes.find((y) => y.step_id === x.step);
      const taken = all ? all === "taken" : leaves(o?.outcome);
      this.leases.settle(x.target, r.apply_id, x.step, taken ? { sinceMs: r.dispatchMs!, holdMs } : undefined);
    }
    r.laid = [];
  }

  /**
   * The applier call (the design, *The applier call*): `apply { request, idempotency_key: apply_id }`.
   * A call never sent (no session) ends its steps `unreachable`; a call whose answer was lost is
   * repeated with its key, which the applier answers from its record, until 10 s after the first try,
   * and then its outcomes stay `unknown` and the caller is told so; an applier's refusal fails them.
   */
  private async callApplier(r: ApplyRecord, actions: Record<string, unknown>[], reask = false): Promise<void> {
    const deadline = this.o.clock.now() + REPEAT_WINDOW_MS;
    const body = { request: { actions }, idempotency_key: r.applierKey ?? r.apply_id };
    this.inFlight.add(r.apply_id);
    let answer: Args | undefined;
    let failure: { kind: "unsent" | "lost" } | { kind: "refused"; detail: string } | undefined;
    try {
      for (let tries = 0, wait = 250; ; tries++, wait = Math.min(wait * 2, 2000)) {
        try {
          if (!this.o.applierApply) throw new NotSent("the steward has no applier");
          answer = await this.o.applierApply(body, Math.max(1, deadline - this.o.clock.now()));
          break;
        } catch (err) {
          // Asked again for a lost answer, a call not sent says nothing of the first: still lost.
          if (err instanceof NotSent && tries === 0 && !reask) { failure = { kind: "unsent" }; break; }
          if (err instanceof ApplierRefused) { failure = { kind: "refused", detail: `the applier refused the apply: ${err.code}` }; break; }
          if (this.o.clock.now() + wait >= deadline) { failure = { kind: "lost" }; break; }
          await new Promise<void>((resolve) => { this.o.clock.setTimeout(resolve, wait); });
        }
      }
    } finally {
      this.inFlight.delete(r.apply_id);
    }
    if (answer) {
      this.lost.delete(r.apply_id);
      this.answered(r, answer);
    }
    else if (failure!.kind === "refused") {
      this.sayOnce("apply-refused", `${failure!.detail}; its steps failed`);
      this.settleUnsent(r, "failed", failure!.detail);
    } else if (failure!.kind === "unsent") this.settleUnsent(r, "unreachable");
    // A firing's lost answer is asked for again: its events wait for it (I1).
    if (failure?.kind === "lost" && r.firing) this.lost.add(r.apply_id);
    for (const b of this.parked) b.waitFor.delete(r.apply_id);
    this.release();
    if (!this.inFlight.size && !this.lost.size) this.adoptOrphans();
    if (failure?.kind === "lost") {
      this.settleLeases(r, "taken");
      this.saveApply(r);
      throw new OutcomeUnknown("the applier's answer to the apply was lost and not recovered in 10 s: the apply is kept, its outcomes unknown");
    }
  }

  /**
   * A step: the applier's answer. Each of its outcomes is its sent step's, stamped with the time of
   * the `outcome` event the steward puts for it now (the applier's own event of it, when it comes,
   * moves nothing and is not relayed again), and the applier's apply and step ids are kept for its
   * later events.
   */
  private answered(r: ApplyRecord, answer: Args): void {
    const theirs = Array.isArray(answer.outcomes) ? answer.outcomes as Args[] : [];
    // Its steps were dispatched by now: a lock's late-ack wait runs from here, never earlier (GA-RULE-8).
    if (r.firing) r.firing.answeredMs = Math.floor(this.o.clock.now());
    if (typeof answer.apply_id === "string") {
      r.applierApplyId = answer.apply_id;
      this.byApplier.set(answer.apply_id, r);
      if (r.firing?.apply) r.firing.apply.applier = answer.apply_id;
    }
    r.sent.forEach((step, i) => {
      const o = theirs[i];
      const at = r.outcomes.findIndex((x) => x.step_id === step);
      if (!o || at < 0) return;
      r.steps[String(o.step_id)] = step;
      const fields = { outcome: o.outcome, ...(o.reason !== undefined ? { reason: o.reason } : {}), ...(o.detail !== undefined ? { detail: o.detail } : {}) };
      const ev = this.log.append("outcome", { apply_id: r.apply_id, step_id: step, target: r.outcomes[at]!.target, ...fields, cause: r.cause,
        ...(typeof o.time === "string" ? { applier_time: o.time } : {}) });
      r.outcomes[at] = { step_id: step, target: r.outcomes[at]!.target, ...fields, time: ev.time } as Outcome;
    });
    this.saveApply(r);
    this.settleLeases(r);
    for (const step of r.sent) this.ruleOutcome(r, step);
    this.trackFiring(r);
    // The cap forced this apply's events out before its answer named it: relayed now, after the steward's own.
    if (typeof answer.apply_id === "string") this.adoptOrphans(answer.apply_id);
  }

  /** A step: every step sent, or to be sent, ends `outcome`, nothing having reached the applier (or, `failed`, the applier refused it). */
  private settleUnsent(r: ApplyRecord, outcome: "unreachable" | "failed", detail?: string): void {
    const time = new Date(Math.floor(this.o.clock.now())).toISOString();
    r.outcomes = r.outcomes.map((o) => (r.sent.includes(o.step_id) ? { step_id: o.step_id, target: o.target, outcome, ...(detail ? { detail } : {}), time } : o));
    this.saveApply(r);
    this.settleLeases(r, "lifted");
    for (const step of r.sent) this.ruleOutcome(r, step);
  }

  /** A step: a rule firing's step, once its outcome is final, goes to what a rule's outcome does (GA-RULE-7, GA-RULE-8). */
  private ruleOutcome(r: ApplyRecord, step: string): void {
    if (r.firing && this.settleLater) {
      this.settleLater.push([r, step]);
      return;
    }
    // A run's step: the run, waiting on its step's outcome, looks again.
    if (r.run) this.runs.get(r.run.id)?.settle?.();
    const o = r.firing ? r.outcomes.find((x) => x.step_id === step) : undefined;
    if (!o || outcomeRank(o.outcome) < 2) return;
    // Refused `safety` on a device whose safety lease the steward ended early: no notice; the rule is
    // re-evaluated when the safety rule's completion is relayed (GA-LEASE-6, GA-RULE-8).
    const early = o.outcome === "refused" && o.reason === "safety" ? this.earlyOn(o.target) : [];
    if (early.length) {
      // Kept by each safety rule ended early on the device: the first completion read re-evaluates it.
      if (this.mutation !== "forgets-a-safety-refusal") for (const rules of early) rules.add(r.firing!.rule);
      this.trackFiring(r);
      return;
    }
    this.after.settled(r.firing!, step, o.outcome, o.reason);
    this.trackFiring(r);
  }

  /**
   * A step: a rule firing the applier answered is kept in the store while a step it sent has no final
   * outcome (GA-PERSIST-2), so a restart still finds it by the applier's apply id; its row goes once none
   * is open. Written behind: a crash before the write lands loses it, as before slice 11.
   */
  private trackFiring(r: ApplyRecord): void {
    if (!r.firing?.apply?.applier) return;
    this.after.inFlight(r.firing, r.sent.filter((step) => outcomeRank(r.outcomes.find((x) => x.step_id === step)?.outcome) < 2));
  }

  /**
   * An apply as `apply` and `outcome` return it: its outcomes, each with its time, its fields in one
   * order whether the record was made in this life or read back (the store's jsonb keeps no order).
   */
  private applyView(r: ApplyRecord): Record<string, unknown> {
    return { apply_id: r.apply_id, outcomes: r.outcomes.map((o) => ({ step_id: o.step_id, target: o.target, outcome: o.outcome,
      ...(o.reason !== undefined ? { reason: o.reason } : {}), ...(o.detail !== undefined ? { detail: o.detail } : {}), time: o.time,
      ...(r.fromReplaced?.includes(o.step_id) ? { from_replaced: true } : {}) })) };
  }

  /**
   * `outcome { apply_id }` (steward, *Operations*): an apply's current outcomes, each with its time
   * (GA-STW-12), to the credential that applied, for 3600 s; any other is `unknown_apply`.
   * `outcome-without-a-time` leaves an `acked` outcome's time out.
   */
  private outcome(a: Args, caller: Extract<Caller, { kind: "credential" }>): Record<string, unknown> {
    const r = this.appliesById.get(a.apply_id);
    if (!r || r.credential !== caller.credential.id || this.o.clock.now() - r.atMs > KEY_RETENTION_MS) {
      throw new RequestError("unknown_apply", `no apply ${a.apply_id} of this credential's is kept`);
    }
    const view = this.applyView(r) as { apply_id: string; outcomes: Partial<Outcome>[] };
    if (this.mutation === "outcome-without-a-time") for (const o of view.outcomes) if (o.outcome === "acked") delete o.time;
    return view;
  }

  /** Writes an apply's record again, behind: one write in the writer's line per apply at a time, writing its latest. */
  private saveApply(r: ApplyRecord): void {
    if (r.memoryOnly) return;
    if (this.saving.has(r.apply_id)) {
      this.saving.set(r.apply_id, true);
      return;
    }
    this.saving.set(r.apply_id, false);
    void this.o.store.write((tx) => tx.query("UPDATE applies SET doc = $2 WHERE apply_id = $1", [r.apply_id, JSON.stringify(docOf(r))]).then(() => undefined))
      .then(() => {
        const again = this.saving.get(r.apply_id);
        this.saving.delete(r.apply_id);
        if (again) this.saveApply(r);
      });
  }

  /**
   * Reads back the applies of the last 3600 s, so a repeated key finds its apply across a restart
   * (GA-STW-6); a step whose applier answer the last life never had stays `unknown`, never sent again.
   */
  private async loadApplies(): Promise<void> {
    const since = Math.floor(this.o.clock.now()) - KEY_RETENTION_MS;
    const rows = await this.o.store.query<{ credential: string; key: string; apply_id: string; at_ms: number | string; body: string; doc: Args }>(
      "SELECT credential, key, apply_id, at_ms, body, doc FROM applies WHERE at_ms > $1", [since]);
    for (const row of rows.rows) {
      const d = row.doc;
      const r: ApplyRecord = { apply_id: row.apply_id, credential: row.credential, key: row.key, body: row.body, atMs: Number(row.at_ms),
        ...(d.plan_id ? { plan_id: d.plan_id } : {}), cause: d.cause ?? {}, outcomes: d.outcomes ?? [], sent: d.sent ?? [], steps: d.steps ?? {},
        done: Promise.resolve(), ...(d.applier_apply_id ? { applierApplyId: d.applier_apply_id } : {}),
        ...(Array.isArray(d.from_replaced) ? { fromReplaced: d.from_replaced } : {}) };
      this.keepApply(`${r.credential}\u0000${r.key}`, r);
      this.appliesById.set(r.apply_id, r);
      if (r.applierApplyId) this.byApplier.set(r.applierApplyId, r);
    }
  }

  /** Holds `r` under its key, an earlier apply of the key (past its retention) forgotten whole. */
  private keepApply(k: string, r: ApplyRecord): void {
    if (this.applies.has(k)) this.dropApply(k);
    this.applies.set(k, r);
    this.keysHeld.set(r.credential, (this.keysHeld.get(r.credential) ?? 0) + 1);
  }

  /** Forgets the apply held under `k`, by its key and its ids. */
  private dropApply(k: string): void {
    const r = this.applies.get(k);
    if (!r) return;
    this.applies.delete(k);
    if (this.appliesById.get(r.apply_id) === r) this.appliesById.delete(r.apply_id);
    if (r.applierApplyId && this.byApplier.get(r.applierApplyId) === r) this.byApplier.delete(r.applierApplyId);
    const n = (this.keysHeld.get(r.credential) ?? 1) - 1;
    if (n > 0) this.keysHeld.set(r.credential, n);
    else this.keysHeld.delete(r.credential);
  }

  /** Forgets the applies older than their keys' 3600 s, in memory; the store's rows go with the periodic prune. */
  private forgetApplies(): void {
    const oldest = this.o.clock.now() - KEY_RETENTION_MS;
    for (const [k, r] of this.applies) {
      if (r.atMs > oldest || this.inFlight.has(r.apply_id)) continue;
      this.dropApply(k);
    }
  }

  /**
   * Reads back the plans with an ask not yet forgotten, with their answers, and the utterance records
   * kept (GA-PERSIST-2, ruled 2026-10-04); a plan whose endpoint its credential no longer serves is
   * left. A plan with no ask was never kept: an accepted loss.
   */
  private async loadPlans(): Promise<void> {
    if (this.mutation === "forgets-an-asked-plan") return;
    const now = Math.floor(this.o.clock.now());
    const rows = await this.o.store.query<{ plan_id: string; credential: string; made_ms: number | string; expires_ms: number | string;
      forget_ms: number | string; asked: Record<string, number>; doc: StewardPlan; asked_at: string; answers: Record<string, Answer>; applied: boolean }>(
      "SELECT plan_id, credential, made_ms, expires_ms, forget_ms, asked, doc, asked_at, answers, applied FROM plans WHERE forget_ms > $1 ORDER BY made_ms", [now]);
    for (const r of rows.rows) {
      const c = this.house.credentials.get(r.credential);
      let principal: Principal;
      try {
        if (!c) continue;
        principal = principalOf(this.house, c, r.doc.endpoint, r.doc.speaker);
      } catch {
        continue;
      }
      this.plans.set(r.plan_id, { plan: r.doc, credential: r.credential, principal, madeMs: Number(r.made_ms), expiresMs: Number(r.expires_ms),
        forgetMs: Number(r.forget_ms), asked: Object.keys(r.asked), askedMs: r.asked, askedAt: r.asked_at || r.doc.endpoint, answers: r.answers ?? {},
        applied: r.applied === true });
    }
    const heard = await this.o.store.query<{ utterance_id: string; plan_id: string; endpoint: string; time_ms: number | string; transcript: string }>(
      "SELECT utterance_id, plan_id, endpoint, time_ms, transcript FROM utterances");
    for (const h of heard.rows) this.heard.set(h.utterance_id, { ...h, time_ms: Number(h.time_ms) });
  }

  /** Forgets the utterance records no plan can still take (GA-CONF-2's timing), in memory and, behind, in the store. */
  private forgetHeard(): string[] {
    const now = this.o.clock.now();
    const plans = [...this.plans.values()].filter((x) => x.asked.length).map((x) => this.asked(x));
    const gone = [...this.heard.values()].filter((h) => !stillNeeded(h, plans, now)).map((h) => h.utterance_id);
    for (const id of gone) this.heard.delete(id);
    return gone;
  }

  /**
   * The occupancy of `target`'s room, now (GA-OCC-1): a target with no room is `unknown`, failing
   * closed as a room with no sensor does.
   */
  /**
   * One firing of a rule (the design, *Rules*): its actions resolved now, `notify`'s `from` the rule's
   * (GA-NOTE-2), planned on the applier and judged in the steward's order at `rule` precedence, so a
   * lease that outranks it refuses a step `refused(leased)` (GA-LEASE-1, GA-LEASE-3), and the room
   * judged where the action respects occupancy; its `confirm` and `no_voice` steps authored, with a
   * token `for: { rule }`, an ask it cannot answer the matching skip (GA-SCN-4, GA-CONF-3). What is sent
   * goes as one applier apply keyed `rule:<id>:<n>` (GA-STW-10), `via: rule`, `brain: false`
   * (GA-AUTH-5), laying no lease (GA-LEASE-5). A `rule_fired` event, and the steward's own outcomes as
   * `outcome` events (a refusal as a `refused` event too), the applier's as it gives them, each with
   * the cause `{ rule }`. The firing's `fired` commits first while the store is up (I7). A retry (`only`) sends those steps as
   * they were resolved, under a new number, its `rule_fired` marked `retry` (GA-RULE-7); each step's
   * final outcome goes to what a rule's outcome does (`ruleOutcome`).
   */
  private async fireRule(rule: Rule, n: number, only?: FiringStep[]): Promise<void> {
    const cause = { rule: rule.id };
    // A rule defined through a brain: its every step is brain_authored (GA-DEF-7), and its notify's from says so (GA-NOTE-2).
    const marked = rule.brain_authored === true;
    const p: Principal = { endpoint: `rule:${rule.id}`, person: null, via: "rule", brain: false, role: "owner" };
    const declared = (x: { target: string; action: string }) => ({ idempotent: this.mirror.idempotent(x.target, x.action),
      ackWithinS: this.mirror.ackWithinS(x.target, x.action) });
    // A retry's one step conflicts with nothing (GA-STW-2).
    let steps: (FiringStep & { conflict: boolean })[];
    if (only) steps = only.map((x) => ({ ...x, ...declared(x), conflict: false }));
    else {
      // Authored work: a device reached through a room or a group it joined through a brain is brain_authored for it (GA-DEF-7).
      const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation, authored: true };
      const strip = ({ respect_occupancy: _r, ...a }: ReturnType<typeof deviceActions>[number]) => a as Requested;
      const respectful = new Set(deviceActions(rule).filter((a) => a.respect_occupancy === true)
        .flatMap((a) => resolveRequest([strip(a)], view).map((x) => canonical([x.target, x.action, x.args]))));
      steps = resolveRequest(deviceActions(rule).map(strip), view).map((x) => {
        const respect = respectful.has(canonical([x.target, x.action, x.args]));
        const brain = marked || x.brain === true;
        const { from: _f, ...rest } = x.args as Args;
        const args = x.action === "notify.notify" ? this.fromOf(rest, { ...cause, ...(brain ? { brain_authored: true } : {}) }) : x.args;
        return { target: x.target, action: x.action, args, conflict: x.conflict, respect, ...declared(x), unanswered: 0,
          ...(brain ? { brain: true as const } : {}) };
      });
    }
    const sent = (x: { target: string; action: string; args: Record<string, unknown>; brain?: true }) =>
      ({ target: x.target, action: x.action, args: x.args, via: "rule", brain: x.brain === true, for: cause });
    let finished!: () => void;
    const key = `rule:${rule.id}:${n}`;
    const r: ApplyRecord = { apply_id: randomUUID(), credential: `rule:${rule.id}`, key, applierKey: key, body: "", atMs: Math.floor(this.o.clock.now()),
      cause, outcomes: [], sent: [], steps: {}, done: new Promise<void>((resolve) => { finished = resolve; }), memoryOnly: true,
      firing: { rule: rule.id, name: rule.name, n, episode: this.rules.episode(rule.id), conditionsOnly: rule.trigger === undefined,
        ...(rule.trigger && "held" in rule.trigger ? { held: true as const } : rule.trigger ? { edge: true as const } : {}), atMs: Math.floor(this.o.clock.now()),
        steps: Object.fromEntries(steps.map(({ conflict: _c, ...x }, i) => [`s${i + 1}`, x])) } };
    // The apply it goes as, the applier's step ids filled in by its answer: a held notice keeps it (GA-PERSIST-2).
    r.firing!.apply = { id: r.apply_id, steps: r.steps };
    this.keepFiring(r);
    // Put in the step that fired it, before anything is awaited: the event that made it true comes just before.
    // It names the devices its steps act on, so `history { targets }` finds it (the milestone 7+10+11 review, M4).
    this.log.append("rule_fired", { rule: rule.id, firing: n, apply_id: r.apply_id, targets: [...new Set(steps.map((x) => x.target))].sort(), cause,
      ...(only ? { retry: true } : {}) });
    // Its scenario starts, in the order written, in the same step; a retry starts none (GA-RULE-7 retries an action, not a start).
    if (!only) for (const sc of startsOf(rule)) this.startRuleRun(rule, sc);
    // Authority waits for its commit while the store is up (the design, *Decisions*): the firing's
    // `fired` commits before anything is planned or sent, so a crash after the send does not fire it
    // again at the restart; written behind only while the store is known down (Q6; the milestone 5+6
    // review, I7). A commit that outlasts the gate sends nothing: each step ends unreachable.
    if (steps.length && !only && !this.o.store.down) {
      try {
        await within(this.o.clock, GATE_MS, this.rules.committed(rule.id), FIRING_DROPPED, false);
      } catch (err) {
        if (!(err instanceof StoreUnavailable)) throw err;
        const time = new Date(Math.floor(this.o.clock.now())).toISOString();
        steps.forEach((x, i) => {
          const step_id = `s${i + 1}`;
          r.outcomes.push({ step_id, target: x.target, outcome: "unreachable", detail: FIRING_DROPPED, time });
          this.log.append("outcome", { apply_id: r.apply_id, step_id, target: x.target, outcome: "unreachable", detail: FIRING_DROPPED, cause });
          this.ruleOutcome(r, step_id);
        });
        finished();
        return;
      }
    }
    const theirs = steps.length ? await this.applierPlanOf({ actions: steps.map(sent) }) : [];
    const now = Math.floor(this.o.clock.now());
    const time = new Date(now).toISOString();
    const actions: Record<string, unknown>[] = [];
    steps.forEach((x, i) => {
      const step_id = `s${i + 1}`;
      const theirStep = theirs?.find((y) => y.target === x.target && y.action === x.action && canonical(y.args ?? {}) === canonical(x.args));
      const judged = judge(step_id, x, theirStep, { principal: p, precedence: "rule", authored: true, leaseOf: (t) => this.leases.holding(t), mutation: this.mutation,
        internal: (t) => this.mirror.devices.get(t)?.internal === true,
        ...(x.respect ? { occupancyOf: (t: string) => this.occupancyAt(t) } : {}),
        tierOf: (t, a) => this.mirror.tierOf(t, a), described: (t, a) => this.mirror.described(t, a) });
      const room = x.respect ? this.occupancyAt(x.target) : undefined;
      const d = ruleDecision(judged, this.mutation, { leased: leased(x.target, x.action, { leaseOf: (t) => this.leases.holding(t), precedence: "rule", mutation: this.mutation })?.holder,
        ...(room === "occupied" || room === "unknown" ? { occupancy: room } : {}) });
      if (!d.send) {
        const why = "reason" in d ? { reason: d.reason } : { detail: d.detail };
        r.outcomes.push({ step_id, target: x.target, outcome: d.outcome, ...why, time });
        this.log.append("outcome", { apply_id: r.apply_id, step_id, target: x.target, outcome: d.outcome, ...why, cause });
        // A provisional lease that refused it re-evaluates the rule when it is lifted (GA-LEASE-4).
        if (d.outcome === "refused" && d.reason === "leased") this.leases.refused(x.target, rule.id);
        if (d.outcome === "refused") {
          this.log.append("refused", { rule: rule.id, apply_id: r.apply_id, step_id, target: x.target, action: x.action, reason: d.reason,
            ...(judged.holder !== undefined ? { holder: judged.holder } : {}), cause });
        }
        this.ruleOutcome(r, step_id);
        return;
      }
      const s = sent(x);
      const token = d.token ? mintToken(s, { issuer: this.o.applierClient!, key: this.o.tokenKey!, now }) : undefined;
      actions.push({ ...s, ...(token ? { token } : {}) });
      r.sent.push(step_id);
      r.outcomes.push({ step_id, target: x.target, outcome: "unknown", time });
    });
    try {
      if (actions.length) await this.callApplier(r, actions);
    } catch (err) {
      if (!(err instanceof OutcomeUnknown)) throw err;
      this.reask(r, actions, Math.floor(this.o.clock.now()));
    } finally {
      finished();
    }
  }

  /**
   * A firing whose answer was lost is asked again with the same key, `RETRY_SPACING_MS` apart, while
   * the applier still answers that key from its record (GA-APPLY-4); its answer then goes where any
   * answer goes, so the retry and the notice follow its outcome (GA-RULE-7, GA-RULE-8; the milestone
   * review, I1). The re-ask dispatches nothing new.
   */
  private reask(r: ApplyRecord, actions: Record<string, unknown>[], since: number): void {
    if (this.o.clock.now() + RETRY_SPACING_MS - since > REASK_FOR_MS) {
      this.sayOnce("reask", `the answer to a rule's apply was lost and not recovered within an hour: its outcome stays unknown (rule ${r.firing?.rule})`);
      this.lost.delete(r.apply_id);
      if (!this.inFlight.size && !this.lost.size) this.adoptOrphans();
      return;
    }
    this.lost.add(r.apply_id);
    const t = this.o.clock.setTimeout(() => {
      this.reasks.delete(t);
      void this.callApplier(r, actions, true).catch((err) => {
        if (err instanceof OutcomeUnknown) this.reask(r, actions, since);
      });
    }, RETRY_SPACING_MS);
    this.reasks.add(t);
  }

  /**
   * Reads back what the rules had pending on the applier when the steward stopped (GA-PERSIST-2): the
   * firings sent whose steps had no final outcome, and the notices held for a late ack (GA-RULE-8). A
   * rule deleted since has its dropped; each other's firing is kept again as a record found by the
   * applier's apply id, its open steps `dispatched`, so an outcome or a late ack the applier gave while
   * the steward was down, read from its history, or gives after the restart names the firing's apply
   * and goes to what a rule's outcome does. Held notices' timers wait for the first sync (`onState`).
   */
  private async loadFirings(): Promise<void> {
    // A rule that has fired and not stopped since is in the becoming true its latest firing was sent in:
    // that firing takes this life's count; any older one, or one whose rule has stopped, none that counts.
    const { held, sent } = await this.after.load((rule, latest) => (latest && this.rules.fired(rule) ? this.rules.episode(rule) : -1));
    const back = (f: Firing, open: string[]): ApplyRecord | undefined => {
      if (!this.house.rules.has(f.rule)) {
        this.after.forget(f.rule);
        return undefined;
      }
      if (!f.apply?.applier) return undefined;
      const known = this.byApplier.get(f.apply.applier);
      if (known) return known;
      const time = new Date(f.answeredMs ?? f.atMs).toISOString();
      const r: ApplyRecord = { apply_id: f.apply.id, credential: `rule:${f.rule}`, key: `rule:${f.rule}:${f.n}`, applierKey: `rule:${f.rule}:${f.n}`, body: "",
        atMs: f.atMs, cause: { rule: f.rule }, sent: open, steps: { ...(f.apply.steps ?? {}) }, done: Promise.resolve(), memoryOnly: true, firing: f,
        applierApplyId: f.apply.applier,
        outcomes: open.map((step_id) => ({ step_id, target: f.steps[step_id]!.target, outcome: "dispatched", time }) as Outcome) };
      f.apply.steps = r.steps;
      this.keepFiring(r);
      this.byApplier.set(f.apply.applier, r);
      return r;
    };
    for (const { open, ...f } of sent) back(f, open);
    for (const { stepId, outcome, reason, ...f } of held) {
      const r = back(f, []);
      if (!r || r.outcomes.some((o) => o.step_id === stepId)) continue;
      r.outcomes.push({ step_id: stepId, target: f.steps[stepId]!.target, outcome, ...(reason !== undefined ? { reason } : {}), time: new Date(f.atMs).toISOString() } as Outcome);
    }
  }

  /**
   * Keeps a firing's record for its later events, forgetting the oldest past `FIRINGS_KEPT` that
   * nothing waits on: one with a notice held or a retry pending stays, so its late ack still finds it
   * (I2), up to `HELD_CAP` more, past which the oldest goes whatever waits.
   */
  private keepFiring(r: ApplyRecord): void {
    this.firings.set(r.apply_id, r);
    while (this.firings.size > FIRINGS_KEPT) {
      let gone: [string, ApplyRecord] | undefined;
      for (const e of this.firings) if (!e[1].firing || !this.after.pins(e[1].firing)) { gone = e; break; }
      if (!gone) {
        if (this.firings.size <= FIRINGS_KEPT + HELD_CAP) break;
        gone = this.firings.entries().next().value!;
      }
      this.firings.delete(gone[0]);
      if (gone[1].applierApplyId) this.byApplier.delete(gone[1].applierApplyId);
      if (gone[1].firing) this.after.closed(gone[1].firing);
    }
  }

  /**
   * The devices a rule names (GA-LEASE-4): those it reads, those it acts on by id, the members of a
   * group it acts on, and a selector's matches as it resolves now.
   */
  private namesOf(r: Rule): string[] {
    const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation };
    return [...new Set([...readsOf(r), ...deviceActions(r).flatMap((a) => (a.target === undefined
      ? resolveRequest([{ selector: a.selector, action: a.action, args: a.args } as Requested], view).map((x) => x.target)
      : this.house.groups.has(a.target) && !this.mirror.devices.has(a.target) ? this.house.groups.get(a.target)!.members : [a.target]))])];
  }

  /**
   * What a rule reads now (the design, *Rules*): each device's liveness and values as the mirror holds
   * them, an `assumed` value marked, and a `session.<token>` key retired when the computer's `accounts`
   * no longer lists its token; the clock, in the home's timezone.
   */
  private ruleView(): View {
    return { now: Math.floor(this.o.clock.now()), tz: this.house.home.timezone, mutation: this.mutation,
      device: (id) => {
        const t = this.mirror.state.get(id);
        const d = this.mirror.devices.get(id);
        if (!t && !d) return undefined;
        const accounts = d?.accounts && typeof d.accounts === "object" ? d.accounts as Record<string, unknown> : undefined;
        return { live: t?.liveness === "live",
          value: (k: string) => {
            const x = t?.values.find((v) => v.key === k);
            return x ? { value: x.value, assumed: x.assumed === true } : undefined;
          },
          retired: (k: string) => accounts !== undefined && k.startsWith("session.") && !Object.hasOwn(accounts, k.slice("session.".length)) };
      } };
  }

  private occupancyAt(target: string): Occupancy {
    const room = this.house.targets.get(target)?.room;
    return room ? this.occupancyOfRoom(room) : "unknown";
  }

  /** A room's occupancy, from the sensors the house puts in it (steward, *Occupancy*); a read, changing nothing. */
  private occupancyOfRoom(room: string): Occupancy {
    return occupancyOf(this.mirror.sensors(this.targetsIn(room)), Math.floor(this.o.clock.now()), this.house.home.occupancy_hold_s * 1000, this.mutation);
  }

  /** The house's targets by room, built once for each house (a define replaces it). */
  private readonly byRoom = new WeakMap<House, Map<string, string[]>>();

  private targetsIn(room: string): string[] {
    let m = this.byRoom.get(this.house);
    if (!m) {
      m = new Map();
      for (const t of this.house.targets.values()) if (t.room) m.set(t.room, [...(m.get(t.room) ?? []), t.id]);
      this.byRoom.set(this.house, m);
    }
    return m.get(room) ?? [];
  }

  /**
   * A sensor's event in `room`, followed or recovered from a gap: should it show the room's occupancy
   * known, the next skipped(occupancy_unknown) in it is noticed again (GA-RULE-8). A mark is only made
   * while the room is unknown, so a room known at a sensor's event went from unknown to known since it
   * (the code review, CR8). One recovered counts as known when it reports someone there at its time;
   * the room as it stands after the gap is judged too.
   */
  private sensorSeen(room: string, e: Args, recovered: boolean): void {
    const there = (e.key === "motion" || e.key === "occupancy") && e.value === true;
    if ((recovered && there) || this.occupancyOfRoom(room) !== "unknown") this.after.roomKnown(room);
  }

  /**
   * `state` (steward, *Operations*): the applier's, as the mirror holds it, each group's state
   * (GA-GRP-1), each room's occupancy and each leased device's lease. The personal floor's policy is
   * slice 8's, every personal value withheld until then. An `endpoint` and `speaker` are checked as
   * for a request.
   */
  private state(a: Args, caller: Extract<Caller, { kind: "credential" }>): Record<string, unknown> {
    if (a.endpoint !== undefined) principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    const wanted: string[] | undefined = a.targets;
    const groups: Record<string, { on: boolean | null }> = {};
    for (const g of byId([...this.house.groups.values()])) if (!wanted || wanted.includes(g.id)) groups[g.id] = { on: groupOn(g, this.mirror) };
    // An internal device's state is shown to the owner's app only, as in `describe`.
    const ownersApp = this.isOwnersApp(caller);
    const view = this.mirror.stateView(wanted);
    const targets = Object.fromEntries(Object.entries(view.targets).filter(([id]) => ownersApp || this.mirror.devices.get(id)?.internal !== true));
    const leases = Object.fromEntries(this.leases.all().filter((l) => (!wanted || wanted.includes(l.target)) && (ownersApp || this.mirror.devices.get(l.target)?.internal !== true))
      .map((l) => [l.target, leaseView(l)]));
    const rooms = Object.fromEntries(byId([...this.house.rooms.values()]).map((r) => [r.id, { occupancy: this.occupancyOfRoom(r.id) }]));
    return { ...view, targets, groups, rooms, leases };
  }

  /**
   * `events` (steward, *Causes and history*): the steward's log, its own events and the applier's
   * relayed, as the applier's `events` works: no cursor gives the current one and no events; a long
   * poll waits on the clock for the next event. A personal key's event is the owner's only, its value
   * withheld (`servedTo`), until the personal floor (slice 8). An `endpoint` and `speaker` are checked as for a request.
   */
  private async events(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    const reader = this.readerOf(a, caller);
    if (a.cursor === undefined) return { events: [], cursor: this.log.cursor() };
    const read = () => {
      const marked = this.log.readMarked(a.cursor);
      const events = this.servedTo(caller, marked, reader);
      return { events, cursor: marked.length ? String(marked[marked.length - 1]!.event.seq) : a.cursor };
    };
    const first = read();
    if (first.events.length || !a.wait_s) return first;
    await this.log.wait(a.wait_s * 1000);
    return read();
  }

  /**
   * `history { targets?, from, to }` (steward, *Causes and history*; GA-STW-7): the kinds the standard
   * lists, the steward's own and the applier's relayed with their causes, oldest first, from the
   * store, which keeps 90 days (a personal key's `state` events 7); a speech key's and a personal key's
   * occurrences never. Read from the store, so it fails while the store is down (the design, *The store
   * unreachable*), `pending: false`. In the log's order, by `seq`. At most `HISTORY_CAP` events; past it
   * the answer says `more: true` and the caller reads on with `after_seq`, its last event's `seq` (the
   * build's pick: the standard names no paging; the milestone 7+10+11 review, I4). A personal key's event is the owner's only, value withheld, until the personal floor
   * (slice 8; `servedTo`).
   */
  private async history(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    const reader = this.readerOf(a, caller);
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: history is read from it");
    if (a.after_seq !== undefined && !Number.isSafeInteger(a.after_seq)) throw new RequestError("invalid_request", "after_seq is not an integer");
    // An applier's `latch` or `rule_fired` names its rule only: it matches the devices the rule actuates, as `describe` lists them (M4).
    const rules = a.targets === undefined ? [] : [...this.mirror.safetyRules].filter(([, r]) => r.devices.some((d) => a.targets.includes(d))).map(([id]) => id);
    const r = await within(this.o.clock, GATE_MS, this.log.history(Date.parse(a.from), Date.parse(a.to), a.targets, this.o.historyCap ?? HISTORY_CAP, a.after_seq ?? 0, rules),
      `the store did not answer within ${GATE_MS} ms: history is read from it`, false);
    return { events: this.servedTo(caller, r.events, reader), ...(r.more ? { more: true } : {}) };
  }

  /**
   * The events `caller` is served, judged by each event's `personal` mark as it was kept, never by
   * the model as it is now (the milestone 7+10+11 review, B5). Until slice 8 builds the personal floor,
   * a personal key's event goes to the owner only, its value withheld; every other caller gets none
   * (the maintainer, 2026-10-06, Q1). A mark not known counts as personal.
   */
  private servedTo(caller: Extract<Caller, { kind: "credential" }>, marked: Marked[], reader?: Principal): AppEvent[] {
    const owner = this.isOwnersApp(caller);
    const out: AppEvent[] = [];
    for (const { event, personal, readers } of marked) {
      // A `define` kept with no readers (one the migration missed) is read as its endpoint's (the review, I2).
      const kept = readers ?? (event.type === "define" ? { endpoint: String(event.endpoint ?? "") } : undefined);
      const shown = kept ? this.forReader(event, kept, reader) : event;
      if (personal === false) out.push(shown);
      else if (owner) out.push("value" in shown ? { ...shown, value: "withheld" } : shown);
    }
    return out;
  }

  /**
   * The reader of an `events` or `history` call, by the endpoint it names, or derives: an app's or a
   * panel's one endpoint (GA-CONF-5, GA-STW-7). A brain naming no endpoint, and a front, derive none.
   */
  private readerOf(a: Args, caller: Extract<Caller, { kind: "credential" }>): Principal | undefined {
    if (a.endpoint !== undefined) return principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    const c = caller.credential;
    return (c.kind === "app" || c.kind === "panel") && c.endpoint !== undefined && this.house.endpoints.has(c.endpoint)
      ? principalOf(this.house, c, c.endpoint, undefined, this.mutation) : undefined;
  }

  /**
   * An `ask` event's `steps`, or a `define` event's `diff`, as `reader` may read them (GA-CONF-5, GA-STW-7):
   * whole at the event's endpoint, to an owner's role and to the plan's speaker, a value setting a
   * personal key withheld from a guest or a visitor (GA-AUTH-7); every other read gets the event without them.
   */
  private forReader(event: AppEvent, readers: Readers, reader: Principal | undefined): AppEvent {
    const may = reader !== undefined && (reader.endpoint === readers.endpoint || reader.role === "owner"
      || (readers.speaker !== undefined && reader.person === readers.speaker));
    if (event.type === "define") {
      if (may || this.mutation === "broadcasts-the-diff") return event;
      const { diff: _d, ...rest } = event;
      return rest as AppEvent;
    }
    if (!Array.isArray(event.steps)) return event;
    if (!may && this.mutation !== "broadcasts-the-steps") {
      const { steps: _s, ...rest } = event;
      return rest as AppEvent;
    }
    if (reader === undefined || (reader.role !== "guest" && reader.role !== "visitor")) return event;
    return { ...event, steps: (event.steps as Args[]).map((x) => {
      const personal = this.mirror.devices.get(String(x.target))?.personal;
      if (!Array.isArray(personal) || !x.args || typeof x.args !== "object") return x;
      return { ...x, args: Object.fromEntries(Object.entries(x.args as Args).map(([k, v]) => [k, personal.includes(k) ? "withheld" : v])) };
    }) };
  }

  /**
   * `scenario_run { plan_id, idempotency_key }` (steward, *Scenario runs*): a client write, refused at
   * once while the store is known down. A repeated key within 3600 s returns the first run and starts
   * nothing, another plan under it `idempotency_conflict` (GA-SCN-6); the plan's rules are `apply`'s
   * (`unknown_plan`, `plan_not_yours`, `plan_expired`, `stale_revision`, spent once run), and a plan
   * that is not a scenario's is `invalid_request`. A scenario of mode `single` that is running is not
   * started again: its run is returned with `ignored` (GA-SCN-1). Otherwise the run's record commits,
   * the plan is spent, and the run starts, acting as the plan's principal (GA-SCN-3).
   */
  private async scenarioRun(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<Record<string, unknown>> {
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: a run is refused until it returns", false);
    const credential = caller.credential.id;
    const now = Math.floor(this.o.clock.now());
    const k = `${credential}\u0000${a.idempotency_key}`;
    const prior = this.runKeys.get(k);
    if (prior && now - prior.atMs <= KEY_RETENTION_MS) {
      if (prior.body !== a.plan_id) throw new RequestError("idempotency_conflict", "this key was used with another plan (GA-SCN-6)");
      await prior.ready;
      if (this.runKeys.get(k) !== prior) return this.scenarioRun(a, caller);
      return { run_id: prior.run_id, ...(prior.ignored ? { ignored: true } : {}) };
    }
    this.forgetPlans();
    const held = this.plans.get(a.plan_id);
    if (!held) throw new RequestError("unknown_plan", `no plan ${a.plan_id} is held`);
    if (held.credential !== credential) throw new RequestError("plan_not_yours", "another credential made this plan (GA-STW-5)");
    const scenario = held.plan.request.scenario;
    if (typeof scenario !== "string") {
      throw new RequestError("invalid_request", held.plan.request.changes !== undefined ? "a define's plan is applied with define { plan_id }, not run"
        : "a request's plan is applied, not run");
    }
    if (now > held.expiresMs) throw new RequestError("plan_expired", "the plan expired (GA-SCN-6)");
    if (held.plan.revision !== this.rev) throw new RequestError("stale_revision", `the plan was made at revision ${held.plan.revision}, the house is at ${this.rev}`);
    if (held.applied) throw new RequestError("plan_expired", "the plan was run already: a run spends it");
    // Every key a credential holds counts, an ignored start's too: one plan reused under new keys grows nothing past the cap (B1).
    if ((this.runKeysHeld.get(credential) ?? 0) >= (this.o.maxAppliesPerCredential ?? MAX_APPLIES_PER_CREDENTIAL)) {
      throw new RequestError("invalid_request", "this credential holds too many runs under keys within their 3600 s; a new key waits for the oldest to pass");
    }
    const running = this.runningOf.get(scenario);
    if (running) {
      // The ignored start's key is kept, committed before the answer, so a restart answers it as the same run (GA-SCN-6, GA-PERSIST-2; I1).
      let ready!: () => void;
      const claim = { run_id: running.run_id, body: a.plan_id, atMs: now, ignored: true as const, ready: new Promise<void>((resolve) => { ready = resolve; }) };
      this.setRunKey(k, claim);
      try {
        const kept = this.o.store.write((tx) => tx.query("INSERT INTO run_keys (credential, key, body, at_ms, run_id) VALUES ($1, $2, $3, $4, $5) "
          + "ON CONFLICT (credential, key) DO UPDATE SET body = EXCLUDED.body, at_ms = EXCLUDED.at_ms, run_id = EXCLUDED.run_id",
        [credential, a.idempotency_key, a.plan_id, now, running.run_id]).then(() => undefined));
        await within(this.o.clock, GATE_MS, kept, `the store did not keep the start within ${GATE_MS} ms: it is not taken`, false);
      } catch (err) {
        if (this.runKeys.get(k) === claim) this.deleteRunKey(k);
        throw err;
      } finally {
        ready();
      }
      return { run_id: running.run_id, ignored: true };
    }
    const p = held.principal;
    const run_id = randomUUID();
    const cause = { run: run_id, ...(p.person ? { person: p.person } : {}), ...(this.mutation === "drops-the-starting-endpoint" ? {} : { endpoint: p.endpoint }) };
    const run: Run = { run_id, scenario, credential, key: a.idempotency_key, starterRole: p.role, atMs: now, precedence: "person", cause, via: p.via, brain: p.brain,
      status: "running", entries: [], lateAcked: new Set(), lost: new Set(), leased: [], programDone: false };
    // The key is claimed, and the plan spent, before anything is awaited, so a repeat waits for this start.
    let ready!: () => void;
    const claim = { run_id, body: a.plan_id, atMs: now, ready: new Promise<void>((resolve) => { ready = resolve; }) };
    this.setRunKey(k, claim);
    held.applied = true;
    try {
      const kept = this.o.store.write(async (tx) => {
        await tx.query("INSERT INTO runs (run_id, credential, key, body, at_ms, scenario, doc) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (run_id) DO NOTHING",
          [run_id, credential, a.idempotency_key, a.plan_id, now, scenario, JSON.stringify(this.runDoc(run))]);
        await tx.query("UPDATE plans SET applied = true WHERE plan_id = $1", [held.plan.plan_id]);
      });
      await within(this.o.clock, GATE_MS, kept, `the store did not keep the run within ${GATE_MS} ms: it is not started`, false);
    } catch (err) {
      // Nothing started: the key is free again, and the plan unspent.
      this.deleteRunKey(k);
      held.applied = false;
      throw err;
    } finally {
      ready();
    }
    this.startRun(run, compile(this.house, scenario), held);
    return { run_id };
  }

  /**
   * `scenario_status { run_id }` (GA-SCN-11, GA-STW-12): a run's status, `failed_steps` and
   * `sent_steps`, each step with its time; `unknown_run` for none held. Read only by the credential
   * that started it and the owner's app, a run a rule or a schedule started by the owner's app alone;
   * any other is `unknown_run`, as `outcome` is (ruled by the maintainer, 2026-10-05; proposed for the next steward revision).
   */
  private scenarioStatus(a: Args, caller: Extract<Caller, { kind: "credential" }>): Record<string, unknown> {
    const run = this.runs.get(a.run_id);
    if (!run || (run.credential !== caller.credential.id && !this.isOwnersApp(caller))) throw new RequestError("unknown_run", `no run ${a.run_id} of this credential's is held`);
    return statusOf(run, this.mutation);
  }

  /**
   * `scenario_stop { run_id, endpoint, speaker? }` (GA-SCN-9): a client write, refused at once while the
   * store is known down. The principal is the endpoint's; one of lower precedence than the run's, or of
   * a role lower than its starter's, is `not_permitted`, as is a guest's or a visitor's for a run no
   * person started (ruled by the maintainer, 2026-10-05); an unknown run is `unknown_run`. A running run
   * ends `ended(stopped)`, its devices left where they are (a finish block is for the revision); an
   * ended one is returned as it ended. The status is the answer.
   */
  private scenarioStop(a: Args, caller: Extract<Caller, { kind: "credential" }>): Record<string, unknown> {
    if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: a stop is refused until it returns", false);
    const p = principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    const run = this.runs.get(a.run_id);
    if (!run) throw new RequestError("unknown_run", `no run ${a.run_id} is held`);
    if (refusedBy({ precedence: run.precedence }, "person")) throw new RequestError("not_permitted", "the run outranks a person (GA-SCN-9)");
    if (run.starterRole && p.role !== run.starterRole && lowerRole(p.role, run.starterRole) === p.role) {
      throw new RequestError("not_permitted", `a ${p.role} may not stop a run a ${run.starterRole} started (GA-SCN-9)`);
    }
    // A run no person started is never a visitor's to stop (GA-SCN-9); nor, the build's choice, a guest's.
    if (!run.starterRole && (p.role === "guest" || (p.role === "visitor" && this.mutation !== "visitor-stops-a-schedule"))) {
      throw new RequestError("not_permitted", `a ${p.role} may not stop a run no person started`);
    }
    this.endRun(run, "stopped");
    return statusOf(run, this.mutation);
  }

  /** A run's record in the store, as it stands. */
  private runDoc(run: Run): Record<string, unknown> {
    return { status: run.status, ...(run.reason ? { reason: run.reason } : {}), ...(run.starterRole ? { starter_role: run.starterRole } : {}), ...(run.endedMs !== undefined ? { ended_ms: run.endedMs } : {}), cause: run.cause, ...(run.rule ? { rule: run.rule } : {}),
      ...(run.schedule ? { schedule: run.schedule } : {}), ...(run.stepAt !== undefined ? { step: run.stepAt } : {}), ...(run.status === "ended" ? run.ended ?? tally(run, this.mutation) : {}) };
  }

  /** A run's record as it stands when the write runs; a rule's run is inserted so. Safe to run twice. */
  private async writeRun(tx: Tx, run: Run): Promise<void> {
    await tx.query("INSERT INTO runs (run_id, credential, key, body, at_ms, scenario, doc) VALUES ($1, NULL, NULL, NULL, $2, $3, $4) "
      + "ON CONFLICT (run_id) DO UPDATE SET doc = EXCLUDED.doc", [run.run_id, run.atMs, run.scenario, JSON.stringify(this.runDoc(run))]);
  }

  /** Writes a run's record again, behind: one write in the writer's line per run at a time, writing its latest; a rule's run is inserted so. */
  private saveRun(run: Run): void {
    const id = `run:${run.run_id}`;
    if (this.saving.has(id)) {
      this.saving.set(id, true);
      return;
    }
    this.saving.set(id, false);
    void this.o.store.write((tx) => this.writeRun(tx, run))
      .then(() => {
        const again = this.saving.get(id);
        this.saving.delete(id);
        if (again) this.saveRun(run);
      });
  }

  /**
   * Reads back the runs of the last 3600 s, so a repeated key finds its run and `scenario_status` its
   * end; a run the store holds as running was interrupted by the restart: it ends `ended(interrupted)`
   * and its leases are released (GA-PERSIST-2).
   */
  private async loadRuns(): Promise<void> {
    const since = Math.floor(this.o.clock.now()) - KEY_RETENTION_MS;
    const rows = await this.o.store.query<{ run_id: string; credential: string | null; key: string | null; body: string | null; at_ms: number | string;
      scenario: string; doc: Args }>("SELECT run_id, credential, key, body, at_ms, scenario, doc FROM runs WHERE COALESCE((doc->>'ended_ms')::bigint, at_ms) > $1 OR doc->>'status' = 'running' ORDER BY at_ms", [since]);
    for (const row of rows.rows) {
      const d = row.doc;
      const run: Run = { run_id: row.run_id, scenario: row.scenario, ...(row.credential ? { credential: row.credential, key: row.key! } : {}),
        ...(d.rule ? { rule: d.rule } : {}), ...(d.schedule ? { schedule: d.schedule } : {}), ...(d.starter_role ? { starterRole: d.starter_role } : {}), atMs: Number(row.at_ms), precedence: "person", cause: d.cause ?? { run: row.run_id }, via: "", brain: false,
        status: "ended", reason: d.status === "running" ? "interrupted" : d.reason, endedMs: d.status === "running" ? Math.floor(this.o.clock.now()) : Number(d.ended_ms ?? row.at_ms), entries: [], lateAcked: new Set(), lost: new Set(), leased: [], programDone: true,
        ended: { failed_steps: d.failed_steps ?? [], sent_steps: d.sent_steps ?? [] } };
      this.runs.set(run.run_id, run);
      if (row.credential && row.key) this.setRunKey(`${row.credential}\u0000${row.key}`, { run_id: run.run_id, body: row.body ?? "", atMs: run.atMs, ready: Promise.resolve() });
      if (d.status === "running") {
        this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "ended", reason: "interrupted", cause: run.cause });
        this.saveRun(run);
      }
    }
    // The keys of starts that `single` ignored, each answered as the run it named (I1).
    const ignored = await this.o.store.query<{ credential: string; key: string; body: string; at_ms: number | string; run_id: string }>(
      "SELECT credential, key, body, at_ms, run_id FROM run_keys WHERE at_ms > $1", [since]);
    for (const row of ignored.rows) {
      this.setRunKey(`${row.credential}\u0000${row.key}`, { run_id: row.run_id, body: row.body, atMs: Number(row.at_ms), ignored: true, ready: Promise.resolve() });
    }
    // A run's lease outlives no run: every one the store held is released, re-evaluating the rules it refused (GA-LEASE-4).
    for (const l of this.leases.all()) if (typeof l.holder === "object" && "run" in l.holder) this.leases.end(l.target);
  }

  /** Holds a run key, counted against its credential's cap; one it replaces is no longer counted. */
  private setRunKey(k: string, v: { run_id: string; body: string; atMs: number; ignored?: true; ready: Promise<void> }): void {
    if (this.runKeys.has(k)) this.deleteRunKey(k);
    this.runKeys.set(k, v);
    const credential = k.slice(0, k.indexOf("\u0000"));
    this.runKeysHeld.set(credential, (this.runKeysHeld.get(credential) ?? 0) + 1);
  }

  /** Forgets a run key, and its count. */
  private deleteRunKey(k: string): void {
    if (!this.runKeys.delete(k)) return;
    const credential = k.slice(0, k.indexOf("\u0000"));
    const n = (this.runKeysHeld.get(credential) ?? 1) - 1;
    if (n > 0) this.runKeysHeld.set(credential, n);
    else this.runKeysHeld.delete(credential);
  }

  /** Forgets the ended runs older than their keys' 3600 s, in memory; the store's rows go with the periodic prune. */
  private forgetRuns(): void {
    const oldest = this.o.clock.now() - KEY_RETENTION_MS;
    for (const [k, x] of this.runKeys) if (x.atMs <= oldest && this.runs.get(x.run_id)?.status !== "running") this.deleteRunKey(k);
    for (const [id, r] of this.runs) {
      if (r.status !== "ended" || (r.endedMs ?? r.atMs) > oldest) continue;
      this.runs.delete(id);
      for (const e of r.entries) if ("applierApplyId" in e && e.applierApplyId) this.byApplier.delete(e.applierApplyId);
    }
  }

  /**
   * A step: a run starts (the design, *Scenarios*): its owned targets, groups expanded leaving out
   * `infrastructure` members, leased at its precedence until it ends (GA-SCN-2), a target held higher
   * left unleased; a `scenario` event; the run limit's timer; then its steps, in order, outside the
   * steps. `held` is the plan a person's run was started from, whose answers stand for the run.
   */
  private startRun(run: Run, program: Program, held?: HeldPlan): void {
    if (held) run.planId = held.plan.plan_id;
    this.runs.set(run.run_id, run);
    this.runningOf.set(run.scenario, run);
    const now = Math.floor(this.o.clock.now());
    const targets = [...new Set(program.owned.flatMap((id) => (this.house.groups.has(id) && !this.mirror.devices.has(id)
      ? this.house.groups.get(id)!.members.filter((m) => this.mirror.devices.get(m)?.infrastructure !== true) : [id])))].sort();
    for (const target of targets) {
      if (this.mutation === "ignores-leases") break;
      // Only a device its starter's role could act on (ruled by the maintainer, 2026-10-05; proposed for the next steward revision).
      if (!this.mayAct(run.starterRole, target)) continue;
      if (this.leases.grant({ target, holder: { run: run.run_id }, precedence: run.precedence, sinceMs: now, expiresMs: null })) run.leased.push(target);
    }
    this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "started", cause: run.cause });
    run.bound = this.o.clock.setTimeout(() => this.endRun(run, "timeout"), RUN_LIMIT_MS);
    void this.drive(run, program.nodes, held).then(() => {
      // A steward stopped leaves its runs as the store holds them: the next start ends them interrupted.
      if (this.halted) return;
      run.programDone = true;
      this.maybeEndRun(run);
    }).catch((err: unknown) => {
      this.say(`steward bug: run ${run.run_id} of ${run.scenario} threw: ${err instanceof Error ? err.message : String(err)}`);
      run.programDone = true;
      this.endRun(run, "done");
    });
  }

  /**
   * Whether a role could act on `target` (GA-TIER-3): an owner or a member on any device, a guest on one
   * with an action at `reversible`, a visitor on none. A run no person started acts as the house's own.
   */
  private mayAct(role: Role | undefined, target: string): boolean {
    if (role === undefined || role === "owner" || role === "member") return true;
    if (role === "visitor") return false;
    const actions = this.mirror.devices.get(target)?.actions;
    return (Array.isArray(actions) ? actions as Args[] : []).some((x) => this.mirror.tierOf(target, String(x.action)) === "reversible");
  }

  /** A run's steps in order; false once the run has ended. An action step's outcomes are waited for before the next step (*Rulings*). */
  private async drive(run: Run, nodes: Node[], held?: HeldPlan): Promise<boolean> {
    for (const n of nodes) {
      if (run.status !== "running" || this.halted) return false;
      if (n.kind === "action") await this.runAction(run, n, held);
      else if (n.kind === "delay") await this.runSleep(run, n.ms);
      else if (n.kind === "wait") {
        if (!(await this.runWait(run, n))) return false;
      } else {
        const branch = this.runIf(run, n);
        if (branch && !(await this.drive(run, branch, held))) return false;
      }
    }
    return run.status === "running";
  }

  /** Waits `ms` on the clock, or until the run ends. */
  private runSleep(run: Run, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = this.o.clock.setTimeout(() => { run.wake = undefined; resolve(); }, ms);
      run.wake = () => { this.o.clock.clear(timer); run.wake = undefined; resolve(); };
    });
  }

  /** What an `if` or a `wait` reads: the mirror, with no rule's mutation; `assumed` read as observed when `assumed` says so. */
  private runView(assumed = false): ReturnType<Steward["ruleView"]> {
    return { ...this.ruleView(), mutation: undefined, readsAssumed: assumed };
  }

  /**
   * A `wait` (GA-SCN-10): its value read on the device, live and not `assumed` (GA-RULE-2), at once and
   * on every event of the device, until its timeout. A timeout is a `scenario` event either way; with
   * `stop` it ends the run `ended(timeout)` and returns false, with `continue` the run goes on.
   */
  private runWait(run: Run, n: Extract<Node, { kind: "wait" }>): Promise<boolean> {
    const w = n.wait;
    const holds = () => readingHolds({ target: w.target, key: w.key, op: "eq", value: w.value }, this.runView());
    if (holds()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer = 0;
      const done = (met: boolean) => {
        this.waiting.delete(waiter);
        this.o.clock.clear(timer);
        run.wake = undefined;
        resolve(met);
      };
      const waiter = { target: w.target, check: () => { if (holds()) done(true); } };
      this.waiting.add(waiter);
      run.wake = () => done(false);
      timer = this.o.clock.setTimeout(() => {
        const stop = (w.on_timeout ?? "stop") === "stop";
        this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "wait_timeout", step_id: n.id, target: w.target, key: w.key,
          on_timeout: stop ? "stop" : "continue", cause: run.cause });
        done(!stop);
        if (stop) this.endRun(run, "timeout");
      }, w.timeout_s * 1000);
    });
  }

  /**
   * An `if` (GA-SCN-8), read when reached: the branch its condition chooses; on a device not `live`, or
   * an `assumed` value, the `else` if there is one, else none, the step ending `skipped(dead)`,
   * `skipped(stale)` or `skipped(assumed)`, which `failed_steps` lists. `branches-on-an-assumed-value`
   * reads an assumed value as observed; `stales-an-assumed-if` reports `skipped(stale)` for one.
   */
  private runIf(run: Run, n: Extract<Node, { kind: "if" }>): Node[] | undefined {
    const c = n.cond;
    const liveness = this.mirror.state.get(c.target)?.liveness;
    const read = this.ruleView().device(c.target)?.value(c.key);
    const assumed = read?.assumed === true && this.mutation !== "branches-on-an-assumed-value";
    const time = new Date(Math.floor(this.o.clock.now())).toISOString();
    if (liveness !== "live" || assumed) {
      if (n.else) {
        this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "if", step_id: n.id, branch: "else", cause: run.cause });
        return n.else;
      }
      const reason = liveness !== "live" ? (liveness === "stale" ? "stale" : "dead") : this.mutation === "stales-an-assumed-if" ? "stale" : "assumed";
      const ev = this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "if", step_id: n.id, outcome: "skipped", reason, cause: run.cause });
      run.entries.push({ step_id: n.id, target: c.target, outcome: "skipped", reason, time: ev.time });
      this.saveRun(run);
      return undefined;
    }
    const holds = readingHolds({ target: c.target, key: c.key, op: c.op, value: c.value }, this.runView(this.mutation === "branches-on-an-assumed-value"));
    this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "if", step_id: n.id, branch: holds ? "then" : n.else ? "else" : "none", cause: run.cause });
    return holds ? n.then : n.else;
  }

  /**
   * One action step of a run (GA-SCN-7, GA-STW-10): each of its plan's steps judged again at dispatch,
   * as `apply` judges a plan's, the answers given standing for the run (GA-SCN-3): a lease that outranks
   * the run refuses it, its room is read where it respects occupancy, an unanswered ask is
   * `skipped(not_confirmed)`. What is sent goes as one applier apply keyed `run:<run_id>:<n>`, with the
   * starting endpoint's `via` and `brain` (GA-AUTH-5), the run's cause (GA-SCN-3) and a token for each
   * yes (GA-CONF-3); its steps take no lease of their own (the design, *Standards problems*). The run
   * waits for every step to end before it goes on (*Rulings*).
   */
  private async runAction(run: Run, n: ActionNode, held?: HeldPlan): Promise<void> {
    if (!held) return this.runAuthoredAction(run, n);
    await this.reaskToggles(run, n, held);
    // A steward stopped meanwhile records nothing more of the run (the milestone 5+6 review, M5).
    if (run.status !== "running" || this.halted) return;
    const now = Math.floor(this.o.clock.now());
    const time = new Date(now).toISOString();
    const key = `run:${run.run_id}:${n.index}`;
    const r: ApplyRecord = { apply_id: randomUUID(), credential: `run:${run.run_id}`, key, applierKey: key, body: "", atMs: now, cause: run.cause,
      outcomes: [], sent: [], steps: {}, done: Promise.resolve(), memoryOnly: true, run: { id: run.run_id, index: n.index } };
    run.entries.push(r);
    const actions: Record<string, unknown>[] = [];
    const checks: RunCheck[] = [];
    const judging = { precedence: run.precedence, leaseOf: (t: string) => this.leases.holding(t), mutation: this.mutation };
    for (const s of (held.plan.steps as StewardStep[]).filter((x) => indexOf(x.step_id) === n.index)) {
      const decide = () => {
        const room = n.respect ? this.occupancyAt(s.target) : undefined;
        const holder = leased(s.target, s.action, judging)?.holder;
        return { d: atDispatch(s, held.answers[s.step_id], false, { leased: holder,
          ...(room === "occupied" || room === "unknown" ? { occupancy: room } : {}) }, this.mutation), holder };
      };
      const { d } = decide();
      if (!d.send) {
        const why = "reason" in d ? { reason: d.reason } : { detail: d.detail };
        r.outcomes.push({ step_id: s.step_id, target: s.target, outcome: d.outcome, ...why, time });
        this.runOwnOutcome(run, r, s, d.outcome, why);
        continue;
      }
      // A step of a brain_authored scenario goes with brain: true, whoever runs it (GA-DEF-7).
      const sent = { target: s.target, action: s.action, args: s.args, via: run.via, brain: run.brain || s.brain_authored === true, for: run.cause };
      const token = d.token ? mintToken(sent, { issuer: this.o.applierClient!, key: this.o.tokenKey!, now }) : undefined;
      actions.push({ ...sent, ...(token ? { token } : {}) });
      checks.push({ step_id: s.step_id, target: s.target, action: s.action, decide });
      r.sent.push(s.step_id);
      r.outcomes.push({ step_id: s.step_id, target: s.target, outcome: "unknown", time });
    }
    await this.dispatchRunStep(run, r, actions, checks);
  }

  /**
   * GA-SCN-3: a yes to `ask(toggle_only)` stands for `ask_expiry_s` from when it was given. The action
   * step's toggle steps whose yes is older are asked again, as a new `ask` event on the run's plan,
   * which is open to their answer alone for `ask_expiry_s` (the design, *Standards problems found*), the
   * run waiting on it; the yes taken away meanwhile, so without a new one the step is
   * `skipped(not_confirmed)`. `toggles-on-an-old-yes` sends on the old yes.
   */
  private async reaskToggles(run: Run, n: ActionNode, held: HeldPlan): Promise<void> {
    if (this.mutation === "toggles-on-an-old-yes") return;
    const now = Math.floor(this.o.clock.now());
    const expiry = this.house.home.ask_expiry_s * 1000;
    const stale = (held.plan.steps as StewardStep[]).filter((x) => indexOf(x.step_id) === n.index && x.verdict === "ask" && x.reason === "toggle_only"
      && held.answers[x.step_id] === "yes" && now - (held.answeredMs?.[x.step_id] ?? 0) > expiry).map((x) => x.step_id);
    if (!stale.length) return;
    const answers = { ...held.answers };
    for (const st of stale) delete answers[st];
    held.answers = answers;
    held.askedMs = { ...held.askedMs, ...Object.fromEntries(stale.map((st) => [st, now])) };
    held.reopened = { steps: stale, untilMs: now + expiry };
    this.putAsk(held, stale, run.run_id);
    await new Promise<void>((resolve) => {
      const done = () => {
        this.o.clock.clear(timer);
        this.reasked.delete(held.plan.plan_id);
        run.wake = undefined;
        held.reopened = undefined;
        resolve();
      };
      const timer = this.o.clock.setTimeout(done, expiry);
      run.wake = done;
      this.reasked.set(held.plan.plan_id, () => {
        if (stale.every((st) => held.answers[st] !== undefined)) done();
      });
    });
  }

  /**
   * A step: a rule starts a scenario (GA-SCN-4, GA-AUTH-5): a run at `rule` precedence, `via: rule`,
   * its cause `{ run, rule }`, written behind. A scenario of mode `single` that is running is not
   * started again; the start counts as landed, no failure and nothing retried (a media lock, done
   * the standard's way: *Rulings*), a `scenario` event recording it.
   */
  private startRuleRun(rule: Rule, scenario: string): void {
    const running = this.runningOf.get(scenario);
    if (running) {
      this.log.append("scenario", { run_id: running.run_id, scenario, change: "ignored", cause: { rule: rule.id } });
      return;
    }
    const run_id = randomUUID();
    const run: Run = { run_id, scenario, rule: rule.id, atMs: Math.floor(this.o.clock.now()), precedence: "rule", cause: { run: run_id, rule: rule.id },
      via: "rule", brain: false, ...(rule.brain_authored ? { brainAuthored: true as const } : {}), status: "running", entries: [], lateAcked: new Set(),
      lost: new Set(), leased: [], programDone: false };
    this.saveRun(run);
    this.startRun(run, compile(this.house, scenario));
  }

  /**
   * A step: a schedule's time has come (the design, *Schedules*): a run of its scenario that acts as the
   * scenario at `scheduled_run` precedence, `via: schedule`, its cause `{ run, schedule }`, its steps
   * authored (GA-SCN-4, GA-AUTH-5), written behind. A schedule whose `single` scenario runs waits
   * (`Schedules`), and goes back to waiting when the scenario was started by another while its mark
   * committed (M10); one that still finds it running here is recorded `schedule_missed`, `reason:
   * scenario_running`, as a wait whose grace closed is.
   */
  private startScheduledRun(s: Schedule, o: Occurrence): void {
    const running = this.runningOf.get(s.scenario);
    if (running) {
      // Its date was marked; a start that came in between is recorded missed, as the grace closing is (M10).
      this.log.append("schedule_missed", { schedule: s.id, scenario: s.scenario, date: o.date, at: new Date(o.at).toISOString(), reason: "scenario_running",
        cause: { schedule: s.id } });
      return;
    }
    const run_id = randomUUID();
    // A schedule defined through a brain, or its date a brain moved, makes the run brain_authored (GA-DEF-7).
    const marked = s.brain_authored === true || s.exceptions.some((x) => x.date === o.date && x.action === "move" && x.brain_authored === true);
    const run: Run = { run_id, scenario: s.scenario, schedule: s.id, atMs: Math.floor(this.o.clock.now()), precedence: "scheduled_run",
      cause: { run: run_id, schedule: s.id }, via: "schedule", brain: false, ...(marked ? { brainAuthored: true as const } : {}), status: "running",
      entries: [], lateAcked: new Set(), lost: new Set(), leased: [], programDone: false };
    this.saveRun(run);
    this.startRun(run, compile(this.house, s.scenario));
  }

  /**
   * One action step of a run no person started (GA-SCN-4): resolved and planned at its dispatch, judged
   * as a rule's own action is (authored, at the run's precedence, its room read where it respects
   * occupancy, an ask no one can answer its skip), sent as one apply keyed `run:<run_id>:<n>`, `via:
   * rule` or `via: schedule` (GA-AUTH-5), `notify`'s `from` the rule's, or for a scheduled run the
   * scenario's (GA-NOTE-2). Its outcomes raise no rule's failure notice and are not retried
   * (*Standards problems found*).
   */
  private async runAuthoredAction(run: Run, n: ActionNode): Promise<void> {
    // Authored work: a device reached through a room or a group it joined through a brain is brain_authored for it (GA-DEF-7).
    const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation, authored: true };
    // The run's start, or the scenario the step comes from, brain_authored: so is the step (GA-DEF-7), and its notify's from says so (GA-NOTE-2).
    const marked = run.brainAuthored === true || n.brain === true;
    const by = run.schedule !== undefined ? { scenario: run.scenario } : { rule: run.rule! };
    const steps = resolveRequest([n.action], view).map((x) => {
      const brain = marked || x.brain === true;
      const { from: _f, ...rest } = x.args as Args;
      return { target: x.target, action: x.action, args: x.action === "notify.notify" ? this.fromOf(rest, { ...by, ...(brain ? { brain_authored: true } : {}) }) : x.args,
        conflict: x.conflict, ...(brain ? { brain: true as const } : {}) };
    });
    const sent = (x: { target: string; action: string; args: Record<string, unknown>; brain?: true }) =>
      ({ target: x.target, action: x.action, args: x.args, via: run.via, brain: run.brain || x.brain === true, for: run.cause });
    const key = `run:${run.run_id}:${n.index}`;
    const r: ApplyRecord = { apply_id: randomUUID(), credential: `run:${run.run_id}`, key, applierKey: key, body: "", atMs: Math.floor(this.o.clock.now()),
      cause: run.cause, outcomes: [], sent: [], steps: {}, done: Promise.resolve(), memoryOnly: true, run: { id: run.run_id, index: n.index } };
    run.entries.push(r);
    const theirs = steps.length ? await this.applierPlanOf({ actions: steps.map(sent) }) : [];
    if (run.status !== "running" || this.halted) {
      run.entries.pop();
      return;
    }
    const now = Math.floor(this.o.clock.now());
    const time = new Date(now).toISOString();
    // A scheduled run's principal says `schedule`, as its wire does (the milestone 5+6 review, M4).
    const p: Principal = { endpoint: run.schedule !== undefined ? `schedule:${run.schedule}` : `rule:${run.rule}`, person: null,
      via: run.schedule !== undefined ? "schedule" : "rule", brain: false, role: "owner" };
    const actions: Record<string, unknown>[] = [];
    const checks: RunCheck[] = [];
    steps.forEach((x, i) => {
      const step_id = stepIdOf(n.index, i + 1, steps.length);
      const theirStep = theirs?.find((y) => y.target === x.target && y.action === x.action && canonical(y.args ?? {}) === canonical(x.args));
      const judgeNow = () => judge(step_id, x, theirStep, { principal: p, precedence: run.precedence, authored: true, leaseOf: (t) => this.leases.holding(t),
        mutation: this.mutation, internal: (t) => this.mirror.devices.get(t)?.internal === true,
        ...(n.respect ? { occupancyOf: (t: string) => this.occupancyAt(t) } : {}),
        tierOf: (t, a) => this.mirror.tierOf(t, a), described: (t, a) => this.mirror.described(t, a) });
      const judged = judgeNow();
      // The lease and the room as they are now, as a rule's own action's (the milestone review, B4); judged whole again after the commit (I2).
      const decide = (again = true) => {
        const step = again ? judgeNow() : judged;
        const room = n.respect ? this.occupancyAt(x.target) : undefined;
        const holder = leased(x.target, x.action, { leaseOf: (t) => this.leases.holding(t), precedence: run.precedence, mutation: this.mutation })?.holder;
        return { d: ruleDecision(step, this.mutation, { leased: holder, ...(room === "occupied" || room === "unknown" ? { occupancy: room } : {}) }), holder: step.holder ?? holder };
      };
      const { d } = decide(false);
      if (!d.send) {
        const why = "reason" in d ? { reason: d.reason } : { detail: d.detail };
        r.outcomes.push({ step_id, target: x.target, outcome: d.outcome, ...why, time });
        this.runOwnOutcome(run, r, { step_id, target: x.target, action: x.action }, d.outcome, why, judged.holder);
        return;
      }
      const s = sent(x);
      const token = d.token ? mintToken(s, { issuer: this.o.applierClient!, key: this.o.tokenKey!, now }) : undefined;
      actions.push({ ...s, ...(token ? { token } : {}) });
      checks.push({ step_id, target: x.target, action: x.action, decide });
      r.sent.push(step_id);
      r.outcomes.push({ step_id, target: x.target, outcome: "unknown", time });
    });
    await this.dispatchRunStep(run, r, actions, checks);
  }

  /** The steward's own outcome of a run's step: an `outcome` event, and a `refused` one for a refusal, with the run's cause. */
  private runOwnOutcome(run: Run, r: ApplyRecord, s: { step_id: string; target: string; action: string }, outcome: string,
    why: { reason: string } | { detail: string }, holder?: unknown): void {
    const ev = this.log.append("outcome", { apply_id: r.apply_id, step_id: s.step_id, target: s.target, outcome, ...why, cause: run.cause });
    // The outcome carries its event's time (GA-STW-12): the clock may move between two reads in a step.
    const o = r.outcomes.find((x) => x.step_id === s.step_id);
    if (o) o.time = ev.time;
    if (outcome === "refused") {
      this.log.append("refused", { run: run.run_id, apply_id: r.apply_id, step_id: s.step_id, target: s.target, action: s.action, ...why,
        ...(holder !== undefined ? { holder } : {}), cause: run.cause });
    }
  }

  /**
   * Sends a run's action step, if it has anything to send, and waits until each of its steps has ended
   * or the run has. Authority waits for its commit while the store is up (the design, *Decisions*):
   * the run's record, naming this step, commits before the step is sent; only while the store is known
   * down is it written behind, so the run goes on through an outage (ruled, Q6). A commit that does not
   * come within the gate sends nothing: each step it would have sent ends unreachable. Once it has
   * committed, each step's lease and room are judged again (`checks`), in the step that sends, so a
   * lease taken while the commit waited refuses it (GA-LEASE-3; the milestone 5+6 review, I2).
   */
  private async dispatchRunStep(run: Run, r: ApplyRecord, actions: Record<string, unknown>[], checks: RunCheck[]): Promise<void> {
    if (actions.length) {
      run.stepAt = r.run!.index;
      if (this.o.store.down) this.saveRun(run);
      else {
        try {
          await within(this.o.clock, GATE_MS, this.o.store.write((tx) => this.writeRun(tx, run)), RUN_STEP_DROPPED, false);
        } catch (err) {
          if (!(err instanceof StoreUnavailable)) throw err;
          for (const step of r.sent) {
            const o = r.outcomes.find((x) => x.step_id === step)!;
            o.outcome = "unreachable";
            o.detail = DROPPED_STEP;
            this.runOwnOutcome(run, r, { step_id: step, target: o.target, action: "" }, "unreachable", { detail: DROPPED_STEP });
          }
          r.sent = [];
          actions = [];
          this.saveRun(run);
        }
      }
    }
    // A steward stopped while the record committed sends nothing and records nothing more (M5).
    if (this.halted) return;
    if (actions.length && run.status === "running") {
      const kept: Record<string, unknown>[] = [];
      actions.forEach((x, i) => {
        const c = checks[i]!;
        const { d, holder } = c.decide();
        if (d.send) {
          kept.push(x);
          return;
        }
        const why = "reason" in d ? { reason: d.reason } : { detail: d.detail };
        const o = r.outcomes.find((y) => y.step_id === c.step_id)!;
        o.outcome = d.outcome;
        if ("reason" in d) o.reason = d.reason;
        else o.detail = d.detail;
        r.sent = r.sent.filter((st) => st !== c.step_id);
        this.runOwnOutcome(run, r, c, d.outcome, why, holder);
      });
      actions = kept;
    }
    if (actions.length && run.status === "running") {
      try {
        await this.callApplier(r, actions);
      } catch (err) {
        if (!(err instanceof OutcomeUnknown)) throw err;
        for (const step of r.sent) run.lost.add(step);
      }
    }
    if (this.halted) return;
    this.saveRun(run);
    while (run.status === "running" && !this.halted && !r.outcomes.every((o) => outcomeRank(o.outcome) >= 2 || run.lost.has(o.step_id))) {
      await new Promise<void>((resolve) => { run.settle = () => { run.settle = undefined; resolve(); }; });
    }
  }

  /** Ends a run whose steps were all reached once every step it dispatched has ended (steward, *Operations*). */
  private maybeEndRun(run: Run): void {
    if (run.status === "running" && run.programDone && settled(run)) this.endRun(run, "done");
  }

  /**
   * A step: a run ends (`done`, `timeout`, `stopped`): nothing more of it is sent, what it waits on is
   * let go, `failed_steps` taken as of now, its own leases released (GA-SCN-2), each end re-evaluating
   * the rules naming the device (GA-LEASE-4), and a `scenario` event.
   */
  private endRun(run: Run, reason: RunEnd): void {
    if (run.status !== "running") return;
    run.status = "ended";
    run.reason = reason;
    run.endedMs = Math.floor(this.o.clock.now());
    run.ended = tally(run, this.mutation);
    if (run.bound !== undefined) this.o.clock.clear(run.bound);
    if (this.runningOf.get(run.scenario) === run) this.runningOf.delete(run.scenario);
    for (const target of run.leased) this.leases.end(target, (l) => typeof l.holder === "object" && (l.holder as Args).run === run.run_id);
    this.log.append("scenario", { run_id: run.run_id, scenario: run.scenario, change: "ended", reason, cause: run.cause });
    if ((run.schedule !== undefined || run.rule !== undefined) && reason !== "interrupted") this.noticeAuthoredRun(run);
    this.saveRun(run);
    run.wake?.();
    run.settle?.();
  }

  /**
   * A scheduled or rule-started run's failure notice (G3, ratified 2026-10-05; a rule-started run's
   * ruled by the maintainer 2026-10-05, Q2; proposed for the next steward revision, as a rule's own action's GA-RULE-8
   * notice): at its end, one notice naming every step of `failed_steps` that a rule's action would be
   * told of (`afterOutcome`; `refused(leased)`, a person's hand on the device, `skipped(toggle_only)`
   * and the skips that are no failure not, though each stays in `failed_steps`: Q3), through the
   * notice pump with its caps, coalesced per schedule or rule while one waits for delivery. No wait
   * for a late ack: a run's `failed_steps` are final at its end.
   */
  private noticeAuthoredRun(run: Run): void {
    const targets = new Map(outcomesOf(run).map((o) => [o.step_id, o.target]));
    const failed = (run.ended?.failed_steps ?? []).filter((f) => {
      const k = afterOutcome({ outcome: f.outcome, reason: f.reason, idempotent: false, unanswered: 1 }, this.mutation).kind;
      return k !== "none" && k !== "landed";
    }).map((f) => ({ step_id: f.step_id, target: targets.get(f.step_id) ?? null, outcome: f.outcome, ...(f.reason !== undefined ? { reason: f.reason } : {}) }));
    if (!failed.length) return;
    const said = failed.map((f) => `${f.step_id} on ${f.target} ${f.outcome}${f.reason ? `(${f.reason})` : ""}`).join(", ");
    const steps = failed.length === 1 ? "a step" : `${failed.length} steps`;
    if (run.schedule !== undefined) {
      const schedule = run.schedule;
      this.notices.own(`steward:schedule:${schedule}:${run.run_id}`, "schedule_failed", `schedule ${schedule} ran scenario ${run.scenario}, and ${steps} did not land: ${said}`,
        { schedule, scenario: run.scenario, run_id: run.run_id, failed }, `schedule_failed:${schedule}`);
      return;
    }
    const rule = run.rule!;
    this.notices.own(`steward:rule-run:${rule}:${run.run_id}`, "rule_run_failed", `rule ${rule} started scenario ${run.scenario}, and ${steps} did not land: ${said}`,
      { rule, scenario: run.scenario, run_id: run.run_id, failed }, `rule_run_failed:${rule}`);
  }


  /**
   * `scenario_plan` (steward, *Scenario runs*; GA-SCN-6): one step per action step of the scenario, in
   * order, those its `run` steps reach included, each device it reaches its own step, planned on the
   * applier and judged in the steward's order as the principal of the endpoint and speaker named, as
   * `plan` judges a request; an action inside an `if` planned as if its branch were taken and marked
   * `conditional`. Held as a plan is, its asks put as its `ask` event, committed before it is returned.
   */
  private async scenarioPlan(a: Args, caller: Extract<Caller, { kind: "credential" }>): Promise<StewardPlan> {
    const p = principalOf(this.house, caller.credential, a.endpoint, a.speaker, this.mutation);
    if (!this.house.scenarios.has(a.scenario)) throw new RequestError("invalid_request", `no scenario ${a.scenario}`);
    const revision = this.rev;
    const program = compile(this.house, a.scenario);
    const view = { devices: this.mirror.devices, house: this.house, mutation: this.mutation };
    const resolved = program.actions.flatMap((n) => {
      const rs = resolveRequest([n.action], view);
      return rs.map((r, k) => {
        let args = r.args;
        let replaced = false;
        if (r.action === "notify.notify") {
          const { from, ...rest } = r.args as Args;
          if (from === undefined || this.mutation !== "trusts-the-callers-from") args = this.fromOf(rest, { endpoint: p.endpoint, role: p.role });
          replaced = from !== undefined && this.mutation !== "trusts-the-callers-from";
        }
        return { n, id: stepIdOf(n.index, k + 1, rs.length), r: { ...r, args, conflict: false, ...(n.brain ? { brain: true as const } : {}) }, replaced };
      });
    });
    const cause = { ...(p.person ? { person: p.person } : {}), endpoint: p.endpoint };
    const theirs = resolved.length
      ? await this.applierPlanOf({ actions: resolved.map(({ r }) => ({ target: r.target, action: r.action, args: r.args, via: p.via, brain: p.brain || r.brain === true,
        for: cause })) })
      : [];
    const steps = resolved.map(({ n, id, r, replaced }) => {
      const theirStep = theirs?.find((x) => x.target === r.target && x.action === r.action && canonical(x.args ?? {}) === canonical(r.args));
      const step = judge(id, r, theirStep, { principal: p, precedence: "person", leaseOf: (t) => this.leases.holding(t), mutation: this.mutation,
        ...(n.respect ? { occupancyOf: (t: string) => this.occupancyAt(t) } : {}),
        tierOf: (t, act) => this.mirror.tierOf(t, act), described: (t, act) => this.mirror.described(t, act) });
      if (!replaced && !n.conditional) return step;
      const marked = { ...step, ...(replaced ? { from_replaced: true as const } : {}), ...(n.conditional ? { conditional: true as const } : {}) };
      // A step the steward could not plan on the applier stays one when marked, so it fails closed at dispatch (the milestone review, B4).
      if (unplanned.has(step)) unplanned.add(marked);
      return marked;
    });
    const request = { endpoint: p.endpoint, ...(p.speaker !== undefined ? { speaker: p.speaker } : {}), scenario: a.scenario };
    return this.keepPlan(caller.credential.id, p, revision, request, steps);
  }

  /**
   * Holds a plan made now of `steps` (steward, *Planning changes nothing*), as `plan` does: one with an
   * ask is committed first, refused while the store is known down and dropped when its commit outlasts
   * 10 s, and its question put as its `ask` event.
   */
  private async keepPlan(credential: string, p: Principal, revision: number, request: Record<string, unknown>,
    steps: (StewardStep | DefineStep)[]): Promise<StewardPlan> {
    const asked = steps.filter((x) => x.verdict === "ask").map((x) => x.step_id);
    const now = Math.floor(this.o.clock.now());
    const expiresMs = now + (asked.length ? this.house.home.ask_expiry_s * 1000 : PLAN_EXPIRY_MS);
    const plan: StewardPlan = { plan_id: randomUUID(), expires_at: new Date(expiresMs).toISOString(), revision, endpoint: p.endpoint,
      ...(p.speaker !== undefined ? { speaker: p.speaker } : {}), client: credential, request, steps };
    const held: HeldPlan = { plan, credential, principal: p, madeMs: now, expiresMs, forgetMs: expiresMs + (expiresMs - now), asked,
      askedMs: Object.fromEntries(asked.map((id) => [id, now])), askedAt: this.askedAt(p), answers: {}, applied: false };
    if (asked.length) {
      if (this.o.store.down) throw new StoreUnavailable("the store is unreachable: a plan with an ask is refused until it returns", false);
      const kept = this.o.store.write((tx) => tx.query("INSERT INTO plans (plan_id, credential, made_ms, expires_ms, forget_ms, asked, doc, asked_at) "
        + "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (plan_id) DO NOTHING",
      [plan.plan_id, held.credential, held.madeMs, held.expiresMs, held.forgetMs, JSON.stringify(held.askedMs), JSON.stringify(plan), held.askedAt])
        .then(() => undefined));
      try {
        await within(this.o.clock, GATE_MS, kept, PLAN_DROPPED, false);
      } catch (err) {
        void kept.then(() => this.o.store.write((tx) => dropPlans(tx, [plan.plan_id])), () => undefined);
        throw err;
      }
    }
    this.hold(held);
    return plan;
  }

  private schedulePrune(): void {
    this.pruneTimer = this.o.clock.setTimeout(() => {
      this.log.prune();
      this.forgetPlans();
      this.forgetApplies();
      this.forgetRuns();
      const gone = this.forgetHeard();
      const now = Math.floor(this.o.clock.now());
      if (!this.o.store.down) {
        void this.o.store.write(async (tx) => {
          await tx.query("DELETE FROM plans WHERE forget_ms <= $1", [now]);
          await tx.query("DELETE FROM applies WHERE at_ms <= $1", [now - KEY_RETENTION_MS]);
          await tx.query("DELETE FROM runs WHERE COALESCE((doc->>'ended_ms')::bigint, at_ms) <= $1 AND doc->>'status' = 'ended'", [now - KEY_RETENTION_MS]);
          await tx.query("DELETE FROM run_keys WHERE at_ms <= $1", [now - KEY_RETENTION_MS]);
          // A record forgotten in a life that stopped before this write is forgotten again at the next start.
          if (gone.length) await tx.query("DELETE FROM utterances WHERE utterance_id = ANY($1)", [gone]);
        }, { droppable: true });
      }
      this.schedulePrune();
    }, this.o.pruneEveryMs ?? PRUNE_EVERY_MS);
  }
}

/** A run's step sent: judged again, its lease and room as they are then, once its record has committed (I2). */
interface RunCheck { step_id: string; target: string; action: string; decide: () => { d: ReturnType<typeof atDispatch>; holder?: unknown } }

/** A plan's request as the steward read it, its fields only: what a later apply re-resolves (steward, *Plans*). */
function requestOf(a: Args): Record<string, unknown> {
  return { endpoint: a.endpoint, ...(a.speaker !== undefined ? { speaker: a.speaker } : {}),
    actions: (a.actions as Args[]).map((x) => ({ ...(x.target !== undefined ? { target: x.target } : {}),
      ...(x.selector !== undefined ? { selector: x.selector } : {}), action: x.action, ...(x.args !== undefined ? { args: x.args } : {}) })),
    ...(a.respect_occupancy !== undefined ? { respect_occupancy: a.respect_occupancy } : {}) };
}

/** Takes plans out of the store: safe to run twice. */
function dropPlans(tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, ids: string[]): Promise<void> {
  return tx.query("DELETE FROM plans WHERE plan_id = ANY($1)", [ids]).then(() => undefined);
}

/** In code-point order of their ids, as every list the steward gives. */
const byId = <T extends { id: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** An endpoint as `describe` shows it: its cap as it applies, and `confirm_on` `same` when it names none. */
function endpointView(e: Endpoint): Record<string, unknown> {
  return { id: e.id, name: e.name, type: e.type, room: e.room, person: e.person, max_role: maxRoleOf(e), served_by: e.served_by,
    confirm_on: e.confirm_on ?? "same", voice: e.voice };
}
