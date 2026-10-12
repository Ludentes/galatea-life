import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

describe("galatea-prepare", () => {
  let s: Stack;
  const mcp = (n: string) => join(s.mcpSecrets, n);
  beforeAll(async () => {
    s = await Stack.create(["applier"]);
  });
  afterAll(async () => s?.destroy());

  it("writes a password for postgres, reader and each instance, readable by the owner only", () => {
    expect(statSync(s.secretsRoot).mode & 0o777).toBe(0o700);
    expect(statSync(s.secrets).mode & 0o777).toBe(0o700);
    for (const n of ["postgres", "reader", "applier"]) {
      const f = join(s.secrets, n);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(readFileSync(f, "utf8")).toMatch(/^[A-Za-z0-9]{32}$/);
    }
  });

  it("writes the applier's owner credential with applier listed, and the steward's three secrets only with steward listed", async () => {
    expect(statSync(s.mcpSecrets).mode & 0o777).toBe(0o700);
    expect(readFileSync(mcp("applier-owner"), "utf8")).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(statSync(mcp("applier-owner")).mode & 0o777).toBe(0o600);
    for (const f of ["steward-owner", "steward-at-applier", "steward-token-key"]) expect(existsSync(mcp(f)), f).toBe(false);
    s.setInstances(["applier", "steward"]);
    await s.must(s.bin("galatea-prepare"));
    const values = ["applier-owner", "steward-owner", "steward-at-applier", "steward-token-key"].map((f) => {
      expect(statSync(mcp(f)).mode & 0o777, f).toBe(0o600);
      return readFileSync(mcp(f), "utf8");
    });
    // One secret per seam: no two alike, and none a store or broker password.
    const all = [...values, ...["postgres", "reader", "applier", "steward"].map((n) => readFileSync(join(s.secrets, n), "utf8")),
      readFileSync(join(s.brokerSecrets, "applier"), "utf8")];
    expect(new Set(all).size).toBe(all.length);
  });

  it("creates the backups directory and the secrets archive's, owned by the owner and closed to others", () => {
    for (const d of [s.backups, s.archive]) {
      expect(statSync(d).isDirectory()).toBe(true);
      expect(statSync(d).uid).toBe(process.getuid!());
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
  });

  it("makes the CA and the servers' certificates through galatea-certs", () => {
    for (const f of ["ca.pem", "applier.pem", "steward.pem", "broker.pem"]) expect(existsSync(join(s.tls, f)), f).toBe(true);
  });

  it("refuses a bad instance name before it writes any file", async () => {
    s.setInstances(["applier", "../x", "Bad"]);
    const r = await s.bin("galatea-prepare");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("../x");
    expect(existsSync(join(s.secrets, "..", "x"))).toBe(false);
    s.setInstances(["applier"]);
  });

  it("gives a watcher (watch, watch-<n>) a broker password and no store password, and refuses a bad watcher name", async () => {
    for (const bad of ["watch-", "watch-UP", "watch-a_b"]) {
      s.setInstances(["applier", bad]);
      const r = await s.bin("galatea-prepare");
      expect(r.code, bad).not.toBe(0);
      expect(r.stderr, bad).toContain(`bad watcher name: ${bad}`);
    }
    s.setInstances(["applier", "watch", "watch-2"]);
    await s.must(s.bin("galatea-prepare"));
    for (const w of ["watch", "watch-2"]) {
      expect(statSync(join(s.brokerSecrets, w)).mode & 0o777, w).toBe(0o600);
      expect(existsSync(join(s.secrets, w)), w).toBe(false);
    }
    s.setInstances(["applier"]);
  });

  it("never changes a secret that exists, and adds the missing ones", async () => {
    writeFileSync(join(s.secrets, "applier"), "kept");
    writeFileSync(mcp("applier-owner"), "kept too");
    s.setInstances(["applier", "steward", "voice_hall"]);
    const r = await s.must(s.bin("galatea-prepare"));
    expect(readFileSync(join(s.secrets, "applier"), "utf8")).toBe("kept");
    expect(readFileSync(mcp("applier-owner"), "utf8")).toBe("kept too");
    expect(r.stdout).toContain("db/voice_hall");
    expect(r.stdout).not.toContain("applier");
    // voice_hall keeps state but has no broker identity.
    expect(existsSync(join(s.brokerSecrets, "voice_hall"))).toBe(false);
  });

  it("refuses to run when GALATEA_UID is not this account's, since the services could not read its files", async () => {
    const env = readFileSync(s.envFile, "utf8");
    writeFileSync(s.envFile, env.replace(/^GALATEA_UID=.*$/m, `GALATEA_UID=${process.getuid!() + 1}`));
    try {
      const r = await s.bin("galatea-prepare");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("GALATEA_UID and GALATEA_GID");
    } finally {
      writeFileSync(s.envFile, env);
    }
  });

  it("refuses 4a's settings GALATEA_DB_SECRETS and GALATEA_BROKER_SECRETS, from .env or the environment, naming the new roots and writing nothing", async () => {
    const env = readFileSync(s.envFile, "utf8");
    const elsewhere = join(s.dir, "old-secrets");
    try {
      for (const old of ["GALATEA_DB_SECRETS", "GALATEA_BROKER_SECRETS"]) {
        writeFileSync(s.envFile, `${env}${old}=${elsewhere}\n`);
        const r = await s.bin("galatea-prepare");
        expect(r.code, old).not.toBe(0);
        expect(r.stderr, old).toContain(`${old} is no longer read: set GALATEA_SECRETS`);
      }
      writeFileSync(s.envFile, env);
      const fromEnv = await run(join(PKG, "bin", "galatea-certs"), ["--check"], { ...s.env, GALATEA_DB_SECRETS: elsewhere });
      expect(fromEnv.code).not.toBe(0);
      expect(fromEnv.stderr).toContain("GALATEA_DB_SECRETS is no longer read");
      expect(existsSync(elsewhere)).toBe(false);
    } finally {
      writeFileSync(s.envFile, env);
    }
  });

  it("refuses to run without an instances file", async () => {
    rmSync(s.instancesFile);
    const r = await s.bin("galatea-prepare");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no instances file");
  });
});
