import { createHash } from "node:crypto";
import type { Definition } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import type { Description } from "../port.js";
import { type ActionDecl, type ArgConstraint, type DescribeMutation, type Extension, heldBack, STANDARD_KEYS } from "../vocabulary.js";

export type { DescribeMutation } from "../vocabulary.js";
import type { Override } from "./overrides.js";
import { POLL_BOUND_MS, POLL_MS, polls } from "./polling.js";
import { confirmsOf, dryRun } from "./recording.js";

type ExtensionAction = NonNullable<Extension["actions"]>[number];
type ExtensionKey = NonNullable<Extension["keys"]>[number];

/**
 * Describing a device (the design, *Describing a device*): a converter definition's `exposes`,
 * mapped to the applier's closed vocabulary where it matches exactly and to an extension otherwise,
 * with each action's `confirms` from a dry run of its `convertSet`, and the override table's word
 * where `exposes` cannot say.
 */

/** How a converter's property becomes a reading: the key it is published under, its kind, and its value. */
export interface KeyMap {
  key: string;
  kind: "state" | "event";
  /** The reading for the converter's value; undefined when the value is none the key takes. */
  from(value: unknown): unknown;
}

/** How an action becomes a set of the converters: the property set, and its value from the command's named arguments. */
export interface ActionMap {
  property: string;
  value(args: Record<string, unknown>): unknown;
}

/** A device described, and what the doer needs to read its messages and carry out its actions. */
export interface Described {
  description: Description;
  /** By the converters' property. */
  keys: Map<string, KeyMap>;
  /** By action. */
  actions: Map<string, ActionMap>;
  /** The converters' properties whose values the declarations rest on, with their keys (GA-BRIDGE-74). */
  settings: Map<string, string>;
}

/** The reach of a device whose reach cannot be known (a sleeping device with no Poll Control and no measurement): a day, beyond any action's (GA-BRIDGE-7). */
export const UNKNOWN_REACH_MS = 86_400_000;
/** The namespace of every extension this bridge declares. */
export const NAMESPACE = "org.galatea.zigbee";

/** An expose as the converters build it, with the fields this module reads. */
interface Leaf {
  type: string;
  name: string;
  property?: string;
  access?: number;
  endpoint?: string;
  value_on?: unknown;
  value_off?: unknown;
  label?: string;
  description?: string;
  value_min?: number;
  value_max?: number;
  value_step?: number;
  values?: (string | number)[];
  features?: Leaf[];
}

const STATE = 0b001;
const SET = 0b010;
/** The exposes whose features are each a property of their own; any other with features is one value. */
const SPECIFIC = new Set(["light", "switch", "lock", "cover", "climate", "fan"]);
/**
 * The mapping layer (*What the bench taught*): the applier's sensor keys, by the converters' property,
 * by what the reading means, not by its name (GA-BRIDGE-78). A radar's `presence` is someone there
 * now, `occupancy`; the converters' `occupancy` is mostly a PIR's movement, `motion`, and a model
 * whose definition uses that name for a radar says so in its override (`Override.meaning`). Every
 * binary maps by its on-value: the converters' `contact` is on at `false` (contact broken), so
 * `opening` is true when open. Each model's mapping is recorded in its passport.
 */
export const SENSORS: Record<string, { key: string; type: "numeric" | "binary" }> = {
  temperature: { key: "temperature", type: "numeric" }, humidity: { key: "humidity", type: "numeric" },
  illuminance: { key: "illuminance", type: "numeric" }, battery: { key: "battery", type: "numeric" },
  presence: { key: "occupancy", type: "binary" }, occupancy: { key: "motion", type: "binary" },
  contact: { key: "opening", type: "binary" }, water_leak: { key: "leak", type: "binary" },
  battery_low: { key: "battery_low", type: "binary" },
};
/** A member of an extension: the name after its capability (*Extension names*). */
const MEMBER = /^[a-z][a-z0-9_]*$/;

/** The definition slug: the converters' `model`, lower-cased, every other character `_`. */
export function slug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/** The properties of `exposes`, with the specific expose each is a feature of. */
function leaves(exposes: Leaf[]): { e: Leaf; parent?: string }[] {
  return exposes.flatMap((e) => (SPECIFIC.has(e.type) ? (e.features ?? []).map((f) => ({ e: f, parent: e.type })) : [{ e }]));
}

