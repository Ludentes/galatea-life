import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import { Zdo } from "zigbee-herdsman";
import type { DoerEvents, DoerPort, HardwareId, ProtocolResult } from "../port.js";
import { Link, type LinkMutation } from "../transport.js";
import { type AvailabilityMutation, reachOf } from "./availability.js";
import { HerdsmanDevices, type Target } from "./devices.js";
import { resultOf, runGet, runSet } from "./execute.js";
import { redact } from "./log.js";
import { BackupUnreadable, predict as readCoordinator, startRefusal, type Prediction } from "./network-guard.js";
import { readNetwork as readNetworkFile, type Network, type NetworkRead } from "./network.js";
import { PERMIT_MS, permitSeconds, removeDevice } from "./provision.js";
import { BACKUP_FILE, herdsmanStack, type MakeStack, type Stack, type StackEvents } from "./stack.js";

/** The health exchange's own deadline, inside GA-BRIDGE-23's 30 s window (bench: about 50 ms). */
export const PING_MS = 8_000;
/** How often the doer looks for a due poll or backup while the coordinator is up: well inside a poll's cadence. */
export const UPKEEP_MS = 5_000;
/** How long herdsman's start may take: its Z-Stack start waits up to 60 s for the coordinator's state. */
export const START_MS = 90_000;
/**
 * Why a lock's unlock with the owner's PIN is not carried out: no lock is handed its PIN until spike
 * S6 lets the doer tell a new association from a rejoin, since a device re-paired without a leave
 * herdsman heard keeps its id, and the PIN configured for it (the maintainer, 2026-10-05).
 */
export const PIN_WITHHELD = "no lock is handed its PIN until spike S6 tells a new association from a rejoin";

/** Why an action is not carried out under the owner's switch that withholds them all. */
export const NO_ACTIONS = "the bridge offers no action: GALATEA_ZIGBEE_NO_ACTIONS";

/**
 * How long a backup of the coordinator (NV reads over the coordinator's own link) may take before the
 * doer gives up on it, at a stop or on its own. The bench's took 9.3 s (plan 2c-1's bench run), most of
 * it the address-manager and trust-centre link key tables, which herdsman reads entry by entry: three
 * times that, so that a slower coordinator or a busier link still has room (plan 2c-3).
 */
export const BACKUP_MS = 30_000;

/**
 * How old the coordinator's backup may grow before the doer takes another, after a successful health
 * exchange: herdsman's own cadence, a day, whose timer the stack turns off, since it restarts with
 * every controller (plan 2b review I4, re-review N5; plan 2c-3).
 */
export const BACKUP_AGE_MS = 86_400_000;

/** How long after a backup it tried the doer waits before it tries another, whatever came of it: one failing never retries every exchange. */
export const BACKUP_RETRY_MS = 3_600_000;

/**
 * The faults the doer names: the owner's network missing or unreadable, the coordinator's backup
 * damaged, or a coordinator that is not the owner's (GA-BRIDGE-12).
 */
const DOER_FAULTS = ["no_network", "invalid_network", "invalid_backup", "state_mismatch"] as const;
type DoerFault = (typeof DOER_FAULTS)[number];

/**
 * A removal waiting for its device: its promise, settled once, whether a try is under way, and whether
 * it is forced (asked with `force` while no controller was up: carried out as the next one resumes).
 */
interface Removal {
  done: Promise<void>;
  resolve(): void;
  reject(err: Error): void;
  trying: boolean;
  force: boolean;
}

export interface HerdsmanDoerOptions {
  clock: Clock;
  /** The coordinator, as herdsman names it: `tcp://host:port`. */
  coordinator: string;
  /** The bridge's private data directory: `network.json`, herdsman's database and the coordinator's backup. */
  dataDir: string;
  /** Reads the owner's network; the data directory's file unless given. */
  readNetwork?: (dir: string) => Promise<NetworkRead>;
  /** What herdsman would do at its start; read from the coordinator unless given. */
  predict?: (coordinator: string, network: Network, backupPath: string) => Promise<Prediction>;
  /** The stack; herdsman's unless given. */
  makeStack?: MakeStack;
  /** A negative mutation of the coordinator's link, only under a run. */
  mutation?: LinkMutation;
  /**
   * The owner's switch (`GALATEA_ZIGBEE_NO_ACTIONS=1`): every action withheld, and nothing sent to a
   * device, its keys still described and read; for read-only work on a real network (plan 2c-2
   * review M6).
   */
  noActions?: boolean;
  /** The devices' definitions; the converters' own unless given (tests). */
  definitionOf?: ConstructorParameters<typeof HerdsmanDevices>[0]["definitionOf"];
  /** When the coordinator's backup was last written, on the doer's clock, or undefined for none; the file's own time unless given. */
  backupTakenAt?: () => Promise<number | undefined>;
  /** The build's own mutation of the availability rule, only under a run (`availability.ts`). */
  availabilityMutation?: AvailabilityMutation;
}

