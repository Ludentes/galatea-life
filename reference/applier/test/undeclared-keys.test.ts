import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/applier.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, LEAK, leak } from "./safe-home.js";

// covers: GA-SAFE-14: configure refuses a safety rule, latch or witness on a key its device does not
// declare, with `data { key, device, awaited }`; a declaration change disables a rule, latch or witness
// that then reads such a key, with a rule_disabled notice naming it. GA-SAFE-13's other faults are rule-check's.

/** A room thermometer whose humidity its bridge awaits (bridge, *Keys a device has not yet sent*). */
const temp = { id: "temp", stableIdentifier: "test:temp", transport: "radio", capabilities: ["sensor"], sensorKeys: ["temperature"],
  awaitedKeys: ["humidity"], actions: [], feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", otherAdmins: [] };
const extra = [heater, temp];
const errorOf = (r: ToolResult) => (r.ok ? { ok: true } : { error: r.error, data: r.data });
const ruleOn = (device: string, key: string, where: "trigger" | "latch" = "trigger") => ({ op: "upsert", kind: "safety_rule", value: {
  id: "r", trigger: where === "trigger" ? { device, key, op: "gt", value: 30 } : LEAK,
  ...(where === "latch" ? { latch: { condition: { device, key, op: "lt", value: 30 } } } : {}),
  actions: [{ target: "hall:valve", action: "valve.close" }] } });
const witnessOn = (key?: string) => ({ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:temp",
  ...(key ? { key } : {}), expect: "rises", within_s: 60 } });

describe("a key its device does not declare, at configure (GA-SAFE-14)", () => {
  it("refuses a rule, a latch and a witness on it with invalid_request and data { key, device, awaited }, awaited where the bridge awaits it", async () => {
    const m = await home({ extra });
    const { revision } = body(await m.a.call(m.owner, "describe", {}));
    expect(errorOf(await m.configure([ruleOn("hall:temp", "humidity")]))).toEqual({ error: "invalid_request",
      data: { key: "humidity", device: "hall:temp", awaited: true } });
    expect(errorOf(await m.configure([ruleOn("hall:temp", "pressure", "latch")]))).toEqual({ error: "invalid_request",
      data: { key: "pressure", device: "hall:temp", awaited: false } });
    expect(errorOf(await m.configure([witnessOn("humidity")]))).toEqual({ error: "invalid_request",
      data: { key: "humidity", device: "hall:temp", awaited: true } });
    expect(body(await m.a.call(m.owner, "describe", {})).revision).toBe(revision);
    body(await m.configure([ruleOn("hall:temp", "temperature"), witnessOn("temperature")]));
  });

  it("refuses a witness on a declared key that is no sensor key without GA-SAFE-14's data, and a keyless one on awaited keys alone naming them (preflight M3)", async () => {
    const m = await home({ extra: [heater, temp, { ...temp, id: "probe", stableIdentifier: "test:probe", sensorKeys: [], awaitedKeys: ["humidity"] }] });
    const onLamp = await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on",
      sensor: "hall:heater", key: "on", expect: "rises", within_s: 60 } }]);
    expect(onLamp.ok ? "accepted" : [onLamp.error, onLamp.message, onLamp.data]).toEqual(["invalid_request",
      expect.stringMatching(/on is not among its sensor keys/), undefined]);
    const keyless = await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on",
      sensor: "hall:probe", expect: "rises", within_s: 60 } }]);
    expect(keyless.ok ? "accepted" : keyless.message).toMatch(/awaits humidity/);
    // Keyed on the awaited key, the data says so even with no sensor key reported yet.
    expect(errorOf(await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on",
      sensor: "hall:probe", key: "humidity", expect: "rises", within_s: 60 } }]))).toEqual({ error: "invalid_request",
      data: { key: "humidity", device: "hall:probe", awaited: true } });
  });

  it("takes the rule under accepts-a-safety-rule-on-an-undeclared-key", async () => {
    const m = await home({ extra, mutation: "accepts-a-safety-rule-on-an-undeclared-key" });
    expect(errorOf(await m.configure([ruleOn("hall:temp", "humidity")]))).toEqual({ ok: true });
  });
});