const has = (e: Leaf, bit: number) => ((e.access ?? 0) & bit) !== 0;
const binary = (e: Leaf) => (v: unknown) => (v === e.value_on ? true : v === e.value_off ? false : undefined);
const scalar = (v: unknown) => (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ? v : undefined);

/**
 * A reading of a key whose schema the expose or the override gave: a scalar its schema allows, else
 * none. A value outside it is left out, as a field that fails its declared type is (GA-BRIDGE-1);
 * the key keeps its last value. Where a device reports beyond what its converter declares (the
 * vibration sensor's sensitivity of 200), the override widens the key's schema (`Override.schemas`).
 */
function within(schema: Record<string, unknown>): (v: unknown) => unknown {
  const { enum: values, minimum, maximum, type } = schema as { enum?: unknown[]; minimum?: number; maximum?: number; type?: string };
  return (v) => {
    const x = scalar(v);
    if (x === undefined) return undefined;
    if (values && !values.includes(x)) return undefined;
    if ((type === "number" || type === "integer") && typeof x !== "number") return undefined;
    if (type === "string" && typeof x !== "string") return undefined;
    if (type === "boolean" && typeof x !== "boolean") return undefined;
    if (typeof x === "number" && ((minimum !== undefined && x < minimum) || (maximum !== undefined && x > maximum))) return undefined;
    return x;
  };
}

/** An extension argument's constraint and its key's schema, from the expose; undefined for an expose of no scalar. */
function shapeOf(e: Leaf): { args: ArgConstraint; schema: Record<string, unknown>; tried: unknown[] } | undefined {
  if (e.type === "binary") return { args: [e.value_on, e.value_off] as (string | number | boolean)[], schema: { enum: [e.value_on, e.value_off] },
    tried: [e.value_on, e.value_off] };
  if (e.type === "enum" && e.values?.length) return { args: [...e.values], schema: { enum: [...e.values] }, tried: [...e.values] };
  if (e.type === "numeric") {
    // The expose's step is the argument's: the core refuses a value off it (plan 2c-2 review I1). The
    // key's schema keeps none, as a reading is taken unrounded.
    const args: { min?: number; max?: number; step?: number } = {};
    if (typeof e.value_min === "number") args.min = e.value_min;
    if (typeof e.value_max === "number") args.max = e.value_max;
    if (typeof e.value_step === "number" && Number.isFinite(e.value_step) && e.value_step > 0) args.step = e.value_step;
    const schema: Record<string, unknown> = { type: "number" };
    if (args.min !== undefined) schema.minimum = args.min;
    if (args.max !== undefined) schema.maximum = args.max;
    const lo = args.min ?? 0;
    return { args, schema, tried: args.max !== undefined && args.max !== lo ? [lo, args.max] : [lo] };
  }
  if (e.type === "text") return { args: "any", schema: { type: "string" }, tried: ["x"] };
  return undefined;
}

/**
 * An argument's JSON Schema: the expose's, narrowed to the constraint the override table gave; a
 * step whole from a whole minimum makes it an integer, and any step other than 1 a `multipleOf`.
 */
function argSchema(c: ArgConstraint, schema: Record<string, unknown>): Record<string, unknown> {
  if (c === "any") return schema;
  if (Array.isArray(c)) return { enum: [...(c as readonly unknown[])] };
  const range = c as { min?: number; max?: number; step?: number };
  const whole = range.step !== undefined && Number.isInteger(range.step) && Number.isInteger(range.min ?? 0);
  return { ...schema, ...(whole ? { type: "integer" } : {}), ...(range.min !== undefined ? { minimum: range.min } : {}),
    ...(range.max !== undefined ? { maximum: range.max } : {}), ...(range.step !== undefined && range.step !== 1 ? { multipleOf: range.step } : {}) };
}

/** The values an argument constraint allows of `tried`. */
function allowed(c: ArgConstraint, tried: unknown[]): unknown[] {
  return Array.isArray(c) ? tried.filter((v) => c.includes(v as never)).concat(c.filter((v) => !tried.includes(v))) : tried;
}

/** The power sources herdsman names for a device on mains, which listens when idle. */
const MAINS = new Set(["Mains (single phase)", "Mains (3 phase)", "DC Source", "Emergency mains constantly powered",
  "Emergency mains and transfer switch"]);