/**
 * The herdsman doer (the design, *The herdsman doer*): the coordinator below the core, through one
 * herdsman controller at a time. Its link is the coordinator's: a try while there is no controller
 * reads the owner's network, asks the network guard, and starts herdsman only to resume that
 * network; a try while there is one is the health exchange. A failed exchange, or herdsman's
 * disconnect, closes the controller, and the next try, on the link's backoff, builds a new one
 * (GA-BRIDGE-10, 11, 23). The doer never forms a network, and never sends a frame to close one.
 */
export class HerdsmanDoer implements DoerPort {
  /** No lock is handed its PIN until spike S6: the core offers no unlock that would need one (plan 2c-2 review I3). */
  readonly withholdsPins = PIN_WITHHELD;
  /**
   * The doer opens join windows and removes devices (plan 3b), so the bridge claims Provision; not
   * under the owner's switch, which sends nothing: the bridge then claims Serve alone, and answers
   * Provision's ops `invalid_request`.
   */
  readonly provisions: boolean;
  private events?: DoerEvents;
  private readonly link: Link;
  /** The controller started and resuming the owner's network, if any. */
  private stack?: Stack;
  /** The controller starting, if any: closed by a stop. */
  private starting?: Stack;
  /** The close of the last controller: the next is built only after it, as herdsman keeps static state. */
  private closing: Promise<void> = Promise.resolve();
  private stopped = false;
  /** The tick that reads polled devices and backs the coordinator up, on its own timer (below). */
  private upkeep: number | null = null;
  /**
   * Whether the doer's join window is open: from its `join` call to its `joinClose` call, not by
   * herdsman's own permit timer (the window rule, the maintainer's ruling of 2026-10-05).
   */
  private windowOpen = false;
  /**
   * Hardware admitted in the window open now: another join of it before the window closes is the
   * same admission, not a pairing again (the maintainer's ruling, 2026-10-13). One pairing can reach
   * the handler twice, the second indication after herdsman took the hardware in (the bench's radar,
   * 32 ms apart). Emptied as each window opens.
   */
  private readonly admittedInWindow = new Set<string>();
  /** When the coordinator's last permit the doer asked for ends, on the doer's clock. */
  private permitEnds = 0;
  /**
   * Until when the coordinator may still permit joins it was never told to stop: a close the doer owes
   * it, sent as one permit of 0 once a controller is up (plan 3b review I2, M1). Owed from the start
   * (unbounded), since a bridge that stopped without closing its window may have left a permit that
   * herdsman's resume does not end; owed again by a close that could not reach the coordinator, and
   * by a permit that landed after its window closed. Undefined while none is owed.
   */
  private closeOwed?: number;
  /** The owed close under way, if any: a join's permit is sent after it, never before. */
  private paying?: Promise<void>;
  /**
   * The hardware the core has a device for, as far as the doer knows: what the store kept at the
   * start, and what herdsman let in since. One herdsman no longer has left while the doer was not
   * listening (a leave the store missed, or one during a link outage).
   */
  private readonly known = new Set<HardwareId>();
  /** Each removal waiting for its device (`remove` without `force`), by hardware: ended once the hardware is out. */
  private readonly removals = new Map<HardwareId, Removal>();
  /** The doer's faults shown now, by code. */
  private readonly shown = new Map<DoerFault, string>();
  private readonly readNetwork: (dir: string) => Promise<NetworkRead>;
  private readonly predict: (coordinator: string, network: Network, backupPath: string) => Promise<Prediction>;
  private readonly makeStack: MakeStack;
  /** The devices herdsman has, described and read through their converters (plan 2c). */
  private readonly devices: HerdsmanDevices;
  /**
   * herdsman's backup of the coordinator under way, if any, with the controller it runs on (plan 2c-3):
   * kept until herdsman's backup ends, though the doer gave up waiting on it, so that no second runs
   * beside it (both write the same file); dropped with its controller, so that a stop waits only on the
   * current controller's (plan 2c-3 review M1).
   */
  private backing?: { stack: Stack; promise: Promise<boolean> };
  /** Whether the backup's age is being read now. */
  private agingBackup = false;
  /** When the doer last tried a backup of its own, on its clock. */
  private backupTried?: number;
  private readonly backupTakenAt: () => Promise<number | undefined>;

