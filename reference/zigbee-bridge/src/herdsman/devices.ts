import type { Clock } from "@ludentes/galatea-life-test-clock";
import { findByDevice, onEvent as convertersOnEvent, type Definition, type OnEvent } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import type { Description, DoerEvents, HardwareId } from "../port.js";
import { CONFIGURE_RETRY_MS, CONFIGURE_TRIES, runConfigure } from "./configure.js";
import { configures, configureVersion, type Described, describe } from "./describe.js";
import { active, Availability, type AvailabilityMutation, POLL_RETRY_MS } from "./availability.js";
import { answering, type ConfigureMethod, eventExchange, type Exchange, type Gate, guard } from "./guard.js";
import { redact } from "./log.js";
import { type Override, overrideFor } from "./overrides.js";
import { type Heard, type Message, Pipeline } from "./pipeline.js";
import { poll, POLL_MS } from "./polling.js";

/**
 * The herdsman doer's devices (the design, *The herdsman doer*): each device herdsman has, its
 * definition resolved, its converters' `onEvent` hooks told what zigbee2mqtt tells them, described,
 * and its messages read through the pipeline. Everything it tells the core goes out in the order it
 * happened, one thing at a time, so that a description changed by a setting reaches the core before
 * the observation that carried the setting (GA-BRIDGE-74). Every converter call here gets the device
 * through the guard (`guard.ts`), which sends a device nothing, so nothing in the one queue waits on
 * the network (plan 2c-1 review I1). The doer carries a device's actions out from what `target` gives
 * it, outside the queue (`execute.ts`), and a definition's `configure` runs outside it too
 * (`configure.ts`, plan 2c-3): a router's when it is described, an end device's when it was just
 * interviewed or is heard (it is awake then), each once per definition version, a failed one again at
 * the device's next message no sooner than CONFIGURE_RETRY_MS after its last try, CONFIGURE_TRIES
 * times at most per version until the bridge restarts or the device is interviewed again. A device
 * admitted anew is configured again, as zigbee2mqtt does at a join: herdsman's record of an earlier
 * configure outlives the device's leave, and the device may have been reset. The devices described as
 * polled are read POLL_MS after they were last heard or polled, one at a time, outside the queue, at
 * the doer's health exchanges (`pollDue`, the design's *Freshness*). A device the rule covers (a mains
 * device, `availability.ts`) is told unavailable once its polls or its commands go unanswered in a
 * row, and available again, before anything else of it, at the next frame heard from it.
 */

/** A device as the doer knows it: its definition, how it was described, and the settings it was described for. */
interface Known {
  /** herdsman's model of the device, through the guard. */
  device: Zh.Device;
  /** herdsman's own model of the device, for an action's live run (`execute.ts`), which opens only its own calls. */
  model: Zh.Device;
  definition: Definition;
  override?: Override;
  described: Described;
}

/** A device as an action is carried out on it (`HerdsmanDevices.target`). */
export interface Target {
  model: Zh.Device;
  definition: Definition;
  override?: Override;
  described: Described;
  /** The converters' state for the device, as its messages built it. */
  state: Record<string, unknown>;
}

export interface DevicesOptions {
  clock: Clock;
  /** The core, while the doer is started. */
  events(): DoerEvents | undefined;
  /**
   * The definition of a device; the converters' own, generated for one no database knows, unless
   * given. It gets the device through the guard: an attribute a generated definition would read is
   * refused at once, and the converters take their fallback for it (`getClusterAttributeValue`).
   */
  definitionOf?(device: Zh.Device): Promise<Definition | undefined>;
  /** The override table; the converters' models' unless given. */
  overrideOf?(model: string): Override | undefined;
  /** The owner's switch: every description sent with no action, its extensions' actions too (plan 2c-2 review M6); and no `configure` run. */
  noActions?: boolean;
  /** The coordinator's endpoint, the target of a `configure`'s binds, while a controller is up. */
  coordinator?(): Zh.Endpoint | undefined;
  /** The build's own mutation of the availability rule, only under a run (`availability.ts`). */
  mutation?: AvailabilityMutation;
}