/**
 * The device's reach (GA-BRIDGE-7, *Devices*): 0 for a device that listens when idle, a router or an
 * end device on mains (herdsman 10.10.0 keeps no `rxOnWhenIdle`, so its power source is the
 * evidence; plan 2c-1 review M7); for a sleeping end device, the bench's measurement in the override
 * table, else its Poll Control long-poll interval where herdsman has read it, else UNKNOWN_REACH_MS.
 */
export function reachOf(device: Zh.Device, override?: Override): number {
  if (device.type === "Router" || MAINS.has(String(device.powerSource))) return 0;
  if (override?.reachMs !== undefined) return override.reachMs;
  for (const ep of device.endpoints) {
    const quarters = ep.getClusterAttributeValue("genPollCtrl", "longPollInterval");
    if (typeof quarters === "number" && quarters > 0) return quarters * 250;
  }
  return UNKNOWN_REACH_MS;
}

/**
 * Whether a lock requires a PIN for remote operation (GA-BRIDGE-36), from its Door Lock's
 * `requirePinForRfOperation` as herdsman last read it; one never read is taken to require it, its
 * worst case (GA-BRIDGE-74).
 */
export function pinRequiredOf(device: Zh.Device): boolean {
  for (const ep of device.endpoints) {
    const v: unknown = ep.getClusterAttributeValue("closuresDoorLock", "requirePinForRfOperation");
    if (v === false || v === 0) return false;
    if (v === true || v === 1) return true;
  }
  return true;
}

/**
 * The dry runs' verdicts, by definition, then device, property and values tried: they rest on the
 * definition's converters and the device's endpoints, never on its settings, so a device described
 * again runs none again (plan 2c-1 review M2).
 */
const verdicts = new WeakMap<Definition, Map<string, Promise<boolean | undefined>>>();

/** Whether the sets of `property` to each of `tried` confirm, by their dry runs, all at once; cached. */
function confirmsFor(definition: Definition, device: Zh.Device, property: string, tried: unknown[]): Promise<boolean | undefined> {
  let byRun = verdicts.get(definition);
  if (!byRun) verdicts.set(definition, (byRun = new Map()));
  const id = JSON.stringify([device.ieeeAddr, property, tried]);
  let verdict = byRun.get(id);
  if (!verdict) {
    verdict = Promise.all(tried.map((v) => dryRun(definition, device, property, v))).then(confirmsOf);
    byRun.set(id, verdict);
  }
  return verdict;
}

/** An extension key's description, from the expose's own text (its description, else its label). */
const textOf = (e: Leaf, property: string) => e.description ?? e.label ?? property;

/** The definition's version, as `configure` is kept by it in herdsman's device meta: the converters' own default where none is given. */
export function versionOf(definition: Definition): string {
  return typeof definition.version === "string" ? definition.version : "0.0.0";
}

/** herdsman's mark of a reporting turned off (`maximumReportInterval`); 0 is a report on change only, with no interval. */
const NO_REPORTING = 0xffff;

/**
 * What a run of `configure` is kept by in herdsman's device `meta.configured`: the definition's
 * version, and, where the override table configures reports of its own (`Override.reports`), a hash
 * of them, so that a bridge whose table changed configures the device again (the design, *Freshness*).
 */
export function configureVersion(definition: Definition, override?: Override): string {
  const version = versionOf(definition);
  if (!override?.reports?.length) return version;
  return `${version}+galatea.${createHash("sha256").update(JSON.stringify(override.reports)).digest("hex").slice(0, 8)}`;
}

/** Whether the device has anything to configure: its definition's `configure`, or the override's reports. */
export function configures(definition: Definition, override?: Override): boolean {
  return !!definition.configure || !!override?.reports?.length;
}

/**
 * The device's freshness bound (GA-BRIDGE-13) as a device that reports on its own: twice the longest
 * maximum reporting interval herdsman recorded on the device's endpoints, in milliseconds (herdsman
 * records one only once the device accepted it), where the definition's `configure` or the override's
 * reports succeeded at their version (herdsman's device `meta.configured`) and the bench never saw
 * the model ignore what it accepted (`Override.reportsIgnored`); else, where no periodic report is
 * configured, twice the interval the bench measured the model reporting at (`Override.rhythm`); else
 * null: the bridge never guesses one.
 */
