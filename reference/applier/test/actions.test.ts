import { describe, expect, it } from "vitest";
import { argsFault, commandValue, holds } from "../src/gate/actions.js";

describe("the actions' arguments (refuse(invalid_args))", () => {
  it("takes each standard action's arguments, and nothing else", () => {
    expect(argsFault("onoff.turn_on", {})).toBeUndefined();
    expect(argsFault("level.set_level", { level: 40 })).toBeUndefined();
    expect(argsFault("color.set_color", { rgb: "#ff8800" })).toBeUndefined();
    expect(argsFault("climate.set_mode", { mode: "cool" })).toBeUndefined();
    expect(argsFault("climate.set_setpoint", { celsius: 21.5 })).toBeUndefined();
    expect(argsFault("notify.notify", { text: "hi", urgency: "info" })).toBeUndefined();
    expect(argsFault("notify.notify", { text: "hi", urgency: "info", from: { notice: "n-1" } })).toBeUndefined();
    expect(argsFault("power.shutdown", {})).toBeUndefined();
    expect(argsFault("power.shutdown", { delay_s: 30 })).toBeUndefined();
  });

  it("refuses a missing, extra, mistyped or out-of-range argument", () => {
    expect(argsFault("level.set_level", {})).toMatch(/level is required/);
    expect(argsFault("level.set_level", { level: 101 })).toMatch(/level/);
    expect(argsFault("level.set_level", { level: "40" })).toMatch(/level/);
    expect(argsFault("onoff.turn_on", { level: 1 })).toMatch(/takes no argument level/);
    expect(argsFault("color.set_color", { rgb: "orange" })).toMatch(/rgb/);
    expect(argsFault("climate.set_mode", { mode: "dry" })).toMatch(/mode/);
    expect(argsFault("climate.set_setpoint", { celsius: Number.NaN })).toMatch(/celsius/);
    expect(argsFault("notify.notify", { text: "hi", urgency: "loud" })).toMatch(/urgency/);
    expect(argsFault("onoff.turn_on", [])).toMatch(/object/);
    expect(argsFault("onoff.turn_on", null)).toMatch(/object/);
  });

  it("takes any object of arguments for an action outside the standard's table, which its own slice checks", () => {
    expect(argsFault("vendor.kiosk.show", { page: 3 })).toBeUndefined();
    expect(argsFault("vendor.kiosk.show", "page 3")).toMatch(/object/);
  });
});

describe("a device's own args constraints (applier, *Requests*)", () => {
  it("narrows by enum, range and an object's fields; a field the constraint does not name is refused", () => {
    const args = { mode: { enum: ["off", "cool"] } };
    expect(argsFault("climate.set_mode", { mode: "cool" }, args)).toBeUndefined();
    expect(argsFault("climate.set_mode", { mode: "heat" }, args)).toMatch(/mode.*off, cool/);
    const celsius = { celsius: { min: 16, max: 30 } };
    expect(argsFault("climate.set_setpoint", { celsius: 16 }, celsius)).toBeUndefined();
    expect(argsFault("climate.set_setpoint", { celsius: 31 }, celsius)).toMatch(/celsius 31 is above 30/);
    expect(argsFault("climate.set_setpoint", { celsius: 15 }, celsius)).toMatch(/celsius 15 is below 16/);
    const search = { search: { fields: { series: "any" as const, season: { min: 1, max: 99 } } } };
    expect(argsFault("media.launch", { search: { series: "x", season: 3 } }, search)).toBeUndefined();
    expect(argsFault("media.launch", { search: { title: "x" } }, search)).toMatch(/search.title is not supported/);
    expect(argsFault("media.launch", { search: { season: 100 } }, search)).toMatch(/search.season 100 is above 99/);
  });

  it("takes an argument the constraints do not name as the vocabulary gives it, and notify's from whether or not it is named", () => {
    expect(argsFault("climate.set_setpoint", { celsius: 40 }, { mode: { enum: ["off"] } })).toBeUndefined();
    const notify = { text: "hi", urgency: "info", from: { notice: "n-1" } };
    expect(argsFault("notify.notify", notify, { text: "any", urgency: { enum: ["info"] } })).toBeUndefined();
    expect(argsFault("notify.notify", { ...notify, urgency: "critical" }, { urgency: { enum: ["info"] } })).toMatch(/urgency/);
  });

  it("checks an extension action against its device's constraints too", () => {
    expect(argsFault("vendor.kiosk.show", { page: 3 }, { page: { min: 1, max: 2 } })).toMatch(/page 3 is above 2/);
  });
});

