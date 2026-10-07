import { describe, expect, it } from "vitest";
import { defaultAckWithinS, defaultTier, NEVER_IDEMPOTENT, standardKeys, type TierFacts } from "../src/model/declarations.js";

const plain: TierFacts = { cls: null, infrastructure: false, opensWith: "onoff.turn_on" };

describe("the default tiers (GA-DESC-3)", () => {
  it("gives each row's tier, the first row that matches winning, and reversible otherwise", () => {
    expect(defaultTier({ ...plain, cls: "light" }, "lock.unlock")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "water_valve" }, "valve.open")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "water_valve" }, "valve.close")).toBe("reversible");
    expect(defaultTier({ ...plain, cls: "gas_valve" }, "onoff.turn_on")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "gas_valve", opensWith: "onoff.turn_off" }, "onoff.turn_on")).toBe("reversible");
    expect(defaultTier({ ...plain, cls: "gas_valve", opensWith: "onoff.turn_off" }, "onoff.turn_off")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "gate" }, "cover.close")).toBe("confirm");
    expect(defaultTier({ ...plain, cls: "garage_door" }, "cover.open")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "gate" }, "onoff.turn_on")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "boiler" }, "climate.set_setpoint")).toBe("confirm");
    expect(defaultTier({ ...plain, cls: "socket", load: "heating" }, "onoff.turn_on")).toBe("confirm");
    expect(defaultTier({ ...plain, cls: "socket", load: "lighting" }, "onoff.turn_on")).toBe("reversible");
    expect(defaultTier({ ...plain, cls: "socket", infrastructure: true }, "onoff.turn_off")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "socket", infrastructure: true }, "onoff.turn_on")).toBe("reversible");
    expect(defaultTier({ ...plain, infrastructure: true }, "power.sleep")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "light" }, "onoff.turn_on")).toBe("reversible");
    expect(defaultTier({ ...plain, cls: "computer" }, "power.shutdown")).toBe("confirm");
    expect(defaultTier({ ...plain, cls: "computer", infrastructure: true }, "power.shutdown")).toBe("no_voice");
    expect(defaultTier({ ...plain, cls: "computer" }, "power.wake")).toBe("reversible");
    expect(defaultTier({ ...plain, cls: "computer" }, "session.lock")).toBe("reversible");
  });
});

describe("what the standard declares of actions and keys", () => {
  it("never lets notify, media.announce, power.shutdown or media.launch be idempotent (GA-DESC-4)", () => {
    expect([...NEVER_IDEMPOTENT].sort()).toEqual(["media.announce", "media.launch", "notify.notify", "power.shutdown"]);
  });

  it("gives ack_within_s by capability and class, never below twice the reach plus 10", () => {
    expect(defaultAckWithinS("light", "onoff.turn_on", 0)).toBe(10);
    expect(defaultAckWithinS("curtain", "cover.close", 0)).toBe(90);
    expect(defaultAckWithinS("gate", "onoff.turn_on", 0)).toBe(90);
    expect(defaultAckWithinS("water_valve", "onoff.turn_on", 0)).toBe(60);
    expect(defaultAckWithinS("sensor", "valve.close", 0)).toBe(60);
    expect(defaultAckWithinS("light", "onoff.turn_on", 30)).toBe(70);
    expect(defaultAckWithinS("light", "onoff.turn_on", undefined)).toBe(10);
    expect(defaultAckWithinS("computer", "power.wake", 0)).toBe(240);
    expect(defaultAckWithinS(null, "power.wake", undefined)).toBe(240);
    expect(defaultAckWithinS("player", "media.launch", 0)).toBe(30);
    expect(defaultAckWithinS("tv", "media.launch", 15)).toBe(40);
    expect(defaultAckWithinS("computer", "session.lock", 0)).toBe(10);
    expect(defaultAckWithinS("computer", "session.lock", 30)).toBe(70);
  });

  it("declares app, camera_in_use, microphone_in_use and speech personal, and speech self_changing, where reported (GA-DESC-9)", () => {
    expect(standardKeys(null, ["sensor"], [], ["app", "camera_in_use", "temperature"])).toEqual({ personal: ["app", "camera_in_use"], self_changing: [] });
    expect(standardKeys("tv", ["media"], ["media.pause"], [])).toEqual({ personal: ["speech"], self_changing: ["speech"] });
    expect(standardKeys(null, ["onoff"], ["onoff.turn_on"], [])).toEqual({ personal: [], self_changing: [] });
  });

  it("declares a player's playing, title and started_at self_changing, only those it can report (GA-DESC-9)", () => {
    expect(standardKeys("player", ["media"], ["media.launch", "media.pause"], []).self_changing.sort())
      .toEqual(["playing", "speech", "started_at", "title"]);
    // No launch: no title and no started_at.
    expect(standardKeys("player", ["media"], ["media.pause", "media.set_volume"], []).self_changing.sort()).toEqual(["playing", "speech"]);
  });

  it("declares every state key a computer reports self_changing, its capabilities' keys included (GA-DESC-9)", () => {
    expect(standardKeys("computer", ["sensor", "media", "onoff", "power"],
      ["media.pause", "media.set_volume", "onoff.turn_on", "onoff.turn_off", "power.wake"], ["app", "temperature"]).self_changing.sort())
      .toEqual(["app", "on", "playing", "speech", "temperature", "volume"]);
    expect(standardKeys("computer", ["sensor"], [], ["app", "temperature"]).personal).toEqual(["app"]);
  });
});
