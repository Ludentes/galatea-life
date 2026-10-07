import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

/** The installation's broker (plan 4a): one identity per line of `instances`, each with its own password. */
describe("the broker", () => {
  let s: Stack;
  const pw = (n: string) => readFileSync(join(s.brokerSecrets, n), "utf8");
  // A subscriber that waits for one message, at most `secs` seconds; `mosquitto_sub -W` exits 27 at its timeout.
  const receive = (user: string, topic: string, secs = 3) => s.mqtt("mosquitto_sub", user, pw(user), ["-t", topic, "-C", "1", "-W", String(secs), "-v"]);
  const publish = (user: string, topic: string, payload: string, retain = false) =>
    s.mqtt("mosquitto_pub", user, pw(user), ["-t", topic, "-m", payload, "-q", "1", ...(retain ? ["-r"] : [])]);

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward", "bridge_zigbee", "bridge_other"]);
    await s.must(s.compose("up", "-d", "--wait", "broker"), "up broker");
  });
  afterAll(async () => s?.destroy());

  it("galatea-db-prepare writes a broker password for each instance, readable by the owner only, kept once written", async () => {
    expect(statSync(s.brokerSecrets).mode & 0o777).toBe(0o700);
    for (const n of ["applier", "steward", "bridge_zigbee", "bridge_other"]) {
      expect(statSync(join(s.brokerSecrets, n)).mode & 0o777).toBe(0o600);
      expect(pw(n)).toMatch(/^[A-Za-z0-9]{32}$/);
      // Not the store's password: one leaked secret opens one door.
      expect(pw(n)).not.toBe(readFileSync(join(s.secrets, n), "utf8"));
    }
    const before = pw("applier");
    const r = await s.must(s.bin("galatea-db-prepare"));
    expect(pw("applier")).toBe(before);
    expect(r.stdout).not.toContain("broker/applier");
  });

  it("refuses a client without a password, with a wrong one, or with no identity", async () => {
    let r = await s.mqtt("mosquitto_pub", undefined, undefined, ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    r = await s.mqtt("mosquitto_pub", "applier", undefined, ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    r = await s.mqtt("mosquitto_pub", "applier", "wrong-password", ["-t", "galatea/x", "-m", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not authori[sz]ed|bad user name or password/i);
  });

  it("lets a bridge read and write its own topics, and the applier read them", async () => {
    const heard = receive("applier", "galatea/bridges/bridge_zigbee/status", 10);
    await new Promise((r) => setTimeout(r, 1500));
    await s.must(publish("bridge_zigbee", "galatea/bridges/bridge_zigbee/status", "up"));
    const r = await heard;
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("galatea/bridges/bridge_zigbee/status up");
  });

  it("keeps a bridge out of another bridge's topics, and out of everything outside its own", async () => {
    // Mosquitto drops a publish the rules refuse without a word to an MQTT 5 client at QoS 1 only as a
    // reason code; what counts is that the applier never hears it.
    for (const topic of ["galatea/bridges/bridge_other/command/x", "galatea/finder/candidates", "galatea/applier/x"]) {
      const heard = receive("applier", topic, 4);
      await new Promise((r) => setTimeout(r, 1500));
      await publish("bridge_zigbee", topic, "forged");
      const r = await heard;
      expect(r.code, topic).toBe(27);
      expect(r.stdout, topic).toBe("");
    }
    // Nor does it hear what is published to another bridge.
    const peek = receive("bridge_zigbee", "galatea/bridges/bridge_other/command/#", 4);
    await new Promise((r) => setTimeout(r, 1500));
    await s.must(publish("applier", "galatea/bridges/bridge_other/command/x", "for other"));
    expect((await peek).stdout).toBe("");
  });

  it("keeps retained messages across its own restart", async () => {
    await s.must(publish("bridge_zigbee", "galatea/bridges/bridge_zigbee/devices", "kept", true));
    await s.must(s.compose("restart", "broker"), "restart broker");
    await s.must(s.compose("up", "-d", "--wait", "broker"), "wait broker");
    const r = await receive("applier", "galatea/bridges/bridge_zigbee/devices", 10);
    expect(r.stdout.trim()).toBe("galatea/bridges/bridge_zigbee/devices kept");
  });

  it("refuses to start when an instance has no broker password", async () => {
    writeFileSync(join(s.brokerSecrets, "bridge_other"), "");
    await s.compose("restart", "broker");
    await new Promise((r) => setTimeout(r, 3000));
    const logs = await s.compose("logs", "--no-log-prefix", "broker");
    expect(logs.stdout + logs.stderr).toContain("broker-init: no password in secrets/broker/bridge_other");
  });
});
