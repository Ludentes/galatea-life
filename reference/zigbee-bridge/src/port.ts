import type { TransportState } from "./transport.js";
import type { ActionDecl, Extension } from "./vocabulary.js";

export type { Extension } from "./vocabulary.js";

/** The doer's name for a device: its IEEE address on a Zigbee network, its scripted name under the harness. */
export type HardwareId = string;

/**
 * A device as the doer describes it: its entry in `devices` (*Devices*) without the core's id, with
 * every declaration, and the facts of its roster entry only the doer knows (*The roster and
 * freshness*). Sent on interview, on a definition change and on any re-description.
 */
export interface Description {
  hardwareId: HardwareId;
  stableIdentifier: string;
  model: { vendor: string; model: string };
  capabilities: string[];
  sensorKeys?: string[];
  actions: ActionDecl[];
  feedback: "closed" | "open";
  reachMs: number;
  proposedClass: string | null;
  classEvidence: "protocol" | "model_db" | "none";
  otherAdmins: { vendor: string; label: string }[] | "unknown";
  extensions?: Extension[];
  personal?: string[];
  selfChanging?: string[];
  /**
   * The declared `state` keys whose values the declarations rest on (*Declarations and settings*,
   * GA-BRIDGE-74): the core keeps their last observed values across restarts, and gives them back
   * to the doer at its start.
   */
  settings?: string[];
  /**
   * Keys the model promises and the device has not yet reported, held back until it does: only keys
   * the model's override names as seen missing (GA-BRIDGE-80, *Keys a device has not yet sent*).
   */
  awaitedKeys?: string[];
  /**
   * A lock that requires a PIN for remote operation (GA-BRIDGE-36): the core offers its `unlock` only
   * while it holds the PIN, which is the bridge's own configuration, never the doer's word.
   */
  pinRequired?: boolean;
  /** A router, at which a join window can open (GA-BRIDGE-26): the port's, never published. */
  router?: boolean;
  /** How the bridge learns of the device: `report`, or `poll` where the doer polls it. */
  basis: string;
  cadenceMs: number | null;
  /** The bound the doer knows from the protocol or the model, or null (GA-BRIDGE-13). */
  basisMaxAgeMs: number | null;
}

/**
 * What the protocol said of one command (the design, *The doer port*). `notSent` only when no call
 * reached the stack: handing a frame to the stack is transmitting it (*Commands*).
 */
export type ProtocolResult =
  | { kind: "confirmed" }
  | { kind: "transmitted" }
  | { kind: "refused"; reason: string; detail?: string }
  | { kind: "lost"; detail?: string }
  | { kind: "notSent"; reason: "unreachable" | "expired"; detail?: string };

/**
 * How a device came into the network (bridge, *Provisioning*). An association, or a trust-centre
 * rejoin under the key everyone knows, is new; a secured rejoin, or a trust-centre rejoin under the
 * device's own key, is not, while the device is in `devices` (GA-BRIDGE-35). A doer that cannot
 * tell them apart (herdsman) reports by the window rule (the maintainer's ruling, 2026-10-05):
 * hardware it has, coming in while its window is open, as an `association`; outside every window, as
 * a `securedRejoin`.
 */
export type Admission = "association" | "tcRejoinWellKnown" | "securedRejoin" | "tcRejoinUniqueKey";

/**
 * What the doer tells the core. The core handles them one at a time, in the order they come, so a
 * `described` sent before an `observed` reaches the wire first (GA-BRIDGE-74).
 */
export interface DoerEvents {
  described(d: Description): void;
  /** Readings keyed by the applier's key or an extension key, stamped with the device message's time; `checkIn` for a device-originated application message (GA-BRIDGE-37). */
  observed(hardwareId: HardwareId, readings: Record<string, unknown>, time: number, checkIn: boolean): void;
  /** An `event` key's occurrence, stamped with the device message's time; `frameId` lets the core drop a repeat (GA-BRIDGE-75). */
  occurred(hardwareId: HardwareId, key: string, value: unknown, time: number, frameId: string): void;
  /** Names the device sent that no key describes, by the protocol's own names (GA-BRIDGE-76). */
  undescribed(hardwareId: HardwareId, names: string[]): void;
  /**
   * The doer cannot reach the device now (false), or can again (true), stamped with when it found so:
   * a mains device that stopped answering, and its next frame heard (the maintainer's ruling of
   * 2026-10-12). The core publishes the device's status with `available` as told; a return is told
   * before the observation of the frame that brought it.
   */
  availability(hardwareId: HardwareId, available: boolean, time: number): void;
  /** The device came into the network, as `how` says; its description follows (GA-BRIDGE-35). */
  admitted(hardwareId: HardwareId, how: Admission): void;
  /**
   * Whether hardware coming into the network may be admitted now, asked before every arrival the
   * doer will report as new (hardware it does not have, and, by the window rule, hardware it has that
   * comes in while the doer's window is open), and answered at once, from memory. False for blocked
   * hardware, the refusal published as a `blocked_rejoin` (GA-BRIDGE-27). False while the store is
   * away for hardware the bridge has a device for (the maintainer's ruling, 2026-10-04): the
   * admission would give it a new id the store could not keep, and a restart would hand it the old
   * id, and a PIN configured for it (GA-BRIDGE-35, 36). The doer then turns the hardware away (out
   * of the network, reported `left` where it had it), and the owner pairs it again once the store is
   * back; unknown hardware is always admitted, held in memory while the store is away. The core
   * keeps blocked hardware out on its own too: a new admission of it is never taken.
   */
  mayAdmit(hardwareId: HardwareId): boolean;
  /** The device's interview is done: its model and capabilities are known. */
  interviewed(hardwareId: HardwareId): void;
  /** The device left the network, or the doer no longer has it (GA-BRIDGE-21). */
  left(hardwareId: HardwareId): void;
  /** The doer's one transport, whenever its state or its backoff changes (GA-BRIDGE-11, GA-BRIDGE-23). */
  transport(state: TransportState, since: number, retryIntervalMs?: number): void;
  /** A fault of the doer's (`state_mismatch`, `no_network`), named with its detail, or cleared with null. */
  fault(code: string, detail: string | null): void;
  /**
   * Every native way the doer can change a device or open a window without the applier's request
   * that it cannot disable, as the whole list each time it changes (GA-BRIDGE-32).
   */
  ungoverned(ways: string[]): void;
}

