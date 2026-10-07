import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Search } from "../src/library.js";
import { ToolFailure, type PlayerPort, type PlayerState } from "../src/player.js";
import { createMcpServer, STATE_URI } from "../src/server.js";

class FakePlayer extends EventEmitter implements PlayerPort {
  s: PlayerState = { playing: false, volume: 50 };
  calls: unknown[][] = [];
  fail: string | undefined;
  state() { return this.s; }
  async #act(call: unknown[], next: Partial<PlayerState>) {
    this.calls.push(call);
    if (this.fail) throw new ToolFailure(this.fail);
    this.s = { ...this.s, ...next };
    this.emit("change");
    return this.s;
  }
  launch(search: Search) { return this.#act(["launch", search], { playing: true, title: "Film.mkv", started_at: "2026-09-27T20:00:00.000Z" }); }
  pause() { return this.#act(["pause"], { playing: false }); }
  resume() { return this.#act(["resume"], { playing: true }); }
  setVolume(volume: number) { return this.#act(["setVolume", volume], { volume }); }
}

const ERAS = [
  ["2025-11-25", { mode: "legacy" }],
  ["2026-07-28", { mode: { pin: "2026-07-28" } }],
] as const;

const text = (r: { content: unknown }) => (r.content as { type: string; text: string }[])[0]!.text;
const tick = () => new Promise((r) => setTimeout(r, 30));

describe.each(ERAS)("the MCP server, era %s", (era, versionNegotiation) => {
  let player: FakePlayer;
  let client: Client;
  let stop: () => Promise<void>;

  beforeEach(async () => {
    player = new FakePlayer();
    const [serverEnd, clientEnd] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(player, "0.1.0"), { transport: serverEnd });
    client = new Client({ name: "test", version: "0" }, { capabilities: {}, versionNegotiation } as never);
    await client.connect(clientEnd as never);
    stop = async () => { await client.close(); await handle.close(); };
  });
  afterEach(async () => { await stop(); });

  it("speaks the era asked for", () => {
    expect((client as unknown as { getNegotiatedProtocolVersion(): string }).getNegotiatedProtocolVersion()).toBe(era);
  });

  it("names itself and offers tools and subscribable resources", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "org.galatea.mpv", version: "0.1.0" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, resources: { subscribe: true } });
  });

  it("lists the four tools", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["launch", "pause", "resume", "set_volume"]);
  });

  it("serves the state resource as one JSON object", async () => {
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([STATE_URI]);
    const read = await client.readResource({ uri: STATE_URI });
    expect(JSON.parse((read.contents[0] as { text: string }).text)).toEqual({ playing: false, volume: 50 });
  });

  it("refuses an unknown resource", async () => {
    await expect(client.readResource({ uri: "mpv://other" })).rejects.toMatchObject({ code: -32602 });
  });

  it("launches with the command's search, and answers with the state", async () => {
    const r = await client.callTool({ name: "launch", arguments: { search: { title: "Дюна", kind: "movie" } } });
    expect(r.isError).toBeFalsy();
    expect(player.calls).toEqual([["launch", { title: "Дюна", kind: "movie" }]]);
    expect(JSON.parse(text(r))).toMatchObject({ playing: true, title: "Film.mkv" });
  });

  it("refuses a search field it does not declare, calling nothing", async () => {
    const r = await client.callTool({ name: "launch", arguments: { search: { title: "x", path: "/etc/passwd" } } });
    expect(r.isError).toBe(true);
    expect(player.calls).toEqual([]);
  });

  it("refuses an argument it does not declare, calling nothing", async () => {
    const r = await client.callTool({ name: "pause", arguments: { url: "http://example.org/x" } });
    expect(r.isError).toBe(true);
    expect(player.calls).toEqual([]);
  });

  it("reports a failure as isError with its reason", async () => {
    player.fail = "nothing is loaded";
    const r = await client.callTool({ name: "pause", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("nothing is loaded");
  });

  it("passes set_volume's volume through", async () => {
    await client.callTool({ name: "set_volume", arguments: { volume: 20 } });
    expect(player.calls).toEqual([["setVolume", 20]]);
  });

  it("refuses an unknown tool", async () => {
    await expect(client.callTool({ name: "shell", arguments: {} })).rejects.toThrow();
  });

  it("notifies a change only while the client listens for it", async () => {
    const seen: string[] = [];
    client.setNotificationHandler("notifications/resources/updated" as never, (async (n: { params: { uri: string } }) => {
      seen.push(n.params.uri);
    }) as never);
    const modern = era === "2026-07-28";
    const c = client as unknown as {
      subscribeResource(p: { uri: string }): Promise<unknown>;
      unsubscribeResource(p: { uri: string }): Promise<unknown>;
      listen(f: { resourceSubscriptions: string[] }): Promise<{ close(): Promise<void> }>;
    };

    await client.callTool({ name: "pause", arguments: {} });
    await tick();
    expect(seen).toEqual([]);

    const listening = modern ? await c.listen({ resourceSubscriptions: [STATE_URI] }) : await c.subscribeResource({ uri: STATE_URI });
    await client.callTool({ name: "resume", arguments: {} });
    await tick();
    expect(seen).toEqual([STATE_URI]);

    if (modern) await (listening as { close(): Promise<void> }).close();
    else await c.unsubscribeResource({ uri: STATE_URI });
    await client.callTool({ name: "pause", arguments: {} });
    await tick();
    expect(seen).toEqual([STATE_URI]);
  });
});
