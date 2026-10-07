import { lookup as dnsLookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/** What `isOwnAddress` reads of the machine; the unit tests hand it their own. */
export interface AddressSources {
  lookup(host: string): Promise<{ address: string }[]>;
  interfaces(): string[];
}

const SYSTEM: AddressSources = {
  lookup: (host) => dnsLookup(host, { all: true }),
  interfaces: () => Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address)),
};

/** 127.0.0.0/8, ::1, and either written as an IPv4-mapped IPv6 address. */
function loopback(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * Whether `host`, the broker's as the bridge reaches it, is this machine: a loopback name or
 * address, or one of its own interfaces' addresses, after resolving the name (GA-BRIDGE-65). A name
 * that does not resolve is not taken for this machine: the bridge then proposes nothing, and the
 * owner can still set `infrastructure` at the applier. Both backends use it.
 */
export async function isOwnAddress(host: string, sources: AddressSources = SYSTEM): Promise<boolean> {
  // A URL's hostname keeps an IPv6 address in brackets.
  const name = host.replace(/^\[(.*)\]$/, "$1");
  let addresses: string[];
  try {
    addresses = (await sources.lookup(name)).map((a) => a.address);
  } catch {
    return false;
  }
  const own = new Set(sources.interfaces().map((a) => a.toLowerCase()));
  return addresses.some((a) => loopback(a) || own.has(a.toLowerCase()));
}
