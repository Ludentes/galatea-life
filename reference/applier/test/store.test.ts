import { describe, expect, it, vi } from "vitest";
import { isFault, maskUrls, StoreError, type Tx } from "../src/core/db.js";
import { migrate } from "../src/core/migrate.js";
import { getMeta, raiseMeta, RisingMeta, setMeta, Store, within } from "../src/core/store.js";
import { FIRST_RETRY_MS } from "../src/core/writer.js";
import { CLEAN_STOP } from "../src/core/events.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

async function open() {
  const clock = new FakeClock();
  const db = await memoryDb();
  const faults: unknown[] = [];
  const store = await Store.open(db, clock, (err) => faults.push(err));
  return { clock, db, faults, store };
}

describe("Store", () => {
  it("records its migrations once, in no schema it names, and lets reader read only history_v", async () => {
    const { db, store } = await open();
    expect((await db.query<{ name: string }>("SELECT name FROM migrations")).rows.map((r) => r.name)).toEqual(["0001_skeleton.sql", "0002_bus.sql",
      "0003_declarations_notices.sql", "0004_adoption.sql", "0005_routes.sql", "0006_dispatch.sql",
      "0007_idempotency.sql", "0008_late_acks.sql", "0009_assumed.sql", "0010_occurrences.sql",
      "0011_safety.sql", "0012_rule_disabled.sql", "0013_latches.sql", "0014_load_caps.sql", "0015_restarts.sql", "0016_provisioning.sql",
      "0017_discovery.sql", "0018_undescribed.sql", "0019_hashed_secrets.sql"]);
    await store.write((tx) => setMeta(tx, "revision", "3"));
    expect(await migrate(db)).toEqual([]);
    expect(await getMeta(store, "revision")).toBe("3");
    const grants = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'reader'");
    expect(grants.rows.map((r) => r.table_name)).toEqual(["history_v"]);
  });

  it("commits write sets in the order given", async () => {
    const { store } = await open();
    const done: number[] = [];
    await Promise.all([1, 2, 3].map((n) => store.write((tx) => setMeta(tx, "n", String(n))).then(() => done.push(n))));
    expect(done).toEqual([1, 2, 3]);
    expect(await getMeta(store, "n")).toBe("3");
  });

  it("commits the write sets a group hands as one: all or none (a firing's records, GA-SAFE-3)", async () => {
    const { clock, db, store } = await open();
    await db.query("CREATE TABLE g (k text PRIMARY KEY)");
    db.trouble.failOn = /INSERT INTO g VALUES \('b'\)/;
    let inner: Promise<unknown> | undefined;
    const done = store.group(() => {
      const a = store.write((tx) => tx.query("INSERT INTO g VALUES ('a') ON CONFLICT DO NOTHING").then(() => undefined));
      // A group inside a group is the outer one.
      inner = store.group(() => store.write((tx) => tx.query("INSERT INTO g VALUES ('b') ON CONFLICT DO NOTHING").then(() => undefined)));
      return Promise.all([a, inner]);
    });
    await vi.waitFor(() => expect(store.down).toBe(true));
    expect((await db.query("SELECT k FROM g")).rows).toEqual([]);
    db.trouble.failOn = undefined;
    clock.advance(FIRST_RETRY_MS);
    await done;
    await inner;
    expect((await db.query<{ k: string }>("SELECT k FROM g ORDER BY k")).rows.map((r) => r.k)).toEqual(["a", "b"]);
  });

  it("commits a group after everything handed before it, and what is handed after it after", async () => {
    const { db, store } = await open();
    await db.query("CREATE TABLE g (n serial PRIMARY KEY, k text)");
    const put = (k: string) => store.write((tx) => tx.query("INSERT INTO g (k) VALUES ($1)", [k]).then(() => undefined));
    void put("before");
    void store.group(() => { void put("in 1"); void put("in 2"); });
    await put("after");
    expect((await db.query<{ k: string }>("SELECT k FROM g ORDER BY n")).rows.map((r) => r.k)).toEqual(["before", "in 1", "in 2", "after"]);
  });

  it("retries while the store is down, and commits in order when it is back", async () => {
    const { clock, db, store } = await open();
    db.trouble.down = true;
    const done: string[] = [];
    const a = store.write((tx) => setMeta(tx, "k", "a")).then(() => done.push("a"));
    const b = store.write((tx) => setMeta(tx, "k", "b")).then(() => done.push("b"));
    await vi.waitFor(() => expect(store.down).toBe(true));
    clock.advance(FIRST_RETRY_MS);
    expect(done).toEqual([]);
    expect(store.backlog).toBe(2);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(done).toEqual(["a", "b"]); });
    await Promise.all([a, b]);
    expect(store.down).toBe(false);
    expect(await getMeta(store, "k")).toBe("b");
  });

  it("stops at a fault, tells its owner, and writes nothing after it", async () => {
    const { clock, db, faults, store } = await open();
    db.trouble.fault = "23505";
    void store.write((tx) => setMeta(tx, "k", "refused"));
    void store.write((tx) => setMeta(tx, "k", "after"));
    await vi.waitFor(() => expect(faults).toHaveLength(1));
    expect(faults[0]).toMatchObject({ code: "23505" });
    db.trouble.fault = undefined;
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(store.backlog).toBe(2);
    expect(await getMeta(store, "k")).toBeUndefined();
  });

  it("stops at a write set that throws a bug, tells its owner once, and writes nothing after it", async () => {
    const { clock, faults, store } = await open();
    void store.write(async () => { throw new TypeError("a bug in a step"); });
    void store.write((tx) => setMeta(tx, "k", "after"));
    await vi.waitFor(() => expect(faults).toHaveLength(1));
    expect(faults[0]).toBeInstanceOf(TypeError);
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(faults).toHaveLength(1);
    expect(store.down).toBe(false);
    expect(await getMeta(store, "k")).toBeUndefined();
  });

  it("marks what the store says as the store's, and a fault stays a fault", async () => {
    const { db } = await open();
    db.trouble.down = true;
    await expect(db.query("SELECT 1")).rejects.toBeInstanceOf(StoreError);
    db.trouble.down = false;
    const refused = await db.query("SELECT * FROM no_such_table").catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(StoreError);
    expect(isFault(refused)).toBe(true);
    expect(isFault(new StoreError(Object.assign(new Error("gone"), { code: "ECONNREFUSED" })))).toBe(false);
  });

  it("logs once when the store goes away, and once when it is back, with no URL", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { clock, db, store } = await open();
      db.trouble.down = true;
      const w = store.write((tx) => setMeta(tx, "k", "a"));
      await vi.waitFor(() => expect(store.down).toBe(true));
      clock.advance(FIRST_RETRY_MS);
      await vi.waitFor(() => { clock.advance(FIRST_RETRY_MS * 2); expect(said.mock.calls.length).toBeGreaterThan(0); });
      clock.advance(1000);
      await new Promise((r) => setTimeout(r, 20));
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual(["store unreachable, retrying: the store is unreachable"]);
      db.trouble.down = false;
      await vi.waitFor(() => { clock.advance(5000); expect(store.backlog).toBe(0); });
      await w;
      expect(said.mock.calls.map((c) => String(c[0]))).toEqual(["store unreachable, retrying: the store is unreachable", "store back"]);
    } finally {
      said.mockRestore();
    }
  });

  it("masks a database URL in what it logs", () => {
    expect(maskUrls("connect to postgresql://u:secret@db:5432/x failed")).toBe("connect to <url> failed");
  });

  it("tells a fault from a failure that passes", () => {
    expect(isFault({ severity: "ERROR", code: "23505" })).toBe(true);   // unique violation
    expect(isFault({ severity: "ERROR", code: "42501" })).toBe(true);   // insufficient privilege
    expect(isFault({ severity: "FATAL", code: "57P01" })).toBe(false);  // the server is shutting down
    expect(isFault({ severity: "ERROR", code: "53100" })).toBe(false);  // the disk is full
    expect(isFault({ severity: "ERROR", code: "57014" })).toBe(false);  // statement_timeout
    expect(isFault(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(false);
  });

  it("gives up waiting at the deadline, on the clock", async () => {
    const clock = new FakeClock();
    const late = within(clock, 10_000, new Promise(() => undefined));
    clock.advance(10_000);
    await expect(late).rejects.toThrow("not known");
    expect(await within(clock, 10_000, Promise.resolve(1))).toBe(1);
  });
});

