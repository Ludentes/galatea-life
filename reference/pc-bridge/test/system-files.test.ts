import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dbusNextBus, type Bus } from "../src/linux/bus.js";
import { hasDbusDaemon, privateBus, SYSTEM_DEFAULT_POLICY, type PrivateBus } from "./private-bus.js";

/**
 * The files an install puts in place (plan 4b): the bus policy, loaded by a private `dbus-daemon`
 * run as this account with the system bus's default policy, as the system bus loads `system.d`; and
 * the unit, read and checked by `systemd-analyze verify` in a temporary directory. Nothing is
 * installed on this machine.
 */
const POLICY_FILE = fileURLToPath(new URL("../system/org.galatea.PcBridge1.conf", import.meta.url));
const UNIT_FILE = fileURLToPath(new URL("../system/galatea-pc-bridge.service", import.meta.url));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
async function daemon(includes: string[]): Promise<PrivateBus> {
  const d = await privateBus({ policy: SYSTEM_DEFAULT_POLICY, includes });
  cleanups.push(() => d.stop());
  return d;
}
async function connect(d: PrivateBus): Promise<Bus> {
  const bus = await dbusNextBus({ address: d.address });
  cleanups.push(() => bus.close());
  return bus;
}
const errType = (e: unknown) => (e as { type?: string }).type;

describe.skipIf(!hasDbusDaemon)("the bus policy, as a bus daemon loads it", () => {
  it("lets no account but root own the endpoint's name: this one is refused", async () => {
    const d = await daemon([POLICY_FILE]);
    const bus = await connect(d);
    expect(userInfo().uid).not.toBe(0);
    await expect(bus.requestName("org.galatea.PcBridge1")).rejects.toThrow(/not allowed to own the service "org\.galatea\.PcBridge1"/);
  });

  it("lets any account call the endpoint's interface and nothing else of it (the file, root read as this account)", async () => {
    // The same rules with this account in root's place, so that a connection of its own can own the name.
    const dir = mkdtempSync(join(tmpdir(), "galatea-policy-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const mine = join(dir, "org.galatea.PcBridge1.conf");
    const text = readFileSync(POLICY_FILE, "utf8");
    expect(text.match(/<policy user="root">/g)).toHaveLength(1);
    writeFileSync(mine, text.replace('<policy user="root">', `<policy user="${userInfo().username}">`));
    const d = await daemon([mine]);
    const service = await connect(d);
    expect(await service.requestName("org.galatea.PcBridge1")).toBe(true);
    service.onCall("/org/galatea/PcBridge1", (c) => c.reply("s", [`${c.interface}.${c.member}`]));
    const caller = await connect(d);
    const call = (iface: string, member: string) => caller.call("org.galatea.PcBridge1", "/org/galatea/PcBridge1", iface, member).catch((e: unknown) => e);
    expect(await call("org.galatea.PcBridge1", "Hello")).toEqual(["org.galatea.PcBridge1.Hello"]);
    expect(errType(await call("org.galatea.PcBridge1.Other", "Hello"))).toBe("org.freedesktop.DBus.Error.AccessDenied");
    expect(errType(await call("org.freedesktop.DBus.Introspectable", "Introspect"))).toBe("org.freedesktop.DBus.Error.AccessDenied");
    expect(errType(await call("org.freedesktop.DBus.Properties", "GetAll"))).toBe("org.freedesktop.DBus.Error.AccessDenied");
  });

  it("lets no account but root call a helper's object: this one is refused", async () => {
    const d = await daemon([POLICY_FILE]);
    const helper = await connect(d);
    helper.onCall("/org/galatea/PcBridge1/Helper", (c) => c.reply());
    const other = await connect(d);
    const err = await other.call(helper.uniqueName(), "/org/galatea/PcBridge1/Helper", "org.galatea.PcBridge1.Helper", "Notify", "ss", ["x", "info"])
      .catch((e: unknown) => e);
    expect(errType(err)).toBe("org.freedesktop.DBus.Error.AccessDenied");
  });
});

describe("the unit", () => {
  const unit = readFileSync(UNIT_FILE, "utf8");
  const settings = unit.split("\n").filter((l) => /^[A-Za-z]+=/.test(l));

  it("runs main as root with its state directory, restarts on a crash but not on a refusal, and stops the bridge first", () => {
    expect(settings).toEqual(expect.arrayContaining([
      "ExecStart=/usr/bin/node /usr/lib/galatea-pc-bridge/dist/main.js", "EnvironmentFile=/etc/galatea-pc-bridge/environment",
      "StateDirectory=galatea-pc-bridge", "StateDirectoryMode=0755", "Restart=on-failure", "RestartPreventExitStatus=2", "KillMode=mixed",
    ]));
    expect(settings.some((l) => /^(User|Group|DynamicUser)=/.test(l))).toBe(false);
  });

  it("carries none of the sandboxing that would break what it starts: the cgroup writes, setpriv, sudo, a player, an X11 client", () => {
    for (const option of ["ProtectSystem", "ProtectHome", "PrivateTmp", "PrivateDevices", "DevicePolicy", "DeviceAllow", "ProtectControlGroups",
      "ProtectKernelTunables",
      "NoNewPrivileges", "RestrictNamespaces", "SystemCallArchitectures", "MemoryDenyWriteExecute"]) {
      expect(settings.filter((l) => l.startsWith(`${option}=`)), option).toEqual([]);
    }
  });

  it("keeps the three protections the VM run showed harmless to the helper's move, a server's devices and an X window (plan 4b, *The desktop run*)", () => {
    for (const option of ["ProtectKernelModules", "ProtectKernelLogs", "ProtectClock"]) {
      expect(settings.filter((l) => l.startsWith(`${option}=`)), option).toEqual([`${option}=yes`]);
    }
  });

  it("drops from its bounding set the root powers neither it nor sudo uses, which its children could never gain (review M6)", () => {
    expect(settings.filter((l) => l.startsWith("CapabilityBoundingSet="))).toEqual([
      "CapabilityBoundingSet=~CAP_SYS_MODULE CAP_SYSLOG CAP_SYS_TIME CAP_SYS_RAWIO CAP_MKNOD",
    ]);
  });

  it.skipIf(!existsSync("/usr/bin/systemd-analyze"))("passes systemd-analyze verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "galatea-unit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "galatea-pc-bridge.service"), unit);
    const r = spawnSync("systemd-analyze", ["verify", "--man=no", join(dir, "galatea-pc-bridge.service")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    // Its notes on the machine's own units are not this one's.
    expect(r.stderr.split("\n").filter((l) => l.includes("galatea-pc-bridge"))).toEqual([]);
  });
});
