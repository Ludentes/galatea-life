import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, Stack } from "./stack.js";

describe("db-init", () => {
  let s: Stack;
  const pw = (role: string) => readFileSync(join(s.secrets, role), "utf8");
  beforeAll(async () => {
    s = await Stack.create(["applier", "voice_kitchen"]);
    await s.up();
  });
  afterAll(async () => s?.destroy());

  it("gives each instance a role that logs in with its password", async () => {
    expect((await s.sql("applier", pw("applier"), "SELECT current_user")).stdout.trim()).toBe("applier");
    expect((await s.sql("applier", "wrong", "SELECT 1")).code).not.toBe(0);
  });

  it("gives each role a schema of its name, found without naming it", async () => {
    await s.must(s.sql("applier", pw("applier"), "CREATE TABLE t (x int); INSERT INTO t VALUES (1)"));
    expect((await s.admin("SELECT count(*) FROM applier.t")).stdout.trim()).toBe("1");
    expect((await s.admin("SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'voice_kitchen'")).stdout.trim())
      .toBe("voice_kitchen");
  });

  it("keeps each role out of every other schema", async () => {
    await s.must(s.sql("voice_kitchen", pw("voice_kitchen"), "CREATE TABLE secret (x int)"));
    const r = await s.sql("applier", pw("applier"), "SELECT * FROM voice_kitchen.secret");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("permission denied");
  });

  it("lets no role create a schema or use public", async () => {
    const r = await s.sql("applier", pw("applier"), "CREATE SCHEMA other");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("permission denied");
    expect((await s.sql("applier", pw("applier"), "CREATE TABLE public.t (x int)")).code).not.toBe(0);
  });

  it("creates reader, which logs in when it has a password", async () => {
    expect((await s.sql("reader", pw("reader"), "SELECT current_user")).stdout.trim()).toBe("reader");
  });

  it("runs again without change, and adds an instance listed later", async () => {
    s.setInstances(["applier", "voice_kitchen", "bridge_zigbee"]);
    await s.must(s.bin("galatea-prepare"));
    const again = await s.must(s.compose("run", "--rm", "db-init"));
    expect(again.stderr).not.toContain("NOTICE");
    expect((await s.admin("SELECT count(*) FROM applier.t")).stdout.trim()).toBe("1");
    expect((await s.sql("bridge_zigbee", pw("bridge_zigbee"), "SELECT current_schema()")).stdout.trim())
      .toBe("bridge_zigbee");
  });

  it("gives a watcher no role and no schema: it is the broker's alone", async () => {
    s.setInstances(["applier", "watch", "watch-2"]);
    await s.must(s.bin("galatea-prepare"));
    await s.must(s.compose("run", "--rm", "db-init"));
    expect((await s.admin("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'watch%'")).stdout.trim()).toBe("0");
    expect((await s.admin("SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'watch%'")).stdout.trim()).toBe("0");
  });

  it("never drops an instance that is no longer listed", async () => {
    s.setInstances(["applier"]);
    await s.must(s.compose("run", "--rm", "db-init"));
    expect((await s.admin("SELECT count(*) FROM voice_kitchen.secret")).stdout.trim()).toBe("0");
  });

  it("refuses a bad or reserved name, or a missing password, before changing anything", async () => {
    for (const [names, message] of [
      [["applier", "Bad-Name"], "bad instance name"],
      [["applier", "reader"], "reserved"],
      [["applier", "pg_x"], "reserved"],
      [["applier", "nobody"], "no password"],
    ] as const) {
      s.setInstances([...names]);
      const r = await s.compose("run", "--rm", "db-init");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(message);
    }
    expect((await s.admin("SELECT count(*) FROM pg_roles WHERE rolname = 'nobody'")).stdout.trim()).toBe("0");
  });

  it("keeps passwords off every command line", () => {
    const script = readFileSync(join(PKG, "db", "db-init.sh"), "utf8");
    expect(script).not.toMatch(/-v\s+pw=/);
    expect(script).toContain("\\\\set pw");
  });

  it("changes a role's password when its secret changes", async () => {
    s.setInstances(["applier"]);
    writeFileSync(join(s.secrets, "applier"), "a-new-password-for-applier");
    await s.must(s.compose("run", "--rm", "db-init"));
    expect((await s.sql("applier", "a-new-password-for-applier", "SELECT 1")).stdout.trim()).toBe("1");
  });
});
