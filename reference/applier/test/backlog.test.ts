import { describe, expect, it, vi } from "vitest";
import { EventLog, SEQ_LIFE_GAP } from "../src/core/events.js";
import { getMeta, setMeta, Store } from "../src/core/store.js";
import { BACKLOG_CAP } from "../src/core/writer.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const CAP = 5;

async function setup() {
  const clock = new FakeClock();
  const db = lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; }, { backlogCap: CAP });
  const log = new EventLog(store, clock);
  await log.load();
  let full = 0;
  store.onFull = () => { full++; };
  /** Brings the store back, and waits until everything handed over has committed. */
  const back = async () => {
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(5000); expect(store.backlog).toBe(0); });
  };
  return { clock, db, store, log, full: () => full, back };
}

describe("the writer's backlog cap (the maintainer, 2026-09-29)", () => {
  it("is below the million a life's seq moves by", () => {
    expect(BACKLOG_CAP).toBeLessThan(SEQ_LIFE_GAP);
  });

  it("drops only droppable write sets past the cap, and tells its owner once while it is reached", async () => {
    const { db, store, full, back } = await setup();
    db.trouble.down = true;
    const kept: Promise<void>[] = [];
    for (let i = 0; i < CAP; i++) void store.write((tx) => setMeta(tx, `d${i}`, "1"), { droppable: true });
    await expect(store.write((tx) => setMeta(tx, "dropped", "1"), { droppable: true })).resolves.toBeUndefined();
    kept.push(store.write((tx) => setMeta(tx, "owner", "1")));
    void store.write((tx) => setMeta(tx, "dropped-too", "1"), { droppable: true });
    expect([store.backlog, store.dropped, full()]).toEqual([CAP + 1, 2, 1]);
    await back();
    await Promise.all(kept);
    expect([await getMeta(store, "d4"), await getMeta(store, "owner"), await getMeta(store, "dropped")]).toEqual(["1", "1", undefined]);
    // The line emptied: reaching the cap again is told again.
    db.trouble.down = true;
    for (let i = 0; i <= CAP; i++) void store.write((tx) => setMeta(tx, `e${i}`, "1"), { droppable: true });
    expect(full()).toBe(2);
    await back();
  });

  it("keeps last_seq past every seq served though event rows were dropped, and leaves no clean-stop marker", async () => {
    const { clock, db, store, log, back } = await setup();
    db.trouble.down = true;
    const c = log.cursor();
    let last = 0;
    for (let i = 0; i < 3 * CAP; i++) last = log.append("model", { revision: i }).seq;
    // Served from memory all the same.
    expect(log.read(c)).toHaveLength(3 * CAP);
    await back();
    expect(Number(await getMeta(store, "last_seq"))).toBe(last);
    const rows = await store.query<{ n: number | string }>("SELECT count(*) AS n FROM events");
    expect(Number(rows.rows[0]!.n)).toBeLessThan(3 * CAP);
    await store.close();
    expect(await getMeta(db, "clean_stop")).toBeUndefined();
    // So the next life expires every cursor of this one, as after a stop that was not clean.
    const again = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock);
    await again.load();
    expect(again.lastStopClean).toBe(false);
    expect(Number(again.cursor())).toBe(last + SEQ_LIFE_GAP);
    expect(() => again.read(String(last))).toThrow(expect.objectContaining({ code: "cursor_expired" }));
  });

  it.each([undefined, "skips-lost-events"] as const)(
    "expires every cursor of a life that did not stop clean; mutation %s reads on past the events it lost (GA-EVT-4)", async (mutation) => {
      const { clock, db, log } = await setup();
      const cursor = log.cursor();
      // Served from memory while the store is down, never written: then the process dies.
      db.trouble.down = true;
      log.append("model", { revision: 1 });
      expect(log.read(cursor)).toHaveLength(1);
      db.trouble.down = false;
      const again = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock, mutation);
      await again.load();
      if (mutation) expect(again.read(cursor)).toEqual([]);
      else expect(() => again.read(cursor)).toThrow(expect.objectContaining({ code: "cursor_expired" }));
    });

  it("queues one write of last_seq at a time, whatever the events", async () => {
    const { db, store, log, back } = await setup();
    db.trouble.down = true;
    for (let i = 0; i < 3 * CAP; i++) log.append("model", { revision: i });
    // The first event row, one write of last_seq, and event rows up to the cap: the rest were dropped.
    expect(store.backlog).toBe(CAP);
    expect(store.dropped).toBe(3 * CAP - (CAP - 1));
    await back();
  });
});
