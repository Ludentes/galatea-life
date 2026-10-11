/**
 * What a bridge publishes, parsed entry by entry and field by field (GA-BUS-1): a bad entry or field
 * drops only itself, and is named in `faults`. An enumerated value this applier does not know is
 * taken as the least it can mean, never a reason to drop the message (GA-BUS-3). The camelCase of
 * the wire becomes the applier's snake_case here, once. Nothing here throws on what a bridge sends,
 * and nothing gates on the strict `bridge/*.json` schemas, whose enums are closed.
 */

import { storable } from "../core/canonical.js";

export type TransportState = "up" | "down" | "unknown";
export type Protocol = "matter" | "zigbee" | "zwave" | "modbus" | "ir" | "other";
export type Feedback = "closed" | "open";

const PROTOCOLS: readonly string[] = ["matter", "zigbee", "zwave", "modbus", "ir", "other"];
const CLASSES: readonly string[] = ["light", "socket", "ac", "boiler", "floor_heating", "curtain", "gate", "garage_door",
  "door_lock", "water_valve", "gas_valve", "tv", "speaker", "sensor", "channel", "computer", "player"];
const EVIDENCE: readonly string[] = ["protocol", "model_db", "none"];
/** An id: 1–128 of `[A-Za-z0-9._:/-]` (applier, *Identifiers and revision*); a bridge's has no `/`, `+` or `#`. */
const BRIDGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** A standard action: `capability.action` (applier, *Capabilities and actions*). */
const ACTION = /^[a-z_]+\.[a-z_]+$/;
/** An extension's capability: a namespace with at least one dot (bridge, *Extension names*). */
const EXT_CAPABILITY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
/** An extension action's or key's own name, after its capability and a dot. */
const EXT_NAME = /^[a-z][a-z0-9_]*$/;
/** At most this many extension capabilities on one device, and actions or keys in one capability, are modelled. */
export const MAX_EXTENSION_ITEMS = 64;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/** An RFC 3339 time with any offset, as ms since the epoch; undefined unless it is a real instant. */
export function parseTime(x: unknown): number | undefined {
  if (typeof x !== "string") return undefined;
  const m = TIME.exec(x);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  // Date.parse admits days that do not exist (2030-02-30); a date that does not round-trip is none.
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    return undefined;
  }
  const ms = Date.parse(x);
  return Number.isNaN(ms) ? undefined : ms;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * An extension action's or key's name, split as the bridge standard reads it: its capability is
 * everything before the last dot, a namespace with at least one dot, and its own name what follows,
 * of `[a-z][a-z0-9_]*` (bridge, *Extension names*). Undefined for any other name: a standard action's
 * `capability.action` has one dot only.
 */
export function extensionParts(name: string): { capability: string; name: string } | undefined {
  const i = name.lastIndexOf(".");
  if (i < 0) return undefined;
  const capability = name.slice(0, i);
  const own = name.slice(i + 1);
  return EXT_CAPABILITY.test(capability) && EXT_NAME.test(own) ? { capability, name: own } : undefined;
}

/** Whether `action` is an extension action by its name (applier, *Extensions*): it takes the extension tier and is never idempotent unless the owner says so. */
export const isExtension = (action: string): boolean => extensionParts(action) !== undefined;

/** The capability of an action: a standard one's first segment, an extension's everything before its last dot. */
export const capabilityOf = (action: string): string => extensionParts(action)?.capability ?? action.split(".")[0]!;
/**
 * A string Postgres can hold: U+0000 fits neither `jsonb` nor `text`, and `jsonb` refuses a lone
 * surrogate; either, in a retained message, would stop the applier at every start. A string that
 * holds one is a malformed field.
 */
export const isStr = (x: unknown): x is string => typeof x === "string" && !x.includes("\u0000") && x.isWellFormed();
const strings = (x: unknown): string[] | undefined =>
  Array.isArray(x) && x.every(isStr) ? (x as string[]) : undefined;
const count = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);

/** What a parse keeps, and what it dropped, each drop a fault to report. */
export type Parsed<T> = { value: T; faults: string[] };

/**
 * `connections` are the identity keys the finder can hear it by (bridge, *What a bridge adds*): facts kept
 * apart from the model (slice 5b), absent where the entry gives none as a list of strings.
 */
export type TransportFacts = { id: string; kind: Protocol; state: TransportState; connections?: string[] };
export type RosterFacts = { id: string; transport?: string; basis_max_age_ms: number | null; last_check_in: number | null };
export type BridgeFault = { code: string; device?: string };