  constructor(private readonly o: HerdsmanDoerOptions) {
    this.provisions = o.noActions !== true;
    // Under the owner's switch nothing is sent, the close too: no window opens.
    if (!o.noActions) this.closeOwed = Number.POSITIVE_INFINITY;
    this.devices = new HerdsmanDevices({ clock: o.clock, events: () => (this.stopped ? undefined : this.events),
      coordinator: () => (this.stack && !this.stopped ? this.stack.coordinatorEndpoint() : undefined),
      ...(o.definitionOf ? { definitionOf: o.definitionOf } : {}), ...(o.noActions ? { noActions: true } : {}),
      ...(o.availabilityMutation ? { mutation: o.availabilityMutation } : {}) });
    this.readNetwork = o.readNetwork ?? readNetworkFile;
    this.predict = o.predict ?? ((c, n, b) => readCoordinator(c, n, b));
    this.makeStack = o.makeStack ?? herdsmanStack;
    this.backupTakenAt = o.backupTakenAt ?? (async () => {
      try {
        return (await stat(join(o.dataDir, BACKUP_FILE))).mtimeMs;
      } catch {
        // None, or none that can be read: one is taken.
        return undefined;
      }
    });
    this.link = new Link({
      clock: o.clock,
      probe: () => this.probe(),
      report: (state, since, retryIntervalMs) => this.events?.transport(state, since, retryIntervalMs),
      ...(o.mutation ? { mutation: o.mutation } : {}),
    });
  }

  /** Starts the link, whose first try brings herdsman up; `settings` names every device the store keeps. */
  async start(events: DoerEvents, settings?: ReadonlyMap<HardwareId, Record<string, unknown>>,
    reported?: ReadonlyMap<HardwareId, string[]>): Promise<void> {
    this.events = events;
    this.stopped = false;
    for (const hw of settings?.keys() ?? []) this.known.add(hw);
    this.devices.keep(settings, reported);
    await this.link.start();
    // Polls and the backup run on their own tick while the coordinator is up, never on the health
    // exchange: any device's message postpones that exchange (GA-BRIDGE-11), so on a network with
    // steady traffic it never falls due, and a polled device would never be read (code review, plan 5b).
    if (this.upkeep === null) this.upkeep = this.o.clock.setInterval(() => this.upkeepTick(), UPKEEP_MS);
  }

  /** One upkeep pass: the devices whose poll is due, and the backup when it is due, while the link is up. */
  private upkeepTick(): void {
    const stack = this.stack;
    if (this.stopped || !stack || this.link.t.state !== "up") return;
    void this.backupIfDue(stack);
    void this.devices.pollDue();
  }

  /**
   * A planned stop takes a fresh backup of the coordinator first, while the link is up: herdsman's
   * daily backup timer lives only as long as one controller, so a bridge restarted more often never
   * refreshes it, and a restore from a stale backup gives the coordinator a frame counter its devices
   * take for replays (plan 2b review I4). The backup reads the coordinator's NV over its own link and
   * sends no frame to the network; it is bounded by BACKUP_MS, and skipped when the link is failing.
   * A backup under way on this controller is waited for instead of a second.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.upkeep !== null) this.o.clock.clear(this.upkeep);
    this.upkeep = null;
    const stack = this.stack;
    // A window still open is closed on the coordinator first: the close below sends no frame (the design, *Provisioning*).
    if (this.windowOpen) {
      this.windowOpen = false;
      await this.closePermit().catch((err) => console.error(`herdsman: the join window was not closed at the stop: ${redact(String((err as Error)?.message ?? err))}`));
    }
    if (stack && this.link.t.state === "up") {
      const ok = await this.within(this.backupOn(stack), BACKUP_MS).catch(() => false);
      if (!ok) console.error("herdsman: the coordinator's backup was not refreshed at the stop");
    }
    this.link.stop();
    const starting = this.starting;
    this.starting = undefined;
    await Promise.all([starting?.close(), this.drop()]);
    await this.closing;
    await this.devices.idle();
  }

  /** Resolves once the devices' work so far is done: their descriptions and observations told (tests). */
  idle(): Promise<void> {
    return this.devices.idle();
  }