describe("a key its device no longer declares, after a declaration change (GA-SAFE-14)", () => {
  it("disables a witness reading it, with a rule_disabled notice naming the key, shown disabled in describe until set again", async () => {
    const m = await home({ extra });
    body(await m.configure([witnessOn("temperature")]));
    const { revision } = body(await m.a.call(m.owner, "describe", {}));
    m.send("devices", { devices: [...DEVICES, heater, { ...temp, sensorKeys: ["humidity"], awaitedKeys: [] }] }, true);
    await flush();
    const [n] = await m.notices("rule_disabled");
    expect(n).toMatchObject({ witness: { device: "hall:heater", action: "onoff.turn_on" }, devices: ["hall:temp", "hall:heater"] });
    expect(n.text).toMatch(/temperature/);
    const d = body(await m.a.call(m.owner, "describe", {}));
    expect(d.revision).toBeGreaterThan(revision);
    const heaterDoc = d.devices.find((x: any) => x.id === "hall:heater").actions.find((a: any) => a.action === "onoff.turn_on");
    expect(heaterDoc.witness).toMatchObject({ sensor: "hall:temp", key: "temperature", disabled: expect.stringMatching(/temperature/) });
    // Set again, it is checked as new: refused while the key stays undeclared.
    expect(errorOf(await m.configure([witnessOn("temperature")]))).toMatchObject({ error: "invalid_request" });
    // Set again on a key it declares, it stands again.
    body(await m.configure([witnessOn("humidity")]));
    const again = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:heater").actions
      .find((a: any) => a.action === "onoff.turn_on");
    expect(again.witness).toEqual({ sensor: "hall:temp", key: "humidity", expect: "rises", within_s: 60 });
  });

  it("keeps a witness with no key on the key it resolved at configure, its sensor's first then, when the first key changes (the whole-applier review's M8)", async () => {
    const m = await home({ extra });
    body(await m.configure([witnessOn()]));
    const witnessOf = async () => body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:heater").actions
      .find((a: any) => a.action === "onoff.turn_on").witness;
    expect(await witnessOf()).toEqual({ sensor: "hall:temp", key: "temperature", expect: "rises", within_s: 60 });
    // The humidity comes first now: the witness still reads the temperature, which the sensor still declares.
    m.send("devices", { devices: [...DEVICES, heater, { ...temp, sensorKeys: ["humidity", "temperature"], awaitedKeys: [] }] }, true);
    await flush();
    expect(await m.notices("rule_disabled")).toEqual([]);
    expect((await witnessOf()).key).toBe("temperature");
    // The temperature gone: disabled, naming it.
    m.send("devices", { devices: [...DEVICES, heater, { ...temp, sensorKeys: ["humidity"], awaitedKeys: [] }] }, true);
    await flush();
    const [n] = await m.notices("rule_disabled");
    expect(n.text).toMatch(/temperature/);
  });

  it("judges a witness with no key against the key it resolved at configure across a restart, its sensor's first key changed meanwhile (the whole-applier review's M8)", async () => {
    const db = await memoryDb();
    const m = await home({ extra, db: lasting(db) });
    body(await m.configure([witnessOn()]));
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    // While the applier was down the sensor was re-taught: its first key is the humidity, the temperature gone.
    const again = await home({ db, fresh: false, extra, at: m.clock.now() });
    again.send("devices", { devices: [...DEVICES, heater, { ...temp, sensorKeys: ["humidity"], awaitedKeys: [] }] }, true);
    await flush();
    const [n] = await again.notices("rule_disabled");
    expect(n).toMatchObject({ witness: { device: "hall:heater", action: "onoff.turn_on" } });
    expect(n.text).toMatch(/temperature/);
  });

  it("disables a rule whose key is taken away under keeps-a-rule-on-a-re-taught-code too, which keeps only a toggle's", async () => {
    const m = await home({ extra, mutation: "keeps-a-rule-on-a-re-taught-code" });
    body(await m.configure([ruleOn("hall:temp", "temperature")]));
    m.send("devices", { devices: [...DEVICES, heater, { ...temp, sensorKeys: ["humidity"] }] }, true);
    await flush();
    const [n] = await m.notices("rule_disabled");
    expect(n).toMatchObject({ rule_id: "r" });
    expect(n.text).toMatch(/temperature/);
  });

  it("disables a rule whose latch reads it, naming the key", async () => {
    const m = await home({ extra });
    body(await m.configure([ruleOn("hall:temp", "temperature", "latch")]));
    m.send("devices", { devices: [...DEVICES.map((x) => (x.id === "leak" ? leak : x)), heater, { ...temp, sensorKeys: ["humidity"] }] }, true);
    await flush();
    const [n] = await m.notices("rule_disabled");
    expect(n).toMatchObject({ rule_id: "r" });
    expect(n.text).toMatch(/temperature/);
  });
});
