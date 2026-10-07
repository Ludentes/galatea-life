import { describe, expect, it } from "vitest";
import {
  closedActions, closedSets, declaredKeys, extensionKeys, extensionProblems, fits, namedArgs, schemaType, STANDARD_KEYS,
} from "../src/vocabulary.js";

describe("the closed vocabulary", () => {
  it("declares a capability's actions with their args, stateless where they set nothing", () => {
    expect(closedActions("cover", true)).toEqual([
      { action: "cover.open", idempotent: true, stateless: false, confirms: true },
      { action: "cover.close", idempotent: true, stateless: false, confirms: true },
      { action: "cover.set_position", idempotent: true, stateless: false, confirms: true, args: { position: { min: 0, max: 100 } } },
      { action: "cover.stop", idempotent: true, stateless: true, confirms: true },
    ]);
    expect(closedActions("onoff", false).map((a) => a.confirms)).toEqual([false, false]);
    expect(closedActions("media", true)).toEqual([]);
  });

  it("names the keys an action sets, and with what", () => {
    expect(closedSets("onoff.turn_on")).toEqual({ on: { fixed: true } });
    expect(closedSets("level.set_level")).toEqual({ level: { arg: "level" } });
    expect(closedSets("cover.stop")).toEqual({});
    expect(closedSets("org.galatea.zigbee.ts0001_fingerbot.set_mode")).toBeUndefined();
  });

  it("gives a device's state keys from its capabilities, and its sensor keys only under sensor", () => {
    expect([...declaredKeys(["onoff", "level"])]).toEqual([["on", "boolean"], ["level", "number"]]);
    expect([...declaredKeys(["sensor"], ["temperature", "leak", "app"])]).toEqual([["temperature", "number"], ["leak", "boolean"]]);
    expect([...declaredKeys(["onoff"], ["temperature"])]).toEqual([["on", "boolean"]]);
  });

  it("takes a reading of its type, or unknown", () => {
    expect(fits("boolean", true)).toBe(true);
    expect(fits("boolean", "unknown")).toBe(true);
    expect(fits("boolean", 1)).toBe(false);
    expect(fits("number", Number.NaN)).toBe(false);
  });
});

describe("inherited names", () => {
  it("are no capability, action or sensor key", () => {
    expect(closedSets("constructor.x")).toBeUndefined();
    expect(closedSets("onoff.constructor")).toBeUndefined();
    expect(closedSets("__proto__.x")).toBeUndefined();
    expect(closedActions("constructor", true)).toEqual([]);
    expect(closedActions("__proto__", true)).toEqual([]);
    expect([...declaredKeys(["constructor", "sensor"], ["constructor", "toString", "leak"])]).toEqual([["leak", "boolean"]]);
  });
});

describe("namedArgs", () => {
  const [setLevel] = closedActions("level", true);
  const [turnOn] = closedActions("onoff", true);
  const setMode = closedActions("climate", true)[0]!;

  it("names the one argument a command carries bare", () => {
    expect(namedArgs(setLevel!, 40)).toEqual({ level: 40 });
    expect(namedArgs(setMode, "heat")).toEqual({ mode: "heat" });
  });

  it("takes no argument where the action has none", () => {
    expect(namedArgs(turnOn!, undefined)).toEqual({});
    expect(namedArgs(turnOn!, true)).toBe("onoff.turn_on takes no argument");
  });

  it("refuses an argument outside its constraint", () => {
    expect(namedArgs(setLevel!, 101)).toBe("level is at most 100");
    expect(namedArgs(setLevel!, "40")).toBe("level is a number");
    expect(namedArgs(setMode, "dry")).toBe("mode is one of off, heat, cool, auto, fan");
  });

  it("refuses a number off its argument's step, counted from the minimum, or from 0 with none (plan 2c-2 review I1)", () => {
    const decl = (c: { min?: number; max?: number; step?: number }) => ({ action: "org.galatea.zigbee.x.set_delay", idempotent: true,
      stateless: false, confirms: false, args: { value: c } });
    expect(namedArgs(decl({ min: 0, max: 10, step: 1 }), 3)).toEqual({ value: 3 });
    expect(namedArgs(decl({ min: 0, max: 10, step: 1 }), 2.5)).toBe("value goes in steps of 1 from 0");
    expect(namedArgs(decl({ min: 50, max: 100, step: 5 }), 75)).toEqual({ value: 75 });
    expect(namedArgs(decl({ min: 50, max: 100, step: 5 }), 72)).toBe("value goes in steps of 5 from 50");
    expect(namedArgs(decl({ max: 10, step: 0.1 }), 0.3)).toEqual({ value: 0.3 });
    expect(namedArgs(decl({ max: 10, step: 0.1 }), 0.35)).toBe("value goes in steps of 0.1 from 0");
    // The range is checked first.
    expect(namedArgs(decl({ min: 0, max: 10, step: 1 }), 11)).toBe("value is at most 10");
  });

  it("takes an object of several arguments, refusing one it does not know", () => {
    const decl = { action: "org.galatea.zigbee.x.set", idempotent: true, stateless: false, confirms: true,
      args: { a: "any" as const, b: { min: 0 } } };
    expect(namedArgs(decl, { a: "x", b: 2 })).toEqual({ a: "x", b: 2 });
    expect(namedArgs(decl, { a: "x", b: 2, c: 1 })).toBe("unknown arguments: c");
    expect(namedArgs(decl, 3)).toBe("org.galatea.zigbee.x.set takes an object of a, b");
  });
});

