import { describe, expect, it } from "vitest";
import { repointDevices, saveDevices } from "../src/model/rows.js";
import type { HeldDevice } from "../src/model/home.js";
import { memoryStore } from "./db.js";

const doc = (id: string, sid = `test:${id}`) => ({ id, stable_identifier: sid }) as unknown as HeldDevice["doc"];
const held = (id: string, device: string, sid?: string): HeldDevice => ({ id, bridge: "hall", bridge_device: device, doc: doc(device, sid) });

describe("saveDevices", () => {
  it("writes a device by its bridge device, whatever id a replacement gave it since, and twice safely", async () => {
    const s = await memoryStore();
    await s.write((tx) => saveDevices(tx, [held("hall:lamp", "lamp")]));
    // A replacement re-pointed hall:lamp at the bridge device lamp-2.
    await s.write(async (tx) => {
      await tx.query("UPDATE devices SET bridge_device = 'lamp-2', doc = $1 WHERE id = 'hall:lamp'", [JSON.stringify(doc("lamp-2"))]);
    });
    // A write handed over before the replacement committed names lamp-2 by the id it had then.
    const late = held("hall:lamp-2", "lamp-2", "test:changed");
    await s.write((tx) => saveDevices(tx, [late]));
    await s.write((tx) => saveDevices(tx, [late]));
    // And one names the old bridge device by the id it lost: written nothing, never a fault.
    await s.write((tx) => saveDevices(tx, [held("hall:lamp", "lamp")]));
    const rows = await s.query<{ id: string; bridge_device: string; doc: { stable_identifier: string } }>(
      "SELECT id, bridge_device, doc FROM devices ORDER BY id");
    expect(rows.rows.map((r) => [r.id, r.bridge_device, r.doc.stable_identifier])).toEqual([["hall:lamp", "lamp-2", "test:changed"]]);
  });
});

describe("repointDevices", () => {
  it("re-points an id at new hardware, and the old hardware's minted id written after it, each twice safely", async () => {
    const s = await memoryStore();
    await s.write((tx) => saveDevices(tx, [held("hall:lamp", "lamp"), held("hall:lamp-2", "lamp-2")]));
    const moves = [{ from: "hall:lamp-2", to: held("hall:lamp", "lamp-2") }];
    await s.write((tx) => repointDevices(tx, moves));
    await s.write((tx) => repointDevices(tx, moves));
    // The old hardware, still listed, under the id the model minted for it.
    await s.write((tx) => saveDevices(tx, [held("hall:lamp/2", "lamp")]));
    await s.write((tx) => saveDevices(tx, [held("hall:lamp/2", "lamp")]));
    const rows = await s.query<{ id: string; bridge_device: string }>("SELECT id, bridge_device FROM devices ORDER BY id");
    expect(rows.rows.map((r) => [r.id, r.bridge_device])).toEqual([["hall:lamp", "lamp-2"], ["hall:lamp/2", "lamp"]]);
  });
});
