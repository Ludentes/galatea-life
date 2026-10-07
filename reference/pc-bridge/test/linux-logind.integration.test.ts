import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dbusNextBus } from "../src/linux/bus.js";
import { Logind, toOsSessions } from "../src/linux/logind.js";

/**
 * This machine's own logind, read as the current user, read-only: no session is locked, nothing is
 * suspended. Skipped where there is no system bus, or no logind on it (a container, CI).
 */
const hasSystemBus = existsSync("/var/run/dbus/system_bus_socket");

describe.skipIf(!hasSystemBus)("logind on this machine", () => {
  it("lists this machine's sessions with the properties the design lists, as any user may read them", async (ctx) => {
    const bus = await dbusNextBus();
    try {
      const logind = new Logind(bus);
      if (!(await logind.present())) return ctx.skip();
      const reading = await logind.read();
      for (const s of reading.sessions) {
        expect(s.id).toMatch(/^\S+$/);
        expect(Number.isInteger(s.uid)).toBe(true);
        expect(typeof s.type).toBe("string");
        expect(typeof s.class).toBe("string");
        expect(["online", "active", "closing"]).toContain(s.state);
        expect(s.timestampUs).toBeGreaterThan(1_000_000_000_000_000);
      }
      const sessions = toOsSessions(reading);
      expect(sessions.filter((s) => s.seat0Active).length).toBeLessThanOrEqual(1);
      // A start in ms since the epoch; not bounded by now, since a clock stepped back since the login leaves it ahead.
      for (const s of sessions) expect(Number.isSafeInteger(s.startedAt)).toBe(true);
      expect(typeof (await logind.scheduledShutdown())).toBe("boolean");
    } finally {
      bus.close();
    }
  });
});
