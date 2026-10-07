import { describe, expect, it } from "vitest";
import { body, DEVICES, flush, home, LEAK, status } from "./safe-home.js";

// covers: GA-SAFE-8's late_ack of a rule's actuation within one life: while another actuation of its run still waits, after a
// re-send landed, and after a run held past the dispatcher's hour was pruned (GA-PERSIST-1 untested here).
type Home = Awaited<ReturnType<typeof home>>;
const latch = { latch: { condition: { ...LEAK, value: false } } };
const BOUNDS = [["hall:valve", "valve.close"], ["hall:pulse", "onoff.turn_off"]]
  .map(([device, action]) => ({ op: "upsert", kind: "ack_within_s", value: { device, action, ack_within_s: 10 } }));
const at = (m: Home) => new Date(m.clock.now()).toISOString();
const available = (m: any, device: string, up: boolean) => m.send(`devices/${device}/status`, { deviceId: device, available: up, timestamp: at(m) });

const ids = DEVICES.map((d) => d.id);
/** The bridge says it lives, now, each device checked in now. */
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}

describe("a safety rule's late_ack (GA-SAFE-8)", () => {
  it("says a failed(no_ack) actuation's late_ack that came while another actuation of the run waited, in the completion notice", async () => {
    const m = await home();
    body(await m.configure([...BOUNDS, { op: "upsert", kind: "safety_rule", value: { id: "two", trigger: LEAK,
      actions: [{ target: "hall:pulse", action: "onoff.turn_off" }, { target: "hall:valve", action: "valve.close" }], ...latch } }]));
    const c = await m.cursor();
    m.report("pulse", { on: true });
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(11_000);
    await flush();
    // pulse ended failed(no_ack), not idempotent: done; valve waits for its return.
    m.report("pulse", { on: false });
    await flush();
    expect((await m.events(c, "late_ack")).length).toBe(1);
    available(m, "valve", true);
    await flush();
    const close = m.sent.find((s) => s.device === "valve")!;
    m.ack(close, "applied");
    m.report("valve", { open: false });
    await flush();
    const [f] = await m.events(c, "rule_fired");
    expect(f).toBeDefined();
    const done = (await m.notices("safety_rule")).find((n: any) => n.notice_id === f.notice);
    expect(done.text).toMatch(/hall:pulse did what it was asked after its outcome failed/);
    expect(done.text).not.toMatch(/may have run/);
  });

  it("gives no second notice for the first attempt's late_ack once a re-send of it acked: the completion notice already said acked", async () => {
    const m = await home();
    body(await m.configure([...BOUNDS, { op: "upsert", kind: "safety_rule", value: { id: "leak-closes-valve", trigger: LEAK,
      actions: [{ target: "hall:valve", action: "valve.close" }], ...latch } }]));
    const c = await m.cursor();
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(11_000);
    await flush();
    expect(m.sent.length).toBe(2);
    m.ack(m.sent[1]!, "applied");
    m.report("valve", { open: false });
    await flush();
    const [f] = await m.events(c, "rule_fired");
    expect((await m.notices("safety_rule")).filter((n: any) => n.late_ack)).toEqual([]);
  });

  it("names the rule of a run held past the hour, and gives its second notice, after the run was pruned", async () => {
    const m = await home();
    body(await m.configure([{ op: "upsert", kind: "ack_within_s", value: { device: "hall:pulse", action: "onoff.turn_off", ack_within_s: 10 } },
      { op: "upsert", kind: "safety_rule", value: { id: "leak-cuts-pump", trigger: LEAK,
        actions: [{ target: "hall:pulse", action: "onoff.turn_off" }], latch: { condition: { ...LEAK, value: false } } } }]));
    m.report("pulse", { on: true });
    m.send("devices/pulse/status", { deviceId: "pulse", available: false, timestamp: at(m) });
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent).toEqual([]);
    m.clock.advance(3_700_000);
    const c = await m.cursor();
    online(m);
    m.send("devices/pulse/status", { deviceId: "pulse", available: true, timestamp: at(m) });
    await flush();
    expect(m.sent.length).toBe(1);
    for (let i = 0; i < 2; i++) { m.clock.advance(6000); online(m); await flush(); }
    const [f] = await m.events(c, "rule_fired");
    expect(f.outcomes.map((o: any) => `${o.outcome}(${o.reason})`)).toEqual(["failed(no_ack)"]);
    for (let i = 0; i < 6; i++) { m.clock.advance(7000); online(m); await flush(); }
    m.report("pulse", { on: false });
    await flush();
    const late = await m.events(c, "late_ack");
    expect(late[0]).toMatchObject({ rule_id: "leak-cuts-pump" });
    expect((await m.notices("safety_rule")).filter((n: any) => n.late_ack).length).toBe(1);
  });
});
