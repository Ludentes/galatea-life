import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

/**
 * The owner's `form` and `backup` (plan 4a): never while the bridge's service runs, and then in a
 * one-off container of its image, on its data directory. With no coordinator to reach, `form` is
 * checked as far as its refusal; the bench guide forms for real.
 */
describe("galatea-zigbee", () => {
  let s: Stack;
  let data: string;
  let kept: string;
  // A made-up network, never a real one's key.
  const NETWORK = { panID: 4660, extendedPanID: [1, 2, 3, 4, 5, 6, 7, 8], channel: 15,
    networkKey: [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], coordinator: "0x00124b0000000001" };

  beforeAll(async () => {
    s = await Stack.create(["applier", "bridge_zigbee"], { COMPOSE_PROFILES: "zigbee", GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:9" });
    data = join(s.dir, "zigbee");
    kept = join(s.archive, "zigbee");
    await s.must(s.compose("build", "zigbee-bridge"), "build the bridge's image");
    await s.must(s.compose("up", "-d", "--wait", "postgres", "broker"), "up postgres and broker");
    await s.must(s.compose("up", "-d", "zigbee-bridge"), "up zigbee-bridge");
  });
  afterAll(async () => s?.destroy());

  it("refuses form and backup while the bridge's service runs, doing nothing", async () => {
    for (const args of [["form", "--channel", "15"], ["backup"]]) {
      const r = await s.bin("galatea-zigbee", ...args);
      expect(r.code, args[0]).toBe(1);
      expect(r.stderr).toContain("the bridge's service is running: stop it first (docker compose stop zigbee-bridge)");
    }
    expect(existsSync(kept) ? readdirSync(kept) : []).toEqual([]);
  });

  it("sees the running service even when the settings no longer enable its profile", async () => {
    const env = readFileSync(s.envFile, "utf8");
    writeFileSync(s.envFile, env.replace("COMPOSE_PROFILES=zigbee\n", ""));
    try {
      const r = await s.bin("galatea-zigbee", "backup");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("the bridge's service is running");
    } finally {
      writeFileSync(s.envFile, env);
    }
  });

  it("refuses an unknown command, or form without its channel, with its usage", async () => {
    await s.must(s.compose("stop", "zigbee-bridge"));
    for (const args of [[], ["reset"], ["form"]]) {
      const r = await s.bin("galatea-zigbee", ...args);
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.stderr, args.join(" ")).toMatch(/usage|zigbee-bridge form --channel N/);
    }
  });

  it("runs backup in the bridge's image with the service stopped: the bridge's own refusal, with nothing formed", async () => {
    const r = await s.bin("galatea-zigbee", "backup");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("network.json");
  });

  it("runs form in the bridge's image with the service stopped: it reads the coordinator first, and refuses when it cannot", async () => {
    const r = await s.bin("galatea-zigbee", "form", "--channel", "15");
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/refusing to form: .*coordinator/);
    expect(readdirSync(data).filter((f) => f !== "instance.key")).toEqual([]);
  });

  it("writes backup into the secrets archive's directory, the owner's alone, never into backups/ and never quoting the key", async () => {
    writeFileSync(join(data, "network.json"), JSON.stringify(NETWORK), { mode: 0o600 });
    const r = await s.must(s.bin("galatea-zigbee", "backup"));
    const files = readdirSync(kept);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^zigbee-\d{8}T\d{6}Z\.json$/);
    expect(statSync(kept).mode & 0o777).toBe(0o700);
    expect(statSync(s.archive).mode & 0o777).toBe(0o700);
    const file = join(kept, files[0]!);
    expect(statSync(file).uid).toBe(process.getuid!());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(JSON.parse(readFileSync(file, "utf8")).files["network.json"])).toEqual(NETWORK);
    expect(r.stdout).toContain(`backed up network.json to /backups/zigbee/${files[0]}`);
    expect(r.stdout + r.stderr).not.toContain("16,15,14");
    expect(existsSync(join(s.backups, "zigbee"))).toBe(false);
  });

  it("goes into the secrets archive, newest only, and restores from it into an empty data directory", async () => {
    await new Promise((res) => setTimeout(res, 1100));
    await s.must(s.bin("galatea-zigbee", "backup"));
    const newest = readdirSync(kept).sort().at(-1)!;
    const r = await s.must(s.bin("galatea-backup-secrets"));
    const archive = join(s.archive, /(install-\S+\.tar): ok/.exec(r.stdout)![1]!);
    const names = (await s.must(run("tar", ["-tf", archive], process.env))).stdout.split("\n");
    expect(names.filter((n) => n.startsWith("zigbee/"))).toEqual([`zigbee/${newest}`]);
    // A new box: the archive unpacked elsewhere, the data directory empty, then galatea-zigbee restore.
    const unpacked = join(s.dir, "unpacked");
    mkdirSync(unpacked);
    await s.must(run("tar", ["-xf", archive, "-C", unpacked, `zigbee/${newest}`], process.env));
    for (const f of readdirSync(data)) if (f !== "instance.key") rmSync(join(data, f));
    const restored = await s.must(s.bin("galatea-zigbee", "restore", join(unpacked, "zigbee", newest)));
    expect(restored.stdout).toContain("galatea-zigbee: restored network.json");
    expect(JSON.parse(readFileSync(join(data, "network.json"), "utf8"))).toEqual(NETWORK);
    expect(statSync(join(data, "network.json")).mode & 0o777).toBe(0o600);
    // Never over a network that is there.
    const again = await s.bin("galatea-zigbee", "restore", join(unpacked, "zigbee", newest));
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already holds a network");
  });

  it("encrypts the backup with age when GALATEA_SECRETS_RECIPIENT is set, keeping no readable copy", async () => {
    const bin = await s.ageBin();
    const keys = (await s.must(run(join(bin, "age-keygen"), [], process.env))).stdout;
    const pub = /^# public key: (age1\S+)$/m.exec(keys)![1]!;
    const env = readFileSync(s.envFile, "utf8");
    writeFileSync(s.envFile, `${env}GALATEA_SECRETS_RECIPIENT=${pub}\n`);
    try {
      const before = new Set(readdirSync(kept));
      await new Promise((res) => setTimeout(res, 1100));
      const r = await s.must(run(join(PKG, "bin", "galatea-zigbee"), ["backup"], { ...s.env, PATH: `${bin}:${process.env.PATH}` }));
      const added = readdirSync(kept).filter((f) => !before.has(f));
      expect(added).toHaveLength(1);
      expect(added[0]).toMatch(/^zigbee-\d{8}T\d{6}Z\.json\.age$/);
      expect(readFileSync(join(kept, added[0]!)).subarray(0, 21).toString()).toBe("age-encryption.org/v1");
      expect(r.stdout).toContain("this box keeps no readable copy");
      const refused = await s.bin("galatea-zigbee", "restore", join(kept, added[0]!));
      expect(refused.stderr).toContain("is encrypted: decrypt it first");
    } finally {
      writeFileSync(s.envFile, env);
    }
  });
});
