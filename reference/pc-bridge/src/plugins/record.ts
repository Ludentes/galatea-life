import type { Manifest } from "./manifest.js";

/**
 * What the bridge keeps of one installed version (GA-BRIDGE-31, GA-BRIDGE-57): the package's
 * `sha256`, the manifest as installed, the account's token, the interpreter's absolute path (null
 * where `command` starts with a file of the package), each file's SHA-256, whether it is activated,
 * when it was installed, in wire time, the MCP revision its server spoke at its last start, once
 * it has started (a 2025 one is not probed again), and a mismatch of its files or tools with when it
 * was found, kept until a reinstall that verifies (GA-BRIDGE-45, GA-BRIDGE-57).
 */
export interface InstalledVersion {
  sha256: string;
  manifest: Manifest;
  account: string;
  interpreter: string | null;
  files: Record<string, string>;
  activated: boolean;
  installedAt: string;
  era?: string;
  mismatch?: { detail: string; at: string };
}

/**
 * Every installed version of one plugin; the version whose activation waits for its swap; and the
 * version the last swap removed, with its device keys: the current version's devices of those keys
 * keep `stagedFor` naming the devices they replaced (GA-BRIDGE-69).
 */
export interface InstalledPlugin {
  versions: Record<string, InstalledVersion>;
  pending?: string;
  replaced?: { version: string; keys: string[] };
}

/** How a request ended: its terminal event, kept until it has gone out. */
export type Outcome =
  | { type: "installed"; manifest: Manifest }
  | { type: "install_failed"; reason: string; detail?: string }
  | { type: "uninstalled"; plugin: string };

/**
 * An `install` or `uninstall` the bridge answered `accepted` (GA-BRIDGE-31, GA-BRIDGE-68), kept
 * from before its reply until its terminal event has gone out: `acceptedAt` in wire time, the
 * request's own fields, and `ended` once it has ended.
 */
export interface InFlight {
  requestId: string;
  op: "install" | "uninstall";
  acceptedAt: string;
  package?: { url: string; sha256: string };
  account?: string;
  plugin?: string;
  ended?: Outcome;
}

/**
 * The plugin host's part of the state file: kept beside the token table, written with it. `clears`
 * holds the device ids whose retained statuses must still be cleared, until the broker took each.
 */
export interface PluginsState {
  installed: Record<string, InstalledPlugin>;
  requests: InFlight[];
  clears?: string[];
}

export function emptyPlugins(): PluginsState {
  return { installed: {}, requests: [] };
}

/** A plugin device's id, `<plugin id>:<version>:<key>`, so that two versions never collide (GA-BRIDGE-69). */
export function deviceIdOf(plugin: string, version: string, key: string): string {
  return `${plugin}:${version}:${key}`;
}

/** Every device id of every installed version of a plugin: what an `uninstall` removes. */
export function deviceIdsOf(plugin: string, p: InstalledPlugin): string[] {
  return Object.entries(p.versions).flatMap(([version, v]) => v.manifest.devices.map((d) => deviceIdOf(plugin, version, d.key)));
}

