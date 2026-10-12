import { describe, expect, it } from "vitest";
import { Mutant } from "../src/mutations.js";
import { Latches } from "../src/safety/latches.js";
import type { SafetyRule } from "../src/safety/language.js";
import { lasting, memoryDb } from "./db.js";
import { body, COUNTDOWN, DEVICES, flush, home, LEAK, refused, rule, status, T } from "./safe-home.js";

// covers: GA-SAFE-7 and GA-SAFE-9, and a latch held across a restart (forgets-a-latch).

/** HS4's rule: a leak closes the valve, and its latch holds until the sensor reports dry and is live. */
const latched = (extra: Record<string, unknown> = {}) => rule({ latch: { condition: { ...LEAK, value: false } }, ...extra });
const DRY = { leak: false };

/** A rule firing on a leak whose run is complete: the valve acked closed. */
async function leaked(o: Parameters<typeof home>[0] = {}, r = latched()) {
  const m = await home(o);
  body(await m.configure([r]));
  const c = await m.cursor();
  m.report("leak", { leak: true });
  await flush();
  m.ack(m.sent[0]!, "applied");
  m.report("valve", { open: false });
  await flush();
  return { m, c };
}

const short = (o: { outcome: string; reason?: string }) => `${o.outcome}${o.reason ? `(${o.reason})` : ""}`;

