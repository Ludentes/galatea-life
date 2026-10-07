import { validate } from "@ludentes/galatea-life-schemas";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import { reduceAdmins, sameAdmins, sameSet, UNKNOWN, withAccounts, withUnknown } from "./admins.js";
import { Helpers } from "./helpers.js";
import { HostState } from "./host.js";
import { notifyError, shownText, type NotifyValue } from "./notify-text.js";
import {
  accountFaults, pluginAdmins, pluginDevices, pluginEntry, pluginRoster, pluginStatus, sessionAccounts, type PluginDevice,
} from "./plugins/devices.js";
import { READ_BACK_LEAD_MS, toolArguments, toOutcome } from "./plugins/command.js";
import { PluginHost, type Answer } from "./plugins/host.js";
import { capText } from "./plugins/state.js";
import type { Identity, Observation, OsAccount, OsPort, OsSession, PowerEvent, Urgency } from "./port.js";
import { sessionKeys } from "./sessions.js";
import type { OtherAdmin, StateStore } from "./state-store.js";
import { SuspendClock } from "./suspend-clock.js";
import { accountsOf, emptyTokens, interactive, retire, see, tokenOf, type TokenTable } from "./tokens.js";
import { Refused, type Delivery, type Wire } from "./wire.js";

export const VERSION = "0.1.0";
/** The PC's one transport, its host, of kind `other` (*Transports*). */
export const HOST = "host";
/** The computer's device id. */
export const COMPUTER = "computer";

/** `status` at least every 10 s (GA-BRIDGE-17). */
export const STATUS_MS = 10_000;
/** The observer is read, and a due observation made, every second, so a lost observer shows within 1 s. */
export const CHECK_MS = 1_000;
/** A request repeated by `requestId` within 10 s gets the first reply (GA-BRIDGE-4). */
export const DUPLICATE_REQUEST_MS = 10_000;
/** A `commandId` is remembered for at least its `resultWithinMs`, and never less than this. */
export const COMMAND_MEMORY_MS = 60_000;
/** The computer's roster entry: polled every 10 s, its bound three times that (GA-BRIDGE-13, GA-BRIDGE-37). */
export const COMPUTER_CADENCE_MS = 10_000;
export const COMPUTER_MAX_AGE_MS = 30_000;
/** At resume, the OS gets at most 10 s to step its clock before the first `status` (GA-BRIDGE-59). */
export const CLOCK_STEP_MS = 10_000;
/**
 * A helper's refusal changes the computer's status at most this often (review M2): any account may
 * connect to the endpoint, and each new connection is a new refusal. One coming sooner is named when
 * the bound has passed, the latest of them.
 */
export const HELPER_REFUSED_EVERY_MS = 10_000;
/** A failed reconnection is tried again after 1 s, then 2, 4 … never more than this apart. */
export const REOPEN_CEILING_MS = 60_000;
/**
 * A leave, or a stop's wait for a reconnection, not done within this cuts the connection: the broker
 * may be away, and logind holds a suspend 5 s at most by default (InhibitDelayMaxSec), so the cut
 * comes before the suspend does. Kept on the bridge's clock, as every other time of it: under the
 * harness's time source, a step of that clock moves the bound with it.
 */
export const LEAVE_MS = 4_000;
/** The check-in is saved at most this often while running, and at every leave and stop (GA-BRIDGE-31). */
export const SAVE_MS = 60_000;
/** The administrators are re-read at least this often, a change the OS did not report included (GA-BRIDGE-53; ⚠️ a guess). */
export const ADMINS_REREAD_MS = 86_400_000;
/** A token table that could not be written is written again after 1 s, then 2, 4 … never more than 60 s apart. */
export const TOKENS_RETRY_MS = 1_000;
export const TOKENS_RETRY_CEILING_MS = 60_000;
/** A lock not reported within this of its receipt is `failed(not_locked)` (GA-BRIDGE-66; ⚠️ a guess). */
export const LOCK_MS = 5_000;
/** A helper that has not shown a notification within this counts as failing to (GA-BRIDGE-62; ⚠️ a guess). */
export const NOTIFY_MS = 2_000;
/**
 * The ack of a command whose handling threw unexpectedly. The standard names no reason for the
 * bridge's own failure; the throw may come after something was transmitted (a plugin's tool
 * called), and once anything was the standard allows only `no_confirmation`, which the applier
 * takes as no ack, since the device may have acted. So that one, whatever threw.
 */
export const UNEXPECTED_ACK_REASON = "no_confirmation";
/** The reply's reason for a request whose handling threw unexpectedly: one of the standard's "another reason". */
export const UNEXPECTED_REPLY_REASON = "bridge_error";

type Action = { action: string; idempotent: boolean; stateless: boolean; confirms: boolean; args?: Record<string, unknown> };

/** The computer's `power` actions (`standard/applier.md`, the capability table); a PC's bridge offers no `wake`. */
const POWER: Action[] = [
  { action: "power.sleep", idempotent: true, stateless: true, confirms: true },
  { action: "power.shutdown", idempotent: false, stateless: true, confirms: true, args: { delay_s: { min: 0, optional: true } } },
  { action: "power.cancel", idempotent: true, stateless: true, confirms: true },
];
/** `notify`, listing `from` among its args, as a computer's must (GA-BRIDGE-62). */
const NOTIFY: Action = {
  action: "notify.notify", idempotent: false, stateless: true, confirms: true,
  args: { text: "any", urgency: ["info", "warning", "critical"], from: "any" },
};

/** The computer's actions: `session.lock`'s `account` the tokens `accounts` lists, changing with it (GA-BRIDGE-66). */
function actions(tokens: string[]): Action[] {
  return [...POWER, { action: "session.lock", idempotent: true, stateless: false, confirms: true, args: { account: tokens } }, NOTIFY];
}

export interface PcBridgeOptions {
  bridgeId: string;
  instanceId: string;
  root: string;
  clock: Clock;
  port: OsPort;
  wire: Wire;
  store: StateStore;
  /** Only under a run (GA-BRIDGE-16). */
  runId?: string;
  /** The broker's host as the bridge reaches it: on this machine, the computer proposes itself as infrastructure (GA-BRIDGE-65). */
  brokerHost?: string;
}

type Ack = { commandId: string; source: string; result: string; reason?: string; detail?: string; timestamp: string };
type Reply = { requestId: string; op: string; status: string; data?: unknown; reason?: string };
type Fault = { code: string; topic?: string; device?: string; detail?: string };
/** Running; offline after a suspend or shutdown the OS announced; frozen by one it did not; stopped. */
type Life = "running" | "offline" | "frozen" | "stopped";
/**
 * A `session.lock` waiting for an observation begun after the ask (numbered above `after`): with
 * `fresh`, any such observation, for a lock whose last observation showed the account no session;
 * else one that reports every graphical session of the account locked.
 */
type LockWait = { osId: number; after: number; fresh: boolean; settle: (outcome: LockOutcome) => void };
/** Observed afresh (a `fresh` wait); locked (or the account logged out); only an SSH login left; the bridge leaving; not reported in time. */
type LockOutcome = "seen" | "locked" | "ungraphical" | "leaving" | "late";
/** A helper handed a notification that gave no answer: it may still show it. */
class Unanswered extends Error {}

const wireTime = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A PC's bridge at level Serve: the computer, its host transport, its power, and its people. */
export class PcBridge {
  private readonly base: string;
  private readonly host: HostState;
  private readonly faults: Fault[] = [];
  private readonly commands = new Map<string, { ack?: Ack; keepUntil: number }>();
  private readonly requests = new Map<string, { reply?: Reply; keepUntil: number }>();
  private readonly timers = new Set<number>();
  /** The command and request handlers running: what a leave waits for, and nothing else. */
  private readonly deliveries = new Set<Promise<unknown>>();
  private leaving?: Promise<void>;
  /** Ends the reconnection's wait between tries, when the bridge stops meanwhile. */
  private wake?: () => void;
  /** The reconnection under way, if any: there is one at a time. */
  private reconnecting?: Promise<void>;
  /**
   * The reconnection's connection settled: running, or ended by a stop, or the reconnection failed.
   * What a stop waits for; never the rest of the reconnection, whose observation may outlast the OS's hold.
   */
  private wireSettled?: Promise<void>;
  /** A resume asked the reconnection under way to try again at once. */
  private retryNow = false;
  private identity!: Identity;
  private lastCheckIn: number | null;
  /** The check-in last written to the store, and whether a newer one waits to be. */
  private savedAt: number | null = null;
  private unsaved = false;
  private observable: { value: boolean; since: number };
  private checking?: Promise<void>;
  private checkAgain = false;
  private resuming?: Promise<void>;
  private stalledUntil = 0;
  private life: Life = "running";
  /** The token table, kept in the state file (GA-BRIDGE-52). */
  private readonly tokens: TokenTable;
  /** Each change of the table is counted; `tokensOnDisk` is the last change a save wrote. */
  private tokensChanged = 0;
  private tokensOnDisk = 0;
  /** The last save of the table asked, settled once it has been written or has failed. */
  private tokensWrite: Promise<void> = Promise.resolve();
  /** A save that failed is tried again after the backoff: the next wait, and its timer while one is set. */
  private tokensRetryMs = TOKENS_RETRY_MS;
  private tokensTimer: number | null = null;
  /** When a helper's refusal last changed the status, the latest refusal waiting for the bound, and its timer (review M2). */
  private refusedAt: number | null = null;
  private refusedNext: string | null = null;
  private refusedTimer: number | null = null;
  /** A `devices` or status held back while the table was not on disk, to go out once it is. */
  private heldBack = false;
  /** What the last successful observation read, and when; nothing before the first. */
  private sessions: OsSession[] = [];
  private sessionsAt: number | null = null;
  /** Observations are numbered as they begin; `sessionsSeq` is the number of the one `sessions` holds. */
  private observeStarts = 0;
  private sessionsSeq = 0;
  private readonly helpers: Helpers;
  private personalKeys: string[] = [];
  /** The computer's `otherAdmins` as last declared, kept across a restart (GA-BRIDGE-31); null before the first read. */
  private otherAdmins: OtherAdmin[] | null;
  /** The set this instance last read, null before its first read: a read that changes it is a change, declared or not yet. */
  private adminsRead: OtherAdmin[] | null = null;
  private adminsChain: Promise<void> = Promise.resolve();
  private infrastructure = false;
  /** Events' `seq`, from 1 in each instance (GA-BRIDGE-33). */
  private seq = 0;
  /** What `devices`, the computer's status and the bridge's roster and faults last carried, so that a change goes out and nothing else does. */
  private devicesShown?: string;
  private computerShown?: string;
  private rosterShown?: string;
  /**
   * Opened when the start has published its first `devices`, statuses and event: what a re-read of the
   * administrators or a refused helper would publish waits for it, so nothing goes out before them.
   */
  private readonly startGate: Promise<void>;
  private openGate!: () => void;
  /** Each device whose `otherAdmins` changed: its event waits for the `devices` that carries it to have gone out (GA-BRIDGE-53). */
  private readonly adminsDue = new Set<string>();
  /** The due events going out, one pass at a time, so that none goes out twice. */
  private dueChain: Promise<void> = Promise.resolve();
  /** The plugin host: its packages (plan 3c) and its servers (plan 3d). */
  private readonly plugins: PluginHost;
  /** The servers' clock: the bridge's, less the time the OS slept (GA-BRIDGE-58). */
  private readonly serverClock: SuspendClock;
  /**
   * The plugin devices whose retained status this instance published, each with what it published:
   * one that leaves has it cleared (GA-BRIDGE-21), and a re-publish carries the same payload.
   */
  private readonly pluginStatusShown = new Map<string, { key: string; payload: Record<string, unknown> }>();
  /** The plugin statuses' publication under way, which the next waits for. */
  private statusesRun: Promise<void> = Promise.resolve();
  /** The accounts the last successful observation listed, each with its `PATH`, for a plugin's interpreter (GA-BRIDGE-68). */
  private listed: OsAccount[] = [];
  /** Set when the start reaches its first `devices`: a change before that is the start's to publish. */
  private publishing = false;
  private readonly locks = new Set<LockWait>();
  /** Each notification waiting on a helper's answer, ended at once when the bridge leaves. */
  private readonly notifying = new Set<() => void>();
  /** Each ack waiting for the computer's status held back by the token table to go out: true once it has, false at a leave. */
  private readonly keyWaits = new Set<(out: boolean) => void>();