  /**
   * Carries an action out (the design, *Command results*): its converter's set, run on the device
   * live (`execute.ts`), the arguments made the converter's value by the description's map. Whether
   * the device answered counts towards its going unavailable (`availability.ts`). The
   * owner's PIN, which the core gives with a lock's unlock, is never handed to the lock (PIN_WITHHELD):
   * the command is not sent at all. The core gives none while the doer withholds them
   * (`withholdsPins`); this is the second wall. Under the owner's switch nothing is sent.
   */
  async execute(hardwareId: HardwareId, action: string, args: Record<string, unknown>, deadline: number, pin?: string): Promise<ProtocolResult> {
    if (this.o.noActions) return { kind: "notSent", reason: "unreachable", detail: NO_ACTIONS };
    const t = this.target(hardwareId);
    if (!t) return { kind: "notSent", reason: "unreachable", detail: "the coordinator does not have the device described" };
    const decl = t.described.description.actions.find((a) => a.action === action);
    const map = t.described.actions.get(action);
    if (!decl || !map) return { kind: "notSent", reason: "unreachable", detail: `${action} is not offered` };
    if (pin !== undefined) return { kind: "notSent", reason: "unreachable", detail: PIN_WITHHELD };
    const since = this.o.clock.now();
    const run = await runSet(t.definition, t.model, map.property, map.value(args), { now: () => this.o.clock.now(), deadline,
      once: !decl.idempotent, ...(t.override?.options ? { options: t.override.options } : {}), state: t.state });
    // Whether the device answered counts towards its availability (`availability.ts`); the ack is the run's
    // alone. A command sent once, without herdsman's recovery, counts only when answered.
    const reach = reachOf(run);
    void this.devices.commanded(hardwareId, reach === "unanswered" && !decl.idempotent ? undefined : reach, since);
    return resultOf(run);
  }

  /**
   * Reads the keys back (GA-BRIDGE-34): each by its converter's get, run on the device live; the
   * answers come as the device's messages. A key no converter reads (a Tuya datapoint's, whose echo
   * is its observation) is not read.
   */
  async read(hardwareId: HardwareId, keys: string[], deadline: number): Promise<void> {
    if (this.o.noActions) return;
    const t = this.target(hardwareId);
    if (!t) return;
    const properties = [...t.described.keys].filter(([, k]) => keys.includes(k.key)).map(([p]) => p);
    const runs = await runGet(t.definition, t.model, properties, { now: () => this.o.clock.now(), deadline, once: false,
      ...(t.override?.options ? { options: t.override.options } : {}), state: t.state });
    for (const r of runs.map(resultOf)) {
      // The details are the doer's own words, never herdsman's (spike S8).
      if (r.kind !== "confirmed") console.error(`zigbee: ${hardwareId}: the read-back was ${r.kind}${"detail" in r && r.detail ? `: ${r.detail}` : ""}`);
    }
  }

  /**
   * Opens a join window (GA-BRIDGE-25, 26): herdsman's permit for the window's whole seconds, rounded
   * up, house-wide, or at the router `near` names. The doer's window is open from this call on, until
   * its `joinClose`, whatever herdsman counts (the window rule): a permit that fails leaves it open
   * until the core closes it, which it does at once. Rejects with no controller up, when herdsman
   * rejects, after PERMIT_MS without an answer, and under the owner's switch, which sends nothing.
   * The permit goes after an owed close under way. One given up on that lands once the window has
   * closed is closed again (plan 3b review M1).
   */
  async join(windowMs: number, near?: HardwareId): Promise<void> {
    if (this.o.noActions) throw new Error(NO_ACTIONS);
    if (!this.windowOpen) this.admittedInWindow.clear();
    this.windowOpen = true;
    const stack = this.stack;
    if (!stack || this.stopped) throw new Error("the coordinator is not connected");
    if (this.paying) await this.paying;
    const seconds = permitSeconds(windowMs);
    this.permitEnds = this.o.clock.now() + seconds * 1000;
    const permit = stack.permitJoin(seconds, near);
    const landed = () => this.landed(stack, seconds);
    void permit.then(landed, landed);
    await this.within(permit, PERMIT_MS);
  }

  /**
   * Closes the doer's window: herdsman's permit of 0, broadcast, while a controller is up. With none
   * open, changes nothing. The window ends though the close does not reach the coordinator (no
   * controller up, or no answer): the close is then owed, and sent once a controller is up.
   */
  async joinClose(): Promise<void> {
    if (!this.windowOpen) return;
    this.windowOpen = false;
    await this.closePermit();
  }