describe("what an action sets, for already (GA-PLAN-4)", () => {
  const values = (v: Record<string, unknown>) => new Map(Object.entries(v));

  it("matches the key an action sets, within its default tolerance", () => {
    expect(holds("onoff.turn_on", {}, values({ on: true }))).toBe(true);
    expect(holds("onoff.turn_on", {}, values({ on: false }))).toBe(false);
    expect(holds("level.set_level", { level: 40 }, values({ level: 41 }))).toBe(true);
    expect(holds("level.set_level", { level: 40 }, values({ level: 42 }))).toBe(false);
    expect(holds("climate.set_setpoint", { celsius: 21 }, values({ setpoint: 21.5 }))).toBe(true);
    expect(holds("climate.set_setpoint", { celsius: 21 }, values({ setpoint: 21.6 }))).toBe(false);
    expect(holds("cover.open", {}, values({ position: 98 }))).toBe(true);
    expect(holds("cover.close", {}, values({ position: 3 }))).toBe(false);
    expect(holds("color.set_color", { rgb: "#FF8800" }, values({ color: "#ff8800" }))).toBe(true);
    expect(holds("valve.close", {}, values({ open: false }))).toBe(true);
    expect(holds("lock.lock", {}, values({ locked: true }))).toBe(true);
  });

  it("never holds without the key reported, for a stateless action, or for media.launch", () => {
    expect(holds("onoff.turn_on", {}, values({}))).toBe(false);
    expect(holds("cover.stop", {}, values({ position: 50 }))).toBe(false);
    expect(holds("media.launch", { search: { title: "x" } }, values({ playing: true }))).toBe(false);
    expect(holds("level.set_level", { level: 40 }, values({ level: "40" }))).toBe(false);
  });

  it("matches a session.lock on the account's key by locked, disconnected or none", () => {
    for (const v of ["locked", "disconnected", "none"]) expect(holds("session.lock", { account: "u1" }, values({ "session.u1": v }))).toBe(true);
    expect(holds("session.lock", { account: "u1" }, values({ "session.u1": "active" }))).toBe(false);
  });
});

describe("a command's value (bridge, *Commands*)", () => {
  it("is the one argument bare, several as an object, and absent for none", () => {
    expect(commandValue("level.set_level", { level: 40 }, { from: false })).toBe(40);
    expect(commandValue("session.lock", { account: "u1" }, { from: false })).toBe("u1");
    expect(commandValue("onoff.turn_on", {}, { from: false })).toBeUndefined();
    expect(commandValue("power.shutdown", {}, { from: false })).toBeUndefined();
    expect(commandValue("notify.notify", { text: "hi", urgency: "info" }, { from: false })).toEqual({ text: "hi", urgency: "info" });
    expect(commandValue("demo.brew", { cups: 2 }, { from: false })).toEqual({ cups: 2 });
    expect(commandValue("demo.brew", {}, { from: false })).toBeUndefined();
  });

  it("carries notify's from only to a device whose notify lists it (GA-APPLY-14)", () => {
    const args = { text: "hi", urgency: "info", from: { notice: "n-1" } };
    expect(commandValue("notify.notify", args, { from: false })).toEqual({ text: "hi", urgency: "info" });
    expect(commandValue("notify.notify", args, { from: true })).toEqual(args);
  });
});
