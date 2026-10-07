import { afterEach, describe, expect, it } from "vitest";
import { StoreError } from "../src/db.js";
import { deviceIdFor, Store } from "../src/store.js";
import { memoryDb } from "./db.js";

const dbs: { end(): Promise<void> }[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.end();
});
async function db() {
  const d = await memoryDb();
  dbs.push(d);
  return d;
}

describe("deviceIdFor", () => {
  it("gives the hardware id itself at a first admission, and the next free suffix after", () => {
    expect(deviceIdFor("0x00158d0001a2b3c4", new Set())).toBe("0x00158d0001a2b3c4");
    expect(deviceIdFor("lamp", new Set(["lamp"]))).toBe("lamp-2");
    expect(deviceIdFor("lamp", new Set(["lamp", "lamp-2", "lamp-3"]))).toBe("lamp-4");
  });

  it("never gives an id another hardware id took, nor one with a topic wildcard or a slash", () => {
    expect(deviceIdFor("lamp", new Set(["lamp", "lamp-2"]))).toBe("lamp-3");
    expect(deviceIdFor("a/b+c#", new Set())).toBe("a_b_c_");
  });
});

describe("Store", () => {
  it("makes its tables in the role's own schema, and opens again on them", async () => {
    const d = await db();
    await Store.open(d);
    await Store.open(d);
    const tables = await d.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(["blocked", "devices", "meta", "migrations", "reported_keys", "settings", "undescribed"]);
  });

  it("admits new hardware under a never-used id, and keeps the mapping across a restart", async () => {
    const d = await db();
    const store = await Store.open(d);
    const lamp = await store.admit("lamp");
    expect(lamp).toEqual({ deviceId: "lamp", hardwareId: "lamp", admission: 1, lastCheckIn: null });
    const again = await Store.open(d);
    expect(again.device("lamp")).toEqual(lamp);
  });

  it("gives a re-admission of the same hardware a new id, and forgets the old one's mapping", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("lamp");
    const second = await store.admit("lamp");
    expect(second).toEqual({ deviceId: "lamp-2", hardwareId: "lamp", admission: 2, lastCheckIn: null });
    expect((await Store.open(d)).device("lamp")).toEqual(second);
    expect((await store.admit("lamp-2")).deviceId).toBe("lamp-2-2");
  });

  it("keeps each device's lastCheckIn", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("lamp");
    const at = Date.parse("2030-01-01T08:00:01.250Z");
    await store.saveCheckIns([{ deviceId: "lamp", at }]);
    expect((await Store.open(d)).device("lamp")!.lastCheckIn).toBe(at);
  });

  it("keeps meta values", async () => {
    const d = await db();
    const store = await Store.open(d);
    expect(await store.meta("coordinator")).toBeUndefined();
    await store.setMeta("coordinator", "0x00124b0024c2a1b0");
    await store.setMeta("coordinator", "0x00124b0024c2a1b1");
    expect(await (await Store.open(d)).meta("coordinator")).toBe("0x00124b0024c2a1b1");
  });

  it("takes a device out on its removal, keeping its id from being given again", async () => {
    const d = await db();
    const store = await Store.open(d);
    const lamp = await store.admit("lamp");
    const socket = await store.admit("socket");
    expect(store.devices()).toEqual([lamp, socket]);
    await store.remove("lamp");
    expect(store.device("lamp")).toBeUndefined();
    expect(store.devices()).toEqual([socket]);
    const reopened = await Store.open(d);
    expect(reopened.device("lamp")).toBeUndefined();
    expect(await reopened.admit("lamp")).toEqual({ deviceId: "lamp-2", hardwareId: "lamp", admission: 2, lastCheckIn: null });
    // A removal of hardware with no device changes nothing.
    await reopened.remove("bulb");
    expect(reopened.devices().map((x) => x.deviceId).sort()).toEqual(["lamp-2", "socket"]);
  });

  it("keeps each setting's last observed value and time across a restart", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("pusher");
    expect(store.settings("pusher")).toEqual({});
    const t1 = Date.parse("2030-01-01T08:00:01.000Z");
    const t2 = Date.parse("2030-01-01T08:00:02.500Z");
    await store.saveSettings([{ deviceId: "pusher", key: "org.galatea.test.pusher.mode", value: "switch", at: t1 }]);
    await store.saveSettings([{ deviceId: "pusher", key: "org.galatea.test.pusher.mode", value: "click", at: t2 },
      { deviceId: "pusher", key: "org.galatea.test.pusher.reverse", value: false, at: t2 }]);
    const want = { "org.galatea.test.pusher.mode": { value: "click", at: t2 }, "org.galatea.test.pusher.reverse": { value: false, at: t2 } };
    expect(store.settings("pusher")).toEqual(want);
    expect((await Store.open(d)).settings("pusher")).toEqual(want);
  });

  it("keeps each device's reported keys across a restart, once each (GA-BRIDGE-80)", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("radar");
    expect(store.reported("radar")).toEqual([]);
    await store.saveReported([{ deviceId: "radar", key: "temperature", at: Date.parse("2030-01-01T08:00:01.000Z") }]);
    await store.saveReported([{ deviceId: "radar", key: "temperature", at: Date.parse("2030-01-02T08:00:01.000Z") },
      { deviceId: "radar", key: "humidity", at: Date.parse("2030-01-02T08:00:01.000Z") }]);
    expect(store.reported("radar")).toEqual(["humidity", "temperature"]);
    expect((await Store.open(d)).reported("radar")).toEqual(["humidity", "temperature"]);
  });

  it("keeps each device's undescribed names in the order first seen, across a restart, and forgets one described (GA-BRIDGE-76)", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("radar");
    const t1 = Date.parse("2030-01-01T08:00:01.000Z");
    const t2 = Date.parse("2030-01-01T08:00:02.000Z");
    await store.saveUndescribed([{ deviceId: "radar", name: "dp9", at: t1 }, { deviceId: "radar", name: "dp1", at: t2 }], []);
    await store.saveUndescribed([{ deviceId: "radar", name: "dp9", at: t2 }], []);
    expect(store.undescribed("radar")).toEqual([{ name: "dp9", at: t1 }, { name: "dp1", at: t2 }]);
    await store.saveUndescribed([], [{ deviceId: "radar", name: "dp9" }]);
    expect((await Store.open(d)).undescribed("radar")).toEqual([{ name: "dp1", at: t2 }]);
  });

  it("returns an admission the store took whose answer was lost, and admits it once", async () => {
    const d = await db();
    const store = await Store.open(d);
    d.trouble.loseCommit = true;
    await expect(store.admit("lamp")).rejects.toThrow(StoreError);
    // The core tries again for the hardware it does not yet hold: the row that landed is found, not a second admission.
    expect(await store.admit("lamp", null)).toEqual({ deviceId: "lamp", hardwareId: "lamp", admission: 1, lastCheckIn: null });
    expect((await d.query<{ n: number }>("SELECT count(*)::int AS n FROM devices")).rows[0]!.n).toBe(1);
    // A lost answer for a re-admission is found the same way.
    d.trouble.loseCommit = true;
    await expect(store.admit("lamp", "lamp")).rejects.toThrow(StoreError);
    expect((await store.admit("lamp", "lamp")).deviceId).toBe("lamp-2");
    expect((await d.query<{ n: number }>("SELECT count(*)::int AS n FROM devices")).rows[0]!.n).toBe(2);
  });

  it("admits after a failed try that the store did not take, once it is back", async () => {
    const d = await db();
    const store = await Store.open(d);
    d.trouble.down = true;
    await expect(store.admit("lamp")).rejects.toThrow(StoreError);
    // Still away: the read before the next try fails as the store's too.
    await expect(store.admit("lamp", null)).rejects.toThrow(StoreError);
    d.trouble.down = false;
    expect((await store.admit("lamp", null)).deviceId).toBe("lamp");
  });

  it("fails a write as the store's when the store is away, and admits nothing", async () => {
    const d = await db();
    const store = await Store.open(d);
    d.trouble.down = true;
    await expect(store.admit("lamp")).rejects.toThrow(StoreError);
    expect(store.device("lamp")).toBeUndefined();
    d.trouble.down = false;
    expect((await store.admit("lamp")).deviceId).toBe("lamp");
  });

  it("keeps the blocklist across a restart, each with its first time, and takes hardware off it", async () => {
    const d = await db();
    const store = await Store.open(d);
    const at = Date.parse("2026-10-05T12:00:00Z");
    await store.block("lamp", at);
    await store.block("lamp", at + 5000);
    await store.block("plug", at + 1000);
    expect(store.blocked()).toEqual([{ hardwareId: "lamp", since: at }, { hardwareId: "plug", since: at + 1000 }]);
    const again = await Store.open(d);
    expect(again.blocked().sort((a, b) => a.since - b.since)).toEqual([{ hardwareId: "lamp", since: at }, { hardwareId: "plug", since: at + 1000 }]);
    await again.unblock("lamp");
    await again.unblock("never-blocked");
    expect(again.blocked()).toEqual([{ hardwareId: "plug", since: at + 1000 }]);
    expect((await Store.open(d)).blocked()).toEqual([{ hardwareId: "plug", since: at + 1000 }]);
  });

  it("says which hardware each id was given to, and each hardware's latest id, in use or not, across a restart", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.admit("lamp");
    await store.admit("lamp");
    await store.remove("lamp");
    for (const s of [store, await Store.open(d)]) {
      expect([s.hardwareOf("lamp"), s.hardwareOf("lamp-2"), s.hardwareOf("nothing")]).toEqual(["lamp", "lamp", undefined]);
      expect([s.lastDeviceOf("lamp"), s.lastDeviceOf("plug")]).toEqual(["lamp-2", undefined]);
      expect(s.device("lamp")).toBeUndefined();
    }
  });

  it("fails a block and an unblock as the store's when the store is away, and changes nothing", async () => {
    const d = await db();
    const store = await Store.open(d);
    await store.block("plug", 1000);
    d.trouble.down = true;
    await expect(store.block("lamp", 2000)).rejects.toThrow(StoreError);
    await expect(store.unblock("plug")).rejects.toThrow(StoreError);
    expect(store.blocked()).toEqual([{ hardwareId: "plug", since: 1000 }]);
  });
});
