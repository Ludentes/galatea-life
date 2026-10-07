import { describe, expect, it } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, home, LEAK, rule, status } from "./safe-home.js";

// covers: the maintainer's ruling 8 across a restart, three-valued: a resumed run whose `all` trigger is false on a
// reported term is not wanted, whatever term is still unknown (the 7b preflight's M1, its probe kept).

type Home = Awaited<ReturnType<typeof home>>;
const at = (m: Home) => new Date(m.clock.now()).toISOString();
const available = (m: Home, device: string, up: boolean) =>
  m.send(`devices/${device}/status`, { deviceId: device, available: up, timestamp: at(m) });
function online(m: Home, dead: string[] = []): void {
  m.send("devices", { devices: DEVICES }, true);
  m.a.listening("hall");
  const s = status(DEVICES.map((d) => d.id), { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.filter((d) => !dead.includes(d.id)).map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
const HEAT = { device: "hall:thermo", key: "mode", op: "eq", value: "heat" };

describe("unknown is not false, and false is false (GA-SAFE-12)", () => {
  it("does not re-send a resumed run's close once its all-trigger is false on a reported value", async () => {
    const db = await memoryDb();
    const m = await home({ db: lasting(db) });
    body(await m.configure([rule({ trigger: { all: [LEAK, HEAT] } })]));
    available(m, "valve", false);
    m.report("thermo", { mode: "heat" });
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.filter((s) => s.device === "valve")).toEqual([]);
    await m.store.settled();
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, at: m.clock.now() + 1000 });
    // After the restart: the sensor dry (a known false term); the thermostat not yet reported in this life.
    again.send("devices", { devices: DEVICES }, true);
    again.a.listening("hall");
    again.report("leak", { leak: false });
    await flush();
    online(again);
    await flush();
    again.clock.advance(15_000);
    online(again);
    await flush();
    const closes = again.sent.filter((s) => s.device === "valve");
    // The trigger `leak and heat` is false on the latest reported leak: the rule no longer wants its close (GA-SAFE-12).
    expect(closes).toEqual([]);
  });
});
