import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakePostgres } from "./fake-postgres.js";

// The steward's entry point refuses a setting it cannot use before it opens its store, with a
// message that names the settings and no secret (the install-core design, *The builds' entry points*).
const entry = join(import.meta.dirname, "..", "dist", "main.js");
const dir = mkdtempSync(join(tmpdir(), "steward-main-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const secret = (name: string, text: string) => {
  const path = join(dir, name);
  writeFileSync(path, `${text}\n`);
  chmodSync(path, 0o600);
  return path;
};
// No store answers here: a start that got past its settings fails opening it instead (exit 1).
const BASE = { GALATEA_DATABASE_URL: "postgres://steward:db-secret-pw@127.0.0.1:1/nowhere", GALATEA_MCP_PORT: "1",
  GALATEA_APPLIER_URL: "http://127.0.0.1:1/mcp", GALATEA_APPLIER_CLIENT: "steward",
  GALATEA_APPLIER_CREDENTIAL: "applier-secret-value", GALATEA_APPLIER_TOKEN_KEY: "token-key-secret-value" };
const run = (env: Record<string, string | undefined>) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
  const merged = Object.fromEntries(Object.entries({ ...inherited, ...BASE, ...env }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = spawnSync(process.execPath, [entry], { env: merged, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, out: r.stderr + r.stdout };
};

describe("the steward's entry point", () => {
  it("refuses each secret given both as a value and as a file", () => {
    for (const name of ["GALATEA_APPLIER_CREDENTIAL", "GALATEA_APPLIER_TOKEN_KEY", "GALATEA_OWNER_CREDENTIAL"]) {
      const r = run({ [name]: "a-value-of-sixteen-or-more", [`${name}_FILE`]: secret(name, "file-secret-of-sixteen-or-more") });
      expect(r.status, name).toBe(2);
      expect(r.out).toContain(`${name} and ${name}_FILE are both set`);
      expect(r.out).not.toMatch(/secret-value|file-secret|db-secret-pw/);
    }
  });

  it("holds a token key from a file to the 16-character floor, never printing it", () => {
    const r = run({ GALATEA_APPLIER_TOKEN_KEY: undefined, GALATEA_APPLIER_TOKEN_KEY_FILE: secret("short", "short-key") });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/GALATEA_APPLIER_TOKEN_KEY is shorter than 16 characters/);
    expect(r.out).not.toMatch(/short-key/);
  });

  it("refuses the store's URL carrying a password beside its file, and a CA or TLS file it cannot read", () => {
    const db = run({ GALATEA_DATABASE_PASSWORD_FILE: secret("db", "x") });
    expect(db.status).toBe(2);
    expect(db.out).toMatch(/GALATEA_DATABASE_URL carries a password and GALATEA_DATABASE_PASSWORD_FILE is set/);
    expect(db.out).not.toMatch(/db-secret-pw/);
    for (const name of ["GALATEA_APPLIER_CA", "GALATEA_STEWARD_TLS_CERT", "GALATEA_STEWARD_TLS_KEY"]) {
      const t = run({ [name]: join(dir, "missing.pem") });
      expect(t.status, name).toBe(2);
      expect(t.out).toMatch(new RegExp(`${name} .*missing\\.pem cannot be read \\(ENOENT\\)`));
    }
  });

  it("takes every secret from its file, and goes on to open the store", () => {
    const r = run({ GALATEA_DATABASE_URL: "postgres://steward@127.0.0.1:1/nowhere", GALATEA_DATABASE_PASSWORD_FILE: secret("db2", "db-secret-pw"),
      GALATEA_APPLIER_CREDENTIAL: undefined, GALATEA_APPLIER_CREDENTIAL_FILE: secret("cred", "applier-secret-file"),
      GALATEA_APPLIER_TOKEN_KEY: undefined, GALATEA_APPLIER_TOKEN_KEY_FILE: secret("key", "token-key-secret-file"),
      GALATEA_OWNER_CREDENTIAL_FILE: secret("owner", "owner-secret-file") });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/could not be opened/);
    expect(r.out).not.toMatch(/db-secret-pw|secret-file/);
  });

  it("hands pg the password from GALATEA_DATABASE_PASSWORD_FILE, exactly (a fake Postgres records what arrives)", async () => {
    const pg = await fakePostgres();
    try {
      const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
        const child = spawn(process.execPath, [entry], { env: { ...inherited, ...BASE,
          GALATEA_DATABASE_URL: `postgres://steward@127.0.0.1:${pg.port}/galatea`, GALATEA_DATABASE_PASSWORD_FILE: secret("db3", "p@ss %#word") } });
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
