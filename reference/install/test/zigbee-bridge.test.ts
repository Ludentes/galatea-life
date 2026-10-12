import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

/**
 * The Zigbee bridge's service (plan 4a), from its image, with no coordinator to reach: what is
 * checked is the install (the image, its identity on the broker, its store, its data directory and
 * its stop), not the radio, which the bench guide checks.
 */
describe("the Zigbee bridge's service", () => {
  let s: Stack;
  let data: string;
  const pw = (n: string) => readFileSync(join(s.brokerSecrets, n), "utf8");
  const status = (secs: number) =>
    s.mqtt("mosquitto_sub", "applier", pw("applier"), ["-t", "galatea/bridges/bridge_zigbee/status", "-C", "1", "-W", String(secs)]);

  beforeAll(async () => {
    s = await Stack.create(["applier", "bridge_zigbee"], {
      COMPOSE_PROFILES: "zigbee",
      // Nothing listens there inside the bridge's container.
      GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:9",
    });
    data = join(s.dir, "zigbee");
    await s.must(s.compose("build", "zigbee-bridge"), "build the bridge's image");
    await s.must(s.compose("up", "-d", "--wait", "postgres", "broker"), "up postgres and broker");
    await s.must(s.compose("up", "-d", "zigbee-bridge"), "up zigbee-bridge");
  });
  afterAll(async () => s?.destroy());

  it("has a data directory galatea-prepare made: the owner's, closed to others", () => {
    expect(statSync(data).isDirectory()).toBe(true);
    expect(statSync(data).uid).toBe(process.getuid!());
    expect(statSync(data).mode & 0o777).toBe(0o700);
  });

  it("announces itself on the broker as bridge_zigbee, with its password from its file", async () => {
    const r = await status(90);
    expect(r.code).toBe(0);
    const st = JSON.parse(r.stdout.trim());
    expect(st.bridgeId).toBe("bridge_zigbee");
    expect(st.transports).toMatchObject([{ kind: "zigbee", state: "down" }]);
    // No network formed in its data directory yet: the owner's `form` is what it asks for.
    expect(st.faults).toContainEqual(expect.objectContaining({ code: "no_network" }));
  });

  it("keeps its state in its own schema, through its password from its file", async () => {
    const r = await s.sql("bridge_zigbee", readFileSync(join(s.secrets, "bridge_zigbee"), "utf8"),
      "SELECT count(*) FROM pg_tables WHERE schemaname = 'bridge_zigbee' AND tablename IN ('devices', 'blocked', 'settings', 'meta')");
    expect(r.stdout.trim()).toBe("4");
  });

  it("runs as the owner's account, with only its own passwords to read", async () => {
    const r = await s.must(s.compose("exec", "-T", "zigbee-bridge", "sh", "-c", "id -u; ls /run/db-secrets /run/broker-secrets"));
    const [uid, ...files] = r.stdout.trim().split(/\s+/);
    expect(uid).toBe(String(process.getuid!()));
    expect(files.filter((f) => !f.endsWith(":"))).toEqual(["bridge_zigbee", "bridge_zigbee"]);
  });

  it("reaches the broker over mqtts, trusting the installation's CA through NODE_EXTRA_CA_CERTS until it has a CA option", async () => {
    const r = await s.must(s.compose("exec", "-T", "zigbee-bridge", "sh", "-c", "echo $GALATEA_BROKER; echo $NODE_EXTRA_CA_CERTS; ls /run/tls"));
    expect(r.stdout.trim().split("\n")).toEqual(["mqtts://bridge_zigbee@broker:8883", "/run/tls/ca.pem", "ca.pem"]);
    expect(await s.logs("broker")).toMatch(/New client connected from .* as bridge_zigbee \(p5/);
  });

  it("follows a new CA: galatea-certs --new-ca restarts the broker before the bridge, which reconnects over mqtts with no refusal and no will left", async () => {
    const before = JSON.parse((await status(10)).stdout.trim()).instanceId as string;
    const r = await s.must(s.bin("galatea-certs", "--new-ca"));
    const order = r.stdout.split("\n").filter((l) => l.startsWith("galatea-certs: restarted ")).map((l) => l.slice("galatea-certs: restarted ".length));
    expect(order).toEqual(["broker", "zigbee-bridge"]);
    // A fresh status, from the bridge restarted on the new CA: online, with no grant refused.
    let st: { state?: string; instanceId?: string; faults?: { code: string }[] } = {};
    for (const end = Date.now() + 60_000; Date.now() < end;) {
      const got = await status(10);
      if (got.code === 0) st = JSON.parse(got.stdout.trim());
      if (st.instanceId !== before && st.state === "online") break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    expect(st.instanceId).not.toBe(before);
    expect(st.state).toBe("online");
    expect((st.faults ?? []).map((f) => f.code)).not.toContain("publish_refused");
    expect((st.faults ?? []).map((f) => f.code)).not.toContain("subscribe_refused");
    const will = await s.mqtt("mosquitto_sub", "applier", pw("applier"), ["-t", "galatea/bridges/bridge_zigbee/lwt", "-C", "1", "-W", "3"]);
    expect(will.stdout).toBe("");
  });

  it("stops within its grace, cleanly: its status says it went offline gracefully, and its will is cleared", async () => {
    const id = (await s.must(s.compose("ps", "-q", "zigbee-bridge"))).stdout.trim();
    expect(execFileSync("docker", ["inspect", "-f", "{{.Config.StopTimeout}}", id], { encoding: "utf8" }).trim()).toBe("45");
    const started = Date.now();
    await s.must(s.compose("stop", "zigbee-bridge"), "stop zigbee-bridge");
    expect(Date.now() - started).toBeLessThan(45_000);
    const state = JSON.parse(execFileSync("docker", ["inspect", "-f", "{{json .State}}", id], { encoding: "utf8" }));
    expect(state.ExitCode).toBe(0);
    expect(state.OOMKilled).toBe(false);
    const logs = await s.compose("logs", "--no-log-prefix", "zigbee-bridge");
    expect(logs.stdout + logs.stderr).not.toMatch(/stopping: |unhandled: /);
    // GA-BRIDGE-22's last steps: a graceful offline status, then the will cleared, before the clean disconnect.
    const r = await status(5);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ bridgeId: "bridge_zigbee", state: "offline", graceful: true });
    const will = await s.mqtt("mosquitto_sub", "applier", pw("applier"), ["-t", "galatea/bridges/bridge_zigbee/lwt", "-C", "1", "-W", "3"]);
    expect(will.stdout).toBe("");
  });
});

describe("the Zigbee bridge's service, its instance not listed", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await Stack.create(["applier"], { COMPOSE_PROFILES: "zigbee", GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:9" });
    await s.must(s.compose("build", "zigbee-bridge"), "build the bridge's image");
  });
  afterAll(async () => s?.destroy());

  it("refuses to start, and leaves no directory owned by root where its data and passwords would be", async () => {
    const r = await s.compose("up", "-d", "zigbee-bridge");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/bind source path does not exist|no such file or directory/i);
    expect(existsSync(join(s.dir, "zigbee"))).toBe(false);
    expect(existsSync(join(s.secrets, "bridge_zigbee"))).toBe(false);
    expect(existsSync(join(s.brokerSecrets, "bridge_zigbee"))).toBe(false);
  });
});
