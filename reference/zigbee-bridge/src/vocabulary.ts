/**
 * The applier's closed vocabulary as a Zigbee bridge maps it (`standard/applier.md`, *Capabilities
 * and actions*): each capability's state keys with their types, and its actions with their
 * arguments and the state each sets. `media`, `notify`, `power` and `session` have no Zigbee
 * mapping and are left out.
 */

/**
 * A reading's type. Every reading is a scalar, and may also be the string "unknown" (*A device's
 * status*); `scalar` is an extension key whose schema says no more than that.
 */
export type KeyType = "boolean" | "number" | "string" | "scalar";

/**
 * An argument's constraint, as `args` declares it: `any` scalar; one of a list; or a number, an
 * object giving its bounds, either of which may be left out, and its step, counted from `min` (or
 * from 0 without one), where the device takes only those values (plan 2c-2 review I1).
 */
export type ArgConstraint = "any" | readonly (string | number | boolean)[] | { min?: number; max?: number; step?: number };

/** An action as the `devices` document declares it (*Devices*). */
export interface ActionDecl {
  action: string;
  idempotent: boolean;
  stateless: boolean;
  confirms: boolean;
  toggles?: boolean;
  wholeState?: boolean;
  args?: Record<string, ArgConstraint>;
  confirmedBy?: { key: string; value: unknown };
}

/** The value an action sets a key to: fixed, or the named argument of the command. */
export type SetValue = { fixed: string | number | boolean } | { arg: string };

interface VocabAction {
  args?: Record<string, ArgConstraint>;
  /** The keys the action sets, and to what: GA-BRIDGE-34's read-back reads these. Absent for a stateless action. */
  sets?: Record<string, SetValue>;
  idempotent?: false;
}

interface Capability {
  keys: Record<string, KeyType>;
  actions: Record<string, VocabAction>;
}

const on = (v: boolean): SetValue => ({ fixed: v });

export const CAPABILITIES: Record<string, Capability> = {
  onoff: { keys: { on: "boolean" }, actions: { turn_on: { sets: { on: on(true) } }, turn_off: { sets: { on: on(false) } } } },
  level: { keys: { level: "number" }, actions: { set_level: { args: { level: { min: 0, max: 100 } }, sets: { level: { arg: "level" } } } } },
  color: { keys: { color: "string" }, actions: { set_color: { args: { rgb: "any" }, sets: { color: { arg: "rgb" } } } } },
  climate: {
    keys: { mode: "string", setpoint: "number", current: "number" },
    actions: {
      set_mode: { args: { mode: ["off", "heat", "cool", "auto", "fan"] }, sets: { mode: { arg: "mode" } } },
      set_setpoint: { args: { celsius: {} }, sets: { setpoint: { arg: "celsius" } } },
    },
  },
  cover: {
    keys: { position: "number" },
    actions: {
      open: { sets: { position: { fixed: 100 } } },
      close: { sets: { position: { fixed: 0 } } },
      set_position: { args: { position: { min: 0, max: 100 } }, sets: { position: { arg: "position" } } },
      stop: {},
    },
  },
  valve: { keys: { open: "boolean" }, actions: { open: { sets: { open: on(true) } }, close: { sets: { open: on(false) } } } },
  lock: { keys: { locked: "boolean" }, actions: { lock: { sets: { locked: on(true) } }, unlock: { sets: { locked: on(false) } } } },
  sensor: { keys: {}, actions: {} },
};

/** The `sensor` capability's keys a Zigbee device can report. */
export const SENSOR_KEYS: Record<string, KeyType> = {
  temperature: "number", humidity: "number", motion: "boolean", opening: "boolean", leak: "boolean", occupancy: "boolean",
  illuminance: "number", battery: "number", battery_low: "boolean",
};

/**
 * The negative mutations honoured in describing (bridge, *Negative subjects*), only under a run:
 * `maps-motion-to-occupancy` (GA-BRIDGE-78) and `holds-back-the-leak` (GA-BRIDGE-80).
 */
