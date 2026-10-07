import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalMac, ConfigError, loadConfig, parseConfig } from "../src/config.js";

const entry = (id: string, mac: string) => ({ id, mac });
const minimal = { interface: "eth0", entries: [entry("desk-pc", "d4:a6:51:a1:b2:c3")] };

describe("canonicalMac", () => {
  it.each([
    ["d4:a6:51:a1:b2:c3"], ["D4-A6-51-A1-B2-C3"], ["d4a651a1b2c3"], ["d4a6.51a1.b2c3"],
  ])("reads %s as D4A651A1B2C3", (text) => {
    expect(canonicalMac(text)).toBe("D4A651A1B2C3");
  });

  it.each([["d4:a6:51:a1:b2"], ["d4:a6-51:a1:b2:c3"], ["g4:a6:51:a1:b2:c3"], [""]])("refuses %j", (text) => {
    expect(() => canonicalMac(text)).toThrow(ConfigError);
  });

  it("refuses the all-zero and broadcast addresses", () => {
    expect(() => canonicalMac("00:00:00:00:00:00")).toThrow(/not a computer's/);
    expect(() => canonicalMac("ff:ff:ff:ff:ff:ff")).toThrow(/not a computer's/);
  });
});

describe("parseConfig", () => {
  it("takes the minimal file, with MACs canonical", () => {
    expect(parseConfig(minimal)).toEqual({ interface: "eth0", entries: [{ id: "desk-pc", mac: "D4A651A1B2C3" }] });
  });

  it("takes a gateway, a broker and a root", () => {
    const c = parseConfig({ ...minimal, gateway: "192.168.1.1", root: "home",
      broker: { url: "mqtts://hub:8883", username: "wake-relay", passwordFile: "/etc/galatea/wake-relay.pw", caFile: "/etc/galatea/ca.pem" } });
    expect(c.gateway).toBe("192.168.1.1");
    expect(c.root).toBe("home");
    expect(c.broker).toEqual({ url: "mqtts://hub:8883", username: "wake-relay", passwordFile: "/etc/galatea/wake-relay.pw", caFile: "/etc/galatea/ca.pem" });
  });

  it.each([
    ["no interface", { entries: minimal.entries }, /interface/],
    ["an interface with a slash", { ...minimal, interface: "eth0/1" }, /interface/],
    ["an interface arping would read as an option", { ...minimal, interface: "-h" }, /interface/],
    ["no entries", { interface: "eth0", entries: [] }, /at least one/],
    ["an id with a wildcard", { interface: "eth0", entries: [entry("desk+", "d4a651a1b2c3")] }, /entries\[0\]\.id/],
    ["an id with a slash", { interface: "eth0", entries: [entry("a/b", "d4a651a1b2c3")] }, /entries\[0\]\.id/],
    ["an id twice", { interface: "eth0", entries: [entry("a", "d4a651a1b2c3"), entry("a", "d4a651a1b2c4")] }, /listed twice/],
    ["a MAC twice in two forms", { interface: "eth0", entries: [entry("a", "d4a651a1b2c3"), entry("b", "D4-A6-51-A1-B2-C3")] }, /listed twice/],
    ["a bad gateway", { ...minimal, gateway: "192.168.1.256" }, /gateway/],
    ["a broker with no username", { ...minimal, broker: { url: "mqtt://hub" } }, /broker/],
    ["an empty root", { ...minimal, root: "" }, /root/],
    ["an array", [], /not an object/],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseConfig(value)).toThrow(message);
  });
});

describe("loadConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "wake-relay-"));
    dirs.push(dir);
    const path = join(dir, "relay.json");
    writeFileSync(path, text);
    return path;
  };

  it("reads a file", () => {
    expect(loadConfig(file(JSON.stringify(minimal))).entries).toHaveLength(1);
  });

  it("names a missing file and bad JSON as configuration errors", () => {
    expect(() => loadConfig("/nonexistent/relay.json")).toThrow(/cannot read/);
    expect(() => loadConfig(file("{"))).toThrow(/is not JSON/);
  });
});
