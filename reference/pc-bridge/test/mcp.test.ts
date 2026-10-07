import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareTools, McpSession, MODERN_ERA, toolHash, type McpSessionOptions } from "../src/plugins/mcp.js";
import { spawnServer } from "../src/spawn-server.js";
import { controlServer, inProcess, pins, serverFile, tool, type Behaviour } from "./servers.js";

const URI = "kodi://player/state";
const TOOLS = [tool("pause"), tool("set_volume", { inputSchema: { type: "object", properties: { volume: { type: "integer" } }, required: ["volume"] } })];
const never = () => new AbortController().signal;

/** A session on an in-process fixture, and what it was told. */
async function session(behaviour: Behaviour = {}, over: Partial<McpSessionOptions> = {}) {
  const p = inProcess({ tools: TOOLS, state: { [URI]: { playing: false, volume: 40 } }, ...behaviour });
  const told = { tools: 0, updated: [] as string[], input: [] as string[], closed: [] as string[] };
  const s = await McpSession.connect(p, {
    onToolsChanged: () => { told.tools += 1; },
    onResourceUpdated: (uri) => told.updated.push(uri),
    onInputRequest: (m) => told.input.push(m),
    onClosed: (why) => told.closed.push(why),
    ...over,
  }, never());
  open.push(async () => { await s.close(); await p.stop(); });
  return { s, p, told, fixture: p.fixture };
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

/** Lets the in-process exchange run: every hop is a stream write and a promise. */
async function turns(ok: () => boolean): Promise<void> {
  for (const end = Date.now() + 10_000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2));
  expect(ok()).toBe(true);
}

describe("toolHash and compareTools", () => {
  it("hashes the fields the standard names, as the mpv plugin's manifest does, whatever the key order", () => {
    const a = { name: "pause", title: "Pause", description: "Pauses.", inputSchema: { type: "object", properties: {} }, _meta: { x: 1 } };
    const b = { inputSchema: { properties: {}, type: "object" }, description: "Pauses.", title: "Pause", name: "pause" };
    expect(toolHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(toolHash(a)).toBe(toolHash(b));
    expect(toolHash({ ...b, annotations: { readOnlyHint: true } })).not.toBe(toolHash(b));
  });

  it("names a tool not in the manifest, a missing one, a changed one and one listed twice", () => {
    const pinned = pins(TOOLS);
    expect(compareTools(TOOLS, pinned)).toBeNull();
    expect(compareTools([...TOOLS, tool("shell")], pinned)).toBe("tool shell is not in the manifest");
    expect(compareTools([TOOLS[0]!], pinned)).toBe("tool set_volume is missing");
    expect(compareTools([{ ...TOOLS[0]!, description: "Pauses, and more." }, TOOLS[1]!], pinned)).toBe("tool pause is not the one the manifest pins");
    expect(compareTools([...TOOLS, TOOLS[0]!], pinned)).toBe("tool pause is listed twice");
  });

  it("names five problems and counts the rest, each name cut, the whole within 1 KiB; a long pinned name still matches", () => {
    const pinned = pins(TOOLS);
    const extra = Array.from({ length: 1000 }, (_, i) => tool(`t${i}-${"x".repeat(5000)}`));
    const text = compareTools([...TOOLS, ...extra], pinned)!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text).toMatch(/; and 995 more$/);
    expect(text.split("; ").slice(0, 5).every((p) => /^tool t\d+-x+… is not in the manifest$/.test(p))).toBe(true);
    const long = tool(`l-${"y".repeat(500)}`);
    expect(compareTools([long], pins([long]))).toBeNull();
    expect(compareTools([long, tool(`l-${"y".repeat(499)}z`)], pins([long]))).toMatch(/is not in the manifest$/);
  });
});

