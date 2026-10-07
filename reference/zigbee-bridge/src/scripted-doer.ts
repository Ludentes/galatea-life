import { validate } from "@ludentes/galatea-life-schemas";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Admission, Description, DoerEvents, DoerPort, HardwareId, ProtocolResult } from "./port.js";
import type { KeyMap } from "./herdsman/describe.js";
import { Link, type LinkMutation } from "./transport.js";
import { closedActions, closedSets, heldBack, type ActionDecl, type DescribeMutation } from "./vocabulary.js";
import type { Delivery, Wire } from "./wire.js";

/** The harness asked for an op this scripted doer cannot play; the reply says so (`unsupported`). */
export class UnsupportedOp extends Error {}

/**
 * What the radio sent, as the harness reads it on `received`: wave 0's shape. A join window the doer
 * opens or closes is `{ device: <the router's hardware, or WINDOW_EVERYWHERE>, action: WINDOW_ACTION,
 * args: { windowMs } }`, `windowMs` 0 for a close (GA-BRIDGE-25, 26).
 */
export interface Received {
  device: string;
  action: string;
  args: Record<string, unknown>;
}

/** `received`'s action for a join window the scripted coordinator opened or closed. */
export const WINDOW_ACTION = "provision.window";
/** `received`'s device for a window open house-wide. */
export const WINDOW_EVERYWHERE = "*";

/** The model a scripted device is unless its entry names another. */
export const SCRIPTED_MODEL = { vendor: "galatea", model: "scripted" };
/**
 * The scripted model's entry in the doer's model database: it is known to report every 60 s. A
 * device of another model has no entry, so its bound is null until `reporting` gives one (GA-BRIDGE-13).
 */
export const SCRIPTED_MODEL_REPORT_MS = 60_000;

/** A device's reporting facts, as the protocol's configuration and the model database give them. */
interface Reporting {
  /** The intervals it is configured to report at; none configured is `[]`. */
  configuredMs: number[];
  /** The interval its model is known to report at; null for a model with no entry. */
  modelMs: number | null;
}

/** The `classEvidence` for where the doer found a device's class (GA-BRIDGE-15). */
const EVIDENCE = { device: "protocol", modelDb: "model_db", guess: "none" } as const;

export interface ScriptedDoerOptions {
  clock: Clock;
  /** Publishes what the radio sent on the control topic's `received`. */
  onReceived(r: Received): Promise<void>;
  /** The harness's `stall`: the bridge's main loop waits that long. */
  onStall(ms: number): void;
  /**
   * `lockPin`'s `pin`: the owner sets it in the bridge's own configuration, never through the core's
   * events (GA-BRIDGE-36). The op names the lock's hardware, as every op does; the configuration
   * holds it under the device id that hardware has now.
   */
  onPin?(hardwareId: string, pin: string): void;
  /** A negative mutation of the coordinator's link, only under a run. */
  mutation?: LinkMutation;
  /** A negative mutation of describing (`maps-motion-to-occupancy`, `holds-back-the-leak`), only under a run. */
  describeMutation?: DescribeMutation;
}

/**
 * What the converters call a reading of a `libraryDevice`, by what it means: a movement sensor's is
 * `occupancy` (a PIR's), a presence sensor's `presence` (a radar's). The op names the converters'
 * property; its meaning is the harness's word, which the bridge never reads: it maps by its table.
 */
const LIBRARY_EXPOSE = (name: string) => ({ type: "binary", name, property: name, access: 1, value_on: true, value_off: false });

/**
 * What the stack says of the next command, by `commandResult`'s name for it: the protocol's answer
 * (`confirmed`, `rejected`, `none`), or the ack it should end in, as the stack would bring it about.
 * `unsupported` and `received` are the core's own acks, which no stack's answer brings: refused.
 */
const ANSWERS: Record<string, (detail?: string) => ProtocolResult> = {
  confirmed: () => ({ kind: "confirmed" }),
  rejected: (detail = "FAILURE") => ({ kind: "refused", reason: "refused", detail }),
  none: (detail = "no answer from the device") => ({ kind: "lost", detail }),
  no_confirmation: (detail = "no answer from the device") => ({ kind: "lost", detail }),
  sent: () => ({ kind: "transmitted" }),
  unreachable: (detail) => ({ kind: "notSent", reason: "unreachable", ...(detail ? { detail } : {}) }),
  expired: (detail) => ({ kind: "notSent", reason: "expired", ...(detail ? { detail } : {}) }),
};

