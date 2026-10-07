import { posix } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";

/** Where a package keeps its manifest: at its root, as the mpv plugin's packaging writes it. */
export const MANIFEST_FILE = "manifest.json";
/** What an `id`, a `key` and a `version` may hold, since each becomes part of a device id (GA-BRIDGE-68). */
export const NAME = /^[A-Za-z0-9._-]+$/;
export const ID_MAX = 40;
export const KEY_MAX = 40;
export const VERSION_MAX = 32;
/** A device's bound is three times its cadence (GA-BRIDGE-13); the standard caps the cadence (GA-BRIDGE-68, ⚠️ a guess). */
export const CADENCE_MAX_MS = 300_000;
/** The bridge's own caps (the design's *Plugins on Linux*): a manifest's size, its tools, a description's size. */
export const MANIFEST_MAX_BYTES = 256 * 1024;
export const TOOLS_MAX = 64;
export const DESCRIPTION_MAX_BYTES = 2 * 1024;

/** A standard capability's action, `capability.action` (wave 0's pattern). */
const STANDARD_ACTION = /^[a-z_]+\.[a-z_]+$/;
/** A tool's hash as the mpv plugin writes it: SHA-256, lowercase hex (a standards candidate: the text says only "a SHA-256"). */
const TOOL_HASH = /^[0-9a-f]{64}$/;
/** An interpreter named, not a path: what `PATH` resolution may look for. */
const INTERPRETER = /^[A-Za-z0-9._+-]+$/;
/** A `command` element ending so names a script, and must be one of the package's files. */
const SCRIPT = /\.(?:js|mjs|cjs|py|pyc|rb|pl|sh|lua|php|jar)$/;

export interface ManifestAction {
  action: string;
  tool: string;
  args?: Record<string, unknown>;
  idempotent: boolean;
  stateless: boolean;
  confirms: boolean;
  confirmedBy?: { key: string; value: unknown };
  requestedTier?: string;
}

export interface ManifestDevice {
  key: string;
  proposedClass: string | null;
  capabilities: string[];
  sensorKeys: string[];
  personal?: string[];
  selfChanging?: string[];
  cadenceMs: number;
  stateUri: string;
  actions: ManifestAction[];
}

export interface ManifestExtension {
  capability: string;
  description: string;
  actions: { action: string; description: string; schema: Record<string, unknown> }[];
  keys: { key: string; description: string; schema: Record<string, unknown> }[];
}

export interface Manifest {
  id: string;
  version: string;
  devices: ManifestDevice[];
  extensions?: ManifestExtension[];
  toolHashes: Record<string, string>;
  command: string[];
  hosts: string[];
  needsSession?: boolean;
  otherAdmins?: { vendor: string; label: string }[];
}

/** The manifest, or every reason it is not one the bridge installs (`invalid_manifest`). */
export type Checked = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * A package path as the manifest writes it, relative to the package's root: `./server.js` is
 * `server.js`; null for one that leaves the package (absolute, or through `..`).
 */
export function packagePath(p: string): string | null {
  if (p.startsWith("/") || p.includes("\0")) return null;
  const n = posix.normalize(p);
  if (n === ".." || n.startsWith("../") || n === ".") return null;
  return n.replace(/\/+$/, "");
}

/** The publisher's namespace: the plugin's `id` without its last label (`org.example` for `org.example.kodi`). */
export function namespaceOf(id: string): string {
  return id.slice(0, id.lastIndexOf("."));
}

/**
 * Parses and checks a manifest read from a package whose files are `files` (paths from its root), as
 * *The manifest* and the design's caps ask; every problem is named, none is fixed up.
 */
export function checkManifest(text: Buffer, files: ReadonlySet<string>): Checked {
  if (text.length > MANIFEST_MAX_BYTES) return { ok: false, problems: [`the manifest is over ${MANIFEST_MAX_BYTES} bytes`] };
  let value: unknown;
  try {
    value = JSON.parse(text.toString("utf8"));
  } catch (err) {
    return { ok: false, problems: [`the manifest is not JSON: ${(err as Error).message}`] };
  }
  const problems = check(value, files);
  return problems.length ? { ok: false, problems } : { ok: true, manifest: value as Manifest };
}