export type Status = {
  bridge_id: string;
  instance_id: string;
  v: unknown;
  /** Only `offline` with `graceful: true` means anything to the applier: a planned death. */
  graceful: boolean;
  /** `undefined` when the time did not parse: then it is neither a heartbeat nor a revival. */
  published_at: number | undefined;
  /** `undefined` when the list is absent or not a list: then nothing is said of any transport. */
  transports: TransportFacts[] | undefined;
  /** The roster: the entries that parsed. */
  roster: RosterFacts[];
  /** The ids of every roster entry, those dropped for a bad field included: none of these left. */
  /** `undefined` when the list is absent or not a list: then no device is said to have left. */
  listed: string[] | undefined;
  faults: BridgeFault[];
  /**
   * Each way its doer can change a device without the applier's request that the bridge cannot disable
   * (GA-BRIDGE-32), as text: an entry that is not a string is its JSON, and a list that is not a list one
   * entry saying so, since what cannot be read may still be a way in (GA-BUS-3, its least meaning for a claim).
   */
  ungoverned: string[];
  /** The conformance levels it claims (bridge, *Conformance levels*): strings only; none when absent or not a list (GA-BUS-3). */
  levels: string[];
  /** Its `bridgeType`, when it gives one as a string. */
  bridge_type?: string;
};

/**
 * A `status`. The checks of GA-BUS-14 (`v`, `bridgeId`) are the caller's, on what this returns;
 * this only gives back what parsed.
 */
export function parseStatus(body: Record<string, unknown>): Parsed<Status> {
  const faults: string[] = [];
  const transports: TransportFacts[] = [];
  const hasTransports = Array.isArray(body.transports);
  if (!hasTransports) faults.push("status has no transports list");
  for (const [i, t] of (Array.isArray(body.transports) ? body.transports : []).entries()) {
    if (!isObject(t) || typeof t.id !== "string" || !BRIDGE_ID.test(t.id)) {
      faults.push(`status transports[${i}] has no id`);
      continue;
    }
    // One entry to an id: a repeat would move the model's revision at every status.
    if (transports.some((x) => x.id === t.id)) {
      faults.push(`status transports[${i}] (${t.id}) repeats an id`);
      continue;
    }
    // Least it can mean: a kind not known reaches devices by an `other` way; a state not known is not up.
    const kind = PROTOCOLS.includes(t.kind as string) ? (t.kind as Protocol) : "other";
    const state = t.state === "up" || t.state === "unknown" ? t.state : "down";
    const connections = strings(t.connections);
    transports.push({ id: t.id, kind, state, ...(connections ? { connections } : {}) });
  }
  const roster: RosterFacts[] = [];
  const listed: string[] = [];
  const hasRoster = Array.isArray(body.devices);
  if (!hasRoster) faults.push("status has no devices list");
  for (const [i, e] of (Array.isArray(body.devices) ? body.devices : []).entries()) {
    if (!isObject(e) || typeof e.id !== "string" || !BRIDGE_ID.test(e.id)) {
      faults.push(`status devices[${i}] has no id`);
      continue;
    }
    listed.push(e.id);
    const max = e.basisMaxAgeMs === null ? null : count(e.basisMaxAgeMs);
    const checkIn = e.lastCheckIn === null ? null : parseTime(e.lastCheckIn);
    if (max === undefined || checkIn === undefined) {
      // Dropped for a bad field, not left: the device keeps its last facts (GA-BUS-1).
      faults.push(`status devices[${i}] (${e.id}): a bad ${max === undefined ? "basisMaxAgeMs" : "lastCheckIn"}`);
      continue;
    }
    roster.push({ id: e.id, ...(isStr(e.transport) ? { transport: e.transport } : {}),
      basis_max_age_ms: max, last_check_in: checkIn });
  }
  const bridgeFaults: BridgeFault[] = [];
  for (const f of Array.isArray(body.faults) ? body.faults : []) {
    if (isObject(f) && isStr(f.code)) bridgeFaults.push({ code: f.code, ...(isStr(f.device) ? { device: f.device } : {}) });
  }
  const publishedAt = parseTime(body.publishedAt);
  if (publishedAt === undefined) faults.push(`status publishedAt ${JSON.stringify(body.publishedAt)} is not a time`);
  if (!Array.isArray(body.ungoverned)) faults.push("status ungoverned is not a list");
  const ungoverned = !Array.isArray(body.ungoverned) ? ["(a list the applier could not read)"]
    : body.ungoverned.slice(0, MAX_EXTENSION_ITEMS).map((x) => cut(typeof x === "string" ? x : JSON.stringify(x) ?? String(x), MAX_DETAIL));
  if (Array.isArray(body.ungoverned) && body.ungoverned.length > MAX_EXTENSION_ITEMS) ungoverned.push(`(${body.ungoverned.length - MAX_EXTENSION_ITEMS} more)`);
  return {
    value: {
      bridge_id: isStr(body.bridgeId) ? body.bridgeId : "",
      instance_id: isStr(body.instanceId) ? body.instanceId : "",
      v: body.v,
      graceful: body.state === "offline" && body.graceful === true,
      published_at: publishedAt,
      transports: hasTransports ? transports : undefined, roster, listed: hasRoster ? listed : undefined, faults: bridgeFaults,
      ungoverned,
      levels: Array.isArray(body.levels) ? body.levels.filter(isStr) : [],
      ...(isStr(body.bridgeType) ? { bridge_type: body.bridgeType } : {}),
    },
    faults,
  };
}