export function boundOf(device: Zh.Device, definition: Definition, override?: Override): number | null {
  const configured = configures(definition, override) && device.meta?.configured === configureVersion(definition, override)
    && !override?.reportsIgnored ? longestReport(device) : 0;
  if (configured > 0) return 2 * configured * 1_000;
  return override?.rhythm ? 2 * override.rhythm.everyMs : null;
}

/** The longest maximum reporting interval herdsman recorded on the device's endpoints, in seconds; 0 for none. */
function longestReport(device: Zh.Device): number {
  let longest = 0;
  for (const endpoint of device.endpoints) {
    for (const r of endpoint.configuredReportings) {
      const max = r.maximumReportInterval;
      if (Number.isInteger(max) && max > 0 && max < NO_REPORTING && max > longest) longest = max;
    }
  }
  return longest;
}

/**
 * How the bridge learns of the device (*The roster and freshness*): a device it polls (`polling.ts`)
 * is `poll` at POLL_MS, its bound three times that; any other reports on its own, its bound
 * `boundOf`'s, and no cadence.
 */
export function freshnessOf(device: Zh.Device, definition: Definition, override: Override | undefined, polled: boolean)
  : Pick<Description, "basis" | "cadenceMs" | "basisMaxAgeMs"> {
  if (polled) return { basis: "poll", cadenceMs: POLL_MS, basisMaxAgeMs: POLL_BOUND_MS };
  return { basis: "report", cadenceMs: null, basisMaxAgeMs: boundOf(device, definition, override) };
}

/**
 * Describes a device from its definition. `settings` holds the last observed values of its
 * settings, by key, as the core kept them (GA-BRIDGE-74); `reported`, the awaited keys the device has
 * reported once, which are declared (GA-BRIDGE-80). `polls` says the doer polls the devices in reach
 * (`polling.ts`): not under the owner's switch, which sends a device nothing.
 */