describe("a safety rule's latch", () => {
  it("is set when the rule fires, a latch event and listed in state; holds after completion; clears on a dry report from a live sensor (GA-SAFE-7, GA-SAFE-9)", async () => {
    const { m, c } = await leaked();
    expect((await m.events(c, "latch")).map((e: any) => [e.rule_id, e.latch, e.devices])).toEqual([["leak-closes-valve", "set", ["hall:valve"]]]);
    expect(body(await m.a.call(m.owner, "state", {})).latches).toMatchObject([{ rule_id: "leak-closes-valve", devices: ["hall:valve"] }]);
    // Complete, so no longer refuse(safety): the latch refuses the undo instead.
    expect(await m.plan("hall:valve", "valve.open")).toMatchObject({ verdict: "refuse", reason: "latched", tier: "no_voice" });
    expect(short((await m.apply("hall:valve", "valve.open", { token: true })).outcomes[0])).toBe("refused(latched)");
    // Closing again is no undo; neither is a request for another device.
    expect((await m.plan("hall:valve", "valve.close")).reason).not.toBe("latched");
    m.clock.advance(1000);
    m.report("leak", DRY);
    expect((await m.events(c, "latch")).map((e: any) => e.latch)).toEqual(["set", "cleared"]);
    expect(body(await m.a.call(m.owner, "state", {})).latches).toEqual([]);
    // In history, by the device its rule actuates.
    const h = body(await m.a.call(m.owner, "history", { from: T, to: new Date(m.clock.now() + 1000).toISOString(), targets: ["hall:valve"] }));
    expect(h.events.filter((e: any) => e.type === "latch").map((e: any) => e.latch)).toEqual(["set", "cleared"]);
  });

  it("does not fire its rule again while it is held, the trigger becoming true again included (GA-SAFE-11)", async () => {
    // A latch that needs the thermostat off as well as the sensor dry: a dry report alone does not clear it.
    const { m, c } = await leaked({}, latched({ latch: { condition: { all: [{ ...LEAK, value: false },
      { device: "hall:thermo", key: "mode", op: "eq", value: "off" }] } } }));
    m.clock.advance(1000);
    m.report("leak", DRY);
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.length).toBe(1);
    m.clock.advance(1000);
    m.report("leak", DRY);
    m.report("thermo", { mode: "off" });
    expect((await m.events(c, "latch")).map((e: any) => e.latch)).toEqual(["set", "cleared"]);
  });

  // One home per test: several in one outlast the test's bound under a parallel run.
  it.each([undefined, "latch-misses-an-extension" as const])(
    "refuses an extension action on a device its rule actuated, but under latch-misses-an-extension (GA-SAFE-7), mutation %s", async (mutation) => {
      const { m } = await leaked({ mutation });
      const r = await m.apply("hall:valve", COUNTDOWN, { token: true });
      expect(short(r.outcomes[0])).toBe(mutation ? "dispatched" : "refused(latched)");
      expect(m.sent.filter((x) => x.body.value.action === COUNTDOWN).length).toBe(mutation ? 1 : 0);
    });

  it("holds while a sensor it reads is not live, a dry report included; clears once it is live again (GA-SAFE-7)", async () => {
    const { m, c } = await leaked();
    m.send("devices/leak/status", { deviceId: "leak", available: false, leak: false, timestamp: new Date(m.clock.now()).toISOString() });
    expect(body(await m.a.call(m.owner, "state", { targets: ["hall:leak"] })).targets["hall:leak"].liveness).toBe("dead");
    expect(body(await m.a.call(m.owner, "state", {})).latches.length).toBe(1);
    m.clock.advance(1000);
    m.send("devices/leak/status", { deviceId: "leak", available: true, timestamp: new Date(m.clock.now()).toISOString() });
    m.send("status", status(DEVICES.map((d) => d.id), { publishedAt: new Date(m.clock.now()).toISOString() }));
    expect((await m.events(c, "latch")).map((e: any) => e.latch)).toEqual(["set", "cleared"]);
  });

  it.each([undefined, "clears-a-latch-on-an-assumed-value" as const])(
    "never clears on an assumed value, but under clears-a-latch-on-an-assumed-value (GA-SAFE-7), mutation %s", async (mutation) => {
      const r = latched({ latch: { condition: { device: "hall:ac", key: "mode", op: "eq", value: "off" } } });
      const { m, c } = await leaked({ mutation }, r);
      const a = await m.apply("hall:ac", "climate.set_mode", { args: { mode: "off" } });
      expect(a.outcomes[0].outcome).toBe("dispatched");
      m.ack(m.sent.at(-1)!, "sent");
      await flush();
      expect((await m.events(c, "latch")).map((e: any) => e.latch)).toEqual(mutation ? ["set", "cleared"] : ["set"]);
    });

  it("raises its undo to no_voice once it cleared, needing a token whose for names a person, until such an action runs (GA-SAFE-7)", async () => {
    const r = { op: "upsert", kind: "safety_rule", value: { id: "leak-stops-heat", trigger: LEAK,
      actions: [{ target: "hall:thermo", action: "climate.set_mode", args: { mode: "off" } }], latch: { condition: { ...LEAK, value: false } } } };
    const m = await home();
    body(await m.configure([r]));
    m.report("leak", { leak: true });
    await flush();
    m.ack(m.sent[0]!, "applied");
    m.report("thermo", { mode: "off" });
    m.clock.advance(1000);
    m.report("leak", DRY);
    expect(await m.plan("hall:thermo", "climate.set_mode", { mode: "heat" })).toMatchObject({ verdict: "refuse", reason: "token", tier: "no_voice" });
    // Turning it off again is no undo: at its own tier.
    expect((await m.plan("hall:thermo", "climate.set_mode", { mode: "off" })).tier).toBe("reversible");
    // A token for a rule's step is no person's yes.
    const rules = await m.apply("hall:thermo", "climate.set_mode", { args: { mode: "heat" }, for: { rule: "evening" }, token: true });
    expect(short(rules.outcomes[0])).toBe("refused(token)");
    const person = await m.apply("hall:thermo", "climate.set_mode", { args: { mode: "heat" }, token: true });
    expect(short(person.outcomes[0])).toBe("dispatched");
    // Once it ran, the undo is the household's again.
    expect(await m.plan("hall:thermo", "climate.set_mode", { mode: "heat" })).toMatchObject({ tier: "reversible" });
  });

  it("is cleared by the owner's clear_latch: cleared_by_owner, a model change; refused when none is held; a rule deleted clears its own (GA-SAFE-9)", async () => {
    const { m, c } = await leaked();
    await refused(m.configure([{ op: "upsert", kind: "clear_latch", value: { rule_id: "no-such-rule" } }]), /no latch of safety rule no-such-rule/);
    const { revision } = body(await m.a.call(m.owner, "describe", {}));
    const dry = body(await m.a.call(m.owner, "configure", { changes: [{ op: "upsert", kind: "clear_latch", value: { rule_id: "leak-closes-valve" } }],
      expected_revision: revision, dry_run: true }));
    expect(dry.diff).toBe("- latch leak-closes-valve");
    expect(body(await m.configure([{ op: "upsert", kind: "clear_latch", value: { rule_id: "leak-closes-valve" } }])).revision).toBeGreaterThan(revision);
    expect((await m.events(c, "latch")).map((e: any) => e.latch)).toEqual(["set", "cleared_by_owner"]);
    expect((await m.events(c, "model")).some((e: any) => e.safety_rule === "leak-closes-valve" && e.latch === "cleared_by_owner")).toBe(true);
  });

  it.each([undefined, "forgets-a-latch"] as const)(
    "is held across a restart: a plan to open the valve is still refuse(latched); mutation %s forgets it (GA-SAFE-7)", async (mutation) => {
      const db = await memoryDb();
      const { m } = await leaked({ db: lasting(db) });
      await m.store.settled();
      m.a.stop();
      await m.store.close();
      const again = await home({ db, fresh: false, mutation });
      again.send("devices", { devices: DEVICES }, true);
      again.a.listening("hall");
      again.send("status", status(DEVICES.map((d) => d.id)));
      expect(again.a.safety.latches.holds("leak-closes-valve")).toBe(mutation === undefined);
      expect((await again.plan("hall:valve", "valve.open")).reason === "latched").toBe(mutation === undefined);
    });

  it("is cleared, cleared_by_owner, when its rule is deleted (GA-SAFE-9)", async () => {
    const again = await leaked();
    body(await again.m.configure([{ op: "delete", kind: "safety_rule", value: { id: "leak-closes-valve" } }]));
    expect((await again.m.events(again.c, "latch")).map((e: any) => e.latch)).toEqual(["set", "cleared_by_owner"]);
    expect(body(await again.m.a.call(again.m.owner, "state", {})).latches).toEqual([]);
  });
});

