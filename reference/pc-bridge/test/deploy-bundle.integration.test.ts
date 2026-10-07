import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The bridge as it is installed outside the repository: a `pnpm deploy --prod` bundle (plan 4b,
 * *The desktop run*). Its `@ludentes/galatea-life-schemas` must carry every schema it loads, so the bridge's
 * `validate` works there, and a second call after a failure must not stay broken. It grades the
 * built packages, `dist/` as it stands: skipped before `pnpm -r build`, and a stale
 * schemas `dist/` grades old code, so build before trusting it. (It does not build
 * itself: a build during the run would rewrite the `dist/` the other test files import.)
 */
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
// The schemas package this build depends on, by name: the workspace's, or the registry's where the build stands alone.
// Not resolving is a failure, never a skip.
const SCHEMAS_DIST = createRequire(import.meta.url).resolve("@ludentes/galatea-life-schemas");
const built = existsSync(join(PACKAGE, "dist", "bridge.js")) && existsSync(SCHEMAS_DIST);
const pnpm = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;

const CHECK = `
import { validate } from "@ludentes/galatea-life-schemas";
const out = [];
for (const id of ["bridge/command.json", "bridge/command.json", "galatea-bridge.schema.json"]) {
  try { out.push(validate(id, {}).length > 0 ? "errors" : "none"); } catch (e) { out.push("threw: " + e.message); }
}
console.log(JSON.stringify(out));
`;

describe.skipIf(!built || !pnpm)("a pnpm deploy bundle of the bridge", () => {
  it("validates a command with the bundle's own schemas, each call", () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-bridge-deploy-"));
    try {
      const target = join(dir, "pc-bridge");
      const deploy = spawnSync("pnpm", ["--filter", "@ludentes/galatea-life-pc-bridge", "deploy", "--prod", "--legacy", "--offline", target],
        { cwd: PACKAGE, encoding: "utf8" });
      expect(deploy.status, deploy.stderr || deploy.stdout).toBe(0);
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", CHECK], { cwd: target, encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toEqual(["errors", "errors", "errors"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
