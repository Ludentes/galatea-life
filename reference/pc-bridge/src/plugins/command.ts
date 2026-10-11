import type { ManifestAction } from "./manifest.js";
import type { ToolOutcome } from "./mcp.js";
import { capText } from "./state.js";

/** A terminal ack's content. */
export interface Outcome {
  result: "applied" | "sent" | "failed";
  reason?: string;
  detail?: string;
}

/** The read-back is started this long before it must be out (GA-BRIDGE-34's bound less 1 s): a read's own time (⚠️ a guess). */
export const READ_BACK_LEAD_MS = 1_000;

const NUMBER_KEYS = new Set(["min", "max", "optional"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const scalar = (v: unknown) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** Whether a constraint marks its argument optional (`{ optional: true }`, alone or with `min`/`max`). */
const optional = (c: unknown) => isObject(c) && c.optional === true;

/**
 * A value against one of the manifest's `args` constraints (`standard/bridge.md`, *Devices*;
 * `standard/applier.md`, *Capabilities and actions*): `"any"` any scalar; a list, one of its
 * values; `{ min?, max?, optional? }` a number within the bounds; any other object, an object of
 * those fields, each checked by its own constraint, none else. Null when it fits, else why not.
 */
export function checkArg(name: string, c: unknown, v: unknown): string | null {
  if (c === "any") return scalar(v) ? null : `${name} is not a string, a number or a boolean`;
  if (Array.isArray(c)) return c.some((x) => x === v) ? null : `${name} is none of ${JSON.stringify(c)}`;
  if (isObject(c) && Object.keys(c).every((k) => NUMBER_KEYS.has(k))) {
    if (typeof v !== "number" || !Number.isFinite(v)) return `${name} is not a number`;
    if (typeof c.min === "number" && v < c.min) return `${name} is below ${c.min}`;
    if (typeof c.max === "number" && v > c.max) return `${name} is above ${c.max}`;
    return null;
  }
  if (isObject(c)) {
    if (!isObject(v)) return `${name} is not an object`;
    // An object argument's fields are supported, not required (applier, *Capabilities and actions*).
    return fields(name, c, v, false);
  }
  return `${name}'s constraint is not one the bridge knows`;
}

/**
 * An object's fields against the constraints of each, none unknown: the command's several arguments
 * (`required`), each present unless optional; an object argument's fields, none required.
 */
function fields(name: string, cs: Record<string, unknown>, v: Record<string, unknown>, required = true): string | null {
  const unknown = Object.keys(v).filter((k) => !Object.hasOwn(cs, k));
  if (unknown.length) return `${name || "the value"} has unknown keys: ${unknown.join(", ")}`;
  for (const [k, c] of Object.entries(cs)) {
    const where = name ? `${name}.${k}` : k;
    if (!Object.hasOwn(v, k)) {
      if (required && !optional(c)) return `${where} is missing`;
      continue;
    }
    const wrong = checkArg(where, c, v[k]);
    if (wrong) return wrong;
  }
  return null;
}

/**
 * The tool's arguments for a command's `value` (*Plugins*, *Commands*): the command's arguments,
 * named as the manifest names them. An action of no argument carries none; of one, the argument
 * itself, bare; of several, an object of them (*Commands*). A value that does not fit is
 * `invalid_request`, nothing called.
 */
export function toolArguments(a: ManifestAction, has: boolean, value: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; why: string } {
  const names = Object.keys(a.args ?? {});
  if (names.length === 0) return has ? { ok: false, why: `${a.action} takes no argument` } : { ok: true, args: {} };
  if (names.length === 1) {
    const [n] = names as [string];
    const c = a.args![n];
    if (!has) return optional(c) ? { ok: true, args: {} } : { ok: false, why: `${n} is missing` };
    const wrong = checkArg(n, c, value);
    return wrong ? { ok: false, why: wrong } : { ok: true, args: { [n]: value } };
  }
  if (!has) {
    const needed = names.filter((n) => !optional(a.args![n]));
    return needed.length ? { ok: false, why: `${needed.join(", ")} missing` } : { ok: true, args: {} };
  }
  if (!isObject(value)) return { ok: false, why: `${a.action} takes an object of ${names.join(", ")}` };
  const wrong = fields("", a.args!, value);
  return wrong ? { ok: false, why: wrong } : { ok: true, args: { ...value } };
}

/**
 * A tool's result as the command's ack (*Plugins*, *Commands*, GA-BRIDGE-47): a success `applied`
 * where the action declares `confirms`, else `sent`; `isError` `failed(no_confirmation)` with the
 * tool's text; a request for input, a call that failed or one whose time ran out `failed(no_confirmation)`,
 * since the tool may have run. `detail` is capped at 1 KiB, the cut marked. A success carries no
 * `detail`: its text is often the device's state (the mpv plugin's is), personal keys and all,
 * which goes out in the status, declared, and never in an ack.
 */
export function toOutcome(a: ManifestAction, r: ToolOutcome): Outcome {
  if (r.kind === "ok") return { result: a.confirms ? "applied" : "sent" };
  return { result: "failed", reason: "no_confirmation", detail: capText(r.text || "the tool reported an error and no text") };
}
