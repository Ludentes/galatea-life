import { describe, expect, it } from "vitest";
import { capText, declaredKeys, READING_MAX_BYTES, STATE_MAX_BYTES, toReadings } from "../src/plugins/state.js";
import { manifest } from "./manifests.js";

const m = manifest();
const player = declaredKeys(m, m.devices[0]!);
const library = declaredKeys(m, m.devices[1]!);

describe("declaredKeys", () => {
  it("gives a device its capabilities' state keys, its sensor keys and its extensions' keys, each with its type", () => {
    expect(Object.fromEntries(player)).toEqual({ playing: "boolean", volume: "number", speech: "string", title: "string", started_at: "string" });
    expect(Object.fromEntries(library)).toEqual({ "org.example.library.scanning": "boolean" });
    const sensing = { ...m.devices[0]!, capabilities: ["sensor"], sensorKeys: ["temperature", "app"] };
    expect(Object.fromEntries(declaredKeys(m, sensing))).toEqual({ temperature: "number", app: "string" });
  });
});

describe("toReadings", () => {
  it("takes each declared key that fits its type, and \"unknown\" for any", () => {
    expect(toReadings(JSON.stringify({ playing: true, volume: 40, title: "unknown" }), player))
      .toEqual({ ok: true, values: { playing: true, volume: 40, title: "unknown" }, dropped: [] });
  });

  it("leaves out a key the device does not declare, and names one that fails its type or is too long", () => {
    const r = toReadings(JSON.stringify({ playing: "yes", volume: 40, title: "x".repeat(READING_MAX_BYTES + 1), path: "/home/liza" }), player);
    expect(r).toEqual({ ok: true, values: { volume: 40 }, dropped: ["playing: not a boolean", `title: over ${READING_MAX_BYTES} bytes`] });
  });

  it("fails a read that is not one JSON object, or is over the state cap", () => {
    expect(toReadings("[1]", player)).toMatchObject({ ok: false });
    expect(toReadings("{", player)).toMatchObject({ ok: false, why: "the state is not JSON" });
    expect(toReadings(JSON.stringify({ title: "x".repeat(STATE_MAX_BYTES) }), player)).toMatchObject({ ok: false });
  });
});

describe("capText", () => {
  it("cuts text to the cap at a character's boundary, marking the cut", () => {
    expect(capText("short")).toBe("short");
    const cut = capText("я".repeat(600));
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(1024);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice(0, -1)).toBe("я".repeat(cut.length - 1));
  });
});
