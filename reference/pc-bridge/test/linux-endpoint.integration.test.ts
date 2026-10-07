import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import dbus from "dbus-next";
import { afterEach, describe, expect, it } from "vitest";
import { Helpers } from "../src/helpers.js";
import { dbusNextBus, type Bus } from "../src/linux/bus.js";
import { HelperEndpoint, REFUSED } from "../src/linux/endpoint.js";
import type { HelperMessage, OsPort } from "../src/port.js";
import { FakeClock, osSession } from "./fakes.js";
import { hasDbusDaemon, privateBus, SYSTEM_DEFAULT_POLICY } from "./private-bus.js";

/**
 * The helper endpoint on a private `dbus-daemon` run as this account (plan 4b), with the system bus's
 * default policy and holes like the bridge's own: the endpoint, a stand-in logind, a stand-in helper
 * (a process of its own) and a forger (this test's own connection). The uid and pid come from that
 * daemon; the binding is the core's own `Helpers`. Nothing reaches this machine's system or session
 * bus, and no notification is shown anywhere.
 */
const POLICY = `${SYSTEM_DEFAULT_POLICY}
  <policy context="default">
    <allow own="org.galatea.PcBridge1"/>
    <allow own="org.freedesktop.login1"/>
    <allow send_destination="org.freedesktop.login1"/>
    <allow send_destination="org.galatea.PcBridge1" send_interface="org.galatea.PcBridge1"/>
    <allow send_interface="org.galatea.PcBridge1.Helper"/>
  </policy>`;

const PEER = fileURLToPath(new URL("./fixtures/bus-peer.mjs", import.meta.url));

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

/** logind as far as the endpoint asks it: the session of a pid, and each of `ids`' `Id`. */
async function fakeLogind(address: string, sessionOfPid: Map<number, string>, ids: string[]): Promise<Bus> {
  const bus = await dbusNextBus({ address });
  cleanups.push(() => bus.close());
  expect(await bus.requestName("org.freedesktop.login1")).toBe(true);
  bus.onCall("/org/freedesktop/login1", (c) => {
    const id = sessionOfPid.get(Number(c.body[0]));
    if (c.member !== "GetSessionByPID" || id === undefined) return c.fail("org.freedesktop.login1.NoSessionForPID", "no session");
    c.reply("o", [`/org/freedesktop/login1/session/_3${id}`]);
  });
  for (const id of ids) {
    bus.onCall(`/org/freedesktop/login1/session/_3${id}`, (c) => c.reply("v", [new dbus.Variant("s", id)]));
  }
  return bus;
}

/** The stand-in helper: a process of its own, answering on stdout what each line on stdin asked. */
async function peer(address: string): Promise<{ child: ChildProcess; lines: Record<string, unknown>[]; say(line: string): void; first: { name: string; pid: number } }> {
  const child = spawn(process.execPath, [PEER, address], { stdio: ["pipe", "pipe", "inherit"] });
  cleanups.push(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const lines: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout! }).on("line", (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  await until(() => lines.length > 0, "the peer's name");
  return { child, lines, say: (l) => child.stdin!.write(`${l}\n`), first: lines[0] as { name: string; pid: number } };
}

describe.skipIf(!hasDbusDaemon)("the helper endpoint on a private bus (plan 4b)", () => {
  it("binds the helper by the daemon's uid and pid and logind's session, refuses a forger, passes a notification, and hears the drop", async () => {
    const d = await privateBus({ policy: POLICY });
    cleanups.push(() => d.stop());
    const sessionOfPid = new Map<number, string>();
    await fakeLogind(d.address, sessionOfPid, ["2"]);
    const service = await dbusNextBus({ address: d.address });
    cleanups.push(() => service.close());
    const seen: HelperMessage[] = [];
    const refused: string[] = [];
    let helpers!: Helpers;
    const endpoint = new HelperEndpoint({ bus: service, emit: (m) => { seen.push(m); helpers.onMessage(m); }, log: () => {} });
    service.onSignal((s) => endpoint.onSignal(s));
    expect(await endpoint.open()).toBe(true);

    const helper = await peer(d.address);
    sessionOfPid.set(helper.first.pid, "2");
    // The forger is another process of the same session and account: this test's own.
    sessionOfPid.set(process.pid, "2");
    const port = {
      startHelper: async () => helper.first.pid,
      stopHelper: async () => void helper.child.kill("SIGTERM"),
      closeHelper: async (conn: number) => endpoint.close(conn),
    } as unknown as OsPort;
    helpers = new Helpers({ port, clock: new FakeClock(), refused: (r) => refused.push(r), changed: () => {}, running: () => true });
    const uid = process.getuid!();
    await helpers.sync([osSession({ id: "2", osId: uid })]);

    helper.say("hello");
    await until(() => helpers.conn("2") !== undefined, "the helper bound");
    expect(seen[0]).toEqual({ kind: "connected", from: { conn: 1, pid: helper.first.pid, osId: uid, session: "2" } });
    helper.say("report 2 idle");
    await until(() => helpers.activity("2") === "idle", "its report taken");

    // A forged report from another connection of the same account and session.
    const forger = await dbusNextBus({ address: d.address });
    cleanups.push(() => forger.close());
    const answer = await forger.call("org.galatea.PcBridge1", "/org/galatea/PcBridge1", "org.galatea.PcBridge1", "Report", "sa{sv}",
      ["2", { activity: new dbus.Variant("s", "active") }]).catch((e: unknown) => e);
    expect((answer as { type?: string }).type).toBe(REFUSED);
    expect(refused).toEqual([`session 2: pid ${process.pid} is no helper the bridge started`]);
    expect(helpers.activity("2")).toBe("idle");

    await endpoint.notify(helpers.conn("2")!, "От: Galatea\nпроверка", "info");
    await until(() => helper.lines.some((l) => "notified" in l), "the notification handed over");
    expect(helper.lines.find((l) => "notified" in l)).toEqual({ notified: ["От: Galatea\nпроверка", "info"], from: service.uniqueName() });

    helper.say("exit");
    await until(() => helpers.conn("2") === undefined, "the helper's connection gone");
    expect(seen.filter((m) => m.kind === "gone").map((m) => (m as { from: { pid: number } }).from.pid)).toEqual([process.pid, helper.first.pid]);
  }, 20_000);
});
