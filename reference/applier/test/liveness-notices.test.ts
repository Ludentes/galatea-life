import { describe, expect, it } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, home, rule, status } from "./safe-home.js";

// covers: GA-SAFE-10's notices, and what they remember across a restart: a said stop, and the start's grace (the maintainer's ruling 4).
type Home = Awaited<ReturnType<typeof home>>;
const at = (m: Home) => new Date(m.clock.now()).toISOString();
const ids = DEVICES.map((d) => d.id);
/** The bridge says it lives, now, each device checked in now. */
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
/** The bridge says it lives, each device but `except` checked in now: `except` stays dead. */
function onlineBut(m: Home, except: string): void {
  const s = status(ids.filter((d) => d !== except), { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
/** A restart over `db`, the clock going on from `m`'s, the bridge's devices document retained. */
async function restarted(m: Home, db: Awaited<ReturnType<typeof memoryDb>>, mutation?: Mutation) {
  await m.store.settled();
  m.a.stop();
  await m.store.close();
  const again = await home({ db, fresh: false, mutation, at: m.clock.now() });
  again.send("devices", { devices: DEVICES }, true);
  again.a.listening("hall");
  return again;
}
const leakNotices = async (m: Home) => (await m.notices("liveness")).filter((n: any) => n.devices.includes("hall:leak"));
/** The bridge goes offline gracefully: a planned reload. */
const reload = (m: Home) => m.send("status", status(ids, { state: "offline", graceful: true, publishedAt: at(m) }));
/** Advances the clock in steps of 10 s, the bridge saying it lives at each unless `quiet`. */
function advance(m: Home, ms: number, quiet = false): void {
  for (let left = ms; left > 0; left -= 10_000) {
    m.clock.advance(Math.min(10_000, left));
    if (!quiet) online(m);
  }
}

async function ruled(o: { mutation?: Mutation } = {}) {
  const m = await home(o);
  body(await m.configure([rule()]));
  return m;
}
const texts = async (m: Home) => (await m.notices("liveness")).map((n: any) => `${n.rule_id} ${n.devices.join(",")}: ${n.text}`);

describe("GA-SAFE-10's liveness notices", () => {
  it("says at once that a sensor a rule reads stopped being live, and replaces it when it is live again", async () => {
    const m = await ruled();
    expect(await texts(m)).toEqual([]);
    m.send("devices/leak/status", { deviceId: "leak", available: false, timestamp: at(m) });
    expect(await texts(m)).toEqual(["leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak is dead."]);
    m.clock.advance(1000);
    m.send("devices/leak/status", { deviceId: "leak", available: true, timestamp: at(m) });
    online(m);
    expect(await texts(m)).toEqual(["leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak is live again."]);
  });

  // One home per test: several in one outlast the test's bound under a parallel run.
  it.each([undefined, "floods-reload-notices" as const])(
    "gives a graceful reload 60 s: none when the bridge is back within it, but under floods-reload-notices, mutation %s", async (mutation) => {
      const m = await ruled({ mutation });
      reload(m);
      expect((await texts(m)).length).toBe(mutation ? 2 : 0);
      advance(m, 20_000, true);
      online(m);
      advance(m, 60_000);
      // Under the mutation: a stop for each device, each replaced by its `live again`.
      expect((await texts(m)).every((t) => /live again/.test(t))).toBe(true);
      expect((await texts(m)).length).toBe(mutation ? 2 : 0);
    });

  it.each([undefined, "silent-on-liveness" as const])(
    "says a device still dead 60 s after a graceful reload, for each rule and device; but not under silent-on-liveness, mutation %s", async (mutation) => {
      const m = await ruled({ mutation });
      reload(m);
      advance(m, 59_000, true);
      expect(await texts(m)).toEqual([]);
      advance(m, 2_000, true);
      expect((await texts(m)).sort()).toEqual(mutation ? [] : [
        "leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak has not been live for 60 s, since its bridge went offline.",
        "leak-closes-valve hall:valve: Safety rule leak-closes-valve: hall:valve has not been live for 60 s, since its bridge went offline."]);
    });

  it.each([undefined, "forgets-a-said-stop"] as const)(
    "says a dead sensor's stop once across a restart, and its return after it; mutation %s says it again (GA-SAFE-10)", async (mutation) => {
      const db = await memoryDb();
      const m = await home({ db: lasting(db) });
      body(await m.configure([rule()]));
      m.send("devices/leak/status", { deviceId: "leak", available: false, timestamp: at(m) });
      const said = (await leakNotices(m)).map((n: any) => n.notice_id);
      expect(said).toHaveLength(1);
      const again = await restarted(m, db, mutation);
      for (let i = 0; i < 7; i++) {
        onlineBut(again, "leak");
        again.clock.advance(10_000);
      }
      const after = (await leakNotices(again)).map((n: any) => n.notice_id);
      if (mutation) expect(after).not.toEqual(said);
      else expect(after).toEqual(said);
      online(again);
      expect((await texts(again)).filter((t) => t.includes("hall:leak is live again"))).toHaveLength(1);
    });

  it("says nothing within 55 s of a start for a rule's device not yet live, and its stop past 60 s; one live by then is no news (GA-SAFE-10)", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([rule()]));
    const again = await restarted(m, db);
    for (let i = 0; i < 5; i++) {
      onlineBut(again, "leak");
      again.clock.advance(11_000);
    }
    expect(await texts(again)).toEqual([]);
    onlineBut(again, "leak");
    again.clock.advance(6_000);
    expect((await again.notices("liveness")).map((n: any) => n.devices)).toEqual([["hall:leak"]]);
  });

  it("says a bridge's second planned death within 10 min at once: a reload loop", async () => {
    const m = await ruled();
    reload(m);
    advance(m, 10_000, true);
    online(m);
    advance(m, 5 * 60_000);
    expect(await texts(m)).toEqual([]);
    reload(m);
    expect((await texts(m)).sort()).toEqual([
      "leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak is dead; its bridge hall went offline again within 10 min.",
      "leak-closes-valve hall:valve: Safety rule leak-closes-valve: hall:valve is dead; its bridge hall went offline again within 10 min."]);
  });

  it("gives the broker's loss the same grace", async () => {
    const m = await ruled();
    m.a.home.lost();
    expect(await texts(m)).toEqual([]);
    m.clock.advance(61_000);
    expect((await texts(m)).length).toBe(2);
  });

  it("says a rule's closed device whose fresh_s is not known, never an open one; and an owner's fresh_s longer than the declared one, not a shorter one", async () => {
    const m = await ruled();
    // The IR air conditioner is open: it has no bound, and is live while its bridge is.
    body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "leak-stops-ac", trigger: { device: "hall:leak", key: "leak", op: "eq", value: true },
      actions: [{ target: "hall:ac", action: "climate.set_mode", args: { mode: "off" } }] } }]));
    expect(await texts(m)).toEqual([]);
    // The sensor's bridge no longer declares its bound: it can never be live until the owner sets one.
    const s = status(ids, { publishedAt: at(m) });
    m.send("status", { ...s, devices: s.devices.map((d) => d.id === "leak" ? { ...d, basisMaxAgeMs: null } : d) });
    expect((await texts(m)).sort()).toEqual([
      "leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak has no known fresh_s: it can never be live until the owner sets one.",
      "leak-stops-ac hall:leak: Safety rule leak-stops-ac: hall:leak has no known fresh_s: it can never be live until the owner sets one."]);
    // Its bound declared again: the sensor, stale meanwhile, is live again, and says so.
    online(m);
    expect((await texts(m)).filter((t) => t.endsWith("is live again.")).length).toBe(2);
    // A client takes them (the owner's notice_taken takes none).
    await m.a.call(m.a.caller("h-credential"), "events", { notice_taken: (await m.notices("liveness")).map((n: any) => n.notice_id) });
    body(await m.configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:leak", fresh_s: 30 } }]));
    expect(await texts(m)).toEqual([]);
    body(await m.configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:leak", fresh_s: 600 } }]));
    expect((await texts(m)).sort()).toEqual([
      "leak-closes-valve hall:leak: Safety rule leak-closes-valve: hall:leak's fresh_s, 600 s, is longer than the 60 s its bridge declares: a dead device reads live for longer.",
      "leak-stops-ac hall:leak: Safety rule leak-stops-ac: hall:leak's fresh_s, 600 s, is longer than the 60 s its bridge declares: a dead device reads live for longer."]);
  });

  it("says nothing for a rule disabled by a declaration change", async () => {
    const m = await ruled();
    // The valve's bridge no longer offers valve.close: the rule is disabled.
    m.send("devices", { devices: DEVICES.map((d) => d.id !== "valve" ? d : { ...d, actions: d.actions.filter((a: any) => a.action !== "valve.close") }) }, true);
    expect((await m.notices("rule_disabled")).length).toBe(1);
    m.send("devices/leak/status", { deviceId: "leak", available: false, timestamp: at(m) });
    expect(await texts(m)).toEqual([]);
  });
});
