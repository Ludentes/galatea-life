import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPlugins, currentVersion, deviceIdOf, deviceIdsOf, emptyPlugins, type InstalledVersion, type PluginsState,
} from "../src/plugins/record.js";
import { StateStore } from "../src/state-store.js";
import { hashOf, manifest } from "./manifests.js";

const AT = "2026-09-30T10:00:00.000Z";

/** An installed version of the test plugin, as the host records one. */
function installed(over: Partial<InstalledVersion> & { version?: string } = {}): InstalledVersion {
  const { version = "1.0.0", ...rest } = over;
  return { sha256: hashOf("package"), manifest: manifest({ version }), account: "liza", interpreter: "/usr/bin/python3",
    files: { "manifest.json": hashOf("m"), "server.py": hashOf("s") }, activated: false, installedAt: AT, ...rest };
}

function record(): PluginsState {
  return {
    installed: { "org.example.kodi": { versions: { "1.0.0": installed({ activated: true }), "1.1.0": installed({ version: "1.1.0" }) }, pending: "1.1.0" } },
    requests: [
      { requestId: "i1", op: "install", acceptedAt: AT, package: { url: "https://example.org/p.tar.gz", sha256: hashOf("p") }, account: "liza" },
      { requestId: "u1", op: "uninstall", acceptedAt: AT, plugin: "org.example.mpv", ended: { type: "uninstalled", plugin: "org.example.mpv" } },
    ],
  };
}

describe("checkPlugins", () => {
  it("takes a record it wrote: versions, a pending activation, and requests in flight, one ended", () => {
    expect(checkPlugins(record())).toEqual(record());
    expect(checkPlugins(emptyPlugins())).toEqual({ installed: {}, requests: [] });
  });

  it("takes a version's era and kept mismatch, and the version a swap replaced", () => {
    const r = record();
    const p = r.installed["org.example.kodi"]!;
    p.versions["1.0.0"]!.era = "2026-07-28";
    p.versions["1.1.0"]!.mismatch = { detail: "its tools do not verify: tool shell is not in the manifest", at: AT };
    p.replaced = { version: "0.9.0", keys: ["player"] };
    expect(checkPlugins(structuredClone(r))).toEqual(r);
  });

  it.each([
    ["no requests", (r: any) => { delete r.requests; }, "not a plugin record"],
    ["a version with no sha256", (r: any) => { r.installed["org.example.kodi"].versions["1.0.0"].sha256 = "abc"; }, "no sha256"],
    ["a manifest of another version", (r: any) => { r.installed["org.example.kodi"].versions["1.1.0"].manifest.version = "1.0.0"; }, "not that version's"],
    ["a relative interpreter", (r: any) => { r.installed["org.example.kodi"].versions["1.0.0"].interpreter = "python3"; }, "not an absolute path"],
    ["a file with no hash", (r: any) => { r.installed["org.example.kodi"].versions["1.0.0"].files["server.py"] = 7; }, "files are not hashes"],
    ["no activation", (r: any) => { delete r.installed["org.example.kodi"].versions["1.0.0"].activated; }, "no activation"],
    ["a pending version not installed", (r: any) => { r.installed["org.example.kodi"].pending = "2.0.0"; }, "names no installed version"],
    ["a request twice", (r: any) => { r.requests[1].requestId = "i1"; }, "twice"],
    ["an install with no account", (r: any) => { delete r.requests[0].account; }, "no package or account"],
    ["an uninstall naming no plugin", (r: any) => { delete r.requests[1].plugin; }, "naming no plugin"],
    ["an acceptedAt that is no wire time", (r: any) => { r.requests[0].acceptedAt = "yesterday"; }, "no acceptedAt"],
    ["an end that is no event", (r: any) => { r.requests[1].ended = { type: "done" }; }, "ended in no event"],
    ["an era that is no revision", (r: any) => { r.installed["org.example.kodi"].versions["1.0.0"].era = "latest"; }, "not an MCP revision"],
    ["a mismatch with no time", (r: any) => { r.installed["org.example.kodi"].versions["1.0.0"].mismatch = { detail: "x" }; }, "not { detail, at }"],
    ["a replaced version with no keys", (r: any) => { r.installed["org.example.kodi"].replaced = { version: "0.9.0" }; }, "not { version, keys }"],
  ])("refuses %s", (_what, edit, message) => {
    const r = record();
    edit(r);
    expect(() => checkPlugins(r)).toThrow(message);
  });
});

describe("device ids", () => {
  it("names a plugin device <plugin id>:<version>:<key>, and every one of every version of a plugin", () => {
    expect(deviceIdOf("org.example.kodi", "1.0.0", "player")).toBe("org.example.kodi:1.0.0:player");
    expect(deviceIdsOf("org.example.kodi", record().installed["org.example.kodi"]!)).toEqual([
      "org.example.kodi:1.0.0:player", "org.example.kodi:1.0.0:library", "org.example.kodi:1.1.0:player", "org.example.kodi:1.1.0:library",
    ]);
  });
});

describe("currentVersion", () => {
  it("is the activated version, the old one while a pending activation waits", () => {
    expect(currentVersion(record().installed["org.example.kodi"]!)).toBe("1.0.0");
    const p = record().installed["org.example.kodi"]!;
    p.versions["1.0.0"]!.activated = false;
    p.versions["1.1.0"]!.activated = true;
    delete p.pending;
    expect(currentVersion(p)).toBe("1.1.0");
  });

  it("with none activated, is the version installed first", () => {
    const later = "2026-09-30T11:00:00.000Z";
    expect(currentVersion({ versions: { "2.0.0": installed({ version: "2.0.0" }), "1.9.0": installed({ version: "1.9.0", installedAt: later }) } }))
      .toBe("2.0.0");
    expect(currentVersion({ versions: {} })).toBeUndefined();
  });

  it("with none activated, is never the pending version, which a swap is to replace it with (M6)", () => {
    const later = "2026-09-30T11:00:00.000Z";
    const p = { versions: { "1.0.0": installed({ installedAt: later }), "1.1.0": installed({ version: "1.1.0" }) }, pending: "1.1.0" };
    expect(currentVersion(p)).toBe("1.0.0");
  });
});

describe("the plugin record in the state file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-bridge-record-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is kept across a load, beside the token table", async () => {
    const s = StateStore.load(dir);
    s.state.plugins = record();
    await s.save();
    expect(StateStore.load(dir).state.plugins).toEqual(record());
  });

  it("is absent from a file plan 3b's bridge wrote, and refused when it is not a record this bridge wrote", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: {}, tokens: { accounts: {}, given: [] } }));
    expect(StateStore.load(dir).state.plugins).toBeUndefined();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: {}, plugins: { installed: {} } }));
    expect(() => StateStore.load(dir)).toThrow(/not a plugin record/);
  });
});