/**
 * A device's constraint on one argument (applier, *Capability and action vocabulary*, `args`), read
 * from the table the maintainer ruled on 2026-10-06, which is the bridges' wire form:
 *
 * | On the wire | Held as | Means |
 * |---|---|---|
 * | `["off", "cool"]` | `{ enum }` | one of these values |
 * | `{ min?, max?, step? }`, one at least | the range | a number within it, `min` (else 0) plus whole steps |
 * | `"any"` or `{}` | `"any"` | no limit |
 * | an object of named fields | `{ fields }` | an object argument, each field with its own constraint |
 * | `optional: true` beside a range's or fields' keys | `optional: true` | the argument may be left out |
 *
 * `{ optional: true }` alone is an optional argument of no limit. Not JSON Schema.
 */
export type Constraint = "any" | { enum: (string | number | boolean)[] }
  | { min?: number; max?: number; step?: number; optional?: true }
  | { fields: Record<string, Constraint>; optional?: true };

/** Whether a constraint marks its argument optional (`optional: true`). */
export const optionalArg = (c: Constraint): boolean => typeof c === "object" && "optional" in c && c.optional === true;

/** A constraint in the ruled table's wire form, as `describe` gives it (the form its bridge declared it in, `{}` as `"any"`). */
export function wireConstraint(c: Constraint): unknown {
  if (c === "any") return "any";
  if ("enum" in c) return [...c.enum];
  if ("fields" in c) {
    return { ...Object.fromEntries(Object.entries(c.fields).map(([k, f]) => [k, wireConstraint(f)])), ...(c.optional ? { optional: true } : {}) };
  }
  return { ...c };
}
/**
 * The state key and value that confirm a stateful extension action (applier, *Action declarations*):
 * `value` is a scalar, or `{ arg }`, the value of that argument of the step.
 */
export type ConfirmedBy = { key: string; value: string | number | boolean | { arg: string } };
export type ActionDoc = { action: string; idempotent: boolean; stateless: boolean; toggles: boolean; whole_state: boolean; confirms: boolean;
  args?: Record<string, Constraint>; confirmed_by?: ConfirmedBy };
/** An extension key: a `state` key is a state key of the device like any other, an `event` key never one (applier, *Extensions*). */
export type ExtensionKey = { key: string; kind: "state" | "event"; description?: string; schema: Record<string, unknown> };
/** An extension capability its bridge declares on a device, as the applier holds and describes it (applier, *Devices*, `extensions`). */
export type Extension = { capability: string; description?: string; actions: { action: string; description?: string; schema: Record<string, unknown> }[];
  keys: ExtensionKey[] };
export type DeviceDoc = {
  id: string;
  stable_identifier: string;
  transport: string;
  model?: { vendor: string; model: string };
  capabilities: string[];
  sensor_keys: string[];
  actions: ActionDoc[];
  feedback: Feedback;
  /** Undefined when the bridge did not say: then how long a command takes to reach it is not known. */
  reach_ms?: number;
  proposed_class: string | null;
  class_evidence: string;
  other_admins: { vendor: string; label: string }[] | "unknown";
  /** Only on a computer: its bridge's proposal that it carries the broker (GA-BRIDGE-65), for the owner to set `infrastructure`. */
  proposed_infrastructure?: true;
  self_changing: string[];
  personal: string[];
  internal: boolean;
  /** Absent where its bridge declares none, so a document without them compares as it did before 0.14. */
  extensions?: Extension[];
  /** The numeric keys its model promises and it has not yet reported (bridge, *Keys a device has not yet sent*); absent where its bridge gives none. */
  awaited_keys?: string[];
  /** Its keys that are settings (bridge, *Declarations and settings*); absent where its bridge gives none. */
  settings?: string[];
  /** What it sends that no key describes, each name with when its bridge first saw it (GA-BRIDGE-76); absent where its bridge gives none. */
  undescribed?: { name: string; first_seen: number }[];
};

