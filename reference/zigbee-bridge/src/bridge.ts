import { validate } from "@ludentes/galatea-life-schemas";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Admission, Description, DoerEvents, DoerPort, HardwareId, ProtocolResult } from "./port.js";
import { Keeping, type Held } from "./keeping.js";
import type { DeviceStore, StoredDevice } from "./store.js";
import type { TransportState } from "./transport.js";
import { descriptionProblem } from "./description.js";
import { ackFor, declaration, entry, rosterEntry, UNLOCK, type Device } from "./declaring.js";
import { closedSets, declaredKeys, extensionKeys, fits, namedArgs, type ActionDecl } from "./vocabulary.js";
import { Refused, type Delivery, type Wire } from "./wire.js";

export const VERSION = "0.1.0";
/** The bridge's one transport, its coordinator, of kind `zigbee` (*Transports*). */
export const COORDINATOR = "coordinator";

/** `status` at least every 10 s (GA-BRIDGE-17). */
export const STATUS_MS = 10_000;
/** Each device's `observable` is recomputed every second, so a change shows within 1 s (GA-BRIDGE-17). */
export const CHECK_MS = 1_000;
/** A request repeated by `requestId` within 10 s gets the first reply (GA-BRIDGE-4). */
export const DUPLICATE_REQUEST_MS = 10_000;
/** A `commandId` is remembered for at least its `resultWithinMs`, and never less than this. */
export const COMMAND_MEMORY_MS = 60_000;
/** A leave not done within this cuts the connection: the broker may be away. Kept on the bridge's clock. */
export const LEAVE_MS = 4_000;
export { SAVE_MS, STORE_RETRY_CEILING_MS, STORE_RETRY_MS } from "./keeping.js";
/** The read-back is started this long before it must be out (GA-BRIDGE-34's bound less 1 s): a read's own time (⚠️ a guess, the PC bridge's). */
export const READ_BACK_LEAD_MS = 1_000;
/**
 * The ack of a command whose handling threw unexpectedly: the throw may come after the doer was
 * handed it, and once anything was transmitted the standard allows only `no_confirmation` (the PC
 * bridge's ruling).
 */
export const UNEXPECTED_ACK_REASON = "no_confirmation";
/** The reply's reason for a request whose handling threw unexpectedly: one of the standard's "another reason". */
export const UNEXPECTED_REPLY_REASON = "bridge_error";
/** A frame received again with the same `frameId` and payload within this is one occurrence (GA-BRIDGE-75, ⚠️ the standard's guess). */
export const OCCURRENCE_REPEAT_MS = 10_000;
/** At most this many undescribed names are kept for one device (GA-BRIDGE-76). */
export const UNDESCRIBED_MAX = 32;
/** The hardware the bridge's `invalid_description` fault names, at most; the rest are counted. */
const REFUSED_NAMED = 8;
export { LONGEST_REACH_MS } from "./declaring.js";
/** A Zigbee join window's cap (GA-BRIDGE-25, *Constants*). */
export const JOIN_CAP_MS = 254_000;
/** The fault naming a device whose removal the doer rejected: the removal stays pending until a `remove` with `force`. */
export const REMOVE_REFUSED = "remove_refused";
/** The form of an undescribed name (GA-BRIDGE-76). */
const UNDESCRIBED_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The negative subjects this build implements (bridge, *Negative subjects*), each one switch in the core. */
export const MUTATIONS = [
  "publishes-an-undescribed-key", "retains-an-occurrence", "replays-an-occurrence", "misnames-an-extension",
  "keeps-a-stale-description", "leaves-retained-state", "reuses-id-on-join",
  "restamps-partial-read", "stamps-the-future", "echoes-commanded-state", "restamps-check-in", "skips-seq",
  "double-acks", "unreachable-late", "unreachable-after-transmit", "runs-expired-commands", "applied-before-confirmation",
  "one-fault-stops-all", "no-read-back",
  "online-before-subscribed", "acts-on-retained-request", "ignores-refusals",
  "exits-on-fault", "reloads-without-graceful", "ignores-snapshot", "forgets-on-restart",
  "serves-on-mismatch", "inflates-the-bound", "guesses-the-bound", "hides-other-admins", "claims-protocol-class",
  "hides-native-control", "pin-on-the-wire", "status-without-roster",
  "window-never-closes", "ignores-near", "forgets-the-blocklist", "provisions-the-wrong-way",
  "stamps-publication-time", "holds-back-silently", "holds-back-again-after-restart", "declares-after-the-reading",
  "publishes-an-unconfirmed-setting", "forgets-a-confirmed-setting", "drops-a-setting-on-a-rejoin",
  "keeps-a-setting-through-an-interview", "repeats-the-undescribed-event",
  // Describing's (`DESCRIBE_MUTATIONS`), honoured in the doer's describing, not here.
  "maps-motion-to-occupancy", "holds-back-the-leak",
  // The link's (`LINK_MUTATIONS`), honoured in the doer's link, not here.
  "resets-on-connect", "up-without-exchange",
] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** Under `online-before-subscribed`, how long after its `status` the bridge subscribes, on its clock. */
const SUBSCRIBE_LATE_MS = 2_000;
/** Under `guesses-the-bound`, the bound a closed device gets when the doer knows none: the scripted fixture's old guess. */
const GUESSED_BOUND_MS = 60_000;
/** Under `unreachable-late`, how long after its receipt a command on a down coordinator is acked, on the bridge's clock. */
const UNREACHABLE_LATE_MS = 2_000;
/** Under `replays-an-occurrence`, where the occurrences published are kept, to publish again at the next start. */
const REPLAY_META = "mutation.occurrences";

export interface ZigbeeBridgeOptions {
  bridgeId: string;
  instanceId: string;
  root: string;
  clock: Clock;
  doer: DoerPort;
  wire: Wire;
  store: DeviceStore;
  /** Only under a run (GA-BRIDGE-16). */
  runId?: string;
  /** A negative mutation, honoured only with a run id. */
  mutation?: Mutation;
  /** How `exits-on-fault` exits; the process's own exit unless given. */
  exit?: (code: number) => void;
}

type Ack = { commandId: string; source: string; result: string; reason?: string; detail?: string; timestamp: string };
type Reply = { requestId: string; op: string; status: string; data?: unknown; reason?: string };
type Fault = { code: string; topic?: string; device?: string; detail?: string };
/** A join window open now (GA-BRIDGE-25): its effective time, every device a `joined` named while it was open, and its timer. */
type Window = { windowMs: number; devices: string[]; timer: number };
type Life = "running" | "stopped";
const wireTime = (ms: number) => new Date(ms).toISOString();