export async function describe(device: Zh.Device, definition: Definition,
  o: { override?: Override; settings?: Record<string, unknown>; reported?: ReadonlySet<string>; mutation?: DescribeMutation; polls?: boolean } = {})
  : Promise<Described> {
  const override = o.override;
  const raw = typeof definition.exposes === "function" ? definition.exposes(device, {}) : definition.exposes;
  const capability = `${NAMESPACE}.${slug(definition.model)}`;
  const keys = new Map<string, KeyMap>();
  const actionMaps = new Map<string, ActionMap>();
  const actions: ActionDecl[] = [];
  const capabilities: string[] = [];
  const sensorKeys: string[] = [];
  const extension: { keys: ExtensionKey[]; actions: ExtensionAction[] } = { keys: [], actions: [] };
  let proposedClass: string | null = null;
  let pinRequired: boolean | undefined;

  /** The actions to offer, in order, each with its dry runs under way: all run at once (plan 2c-1 review M2). */
  const offers: { decl: Omit<ActionDecl, "confirms">; map: ActionMap; ext?: ExtensionAction; confirms: Promise<boolean | undefined> }[] = [];
  /** Offers an action whose sets are each dry-run: not offered when the dry runs cannot say it confirms. */
  const offer = (decl: Omit<ActionDecl, "confirms">, property: string, tried: unknown[], map: ActionMap, ext?: ExtensionAction) => {
    offers.push({ decl, map, ...(ext ? { ext } : {}), confirms: confirmsFor(definition, device, property, tried) });
  };

  for (const { e, parent } of leaves(raw as unknown as Leaf[])) {
    const property = e.property;
    if (!property || keys.has(property)) continue;
    const closed = !e.endpoint;
    if (closed && (parent === "switch" || parent === "light") && e.name === "state" && e.type === "binary") {
      capabilities.push("onoff");
      if (parent === "light") proposedClass = "light";
      keys.set(property, { key: "on", kind: "state", from: binary(e) });
      if (has(e, SET)) {
        offer({ action: "onoff.turn_on", idempotent: true, stateless: false }, property, [e.value_on], { property, value: () => e.value_on });
        offer({ action: "onoff.turn_off", idempotent: true, stateless: false }, property, [e.value_off], { property, value: () => e.value_off });
      }
      continue;
    }
    if (closed && parent === "light" && e.name === "brightness" && e.type === "numeric") {
      const min = e.value_min ?? 0;
      const max = e.value_max ?? 254;
      capabilities.push("level");
      keys.set(property, { key: "level", kind: "state",
        from: (v) => (typeof v === "number" ? Math.round(((v - min) * 100) / (max - min)) : undefined) });
      if (has(e, SET)) {
        offer({ action: "level.set_level", idempotent: true, stateless: false, args: { level: { min: 0, max: 100 } } }, property, [min, max],
          { property, value: (a) => Math.round(min + ((Number(a.level) * (max - min)) / 100)) });
      }
      continue;
    }
    if (closed && parent === "lock" && e.name === "state" && e.type === "binary") {
      capabilities.push("lock");
      proposedClass = "door_lock";
      pinRequired = pinRequiredOf(device);
      keys.set(property, { key: "locked", kind: "state", from: binary(e) });
      if (has(e, SET)) {
        offer({ action: "lock.lock", idempotent: true, stateless: false }, property, [e.value_on], { property, value: () => e.value_on });
        offer({ action: "lock.unlock", idempotent: true, stateless: false }, property, [e.value_off], { property, value: () => e.value_off });
      }
      continue;
    }
    const meant = override?.meaning && Object.hasOwn(override.meaning, property) ? override.meaning[property] : undefined;
    const mapped = !closed || parent ? undefined
      : meant !== undefined ? (Object.hasOwn(SENSORS, property) ? { ...SENSORS[property]!, key: meant } : undefined)
      : Object.hasOwn(SENSORS, property) ? SENSORS[property] : undefined;
    // `maps-motion-to-occupancy`: the converters' `occupancy` taken by its name, a movement published as presence.
    const sensor = mapped && o.mutation === "maps-motion-to-occupancy" && property === "occupancy" && meant === undefined
      ? { ...mapped, key: "occupancy" } : mapped;
    if (sensor && e.type === sensor.type && has(e, STATE)) {
      sensorKeys.push(sensor.key);
      keys.set(property, { key: sensor.key, kind: "state", from: sensor.type === "binary" ? binary(e) : (v) => (typeof v === "number" ? v : undefined) });
      continue;
    }
    // Anything else is the device's own: an extension key and, where settable, its set.
    const shape = shapeOf(e);
    if (!shape || !MEMBER.test(property) || STANDARD_KEYS.has(property)) continue;
    const key = `${capability}.${property}`;
    const event = property === "action" || !!override?.events?.includes(property);
    // An event whose one value is an occurrence (`Override.occurrence`): any other value is none.
    const occurs = event && override?.occurrence && Object.hasOwn(override.occurrence, property) ? override.occurrence[property] : undefined;
    if (has(e, STATE)) {
      // The override's schema for the key, where the device reports beyond what its converter declares (plan 2c-2 review M3).
      const keySchema = override?.schemas && Object.hasOwn(override.schemas, property) ? override.schemas[property]! : shape.schema;
      keys.set(property, { key, kind: event ? "event" : "state", from: occurs === undefined ? within(keySchema) : (v) => (v === occurs ? v : undefined) });
      extension.keys.push({ key, ...(event ? { kind: "event" as const } : {}), description: textOf(e, property),
        schema: occurs === undefined ? keySchema : { enum: [occurs] } });
    }
    // A feature of a specific expose the closed vocabulary does not map (a cover's, a thermostat's, a
    // fan's, a light's beyond onoff and level) gives its key only: offered as the device's own, its
    // set would pass the applier's class rows (plan 2c-1 review I4).
    if (has(e, SET) && closed && !parent && !event) {
      const args = override?.args && Object.hasOwn(override.args, property) ? override.args[property]! : shape.args;
      const stateful = has(e, STATE);
      const action = `${capability}.set_${property}`;
      const label = e.label ?? property;
      offer({ action, idempotent: !override?.notIdempotent?.includes(property), stateless: !stateful, args: { value: args },
        ...(stateful ? { confirmedBy: { key, value: { arg: "value" } } } : {}) }, property, allowed(args, shape.tried), { property, value: (a) => a.value },
        { action, description: e.description ? `Sets ${label}: ${e.description}` : `Sets ${label}`,
          schema: { type: "object", properties: { value: argSchema(args, shape.schema) } } });
    }
  }
  for (const [property, k] of Object.entries(override?.keys ?? {})) {
    if (keys.has(property)) continue;
    // A property the mapping layer knows is its vocabulary key, as an expose of it would be (GA-BRIDGE-78).
    const meant = override?.meaning?.[property] ?? (Object.hasOwn(SENSORS, property) ? SENSORS[property]!.key : undefined);
    if (meant !== undefined) {
      keys.set(property, { key: meant, kind: "state", from: within(k.schema) });
      if (!sensorKeys.includes(meant)) sensorKeys.push(meant);
      continue;
    }
    const key = `${capability}.${property}`;
    keys.set(property, { key, kind: "state", from: within(k.schema) });
    extension.keys.push({ key, description: k.description, schema: k.schema });
  }
  if (override?.press) {
    const { property, value, description } = override.press;
    const action = `${capability}.press`;
    offer({ action, idempotent: false, stateless: true, toggles: true }, property, [value], { property, value: () => value },
      { action, description, schema: { type: "object", properties: {} } });
  }
  for (const [i, confirms] of (await Promise.all(offers.map((o) => o.confirms))).entries()) {
    const o = offers[i]!;
    if (confirms === undefined) continue;
    actions.push({ ...o.decl, confirms });
    actionMaps.set(o.decl.action, o.map);
    if (o.ext) extension.actions.push(o.ext);
  }
  // Held back: a sensor key the override names as seen missing, not yet reported (GA-BRIDGE-80). Its
  // converter stays in `keys`, so that the first report is read, and declares it.
  // Only a numeric measurement, never a boolean: a leak sensor's `leak` is declared from the start, whatever an override says.
  const awaitedKeys = heldBack(sensorKeys, override?.awaited, o.reported, o.mutation === "holds-back-the-leak");
  if (awaitedKeys.length) sensorKeys.splice(0, sensorKeys.length, ...sensorKeys.filter((k) => !awaitedKeys.includes(k)));
  if (sensorKeys.length) capabilities.push("sensor");
  // A device of no closed actuator that senses, or tells of events, is proposed as a sensor; the owner decides.
  const senses = sensorKeys.length > 0 || [...keys.values()].some((k) => k.kind === "event");
  if (!proposedClass && !capabilities.some((c) => c !== "sensor") && senses) proposedClass = "sensor";

  const settings = new Map<string, string>();
  for (const property of override?.settings ?? []) {
    const k = keys.get(property);
    if (k?.kind === "state") settings.set(property, k.key);
  }
  let declared = actions;
  if (override?.declare) {
    const values: Record<string, unknown> = {};
    for (const [property, key] of settings) values[property] = o.settings?.[key];
    declared = override.declare(values, actions);
  }
  // An extension action is described only where it is offered (a press only in the mode that has one).
  extension.actions = extension.actions.filter((x) => declared.some((d) => d.action === x.action));
  const extensions: Extension[] = extension.keys.length || extension.actions.length
    ? [{ capability, description: definition.description, ...(extension.actions.length ? { actions: extension.actions } : {}), keys: extension.keys }]
    : [];
  const reachMs = reachOf(device, override);
  const description: Description = {
    hardwareId: device.ieeeAddr,
    stableIdentifier: device.ieeeAddr,
    model: { vendor: device.manufacturerName ?? "", model: device.modelID ?? "" },
    capabilities,
    ...(sensorKeys.length ? { sensorKeys } : {}),
    actions: declared,
    feedback: "closed",
    reachMs,
    proposedClass,
    classEvidence: definition.generated ? "protocol" : "model_db",
    otherAdmins: "unknown",
    ...(extensions.length ? { extensions } : {}),
    ...(settings.size ? { settings: [...settings.values()] } : {}),
    ...(awaitedKeys.length ? { awaitedKeys } : {}),
    ...(pinRequired !== undefined ? { pinRequired } : {}),
    // A router, by herdsman's model, at which a join window can open (GA-BRIDGE-26; plan 3a review M4).
    ...(device.type === "Router" ? { router: true } : {}),
    // Polled where the doer polls and the device is in reach; otherwise from the reporting configured
    // and accepted, or the model's measured rhythm; the converters keep no model figure (GA-BRIDGE-13).
    ...freshnessOf(device, definition, override, o.polls === true && override?.poll !== false && polls(device, reachMs)),
  };
  return { description, keys, actions: actionMaps, settings };
}

