import type { Manifest, ManifestDevice } from "./manifest.js";

/** The bridge's own caps (the design's *Plugins on Linux*): a string reading, a state object, an ack's `detail`. */
export const READING_MAX_BYTES = 1024;
export const STATE_MAX_BYTES = 64 * 1024;
export const DETAIL_MAX_BYTES = 1024;

/** A reading's type, as the applier's table or an extension key's schema gives it. */
export type KeyType = "boolean" | "number" | "integer" | "string";

/** The state keys of each standard capability (`standard/applier.md`, *Capabilities and actions*). */
const CAPABILITY_KEYS: Record<string, Record<string, KeyType>> = {
  onoff: { on: "boolean" },
  level: { level: "number" },
  color: { color: "string" },
  climate: { mode: "string", setpoint: "number", current: "number" },
  cover: { position: "number" },
  media: { playing: "boolean", volume: "number", speech: "string", title: "string", started_at: "string" },
  valve: { open: "boolean" },
  lock: { locked: "boolean" },
};

/** The sensor keys a device may list in `sensorKeys`, with their types. */
const SENSOR_KEYS: Record<string, KeyType> = {
  temperature: "number", humidity: "number", motion: "boolean", contact: "boolean", leak: "boolean", occupancy: "boolean",
  battery: "number", app: "string", camera_in_use: "boolean", microphone_in_use: "boolean",
};

/**
 * The keys a plugin device declares, each with its type (*State*): the state keys of its
 * capabilities, its `sensorKeys`, and the keys of the extensions whose capability it lists.
 */
export function declaredKeys(m: Manifest, d: ManifestDevice): Map<string, KeyType> {
  const keys = new Map<string, KeyType>();
  for (const c of d.capabilities) for (const [k, t] of Object.entries(CAPABILITY_KEYS[c] ?? {})) keys.set(k, t);
  for (const k of d.sensorKeys) keys.set(k, SENSOR_KEYS[k] ?? "string");
  for (const e of m.extensions ?? []) {
    if (!d.capabilities.includes(e.capability)) continue;
    for (const k of e.keys) keys.set(k.key, k.schema.type as KeyType);
  }
  return keys;
}

const fits: Record<KeyType, (v: unknown) => boolean> = {
  boolean: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  string: (v) => typeof v === "string",
};

/** A read's outcome: the readings and what was left out, or why the read failed. */
export type Read =
  | { ok: true; values: Record<string, string | number | boolean>; dropped: string[] }
  | { ok: false; why: string };

/**
 * A state resource's text as the device's readings (*State*, GA-BRIDGE-1): one JSON object of at most
 * STATE_MAX_BYTES, else the read failed. Each declared key whose value fits its type becomes a
 * reading, `"unknown"` fitting any; a value that fails its type, or a string over READING_MAX_BYTES,
 * is left out and named in `dropped` (the device's fault `reading_dropped`); a key the device does not
 * declare is left out.
 */
export function toReadings(text: string, keys: Map<string, KeyType>): Read {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > STATE_MAX_BYTES) return { ok: false, why: `the state is ${bytes} bytes, over ${STATE_MAX_BYTES}` };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, why: "the state is not JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, why: "the state is not one JSON object" };
  const values: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const type = keys.get(k);
    if (type === undefined) continue;
    if (typeof x === "string" && Buffer.byteLength(x, "utf8") > READING_MAX_BYTES) {
      dropped.push(`${k}: over ${READING_MAX_BYTES} bytes`);
    } else if (x === "unknown" || fits[type](x)) {
      values[k] = x as string | number | boolean;
    } else {
      dropped.push(`${k}: not a ${type}`);
    }
  }
  return { ok: true, values, dropped };
}

/** Text cut to at most `max` bytes of UTF-8 at a character's boundary, the cut marked with "…". */
export function capText(text: string, max = DETAIL_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const mark = "…";
  let bytes = Buffer.byteLength(mark, "utf8");
  let out = "";
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, "utf8");
    if (bytes > max) break;
    out += ch;
  }
  return out + mark;
}
