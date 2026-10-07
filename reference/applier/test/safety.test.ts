import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { getMeta } from "../src/core/store.js";
import { HELD_MS } from "../src/dispatch/records.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, home, LEAK, rule, status, T } from "./safe-home.js";

const at = (m: Awaited<ReturnType<typeof home>>) => new Date(m.clock.now()).toISOString();
/** The device's `available` flag, as its bridge reports it: false makes it dead at once. */
const available = (m: Awaited<ReturnType<typeof home>>, device: string, up: boolean) =>
  m.send(`devices/${device}/status`, { deviceId: device, available: up, timestamp: at(m) });
/** The bridge says it lives, now, each device checked in now. */
function online(m: Awaited<ReturnType<typeof home>>): void {
  m.send("devices", { devices: DEVICES }, true);
  m.a.listening("hall");
  const s = status(DEVICES.map((d) => d.id), { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
/** The bounds the restart tests send at: past 30 s a silent bridge is found dead. */
const BOUNDS = [["hall:valve", "valve.close"], ["hall:ac", "climate.set_mode"]]
  .map(([device, action]) => ({ op: "upsert", kind: "ack_within_s", value: { device, action, ack_within_s: 10 } }));

describe("a safety rule running", () => {
  async function wet(o: { mutation?: Mutation } = {}) {
    const m = await home(o);
    body(await m.configure([rule()]));
    return m;
  }

  it("fires on a leak with no client, through the dispatcher with cause safety_rule; guards its valve until complete; then a notice and rule_fired (GA-SAFE-1, 2, 3, 8)", async () => {
    const m = await wet();
    const c = await m.cursor();
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.map((s) => [s.device, s.body.value.action])).toEqual([["valve", "valve.close"]]);
    // From firing until complete, a request for the valve is refuse(safety).
    const r = await m.apply("hall:valve", "valve.open");
    expect(r.outcomes[0]).toMatchObject({ outcome: "refused", reason: "safety" });
    const plan = body(await m.a.call(m.a.caller("h-credential"), "plan", { actions: [{ target: "hall:valve", action: "valve.open", args: {},
      via: "app", brain: false, for: { person: "demo" } }] }));
    expect(plan.steps[0]).toMatchObject({ verdict: "refuse", reason: "safety" });
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    const outcome = (await m.events(c, "outcome")).at(-1);
    expect(outcome).toMatchObject({ rule_id: "leak-closes-valve", target: "hall:valve", outcome: "acked" });
    expect(outcome).not.toHaveProperty("apply_id");
    expect((await m.events(c, "state")).find((e: any) => e.target === "hall:valve")).toMatchObject({ cause: { safety_rule: "leak-closes-valve" } });
    const [fired] = await m.events(c, "rule_fired");
    expect(fired).toMatchObject({ rule_id: "leak-closes-valve", outcomes: [{ target: "hall:valve", outcome: "acked" }] });
    const [n] = await m.notices("safety_rule");
    expect(n).toMatchObject({ notice_id: fired.notice, rule_id: "leak-closes-valve", outcomes: [{ target: "hall:valve", outcome: "acked" }] });
    expect(n.text).toMatch(/A leak closed the valve/);
    // Complete: the valve is the household's again.
    expect((await m.apply("hall:valve", "valve.open")).outcomes[0].reason).not.toBe("safety");
    // In history by the devices the rule names.
    const h = body(await m.a.call(m.owner, "history", { from: T, to: new Date(m.clock.now() + 1000).toISOString(), targets: ["hall:leak"] }));
    expect(h.events.map((e: any) => e.type)).toContain("rule_fired");
  });

  it("fires again on a basis it fired on before, once its trigger was false between: a new run, never the ended one (the preflight's I1)", async () => {
    const m = await wet();
    const c = await m.cursor();
    m.report("leak", { leak: true });
    await flush();
    const basis = (m.a.safety as any).seen.get("hall:leak\u0000leak") as number;
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    await flush();
    expect(await m.events(c, "rule_fired")).toHaveLength(1);
    m.clock.advance(1000);
    m.report("leak", { leak: false });
    m.report("valve", { open: true });
    await flush();
    // True again on a report whose basis is the first firing's: the trigger's other key, never seen
    // before, can carry it. Judged as the engine would judge it.
    const s = m.a.safety as any;
    const real = s.o.reported;
    s.o.reported = (d: string, k: string) => d === "hall:leak" && k === "leak" ? true : real(d, k);
    s.judge("hall:leak", ["leak"], new Map([["leak", basis]]));
    await flush();
    const closes = m.sent.filter((x) => x.device === "valve");
    expect(closes).toHaveLength(2);
    expect(closes[1]!.body.commandId).not.toBe(closes[0]!.body.commandId);
    m.ack(closes[1]!, "applied");
    m.report("valve", { open: false });
    await flush();
    expect(await m.events(c, "rule_fired")).toHaveLength(2);
  });

  it("fires once per trigger becoming true: not on a repeat, an older basis or a fast clock; again once it was false (GA-SAFE-11)", async () => {
    const m = await wet();
    m.report("leak", { leak: true });
    await flush();
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    await flush();
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    m.report("leak", { leak: false }, m.clock.now() - 5000);
    m.report("leak", { leak: true }, m.clock.now() + 60_000);
    await flush();
    expect(m.sent.length).toBe(1);
    m.clock.advance(1000);
    m.report("leak", { leak: false });
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.length).toBe(2);
  });

  it("never fires on a report the applier held before the rule was configured, re-delivered after (GA-SAFE-11)", async () => {
    const m = await home();
    const at = m.clock.now();
    m.report("leak", { leak: true }, at);
    m.clock.advance(1000);
    body(await m.configure([rule()]));
    // A broker reconnect, or a snapshot, delivers the retained status again: the same basis_time, no new report.
    m.send("devices/leak/status", { deviceId: "leak", leak: true, timestamp: new Date(at).toISOString() }, true);
    await flush();
    expect(m.sent.length).toBe(0);
    // A later report of the still-wet sensor is new: the trigger becomes true, and the rule fires.
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.map((x) => x.body.value.action)).toEqual(["valve.close"]);
  });

  it("never fires on an assumed value, but under fires-on-an-assumed-value (GA-SAFE-11)", async () => {
    for (const mutation of [undefined, "fires-on-an-assumed-value" as const]) {
      const m = await home({ mutation });
      body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "heat-closes-valve",
        trigger: { device: "hall:ac", key: "mode", op: "eq", value: "heat" }, actions: [{ target: "hall:valve", action: "valve.close" }] } }]));
      const r = await m.a.call(m.a.caller("h-credential"), "apply", { idempotency_key: crypto.randomUUID(), request: { actions: [
        { target: "hall:ac", action: "climate.set_mode", args: { mode: "heat" }, via: "app", brain: false, for: { person: "demo" } }] } });
      body(r);
      m.ack(m.sent[0]!, "sent");
      expect(m.sent.filter((s) => s.device === "valve").length).toBe(mutation ? 1 : 0);
    }
  });

  it("sends a non-idempotent actuation once, with no reissue, but under reissues-on-timeout (GA-SAFE-5)", async () => {
    for (const mutation of [undefined, "reissues-on-timeout" as const]) {
      const m = await home({ mutation });
      body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "leak-cuts-pump", trigger: LEAK,
        actions: [{ target: "hall:pulse", action: "onoff.turn_off" }] } }]));
      m.report("leak", { leak: true });
      await flush();
      m.clock.advance(40_000);
      await flush();
      expect(m.sent.filter((s) => s.device === "pulse").length).toBe(mutation ? 3 : 1);
      if (!mutation) expect((await m.notices("safety_rule"))[0].outcomes).toMatchObject([{ outcome: "failed", reason: "no_ack" }]);
    }
  });

  it("judges a resumed rule's orphan actuation once every module has loaded, and completes it once (GA-PERSIST-1, GA-SAFE-3)", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([rule({ actions: [{ target: "hall:pulse", action: "onoff.turn_off" }] })]));
    m.report("leak", { leak: true });
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    await db.query("DELETE FROM waiting");
    const again = await home({ db, fresh: false, start: false });
    await again.a.load();
    expect(await again.notices("safety_rule")).toEqual([]);
    await again.a.resume();
    // The pump's turn_off may have run; whether it is idempotent is known once its bridge describes it.
    expect((await again.notices("safety_rule")).filter((n: any) => !n.waiting)).toEqual([]);
    // The rest of a start: the bridges followed, then heard.
    (again.a as any).home.follow((again.a as any).config.bridges);
    online(again);
    await flush();
    again.clock.advance(1000);
    await flush();
    // It is not idempotent: done, never sent again, the run complete, its notice once.
    expect(again.sent).toEqual([]);
    const done = (await again.notices("safety_rule")).filter((n: any) => !n.waiting);
    expect(done).toHaveLength(1);
    expect(done[0].outcomes).toMatchObject([{ target: "hall:pulse", outcome: "failed", reason: "no_ack" }]);
  });

  it.each([undefined, "loses-a-fired-run"] as const)(
    "keeps a firing's seen basis, latch, run and state together: a crash that lost the run lost them all (GA-SAFE-3), mutation %s", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db), mutation });
      const DRY = { condition: { device: "hall:leak", key: "leak", op: "eq", value: false } };
      body(await m.configure([rule({ latch: DRY })]));
      await m.store.settled();
      // The firing's run is never written: the store fails on it, and keeps failing.
      db.trouble.failOn = /INSERT INTO applies/;
      const at = m.clock.now();
      m.report("leak", { leak: true }, at);
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      // A crash: nothing more commits.
      m.a.stop();
      db.trouble.failOn = undefined;
      const again = await home({ db, fresh: false, mutation });
      again.send("devices", { devices: DEVICES }, true);
      again.a.listening("hall");
      again.send("status", status(DEVICES.map((d) => d.id)));
      expect(again.a.safety.latches.holds("leak-closes-valve")).toBe(mutation !== undefined);
      // The wet report, retained, delivered again at the start.
      again.report("leak", { leak: true }, at);
      await flush();
      expect(again.sent.some((s) => s.device === "valve")).toBe(mutation === undefined);
    });

  it.each([undefined, "draws-a-fresh-command-id"] as const)(
    "sends a firing a crash lost again with the first's commandId; mutation %s draws a fresh one (the maintainer's ruling 2, proposed for 0.16)", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db), mutation });
      body(await m.configure([rule()]));
      await m.store.settled();
      // The firing's group never commits.
      db.trouble.failOn = /INSERT INTO applies/;
      const at = m.clock.now();
      m.report("leak", { leak: true }, at);
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      const [first] = m.sent.filter((s) => s.device === "valve");
      m.a.stop();
      db.trouble.failOn = undefined;
      const again = await home({ db, fresh: false, mutation });
      again.send("devices", { devices: DEVICES }, true);
      again.a.listening("hall");
      again.send("status", status(DEVICES.map((d) => d.id)));
      // The same report, re-delivered retained.
      again.report("leak", { leak: true }, at);
      await flush();
      const [second] = again.sent.filter((s) => s.device === "valve");
      expect(second).toBeDefined();
      expect(second!.body.commandId === first!.body.commandId).toBe(mutation === undefined);
    });

  it.each([undefined, "draws-a-fresh-command-id"] as const)(
    "names a command by what was sent: a re-fired close skipped on a valve dead until its bridge is heard, sent on its return, keeps the first life's commandId; mutation %s", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db), mutation });
      body(await m.configure([rule()]));
      await m.store.settled();
      db.trouble.failOn = /INSERT INTO applies/;
      const at = m.clock.now();
      m.report("leak", { leak: true }, at);
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      const [first] = m.sent.filter((s) => s.device === "valve");
      m.a.stop();
      db.trouble.failOn = undefined;
      const again = await home({ db, fresh: false, mutation, at: m.clock.now() });
      // The retained report comes before the bridge's status: every device still dead, the close skipped(dead).
      again.send("devices", { devices: DEVICES }, true);
      again.a.listening("hall");
      again.report("leak", { leak: true }, at);
      await flush();
      expect(again.sent).toEqual([]);
      online(again);
      await flush();
      const sent = again.sent.filter((s) => s.device === "valve");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.body.commandId === first!.body.commandId).toBe(mutation === undefined);
    });

  it("keeps the install's command namespace across a restart", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    const ns = await getMeta(m.store, "command_namespace");
    expect(ns).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false });
    expect(await getMeta(again.store, "command_namespace")).toBe(ns);
  });

  it.each([undefined, "forgets-a-running-rule"] as const)(
    "resumes a rule waiting on a dead valve after a restart past its hour, and sends on its return; mutation %s forgets it (GA-SAFE-12)", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db) });
      body(await m.configure([rule()]));
      available(m, "valve", false);
      m.report("leak", { leak: true });
      await flush();
      expect(m.sent).toEqual([]);
      await m.store.settled();
      m.a.stop();
      await m.store.close();
      const again = await home({ db, fresh: false, mutation, at: m.clock.now() + HELD_MS + 60_000 });
      // Every device is dead at the start until its bridge is heard: the valve's return.
      expect(again.sent).toEqual([]);
      expect(again.a.safety.guarded("hall:valve")).toBe(mutation === undefined);
      online(again);
      await flush();
      expect(again.sent.filter((s) => s.device === "valve")).toHaveLength(mutation ? 0 : 1);
    });

  it.each([["hall:pulse", "onoff.turn_off", 0], ["hall:valve", "valve.close", 1]] as const)(
    "takes up %s's %s kept above its last outcome, its records lost to a crash: may have run, so sent again: %i (the preflight's I2)",
    async (target, action, again) => {
      const device = target.slice(5);
      const db = await memoryDb();
      const m = await home({ db: lasting(db) });
      body(await m.configure([rule({ actions: [{ target, action }] })]));
      available(m, device, false);
      await flush();
      const wetAt = m.clock.now();
      m.report("leak", { leak: true }, wetAt);
      await flush();
      await m.store.settled();
      // The device returns: attempt 2 is kept, then sent, and the store fails on the run's row.
      db.trouble.failOn = /INSERT INTO applies/;
      m.clock.advance(1000);
      available(m, device, true);
      await flush();
      expect(m.sent.filter((s) => s.device === device)).toHaveLength(1);
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      m.a.stop();
      db.trouble.failOn = undefined;
      const after = await home({ db, fresh: false, at: m.clock.now() });
      // The attempt taken up ended failed(no_ack) at the start: it may have run.
      const run = [...((after.a.dispatcher as any).applies as Map<string, any>).values()].find((a) => a.rule_id !== undefined);
      expect(run.outcomes[0]).toMatchObject({ step_id: "s1.2", outcome: "failed", reason: "no_ack" });
      // Past the valve's 60 s bound, its bridge heard throughout.
      for (let i = 0; i < 14; i++) {
        online(after);
        await flush();
        after.clock.advance(5000);
      }
      online(after);
      await flush();
      expect(after.sent.filter((s) => s.device === device).length > 0 ? 1 : 0).toBe(again);
    });

  it("keeps an actuation's attempt across a restart: an unanswered idempotent action, sent once more before, is not sent a third time (GA-SAFE-12)", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([...BOUNDS, { op: "upsert", kind: "safety_rule", value: { id: "leak-stops-ac", trigger: LEAK,
      actions: [{ target: "hall:ac", action: "climate.set_mode", args: { mode: "off" } }] } }]));
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(10_000 + 1000);
    await flush();
    expect(m.sent.filter((s) => s.device === "ac")).toHaveLength(2);
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, at: m.clock.now() });
    online(again);
    again.clock.advance(10_000 + 1000);
    online(again);
    await flush();
    again.clock.advance(10_000 + 1000);
    await flush();
    expect(again.sent.filter((s) => s.device === "ac")).toEqual([]);
    const done = (await again.notices("safety_rule")).filter((n: any) => !n.waiting);
    expect(done.at(-1).text).toMatch(/nothing will say whether it ran/);
  });

  it("says a waiting already said once: a restart raises no second waiting notice for the same wait (GA-SAFE-8)", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([rule()]));
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    const said = (await m.notices("safety_rule")).filter((n: any) => n.waiting).map((n: any) => n.notice_id);
    expect(said).toHaveLength(1);
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, at: m.clock.now() });
    online(again);
    available(again, "valve", false);
    await flush();
    expect((await again.notices("safety_rule")).filter((n: any) => n.waiting).map((n: any) => n.notice_id)).toEqual(said);
  });

  it("commits a new rule's seen bases with the rule: a crash right after configure keeps them (GA-SAFE-11)", async () => {
    const db = await memoryDb();
    // The store goes away the moment the configure holding the rule commits: nothing written behind it lands.
    let after = false;
    const watched = { ...lasting(db), transaction: async <T>(fn: (tx: any) => Promise<T>) => {
      let rules = false;
      const r = await db.transaction((tx) => fn({ ...tx, query: (sql: string, p?: unknown[]) => {
        if (/INSERT INTO safety_rules/.test(sql)) rules = true;
        return tx.query(sql, p);
      } }));
      if (rules && after) db.trouble.down = true;
      return r;
    } };
    const m = await home({ db: watched as typeof db });
    m.report("leak", { leak: true });
    await m.store.settled();
    after = true;
    body(await m.configure([rule()]));
    m.a.stop();
    db.trouble.down = false;
    const seen = await db.query("SELECT device, key FROM safety_seen");
    expect(seen.rows).toEqual([{ device: "hall:leak", key: "leak" }]);
  });

  it.each([undefined, "forgets-what-it-saw"] as const)(
    "does not fire on a report it held before the rule, re-delivered after a restart; mutation %s does (GA-SAFE-11)", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db) });
      const at = m.clock.now();
      m.report("leak", { leak: true }, at);
      m.clock.advance(1000);
      body(await m.configure([rule()]));
      await m.store.settled();
      m.a.stop();
      await m.store.close();
      const again = await home({ db, fresh: false, mutation, at: m.clock.now() });
      online(again);
      // The same report, re-delivered retained.
      again.send("devices/leak/status", { deviceId: "leak", leak: true, timestamp: new Date(at).toISOString() }, true);
      await flush();
      expect(again.sent.filter((s) => s.device === "valve")).toHaveLength(mutation ? 1 : 0);
    });

  it("keeps what a restart needs: the last basis seen and the trigger", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([rule()]));
    m.report("leak", { leak: true });
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    await m.store.settled();
    m.a.stop();
    const again = await home({ db, fresh: false });
    again.send("devices", { devices: DEVICES }, true);
    again.a.listening("hall");
    again.send("status", status(DEVICES.map((d) => d.id)));
    // The retained report the restart finds again is no new one; a later one of the same wet sensor is no trigger becoming true.
    again.report("leak", { leak: true }, m.clock.now());
    again.clock.advance(1000);
    again.report("leak", { leak: true });
    await flush();
    expect(again.sent.length).toBe(0);
    // Dry, then wet again: the trigger becomes true, and the rule fires.
    again.clock.advance(1000);
    again.report("leak", { leak: false });
    again.clock.advance(1000);
    again.report("leak", { leak: true });
    await flush();
    expect(again.sent.map((x) => x.body.value.action)).toEqual(["valve.close"]);
  });
});
