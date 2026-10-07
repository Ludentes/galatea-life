import { describe, expect, it } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { getMeta } from "../src/core/store.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, rf, status } from "./safe-home.js";

// covers: GA-LOAD-2, the cap's turn-off, its retries and notices, and max_on_s; the on-time, the cap and the
// clock's last reading kept across a restart (slice 7b).

type Home = Awaited<ReturnType<typeof home>>;
const ids = [...DEVICES, heater, rf].map((d) => d.id);
const at = (m: Home) => new Date(m.clock.now()).toISOString();
/** The bridge says it lives, now, each device checked in now: a unit test has nothing else to send its status. */
function online(m: Home, more: string[] = []): void {
  const s = status([...ids, ...more], { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
/** Advances the clock in steps of 5 s, the bridge saying it lives at each. */
async function advance(m: Home, ms: number, more: string[] = []): Promise<void> {
  for (let left = ms; left > 0; left -= 5000) {
    m.clock.advance(Math.min(5000, left));
    online(m, more);
    await flush();
  }
}
/** The wall clock stepped back; timers, on a monotonic clock as Node's are, still fire after their delay. */
function stepBack(m: Home, ms: number): void {
  const c = m.clock as unknown as { t: number; timers: Map<number, { due: number }> };
  c.t -= ms;
  for (const t of c.timers.values()) t.due -= ms;
}
const offs = (m: Home, device: string, from = 0) => m.sent.slice(from).filter((x) => x.device === device && x.body.value.action === "onoff.turn_off");

/** A home whose heater and radio plug carry a heating load with a 20 s cap; the pump's turn_off is not idempotent. */
async function heated(o: { mutation?: Mutation; db?: Awaited<ReturnType<typeof memoryDb>> } = {}) {
  const m = await home({ ...o, extra: [heater, rf] });
  body(await m.configure(["hall:heater", "hall:rf", "hall:pulse"].flatMap((device) => [
    { op: "upsert", kind: "load", value: { device, load: "heating" } },
    { op: "upsert", kind: "max_on_s", value: { device, max_on_s: 20 } },
    { op: "upsert", kind: "ack_within_s", value: { device, action: "onoff.turn_off", ack_within_s: 10 } }])));
  online(m);
  return m;
}

/** A restart over `db`, the clock going on from `m`'s (or from `at`), the bridge heard again. */
async function restarted(m: Home, db: Awaited<ReturnType<typeof memoryDb>>, o: { mutation?: Mutation; at?: number } = {}) {
  await m.store.settled();
  m.a.stop();
  await m.store.close();
  const again = await home({ db, fresh: false, mutation: o.mutation, extra: [heater, rf], at: o.at ?? m.clock.now() });
  again.send("devices", { devices: [...DEVICES, heater, rf] }, true);
  again.a.listening("hall");
  online(again);
  await flush();
  return again;
}

describe("the heating cap across a restart (GA-LOAD-2, slice 7b)", () => {
  it.each([undefined, "forgets-an-on-time"] as const)(
    "counts the downtime toward a heater's cap: on 15 s, a restart, off 20 s after it went on; mutation %s forgets it", async (mutation) => {
      const db = await memoryDb();
      const m = await heated({ db: lasting(db) });
      m.report("heater", { on: true });
      await advance(m, 15_000);
      const again = await restarted(m, db, { mutation });
      await advance(again, 4000);
      expect(offs(again, "heater")).toEqual([]);
      await advance(again, 1500);
      expect(offs(again, "heater")).toHaveLength(mutation ? 0 : 1);
    });

  it.each([undefined, "forgets-a-cap"] as const)(
    "never sends a not-idempotent cap turn-off in flight again after a restart; mutation %s forgets the cap and sends it again", async (mutation) => {
      const db = await memoryDb();
      const m = await heated({ db: lasting(db) });
      m.report("pulse", { on: true });
      await advance(m, 20_500);
      expect(offs(m, "pulse")).toHaveLength(1);
      const again = await restarted(m, db, { mutation });
      await advance(again, 30_000);
      expect(offs(again, "pulse")).toHaveLength(mutation ? 1 : 0);
      if (mutation) return;
      const [n] = await again.notices("load_cap");
      expect(n.text).toMatch(/not sent again, being declared not idempotent/);
    });

  it("sends a refused turn-off again after a restart, its attempt going on, within its ack_within_s", async () => {
    const db = await memoryDb();
    const m = await heated({ db: lasting(db) });
    m.report("heater", { on: true });
    await advance(m, 20_500);
    const [first] = offs(m, "heater");
    m.ack(first!, "failed", { reason: "rejected" });
    await flush();
    await advance(m, 2000);
    // The socket dead at the start until its bridge is heard: on that return it is sent at once.
    const again = await restarted(m, db);
    await advance(again, 10_000);
    const sent = offs(again, "heater");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.commandId).not.toBe(first!.body.commandId);
  });

  it("goes on from a cap's last attempt on the on-time, kept apart from the cap's row, when it is armed again after a restart (the preflight's I1)", async () => {
    const db = await memoryDb();
    const m = await heated({ db: lasting(db) });
    m.report("heater", { on: true });
    await advance(m, 20_500);
    const [first] = offs(m, "heater");
    m.ack(first!, "failed", { reason: "unsupported_action" });
    await flush();
    // The cap stops: the load is no longer heating; its row goes, the on-time stays.
    body(await m.configure([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "lighting" } },
      { op: "delete", kind: "max_on_s", value: { device: "hall:heater" } }]));
    await advance(m, 5000);
    const again = await restarted(m, db);
    again.report("heater", { on: true });
    await flush();
    body(await again.configure([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } },
      { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } }]));
    await advance(again, 5000);
    expect(offs(again, "heater")).toHaveLength(1);
    expect((again.a.caps as any).caps.get("hall:heater").attempt).toBe(2);
  });

  it("writes the clock's last reading with an on-time and on a step back, not on every read, and goes on after a dropped write (the preflight's M3)", async () => {
    const m = await heated();
    const clock = async () => Number(await getMeta(m.store, "caps_clock_ms"));
    m.report("heater", { on: true });
    await flush();
    await m.store.settled();
    const first = await clock();
    expect(first).toBe(Math.floor(m.clock.now()));
    // Not on every read: at most once each 10 s.
    await advance(m, 9000);
    await m.store.settled();
    expect(await clock()).toBe(first);
    // A write dropped: the next is still queued.
    const write = m.store.write.bind(m.store);
    let drops = 1;
    (m.store as any).write = (ws: unknown, o?: { droppable?: boolean }) => (o?.droppable && drops-- > 0 ? Promise.resolve() : write(ws as never, o));
    stepBack(m, 10_000);
    await advance(m, 1000);
    stepBack(m, 10_000);
    await advance(m, 1000);
    await m.store.settled();
    expect(await clock()).toBe(Math.floor(m.clock.now()));
  });

  it("moves every on-time back when the clock reads earlier at a start than its last reading (the maintainer's ruling 5)", async () => {
    const db = await memoryDb();
    const m = await heated({ db: lasting(db) });
    m.report("heater", { on: true });
    await advance(m, 15_000);
    // The reading is kept at most every 10 s: the last, 10 s after the on-time began.
    await advance(m, 500);
    const again = await restarted(m, db, { at: m.clock.now() - 10_000 });
    // 10 s counted by the last reading kept: the cap of 20 s is reached 10 s after the start, whatever the clock reads.
    await advance(again, 9000);
    expect(offs(again, "heater")).toEqual([]);
    await advance(again, 1500);
    expect(offs(again, "heater")).toHaveLength(1);
  });
});

