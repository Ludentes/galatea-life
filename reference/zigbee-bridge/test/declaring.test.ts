import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import { ackFor, declaration, entry, LONGEST_REACH_MS } from "../src/declaring.js";
import { closedActions } from "../src/vocabulary.js";
import { lamp } from "./fakes.js";

const door = () => lamp({ capabilities: ["lock"], actions: closedActions("lock", true), pinRequired: true });

describe("a declaration", () => {
  it("takes a sound description as it is", () => {
    const given = lamp();
    expect(declaration(given, { misnames: false, hasPin: false })).toEqual({ d: given, invalid: new Map(), pinMissing: false, outOfReach: false });
  });

  it("withholds a lock's unlock without its PIN, and offers it with one", () => {
    const without = declaration(door(), { misnames: false, hasPin: false });
    expect(without.pinMissing).toBe(true);
    expect(without.d.actions.map((a) => a.action)).toEqual(["lock.lock"]);
    expect(declaration(door(), { misnames: false, hasPin: true }).d.actions.map((a) => a.action)).toEqual(["lock.lock", "lock.unlock"]);
  });

  it("withholds every action beyond the longest reach, and only then", () => {
    expect(declaration(lamp({ reachMs: LONGEST_REACH_MS }), { misnames: false, hasPin: false }).outOfReach).toBe(false);
    const far = declaration(lamp({ reachMs: LONGEST_REACH_MS + 1 }), { misnames: false, hasPin: false });
    expect(far).toMatchObject({ outOfReach: true, d: { actions: [] } });
  });

  it("leaves out a misnamed extension with its actions, unless the mutation lets it through", () => {
    const given = lamp({ extensions: [{ capability: "pusher" }], actions: [{ action: "pusher.go", idempotent: true, stateless: true, confirms: true }] });
    const taken = declaration(given, { misnames: false, hasPin: false });
    expect([...taken.invalid.keys()]).toEqual(["pusher"]);
    expect(taken.d).toMatchObject({ extensions: [], actions: [] });
    expect(declaration(given, { misnames: true, hasPin: false }).d).toBe(given);
  });
});

describe("an entry in devices", () => {
  const plain = { claimsProtocol: false, hidesOtherAdmins: false };
  const SENS = "org.galatea.zigbee.radar.sensitivity";
  const radar = () => lamp({ capabilities: [], actions: [], settings: [SENS],
    extensions: [{ capability: "org.galatea.zigbee.radar", keys: [{ key: SENS, schema: { type: "number" } }] }] });

  it("lists every setting of the device, valid against devices.json, and leaves the field out when there is none (GA-BRIDGE-79)", () => {
    const e = entry("radar", radar(), "zigbee", [], plain);
    expect(e.settings).toEqual([SENS]);
    expect(validate("bridge/devices.json", { publishedAt: new Date(0).toISOString(), devices: [e] })).toEqual([]);
    expect("settings" in entry("lamp", lamp(), "zigbee", [], plain)).toBe(false);
    expect("settings" in entry("lamp", lamp({ settings: [] }), "zigbee", [], plain)).toBe(false);
  });
});

describe("selfChanging: what the device changes by itself (FL-GAP-2)", () => {
  const plain = { claimsProtocol: false, hidesOtherAdmins: false };
  const NS = "org.galatea.zigbee.radar";
  const presence = () => lamp({ capabilities: ["sensor"], sensorKeys: ["occupancy", "illuminance", "battery"], actions: [],
    settings: [`${NS}.fading_time`], extensions: [{ capability: NS, keys: [{ key: `${NS}.fading_time`, schema: { type: "number" } }] }] });

  it("declares every sensor key selfChanging, and no setting", () => {
    expect(entry("radar", presence(), "zigbee", [], plain).selfChanging).toEqual(["occupancy", "illuminance", "battery"]);
  });

  it("keeps out every key a vocabulary action sets, so a person's press still leases the device; a battery on it is the device's", () => {
    const pusher = lamp({ capabilities: ["onoff", "level", "sensor"], sensorKeys: ["battery"] });
    expect(entry("pusher", pusher, "zigbee", [], plain).selfChanging).toEqual(["battery"]);
    expect(entry("lamp", lamp(), "zigbee", [], plain)).not.toHaveProperty("selfChanging");
  });

  it("declares a thermostat's current temperature, not its mode or setpoint", () => {
    const trv = lamp({ capabilities: ["climate"], actions: closedActions("climate", true) });
    expect(entry("trv", trv, "zigbee", [], plain).selfChanging).toEqual(["current"]);
  });

  it("keeps a key out while the action that sets it is withheld: a lock without its PIN, a device out of reach", () => {
    const noPin = declaration(door(), { misnames: false, hasPin: false }).d;
    expect(entry("door", noPin, "zigbee", [], plain)).not.toHaveProperty("selfChanging");
    const far = declaration(lamp({ reachMs: LONGEST_REACH_MS + 1 }), { misnames: false, hasPin: false }).d;
    expect(far.actions).toEqual([]);
    expect(entry("far", far, "zigbee", [], plain)).not.toHaveProperty("selfChanging");
  });

  it("keeps a sensor key out that an extension action's confirmedBy names", () => {
    const d = lamp({ capabilities: ["sensor"], sensorKeys: ["illuminance", "battery"],
      actions: [{ action: `${NS}.calibrate`, idempotent: true, stateless: false, confirms: true, confirmedBy: { key: "illuminance", value: 0 } }] });
    expect(entry("radar", d, "zigbee", [], plain).selfChanging).toEqual(["battery"]);
  });

  it("is valid against devices.json", () => {
    const e = entry("radar", presence(), "zigbee", [], plain);
    expect(validate("bridge/devices.json", { publishedAt: new Date(0).toISOString(), devices: [e] })).toEqual([]);
  });

  it("leaves the sensor keys out under `leaves-a-reading-unmarked`, extension keys still in", () => {
    const d = lamp({ capabilities: ["sensor"], sensorKeys: ["occupancy"], actions: [],
      extensions: [{ capability: NS, keys: [{ key: `${NS}.voltage`, schema: { type: "number" } }] }] });
    expect(entry("radar", d, "zigbee", [], plain).selfChanging).toEqual(["occupancy", `${NS}.voltage`]);
    expect(entry("radar", d, "zigbee", [], { ...plain, leavesReadingsUnmarked: true }).selfChanging).toEqual([`${NS}.voltage`]);
  });
});

describe("an ack", () => {
  const confirmed = closedActions("onoff", true)[0]!;
  it("follows the protocol's word, and a mutation misreports only an unconfirmed transmission", () => {
    expect(ackFor(confirmed, { kind: "confirmed" })).toEqual(["applied"]);
    expect(ackFor(confirmed, { kind: "transmitted" })).toEqual(["failed", "no_confirmation", "the protocol gave no answer"]);
    expect(ackFor(confirmed, "late", "applied-before-confirmation")).toEqual(["applied"]);
    expect(ackFor(confirmed, { kind: "refused", reason: "refused", detail: "UNSUP_COMMAND" }, "unreachable-after-transmit"))
      .toEqual(["failed", "refused", "UNSUP_COMMAND"]);
  });
});