describe.each([
  ["both", MODERN_ERA],
  ["legacy", "2025-11-25"],
] as const)("McpSession with a server of era %s", (era, negotiated) => {
  it("negotiates the era with a probe in place", async () => {
    const { s } = await session({ era });
    expect(s.era).toBe(negotiated);
  });

  it("finds the live tools as pinned, and a tool changed or added after start as a mismatch, announced", async () => {
    const { s, fixture, told } = await session({ era });
    expect(await s.checkTools(pins(TOOLS), never())).toBeNull();
    await s.subscribe([URI], never());
    fixture.setTools([...TOOLS, tool("shell")], true);
    await turns(() => told.tools === 1);
    expect(await s.checkTools(pins(TOOLS), never())).toBe("tool shell is not in the manifest");
  });

  it("hashes a tool as the server wrote it, a field the SDK does not know included", async () => {
    const odd = tool("pause", { annotations: { readOnlyHint: false, "org.example.hint": true } });
    const { s } = await session({ era, tools: [odd] });
    expect(await s.checkTools({ pause: toolHash(odd) }, never())).toBeNull();
    const { "org.example.hint": _, ...known } = odd.annotations as Record<string, unknown>;
    expect(await s.checkTools({ pause: toolHash({ ...odd, annotations: known }) }, never())).toBe("tool pause is not the one the manifest pins");
  });

  it("subscribes to a state resource and hears its changes; reads it as text, never from a cache", async () => {
    const { s, fixture, told } = await session({ era });
    expect(await s.subscribe([URI], never())).toBe(true);
    expect(JSON.parse(await s.read(URI, never()))).toEqual({ playing: false, volume: 40 });
    fixture.set(URI, { playing: true, volume: 40 });
    await turns(() => told.updated.length === 1);
    expect(told.updated).toEqual([URI]);
    expect(JSON.parse(await s.read(URI, never()))).toEqual({ playing: true, volume: 40 });
  });

  it("says when the server offers no subscription", async () => {
    const { s } = await session({ era, subscribe: false });
    expect(await s.subscribe([URI], never())).toBe(false);
  });

  it("rejects a read the server fails, and a resource it does not have", async () => {
    const { s } = await session({ era, readFails: 1 });
    await expect(s.read(URI, never())).rejects.toThrow(/not ready yet/);
    await expect(s.read("kodi://nothing", never())).rejects.toThrow();
    expect(JSON.parse(await s.read(URI, never()))).toMatchObject({ volume: 40 });
  });

  it("probes a server with the era's word", async () => {
    const { s } = await session({ era });
    await expect(s.probe(never())).resolves.toBeUndefined();
  });

  it("calls a tool with the arguments, keeping only its text", async () => {
    const { s, fixture } = await session({ era, calls: { set_volume: { result: "ok", text: "set", sets: URI } } });
    expect(await s.callTool("set_volume", { volume: 20 }, never())).toEqual({ kind: "ok", text: "set" });
    expect(fixture.log).toContainEqual({ call: "set_volume", args: { volume: 20 } });
    expect(JSON.parse(await s.read(URI, never()))).toMatchObject({ volume: 20 });
  });

  it("gives a tool's isError with its text", async () => {
    const { s } = await session({ era, calls: { pause: { result: "error", text: "nothing is loaded" } } });
    expect(await s.callTool("pause", {}, never())).toEqual({ kind: "error", text: "nothing is loaded" });
  });

  it("ends a tool that asks for input through the SDK as input", async () => {
    const { s, told } = await session({ era, calls: { pause: { result: "sdk-input" } } });
    const r = await s.callTool("pause", {}, never());
    // The SDK's own refusal: isError on a 2025 connection, -32021 on a 2026 one; neither reaches the client as a request.
    expect(r.kind).toBe(era === "both" ? "input" : "error");
    expect(told.input).toEqual([]);
  });

  it("gives up a call when its signal aborts", async () => {
    const { s } = await session({ era, calls: { pause: { result: "hang" } } });
    const a = new AbortController();
    const call = s.callTool("pause", {}, a.signal);
    a.abort(new Error("the command's time ran out"));
    expect(await call).toMatchObject({ kind: "failed" });
  });
});

