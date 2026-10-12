import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutantOf } from "../src/mutations.js";
import { Applier, TOOLS, type ApplierService } from "../src/applier.js";
import { StoreError } from "../src/core/db.js";
import { StoreUnavailable } from "../src/core/errors.js";
import { GATE_MS, Store } from "../src/core/store.js";
import { sameSecret } from "../src/core/secret.js";
import { bearerOf, isLoopback, publicMessage, serveMcp } from "../src/mcp/server.js";
import { memoryDb, migrations } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const OWNER = "owner-credential";
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

async function serve(mutation?: "speaks-only-2025", log?: (line: string) => void) {
  const db = await memoryDb();
  const clock = new FakeClock();
  const store = await Store.open(db, clock, (err) => { throw err; }, { migrations });
  const applier = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo", runId: "r", mutant: mutantOf(mutation) });
  await applier.start();
  const server = await serveMcp(applier, TOOLS, { port: await freePort(), mutant: mutantOf(mutation), ...(log ? { log } : {}) });
  cleanup.push(() => server.close(), () => applier.stop());
  return { url: server.url, db, store, clock };
}

async function connect(url: string, bearer: string, mode: "auto" | "legacy" = "auto", scheme = "Bearer") {
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `${scheme} ${bearer}` } } }));
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any };
  return { client, call };
}

