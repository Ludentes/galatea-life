import type { ConfirmedBy, Constraint } from "../bus/wire.js";

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

/** Why `v` does not meet a device's constraint `c`, `name` being the argument's path. */
function constraintFault(name: string, c: Constraint, v: unknown): string | undefined {
  if (c === "any") return undefined;
  if ("enum" in c) return c.enum.includes(v as string) ? undefined : `${name} is not one of ${c.enum.join(", ")} on this device`;
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
  if (typeof v !== "number") return `${name} is not a number`;
  if (c.min !== undefined && v < c.min) return `${name} ${v} is below ${c.min}`;
  if (c.max !== undefined && v > c.max) return `${name} ${v} is above ${c.max}`;
  return undefined;
}

/**
 * Why `args` do not fit `action`, or undefined: they are an object, with every argument the action
 * takes, of its type and range, and no other; then each argument the device's own `constraints`
 * name meets its constraint (applier, *Requests*). An argument they do not name is as the vocabulary
 * gives it; `notify`'s `from` is never refused, since a device that does not list it is sent none
 * (GA-APPLY-14). An action outside the standard's table (an extension) takes any object of
 * arguments, narrowed only by its device's constraints; its manifest's schema is the PC build's.
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
  const fault = vocabularyFault(action, args);
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
    if (!Object.hasOwn(args, name) || args[name] === undefined) continue;
    const f = constraintFault(name, c, args[name]);
    if (f) return f;
  }
  return undefined;
}

function vocabularyFault(action: string, args: Record<string, unknown>): string | undefined {
  const spec = ARGS[action];
  if (!spec) return undefined;
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
 * A command's inner `value` (bridge, *Commands*): the argument itself for a standard action with one
 * (`set_level` carries 40), an object of them for one with several (`notify` carries `{ text,
 * urgency }`), and absent for one with none; an extension action's arguments go as their object.
 * `notify`'s `from` goes only to a device whose `notify` lists it (GA-APPLY-14).
 */
export function commandValue(action: string, args: Record<string, unknown>, o: { from: boolean }): unknown {
  const given = Object.entries(args).filter(([k, v]) => v !== undefined && !(action === "notify.notify" && k === "from" && !o.from));
  const spec = ARGS[action];
  if (!spec) return given.length ? Object.fromEntries(given) : undefined;
  const names = Object.keys(spec);
  if (names.length === 0) return undefined;
  if (names.length === 1) return args[names[0]!];
  return Object.fromEntries(given);
}

/** The default `tolerance` of a numeric key (applier, *Action declarations*). */
const TOLERANCE: Record<string, number> = { level: 1, volume: 1, setpoint: 0.5, position: 2 };

/**
 * The key an action sets, what matches it, and for a numeric key the value it wants, so a report can
 * move towards it; `value`, the value it asks for, which an open device's state assumes once it is
 * sent (GA-STATE-4), absent where an argument chooses among several (`session.lock`).
 */
export type Sets = { key: string; matches: (value: unknown) => boolean; want?: number; value?: unknown };

const near = (key: string, want: unknown): Sets => ({ key, value: want, ...(typeof want === "number" ? { want } : {}), matches: (v) =>
  typeof v === "number" && typeof want === "number" && Math.abs(v - want) <= (TOLERANCE[key] ?? 0) });
const exactly = (key: string, want: unknown): Sets => ({ key, value: want, matches: (v) => v === want });

/**
 * The key a stateful action sets and what matches it (the key an argument chooses included, *Key
 * families*), or undefined for a stateless action and for one never `already` (`media.launch`). An
 * extension action sets what its `confirmed_by` names: its key, at its value or the value of the
 * argument it names (applier, *Action declarations*, GA-EVT-3).
 */
export function sets(action: string, args: Record<string, unknown>, confirmedBy?: ConfirmedBy): Sets | undefined {
  if (confirmedBy) {
    const want = typeof confirmedBy.value === "object" ? args[confirmedBy.value.arg] : confirmedBy.value;
    return typeof want === "number" ? near(confirmedBy.key, want) : exactly(confirmedBy.key, want);
  }
  switch (action) {
    case "onoff.turn_on": return exactly("on", true);
    case "onoff.turn_off": return exactly("on", false);
    case "level.set_level": return near("level", args.level);
    case "color.set_color": return { key: "color", value: args.rgb, matches: (v) =>
      typeof v === "string" && typeof args.rgb === "string" && v.toLowerCase() === args.rgb.toLowerCase() };
    case "climate.set_mode": return exactly("mode", args.mode);
    case "climate.set_setpoint": return near("setpoint", args.celsius);
    case "cover.open": return near("position", 100);
    case "cover.close": return near("position", 0);
    case "cover.set_position": return near("position", args.position);
    case "media.pause": return exactly("playing", false);
    case "media.resume": return exactly("playing", true);
    case "media.set_volume": return near("volume", args.volume);
    case "valve.open": return exactly("open", true);
    case "valve.close": return exactly("open", false);
    case "lock.lock": return exactly("locked", true);
    case "lock.unlock": return exactly("locked", false);
    case "session.lock": return { key: `session.${String(args.account)}`, matches: (v) =>
      v === "locked" || v === "disconnected" || v === "none" };
    default: return undefined;
  }
}

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