  constructor(private readonly o: PcBridgeOptions) {
    const now = o.clock.now();
    this.base = `${o.root}/bridges/${o.bridgeId}`;
    this.host = new HostState(now);
    const kept = o.store.state.lastCheckIn[COMPUTER];
    // Kept across a restart (GA-BRIDGE-31, GA-BRIDGE-37); the transport's own exchange is this instance's.
    this.lastCheckIn = kept !== undefined ? Date.parse(kept) : null;
    this.observable = { value: false, since: now };
    // A state file from plan 3a's bridge has neither: an empty table, and no administrators read yet.
    this.tokens = o.store.state.tokens ??= emptyTokens();
    this.otherAdmins = o.store.state.otherAdmins?.[COMPUTER] ?? null;
    this.startGate = new Promise<void>((r) => { this.openGate = r; });
    this.helpers = new Helpers({
      port: o.port,
      clock: o.clock,
      refused: (detail) => this.nameRefusal(detail),
      changed: () => this.track(this.publishChanges()),
      running: () => this.life === "running",
    });
    this.serverClock = new SuspendClock(o.clock);
    this.plugins = new PluginHost({
      port: o.port,
      clock: o.clock,
      serverClock: this.serverClock,
      sessions: () => this.sessions,
      store: o.store,
      // The harness serves packages over plain HTTP; outside a run, `https:` only.
      allowHttp: o.runId !== undefined,
      account: (token) => {
        const a = interactive(this.tokens).find((x) => x.token === token);
        return a && this.listed.find((l) => l.osId === a.osId);
      },
      retired: (token) => this.retired(token),
      changed: () => this.track(this.publishChanges()),
    });
  }

  /** A token given once and held by no account now: its account was deleted (GA-BRIDGE-52, GA-BRIDGE-67). */
  private retired(token: string): boolean {
    return this.tokens.given.includes(token) && !Object.values(this.tokens.accounts).some((e) => e.token === token);
  }

  private get filters(): string[] {
    return [`${this.base}/devices/+/command`, `${this.base}/request/+`];
  }

  /**
   * Subscribes before the first `status` (GA-BRIDGE-18), clears `lwt`, observes the host, reads the
   * administrators, then `devices` and the statuses.
   */
  async start(): Promise<void> {
    this.identity = await this.o.port.identity();
    this.personalKeys = this.o.port.personalKeys();
    // A broker on this machine goes down with it (GA-BRIDGE-65); a name that cannot be resolved proposes nothing.
    if (this.o.brokerHost !== undefined) {
      this.infrastructure = await this.o.port.isOwnAddress(this.o.brokerHost).catch((err) => {
        console.error(`broker host: ${err}`);
        return false;
      });
    }
    this.o.wire.onMessage((d) => this.trackDelivery(this.onDelivery(d, this.o.clock.now())));
    this.o.wire.onReconnect(() => this.track(this.reconnected()));
    // A change the OS reports (the observer, a session, an account) is observed at once.
    this.o.port.onChange(() => {
      this.host.observeAtOnce(this.o.clock.now());
      this.track(this.tick());
    });
    this.o.port.onAdminsChange(() => this.track(this.rereadAdmins()));
    this.o.port.onHelper((m) => this.helpers.onMessage(m));
    // The OS's hold ends however the bridge's part ends (the port's contract).
    this.o.port.onPower((e) => this.onPower(e).catch((err) => console.error(`power: ${err}`)));
    await this.subscribe();
    await this.publish(`${this.base}/lwt`, "", true);
    await this.readHost();
    // After the observation, whose interactive accounts are seen before the administrators name them.
    await this.readAdmins();
    // After the accounts, which a resumed install checks: each request a restart cut short is ended
    // or resumed, and an uninstall finished, before the first `devices` (GA-BRIDGE-68).
    // A plugins directory it cannot make is the fault `plugins_unready` (pluginFaults), never an exit.
    await this.plugins.start();
    // The declarations before the first status, so no reader sees a device it has no declaration for;
    // nothing of the computer goes out before them, whatever a helper did meanwhile. A set of
    // `otherAdmins` that changed while the bridge was not running is a change all the same.
    this.publishing = true;
    await this.publishDevices();
    await this.publishComputerStatus();
    await this.publishPluginStatuses(true);
    await this.publishStatus();
    await this.publishDue();
    this.openGate();
    this.startTimers();
    // The servers once `devices` is out: no status of a plugin device goes before its declaration.
    this.plugins.reconcile();
  }

  /** A restart: GA-BRIDGE-22's order when running; after a suspend or shutdown the connection is already gone. */
  async stop(): Promise<void> {
    if (this.life === "stopped") return;
    const was = this.life;
    this.life = "stopped";
    if (was === "running") this.leaving = this.leave();
    // A leave already begun (an announced suspend) is waited for; a reconnection's wait is cut short,
    // and the reconnection is waited for until running (the leave above ends it) or until it has ended
    // its connection, so that no connection is open when this resolves.
    this.clearTimers();
    if (this.tokensTimer !== null) this.o.clock.clear(this.tokensTimer);
    this.tokensTimer = null;
    if (this.refusedTimer !== null) this.o.clock.clear(this.refusedTimer);
    this.refusedTimer = null;
    this.wake?.();
    const settled = this.wireSettled;
    if (settled) {
      // A connection attempt the broker does not answer would hold the stop for its whole timeout.
      await this.o.wire.abort().catch((err) => console.error(`abort: ${err}`));
      if (!(await this.within(settled, LEAVE_MS))) {
        console.error(`stop: the reconnection did not settle within ${LEAVE_MS} ms; the connection is cut`);
        await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
      }
    }
    await this.leaving?.catch(() => {});
    // An install under way is cut and stays in flight, for the next start to end (GA-BRIDGE-68).
    await this.plugins.close();
    this.saveCheckIn();
    await this.o.store.flush();
    // Every helper it started goes with it; a suspend leaves them, as the sessions stay.
    await this.helpers.stopAll();
    await this.o.port.close();
  }

  /** The harness's `stall`: the main loop waits, as a hung loop would (real time). */
  stall(ms: number): void {
    this.stalledUntil = Date.now() + ms;
  }

  /**
   * GA-BRIDGE-22: unsubscribe and wait, finish the commands and requests in flight (a `sleep`'s or
   * `shutdown`'s terminal ack among them; never an observation, which may outlast the OS's hold),
   * a graceful `offline`, `lwt` cleared, a clean disconnect.
   */
  private async leave(): Promise<void> {
    this.clearTimers();
    this.saveCheckIn();
    const cut = { value: false };
    // The check-in on disk before the OS goes on to a shutdown, within the same bound.
    const flushed = this.o.store.flush();
    if (await this.within(Promise.all([flushed, this.leaveInOrder(cut)]), LEAVE_MS)) return;
    // Cut: what the leave has not done is left undone, so its rest can never end a connection a resume makes.
    cut.value = true;
    console.error(`leave: not done within ${LEAVE_MS} ms; the connection is cut`);
    // Nothing is left waiting behind a cut: its handler ends, whether or not its ack still gets out.
    this.endWaits();
    await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
  }

  /** What waits on the OS or a helper is answered now: a leave cannot wait a lock's 5 s or a helper's 2 s. */
  private endWaits(): void {
    for (const w of this.locks) w.settle("leaving");
    for (const end of this.notifying) end();
    for (const wake of this.keyWaits) wake(false);
  }