export const DESCRIBE_MUTATIONS = ["maps-motion-to-occupancy", "holds-back-the-leak"] as const;
export type DescribeMutation = (typeof DESCRIBE_MUTATIONS)[number];

/**
 * The keys a device holds back until it first reports each (GA-BRIDGE-80, *Keys a device has not yet
 * sent*): of `keys`, those its maker's records name as promised and seen missing, not yet reported,
 * and only a numeric sensor key, never a boolean (a leak sensor's `leak` is declared from the start).
 * `holdsBooleans` is the `holds-back-the-leak` mutation.
 */
export function heldBack(keys: readonly string[], seenMissing: readonly string[] | undefined, reported: ReadonlySet<string> | undefined,
  holdsBooleans = false): string[] {
  return keys.filter((k) => Object.hasOwn(SENSOR_KEYS, k) && (holdsBooleans || SENSOR_KEYS[k] === "number")
    && !!seenMissing?.includes(k) && !reported?.has(k));
}

/** The closed capability of that name; an inherited property name such as "constructor" is none. */
function capability(name: string): Capability | undefined {
  return Object.hasOwn(CAPABILITIES, name) ? CAPABILITIES[name] : undefined;
}

/** Every action of a closed capability, declared as the vocabulary has it; `confirms` is the doer's. */
export function closedActions(cap: string, confirms: boolean): ActionDecl[] {
  const c = capability(cap);
  if (!c) return [];
  return Object.entries(c.actions).map(([name, a]) => ({
    action: `${cap}.${name}`,
    idempotent: a.idempotent ?? true,
    stateless: a.sets === undefined,
    confirms,
    ...(a.args ? { args: a.args } : {}),
  }));
}

/** The keys a closed action sets, with their values; undefined for an action outside the vocabulary. */
export function closedSets(action: string): Record<string, SetValue> | undefined {
  const [cap, name] = action.split(".") as [string, string | undefined];
  if (name === undefined) return undefined;
  const actions = capability(cap)?.actions;
  const a = actions && Object.hasOwn(actions, name) ? actions[name] : undefined;
  return a ? (a.sets ?? {}) : undefined;
}

/** The state keys of a device's declaration, with their types: its capabilities' keys and its `sensorKeys`. */
export function declaredKeys(capabilities: readonly string[], sensorKeys: readonly string[] = []): Map<string, KeyType> {
  const keys = new Map<string, KeyType>();
  for (const c of capabilities) for (const [k, t] of Object.entries(capability(c)?.keys ?? {})) keys.set(k, t);
  if (capabilities.includes("sensor")) for (const k of sensorKeys) if (Object.hasOwn(SENSOR_KEYS, k)) keys.set(k, SENSOR_KEYS[k]!);
  return keys;
}

/**
 * The keys an action of one of `capabilities` sets (`on`, `level`, `setpoint` and so on), by the
 * vocabulary, whether or not the device is offered that action now: a person changing one at the
 * device is the change a lease is for, never the device's own.
 */
export function closedSetKeys(capabilities: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const c of capabilities) for (const a of Object.values(capability(c)?.actions ?? {})) for (const k of Object.keys(a.sets ?? {})) keys.add(k);
  return keys;
}

/** Whether `value` is a reading of type `type`: that scalar, or "unknown" (*A device's status*). */
export function fits(type: KeyType, value: unknown): boolean {
  if (value === "unknown") return true;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "scalar") return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  return typeof value === type;
}

/** An extension as *Devices* gives it, on any device (bridge 0.5). */
export interface Extension {
  capability: string;
  description?: string;
  actions?: { action: string; description?: string; schema?: unknown }[];
  keys?: { key: string; kind?: "state" | "event"; description?: string; schema?: unknown }[];
}

/** An extension's keys, by `kind` (absent is `state`), each with the type its schema gives. */
export interface ExtensionKeys {
  state: Map<string, KeyType>;
  events: Map<string, KeyType>;
}

