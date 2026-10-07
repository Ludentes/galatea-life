import { readFileSync } from "node:fs";
import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/plugins/manifest.js";
import {
  accountFaults, pluginAdmins, pluginDevices, pluginEntry, pluginRoster, pluginStatus, sessionAccounts,
} from "../src/plugins/devices.js";
import type { InstalledVersion, PluginsState } from "../src/plugins/record.js";
import { hashOf, manifest } from "./manifests.js";

const AT = "2026-09-30T10:00:00.000Z";
const COMPUTER = { id: "computer", stableIdentifier: "0123456789abcdef0123456789abcdef", transport: "host" };
const ADMINS = [{ vendor: "os", label: "root" }, { vendor: "os", label: "unknown" }];
const held = (t: string) => t !== "gone";

function version(m: Manifest, over: Partial<InstalledVersion> = {}): InstalledVersion {
  return { sha256: hashOf("p"), manifest: m, account: "liza", interpreter: "/usr/bin/python3", files: {}, activated: false, installedAt: AT, ...over };
}

function state(versions: Record<string, InstalledVersion>, pending?: string): PluginsState {
  return { installed: { "org.example.kodi": { versions, ...(pending ? { pending } : {}) } }, requests: [] };
}

const mpv = JSON.parse(readFileSync(new URL("./fixtures/mpv-manifest.json", import.meta.url), "utf8")) as Manifest;

describe("pluginEntry", () => {
  it("declares a plugin device as *Plugin devices* fixes it, and it validates against devices.json", () => {
    const [player, library] = [...pluginDevices(state({ "1.0.0": version(manifest()) }))].sort((a) => (a.key === "player" ? -1 : 1));
    const entry = pluginEntry(player!, COMPUTER, pluginAdmins(ADMINS, player!.installed, held));
    expect(entry).toEqual({
      id: "org.example.kodi:1.0.0:player",
      stableIdentifier: "0123456789abcdef0123456789abcdef/org.example.kodi/player",
      transport: "host", host: "computer", plugin: "org.example.kodi", version: "1.0.0",
      model: { vendor: "org.example.kodi", model: "player" },
      capabilities: ["media"], sensorKeys: [],
      actions: [
        { action: "media.pause", idempotent: true, stateless: false, confirms: true, requestedTier: "reversible", toolHash: hashOf("pause") },
        { action: "media.set_volume", args: { volume: { min: 0, max: 100 } }, idempotent: true, stateless: false, confirms: true,
          requestedTier: "reversible", toolHash: hashOf("set_volume") },
      ],
      feedback: "closed", reachMs: 0, proposedClass: "player", classEvidence: "none",
      otherAdmins: [...ADMINS, { vendor: "os", label: "liza" }, { vendor: "kodi", label: "web interface" }],
      personal: ["title"],
      selfChanging: ["playing", "volume", "title", "started_at"],
      extensions: [],
    });
    const lib = pluginEntry(library!, COMPUTER, []);
    expect(lib.extensions).toEqual(manifest().extensions);
    expect(lib.actions).toEqual([{ action: "org.example.library.scan", args: { path: "any" }, idempotent: false, stateless: false, confirms: true,
      confirmedBy: { key: "org.example.library.scanning", value: true }, requestedTier: "confirm", toolHash: hashOf("scan") }]);
    expect(validate("bridge/devices.json", { devices: [entry] })).toEqual([]);
  });

  it("declares the mpv plugin's player, its standard's player keys selfChanging", () => {
    const [player] = pluginDevices({ installed: { "org.galatea.mpv": { versions: { "0.1.0": version(mpv) } } }, requests: [] });
    const entry = pluginEntry(player!, COMPUTER, []);
    expect(entry.id).toBe("org.galatea.mpv:0.1.0:player");
    expect(entry.selfChanging).toEqual(["playing", "volume", "title", "started_at"]);
    expect(entry.personal).toEqual([]);
    expect(validate("bridge/devices.json", { devices: [entry] })).toEqual([]);
  });

  it("marks personal the sensor keys the applier's standard declares so, whatever the manifest says", () => {
    const m = manifest();
    m.devices[0] = { ...m.devices[0]!, capabilities: ["media", "sensor"], sensorKeys: ["camera_in_use", "temperature"], personal: [] };
    const [player] = pluginDevices(state({ "1.0.0": version(m) })).filter((d) => d.key === "player");
    expect(pluginEntry(player!, COMPUTER, []).personal).toEqual(["camera_in_use"]);
  });
});

