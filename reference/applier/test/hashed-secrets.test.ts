import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Applier, type BusPort, type ToolResult } from "../src/applier.js";
import { migrate } from "../src/core/migrate.js";
import { hashSecret } from "../src/core/secret.js";
import { Store } from "../src/core/store.js";
import { blankDb, lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

// The whole-applier review's M6: the secrets the applier only compares are kept as SHA-256 digests,
// a client's bearer credential and a keyed provisioning request's body (a Matter setup code).

const OWNER = "owner-credential-of-the-test";
const T = "2030-01-01T08:00:00.000Z";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };
const sha = (s: string) => hashSecret(s);

async function make(db: Awaited<ReturnType<typeof memoryDb>>, fresh = true) {
  const clock = new FakeClock();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const sent: Record<string, any>[] = [];
  const bus: BusPort = { follow: () => undefined, snapshot: async () => ({ kind: "ok" }), command: async () => ({ kind: "ok" }),
    request: async (_b, _op, req) => { sent.push(req); return { kind: "ok" }; } };
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1", bus });
  await a.start();
  const owner = a.caller(OWNER);
  if (fresh) {
    const { revision } = body(await a.call(owner, "describe", {}));
    body(await a.call(owner, "configure", { expected_revision: revision, dry_run: false, changes: [
      { op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } },
      { op: "upsert", kind: "client", value: { id: "h", credential: "h-credential-0001", kind: "steward", token_key: "h-token-key-00001" } }] }));
  }
  return { a, store, clock, owner, sent };
}

describe("secrets kept as digests", () => {
  it("keeps a client's credential as its SHA-256 only, takes the bearer by it, and again after a restart", async () => {
    const db = await memoryDb();
    const m = await make(lasting(db));
    await m.store.settled();
    const rows = (await db.query<Record<string, unknown>>("SELECT * FROM clients")).rows;
    expect(rows).toEqual([{ id: "h", credential_sha256: sha("h-credential-0001"), token_key: "h-token-key-00001", kind: "steward" }]);
    expect(JSON.stringify(rows)).not.toContain("h-credential-0001");
    expect(m.a.caller("h-credential-0001")).toEqual({ kind: "client", id: "h" });
    // The digest itself is no bearer.
    expect(m.a.caller(sha("h-credential-0001"))).toEqual({ kind: "anonymous" });
    m.a.stop();
    await m.store.close();
    const again = await make(db, false);
    expect(again.a.caller("h-credential-0001")).toEqual({ kind: "client", id: "h" });
    // A second client may not hold the same credential, judged by the digests.
    const { revision } = body(await again.a.call(again.owner, "describe", {}));
    expect(await again.a.call(again.owner, "configure", { expected_revision: revision, dry_run: false, changes: [
      { op: "upsert", kind: "client", value: { id: "k", credential: "h-credential-0001", kind: "steward" } }] }))
      .toMatchObject({ ok: false, error: "invalid_request", message: expect.stringContaining("already holds that credential") });
  });

  it("keeps a keyed commission's body as its SHA-256, never the setup code, and still answers a repeat and a conflict by it", async () => {
    const db = await memoryDb();
    const m = await make(db);
    const at = new Date(m.clock.now()).toISOString();
    m.a.home.message("hall-bridge", "status", Buffer.from(JSON.stringify({ bridgeId: "hall-bridge", instanceId: "11111111-1111-4111-8111-111111111111",
      v: 1, state: "online", version: "1", levels: ["Serve", "Provision"], faults: [], ungoverned: [], blocked: [],
      transports: [{ id: "matter", kind: "matter", state: "up", since: T }], devices: [], publishedAt: at })), false);
    m.a.listening("hall");
    const ask = (code: string) => m.a.call(m.owner, "provision", { idempotency_key: "k1", commission: { transport: "hall:matter", code } });
    const first = ask("34970112332");
    await vi.waitFor(() => expect(m.sent).toHaveLength(1));
    m.a.home.message("hall-bridge", "reply", Buffer.from(JSON.stringify({ requestId: m.sent[0]!.requestId, op: "commission", status: "accepted" })), false);
    const r = body(await first);
    await m.store.settled();
    const kept = (await db.query<{ body: string }>("SELECT body FROM provisions WHERE idempotency_key = 'k1'")).rows;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.body).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await db.query("SELECT * FROM provisions")).rows)).not.toContain("34970112332");
    expect(body(await ask("34970112332")).request_id).toBe(r.request_id);
    expect(await ask("20202021000")).toMatchObject({ ok: false, error: "idempotency_conflict" });
  });

  it("migrates the plaintext an earlier store kept to its digests", async () => {
    const db = await blankDb();
    const all = new URL("../migrations/", import.meta.url);
    const before = mkdtempSync(join(tmpdir(), "galatea-migrations-"));
    try {
      cpSync(all, before, { recursive: true, filter: (src) => !src.endsWith("0019_hashed_secrets.sql") });
      await migrate(db, pathToFileURL(`${before}/`));
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
    await db.query("INSERT INTO clients (id, credential, token_key, kind) VALUES ('h', 'plain-credential-1', NULL, 'steward')");
    await db.query("INSERT INTO provisions (request_id, op, bridge, idempotency_key, body, result, created_ms) "
      + "VALUES ('r1', 'commission', 'hall', 'k1', '{\"commission\":{\"code\":\"MT:secret\"}}', '{}', 1), ('r2', 'join', 'hall', NULL, NULL, '{}', 1)");
    expect(await migrate(db, all)).toEqual(["0019_hashed_secrets.sql"]);
    expect((await db.query("SELECT id, credential_sha256 FROM clients")).rows).toEqual([{ id: "h", credential_sha256: sha("plain-credential-1") }]);
    expect((await db.query("SELECT request_id, body FROM provisions ORDER BY request_id")).rows)
      .toEqual([{ request_id: "r1", body: sha("{\"commission\":{\"code\":\"MT:secret\"}}") }, { request_id: "r2", body: null }]);
  });
});