const WIRE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The version whose devices the others are staged for: the activated one, the old one while a
 * pending activation waits included; else, with none activated, the one installed first (by
 * `installedAt`, then by version) other than a pending one, which a swap is to replace (the
 * maintainer's ruling M6).
 */
export function currentVersion(p: InstalledPlugin): string | undefined {
  const all = Object.entries(p.versions);
  const active = all.find(([v, x]) => x.activated && v !== p.pending);
  if (active) return active[0];
  const others = all.filter(([v]) => v !== p.pending);
  return (others.length ? others : all).sort(([va, a], [vb, b]) => (a.installedAt < b.installedAt ? -1 : a.installedAt > b.installedAt ? 1 : va < vb ? -1 : va > vb ? 1 : 0))[0]?.[0];
}

/** Throws with what is wrong when `value` is not a plugin record this bridge wrote. */
export function checkPlugins(value: unknown): PluginsState {
  if (!isObject(value) || !isObject(value.installed) || !Array.isArray(value.requests)) throw new Error("plugins is not a plugin record");
  for (const [id, p] of Object.entries(value.installed)) {
    if (!isObject(p) || !isObject(p.versions)) throw new Error(`plugins.installed.${id} has no versions`);
    for (const [version, v] of Object.entries(p.versions)) {
      const where = `plugins.installed.${id}.versions.${version}`;
      if (!isObject(v) || typeof v.sha256 !== "string" || !SHA256.test(v.sha256)) throw new Error(`${where} has no sha256`);
      if (!isObject(v.manifest) || v.manifest.id !== id || v.manifest.version !== version) throw new Error(`${where}'s manifest is not that version's`);
      if (typeof v.account !== "string" || !v.account) throw new Error(`${where} has no account`);
      if (v.interpreter !== null && (typeof v.interpreter !== "string" || !v.interpreter.startsWith("/"))) throw new Error(`${where}'s interpreter is not an absolute path`);
      if (!isObject(v.files) || !Object.values(v.files).every((h) => typeof h === "string" && SHA256.test(h))) throw new Error(`${where}'s files are not hashes`);
      if (typeof v.activated !== "boolean") throw new Error(`${where} has no activation`);
      if (typeof v.installedAt !== "string" || !WIRE_TIME.test(v.installedAt)) throw new Error(`${where}'s installedAt is not a time`);
      if (v.era !== undefined && (typeof v.era !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.era))) throw new Error(`${where}'s era is not an MCP revision`);
      if (v.mismatch !== undefined && (!isObject(v.mismatch) || typeof v.mismatch.detail !== "string" || typeof v.mismatch.at !== "string" || !WIRE_TIME.test(v.mismatch.at))) {
        throw new Error(`${where}'s mismatch is not { detail, at }`);
      }
    }
    if (p.pending !== undefined && (typeof p.pending !== "string" || !Object.hasOwn(p.versions, p.pending))) {
      throw new Error(`plugins.installed.${id}.pending names no installed version`);
    }
    const r = p.replaced;
    if (r !== undefined && (!isObject(r) || typeof r.version !== "string" || !Array.isArray(r.keys) || !r.keys.every((k) => typeof k === "string"))) {
      throw new Error(`plugins.installed.${id}.replaced is not { version, keys }`);
    }
  }
  if (value.clears !== undefined && (!Array.isArray(value.clears) || !value.clears.every((c) => typeof c === "string" && c.length > 0))) {
    throw new Error("plugins.clears is not a list of device ids");
  }
  const ids = new Set<string>();
  for (const r of value.requests) {
    if (!isObject(r) || typeof r.requestId !== "string" || (r.op !== "install" && r.op !== "uninstall")) throw new Error("plugins.requests holds a request of no kind");
    if (ids.has(r.requestId)) throw new Error(`plugins.requests holds ${r.requestId} twice`);
    ids.add(r.requestId);
    if (typeof r.acceptedAt !== "string" || !WIRE_TIME.test(r.acceptedAt)) throw new Error(`plugins.requests.${r.requestId} has no acceptedAt`);
    if (r.op === "install" && (!isObject(r.package) || typeof r.package.url !== "string" || typeof r.package.sha256 !== "string" || typeof r.account !== "string")) {
      throw new Error(`plugins.requests.${r.requestId} is an install with no package or account`);
    }
    if (r.op === "uninstall" && typeof r.plugin !== "string") throw new Error(`plugins.requests.${r.requestId} is an uninstall naming no plugin`);
    if (r.ended !== undefined && (!isObject(r.ended) || !["installed", "install_failed", "uninstalled"].includes(r.ended.type as string))) {
      throw new Error(`plugins.requests.${r.requestId} ended in no event`);
    }
  }
  return value as unknown as PluginsState;
}
