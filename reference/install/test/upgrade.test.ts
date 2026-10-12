import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

// 17 to 18 is the upgrade the images on hand allow; the script takes any major.
describe("galatea-db-upgrade", () => {
  let s: Stack;
  let anonymous: string[] = [];
  const pw = (role: string) => readFileSync(join(s.secrets, role), "utf8");

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward"], { PG_MAJOR: "17" });
    await s.up();
    await s.must(s.sql("applier", pw("applier"), "CREATE TABLE t (x int); INSERT INTO t VALUES (7)"));
    // The 17 image declares /var/lib/postgresql/data a volume of its own, so its
    // data lands in an anonymous volume that the upgrade's `down` leaves behind.
    const id = (await s.must(s.compose("ps", "-q", "postgres"))).stdout.trim();
    const mounts = await s.must(run("docker", ["inspect", "--format", "{{json .Mounts}}", id], process.env));
    anonymous = (JSON.parse(mounts.stdout) as { Name: string; Destination: string }[])
      .filter((m) => m.Destination === "/var/lib/postgresql/data")
      .map((m) => m.Name);
  });
  afterAll(async () => {
    await s?.destroy();
    if (anonymous.length) await run("docker", ["volume", "rm", ...anonymous], process.env);
  });

  it("starts on 17", async () => {
    expect((await s.admin("SHOW server_version")).stdout).toMatch(/^17\./);
  });

  it("moves to 18 by dump and restore, keeping the data and the roles", async () => {
    const r = await s.bin("galatea-db-upgrade", "18");
    expect(r.code, r.stderr).toBe(0);
    expect((await s.admin("SHOW server_version")).stdout).toMatch(/^18\./);
    expect((await s.sql("applier", pw("applier"), "SELECT x FROM t")).stdout.trim()).toBe("7");
    expect(readFileSync(s.envFile, "utf8")).toMatch(/^PG_MAJOR=18$/m);
    expect(readdirSync(s.backups).some((f) => /^pre-upgrade-17-to-18-.*\.dump$/.test(f))).toBe(true);
  });

  it("writes the pre-upgrade dump readable by the owner only", () => {
    const f = readdirSync(s.backups).find((n) => /^pre-upgrade-.*\.dump$/.test(n))!;
    expect(statSync(join(s.backups, f)).mode & 0o777).toBe(0o600);
  });

  it("keeps the old major's volume for a rollback", async () => {
    const r = await s.must(run("docker", ["volume", "ls", "-q", "--filter", `name=${s.project}-pgdata-17`], process.env));
    expect(r.stdout.trim()).toBe(`${s.project}-pgdata-17`);
  });

  it("refuses the major it is already on, and a version that is not a number", async () => {
    const same = await s.bin("galatea-db-upgrade", "18");
    expect(same.code).not.toBe(0);
    expect(same.stderr).toContain("already on 18");
    const bad = await s.bin("galatea-db-upgrade", "18.1");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("not a major version");
  });

  it("refuses to run when PG_MAJOR is exported, since it would override the settings file", async () => {
    const r = await run(join(PKG, "bin", "galatea-db-upgrade"), ["19"], { ...s.env, PG_MAJOR: "18" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("PG_MAJOR is exported");
  });
});