function check(m: unknown, files: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!isObject(m)) return ["the manifest is not an object"];
  const name = (what: string, v: unknown, max: number): v is string => {
    // `.` and `..` pass the standard's charset, but each names no directory of its own (a version is one).
    if (v === "." || v === "..") {
      out.push(`${what} ${JSON.stringify(v)} names no directory`);
      return false;
    }
    if (typeof v === "string" && NAME.test(v) && v.length <= max) return true;
    out.push(`${what} ${JSON.stringify(v)} is not 1 to ${max} of [A-Za-z0-9._-]`);
    return false;
  };
  const described = (what: string, v: unknown) => {
    if (typeof v !== "string") out.push(`${what} has no description`);
    else if (bytes(v) > DESCRIPTION_MAX_BYTES) out.push(`${what}'s description is over ${DESCRIPTION_MAX_BYTES} bytes`);
  };

  // The id: reverse-DNS, so at least two labels, none empty.
  let ns = "";
  if (name("id", m.id, ID_MAX)) {
    if (!/^[^.]+(\.[^.]+)+$/.test(m.id)) out.push(`id ${JSON.stringify(m.id)} is not reverse-DNS (org.example.plugin)`);
    else ns = namespaceOf(m.id);
  }
  name("version", m.version, VERSION_MAX);

  // The tools: one hash per tool, lowercase hex, at most TOOLS_MAX of them.
  const tools = isObject(m.toolHashes) ? m.toolHashes : undefined;
  if (!tools) out.push("toolHashes is not an object of tool names to hashes");
  else {
    if (Object.keys(tools).length > TOOLS_MAX) out.push(`toolHashes names more than ${TOOLS_MAX} tools`);
    for (const [tool, hash] of Object.entries(tools)) {
      if (typeof hash !== "string" || !TOOL_HASH.test(hash)) out.push(`the hash of tool ${JSON.stringify(tool)} is not a SHA-256 in lowercase hex`);
    }
  }

  // The extensions: under the publisher's namespace, each key's schema a scalar.
  const extActions = new Map<string, string>();
  const extKeys = new Map<string, string>();
  const extensions = m.extensions ?? [];
  if (!Array.isArray(extensions)) out.push("extensions is not a list");
  else {
    for (const e of extensions) {
      if (!isObject(e) || typeof e.capability !== "string") {
        out.push("an extension has no capability");
        continue;
      }
      const cap = e.capability;
      const under = (what: string, v: string) => {
        if (!ns || !v.startsWith(`${ns}.`) || !NAME.test(v)) out.push(`${what} ${JSON.stringify(v)} is not under the publisher's namespace ${ns || "(none)"}`);
      };
      under("extension capability", cap);
      described(`extension ${cap}`, e.description);
      for (const a of Array.isArray(e.actions) ? e.actions : [null]) {
        if (!isObject(a) || typeof a.action !== "string" || !isObject(a.schema)) {
          out.push(`an action of extension ${cap} has no action name or schema`);
          continue;
        }
        // An extension's action is written as a standard one is, `<capability>.<action>`: `org.example.steam.launch`.
        if (!a.action.startsWith(`${cap}.`) || !/^[a-z_]+$/.test(a.action.slice(cap.length + 1))) {
          out.push(`extension action ${JSON.stringify(a.action)} is not ${cap}.<action>`);
        }
        described(`extension action ${a.action}`, a.description);
        extActions.set(a.action, cap);
      }
      for (const k of Array.isArray(e.keys) ? e.keys : [null]) {
        if (!isObject(k) || typeof k.key !== "string") {
          out.push(`a key of extension ${cap} has no name`);
          continue;
        }
        under("extension key", k.key);
        described(`extension key ${k.key}`, k.description);
        const type = isObject(k.schema) ? k.schema.type : undefined;
        if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
          out.push(`extension key ${k.key}'s schema is not a scalar (a string, a number or a boolean)`);
        }
        extKeys.set(k.key, cap);
      }
    }
  }

  // The devices.
  if (!Array.isArray(m.devices) || m.devices.length === 0) out.push("devices is not a list of at least one device");
  else {
    const keys = new Set<string>();
    for (const d of m.devices) {
      if (!isObject(d)) {
        out.push("a device is not an object");
        continue;
      }
      const where = `device ${JSON.stringify(d.key)}`;
      if (name("key", d.key, KEY_MAX)) {
        if (keys.has(d.key)) out.push(`${where} is declared twice`);
        keys.add(d.key);
      }
      if (d.proposedClass !== null && (typeof d.proposedClass !== "string" || validate("common.json#/$defs/deviceClass", d.proposedClass).length)) {
        out.push(`${where}'s proposedClass is neither a class of the applier's list nor null`);
      }
      const caps = isStrings(d.capabilities) ? d.capabilities : (out.push(`${where}'s capabilities is not a list of names`), []);
      if (!Array.isArray(d.sensorKeys) || !d.sensorKeys.every((k) => typeof k === "string")) out.push(`${where}'s sensorKeys is not a list of keys`);
      for (const f of ["personal", "selfChanging"] as const) {
        if (d[f] !== undefined && (!Array.isArray(d[f]) || !(d[f] as unknown[]).every((k) => typeof k === "string"))) out.push(`${where}'s ${f} is not a list of keys`);
      }
      if (!Number.isInteger(d.cadenceMs) || (d.cadenceMs as number) < 1 || (d.cadenceMs as number) > CADENCE_MAX_MS) {
        out.push(`${where}'s cadenceMs is not a whole number from 1 to ${CADENCE_MAX_MS}`);
      }
      if (typeof d.stateUri !== "string" || !d.stateUri) out.push(`${where} has no stateUri`);
      if (!Array.isArray(d.actions)) {
        out.push(`${where}'s actions is not a list`);
        continue;
      }
      for (const a of d.actions) {
        if (!isObject(a) || typeof a.action !== "string") {
          out.push(`an action of ${where} has no name`);
          continue;
        }
        const act = `${where}'s action ${a.action}`;
        const ext = extActions.get(a.action);
        if (ext !== undefined) {
          if (!caps.includes(ext)) out.push(`${act} is of extension ${ext}, which the device does not list`);
        } else if (!STANDARD_ACTION.test(a.action)) {
          out.push(`${act} is neither capability.action nor an action of the manifest's extensions`);
        } else if (!caps.includes(a.action.split(".")[0]!)) {
          out.push(`${act} is of a capability the device does not list`);
        }
        for (const f of ["idempotent", "stateless", "confirms"] as const) if (typeof a[f] !== "boolean") out.push(`${act} has no boolean ${f}`);
        if (a.args !== undefined && !isObject(a.args)) out.push(`${act}'s args is not an object`);
        if (a.requestedTier !== undefined && validate("common.json#/$defs/tier", a.requestedTier).length) out.push(`${act}'s requestedTier is not a tier`);
        if (typeof a.tool !== "string" || !a.tool) out.push(`${act} names no tool`);
        else if (tools && !Object.hasOwn(tools, a.tool)) out.push(`${act}'s tool ${a.tool} has no toolHashes entry`);
        // A stateful extension action says what confirms it; a standard one has its capability's key (the mpv plugin's media.*).
        if (a.confirmedBy === undefined) {
          if (ext !== undefined && a.stateless === false) out.push(`${act} is a stateful extension action with no confirmedBy`);
        } else if (!isObject(a.confirmedBy) || typeof a.confirmedBy.key !== "string" || !("value" in a.confirmedBy)) {
          out.push(`${act}'s confirmedBy is not { key, value }`);
        } else {
          const v = a.confirmedBy.value;
          const arg = isObject(v) ? v.arg : undefined;
          if (isObject(v) && (typeof arg !== "string" || !isObject(a.args) || !Object.hasOwn(a.args, arg))) {
            out.push(`${act}'s confirmedBy names no argument of the action`);
          } else if (!isObject(v) && !["string", "number", "boolean"].includes(typeof v)) {
            out.push(`${act}'s confirmedBy value is neither a scalar nor { arg }`);
          }
          if (ext !== undefined && !extKeys.has(a.confirmedBy.key)) out.push(`${act}'s confirmedBy key ${a.confirmedBy.key} is no key of the extensions`);
        }
      }
    }
  }

  // The command: an interpreter by name or a file of the package first, and any other file it names inside the package.
  if (!isStrings(m.command) || m.command.length === 0) out.push("command is not a list of at least one non-empty string");
  else {
    const [first, ...rest] = m.command;
    if (first!.includes("/")) {
      const p = packagePath(first!);
      if (p === null || !files.has(p)) out.push(`command's first element ${JSON.stringify(first)} is not a file of the package`);
    } else if (!INTERPRETER.test(first!) || first === "." || first === "..") {
      out.push(`command's first element ${JSON.stringify(first)} is not an interpreter's name`);
    }
    for (const el of rest) {
      if (!el.includes("/") && !SCRIPT.test(el)) continue;
      const p = packagePath(el);
      if (p === null || !files.has(p)) out.push(`command names ${JSON.stringify(el)}, which is not a file of the package`);
    }
  }
  if (!isStrings(m.hosts)) out.push("hosts is not a list of hosts");
  if (m.needsSession !== undefined && typeof m.needsSession !== "boolean") out.push("needsSession is not a boolean");
  if (m.otherAdmins !== undefined && (!Array.isArray(m.otherAdmins)
    || !m.otherAdmins.every((a) => isObject(a) && typeof a.vendor === "string" && a.vendor && typeof a.label === "string" && a.label))) {
    out.push("otherAdmins is not a list of { vendor, label }");
  }
  return out;
}