export class HerdsmanDevices {
  private readonly known = new Map<HardwareId, Known>();
  /**
   * The description last sent to the core, by hardware, to send another only when it changed: kept
   * across a controller's close, since the next controller's devices are the same hardware.
   */
  private readonly sent = new Map<HardwareId, string>();
  /** The last observed values of each device's settings, by key: what the core kept, then what its messages said. */
  private readonly settings = new Map<HardwareId, Record<string, unknown>>();
  /** The awaited keys each device has reported once (GA-BRIDGE-80): what the core kept, then what its messages said. */
  private readonly reported = new Map<HardwareId, Set<string>>();
  private readonly pipeline: Pipeline;
  /** Everything the devices do, one at a time, in the order it came. */
  private queue: Promise<void> = Promise.resolve();
  private readonly definitionOf: (device: Zh.Device) => Promise<Definition | undefined>;
  private readonly overrideOf: (model: string) => Override | undefined;
  /** Each `configure` running, by hardware: its gate, closed when the device is forgotten. */
  private readonly configuring = new Map<HardwareId, Gate<ConfigureMethod>>();
  /** When each device's `configure` was last tried and did not succeed, on the doer's clock. */
  private readonly tried = new Map<HardwareId, number>();
  /** The definition version whose `configure` the guard refused, by hardware: not tried again in this process. */
  private readonly refusedAt = new Map<HardwareId, string>();
  /** How many times each device's `configure` failed at a definition version in this process: given up at CONFIGURE_TRIES. */
  private readonly failures = new Map<HardwareId, { version: string; count: number }>();
  /** When each device's last check-in came, on the doer's clock: a device polled is read POLL_MS after it, or after its last poll. */
  private readonly lastHeard = new Map<HardwareId, number>();
  /** When each polled device was last read, on the doer's clock. */
  private readonly lastPolled = new Map<HardwareId, number>();
  /** The polled devices whose last poll went unanswered, so that the log says it once, and again once one is answered. */
  private readonly unanswered = new Set<HardwareId>();
  /** Whether a round of polls is under way: one round, and one poll, at a time. */
  private polling = false;
  /** The rows of unanswered polls and commands of the devices the rule covers (`availability.ts`). */
  private readonly availability: Availability;
  /** Each covered device's poll retry, due POLL_RETRY_MS after a poll it did not answer: its timer. */
  private readonly retries = new Map<HardwareId, number>();

  constructor(private readonly o: DevicesOptions) {
    this.definitionOf = o.definitionOf ?? ((d) => findByDevice(d, true));
    this.overrideOf = o.overrideOf ?? ((m) => overrideFor(m));
    this.pipeline = new Pipeline({
      clock: o.clock,
      late: (h) => this.then(async () => this.tell(h)),
      exposesChanged: (hw) => this.then(async () => this.redescribe(hw)),
      ...(o.noActions ? {} : { answers: true }),
    });
    this.availability = new Availability({ covers: (hw) => this.covers(hw), now: () => this.o.clock.now(),
      tell: (hw, available) => {
        const events = this.o.events();
        events?.availability(hw, available, this.o.clock.now());
        return events !== undefined;
      } });
  }

  /**
   * Whether the availability rule covers the device: what it is (`active`), never whether it is
   * polled; under `marks-a-battery-device-dead`, whether it is polled.
   */
  private covers(hw: HardwareId): boolean {
    const k = this.known.get(hw);
    if (!k) return false;
    if (this.o.mutation === "marks-a-battery-device-dead") return k.described.description.basis === "poll";
    return active(k.model);
  }

