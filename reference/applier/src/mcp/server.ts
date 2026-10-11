import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, legacyStatelessFallback, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { TOOLS, type Applier } from "../applier.js";
import { maskUrls, StoreError } from "../core/db.js";
import { isLoopback } from "../net/loopback.js";
import { StoreUnavailable } from "../core/errors.js";

export { isLoopback };

/** The bearer credential in `Authorization`; the scheme is matched in any case (RFC 9110). */
export const bearerOf = (req: Request | undefined): string | undefined => {
  const m = /^bearer +(.*)$/i.exec(req?.headers.get("authorization") ?? "");
  return m ? m[1] : undefined;
};

/**
 * What a caller is told of a failure the applier could not answer with a request error. A driver's
 * message can name the store's host and port, and a bug's can carry anything, so neither leaves;
 * `StoreUnavailable`'s messages are the applier's own and name no host.
 */
export function publicMessage(err: unknown): string {
  if (err instanceof StoreUnavailable) return err.message;
  if (err instanceof StoreError) return "the store did not answer";
  return "internal error";
}

/** The detail stays on the applier's side, in its log, with any database URL masked. */
function logFailure(what: string, err: unknown): void {
  const detail = err instanceof Error ? (err instanceof StoreError || err instanceof StoreUnavailable ? err.message : err.stack ?? err.message) : String(err);
  console.error(`${what}: ${maskUrls(detail)}`);
}

// The low-level Server, not McpServer: the tools are the standard's operations, validated inside
// against @ludentes/galatea-life-schemas, and McpServer takes Standard Schema objects instead.
function mcpServer(applier: Applier, bearer: string | undefined): Server {
  const server = new Server({ name: "galatea-reference-applier", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: `The applier's ${t.name} (standard/applier.md, Operations)`,
      inputSchema: { type: "object" as const },
      annotations: t.readOnly ? { readOnlyHint: true } : { destructiveHint: true },
    })),
  }));
  server.setRequestHandler("tools/call", async (req) => {
    // The caller is resolved on every request, at every revision (GA-AUTH-3).
    let result;
    try {
      result = await applier.call(applier.caller(bearer), req.params.name, req.params.arguments ?? {});
    } catch (err) {
      logFailure(`${req.params.name} failed`, err);
      throw new ProtocolError(ProtocolErrorCode.InternalError, publicMessage(err));
    }
    const out = result.ok ? result.body : { error: result.error, message: result.message, ...(result.data ? { data: result.data } : {}) };
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out, isError: !result.ok };
  });
  return server;
}

/**
 * The applier's MCP binding over Streamable HTTP at `/mcp`: revision 2026-07-28, and the 2025
 * revisions through the SDK's stateless fallback (GA-BIND-1). Plain HTTP only on loopback; any
 * other address needs a certificate and key (GA-SEC-1), given as PEM contents: the entry point reads
 * the files.
 */
export async function serveMcp(applier: Applier, opts: { port: number; host?: string; tls?: { cert: string; key: string } }):
Promise<{ url: string; close(): Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const loopback = isLoopback(host);
  if (!loopback && !opts.tls) throw new Error(`refusing to serve MCP on ${host} without TLS (GA-SEC-1)`);
  const factory = (ctx: { requestInfo?: Request }) => mcpServer(applier, bearerOf(ctx.requestInfo));
  const mcp = applier.mutation === "speaks-only-2025"
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