/**
 * The type a key's JSON Schema gives its readings: its `type`, or that of every value of its `enum`;
 * `scalar` where it says no more; undefined where it is no scalar (an object, an array), which no
 * key may be (*Devices*).
 */
export function schemaType(schema: unknown): KeyType | undefined {
  if (schema === undefined || schema === null || typeof schema !== "object") return "scalar";
  const s = schema as { type?: unknown; enum?: unknown };
  const of = (t: unknown): KeyType | undefined | null =>
    t === "boolean" ? "boolean" : t === "number" || t === "integer" ? "number" : t === "string" ? "string"
      : t === "object" || t === "array" || t === "null" ? undefined : null;
  if (s.type !== undefined) {
    const t = of(s.type);
    return t === null ? "scalar" : t;
  }
  if (Array.isArray(s.enum) && s.enum.length) {
    const types = new Set(s.enum.map((v) => (typeof v === "number" ? "number" : typeof v)));
    if (types.size !== 1) return [...types].every((t) => ["string", "number", "boolean"].includes(t)) ? "scalar" : undefined;
    const [t] = types;
    return t === "string" || t === "number" || t === "boolean" ? t : undefined;
  }
  return "scalar";
}

/** The state and event keys of a device's extensions, with their types. */
export function extensionKeys(extensions: readonly Extension[] = []): ExtensionKeys {
  const keys: ExtensionKeys = { state: new Map(), events: new Map() };
  for (const e of extensions) {
    for (const k of e.keys ?? []) (k.kind === "event" ? keys.events : keys.state).set(k.key, schemaType(k.schema) ?? "scalar");
  }
  return keys;
}

/** The name an extension's action or key carries after its capability (*Extension names*). */
const MEMBER = /^[a-z][a-z0-9_]*$/;
/** A capability: a namespace with at least one dot. */
const NAMESPACE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

/** The `sensor` keys of the applier's vocabulary that only a computer reports (`standard/applier.md`, *Capabilities and actions*). */
const COMPUTER_SENSOR_KEYS = ["app", "camera_in_use", "microphone_in_use"];

/**
 * The keys the applier's vocabulary names as one quantity on any device, which an extension never
 * reports under its own name (GA-BRIDGE-77): every `sensor` key, a computer's included, and the one
 * key of each capability that has one. `climate`'s `mode`, `setpoint` and `current` name parts of a
 * thermostat, not a quantity of their own, and an extension's `mode` is its own (this plan's ruling).
 */
export const STANDARD_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(SENSOR_KEYS), ...COMPUTER_SENSOR_KEYS,
  ...Object.values(CAPABILITIES).map((c) => Object.keys(c.keys)).filter((k) => k.length === 1).flat(),
]);

/**
 * Why each of a device's extensions breaks *Extension names* (GA-BRIDGE-77), by its capability: a
 * capability with no dot, or a standard capability's name; an action or key that is not the
 * capability's name, a dot and `^[a-z][a-z0-9_]*$`; a key named as the vocabulary names a quantity;
 * a key whose schema is no scalar; a capability that is another's with a segment added. An empty
 * map when all of them keep it.
 */