/**
 * The doer: the protocol stack below the core. The herdsman doer in production (plan 2), the
 * scripted doer under the harness.
 */
export interface DoerPort {
  /**
   * Why the doer hands no lock a PIN, where it does not (the herdsman doer, until spike S6): the core
   * then takes a configured PIN as none, offers no `unlock` on a lock that requires one, and says so
   * in its `pin_missing` fault (GA-BRIDGE-36; plan 2c-2 review I3).
   */
  readonly withholdsPins?: string;
  /**
   * Whether the doer opens join windows and removes devices: the bridge claims Provision only when
   * it does, and answers Provision's ops `invalid_request` otherwise (GA-BRIDGE-28's "does not fit
   * the bridge"). The herdsman doer does, but under the owner's switch that withholds every action.
   */
  readonly provisions: boolean;
  /**
   * Starts the doer, which reports to `events` from here on; resolves once it has described every
   * device it has. `settings` holds every device the core keeps, by hardware, with the last observed
   * values of its settings as kept across the restart: the doer declares from them until the device
   * reports again (GA-BRIDGE-74). Hardware in it that the network no longer has (a leave the store
   * missed) the doer reports as `left`, so that no entry outlives its device (GA-BRIDGE-21).
   * `reported` holds, by hardware, the awaited keys each device has reported once: never held back
   * again (GA-BRIDGE-80).
   */
  start(events: DoerEvents, settings?: ReadonlyMap<HardwareId, Record<string, unknown>>,
    reported?: ReadonlyMap<HardwareId, string[]>): Promise<void>;
  stop(): Promise<void>;
  /**
   * Carries out an action, its arguments named, within `deadline` on the bridge's clock. `pin` is the
   * owner's PIN for a lock's unlock, where the lock requires one: the bridge's own configuration,
   * given only with that action and never sent on the binding (GA-BRIDGE-36).
   */
  execute(hardwareId: HardwareId, action: string, args: Record<string, unknown>, deadline: number, pin?: string): Promise<ProtocolResult>;
  /** Reads the keys from the device, the answer coming as `observed` (GA-BRIDGE-34). */
  read(hardwareId: HardwareId, keys: string[], deadline: number): Promise<void>;
  /**
   * Opens a join window for `windowMs`, already the lesser of the request's and the transport's cap,
   * house-wide, or at the router `near` names (GA-BRIDGE-25, 26). The core keeps the window's time on
   * its own clock and closes it; rejects when the window could not be opened. The doer's window is
   * open from this call to its `joinClose`, whatever the stack counts (the window rule): the core
   * makes one call at a time, each after the one before it settled.
   */
  join(windowMs: number, near?: HardwareId): Promise<void>;
  /** Closes the window at once (GA-BRIDGE-25); with none open, changes nothing. */
  joinClose(): Promise<void>;
  /**
   * Removes the hardware from the network, resolving once it is out and reported `left`
   * (GA-BRIDGE-21, 27); hardware the doer does not have resolves at once. Without `force` a device
   * that does not answer is waited for; with `force` it is dropped without a word to the device, at
   * once, or, with no link to the network up, as the link comes back (plan 3b review, gap c). The
   * removal ends, with no `left` of the doer's, when the hardware is admitted anew. Rejects when the doer
   * could not remove it: without `force` the core keeps the removal pending, named in a fault, and
   * with `force` the core drops the device on its own word. The blocklist is the core's, answered
   * through `mayAdmit`: the doer holds none.
   */
  remove(hardwareId: HardwareId, force: boolean): Promise<void>;
}