  /** herdsman's permit of 0, on the current controller; owed when there is none, or it fails. */
  private async closePermit(): Promise<void> {
    const stack = this.stack;
    if (!stack) {
      this.owe(this.permitEnds);
      return;
    }
    try {
      await this.within(stack.permitJoin(0), PERMIT_MS);
      this.closeOwed = undefined;
    } catch (err) {
      this.owe(this.permitEnds);
      throw err;
    }
  }

  /**
   * A permit herdsman settled: the coordinator permits from now on for its seconds, so a close is owed;
   * sent now when its window has closed (a permit given up on that landed late, plan 3b review M1), and
   * otherwise by the window's own close.
   */
  private landed(stack: Stack, seconds: number): void {
    this.owe(this.o.clock.now() + seconds * 1000);
    if (this.stack === stack && !this.stopped) this.payOwed(stack);
  }

  /** A close owed to the coordinator, whose permit runs until `until`. */
  private owe(until: number): void {
    this.closeOwed = Math.max(this.closeOwed ?? until, until);
  }

  /**
   * Sends the close owed, if any, as one permit of 0 on `stack`, bounded by PERMIT_MS; none while the
   * doer's window is open (its own close follows), or once the coordinator's permit has run out on its
   * own. A close that fails is owed again, to the next controller.
   */
  private payOwed(stack: Stack): void {
    const until = this.closeOwed;
    if (until === undefined || this.windowOpen) return;
    this.closeOwed = undefined;
    if (this.o.clock.now() >= until) return;
    const paying: Promise<void> = this.within(stack.permitJoin(0), PERMIT_MS).catch((err) => {
      console.error(`herdsman: the close owed to the coordinator was not sent: ${redact(String((err as Error)?.message ?? err))}`);
      this.owe(until);
    }).finally(() => {
      if (this.paying === paying) this.paying = undefined;
    });
    this.paying = paying;
  }

  /**
   * Removes the hardware from the network (GA-BRIDGE-21, 27), resolving once it is out and reported
   * `left`. Hardware herdsman does not have is `left` at once. Without `force`, herdsman's Leave
   * Request (`removeFromNetwork`, through the guard opened for it alone); a device that does not
   * answer is tried again at its next message or announce, one try at a time, and herdsman's own leave
   * of it ends the wait too; the device's own refusal (its ZDO status) rejects. With `force`, herdsman's
   * record is dropped without a frame (`removeFromDatabase`), which ends a removal still waiting.
   * Rejects under the owner's switch. A removal asked while no controller is up waits for the next:
   * without `force` it is tried once that one is up; with it, herdsman's record is dropped as that one
   * resumes, before it describes its devices, so the device is never described again (plan 3b review,
   * gap c).
   */
  async remove(hardwareId: HardwareId, force: boolean): Promise<void> {
    if (this.o.noActions) throw new Error(NO_ACTIONS);
    const stack = this.stack && !this.stopped ? this.stack : undefined;
    if (force && stack) {
      const model = stack.device(hardwareId);
      if (model) await removeDevice(model, true);
      this.gone(hardwareId);
      return;
    }
    // Hardware herdsman does not have is gone at the first try (`tryRemoval`).
    let r = this.removals.get(hardwareId);
    if (!r) {
      let resolve!: () => void;
      let reject!: (err: Error) => void;
      const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      r = { done, resolve, reject, trying: false, force: false };
      this.removals.set(hardwareId, r);
    }
    if (force) r.force = true;
    else void this.tryRemoval(hardwareId);
    return r.done;
  }

  /**
   * The removals forced while no controller was up, carried out on `stack` as it resumes: herdsman's
   * record dropped without a frame, and the hardware `left`. One herdsman rejects is rejected.
   */
  private async forceQueued(stack: Stack): Promise<void> {
    for (const [hw, r] of [...this.removals]) {
      if (!r.force) continue;
      const model = stack.device(hw);
      try {
        if (model) await removeDevice(model, true);
      } catch (err) {
        if (this.removals.get(hw) === r) this.removals.delete(hw);
        r.reject(new Error(`herdsman did not drop the device: ${redact(String((err as Error)?.message ?? err))}`));
        continue;
      }
      this.gone(hw);
    }
  }

