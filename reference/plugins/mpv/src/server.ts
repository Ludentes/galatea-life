import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult } from "@modelcontextprotocol/server";
import type { Search } from "./library.js";
import type { PlayerPort, PlayerState } from "./player.js";
import { TOOLS } from "./tools.js";

export const STATE_URI = "mpv://player/state";

/** The first revision in which the SDK's `subscriptions/listen` filters notifications itself. */
const LISTEN_ERA = "2026-07-28";

class BadArgs extends Error {}

function only(obj: unknown, allowed: string[], what: string): Record<string, unknown> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new BadArgs(`${what} must be an object`);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new BadArgs(`${what} has no field "${k}"`);
  return obj as Record<string, unknown>;
}

function search(args: Record<string, unknown>): Search {
  const s = only(args.search, ["title", "kind"], "search");
  if (typeof s.title !== "string" || s.title.trim() === "") throw new BadArgs("search.title must be a non-empty string");
  if (s.kind !== undefined && s.kind !== "movie" && s.kind !== "episode") throw new BadArgs('search.kind must be "movie" or "episode"');
  return s.kind === undefined ? { title: s.title } : { title: s.title, kind: s.kind };
}

async function call(player: PlayerPort, name: string, raw: unknown): Promise<PlayerState> {
  switch (name) {
    case "launch":
      return player.launch(search(only(raw ?? {}, ["search"], "arguments")));
    case "pause":
      only(raw ?? {}, [], "arguments");
      return player.pause();
    case "resume":
      only(raw ?? {}, [], "arguments");
      return player.resume();
    case "set_volume": {
      const args = only(raw ?? {}, ["volume"], "arguments");
      if (typeof args.volume !== "number") throw new BadArgs("volume must be a number");
      return player.setVolume(args.volume);
    }
    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown tool: ${name}`);
  }
}

function unknownResource(uri: string): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown resource: ${uri}`);
}

/**
 * One connection's MCP server: the four tools and the state resource, over a player. A factory
 * for `serveStdio`, which calls it once per connection and serves both protocol eras.
 */
export function createMcpServer(player: PlayerPort, version: string): Server {
  const server = new Server(
    { name: "org.galatea.mpv", version },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );
  const subscribed = new Set<string>();

  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));

  server.setRequestHandler("tools/call", async (req): Promise<CallToolResult> => {
    try {
      const state = await call(player, req.params.name, req.params.arguments);
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
    }
  });

  server.setRequestHandler("resources/list", async () => ({
    resources: [{ uri: STATE_URI, name: "player", title: "The player's state", mimeType: "application/json" }],
  }));

  server.setRequestHandler("resources/read", async (req) => {
    if (req.params.uri !== STATE_URI) unknownResource(req.params.uri);
    return { contents: [{ uri: STATE_URI, mimeType: "application/json", text: JSON.stringify(player.state()) }] };
  });

  // 2025 era only: 2026-07-28 replaced these with `subscriptions/listen`, which the SDK serves.
  server.setRequestHandler("resources/subscribe", async (req) => {
    if (req.params.uri !== STATE_URI) unknownResource(req.params.uri);
    subscribed.add(req.params.uri);
    return {};
  });
  server.setRequestHandler("resources/unsubscribe", async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });

  player.on("change", () => {
    const era = server.getNegotiatedProtocolVersion();
    if (era === undefined) return;
    if (era < LISTEN_ERA && !subscribed.has(STATE_URI)) return;
    server.sendResourceUpdated({ uri: STATE_URI }).catch(() => { /* the client is gone */ });
  });

  return server;
}
