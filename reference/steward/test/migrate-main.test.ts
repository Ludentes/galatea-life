import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakePostgres } from "./fake-postgres.js";
import { templateDatabase } from "@ludentes/galatea-life-harness/database";
import { loadSubject } from "@ludentes/galatea-life-harness";

// The migrate-only entry the harness runs once per run into its template (subject.json's database.migrate).
const here = join(import.meta.dirname, "..");
const entry = join(here, "dist", "migrate-main.js");
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [entry], { env: { ...inherited, ...env }, encoding: "utf8", timeout: 20_000 });
const PG = process.env.GALATEA_TEST_PG_URL;

const dir = mkdtempSync(join(tmpdir(), "steward-migrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the migrate-only entry", () => {
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

  it("is the subject's database.migrate", () => {
    expect(loadSubject(here).database).toEqual({ migrate: { command: "node", args: ["dist/migrate-main.js"] } });
  });

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

  // The template's limits (the harness's subject contract, database.migrate): a clone renames the
  // schema, and keeps no default privileges and no setting of the template's role.
  it("migrations name no schema, set no default privileges, role setting or search path, and define no function", () => {
    const dir = join(here, "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
      const sql = readFileSync(join(dir, f), "utf8").replace(/--.*$/gm, "");
      expect([f, sql]).not.toEqual([f, expect.stringMatching(/\b(SCHEMA|DEFAULT\s+PRIVILEGES|ALTER\s+ROLE|search_path|FUNCTION|PROCEDURE|TRIGGER|steward\.)/i)]);
    }
  });
});

describe.skipIf(!PG)("the steward's database.migrate, on a real Postgres", () => {
  it("makes a template its clones keep, and the steward's own migrate finds nothing to do on a clone", async () => {
    const spec = loadSubject(here);
    const migrate = typeof spec.database === "object" ? spec.database.migrate : undefined;
    expect(migrate).toBeDefined();
    // templateDatabase refuses a template a clone would not keep (TEMPLATE_FIT): default privileges, a
    // setting of its role, a function whose text or settings name the schema.
    const t = await templateDatabase(PG!, migrate!, here);
    const a = await t.clone();
    try {
      const r = spawnSync(migrate!.command, migrate!.args ?? [], { cwd: here, env: { ...inherited, GALATEA_DATABASE_URL: a.url },
        encoding: "utf8", timeout: 30_000 });
      expect([r.status, r.stdout.trim()]).toEqual([0, "migrated: nothing to do"]);
    } finally {
      await a.drop();
      await t.drop();
    }
  }, 60_000);

});

describe("the migrate-only entry and a fake Postgres", () => {
  it("hands pg the password from GALATEA_DATABASE_PASSWORD_FILE, exactly (a fake Postgres records what arrives)", async () => {
    const pg = await fakePostgres();
    const pw = join(dir, "pw2");
    writeFileSync(pw, "p@ss %#word\n");
    chmodSync(pw, 0o600);
    try {
      const status = await new Promise<number | null>((resolve) => {
        spawn(process.execPath, [entry], { env: { ...inherited, GALATEA_DATABASE_URL: `postgres://steward@127.0.0.1:${pg.port}/galatea`,
          GALATEA_DATABASE_PASSWORD_FILE: pw }, stdio: "ignore" }).on("exit", resolve);
      });
      expect(pg.passwords).toContain("p@ss %#word");
      expect(status).toBe(1);
    } finally {
      await pg.close();
    }
  });
});