/** Under `publishes-an-unconfirmed-setting`, the value a setting never confirmed is published as: its schema's first, else its type's. */
function unconfirmedValue(type: string, d: Description, key: string): unknown {
  const schema = (d.extensions ?? []).flatMap((e) => e.keys ?? []).find((k) => k.key === key)?.schema as { enum?: unknown[] } | undefined;
  if (schema?.enum?.length) return schema.enum[0];
  return type === "number" ? 0 : type === "boolean" ? false : "default";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const message = (err: unknown) => String((err as Error)?.message ?? err);

/** The reference Zigbee bridge at level Serve: the standard's rules over a doer port. */
export class ZigbeeBridge {
  private readonly base: string;
  private readonly faults: Fault[] = [];
  private readonly commands = new Map<string, { ack?: Ack; keepUntil: number }>();
  private readonly requests = new Map<string, { reply?: Reply; keepUntil: number }>();
  private readonly timers = new Set<number>();
  /** The command and request handlers running: what a leave waits for, and nothing else. */
  private readonly deliveries = new Set<Promise<unknown>>();
  /** Each command waiting on the doer, ended at once when the bridge leaves (GA-BRIDGE-22). */
  private readonly waits = new Set<() => void>();
  private readonly byHw = new Map<HardwareId, Device>();
  private readonly byId = new Map<string, Device>();
  /** Hardware admitted, its `joined` sent, whose description has not come yet: in no `devices` until it does. */
  private readonly pending = new Map<HardwareId, StoredDevice>();
  /**
   * The PINs for remote operation the owner configured, by device id: the bridge's own configuration,
   * never published (GA-BRIDGE-36). Keyed by the id, not the hardware, so that a new admission under
   * the same address, which gets a new id (GA-BRIDGE-35), is never handed the lock's PIN.
   */
  private readonly pins = new Map<string, string>();
  /** The native ways the doer cannot disable, as it last reported them (GA-BRIDGE-32). */
  private ungovernedWays: string[] = [];
  /** Retained statuses of devices taken out before the start's first `devices`, cleared with it. */
  private readonly clears = new Set<string>();
  /** Under `declares-after-the-reading`, devices whose next `devices` waits for their next status. */
  private readonly devicesAfterStatus = new Set<string>();
  /** Descriptions refused at the port for hardware with no device id yet, and why: the bridge's `invalid_description` fault. */
  private readonly refused = new Map<string, string>();
  /** Hardware refused while the store was away, and the device it had: the bridge's `admission_refused` fault, until it is admitted again. */
  private readonly admissionsRefused = new Map<string, string>();
  private transport: { state: TransportState; since: number; retryIntervalMs?: number };
  private doerChain: Promise<void> = Promise.resolve();
  /** What waits for the store while it is away, and its retry (the design, *The store*). */
  private readonly keep: Keeping;
  private leaving?: Promise<void>;
  private stalledUntil = 0;
  private life: Life = "running";
  /** Set when the start reaches its first `devices`: nothing is published before it. */
  private publishing = false;
  /** What `devices` last carried, so that a change goes out and nothing else does. */
  private devicesShown?: string;
  /** Events' `seq`, from 1 in each instance (GA-BRIDGE-33). */
  private seq = 0;
  /** The join window open now, if any (GA-BRIDGE-25). */
  private window?: Window;
  /** The blocklist, by hardware id, with when each was put there (GA-BRIDGE-27): read from the store at the start, written to it first. */
  private readonly blocked = new Map<HardwareId, number>();
  /** Each hardware being removed, and whether with `force`: a second `remove` waits for the first, unless it adds `force`. */
  private readonly removing = new Map<HardwareId, { force: boolean }>();
  /** The device ids a `left` named in this instance: a removal's end names one only if nothing did. */
  private readonly leftIds = new Set<string>();
  /** The doer's `join` and `joinClose` calls, each made once the one before it settled (the window rule needs them in order). */
  private windowCalls: Promise<unknown> = Promise.resolve();
  /** Under `one-fault-stops-all`, every command waits for the one before it, whatever its device. */
  private commandLine: Promise<void> = Promise.resolve();
  private readonly mutation?: Mutation;

  constructor(private readonly o: ZigbeeBridgeOptions) {
    this.base = `${o.root}/bridges/${o.bridgeId}`;
    // Down until the doer reports an exchange (GA-BRIDGE-23).
    this.transport = { state: "down", since: o.clock.now() };
    this.mutation = o.runId ? o.mutation : undefined;
    this.keep = new Keeping({
      store: o.store,
      clock: o.clock,
      running: () => this.life === "running",
      devices: () => this.byId.values(),
      fault: (detail) => {
        const changed = detail === null ? this.clearFault("store_fault") : this.setFault({ code: "store_fault", detail });
        if (changed) this.track(this.publishStatus());
        // What must survive a restart is never done from memory: an open window is closed (the design, *The store*).
        if (detail !== null && this.window) this.queue(() => this.endWindow(this.window));
      },
      enqueue: (fn) => { this.doerChain = this.doerChain.then(fn).catch((e) => console.error(`store: ${e}`)); },
      readmit: (hw, held) => this.readmit(hw, held),
    });
  }

  private get filters(): string[] {
    return [`${this.base}/devices/+/command`, `${this.base}/request/+`];
  }

  /**
   * Subscribes before the first `status` (GA-BRIDGE-18), clears `lwt`, starts the doer with each
   * device's kept settings (GA-BRIDGE-74) and takes every device it describes, then `devices`, the
   * devices' statuses and `status`.
   */
  async start(): Promise<void> {
    this.o.wire.onMessage((d) => this.trackDelivery(this.onDelivery(d, this.o.clock.now())));
    this.o.wire.onReconnect(() => this.track(this.reconnected()));
    if (this.mutation !== "online-before-subscribed") await this.subscribe();
    await this.publish(`${this.base}/lwt`, "", true);
    const settings = new Map(this.o.store.devices().map((s) => [s.hardwareId,
      Object.fromEntries(Object.entries(this.o.store.settings(s.deviceId)).map(([k, v]) => [k, v.value]))]));
    // The blocklist survives a restart (GA-BRIDGE-31): taken before the doer starts, because a doer
    // may ask about hardware while it starts (herdsman raises join indications as its network
    // resumes, plan 3b), and blocked hardware asked about before the list is read would be let in.
    if (this.mutation !== "forgets-on-restart") for (const b of this.o.store.blocked()) this.blocked.set(b.hardwareId, b.since);
    const reported = this.mutation === "holds-back-again-after-restart" ? new Map<HardwareId, string[]>()
      : new Map(this.o.store.devices().map((s) => [s.hardwareId, this.o.store.reported(s.deviceId)]));
    await this.o.doer.start(this.events(), settings, reported);
    // Every description the start brought is taken, its admission written, before anything goes out.
    await this.doerChain;
    this.publishing = true;
    await this.publishDevices(true);
    for (const id of this.clears) await this.publish(`${this.base}/devices/${id}/status`, "", true);
    this.clears.clear();
    for (const dev of this.byId.values()) await this.publishDeviceStatus(dev);
    await this.publishStatus();
    // Blocked hardware the bridge still has (a removal a restart cut off) is removed again, so that
    // the `remove` ends in its `left` and the hardware is out of the network (GA-BRIDGE-27).
    for (const hw of this.blocked.keys()) {
      const id = this.deviceIdOf(hw);
      if (id !== undefined) this.removal(hw, id, false);
    }
    if (this.mutation === "replays-an-occurrence") await this.replayOccurrences();
    if (this.mutation === "online-before-subscribed") this.later(() => this.subscribe(), SUBSCRIBE_LATE_MS);
    this.startTimers();
  }

  /** A restart or a reload: GA-BRIDGE-22's order, then the doer stops. */
  async stop(): Promise<void> {
    if (this.life === "stopped") return;
    this.life = "stopped";
    if (this.mutation === "reloads-without-graceful") {
      // No unsubscribe, no ack for a command in flight, no graceful offline: the connection is cut and its will fires.
      // The check-ins are still saved: the mutation drops the goodbye, not the data (GA-BRIDGE-31, 37).
      this.clearTimers();
      await this.keep.saveCheckIns().catch((err) => console.error(`save: ${err}`));
      await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
      await this.o.doer.stop();
      return;
    }
    this.leaving = this.leave();
    await this.leaving.catch(() => {});
    this.keep.stop();
    await this.o.doer.stop();
  }

  /**
   * The owner sets a lock's PIN in the bridge's own configuration (GA-BRIDGE-36), outside the binding,
   * naming the lock by the device id `devices` gives it; the test transport stands in for it. It
   * takes effect when the device is next described, and only for that admission of the hardware.
   */
  setPin(deviceId: string, pin: string): void {
    this.pins.set(deviceId, pin);
  }

  /**
   * The owner's PIN for the lock now at the hardware: set under the device id the hardware has now.
   * False when it has none (unknown, or a new admission of it waiting for the store).
   */
  setPinFor(hw: HardwareId, pin: string): boolean {
    const id = this.deviceIdOf(hw);
    if (id === undefined) return false;
    this.setPin(id, pin);
    return true;
  }

  /** The device id the hardware has now: described, admitted and waiting for its description, or kept in the store. */
  deviceIdOf(hw: HardwareId): string | undefined {
    if (this.keep.held.has(hw)) return undefined;
    return this.byHw.get(hw)?.id ?? this.pending.get(hw)?.deviceId
      ?? (this.keep.removals.has(hw) ? undefined : this.o.store.device(hw)?.deviceId);
  }

  /** Whether the start reached its first `devices`: from then on a stop leaves in GA-BRIDGE-22's order. */
  get announced(): boolean {
    return this.publishing;
  }

  /** The harness's `stall`: the main loop waits, as a hung loop would (real time). */
  stall(ms: number): void {
    this.stalledUntil = Date.now() + ms;
  }

  /**
   * GA-BRIDGE-22: unsubscribe and wait, answer every command in flight, a graceful `offline`,
   * `lwt` cleared, a clean disconnect; bounded by LEAVE_MS, then the connection is cut.
   */
  private async leave(): Promise<void> {
    this.clearTimers();
    const cut = { value: false };
    const saved = this.keep.leaving();
    if (await this.within(Promise.all([saved, this.leaveInOrder(cut)]), LEAVE_MS)) return;
    cut.value = true;
    console.error(`leave: not done within ${LEAVE_MS} ms; the connection is cut`);
    this.endWaits();
    await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
  }

  /** Every command waiting on the doer is answered now: it was handed to the doer, so `failed(no_confirmation)`. */
  private endWaits(): void {
    for (const end of this.waits) end();
  }

  /** The leave's steps; with the broker away, only the waits that need no broker (its will has fired already). */
  private async leaveInOrder(cut: { value: boolean }): Promise<void> {
    if (this.o.wire.connected()) {
      await this.o.wire.unsubscribe(this.filters).catch((err) => console.error(`unsubscribe: ${err}`));
    }
    // After the UNSUBACK, an open window is closed with its window_closed, before the doer stops (GA-BRIDGE-22).
    await this.endWindow(this.window, { leaving: true });
    // After the UNSUBACK, as a command in flight is answered (GA-BRIDGE-22).
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

  // --- What the doer says -----------------------------------------------------------------------

  /** The doer's events, handled one at a time in the order they came (GA-BRIDGE-74's order on the wire). */
  private events(): DoerEvents {
    const queue = (fn: () => Promise<void>) => this.queue(fn);
    // A time that is no number would stop every later status: the message is dropped at the port.
    const timed = (what: string, time: number, fn: () => Promise<void>) => {
      if (Number.isFinite(time)) queue(fn);
      else console.error(`doer: ${what} with no time (${time}), dropped`);
    };
    return {
      described: (d) => queue(() => this.described(d)),
      observed: (hw, readings, time, checkIn) => timed("an observation", time, () => this.observed(hw, readings, time, checkIn)),
      occurred: (hw, key, value, time, frameId) => timed("an occurrence", time, () => this.occurred(hw, key, value, time, frameId)),
      undescribed: (hw, names) => queue(() => this.undescribedNames(hw, names)),
      transport: (state, since, retryIntervalMs) => timed("a transport's change", since,
        () => this.transportChanged(state, since, retryIntervalMs)),
      fault: (code, detail) => queue(() => this.doerFault(code, detail)),
      ungoverned: (ways) => queue(() => this.ungovernedChanged(ways)),
      admitted: (hw, how) => queue(() => this.admitted(hw, how)),
      mayAdmit: (hw) => {
        const may = this.mayAdmit(hw);
        if (!may) queue(() => this.publishStatus());
        return may;
      },
      left: (hw) => queue(() => this.left(hw)),
      interviewed: (hw) => queue(() => this.interviewed(hw)),
    };
  }

  /** Runs `fn` on the doer's event chain, after every event before it. */
  private queue(fn: () => Promise<void>): void {
    this.doerChain = this.doerChain.then(fn).catch((err) => console.error(`doer: ${err}`));
  }

  /**
   * The doer says how the hardware came in (GA-BRIDGE-35). An association, or a trust-centre rejoin
   * under the key everyone knows, is a new admission whatever identifier the hardware shows: a
   * device id never used, and a `joined` event; a device of the hardware already in `devices` leaves
   * it. A secured rejoin, or one under the device's own key, is new only for hardware with no device:
   * one described, admitted and waiting for its description, or kept in the store (its removal not
   * yet written among them) is still in `devices` (plan 3b review, gap b). Its description comes next. Hardware held back for the store stays one admission: a later
   * indication joins the hold, and one that is new whatever the hardware has makes the held one so.
   */
  private async admitted(hw: HardwareId, how: Admission, d?: Description, previous?: string): Promise<void> {
    const held = this.keep.held.get(hw);
    if (held) {
      if (how === "association" || how === "tcRejoinWellKnown") held.how = how;
      return;
    }
    const known = this.byHw.has(hw) || this.pending.has(hw) || (!this.keep.removals.has(hw) && this.o.store.device(hw) !== undefined);
    if (known && how !== "association" && how !== "tcRejoinWellKnown") {
      // A secured rejoin is no interview: what was kept stays. The mutation drops it as if it were one.
      const dev = this.byHw.get(hw);
      if (dev && this.mutation === "drops-a-setting-on-a-rejoin") await this.dropKeptSettings(dev);
      return;
    }
    const stored = await this.admit(hw, how, d, previous);
    if (!stored) return;
    this.pending.set(hw, stored);
    // Refused while it had no id: the refusal now names its device.
    const why = this.refused.get(hw);
    if (why !== undefined) {
      this.refusedChanged(hw, undefined);
      this.setFault({ code: "invalid_description", device: stored.deviceId, detail: why });
      await this.publishStatus();
    }
  }

  /**
   * Whether hardware coming in may be admitted now (`DoerEvents.mayAdmit`; the maintainer's ruling,
   * 2026-10-04): not while the store is away when the bridge has a device for it, described,
   * admitted and waiting for its description, kept in the store (its removal not yet written among
   * them), or taken out of use by an admission held for the store. The store could not keep the new
   * id, and a restart before it does would hand the hardware the old one, with a PIN configured for
   * it (GA-BRIDGE-35, 36). The refusal is named in `admission_refused` until the hardware is admitted.
   */
  private mayAdmit(hw: HardwareId): boolean {
    // Blocked hardware is kept out, in a window or not, and the refusal is named (GA-BRIDGE-27).
    if (this.keepsOut(hw)) {
      console.error(`doer: ${hw} came in again, and is blocked: turned away`);
      this.queue(() => this.publishEvent("blocked_rejoin", { identifier: hw }));
      return false;
    }
    const storeAway = this.keep.retryDue || this.faults.some((f) => f.code === "store_fault");
    if (!storeAway) return true;
    const id = this.byHw.get(hw)?.id ?? this.pending.get(hw)?.deviceId ?? this.keep.removals.get(hw)
      ?? this.o.store.device(hw)?.deviceId ?? this.keep.held.get(hw)?.previous;
    if (id === undefined) return true;
    console.error(`doer: ${hw} came in again while the store is away: refused, as ${id} could not be kept apart from it`);
    this.admissionsRefused.set(hw, `the hardware of ${id} came in again while the store was away; pair it again once the store is back`);
    this.namedFault("admission_refused", this.admissionsRefused);
    return false;
  }

  /** Whether blocked hardware is kept out now: always, but under `forgets-the-blocklist` only while a window is open. */
  private keepsOut(hw: HardwareId): boolean {
    return this.blocked.has(hw) && (this.mutation !== "forgets-the-blocklist" || this.window !== undefined);
  }

  /**
   * Blocked hardware a doer brought in without asking (`mayAdmit`) is turned away by the core
   * itself: a `blocked_rejoin`, and the doer asked to remove it, never an admission (GA-BRIDGE-27).
   */
  private async turnAway(hw: HardwareId): Promise<void> {
    console.error(`doer: ${hw} came in without being asked about, and is blocked: removed again`);
    await this.publishEvent("blocked_rejoin", { identifier: hw });
    const id = this.deviceIdOf(hw);
    if (id !== undefined) this.removal(hw, id, false);
    else this.o.doer.remove(hw, false).catch((err) => console.error(`remove of ${hw}: ${message(err)}`));
  }

  /**
   * A new admission of the hardware: written to the store first, then the old device of the hardware
   * taken out and `joined` sent. While a store retry is pending the store is not tried, and the
   * hardware is held back with how it came and its description, for the retry (the design, *The
   * store*). Undefined when it was held back. The old device of held-back hardware is taken out at
   * once, as a leave is: its actions would reach the hardware the new admission now is (a lock's
   * unlock, with its PIN, to whatever joined under its address).
   */
  private async admit(hw: HardwareId, how: Admission, d?: Description, given?: string): Promise<StoredDevice | undefined> {
    // The core's own guard: blocked hardware is never admitted, whatever the doer asked.
    if (this.keepsOut(hw)) {
      await this.turnAway(hw);
      return undefined;
    }
    const old = this.byHw.get(hw);
    const previous = old?.id ?? this.pending.get(hw)?.deviceId ?? this.keep.removals.get(hw) ?? given ?? null;
    // The previous id goes out of use: no refusal of its description stands.
    const outOfUse = async () => {
      const cleared = previous !== null && this.clearFault("invalid_description", undefined, previous);
      if (old) await this.takeOut(old);
      else if (cleared) await this.publishStatus();
    };
    const holdBack = async () => {
      const keep = d ?? this.keep.held.get(hw)?.d;
      this.keep.held.set(hw, { how, ...(keep ? { d: keep } : {}), ...(previous !== null ? { previous } : {}) });
      await outOfUse();
    };
    if (this.keep.retryDue) {
      await holdBack();
      return undefined;
    }
    let stored: StoredDevice;
    if (this.mutation === "reuses-id-on-join" && previous !== null) {
      stored = { deviceId: previous, hardwareId: hw, admission: 0, lastCheckIn: null };
    } else {
      try {
        stored = await this.o.store.admit(hw, previous);
      } catch (err) {
        this.keep.failed(err);
        await holdBack();
        return undefined;
      }
    }
    this.pending.delete(hw);
    // The admission took the hardware's earlier row out of use: no removal waits for it.
    this.keep.removals.delete(hw);
    // Paired again: a refusal of it while the store was away is done with.
    if (this.admissionsRefused.delete(hw)) this.namedFault("admission_refused", this.admissionsRefused);
    await outOfUse();
    await this.publishEvent("joined", { device: stored.deviceId });
    // Every device that joined while a window was open is named in its window_closed (GA-BRIDGE-25).
    this.window?.devices.push(stored.deviceId);
    this.keep.ok();
    return stored;
  }

  /** Hardware held back for the store, admitted on its retry, with its description taken as the doer's would be. */
  private async readmit(hw: HardwareId, held: Held): Promise<void> {
    await this.admitted(hw, held.how, held.d, held.previous);
    if (!this.keep.held.has(hw) && held.d) await this.described(held.d);
  }

  /**
   * The device's interview is done, its model and capabilities known: `interviewed` names it, where
   * the hardware has an id (*Provisioning*). A device interviewed again may carry other firmware or have
   * been reset: every kept setting of it is dropped, until each is reported (GA-BRIDGE-79).
   */
  private async interviewed(hw: HardwareId): Promise<void> {
    const id = this.deviceIdOf(hw);
    if (id !== undefined) await this.publishEvent("interviewed", { device: id });
    const dev = this.byHw.get(hw);
    if (!dev || this.mutation === "keeps-a-setting-through-an-interview") return;
    await this.dropKeptSettings(dev);
  }

  /** Every kept setting of the device dropped, from the store and from its status (GA-BRIDGE-79). */
  private async dropKeptSettings(dev: Device): Promise<void> {
    this.keep.forgetSettings(dev.id);
    this.keep.flushSettings();
    let dropped = false;
    for (const k of dev.d.settings ?? []) dropped = dev.values.delete(k) || dropped;
    if (!dropped) return;
    // The retained status must stop carrying what was dropped. With no reading left it is never
    // cleared: an empty retained status is a removal (GA-BRIDGE-21), and the device is still listed.
    // It goes out with no reading, stamped with the interview, the last exchange observed (GA-BRIDGE-1).
    if (dev.values.size) await this.publishDeviceStatus(dev);
    else await this.publishBareStatus(dev, this.o.clock.now());
  }

  /** A device's status with no reading, stamped `at`: its readings all dropped while it stays listed. */
  private async publishBareStatus(dev: Device, at: number): Promise<void> {
    if (!this.publishing || this.life !== "running") return;
    await this.publish(`${this.base}/devices/${dev.id}/status`, { deviceId: dev.id, timestamp: wireTime(at), available: true }, true);
  }

  /**
   * The hardware left (GA-BRIDGE-21): its device leaves `devices` and the roster, its retained status
   * cleared, and `left` names it. The removal is written to the store first; while the store is away
   * the device still leaves, and the removal is written when the store is back.
   */
  private async left(hw: HardwareId): Promise<void> {
    this.keep.held.delete(hw);
    const refusalCleared = this.descriptionTaken(hw);
    const dev = this.byHw.get(hw);
    const pending = this.pending.get(hw);
    this.pending.delete(hw);
    const stored = this.keep.removals.has(hw) ? undefined : this.o.store.device(hw);
    if (!dev && !pending && !stored) {
      if (refusalCleared) await this.publishStatus();
      return;
    }
    const id = dev?.id ?? pending?.deviceId ?? stored!.deviceId;
    // Out of the network: no removal of it waits any more, and none is refused.
    this.removing.delete(hw);
    const removeCleared = this.clearFault(REMOVE_REFUSED, undefined, id);
    if (this.keep.retryDue) {
      this.keep.removals.set(hw, id);
    } else {
      try {
        await this.o.store.remove(hw);
      } catch (err) {
        this.keep.removals.set(hw, id);
        this.keep.failed(err);
      }
    }
    if (dev) await this.takeOut(dev);
    // Never described in this instance (it left before the doer described it, or while the doer
    // started: a leave the store missed, which the doer reports at its start). The status an earlier
    // instance retained for it is cleared all the same (GA-BRIDGE-21).
    else if (this.publishing) await this.publish(`${this.base}/devices/${id}/status`, "", true);
    else this.clears.add(id);
    // Taken out, the device's status went out with it; never described, its refusal's end goes out here.
    if (!dev && (refusalCleared || removeCleared)) await this.publishStatus();
    await this.publishEvent("left", { device: id });
    this.leftIds.add(id);
  }

  /**
   * A description refused at the port, named for the owner in an `invalid_description` fault (the
   * bridge's own code): on the device, when the hardware has an id (described, admitted and waiting
   * for its description, or kept in the store); otherwise on the bridge, naming the hardware.
   */
  private async refuseDescription(hw: HardwareId | undefined, why: string): Promise<void> {
    // No hardware to name: nothing could clear a fault for it, so it is only logged.
    if (hw === undefined) return;
    // Held back for the store, the hardware has no id yet, and its older description is no longer
    // what it can do: the retry admits it to wait for one the port can take.
    const held = this.keep.held.get(hw);
    if (held) delete held.d;
    const id = this.deviceIdOf(hw);
    if (id !== undefined) this.setFault({ code: "invalid_description", device: id, detail: why });
    else this.refusedChanged(hw, why);
    await this.publishStatus();
  }

  /** The hardware's description taken, or the hardware gone: no refusal of it stands, on any id it had. True when the faults changed. */
  private descriptionTaken(hw: HardwareId): boolean {
    const ids = [this.byHw.get(hw)?.id, this.pending.get(hw)?.deviceId, this.keep.removals.get(hw),
      this.o.store.device(hw)?.deviceId, this.keep.held.get(hw)?.previous];
    let cleared = false;
    for (const id of new Set(ids)) if (id !== undefined && this.clearFault("invalid_description", undefined, id)) cleared = true;
    if (!this.refused.has(hw)) return cleared;
    this.refusedChanged(hw, undefined);
    return true;
  }

  /** The bridge's refusal fault for a description of hardware with no id. */
  private refusedChanged(hw: string, why: string | undefined): void {
    if (why === undefined) this.refused.delete(hw);
    else this.refused.set(hw, why);
    this.namedFault("invalid_description", this.refused);
  }

  /** A fault of the bridge naming hardware: at most REFUSED_NAMED named, each id cut to 64 characters, the rest counted. */
  private namedFault(code: string, named: Map<string, string>): void {
    const all = [...named];
    const shown = all.slice(0, REFUSED_NAMED).map(([h, w]) => `${h.length > 64 ? `${h.slice(0, 61)}...` : h}: ${w}`);
    if (all.length > REFUSED_NAMED) shown.push(`and ${all.length - REFUSED_NAMED} more`);
    const detail = shown.join("; ");
    const i = this.faults.findIndex((x) => x.code === code && x.device === undefined);
    if (i >= 0) this.faults.splice(i, 1);
    if (detail) this.faults.push({ code, detail });
  }

  /** The device leaves `devices` and the roster, its retained status cleared with an empty payload (GA-BRIDGE-21). */
  private async takeOut(dev: Device): Promise<void> {
    this.byHw.delete(dev.hw);
    this.byId.delete(dev.id);
    this.clearFault("invalid_description", undefined, dev.id);
    this.clearFault("invalid_extension", undefined, dev.id);
    this.clearFault("pin_missing", undefined, dev.id);
    await this.publishDevices();
    if (this.mutation !== "leaves-retained-state") {
      if (this.publishing) await this.publish(`${this.base}/devices/${dev.id}/status`, "", true);
      else this.clears.add(dev.id);
    }
    await this.publishStatus();
  }

  /**
   * A device described. Hardware admitted, or kept in the store, takes its device id; other hardware
   * is a new admission, as an association (GA-BRIDGE-35), and hardware held back for the store, known
   * or not, waits with it. A known device takes its new declarations (GA-BRIDGE-74): the `devices` that carries
   * them goes out before anything the doer sends after them. A new device takes its settings as last
   * kept, and publishes them (GA-BRIDGE-74).
   */
  private async described(d: Description): Promise<void> {
    // A description the port cannot take is never taken: a device it would add is not admitted, and
    // a device it would change keeps its entry but is offered no action, since what it can do is no
    // longer known (fails closed).
    const wrong = descriptionProblem(d);
    if (wrong) {
      const hw = (d as { hardwareId?: unknown } | null)?.hardwareId;
      console.error(`doer: a description of ${String(hw)} not taken: ${wrong}`);
      const known = typeof hw === "string" ? this.byHw.get(hw) : undefined;
      if (known?.d.actions.length) {
        known.d = { ...known.d, actions: [] };
        await this.publishDevices();
      }
      await this.refuseDescription(typeof hw === "string" && hw ? hw : undefined, wrong);
      return;
    }
    const hw = d.hardwareId;
    this.descriptionTaken(hw);
    // Held back for the store, known hardware too (a new admission of it): the description waits
    // with it, for the device the retry admits, not the old one.
    const held = this.keep.held.get(hw);
    if (held) {
      held.d = d;
      return;
    }
    let dev = this.byHw.get(hw);
    if (dev && this.mutation === "keeps-a-stale-description") return;
    // The device's status goes out again when its readings changed: settings taken, or keys dropped.
    const readings = dev?.values.size ?? 0;
    const fresh = !dev;
    if (!dev) {
      let stored = this.pending.get(hw) ?? (this.keep.removals.has(hw) ? undefined : this.o.store.device(hw));
      stored ??= await this.admit(hw, "association", d);
      if (!stored) return;
      this.pending.delete(hw);
      const now = this.o.clock.now();
      const keptCheckIn = this.mutation === "forgets-on-restart" ? null : stored.lastCheckIn;
      const lastCheckIn = this.mutation === "restamps-check-in" && keptCheckIn !== null ? now : keptCheckIn;
      const undescribed = this.o.store.undescribed(stored.deviceId).map((u) => ({ name: u.name, firstSeen: u.at }));
      dev = { id: stored.deviceId, hw, d, keys: new Map(), events: new Map(), values: new Map(), undescribed,
        frames: new Map(), lastCheckIn, observable: { value: false, since: now }, savedAt: stored.lastCheckIn,
        unsaved: false };
      // Declared before it enters the maps: a declaration that throws leaves no device whose raw
      // description the next `devices` would carry (GA-BRIDGE-77).
      this.declare(dev, d);
      this.byHw.set(hw, dev);
      this.byId.set(dev.id, dev);
      const kept = this.mutation === "forgets-a-confirmed-setting" ? {} : this.o.store.settings(dev.id);
      for (const k of d.settings ?? []) {
        const s = kept[k];
        const type = dev.keys.get(k);
        if (s && type && fits(type, s.value)) dev.values.set(k, { value: s.value, at: s.at, seenAt: s.at });
        // `publishes-an-unconfirmed-setting`: a setting never confirmed published as a value of its type.
        else if (!s && type && this.mutation === "publishes-an-unconfirmed-setting") {
          dev.values.set(k, { value: unconfirmedValue(type, d, k), at: now, seenAt: now });
        }
      }
    } else {
      // An awaited key the new description declares was reported: kept, so it is never held back again (GA-BRIDGE-80).
      const awaited = dev.d.awaitedKeys ?? [];
      this.declare(dev, d);
      const declaredNow = awaited.filter((k) => !(d.awaitedKeys ?? []).includes(k));
      for (const k of declaredNow) this.keep.reported(dev.id, k, this.o.clock.now());
      this.keep.flushSettings();
      // `declares-after-the-reading`: the devices that declares a held-back key waits for its first value's status.
      if (declaredNow.length && this.mutation === "declares-after-the-reading") this.devicesAfterStatus.add(dev.id);
    }
    this.refreshDevice(dev, this.o.clock.now());
    if (!this.devicesAfterStatus.has(dev.id)) await this.publishDevices();
    // `repeats-the-undescribed-event`: every name kept from before the start announced again.
    if (fresh && this.mutation === "repeats-the-undescribed-event") {
      for (const u of dev.undescribed) await this.publishEvent("undescribed", { device: dev.id, name: u.name });
    }
    if (dev.values.size !== readings) await this.publishDeviceStatus(dev);
    // The roster gained the device, or its entry changed (or its faults did): the status follows
    // `devices` (GA-BRIDGE-17, GA-BRIDGE-38).
    await this.publishStatus();
  }

  /**
   * Takes a description as the device's declarations (`declaration`), naming in a fault for the
   * device an extension left out (`invalid_extension`, GA-BRIDGE-77) or an unlock withheld
   * (`pin_missing`, GA-BRIDGE-36). Readings of keys it no longer declares are dropped, and names it
   * now declares are no longer undescribed.
   */
  private declare(dev: Device, given: Description): void {
    // A PIN the doer will not hand a lock is no usable PIN (plan 2c-2 review I3).
    const withheld = this.o.doer.withholdsPins;
    const configured = this.pins.has(dev.id);
    const r = declaration(given, { misnames: this.mutation === "misnames-an-extension", hasPin: configured && withheld === undefined });
    if (r.invalid.size) {
      console.error(`${dev.id}: extensions left out: ${[...r.invalid.values()].join("; ")}`);
      this.setFault({ code: "invalid_extension", device: dev.id, detail: [...r.invalid].map(([c, why]) => `${c}: ${why}`).join("; ") });
    } else {
      this.clearFault("invalid_extension", undefined, dev.id);
    }
    // A lock that requires a PIN the bridge does not hold: a fault says why its unlock is not offered.
    if (r.pinMissing) {
      this.setFault({ code: "pin_missing", device: dev.id, detail: configured && withheld !== undefined
        ? `the lock requires a PIN for remote operation; one is configured, but ${withheld}, so unlock is not offered`
        : "the lock requires a PIN for remote operation, and none is configured, so unlock is not offered" });
    } else {
      this.clearFault("pin_missing", undefined, dev.id);
    }
    if (r.outOfReach) console.error(`${dev.id}: reached only within ${given.reachMs} ms, so offered no action`);
    const d = r.d;
    dev.d = d;
    const ext = extensionKeys(d.extensions);
    dev.keys = new Map([...declaredKeys(d.capabilities, d.sensorKeys), ...ext.state]);
    dev.events = ext.events;
    for (const k of [...dev.values.keys()]) if (!dev.keys.has(k)) dev.values.delete(k);
    // Names it now declares are no longer undescribed (GA-BRIDGE-76).
    const gone = dev.undescribed.filter((u) => dev.keys.has(u.name) || dev.events.has(u.name));
    if (gone.length) {
      dev.undescribed = dev.undescribed.filter((u) => !gone.includes(u));
      for (const u of gone) this.keep.undescribed(dev.id, u.name, null);
      this.keep.flushSettings();
    }
  }

  /**
   * Readings from a device: each a key the device declares as `state`, of its type, stamped with the
   * device message's time (GA-BRIDGE-1). A key it does not declare is listed in its `undescribed`
   * and never published (GA-BRIDGE-76); an `event` key is never a reading, and a value of the
   * wrong type is left out. A check-in moves `lastCheckIn` (GA-BRIDGE-37); a reading changed goes
   * out within the second.
   */
  private async observed(hw: HardwareId, readings: Record<string, unknown>, time: number, checkIn: boolean): Promise<void> {
    const dev = this.byHw.get(hw);
    // Hardware not described, or not admitted: there is no device to stamp it on.
    if (!dev) return;
    const now = this.o.clock.now();
    // Never ahead of the bridge's own clock (GA-BRIDGE-3).
    const at = this.mutation === "stamps-the-future" ? time : Math.min(time, now);
    // When it reached the bridge, never the device's own stamp (GA-BRIDGE-37).
    if (checkIn && dev.d.feedback === "closed") this.keep.checkedIn(dev, this.mutation === "stamps-the-future" ? at : now);
    let changed = false;
    const unnamed: string[] = [];
    for (const [k, v] of Object.entries(readings)) {
      let type = dev.keys.get(k);
      if (!type && !dev.events.has(k)) {
        if (this.mutation !== "publishes-an-undescribed-key") {
          unnamed.push(k);
          continue;
        }
        type = "scalar";
      }
      if (!type || !fits(type, v)) continue;
      const held = dev.values.get(k);
      // A message older than the reading held does not replace it.
      if (held && held.at > at) continue;
      dev.values.set(k, { value: v, at, seenAt: now });
      changed = true;
      // A setting's last observed value is kept across restarts (GA-BRIDGE-74).
      if (dev.d.settings?.includes(k)) this.keep.setting(dev.id, k, v, at);
    }
    if (changed && this.mutation === "restamps-partial-read") for (const r of dev.values.values()) r.at = at;
    this.keep.flushSettings();
    if (changed) await this.publishDeviceStatus(dev);
    if (this.devicesAfterStatus.delete(dev.id)) await this.publishDevices();
    if (unnamed.length) await this.addUndescribed(dev, unnamed, now);
    if (this.refreshDevice(dev, now)) await this.publishStatus();
  }

  /** Names the doer reports as no key's (GA-BRIDGE-76). */
  private async undescribedNames(hw: HardwareId, names: string[]): Promise<void> {
    const dev = this.byHw.get(hw);
    if (!dev || this.mutation === "publishes-an-undescribed-key") return;
    await this.addUndescribed(dev, names, this.o.clock.now());
  }

  /**
   * Names data the device sent that no key describes (GA-BRIDGE-76): each made to the list's form (a
   * character outside it becomes `_`, a name over 64 characters is cut), added once, in the order
   * first seen, the first UNDESCRIBED_MAX kept; a later name is neither listed nor announced. Each one
   * added is kept across restarts (GA-BRIDGE-31), goes out in `devices`, and is announced by one
   * `undescribed` event.
   */
  private async addUndescribed(dev: Device, names: string[], at: number): Promise<void> {
    if (this.mutation === "publishes-an-undescribed-key") return;
    const added: string[] = [];
    for (const n of names) {
      const name = String(n).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
      if (!UNDESCRIBED_NAME.test(name) || dev.undescribed.some((u) => u.name === name) || dev.undescribed.length >= UNDESCRIBED_MAX) continue;
      dev.undescribed.push({ name, firstSeen: at });
      this.keep.undescribed(dev.id, name, at);
      added.push(name);
    }
    if (!added.length) return;
    this.keep.flushSettings();
    await this.publishDevices();
    for (const name of added) await this.publishEvent("undescribed", { device: dev.id, name });
  }


  /**
   * An occurrence of an `event` key: published once, as an `occurrence` on the `event` topic, never
   * in the retained status and never again (GA-BRIDGE-75). The same frame and payload again within
   * OCCURRENCE_REPEAT_MS is the same occurrence, dropped. The message is a check-in (GA-BRIDGE-37).
   * A key the device does not declare as an event is named undescribed (GA-BRIDGE-76).
   */
  private async occurred(hw: HardwareId, key: string, value: unknown, time: number, frameId: string): Promise<void> {
    const dev = this.byHw.get(hw);
    if (!dev) return;
    const now = this.o.clock.now();
    const at = this.mutation === "stamps-the-future" ? time : Math.min(time, now);
    const type = dev.events.get(key);
    if (!type) {
      await this.addUndescribed(dev, [key], now);
      return;
    }
    if (!fits(type, value)) {
      console.error(`${dev.id}: an occurrence of ${key} that is not its type, left out`);
      return;
    }
    for (const [f, seenAt] of dev.frames) if (now - seenAt > OCCURRENCE_REPEAT_MS || now < seenAt) dev.frames.delete(f);
    const frame = JSON.stringify([frameId, key, value]);
    if (dev.frames.has(frame)) return;
    dev.frames.set(frame, now);
    if (dev.d.feedback === "closed") this.keep.checkedIn(dev, this.mutation === "stamps-the-future" ? at : now);
    const occurrence = { device: dev.id, key, value, timestamp: wireTime(at) };
    await this.publishEvent("occurrence", occurrence);
    if (this.mutation === "retains-an-occurrence") {
      dev.values.set(key, { value, at, seenAt: now });
      await this.publishDeviceStatus(dev);
    }
    if (this.mutation === "replays-an-occurrence") await this.keepForReplay(occurrence);
    if (this.refreshDevice(dev, now)) await this.publishStatus();
  }

  /** `replays-an-occurrence`: every occurrence is kept in the store, to be published again at the next start. */
  private async keepForReplay(occurrence: Record<string, unknown>): Promise<void> {
    const kept = JSON.parse((await this.o.store.meta(REPLAY_META).catch(() => undefined)) ?? "[]") as unknown[];
    await this.o.store.setMeta(REPLAY_META, JSON.stringify([...kept, occurrence])).catch(() => undefined);
  }

  private async replayOccurrences(): Promise<void> {
    const kept = JSON.parse((await this.o.store.meta(REPLAY_META).catch(() => undefined)) ?? "[]") as Record<string, unknown>[];
    for (const o of kept) await this.publishEvent("occurrence", o);
  }

  /** The doer's transport, as it reports it: a change re-publishes `status` within 1 s (GA-BRIDGE-17). */
  private async transportChanged(state: TransportState, since: number, retryIntervalMs?: number): Promise<void> {
    if (this.mutation === "exits-on-fault" && state === "down" && this.publishing) {
      console.error("exits-on-fault: the coordinator is down, so the bridge exits");
      (this.o.exit ?? process.exit)(1);
      return;
    }
    this.transport = { state, since, ...(retryIntervalMs !== undefined ? { retryIntervalMs } : {}) };
    const now = this.o.clock.now();
    for (const dev of this.byId.values()) this.refreshDevice(dev, now);
    await this.publishStatus();
  }

  /** A fault the doer names, or clears with a null detail. */
  private async doerFault(code: string, detail: string | null): Promise<void> {
    const changed = detail === null ? this.clearFault(code) : this.setFault({ code, detail });
    if (changed) await this.publishStatus();
    // A network that disagrees with the store takes no admission: an open window is closed (GA-BRIDGE-12).
    if (code === "state_mismatch" && detail !== null) await this.endWindow(this.window);
  }

  /** The native ways the doer cannot disable: `status`'s `ungoverned`, re-published on a change (GA-BRIDGE-32). */
  private async ungovernedChanged(ways: string[]): Promise<void> {
    const next = [...new Set(ways)].sort();
    if (JSON.stringify(next) === JSON.stringify(this.ungovernedWays)) return;
    this.ungovernedWays = next;
    await this.publishStatus();
  }

  /** Persisted state disagrees with the network: every transport `down`, every command `unreachable` (GA-BRIDGE-12). */
  private get mismatch(): boolean {
    // Under `serves-on-mismatch`, the fault is named and the bridge serves on.
    return this.mutation !== "serves-on-mismatch" && this.faults.some((f) => f.code === "state_mismatch");
  }

  /** The device's `observable` against `now`; true when it changed. */
  private refreshDevice(dev: Device, now: number): boolean {
    let observable: boolean;
    if (dev.d.feedback === "open") {
      // A device that never reports: its liveness is its transport's (*The roster and freshness*).
      observable = this.transport.state === "up" && !this.mismatch;
    } else {
      const bound = this.bound(dev);
      // A check-in "in the future" proves nothing about now.
      observable = dev.lastCheckIn !== null && bound !== null && now >= dev.lastCheckIn && now - dev.lastCheckIn <= bound;
    }
    if (observable === dev.observable.value) return false;
    dev.observable = { value: observable, since: now };
    return true;
  }

  private async tick(): Promise<void> {
    const now = this.o.clock.now();
    let changed = false;
    for (const dev of this.byId.values()) if (this.refreshDevice(dev, now)) changed = true;
    if (changed) await this.publishStatus();
  }

  // --- What the bridge publishes ----------------------------------------------------------------

  /**
   * A routine status goes out only while running and once the start reached its first `devices`;
   * `leaving` marks the graceful offline of a leave, which goes out only while that leave is not cut.
   */
  private async publishStatus(extra: Record<string, unknown> = {}, leaving?: { value: boolean }): Promise<void> {
    await this.whenFree();
    if (leaving ? leaving.value : this.life !== "running" || !this.publishing) return;
    // Not while the broker is away: the client would queue it and deliver it stale before the
    // resubscription; the reconnection publishes a fresh one after it (GA-BRIDGE-18).
    if (!this.o.wire.connected()) return;
    const now = this.o.clock.now();
    for (const dev of this.byId.values()) this.refreshDevice(dev, now);
    const devices = [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    const observable = devices.filter((d) => d.observable.value).length;
    const t = this.transport;
    const status: Record<string, unknown> = {
      bridgeId: this.o.bridgeId,
      instanceId: this.o.instanceId,
      v: 1,
      state: observable === devices.length ? "online" : observable === 0 ? "offline" : "degraded",
      version: VERSION,
      // Provision only where the doer provisions (the herdsman doer does not under the owner's switch).
      levels: this.o.doer.provisions ? ["Serve", "Provision"] : ["Serve"],
      faults: [...this.faults],
      ungoverned: this.mutation === "hides-native-control" ? [] : [...this.ungovernedWays],
      blocked: [...this.blocked.keys()].sort(),
      transports: [{ id: COORDINATOR, kind: "zigbee", state: this.mismatch ? "down" : t.state, since: wireTime(t.since),
        ...(t.retryIntervalMs !== undefined && !this.mismatch ? { retryIntervalMs: t.retryIntervalMs } : {}) }],
      devices: this.mutation === "status-without-roster" ? [] : devices.map((d) => this.rosterEntry(d)),
      publishedAt: wireTime(now),
      ...extra,
    };
    if (this.o.runId) status.testRunId = this.o.runId;
    await this.publish(`${this.base}/status`, status, true);
  }

  /** A closed device's bound: the doer's, which it knows from the protocol or the model, or null (GA-BRIDGE-13). */
  private bound(dev: Device): number | null {
    const known = dev.d.basisMaxAgeMs;
    if (this.mutation === "inflates-the-bound" && known !== null) return 2 * known;
    if (this.mutation === "guesses-the-bound" && known === null) return GUESSED_BOUND_MS;
    return known;
  }

  private rosterEntry(dev: Device): Record<string, unknown> {
    return rosterEntry(dev, this.bound(dev), COORDINATOR);
  }

  /** A device's entry in `devices`, under the core's id (`entry`). */
  private entry(dev: Device): Record<string, unknown> {
    return entry(dev.id, dev.d, COORDINATOR, dev.undescribed, { hidesAwaited: this.mutation === "holds-back-silently",
      claimsProtocol: this.mutation === "claims-protocol-class",
      hidesOtherAdmins: this.mutation === "hides-other-admins" });
  }

  /** `devices` when a declaration changed, or always when `force`d (the start, a snapshot, a reconnection). */
  private async publishDevices(force = false): Promise<void> {
    if (!this.publishing || this.life !== "running") return;
    const devices = [...this.byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((d) => this.entry(d));
    const shown = JSON.stringify(devices);
    if (!force && shown === this.devicesShown) return;
    this.devicesShown = shown;
    await this.publish(`${this.base}/devices`, { publishedAt: wireTime(this.o.clock.now()), devices }, true);
  }

  /**
   * A device's status: its declared readings, `timestamp` the newest observation among them, and
   * `timestamps` for those observed at another time (GA-BRIDGE-1, GA-BRIDGE-2). None before its first reading.
   */
  private async publishDeviceStatus(dev: Device): Promise<void> {
    if (!this.publishing || this.life !== "running" || !dev.values.size) return;
    // `stamps-publication-time`: every reading stamped with the publication, not its observation.
    const now = this.o.clock.now();
    const readings = [...dev.values.entries()].map(([k, r]) => [k, this.mutation === "stamps-publication-time" ? { ...r, at: now } : r] as const);
    const newest = Math.max(...readings.map(([, r]) => r.at));
    const values = Object.fromEntries(readings.map(([k, r]) => [k, r.value]));
    const timestamps = Object.fromEntries(readings.filter(([, r]) => r.at !== newest).map(([k, r]) => [k, wireTime(r.at)]));
    const on = dev.values.get("on")?.value;
    await this.publish(`${this.base}/devices/${dev.id}/status`, {
      deviceId: dev.id,
      // The universal `state` field (*A device's status*), for a device with `onoff`.
      ...(typeof on === "boolean" ? { state: on ? "on" : "off" } : {}),
      timestamp: wireTime(newest),
      ...values,
      available: true,
      ...(Object.keys(timestamps).length ? { timestamps } : {}),
    }, true);
  }

  private async publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
    try {
      await this.o.wire.publish(topic, payload, retain);
      // Accepted now: an earlier refusal no longer holds, and the next status says so.
      this.clearFault("publish_refused", topic);
    } catch (err) {
      if (err instanceof Refused && this.mutation !== "ignores-refusals") this.setFault({ code: "publish_refused", topic: err.topic });
      else console.error(`publish ${topic}: ${err}`);
    }
  }

  /**
   * An event, not retained, `seq` from 1 in this instance (GA-BRIDGE-33). Only while running, once
   * the start reached its first `devices`, and with the broker there: an event the applier missed is
   * lost, never replayed (GA-BRIDGE-75). One dropped while the broker is away still takes its `seq`,
   * so the gap tells the applier it missed one (*Gaps*).
   */
  private async publishEvent(type: string, fields: Record<string, unknown>, leaving = false): Promise<void> {
    if (!this.publishing || (this.life !== "running" && !leaving)) return;
    this.seq += this.mutation === "skips-seq" ? 2 : 1;
    if (!this.o.wire.connected()) return;
    await this.publish(`${this.base}/event`, { seq: this.seq, instanceId: this.o.instanceId, type, ...fields }, false);
  }

  /** Adds or replaces the fault of that code, topic and device; true when the list changed. */
  private setFault(f: Fault): boolean {
    const i = this.faults.findIndex((x) => x.code === f.code && x.topic === f.topic && x.device === f.device);
    if (i >= 0 && JSON.stringify(this.faults[i]) === JSON.stringify(f)) return false;
    if (i >= 0) this.faults[i] = f;
    else this.faults.push(f);
    return true;
  }

  /** Removes the fault of that code (and topic, and device, when named); true when the list changed. */
  private clearFault(code: string, topic?: string, device?: string): boolean {
    const i = this.faults.findIndex((x) => x.code === code && (topic === undefined || x.topic === topic)
      && (device === undefined || x.device === device));
    if (i < 0) return false;
    this.faults.splice(i, 1);
    return true;
  }

  /** Every filter is asked for again: one granted now clears its refusal, one refused now is a fault (GA-BRIDGE-20). */
  private async subscribe(): Promise<void> {
    // Under `acts-on-retained-request`, the broker sends what is retained on subscribing (Retain Handling 0).
    const refused = await this.o.wire.subscribe(this.filters, this.mutation === "acts-on-retained-request" ? 0 : 2);
    if (this.mutation === "ignores-refusals") return;
    for (const topic of this.filters) {
      if (refused.includes(topic)) this.setFault({ code: "subscribe_refused", topic });
      else this.clearFault("subscribe_refused", topic);
    }
  }

  /** The session is clean, so the broker forgot the subscriptions: subscribed again before `status` (GA-BRIDGE-9, GA-BRIDGE-18). */
  private async reconnected(): Promise<void> {
    if (this.life !== "running") return;
    const late = this.mutation === "online-before-subscribed";
    if (!late) await this.subscribe();
    await this.publish(`${this.base}/lwt`, "", true);
    await this.publishDevices(true);
    for (const dev of this.byId.values()) await this.publishDeviceStatus(dev);
    await this.publishStatus();
    if (late) this.later(() => this.subscribe(), SUBSCRIBE_LATE_MS);
  }

  // --- What the bridge receives -----------------------------------------------------------------

  private async onDelivery(d: Delivery, receivedAt: number): Promise<void> {
    await this.whenFree();
    // A retained command or request is never acted on (GA-BRIDGE-19).
    if ((d.retained && this.mutation !== "acts-on-retained-request") || !d.topic.startsWith(`${this.base}/`)) return;
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
      if (this.mutation === "one-fault-stops-all") {
        const run = this.commandLine.then(() => this.handleCommand(id, d, receivedAt, cmd, commandId, within));
        this.commandLine = run.catch(() => {});
        await run;
      } else {
        await this.handleCommand(id, d, receivedAt, cmd, commandId, within);
      }
    } catch (err) {
      // One ack per command, whatever threw (GA-BRIDGE-4); logged, never an exit.
      console.error(`command ${commandId}: ${message(err)}`);
      if (this.commands.get(commandId)?.ack) return;
      await this.ack(id, commandId, "failed", UNEXPECTED_ACK_REASON, message(err));
    }
  }

  private async handleCommand(id: string, d: Delivery, receivedAt: number, cmd: Record<string, any>, commandId: string,
    within: number): Promise<void> {
    const errors = validate("bridge/command.json", cmd);
    if (errors.length) return this.ack(id, commandId, "failed", "invalid_request", errors.join("; "));
    const dev = this.byId.get(id);
    // A device the bridge has, whose description has not come yet (the doer is starting, or has not
    // described it since its admission), cannot be reached now: it is no unknown device.
    if (!dev && this.undescribed(id)) return this.ack(id, commandId, "failed", "unreachable", `${id} is not described yet`);
    if (!dev) return this.ack(id, commandId, "failed", "unknown_device", `no device ${id}`);
    // The command's time: the lesser of the Message Expiry left on delivery and resultWithinMs from receipt.
    const deadline = receivedAt + Math.min(within, d.expirySeconds !== undefined ? d.expirySeconds * 1000 : Infinity);
    // A clock that stepped back since receipt says nothing of the time left: expired, never stretched.
    const now = this.o.clock.now();
    const expired = now > deadline && this.mutation !== "runs-expired-commands";
    if (expired || now < receivedAt) return this.ack(id, commandId, "failed", "expired");
    const value = cmd.value as Record<string, unknown>;
    const action = String(value.action);
    const decl = dev.d.actions.find((a) => a.action === action);
    if (!decl) return this.ack(id, commandId, "unsupported", undefined, `${action} is not offered`);
    const unknown = Object.keys(value).filter((k) => k !== "action" && k !== "value" && k !== "state");
    if (unknown.length) return this.ack(id, commandId, "failed", "invalid_request", `unknown keys: ${unknown.join(", ")}`);
    // A one-argument action carries the argument itself, a several-argument one an object (*Commands*).
    const args = namedArgs(decl, value.value);
    if (typeof args === "string") return this.ack(id, commandId, "failed", "invalid_request", args);
    // Nothing was done: `unreachable` while leaving, as for a command in flight (GA-BRIDGE-22).
    if (this.life !== "running") return this.ack(id, commandId, "failed", "unreachable", "the bridge is going offline");
    if (this.mismatch) return this.ack(id, commandId, "failed", "unreachable", "the store disagrees with the network (state_mismatch)");
    if (this.transport.state !== "up") {
      if (this.mutation === "unreachable-late") await this.wait(UNREACHABLE_LATE_MS);
      return this.ack(id, commandId, "failed", "unreachable", "the coordinator is not answering");
    }
    if (this.mutation === "echoes-commanded-state") await this.echo(dev, decl, args);
    // The owner's PIN goes to the doer with a lock's unlock, where the lock requires one, and nowhere else (GA-BRIDGE-36).
    const owners = decl.action === UNLOCK && dev.d.pinRequired ? this.pins.get(dev.id) : undefined;
    const result = await this.execute(dev, decl, args, deadline, owners);
    const misreports = this.mutation === "applied-before-confirmation" || this.mutation === "unreachable-after-transmit"
      ? this.mutation : undefined;
    const [ackResult, reason, detail] = ackFor(decl, result, misreports);
    const pin = this.mutation === "pin-on-the-wire" && decl.action === UNLOCK ? this.pins.get(dev.id) : undefined;
    await this.ack(id, commandId, ackResult, reason, pin !== undefined ? `unlocked with PIN ${pin}` : detail);
    // GA-BRIDGE-34: after applied, sent or no_confirmation, a stateful action on a closed device is read back if no report came.
    const readBack = ackResult === "applied" || ackResult === "sent" || reason === "no_confirmation";
    const closedStateful = !decl.stateless && dev.d.feedback === "closed";
    if (readBack && closedStateful && result !== "leaving" && this.mutation !== "no-read-back") {
      this.readBack(dev, decl, receivedAt, Date.parse(cmd.issuedAt) + within, deadline);
    }
  }

  /** Whether the id is a device the bridge has, admitted or kept in the store, that the doer has not described. */
  private undescribed(id: string): boolean {
    if ([...this.pending.values()].some((s) => s.deviceId === id)) return true;
    // A row being removed, or one a held new admission takes out of use, is no device the bridge has.
    return this.o.store.devices().some((s) => s.deviceId === id && !this.keep.removals.has(s.hardwareId)
      && this.keep.held.get(s.hardwareId)?.previous !== id);
  }

  /** `echoes-commanded-state`: the values the action sets are published as readings, as optimistic state would be. */
  private async echo(dev: Device, decl: ActionDecl, args: Record<string, unknown>): Promise<void> {
    const now = this.o.clock.now();
    for (const [k, v] of Object.entries(closedSets(decl.action) ?? {})) {
      dev.values.set(k, { value: "fixed" in v ? v.fixed : args[v.arg], at: now, seenAt: now });
    }
    await this.publishDeviceStatus(dev);
  }

  /** The doer carries the action out, within the command's time; a leave ends the wait at once. */
  private execute(dev: Device, decl: ActionDecl, args: Record<string, unknown>, deadline: number, pin?: string)
    : Promise<ProtocolResult | "late" | "leaving"> {
    return new Promise((resolve) => {
      let done = false;
      const end = (r: ProtocolResult | "late" | "leaving") => {
        if (done) return;
        done = true;
        this.o.clock.clear(timer);
        this.timers.delete(timer);
        this.waits.delete(leaving);
        resolve(r);
      };
      const leaving = () => end("leaving");
      const timer = this.o.clock.setTimeout(() => end("late"), Math.max(0, deadline - this.o.clock.now()));
      this.timers.add(timer);
      this.waits.add(leaving);
      // A doer that throws reached the stack, or may have: lost, never `unreachable` (*Commands*).
      Promise.resolve().then(() => this.o.doer.execute(dev.hw, decl.action, args, deadline, pin))
        .then(end, (err) => end({ kind: "lost", detail: message(err) }));
    });
  }

  /**
   * GA-BRIDGE-34's read-back: unless every key the action sets was observed since the command came,
   * the device is read, begun READ_BACK_LEAD_MS before the latest moment that still lets its answer go
   * out by `issuedAt` plus `resultWithinMs` less 1 s (and never past the command's own time).
   */
  private readBack(dev: Device, decl: ActionDecl, receivedAt: number, bound: number, deadline: number): void {
    const keys = Object.keys(closedSets(decl.action) ?? (decl.confirmedBy ? { [decl.confirmedBy.key]: true } : {}));
    if (!keys.length) return;
    const by = Math.min(Number.isNaN(bound) ? deadline : bound, deadline) - 1000;
    const fresh = () => keys.every((k) => (dev.values.get(k)?.seenAt ?? -Infinity) >= receivedAt);
    this.later(async () => {
      if (fresh() || this.byHw.get(dev.hw) !== dev) return;
      await this.o.doer.read(dev.hw, keys, by).catch((err) => console.error(`read-back of ${dev.id}: ${message(err)}`));
    }, Math.max(0, by - READ_BACK_LEAD_MS - this.o.clock.now()));
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
      console.error(`${op} ${requestId}: ${message(err)}`);
      if (!this.requests.get(requestId)?.reply) await this.reply({ requestId, op, status: "failed", reason: UNEXPECTED_REPLY_REASON });
    }
  }

  private async handleRequest(op: string, requestId: string, req: Record<string, any>): Promise<void> {
    if (validate("bridge/request.json", req).length) return this.reply({ requestId, op, status: "invalid_request" });
    if (op === "snapshot") {
      if (this.mutation === "ignores-snapshot") return this.reply({ requestId, op, status: "ok", data: {} });
      await this.publishDevices(true);
      for (const dev of this.byId.values()) await this.publishDeviceStatus(dev);
      await this.publishStatus();
      return this.reply({ requestId, op, status: "ok", data: {} });
    }
    // A doer that does not provision: its ops do not fit the bridge, whose `levels` say Serve alone (GA-BRIDGE-28).
    if (!this.o.doer.provisions) return this.reply({ requestId, op, status: "invalid_request" });
    switch (op) {
      case "join":
        return this.join(requestId, req);
      case "join_close":
        return this.joinClose(requestId, req);
      case "remove":
        return this.remove(requestId, req);
      case "unblock":
        return this.unblock(requestId, req);
      case "commission":
        // Under `provisions-the-wrong-way`, a Zigbee transport takes a setup code it has no use for.
        if (this.mutation === "provisions-the-wrong-way") return this.reply({ requestId, op, status: "accepted" });
        return this.reply({ requestId, op, status: "invalid_request" });
      default:
        // `commission`: a Zigbee transport has no setup codes (GA-BRIDGE-28); `connect`: the bridge
        // ships no manifest (GA-BRIDGE-40); any other op the bridge does not know.
        return this.reply({ requestId, op, status: "invalid_request" });
    }
  }

  /**
   * Why provisioning is refused now, if it is: the store disagrees with the network (GA-BRIDGE-12),
   * or, for what must survive a restart, the store is away (the design, *The store*).
   */
  private provisionRefusal(needsStore: boolean): string | undefined {
    if (this.mismatch) return "state_mismatch";
    if (needsStore && (this.keep.retryDue || this.faults.some((f) => f.code === "store_fault"))) return "store_fault";
    return undefined;
  }

  /**
   * `join { transport, windowMs, near? }` (GA-BRIDGE-25, 26): answered `accepted`, then a window
   * open for the lesser of `windowMs` and JOIN_CAP_MS, house-wide or at the router `near` names. A
   * `join` while a window is open is `failed(busy)` (GA-BRIDGE-4), checked with nothing awaited
   * between the check and the opening, so of two delivered together one opens and one is `busy`.
   */
  private async join(requestId: string, req: Record<string, any>): Promise<void> {
    const op = "join";
    if (req.transport !== COORDINATOR || !Number.isInteger(req.windowMs) || req.windowMs <= 0
      || (req.near !== undefined && typeof req.near !== "string")) return this.reply({ requestId, op, status: "invalid_request" });
    const refusal = this.provisionRefusal(true);
    if (refusal) return this.reply({ requestId, op, status: "failed", reason: refusal });
    let near: HardwareId | undefined;
    if (req.near !== undefined) {
      const at = this.byId.get(req.near);
      if (!at) return this.reply({ requestId, op, status: "failed", reason: "unknown_device" });
      // A window opens only at a router (GA-BRIDGE-26).
      if (at.d.router !== true) return this.reply({ requestId, op, status: "invalid_request" });
      near = at.hw;
    }
    if (this.transport.state !== "up") return this.reply({ requestId, op, status: "failed", reason: "unreachable" });
    if (this.window) return this.reply({ requestId, op, status: "failed", reason: "busy" });
    // Open before the reply: a stop that follows the reply at once finds the window, and closes it (GA-BRIDGE-22).
    this.openWindow(Math.min(req.windowMs as number, JOIN_CAP_MS), near);
    await this.reply({ requestId, op, status: "accepted" });
  }

  /** The window opens: the doer told, its time kept on the bridge's clock; one the doer could not open ends at once. */
  private openWindow(windowMs: number, near?: HardwareId): void {
    const w: Window = { windowMs, devices: [], timer: 0 };
    this.window = w;
    // Under `window-never-closes`, nothing ends the window at its time: it stays open until join_close or a stop.
    if (this.mutation !== "window-never-closes") {
      w.timer = this.o.clock.setTimeout(() => {
        this.timers.delete(w.timer);
        this.queue(() => this.endWindow(w));
      }, windowMs);
      this.timers.add(w.timer);
    }
    // Under `ignores-near`, the window opens everywhere, the router named or not.
    const at = this.mutation === "ignores-near" ? undefined : near;
    const opened = this.windowCalls.then(() => this.o.doer.join(windowMs, at));
    this.windowCalls = opened.catch(() => {});
    opened.catch((err) => {
      console.error(`join: the window did not open: ${message(err)}`);
      this.queue(() => this.endWindow(w));
    });
  }

  /** `join_close { transport }`: the window open now ends at once, with its window_closed; with none, `ok` and nothing more (GA-BRIDGE-25, 27). */
  private async joinClose(requestId: string, req: Record<string, any>): Promise<void> {
    const op = "join_close";
    if (req.transport !== COORDINATOR) return this.reply({ requestId, op, status: "invalid_request" });
    const refusal = this.provisionRefusal(false);
    if (refusal) return this.reply({ requestId, op, status: "failed", reason: refusal });
    await this.endWindow(this.window);
    return this.reply({ requestId, op, status: "ok", data: {} });
  }

  /**
   * `remove { device | identifier, blockRejoin, force? }` (GA-BRIDGE-21, 27): `device` a device id,
   * `identifier` a hardware id, either never had `failed(unknown_device)`. With `blockRejoin`, the
   * hardware is on the blocklist, in the store, before the reply. Answered `accepted`; the doer
   * removes the hardware and `left` names its device. An id the hardware no longer has is already
   * gone: `left` names it at once. The hardware's device now, if any, is untouched, unless the
   * hardware is blocked: then it is removed too, as blocked hardware is kept out of the network.
   */
  private async remove(requestId: string, req: Record<string, any>): Promise<void> {
    const op = "remove";
    const byDevice = typeof req.device === "string";
    if (byDevice === (typeof req.identifier === "string") || typeof req.blockRejoin !== "boolean"
      || (req.force !== undefined && typeof req.force !== "boolean")) return this.reply({ requestId, op, status: "invalid_request" });
    const refusal = this.provisionRefusal(true);
    if (refusal) return this.reply({ requestId, op, status: "failed", reason: refusal });
    const hw: HardwareId | undefined = byDevice ? this.hardwareOfId(req.device as string) : req.identifier as string;
    const id = byDevice ? req.device as string : hw === undefined ? undefined : this.deviceIdOf(hw) ?? this.o.store.lastDeviceOf(hw);
    if (hw === undefined || id === undefined) return this.reply({ requestId, op, status: "failed", reason: "unknown_device" });
    if (req.blockRejoin && !this.blocked.has(hw)) {
      const now = this.o.clock.now();
      try {
        await this.o.store.block(hw, now);
      } catch (err) {
        this.keep.failed(err);
        return this.reply({ requestId, op, status: "failed", reason: "store_fault" });
      }
      this.blocked.set(hw, now);
      await this.publishStatus();
    }
    await this.reply({ requestId, op, status: "accepted" });
    const now = this.deviceIdOf(hw);
    if (now !== id) {
      // Already gone: it left, or the hardware was admitted anew since.
      await this.publishEvent("left", { device: id });
      // Blocked, the hardware's device now goes too, and its own `left` names it (GA-BRIDGE-27).
      if (req.blockRejoin && now !== undefined) this.removal(hw, now, req.force === true);
      return;
    }
    this.removal(hw, id, req.force === true);
  }

  /**
   * The hardware a device id was given to: a device the bridge has, or any the store kept (an
   * admission waiting for its description among them, the store having it before `pending` does).
   */
  private hardwareOfId(id: string): HardwareId | undefined {
    return this.byId.get(id)?.hw ?? this.o.store.hardwareOf(id);
  }

  /**
   * The doer removes the hardware, which it reports `left`; one `left` ends every `remove` of it. A
   * `remove` while another of the same hardware runs waits for it, unless it adds `force`. A removal
   * the doer rejects stays pending, as one waiting for a silent device does, and a `remove_refused`
   * fault names the device and the doer's reason; a `remove` with `force` ends it, on the bridge's
   * own word if the doer rejects that too.
   */
  private removal(hw: HardwareId, id: string, force: boolean): void {
    const running = this.removing.get(hw);
    if (running && (running.force || !force)) return;
    const mine = { force };
    this.removing.set(hw, mine);
    const ended = async () => {
      if (this.removing.get(hw) === mine) this.removing.delete(hw);
      if (this.leftIds.has(id)) return;
      // The doer had nothing to remove, or did not say so: the bridge's own word ends it.
      if (this.deviceIdOf(hw) === id) await this.left(hw);
      else await this.publishEvent("left", { device: id });
    };
    this.o.doer.remove(hw, force).then(() => this.queue(ended), (err) => this.queue(async () => {
      console.error(`remove of ${id}: ${message(err)}`);
      if (force) return ended();
      // Superseded by a forced removal, or ended by a leave: nothing waits on this one.
      if (this.removing.get(hw) !== mine) return;
      if (this.setFault({ code: REMOVE_REFUSED, device: id, detail: message(err) })) await this.publishStatus();
    }));
  }

  /** `unblock { identifier }` (GA-BRIDGE-27): the hardware off the blocklist, in the store first; `ok` whether it was on it or not. */
  private async unblock(requestId: string, req: Record<string, any>): Promise<void> {
    const op = "unblock";
    if (typeof req.identifier !== "string") return this.reply({ requestId, op, status: "invalid_request" });
    const refusal = this.provisionRefusal(true);
    if (refusal) return this.reply({ requestId, op, status: "failed", reason: refusal });
    const hw = req.identifier as string;
    try {
      await this.o.store.unblock(hw);
    } catch (err) {
      this.keep.failed(err);
      return this.reply({ requestId, op, status: "failed", reason: "store_fault" });
    }
    if (this.blocked.delete(hw)) await this.publishStatus();
    return this.reply({ requestId, op, status: "ok", data: {} });
  }

  /**
   * Ends the window `w` if it is still the open one: the doer closes it, after its `join` settled,
   * and window_closed carries every device that joined in it and its effective `windowMs`
   * (GA-BRIDGE-25). The doer's close is awaited only while leaving, where it must come before the
   * doer stops (GA-BRIDGE-22).
   */
  private async endWindow(w: Window | undefined, o: { leaving?: boolean } = {}): Promise<void> {
    if (!w || this.window !== w) return;
    this.window = undefined;
    this.o.clock.clear(w.timer);
    this.timers.delete(w.timer);
    const closed = this.windowCalls.then(() => this.o.doer.joinClose()).catch((err) => console.error(`join_close: ${message(err)}`));
    this.windowCalls = closed;
    await this.publishEvent("window_closed", { transport: COORDINATOR, devices: [...w.devices], windowMs: w.windowMs }, o.leaving);
    if (o.leaving) await closed;
  }

  private async ack(id: string, commandId: string, result: string, reason?: string, detail?: string): Promise<void> {
    const ack: Ack = { commandId, source: this.o.bridgeId, result, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}),
      timestamp: wireTime(this.o.clock.now()) };
    const record = this.commands.get(commandId);
    if (record) record.ack = ack;
    await this.publish(this.ackTopic(id), ack, false);
    if (this.mutation === "double-acks") await this.publish(this.ackTopic(id), ack, false);
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
  }

  private clearTimers(): void {
    for (const h of this.timers) this.o.clock.clear(h);
    this.timers.clear();
  }

  /** Waits `ms` of the bridge's clock. */
  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.o.clock.setTimeout(r, ms));
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
