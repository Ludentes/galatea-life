import { afterEach, describe, expect, it } from "vitest";
import { dbusNextBus, type Bus, type BusCall } from "../src/linux/bus.js";
import { hasDbusDaemon, OPEN_POLICY, privateBus, type PrivateBus } from "./private-bus.js";

/**
 * The bus as a server (plan 4b), on a private `dbus-daemon` this test starts as this account: a name
 * owned, the calls made to a path, each caller's name as the daemon stamped it. Nothing reaches this
 * machine's own buses.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function daemon(policy?: string): Promise<PrivateBus> {
  const d = await privateBus(policy ? { policy } : {});
  cleanups.push(() => d.stop());
  return d;
}

async function connect(d: PrivateBus): Promise<Bus> {
  const bus = await dbusNextBus({ address: d.address });
  cleanups.push(() => bus.close());
  return bus;
}

describe.skipIf(!hasDbusDaemon)("dbusNextBus as a server (plan 4b)", () => {
  it("owns a name, and hands each call on its path over with the caller's name as the daemon stamped it", async () => {
    const d = await daemon(OPEN_POLICY);
    const server = await connect(d);
    const client = await connect(d);
    expect(server.uniqueName()).toMatch(/^:1\.\d+$/);
    expect(await server.requestName("org.example.Server")).toBe(true);
    const calls: BusCall[] = [];
    server.onCall("/org/example/Server", (c) => {
      calls.push(c);
      c.reply("s", [`hello ${c.sender}`]);
      // A second answer is dropped: one call, one answer.
      c.reply("s", ["again"]);
    });
    const [said] = await client.call("org.example.Server", "/org/example/Server", "org.example.Server", "Hello", "su", ["x", 7]);
    expect(said).toBe(`hello ${client.uniqueName()}`);
    expect(calls.map((c) => [c.sender, c.interface, c.member, c.signature, c.body])).toEqual([
      [client.uniqueName(), "org.example.Server", "Hello", "su", ["x", 7]],
    ]);
  });

  it("refuses a call on another path, and passes a refusal on with its error's name", async () => {
    const d = await daemon(OPEN_POLICY);
    const server = await connect(d);
    const client = await connect(d);
    await server.requestName("org.example.Server");
    server.onCall("/org/example/Server", (c) => c.fail("org.example.Error.Refused", "not you"));
    const refused = await client.call("org.example.Server", "/org/example/Server", "org.example.Server", "Hello").catch((e: unknown) => e);
    expect((refused as { type?: string }).type).toBe("org.example.Error.Refused");
    const elsewhere = await client.call("org.example.Server", "/elsewhere", "org.example.Server", "Hello").catch((e: unknown) => e);
    expect((elsewhere as { type?: string }).type).toBe("org.freedesktop.DBus.Error.UnknownMethod");
  });

  it("does not take a name another connection holds: never queued", async () => {
    const d = await daemon(OPEN_POLICY);
    const first = await connect(d);
    const second = await connect(d);
    expect(await first.requestName("org.example.Server")).toBe(true);
    expect(await second.requestName("org.example.Server")).toBe(false);
    expect(await first.requestName("org.example.Server")).toBe(true);
  });

  it("rejects a name the bus's policy refuses (the system bus's default)", async () => {
    const d = await daemon();
    const bus = await connect(d);
    await expect(bus.requestName("org.example.Server")).rejects.toThrow(/not allowed to own/);
  });
});
