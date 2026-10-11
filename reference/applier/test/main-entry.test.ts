import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakePostgres } from "./fake-postgres.js";

// The applier's entry point refuses a setting it cannot use before it opens its store, with a
// message that names the settings and no secret (the install-core design, *The builds' entry points*).
const entry = join(import.meta.dirname, "..", "dist", "main.js");
const dir = mkdtempSync(join(tmpdir(), "applier-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const secret = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, `${text}\n`);
  chmodSync(path, 0o600);
  return path;
};
const run = (env: Record<string, string>) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
  const r = spawnSync(process.execPath, [entry], { env: { ...inherited, GALATEA_MCP_PORT: "1", ...env }, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: r.stderr + r.stdout };
};
// No store answers here: a start that got past its settings fails opening it instead (exit 1).
const DB = "postgres://applier:db-secret-pw@127.0.0.1:1/nowhere";

describe("the applier's entry point", () => {
  it("refuses a secret given both as a value and as a file", () => {
    const r = run({ GALATEA_DATABASE_URL: DB, GALATEA_OWNER_CREDENTIAL: "owner-secret-value", GALATEA_OWNER_CREDENTIAL_FILE: secret("owner", "owner-secret-file") });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/GALATEA_OWNER_CREDENTIAL and GALATEA_OWNER_CREDENTIAL_FILE are both set/);
    expect(r.out).not.toMatch(/owner-secret|db-secret-pw/);
  });

  it("refuses a URL carrying a password beside its password file, for the store and the broker", () => {
    const db = run({ GALATEA_DATABASE_URL: DB, GALATEA_DATABASE_PASSWORD_FILE: secret("db", "x"), GALATEA_OWNER_CREDENTIAL: "owner-of-sixteen-chars" });
    expect(db.status).toBe(2);
    expect(db.out).toMatch(/GALATEA_DATABASE_URL carries a password and GALATEA_DATABASE_PASSWORD_FILE is set/);
    const broker = run({ GALATEA_DATABASE_URL: DB, GALATEA_OWNER_CREDENTIAL: "owner-of-sixteen-chars", GALATEA_ROOT: "demo",
      GALATEA_BROKER: "mqtts://applier:broker-secret-pw@127.0.0.1:1", GALATEA_BROKER_PASSWORD_FILE: secret("broker", "y") });
    expect(broker.status).toBe(2);
    expect(broker.out).toMatch(/GALATEA_BROKER carries a password and GALATEA_BROKER_PASSWORD_FILE is set/);
    expect(db.out + broker.out).not.toMatch(/secret-pw/);
  });

  it("refuses a secret file other accounts can read, and a TLS or CA file it cannot read, naming the setting", () => {
    const open = secret("open", "owner-secret-file");
    chmodSync(open, 0o644);
    const r = run({ GALATEA_DATABASE_URL: DB, GALATEA_OWNER_CREDENTIAL_FILE: open });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/GALATEA_OWNER_CREDENTIAL_FILE .* can be reached by other accounts/);
    expect(r.out).not.toMatch(/owner-secret-file/);
    for (const name of ["GALATEA_APPLIER_TLS_CERT", "GALATEA_APPLIER_TLS_KEY", "GALATEA_BROKER_CA"]) {
      const t = run({ GALATEA_DATABASE_URL: DB, GALATEA_OWNER_CREDENTIAL: "owner-of-sixteen-chars", [name]: join(dir, "missing.pem") });
      expect(t.status, name).toBe(2);
      expect(t.out).toMatch(new RegExp(`${name} .*missing\\.pem cannot be read \\(ENOENT\\)`));
    }
  });

  it("takes the owner's credential and the store's password from files, and goes on to open the store", () => {
    const r = run({ GALATEA_DATABASE_URL: "postgres://applier@127.0.0.1:1/nowhere", GALATEA_DATABASE_PASSWORD_FILE: secret("db2", "db-secret-pw"),
      GALATEA_OWNER_CREDENTIAL_FILE: secret("owner2", "owner-secret-file") });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/could not be opened/);
    expect(r.out).not.toMatch(/db-secret-pw|owner-secret-file/);
  });

  it("hands pg the password from GALATEA_DATABASE_PASSWORD_FILE, exactly (a fake Postgres records what arrives)", async () => {
    const pg = await fakePostgres();
    try {
      const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
        const child = spawn(process.execPath, [entry], { env: { ...inherited, GALATEA_MCP_PORT: "1",
          GALATEA_DATABASE_URL: `postgres://applier@127.0.0.1:${pg.port}/galatea`, GALATEA_DATABASE_PASSWORD_FILE: secret("db3", "p@ss %#word"),
          GALATEA_OWNER_CREDENTIAL: "owner-of-sixteen-chars" } });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("exit", (status) => resolve({ status, out }));
      });
      expect(pg.passwords).toContain("p@ss %#word");
      expect(r.status).toBe(1);
      expect(r.out).not.toMatch(/p@ss/);
    } finally {
      await pg.close();
    }
  });
});