  /** The leave's steps; with the broker away, only the waits that need no broker (its will has fired already). */
  private async leaveInOrder(cut: { value: boolean }): Promise<void> {
    if (this.o.wire.connected()) {
      await this.o.wire.unsubscribe(this.filters).catch((err) => console.error(`unsubscribe: ${err}`));
    }
    // After the UNSUBACK, as a command in flight is finished (GA-BRIDGE-22).
    this.endWaits();
    await Promise.allSettled([...this.deliveries]);
    if (cut.value) return;
    if (!this.o.wire.connected()) {
      await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
      return;
    }
    await this.publishStatus({ state: "offline", graceful: true }, cut);
    if (cut.value) return;
    await this.publish(`${this.base}/lwt`, "", true);
    if (cut.value) return;
    await this.o.wire.end().catch((err) => console.error(`disconnect: ${err}`));
  }

  /** Whether `p` settles within `ms` of the clock. */
  private async within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let handle = 0;
    const late = new Promise<boolean>((r) => { handle = this.o.clock.setTimeout(() => r(false), ms); });
    const inTime = await Promise.race([p.then(() => true, () => true), late]);
    this.o.clock.clear(handle);
    return inTime;
  }

  // --- Power ------------------------------------------------------------------------------------

  /**
   * A suspend or shutdown the OS announces: offline gracefully, in GA-BRIDGE-22's order, before the
   * OS may go on. One it does not announce leaves no time: the process freezes, and the will fires.
   */
  private async onPower(e: PowerEvent): Promise<void> {
    if (e.kind === "resume") return this.resume(e.asleepMs);
    // The servers sleep with the OS: none is found hung for the time it slept (GA-BRIDGE-58).
    this.serverClock.freeze();
    if (this.life !== "running") return;
    if (e.announced) {
      this.life = "offline";
      this.leaving = this.leave();
      return this.leaving;
    }
    this.life = "frozen";
    this.clearTimers();
    await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
    // A lock or a notification waiting is answered `no_confirmation` now, its timer gone with the
    // rest: the ack is kept by commandId, so a redelivery after the resume gets it (GA-BRIDGE-4).
    this.endWaits();
  }

  /** The OS steps its clock before the first `status` (GA-BRIDGE-59), then the bridge comes back as at a start. */
  private async resume(asleepMs: number): Promise<void> {
    if (this.stopped) return;
    console.error(`resumed after ${asleepMs} ms asleep`);
    // Every step under way is waited for, whichever settles first: one resume's step never lets a
    // status out before another's.
    const stepping = Promise.all([this.resuming, this.stepClock()]).then(() => {});
    this.resuming = stepping;
    await stepping;
    if (this.resuming === stepping) this.resuming = undefined;
    // After the clock's step, so the servers' clock counts no step as time asleep.
    this.serverClock.thaw(asleepMs);
    if (this.stopped) return;
    // The leave before this resume ends first, or it would end the connection made below.
    await this.leaving?.catch(() => {});
    this.leaving = undefined;
    if (this.stopped) return;
    // The check-in from before the sleep says nothing about now, whether this resume joins a reconnection or not.
    this.host.observeAtOnce(this.o.clock.now());
    // One reconnection at a time: a resume that finds one under way has it try again at once, and leaves the rest to it.
    if (this.reconnecting) {
      this.retryNow = true;
      this.wake?.();
      return;
    }
    if (this.life === "running") {
      // A suspend the OS did not announce, with the connection kept: nothing to reopen.
      await this.readHost();
      if (this.stopped) return;
      await this.publishStatus();
      // Each serving server's devices read within 10 s of the first status after the resume (GA-BRIDGE-60).
      this.plugins.afterResume();
      return;
    }
    this.retryNow = false;
    let settle!: () => void;
    this.wireSettled = new Promise<void>((r) => { settle = r; });
    const reconnection = this.reconnect(settle);
    this.reconnecting = reconnection;
    try {
      await reconnection;
    } finally {
      // A stopped return has ended the wire already; a failure leaves none open either.
      settle();
      this.reconnecting = undefined;
      this.wireSettled = undefined;
    }
    // The reconnection reached running: its first status is out.
    if ((this.life as string) === "running") this.plugins.afterResume();
  }

  /**
   * The whole reconnection, from the first reopen to running (or to a stop that ends the wire): one at a time.
   * `settled` marks running: from there a stop's own leave ends the connection.
   */
  private async reconnect(settled: () => void): Promise<void> {
    // Not running until resubscribed: a delivery before that takes the not-running path.
    if (!(await this.reopen())) return;
    this.life = "running";
    settled();
    await this.readHost();
    if (this.stopped) return;
    // As at a start: the administrators are read again, and the 24 h count starts over.
    await this.readAdmins();
    if (this.stopped) return;
    await this.publishDevices();
    if (this.stopped) return;
    await this.publishComputerStatus();
    if (this.stopped) return;
    await this.publishPluginStatuses(true);
    if (this.stopped) return;
    await this.publishStatus();
    if (this.stopped) return;
    await this.publishDue();
    if (this.stopped) return;
    this.startTimers();
  }

  private get stopped(): boolean {
    return this.life === "stopped";
  }

  /** After a reconnection, before running: a stop that landed leaves no connection behind (a running bridge's stop ends its own). */
  private async endIfStopped(): Promise<boolean> {
    if (!this.stopped) return false;
    await this.o.wire.end().catch((err) => console.error(`disconnect: ${err}`));
    return true;
  }

  /**
   * Reopens the connection, resubscribes and clears `lwt`, trying again 1 s, 2 s, 4 s … up to
   * REOPEN_CEILING_MS apart; false when stopped meanwhile. A resubscription that fails (the connection
   * closed before its SUBACK) ends the connection and waits for the next try as a failed reopen does:
   * left open, MQTT.js would reconnect it unseen, a bridge not running would renew nothing on it, and
   * a later stop would never end it.
   */
  private async reopen(): Promise<boolean> {
    let wait = 1000;
    for (;;) {
      let opened = false;
      try {
        await this.o.wire.reopen();
        opened = true;
        // Stopped while reconnecting: the new connection is closed, not left open.
        if (await this.endIfStopped()) return false;
        await this.subscribe();
        if (await this.endIfStopped()) return false;
        await this.publish(`${this.base}/lwt`, "", true);
        return !(await this.endIfStopped());
      } catch (err) {
        console.error(`reconnect: ${err}`);
        if (opened) await this.o.wire.end().catch((e) => console.error(`disconnect: ${e}`));
      }
      if (this.stopped) return false;
      // A resume came meanwhile: try again at once, the backoff from 1 s.
      if (this.retryNow) {
        this.retryNow = false;
        wait = 1000;
        continue;
      }
      await new Promise<void>((resolve) => {
        const h = this.o.clock.setTimeout(() => {
          this.timers.delete(h);
          this.wake = undefined;
          resolve();
        }, wait);
        this.timers.add(h);
        this.wake = () => {
          this.o.clock.clear(h);
          this.timers.delete(h);
          this.wake = undefined;
          resolve();
        };
      });
      if (this.stopped) return false;
      if (this.retryNow) {
        this.retryNow = false;
        wait = 1000;
      } else {
        wait = Math.min(wait * 2, REOPEN_CEILING_MS);
      }
    }
  }

  /** At most CLOCK_STEP_MS; a clock the OS could not step is named by the applier's check (GA-BUS-2), not here. */
  private async stepClock(): Promise<void> {
    let handle = 0;
    const bound = new Promise<boolean>((r) => { handle = this.o.clock.setTimeout(() => r(false), CLOCK_STEP_MS); });
    const stepped = await Promise.race([
      this.o.port.stepClock().catch((err) => {
        console.error(`clock step: ${err}`);
        return false;
      }),
      bound,
    ]);
    this.o.clock.clear(handle);
    if (!stepped) console.error("the OS did not step its clock at resume");
  }

  // --- The host ---------------------------------------------------------------------------------

  /** An observer lost shows at once, even while an observation waits on the OS (GA-BRIDGE-17's 1 s); then a check. */
  private async tick(): Promise<void> {
    if (this.life !== "running") return;
    const now = this.o.clock.now();
    // Each install's 600 s, on the wall clock of the subject's time source, which spans a restart;
    // and an end not yet saved, and the plugins directory, tried again.
    this.plugins.expire(now);
    // A deleted account's server stopped, a swap whose save failed made again.
    this.plugins.reconcile();
    if (!this.o.port.observerPresent() && this.host.present) {
      this.host.setPresent(false, now);
      if (this.refresh(now)) await this.publishStatus();
    }
    await this.check();
  }

  private check(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.checkAgain = false;
        const began = this.observeStarts;
        const statusDue = await this.readHost();
        // A key that changed goes out within the second (the check runs every CHECK_MS), `devices` first.
        await this.publishChanges();
        this.settleLocks();
        // A lock asked while an observation was in flight is answered by none begun before it: one
        // begun after it is made now, not at the next due time, which that observation pushed 10 s on.
        // Only after a pass that observed, and with the observer there: a pass that could observe
        // nothing never loops on itself (it would never yield); an observer regained is observed at
        // once anyway, and else the lock's timer answers it.
        const observed = this.observeStarts > began;
        if (observed && this.life === "running" && this.host.present && [...this.locks].some((w) => this.observeStarts <= w.after)) {
          this.host.observeAtOnce(this.o.clock.now());
          this.checkAgain = true;
        }
        if (statusDue) await this.publishStatus();
      } while (this.checkAgain && this.life === "running");
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  /** Reads the observer, observes the host when due, and recomputes; true when the status should go out. */
  private async readHost(): Promise<boolean> {
    const h = this.host;
    h.setPresent(this.o.port.observerPresent(), this.o.clock.now());
    let faultsChanged = false;
    if (h.due(this.o.clock.now())) {
      let observation: Observation | undefined;
      // Numbered as it begins, so that a lock asked meanwhile never takes its answer (GA-BRIDGE-66).
      const seq = ++this.observeStarts;
      try {
        // Every account the bridge holds a token for, so that the OS says which are gone now (GA-BRIDGE-52).
        observation = await this.o.port.observe(Object.keys(this.tokens.accounts).map(Number));
      } catch (err) {
        faultsChanged = this.setFault({ code: "host_unobserved", detail: String((err as Error).message ?? err) });
      }
      const at = this.o.clock.now();
      h.observed(observation !== undefined, at);
      if (observation) {
        faultsChanged = this.clearFault("host_unobserved");
        this.checkedIn(at);
        await this.observed(observation, at, seq);
      }
    }
    return this.refresh(this.o.clock.now()) || faultsChanged;
  }

  /**
   * A successful observation: accounts first seen get their tokens, accounts the OS reports deleted
   * retire theirs, and the sessions read now are the keys' basis, stamped with its time. A failed
   * one changes none of this, so no key is restamped from a read that did not happen; nor does one
   * that began before the observation already taken, and ended after it.
   */
  private async observed(o: Observation, at: number, seq: number): Promise<void> {
    // An observation that outlasted a stop starts nothing after it.
    if (this.stopped || seq < this.sessionsSeq) return;
    const listed = new Set(o.accounts.listed.map((a) => a.osId));
    let changed = false;
    const retired: string[] = [];
    for (const osId of o.accounts.deleted) {
      const token = tokenOf(this.tokens, osId);
      if (listed.has(osId) || !retire(this.tokens, osId)) continue;
      changed = true;
      retired.push(token!);
    }
    for (const a of o.accounts.listed) if (see(this.tokens, a.osId, a.name, true)) changed = true;
    this.listed = o.accounts.listed;
    if (changed) this.saveTokens();
    // A retired token the administrators name is read again at once, not left in `otherAdmins` until the next change or 24 h.
    if (retired.some((t) => this.otherAdmins?.some((a) => a.label === t))) this.track(this.rereadAdmins());
    this.sessions = o.sessions;
    this.sessionsAt = at;
    this.sessionsSeq = seq;
    this.plugins.sessionsChanged();
    // Not waited for: a launcher that hangs must not hold up the observation, nor every one after it.
    if (this.life === "running") this.track(this.helpers.sync(o.sessions));
  }

  /**
   * A token given or retired is on disk before any `devices` or status carries the change: one given
   * and lost in a crash could be given again. A save that fails holds them back, names the fault
   * `state_unsaved`, and is tried again after 1 s, 2 s, 4 s … at most TOKENS_RETRY_CEILING_MS apart.
   */
  private saveTokens(): void {
    this.tokensChanged += 1;
    // A retry that waits writes this change with the rest.
    if (this.tokensTimer === null) this.writeTokens();
  }

  private get tokensUnsaved(): boolean {
    return this.tokensOnDisk < this.tokensChanged;
  }

  private writeTokens(): void {
    const change = this.tokensChanged;
    this.tokensWrite = this.o.store.save().then(() => {
      this.tokensOnDisk = Math.max(this.tokensOnDisk, change);
      if (this.tokensUnsaved) return;
      this.tokensRetryMs = TOKENS_RETRY_MS;
      if (this.tokensTimer !== null) this.o.clock.clear(this.tokensTimer);
      this.tokensTimer = null;
      if (this.clearFault("state_unsaved")) this.track(this.publishStatus());
      // What waited for the disk goes out now.
      if (this.heldBack) {
        this.heldBack = false;
        this.track(this.publishChanges().then(() => this.publishDue()).then(() => {
          for (const wake of this.keyWaits) wake(true);
        }));
      }
    }, (err) => {
      console.error(`state: ${err}`);
      if (this.setFault({ code: "state_unsaved", detail: String((err as Error).message ?? err) })) this.track(this.publishStatus());
      if (this.tokensTimer !== null || this.stopped) return;
      const wait = this.tokensRetryMs;
      this.tokensRetryMs = Math.min(wait * 2, TOKENS_RETRY_CEILING_MS);
      this.tokensTimer = this.o.clock.setTimeout(() => {
        this.tokensTimer = null;
        this.writeTokens();
      }, wait);
    });
  }

  /** Each successful observation is the computer's check-in (GA-BRIDGE-37), kept across a restart (GA-BRIDGE-31). */
  private checkedIn(at: number): void {
    // An observation that outlasted a stop saves nothing after its final flush.
    if (this.stopped) return;
    this.lastCheckIn = at;
    this.unsaved = true;
    // Not every 10 s: a crash loses at most SAVE_MS of it, and a leave or a stop saves the last.
    if (this.savedAt === null || at - this.savedAt >= SAVE_MS || at < this.savedAt) this.saveCheckIn();
  }

  /** Writes the check-in when a newer one waits to be written. */
  private saveCheckIn(): void {
    if (!this.unsaved || this.lastCheckIn === null) return;
    this.unsaved = false;
    this.savedAt = this.lastCheckIn;
    this.o.store.state.lastCheckIn[COMPUTER] = wireTime(this.lastCheckIn);
    this.o.store.save().catch((err) => console.error(`state: ${err}`));
  }

  /** The transport's state and the computer's `observable`, against `now`; true when either changed. */
  private refresh(now: number): boolean {
    let changed = this.host.evaluate(now);
    // A check-in "in the future" proves nothing about now, as for the host.
    const observable = this.lastCheckIn !== null && now >= this.lastCheckIn && now - this.lastCheckIn <= COMPUTER_MAX_AGE_MS;
    if (observable !== this.observable.value) {
      this.observable = { value: observable, since: now };
      changed = true;
    }
    return changed;
  }

  // --- The administrators -----------------------------------------------------------------------

  /**
   * Reads the administrator facts and reduces them (GA-BRIDGE-53). A read that fails keeps the last
   * set and adds `unknown`, never naming fewer than before, and is a fault of the bridge's own code,
   * `admins_unread`, cleared by the next read that succeeds; a first read that fails gives root and
   * `unknown`. Whether a device's set changed is judged when `devices` carries it (noteAdmins).
   */
  private async readAdmins(): Promise<{ faultsChanged: boolean }> {
    let next: OtherAdmin[];
    let faultsChanged: boolean;
    let given = false;
    const token = (osId: number, name: string) => {
      if (see(this.tokens, osId, name, false)) given = true;
      return tokenOf(this.tokens, osId)!;
    };
    try {
      next = reduceAdmins(await this.o.port.admins(), token);
      faultsChanged = this.clearFault("admins_unread");
    } catch (err) {
      next = withUnknown(this.otherAdmins ?? [{ vendor: "os", label: token(0, "root") }]);
      faultsChanged = this.setFault({ code: "admins_unread", device: COMPUTER, detail: String((err as Error).message ?? err) });
    }
    if (given) this.saveTokens();
    // A change this instance read is due its event even while `devices` is held back; one across a restart is noteAdmins'.
    const accounts = sessionAccounts(this.plugins.state, (t) => !this.retired(t));
    const before = this.adminsRead;
    if (before !== null && !sameAdmins(withAccounts(before, accounts), withAccounts(next, accounts))) this.adminsDue.add(COMPUTER);
    this.adminsRead = next;
    this.otherAdmins = next;
    return { faultsChanged };
  }

  /** A re-read on the OS's word or the 24 h timer, one at a time: a change republishes `devices`, then its event. */
  private rereadAdmins(): Promise<void> {
    const next = this.adminsChain.then(async () => {
      // Not before the start's own read and declaration.
      await this.startGate;
      if (this.life !== "running") return;
      const { faultsChanged } = await this.readAdmins();
      if (this.life !== "running") return;
      await this.publishChanges();
      if (faultsChanged) await this.publishStatus();
    });
    this.adminsChain = next.catch(() => {});
    return next;
  }

  // --- The computer's sessions ------------------------------------------------------------------

  /**
   * Settles each lock by the last observation, when it began after the lock was asked (GA-BRIDGE-66),
   * by every session the account has now: locked once each graphical one reads locked or disconnected,
   * one opened after the ask included, so that the key reads `locked` when the ack says so; logged
   * out (`none`) being locked, and an SSH login alone being no graphical session.
   */
  private settleLocks(): void {
    for (const w of this.locks) {
      if (this.sessionsSeq <= w.after) continue;
      if (w.fresh) {
        w.settle("seen");
        continue;
      }
      const left = this.sessions.filter((s) => s.osId === w.osId);
      const graphical = left.filter((s) => s.graphical);
      if (!left.length) w.settle("locked");
      else if (!graphical.length) w.settle("ungraphical");
      else if (graphical.every((s) => s.state === "locked" || s.state === "disconnected")) w.settle("locked");
    }
  }

  /**
   * The computer's status with its keys as they read now, before an ack that rests on them
   * (GA-BRIDGE-34): true once it went out; false when the token table still holds it back at `until`,
   * or at a leave.
   */
  private async keyOut(until: number): Promise<boolean> {
    if (await this.publishComputerStatus()) return true;
    for (;;) {
      const left = until - this.o.clock.now();
      if (this.life !== "running" || left <= 0) return false;
      const released = await new Promise<boolean>((resolve) => {
        let handle = 0;
        const wake = (out: boolean) => {
          this.keyWaits.delete(wake);
          this.o.clock.clear(handle);
          this.timers.delete(handle);
          resolve(out);
        };
        handle = this.o.clock.setTimeout(() => wake(false), left);
        this.timers.add(handle);
        this.keyWaits.add(wake);
      });
      if (!released) return false;
      // The release published the keys as they read now, unless the table is unsaved again meanwhile.
      if (!this.tokensUnsaved && JSON.stringify(this.readings().values) === this.computerShown) return true;
      if (await this.publishComputerStatus()) return true;
    }
  }

  /**
   * `session.lock` (GA-BRIDGE-66). The last observation may be 10 s old: when it showed the account
   * no session, the host is observed afresh first, a person who logged in since being locked as any
   * other; still no session, `applied` with the key reading `none`; no fresh observation within
   * LOCK_MS of the receipt, or a leave before one, is `failed(unreachable)`, the OS asked nothing
   * (*Acks*: nothing was transmitted). Only non-graphical sessions, `failed(no_graphical_session)`,
   * at once from the last observation; else every graphical session is
   * asked to lock, and the lock is `applied` once an observation shows every graphical session of the
   * account locked or disconnected, the status with the fresh key going out first (GA-BRIDGE-34), or
   * `failed(not_locked)` when that is not so within LOCK_MS of the receipt. A lock the OS reported
   * whose key the token table still holds back at LOCK_MS is `failed(no_confirmation)`: the OS did
   * act, so not `not_locked`, and its read-back follows when the key goes out.
   */
  private async lock(id: string, commandId: string, token: string, receivedAt: number): Promise<void> {
    const osId = interactive(this.tokens).find((a) => a.token === token)!.osId;
    const bound = receivedAt + LOCK_MS;
    let mine = this.sessions.filter((s) => s.osId === osId);
    if (!mine.length) {
      // No session 10 s ago says nothing of now: only an observation begun after the receipt does (GA-BRIDGE-66).
      const seen = await this.lockWait(osId, bound, true);
      if (seen === "late") return this.ack(id, commandId, "failed", "unreachable", `the host was not observed within ${LOCK_MS} ms; nothing was asked of the OS`);
      if (seen !== "seen") return this.ack(id, commandId, "failed", "unreachable", "the bridge went offline before the host was observed; nothing was asked of the OS");
      mine = this.sessions.filter((s) => s.osId === osId);
    }
    if (!mine.length) {
      if (await this.keyOut(bound)) return this.ack(id, commandId, "applied");
      return this.ack(id, commandId, "failed", "no_confirmation", "the key could not be published: the token table is not on disk");
    }
    const graphical = mine.filter((s) => s.graphical);
    if (!graphical.length) return this.ack(id, commandId, "failed", "no_graphical_session", `${token} has no graphical session to lock`);
    const asked = graphical.map((s) => s.id);
    try {
      await this.o.port.lock(asked);
    } catch (err) {
      return this.ack(id, commandId, "failed", "os_refused", String((err as Error).message ?? err));
    }
    const outcome = await this.lockWait(osId, bound, false);
    if (outcome === "late") {
      return this.ack(id, commandId, "failed", "not_locked", `not reported locked within ${LOCK_MS} ms`);
    }
    if (outcome === "ungraphical") {
      return this.ack(id, commandId, "failed", "no_graphical_session", `${token}'s graphical sessions closed; it has only non-graphical ones`);
    }
    if (outcome === "leaving") {
      return this.ack(id, commandId, "failed", "no_confirmation", "the bridge went offline before the OS reported the lock");
    }
    if (await this.keyOut(bound)) return this.ack(id, commandId, "applied");
    return this.ack(id, commandId, "failed", "no_confirmation",
      this.life === "running" ? "the OS reported the lock, but its key could not be published: the token table is not on disk"
        : "the bridge went offline before the lock's key was published");
  }

  /**
   * Waits, until `bound`, for an observation begun from here on, the only one that is the OS's word
   * on the lock: any (`fresh`), or one that settles it (settleLocks). The host is observed at once,
   * and again whenever the OS reports a change; with the observer gone, the timer answers.
   */
  private lockWait(osId: number, bound: number, fresh: boolean): Promise<LockOutcome> {
    const after = this.observeStarts;
    return new Promise<LockOutcome>((resolve) => {
      // A leave that began meanwhile has settled the waits already: this one is answered now.
      if (this.life !== "running") return resolve("leaving");
      let handle = 0;
      const w: LockWait = { osId, after, fresh, settle: (o) => {
        this.locks.delete(w);
        this.o.clock.clear(handle);
        this.timers.delete(handle);
        resolve(o);
      } };
      this.locks.add(w);
      // Among the bridge's timers, so that a suspend the OS did not announce clears it with the rest.
      handle = this.o.clock.setTimeout(() => w.settle("late"), Math.max(0, bound - this.o.clock.now()));
      this.timers.add(handle);
      this.host.observeAtOnce(this.o.clock.now());
      this.track(this.check());
    });
  }

  /**
   * `notify` (GA-BRIDGE-62): shown in every graphical session the OS reports active with a bound
   * helper, the source first (GA-BRIDGE-56); `applied` once any helper handed it to its session's
   * notification service. `failed(not_shown)` only when none could show it: no session to show it
   * in, or every helper saying it failed. A helper that has not answered within NOTIFY_MS, or by the
   * time the bridge leaves, was handed the text and may still show it, so with no helper having shown
   * it the ack is `failed(no_confirmation)`, never `not_shown` (*Commands*, GA-BRIDGE-22): `notify`
   * is not idempotent, and a `not_shown` would invite a second copy.
   */
  private async notify(id: string, commandId: string, v: NotifyValue): Promise<void> {
    const conns = this.sessions
      .filter((s) => s.graphical && s.state === "active")
      .map((s) => this.helpers.conn(s.id))
      .filter((c): c is number => c !== undefined);
    if (!conns.length) return this.ack(id, commandId, "failed", "not_shown", "no session is unlocked with a helper running");
    const text = shownText(v.text, v.from);
    const results = await Promise.allSettled(conns.map((c) => this.shown(c, text, v.urgency)));
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length < results.length) return this.ack(id, commandId, "applied");
    const unanswered = failed.find((r) => r.reason instanceof Unanswered);
    if (unanswered) return this.ack(id, commandId, "failed", "no_confirmation", (unanswered.reason as Error).message);
    return this.ack(id, commandId, "failed", "not_shown", String((failed[0]!.reason as Error)?.message ?? failed[0]!.reason));
  }

  /** One helper's showing of a notification, bounded by NOTIFY_MS and by the bridge's leave. */
  private shown(conn: number, text: string, urgency: Urgency): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const end = (err?: Error) => {
        if (done) return;
        done = true;
        this.o.clock.clear(timer);
        this.notifying.delete(cut);
        if (err) reject(err);
        else resolve();
      };
      const cut = () => end(new Unanswered("the bridge went offline before the helper answered"));
      const timer = this.o.clock.setTimeout(() => end(new Unanswered(`the helper did not answer within ${NOTIFY_MS} ms`)), NOTIFY_MS);
      this.notifying.add(cut);
      this.o.port.notify(conn, text, urgency).then(() => end(), (err) => end(err instanceof Error ? err : new Error(String(err))));
    });
  }

  // --- What the bridge publishes ----------------------------------------------------------------

  /**
   * A routine status goes out only while running; `leaving` marks the graceful offline of a leave,
   * which goes out only while that leave is not cut (a stall may hold it past the cut).
   */
  private async publishStatus(extra: Record<string, unknown> = {}, leaving?: { value: boolean }): Promise<void> {
    await this.whenFree();
    if (this.resuming) await this.resuming;
    if (leaving ? leaving.value : this.life !== "running") return;
    // Not while the broker is away: the client would queue it and deliver it stale before the
    // resubscription; the reconnection publishes a fresh one after it (GA-BRIDGE-18).
    if (!this.o.wire.connected()) return;
    const now = this.o.clock.now();
    this.refresh(now);
    const h = this.host;
    const retry = h.retryIntervalMs;
    const lastCheckIn = this.lastCheckIn !== null ? wireTime(this.lastCheckIn) : null;
    const status: Record<string, unknown> = {
      bridgeId: this.o.bridgeId,
      instanceId: this.o.instanceId,
      v: 1,
      state: this.observable.value ? "online" : "offline",
      version: VERSION,
      // Host once its requests exist (plan 3c); the subject still claims Serve alone, the harness having no Host tests before plan 5.
      levels: ["Serve", "Host"],
      faults: [...this.faults, ...this.pluginFaults()],
      ungoverned: [],
      blocked: [],
      transports: [{ id: HOST, kind: "other", state: h.state, since: wireTime(h.since),
        ...(retry !== undefined ? { retryIntervalMs: retry } : {}) }],
      devices: [{
        id: COMPUTER, transport: HOST, basis: "poll", cadenceMs: COMPUTER_CADENCE_MS, basisMaxAgeMs: COMPUTER_MAX_AGE_MS,
        timestamp: lastCheckIn, lastCheckIn, observable: this.observable.value, since: wireTime(this.observable.since),
      }, ...pluginDevices(this.plugins.state).map((d) => pluginRoster(d, HOST, this.pluginObservation(d, now)))],
      publishedAt: wireTime(now),
      ...extra,
    };
    if (this.o.runId) status.testRunId = this.o.runId;
    this.rosterShown = this.rosterKey();
    await this.publish(`${this.base}/status`, status, true);
  }

  /** A plugin device's check-in and whether it is observable, for the roster. */
  private pluginObservation(d: PluginDevice, now: number) {
    return this.plugins.observation(d.id, this.plugins.view(d.plugin, d.version, d.key), d.declared.cadenceMs, Date.parse(d.installed.installedAt), now);
  }

  /**
   * One `account_deleted` per device of a plugin whose account was deleted, until it is uninstalled
   * (GA-BRIDGE-67); each server's `pin_mismatch`, `crash_loop` and `reading_dropped`.
   */
  private pluginFaults(): Fault[] {
    const out: Fault[] = [...accountFaults(pluginDevices(this.plugins.state), (t) => this.retired(t)), ...this.plugins.faults()];
    const unready = this.plugins.unready();
    if (unready !== undefined) out.push({ code: "plugins_unready", detail: unready });
    // An install's or uninstall's end not on disk: its event is held until it is (GA-BRIDGE-68).
    if (this.plugins.unsavedEnds() && !this.faults.some((f) => f.code === "state_unsaved")) {
      out.push({ code: "state_unsaved", detail: "a plugin request's end is not on disk" });
    }
    return out;
  }

  /** What of the status a plugin can change: the roster's devices, whether each is observable, and the faults. */
  private rosterKey(): string {
    const now = this.o.clock.now();
    return JSON.stringify([pluginDevices(this.plugins.state).map((d) => [d.id, this.pluginObservation(d, now).observable]), this.faults, this.pluginFaults()]);
  }

  /**
   * The computer's declaration (*Computers*, GA-BRIDGE-38): its capabilities, `sensor` only where the
   * port's helpers read a personal key; `accounts` one entry per interactive account; every session
   * key and sensor key `personal` and `selfChanging`, as the standard declares them.
   */
  private declaration(): Record<string, unknown> {
    const accounts = accountsOf(this.tokens);
    const keys = [...Object.keys(accounts).map((t) => `session.${t}`), ...this.personalKeys];
    return {
      id: COMPUTER,
      stableIdentifier: this.identity.machineId,
      transport: HOST,
      model: { vendor: this.identity.vendor, model: this.identity.model },
      capabilities: ["power", "session", "notify", ...(this.personalKeys.length ? ["sensor"] : [])],
      sensorKeys: this.personalKeys,
      actions: actions(Object.keys(accounts)),
      feedback: "closed",
      reachMs: 0,
      proposedClass: "computer",
      // Read from the host itself (*Computers*).
      classEvidence: "protocol",
      otherAdmins: this.computerAdmins(),
      ...(this.infrastructure ? { proposedInfrastructure: true } : {}),
      accounts,
      personal: keys,
      selfChanging: keys,
    };
  }

  /** The administrators, and the account of each `needsSession` plugin, whose server runs in its session (GA-BRIDGE-53). */
  private computerAdmins(): OtherAdmin[] {
    const admins = this.otherAdmins ?? [UNKNOWN];
    const accounts = sessionAccounts(this.plugins.state, (t) => !this.retired(t));
    return withAccounts(admins, accounts);
  }

  /** The `devices` document's entries: the computer, then each plugin device by id. */
  private devicesDoc(): Record<string, unknown>[] {
    const computer = { id: COMPUTER, stableIdentifier: this.identity.machineId, transport: HOST };
    const admins = this.otherAdmins ?? [UNKNOWN];
    const held = (t: string) => !this.retired(t);
    return [this.declaration(), ...pluginDevices(this.plugins.state).map((d) => pluginEntry(d, computer, pluginAdmins(admins, d.installed, held)))];
  }

  private async publishDevices(): Promise<void> {
    // A token given or retired is on disk first; until a save succeeds, the last `devices` stands.
    await this.tokensWrite;
    if (this.tokensUnsaved) {
      this.heldBack = true;
      return;
    }
    const devices = this.devicesDoc();
    this.noteAdmins(devices);
    this.devicesShown = JSON.stringify(devices);
    await this.publish(`${this.base}/devices`, { publishedAt: wireTime(this.o.clock.now()), devices }, true);
  }

  /**
   * Each device whose `otherAdmins` differ from those it last declared, in this instance or the last
   * (GA-BRIDGE-31), is due an `other_admins_changed`, each its own event (GA-BRIDGE-53); a device
   * declared for the first time is not, nor one that left. The sets are kept for the next start.
   */
  private noteAdmins(devices: Record<string, unknown>[]): void {
    const kept = this.o.store.state.otherAdmins ?? {};
    const next: Record<string, OtherAdmin[]> = {};
    for (const d of devices) {
      const id = d.id as string;
      next[id] = d.otherAdmins as OtherAdmin[];
      if (kept[id] !== undefined && !sameSet(kept[id], next[id])) this.adminsDue.add(id);
    }
    if (JSON.stringify(next) === JSON.stringify(kept)) return;
    this.o.store.state.otherAdmins = next;
    this.o.store.save().catch((err) => console.error(`state: ${err}`));
  }

  /**
   * Each plugin device's retained status (pluginStatus): one that changed, or every one shown
   * (`all`, at a start, a reconnection or a snapshot) with the payload it had, never restamped; and
   * an empty retained payload for each that left, an uninstall's and a swap's included
   * (GA-BRIDGE-21). Nothing while its server starts or after the bridge stopped it: the retained one
   * stands. A read a command asked for goes out even when nothing changed (GA-BRIDGE-34). Only once
   * `devices` shows the plugin devices as they are, so none is cleared before `devices` drops it, and
   * none published before its declaration. The ids still to clear are kept in the state file, each
   * forgotten only once the broker took its clear, so a restart or a refusal never leaves a retained
   * status behind. One run at a time, each from the state as it is when it begins: two that
   * overlapped would clear a status twice, or one begun before a swap would put a status the swap
   * cleared back.
   */
  private publishPluginStatuses(all = false): Promise<void> {
    const run = this.statusesRun.then(() => this.publishPluginStatusesNow(all));
    this.statusesRun = run.catch(() => {});
    return run;
  }

  private async publishPluginStatusesNow(all: boolean): Promise<void> {
    if (JSON.stringify(this.devicesDoc()) !== this.devicesShown || !this.o.wire.connected()) return;
    const devices = pluginDevices(this.plugins.state);
    const ids = new Set(devices.map((d) => d.id));
    const left = [...this.pluginStatusShown.keys()].filter((id) => !ids.has(id));
    if (left.length) await this.plugins.toClear(left);
    const taken: string[] = [];
    for (const id of this.plugins.clears()) {
      this.pluginStatusShown.delete(id);
      // A device installed again since keeps its status; its clear is done with.
      if (ids.has(id) || (await this.publishTaken(`${this.base}/devices/${id}/status`, "", true))) taken.push(id);
    }
    if (taken.length) await this.plugins.cleared(taken);
    for (const d of devices) {
      const view = this.plugins.view(d.plugin, d.version, d.key);
      const shown = this.pluginStatusShown.get(d.id);
      // A version that runs a server and shows nothing yet: starting, or stopped by the bridge.
      const payload = view !== undefined || !this.plugins.runs(d.plugin, d.version) ? pluginStatus(d, view) : undefined;
      // A read that changed nothing goes out only when a command asked for it: the roster carries each check-in.
      const key = payload && JSON.stringify(view?.available ? [view.values, view.seq] : payload);
      if (payload && key !== shown?.key) {
        this.pluginStatusShown.set(d.id, { key: key!, payload });
        await this.publish(`${this.base}/devices/${d.id}/status`, payload, true);
      } else if (all && shown) {
        await this.publish(`${this.base}/devices/${d.id}/status`, shown.payload, true);
      }
    }
  }

  /**
   * The computer's keys and when each was read: every interactive account's `session.<token>` from
   * the last successful observation, with its time; the personal keys from the console session's
   * helper, each with the time it reported it, a key it never reported left out (GA-BRIDGE-61).
   */
  private readings(): { values: Record<string, unknown>; at: Record<string, number> } {
    const values: Record<string, unknown> = {};
    const at: Record<string, number> = {};
    if (this.sessionsAt !== null) {
      const keys = sessionKeys(interactive(this.tokens), this.sessions, (id) => this.helpers.activity(id));
      for (const [k, v] of Object.entries(keys)) {
        values[k] = v;
        at[k] = this.sessionsAt;
      }
    }
    const atConsole = this.sessions.find((s) => s.seat0Active && s.graphical);
    if (atConsole) {
      for (const [k, r] of Object.entries(this.helpers.readings(atConsole.id, this.personalKeys))) {
        values[k] = r.value;
        at[k] = r.at;
      }
    }
    return { values, at };
  }

  /**
   * The computer's own status: its keys, each with when it was read, and when the computer was last
   * observed. False when it did not go out: never observed yet, or held back by the token table.
   */
  private async publishComputerStatus(): Promise<boolean> {
    // Its keys are named by token: none goes out while the table is not on disk.
    if (this.lastCheckIn === null) return false;
    if (this.tokensUnsaved) {
      this.heldBack = true;
      return false;
    }
    const { values, at } = this.readings();
    this.computerShown = JSON.stringify(values);
    const timestamps = Object.fromEntries(Object.entries(at).map(([k, t]) => [k, wireTime(t)]));
    await this.publish(`${this.base}/devices/${COMPUTER}/status`, {
      deviceId: COMPUTER, timestamp: wireTime(this.lastCheckIn), available: true, ...values,
      ...(Object.keys(timestamps).length ? { timestamps } : {}),
    }, true);
    return true;
  }

  /**
   * `devices` when a declaration changed, then the computer's status when a key's value did: a key
   * that leaves (a retired token's) leaves the retained status with it; then an administrators' event
   * due. Only while running and connected, and once the start has reached its first `devices`; the
   * reconnection publishes all three afresh.
   */
  private async publishChanges(): Promise<void> {
    if (!this.publishing || this.life !== "running" || !this.o.wire.connected()) return;
    if (JSON.stringify(this.devicesDoc()) !== this.devicesShown) await this.publishDevices();
    if (this.lastCheckIn !== null && JSON.stringify(this.readings().values) !== this.computerShown) await this.publishComputerStatus();
    await this.publishPluginStatuses();
    // A plugin installed or removed changes the roster; a deleted account, the faults.
    if (this.rosterKey() !== this.rosterShown) await this.publishStatus();
    // A change read while the broker was away goes out with the first `devices` that carries it.
    await this.publishDue();
  }

  /**
   * The events due, once the `devices` that carries them has gone out: while `devices` is held back
   * (the token table not on disk), so are they, until the release publishes both. Each device's
   * `other_admins_changed`, then each request's terminal event (`installed`, `install_failed`,
   * `uninstalled`), forgotten once it went out, so that one the broker never took goes out again at
   * the next change or reconnection. One pass at a time.
   */
  private publishDue(): Promise<void> {
    const next = this.dueChain.then(async () => {
      if (!this.o.wire.connected() || JSON.stringify(this.devicesDoc()) !== this.devicesShown) return;
      for (const device of [...this.adminsDue]) {
        this.adminsDue.delete(device);
        await this.publishEvent("other_admins_changed", { device });
      }
      for (const r of this.plugins.ended()) {
        const e = r.ended;
        const fields = e.type === "installed" ? { requestId: r.requestId, manifest: e.manifest }
          : e.type === "install_failed" ? { requestId: r.requestId, reason: e.reason, ...(e.detail ? { detail: e.detail } : {}) }
            : { requestId: r.requestId, plugin: e.plugin };
        if (!(await this.publishEvent(e.type, fields))) return;
        await this.plugins.announced(r.requestId);
      }
    });
    this.dueChain = next.catch(() => {});
    return next;
  }

  /** A publication the caller must know was taken: true once the broker took it; a refusal is the fault `publish_refused`. */
  private async publishTaken(topic: string, payload: unknown, retain: boolean): Promise<boolean> {
    try {
      await this.o.wire.publish(topic, payload, retain);
      this.clearFault("publish_refused", topic);
      return true;
    } catch (err) {
      if (err instanceof Refused) this.setFault({ code: "publish_refused", topic: err.topic });
      else console.error(`publish ${topic}: ${err}`);
      return false;
    }
  }

  /** An event, `seq` from 1 in this instance (GA-BRIDGE-33), not retained; true once the broker took it. */
  private async publishEvent(type: string, fields: Record<string, unknown>): Promise<boolean> {
    this.seq += 1;
    return this.publishTaken(`${this.base}/event`, { seq: this.seq, instanceId: this.o.instanceId, type, ...fields }, false);
  }

  private async publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
    try {
      await this.o.wire.publish(topic, payload, retain);
      // Accepted now: an earlier refusal no longer holds, and the next status says so.
      this.clearFault("publish_refused", topic);
    } catch (err) {
      if (err instanceof Refused) this.setFault({ code: "publish_refused", topic: err.topic });
      else console.error(`publish ${topic}: ${err}`);
    }
  }

  /**
   * A helper refused: one entry on the computer, its detail the latest, kept until the bridge restarts
   * (a forged helper is worth the owner's eye). It changes the status at most once every
   * HELPER_REFUSED_EVERY_MS; a refusal sooner waits for the bound, and only the latest of those is
   * named (review M2). The status waits for the start's first declaration.
   */
  private nameRefusal(detail: string): void {
    const now = this.o.clock.now();
    if (this.refusedAt !== null && now - this.refusedAt < HELPER_REFUSED_EVERY_MS) {
      this.refusedNext = detail;
      this.refusedTimer ??= this.o.clock.setTimeout(() => {
        this.refusedTimer = null;
        const next = this.refusedNext;
        this.refusedNext = null;
        if (next !== null && this.life !== "stopped") this.nameRefusal(next);
      }, this.refusedAt + HELPER_REFUSED_EVERY_MS - now);
      return;
    }
    this.refusedAt = now;
    if (this.setFault({ code: "helper_refused", device: COMPUTER, detail })) this.track(this.startGate.then(() => this.publishStatus()));
  }

  /** Adds or replaces the fault of that code and topic; true when the list changed. */
  private setFault(f: Fault): boolean {
    const i = this.faults.findIndex((x) => x.code === f.code && x.topic === f.topic);
    if (i >= 0 && JSON.stringify(this.faults[i]) === JSON.stringify(f)) return false;
    if (i >= 0) this.faults[i] = f;
    else this.faults.push(f);
    return true;
  }

  /** Removes the fault of that code (and topic, when named); true when the list changed. */
  private clearFault(code: string, topic?: string): boolean {
    const i = this.faults.findIndex((x) => x.code === code && (topic === undefined || x.topic === topic));
    if (i < 0) return false;
    this.faults.splice(i, 1);
    return true;
  }

  /** Every filter is asked for again: one granted now clears its refusal, one refused now is a fault (GA-BRIDGE-20). */
  private async subscribe(): Promise<void> {
    const refused = await this.o.wire.subscribe(this.filters);
    for (const topic of this.filters) {
      if (refused.includes(topic)) this.setFault({ code: "subscribe_refused", topic });
      else this.clearFault("subscribe_refused", topic);
    }
  }

  /** The session is clean, so the broker forgot the subscriptions: subscribed again before `status` (GA-BRIDGE-9, GA-BRIDGE-18). */
  private async reconnected(): Promise<void> {
    if (this.life !== "running") return;
    await this.subscribe();
    await this.publish(`${this.base}/lwt`, "", true);
    await this.publishDevices();
    await this.publishComputerStatus();
    await this.publishPluginStatuses(true);
    await this.publishStatus();
    // A change read while the broker was away: its event follows the `devices` that carries it (GA-BRIDGE-53).
    await this.publishDue();
  }

  // --- What the bridge receives -----------------------------------------------------------------

  private async onDelivery(d: Delivery, receivedAt: number): Promise<void> {
    await this.whenFree();
    // A retained command or request is never acted on (GA-BRIDGE-19).
    if (d.retained || !d.topic.startsWith(`${this.base}/`)) return;
    const command = d.topic.match(/\/devices\/([^/]+)\/command$/);
    // A command the broker delivers while leaving still gets its one ack (GA-BRIDGE-4, GA-BRIDGE-22).
    if (command) return this.onCommand(command[1]!, d, receivedAt);
    if (this.life !== "running") return;
    const request = d.topic.match(/\/request\/([^/]+)$/);
    if (request) return this.onRequest(request[1]!, d, receivedAt);
  }

  private async onCommand(id: string, d: Delivery, receivedAt: number): Promise<void> {
    let cmd: Record<string, any>;
    try {
      cmd = JSON.parse(d.payload.toString());
    } catch {
      return;
    }
    if (!cmd || typeof cmd !== "object" || typeof cmd.commandId !== "string") return;
    const commandId: string = cmd.commandId;
    this.prune(receivedAt);
    // A repeated commandId gets the first ack, or nothing while the first runs, and does nothing more (GA-BRIDGE-4).
    const seen = this.commands.get(commandId);
    if (seen) {
      if (seen.ack) await this.publish(this.ackTopic(id), seen.ack, false);
      return;
    }
    const within = Number.isInteger(cmd.resultWithinMs) && cmd.resultWithinMs >= 0 ? (cmd.resultWithinMs as number) : 0;
    this.commands.set(commandId, { keepUntil: receivedAt + Math.max(within, COMMAND_MEMORY_MS) });
    try {
      await this.handleCommand(id, d, receivedAt, cmd, commandId, within);
    } catch (err) {
      // One ack per command, whatever threw (GA-BRIDGE-4); logged, never an exit.
      const message = String((err as Error)?.message ?? err);
      console.error(`command ${commandId}: ${message}`);
      if (this.commands.get(commandId)?.ack) return;
      // A no_confirmation for a plugin's stateful action owes its read-back (GA-BRIDGE-34), as pluginCommand gives it.
      const plugin = id !== COMPUTER ? pluginDevices(this.plugins.state).find((p) => p.id === id) : undefined;
      const action = plugin?.declared.actions.find((a) => a.action === String(cmd.value?.action));
      if (plugin && action && !action.stateless) {
        const issued = Date.parse(cmd.issuedAt);
        this.readBack(plugin, (Number.isFinite(issued) ? issued : receivedAt) + within);
      }
      await this.ack(id, commandId, "failed", UNEXPECTED_ACK_REASON, capText(message));
    }
  }

  private async handleCommand(id: string, d: Delivery, receivedAt: number, cmd: Record<string, any>, commandId: string,
    within: number): Promise<void> {
    const errors = validate("bridge/command.json", cmd);
    if (errors.length) return this.ack(id, commandId, "failed", "invalid_request", errors.join("; "));
    const plugin = id !== COMPUTER ? pluginDevices(this.plugins.state).find((d) => d.id === id) : undefined;
    if (id !== COMPUTER && !plugin) return this.ack(id, commandId, "failed", "unknown_device", `no device ${id}`);
    // The command's time: the lesser of the Message Expiry left on delivery and resultWithinMs from receipt.
    const deadline = receivedAt + Math.min(within, d.expirySeconds !== undefined ? d.expirySeconds * 1000 : Infinity);
    // A clock that stepped back since receipt says nothing of the time left: expired, never stretched.
    const now = this.o.clock.now();
    if (now > deadline || now < receivedAt) return this.ack(id, commandId, "failed", "expired");
    if (plugin) return this.pluginCommand(plugin, commandId, cmd.value as Record<string, unknown>, deadline, Date.parse(cmd.issuedAt) + within);
    const value = cmd.value as Record<string, unknown>;
    const action = String(value.action);
    const accounts = accountsOf(this.tokens);
    if (!actions(Object.keys(accounts)).some((a) => a.action === action)) {
      return this.ack(id, commandId, "unsupported", undefined, `${action} is not offered`);
    }
    const unknown = Object.keys(value).filter((k) => k !== "action" && k !== "value" && k !== "state");
    if (unknown.length) return this.ack(id, commandId, "failed", "invalid_request", `unknown keys: ${unknown.join(", ")}`);
    // A one-argument action carries the argument itself, a several-argument one an object (*Commands*).
    const arg = value.value;
    if (action === "power.shutdown") {
      if (arg !== undefined && !(typeof arg === "number" && Number.isFinite(arg) && arg >= 0)) {
        return this.ack(id, commandId, "failed", "invalid_request", "delay_s is a number of seconds, 0 or more");
      }
    } else if (action === "session.lock") {
      // A token `accounts` does not list, a retired one included, is refused at once, nothing done (GA-BRIDGE-66).
      if (typeof arg !== "string" || !Object.hasOwn(accounts, arg)) {
        return this.ack(id, commandId, "failed", "invalid_request", `${JSON.stringify(arg)} is no account this computer lists`);
      }
    } else if (action === "notify.notify") {
      const wrong = notifyError(arg);
      if (wrong) return this.ack(id, commandId, "failed", "invalid_request", wrong);
    } else if (arg !== undefined) {
      return this.ack(id, commandId, "failed", "invalid_request", `${action} takes no argument`);
    }
    // Nothing was done: `unreachable` while leaving, as for a command in flight (GA-BRIDGE-22).
    if (this.life !== "running") return this.ack(id, commandId, "failed", "unreachable", "the bridge is going offline");
    if (this.host.state !== "up") return this.ack(id, commandId, "failed", "unreachable", "the host is not observed");
    if (action === "session.lock") return this.lock(id, commandId, arg as string, receivedAt);
    if (action === "notify.notify") return this.notify(id, commandId, arg as NotifyValue);
    try {
      if (action === "power.sleep") await this.o.port.sleep();
      else if (action === "power.shutdown") await this.o.port.shutdown(arg as number | undefined);
      // Nothing scheduled is still `applied` (GA-BRIDGE-63).
      else await this.o.port.cancelShutdown();
    } catch (err) {
      return this.ack(id, commandId, "failed", "os_refused", String((err as Error).message ?? err));
    }
    // `applied` once the OS accepted it, before any graceful `offline` it brings (GA-BRIDGE-22).
    return this.ack(id, commandId, "applied");
  }

  /**
   * A command to a plugin device (*Plugins*, *Commands*): an action it does not declare is
   * `unsupported`; a value that does not fit its `args` `invalid_request`; a server that has not
   * served (still starting, waiting for a session, failed, or its version not run) `unreachable`,
   * nothing called (GA-BRIDGE-60); else the action's tool is called with the arguments, until the
   * command's time runs out, and its result acked (toOutcome). A stateful action's `applied`, `sent`
   * or `failed(no_confirmation)` is followed by a read-back, started READ_BACK_LEAD_MS before
   * `issuedAt` plus `resultWithinMs` less 1 s, so that its status is out by then, whatever the early
   * read found (GA-BRIDGE-34, GA-BRIDGE-51).
   */
  private async pluginCommand(d: PluginDevice, commandId: string, value: Record<string, unknown>, deadline: number, bound: number): Promise<void> {
    const action = d.declared.actions.find((a) => a.action === String(value.action));
    if (!action) return this.ack(d.id, commandId, "unsupported", undefined, `${String(value.action)} is not offered`);
    const unknown = Object.keys(value).filter((k) => k !== "action" && k !== "value" && k !== "state");
    if (unknown.length) return this.ack(d.id, commandId, "failed", "invalid_request", `unknown keys: ${unknown.join(", ")}`);
    const args = toolArguments(action, Object.hasOwn(value, "value"), value.value);
    if (!args.ok) return this.ack(d.id, commandId, "failed", "invalid_request", args.why);
    if (this.life !== "running") return this.ack(d.id, commandId, "failed", "unreachable", "the bridge is going offline");
    const srv = this.plugins.server(d.plugin, d.version);
    if (!srv?.serving) return this.ack(d.id, commandId, "failed", "unreachable", srv ? srv.why : `${d.plugin} ${d.version} is not activated`);
    const abort = new AbortController();
    const cut = this.o.clock.setTimeout(() => abort.abort(new Error("the command's time ran out")), Math.max(0, deadline - this.o.clock.now()));
    this.timers.add(cut);
    let r: Awaited<ReturnType<typeof srv.call>>;
    try {
      r = await srv.call(d.key, action.tool, args.args, abort.signal);
    } finally {
      this.o.clock.clear(cut);
      this.timers.delete(cut);
    }
    if (r.kind === "unreachable") return this.ack(d.id, commandId, "failed", "unreachable", r.text);
    const outcome = toOutcome(action, r);
    if (!action.stateless) this.readBack(d, bound);
    return this.ack(d.id, commandId, outcome.result, outcome.reason, outcome.detail);
  }

  /** A stateful action's read-back, started READ_BACK_LEAD_MS before its bound less 1 s (GA-BRIDGE-34). */
  private readBack(d: PluginDevice, bound: number): void {
    const at = Math.max(0, bound - 1000 - READ_BACK_LEAD_MS - this.o.clock.now());
    const h = this.o.clock.setTimeout(() => {
      this.timers.delete(h);
      this.plugins.server(d.plugin, d.version)?.readNow(d.key);
    }, at);
    this.timers.add(h);
  }

  private async onRequest(op: string, d: Delivery, receivedAt: number): Promise<void> {
    let req: Record<string, any>;
    try {
      req = JSON.parse(d.payload.toString());
    } catch {
      return;
    }
    if (!req || typeof req !== "object" || typeof req.requestId !== "string") return;
    const requestId: string = req.requestId;
    this.prune(receivedAt);
    const seen = this.requests.get(requestId);
    if (seen) {
      if (seen.reply) await this.publish(`${this.base}/reply`, seen.reply, false);
      return;
    }
    this.requests.set(requestId, { keepUntil: receivedAt + DUPLICATE_REQUEST_MS });
    try {
      await this.handleRequest(op, requestId, req);
    } catch (err) {
      // One reply per request, whatever threw (GA-BRIDGE-4); logged, never an exit. A reply has no detail.
      console.error(`${op} ${requestId}: ${String((err as Error)?.message ?? err)}`);
      if (!this.requests.get(requestId)?.reply) await this.reply({ requestId, op, status: "failed", reason: UNEXPECTED_REPLY_REASON });
    }
  }

  private async handleRequest(op: string, requestId: string, req: Record<string, any>): Promise<void> {
    if (validate("bridge/request.json", req).length) return this.reply({ requestId, op, status: "invalid_request" });
    if (op === "snapshot") {
      await this.publishDevices();
      await this.publishComputerStatus();
      await this.publishPluginStatuses(true);
      await this.publishStatus();
      return this.reply({ requestId, op, status: "ok", data: {} });
    }
    if (op === "install" || op === "uninstall" || op === "activate") return this.hostRequest(op, requestId, req);
    // No join window and no provisioning: every other op is invalid here.
    return this.reply({ requestId, op, status: "invalid_request" });
  }

  /**
   * `install`, `uninstall` and `activate` (Host): answered within 1 s, the fetch and the removal never
   * awaited here. A `host` other than the computer is `invalid_request` (GA-BRIDGE-68 says so of
   * `install`; `uninstall`'s `host` is read the same way), as is a field missing or of another type.
   * One repeated by `requestId` after the 10 s the bridge keeps replies, or after a restart, while
   * still in flight, is answered `accepted` again and does nothing more.
   */
  private async hostRequest(op: "install" | "uninstall" | "activate", requestId: string, req: Record<string, any>): Promise<void> {
    const invalid = () => this.reply({ requestId, op, status: "invalid_request" });
    let answer: Answer;
    if (op === "activate") {
      if (typeof req.plugin !== "string" || typeof req.version !== "string") return invalid();
      answer = await this.plugins.activate(req.plugin, req.version);
    } else {
      if (req.host !== COMPUTER) return invalid();
      if (op === "install") {
        const p = req.package;
        if (!p || typeof p.url !== "string" || typeof p.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(p.sha256) || typeof req.account !== "string") {
          return invalid();
        }
      } else if (typeof req.plugin !== "string") return invalid();
      if (this.plugins.request(requestId)) return this.reply({ requestId, op, status: "accepted" });
      answer = op === "install"
        ? await this.plugins.install(requestId, { url: req.package.url, sha256: req.package.sha256 }, req.account)
        : await this.plugins.uninstall(requestId, req.plugin);
    }
    if (answer.detail) console.error(`${op} ${requestId}: ${answer.status} ${answer.reason ?? ""}: ${answer.detail}`);
    return this.reply({ requestId, op, status: answer.status, ...(answer.data !== undefined ? { data: answer.data } : {}),
      ...(answer.reason ? { reason: answer.reason } : {}) });
  }

  private async ack(id: string, commandId: string, result: string, reason?: string, detail?: string): Promise<void> {
    const ack: Ack = { commandId, source: this.o.bridgeId, result, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}),
      timestamp: wireTime(this.o.clock.now()) };
    const record = this.commands.get(commandId);
    if (record) record.ack = ack;
    await this.publish(this.ackTopic(id), ack, false);
  }

  private async reply(r: Reply): Promise<void> {
    const record = this.requests.get(r.requestId);
    if (record) record.reply = r;
    await this.publish(`${this.base}/reply`, r, false);
  }

  private ackTopic(id: string): string {
    return `${this.base}/devices/${id}/ack`;
  }

  /** Forgets what has had its answer and its time; one still running is kept, however the clock stepped, so its repeat never runs it twice. */
  private prune(now: number): void {
    for (const [k, v] of this.commands) if (v.ack && now > v.keepUntil) this.commands.delete(k);
    for (const [k, v] of this.requests) if (v.reply && now > v.keepUntil) this.requests.delete(k);
  }

  // --- Time and the main loop ---------------------------------------------------------------------

  /** Logs a handler's failure instead of leaving it unhandled. */
  private track(p: Promise<unknown>): void {
    p.catch((err) => console.error(err));
  }

  /** Keeps a command's or request's handler until it settles, so a leave can wait for it. */
  private trackDelivery(p: Promise<unknown>): void {
    const tracked = p.catch((err) => console.error(err)).finally(() => this.deliveries.delete(tracked));
    this.deliveries.add(tracked);
  }

  private startTimers(): void {
    this.every(() => this.publishStatus(), STATUS_MS);
    this.every(() => this.tick(), CHECK_MS);
    this.every(() => this.rereadAdmins(), ADMINS_REREAD_MS);
  }

  private clearTimers(): void {
    for (const h of this.timers) this.o.clock.clear(h);
    this.timers.clear();
  }

  private later(fn: () => unknown, ms: number): void {
    const h = this.o.clock.setTimeout(() => {
      this.timers.delete(h);
      if (this.life === "running") this.track(Promise.resolve().then(fn));
    }, ms);
    this.timers.add(h);
  }

  /** Runs `fn` every `ms` of the clock, rescheduling after each run, so a clock step runs it once. */
  private every(fn: () => unknown, ms: number): void {
    const tick = () => {
      this.later(tick, ms);
      return fn();
    };
    this.later(tick, ms);
  }

  private async whenFree(): Promise<void> {
    const wait = this.stalledUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