/** How the device answers its next command, as `commandResult` or `protocolResult` set it. */
interface Answer {
  result: ProtocolResult;
  afterMs?: number;
  reportAfterMs?: number;
}

/** A device's declarations as the harness scripts them: a `devices` entry less its id, and what a setting changes. */
type Entry = Record<string, unknown>;
interface BySetting {
  key: string;
  entries: Record<string, Entry>;
}

interface ScriptedDevice {
  entry: Entry;
  bySetting?: BySetting;
  d: Description;
  /** The setting's value `d` was declared for; undefined while none was known. */
  declaredFor?: unknown;
  /** What the device holds, as it would report it. */
  values: Record<string, unknown>;
  silent: boolean;
  /** False once it left the network: it keeps its declarations, for an `admit` to bring it back. */
  present: boolean;
  next?: Answer;
  /** Its reporting facts, as `reporting` scripted them; the model database's alone until then. */
  reporting?: Reporting;
  /** Its class and where the doer found it, as `classFrom` scripted them; none until then. */
  classFrom?: { proposedClass: string; from: keyof typeof EVIDENCE };
  /** A lock that requires a PIN for remote operation, as `lockPin` scripted it. */
  requiresPin?: boolean;
  /** The keys its model's records name as promised and seen missing (`describe`'s `seenMissing`, GA-BRIDGE-80). */
  seenMissing?: string[];
  /** A device the converters describe (`libraryDevice`): its reports are the converters' properties, read through these. */
  library?: Map<string, KeyMap>;
}

const ADMISSIONS: readonly Admission[] = ["association", "tcRejoinWellKnown", "securedRejoin", "tcRejoinUniqueKey"];

/**
 * The network behind the test transport (GA-BRIDGE-16): a coordinator that answers while the
 * harness says the transport is up, and devices the harness makes join, describe, report, occur,
 * check in, fall silent, leave and come back. It runs on a connection of its own, as the PC
 * bridge's scripted OS does.
 */