describe("the heating cap (GA-LOAD-2)", () => {
  it("turns a heating socket off by itself once it has been on for max_on_s, with no client, its change caused by load_cap", async () => {
    const m = await heated();
    const c = await m.cursor();
    m.report("heater", { on: true });
    await advance(m, 19_000);
    expect(offs(m, "heater")).toEqual([]);
    await advance(m, 1500);
    const [off] = offs(m, "heater");
    expect(off).toBeDefined();
    m.report("heater", { on: false });
    await flush();
    const state = (await m.events(c, "state")).filter((e: any) => e.target === "hall:heater" && e.value === false);
    expect(state.map((e: any) => e.cause)).toEqual(["load_cap"]);
    const outcomes = (await m.events(c, "outcome")).filter((e: any) => e.target === "hall:heater");
    expect(outcomes.map((e: any) => [e.load_cap, e.outcome])).toEqual([["hall:heater", "dispatched"], ["hall:heater", "acked"]]);
    expect(m.a.caps.onSince("hall:heater")).toBeUndefined();
  });

  it("counts from the first report of on, a repeat counting nothing, and resets only on a report of off", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await advance(m, 10_000);
    m.report("heater", { on: true });
    await advance(m, 5000);
    m.report("heater", { on: false });
    await advance(m, 1000);
    m.report("heater", { on: true });
    await advance(m, 19_000);
    expect(offs(m, "heater")).toEqual([]);
    await advance(m, 1500);
    expect(offs(m, "heater")).toHaveLength(1);
  });

  it("keeps the on-time in the store, and drops it once the socket is off", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await m.store.settled();
    const rows = async () => (await m.store.query<{ device: string; since_ms: number | string }>("SELECT device, since_ms FROM load_on")).rows
      .map((r) => [r.device, Number(r.since_ms)]);
    expect(await rows()).toEqual([["hall:heater", m.clock.now()]]);
    m.report("heater", { on: false });
    await m.store.settled();
    expect(await rows()).toEqual([]);
  });

  it("says a turn-off that did not land, and sends it again no sooner than its ack_within_s, and at once on the socket's return from dead", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await advance(m, 20_500);
    const [first] = offs(m, "heater");
    m.ack(first!, "failed", { reason: "rejected" });
    await flush();
    const [n] = await m.notices("load_cap");
    expect(n).toMatchObject({ devices: ["hall:heater"], outcomes: [{ outcome: "failed", reason: "rejected" }] });
    expect(n.text).toMatch(/sent again/);
    await advance(m, 9000);
    expect(offs(m, "heater")).toHaveLength(1);
    await advance(m, 1500);
    const [, second] = offs(m, "heater");
    expect(second).toBeDefined();
    expect(second!.body.commandId).not.toBe(first!.body.commandId);
    // Its socket dead: nothing is sent while it is, and the turn-off goes at once on its return.
    m.send("devices/heater/status", { deviceId: "heater", available: false, timestamp: at(m) });
    m.ack(second!, "failed", { reason: "rejected" });
    await advance(m, 30_000);
    expect(offs(m, "heater")).toHaveLength(2);
    expect((await m.notices("load_cap")).map((x: any) => x.outcomes[0].outcome)).toEqual(["failed"]);
    m.send("devices/heater/status", { deviceId: "heater", available: true, timestamp: at(m) });
    online(m);
    await flush();
    expect(offs(m, "heater")).toHaveLength(3);
    m.report("heater", { on: false });
    await advance(m, 30_000);
    expect(offs(m, "heater")).toHaveLength(3);
  });

  it.each([[undefined, false], ["retries-a-pulse-off" as const, true]])("sends a turn-off declared not idempotent once, and says it may still be on (mutation %s)", async (mutation, again) => {
    const m = await heated({ mutation });
    m.report("pulse", { on: true });
    await advance(m, 20_500);
    expect(offs(m, "pulse")).toHaveLength(1);
    // Nothing answers it: failed(no_ack) after its 10 s.
    await advance(m, 25_000);
    expect(offs(m, "pulse").length > 1).toBe(again);
    const [n] = await m.notices("load_cap");
    expect(n).toMatchObject({ devices: ["hall:pulse"], outcomes: [{ outcome: "failed", reason: "no_ack" }] });
    if (!mutation) expect(n.text).toMatch(/not sent again, being declared not idempotent/);
  });

  it.each([[undefined, 1], ["never-caps-a-silent-heater" as const, 0]])("counts an open socket from a turn_on that ended sent, and resets it on a turn_off that ended sent (mutation %s)", async (mutation, capped) => {
    const m = await heated({ mutation });
    const r = await m.apply("hall:rf", "onoff.turn_on", { token: true });
    expect(r.outcomes[0].outcome).toBe("dispatched");
    await flush();
    const [on] = m.sent.filter((x) => x.device === "rf");
    m.ack(on!, "sent");
    await flush();
    await advance(m, 21_000);
    expect(offs(m, "rf")).toHaveLength(capped);
    if (!capped) return;
    expect(m.a.caps.onSince("hall:rf")).toBeDefined();
    m.ack(offs(m, "rf")[0]!, "sent");
    await flush();
    expect(m.a.caps.onSince("hall:rf")).toBeUndefined();
    await advance(m, 30_000);
    expect(offs(m, "rf")).toHaveLength(1);
  });

  it("sends an open socket's turn-off again while it ends unanswered", async () => {
    const m = await heated();
    const r = await m.apply("hall:rf", "onoff.turn_on", { token: true });
    expect(r.outcomes[0].outcome).toBe("dispatched");
    await flush();
    m.ack(m.sent.find((x) => x.device === "rf")!, "sent");
    await advance(m, 21_000);
    expect(offs(m, "rf")).toHaveLength(1);
    // Nothing says whether it went: unanswered after its 10 s, and sent again.
    await advance(m, 12_000);
    expect(offs(m, "rf")).toHaveLength(2);
  });

  it("never acts under leaves-heat-on", async () => {
    const m = await heated({ mutation: "leaves-heat-on" });
    m.report("heater", { on: true });
    await advance(m, 60_000);
    expect(offs(m, "heater")).toEqual([]);
  });

  it("turns the socket off while a safety rule that turned it on still runs", async () => {
    const m = await heated();
    // A rule that turns the heater on and closes the valve when the sensor reports a leak. The valve is
    // dead, so the rule waits to send it again (GA-SAFE-12), and runs, guarding the heater, past the cap.
    body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "warm", trigger: { device: "hall:leak", key: "leak", op: "eq", value: true },
      actions: [{ target: "hall:heater", action: "onoff.turn_on" }, { target: "hall:valve", action: "valve.close" }] } }]));
    m.send("devices/valve/status", { deviceId: "valve", available: false, timestamp: at(m) });
    m.report("leak", { leak: true });
    await flush();
    m.report("heater", { on: true });
    await advance(m, 19_000);
    // A client's turn-off is refused while the rule runs; the cap's is not.
    expect(await m.plan("hall:heater", "onoff.turn_off")).toMatchObject({ verdict: "refuse", reason: "safety" });
    expect(offs(m, "heater")).toEqual([]);
    await advance(m, 1500);
    expect(offs(m, "heater")).toHaveLength(1);
    expect(await m.plan("hall:heater", "onoff.turn_off")).toMatchObject({ verdict: "refuse", reason: "safety" });
  });

  it("turns the socket off while the latch of a rule that turned it on holds", async () => {
    const m = await heated();
    body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "warm", trigger: { device: "hall:leak", key: "leak", op: "eq", value: true },
      actions: [{ target: "hall:heater", action: "onoff.turn_on" }], latch: { condition: { device: "hall:leak", key: "leak", op: "eq", value: false } } } }]));
    m.report("leak", { leak: true });
    await flush();
    m.report("heater", { on: true });
    await advance(m, 19_000);
    // The rule is complete and its latch holds: a client's undo is refused; the cap's turn-off is not.
    expect(await m.plan("hall:heater", "onoff.turn_off")).toMatchObject({ verdict: "refuse", reason: "latched" });
    expect(offs(m, "heater")).toEqual([]);
    await advance(m, 1500);
    expect(offs(m, "heater")).toHaveLength(1);
    expect(body(await m.a.call(m.owner, "state", {})).latches).toMatchObject([{ rule_id: "warm" }]);
  });

  it("sends a non-idempotent turn-off that did not go out (skipped, dead) once its socket returns, and says so", async () => {
    const m = await heated();
    m.report("pulse", { on: true });
    await flush();
    // The relay dead when its cap comes: nothing can be sent.
    m.send("devices/pulse/status", { deviceId: "pulse", available: false, timestamp: at(m) });
    await advance(m, 25_000);
    expect(offs(m, "pulse")).toHaveLength(0);
    const [n] = await m.notices("load_cap");
    expect(n).toMatchObject({ devices: ["hall:pulse"], outcomes: [{ outcome: "skipped", reason: "dead" }] });
    expect(n.text).toMatch(/was not carried out, and is sent again while the socket is not dead/);
    // It returns, still on: "sent once" is still owed.
    m.send("devices/pulse/status", { deviceId: "pulse", available: true, timestamp: at(m) });
    await advance(m, 30_000);
    expect(offs(m, "pulse")).toHaveLength(1);
  });

  it("arms a cap that could not act (its turn-off a toggle) again once its turn-off is discrete, the socket still on", async () => {
    const m = await heated();
    const toggling = heater.actions.map((a) => a.action === "onoff.turn_off" ? { ...a, idempotent: false, toggles: true } : a);
    m.send("devices", { devices: [...DEVICES, { ...heater, actions: toggling }, rf] }, true);
    await flush();
    m.report("heater", { on: true });
    await advance(m, 25_000);
    expect(offs(m, "heater")).toEqual([]);
    // Re-taught as discrete, the heater still on and never reported off.
    m.send("devices", { devices: [...DEVICES, heater, rf] }, true);
    await advance(m, 5000);
    expect(offs(m, "heater")).toHaveLength(1);
  });

  it("names a cap's turn-off by its socket, on-time and attempt: a cap armed again on the same on-time sends a new commandId (the maintainer's ruling 2)", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await advance(m, 20_500);
    const [first] = offs(m, "heater");
    expect(first).toBeDefined();
    // The socket says it cannot do it: final, the cap stuck until its turn-off changes.
    m.ack(first!, "unsupported");
    await flush();
    const changed = heater.actions.map((a) => a.action === "onoff.turn_off" ? { ...a, idempotent: false } : a);
    m.send("devices", { devices: [...DEVICES, { ...heater, actions: changed }, rf] }, true);
    await advance(m, 5000);
    const sent = offs(m, "heater");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.commandId).not.toBe(first!.body.commandId);
  });

  it("arms a cap whose socket was gone from the model again once it is back, still on", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await flush();
    m.send("devices", { devices: [...DEVICES, rf] }, true);
    await advance(m, 25_000);
    expect(offs(m, "heater")).toEqual([]);
    m.send("devices", { devices: [...DEVICES, heater, rf] }, true);
    await advance(m, 5000);
    expect(offs(m, "heater")).toHaveLength(1);
  });

  it("keeps one standing notice for a turn-off that keeps failing the same way, not one per attempt", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    const seen = new Set<string>();
    await advance(m, 20_500);
    for (let i = 0; i < 5; i++) {
      for (const s of offs(m, "heater")) m.ack(s, "failed", { reason: "rejected" });
      await flush();
      for (const n of await m.notices("load_cap")) seen.add(n.notice_id);
      await advance(m, 10_500);
    }
    expect(offs(m, "heater").length).toBeGreaterThan(3);
    expect(seen.size).toBe(1);
    // Off, and on again past its cap: the next failure is a new notice.
    m.report("heater", { on: false });
    await flush();
    m.report("heater", { on: true });
    await advance(m, 20_500);
    for (const s of offs(m, "heater")) m.ack(s, "failed", { reason: "rejected" });
    await flush();
    for (const n of await m.notices("load_cap")) seen.add(n.notice_id);
    expect(seen.size).toBe(2);
  });

  it("does not lower a running on-time when the clock steps back", async () => {
    const m = await heated();
    m.report("heater", { on: true });
    await advance(m, 10_000);
    stepBack(m, 3_600_000);
    await advance(m, 11_000);
    expect(offs(m, "heater")).toHaveLength(1);
  });

  it("writes its on-time in whole milliseconds when the clock steps back by a fraction of one", async () => {
    const m = await heated();
    // What the store is asked to write to load_on: PGlite rounds a fractional bigint parameter, where
    // Postgres refuses it (22P02) and the applier stops.
    const written: unknown[] = [];
    const store = m.store as unknown as { write: (fn: (tx: any) => Promise<void>, o?: unknown) => Promise<unknown> };
    const write = store.write.bind(store);
    store.write = (fn, o) => write((tx) => fn({ ...tx, query: (sql: string, params?: unknown[]) => {
      if (sql.includes("load_on (device, since_ms)")) written.push(params![1]);
      return tx.query(sql, params);
    } }), o);
    m.report("heater", { on: true });
    await advance(m, 1000);
    // An SNTP clock's reading moves back by a fraction of a millisecond between two syncs; a repeated
    // report of on, read inside the step, starts nothing but notices it.
    stepBack(m, 0.4);
    m.report("heater", { on: true });
    await advance(m, 1000);
    await m.store.settled();
    expect(written.length).toBeGreaterThan(1);
    expect(written.every((x) => Number.isInteger(x))).toBe(true);
  });

  it("does not count a socket reported on just after a backward step, before the next tick, as on for the step's length", async () => {
    const m = await heated();
    body(await m.configure([{ op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 600 } }]));
    await advance(m, 1000);
    stepBack(m, 3_600_000);
    m.report("heater", { on: true });
    await flush();
    await advance(m, 2000);
    expect(offs(m, "heater")).toEqual([]);
    expect(m.clock.now() - m.a.caps.onSince("hall:heater")!).toBe(2000);
  });

  it("counts new hardware that is already on from its replacement of a heater's plug", async () => {
    const m = await heated();
    const heater2 = { ...heater, id: "heater2", stableIdentifier: "test:heater2" };
    m.send("devices", { devices: [...DEVICES, heater, rf, heater2] }, true);
    online(m, ["heater2"]);
    await flush();
    m.report("heater2", { on: true });
    await flush();
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:heater2", class: "socket", replaces: "hall:heater" } }]));
    expect(m.a.caps.onSince("hall:heater")).toBe(m.clock.now());
    await advance(m, 21_000, ["heater2"]);
    expect(offs(m, "heater2")).toHaveLength(1);
  });

  it("says a socket made heating while on past its cap is turned off at once", async () => {
    const m = await home({ extra: [heater] });
    online(m);
    m.report("heater", { on: true });
    await advance(m, 30_000);
    body(await m.configure([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } },
      { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } }]));
    await flush();
    const [n] = (await m.notices("load_cap")).filter((x: any) => /turns it off now/.test(x.text));
    expect(n).toMatchObject({ devices: ["hall:heater"] });
    expect(n.text).toMatch(/on for 30 s, past the heating cap of 20 s it now has/);
    expect(offs(m, "heater")).toHaveLength(1);
    // Nothing more is said while it stays so.
    await advance(m, 5000);
    expect((await m.notices("load_cap")).filter((x: any) => /turns it off now/.test(x.text))).toHaveLength(1);
  });
});

