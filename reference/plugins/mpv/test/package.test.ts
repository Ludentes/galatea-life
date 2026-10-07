import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pack } from "../scripts/pack.js";
import { MpvIpc } from "../src/ipc.js";
import type { Manifest } from "../src/manifest.js";
import { toolHash } from "../src/tools.js";
import { makeVideo } from "./media.js";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = join(PKG_ROOT, "..", "..", "..");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PACK_SCRIPT = join(PKG_ROOT, "scripts", "pack.ts");

let tarball: string;
let sha256: string;

beforeAll(async () => {
  ({ tarball, sha256 } = await pack());
}, 60_000);

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** No mpv runs with a socket under `runtime`: every test's mpv is started with one there. */
function noMpvUnder(runtime: string): boolean {
  try {
    execFileSync("pgrep", ["-f", runtime]);
    return false;
  } catch {
    return true;
  }
}

async function eventually(pred: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/** The package unpacked as the bridge installs it, a home with a folders file, a runtime directory. */
function install(): { dir: string; manifest: Manifest; home: string; media: string; runtime: string } {
  const dir = temp("installed-");
  execFileSync("tar", ["-xzf", tarball, "-C", dir]);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const home = temp("home-");
  const media = join(home, "Films");
  mkdirSync(join(home, ".config", "galatea-mpv"), { recursive: true });
  writeFileSync(join(home, ".config", "galatea-mpv", "folders"), `${media}\n`);
  return { dir, manifest, home, media, runtime: temp("run-") };
}

/** The server started as the manifest says, from the package's directory, in a minimal environment. */
function spawnServer(i: ReturnType<typeof install>) {
  const [interpreter, ...args] = i.manifest.command;
  return spawn(interpreter!, [...args, "--vo=null", "--ao=null", "--no-config"], {
    cwd: i.dir,
    env: { HOME: i.home, PATH: process.env.PATH!, LANG: "C.UTF-8", XDG_RUNTIME_DIR: i.runtime },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("the package", () => {
  it("holds exactly the manifest, its package.json and the server", () => {
    const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
    expect(list).toEqual(["manifest.json", "package.json", "server.js"]);
  });

  it("is reproducible", async () => {
    expect((await pack()).sha256).toBe(sha256);
  }, 60_000);

  it("packs the same bytes regardless of the working directory it runs from", () => {
    // Fix round 1: esbuild's source-path comments used to follow process.cwd(), so packing from
    // the repository root gave a different bundle, and so a different SHA-256, than packing from
    // the package's own directory. `absWorkingDir` in scripts/pack.ts pins that; this runs the
    // real CLI (not just `pack()`, which always executes from the test's own cwd) once from each
    // directory and compares.
    const runFrom = (cwd: string): { sha256: string } =>
      JSON.parse(execFileSync(TSX, [PACK_SCRIPT], { cwd, encoding: "utf8" }).trim()) as { sha256: string };
    const fromPackageDir = runFrom(PKG_ROOT);
    const fromRepoRoot = runFrom(REPO_ROOT);
    expect(fromRepoRoot.sha256).toBe(fromPackageDir.sha256);
  }, 60_000);

  // Both eras. With the SDK's own stdio transport, a client pinned to 2026-07-28 starts the server
  // a second time to probe the era (docs/research/2026-09-27-mcp-typescript-sdks.md); the bridge
  // will not, over its own transport. Here the probe's server, and its mpv, are simply stopped.
  it.each([
    ["2025-11-25", { mode: "legacy" }],
    ["2026-07-28", { mode: { pin: "2026-07-28" } }],
  ] as const)("runs as the bridge will run it, era %s: tools match the manifest, a film plays, the state follows", async (era, versionNegotiation) => {
    const { dir, manifest, home, media, runtime } = install();
    makeVideo(join(media, "Test Pattern (2026).mkv"));

    // As the bridge will: the manifest's command, from the package's own directory, an environment
    // built from nothing but HOME, PATH, LANG and the runtime directory.
    const [interpreter, ...args] = manifest.command;
    const transport = new StdioClientTransport({
      command: interpreter!,
      args: [...args, "--vo=null", "--ao=null", "--no-config"],
      cwd: dir,
      env: { HOME: home, PATH: process.env.PATH!, LANG: "C.UTF-8", XDG_RUNTIME_DIR: runtime },
      stderr: "pipe",
    });
    const client = new Client({ name: "bridge-stand-in", version: "0" }, { capabilities: {}, versionNegotiation } as never);
    await client.connect(transport);
    const c = client as unknown as {
      getNegotiatedProtocolVersion(): string;
      subscribeResource(p: { uri: string }): Promise<unknown>;
      listen(f: { resourceSubscriptions: string[] }): Promise<{ close(): Promise<void> }>;
    };
    try {
      expect(c.getNegotiatedProtocolVersion()).toBe(era);
      const tools = (await client.listTools()).tools;
      expect(Object.fromEntries(tools.map((t) => [t.name, toolHash(t)]))).toEqual(manifest.toolHashes);

      const seen: string[] = [];
      client.setNotificationHandler("notifications/resources/updated" as never, (async (n: { params: { uri: string } }) => {
        seen.push(n.params.uri);
      }) as never);
      const uri = manifest.devices[0]!.stateUri;
      if (era === "2026-07-28") await c.listen({ resourceSubscriptions: [uri] });
      else await c.subscribeResource({ uri });

      const r = await client.callTool({ name: "launch", arguments: { search: { title: "test pattern", kind: "movie" } } });
      expect(r.isError).toBeFalsy();
      const state = JSON.parse((await client.readResource({ uri })).contents[0]!.text as string);
      expect(state).toMatchObject({ playing: true, title: "Test Pattern (2026).mkv" });
      expect(Date.parse(state.started_at)).not.toBeNaN();
      expect(seen.length).toBeGreaterThan(0);

      const miss = await client.callTool({ name: "launch", arguments: { search: { title: "no such film" } } });
      expect(miss.isError).toBe(true);

      expect((await client.callTool({ name: "pause", arguments: {} })).isError).toBeFalsy();
      const paused = JSON.parse((await client.readResource({ uri })).contents[0]!.text as string);
      expect(paused.playing).toBe(false);
    } finally {
      await client.close();
    }
    // Final review T-b: no mpv outlives the client's close (the probe's server included, in the
    // 2026-07-28 era), and each leaves no socket directory behind.
    expect(await eventually(() => noMpvUnder(runtime) && readdirSync(runtime).length === 0)).toBe(true);
  }, 60_000);

  it.each(["killed", "quit over its socket"] as const)("exits by itself, nonzero, when its mpv goes (%s), leaving no socket directory", async (how) => {
    // Final review C1: when mpv went, the server used to hang in `stop()` on a command sent over
    // the closed socket, and then ignore SIGTERM.
    const i = install();
    const child = spawnServer(i);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    // Ready once it answers `initialize`: mpv is up and the player attached.
    const answered = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n");
    await answered;

    if (how === "killed") {
      execFileSync("pkill", ["-KILL", "-f", i.runtime]);
    } else {
      const ipc = await MpvIpc.connect(join(i.runtime, readdirSync(i.runtime)[0]!, "ipc.sock"));
      await ipc.command(["quit"]).catch(() => { /* the socket closes as mpv quits */ });
      ipc.close();
    }
    const code = await Promise.race([exited, sleep(5_000).then(() => "hung" as const)]);
    if (code === "hung") {
      child.kill("SIGKILL");
      try { execFileSync("pkill", ["-KILL", "-f", i.runtime]); } catch { /* none left */ }
    }
    expect(code).toBe(1);
    expect(readdirSync(i.runtime)).toEqual([]);
    expect(noMpvUnder(i.runtime)).toBe(true);
  }, 15_000);

  it("stops mpv and removes its socket directory when SIGTERM arrives during start-up", async () => {
    // Fix round 1: main.ts used to install its SIGTERM/stdin handlers only after `startMpv` and
    // `Player.attach` had resolved, so a signal arriving during start-up orphaned a live
    // `mpv --idle` and its socket directory. This spawns the real, packaged server and sends
    // SIGTERM as soon as the socket directory appears, while mpv is very likely still starting.
    // Not after a fixed delay: under a loaded parallel run, node may not have loaded main.ts by
    // then, and a signal before its handlers exist kills it with no exit code. The directory is
    // made after the handlers are registered, so its presence says they are in place.
    const i = install();
    const runtime = i.runtime;
    const child = spawnServer(i);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(await eventually(() => readdirSync(runtime).length > 0, 10_000)).toBe(true);
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);

    expect(child.exitCode).toBe(0);
    expect(readdirSync(runtime)).toEqual([]);
    expect(() => execFileSync("pgrep", ["-f", runtime])).toThrow();
  }, 15_000);
});