export class ScriptedDoer implements DoerPort {
  /** The scripted coordinator opens windows and removes devices (Provision). */
  readonly provisions = true;
  private events?: DoerEvents;
  private readonly devices = new Map<HardwareId, ScriptedDevice>();
  /** The settings the core kept across its restart, by hardware: declared from until the device reports again. */
  private kept = new Map<HardwareId, Record<string, unknown>>();
  /**
   * Hardware the core kept across its restart (`start`'s `settings` names every device it keeps): the
   * network has it already, so its first description after the start is no interview, as herdsman
   * loads its database without interviewing (GA-BRIDGE-79).
   */
  private readonly resumed = new Set<HardwareId>();
  /** The held-back keys each device has reported once, as the core kept them and as reported since (GA-BRIDGE-80). */
  private readonly reported = new Map<HardwareId, Set<string>>();
  /** Whether the scripted coordinator answers. */
  private linkUp = true;
  /** Whether its host link is there (the `hostLink` op's `open`): a try while the transport is down opens it, a connect. */
  private carrier = true;
  private readonly link: Link;
  /** The network's native ways to change a device without the applier, and whether the doer can disable each (GA-BRIDGE-32). */
  private readonly ways = new Map<string, boolean>();
  /** Where the scripted coordinator's join window is open, if it is: a router's hardware, or WINDOW_EVERYWHERE. */
  private windowAt?: string;
  /** Removals waiting for a device that does not answer, each ended when it answers, leaves or is forced out. */
  private readonly removals = new Map<HardwareId, { done: () => void; failed: (err: Error) => void }>();
  /**
   * The read of each device described as polled, by hardware: its timer and the cadence it runs at
   * (*The roster and freshness*: a polled device's check-in is its answer to the bridge's read).
   */
  private readonly polls = new Map<HardwareId, { handle: number; cadenceMs: number }>();
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly o: ScriptedDoerOptions) {
    this.link = new Link({
      clock: o.clock,
      // A try while down rebuilds the controller: the host link opens (a connect), then the exchange.
      probe: async () => {
        if (this.carrier && this.link.t.state === "down") this.link.connected();
        return this.linkUp;
      },
      report: (state, since, retryIntervalMs) => this.events?.transport(state, since, retryIntervalMs),
      ...(o.mutation ? { mutation: o.mutation } : {}),
    });
  }

  /** Serves the control topic on the doer's own connection, one message at a time, each answered on `…/reply`. */
  async serve(wire: Wire, topic: string): Promise<void> {
    wire.onMessage((d) => {
      if (d.topic !== topic || d.retained) return;
      // The queue never rejects: one message that fails leaves every later one served.
      this.queue = this.queue.then(() => this.onControl(wire, topic, d)).catch((err) => console.error(`control: ${err}`));
    });
    const refused = await wire.subscribe([topic]);
    if (refused.length) throw new Error(`the broker refused ${topic}`);
    // The session is clean: after the broker's loss the control topic is asked for again, as the radio is not the broker.
    wire.onReconnect(() => {
      wire.subscribe([topic]).catch((err) => console.error(`control: subscribing again: ${err}`));
    });
  }

  private async onControl(wire: Wire, topic: string, d: Delivery): Promise<void> {
    let msg: unknown;
    let reply: Record<string, unknown>;
    try {
      msg = JSON.parse(d.payload.toString());
      const errors = validate("harness/test-control.json", msg);
      if (errors.length) throw new Error(errors.join("; "));
      const valid = msg as Record<string, unknown>;
      await this.control(valid);
      reply = { requestId: valid.requestId, ok: true };
    } catch (err) {
      // A message that is not an object (JSON `null`, a number) has no requestId: the reply carries "".
      const requestId = msg !== null && typeof msg === "object" ? (msg as Record<string, unknown>).requestId : undefined;
      reply = { requestId: typeof requestId === "string" ? requestId : "", ok: false, error: String((err as Error).message ?? err),
        ...(err instanceof UnsupportedOp ? { unsupported: true } : {}) };
    }
    await wire.publish(`${topic}/reply`, reply, false).catch((err) => console.error(`control reply: ${err}`));
  }

  /** One control message. */
  async control(msg: Record<string, unknown>): Promise<void> {
    switch (msg.op) {
      case "join": {
        const model = msg.model as { vendor?: unknown; model?: unknown } | undefined;
        return this.describe(msg.device as string, {
          capabilities: msg.capabilities, feedback: msg.feedback,
          ...(typeof model?.vendor === "string" && typeof model.model === "string" ? { model: { vendor: model.vendor, model: model.model } } : {}),
        });
      }
      case "describe":
        return this.describe(msg.device as string, msg.entry as Entry, msg.bySetting as BySetting | undefined,
          msg.seenMissing as string[] | undefined);
      case "libraryDevice":
        return this.libraryDevice(msg.device as string, msg.readings as { name: string }[]);
      case "interview": {
        // Interviewed again, as after a reset: the core drops what it kept of the device's settings,
        // the device answers no read of them, and it is declared again by their worst case (GA-BRIDGE-79).
        const dev = this.device(msg.device);
        const hw = dev.d.hardwareId;
        this.kept.delete(hw);
        for (const k of dev.d.settings ?? []) delete dev.values[k];
        this.events?.interviewed(hw);
        return this.redescribe(dev);
      }
      case "report": {
        const dev = this.device(msg.device);
        this.report(dev, msg.values as Record<string, unknown>, Date.parse(msg.observedAt as string));
        return;
      }
      case "setting": {
        const dev = this.device(msg.device);
        this.report(dev, { [msg.key as string]: msg.value }, Date.parse(msg.observedAt as string));
        return;
      }
      case "occur": {
        const dev = this.device(msg.device);
        if (!this.linkUp) return;
        this.link.heard();
        this.events?.occurred(dev.d.hardwareId, msg.key as string, msg.value, Date.parse(msg.observedAt as string), msg.frameId as string);
        return;
      }
      case "undescribed": {
        const dev = this.device(msg.device);
        if (!this.linkUp) return;
        this.link.heard();
        this.events?.undescribed(dev.d.hardwareId, msg.names as string[]);
        return;
      }
      case "admit": {
        // The scripted network knows the hardware from its earlier join: an admission brings it back with its declarations.
        const hw = msg.device as string;
        const dev = this.devices.get(hw);
        if (!dev) throw new Error(`no device ${hw} has joined, so nothing is known to admit`);
        const how = msg.how as Admission;
        if (!ADMISSIONS.includes(how)) throw new Error(`${String(how)} is no way in`);
        // Hardware out of the network is asked about first, and a refused one stays out (GA-BRIDGE-27).
        // So is hardware in it that the harness says is new (an association, or a trust-centre rejoin
        // under the well-known key): the doer reports what it is told, so it need not model the
        // window rule, and a refused one is turned out, as herdsman's Leave Request does.
        const isNew = how === "association" || how === "tcRejoinWellKnown";
        if ((!dev.present || isNew) && !this.mayAdmit(hw)) {
          if (dev.present) this.out(dev);
          return;
        }
        dev.present = true;
        this.events?.admitted(hw, how);
        this.events?.described(dev.d);
        return;
      }
      case "leave":
        return this.out(this.device(msg.device));
      case "checkIn":
        this.heard(this.device(msg.device), {}, Date.parse(msg.at as string));
        return;
      case "silence": {
        const dev = this.device(msg.device);
        dev.silent = msg.silent as boolean;
        // A removal waiting for the device ends once it answers.
        if (!dev.silent && this.linkUp && this.removals.has(dev.d.hardwareId)) this.out(dev);
        return;
      }
      case "commandResult": {
        const { result, afterMs, reportAfterMs, detail } = msg as { result: string; afterMs?: number; reportAfterMs?: number; detail?: string };
        if (!ANSWERS[result]) throw new UnsupportedOp(`${result} is the core's own ack, which no answer of the stack brings`);
        // The ack's source is the bridge's, whatever the stack says (GA-BRIDGE-4).
        if (msg.source !== undefined) throw new UnsupportedOp("a Zigbee device cannot change the ack's source");
        const dev = this.device(msg.device);
        dev.next = { result: ANSWERS[result]!(detail), ...(afterMs !== undefined ? { afterMs } : {}),
          ...(reportAfterMs !== undefined ? { reportAfterMs } : {}) };
        return;
      }
      case "protocolResult": {
        const dev = this.device(msg.device);
        dev.next = { result: protocolResult(msg) };
        return;
      }
      case "transportState":
        if (msg.state === "unknown") throw new UnsupportedOp("a Zigbee coordinator is never unknown: it answers or it does not");
        this.linkUp = msg.state === "up";
        this.carrier = this.linkUp;
        // Down is the link lost, as the stack reports a closed socket: at once. Up is tried at once.
        if (this.linkUp) await this.link.exchangeNow();
        else this.link.lost();
        // A removal waiting for a device that answers ends once the coordinator does.
        if (this.linkUp) for (const hw of [...this.removals.keys()]) if (!this.devices.get(hw)!.silent) this.out(this.devices.get(hw)!);
        return;
      case "hostLink":
        // The coordinator's host link (`open`) and its answers (`answers`): a link with no answer is a
        // coordinator that connects and is silent, each try a connect and no exchange.
        this.carrier = msg.open as boolean;
        this.linkUp = this.carrier && (msg.answers as boolean);
        if (!this.carrier) this.link.lost();
        else if (this.linkUp) await this.link.exchangeNow();
        return;
      case "windowState":
        // The scripted network opens no window of its own: only the bridge's `join` opens one.
        throw new UnsupportedOp("the scripted coordinator opens a window only on the bridge's join");
      case "stateMismatch":
        this.events?.fault("state_mismatch",
          msg.disagrees ? "the coordinator answers with another network than the one the store holds" : null);
        return;
      case "reporting": {
        const dev = this.device(msg.device);
        dev.reporting = { configuredMs: msg.configuredMs as number[], modelMs: msg.modelMs as number | null };
        return this.redescribe(dev);
      }
      case "classFrom": {
        const dev = this.device(msg.device);
        dev.classFrom = { proposedClass: msg.proposedClass as string, from: msg.from as keyof typeof EVIDENCE };
        return this.redescribe(dev);
      }
      case "nativeControl": {
        // A way it can disable, it disables; the rest it reports, as the core must list them.
        this.ways.set(msg.way as string, msg.canDisable as boolean);
        this.events?.ungoverned(this.ungovernedWays());
        return;
      }
      case "lockPin": {
        const dev = this.device(msg.device);
        dev.requiresPin = msg.requiresPin as boolean;
        if (typeof msg.pin === "string") this.o.onPin?.(dev.d.hardwareId, msg.pin);
        return this.redescribe(dev);
      }
      case "foreignBinding":
        // The binding is now in the network; this build reads no binding table, so it changes no
        // declaration: every otherAdmins stays `unknown` (GA-BRIDGE-14).
        this.device(msg.device);
        this.device(msg.target);
        return;
      case "stall":
        this.o.onStall(msg.ms as number);
        return;
      default:
        throw new UnsupportedOp(`${String(msg.op)} is not played by the Zigbee bridge's scripted doer`);
    }
  }

  /**
   * A device described as `entry` gives it, joining if it is new: its declarations are the entry's,
   * with those `bySetting` gives for its setting's value, as last reported, or as the core kept it
   * across its restart; with no value yet, the entry's alone (GA-BRIDGE-74).
   */
  private describe(hw: HardwareId, entry: Entry, bySetting?: BySetting, seenMissing?: string[], library?: Map<string, KeyMap>): void {
    const known = this.devices.get(hw);
    if (known) {
      if (seenMissing) known.seenMissing = seenMissing;
      else delete known.seenMissing;
      if (library) known.library = library;
      else delete known.library;
    }
    // Hardware out of the network (new, left or removed) is asked about first; a refused one stays out (GA-BRIDGE-27).
    if (!known?.present && !this.mayAdmit(hw)) {
      if (known) known.entry = entry;
      else {
        const fresh = { entry, values: {}, silent: false, present: false, ...(seenMissing ? { seenMissing } : {}),
          ...(library ? { library } : {}) } as ScriptedDevice;
        this.devices.set(hw, { ...fresh, d: this.declarations(hw, fresh) });
      }
      return;
    }
    const dev: ScriptedDevice = known ?? { entry, d: undefined as never, values: {}, silent: false, present: true,
      ...(seenMissing ? { seenMissing } : {}), ...(library ? { library } : {}) };
    dev.entry = entry;
    if (bySetting) dev.bySetting = bySetting;
    else delete dev.bySetting;
    dev.present = true;
    dev.d = this.declarations(hw, dev);
    this.devices.set(hw, dev);
    this.events?.described(dev.d);
    this.pollAsDeclared(dev);
    // Hardware that came in is interviewed: its model and capabilities are known now. Hardware the
    // network had before the start is not.
    const resumed = this.resumed.delete(hw);
    if (!known?.present && !resumed) this.events?.interviewed(hw);
  }

  /**
   * The device's description from its entry and its setting's value. Its bound, class and other
   * admins are derived from the network's facts, never taken from the entry: the bound from its
   * reporting facts or its poll (GA-BRIDGE-13), the class from where the doer found it
   * (GA-BRIDGE-15), and otherAdmins `unknown`, as no binding table is read in this build (the design,
   * *Not in this build*; GA-BRIDGE-14).
   */
  private declarations(hw: HardwareId, dev: ScriptedDevice): Description {
    const s = dev.bySetting;
    const value = s ? (s.key in dev.values ? dev.values[s.key] : this.kept.get(hw)?.[s.key]) : undefined;
    dev.declaredFor = value;
    const e: Entry = { ...dev.entry, ...(s && value !== undefined ? s.entries[String(value)] ?? {} : {}) };
    const feedback = e.feedback === "open" ? "open" : "closed";
    const capabilities = (e.capabilities ?? []) as string[];
    if (!Array.isArray(capabilities)) throw new Error("an entry's capabilities are a list");
    const opt = <K extends string>(k: K) => (e[k] !== undefined ? { [k]: e[k] } : {});
    const model = (e.model as Description["model"] | undefined) ?? SCRIPTED_MODEL;
    const basis = typeof e.basis === "string" ? e.basis : "report";
    const cadenceMs = typeof e.cadenceMs === "number" ? e.cadenceMs : null;
    const scripted = model.vendor === SCRIPTED_MODEL.vendor && model.model === SCRIPTED_MODEL.model;
    const reporting = dev.reporting ?? { configuredMs: [], modelMs: scripted ? SCRIPTED_MODEL_REPORT_MS : null };
    // Held back until first reported: the rule the herdsman doer's describing keeps (GA-BRIDGE-80).
    const promised = (e.sensorKeys ?? []) as string[];
    const awaitedKeys = heldBack(promised, dev.seenMissing, this.reported.get(hw), this.o.describeMutation === "holds-back-the-leak");
    if (awaitedKeys.length) e.sensorKeys = promised.filter((k) => !awaitedKeys.includes(k));
    return {
      hardwareId: hw,
      stableIdentifier: typeof e.stableIdentifier === "string" ? e.stableIdentifier : hw,
      model,
      capabilities,
      ...opt("sensorKeys"),
      actions: (e.actions as ActionDecl[] | undefined) ?? capabilities.flatMap((c) => closedActions(c, feedback === "closed")),
      feedback,
      reachMs: typeof e.reachMs === "number" ? e.reachMs : 0,
      proposedClass: dev.classFrom?.proposedClass ?? null,
      classEvidence: dev.classFrom ? EVIDENCE[dev.classFrom.from] : "none",
      otherAdmins: "unknown",
      ...opt("extensions"),
      ...opt("personal"),
      ...opt("selfChanging"),
      ...(s ? { settings: [s.key] } : opt("settings")),
      ...(awaitedKeys.length ? { awaitedKeys } : {}),
      ...(dev.requiresPin ? { pinRequired: true } : {}),
      ...(e.router === true ? { router: true } : {}),
      basis,
      cadenceMs,
      basisMaxAgeMs: feedback === "open" ? null : bound(basis, cadenceMs, reporting),
    } as Description;
  }

  /** Whether the core lets the hardware in now (`DoerEvents.mayAdmit`); yes before the core is listening. */
  private mayAdmit(hw: HardwareId): boolean {
    return this.events?.mayAdmit(hw) ?? true;
  }

  /** The device is out of the network: it left, or was removed; a removal waiting for it ends. */
  private out(dev: ScriptedDevice): void {
    dev.present = false;
    dev.next = undefined;
    this.events?.left(dev.d.hardwareId);
    const waiting = this.removals.get(dev.d.hardwareId);
    this.removals.delete(dev.d.hardwareId);
    waiting?.done();
  }

  /** The device's facts changed: it is described again from them. */
  private redescribe(dev: ScriptedDevice): void {
    dev.d = this.declarations(dev.d.hardwareId, dev);
    this.events?.described(dev.d);
    this.pollAsDeclared(dev);
  }

  /**
   * Reads the device at the cadence its declarations give where they say `poll`, as the herdsman doer
   * polls a device in reach; stops reading it where they no longer do. The device answers each read,
   * a check-in with no reading, while it is in the network, not silent, and the coordinator answers;
   * an unanswered read is nothing the core hears (GA-BRIDGE-13, 37).
   */
  private pollAsDeclared(dev: ScriptedDevice): void {
    const hw = dev.d.hardwareId;
    const cadenceMs = dev.d.basis === "poll" && dev.d.cadenceMs !== null && dev.d.cadenceMs > 0 ? dev.d.cadenceMs : null;
    const running = this.polls.get(hw);
    if (running?.cadenceMs === cadenceMs) return;
    if (running) this.o.clock.clear(running.handle);
    this.polls.delete(hw);
    if (cadenceMs === null || this.stopped) return;
    const read = () => {
      const now = this.devices.get(hw);
      if (now?.present && !now.silent) this.heard(now, {}, this.o.clock.now());
      this.polls.set(hw, { handle: this.o.clock.setTimeout(read, cadenceMs), cadenceMs });
    };
    this.polls.set(hw, { handle: this.o.clock.setTimeout(read, cadenceMs), cadenceMs });
  }

  private device(name: unknown): ScriptedDevice {
    const dev = this.devices.get(name as string);
    if (!dev) throw new Error(`no device ${String(name)} has joined`);
    if (!dev.present) throw new Error(`${String(name)} has left the network`);
    return dev;
  }

  /**
   * The device holds and reports values. Where one is the setting its declarations depend on, and
   * they were declared for another value, the device is described again first, so the new `devices`
   * goes out before the value (GA-BRIDGE-74). Nothing reaches the core while the coordinator is down.
   */
  private report(dev: ScriptedDevice, given: Record<string, unknown>, time: number): void {
    const values = dev.library ? this.fromLibrary(dev.library, given) : given;
    Object.assign(dev.values, values);
    if (!this.linkUp) return;
    const s = dev.bySetting;
    // A held-back key's first report: kept as reported, so it is declared now and never held back again (GA-BRIDGE-80).
    const first = (dev.d.awaitedKeys ?? []).filter((k) => k in values);
    if (first.length) {
      const reported = this.reported.get(dev.d.hardwareId) ?? new Set<string>();
      for (const k of first) reported.add(k);
      this.reported.set(dev.d.hardwareId, reported);
    }
    if (first.length || (s !== undefined && s.key in values && values[s.key] !== dev.declaredFor)) this.redescribe(dev);
    this.heard(dev, values, time);
  }

  /** A message from the device: a check-in, and an exchange with the coordinator. */
  private heard(dev: ScriptedDevice, values: Record<string, unknown>, time: number): void {
    if (!this.linkUp) return;
    this.link.heard();
    this.events?.observed(dev.d.hardwareId, values, time, true);
  }

  /** A converters' report read through the device's keys: a property it maps by its key, any other by its own name. */
  private fromLibrary(keys: Map<string, KeyMap>, given: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [property, v] of Object.entries(given)) {
      const k = keys.get(property);
      if (!k) out[property] = v;
      else if (k.from(v) !== undefined) out[k.key] = k.from(v);
    }
    return out;
  }

  /**
   * A device the converters describe, from the readings the op names: a converters' definition whose
   * exposes are those properties, described by the herdsman doer's own describing, with no override,
   * so the mapping by meaning is the bridge's table (GA-BRIDGE-78).
   */
  private async libraryDevice(hw: HardwareId, readings: { name: string }[]): Promise<void> {
    const { describe } = await import("./herdsman/describe.js");
    const definition = { model: "library", vendor: "galatea", description: "A test transport's library device", zigbeeModel: ["library"],
      exposes: readings.map((r) => LIBRARY_EXPOSE(r.name)) };
    const device = { ieeeAddr: hw, type: "EndDevice", powerSource: "Battery", endpoints: [], manufacturerName: "galatea", modelID: "library",
      meta: {} };
    const described = await describe(device as never, definition as never,
      this.o.describeMutation ? { mutation: this.o.describeMutation } : {});
    const d = described.description;
    this.describe(hw, { capabilities: d.capabilities, ...(d.sensorKeys ? { sensorKeys: d.sensorKeys } : {}), actions: d.actions,
      feedback: d.feedback, model: { vendor: "galatea", model: "library" } }, undefined, undefined, described.keys);
  }

  async start(events: DoerEvents, settings?: ReadonlyMap<HardwareId, Record<string, unknown>>,
    reported?: ReadonlyMap<HardwareId, string[]>): Promise<void> {
    this.events = events;
    this.stopped = false;
    if (settings) this.kept = new Map(settings);
    for (const hw of settings?.keys() ?? []) this.resumed.add(hw);
    for (const [hw, keys] of reported ?? []) this.reported.set(hw, new Set(keys));
    // A nativeControl sent before start had no events to go to: the ways are told now.
    if (this.ways.size) events.ungoverned(this.ungovernedWays());
    await this.link.start();
  }

  /** The native ways it was told of and cannot disable. */
  private ungovernedWays(): string[] {
    return [...this.ways].filter(([, canDisable]) => !canDisable).map(([way]) => way);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const { handle } of this.polls.values()) this.o.clock.clear(handle);
    this.polls.clear();
    this.link.stop();
    for (const [, waiting] of this.removals) waiting.failed(new Error("the doer stopped"));
    this.removals.clear();
  }

  /**
   * The radio sends the command, which `received` shows, unless the stack sends nothing (`unreachable`,
   * `expired`). The device answers as `commandResult` or `protocolResult` said: confirmed by default
   * on a closed device, transmitted with no answer on an open one. A device that carried it out takes
   * the state it reached, and a closed one reports it, at once or `reportAfterMs` later. A silent
   * device never answers: lost at the deadline.
   */
  async execute(hardwareId: HardwareId, action: string, args: Record<string, unknown>, deadline: number): Promise<ProtocolResult> {
    const dev = this.devices.get(hardwareId);
    if (!dev || !dev.present || !this.linkUp) return { kind: "notSent", reason: "unreachable", detail: "the coordinator is not answering" };
    const answer = dev.next ?? { result: dev.d.feedback === "open" ? { kind: "transmitted" } : { kind: "confirmed" } };
    dev.next = undefined;
    const result = answer.result;
    if (result.kind === "notSent") return result;
    await this.o.onReceived({ device: hardwareId, action, args });
    if (dev.silent) {
      await this.wait(Math.max(0, deadline - this.o.clock.now()));
      return { kind: "lost", detail: "no answer from the device" };
    }
    if (answer.afterMs) await this.wait(answer.afterMs);
    if (result.kind === "confirmed" || result.kind === "transmitted") {
      const reached = this.reached(dev, action, args);
      Object.assign(dev.values, reached);
      if (dev.d.feedback === "closed") {
        const report = () => this.report(dev, reached, this.o.clock.now());
        if (answer.reportAfterMs === undefined) report();
        else this.o.clock.setTimeout(report, answer.reportAfterMs);
      }
    }
    return result;
  }

  /** The state an action sets, as the device reports it after carrying it out: the vocabulary's, or its `confirmedBy`. */
  private reached(dev: ScriptedDevice, action: string, args: Record<string, unknown>): Record<string, unknown> {
    const sets = closedSets(action);
    if (sets) return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, "fixed" in v ? v.fixed : args[v.arg]]));
    const by = dev.d.actions.find((a) => a.action === action)?.confirmedBy;
    if (!by) return {};
    const v = by.value as { arg?: unknown } | null;
    return { [by.key]: v !== null && typeof v === "object" && typeof v.arg === "string" ? args[v.arg] : by.value };
  }

  /** The device answers with what it holds of those keys, unless it is silent or the coordinator is. */
  async read(hardwareId: HardwareId, keys: string[]): Promise<void> {
    const dev = this.devices.get(hardwareId);
    if (!dev || !dev.present || dev.silent || !this.linkUp) return;
    const values = Object.fromEntries(keys.filter((k) => k in dev.values).map((k) => [k, dev.values[k]]));
    this.heard(dev, values, this.o.clock.now());
  }

  /** The coordinator opens a window, house-wide or at a router, shown on `received`; not while it does not answer. */
  async join(windowMs: number, near?: HardwareId): Promise<void> {
    if (!this.linkUp) throw new Error("the coordinator is not answering");
    if (near !== undefined && this.devices.get(near)?.d.router !== true) throw new Error(`${near} is no router`);
    this.windowAt = near ?? WINDOW_EVERYWHERE;
    await this.o.onReceived({ device: this.windowAt, action: WINDOW_ACTION, args: { windowMs } });
  }

  /** The coordinator closes the window it has open, shown on `received`; with none open, nothing is sent. */
  async joinClose(): Promise<void> {
    const at = this.windowAt;
    if (at === undefined) return;
    this.windowAt = undefined;
    await this.o.onReceived({ device: at, action: WINDOW_ACTION, args: { windowMs: 0 } });
  }

  /**
   * The device leaves the network at the coordinator's request, reported `left`: at once when it
   * answers (not silent, the coordinator up) or with `force`; otherwise once it answers. Hardware the
   * network does not have resolves at once.
   */
  async remove(hardwareId: HardwareId, force: boolean): Promise<void> {
    const dev = this.devices.get(hardwareId);
    if (!dev?.present) return;
    if (force || (this.linkUp && !dev.silent)) {
      this.out(dev);
      return;
    }
    if (this.removals.has(hardwareId)) throw new Error(`${hardwareId} is being removed already`);
    await new Promise<void>((done, failed) => this.removals.set(hardwareId, { done, failed }));
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.o.clock.setTimeout(r, ms));
  }
}

