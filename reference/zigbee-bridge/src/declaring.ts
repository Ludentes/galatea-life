import type { Description, HardwareId, ProtocolResult } from "./port.js";
import { extensionName, extensionProblems, type ActionDecl, type KeyType } from "./vocabulary.js";

/** A device the bridge cannot reach within this is offered no action (GA-BRIDGE-7): twice it plus 10 s fits the longest ack bound. */
export const LONGEST_REACH_MS = 145_000;
/** The action a lock that requires a PIN is offered only with one (GA-BRIDGE-36). */
export const UNLOCK = "lock.unlock";

/** A reading as the bridge holds it: its value, the time of the observation it rests on, and when the bridge took it. */
export type Reading = { value: unknown; at: number; seenAt: number };

/** A device the bridge has: its id, the doer's description as taken, and what it last observed. */
export interface Device {
  id: string;
  hw: HardwareId;
  d: Description;
  /** The `state` keys its entry declares, and its `event` keys, with their types. */
  keys: Map<string, KeyType>;
  events: Map<string, KeyType>;
  values: Map<string, Reading>;
  /** Data the device sent that no key describes, in the order first seen, each with when (GA-BRIDGE-76). */
  undescribed: { name: string; firstSeen: number }[];
  /** Each occurrence's frame and payload, with when the bridge took it, to drop a repeat (GA-BRIDGE-75). */
  frames: Map<string, number>;
  lastCheckIn: number | null;
  observable: { value: boolean; since: number };
  /** The check-in last written to the store, and whether a newer one waits to be. */
  savedAt: number | null;
  unsaved: boolean;
}

const wireTime = (ms: number) => new Date(ms).toISOString();

/** What a description declares once the core has checked it, and why it differs from what the doer gave. */
export interface Declaration {
  d: Description;
  /** The extensions left out, by capability, with why (GA-BRIDGE-77): the device's `invalid_extension` fault. */
  invalid: Map<string, string>;
  /** A lock that requires a PIN the bridge does not hold, whose unlock was withheld (GA-BRIDGE-36). */
  pinMissing: boolean;
  /** Every action withheld, the device being out of reach (GA-BRIDGE-7). */
  outOfReach: boolean;
}

/**
 * Takes a description as a device's declarations. An extension that breaks *Extension names* is left
 * out, with every action of it (GA-BRIDGE-77), unless `misnames` (the `misnames-an-extension`
 * mutation) lets it through. A lock that requires a PIN the bridge does not hold is offered no
 * unlock (GA-BRIDGE-36); a device that offers no unlock has nothing to withhold. A device it cannot
 * reach within LONGEST_REACH_MS is offered no action (GA-BRIDGE-7).
 */
export function declaration(given: Description, o: { misnames: boolean; hasPin: boolean }): Declaration {
  const invalid = o.misnames ? new Map<string, string>() : extensionProblems(given.extensions);
  const bad = (name: string) => [...invalid.keys()].some((cap) => name.startsWith(`${cap}.`));
  let d: Description = invalid.size === 0 ? given : {
    ...given,
    extensions: given.extensions!.filter((e) => !invalid.has(String(extensionName(e)))),
    actions: given.actions.filter((a) => !bad(a.action)),
    ...(given.personal ? { personal: given.personal.filter((k) => !bad(k)) } : {}),
    ...(given.selfChanging ? { selfChanging: given.selfChanging.filter((k) => !bad(k)) } : {}),
    ...(given.settings ? { settings: given.settings.filter((k) => !bad(k)) } : {}),
  };
  const pinMissing = !!d.pinRequired && !o.hasPin && d.actions.some((a) => a.action === UNLOCK);
  if (pinMissing) d = { ...d, actions: d.actions.filter((a) => a.action !== UNLOCK) };
  const outOfReach = !(d.reachMs <= LONGEST_REACH_MS) && d.actions.length > 0;
  if (outOfReach) d = { ...d, actions: [] };
  return { d, invalid, pinMissing, outOfReach };
}

/**
 * A device's entry in `devices` (*Devices*): the doer's description under the core's id, on the
 * coordinator. Every extension `state` key that no action's `confirmedBy` names is `selfChanging`
 * (*Devices*), the doer's list or not. `claimsProtocol` and `hidesOtherAdmins` are the
 * `claims-protocol-class` and `hides-other-admins` mutations, `hidesAwaited` the `holds-back-silently` one.
 */
