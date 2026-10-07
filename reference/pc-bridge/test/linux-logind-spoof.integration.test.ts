import { existsSync } from "node:fs";
import dbus from "dbus-next";
import { describe, expect, it } from "vitest";
import { dbusNextBus, type BusSignal } from "../src/linux/bus.js";
import { Logind, type LogindEvent } from "../src/linux/logind.js";

/**
 * Review C1 on the real system bus: one of this account's connections sends logind-looking signals
 * straight to another of its own (a unicast signal, which the stock bus policy lets any client send
 * and match rules do not filter). The bus delivers them; the backend must not act on them. Nothing
 * is sent to logind: the only calls are the bus daemon's `AddMatch` and `GetNameOwner`. Skipped
 * where there is no system bus.
 */
const hasSystemBus = existsSync("/var/run/dbus/system_bus_socket");

describe.skipIf(!hasSystemBus)("forged logind signals on this machine's bus", () => {
  it("are delivered by the bus, stamped with the forger's name, and ignored by the backend", async () => {
    let raw!: dbus.MessageBus;
    const victim = await dbusNextBus({ make: () => (raw = dbus.systemBus()) });
    const attacker = dbus.systemBus();
    // Its connect may come while the victim sets up: waited for from the start.
    const attackerReady = new Promise<void>((r) => attacker.once("connect", () => r()));
    try {
      const logind = new Logind(victim);
      await logind.watch();
      const heard: BusSignal[] = [];
      const acted: LogindEvent[] = [];
      victim.onSignal((s) => {
        if (s.sender !== attacker.name) return;
        heard.push(s);
        const e = logind.accept(s);
        if (e) acted.push(e);
      });
      await attackerReady;
      const forge = (path: string, iface: string, member: string, signature: string, body: unknown[]) =>
        attacker.send(new dbus.Message({ type: dbus.MessageType.SIGNAL, destination: raw.name!, path, interface: iface, member, signature, body }));
      forge("/org/freedesktop/login1", "org.freedesktop.login1.Manager", "PrepareForShutdown", "b", [true]);
      forge("/org/freedesktop/login1", "org.freedesktop.login1.Manager", "PrepareForSleep", "b", [true]);
      forge("/org/freedesktop/login1/session/_32", "org.freedesktop.DBus.Properties", "PropertiesChanged", "sa{sv}as",
        ["org.freedesktop.login1.Session", {}, []]);
      forge("/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged", "sss", ["org.freedesktop.login1", ":1.1", ""]);
      const deadline = Date.now() + 5_000;
      while (heard.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(heard.map((s) => s.member)).toEqual(["PrepareForShutdown", "PrepareForSleep", "PropertiesChanged", "NameOwnerChanged"]);
      expect(acted).toEqual([]);
    } finally {
      victim.close();
      attacker.disconnect();
    }
  }, 15_000);
});
