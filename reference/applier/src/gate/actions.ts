import { sets, type Sets } from "@ludentes/galatea-life-schemas";
import { optionalArg, type ConfirmedBy, type Constraint } from "../bus/wire.js";

/**
 * The standard's actions as data (applier, *Capabilities and actions*, *Action declarations*): each
 * one's arguments, for `refuse(invalid_args)`, and the key it sets with the value that matches it,
 * for `already` (GA-PLAN-4) and later for `acked` (GA-EVT-3).
 */

type Arg =
  | { type: "number"; min?: number; max?: number; optional?: true }
  | { type: "string"; pattern?: RegExp; optional?: true }
  | { type: "enum"; values: readonly string[]; optional?: true }
  | { type: "boolean"; optional?: true }
  | { type: "object"; optional?: true };

const percent: Arg = { type: "number", min: 0, max: 100 };

/** Each standard action's arguments by name; an action with none takes `{}`. */
const ARGS: Record<string, Record<string, Arg>> = {
  "onoff.turn_on": {}, "onoff.turn_off": {},
  "level.set_level": { level: percent },
  "color.set_color": { rgb: { type: "string", pattern: /^#[0-9a-fA-F]{6}$/ } },
  "climate.set_mode": { mode: { type: "enum", values: ["off", "heat", "cool", "auto", "fan"] } },
  "climate.set_setpoint": { celsius: { type: "number" } },
  "cover.open": {}, "cover.close": {}, "cover.stop": {}, "cover.set_position": { position: percent },
  "media.pause": {}, "media.resume": {}, "media.set_volume": { volume: percent },
  "media.duck": { on: { type: "boolean" } },
  "media.announce": { text: { type: "string" } },
  // Its search's fields are the PC slice's to check against the device's `args`.
  "media.launch": { search: { type: "object" } },
  "valve.open": {}, "valve.close": {},
  "lock.lock": {}, "lock.unlock": {},
  "notify.notify": { text: { type: "string" }, urgency: { type: "enum", values: ["info", "warning", "critical"] },
    from: { type: "object", optional: true } },
  "power.wake": {}, "power.sleep": {}, "power.cancel": {}, "power.shutdown": { delay_s: { type: "number", min: 0, optional: true } },
  "session.lock": { account: { type: "string", pattern: /^[A-Za-z0-9._-]{1,64}$/ } },
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function argFault(name: string, spec: Arg, v: unknown): string | undefined {
  switch (spec.type) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${name} is not a number`;
      if (spec.min !== undefined && v < spec.min) return `${name} ${v} is below ${spec.min}`;
      if (spec.max !== undefined && v > spec.max) return `${name} ${v} is above ${spec.max}`;
      return undefined;
    case "string":
      if (typeof v !== "string") return `${name} is not a string`;
      return spec.pattern && !spec.pattern.test(v) ? `${name} ${JSON.stringify(v)} is not of its form` : undefined;
    case "enum":
      return typeof v === "string" && spec.values.includes(v) ? undefined : `${name} is not one of ${spec.values.join(", ")}`;
    case "boolean":
      return typeof v === "boolean" ? undefined : `${name} is not a boolean`;
    case "object":
      return isObject(v) ? undefined : `${name} is not an object`;
  }
}

/**
 * Whether `v` is `from` plus a whole number of `step`s, within a rounding error's width, as the Zigbee
 * bridge judges it: a value off the step is refused, never rounded, since the device would take it as
 * another value and a rounded one would not be the one the step's `confirmed_by` names.
 */
function onStep(v: number, from: number, step: number): boolean {
  const n = (v - from) / step;
  return Math.abs(n - Math.round(n)) < 1e-9 * Math.max(1, Math.abs(n));
}

/** Why `v` does not meet a device's constraint `c`, `name` being the argument's path. */
function constraintFault(name: string, c: Constraint, v: unknown): string | undefined {
  // No limit is any scalar, as both bridges take it: never null, an object or a list (preflight I3).
  const scalar = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  if (c === "any") return scalar ? undefined : `${name} is not a scalar`;
  if ("enum" in c) {
    if (!c.enum.length) return `${name} allows no value on this device`;
    return c.enum.includes(v as string) ? undefined : `${name} is not one of ${c.enum.join(", ")} on this device`;
  }
  if ("fields" in c) {
    if (!isObject(v)) return `${name} is not an object`;
    for (const [k, x] of Object.entries(v)) {
      const f = Object.hasOwn(c.fields, k) ? c.fields[k] : undefined;
      if (!f) return `${name}.${k} is not supported by this device`;
      const fault = constraintFault(`${name}.${k}`, f, x);
      if (fault) return fault;
    }
    return undefined;
  }
  // A range of no bound and no step (`{ optional: true }`) is no limit: any scalar.
  if (c.min === undefined && c.max === undefined && c.step === undefined) return scalar ? undefined : `${name} is not a scalar`;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${name} is not a number`;
  if (c.min !== undefined && v < c.min) return `${name} ${v} is below ${c.min}`;
  if (c.max !== undefined && v > c.max) return `${name} ${v} is above ${c.max}`;
  if (c.step !== undefined && !onStep(v, c.min ?? 0, c.step)) return `${name} ${v} is not ${c.min ?? 0} plus a whole number of steps of ${c.step}`;
  return undefined;
}

/**
 * Why `args` do not fit `action`, or undefined: they are an object, with every argument the action
 * takes, of its type and range, and no other; then each argument the device's own `constraints`
 * name meets its constraint (applier, *Requests*). An argument they do not name is as the vocabulary
 * gives it; `notify`'s `from` is never refused, since a device that does not list it is sent none
 * (GA-APPLY-14). An action outside the standard's table (an extension) takes the arguments its
 * device's `args` name and no other, each narrowed by its constraint; its manifest's schema is the PC build's.
 */
/**
 * Whether `arg` is an argument of a standard action that takes a number (`climate.set_setpoint`'s
 * `celsius`): what a witness's `toward` can move towards. An extension action's arguments are its
 * bridge's to describe, and any is taken.
 */
export function numberArg(action: string, arg: string): boolean {
  const spec = ARGS[action];
  return spec === undefined ? !Object.hasOwn(ARGS, action) : spec[arg]?.type === "number";
}

export function argsFault(action: string, args: unknown, constraints?: Record<string, Constraint>, confirmedBy?: ConfirmedBy): string | undefined {
  if (!isObject(args)) return "args is not an object";
  const fault = vocabularyFault(action, args, constraints);
  if (fault) return fault;
  // The argument a confirmed_by names is what acks the step: without it, or not a scalar, nothing could (GA-EVT-3).
  if (confirmedBy && typeof confirmedBy.value === "object") {
    const v = args[confirmedBy.value.arg];
    if (!(typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) {
      return `${confirmedBy.value.arg} is required, a scalar: ${action}'s confirmed_by names it`;
    }
  }
  if (!constraints) return undefined;
  for (const [name, c] of Object.entries(constraints)) {
    if (action === "notify.notify" && name === "from") continue;
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      // An extension action's arguments are its device's to declare: one not `optional` is required,
      // as its bridge requires it. A standard action's are the vocabulary's.
      if (!Object.hasOwn(ARGS, action) && !optionalArg(c)) return `${name} is required`;
      continue;
    }
    const f = constraintFault(name, c, args[name]);
    if (f) return f;
  }
  return undefined;
}

function vocabularyFault(action: string, args: Record<string, unknown>, constraints?: Record<string, Constraint>): string | undefined {
  const spec = ARGS[action];
  // An extension action takes the arguments its device's `args` name, and no other: its command
  // carries them by that count (bridge, *Commands*), and its bridge refuses any other.
  if (!spec) {
    for (const name of Object.keys(args)) {
      if (args[name] !== undefined && !(constraints && Object.hasOwn(constraints, name))) return `${action} takes no argument ${name}`;
    }
    return undefined;
  }
  for (const name of Object.keys(args)) if (!Object.hasOwn(spec, name)) return `${action} takes no argument ${name}`;
  for (const [name, arg] of Object.entries(spec)) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      if (arg.optional) continue;
      return `${name} is required`;
    }
    const fault = argFault(name, arg, args[name]);
    if (fault) return fault;
  }
  return undefined;
}

/**
 * A command's inner `value` (bridge, *Commands*): the argument itself for an action with one
 * (`set_level` carries 40), an object of them for one with several (`notify` carries `{ text,
 * urgency }`), and absent for one with none. A standard action's arguments are the vocabulary's; an
 * extension action's, the names its device's `args` declare (`declared`), so a button pusher's
 * `set_mode` with `args: { mode: [...] }` carries `"click"`, never `{ mode: "click" }`. `notify`'s
 * `from` goes only to a device whose `notify` lists it (GA-APPLY-14).
 */
export function commandValue(action: string, args: Record<string, unknown>, o: { from: boolean; declared?: readonly string[] }): unknown {
  const given = Object.entries(args).filter(([k, v]) => v !== undefined && !(action === "notify.notify" && k === "from" && !o.from));
  const spec = ARGS[action];
  const names = spec ? Object.keys(spec) : [...(o.declared ?? [])];
  if (names.length === 0) return undefined;
  if (names.length === 1) return args[names[0]!];
  return Object.fromEntries(given);
}

// What an action sets, and the report that matches it, is the one table the steward reads too.
export { sets, type Sets } from "@ludentes/galatea-life-schemas";

/** Whether the observed `values` already hold what `action` would set, within its tolerance (GA-PLAN-4's `already`). */
export function holds(action: string, args: Record<string, unknown>, values: ReadonlyMap<string, unknown>, confirmedBy?: ConfirmedBy): boolean {
  const s = sets(action, args, confirmedBy);
  return !!s && values.has(s.key) && s.matches(values.get(s.key));
}

/**
 * Whether a report of `value`, where `old` was, moves towards what `s` sets (applier, *Causes*): it
 * matches, or, for a numeric key, it is nearer the value wanted than `old` was (a cover's
 * intermediate `position`).
 */
export function towards(s: Sets, value: unknown, old: unknown): boolean {
  if (s.matches(value)) return true;
  if (s.want === undefined || typeof value !== "number" || typeof old !== "number") return false;
  return Math.abs(value - s.want) < Math.abs(old - s.want);
}

/** The side effects of an action a report may show (applier, *Causes*): `set_level` and `set_color` turn a light `on`. */
export function sideEffects(action: string): { key: string; value: unknown }[] {
  return action === "level.set_level" || action === "color.set_color" ? [{ key: "on", value: true }] : [];
}
