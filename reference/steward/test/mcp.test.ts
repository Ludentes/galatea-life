import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreError } from "../src/core/db.js";
import { OutcomeUnknown, StoreUnavailable } from "../src/core/errors.js";
import { Store } from "../src/core/store.js";
import { bearerOf, isLoopback, publicMessage, serveMcp } from "../src/mcp/server.js";
import type { Mutation } from "../src/mutations.js";
import { Steward } from "../src/steward.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS } from "./house.js";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const freePort = () => new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

async function serve(mutation?: Mutation) {
  const db = await memoryDb();
  const clock = new FakeClock();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const steward = new Steward({ store, clock, stewardId: "demo", ownerCredential: SECRETS.owner, runId: "r", mutation });
  await steward.start();
  const server = await serveMcp(steward, { port: await freePort() });
  cleanup.push(() => server.close(), () => steward.stop());
  return { url: server.url, db, store, clock };
}

async function connect(url: string, bearer: string, mode: "auto" | "legacy" = "auto") {
  const client = new Client({ name: "test", version: "0.0.0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any };
  return { client, call };
}

describe("the MCP binding", () => {
  it("serves 2026-07-28, and the 2025 fallback (GA-BIND-2)", async () => {
    const { url } = await serve();
    const modern = await connect(url, SECRETS.owner);
    expect(modern.client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect((await modern.call("describe")).structuredContent.test_run_id).toBe("r");
    const legacy = await connect(url, SECRETS.owner, "legacy");
    expect(legacy.client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect((await legacy.call("describe")).structuredContent.revision).toBe(0);
  });

  it("serves only the 2025 era under speaks-only-2025", async () => {
    const { url } = await serve("speaks-only-2025");
    expect((await connect(url, SECRETS.owner)).client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
  });

  it("lists the standard's seventeen operations with their hints, and refuses a stranger with not_permitted (GA-AUTH-4)", async () => {
    const { url } = await serve();
    const { client, call } = await connect(url, "stranger");
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(17);
    const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const n of ["describe", "state", "plan", "outcome", "events", "history", "scenario_status", "scenario_plan", "zone_sources"]) {
      expect(hints(n), n).toEqual({ readOnlyHint: true });
    }
    for (const n of ["answer", "apply", "scenario_run", "scenario_stop", "define", "narrow"]) expect(hints(n), n).toEqual({ destructiveHint: true });
    for (const n of ["front_status", "speaking"]) expect(hints(n), n).toEqual({ destructiveHint: false });
    const r = await call("describe");
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: "not_permitted" });
  });

  it("answers a define refused while the store is down with -32603 and pending false, never a result", async () => {
    const { url, db, store } = await serve();
    const { call } = await connect(url, SECRETS.owner);
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(call("define", { endpoint: "owner-app", changes: [], expected_revision: 0, dry_run: false }))
      .rejects.toEqual(expect.objectContaining({ code: -32603, data: { pending: false } }));
  });

  it("serves plain HTTP only on loopback, and tells a caller nothing of the store's address", async () => {
    expect([isLoopback("127.0.0.1"), isLoopback("::1"), isLoopback("localhost"), isLoopback("192.0.2.1")]).toEqual([true, true, true, false]);
    const db = await memoryDb();
    const clock = new FakeClock();
    const steward = new Steward({ store: await Store.open(db, clock, (e) => { throw e; }), clock, stewardId: "demo" });
    await expect(serveMcp(steward, { port: await freePort(), host: "192.0.2.1" })).rejects.toThrow(/without TLS \(GA-SEC-2\)/);
    expect(publicMessage(new StoreError(new Error("connect to db.home:5432 failed")))).toBe("the store did not answer");
    expect(publicMessage(new StoreUnavailable("held"))).toBe("held");
    // A lost applier answer is no store fault: a catch of StoreUnavailable never takes it.
    expect(publicMessage(new OutcomeUnknown("lost"))).toBe("lost");
    expect(new OutcomeUnknown("lost")).not.toBeInstanceOf(StoreUnavailable);
    expect(bearerOf(new Request("http://x", { headers: { authorization: "bearer abc" } }))).toBe("abc");
  });
});