/** An undescribed name's form (bridge, GA-BRIDGE-76). */
const UNDESCRIBED_NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** At most this many undescribed names per device (bridge, GA-BRIDGE-76). */
export const MAX_UNDESCRIBED = 32;

/**
 * A device's `undescribed` (GA-BRIDGE-76): each `{ name, firstSeen }` of a name of its form and a
 * time; what breaks drops alone, with a fault, and past MAX_UNDESCRIBED the rest with one.
 */
function parseUndescribed(x: unknown, where: string, faults: string[]): { name: string; first_seen: number }[] | undefined {
  if (x === undefined) return undefined;
  if (!Array.isArray(x)) {
    faults.push(`${where} undescribed is malformed`);
    return undefined;
  }
  const out: { name: string; first_seen: number }[] = [];
  for (const [i, u] of x.entries()) {
    const at = isObject(u) ? parseTime(u.firstSeen) : undefined;
    if (!isObject(u) || typeof u.name !== "string" || !UNDESCRIBED_NAME.test(u.name) || at === undefined) {
      faults.push(`${where} undescribed[${i}] is malformed`);
      continue;
    }
    if (out.length < MAX_UNDESCRIBED) out.push({ name: u.name, first_seen: at });
  }
  if (x.length > MAX_UNDESCRIBED) faults.push(`${where} undescribed has ${x.length} names; the first ${MAX_UNDESCRIBED} are kept`);
  return out;
}

/** The keys a range holds; any other key of an object is a field of an object argument. */
const RANGE_KEYS = new Set(["min", "max", "step"]);
const MAX_CONSTRAINT_DEPTH = 3;

/** One argument's constraint, or undefined when it cannot be read (the table at `Constraint`). */
function parseConstraint(c: unknown, depth: number): Constraint | undefined {
  if (c === "any") return "any";
  if (Array.isArray(c)) {
    const scalar = (x: unknown) => isStr(x) || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
    // An empty list allows no value (a computer with no interactive account names none).
    return c.every(scalar) ? { enum: c as (string | number | boolean)[] } : undefined;
  }
  if (!isObject(c)) return undefined;
  if (c.optional !== undefined && typeof c.optional !== "boolean") return undefined;
  // A field is supported, never required: `optional` on one says nothing true, and is malformed (I5, the maintainer's ruling).
  if (depth > 1 && c.optional !== undefined) return undefined;
  const optional = c.optional === true ? { optional: true as const } : {};
  const keys = Object.keys(c).filter((k) => k !== "optional");
  if (keys.every((k) => RANGE_KEYS.has(k))) {
    const bound = (x: unknown) => x === undefined || (typeof x === "number" && Number.isFinite(x));
    if (!bound(c.min) || !bound(c.max) || !bound(c.step) || (c.step !== undefined && (c.step as number) <= 0)) return undefined;
    // `{}` (or only `optional`) is no limit.
    if (!keys.length) return c.optional === true ? { optional: true } : "any";
    return { ...(c.min !== undefined ? { min: c.min as number } : {}), ...(c.max !== undefined ? { max: c.max as number } : {}),
      ...(c.step !== undefined ? { step: c.step as number } : {}), ...optional };
  }
  // A range's key beside a field's would leave the argument's kind in doubt.
  if (keys.some((k) => RANGE_KEYS.has(k)) || depth >= MAX_CONSTRAINT_DEPTH || !keys.every(isStr)) return undefined;
  const fields: Record<string, Constraint> = {};
  for (const k of keys) {
    const f = parseConstraint(c[k], depth + 1);
    if (!f) return undefined;
    fields[k] = f;
  }
  return { fields, ...optional };
}

/**
 * An action's `args` constraints. A constraint that cannot be read is dropped with a fault and its
 * argument is then unconstrained (the least it can mean; the vocabulary still checks it); `args`
 * that are not an object are dropped whole.
 */
function parseArgs(x: unknown, where: string, faults: string[]): Record<string, Constraint> | undefined {
  if (x === undefined) return undefined;
  if (!isObject(x)) {
    faults.push(`${where} args is malformed`);
    return undefined;
  }
  const out: Record<string, Constraint> = {};
  for (const [k, c] of Object.entries(x)) {
    if (!isStr(k)) {
      faults.push(`${where} args has a key that holds U+0000 or a lone surrogate`);
      continue;
    }
    const parsed = parseConstraint(c, 1);
    if (parsed) out[k] = parsed;
    else faults.push(`${where} args ${k} is malformed`);
  }
  return out;
}

const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const scalar = (x: unknown): x is string | number | boolean =>
  isStr(x) || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
