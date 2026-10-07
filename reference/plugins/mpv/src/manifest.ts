import { STATE_URI } from "./server.js";
import { TOOLS, toolHash } from "./tools.js";

export const PLUGIN_ID = "org.galatea.mpv";
export const PLUGIN_VERSION = "0.1.0";

export interface ManifestAction {
  action: string;
  tool: string;
  args?: Record<string, unknown>;
  idempotent: boolean;
  stateless: boolean;
  confirms: boolean;
  requestedTier: "reversible" | "confirm" | "no_voice";
}

export interface ManifestDevice {
  key: string;
  proposedClass: string | null;
  capabilities: string[];
  sensorKeys: string[];
  selfChanging: string[];
  personal: string[];
  cadenceMs: number;
  stateUri: string;
  actions: ManifestAction[];
}

export interface Manifest {
  id: string;
  version: string;
  command: string[];
  hosts: string[];
  needsSession: boolean;
  devices: ManifestDevice[];
  extensions: unknown[];
  toolHashes: Record<string, string>;
}

const standard = { stateless: false, confirms: true, requestedTier: "reversible" } as const;

export function buildManifest(): Manifest {
  return {
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    command: ["node", "server.js"],
    hosts: [],
    needsSession: true,
    devices: [{
      key: "player",
      proposedClass: "player",
      capabilities: ["media"],
      sensorKeys: [],
      selfChanging: ["playing", "volume", "title", "started_at"],
      personal: [],
      cadenceMs: 5000,
      stateUri: STATE_URI,
      actions: [
        { action: "media.launch", tool: "launch", args: { search: { title: "any", kind: ["movie", "episode"] } }, idempotent: false, ...standard },
        { action: "media.pause", tool: "pause", idempotent: true, ...standard },
        { action: "media.resume", tool: "resume", idempotent: true, ...standard },
        { action: "media.set_volume", tool: "set_volume", args: { volume: { min: 0, max: 100 } }, idempotent: true, ...standard },
      ],
    }],
    extensions: [],
    toolHashes: Object.fromEntries(TOOLS.map((t) => [t.name, toolHash(t)])),
  };
}

const NAME = /^[A-Za-z0-9._-]+$/;

/** What `install` would end `invalid_manifest` for, as far as this plugin's manifest can show it. */
export function checkManifest(m: Manifest, packageFiles: string[]): string[] {
  const problems: string[] = [];
  const name = (what: string, v: string, max: number) => {
    if (!NAME.test(v) || v.length > max) problems.push(`${what} "${v}" must be 1 to ${max} of [A-Za-z0-9._-]`);
  };
  name("id", m.id, 40);
  name("version", m.version, 32);
  for (const d of m.devices) {
    name("key", d.key, 40);
    if (!Number.isInteger(d.cadenceMs) || d.cadenceMs <= 0 || d.cadenceMs > 300_000) {
      problems.push(`cadenceMs of "${d.key}" must be a whole number from 1 to 300000`);
    }
    if (!d.stateUri) problems.push(`device "${d.key}" has no stateUri`);
    for (const a of d.actions) if (!m.toolHashes[a.tool]) problems.push(`tool "${a.tool}" has no toolHashes entry`);
  }
  const [interpreter, ...files] = m.command;
  if (!interpreter || interpreter.includes("/")) problems.push(`the interpreter "${interpreter ?? ""}" must be named, not a path`);
  for (const f of files) if (!packageFiles.includes(f)) problems.push(`"${f}" is not one of the package's files`);
  return problems;
}
