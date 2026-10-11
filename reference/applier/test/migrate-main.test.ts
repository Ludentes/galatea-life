import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakePostgres } from "./fake-postgres.js";

// The migrate-only entry the harness runs once per run into its template (subject.json's database.migrate).
const entry = join(import.meta.dirname, "..", "dist", "migrate-main.js");
const run = (env: Record<string, string>) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
  return spawnSync(process.execPath, [entry], { env: { ...inherited, ...env }, encoding: "utf8", timeout: 20_000 });
};

const dir = mkdtempSync(join(tmpdir(), "applier-migrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the migrate-only entry", () => {
  it("refuses to run without GALATEA_DATABASE_URL", () => {
    const r = run({});
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/GALATEA_DATABASE_URL is not set/);
  });

  it("fails, never printing the URL, when the store cannot be reached", () => {
    const r = run({ GALATEA_DATABASE_URL: "postgres://someone:secret-pw@127.0.0.1:1/nowhere" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not be migrated/);
    expect(r.stderr + r.stdout).not.toMatch(/secret-pw/);
  });

  it("takes the password from GALATEA_DATABASE_PASSWORD_FILE, never printing it, and refuses it beside a URL that carries one", () => {
    const pw = join(dir, "pw");
    writeFileSync(pw, "file-secret-pw\n");
    chmodSync(pw, 0o600);
    const r = run({ GALATEA_DATABASE_URL: "postgres://someone@127.0.0.1:1/nowhere", GALATEA_DATABASE_PASSWORD_FILE: pw });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/could not be migrated/);
    expect(r.stderr + r.stdout).not.toMatch(/file-secret-pw/);
    const both = run({ GALATEA_DATABASE_URL: "postgres://someone:secret-pw@127.0.0.1:1/nowhere", GALATEA_DATABASE_PASSWORD_FILE: pw });
    expect(both.status).toBe(2);
    expect(both.stderr).toMatch(/GALATEA_DATABASE_URL carries a password and GALATEA_DATABASE_PASSWORD_FILE is set/);
    expect(both.stderr + both.stdout).not.toMatch(/secret-pw/);
  });

  it("hands pg the password from GALATEA_DATABASE_PASSWORD_FILE, exactly (a fake Postgres records what arrives)", async () => {
    const pg = await fakePostgres();
    const pw = join(dir, "pw2");
    writeFileSync(pw, "p@ss %#word\n");
    chmodSync(pw, 0o600);
    try {
      const status = await new Promise<number | null>((resolve) => {
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
        spawn(process.execPath, [entry], { env: { ...inherited, GALATEA_DATABASE_URL: `postgres://applier@127.0.0.1:${pg.port}/galatea`,
          GALATEA_DATABASE_PASSWORD_FILE: pw }, stdio: "ignore" }).on("exit", resolve);
      });
      expect(pg.passwords).toContain("p@ss %#word");
      expect(status).toBe(1);
    } finally {
      await pg.close();
    }
  });
});
