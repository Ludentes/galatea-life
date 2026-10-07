// The matrix driver's `--changed <base>`: what it refuses before it runs anything. The scope itself,
// its lines and the pass line's clause are the harness's (`changed.test.ts` there).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const driver = join(import.meta.dirname, "..", "scripts", "full-matrix.mjs");
const run = (...args: string[]) => spawnSync(process.execPath, [driver, ...args], { encoding: "utf8", timeout: 60_000 });

describe("the matrix scoped to a change", () => {
  it("is refused with --full", () => {
    const r = run("--changed", "origin/main", "--full");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--changed scopes a skipping matrix; --full runs every mutation on every id/);
  });

  it("needs its base", () => {
    expect(run("--changed").status).toBe(2);
    expect(run("--changed", "--only", "x").stderr).toMatch(/--changed takes the base/);
  });

  it("takes --uncommitted only with --changed", () => {
    const r = run("--uncommitted");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/give --changed too/);
  });
});