export function entry(id: string, d: Description, transport: string, undescribed: Device["undescribed"],
  o: { claimsProtocol: boolean; hidesOtherAdmins: boolean; hidesAwaited?: boolean }): Record<string, unknown> {
  const confirming = new Set(d.actions.map((a) => a.confirmedBy?.key).filter((k) => k !== undefined));
  const extensionState = (d.extensions ?? []).flatMap((e) => (e.keys ?? []).filter((k) => k.kind !== "event").map((k) => k.key));
  // A setting changes only when written, so it is never selfChanging (*Devices*).
  const settings = new Set(d.settings ?? []);
  const selfChanging = [...new Set([...(d.selfChanging ?? []), ...extensionState.filter((k) => !confirming.has(k) && !settings.has(k))])];
  return {
    id,
    stableIdentifier: d.stableIdentifier,
    transport,
    model: d.model,
    capabilities: d.capabilities,
    ...(d.sensorKeys ? { sensorKeys: d.sensorKeys } : {}),
    ...(d.awaitedKeys?.length && !o.hidesAwaited ? { awaitedKeys: d.awaitedKeys } : {}),
    actions: d.actions,
    feedback: d.feedback,
    reachMs: d.reachMs,
    proposedClass: d.proposedClass,
    classEvidence: o.claimsProtocol && d.proposedClass !== null ? "protocol" : d.classEvidence,
    otherAdmins: o.hidesOtherAdmins ? [] : d.otherAdmins,
    ...(d.extensions ? { extensions: d.extensions } : {}),
    ...(d.personal ? { personal: d.personal } : {}),
    ...(selfChanging.length ? { selfChanging } : {}),
    // Every setting of the device, so that the applier knows which keys only a write changes (GA-BRIDGE-79).
    ...(d.settings?.length ? { settings: d.settings } : {}),
    ...(undescribed.length ? { undescribed: undescribed.map((u) => ({ name: u.name, firstSeen: new Date(u.firstSeen).toISOString() })) } : {}),
  };
}

/**
 * The ack for the protocol's word (the design, *The doer port*'s table; GA-BRIDGE-8): `late` when the
 * command's time ran out first, `leaving` when the bridge left first. `misreports` is a mutation that
 * misreports a transmission whose declared confirmation never came.
 */
export function ackFor(decl: ActionDecl, r: ProtocolResult | "late" | "leaving",
  misreports?: "applied-before-confirmation" | "unreachable-after-transmit"): [string, string?, string?] {
  // Transmitted, and the confirmation the action declares never came: what the two mutations misreport.
  const unconfirmed = r === "late"
    || (r !== "leaving" && (r.kind === "lost" || (r.kind === "transmitted" && decl.confirms)));
  if (unconfirmed && misreports === "applied-before-confirmation") return ["applied"];
  if (unconfirmed && misreports === "unreachable-after-transmit") {
    return ["failed", "unreachable", "the device did not answer"];
  }
  if (r === "late") return ["failed", "no_confirmation", "the device did not answer within the command's time"];
  if (r === "leaving") return ["failed", "no_confirmation", "the bridge went offline before the device answered"];
  switch (r.kind) {
    case "confirmed":
      return ["applied"];
    case "transmitted":
      // `sent` only for an action declared confirms: false; a confirmation that never came is no_confirmation.
      return decl.confirms ? ["failed", "no_confirmation", "the protocol gave no answer"] : ["sent"];
    case "refused":
      return ["failed", r.reason, r.detail];
    case "lost":
      return ["failed", "no_confirmation", r.detail];
    case "notSent":
      return ["failed", r.reason, r.detail];
  }
}

/**
 * A device's entry in the roster (*The roster and freshness*), on the transport: `bound` is its
 * freshness bound, null for a device that never reports.
 */
export function rosterEntry(dev: Device, bound: number | null, transport: string): Record<string, unknown> {
  const open = dev.d.feedback === "open";
  const newest = Math.max(...[...dev.values.values()].map((r) => r.at));
  return {
    id: dev.id,
    transport,
    basis: dev.d.basis,
    cadenceMs: dev.d.cadenceMs,
    // Null for a device that never reports (*The roster and freshness*).
    basisMaxAgeMs: open ? null : bound,
    timestamp: dev.values.size ? wireTime(newest) : null,
    lastCheckIn: !open && dev.lastCheckIn !== null ? wireTime(dev.lastCheckIn) : null,
    observable: dev.observable.value,
    since: wireTime(dev.observable.since),
  };
}
