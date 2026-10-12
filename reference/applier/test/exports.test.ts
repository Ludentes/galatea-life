import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The applier as a library (package.json's `exports`): each subpath resolves by the package's name
// and gives what a host needs; `.` reaches no MCP SDK, pg or MQTT through its static imports.
const here = join(import.meta.dirname, "..");
const dist = join(here, "dist");

/** The packages the static imports reachable from `entry` (a built file) name. */
function packagesReached(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = (m[1] ?? m[2])!;
      if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  walk(join(dist, entry));
  return packages;
}

/** What `import(spec)` gives, by the package's own name, in a process of its own: the names it exports. */
function exportsOf(spec: string): string[] {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `console.log(JSON.stringify(Object.keys(await import(${JSON.stringify(spec)}))))`],
    { cwd: here, encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("the package's exports", () => {
  it("resolve each subpath by the package's name", () => {
    expect(exportsOf("@ludentes/galatea-life-applier")).toEqual(expect.arrayContaining(
      ["Applier", "TOOLS", "Store", "startApplier", "settingsFromEnv", "migrate", "Mutant", "mutantOf", "quiet"]));
    expect(exportsOf("@ludentes/galatea-life-applier/mcp")).toContain("serveMcp");
    expect(exportsOf("@ludentes/galatea-life-applier/bus")).toContain("Bus");
    expect(exportsOf("@ludentes/galatea-life-applier/pg")).toEqual(expect.arrayContaining(["connectPg", "migrationsFrom", "MIGRATIONS_DIR"]));
  });

  it("keep `.` free of the MCP SDK, pg and MQTT", () => {
    const reached = [...packagesReached("index.js")];
    expect(reached.filter((p) => /^(@modelcontextprotocol\/|undici$|mqtt$|pg$)/.test(p))).toEqual([]);
    expect(packagesReached("mcp/server.js")).toContain("@modelcontextprotocol/server");
    expect(packagesReached("bus/client.js")).toContain("mqtt");
    expect(packagesReached("pg.js")).toContain("pg");
  });
});
