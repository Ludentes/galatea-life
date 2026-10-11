import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, legacyStatelessFallback, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { TOOLS, type Steward } from "../steward.js";
import { maskUrls, StoreError } from "../core/db.js";
import { isLoopback } from "../net/loopback.js";
import { OutcomeUnknown, Unsettled } from "../core/errors.js";

export { isLoopback };

/** The bearer credential in `Authorization`; the scheme is matched in any case (RFC 9110). */
export const bearerOf = (req: Request | undefined): string | undefined => {
  const m = /^bearer +(.*)$/i.exec(req?.headers.get("authorization") ?? "");
  return m ? m[1] : undefined;
};

/**
 * What a caller is told of a failure the steward could not answer with a request error. A driver's
 * message can name the store's host and port, and a bug's can carry anything, so neither leaves;
 * `Unsettled`'s messages (the store unavailable, an outcome unknown) are the steward's own and name no host.
 */
export function publicMessage(err: unknown): string {
  if (err instanceof Unsettled) return err.message;
  if (err instanceof StoreError) return "the store did not answer";
  return "internal error";
}

/** The detail stays on the steward's side, in its log, with any database URL masked. */
function logFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? (err instanceof StoreError || err instanceof Unsettled ? err.message : err.stack ?? err.message) : String(err);
  console.error(`${what}: ${maskUrls(detail)}`);
}

// The low-level Server, not McpServer: the tools are the standard's operations, validated inside
// against @ludentes/galatea-life-schemas, and McpServer takes Standard Schema objects instead.
function mcpServer(steward: Steward, bearer: string | undefined): Server {
  const server = new Server({ name: "galatea-reference-steward", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: `The steward's ${t.name} (standard/steward.md, Operations)`,
      inputSchema: { type: "object" as const },
      annotations: t.readOnly ? { readOnlyHint: true } : { destructiveHint: t.destructive === true },
    })),
  }));
  server.setRequestHandler("tools/call", async (req) => {
    // The caller is resolved on every request, at every revision (GA-AUTH-4).
    let result;
    try {
      result = await steward.call(steward.caller(bearer), req.params.name, req.params.arguments ?? {});
    } catch (err) {
      logFailure(`${req.params.name} failed`, err);
      // -32603, saying whether what was asked is held for the store (the design, *The store unreachable*).
      throw new ProtocolError(ProtocolErrorCode.InternalError, publicMessage(err),
        { pending: err instanceof Unsettled && err.pending, ...(err instanceof OutcomeUnknown ? { outcome_unknown: true } : {}) });
    }
    const out = result.ok ? result.body : { error: result.error, message: result.message };
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out, isError: !result.ok };
  });
  return server;
}

/**
 * The steward's MCP binding over Streamable HTTP at `/mcp`, the reference applier's copied:
 * revision 2026-07-28, and the 2025 revisions through the SDK's stateless fallback, no other
 * (GA-BIND-2). Plain HTTP only on loopback; any other address needs a certificate and key (GA-SEC-2),
 * given as PEM contents: the entry point reads the files.
 */
export async function serveMcp(steward: Steward, opts: { port: number; host?: string; tls?: { cert: string; key: string } }):
Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopback(host);
  if (!loopback && !opts.tls) throw new Error(`refusing to serve MCP on ${host} without TLS (GA-SEC-2)`);
  const factory = (ctx: { requestInfo?: Request }) => mcpServer(steward, bearerOf(ctx.requestInfo));
  const mcp = steward.mutation === "speaks-only-2025"
    ? { fetch: legacyStatelessFallback(factory), close: async () => undefined }
    : createMcpHandler(factory);
  const handle = toNodeHandler(mcp);
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (loopback && (!validHost(req, res) || !validOrigin(req, res))) return;
    try {
      await handle(req, res);
    } catch (err) {
      logFailure("an MCP request failed", err);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    }
  };
  const http = opts.tls
    ? createHttps({ cert: opts.tls.cert, key: opts.tls.key }, listener)
    : createHttp(listener);
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(opts.port, host, resolve); });
  const shown = host.includes(":") ? `[${host}]` : host;
  return {
    url: `${opts.tls ? "https" : "http"}://${shown}:${opts.port}/mcp`,
    close: async () => {
      await mcp.close();
      await new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); });
    },
  };
}
