import { createHash } from "node:crypto";
import type { Manifest } from "../src/plugins/manifest.js";

/** A tool's hash as a test writes it: any lowercase hex SHA-256 will do, since 3c calls no tool. */
export const hashOf = (tool: string) => createHash("sha256").update(tool).digest("hex");

/**
 * A manifest the bridge installs: `org.example.kodi` 1.0.0, started as `python3 server.py`, with a
 * `player` (media) and a `library` whose extension, under the publisher's namespace `org.example`,
 * has a stateful action and a boolean key. `over` replaces top-level fields.
 */
export function manifest(over: Record<string, unknown> = {}): Manifest {
  return {
    id: "org.example.kodi",
    version: "1.0.0",
    command: ["python3", "server.py"],
    hosts: ["127.0.0.1"],
    devices: [
      {
        key: "player",
        proposedClass: "player",
        capabilities: ["media"],
        sensorKeys: [],
        selfChanging: ["playing", "volume"],
        personal: ["title"],
        cadenceMs: 5000,
        stateUri: "kodi://player/state",
        actions: [
          { action: "media.pause", tool: "pause", idempotent: true, stateless: false, confirms: true, requestedTier: "reversible" },
          { action: "media.set_volume", tool: "set_volume", args: { volume: { min: 0, max: 100 } }, idempotent: true, stateless: false,
            confirms: true, requestedTier: "reversible" },
        ],
      },
      {
        key: "library",
        proposedClass: null,
        capabilities: ["org.example.library"],
        sensorKeys: [],
        cadenceMs: 60_000,
        stateUri: "kodi://library/state",
        actions: [
          { action: "org.example.library.scan", tool: "scan", args: { path: "any" }, idempotent: false, stateless: false, confirms: true,
            confirmedBy: { key: "org.example.library.scanning", value: true }, requestedTier: "confirm" },
        ],
      },
    ],
    extensions: [{
      capability: "org.example.library",
      description: "Kodi's media library.",
      actions: [{ action: "org.example.library.scan", description: "Scans the library for new files.", schema: { type: "object" } }],
      keys: [{ key: "org.example.library.scanning", description: "Whether a scan runs.", schema: { type: "boolean" } }],
    }],
    toolHashes: { pause: hashOf("pause"), set_volume: hashOf("set_volume"), scan: hashOf("scan") },
    otherAdmins: [{ vendor: "kodi", label: "web interface" }],
    ...over,
  } as Manifest;
}

/** The package files a manifest from `manifest()` names. */
export const FILES = new Set(["manifest.json", "server.py", "lib/kodi.py"]);

/** The manifest as a package holds it. */
export const text = (m: unknown) => Buffer.from(JSON.stringify(m));
