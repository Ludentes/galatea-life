import { describe, expect, it, vi } from "vitest";
import { EventLog, EVENT_RETENTION_MS, HISTORY_RETENTION_MS, SEQ_LIFE_GAP } from "../src/core/events.js";
import { Store } from "../src/core/store.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

async function db2meta(db: { query<R>(sql: string): Promise<{ rows: R[] }> }): Promise<Record<string, string>> {
  const r = await db.query<{ key: string; value: string }>("SELECT key, value FROM meta");
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}

async function setup() {
  const clock = new FakeClock();
  const db = lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; });
  const log = new EventLog(store, clock);
  await log.load();
  return { clock, db, store, log };
}

describe("EventLog", () => {
  it("gives the current cursor, then the events after it, with seq and the clock's time", async () => {
    const { clock, log } = await setup();
    const c = log.cursor();
    const e = log.append("model", { revision: 1 });
    expect(e).toEqual({ seq: Number(c) + 1, time: new Date(clock.now()).toISOString(), type: "model", revision: 1 });
    expect(log.read(c)).toEqual([e]);
    expect(log.read(log.cursor())).toEqual([]);
  });

  it("serves an event 1 ms short of the retention, and calls an older cursor cursor_expired", async () => {
    const { clock, log } = await setup();
    const c = log.cursor();
    log.append("model", { revision: 1 });
    clock.advance(EVENT_RETENTION_MS - 1);
    expect(log.read(c)).toHaveLength(1);
    clock.advance(2);
    expect(() => log.read(c)).toThrow(expect.objectContaining({ code: "cursor_expired" }));
    log.prune();
    expect(() => log.read(c)).toThrow(expect.objectContaining({ code: "cursor_expired" }));
  });

  it("refuses a cursor that is not a number; one ahead of the log is another store's", async () => {
    const { log } = await setup();
    expect(() => log.read("abc")).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => log.read(String(Number(log.cursor()) + 1))).toThrow(expect.objectContaining({ code: "cursor_expired" }));
  });

  it("serves events while the store is down, and writes them when it is back", async () => {
    const { clock, db, store, log } = await setup();
    const c = log.cursor();
    db.trouble.down = true;
    log.append("model", { revision: 1 });
    expect(log.read(c)).toHaveLength(1);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    expect((await log.history(0, Number.MAX_SAFE_INTEGER)).map((e) => e.revision)).toEqual([1]);
  });

  it("after a clean stop, starts each life past any seq the last one handed out, and serves the last hour again", async () => {
    const { clock, db, store, log } = await setup();
    const c = log.cursor();
    const kept = log.append("model", { revision: 1 });
    await store.close();
    const again = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock);
    await again.load();
    expect(again.lastStopClean).toBe(true);
    expect(Number(again.cursor())).toBe(kept.seq + SEQ_LIFE_GAP);
    expect(again.read(c)).toEqual([kept]);
    // Handed out by the last life and never used: a cursor on it reads the new life's events.
    const next = again.append("model", { revision: 2 });
    expect(again.read(String(kept.seq + 1))).toEqual([next]);
  });

  it("after a stop that was not clean, expires every cursor of the last life, the lost event's included", async () => {
    const { clock, db, store, log } = await setup();
    const c = log.cursor();
    const kept = log.append("model", { revision: 1 });
    await store.settled();
    // Served, never written: the process died with it in the writer's line.
    db.trouble.down = true;
    const lost = log.append("model", { revision: 2 });
    db.trouble.down = false;
    const again = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock);
    await again.load();
    expect(again.lastStopClean).toBe(false);
    for (const cursor of [c, String(kept.seq), String(lost.seq)]) {
      expect(() => again.read(cursor)).toThrow(expect.objectContaining({ code: "cursor_expired" }));
    }
    expect(again.read(again.cursor())).toEqual([]);
  });

  it("counts a fresh store as a clean last life", async () => {
    const { log } = await setup();
    expect(log.lastStopClean).toBe(true);
  });

  it("clears the clean-stop marker at start, so a second unclean stop is not taken as clean", async () => {
    const { clock, db, store } = await setup();
    await store.close();
    const second = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock);
    await second.load();
    const c = second.cursor();
    const third = new EventLog(await Store.open(db, clock, (err) => { throw err; }), clock);
    await third.load();
    expect(third.lastStopClean).toBe(false);
    expect(() => third.read(c)).toThrow(expect.objectContaining({ code: "cursor_expired" }));
  });

  it("leaves no clean-stop marker when the backlog did not commit in time", async () => {
    const { clock, db, store, log } = await setup();
    db.trouble.down = true;
    log.append("model", { revision: 1 });
    const closing = store.close(3000);
    clock.advance(3000);
    await closing;
    db.trouble.down = false;
    expect((await db2meta(db)).clean_stop).toBeUndefined();
  });

  it("never lets a body's seq, time or type overwrite the event's own, served or read back", async () => {
    const { clock, log } = await setup();
    const t0 = clock.now();
    const e = log.append("bridge_fault", { bridge: "b", seq: 7, time: "1999-01-01T00:00:00.000Z", type: "state", what: "x" });
    expect(e).toEqual({ seq: e.seq, time: new Date(t0).toISOString(), type: "bridge_fault", bridge: "b", what: "x" });
    expect(e.seq).not.toBe(7);
    expect(await log.history(t0, t0)).toEqual([e]);
  });

  it("keeps a state event's speech out of history and out of history_v (GA-EVT-5)", async () => {
    const { db, log } = await setup();
    log.append("state", { target: "demo:lamp", key: "speech", value: "hello" });
    const on = log.append("state", { target: "demo:lamp", key: "on", value: true });
    log.append("notice", { text: "not a history kind" });
    expect((await log.history(0, Number.MAX_SAFE_INTEGER)).map((e) => e.seq)).toEqual([on.seq]);
    const view = await db.query<{ seq: number }>("SELECT seq FROM history_v ORDER BY seq");
    expect(view.rows.map((r) => Number(r.seq))).toEqual([on.seq]);
  });

  it("keeps an occurrence in history and history_v, but one given as events only, a personal key's, in events alone (GA-EVT-5)", async () => {
    const { db, log } = await setup();
    const kept = log.append("occurrence", { target: "demo:sensor", key: "org.galatea.test.vibration.alarm", value: true, cause: "device" });
    const personal = log.append("occurrence", { target: "demo:bed", key: "org.galatea.test.bed.turned", value: true, cause: "device" },
      { eventsOnly: true });
    expect(log.read(String(kept.seq - 1)).map((e) => e.seq)).toEqual([kept.seq, personal.seq]);
    expect((await log.history(0, Number.MAX_SAFE_INTEGER)).map((e) => e.seq)).toEqual([kept.seq]);
    const view = await db.query<{ seq: number }>("SELECT seq FROM history_v ORDER BY seq");
    expect(view.rows.map((r) => Number(r.seq))).toEqual([kept.seq]);
  });

  it("leaves out of history what the caller hides as it stands now: an occurrence of a key personal since (GA-EVT-5)", async () => {
    const { log } = await setup();
    const a = log.append("occurrence", { target: "demo:sensor", key: "org.galatea.test.vibration.alarm", value: true, cause: "device" });
    const b = log.append("occurrence", { target: "demo:sensor", key: "org.galatea.test.vibration.presence", value: true, cause: "device" });
    const hidden = (e: { key?: unknown }) => e.key === "org.galatea.test.vibration.presence";
    expect((await log.history(0, Number.MAX_SAFE_INTEGER, undefined, hidden)).map((e) => e.seq)).toEqual([a.seq]);
    expect((await log.history(0, Number.MAX_SAFE_INTEGER)).map((e) => e.seq)).toEqual([a.seq, b.seq]);
  });

  it("releases a waiter on the next event, or at its timeout on the clock", async () => {
    const { clock, log } = await setup();
    const w1 = log.wait(30_000);
    log.append("model", { revision: 1 });
    await w1;
    const w2 = log.wait(1000);
    clock.advance(1000);
    await w2;
  });

  it("returns history in a range, filtered by target, and prunes after 7 days", async () => {
    const { clock, log } = await setup();
    const t0 = clock.now();
    const a = log.append("model", { revision: 1 });
    const b = log.append("state", { target: "b:lamp", key: "on", value: true, cause: "external" });
    const c = log.append("state", { target: "b:tv", key: "on", value: true, cause: "external" });
    expect((await log.history(t0, t0 + 1)).map((e) => e.seq)).toEqual([a.seq, b.seq, c.seq]);
    expect((await log.history(t0, t0 + 1, ["b:lamp"])).map((e) => e.seq)).toEqual([b.seq]);
    // A provision event names its transport (slice 5a): `history` with that target returns it.
    const p = log.append("provision", { transport: "b:radio", devices: [], cause: { bridge: "b" } });
    expect((await log.history(t0, t0 + 1, ["b:radio"])).map((e) => e.seq)).toEqual([p.seq]);
    clock.advance(HISTORY_RETENTION_MS + 1);
    log.prune();
    expect(await log.history(t0, clock.now())).toEqual([]);
  });

  it("filters history's kinds and targets in the store, then refuses a range holding more than the limit (the whole-applier review's M4)", async () => {
    const { clock, log } = await setup();
    const t0 = clock.now();
    // Rows the filters leave out count for nothing toward the limit: they are never read.
    for (let i = 0; i < 5; i++) log.append("state", { target: "b:tv", key: "on", value: i % 2 === 0, cause: "external" });
    log.append("notice", { target: "b:lamp", text: "not a history kind" });
    log.append("state", { target: "b:lamp", key: "speech", value: "hello", cause: "device" });
    log.append("transport", { transport: "b:lamp", up: true, state: "up" });
    const lamp = log.append("state", { target: "b:lamp", key: "on", value: true, cause: "external" });
    const fired = log.append("rule_fired", { rule_id: "r", devices: ["b:leak", "b:lamp"] });
    const model = log.append("model", { revision: 2, device: "b:lamp" });
    const radio = log.append("provision", { transport: "b:lamp", devices: [], cause: { bridge: "b" } });
    expect((await log.history(t0, t0 + 1, ["b:lamp"], undefined, 4)).map((e) => e.seq)).toEqual([lamp.seq, fired.seq, model.seq, radio.seq]);
    await expect(log.history(t0, t0 + 1, ["b:lamp"], undefined, 3))
      .rejects.toMatchObject({ code: "invalid_request", message: expect.stringMatching(/more than 3 events/) });
    // In order, oldest first, across every target when none is named.
    const all = (await log.history(t0, t0 + 1)).map((e) => e.seq);
    expect(all).toEqual([...all].sort((x, y) => x - y));
    // The five on the tv, the transport event, and the four on the lamp; not the notice, not the speech.
    expect(all).toHaveLength(10);
  });

  it("floors a fractional clock reading before it reaches the store's bigint time_ms", async () => {
    class Fractional extends FakeClock { now(): number { return super.now() + 0.4375; } }
    const clock = new Fractional();
    const faults: unknown[] = [];
    const store = await Store.open(await memoryDb(), clock, (err) => { faults.push(err); });
    const log = new EventLog(store, clock);
    await log.load();
    const e = log.append("model", { revision: 1 });
    log.prune();
    await store.settled();
    expect(faults).toEqual([]);
    expect((await log.history(0, Number.MAX_SAFE_INTEGER)).map((x) => x.seq)).toEqual([e.seq]);
  });
});
