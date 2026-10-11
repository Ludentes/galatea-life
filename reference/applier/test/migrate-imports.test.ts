import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The migrate-only entry loads the store's code and its settings, nothing of the MCP SDK, undici or
// MQTT (the review of plan A, round 2): the static imports reachable from dist/migrate-main.js.
const dist = join(import.meta.dirname, "..", "dist");
function packagesReached(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = (m[1] ?? m[2])!;
      if (spec.startsWith(".")) walk(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  walk(join(dist, entry));
  return packages;
}

describe("the migrate-only entry's imports", () => {
  it("reach no MCP SDK, undici or MQTT", () => {
    const reached = [...packagesReached("migrate-main.js")];
    expect(reached).toContain("pg");
    expect(reached.filter((p) => /^(@modelcontextprotocol\/|undici$|mqtt$)/.test(p))).toEqual([]);
  });
});
