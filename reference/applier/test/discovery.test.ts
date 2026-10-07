import { describe, expect, it } from "vitest";
import { Discovery } from "../src/provision/discovery.js";

const cand = (id: string, keys: string[], matches = [{ bridge_type: "esphome", connect: true }]) =>
  ({ id, sources: ["dhcp"], keys, hints: {}, matches });
const view = (candidates: ReturnType<typeof cand>[]) => ({ finder: "live" as const, sources: [], faults: [], candidates });

describe("Discovery.list", () => {
  it("hides a candidate sharing a key with a held connection or an ignore, and offers live bridges of the type", () => {
    const list = Discovery.list(view([cand("a", ["mac:01"]), cand("b", ["mac:02", "mdns:x"]), cand("c", ["mac:03"]), cand("d", ["ble:04"],
      [{ bridge_type: "esphome", connect: false }])]),
      new Set(["mac:01"]), new Set(["mdns:x"]),
      [{ id: "esp", alive: true, levels: ["Serve", "Provision"], bridge_type: "esphome" },
       { id: "esp-dead", alive: false, levels: ["Serve", "Provision"], bridge_type: "esphome" },
       { id: "esp-serve", alive: true, levels: ["Serve"], bridge_type: "esphome" },
       { id: "other", alive: true, levels: ["Serve", "Provision"], bridge_type: "shelly" },
       { id: "untyped", alive: true, levels: ["Serve", "Provision"] }]);
    expect(list.map((c) => c.id)).toEqual(["c", "d"]);
    expect(list[0]!.offers).toEqual([{ bridge_type: "esphome", connect: true, bridges: ["esp"] }]);
    expect(list[1]!.offers).toEqual([{ bridge_type: "esphome", connect: false, bridges: ["esp", "esp-serve"] }]);
  });

  it("finds a listed candidate by id, and none that is hidden", () => {
    const list = Discovery.list(view([cand("a", ["mac:01"]), cand("b", ["mac:02"])]), new Set(["mac:02"]), new Set(), []);
    expect(Discovery.listed(list, "a")?.keys).toEqual(["mac:01"]);
    expect(Discovery.listed(list, "b")).toBeUndefined();
  });
});