/**
 * Whether a key's JSON Schema is a scalar's (bridge, *Devices*, `extensions`): its `type` a string, a
 * number, an integer or a boolean, or, with no `type`, an `enum` of scalars (the form the Zigbee
 * bridge gives an enum or a binary expose, `{ enum: ["click", "switch"] }`). A schema that says
 * nothing (`{}`) admits an object, so it is not one.
 */
const scalarSchema = (s: Record<string, unknown>): boolean =>
  s.type === undefined ? Array.isArray(s.enum) && s.enum.length > 0 && s.enum.every(scalar) : SCALAR_TYPES.has(s.type as string);

/**
 * A device's `extensions` (bridge, *Devices*, *Extension names*), entry by entry: each a capability
 * that is a namespace with a dot, its actions and keys its name, a dot and a name of their own, a key's
 * `kind` `state` where its bridge left it out and its schema a scalar's. What breaks this drops alone,
 * with a fault: an entry, an action, a key, and a key of a kind this applier does not know (the least
 * it can mean is no key, GA-BUS-3). A capability that is another's with a segment added is dropped
 * too, so the last dot is never in doubt.
 */
function parseExtensions(x: unknown, where: string, faults: string[]): Extension[] {
  if (x === undefined) return [];
  if (!Array.isArray(x)) {
    faults.push(`${where} extensions is malformed`);
    return [];
  }
  const out: Extension[] = [];
  /** At most MAX_EXTENSION_ITEMS of a list, with a fault saying what was left out (GA-BUS-1). */
  const cut = <T>(list: T[], at: string, noun: string): T[] => {
    if (list.length > MAX_EXTENSION_ITEMS) faults.push(`${at} has ${list.length} ${noun}; the first ${MAX_EXTENSION_ITEMS} are modelled`);
    return list.slice(0, MAX_EXTENSION_ITEMS);
  };
  for (const [i, e] of cut(x, `${where} extensions`, "entries").entries()) {
    const at = `${where} extensions[${i}]`;
    if (!storable(e)) {
      faults.push(`${at} holds a string with U+0000 or a lone surrogate`);
      continue;
    }
    if (!isObject(e) || typeof e.capability !== "string" || !EXT_CAPABILITY.test(e.capability)) {
      faults.push(`${at} has no capability that is a namespace with a dot`);
      continue;
    }
    const capability = e.capability;
    const clash = out.find((o) => o.capability === capability || capability.startsWith(`${o.capability}.`) || o.capability.startsWith(`${capability}.`));
    if (clash) {
      faults.push(clash.capability === capability ? `${at} (${capability}) repeats a capability`
        : `${at} (${capability}) is ${clash.capability} with a segment added; the last dot would be in doubt`);
      continue;
    }
    const own = (name: unknown): name is string => typeof name === "string" && extensionParts(name)?.capability === capability;
    const named = `is not ${capability}, a dot and a name of [a-z][a-z0-9_]*`;
    const actions: Extension["actions"] = [];
    for (const a of cut(Array.isArray(e.actions) ? e.actions : [], at, "actions")) {
      if (!isObject(a) || !own(a.action)) {
        faults.push(`${at} action ${isObject(a) && isStr(a.action) ? a.action : "?"} ${named}`);
        continue;
      }
      actions.push({ action: a.action, ...(isStr(a.description) ? { description: a.description } : {}), schema: isObject(a.schema) ? a.schema : {} });
    }
    const keys: ExtensionKey[] = [];
    for (const k of cut(Array.isArray(e.keys) ? e.keys : [], at, "keys")) {
      if (!isObject(k) || !own(k.key)) {
        faults.push(`${at} key ${isObject(k) && isStr(k.key) ? k.key : "?"} ${named}`);
        continue;
      }
      if (!isObject(k.schema) || !scalarSchema(k.schema)) {
        faults.push(`${at} key ${k.key} has a schema that is not a scalar's`);
        continue;
      }
      if (k.kind !== undefined && k.kind !== "state" && k.kind !== "event") {
        faults.push(`${at} key ${k.key} has a kind this applier does not know; not modelled`);
        continue;
      }
      keys.push({ key: k.key, kind: k.kind ?? "state", ...(isStr(k.description) ? { description: k.description } : {}), schema: k.schema });
    }
    out.push({ capability, ...(isStr(e.description) ? { description: e.description } : {}), actions, keys });
  }
  return out;
}