describe("max_on_s (applier, *Loads*, GA-CFG-3)", () => {
  it("is shown on a heating load, the default where none is set; refused above 86400 and on a load not heating", async () => {
    const m = await home({ extra: [heater] });
    const describe = async () => body(await m.a.call(m.owner, "describe", {})).devices.find((d: any) => d.id === "hall:heater");
    expect(await describe()).not.toHaveProperty("max_on_s");
    const cap = (s: number) => ({ op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: s } });
    const refused = async (changes: unknown[]) => {
      const r = await m.configure(changes);
      return r.ok ? "accepted" : `${r.error}: ${r.message}`;
    };
    expect(await refused([cap(600)])).toMatch(/invalid_request: .*only a heating load carries/);
    body(await m.configure([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } }]));
    expect(await describe()).toMatchObject({ load: "heating", max_on_s: 14_400 });
    expect(await refused([cap(86_401)])).toMatch(/invalid_request: .*above 86400/);
    body(await m.configure([cap(86_400)]));
    expect(await describe()).toMatchObject({ max_on_s: 86_400 });
    // A load no longer heating takes its cap with it in the same set, or is refused.
    expect(await refused([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "lighting" } }])).toMatch(/only a heating load carries/);
    body(await m.configure([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "lighting" } },
      { op: "delete", kind: "max_on_s", value: { device: "hall:heater" } }]));
    expect(await describe()).not.toHaveProperty("max_on_s");
  });

  it("is not_claimed while the applier claims no Safe (GA-LVL-1)", async () => {
    const m = await home({ extra: [heater], box: false });
    const r = await m.configure([{ op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 600 } }]);
    expect(r.ok ? "accepted" : r.error).toBe("not_claimed");
  });
});
