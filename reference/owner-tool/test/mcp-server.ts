import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, legacyStatelessFallback, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";

export type Handler = (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; body: Record<string, unknown> }>;

/**
 * A small MCP server for the link's tests, as the sim's applier serves its own: Streamable HTTP at
 * `/mcp`, 2026-07-28, plain on loopback or with a certificate. Every bearer it
 * was sent is kept. A handler that throws `held` answers -32603 with `data.pending: true`, as the steward
 * answers a define it holds; `not-taken` with `pending: false`; anything else -32603 with no data.
 */
export async function serveTest(handler: Handler, o: { tls?: { cert: string; key: string }; legacyOnly?: boolean } = {}) {
  const bearers: (string | undefined)[] = [];
  const factory = (ctx: { requestInfo?: Request }) => {
    const auth = ctx.requestInfo?.headers.get("authorization");
    bearers.push(auth?.startsWith("Bearer ") ? auth.slice(7) : undefined);
    const server = new Server({ name: "owner-tool-test", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "any", inputSchema: { type: "object" as const } }] }));
    server.setRequestHandler("tools/call", async (req) => {
      let r;
      try {
        r = await handler(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
      } catch (err) {
        if ((err as Error).message === "held") throw new ProtocolError(ProtocolErrorCode.InternalError, "the store did not answer", { pending: true });
        if ((err as Error).message === "not-taken") throw new ProtocolError(ProtocolErrorCode.InternalError, "the store did not answer", { pending: false });
        // As the applier answers a configure that waited past its gate: -32603 and no data.
        throw new ProtocolError(ProtocolErrorCode.InternalError, "internal error");
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(r.body) }], structuredContent: r.body, isError: !r.ok };
    });
    return server;
  };
  const modern = createMcpHandler(factory);
  // `legacyOnly`: only the 2025 handshake, through the SDK's stateless fallback, as the steward's
  // `speaks-only-2025` mutation serves it.
  const handle = toNodeHandler(o.legacyOnly ? { fetch: legacyStatelessFallback(factory) } : modern);
  const validHost = localhostHostValidation();
  const validOrigin = localhostOriginValidation();
  const listener = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (!o.tls && (!validHost(req, res) || !validOrigin(req, res))) return;
    try {
      await handle(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    }
  };
  const http = o.tls ? createHttps({ cert: o.tls.cert, key: o.tls.key }, listener) : createHttp(listener);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `${o.tls ? "https" : "http"}://127.0.0.1:${port}/mcp`,
    localhostUrl: `${o.tls ? "https" : "http"}://localhost:${port}/mcp`,
    bearers,
    close: async () => {
      await modern.close();
      await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); });
    },
  };
}

const run = promisify(execFile);

/** A test CA and a server certificate it signed for 127.0.0.1 and localhost, from the host's openssl. */
export async function testCa(): Promise<{ ca: string; cert: string; key: string }> {
  const dir = await mkdtemp(join(tmpdir(), "owner-tool-ca-"));
  try {
    const f = (n: string) => join(dir, n);
    await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", f("ca.key"),
      "-out", f("ca.pem"), "-days", "1", "-subj", "/CN=owner-tool test CA", "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    await run("openssl", ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", f("server.key"),
      "-out", f("server.csr"), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"]);
    await run("openssl", ["x509", "-req", "-in", f("server.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"), "-CAcreateserial",
      "-out", f("server.pem"), "-days", "1", "-copy_extensions", "copyall"]);
    return { ca: await readFile(f("ca.pem"), "utf8"), cert: await readFile(f("server.pem"), "utf8"), key: await readFile(f("server.key"), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
