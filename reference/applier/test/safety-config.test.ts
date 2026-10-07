import { describe, expect, it } from "vitest";
import { evaluate, evaluate3 } from "../src/safety/language.js";
import { body, DEVICES, home, leak, LEAK, refused, rule, status, T, V } from "./safe-home.js";

describe("the rule language", () => {
  it("holds a comparison only on a known value, orders numbers only, and joins by all and any", () => {
    const values: Record<string, unknown> = { "d:t": 21, "d:s": "on" };
    const read = (d: string, k: string) => values[`${d}:${k}`];
    expect(evaluate({ device: "d", key: "t", op: "gt", value: 20 }, read)).toBe(true);
    expect(evaluate({ device: "d", key: "t", op: "le", value: 20 }, read)).toBe(false);
    // What is not known holds nothing, `ne` included.
    expect(evaluate({ device: "d", key: "x", op: "ne", value: 1 }, read)).toBe(false);
    expect(evaluate({ device: "d", key: "s", op: "gt", value: 1 }, read)).toBe(false);
    expect(evaluate({ any: [{ device: "d", key: "x", op: "eq", value: 1 }, { device: "d", key: "s", op: "eq", value: "on" }] }, read)).toBe(true);
    expect(evaluate({ all: [{ device: "d", key: "t", op: "ge", value: 21 }, { device: "d", key: "s", op: "ne", value: "on" }] }, read)).toBe(false);
  });
});

describe("the rule language, three-valued (the maintainer's ruling 8)", () => {
  it("leaves a term on a key with no report undetermined; a known false term decides an all, a known true one an any; a reported null is known", () => {
    const values: Record<string, unknown> = { "d:t": 21, "d:n": null };
    const read = (d: string, k: string) => values[`${d}:${k}`];
    const X = { device: "d", key: "x", op: "eq", value: 1 };
    const HOT = { device: "d", key: "t", op: "gt", value: 20 };
    const COLD = { device: "d", key: "t", op: "lt", value: 20 };
    expect(evaluate3(X, read)).toBeUndefined();
    expect(evaluate3({ all: [X, HOT] }, read)).toBeUndefined();
    expect(evaluate3({ all: [X, COLD] }, read)).toBe(false);
    expect(evaluate3({ any: [X, HOT] }, read)).toBe(true);
    expect(evaluate3({ any: [X, COLD] }, read)).toBeUndefined();
    expect(evaluate3({ any: [COLD, { all: [HOT, X] }] }, read)).toBeUndefined();
    expect(evaluate3({ device: "d", key: "n", op: "ne", value: 1 }, read)).toBe(false);
  });
});

describe("configure of a safety rule", () => {
  it("takes a rule over adopted devices and lists it in describe; a delete removes it", async () => {
    const m = await home();
    body(await m.configure([rule()]));
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules).toMatchObject([{ id: "leak-closes-valve", trigger: LEAK }]);
    body(await m.configure([{ op: "delete", kind: "safety_rule", value: { id: "leak-closes-valve" } }]));
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules).toEqual([]);
  });

  it("refuses a rule naming a device not adopted, and a forget or an adoption's delete of one a rule names (GA-ADOPT-1)", async () => {
    const m = await home();
    body(await m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:valve" } }]));
    await refused(m.configure([rule()]), /hall:valve, which would not be adopted/);
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:valve", class: "water_valve" } }, rule()]));
    await refused(m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:leak" } }]), /safety rule leak-closes-valve names hall:leak/);
    m.send("devices", { devices: DEVICES.filter((d) => d.id !== "leak") }, true);
    await refused(m.configure([{ op: "upsert", kind: "forget", value: { device: "hall:leak" } }]), /safety rule leak-closes-valve names/);
  });

  it("refuses a key the device does not report, an event key, an order on a string, an action not offered or declared toggles: true (GA-EVT-8, GA-SAFE-13)", async () => {
    const m = await home();
    await refused(m.configure([rule({ trigger: { ...LEAK, key: "wet" } })]), /reports no state key wet/);
    await refused(m.configure([rule({ trigger: { device: "hall:button", key: `${V}.press`, op: "eq", value: "single" } })]), /event key/);
    await refused(m.configure([rule({ trigger: { ...LEAK, op: "gt" } })]), /compares a number/);
    await refused(m.configure([rule({ actions: [{ target: "hall:valve", action: "onoff.turn_off" }] })]), /offers no onoff.turn_off/);
    await refused(m.configure([rule({ actions: [{ target: "hall:tv", action: "onoff.turn_off" }] })]), /toggles: true/);
    const toggles = await home({ mutation: "toggles-by-safety-rule" });
    body(await toggles.configure([rule({ actions: [{ target: "hall:tv", action: "onoff.turn_off" }] })]));
  });

  it("refuses a rule actuating a device with other admins not known, unless it accepts them (GA-SAFE-6)", async () => {
    const m = await home();
    await refused(m.configure([rule({ actions: [{ target: "hall:shared", action: "valve.close" }] })]), /accepts_other_admins/);
    body(await m.configure([rule({ actions: [{ target: "hall:shared", action: "valve.close" }], accepts_other_admins: true })]));
  });

  it("refuses two rules setting one key of one device to different values (GA-SAFE-11)", async () => {
    const m = await home();
    body(await m.configure([rule()]));
    await refused(m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "dry-opens-valve", trigger: { ...LEAK, value: false },
      actions: [{ target: "hall:valve", action: "valve.open" }] } }]), /set hall:valve's open to different values/);
  });

  it("gives an open_loop notice for a rule actuating a device on a transport that can answer nothing (GA-ADOPT-6)", async () => {
    const m = await home();
    m.send("status", status(DEVICES.map((d) => d.id), { transports: [{ id: "radio", kind: "ir", state: "unknown", since: T }] }));
    const before = (await m.notices("open_loop")).length;
    body(await m.configure([rule()]));
    const after = await m.notices("open_loop");
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ rule_id: "leak-closes-valve", devices: ["hall:valve"] });
  });

  it("keeps a rule through a replacement, refuses new hardware lacking what it uses, and drops it under replaces-without-rules (GA-ADOPT-2)", async () => {
    for (const mutation of [undefined, "replaces-without-rules" as const]) {
      const m = await home({ mutation });
      body(await m.configure([rule()]));
      const sensor2 = { ...leak, id: "leak-2", stableIdentifier: "test:leak-2" };
      const bare = { ...leak, id: "leak-3", stableIdentifier: "test:leak-3", sensorKeys: ["temperature"] };
      m.send("devices", { devices: [...DEVICES, sensor2, bare] }, true);
      await refused(m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:leak-3", class: "sensor", replaces: "hall:leak" } }]),
        /lacks leak/);
      body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:leak-2", class: "sensor", replaces: "hall:leak" } }]));
      const rules = body(await m.a.call(m.owner, "describe", {})).safety_rules;
      expect(rules.length).toBe(mutation ? 0 : 1);
    }
  });
});
