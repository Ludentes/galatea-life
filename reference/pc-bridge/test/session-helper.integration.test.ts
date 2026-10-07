import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import dbus from "dbus-next";
import { afterEach, describe, expect, it } from "vitest";
import { SessionHelper } from "../src/helper/session-helper.js";
import { dbusNextBus, type Bus } from "../src/linux/bus.js";
import { HELPER_IFACE, HELPER_PATH, HelperEndpoint } from "../src/linux/endpoint.js";
import type { HelperMessage } from "../src/port.js";
import { FakeRunner } from "./linux-fakes.js";
import { hasDbusDaemon, OPEN_POLICY, privateBus, SYSTEM_DEFAULT_POLICY, type PrivateBus } from "./private-bus.js";

/**
 * The session helper against a private bus pair this test starts as this account (plan 4b): a
 * "system" bus with the system bus's default policy, the endpoint and a stand-in logind; a "session"
 * bus with stand-ins for Mutter's idle monitor and the notification service. No notification is shown
 * on this machine's desktop, and nothing reaches its own buses.
 */
const POLICY = `${SYSTEM_DEFAULT_POLICY}
  <policy context="default">
    <allow own="org.galatea.PcBridge1"/>
    <allow own="org.freedesktop.login1"/>
    <allow send_destination="org.freedesktop.login1"/>
    <allow send_destination="org.galatea.PcBridge1" send_interface="org.galatea.PcBridge1"/>
    <allow send_interface="org.galatea.PcBridge1.Helper"/>
  </policy>`;