  /**
   * The settings the core kept across the restart, by hardware (GA-BRIDGE-74): described from until
   * the device reports again; and the awaited keys each device reported once (GA-BRIDGE-80).
   */
  keep(settings: ReadonlyMap<HardwareId, Record<string, unknown>> | undefined, reported?: ReadonlyMap<HardwareId, string[]>): void {
    for (const [hw, s] of settings ?? []) this.settings.set(hw, { ...s });
    for (const [hw, keys] of reported ?? []) this.reported.set(hw, new Set(keys));
  }

  /** Resolves once everything asked of the devices so far is done. */
  async idle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  /**
   * A device herdsman has, interviewed: its definition resolved, `start` told to its converters, and
   * it described. A device whose interview did not succeed is left until it does. A device known
   * already (interviewed again) has its converters told `stop` first, which clears what `start` set
   * (plan 2c-1 review M4). `interviewed` says the device was interviewed just now, so is awake: its
   * `configure` runs, as a router's always does.
   */
  add(model: Zh.Device, interviewed = false): Promise<void> {
    return this.then(async () => {
      if (model.interviewState !== "SUCCESSFUL" || model.type === "Coordinator") return;
      const device = guard(model);
      const hw = device.ieeeAddr;
      const prior = this.known.get(hw);
      if (prior) await this.hook(prior, { type: "stop", data: { ieeeAddr: hw } });
      // Interviewed again: a configure given up is tried afresh, and its settings, which a reset or other
      // firmware may have changed, are no longer known; a secured rejoin is no interview (GA-BRIDGE-79).
      if (interviewed) {
        this.failures.delete(hw);
        this.settings.delete(hw);
      }
      const definition = await this.definitionOf(device).catch((err) => {
        console.error(`zigbee: ${hw}: no definition: ${redact(String((err as Error)?.message ?? err))}`);
        return undefined;
      });
      if (!definition) return;
      const override = this.overrideOf(definition.model);
      const ex = this.exchange("start");
      await this.hook({ definition, ...(override ? { override } : {}) }, { type: "start", data: this.data(model, override, ex) }, ex);
      const described = await describe(device, definition, this.describing(hw, override));
      const k: Known = { device, model, definition, ...(override ? { override } : {}), described };
      this.known.set(hw, k);
      this.pipeline.set(hw, { definition, keys: described.keys, ...(override ? { override } : {}) });
      this.send(k);
      // An end device is asleep but for moments: configured once it is heard, unless it was just interviewed.
      if (interviewed || model.type !== "EndDevice") this.configureIfDue(hw);
    });
  }

  /** A device's message, read through the pipeline and told to the core. */
  heard(m: Message): Promise<void> {
    return this.then(async () => {
      // A frame heard from it: a device told unavailable is available again, before what the frame says.
      this.availability.heard(m.device.ieeeAddr);
      const h = await this.pipeline.message(m);
      if (h) await this.tell(h);
      if (!h?.checkIn) return;
      // A check-in: no poll is due for POLL_MS (a poll's answer is one too).
      this.lastHeard.set(h.hardwareId, h.time);
      // The device is awake: its configure, if it is due.
      this.configureIfDue(h.hardwareId);
    });
  }

  /** herdsman's announce of a device: its converters' `deviceAnnounce`. */
  announced(device: Zh.Device): Promise<void> {
    return this.then(async () => {
      // An announce is a frame heard from it: a device plugged back in sends one.
      this.availability.heard(device.ieeeAddr);
      const k = this.known.get(device.ieeeAddr);
      if (!k) return;
      const ex = this.exchange("deviceAnnounce");
      await this.hook(k, { type: "deviceAnnounce", data: this.data(k.model, k.override, ex) }, ex);
    });
  }

