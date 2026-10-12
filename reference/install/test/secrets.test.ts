import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

const REACHED = "the applier reached at MCP revision 2026-07-28";

/**
 * What the owner keeps beside the nightly dump (the install-core design, *Credentials*): the secrets
 * archive, its restore with the dump on a fresh directory, and the superuser's rotation.
 */
describe("the secrets archive, a restore from it, and the superuser's rotation", () => {
  let s: Stack;
  let fresh: Stack | undefined;
  let bin: string;
  const archives = () => readdirSync(s.archive).filter((f) => f.startsWith("install-")).sort();
  const reached = async (t: Stack) => (await t.logs("steward")).split(REACHED).length - 1;
  async function until(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  /** age and age-keygen, from a small image when the desktop has no package. */
  const withAge = () => ({ ...s.env, PATH: `${bin}:${process.env.PATH}` });

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward"], { GALATEA_BACKUP_KEEP: "2" });
    await s.must(run("docker", ["build", "-q", "-t", "galatea-test-age:local", join(PKG, "test", "age")], process.env), "build age");
    bin = join(s.dir, "test-bin");
    mkdirSync(bin);
    for (const tool of ["age", "age-keygen"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec docker run --rm -i galatea-test-age:local ${tool} "$@"\n`, { mode: 0o755 });
    }
    await s.must(s.compose("up", "-d", "--wait", "steward"), "up steward");
    await s.must(s.bin("galatea-register-steward"));
    await until("the steward's link", async () => (await reached(s)) === 1, 10_000);
  });
  afterAll(async () => {
    await fresh?.destroy();
    await s?.destroy();
  });

  it("writes a checked archive of secrets/, tls/, instances and .env into its own directory, the owner's alone", async () => {
    const r = await s.must(s.bin("galatea-backup-secrets"));
    expect(r.stdout).toMatch(/^galatea-backup-secrets: install-\d{8}T\d{6}Z\.tar: ok \(\d+ files\)$/m);
    expect(archives()).toHaveLength(1);
    const f = join(s.archive, archives()[0]!);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(s.archive).mode & 0o777).toBe(0o700);
    const names = (await s.must(run("tar", ["-tf", f], process.env))).stdout.split("\n");
    for (const n of ["secrets/db/postgres", "secrets/broker/applier", "secrets/mcp/applier-owner", "secrets/mcp/steward-token-key",
      "secrets/ca/ca.key", "secrets/tls/broker.key", "tls/ca.pem", "tls/steward.pem", "instances", ".env"]) {
      expect(names, n).toContain(n);
    }
    expect(readdirSync(s.backups).some((x) => x.startsWith("install-"))).toBe(false);
  });

  it("refuses to keep an archive missing a file it should hold, and prunes to GALATEA_BACKUP_KEEP", async () => {
    const f = join(s.mcpSecrets, "brain_agent");
    writeFileSync(f, "", { mode: 0o600 });
    const r = await s.bin("galatea-backup-secrets");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the archive misses or holds empty: secrets/mcp/brain_agent; nothing kept");
    expect(archives()).toHaveLength(1);
    rmSync(f);
    for (let i = 0; i < 2; i++) {
      await new Promise((res) => setTimeout(res, 1100));
      await s.must(s.bin("galatea-backup-secrets"));
    }
    expect(archives()).toHaveLength(2);
  });

  it("encrypts it with age to GALATEA_SECRETS_RECIPIENT, keeping no readable copy, and the private key opens it", async () => {
    const keys = (await s.must(run(join(bin, "age-keygen"), [], process.env))).stdout;
    const pub = /^# public key: (age1\S+)$/m.exec(keys)![1]!;
    writeFileSync(s.envFile, `${readFileSync(s.envFile, "utf8")}GALATEA_SECRETS_RECIPIENT=${pub}\n`);
    const r = await s.must(run(join(PKG, "bin", "galatea-backup-secrets"), [], withAge()));
    const name = /(install-\S+\.tar\.age): ok/.exec(r.stdout)![1]!;
    const f = join(s.archive, name);
    expect(readFileSync(f).subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(readdirSync(s.archive).filter((x) => x.startsWith("."))).toEqual([]);
    writeFileSync(join(s.dir, "key.txt"), keys, { mode: 0o600 });
    const opened = await run("sh", ["-c", `docker run --rm -i -v ${join(s.dir, "key.txt")}:/k:ro galatea-test-age:local age -d -i /k < ${f} | tar -t`], process.env);
    expect(opened.stdout).toContain("secrets/mcp/applier-owner");
    writeFileSync(s.envFile, readFileSync(s.envFile, "utf8").replace(`GALATEA_SECRETS_RECIPIENT=${pub}\n`, ""));
  });

  it("is mounted by no service, and the backup service mounts no MCP secret and no key", async () => {
    const r = await s.must(s.compose("--profile", "zigbee", "config", "--format", "json"));
    const services = JSON.parse(r.stdout).services as Record<string, { volumes?: { source: string }[] }>;
    for (const [name, svc] of Object.entries(services)) {
      for (const v of svc.volumes ?? []) expect(v.source ?? "", name).not.toContain(s.archive);
    }
    const sources = (services.backup!.volumes ?? []).map((v) => v.source);
    for (const p of [s.mcpSecrets, join(s.secretsRoot, "ca"), join(s.secretsRoot, "tls"), s.secretsRoot]) expect(sources).not.toContain(p);
  });

  it("restores on a fresh directory, from the archive and the dump, with the steward still registered", async () => {
    await s.must(s.compose("run", "--rm", "--no-deps", "backup", "once"), "dump");
    const dump = join(s.backups, readdirSync(s.backups).find((f) => f.endsWith(".dump"))!);
    await new Promise((res) => setTimeout(res, 1100));
    const r = await s.must(s.bin("galatea-backup-secrets"));
    const archive = join(s.archive, /(install-\S+\.tar): ok/.exec(r.stdout)![1]!);
    await s.must(s.compose("down"), "the old box goes"); // its volumes stay until destroy; the new one has its own

    fresh = Stack.bare();
    // The new box: the archive unpacked, but its own .env (the test's paths), then prepare, restore, up.
    await fresh.must(run("tar", ["-xf", archive, "-C", fresh.dir, "secrets", "tls", "instances"], process.env));
    const before = readFileSync(join(fresh.mcpSecrets, "steward-at-applier"), "utf8");
    const prepared = await fresh.must(fresh.bin("galatea-prepare"));
    expect(prepared.stdout).not.toContain("wrote");
    expect(prepared.stdout).not.toMatch(/issued|ca made/);
    await fresh.must(fresh.bin("galatea-restore", dump), "restore");
    await fresh.must(fresh.compose("up", "-d", "--wait", "steward"), "up steward");
    expect(readFileSync(join(fresh.mcpSecrets, "steward-at-applier"), "utf8")).toBe(before);
    // No galatea-register-steward: the applier's clients came back with the dump.
    await until("the steward's link on the new box", async () => (await reached(fresh!)) >= 1, 15_000);
    await s.must(s.compose("up", "-d", "--wait", "postgres"), "the old box back for the next test");
  });

  it("rotates the superuser's password: db-init and backup work with the new one", async () => {
    const old = readFileSync(join(s.secrets, "postgres"), "utf8");
    const r = await s.must(s.bin("galatea-rotate-postgres"));
    expect(r.stdout).toContain("the superuser's password is new");
    const now = readFileSync(join(s.secrets, "postgres"), "utf8");
    expect(now).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(now).not.toBe(old);
    expect(existsSync(join(s.secrets, "postgres.next"))).toBe(false);
    expect(statSync(join(s.secrets, "postgres")).mode & 0o777).toBe(0o600);
    expect((r.stdout + r.stderr).includes(now)).toBe(false);
    await s.must(s.compose("run", "--rm", "db-init"), "db-init");
    await s.must(s.compose("run", "--rm", "--no-deps", "backup", "once"), "backup");
    expect((await s.sql("postgres", now, "SELECT 1")).stdout.trim()).toBe("1");
    expect((await s.sql("postgres", old, "SELECT 1")).code).not.toBe(0);
  });

  it("mends a rotation stopped between its ALTER ROLE and its move, when run again", async () => {
    // As a run stopped there leaves it: the database on postgres.next's password, the file not moved.
    const next = join(s.secrets, "postgres.next");
    writeFileSync(next, "Mended0123456789abcdefABCDEF0123", { mode: 0o600 });
    await s.admin("ALTER ROLE postgres PASSWORD 'Mended0123456789abcdefABCDEF0123'");
    expect((await s.compose("run", "--rm", "db-init")).code).not.toBe(0); // locked out, as the design says
    const r = await s.must(s.bin("galatea-rotate-postgres"));
    expect(r.stdout).toContain("setting the password waiting in");
    expect(readFileSync(join(s.secrets, "postgres"), "utf8")).toBe("Mended0123456789abcdefABCDEF0123");
    await s.must(s.compose("run", "--rm", "db-init"), "db-init after the mend");
  });
});