describe("the MCP binding", () => {
  it("serves 2026-07-28, and the 2025 fallback", async () => {
    const { url } = await serve();
    const modern = await connect(url, OWNER);
    expect(modern.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await modern.call("describe")).structuredContent.test_run_id).toBe("r");
    const legacy = await connect(url, OWNER, "legacy");
    expect(legacy.client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect((await legacy.call("describe")).structuredContent.revision).toBe(0);
  });

  it("serves any ApplierService, listing the tools it is given", async () => {
    const seen: unknown[] = [];
    const service: ApplierService = {
      caller: (bearer) => (bearer === OWNER ? { kind: "owner" } : { kind: "anonymous" }),
      call: async (caller, tool, args) => { seen.push({ caller, tool, args }); return { ok: true, body: { echoed: tool } }; },
    };
    const server = await serveMcp(service, [{ name: "echo", readOnly: true, summary: "Echoes", inputSchema: { type: "object", properties: { a: { type: "number" } } } }], { port: await freePort() });
    cleanup.push(() => server.close());
    const { client, call } = await connect(server.url, OWNER);
    expect((await client.listTools()).tools.map((t) => [t.name, t.annotations?.readOnlyHint])).toEqual([["echo", true]]);
    expect((await call("echo", { a: 1 })).structuredContent).toEqual({ echoed: "echo" });
    expect(seen).toEqual([{ caller: { kind: "owner" }, tool: "echo", args: { a: 1 } }]);
  });

  it("serves only the 2025 era under speaks-only-2025", async () => {
    const { url } = await serve("speaks-only-2025");
    expect((await connect(url, OWNER)).client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
  });

  it("lists the ten tools with their hints, and refuses a stranger with not_permitted", async () => {
    const { url } = await serve();
    const { client, call } = await connect(url, "stranger");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["apply", "candidates", "configure", "describe", "events", "history",
      "outcome", "plan", "provision", "state"]);
    expect(tools.find((t) => t.name === "apply")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "state")?.annotations?.readOnlyHint).toBe(true);
    // Typed, self-contained schemas: a small model sends an array as an array only when it sees one.
    for (const t of tools) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(JSON.stringify(t.inputSchema), t.name).not.toContain("$ref");
    }
    expect((tools.find((t) => t.name === "configure")?.inputSchema.properties as Record<string, { type?: unknown }>)?.changes?.type)
      .toBe("array");
    const r = await call("describe");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "not_permitted" });
  });

  it("answers a change the store did not keep in time with an MCP error, never a result", async () => {
    const { url, db, store, clock } = await serve();
    const { call } = await connect(url, OWNER);
    db.trouble.down = true;
    const refused = call("configure", { changes: [], expected_revision: 0, dry_run: false });
    await vi.waitFor(() => expect(store.down).toBe(true));
    clock.advance(GATE_MS);
    await expect(refused).rejects.toThrow();
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    expect((await call("configure", { changes: [], expected_revision: 0, dry_run: false })).isError).toBeFalsy();
  });

  it("reads the bearer scheme in any case (RFC 9110)", async () => {
    const at = (auth?: string) => new Request("http://127.0.0.1/mcp", auth ? { headers: { authorization: auth } } : {});
    expect(bearerOf(at("Bearer x"))).toBe("x");
    expect(bearerOf(at("bearer x"))).toBe("x");
    expect(bearerOf(at("BEARER x"))).toBe("x");
    expect(bearerOf(at("Basic x"))).toBeUndefined();
    expect(bearerOf(at())).toBeUndefined();
    const { url } = await serve();
    expect((await (await connect(url, OWNER, "auto", "bearer")).call("describe")).structuredContent.revision).toBe(0);
  });

  it("compares credentials whole: a different length is a miss, not a throw", () => {
    expect(sameSecret("owner-credential", "owner-credential")).toBe(true);
    expect(sameSecret("owner-credential", "owner-credentiaL")).toBe(false);
    expect(sameSecret("owner-credential", "owner")).toBe(false);
    expect(sameSecret("", "")).toBe(true);
  });

  it("answers an internal error with a message that names no host", () => {
    expect(publicMessage(new StoreUnavailable("the store is unreachable"))).toBe("the store is unreachable");
    expect(publicMessage(new StoreError(new Error("connect ECONNREFUSED 10.9.8.7:5432")))).toBe("the store did not answer");
    expect(publicMessage(new TypeError("postgresql://u:secret@db/x"))).toBe("internal error");
  });

  it("answers a store the reads cannot reach with -32603 and a generic message", async () => {
    const said = vi.fn<(line: string) => void>();
    const { url, db } = await serve(undefined, said);
    const { call } = await connect(url, OWNER);
    {
      db.query = async () => { throw new StoreError(new Error("connect ECONNREFUSED 10.9.8.7:5432")); };
      const failed = await call("history", { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }).catch((err: unknown) => err);
      expect(failed).toMatchObject({ code: -32603 });
      expect(String((failed as Error).message)).toContain("the store did not answer");
      expect(String((failed as Error).message)).not.toContain("10.9.8.7");
      expect(said.mock.calls.flat().join(" ")).toContain("10.9.8.7");
    }
  });

  it("refuses to serve off loopback without TLS", async () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    const clock = new FakeClock();
    const applier = new Applier({ store: await Store.open(await memoryDb(), clock, (err) => { throw err; }, { migrations }), clock,
      ownerCredential: OWNER, applierId: "demo" });
    await expect(serveMcp(applier, TOOLS, { port: await freePort(), host: "0.0.0.0" })).rejects.toThrow(/TLS/);
  });

  it("serves TLS from the PEM contents it is given, reading no file itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "applier-tls-"));
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(dir, "k.pem"),
        "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=applier-test", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
      const cert = readFileSync(join(dir, "c.pem"), "utf8");
      const key = readFileSync(join(dir, "k.pem"), "utf8");
      rmSync(dir, { recursive: true, force: true });
      const clock = new FakeClock();
      const applier = new Applier({ store: await Store.open(await memoryDb(), clock, (err) => { throw err; }, { migrations }), clock,
        ownerCredential: OWNER, applierId: "demo" });
      const server = await serveMcp(applier, TOOLS, { port: await freePort(), tls: { cert, key } });
      cleanup.push(() => server.close());
      expect(server.url).toMatch(/^https:/);
      const status = (ca?: string) => new Promise<number>((resolve, reject) => {
        request(new URL("/elsewhere", server.url), { ca }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end();
      });
      expect(await status(cert)).toBe(404);
      await expect(status()).rejects.toThrow(/self-signed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
