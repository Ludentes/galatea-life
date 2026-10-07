import { describe, expect, it } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, rf, status } from "./safe-home.js";

// covers: GA-LOAD-2 across a restart: a cap armed again on an on-time whose attempts the last life sent
// derives no ended run as new, and turns the socket off (the 7b preflight's I1, its probe kept).

type Home = Awaited<ReturnType<typeof home>>;
const ids = [...DEVICES, heater, rf].map((d) => d.id);
const at = (m: Home) => new Date(m.clock.now()).toISOString();
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
async function advance(m: Home, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5000) {
    m.clock.advance(Math.min(5000, left));
    online(m);
    await flush();
  }
}
const offs = (m: Home, from = 0) => m.sent.slice(from).filter((x) => x.device === "heater" && x.body.value.action === "onoff.turn_off");
const heating = [{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } },
  { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } },
  { op: "upsert", kind: "ack_within_s", value: { device: "hall:heater", action: "onoff.turn_off", ack_within_s: 10 } }];
const notHeating = [{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "lighting" } },
  { op: "delete", kind: "max_on_s", value: { device: "hall:heater" } }];

describe("a cap armed again across a restart (GA-LOAD-2)", () => {
  it.each([false, true])("sends a turn-off when a load is made heating again past its cap (restart between: %s)", async (restart) => {
    const db = await memoryDb();
    let m = await home({ db: lasting(db), extra: [heater, rf] });
    body(await m.configure(heating));
    online(m);
    m.report("heater", { on: true });
    await advance(m, 20_500);
    const [first] = offs(m);
    expect(first).toBeDefined();
    // The bridge refuses it for good: the cap is done, stuck.
    m.ack(first!, "failed", { reason: "unsupported_action" });
    await flush();
    // The owner makes the load lighting: the cap stops, its row deleted; the socket still on.
    body(await m.configure(notHeating));
    await advance(m, 5000);
    if (restart) {
      await m.store.settled();
      m.a.stop();
      await m.store.close();
      m = await home({ db, fresh: false, extra: [heater, rf], at: m.clock.now() });
      m.send("devices", { devices: [...DEVICES, heater, rf] }, true);
      m.a.listening("hall");
      online(m);
      m.report("heater", { on: true });
      await flush();
    }
    const from = m.sent.length;
    // Heating again, the socket on for well past its cap: the applier must turn it off.
    body(await m.configure(heating));
    await advance(m, 15_000);
    expect(offs(m, from).length).toBeGreaterThan(0);
  });
});
