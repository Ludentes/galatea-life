import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkManifest, type Checked, type Manifest, MANIFEST_MAX_BYTES, namespaceOf, packagePath } from "../src/plugins/manifest.js";
import { FILES, hashOf, manifest, text } from "./manifests.js";

const problems = (c: Checked) => (c.ok ? [] : c.problems);
/** A manifest changed by `edit`, checked against the files a test package holds. */
const refused = (edit: (m: any) => void, files: ReadonlySet<string> = FILES) => {
  const m = manifest() as any;
  edit(m);
  return problems(checkManifest(text(m), files));
};

describe("checkManifest", () => {
  it("accepts the mpv plugin's manifest as its packaging writes it, media.* confirming by their capability's keys", () => {
    const mpv = readFileSync(new URL("./fixtures/mpv-manifest.json", import.meta.url));
    const c = checkManifest(mpv, new Set(["manifest.json", "package.json", "server.js"]));
    expect(problems(c)).toEqual([]);
    expect(c.ok && c.manifest.id).toBe("org.galatea.mpv");
  });

  it("accepts a manifest with an extension, a stateful extension action confirmed by its key, and the app's own otherAdmins", () => {
    const c = checkManifest(text(manifest()), FILES);
    expect(problems(c)).toEqual([]);
    expect(c.ok && c.manifest).toEqual(manifest());
  });

  it("accepts a version, an id's label and a key that start with a dot, as the standard's charset allows", () => {
    expect(refused((m) => {
      m.version = ".1";
      m.devices[0].key = ".player";
    })).toEqual([]);
  });

  it("accepts an id and a key of 40 characters, a version of 32, and a cadence of 300 000", () => {
    expect(refused((m) => {
      m.id = `org.example.${"k".repeat(28)}`;
      m.version = "1".repeat(32);
      m.devices[0].key = "p".repeat(40);
      m.devices[0].cadenceMs = 300_000;
    })).toEqual([]);
  });

  it.each([
    ["an id of 41 characters", (m: any) => { m.id = `org.example.${"k".repeat(29)}`; }, "id"],
    ["an id holding a space", (m: any) => { m.id = "org.example.my kodi"; }, "id"],
    ["an id holding a colon", (m: any) => { m.id = "org.example:kodi"; }, "id"],
    ["an id that is not reverse-DNS", (m: any) => { m.id = "kodi"; }, "not reverse-DNS"],
    ["an id with an empty label", (m: any) => { m.id = "org..kodi"; }, "not reverse-DNS"],
    ["a version of 33 characters", (m: any) => { m.version = "1".repeat(33); }, "version"],
    ["a version holding a slash", (m: any) => { m.version = "1.0/2"; }, "version"],
    ["a version of .", (m: any) => { m.version = "."; }, "version \".\" names no directory"],
    ["a version of ..", (m: any) => { m.version = ".."; }, "version \"..\" names no directory"],
    ["an id of .", (m: any) => { m.id = "."; }, "id \".\" names no directory"],
    ["an id of ..", (m: any) => { m.id = ".."; }, "id \"..\" names no directory"],
    ["a key of .", (m: any) => { m.devices[0].key = "."; }, "key \".\" names no directory"],
    ["a key of ..", (m: any) => { m.devices[0].key = ".."; }, "key \"..\" names no directory"],
    ["a key holding a colon", (m: any) => { m.devices[0].key = "player:1"; }, "key"],
    ["a key holding a space", (m: any) => { m.devices[0].key = "the player"; }, "key"],
    ["a key of 41 characters", (m: any) => { m.devices[0].key = "p".repeat(41); }, "key"],
    ["a key declared twice", (m: any) => { m.devices[1].key = "player"; }, "declared twice"],
    ["a cadence above 300 000", (m: any) => { m.devices[0].cadenceMs = 300_001; }, "cadenceMs"],
    ["a cadence of an hour", (m: any) => { m.devices[0].cadenceMs = 3_600_000; }, "cadenceMs"],
    ["a cadence of 0", (m: any) => { m.devices[0].cadenceMs = 0; }, "cadenceMs"],
    ["a cadence that is not whole", (m: any) => { m.devices[0].cadenceMs = 1500.5; }, "cadenceMs"],
    ["an extension key with an object schema", (m: any) => { m.extensions[0].keys[0].schema = { type: "object" }; }, "not a scalar"],
    ["an extension key with a schema of no type", (m: any) => { m.extensions[0].keys[0].schema = { enum: [1, 2] }; }, "not a scalar"],
    ["an extension outside the publisher's namespace", (m: any) => { m.extensions[0].capability = "com.other.library"; }, "namespace"],
    ["an extension key outside it", (m: any) => { m.extensions[0].keys[0].key = "scanning"; }, "namespace"],
    ["an extension action outside it", (m: any) => { m.extensions[0].actions[0].action = "net.other.scan"; }, "is not org.example.library.<action>"],
    ["an extension action not of its capability", (m: any) => { m.extensions[0].actions[0].action = "org.example.scan"; }, "is not org.example.library.<action>"],
    ["an extension with no description", (m: any) => { delete m.extensions[0].description; }, "no description"],
    ["a description over 2 KiB", (m: any) => { m.extensions[0].keys[0].description = "я".repeat(1025); }, "over 2048 bytes"],
    ["a tool hash in uppercase", (m: any) => { m.toolHashes.pause = hashOf("pause").toUpperCase(); }, "lowercase hex"],
    ["a tool hash that is no SHA-256", (m: any) => { m.toolHashes.pause = "abc"; }, "lowercase hex"],
    ["an action whose tool has no hash", (m: any) => { delete m.toolHashes.scan; }, "no toolHashes entry"],
    ["an action with no tool", (m: any) => { delete m.devices[0].actions[0].tool; }, "names no tool"],
    ["more than 64 tools", (m: any) => {
      for (let i = 0; i < 62; i++) m.toolHashes[`t${i}`] = hashOf(`t${i}`);
    }, "more than 64 tools"],
    ["no toolHashes", (m: any) => { delete m.toolHashes; }, "toolHashes"],
    ["no device", (m: any) => { m.devices = []; }, "at least one device"],
    ["a device with no stateUri", (m: any) => { delete m.devices[0].stateUri; }, "no stateUri"],
    ["a device with no sensorKeys", (m: any) => { delete m.devices[0].sensorKeys; }, "sensorKeys"],
    ["a device whose selfChanging is no list", (m: any) => { m.devices[0].selfChanging = "playing"; }, "selfChanging"],
    ["a class not on the applier's list", (m: any) => { m.devices[0].proposedClass = "robot"; }, "proposedClass"],
    ["an action of a capability the device does not list", (m: any) => { m.devices[0].actions[0].action = "onoff.turn_on"; }, "does not list"],
    ["an action that is neither standard nor an extension's", (m: any) => { m.devices[0].actions[0].action = "org.example.library.eject"; }, "neither"],
    ["an extension action on a device without its capability", (m: any) => { m.devices[0].actions.push(m.devices[1].actions[0]); }, "does not list"],
    ["an action with no boolean confirms", (m: any) => { delete m.devices[0].actions[0].confirms; }, "confirms"],
    ["a stateful extension action with no confirmedBy", (m: any) => { delete m.devices[1].actions[0].confirmedBy; }, "no confirmedBy"],
    ["a confirmedBy naming no argument", (m: any) => { m.devices[1].actions[0].confirmedBy.value = { arg: "title" }; }, "names no argument"],
    ["a confirmedBy on a key no extension has", (m: any) => { m.devices[1].actions[0].confirmedBy.key = "org.example.library.busy"; }, "no key of the extensions"],
    ["a requested tier that is none", (m: any) => { m.devices[0].actions[0].requestedTier = "always"; }, "requestedTier"],
    ["no command", (m: any) => { delete m.command; }, "command"],
    ["an interpreter given as a path outside the package", (m: any) => { m.command = ["/usr/bin/python3", "server.py"]; }, "not a file of the package"],
    ["a first element leaving the package", (m: any) => { m.command = ["../bin/python3", "server.py"]; }, "not a file of the package"],
    ["an interpreter name holding a space", (m: any) => { m.command = ["python 3", "server.py"]; }, "interpreter's name"],
    ["a script outside the package", (m: any) => { m.command = ["python3", "/tmp/server.py"]; }, "not a file of the package"],
    ["a script through ..", (m: any) => { m.command = ["python3", "../server.py"]; }, "not a file of the package"],
    ["a script the package does not hold", (m: any) => { m.command = ["python3", "other.py"]; }, "not a file of the package"],
    ["a path argument outside the package", (m: any) => { m.command = ["python3", "server.py", "--config", "/etc/kodi.conf"]; }, "not a file of the package"],
    ["no hosts", (m: any) => { delete m.hosts; }, "hosts"],
    ["a needsSession that is not a boolean", (m: any) => { m.needsSession = "yes"; }, "needsSession"],
    ["otherAdmins of another shape", (m: any) => { m.otherAdmins = [{ vendor: "kodi" }]; }, "otherAdmins"],
  ])("refuses %s", (_what, edit, problem) => {
    const found = refused(edit);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toContain(problem);
  });

  it("takes a command's first element with a slash as a file of the package, and other elements naming no file as they are", () => {
    const files = new Set([...FILES, "bin/server"]);
    expect(refused((m) => { m.command = ["./bin/server", "--port", "8080", "-m", "kodi.main", "lib/kodi.py", "--verbose=2"]; }, files)).toEqual([]);
    expect(refused((m) => { m.command = ["bin/server"]; }, files)).toEqual([]);
    expect(refused((m) => { m.command = ["bin/other"]; }, files).join()).toContain("not a file of the package");
  });

  it("refuses a manifest over 256 KiB, one that is not JSON, and one that is not an object", () => {
    const big = manifest({ padding: "x".repeat(MANIFEST_MAX_BYTES) });
    expect(problems(checkManifest(text(big), FILES))).toEqual([`the manifest is over ${MANIFEST_MAX_BYTES} bytes`]);
    expect(problems(checkManifest(Buffer.from("{ not json"), FILES))[0]).toMatch(/^the manifest is not JSON/);
    expect(problems(checkManifest(Buffer.from("[]"), FILES))).toEqual(["the manifest is not an object"]);
  });

  it("ignores a field it does not know, keeping it in the manifest as installed", () => {
    const c = checkManifest(text(manifest({ skill: "skill.md" })), FILES);
    expect(problems(c)).toEqual([]);
    expect(c.ok && (c.manifest as Manifest & { skill: string }).skill).toBe("skill.md");
  });
});

describe("packagePath and namespaceOf", () => {
  it("gives a package path from its root, and null for one that leaves the package", () => {
    expect(packagePath("./server.js")).toBe("server.js");
    expect(packagePath("lib//kodi.py")).toBe("lib/kodi.py");
    expect(packagePath("lib/../server.js")).toBe("server.js");
    expect(packagePath("../server.js")).toBeNull();
    expect(packagePath("lib/../../x")).toBeNull();
    expect(packagePath("/usr/bin/python3")).toBeNull();
    expect(packagePath(".")).toBeNull();
  });

  it("takes the publisher's namespace as the id without its last label", () => {
    expect(namespaceOf("org.example.kodi")).toBe("org.example");
    expect(namespaceOf("org.galatea.mpv")).toBe("org.galatea");
  });
});
