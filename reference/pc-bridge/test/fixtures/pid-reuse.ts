// Reviews I1 and N1, end to end, run as pid 1 of a private user and pid namespace (`unshare --user
// --map-root-user --pid --fork --mount-proc`), where `ns_last_pid` can be set so that a pid is reused
// at once: a connection opened by a process that has exited keeps that process's pid at the bus
// daemon; the service then starts its helper on that very pid. Mode argv[2]: "hello", the connection
// says the bus's Hello before (an old name); "late", only after the helper's release (a name newer
// than the floor). Everything runs on a private dbus-daemon of its own. Prints one JSON line: what
// the bus daemon said, and what the endpoint did.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import dbus from "dbus-next";
import { dbusNextBus } from "../../src/linux/bus.js";
import { HelperEndpoint } from "../../src/linux/endpoint.js";
import type { HelperMessage } from "../../src/port.js";
import { privateBus, SYSTEM_DEFAULT_POLICY } from "../private-bus.js";

const POLICY = `${SYSTEM_DEFAULT_POLICY}
  <policy context="default">
    <allow own="org.galatea.PcBridge1"/>
    <allow own="org.freedesktop.login1"/>
    <allow send_destination="org.freedesktop.login1"/>
    <allow send_destination="org.galatea.PcBridge1" send_interface="org.galatea.PcBridge1"/>
  </policy>`;
const until = async (cond: () => boolean, what: string, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`not met: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const mode = process.argv[2] === "late" ? "late" : "hello";
const d = await privateBus({ policy: POLICY });
const kill: number[] = [];
try {
  const socketPath = d.address.replace(/^unix:path=/, "").split(",")[0]!;
  // logind: every pid in session 2 (the stale connection's opener was a process of that session).
  const logind = await dbusNextBus({ address: d.address });
  await logind.requestName("org.freedesktop.login1");
  logind.onCall("/org/freedesktop/login1", (c) => c.reply("o", ["/org/freedesktop/login1/session/_32"]));
  logind.onCall("/org/freedesktop/login1/session/_32", (c) => c.reply("v", [new dbus.Variant("s", "2")]));

  const service = await dbusNextBus({ address: d.address });
  const seen: HelperMessage[] = [];
  const endpoint = new HelperEndpoint({ bus: service, emit: (m) => seen.push(m), log: () => {} });
  service.onSignal((s) => endpoint.onSignal(s));
  await endpoint.open();

  const go = join(mkdtempSync(join(tmpdir(), "galatea-pid-reuse-")), "go");
  const attacker = spawn("python3", [fileURLToPath(new URL("./stale-connection.py", import.meta.url)), socketPath, go, mode], { stdio: ["ignore", "pipe", "inherit"] });
  const lines: Record<string, unknown>[] = [];
  createInterface({ input: attacker.stdout! }).on("line", (l) => lines.push(JSON.parse(l) as Record<string, unknown>));
  await until(() => lines.length > 0, "the stale connection");
  const parent = lines[0]!.parent_pid as number;
  await until(() => !existsSync(`/proc/${parent}`), "its opener's end");

  // The service starts its helper, the next pid the opener's, as startHelper does: the floor taken
  // before the spawn, the pid expected at it with a fresh token, then released.
  const floor = await endpoint.floor();
  writeFileSync("/proc/sys/kernel/ns_last_pid", String(parent - 1));
  const helper = spawn("/bin/sleep", ["300"], { stdio: "ignore", detached: true });
  kill.push(helper.pid!);
  endpoint.expect(helper.pid!, floor, randomBytes(32).toString("hex"));

  writeFileSync(go, "");
  await until(() => lines.some((l) => "child_pid" in l), "the stale connection's Hello");
  const name = lines.find((l) => "name" in l && l.name !== null)!.name as string;
  const child = lines.find((l) => "child_pid" in l)!;
  kill.push(child.child_pid as number);
  const [daemonPid] = await service.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", "s", [name]);
  console.log(JSON.stringify({ mode, name, reused: helper.pid === parent && daemonPid === parent, hello: (child.hello as { type: string }).type, seen }));
} finally {
  for (const pid of kill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  d.stop();
}
process.exit(0);
