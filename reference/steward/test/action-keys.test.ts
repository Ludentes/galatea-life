import { matcher } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import { keysSetBy, reportOf, setByAnAction } from "../src/house/action-keys.js";

describe("the keys a device's actions set (GA-LEASE-2)", () => {
  it("are the capability table's keys for its standard actions, and an extension action's confirmed_by key", () => {
    const plug = { actions: [{ action: "onoff.turn_on" }, { action: "onoff.turn_off" }] };
    expect([...keysSetBy(plug)]).toEqual(["on"]);
    expect(setByAnAction(plug, "power")).toBe(false);          // metering: a sensor key on an actuator
    const ac = { actions: [{ action: "climate.set_mode" }, { action: "climate.set_setpoint" }] };
    expect([...keysSetBy(ac)].sort()).toEqual(["mode", "setpoint"]);
    expect(setByAnAction(ac, "current")).toBe(false);          // a reading
    const pusher = { actions: [{ action: "org.galatea.test.push.set_mode", confirmed_by: { key: "org.galatea.test.push.mode", value: { arg: "mode" } } }] };
    expect(setByAnAction(pusher, "org.galatea.test.push.mode")).toBe(true);
    expect(setByAnAction({ actions: [{ action: "session.lock" }] }, "session.liza")).toBe(true);
    expect(setByAnAction(undefined, "on")).toBe(false);
  });
});

/** A report's key, and the value the step set, where one is named. */
const kv = (r: ReturnType<typeof reportOf>) => r && { key: r.key, ...("value" in r ? { value: r.value } : {}) };

describe("the report a step's ack is matched on (GA-LEASE-12, R-6)", () => {
  it("is the standard action's key and value, an extension action's confirmed_by, none for a toggle", () => {
    expect(kv(reportOf("onoff.turn_on", {}))).toEqual({ key: "on", value: true });
    expect(kv(reportOf("climate.set_setpoint", { celsius: 19 }))).toEqual({ key: "setpoint", value: 19 });
    expect(kv(reportOf("x.set_mode", { mode: "click" }, { confirmed_by: { key: "x.mode", value: { arg: "mode" } } }))).toEqual({ key: "x.mode", value: "click" });
    expect(reportOf("onoff.turn_on", {}, { toggles: true })).toBeUndefined();
  });
  it("covers every standard action of the table", () => {
    const r = (action: string, args: Record<string, unknown> = {}) => kv(reportOf(action, args));
    expect(r("onoff.turn_off")).toEqual({ key: "on", value: false });
    expect(r("level.set_level", { level: 40 })).toEqual({ key: "level", value: 40 });
    expect(r("color.set_color", { rgb: "#ffaa00" })).toEqual({ key: "color", value: "#ffaa00" });
    expect(r("climate.set_mode", { mode: "heat" })).toEqual({ key: "mode", value: "heat" });
    expect(r("cover.open")).toEqual({ key: "position", value: 100 });
    expect(r("cover.close")).toEqual({ key: "position", value: 0 });
    expect(r("cover.set_position", { position: 30 })).toEqual({ key: "position", value: 30 });
    expect(r("valve.open")).toEqual({ key: "open", value: true });
    expect(r("valve.close")).toEqual({ key: "open", value: false });
    expect(r("lock.lock")).toEqual({ key: "locked", value: true });
    expect(r("lock.unlock")).toEqual({ key: "locked", value: false });
    expect(r("media.pause")).toEqual({ key: "playing", value: false });
    expect(r("media.resume")).toEqual({ key: "playing", value: true });
    expect(r("media.set_volume", { volume: 5 })).toEqual({ key: "volume", value: 5 });
    expect(r("session.lock", { account: "liza" })).toEqual({ key: "session.liza" });
    // None known: media.launch sets several keys; an unknown extension action; an argument not given; a malformed confirmed_by.
    expect(r("media.launch", { title: "x" })).toBeUndefined();
    expect(r("x.press")).toBeUndefined();
    expect(r("color.set_color", { color: "#ffaa00" })).toBeUndefined();
    expect(r("session.lock")).toBeUndefined();
    expect(kv(reportOf("x.press", {}, { confirmed_by: { key: "on", value: true } }))).toEqual({ key: "on", value: true });
    expect(reportOf("x.press", {}, { confirmed_by: { value: true } })).toBeUndefined();
    expect(reportOf("x.set", {}, { confirmed_by: { key: "x.v", value: { arg: "v" } } })).toBeUndefined();
  });
  it("matches a report as the applier matches the step's ack: a numeric key within its tolerance, a colour whatever its case (GA-EVT-3)", () => {
    const m = (action: string, args: Record<string, unknown>, v: unknown) => matcher(reportOf(action, args)!.match)(v);
    expect([m("level.set_level", { level: 40 }, 41), m("level.set_level", { level: 40 }, 42)]).toEqual([true, false]);
    expect([m("climate.set_setpoint", { celsius: 21 }, 21.5), m("cover.close", {}, 2), m("media.set_volume", { volume: 5 }, 4)]).toEqual([true, true, true]);
    expect([m("color.set_color", { rgb: "#FFAA00" }, "#ffaa00"), m("color.set_color", { rgb: "#FFAA00" }, "#ffaa01")]).toEqual([true, false]);
    expect([m("session.lock", { account: "liza" }, "disconnected"), m("session.lock", { account: "liza" }, "active")]).toEqual([true, false]);
    expect(m("onoff.turn_on", {}, "true")).toBe(false);
  });
});