  /**
   * herdsman let in a device new to it: its converters' `deviceJoined`, as zigbee2mqtt delivers it
   * (plan 3b). The device has no definition before its interview, so only the converters' own hook
   * runs, for the converters' own state; herdsman's model has no manufacturer yet, so the hook sets no
   * read handler (a Legrand device's is set only after a successful interview), and the exchange opens
   * no answers in practice (plan 3b review M2).
   */
  joined(model: Zh.Device): Promise<void> {
    return this.then(async () => {
      this.unconfigure(model);
      const ex = this.exchange("deviceJoined");
      await this.hook({}, { type: "deviceJoined", data: this.data(model, undefined, ex) }, ex);
    });
  }

  /**
   * herdsman's interview of a device, at each status: its converters' `deviceInterview` (plan 3b),
   * with the definition's own hook once the device is described (a successful interview describes it
   * first: `add`).
   */
  interview(model: Zh.Device, status: "started" | "successful" | "failed"): Promise<void> {
    return this.then(async () => {
      const k = this.known.get(model.ieeeAddr);
      const ex = this.exchange("deviceInterview");
      await this.hook(k ?? {}, { type: "deviceInterview", data: { ...this.data(model, k?.override, ex), status } }, ex);
    });
  }

  /** The device left or was removed: its converters' `stop`, which clears their timers, and its messages read no more. */
  remove(hw: HardwareId): Promise<void> {
    return this.then(async () => {
      await this.forget(hw);
      this.sent.delete(hw);
      this.settings.delete(hw);
      this.tried.delete(hw);
      this.refusedAt.delete(hw);
      this.failures.delete(hw);
      this.lastHeard.delete(hw);
      this.lastPolled.delete(hw);
      this.unanswered.delete(hw);
      this.availability.forget(hw);
      this.cancelRetry(hw);
    });
  }

  /** The controller closed: every device's converters are stopped; the next controller's devices are described again. */
  clear(): Promise<void> {
    return this.then(async () => {
      for (const hw of [...this.known.keys()]) await this.forget(hw);
      // A retry belongs to the controller whose link it would use.
      for (const hw of [...this.retries.keys()]) this.cancelRetry(hw);
    });
  }

  /**
   * The device's description sent again, though nothing in it changed: hardware admitted anew under
   * the window rule takes a new id, and herdsman interviews it no more (plan 3b). A device not
   * described yet (its controller still starting) is sent when it is.
   */
  resend(hw: HardwareId): Promise<void> {
    return this.then(async () => {
      this.sent.delete(hw);
      const k = this.known.get(hw);
      if (!k) return;
      // A new admission: configured again, its bound null until then; it has just spoken, so it is awake.
      this.unconfigure(k.model);
      this.failures.delete(hw);
      await this.redescribe(hw);
      this.configureIfDue(hw);
    });
  }