  /**
   * One try of a removal waiting for its device, unless one is under way: herdsman's Leave Request. The
   * device out, it is `left`; its refusal rejects the removal; no answer leaves it waiting for the
   * device's next message.
   */
  private async tryRemoval(hw: HardwareId): Promise<void> {
    const r = this.removals.get(hw);
    const stack = this.stack;
    if (!r || r.trying || !stack || this.stopped) return;
    const model = stack.device(hw);
    if (!model) {
      // herdsman no longer has it: out of the network already.
      this.gone(hw);
      return;
    }
    r.trying = true;
    try {
      await removeDevice(model, false);
      // Ended already by herdsman's own leave of it, heard while its Leave Request waited for the answer.
      if (this.removals.get(hw) === r) this.gone(hw);
    } catch (err) {
      if (this.removals.get(hw) !== r) return;
      if (err instanceof Zdo.StatusError) {
        this.removals.delete(hw);
        r.reject(new Error(`the device refused its removal: ${err.message}`));
        return;
      }
      console.error(`herdsman: ${hw} did not answer its Leave Request (${redact(String((err as Error)?.message ?? err))}): tried again at its next message`);
    } finally {
      r.trying = false;
    }
  }

  /**
   * Hardware admitted anew: a removal still waiting for its earlier device ends, with no frame and no
   * `left` from the doer; the core names the earlier device `left` itself (plan 3b review I1).
   */
  private readmitted(hw: HardwareId): void {
    const r = this.removals.get(hw);
    if (!r) return;
    this.removals.delete(hw);
    r.resolve();
  }

  /** The hardware is out of the network: its converters stopped, `left` told, and a removal waiting for it ended. */
  private gone(hw: HardwareId): void {
    this.known.delete(hw);
    void this.devices.remove(hw);
    this.events?.left(hw);
    const r = this.removals.get(hw);
    if (!r) return;
    this.removals.delete(hw);
    r.resolve();
  }

  /** The device an action is carried out on, while a controller is up and has it described. */
  private target(hw: HardwareId): Target | undefined {
    return this.stack && !this.stopped ? this.devices.target(hw) : undefined;
  }

  /** One try of the link: herdsman brought up where there is none, then the health exchange. */
  private async probe(): Promise<boolean> {
    if (this.stopped) return false;
    if (!this.stack && !(await this.bringUp())) return false;
    const stack = this.stack!;
    if (await stack.ping(PING_MS)) {
      void this.backupIfDue(stack);
      // The devices in reach whose poll is due, read now that the coordinator answers (the design, *Freshness*).
      void this.devices.pollDue();
      return true;
    }
    console.error("herdsman: the coordinator did not answer the health exchange: closing the controller");
    if (this.stack === stack) await this.drop();
    return false;
  }

  /**
   * Starts herdsman on the owner's network, only where the guard says it would resume it, on its
   * channel, on its coordinator. True once it resumed; the link's exchange follows.
   */
  private async bringUp(): Promise<boolean> {
    await this.closing;
    const read = await this.readNetwork(this.o.dataDir);
    if ("fault" in read) {
      this.show(read.fault, read.detail);
      return false;
    }
    const network = read.network;
    // The network is the owner's: a fault about its file is done with, whatever the coordinator says.
    this.show("no_network", null);
    this.show("invalid_network", null);
    let p: Prediction;
    try {
      p = await this.predict(this.o.coordinator, network, join(this.o.dataDir, BACKUP_FILE));
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // A backup herdsman cannot take stops every try until the owner mends it: named, with the guard's
      // fixed text, since herdsman's error can quote the file (plan 2b review M2, M3; re-review N3).
      if (err instanceof BackupUnreadable) {
        this.show("invalid_backup", err.message);
        console.error(`herdsman: ${err.message}`);
        return false;
      }
      // Otherwise the coordinator was not read: a failed try, on the backoff, and no mismatch.
      console.error(`herdsman: the coordinator was not read: ${redact(message)}`);
      return false;
    }
    this.show("invalid_backup", null);
    const why = startRefusal(p, network);
    if (why) {
      this.show("state_mismatch", why);
      return false;
    }
    if (this.stopped) return false;
    const stack = this.makeStack({ coordinator: this.o.coordinator, dataDir: this.o.dataDir, network }, this.stackEvents(() => stack));
    this.starting = stack;
    let result: string | undefined;
    try {
      result = await this.within(stack.start(), START_MS);
    } catch (err) {
      console.error(`herdsman: start: ${redact(String((err as Error)?.message ?? err))}`);
    }
    if (this.starting !== stack) return false;
    this.starting = undefined;
    if (result !== "resumed") {
      if (result !== undefined) this.show("state_mismatch", `herdsman's start ${result} a network instead of resuming the owner's`);
      this.closing = stack.close();
      await this.closing;
      return false;
    }
    this.stack = stack;
    for (const code of DOER_FAULTS) this.show(code, null);
    // Removals forced while no controller was up, before any device is described (gap c).
    await this.forceQueued(stack);
    if (this.stack !== stack) return false;
    this.link.connected();
    this.leftUnheard(stack);
    // Every device herdsman has is described, before any message of this controller's is read.
    for (const ieee of stack.devices()) this.describe(stack, ieee);
    // A removal waiting for its device is tried once on the new controller: one asked while none was
    // up, or hardware the new controller no longer has, ends now; a sleeping device's waits for it.
    for (const hw of this.removals.keys()) void this.tryRemoval(hw);
    // The close owed to the coordinator: at the first controller, any permit a bridge that stopped
    // without closing left; later, a window's close that could not reach it (plan 3b review I2).
    this.payOwed(stack);
    return true;
  }

