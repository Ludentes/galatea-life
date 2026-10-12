import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The applier's core is free of its adapters, so another product can embed it: only the entry points
// read the environment and write to the console, and every log line goes through an injected `log`.
const src = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const sources = files(src).map((f) => ({ file: relative(src, f), text: readFileSync(f, "utf8") }));
/** The core: the applier and its modules, free of the drivers, the protocol SDKs and the file system. */
const CORE = /^(?:(?:core|model|dispatch|safety|config|gate|state|provision|net)\/|applier\.ts$|mutations\.ts$)/;
const FORBIDDEN = /^(?:pg|mqtt|@modelcontextprotocol\/.*|(?:node:)?fs(?:\/promises)?)$/;
/** Every module a file imports or re-exports, type-only ones included. */
const importsOf = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)]
  .map((m) => (m[1] ?? m[2])!);
/** The processes' entry points: the only files that read `process.env` or write to the console. */
const ENTRY_POINTS = new Set(["main.ts", "migrate-main.ts"]);

describe("the applier's modularity", () => {
  it("keeps the core free of pg, mqtt, the MCP SDK and the file system", () => {
    const core = sources.filter((f) => CORE.test(f.file));
    expect(core.length).toBeGreaterThan(30);
    expect(core.flatMap((f) => importsOf(f.text).filter((m) => FORBIDDEN.test(m)).map((m) => `${f.file}: ${m}`))).toEqual([]);
  });

  it("binds MCP to the ApplierService interface, not to the Applier class", () => {
    const server = sources.find((f) => f.file === "mcp/server.ts")!;
    expect(importsOf(server.text).filter((m) => /applier\.js$/.test(m))).toEqual([]);
  });

  it("names the bus by its port, never the MQTT client's module, in the core", () => {
    expect(sources.filter((f) => CORE.test(f.file) && importsOf(f.text).some((m) => /bus\/client\.js$/.test(m))).map((f) => f.file)).toEqual([]);
  });

  it("imports the test clock only in the entry point that makes the clock", () => {
    expect(sources.filter((f) => f.file !== "main.ts" && importsOf(f.text).some((m) => m.startsWith("@ludentes/galatea-life-test-clock")))
      .map((f) => f.file)).toEqual([]);
  });

  it("writes to the console only in the entry points", () => {
    expect(sources.filter((f) => !ENTRY_POINTS.has(f.file) && /\bconsole\./.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("reads process.env only in the entry points", () => {
    expect(sources.filter((f) => !ENTRY_POINTS.has(f.file) && /\bprocess\.env\b/.test(f.text)).map((f) => f.file)).toEqual([]);
  });
});
