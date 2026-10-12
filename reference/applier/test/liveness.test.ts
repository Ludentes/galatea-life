import { describe, expect, it } from "vitest";
import { liveness, type Facts } from "../src/state/liveness.js";

const now = Date.parse("2030-01-01T08:00:00.000Z");
const closed: Facts = { feedback: "closed", bridgeAlive: true, gone: false, transport: "up", freshS: 60, lastCheckIn: now, fastClock: false };

describe("liveness", () => {
  it("is dead when the bridge is, the device is gone, or its transport is down or not listed", () => {
    expect(liveness(closed, now)).toBe("live");
    expect(liveness({ ...closed, bridgeAlive: false }, now)).toBe("dead");
    expect(liveness({ ...closed, gone: true }, now)).toBe("dead");
    expect(liveness({ ...closed, transport: "down" }, now)).toBe("dead");
    // A transport its bridge never listed (slice 2a's M7): least meaning, not reached.
    expect(liveness({ ...closed, transport: undefined }, now)).toBe("dead");
  });

  it("reads a closed device stale past fresh_s plus 11 s, never before fresh_s (GA-STATE-5)", () => {
    expect(liveness({ ...closed, lastCheckIn: now - 71_000 }, now)).toBe("live");
    expect(liveness({ ...closed, lastCheckIn: now - 71_001 }, now)).toBe("stale");
  });

  it("reads a closed device with no known bound, or no check-in, or a fast clock, stale", () => {
    expect(liveness({ ...closed, freshS: null }, now)).toBe("stale");
    expect(liveness({ ...closed, freshS: null }, now, { liveWhileUnknown: true })).toBe("live");
    expect(liveness({ ...closed, lastCheckIn: null }, now)).toBe("stale");
    expect(liveness({ ...closed, fastClock: true }, now)).toBe("stale");
  });

  it("reads an open device live while its bridge lives and its transport is up or unknown", () => {
    const open: Facts = { ...closed, feedback: "open", freshS: null, lastCheckIn: null };
    expect(liveness(open, now)).toBe("live");
    expect(liveness({ ...open, transport: "unknown" }, now)).toBe("live");
    expect(liveness({ ...open, transport: "down" }, now)).toBe("dead");
  });
});
