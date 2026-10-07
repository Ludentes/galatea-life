import { describe, expect, it } from "vitest";
import { Applier } from "../src/applier.js";
import { plainOffLoopback } from "../src/bus/broker-url.js";
import { Store } from "../src/core/store.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { body, DEVICES, home, OWNER, pulse, rule, status } from "./safe-home.js";

describe("the Safe claim", () => {
  it("claims Safe only with box, and while no bridge declares an ungoverned path; Safe kinds are not_claimed without it (GA-DESC-6)", async () => {
    const m = await home({ box: false });
    expect(body(await m.a.call(m.owner, "describe", {}))).toMatchObject({ levels: ["Act"], box: false, ungoverned: [] });
    expect(await m.configure([rule()])).toMatchObject({ ok: false, error: "not_claimed" });
    body(await m.configure([{ op: "upsert", kind: "box", value: true }]));
    expect(body(await m.a.call(m.owner, "describe", {}))).toMatchObject({ levels: ["Act", "Safe"], box: true });
    const before = body(await m.a.call(m.owner, "describe", {})).revision;
    m.send("status", status(DEVICES.map((d) => d.id), { ungoverned: ["a cloud app turns the valve"] }));
    const d = body(await m.a.call(m.owner, "describe", {}));
    expect(d).toMatchObject({ levels: ["Act"], ungoverned: [{ bridge: "hall", path: "a cloud app turns the valve" }] });
    expect(d.revision).toBeGreaterThan(before);
    expect(await m.configure([rule()])).toMatchObject({ ok: false, error: "not_claimed" });
    m.send("status", status(DEVICES.map((d) => d.id)));
    expect(body(await m.a.call(m.owner, "describe", {})).levels).toEqual(["Act", "Safe"]);
  });

  it("refuses box over plain TCP off loopback, and tells such a broker apart", async () => {
    expect(plainOffLoopback("mqtt://box.example:1883")).toBe(true);
    expect(plainOffLoopback("mqtt://127.0.0.1:1883")).toBe(false);
    expect(plainOffLoopback("mqtt://[::1]:1883")).toBe(false);
    expect(plainOffLoopback("mqtts://box.example:8883")).toBe(false);
    const clock = new FakeClock();
    const store = await Store.open(await memoryDb(), clock, (err) => { throw err; });
    const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "x", levels: ["Act", "Safe"], plainOffLoopback: true });
    await a.start();
    const r = await a.call(a.caller(OWNER), "configure", { changes: [{ op: "upsert", kind: "box", value: true }], expected_revision: 0, dry_run: false });
    expect(r).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("takes a socket whose load was never configured as heating, and says so in describe (GA-DESC-8)", async () => {
    const m = await home();
    const plug = { ...pulse, id: "plug", stableIdentifier: "test:plug", actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }] };
    m.send("devices", { devices: [...DEVICES, plug] }, true);
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:plug", class: "socket" } }]));
    const d = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:plug");
    expect(d.load).toBe("heating");
    expect(d.actions[0].tier).not.toBe("reversible");
    // The pulse relay, adopted with load other, keeps it.
    expect(body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:pulse").load).toBe("other");
  });
});