/** A `confirmedBy`: a key and a scalar, or `{ arg }` naming an argument; undefined when it is neither. */
function parseConfirmedBy(c: unknown): ConfirmedBy | undefined {
  if (!isObject(c) || !isStr(c.key)) return undefined;
  if (scalar(c.value)) return { key: c.key, value: c.value };
  if (isObject(c.value) && Object.keys(c.value).length === 1 && isStr(c.value.arg)) return { key: c.key, value: { arg: c.value.arg } };
  return undefined;
}

/**
 * One action of a device. A standard action's name is `capability.action`; an extension action's is
 * an extension's full name, and is kept only where the device's `extensions` declare it, a stateful one
 * only with a `confirmedBy` naming one of their `state` keys, never an `event` key (bridge, *Devices*,
 * GA-BRIDGE-38). Undefined, with a fault where it says why, when it cannot stand.
 */
function parseAction(a: unknown, where: string, faults: string[], extensions: Extension[]): ActionDoc | undefined {
  if (!isObject(a) || typeof a.action !== "string") return undefined;
  const extension = extensionParts(a.action) !== undefined;
  if (!extension && !ACTION.test(a.action)) return undefined;
  if (typeof a.idempotent !== "boolean" || typeof a.stateless !== "boolean") return undefined;
  let confirmedBy: ConfirmedBy | undefined;
  if (extension) {
    if (!extensions.some((e) => e.actions.some((x) => x.action === a.action))) {
      faults.push(`${where} (${a.action}) is an extension action its device's extensions do not declare`);
      return undefined;
    }
    if (!a.stateless) {
      confirmedBy = parseConfirmedBy(a.confirmedBy);
      const state = extensions.some((e) => e.keys.some((k) => k.key === confirmedBy?.key && k.kind === "state"));
      if (!confirmedBy || !state) {
        faults.push(`${where} (${a.action}) is a stateful extension action with no confirmedBy naming one of its state keys`);
        return undefined;
      }
    }
  }
  // An extension action's arguments are its `args`; where it gives none, its schema's `properties` (I4, the maintainer's ruling).
  const args = parseArgs(a.args, where, faults) ?? (extension && a.args === undefined ? fromSchema(extensions, a.action) : undefined);
  // Least it can mean: an action whose confirmation is not stated cannot confirm.
  return { action: a.action, idempotent: a.idempotent, stateless: a.stateless, toggles: a.toggles === true,
    whole_state: a.wholeState === true, confirms: a.confirms === true, ...(args ? { args } : {}),
    ...(confirmedBy ? { confirmed_by: confirmedBy } : {}) };
}

/**
 * The `args` an extension action's schema gives (I4: where its entry gives no `args`): each of its
 * `properties` an argument, optional unless `required` names it; a required one a range from its
 * `minimum` and `maximum`, or a list from its `enum` of scalars; otherwise any scalar. Undefined when it
 * names none.
 */
function fromSchema(extensions: Extension[], action: string): Record<string, Constraint> | undefined {
  const schema = extensions.flatMap((e) => e.actions).find((x) => x.action === action)?.schema;
  const props = schema && isObject(schema.properties) ? schema.properties : undefined;
  if (!props || !Object.keys(props).length) return undefined;
  const required = Array.isArray(schema!.required) ? schema!.required.filter(isStr) : [];
  const scalar = (x: unknown) => isStr(x) || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x));
  const out: Record<string, Constraint> = {};
  for (const [name, p] of Object.entries(props)) {
    if (!required.includes(name)) {
      out[name] = { optional: true };
      continue;
    }
    const s = isObject(p) ? p : {};
    if (Array.isArray(s.enum) && s.enum.length && s.enum.every(scalar)) out[name] = { enum: s.enum as (string | number | boolean)[] };
    else if (typeof s.minimum === "number" || typeof s.maximum === "number") {
      out[name] = { ...(typeof s.minimum === "number" ? { min: s.minimum } : {}), ...(typeof s.maximum === "number" ? { max: s.maximum } : {}) };
    } else out[name] = "any";
  }
  return out;
}