describe("RisingMeta", () => {
  it("writes the last value served, even when it moved while its write was in flight", async () => {
    const clock = new FakeClock();
    const db = await memoryDb();
    let release!: () => void;
    let held: Promise<void> | undefined;
    const hold = () => { held = new Promise<void>((r) => { release = r; }); };
    const gated = { ...db, transaction: async <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(async (tx) => {
      const r = await fn(tx);
      if (held) await held;
      return r;
    }) };
    const store = await Store.open(gated, clock, (err) => { throw err; });
    let value = 1;
    const meta = new RisingMeta(store, "counter", () => value);
    hold();
    meta.schedule();
    // The write has read 1 and waits to commit; the value moves on meanwhile.
    await new Promise((r) => setTimeout(r, 20));
    value = 2;
    meta.schedule();
    value = 3;
    meta.schedule();
    held = undefined;
    release();
    await vi.waitFor(async () => { await store.settled(); expect(await getMeta(store, "counter")).toBe("3"); });
    await store.close();
    // A write that lands after a higher one never lowers it.
    const again = await memoryDb();
    const s2 = await Store.open(again, clock, (err) => { throw err; });
    await s2.write((tx) => raiseMeta(tx, "counter", 5));
    await s2.write((tx) => raiseMeta(tx, "counter", 4));
    expect(await getMeta(s2, "counter")).toBe("5");
  });

  it("lands a write re-queued because the value moved before close()'s clean-stop marker", async () => {
    const clock = new FakeClock();
    const db = await memoryDb();
    const written: string[] = [];
    let release!: () => void;
    let held: Promise<void> | undefined;
    const gated = { ...db, close: async () => undefined, transaction: async <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(async (tx) => {
      const seen: string[] = [];
      const r = await fn({ ...tx, query: (sql: string, params?: unknown[]) => {
        seen.push(params?.[0] === "counter" ? `counter ${String(params[1])}` : params?.[0] === CLEAN_STOP ? "clean stop" : "other");
        return tx.query(sql, params);
      } } as Tx);
      if (held) await held;
      written.push(...seen);
      return r;
    }) };
    const store = await Store.open(gated, clock, (err) => { throw err; });
    let value = 1;
    const meta = new RisingMeta(store, "counter", () => value);
    held = new Promise<void>((r) => { release = r; });
    meta.schedule();
    // The write has read 1 and waits to commit; the value moves, and the store is closed meanwhile.
    await new Promise((r) => setTimeout(r, 20));
    value = 2;
    meta.schedule();
    const closed = store.close();
    held = undefined;
    release();
    await closed;
    expect(written.filter((w) => w !== "other")).toEqual(["counter 1", "counter 2", "clean stop"]);
    expect(await getMeta(db, "counter")).toBe("2");
  });
});
