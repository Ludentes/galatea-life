import { chmodSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

describe("the backup service", () => {
  let s: Stack;
  const dumps = () => readdirSync(s.backups).filter((f) => /^galatea-.*\.dump$/.test(f)).sort();
  const status = () => readFileSync(join(s.backups, "status"), "utf8").trim().split(" ");
  const once = () => s.compose("run", "--rm", "--no-deps", "backup", "once");
  const health = () => s.compose("run", "--rm", "--no-deps", "backup", "health");

  beforeAll(async () => {
    s = await Stack.create(["applier"], { GALATEA_BACKUP_KEEP: "3" });
    await s.up();
    await s.admin("CREATE TABLE applier.migrations (id int); INSERT INTO applier.migrations VALUES (1)");
    await s.admin("ALTER TABLE applier.migrations OWNER TO applier");
  });
  afterAll(async () => s?.destroy());

  it("is unhealthy before any backup", async () => {
    expect((await health()).code).not.toBe(0);
  });

  it("says so, and writes nothing, when it cannot write the backups directory", async () => {
    chmodSync(s.backups, 0o555);
    try {
      const r = await once();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("cannot write /backups");
    } finally {
      chmodSync(s.backups, 0o755);
    }
    expect(readdirSync(s.backups)).toEqual([]);
  });

  it("dumps galatea, checks the dump by restoring it, and reports ok", async () => {
    const r = await once();
    expect(r.code, r.stderr).toBe(0);
    expect(dumps()).toHaveLength(1);
    const [state, , file] = status();
    expect(state).toBe("ok");
    expect(file).toBe(dumps()[0]);
    expect(readFileSync(join(s.backups, `${file}.check`), "utf8").trim()).toBe("ok");
    expect((await health()).code).toBe(0);
  });

  it("writes the dump as the owner's user, not root, readable by the owner only", () => {
    const st = statSync(join(s.backups, dumps()[0]!));
    expect(st.uid).toBe(process.getuid!());
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("leaves no throwaway database behind", async () => {
    expect((await s.admin("SELECT count(*) FROM pg_database WHERE datname LIKE 'galatea_check_%'")).stdout.trim())
      .toBe("0");
  });

  it("keeps the newest GALATEA_BACKUP_KEEP dumps", async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1100)); // dump names have one-second resolution
      await s.must(once());
    }
    expect(dumps()).toHaveLength(3);
    expect(readdirSync(s.backups).filter((f) => f.endsWith(".check"))).toHaveLength(3);
  });

  it("fails the check, and the healthcheck, when a schema's migrations table is empty", async () => {
    await s.admin("DELETE FROM applier.migrations");
    const r = await once();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("applier.migrations is empty");
    expect(status()[0]).toBe("failed");
    expect((await health()).code).not.toBe(0);
    await s.admin("INSERT INTO applier.migrations VALUES (1)");
  });

  it("never prunes the newest good dump, however many checks fail after it", async () => {
    await s.must(once());
    const good = status()[2]!;
    await s.admin("DELETE FROM applier.migrations");
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1100));
      expect((await once()).code).not.toBe(0);
    }
    expect(dumps()).toContain(good);
    expect(dumps()).toHaveLength(4); // the newest 3, plus the good one kept back
    await s.admin("INSERT INTO applier.migrations VALUES (1)");
  });

  it("is unhealthy when the last good backup is older than 25 h", async () => {
    await s.must(once());
    const [, , file] = status();
    writeFileSync(join(s.backups, "status"), `ok ${Math.floor(Date.now() / 1000) - 90_001} ${file}\n`);
    expect((await health()).code).not.toBe(0);
    await s.must(once());
  });

  it("takes a dump at start when none is younger than 25 h, then waits for GALATEA_BACKUP_AT", async () => {
    for (const f of dumps()) {
      const old = new Date(Date.now() - 26 * 3600 * 1000);
      utimesSync(join(s.backups, f), old, old);
    }
    const before = dumps();
    await s.must(s.compose("up", "-d", "backup"));
    const deadline = Date.now() + 60_000;
    while (dumps().join() === before.join() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    expect(dumps()).not.toEqual(before);
    const logs = await s.must(s.compose("logs", "backup"));
    expect(logs.stdout).toContain(": ok");
    await s.must(s.compose("stop", "backup"));
  });
  it("refuses a keep count that is not a positive integer, and a time that is not HH:MM", async () => {
    for (const keep of ["abc", "0", "-1"]) {
      const r = await s.compose("run", "--rm", "--no-deps", "-e", `GALATEA_BACKUP_KEEP=${keep}`, "backup", "once");
      expect(r.code, keep).not.toBe(0);
      expect(r.stderr).toContain("GALATEA_BACKUP_KEEP");
    }
    for (const at of ["25:99", "3pm"]) {
      const r = await s.compose("run", "--rm", "--no-deps", "-e", `GALATEA_BACKUP_AT=${at}`, "backup", "loop");
      expect(r.code, at).not.toBe(0);
      expect(r.stderr).toContain("GALATEA_BACKUP_AT");
    }
  });

  it("runs under an init process, so a stop is a clean SIGTERM", async () => {
    const cfg = JSON.parse((await s.must(s.compose("config", "--format", "json"))).stdout);
    expect(cfg.services.backup.init).toBe(true);
  });
});