/** One entry of the `devices` document; undefined, with the reason, when it cannot stand. */
function parseDeviceDoc(e: unknown, i: number, faults: string[]): DeviceDoc | undefined {
  if (!isObject(e) || typeof e.id !== "string" || !BRIDGE_ID.test(e.id)) {
    faults.push(`devices[${i}] has no id`);
    return undefined;
  }
  const name = `devices[${i}] (${e.id})`;
  const missing: string[] = ["stableIdentifier", "transport"].filter((k) => !isStr(e[k]));
  const capabilities = strings(e.capabilities);
  if (!capabilities) missing.push("capabilities");
  if (!Array.isArray(e.actions)) missing.push("actions");
  if (missing.length) {
    faults.push(`${name} has no ${missing.join(", ")}`);
    return undefined;
  }
  const extensions = parseExtensions(e.extensions, name, faults);
  const actions: ActionDoc[] = [];
  for (const [j, a] of (e.actions as unknown[]).entries()) {
    const before = faults.length;
    const parsed = parseAction(a, `${name} actions[${j}]`, faults, extensions);
    if (parsed) actions.push(parsed);
    else if (faults.length === before) faults.push(`${name} actions[${j}] is malformed`);
  }
  // Absent or malformed is "unknown", never an empty list: nobody is known not to administer it.
  const wellFormed = (x: unknown): x is { vendor: string; label: string } =>
    isObject(x) && isStr(x.vendor) && isStr(x.label);
  let otherAdmins: { vendor: string; label: string }[] | "unknown" = "unknown";
  if (Array.isArray(e.otherAdmins) && e.otherAdmins.every(wellFormed)) otherAdmins = e.otherAdmins;
  else if (e.otherAdmins !== undefined && e.otherAdmins !== "unknown") faults.push(`${name} otherAdmins is malformed`);
  if (e.proposedInfrastructure !== undefined && e.proposedInfrastructure !== true) faults.push(`${name} proposedInfrastructure is malformed`);
  /** A list of strings its bridge may leave out: kept as given, or dropped with a fault (GA-BUS-1). */
  const listed = (wireName: string, key: "awaited_keys" | "settings") => {
    if (e[wireName] === undefined) return {};
    const l = strings(e[wireName]);
    if (!l) faults.push(`${name} ${wireName} is malformed`);
    return l ? { [key]: l } : {};
  };
  const awaited = listed("awaitedKeys", "awaited_keys");
  const settings = listed("settings", "settings");
  const undescribed = parseUndescribed(e.undescribed, name, faults);
  // Required of every entry (bridge, *Devices*): without it the reach is not known, never "always listens".
  const reach = count(e.reachMs);
  if (reach === undefined) faults.push(`${name} has no valid reachMs`);
  return {
    id: e.id,
    stable_identifier: e.stableIdentifier as string,
    transport: e.transport as string,
    ...(isObject(e.model) && isStr(e.model.vendor) && isStr(e.model.model)
      ? { model: { vendor: e.model.vendor, model: e.model.model } } : {}),
    capabilities: capabilities!,
    sensor_keys: strings(e.sensorKeys) ?? [],
    actions,
    // Least it can mean (bridge, *Compatibility*): closed, so the device goes stale when it stops checking in.
    feedback: e.feedback === "open" ? "open" : "closed",
    ...(reach !== undefined ? { reach_ms: reach } : {}),
    proposed_class: CLASSES.includes(e.proposedClass as string) ? (e.proposedClass as string) : null,
    class_evidence: EVIDENCE.includes(e.classEvidence as string) ? (e.classEvidence as string) : "none",
    other_admins: otherAdmins,
    ...(e.proposedInfrastructure === true ? { proposed_infrastructure: true as const } : {}),
    self_changing: strings(e.selfChanging) ?? [],
    personal: strings(e.personal) ?? [],
    internal: e.internal === true,
    ...(extensions.length ? { extensions } : {}),
    ...awaited,
    ...settings,
    ...(undescribed !== undefined ? { undescribed } : {}),
  };
}

/**
 * The retained `devices` document: every entry that stands, and the ids of those that did not; and the
 * `connections` of each entry that stands, by its id, kept apart from its document, since they are no
 * model (slice 5b): none where an entry gives none as a list of strings.
 */
export function parseDevices(body: Record<string, unknown>):
Parsed<{ devices: DeviceDoc[]; listed: string[] | undefined; connections: Map<string, string[]> }> {
  const faults: string[] = [];
  const devices: DeviceDoc[] = [];
  const listed: string[] = [];
  const connections = new Map<string, string[]>();
  if (!Array.isArray(body.devices)) return { value: { devices, listed: undefined, connections }, faults: ["devices has no devices list"] };
  for (const [i, e] of body.devices.entries()) {
    if (isObject(e) && typeof e.id === "string" && BRIDGE_ID.test(e.id)) listed.push(e.id);
    const d = parseDeviceDoc(e, i, faults);
    if (!d) continue;
    devices.push(d);
    connections.set(d.id, strings((e as Record<string, unknown>).connections) ?? []);
  }
  return { value: { devices, listed, connections }, faults };
}

export type Reading = { key: string; value: string | number | boolean; basis: number };
export type DeviceStatus = { device_id: string | undefined; available: boolean | undefined; readings: Reading[] };

const META = new Set(["deviceId", "state", "timestamp", "timestamps", "available"]);

