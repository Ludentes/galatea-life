import { createServer as createHttp, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, legacyStatelessFallback, Server } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { ApplierRefused, checkApplierUrl, McpApplierPort } from "../src/link/port.js";
import { privateCa } from "./private-ca.js";

/** An applier's MCP binding in miniature: `describe` answers, `state` refuses; it records each call's revision. */
async function serve(o: { legacyOnly?: boolean; tls?: { key: string; cert: string } } = {}) {
  const seen: (string | null)[] = [];
  const factory = (ctx: { requestInfo?: Request }) => {
    const s = new Server({ name: "fake-applier", version: "0" }, { capabilities: { tools: {} } });
    s.setRequestHandler("tools/list", async () => ({ tools: [] }));
    s.setRequestHandler("tools/call", async (req) => {
      seen.push(ctx.requestInfo?.headers.get("mcp-protocol-version") ?? null);
      const out = req.params.name === "describe" ? { applier_id: "fake", revision: 1 } : { error: "not_permitted", message: "no" };
      return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out, isError: req.params.name !== "describe" };
    });
    return s;
  };
  const mcp = o.legacyOnly ? { fetch: legacyStatelessFallback(factory), close: async () => undefined } : createMcpHandler(factory);
  const handle = toNodeHandler(mcp);
  const listener = (q: IncomingMessage, r: ServerResponse) => void handle(q, r);
  const http = o.tls ? createHttps(o.tls, listener) : createHttp(listener);
  let handshakes = 0;
  http.on("secureConnection", () => handshakes++);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port;
  const close = async () => { await mcp.close(); await new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); }); };
  closers.push(close);
  return { url: new URL(`${o.tls ? "https" : "http"}://127.0.0.1:${port}/mcp`), seen, handshakes: () => handshakes };
}
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

describe("McpApplierPort", () => {
  it("reaches an applier that serves 2026-07-28 at that revision (GA-BIND-2)", async () => {
    const { url, seen } = await serve();
    const port = await McpApplierPort.connect(url, "b");
    expect(port.protocolVersion).toBe("2026-07-28");
    expect((await port.describe()).applier_id).toBe("fake");
    expect(seen).toEqual(["2026-07-28"]);
    await port.close();
  });

  it("falls back to the 2025 handshake for an applier that serves only it, and speaks it when told to", async () => {
    const legacy = await serve({ legacyOnly: true });
    const a = await McpApplierPort.connect(legacy.url, "b");
    expect(a.protocolVersion).toBe("2025-11-25");
    await a.close();
    const modern = await serve();
    const b = await McpApplierPort.connect(modern.url, "b", { legacy: true });
    await b.describe();
    expect(modern.seen).toEqual(["2025-11-25"]);
    await b.close();
  });

  it("gives the applier's request error as ApplierRefused, with its code", async () => {
    const { url } = await serve();
    const port = await McpApplierPort.connect(url, "b");
    await expect(port.state()).rejects.toEqual(expect.objectContaining({ code: "not_permitted" }));
    await expect(port.state()).rejects.toBeInstanceOf(ApplierRefused);
    await port.close();
  });

  it("takes https anywhere, and plain http only on loopback (GA-SEC-2)", () => {
    expect(checkApplierUrl("http://127.0.0.1:8080/mcp").host).toBe("127.0.0.1:8080");
    expect(checkApplierUrl("http://localhost/mcp").hostname).toBe("localhost");
    expect(checkApplierUrl("https://applier.home.arpa/mcp").protocol).toBe("https:");
    expect(() => checkApplierUrl("http://192.0.2.10/mcp")).toThrow(/must be https/);
    expect(() => checkApplierUrl("ftp://127.0.0.1/mcp")).toThrow(/must be https/);
    expect(() => checkApplierUrl("nonsense")).toThrow(/not a URL/);
  });

  it("trusts the CA one link is given, and only that link: another without it refuses the same applier (GA-SEC-2)", async () => {
    const pki = privateCa();
    const { url, seen, handshakes } = await serve({ tls: { cert: pki.cert, key: pki.key } });
    const trusting = await McpApplierPort.connect(url, "b", { ca: pki.ca });
    expect((await trusting.describe()).applier_id).toBe("fake");
    const before = handshakes();
    // A second link in the same process, made while the first is open and after it closed: no CA, no session.
    await expect(McpApplierPort.connect(url, "b")).rejects.toThrow();
    await trusting.close();
    await expect(McpApplierPort.connect(url, "b")).rejects.toThrow();
    expect(handshakes()).toBe(before);
    expect(seen).toHaveLength(1);
    // Nor does anything else in the process trust it: Node's own fetch refuses the certificate.
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("validates against the given CA alone, refusing a certificate another CA signed", async () => {
    const pki = privateCa();
    const other = privateCa();
    const { url, seen } = await serve({ tls: { cert: pki.cert, key: pki.key } });
    // The refusal names its cause, for the steward's log: a certificate no CA it trusts signed.
    await expect(McpApplierPort.connect(url, "b", { ca: other.ca })).rejects.toThrow(/fetch failed: [A-Z_]*(CERT|SIGNATURE|ISSUER)/);
    expect(seen).toEqual([]);
  });

  it("under the mutation trusts-any-applier, that link alone takes any certificate (GA-SEC-2's negative subject)", async () => {
    const pki = privateCa();
    const { url, handshakes } = await serve({ tls: { cert: pki.cert, key: pki.key } });
    const insecure = await McpApplierPort.connect(url, "b", { insecure: true });
    expect((await insecure.describe()).applier_id).toBe("fake");
    expect(handshakes()).toBeGreaterThan(0);
    const after = handshakes();
    await expect(McpApplierPort.connect(url, "b")).rejects.toThrow();
    expect(handshakes()).toBe(after);
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    await insecure.close();
  });
});