  /**
   * Polls each device described as polled whose last check-in and last poll are POLL_MS old or more,
   * the longest-waiting first, one at a time, outside the queue (the design, *Freshness*). The doer
   * calls it after each successful health exchange, so nothing is polled while the coordinator does
   * not answer, or under the owner's switch, which describes no device as polled. The answer comes as
   * the device's message, a check-in.
   */
  async pollDue(): Promise<void> {
    if (this.polling || this.o.noActions) return;
    this.polling = true;
    try {
      for (let hw = this.nextPoll(); hw !== undefined; hw = this.nextPoll()) {
        const k = this.known.get(hw)!;
        const since = this.o.clock.now();
        this.lastPolled.set(hw, since);
        // A device told unavailable is read on its first endpoint where none lists genBasic, so that it can come back.
        const p = await poll(k.model, { anyEndpoint: this.availability.isGone(hw) });
        // Counted in the queue, in order with the device's messages (its answer among them).
        if (p.answered) void this.then(async () => this.availability.heard(hw));
        else if (p.noAnswer && this.covers(hw)) this.retryLater(hw, k.model, since);
        if (!p.answered && !this.unanswered.has(hw)) {
          this.unanswered.add(hw);
          console.error(`zigbee: ${hw}: its poll was not answered: ${p.detail}; read again every ${POLL_MS} ms`);
        } else if (p.answered && this.unanswered.delete(hw)) {
          console.error(`zigbee: ${hw}: its poll is answered again`);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * What a command carried out on the device, begun at `since`, came to (`reachOf`): an answer starts
   * its rows again, and a command with no answer counts towards its going unavailable, unless the
   * device was heard after it began. Counted in the queue, in order with the device's messages.
   */
  commanded(hw: HardwareId, reach: "answered" | "unanswered" | undefined, since: number): Promise<void> {
    if (reach === undefined) return Promise.resolve();
    return this.then(async () => (reach === "answered" ? this.availability.heard(hw) : this.availability.missed(hw, "command", since)));
  }

  /**
   * A covered device's poll went unanswered: read once more POLL_RETRY_MS later, with herdsman's
   * recovery, as zigbee2mqtt's ping does; the poll counts as a miss only when that read goes
   * unanswered too, and the device was not heard since the poll began.
   */
  private retryLater(hw: HardwareId, model: Zh.Device, since: number): void {
    // Only for the device the poll read, on the controller it read it through: a poll that returns
    // after `clear()` (the controller closed, or the doer stopped) sets no timer, and none crosses to
    // the next controller's model.
    if (this.retries.has(hw) || this.known.get(hw)?.model !== model) return;
    this.retries.set(hw, this.o.clock.setTimeout(() => {
      this.retries.delete(hw);
      void this.retry(hw, model, since);
    }, POLL_RETRY_MS));
  }

  private async retry(hw: HardwareId, model: Zh.Device, since: number): Promise<void> {
    const k = this.known.get(hw);
    if (!k || k.model !== model || this.o.noActions) return;
    // The cadence stays the poll's: the next poll is POLL_MS after it, not after its retry.
    const p = await poll(k.model, { recovery: true, anyEndpoint: this.availability.isGone(hw) });
    if (p.answered) void this.then(async () => this.availability.heard(hw));
    else if (p.noAnswer) void this.then(async () => this.availability.missed(hw, "poll", since));
  }

  private cancelRetry(hw: HardwareId): void {
    const h = this.retries.get(hw);
    if (h === undefined) return;
    this.o.clock.clear(h);
    this.retries.delete(hw);
  }

  /** The polled device that has waited longest since it was heard or polled, if one has waited POLL_MS. */
  private nextPoll(): HardwareId | undefined {
    const now = this.o.clock.now();
    let next: HardwareId | undefined;
    let nextAt = Number.POSITIVE_INFINITY;
    for (const [hw, k] of this.known) {
      // A covered device told unavailable is read whatever its basis, so that it can come back.
      if (k.described.description.basis !== "poll" && !this.availability.isGone(hw)) continue;
      const last = Math.max(this.lastHeard.get(hw) ?? Number.NEGATIVE_INFINITY, this.lastPolled.get(hw) ?? Number.NEGATIVE_INFINITY);
      if (now - last < POLL_MS || last >= nextAt) continue;
      next = hw;
      nextAt = last;
    }
    return next;
  }

  /** herdsman's mark of a configure run forgotten (a new admission), so that the device is configured again (zigbee2mqtt's `onDeviceJoined`). */
  private unconfigure(model: Zh.Device): void {
    if (model.meta?.configured === undefined) return;
    delete model.meta.configured;
    model.save();
  }

  /** The description of a device as last sent, if any. */
  description(hw: HardwareId): Description | undefined {
    return this.known.get(hw)?.described.description;
  }

  /** The device as described. */
  described(hw: HardwareId): Described | undefined {
    return this.known.get(hw)?.described;
  }

  /**
   * What carrying out an action on the device takes: herdsman's own model, its definition, the
   * override and the converters' state for it, and the device as described now.
   */
  target(hw: HardwareId): Target | undefined {
    const k = this.known.get(hw);
    if (!k) return undefined;
    return { model: k.model, definition: k.definition, ...(k.override ? { override: k.override } : {}), described: k.described,
      state: this.pipeline.state(hw) };
  }

  private async forget(hw: HardwareId): Promise<void> {
    const k = this.known.get(hw);
    this.known.delete(hw);
    // A configure under way is cut short: nothing it sends later reaches herdsman.
    const running = this.configuring.get(hw);
    if (running) running.closed = true;
    this.pipeline.delete(hw);
    if (k) await this.hook(k, { type: "stop", data: { ieeeAddr: hw } });
  }

  /**
   * What a message gave, told to the core: a setting changed, or an awaited key's first report,
   * first describes the device again, and the new description goes out before the observation that
   * carried it (GA-BRIDGE-74, GA-BRIDGE-80).
   */
  private async tell(h: Heard): Promise<void> {
    const events = this.o.events();
    const k = this.known.get(h.hardwareId);
    if (!events || !k) return;
    const kept = this.settings.get(h.hardwareId) ?? {};
    const changed = [...k.described.settings.values()].filter((key) => key in h.readings && h.readings[key] !== kept[key]);
    const first = (k.described.description.awaitedKeys ?? []).filter((key) => key in h.readings);
    if (changed.length || first.length) {
      for (const key of changed) kept[key] = h.readings[key];
      this.settings.set(h.hardwareId, kept);
      const reported = this.reported.get(h.hardwareId) ?? new Set();
      for (const key of first) reported.add(key);
      this.reported.set(h.hardwareId, reported);
      await this.redescribe(h.hardwareId);
    }
    if (Object.keys(h.readings).length || h.checkIn) events.observed(h.hardwareId, h.readings, h.time, h.checkIn);
    for (const o of h.occurrences) events.occurred(h.hardwareId, o.key, o.value, h.time, h.frameId);
    if (h.undescribed.length) events.undescribed(h.hardwareId, h.undescribed);
  }

  /** Describes a known device again, for its settings as last observed or its exposes changed. */
  private async redescribe(hw: HardwareId): Promise<void> {
    const k = this.known.get(hw);
    if (!k) return;
    k.described = await describe(k.device, k.definition, this.describing(hw, k.override));
    this.pipeline.set(hw, { definition: k.definition, keys: k.described.keys, ...(k.override ? { override: k.override } : {}) });
    this.send(k);
  }

  /**
   * Runs the device's `configure`, outside the queue, where it is due: the definition has one, it has
   * not succeeded at the definition's version (herdsman's device `meta.configured`), none is running,
   * the guard did not refuse it at this version, it has not failed CONFIGURE_TRIES times at this
   * version since the bridge started or the device was last interviewed, and its last try was
   * CONFIGURE_RETRY_MS ago or more.
   * None under the owner's switch, and none without a controller's coordinator to bind to.
   */
  private configureIfDue(hw: HardwareId): void {
    const k = this.known.get(hw);
    const coordinator = this.o.coordinator?.();
    if (!k || this.o.noActions || !coordinator || !configures(k.definition, k.override)) return;
    const version = configureVersion(k.definition, k.override);
    if (k.model.meta?.configured === version || this.configuring.has(hw) || this.refusedAt.get(hw) === version) return;
    const failed = this.failures.get(hw);
    if (failed?.version === version && failed.count >= CONFIGURE_TRIES) return;
    const last = this.tried.get(hw);
    if (last !== undefined && this.o.clock.now() - last < CONFIGURE_RETRY_MS) return;
    this.tried.set(hw, this.o.clock.now());
    void this.configure(hw, k, coordinator, version);
  }

  private async configure(hw: HardwareId, k: Known, coordinator: Zh.Endpoint, version: string): Promise<void> {
    const r = await runConfigure(k.definition, k.model, coordinator, { clock: this.o.clock, opened: (g) => this.configuring.set(hw, g),
      ...(k.override ? { override: k.override } : {}) })
      .catch(() => ({ outcome: "failed" as const, detail: "configure failed" }));
    this.configuring.delete(hw);
    if (r.outcome === "configured") {
      console.error(`zigbee: ${hw}: configured (${k.definition.model}, version ${version})`);
      this.tried.delete(hw);
      this.failures.delete(hw);
      // Described again with the bound the reporting set up gives, while the device is still the one configured.
      if (this.known.get(hw) === k) void this.then(async () => this.redescribe(hw));
      return;
    }
    if (r.outcome === "refused") {
      this.refusedAt.set(hw, version);
      console.error(`zigbee: ${hw}: configure (${k.definition.model}) needs a call the doer does not send; not tried again, and no bound`);
      return;
    }
    const before = this.failures.get(hw);
    const count = before?.version === version ? before.count + 1 : 1;
    this.failures.set(hw, { version, count });
    console.error(`zigbee: ${hw}: configure (${k.definition.model}) failed: ${r.detail}; ${count < CONFIGURE_TRIES ? "tried again at its next message"
      : `given up after ${CONFIGURE_TRIES} tries, until the bridge restarts or the device is interviewed again`}`);
  }

  /**
   * What describing the device takes: its override, its settings as last observed, its awaited keys
   * reported, and whether the doer polls (not under the owner's switch, which sends a device nothing).
   */
  private describing(hw: HardwareId, override: Override | undefined) {
    return { ...(override ? { override } : {}), settings: this.settings.get(hw) ?? {}, reported: this.reported.get(hw) ?? new Set<string>(),
      polls: !this.o.noActions };
  }

  /** Sends the device's description to the core, unless it is the one sent last. */
  private send(k: Known): void {
    const d = this.o.noActions ? withoutActions(k.described.description) : k.described.description;
    const text = JSON.stringify(d);
    if (this.sent.get(d.hardwareId) === text) return;
    this.sent.set(d.hardwareId, text);
    this.o.events()?.described(d);
  }

  /**
   * A converter hook, as zigbee2mqtt calls them: the converters' own, then the definition's, where the
   * device has one yet; a throw is logged, never the device's end. The event's exchange, if any,
   * closes when the hook returns.
   */
  private async hook({ definition }: { definition?: Definition }, event: OnEvent.Event, ex?: Exchange): Promise<void> {
    try {
      await convertersOnEvent(event);
      await definition?.onEvent?.(event);
    } catch (err) {
      console.error(`zigbee: ${definition?.model ?? "converters"}: onEvent ${event.type}: ${redact(String((err as Error)?.message ?? err))}`);
    } finally {
      if (ex) ex.closed = true;
    }
  }

  /** An event's exchange, whose answers the guard lets through while its hooks run (plan 2c-3); none under the owner's switch. */
  private exchange(type: string): Exchange | undefined {
    return this.o.noActions ? undefined : eventExchange(type);
  }

  /**
   * A hook's data: herdsman's model of the device through the guard, or opened for the event's answers
   * (a read handler a hook sets through it may answer the device's reads); and the model's options.
   */
  private data(model: Zh.Device, override: Override | undefined, ex?: Exchange): OnEvent.BaseData {
    const hw = model.ieeeAddr;
    return { device: ex ? answering(model, ex) : guard(model), state: this.pipeline.state(hw), options: { ...override?.options },
      deviceExposesChanged: () => void this.then(async () => this.redescribe(hw)) };
  }

  /** Runs `step` after everything before it, whatever became of that. */
  private then(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step).catch((err) => {
      console.error(`zigbee: ${redact(String((err as Error)?.message ?? err))}`);
    });
    this.queue = next;
    return next;
  }
}

/** A description with no action, nor any extension action: the keys alone (the owner's switch). */
function withoutActions(d: Description): Description {
  const extensions = d.extensions?.map(({ actions: _actions, ...e }) => e);
  return { ...d, actions: [], ...(extensions ? { extensions } : {}) };
}
