import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Whether `dbus-daemon` is on this machine's PATH: the private-bus tests are skipped without it. */
export const hasDbusDaemon = (process.env.PATH ?? "").split(delimiter).some((dir) => {
  try {
    accessSync(join(dir, "dbus-daemon"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

/**
 * The stock system bus's default policy (`/usr/share/dbus-1/system.conf`, dbus 1.14): any account
 * may connect, no one owns a name or sends a method call unless a policy file punches the hole,
 * signals and requested replies pass, and anyone may talk to the bus daemon.
 */
export const SYSTEM_DEFAULT_POLICY = `
  <policy context="default">
    <allow user="*"/>
    <deny own="*"/>
    <deny send_type="method_call"/>
    <allow send_type="signal"/>
    <allow send_requested_reply="true" send_type="method_return"/>
    <allow send_requested_reply="true" send_type="error"/>
    <allow receive_type="method_call"/>
    <allow receive_type="method_return"/>
    <allow receive_type="error"/>
    <allow receive_type="signal"/>
    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus"/>
    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus.Introspectable"/>
    <allow send_destination="org.freedesktop.DBus" send_interface="org.freedesktop.DBus.Properties"/>
  </policy>`;

/** A session bus's policy: anyone may own any name and call anything. */
export const OPEN_POLICY = `
  <policy context="default">
    <allow user="*"/>
    <allow own="*"/>
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
  </policy>`;

export interface PrivateBus {
  /** The bus's address, for `dbusNextBus({ address })` or `DBUS_SESSION_BUS_ADDRESS`. */
  address: string;
  /** The daemon's pid: the only process the rig ends. */
  pid: number;
  stop(): void;
}

/**
 * A `dbus-daemon` of this test's own, run as this account with a configuration in a temporary
 * directory: `policy` is the busconfig's policies, `includes` policy files it reads as the system
 * bus reads `system.d` (the bridge's own `org.galatea.PcBridge1.conf`). Nothing reaches this machine's
 * system or session bus. `stop` ends the daemon by its pid and removes the directory.
 */
export async function privateBus(o: { policy?: string; includes?: string[] } = {}): Promise<PrivateBus> {
  const dir = mkdtempSync(join(tmpdir(), "galatea-dbus-"));
  const conf = join(dir, "bus.conf");
  writeFileSync(conf, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>custom</type>
  <listen>unix:path=${join(dir, "bus")}</listen>
  <auth>EXTERNAL</auth>
  ${o.policy ?? SYSTEM_DEFAULT_POLICY}
  ${(o.includes ?? []).map((f) => `<include>${f}</include>`).join("\n  ")}
</busconfig>
`);
  const child: ChildProcess = spawn("dbus-daemon", [`--config-file=${conf}`, "--nofork", "--nopidfile", "--print-address=1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const address = await new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => reject(new Error(`dbus-daemon gave no address within 5 s: ${err}`)), 5_000);
      child.stderr!.on("data", (d: Buffer) => { err += d.toString(); });
      child.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        const line = out.split("\n")[0]!;
        if (out.includes("\n")) {
          clearTimeout(timer);
          resolve(line.trim());
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`dbus-daemon exited ${code}: ${err}`));
      });
    });
    return { address, pid: child.pid!, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