const PW = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/pw-dump.json", import.meta.url)), "utf8")) as { busy: unknown[] };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
const until = async (cond: () => boolean, what: string, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`not met: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function connect(d: PrivateBus): Promise<Bus> {
  const bus = await dbusNextBus({ address: d.address });
  cleanups.push(() => bus.close());
  return bus;
}

interface Pair {
  system: PrivateBus;
  session: PrivateBus;
  service: Bus;
  endpoint: HelperEndpoint;
  seen: HelperMessage[];
  shown: unknown[][];
  idle: { ms: number | null };
  idleHint: { value: boolean };
}

/** The two buses, the endpoint, logind for session 2 (this test's pid in it), Mutter and the notification service. */
async function pair(): Promise<Pair> {
  const system = await privateBus({ policy: POLICY });
  const session = await privateBus({ policy: OPEN_POLICY });
  cleanups.push(() => system.stop(), () => session.stop());
  const logind = await connect(system);
  await logind.requestName("org.freedesktop.login1");
  const idleHint = { value: true };
  logind.onCall("/org/freedesktop/login1", (c) => {
    if (c.member === "GetSessionByPID" && c.body[0] === process.pid) return c.reply("o", ["/org/freedesktop/login1/session/_32"]);
    if (c.member === "GetSession" && c.body[0] === "2") return c.reply("o", ["/org/freedesktop/login1/session/_32"]);
    c.fail("org.freedesktop.login1.NoSessionForPID", "no session");
  });
  logind.onCall("/org/freedesktop/login1/session/_32", (c) =>
    c.reply("v", [c.body[1] === "IdleHint" ? new dbus.Variant("b", idleHint.value) : new dbus.Variant("s", "2")]));
  const service = await connect(system);
  const seen: HelperMessage[] = [];
  const endpoint = new HelperEndpoint({ bus: service, emit: (m) => seen.push(m), log: () => {} });
  service.onSignal((s) => endpoint.onSignal(s));
  await endpoint.open();
  const desktop = await connect(session);
  const idle = { ms: 400_000 as number | null };
  await desktop.requestName("org.gnome.Mutter.IdleMonitor");
  desktop.onCall("/org/gnome/Mutter/IdleMonitor/Core", (c) =>
    idle.ms === null ? c.fail("org.freedesktop.DBus.Error.UnknownMethod", "gone") : c.reply("t", [BigInt(idle.ms)]));
  const shown: unknown[][] = [];
  await desktop.requestName("org.freedesktop.Notifications");
  desktop.onCall("/org/freedesktop/Notifications", (c) => {
    shown.push(c.body);
    c.reply("u", [shown.length]);
  });
  return { system, session, service, endpoint, seen, shown, idle, idleHint };
}

const TOKEN = "5a".repeat(32);

async function helper(p: Pair, o: { keys?: string[]; run?: FakeRunner; token?: string } = {}) {
  const exits: number[] = [];
  const logs: string[] = [];
  const h = new SessionHelper({
    system: await dbusNextBus({ address: p.system.address }), session: await dbusNextBus({ address: p.session.address }),
    run: (o.run ?? new FakeRunner()).run, sessionId: "2", idleAfterS: 300, keys: o.keys ?? [], env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    token: o.token ?? TOKEN, log: (l) => logs.push(l), exit: (c) => exits.push(c), readMs: 50,
  });
  cleanups.push(() => h.end(0, "test over"));
  await h.start();
  return { h, exits, logs };
}

describe.skipIf(!hasDbusDaemon)("the session helper on a private bus pair (plan 4b)", () => {
  it("says Hello, is identified by the bus, and reports its session idle by Mutter's idle time against the threshold", async () => {
    const p = await pair();
    await helper(p);
    await until(() => p.seen.some((m) => m.kind === "report"), "a report");
    expect(p.seen[0]).toEqual({ kind: "connected", from: { conn: 1, pid: process.pid, osId: process.getuid!(), session: "2" } });
    expect(p.seen[1]).toMatchObject({ kind: "report", session: "2", values: { activity: "idle" } });
    p.idle.ms = 1_000;
    await until(() => p.seen.some((m) => m.kind === "report" && m.values.activity === "active"), "active reported on change");
  });

  it("presents its start's token in Hello: bound with the service's, refused and ended with another (review N1)", async () => {
    const p = await pair();
    // This test's own process is the "started" helper: its pid is the one the bus daemon gives.
    p.endpoint.expect(process.pid, await p.endpoint.floor(), TOKEN);
    await helper(p);
    await until(() => p.seen.some((m) => m.kind === "report"), "a report");
    expect(p.seen[0]).toEqual({ kind: "connected", from: { conn: 1, pid: process.pid, osId: process.getuid!(), session: "2" } });

    const q = await pair();
    q.endpoint.expect(process.pid, await q.endpoint.floor(), TOKEN);
    const wrong = await helper(q, { token: "a5".repeat(32) });
    expect(wrong.exits).toEqual([1]);
    expect(wrong.logs[0]).toMatch(/^the service's endpoint: /);
    expect(q.seen).toEqual([{ kind: "malformed", from: { conn: 1, pid: process.pid, osId: process.getuid!(), session: "2" },
      detail: expect.stringMatching(/presented a wrong token$/) }]);
  });

  it("falls back to logind's IdleHint with no idle monitor", async () => {
    const p = await pair();
    p.idle.ms = null;
    p.idleHint.value = false;
    await helper(p);
    await until(() => p.seen.some((m) => m.kind === "report"), "a report");
    expect(p.seen.find((m) => m.kind === "report")).toMatchObject({ values: { activity: "active" } });
  });

  it("reports the declared personal keys from PipeWire's graph, and no key it was not given", async () => {
    const p = await pair();
    await helper(p, { keys: ["camera_in_use", "microphone_in_use"], run: new FakeRunner().on("pw-dump", { stdout: JSON.stringify(PW.busy) }) });
    await until(() => p.seen.some((m) => m.kind === "report"), "a report");
    expect(p.seen.find((m) => m.kind === "report")).toMatchObject({ values: { activity: "idle", camera_in_use: true, microphone_in_use: true } });
    expect(Object.keys((p.seen.find((m) => m.kind === "report") as { values: object }).values)).not.toContain("app");
  });

  it("shows a notify through the session's notification service, the source first, when the endpoint's owner asks", async () => {
    const p = await pair();
    await helper(p);
    await until(() => p.seen.some((m) => m.kind === "connected"), "connected");
    await p.endpoint.notify(1, "От: неизвестный отправитель\n<b>Ужин</b> готов", "critical");
    expect(p.shown).toHaveLength(1);
    const [app, replaces, icon, summary, body, actions, hints, expire] = p.shown[0]!;
    expect([app, replaces, icon, summary, body, actions, expire]).toEqual(["Galatea", 0, "", "От: неизвестный отправитель", "&lt;b&gt;Ужин&lt;/b&gt; готов", [], -1]);
    expect((hints as { urgency: { value: number } }).urgency.value).toBe(2);
  });

  it("refuses a Notify from anyone but the endpoint's owner, showing nothing", async () => {
    const p = await pair();
    const { h } = await helper(p);
    await until(() => p.seen.some((m) => m.kind === "connected"), "connected");
    const forger = await connect(p.system);
    const helperName = (h as unknown as { o: { system: Bus } }).o.system.uniqueName();
    const err = await forger.call(helperName, HELPER_PATH, HELPER_IFACE, "Notify", "ss", ["От: Galatea\nфальшивка", "info"]).catch((e: unknown) => e);
    expect((err as { type?: string }).type).toBe("org.freedesktop.DBus.Error.AccessDenied");
    expect(p.shown).toEqual([]);
  });

  it("ends when the service refuses it, and when the endpoint's owner leaves the bus", async () => {
    const p = await pair();
    const refused = await helper(p);
    await until(() => p.seen.some((m) => m.kind === "connected"), "connected");
    p.endpoint.close(1);
    p.idle.ms = 1_000;
    await until(() => refused.exits.length > 0, "the refused helper ended");
    expect(refused.exits).toEqual([1]);
    expect(refused.logs).toContain("the service refused this helper");

    const p2 = await pair();
    const orphan = await helper(p2);
    await until(() => p2.seen.some((m) => m.kind === "connected"), "connected");
    p2.service.close();
    await until(() => orphan.exits.length > 0, "the orphan ended");
    expect(orphan.exits).toEqual([0]);
    expect(orphan.logs).toContain("the service left the bus");
  });

  it("takes no word of the service's leaving that another connection forges, sent straight to it", async () => {
    const p = await pair();
    const { h, exits } = await helper(p);
    await until(() => p.seen.some((m) => m.kind === "connected"), "connected");
    const attacker = dbus.sessionBus({ busAddress: p.system.address });
    cleanups.push(() => attacker.disconnect());
    await new Promise<void>((r) => attacker.once("connect", () => r()));
    const helperName = (h as unknown as { o: { system: Bus } }).o.system.uniqueName();
    // A unicast signal: match rules do not filter it, and the default policy lets anyone send one.
    attacker.send(new dbus.Message({
      type: dbus.MessageType.SIGNAL, destination: helperName, path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
      member: "NameOwnerChanged", signature: "sss", body: ["org.galatea.PcBridge1", p.service.uniqueName(), ""],
    }));
    // A call from the same connection comes after the signal, so its answer says the signal has been taken.
    const answer = await attacker.call(new dbus.Message({
      destination: helperName, path: HELPER_PATH, interface: HELPER_IFACE, member: "Notify", signature: "ss", body: ["x", "info"],
    })).catch((e: unknown) => e);
    expect((answer as { type?: string }).type).toBe("org.freedesktop.DBus.Error.AccessDenied");
    await p.endpoint.notify(1, "От: Galatea\nвсё ещё здесь", "info");
    expect(p.shown).toHaveLength(1);
    expect(exits).toEqual([]);
  });

  it("ends at once when no service owns the endpoint", async () => {
    const p = await pair();
    p.service.close();
    await until(() => p.seen.length === 0, "nothing");
    const { exits, logs } = await helper(p);
    expect(exits).toEqual([1]);
    expect(logs[0]).toMatch(/^the service's endpoint: /);
  });
});