describe("the undos raised after latches clear (GA-SAFE-7)", () => {
  /** Latches alone, over a store that keeps nothing: what they raise is in memory. */
  function latches(values: Record<string, unknown>) {
    const store = { write: async () => undefined, query: async () => ({ rows: [] }) } as never;
    return new Latches({ store, now: () => 0, mutant: Mutant.none, reported: (d, k) => values[`${d} ${k}`], assumed: () => undefined,
      liveness: () => "live", emit: () => undefined });
  }
  const cond = { latch: { condition: { ...LEAK, value: false } } };
  const two = new Map<string, SafetyRule>([
    ["off", { id: "off", trigger: LEAK, actions: [{ target: "hall:thermo", action: "climate.set_mode", args: { mode: "off" } }], ...cond } as SafetyRule],
    ["cool", { id: "cool", trigger: LEAK, actions: [{ target: "hall:thermo", action: "climate.set_setpoint", args: { celsius: 5 } }], ...cond } as SafetyRule]]);

  it("returns to its own tier only the key an undo that ran undid: another latch's undo on the device still needs its own yes", () => {
    const l = latches({ "hall:leak leak": false });
    for (const r of two.values()) l.set(r);
    expect(l.check(two).sort()).toEqual(["cool", "off"]);
    expect(l.raises("hall:thermo", "climate.set_mode", { mode: "heat" })).toBe(true);
    expect(l.raises("hall:thermo", "climate.set_setpoint", { celsius: 20 })).toBe(true);
    l.ran("hall:thermo", "climate.set_mode", { mode: "heat" });
    expect(l.raises("hall:thermo", "climate.set_mode", { mode: "heat" })).toBe(false);
    expect(l.raises("hall:thermo", "climate.set_setpoint", { celsius: 20 })).toBe(true);
  });

  it("raises each undo key once however often its latch fires and clears while no undo runs (the whole-applier review's M2)", () => {
    const l = latches({ "hall:leak leak": false });
    const r = two.get("off")!;
    for (let i = 0; i < 3; i++) {
      l.set(r);
      l.check(two);
    }
    const raised = (l as unknown as { raised: Map<string, unknown[]> }).raised;
    expect(raised.get("hall:thermo")).toEqual([{ device: "hall:thermo", key: "mode", value: "off" }]);
  });

  it("raises an action whose side effect undoes a cleared latch: level.set_level after a turn_off", () => {
    const l = latches({ "hall:leak leak": false });
    const rules = new Map<string, SafetyRule>([["lamp", { id: "lamp", trigger: LEAK, actions: [{ target: "hall:lamp", action: "onoff.turn_off" }], ...cond } as SafetyRule]]);
    l.set(rules.get("lamp")!);
    expect(l.latched("hall:lamp", "level.set_level", { level: 80 })).toBe(true);
    l.check(rules);
    expect(l.raises("hall:lamp", "level.set_level", { level: 80 })).toBe(true);
    l.ran("hall:lamp", "level.set_level", { level: 80 });
    expect(l.raises("hall:lamp", "onoff.turn_on", {})).toBe(false);
  });
});
