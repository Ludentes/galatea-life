import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, home, rule, status } from "./safe-home.js";

// covers: the maintainer's ruling 2 across crashes: a rule's actuation, its first attempt skipped(dead) before
// anything was published, then published on the device's return and lost to a crash with its records,
// is sent again after each start under the first command's id, never a new one (the 7b preflight's I2,
// its probe kept and widened to an idempotent action and to two crashes).

type Home = Awaited<ReturnType<typeof home>>;
const at = (m: Home) => new Date(m.clock.now()).toISOString();
const available = (m: Home, device: string, up: boolean) =>
  m.send(`devices/${device}/status`, { deviceId: device, available: up, timestamp: at(m) });
function online(m: Home): void {
  m.send("devices", { devices: DEVICES }, true);
  m.a.listening("hall");
  const s = status(DEVICES.map((d) => d.id), { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}

describe("the same command, the same id, after a skipped first attempt and a crash", () => {
  it.each([
    ["hall:pulse", "onoff.turn_off", 1], ["hall:pulse", "onoff.turn_off", 2],
    ["hall:valve", "valve.close", 1], ["hall:valve", "valve.close", 2],
  ] as const)("never sends %s's %s again under a new commandId, across %i crash(es)", async (target, action, crashes) => {
    const device = target.slice(5);
    const db = await memoryDb();
    let m = await home({ db: lasting(db) });
    body(await m.configure([rule({ actions: [{ target, action }] })]));
    available(m, device, false);
    await flush();
    const wetAt = m.clock.now();
    m.report("leak", { leak: true }, wetAt);
    await flush();
    await m.store.settled();
    expect(m.sent.filter((s) => s.device === device)).toEqual([]);
    // The device returns: the re-send is published, and the store fails on the run's row before it commits.
    db.trouble.failOn = /INSERT INTO applies/;
    m.clock.advance(1000);
    available(m, device, true);
    await flush();
    const first = m.sent.filter((s) => s.device === device);
    expect(first).toHaveLength(1);
    const ids = new Set([first[0]!.body.commandId]);
    for (let crash = 1; crash <= crashes; crash++) {
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      // A crash: nothing more commits.
      m.a.stop();
      db.trouble.failOn = crash < crashes ? /INSERT INTO applies/ : undefined;
      m = await home({ db, fresh: false, at: m.clock.now() });
      online(m);
      m.report("leak", { leak: true }, wetAt);
      await flush();
      m.clock.advance(15_000);
      online(m);
      await flush();
      for (const s of m.sent.filter((x) => x.device === device)) ids.add(s.body.commandId);
      if (crash < crashes && !m.store.down) break;
    }
    // Ruling 2: a re-send after a crash that lost its write carries the first's id (the bridge then drops it).
    expect([...ids]).toEqual([first[0]!.body.commandId]);
  });
});
