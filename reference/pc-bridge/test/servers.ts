import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { ServerExit, ServerProcess, ServerSpec } from "../src/port.js";
import { toolHash } from "../src/plugins/mcp.js";
// @ts-expect-error: a plain module, run by node as a package's server too.
import { Fixture } from "./fixtures/mcp-server.mjs";
import { tgz } from "./packages.js";

export { Fixture };

/** What the fixture server does (`test/fixtures/mcp-server.mjs`, `DEFAULTS`). */
export interface Behaviour {
  era?: "both" | "legacy";
  tools?: Record<string, unknown>[];
  listChanged?: boolean;
  state?: Record<string, unknown>;
  subscribe?: boolean | "hang";
  readFails?: number;
  calls?: Record<string, { result: string; text?: string; sets?: string }>;
  exitAtStart?: number;
}

export interface FixtureServer {
  b: Required<Behaviour>;
  log: ({ call: string; args: Record<string, unknown> } | { read: string })[];
  answers: Record<string, unknown>[];
  set(uri: string, value: unknown): void;
  setTools(tools: Record<string, unknown>[], announce: boolean): void;
  behave(over: Behaviour): void;
  hang(): void;
  sleep(): void;
  wake(): void;
  crash(code?: number): void;
  flood(): void;
}

/** A tool as a test's server offers it: no arguments unless it says otherwise. */
export function tool(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, title: name, description: `Does ${name}.`, inputSchema: { type: "object", properties: {}, additionalProperties: false }, ...over };
}

/** The `toolHashes` a manifest carries for these tools. */
export function pins(tools: Record<string, unknown>[]): Record<string, string> {
  return Object.fromEntries(tools.map((t) => [t.name as string, toolHash(t)]));
}

/** The test plugin's tools (`test/manifests.ts`), as its fixture server offers them. */
export const KODI_TOOLS = [
  tool("pause"),
  tool("set_volume", { inputSchema: { type: "object", properties: { volume: { type: "integer" } }, required: ["volume"] } }),
  tool("scan", { inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }),
];
export const KODI_PLAYER = "kodi://player/state";
export const KODI_LIBRARY = "kodi://library/state";
/** The test plugin's state as its fixture server starts with it. */
export const kodiState = () => ({ [KODI_PLAYER]: { playing: false, volume: 40 }, [KODI_LIBRARY]: { "org.example.library.scanning": false } });

/** Servers of the test plugin started in this process, pinned as a manifest with `pins(KODI_TOOLS)` pins them; `over(n)` changes the n-th start. */
export function kodiServers(over: (n: number, spec: ServerSpec) => Behaviour = () => ({})): InProcessServers {
  return new InProcessServers((n, spec) => ({ tools: KODI_TOOLS, state: kodiState(), ...over(n, spec) }));
}

/** A server started in this process: the fixture over two streams, its exit its own. */
export function inProcess(behaviour: Behaviour = {}): ServerProcess & { fixture: FixtureServer } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const fixture = new Fixture(behaviour) as FixtureServer;
  let end!: (e: ServerExit) => void;
  const exited = new Promise<ServerExit>((resolve) => { end = resolve; });
  let done = false;
  let handle: { close(): Promise<void> } | undefined;
  const exit = (e: ServerExit) => {
    if (done) return;
    done = true;
    stdout.end();
    void handle?.close().catch(() => {});
    end(e);
  };
  handle = (fixture as unknown as { serve(i: PassThrough, o: PassThrough, x: (code: number) => void): { close(): Promise<void> } })
    .serve(stdin, stdout, (code) => exit({ code, signal: null }));
  return {
    pid: 0,
    stdin,
    stdout,
    exited,
    fixture,
    async stop() {
      exit({ code: null, signal: "SIGTERM" });
      await exited;
    },
  };
}

/**
 * A FakePort's `serverFactory` that starts each server in this process, the behaviour of each
 * start given by `behaviour(n)` (from 0): a server that fails its first starts, then serves.
 */
export class InProcessServers {
  readonly started: (ServerProcess & { fixture: FixtureServer })[] = [];
  readonly specs: ServerSpec[] = [];

  constructor(public behaviour: (n: number, spec: ServerSpec) => Behaviour) {}

  readonly factory = async (spec: ServerSpec): Promise<ServerProcess> => {
    const p = inProcess(this.behaviour(this.started.length, spec));
    this.started.push(p);
    this.specs.push(spec);
    return p;
  };

  /** The last server started. */
  get last(): ServerProcess & { fixture: FixtureServer } {
    return this.started.at(-1)!;
  }
}

const require = createRequire(import.meta.url);
/** The SDK's ES module, by absolute URL, for a package's server that runs outside this workspace. */
const sdk = (name: string) => pathToFileURL(require.resolve(name)).href.replace(/\.cjs$/, ".mjs");

/** The fixture as a package's server file: its SDK imports pointed at this workspace's copy. */
export function serverFile(): string {
  return readFileSync(new URL("./fixtures/mcp-server.mjs", import.meta.url), "utf8")
    .replace('from "@modelcontextprotocol/server/stdio"', `from "${sdk("@modelcontextprotocol/server/stdio")}"`)
    .replace('from "@modelcontextprotocol/server"', `from "${sdk("@modelcontextprotocol/server")}"`);
}

/**
 * A package whose server is the fixture, run as `node server.mjs`: the manifest, the server, and
 * `fixture.json` naming the behaviour and the test's control port.
 */
export function fixturePackage(manifest: Record<string, unknown>, behaviour: Behaviour, control: number): Buffer {
  return tgz([
    { name: "manifest.json", body: JSON.stringify(manifest) },
    { name: "server.mjs", body: serverFile() },
    { name: "fixture.json", body: JSON.stringify({ control, behaviour }) },
  ]);
}

/** How a packaged fixture reported its start. */
export interface Started {
  pid: number;
  env: Record<string, string>;
  argv: string[];
  cwd: string;
}

/** The control port packaged fixtures connect to: each reports its start, and the test drives the latest. */
export async function controlServer() {
  const started: Started[] = [];
  const sockets: Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.started) started.push(msg.started);
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    started,
    /** Calls a method of the latest fixture that connected. */
    send(method: string, ...args: unknown[]) {
      sockets.at(-1)!.write(JSON.stringify({ method, args }) + "\n");
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