describe("extensions", () => {
  const pusher = {
    capability: "org.galatea.test.pusher",
    description: "A button pusher",
    actions: [{ action: "org.galatea.test.pusher.set_mode", schema: { enum: ["click", "switch"] } }],
    keys: [
      { key: "org.galatea.test.pusher.mode", kind: "state" as const, schema: { enum: ["click", "switch"] } },
      { key: "org.galatea.test.pusher.reverse", schema: { type: "boolean" } },
      { key: "org.galatea.test.pusher.pressed", kind: "event" as const, schema: { type: "integer" } },
      { key: "org.galatea.test.pusher.raw" },
    ],
  };

  it("gives each key's type from its schema, by kind, absent being state", () => {
    const keys = extensionKeys([pusher]);
    expect([...keys.state]).toEqual([["org.galatea.test.pusher.mode", "string"], ["org.galatea.test.pusher.reverse", "boolean"],
      ["org.galatea.test.pusher.raw", "scalar"]]);
    expect([...keys.events]).toEqual([["org.galatea.test.pusher.pressed", "number"]]);
    expect(schemaType({ enum: [1, "a"] })).toBe("scalar");
    expect(schemaType({ type: "object" })).toBeUndefined();
    expect(schemaType({ enum: [{}] })).toBeUndefined();
    expect(fits("scalar", "x")).toBe(true);
    expect(fits("scalar", {})).toBe(false);
  });

  it("finds nothing wrong with a well-named extension", () => {
    expect(extensionProblems([pusher])).toEqual(new Map());
  });

  it("names each extension that breaks Extension names, and why (GA-BRIDGE-77)", () => {
    const problems = extensionProblems([
      { capability: "pusher", keys: [] },
      { capability: "onoff" },
      { capability: "org.galatea.test.a", actions: [{ action: "org.galatea.test.b.go" }] },
      { capability: "org.galatea.test.c", keys: [{ key: "org.galatea.test.c.Mode" }] },
      { capability: "org.galatea.test.vibe", keys: [{ key: "org.galatea.test.vibe.battery", schema: { type: "number" } }] },
      { capability: "org.galatea.test.d", keys: [{ key: "org.galatea.test.d.on" }] },
      { capability: "org.galatea.test.e", keys: [{ key: "org.galatea.test.e.blob", schema: { type: "object" } }] },
      { capability: "org.galatea.test.f", keys: [{ key: "org.galatea.test.f.mode" }] },
    ]);
    expect([...problems.keys()]).toEqual(["pusher", "onoff", "org.galatea.test.a", "org.galatea.test.c", "org.galatea.test.vibe",
      "org.galatea.test.d", "org.galatea.test.e"]);
    expect(problems.get("org.galatea.test.vibe")).toBe("the key org.galatea.test.vibe.battery reports a quantity the vocabulary names");
    expect(problems.get("org.galatea.test.e")).toBe("the key org.galatea.test.e.blob's schema is no scalar");
  });

  it("names, and never throws on, an extension, action or key that is no object or whose name is no string", () => {
    const problems = extensionProblems([
      null, { capability: 7 }, { capability: "org.galatea.test.g", actions: [{ action: 9 }] },
      { capability: "org.galatea.test.h", keys: [null] }, { capability: "org.galatea.test.i", keys: "mode" },
    ] as never);
    expect([...problems.keys()]).toEqual(["undefined", "7", "org.galatea.test.g", "org.galatea.test.h", "org.galatea.test.i"]);
    expect(problems.get("org.galatea.test.g")).toBe("the action 9 is not named org.galatea.test.g.<name>");
  });

  it("refuses a capability that is another's with a segment added, both of them", () => {
    const problems = extensionProblems([{ capability: "org.galatea.test.x" }, { capability: "org.galatea.test.x.y" }]);
    expect([...problems.keys()]).toEqual(["org.galatea.test.x", "org.galatea.test.x.y"]);
  });

  it("counts every sensor key and each one-key capability's key as the vocabulary's, and not climate's", () => {
    expect([...STANDARD_KEYS].sort()).toEqual(["app", "battery", "battery_low", "camera_in_use", "color", "humidity", "illuminance",
      "leak", "level", "locked", "microphone_in_use", "motion", "occupancy", "on", "open", "opening", "position", "temperature"]);
  });
});
