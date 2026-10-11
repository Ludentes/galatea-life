import { describe, expect, it } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, rule, status } from "./safe-home.js";
import type { FakeClock } from "./fake-clock.js";

// The whole-applier review's I4: `Applier.stop()` clears every timer its modules own (the safety rules'
// runs, the liveness notices' graces, the heating caps, the witnesses' watches and the ones `resume`
// set, the long polls), so a host that embeds the applier can stop it and close its store.

type Home = Awaited<ReturnType<typeof home>>;
const temp = { id: "temp", stableIdentifier: "test:temp", transport: "radio", capabilities: ["sensor"], sensorKeys: ["temperature"], actions: [],
  feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", otherAdmins: [] };
const extra = [heater, temp];
const ids = [...DEVICES, ...extra].map((d) => d.id);
const pending = (m: Home) => (m.clock as unknown as { timers: Map<number, unknown> }).timers.size;
function online(m: Home): void {
  const at = new Date(m.clock.now()).toISOString();
  const s = status(ids, { publishedAt: at });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at, timestamp: at })) });
}
const setup = [rule(),
  { op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } },
  { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 600 } },
  { op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:temp", expect: "rises", within_s: 60 } }];

describe("Applier.stop()", () => {
  it("leaves no timer of any module behind: a rule's run waiting to resend, a cap waiting to resend, a witness's watch, a long poll", async () => {
    const m = await home({ extra });
    body(await m.configure([...setup,
      { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } },
      { op: "upsert", kind: "ack_within_s", value: { device: "hall:heater", action: "onoff.turn_off", ack_within_s: 10 } },
      { op: "upsert", kind: "ack_within_s", value: { device: "hall:valve", action: "valve.close", ack_within_s: 10 } },
      { op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_off", sensor: "hall:temp", expect: "falls", within_s: 600 } }]));
    online(m);
    m.report("temp", { temperature: 20 });
    // A heating load on past its cap: its turn-off goes, is watched, and fails, so the cap waits to send it again.
    m.report("heater", { on: true });
    for (let i = 0; i < 5; i++) {
      m.clock.advance(4100);
      online(m);
      await flush();
    }
    const off = m.sent.find((x) => x.device === "heater" && x.body.value.action === "onoff.turn_off")!;
    m.ack(off, "failed", { reason: "rejected" });
    // A leak: the rule's valve.close fails too, so its run waits to send it again.
    m.report("leak", { leak: true });
    await flush();
    m.ack(m.sent.find((x) => x.device === "valve")!, "failed", { reason: "rejected" });
    await flush();
    const polled = m.a.call(m.owner, "events", { cursor: await m.cursor(), wait_s: 30 });
    await m.store.settled();
    const x = m.a as unknown as Record<string, any>;
    expect(x.witnesses.watches.size).toBeGreaterThan(0);
    expect(x.caps.caps.get("hall:heater")?.timer).toBeDefined();
    expect([...x.safety.running.values()].flatMap((r: any) => r.acts).some((a: any) => a.timer !== undefined)).toBe(true);
    expect(x.log.waiters.size).toBe(1);
    m.a.stop();
    expect(pending(m)).toBe(0);
    // The long poll is answered at once, not left hanging on a timer that will never fire.
    expect(body(await polled).events).toEqual([]);
  });

  it("clears what resume set after a restart: the liveness graces and the kept watches' verdict timers", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db), extra });
    body(await m.configure(setup));
    online(m);
    m.report("temp", { temperature: 20 });
    await m.apply("hall:heater", "onoff.turn_on", { token: true });
    await flush();
    m.ack(m.sent.find((x) => x.device === "heater")!, "confirmed");
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    // The bridge not heard yet: the rule's devices are graced, the watch kept waits for its due.
    const again = await home({ db, fresh: false, extra, at: (m.clock as FakeClock).now() });
    const x = again.a as unknown as Record<string, any>;
    expect(x.safety.watch.graced.size).toBeGreaterThan(0);
    expect(x.witnesses.resumed.size).toBe(1);
    again.a.stop();
    expect(pending(again)).toBe(0);
  });
});
