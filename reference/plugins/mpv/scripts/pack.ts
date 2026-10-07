import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildManifest, checkManifest, PLUGIN_ID, PLUGIN_VERSION } from "../src/manifest.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FILES = ["manifest.json", "package.json", "server.js"];

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

/**
 * Bundles the server into one file, writes the manifest, and makes a reproducible .tar.gz, in
 * `outDir` (the plugin's own `dist/` unless a caller, such as another package's test, gives its own).
 */
export async function pack(outDir = join(ROOT, "dist")): Promise<{ tarball: string; sha256: string; stage: string }> {
  const stage = join(outDir, "package");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  await build({
    absWorkingDir: ROOT,
    entryPoints: [join(ROOT, "src", "main.ts")],
    outfile: join(stage, "server.js"),
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    // Some bundled dependencies are CommonJS and call require() for Node's own modules.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  writeFileSync(join(stage, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const manifest = buildManifest();
  const problems = checkManifest(manifest, FILES);
  if (problems.length) throw new Error(`invalid manifest:\n${problems.join("\n")}`);
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const tar = join(outDir, `${PLUGIN_ID}-${PLUGIN_VERSION}.tar`);
  // --format=gnu is explicit: a host whose tar defaults to posix/pax would otherwise add
  // atime/ctime extended headers, which would break reproducibility.
  run("tar", ["--format=gnu", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", "--mode=u=rw,go=r",
    "-C", stage, "-cf", tar, ...FILES]);
  run("gzip", ["-n", "-9", "-f", tar]);
  const tarball = `${tar}.gz`;
  const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${sha256}  ${PLUGIN_ID}-${PLUGIN_VERSION}.tar.gz\n`);
  return { tarball, sha256, stage };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { tarball, sha256 } = await pack();
  console.log(JSON.stringify({ package: tarball, sha256, bytes: readFileSync(tarball).length }));
}
