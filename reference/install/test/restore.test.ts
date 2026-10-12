import { chmodSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

describe("galatea-restore", () => {
  let s: Stack;
  let dump: string;
  const pw = (role: string) => readFileSync(join(s.secrets, role), "utf8");

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward", "voice_den", "voice_attic"]);
    await s.up();
    await s.must(s.sql("voice_den", pw("voice_den"), "CREATE TABLE t (x int); INSERT INTO t VALUES (1), (2)"));
    await s.must(s.sql("voice_den", pw("voice_den"), "CREATE VIEW history_v AS SELECT x FROM t; GRANT USAGE ON SCHEMA voice_den TO reader; GRANT SELECT ON history_v TO reader"));
    await s.must(s.compose("run", "--rm", "--no-deps", "backup", "once"));
    dump = join(s.backups, readdirSync(s.backups).find((f) => f.endsWith(".dump"))!);
  });
  afterAll(async () => s?.destroy());

  it("brings back the data, owners and grants of the dump", async () => {
    await s.admin("DELETE FROM voice_den.t; DROP SCHEMA voice_attic CASCADE");
    const r = await s.bin("galatea-restore", dump);
    expect(r.code, r.stderr).toBe(0);
    expect((await s.sql("voice_den", pw("voice_den"), "SELECT count(*) FROM t")).stdout.trim()).toBe("2");
    expect((await s.sql("voice_attic", pw("voice_attic"), "SELECT current_schema()")).stdout.trim()).toBe("voice_attic");
    expect((await s.sql("reader", pw("reader"), "SELECT count(*) FROM voice_den.history_v")).stdout.trim()).toBe("2");
    expect((await s.sql("voice_attic", pw("voice_attic"), "SELECT * FROM voice_den.t")).code).not.toBe(0);
  });

  it("gives an instance added since the dump its schema", async () => {
    s.setInstances(["applier", "steward", "voice_den", "voice_attic", "voice_hall"]);
    await s.must(s.bin("galatea-prepare"));
    await s.must(s.bin("galatea-restore", dump));
    expect((await s.sql("voice_hall", pw("voice_hall"), "SELECT current_schema()")).stdout.trim()).toBe("voice_hall");
  });

  it("stops the other services while it restores, and starts them again", async () => {
    await s.must(s.compose("up", "-d", "backup"));
    const r = await s.must(s.bin("galatea-restore", dump));
    expect(r.stderr).toMatch(/backup.*Stopp/s);
    const running = await s.must(s.compose("ps", "--services", "--status", "running"));
    expect(running.stdout).toContain("backup");
  });

  it("restores onto a new server, whose roles do not exist yet", async () => {
    await s.must(s.compose("down", "-v"));
    const r = await s.bin("galatea-restore", dump);
    expect(r.code, r.stderr).toBe(0);
    expect((await s.sql("voice_den", pw("voice_den"), "SELECT count(*) FROM t")).stdout.trim()).toBe("2");
  });

  it("refuses a file that is not there, and changes nothing", async () => {
    const r = await s.bin("galatea-restore", join(s.dir, "missing.dump"));
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no such file");
    expect((await s.sql("voice_den", pw("voice_den"), "SELECT count(*) FROM t")).stdout.trim()).toBe("2");
  });
  const count = async () => (await s.sql("voice_den", pw("voice_den"), "SELECT count(*) FROM t")).stdout.trim();

  it("refuses a file that is not a readable archive, and changes nothing", async () => {
    const bad = join(s.dir, "corrupt.dump");
    writeFileSync(bad, "this is not a dump\n");
    const r = await s.bin("galatea-restore", bad);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not a readable/);
    expect(await count()).toBe("2");
  });

  it("refuses a dump whose check failed, names the check file, and restores it with --force", async () => {
    const d = join(s.dir, "failed.dump");
    copyFileSync(dump, d);
    writeFileSync(`${d}.check`, "failed: voice_den.migrations is empty\n");
    await s.admin("DELETE FROM voice_den.t");
    const r = await s.bin("galatea-restore", d);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("failed.dump.check");
    expect(await count()).toBe("0");
    const f = await s.bin("galatea-restore", "--force", d);
    expect(f.code, f.stderr).toBe(0);
    expect(await count()).toBe("2");
  });

  it("refuses a dump with a schema that instances lacks, and names it", async () => {
    s.setInstances(["applier", "steward", "voice_den"]);
    try {
      const r = await s.bin("galatea-restore", dump);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("voice_attic");
      expect(r.stderr).not.toMatch(/\bapplier\b.*add/);
      expect(await count()).toBe("2");
    } finally {
      s.setInstances(["applier", "steward", "voice_den", "voice_attic", "voice_hall"]);
    }
  });

  it("leaves the old data and the services running when the restore fails midway", async () => {
    // A table owned by a role that is gone: the dump reads fine and fails on restore.
    await s.admin("CREATE ROLE ghost; CREATE TABLE public.g (x int); ALTER TABLE public.g OWNER TO ghost");
    await s.must(s.compose("exec", "-T", "postgres", "sh", "-c",
      'PGPASSWORD="$(cat /run/db-secrets/postgres)" pg_dump -U postgres -Fc -d galatea -f /tmp/ghost.dump'));
    const ghost = join(s.dir, "ghost.dump");
    await s.must(s.compose("cp", "postgres:/tmp/ghost.dump", ghost));
    await s.admin("DROP TABLE public.g; DROP ROLE ghost");
    await s.must(s.compose("up", "-d", "backup"));
    const r = await s.bin("galatea-restore", ghost);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("was not changed");
    expect(await count()).toBe("2");
    const running = await s.must(s.compose("ps", "--services", "--status", "running"));
    expect(running.stdout).toContain("backup");
    const dbs = await s.admin("SELECT datname FROM pg_database WHERE datname LIKE 'galatea%' ORDER BY 1", "postgres");
    expect(dbs.stdout.trim()).toBe("galatea");
  });

  it("says why a service failed to start after the restore, in the service's own words", async () => {
    // db-init reads the password as root; the steward's migrate, as the owner's account, refuses a
    // file other accounts can read. The restore itself works; the start after it does not.
    const file = join(s.secrets, "steward");
    chmodSync(file, 0o640);
    try {
      const r = await s.bin("galatea-restore", dump);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/galatea-restore: steward-migrate exited \d+; the end of its log:/);
      expect(r.stderr).toContain("can be reached by other accounts");
    } finally {
      chmodSync(file, 0o600);
    }
    await s.must(s.compose("up", "-d"), "up after the mode is mended");
  });
});