/** `protocolResult`'s message as what the stack says: `refused` with its reason (`refused` by default), `notSent` unreachable unless expired. */
function protocolResult(msg: Record<string, unknown>): ProtocolResult {
  const detail = typeof msg.detail === "string" ? { detail: msg.detail } : {};
  switch (msg.result) {
    case "confirmed":
      return { kind: "confirmed" };
    case "transmitted":
      return { kind: "transmitted" };
    case "refused":
      return { kind: "refused", reason: typeof msg.reason === "string" ? msg.reason : "refused", ...detail };
    case "lost":
      return { kind: "lost", ...detail };
    default:
      if (msg.reason !== undefined && msg.reason !== "unreachable" && msg.reason !== "expired") {
        throw new Error("notSent's reason is unreachable or expired");
      }
      return { kind: "notSent", reason: msg.reason === "expired" ? "expired" : "unreachable", ...detail };
  }
}

/**
 * The bound a doer knows (GA-BRIDGE-13): three times a poll's cadence; for a device that reports on
 * its own, twice the longest interval it is configured to report at, or its model's where none is
 * configured; else null, never a guess.
 */
function bound(basis: string, cadenceMs: number | null, r: Reporting): number | null {
  if (basis === "poll" && cadenceMs !== null) return 3 * cadenceMs;
  if (r.configuredMs.length) return 2 * Math.max(...r.configuredMs);
  return r.modelMs;
}
