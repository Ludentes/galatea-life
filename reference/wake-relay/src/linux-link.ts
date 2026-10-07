import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import type { Entry } from "./config.js";
import type { Link } from "./link.js";
import { WAKE_PORT } from "./packet.js";

/** The IPv4 default gateway of `iface` in /proc/net/route's text, or undefined. */
export function gatewayFromRoutes(routes: string, iface: string): string | undefined {
  for (const line of routes.split("\n").slice(1)) {
    const [name, destination, gateway] = line.trim().split(/\s+/);
    if (name !== iface || destination !== "00000000" || !gateway || gateway === "00000000") continue;
    // The kernel writes the address in host byte order, little-endian on the machines the box runs.
    const bytes = Buffer.from(gateway, "hex");
    return [bytes[3], bytes[2], bytes[1], bytes[0]].join(".");
  }
  return undefined;
}

/** Runs a program with no shell, as `execFile` does; injected in the unit tests. */
export type Runner = (file: string, args: string[], opts: { timeout: number }, done: (err: Error | null) => void) => void;

/** The error codes of an `arping` that could not start, each said once per process. */
const cannotStart = new Set<string>();

/** The directed broadcast address of an IPv4 address and its netmask. */
export function broadcastAddress(address: string, netmask: string): string {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((part, i) => (part | (~m[i]! & 0xff)) & 0xff).join(".");
}

/** The interface's IPv4 address and netmask, or undefined when it has none. */
function ipv4Of(iface: string): { address: string; netmask: string } | undefined {
  const found = networkInterfaces()[iface]?.find((a) => a.family === "IPv4" && !a.internal);
  return found ? { address: found.address, netmask: found.netmask } : undefined;
}

/**
 * The real interface: its carrier from sysfs, the gateway's answer from `arping` (which needs
 * CAP_NET_RAW, not root), and the magic packet as a UDP broadcast sent from the interface's own
 * address. No argument of a command reaches a process: `arping` gets only configured values, and
 * never through a shell (GA-BRIDGE-54).
 */
export class LinuxLink implements Link {
  constructor(private readonly iface: string, private readonly configuredGateway?: string,
    private readonly run: Runner = (file, args, opts, done) => { execFile(file, args, opts, done); }) {}

  async carrier(): Promise<boolean> {
    try {
      return (await readFile(`/sys/class/net/${this.iface}/carrier`, "utf8")).trim() === "1";
    } catch {
      // An interface that is administratively down reads as an error, not as 0.
      return false;
    }
  }

  async arp(): Promise<boolean> {
    const gateway = this.configuredGateway ?? gatewayFromRoutes(await readFile("/proc/net/route", "utf8").catch(() => ""), this.iface);
    if (!gateway) return false;
    return new Promise((resolve) => {
      this.run("arping", ["-c", "1", "-w", "2", "-I", this.iface, gateway], { timeout: 5000 }, (err) => {
        // An arping that could not start (missing, or without CAP_NET_RAW) is no answer, said once.
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === "string" && !cannotStart.has(code)) {
          cannotStart.add(code);
          console.error(`arping cannot run (${code}): the gateway reads as silent, so the transport stays down`);
        }
        resolve(!err);
      });
    });
  }

  async send(_entry: Entry, packet: Buffer): Promise<void> {
    const ip = ipv4Of(this.iface);
    if (!ip) throw new Error(`${this.iface} has no IPv4 address`);
    const socket = createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind({ address: ip.address, port: 0 }, () => {
          socket.setBroadcast(true);
          socket.send(packet, WAKE_PORT, broadcastAddress(ip.address, ip.netmask), (err) => (err ? reject(err) : resolve()));
        });
      });
    } finally {
      socket.close();
    }
  }

  async close(): Promise<void> {}
}
