import { describe, expect, it } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, home, leak, LEAK, rule, status } from "./safe-home.js";

// A report held before a rule exists never fires it when re-delivered (GA-SAFE-11): slice 6a re-review's probes, kept as regression tests.
const redeliver = (m: Awaited<ReturnType<typeof home>>, device: string, values: Record<string, unknown>, at: number) =>
  m.send(`devices/${device}/status`, { deviceId: device, ...values, timestamp: new Date(at).toISOString() }, true);

describe("I1: a held report is no new report", () => {
  it("across a restart: seen comes back from the store, seeded at configure", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    const at = m.clock.now();
    m.report("leak", { leak: true }, at);
    m.clock.advance(1000);
    body(await m.configure([rule()]));
    await m.store.settled();
    m.a.stop();
    const again = await home({ db, fresh: false });
    again.send("devices", { devices: DEVICES }, true);
    again.a.listening("hall");
    again.send("status", status(DEVICES.map((d) => d.id)));
    redeliver(again, "leak", { leak: true }, at);
    await flush();
    expect(again.sent.length).toBe(0);
    again.clock.advance(1000);
    again.report("leak", { leak: true });
    await flush();
    expect(again.sent.map((x) => x.body.value.action)).toEqual(["valve.close"]);
  });

  it("a trigger key added by an edit of the rule", async () => {
    const m = await home();
    body(await m.configure([rule()]));
    const at = m.clock.now();
    m.report("button", { battery: 5 }, at);
    m.clock.advance(1000);
    body(await m.configure([rule({ trigger: { any: [LEAK, { device: "hall:button", key: "battery", op: "lt", value: 10 }] } })]));
    redeliver(m, "button", { battery: 5 }, at);
    await flush();
    expect(m.sent.length).toBe(0);
    m.clock.advance(1000);
    m.report("button", { battery: 4 });
    await flush();
    expect(m.sent.length).toBe(1);
  });

  it("new hardware under a replaced id, its report held before the replacement", async () => {
    const m = await home();
    body(await m.configure([rule()]));
    const sensor2 = { ...leak, id: "leak-2", stableIdentifier: "test:leak-2" };
    m.send("devices", { devices: [...DEVICES, sensor2] }, true);
    m.send("status", status([...DEVICES.map((d) => d.id), "leak-2"]));
    const at = m.clock.now();
    m.report("leak-2", { leak: true }, at);
    m.clock.advance(1000);
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:leak-2", class: "sensor", replaces: "hall:leak" } }]));
    redeliver(m, "leak-2", { leak: true }, at);
    await flush();
    expect(m.sent.length).toBe(0);
  });

  it("a configure run twice, and a second rule on the same key", async () => {
    const m = await home();
    const at = m.clock.now();
    m.report("leak", { leak: true }, at);
    m.clock.advance(1000);
    body(await m.configure([rule()]));
    body(await m.configure([rule({ id: "second", actions: [{ target: "hall:valve", action: "valve.close" }] })]));
    body(await m.configure([rule()]));
    redeliver(m, "leak", { leak: true }, at);
    await flush();
    expect(m.sent.length).toBe(0);
  });
});