/**
 * A device's status. Each reading takes its time from `timestamps`, else `timestamp`; a reading
 * with no good time, or a value that is not a scalar, drops only itself.
 */
export function parseDeviceStatus(body: Record<string, unknown>): Parsed<DeviceStatus> {
  const faults: string[] = [];
  const at = parseTime(body.timestamp);
  if (at === undefined) faults.push(`timestamp ${JSON.stringify(body.timestamp)} is not a time`);
  const times = isObject(body.timestamps) ? body.timestamps : {};
  const readings: Reading[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (META.has(key)) continue;
    if (!isStr(key)) {
      faults.push(`reading ${JSON.stringify(key)} has a name this applier cannot keep`);
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      faults.push(`reading ${key} is not a scalar`);
      continue;
    }
    if (!isStr(value) && typeof value === "string") {
      faults.push(`reading ${key} holds a character this applier cannot keep`);
      continue;
    }
    const own = Object.hasOwn(times, key) ? parseTime(times[key]) : at;
    if (own === undefined) {
      if (Object.hasOwn(times, key)) faults.push(`timestamps.${key} is not a time`);
      continue;
    }
    readings.push({ key, value, basis: own });
  }
  return {
    value: {
      device_id: isStr(body.deviceId) ? body.deviceId : undefined,
      available: typeof body.available === "boolean" ? body.available : undefined,
      readings,
    },
    faults,
  };
}

export type BridgeEvent = { seq: number; instance_id: string; type: string; body: Record<string, unknown> };

/** An `event`; a type this applier does not handle is kept, and left unhandled (never a fault). */
export function parseEvent(body: Record<string, unknown>): Parsed<BridgeEvent | undefined> {
  if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 0 || !isStr(body.instanceId) || !body.instanceId) {
    return { value: undefined, faults: ["an event without a seq or an instanceId"] };
  }
  return { value: { seq: body.seq as number, instance_id: body.instanceId, type: isStr(body.type) ? body.type : "", body }, faults: [] };
}

/**
 * An ack's `result`: the bridge standard's four, its optional non-terminal `received`, and `unknown` for
 * one this applier does not know, which is taken as the least it can mean: no ack at all (GA-BUS-3).
 */
export type AckResult = "applied" | "sent" | "failed" | "unsupported" | "received" | "unknown";
export type Ack = { command_id: string; source: string; result: AckResult; reason?: string; detail?: string };

const ACK_RESULTS: readonly string[] = ["applied", "sent", "failed", "unsupported", "received"];
/** A `detail` is text for a person, kept to this many UTF-16 units in an outcome. */
export const MAX_DETAIL = 1024;
/** A `reason` is a word, kept to this many. */
export const MAX_REASON = 128;
/** A `commandId` longer than this is none the applier sent, so its ack is no one's. */
export const MAX_ACK_ID = 128;

/** `s` cut to at most `n` UTF-16 units, never inside a surrogate pair, so what is kept stays well formed. */
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}

/**
 * An ack on `devices/{d}/ack` (bridge, *Commands*). Without a `commandId`, or with one longer than
 * any the applier sends, it is no one's, a fault. A `failed` without a `reason` is a fault too, taken
 * as `failed(no_confirmation)`, the least it can mean: nothing says the device did not act. A `detail`
 * that Postgres could not keep is dropped, and a long one, or a long `reason`, cut where it stays well
 * formed. The faults name no command id, so one stands per kind while it stands. Whether `source`
 * names the topic's bridge is the caller's check (GA-BUS-13).
 */
export function parseAck(body: Record<string, unknown>): Parsed<Ack | undefined> {
  if (!isStr(body.commandId) || !body.commandId) return { value: undefined, faults: ["an ack without a commandId"] };
  if (body.commandId.length > MAX_ACK_ID) return { value: undefined, faults: [`an ack whose commandId is longer than ${MAX_ACK_ID} characters`] };
  const faults: string[] = [];
  const result = ACK_RESULTS.includes(body.result as string) ? (body.result as AckResult) : "unknown";
  let reason = isStr(body.reason) && body.reason ? cut(body.reason, MAX_REASON) : undefined;
  if (result === "failed" && reason === undefined) {
    faults.push("an ack is failed without a reason");
    reason = "no_confirmation";
  }
  if (body.detail !== undefined && !isStr(body.detail)) faults.push("an ack has a detail this applier cannot keep");
  const detail = isStr(body.detail) ? cut(body.detail, MAX_DETAIL) : undefined;
  return {
    value: { command_id: body.commandId, source: isStr(body.source) ? body.source : "", result,
      ...(result === "failed" ? { reason } : {}), ...(detail !== undefined ? { detail } : {}) },
    faults,
  };
}
