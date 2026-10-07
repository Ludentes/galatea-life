import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The migrate-only entry the harness runs once per run into its template (subject.json's database.migrate).
const entry = join(import.meta.dirname, "..", "dist", "migrate-main.js");
const run = (env: Record<string, string>) => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GALATEA_")));
  return spawnSync(process.execPath, [entry], { env: { ...inherited, ...env }, encoding: "utf8", timeout: 20_000 });
};

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
});
