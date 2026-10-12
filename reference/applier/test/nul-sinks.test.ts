import { describe, expect, it } from "vitest";
import { Applier, type ToolResult } from "../src/applier.js";
import { EventLog } from "../src/core/events.js";
import { Notices } from "../src/core/notices.js";
import { Store } from "../src/core/store.js";
import { memoryDb, migrations } from "./db.js";
import { FakeClock } from "./fake-clock.js";

/**
 * U+0000 fits neither `text` nor `jsonb`, and `jsonb` refuses a lone surrogate: a statement holding
 * either stops the writer, and the process build exits on it. Neither a bridge's message nor an
 * owner's change may get one to the store (the whole-applier review's I1, from its NUL probe).
 */
const OWNER = "owner-credential";
const T = "2030-01-01T08:00:00.000Z";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

async function make() {
  const clock = new FakeClock();
  const faults: unknown[] = [];
  const db = await memoryDb();
  const store = await Store.open(db, clock, (err) => { faults.push(err); }, { migrations });
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1" });
  await a.start();
  const owner = a.caller(OWNER);
  const configure = async (changes: unknown[]) => {
    const { revision } = body(await a.call(owner, "describe", {}));
    return a.call(owner, "configure", { changes, expected_revision: revision, dry_run: false });
  };
  const send = (path: string, b: unknown) => a.home.message("hall-bridge", path, Buffer.from(JSON.stringify(b)), false);
  return { a, store, clock, faults, owner, configure, send };
}

const status = { v: 1, bridgeId: "hall-bridge", instanceId: "11111111-1111-4111-8111-111111111111", state: "online",
  version: "1", levels: ["Serve"], faults: [], ungoverned: [], blocked: [], transports: [], devices: [], publishedAt: T };

describe("a string the store cannot keep", () => {
  it("from a bridge: an occurrence and an undescribed event naming a device with U+0000 are faults, and the writer goes on", async () => {
    const { a, store, faults, owner, configure, send } = await make();
    body(await configure([{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } }]));
    a.listening("hall");
    send("status", status);
    const { cursor } = body(await a.call(owner, "events", {}));
    send("event", { seq: 1, instanceId: status.instanceId, type: "occurrence", device: "x\u0000y", key: "k\u0000", value: 1, timestamp: T });
    send("event", { seq: 2, instanceId: status.instanceId, type: "undescribed", device: "x\ud800y", name: "n", timestamp: T });
    await store.settled();
    expect(faults).toEqual([]);
    expect(store.down).toBe(false);
    const said = body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === "bridge_fault");
    expect(said).toHaveLength(2);
    for (const e of said) expect(JSON.stringify(e)).not.toMatch(/\\u0000|\\ud800/);
    // The writer still takes what comes after.
    body(await configure([{ op: "upsert", kind: "client", value: { id: "h", credential: "h-credential-0001", kind: "steward" } }]));
    expect(faults).toEqual([]);
  });

  it("from the owner: configure refuses a change holding U+0000 or a lone surrogate, and the writer goes on", async () => {
    const { store, faults, configure } = await make();
    for (const id of ["st\u0000ew", "st\udc00ew"]) {
      const r = await configure([{ op: "upsert", kind: "client", value: { id, credential: "client-secret-0001", kind: "steward" } }]);
      expect(r).toMatchObject({ ok: false, error: "invalid_request" });
    }
    body(await configure([{ op: "upsert", kind: "client", value: { id: "h", credential: "h-credential-0001", kind: "steward" } }]));
    await store.settled();
    expect(faults).toEqual([]);
  });

  it("the event log and the notices keep whatever they are given, U+0000 and lone surrogates replaced", async () => {
    const clock = new FakeClock();
    const faults: unknown[] = [];
    const store = await Store.open(await memoryDb(), clock, (err) => { faults.push(err); }, { migrations });
    const log = new EventLog(store, clock);
    await log.load();
    const e = log.append("bridge_fault", { bridge: "b\u0000", what: "x\ud800", list: ["\u0000"], ["k\u0000"]: 1 });
    const notices = new Notices(store, clock);
    const n = notices.raise({ cause: "store", text: "t\u0000\udfff" }, "key\u0000");
    await store.settled();
    expect(faults).toEqual([]);
    expect(e).toMatchObject({ bridge: "b�", what: "x�", list: ["�"], ["k�"]: 1 });
    expect(n?.text).toBe("t��");
    const kept = await store.query<{ body: Record<string, unknown> }>("SELECT body FROM events WHERE type = 'bridge_fault'");
    expect(kept.rows[0]?.body).toMatchObject({ bridge: "b�", what: "x�" });
    const held = await store.query<{ key: string; body: { text: string } }>("SELECT key, body FROM notices");
    expect(held.rows[0]).toMatchObject({ key: "key�", body: { text: "t��" } });
    // A key raised again in its own spelling still stands.
    expect(notices.raise({ cause: "store", text: "again" }, "key\u0000")).toBeUndefined();
  });
});
