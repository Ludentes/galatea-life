import { describe, expect, it } from "vitest";
import { keysSetBy, setByAnAction } from "../src/house/action-keys.js";

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
