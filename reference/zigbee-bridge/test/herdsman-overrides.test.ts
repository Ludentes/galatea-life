import { afterEach, describe as group, expect, it } from "vitest";
import { findByDevice } from "zigbee-herdsman-converters";
import { declaration } from "../src/declaring.js";
import { descriptionProblem } from "../src/description.js";
import { describe, NAMESPACE, UNKNOWN_REACH_MS } from "../src/herdsman/describe.js";
import { OVERRIDES, overrideFor } from "../src/herdsman/overrides.js";
import { extensionProblems } from "../src/vocabulary.js";
import { devices, PRESENCE, PRESENCE_ROW, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices> | undefined;
afterEach(() => { db?.close(); db = undefined; });

async function described(ieee: string, settings: Record<string, unknown> = {}) {
  db?.close();
  db = devices([SENSOR_ROW, PUSHER_ROW, PRESENCE_ROW]);
  const device = db.get(ieee);
  const definition = (await findByDevice(device, true))!;
  return describe(device, definition, { override: overrideFor(definition.model), settings });
}

const SENSOR_CAP = `${NAMESPACE}.ts0210`;
const PUSHER_CAP = `${NAMESPACE}.ts0001_fingerbot`;

group("the override table, against the converters' own definitions", () => {
  it("lists every writable key a passported model has, and no other, as a setting (GA-BRIDGE-79)", async () => {
    for (const ieee of [SENSOR, PUSHER, PRESENCE]) {
      db?.close(); db = devices([SENSOR_ROW, PUSHER_ROW, PRESENCE_ROW]);
      const device = db.get(ieee);
      const definition = (await findByDevice(device, true))!;
      const exposes = (typeof definition.exposes === "function" ? definition.exposes(device, {}) : definition.exposes)
        .flatMap((e) => ("features" in e && e.features?.length ? e.features : [e]));
      // A writable expose that no action confirms (the pusher's on/off is an action's) is a setting.
      const writable = exposes.filter((e) => e.property && (e.access ?? 0) & 2 && e.property !== "state").map((e) => e.property!).sort();
      expect([...(overrideFor(definition.model)?.settings ?? [])].sort(), definition.model).toEqual(writable);
    }
  });
  it("reads a key's value only within its schema, the expose's or the override's (GA-BRIDGE-1)", async () => {
    const { keys } = await described(SENSOR);
    // The sensitivity's schema is the device's own range, 0 to 200, though its set takes 0 to 50 (plan 2c-2 review M3).
    expect([0, 50, 51, 200, 201, "20"].map((v) => keys.get("sensitivity")!.from(v))).toEqual([0, 50, 51, 200, undefined, undefined]);
    expect([true, false, 1, "true"].map((v) => keys.get("tamper")!.from(v))).toEqual([true, false, undefined, undefined]);
    // An enum's reading outside its values is none: the button pusher's mode 7 (plan 2c-2 review M2).
    const pusher = await described(PUSHER);
    expect(["click", "program", 7, "press"].map((v) => pusher.keys.get("mode")!.from(v))).toEqual(["click", "program", undefined, undefined]);
  });

  it("is keyed by the converters' model, and has no entry for an inherited name", () => {
    expect(Object.keys(OVERRIDES)).toEqual(["ZG-204ZV", "TS0210", "TS0001_fingerbot"]);
    expect(overrideFor("constructor")).toBeUndefined();
    expect(overrideFor("TS0601")).toBeUndefined();
  });

  it("makes the vibration sensor's vibration an occurrence, and declares the zone's tamper and battery-low bits", async () => {
    const { description: d, keys } = await described(SENSOR);
    expect(keys.get("vibration")).toMatchObject({ key: `${SENSOR_CAP}.vibration`, kind: "event" });
    const sensitivity = "Sensitivity of the sensor (0 = highest sensitivity, 50 = lowest sensitivity). Press button on the device right before changing this";
    expect(d.extensions![0]!.keys).toEqual([
      { key: `${SENSOR_CAP}.voltage`, description: "Voltage of the battery in millivolts", schema: { type: "number" } },
      // Only `true` is an occurrence: a status with the alarm bit clear is none (plan 2c-1 review M5).
      { key: `${SENSOR_CAP}.vibration`, kind: "event", description: "Indicates whether the device detected vibration", schema: { enum: [true] } },
      { key: `${SENSOR_CAP}.sensitivity`, description: sensitivity, schema: { type: "number", minimum: 0, maximum: 200 } },
      { key: `${SENSOR_CAP}.tamper`, description: "The IAS zone status's tamper bit", schema: { type: "boolean" } },
    ]);
    // The zone's battery-low bit is the vocabulary's `battery_low` (GA-BRIDGE-78).
    expect(d.sensorKeys).toContain("battery_low");
    expect(keys.get("tamper")!.from(true)).toBe(true);
    expect([keys.get("vibration")!.from(true), keys.get("vibration")!.from(false)]).toEqual([true, undefined]);
  });

  it("leaves the vibration sensor's sensitivity unoffered by the core, its reach not known (GA-BRIDGE-7)", async () => {
    const { description: d } = await described(SENSOR);
    expect(d.reachMs).toBe(UNKNOWN_REACH_MS);
    expect(d.actions.map((a) => a.action)).toEqual([`${SENSOR_CAP}.set_sensitivity`]);
    // Its set takes the converter's 0 to 50 alone, though the key reads up to 200 (plan 2c-2 review M3).
    expect(d.actions[0]!.args).toEqual({ value: { min: 0, max: 50 } });
    expect(d.extensions![0]!.actions![0]!.schema).toEqual({ type: "object", properties: { value: { type: "number", minimum: 0, maximum: 50 } } });
    const taken = declaration(d, { misnames: false, hasPin: false });
    expect(taken.outOfReach).toBe(true);
    expect(taken.d.actions).toEqual([]);
  });

  it("lists the devices' settings, kept across restarts with their time (GA-BRIDGE-79)", async () => {
    expect((await described(SENSOR)).description.settings).toEqual([`${SENSOR_CAP}.sensitivity`]);
    expect((await described(PUSHER)).description.settings).toEqual(["mode", "lower", "upper", "delay", "reverse", "touch"]
      .map((k) => `${PUSHER_CAP}.${k}`));
  });

  it("offers the button pusher's onoff only once its mode was observed (GA-BRIDGE-74), and never program mode", async () => {
    const { description: d, settings } = await described(PUSHER);
    expect(d.settings).toContain(`${PUSHER_CAP}.mode`);
    expect([...settings][0]).toEqual(["mode", `${PUSHER_CAP}.mode`]);
    expect(d.actions.map((a) => a.action).filter((a) => a.startsWith("onoff."))).toEqual([]);
    expect(d.actions.find((a) => a.action === `${PUSHER_CAP}.set_mode`)).toMatchObject({ args: { value: ["click", "switch"] }, idempotent: false });
    // The extension's action takes what the action's arguments do: program mode is not offered.
    expect(d.extensions![0]!.actions!.find((a) => a.action === `${PUSHER_CAP}.set_mode`)!.schema).toEqual({ type: "object",
      properties: { value: { enum: ["click", "switch"] } } });
    expect(d.reachMs).toBe(2500);
    const program = await described(PUSHER, { [`${PUSHER_CAP}.mode`]: "program" });
    expect(program.description.actions.map((a) => a.action).filter((a) => a.startsWith("onoff."))).toEqual([]);
  });

  it("offers the button pusher a stateless press in click mode and a position in switch mode", async () => {
    // In click mode `on` stays true after every press, so a stateful turn on would be `already` from
    // the second press on; a bridge cannot make `onoff` stateless (*Devices*), so a press is the
    // extension's own, stateless, and a toggle by default (the maintainer's rulings, 2026-10-06).
    const press = `${PUSHER_CAP}.press`;
    const click = await described(PUSHER, { [`${PUSHER_CAP}.mode`]: "click" });
    expect(click.description.actions.filter((a) => a.action.startsWith("onoff."))).toEqual([]);
    expect(click.description.actions.find((a) => a.action === press)).toEqual(
      { action: press, idempotent: false, stateless: true, toggles: true, confirms: true });
    expect(click.description.extensions![0]!.actions!.map((a) => a.action)).toContain(press);
    expect(click.actions.get(press)!.value({})).toBe("ON");
    const sw = (await described(PUSHER, { [`${PUSHER_CAP}.mode`]: "switch" })).description;
    expect(sw.actions.filter((a) => a.action.startsWith("onoff.")).map((a) => a.idempotent)).toEqual([true, true]);
    expect(sw.actions.map((a) => a.action)).not.toContain(press);
    const unknown = (await described(PUSHER)).description;
    expect(unknown.actions.map((a) => a.action)).not.toContain(press);
    // Within reach, so the core offers them.
    expect(declaration(sw, { misnames: false, hasPin: false }).outOfReach).toBe(false);
  });

  it("gives descriptions the port takes", async () => {
    for (const [ieee, s] of [[SENSOR, {}], [PUSHER, {}], [PUSHER, { [`${PUSHER_CAP}.mode`]: "click" }]] as const) {
      const { description: d } = await described(ieee, s);
      expect(descriptionProblem(d)).toBeUndefined();
      expect(extensionProblems(d.extensions)).toEqual(new Map());
    }
  });
});