export function extensionProblems(extensions: readonly Extension[] = []): Map<string, string> {
  const problems = new Map<string, string>();
  // A doer may hand anything: an extension, an action or a key that is no object, or a name that is no
  // string, is a problem named here, never a throw that leaves the device half taken (GA-BRIDGE-77).
  const capabilities = extensions.map(extensionName).filter((c): c is string => typeof c === "string");
  for (const e of extensions) {
    const cap = extensionName(e);
    const member = (name: unknown) => typeof name === "string" && typeof cap === "string" && name.startsWith(`${cap}.`)
      && MEMBER.test(name.slice(cap.length + 1));
    const actions = (e as { actions?: unknown } | null)?.actions ?? [];
    const keys = (e as { keys?: unknown } | null)?.keys ?? [];
    let why: string | undefined;
    if (typeof e !== "object" || e === null) why = "an extension is no object";
    else if (typeof cap !== "string" || !NAMESPACE.test(cap)) why = `${String(cap)} is not a namespace with a dot`;
    else if (Object.hasOwn(CAPABILITIES, cap)) why = `${cap} is a standard capability's name`;
    else if (capabilities.some((other) => other !== cap && (cap.startsWith(`${other}.`) || other.startsWith(`${cap}.`)))) {
      why = `${cap} is another extension's name with a segment added, or the reverse`;
    } else if (!Array.isArray(actions) || !Array.isArray(keys)) {
      why = `${cap}'s actions or keys are no list`;
    } else {
      for (const a of actions as unknown[]) {
        const name = (a as { action?: unknown } | null)?.action;
        if (!why && !member(name)) why = `the action ${String(name)} is not named ${cap}.<name>`;
      }
      for (const k of keys as unknown[]) {
        if (why) break;
        const key = (k as { key?: unknown } | null)?.key;
        if (!member(key)) why = `the key ${String(key)} is not named ${cap}.<name>`;
        else if (STANDARD_KEYS.has((key as string).slice(cap.length + 1))) why = `the key ${String(key)} reports a quantity the vocabulary names`;
        else if (schemaType((k as { schema?: unknown }).schema) === undefined) why = `the key ${String(key)}'s schema is no scalar`;
      }
    }
    if (why) problems.set(String(cap), why);
  }
  return problems;
}

/** An extension's capability as given, whatever the extension is: what `extensionProblems` keys it by. */
export function extensionName(e: unknown): unknown {
  return typeof e === "object" && e !== null ? (e as { capability?: unknown }).capability : undefined;
}

/**
 * The command's inner `value` as named arguments, checked against the action's `args` (*Commands*):
 * none for an action with none, the argument itself for an action with one, an object of them for
 * an action with several. A string saying what is wrong when it does not fit.
 */
export function namedArgs(decl: ActionDecl, value: unknown): Record<string, unknown> | string {
  const names = Object.keys(decl.args ?? {});
  if (names.length === 0) return value === undefined ? {} : `${decl.action} takes no argument`;
  let given: Record<string, unknown>;
  if (names.length === 1) {
    given = { [names[0]!]: value };
  } else {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return `${decl.action} takes an object of ${names.join(", ")}`;
    given = value as Record<string, unknown>;
    const unknown = Object.keys(given).filter((k) => !names.includes(k));
    if (unknown.length) return `unknown arguments: ${unknown.join(", ")}`;
  }
  for (const name of names) {
    const wrong = argError(name, decl.args![name]!, given[name]);
    if (wrong) return wrong;
  }
  return given;
}

function argError(name: string, c: ArgConstraint, v: unknown): string | undefined {
  if (c === "any") {
    return ["string", "number", "boolean"].includes(typeof v) ? undefined : `${name} is a string, a number or a boolean`;
  }
  if (Array.isArray(c)) return c.includes(v as never) ? undefined : `${name} is one of ${c.join(", ")}`;
  const { min, max, step } = c as { min?: number; max?: number; step?: number };
  if (typeof v !== "number" || !Number.isFinite(v)) return `${name} is a number`;
  if (min !== undefined && v < min) return `${name} is at least ${min}`;
  if (max !== undefined && v > max) return `${name} is at most ${max}`;
  if (step !== undefined && !onStep(v, min ?? 0, step)) return `${name} goes in steps of ${step} from ${min ?? 0}`;
  return undefined;
}

/**
 * Whether `v` is `from` plus a whole number of `step`s, within a rounding error's width: a value off
 * it is refused, never rounded, since the device would take a fraction as some other value (plan
 * 2c-2 review I1) and a rounded value would not be the one the command's `confirmedBy` names.
 */
function onStep(v: number, from: number, step: number): boolean {
  const n = (v - from) / step;
  return Math.abs(n - Math.round(n)) < 1e-9 * Math.max(1, Math.abs(n));
}
