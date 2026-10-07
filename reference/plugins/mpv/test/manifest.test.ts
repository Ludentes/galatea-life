import { describe, expect, it } from "vitest";
import { buildManifest, checkManifest, PLUGIN_ID, PLUGIN_VERSION, type Manifest } from "../src/manifest.js";
import { TOOLS, toolHash } from "../src/tools.js";

const FILES = ["manifest.json", "package.json", "server.js"];
const edit = (f: (m: Manifest) => void): Manifest => {
  const m = structuredClone(buildManifest());
  f(m);
  return m;
};

describe("the manifest", () => {
  it("is the plugin's, and valid", () => {
    const m = buildManifest();
    expect(m.id).toBe(PLUGIN_ID);
    expect(m.version).toBe(PLUGIN_VERSION);
    expect(m.command).toEqual(["node", "server.js"]);
    expect(checkManifest(m, FILES)).toEqual([]);
  });

  it("maps each media action to its tool, and hashes every tool", () => {
    const m = buildManifest();
    expect(m.devices[0]!.actions.map((a) => [a.action, a.tool])).toEqual([
      ["media.launch", "launch"], ["media.pause", "pause"], ["media.resume", "resume"], ["media.set_volume", "set_volume"],
    ]);
    for (const t of TOOLS) expect(m.toolHashes[t.name]).toBe(toolHash(t));
  });

  it("declares launch not idempotent, and every action confirmed", () => {
    const actions = buildManifest().devices[0]!.actions;
    expect(actions.find((a) => a.action === "media.launch")!.idempotent).toBe(false);
    expect(actions.every((a) => a.confirms)).toBe(true);
  });

  it.each([
    ["an id with a slash", (m: Manifest) => { m.id = "org/galatea"; }, /id/],
    ["an id over 40", (m: Manifest) => { m.id = "a".repeat(41); }, /id/],
    ["a version over 32", (m: Manifest) => { m.version = "1".repeat(33); }, /version/],
    ["a key with a space", (m: Manifest) => { m.devices[0]!.key = "the player"; }, /key/],
    ["a cadence over 300 000", (m: Manifest) => { m.devices[0]!.cadenceMs = 300_001; }, /cadenceMs/],
    ["an action with no hash", (m: Manifest) => { delete m.toolHashes.pause; }, /pause/],
    ["an interpreter by path", (m: Manifest) => { m.command[0] = "/usr/bin/node"; }, /interpreter/],
    ["a file outside the package", (m: Manifest) => { m.command[1] = "../x.js"; }, /package/],
    ["a device without stateUri", (m: Manifest) => { delete (m.devices[0] as Partial<Manifest["devices"][0]>).stateUri; }, /stateUri/],
  ])("finds %s", (_name, f, re) => {
    const problems = checkManifest(edit(f), FILES);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(re);
  });
});