describe("McpSession: requests for input and the transport", () => {
  it("refuses a 2025 server's elicitation and sampling requests, never relaying them, and ends the tool as input", async () => {
    const { s, fixture, told } = await session({ era: "legacy", calls: { pause: { result: "raw-elicit" }, set_volume: { result: "raw-sampling" } } });
    expect(await s.callTool("pause", {}, never())).toMatchObject({ kind: "input" });
    expect(await s.callTool("set_volume", { volume: 1 }, never())).toMatchObject({ kind: "input" });
    expect(told.input).toEqual(["elicitation/create", "sampling/createMessage"]);
    expect(fixture.answers.map((a) => (a as { error?: { code: number } }).error?.code)).toEqual([-32601, -32601]);
  });

  it("ends a 2026 input_required result as input, fulfilling nothing", async () => {
    const { s, fixture } = await session({ era: "both", calls: { pause: { result: "raw-input" } } });
    expect(await s.callTool("pause", {}, never())).toMatchObject({ kind: "input" });
    expect(fixture.log.filter((l) => "call" in l)).toHaveLength(1);
  });

  it("closes on a message over the 10 MB ceiling, as a flood", async () => {
    const { s, fixture, told } = await session();
    fixture.flood();
    await turns(() => told.closed.length > 0);
    expect(told.closed).toEqual(["flood"]);
    expect(s.closedBy).toBe("flood");
  });

  it("tells of a server whose output ended", async () => {
    const { told, fixture } = await session();
    fixture.crash(1);
    await turns(() => told.closed.length > 0);
    expect(told.closed).toEqual(["the server's output ended"]);
  });

  it("rejects the connection of a server that exits before any answer", async () => {
    const p = inProcess({ exitAtStart: 1 });
    await expect(McpSession.connect(p, { onToolsChanged() {}, onResourceUpdated() {}, onInputRequest() {}, onClosed() {} }, never())).rejects.toThrow();
  });

  it("rejects a connection whose signal aborts", async () => {
    const p = inProcess({ era: "legacy" });
    p.fixture.hang();
    const a = new AbortController();
    const c = McpSession.connect(p, { onToolsChanged() {}, onResourceUpdated() {}, onInputRequest() {}, onClosed() {} }, a.signal);
    a.abort(new Error("its 120 s passed"));
    await expect(c).rejects.toThrow();
    await p.stop();
  });

  it("probes no era for a version whose 2025 era it kept", async () => {
    const { s, fixture } = await session({ era: "both" }, { era: "2025-11-25" });
    expect(s.era).toBe("2025-11-25");
    expect(fixture.log).toEqual([]);
  });
});

describe("McpSession over a real process", () => {
  let dir: string;
  let control: Awaited<ReturnType<typeof controlServer>>;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-real-"));
    control = await controlServer();
  });
  afterEach(async () => {
    await control.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts the server once while negotiating the era, reads it over its pipes, and ends it by closing its input", async () => {
    writeFileSync(join(dir, "server.mjs"), serverFile());
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ control: control.port, behaviour: { tools: TOOLS, state: { [URI]: { volume: 7 } } } }));
    const p = await spawnServer({ plugin: "p", version: "1", osId: 1000, session: null, argv: [process.execPath, join(dir, "server.mjs")],
      env: { PATH: "/usr/bin:/bin" }, cwd: dir, noNewPrivs: true }, 500);
    const s = await McpSession.connect(p, { onToolsChanged() {}, onResourceUpdated() {}, onInputRequest() {}, onClosed() {} }, never());
    expect(s.era).toBe(MODERN_ERA);
    expect(await s.checkTools(pins(TOOLS), never())).toBeNull();
    expect(JSON.parse(await s.read(URI, never()))).toEqual({ volume: 7 });
    await s.close();
    expect(await p.exited).toEqual({ code: 0, signal: null });
    expect(control.started).toHaveLength(1);
  }, 20_000);
});
