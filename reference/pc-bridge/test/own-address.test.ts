import { describe, expect, it } from "vitest";
import { isOwnAddress, type AddressSources } from "../src/own-address.js";

/** A machine with a LAN address, a resolver for a few names, and nothing else. */
const machine: AddressSources = {
  lookup: async (host) => {
    const names: Record<string, string[]> = {
      localhost: ["127.0.0.1", "::1"],
      "desk-pc.lan": ["192.168.1.20"],
      "nas.lan": ["192.168.1.30"],
    };
    const known = names[host] ?? (/^[\d.]+$|:/.test(host) ? [host] : undefined);
    if (!known) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return known.map((address) => ({ address }));
  },
  interfaces: () => ["127.0.0.1", "::1", "192.168.1.20", "fe80::1"],
};

describe("isOwnAddress", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["127.0.1.1", true],
    ["[::1]", true],
    ["::ffff:127.0.0.1", true],
    ["192.168.1.20", true],
    ["desk-pc.lan", true],
    ["FE80::1", true],
    ["192.168.1.30", false],
    ["nas.lan", false],
    ["nowhere.lan", false],
  ])("%s is the machine's own: %s", async (host, own) => {
    expect(await isOwnAddress(host, machine)).toBe(own);
  });

  it("reads this machine by default: loopback is its own", async () => {
    expect(await isOwnAddress("127.0.0.1")).toBe(true);
  });
});