  /**
   * Hardware the core has a device for that herdsman no longer has: it left while nobody listened
   * (before this start, a leave the store missed; or while the link was down). Reported as `left`,
   * so that no entry outlives its device (GA-BRIDGE-21).
   */
  private leftUnheard(stack: Stack): void {
    for (const hw of [...this.known]) {
      if (stack.has(hw)) continue;
      this.known.delete(hw);
      this.events?.left(hw);
    }
  }

  /** A device of the current controller, described (or left until its interview succeeds); `interviewed` just now, so awake. */
  private describe(stack: Stack, ieee: string, interviewed = false): void {
    const device = stack.device(ieee);
    if (device) void this.devices.add(device, interviewed);
  }

  /** What a controller says, heard only while it is the current one: a late word from an old controller is about a link that is gone. */
  private stackEvents(self: () => Stack): StackEvents {
    const current = () => this.stack === self();
    // Admissions and leaves count from the controller's start on.
    const live = () => current() || this.starting === self();
    return {
      joining: async (ieee) => this.joining(self(), ieee),
      joined: (ieee) => {
        if (!live()) return;
        this.known.add(ieee);
        if (this.windowOpen) this.admittedInWindow.add(ieee);
        // herdsman cannot tell an association from a rejoin (spike S6, plan 3), and lets in as new only
        // hardware it did not have or had deleted: an association.
        this.events?.admitted(ieee, "association");
        // Its converters' deviceJoined, while the controller is the current one (plan 3b).
        const device = current() ? self().device(ieee) : undefined;
        if (device) void this.devices.joined(device);
      },
      interviewed: (ieee, status) => {
        if (!live()) return;
        if (status === "successful") {
          this.events?.interviewed(ieee);
          // A device interviewed while the controller still starts is described with the others once it resumed.
          if (current()) this.describe(self(), ieee, true);
        }
        // Its converters' deviceInterview, at each status, after the description a success brings (plan 3b).
        const device = current() ? self().device(ieee) : undefined;
        if (device) void this.devices.interview(device, status);
      },
      left: (ieee) => {
        if (live()) this.gone(ieee);
      },
      heard: () => {
        if (current()) this.link.heard();
      },
      message: (m) => {
        if (!current()) return;
        void this.devices.heard(m);
        // The device is awake: a removal waiting for it is tried again.
        if (this.removals.has(m.device.ieeeAddr)) void this.tryRemoval(m.device.ieeeAddr);
      },
      announced: (ieee) => {
        const device = current() ? self().device(ieee) : undefined;
        if (device) void this.devices.announced(device);
        if (device && this.removals.has(ieee)) void this.tryRemoval(ieee);
      },
      disconnected: () => {
        if (!current()) return;
        console.error("herdsman: the coordinator's link is lost: closing the controller");
        void this.drop();
        this.link.lost();
      },
    };
  }

