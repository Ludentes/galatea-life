import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type dbus from "dbus-next";
import { afterEach, describe, expect, it } from "vitest";
import { dbusNextBus, unwrap, type BusSignal } from "../src/linux/bus.js";

const SYSTEM_BUS = "/var/run/dbus/system_bus_socket";
const hasSystemBus = existsSync(SYSTEM_BUS);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A Unix socket that accepts connections and never says a word: a bus daemon that hangs. */
async function silentSocket(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "galatea-bus-"));
  const path = join(dir, "bus");
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => void sockets.push(s));
  await new Promise<void>((r) => server.listen(path, r));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

describe("dbusNextBus", () => {
  it("rejects a bus that is not there, with no call left pending", async () => {
    const err = await dbusNextBus({ address: "unix:path=/nonexistent/galatea/bus", timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/ENOENT/);
  });

  it("rejects a bus that never answers once its bound has passed", async () => {
    const path = await silentSocket();
    const started = Date.now();
    const err = await dbusNextBus({ address: `unix:path=${path}`, timeoutMs: 300 }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/did not answer within 300 ms/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("unwraps a Variant, and leaves a plain value alone", () => {
    expect(unwrap({ signature: "s", value: "x11" })).toBe("x11");
    expect(unwrap("x11")).toBe("x11");
    expect(unwrap(null)).toBe(null);
  });

  it.skipIf(!hasSystemBus)("calls the system bus, and delivers the signals a match rule asks for", async () => {
    const bus = await dbusNextBus();
    cleanups.push(() => bus.close());
    const [id] = await bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Another connection's arrival is a NameOwnerChanged every client may hear: nothing is changed.
    await bus.addMatch("type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged'");
    const heard: BusSignal[] = [];
    bus.onSignal((s) => heard.push(s));
    const other = await dbusNextBus();
    other.close();
    const deadline = Date.now() + 5_000;
    while (!heard.some((s) => s.member === "NameOwnerChanged") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(heard.some((s) => s.member === "NameOwnerChanged" && s.interface === "org.freedesktop.DBus")).toBe(true);
  });

  it("bounds each call: a peer that never answers is an error at the bound", async () => {
    const hanging = Object.assign(new EventEmitter(), { call: () => new Promise(() => {}), disconnect: () => {} });
    setImmediate(() => hanging.emit("connect"));
    const bus = await dbusNextBus({ make: () => hanging as unknown as dbus.MessageBus, timeoutMs: 200 });
    cleanups.push(() => bus.close());
    await expect(bus.call("org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "ListSessions"))
      .rejects.toThrow("org.freedesktop.login1.Manager.ListSessions did not answer within 200 ms");
  });

  it("reports the connection's loss once, and refuses calls after it", async () => {
    const flaky = Object.assign(new EventEmitter(), { call: () => new Promise(() => {}), disconnect: () => {} });
    setImmediate(() => flaky.emit("connect"));
    const bus = await dbusNextBus({ make: () => flaky as unknown as dbus.MessageBus });
    const lost: string[] = [];
    bus.onClose((err) => lost.push(err.message));
    flaky.emit("error", new Error("read ECONNRESET"));
    flaky.emit("error", new Error("again"));
    expect(lost).toEqual(["read ECONNRESET"]);
    await expect(bus.call("a.b", "/", "a.b", "C")).rejects.toThrow(/closed/);
  });

  it("carries each signal's sender, as the bus daemon stamped it (review C1)", async () => {
    const raw = Object.assign(new EventEmitter(), { call: () => new Promise(() => {}), disconnect: () => {} });
    setImmediate(() => raw.emit("connect"));
    const bus = await dbusNextBus({ make: () => raw as unknown as dbus.MessageBus });
    cleanups.push(() => bus.close());
    const heard: BusSignal[] = [];
    bus.onSignal((s) => heard.push(s));
    raw.emit("message", {
      type: 4, sender: ":1.99", path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "PrepareForShutdown", body: [true],
    });
    expect(heard).toEqual([{
      sender: ":1.99", path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "PrepareForShutdown", body: [true],
    }]);
  });

  it("reports the connection's loss at once when the bus daemon ends it cleanly, as dbus-next does not (review M4)", async () => {
    const connection = new EventEmitter();
    const raw = Object.assign(new EventEmitter(), { _connection: connection, call: () => new Promise(() => {}), disconnect: () => {} });
    setImmediate(() => raw.emit("connect"));
    const bus = await dbusNextBus({ make: () => raw as unknown as dbus.MessageBus });
    const lost: string[] = [];
    bus.onClose((err) => lost.push(err.message));
    connection.emit("end");
    expect(lost).toEqual(["the system bus ended the connection"]);
    await expect(bus.call("a.b", "/", "a.b", "C")).rejects.toThrow(/closed/);
  });

  it("settles a call still waiting at once when the connection is closed", async () => {
    // dbus-next's bus as it is once connected, whose calls never answer: a peer that hangs.
    const hanging = Object.assign(new EventEmitter(), { call: () => new Promise(() => {}), disconnect: () => {} });
    setImmediate(() => hanging.emit("connect"));
    const bus = await dbusNextBus({ make: () => hanging as unknown as dbus.MessageBus, timeoutMs: 10_000 });
    const started = Date.now();
    const waiting = bus.call("org.example.Peer", "/", "org.example.Nothing", "Wait").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    bus.close();
    expect(String(await waiting)).toMatch(/closed/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it.skipIf(!hasSystemBus)("rejects a call once the connection is closed", async () => {
    const bus = await dbusNextBus();
    bus.close();
    await expect(bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId")).rejects.toThrow(/closed/);
  });
});