describe("pluginDevices", () => {
  it("stages every device of a version beside the current one whose key the current one has, naming the device it would replace", () => {
    const next = manifest({ version: "1.1.0" });
    next.devices = [next.devices[0]!, { ...next.devices[1]!, key: "queue" }];
    const devices = pluginDevices(state({ "1.0.0": version(manifest(), { activated: true }), "1.1.0": version(next) }));
    expect(devices.map((d) => [d.id, d.stagedFor])).toEqual([
      ["org.example.kodi:1.0.0:library", undefined],
      ["org.example.kodi:1.0.0:player", undefined],
      ["org.example.kodi:1.1.0:player", "org.example.kodi:1.0.0:player"],
      ["org.example.kodi:1.1.0:queue", undefined],
    ]);
    // Staging is not an admission: both carry the same stableIdentifier.
    const entries = devices.map((d) => pluginEntry(d, COMPUTER, []));
    expect(entries[1]!.stableIdentifier).toBe(entries[2]!.stableIdentifier);
    expect(entries[2]!.stagedFor).toBe("org.example.kodi:1.0.0:player");
    expect(validate("bridge/devices.json", { devices: entries })).toEqual([]);
  });

  it("keeps a pending version staged: the old one stays current until the swap", () => {
    const devices = pluginDevices(state({ "1.0.0": version(manifest(), { activated: true }), "1.1.0": version(manifest({ version: "1.1.0" })) }, "1.1.0"));
    expect(devices.filter((d) => d.stagedFor).map((d) => d.version)).toEqual(["1.1.0", "1.1.0"]);
  });

  it("keeps stagedFor on the new version's devices after a swap, naming those it replaced, a new key none", () => {
    const next = manifest({ version: "1.1.0", devices: [manifest().devices[0], { ...manifest().devices[1], key: "queue" }] });
    const s = state({ "1.1.0": version(next, { activated: true }) });
    s.installed["org.example.kodi"]!.replaced = { version: "1.0.0", keys: ["player", "library"] };
    expect(pluginDevices(s).map((d) => [d.id, d.stagedFor])).toEqual([
      ["org.example.kodi:1.1.0:player", "org.example.kodi:1.0.0:player"], ["org.example.kodi:1.1.0:queue", undefined]]);
  });
});

describe("otherAdmins", () => {
  it("adds the plugin's account unless an administrator already, and never a retired one", () => {
    const v = version(manifest({ otherAdmins: undefined }));
    expect(pluginAdmins([{ vendor: "os", label: "liza" }, { vendor: "os", label: "root" }], v, held))
      .toEqual([{ vendor: "os", label: "liza" }, { vendor: "os", label: "root" }]);
    expect(pluginAdmins(ADMINS, version(manifest({ otherAdmins: undefined }), { account: "gone" }), held)).toEqual(ADMINS);
  });

  it("gives the computer the accounts of needsSession plugins, held ones only, once each", () => {
    const s: PluginsState = { installed: {
      "org.galatea.mpv": { versions: { "0.1.0": version(mpv, { account: "olga" }) } },
      "org.example.kodi": { versions: { "1.0.0": version(manifest({ needsSession: true })), "1.1.0": version(manifest({ version: "1.1.0" }), { account: "ivan" }) } },
      "org.example.game": { versions: { "1.0.0": version(manifest({ id: "org.example.game", needsSession: true }), { account: "gone" }) } },
    }, requests: [] };
    expect(sessionAccounts(s, held)).toEqual(["liza", "olga"]);
  });
});

describe("the roster, the status and the faults", () => {
  const [player] = pluginDevices(state({ "1.0.0": version(manifest()) })).filter((d) => d.key === "player");

  it("gives a roster entry with its last check-in and whether it is observable, since when", () => {
    const at = Date.parse("2026-09-30T10:05:00.123Z");
    expect(pluginRoster(player!, "host", { lastCheckIn: at, observable: true, since: at })).toMatchObject({
      timestamp: "2026-09-30T10:05:00.123Z", lastCheckIn: "2026-09-30T10:05:00.123Z", observable: true, since: "2026-09-30T10:05:00.123Z" });
  });

  it("gives a status available with its readings at the read's time, unavailable since its failure, the install's while not run", () => {
    const at = Date.parse("2026-09-30T10:05:00.123Z");
    const up = pluginStatus(player!, { available: true, at, checkIn: at, values: { playing: true, volume: 3 }, seq: 0 });
    expect(up).toEqual({ deviceId: player!.id, timestamp: "2026-09-30T10:05:00.123Z", available: true, playing: true, volume: 3 });
    expect(validate("bridge/device-status.json", up)).toEqual([]);
    expect(pluginStatus(player!, { available: false, at })).toEqual({ deviceId: player!.id, timestamp: "2026-09-30T10:05:00.123Z", available: false });
  });

  it("gives a roster entry polled at the manifest's cadence, bound three times it, never checked in", () => {
    const roster = pluginRoster(player!, "host", { lastCheckIn: null, observable: false, since: Date.parse(AT) });
    expect(roster).toEqual({ id: "org.example.kodi:1.0.0:player", transport: "host", basis: "poll", cadenceMs: 5000, basisMaxAgeMs: 15000,
      timestamp: null, lastCheckIn: null, observable: false, since: AT });
    expect(validate("bridge/status.json", { bridgeId: "b", instanceId: "7d8f2c1e-5b3a-4c9d-8e7f-6a5b4c3d2e1f", v: 1, state: "online", version: "0",
      levels: ["Serve", "Host"], faults: [], ungoverned: [], blocked: [], transports: [], devices: [roster], publishedAt: AT })).toEqual([]);
  });

  it("gives a retained status available: false, stamped with the install", () => {
    const s = pluginStatus(player!, undefined);
    expect(s).toEqual({ deviceId: "org.example.kodi:1.0.0:player", timestamp: AT, available: false });
    expect(validate("bridge/device-status.json", s)).toEqual([]);
  });

  it("names account_deleted once per device of a version whose account was deleted", () => {
    const devices = pluginDevices(state({ "1.0.0": version(manifest(), { account: "gone" }), "1.1.0": version(manifest({ version: "1.1.0" })) }));
    expect(accountFaults(devices, (t) => t === "gone")).toEqual([
      { code: "account_deleted", device: "org.example.kodi:1.0.0:library", detail: "gone's account was deleted" },
      { code: "account_deleted", device: "org.example.kodi:1.0.0:player", detail: "gone's account was deleted" },
    ]);
  });
});