  /**
   * herdsman's join handler, asked for every device that comes in, answered at once. herdsman answers
   * a refusal with a Leave Request without rejoin and changes nothing else (spike S7), so a refusal
   * removes the device (plan 2a's bench). By the window rule (the maintainer's ruling, 2026-10-05):
   * - hardware herdsman has, outside the doer's window, is a rejoin, let in with its id: reported as a
   *   `securedRejoin`, which keeps the device the core has for it, described or kept in the store;
   * - hardware herdsman has, inside the window, is a new admission, which the core may refuse; let in,
   *   the doer reports it itself, since herdsman raises nothing for it (S7): an `association`, and its
   *   description again, for the new id; a removal still waiting for its earlier device ends;
   * - hardware already admitted in this window, either way, is that admission still: let in, nothing
   *   reported, the core not asked (the maintainer's ruling, 2026-10-13);
   * - other hardware is a new admission in a window or out, which the core may refuse (blocked, or
   *   known to the core while the store is away: `mayAdmit`); herdsman reports it (`joined`).
   * Under the owner's switch nothing is refused, since a refusal sends a frame, and the core is not
   * asked: its own guard keeps blocked hardware out of `devices`.
   */
  private async joining(stack: Stack, ieee: string): Promise<boolean> {
    const known = stack.has(ieee);
    if (known && !this.windowOpen) {
      this.events?.admitted(ieee, "securedRejoin");
      return true;
    }
    // Admitted in this window already: the same pairing, let in as it is.
    if (known && this.admittedInWindow.has(ieee)) return true;
    if (this.o.noActions) return true;
    const may = this.events?.mayAdmit(ieee) ?? true;
    if (!may) {
      console.error(`herdsman: ${ieee} refused (blocked, or known while the store is away): herdsman sends it a Leave Request`);
      return false;
    }
    if (known) {
      // Admitted anew in the window: a new id, and its description again under it.
      this.known.add(ieee);
      this.admittedInWindow.add(ieee);
      this.readmitted(ieee);
      this.events?.admitted(ieee, "association");
      void this.devices.resend(ieee);
    }
    return true;
  }

  /**
   * The doer's own backup of the coordinator, after a successful health exchange, while the link is
   * up (plan 2c-3): taken when the backup file is older than BACKUP_AGE_MS, or missing, and none is
   * under way; one try at most every BACKUP_RETRY_MS, each bounded by BACKUP_MS. herdsman writes the
   * file; the stop's backup refreshes it too.
   */
  private async backupIfDue(stack: Stack): Promise<void> {
    if (this.backing || this.agingBackup || this.stopped) return;
    const now = this.o.clock.now();
    if (this.backupTried !== undefined && now - this.backupTried < BACKUP_RETRY_MS) return;
    this.agingBackup = true;
    let takenAt: number | undefined;
    try {
      takenAt = await this.backupTakenAt();
    } finally {
      this.agingBackup = false;
    }
    if (takenAt !== undefined && now - takenAt < BACKUP_AGE_MS) return;
    if (this.stack !== stack || this.stopped || this.backing) return;
    this.backupTried = now;
    const ok = await this.within(this.backupOn(stack), BACKUP_MS).catch(() => false);
    if (!ok) console.error("herdsman: the coordinator's backup was not refreshed; tried again within the hour");
  }

  /** herdsman's backup on `stack`: the one under way there, or a new one, kept as under way until it ends. */
  private backupOn(stack: Stack): Promise<boolean> {
    if (this.backing?.stack === stack) return this.backing.promise;
    const backing = { stack, promise: stack.backup().catch(() => false) };
    this.backing = backing;
    void backing.promise.then(() => {
      if (this.backing === backing) this.backing = undefined;
    });
    return backing.promise;
  }

  /** Closes the current controller, if any, and forgets a backup under way on it. */
  private async drop(): Promise<void> {
    const stack = this.stack;
    if (!stack) return;
    this.stack = undefined;
    if (this.backing?.stack === stack) this.backing = undefined;
    // The devices' converters are stopped (their timers cleared) with the controller whose models they hold.
    this.closing = this.devices.clear().then(() => stack.close());
    await this.closing;
  }

  /** Shows a fault of the doer's, or clears it with null; the core hears only a change. */
  private show(code: DoerFault, detail: string | null): void {
    if (detail === null ? !this.shown.has(code) : this.shown.get(code) === detail) return;
    if (detail === null) this.shown.delete(code);
    else this.shown.set(code, detail);
    for (const other of DOER_FAULTS) {
      // One reason at a time: the network missing, unreadable, or not the coordinator's.
      if (detail !== null && other !== code && this.shown.delete(other)) this.events?.fault(other, null);
    }
    this.events?.fault(code, detail);
  }

  /** `p`, or a throw once `ms` passed on the clock. */
  private async within<T>(p: Promise<T>, ms: number): Promise<T> {
    let handle = 0;
    const late = new Promise<never>((_, reject) => {
      handle = this.o.clock.setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      this.o.clock.clear(handle);
    }
  }
}
