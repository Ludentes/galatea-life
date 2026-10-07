#!/usr/bin/env node
// Grades this build with the harness on its graded ids, then runs its negatives. Exits 0 only when
// every graded id passes and every mutation fails exactly the ids the manifest names for it.
// With `--reach <store>`, the graded run also collects V8 coverage and its reach is stored, as the
// matrix's `--reach` does (docs/plans/2026-10-06-harness-reach.md); the verdict is unchanged.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "@ludentes/galatea-life-harness";
import { collectReach, ownRows } from "@ludentes/galatea-life-harness/scripts/reach.mjs";
import { withProposed } from "./matrix-verdict.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
// The harness's CLI, by its bin (the package is a devDependency); run with this node, as before.
const harnessPkg = fileURLToPath(import.meta.resolve("@ludentes/galatea-life-harness/package.json"));
const cli = join(dirname(harnessPkg), JSON.parse(readFileSync(harnessPkg, "utf8")).bin["galatea-harness"]);
const { ids } = JSON.parse(readFileSync(join(here, "graded-ids.json"), "utf8"));
const out = join(tmpdir(), "galatea-applier-conformance", String(process.pid));

function harness(mode, extra) {
  const r = spawnSync(process.execPath, [cli, mode, "--subject", here, "--out", out, ...extra], { stdio: "inherit" });
  if (r.status === 2) {
    console.error(`the harness stopped on a fault in ${mode}; see ${out}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(join(out, `${mode}.json`), "utf8"));
}

const i = process.argv.indexOf("--reach");
const reachStore = i >= 0 ? process.argv[i + 1] : undefined;
const run = harness("run", ["--ids", ids.join(","), ...(reachStore ? ["--coverage", join(out, "coverage")] : [])]);
if (reachStore) {
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const subject = read(join(here, "subject.json"));
  const proposed = read(join(here, "proposed-rows.json"));
  const manifest = withProposed(loadManifest(subject.standard), proposed);
  const declared = [...subject.mutations, ...proposed.rows.map((r) => r.mutation)];
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  try {
    const r = collectReach({ buildDir: here, report: run, store: reachStore, out, mutations: declared, ...ownRows(manifest, declared),
      known: read(join(here, "known-outside.json")).known, commit });
    console.log(`Reach: ${r.problems.length ? "not stored, the lint fails" : r.file}; report ${join(out, "reach.md")}`);
    for (const w of r.warnings) console.log(`Warning: ${w}`);
  } catch (err) {
    // The reach is a record beside the run; its failure leaves the verdict to come as it is.
    console.log(`Warning: the reach was not recorded: ${err instanceof Error ? err.message : err}`);
  } finally {
    // The coverage, some 220 MB, is read; the reach and its report stay.
    rmSync(join(out, "coverage"), { recursive: true, force: true });
  }
}
const notPassed = ids.filter((id) => run.rows.find((r) => r.id === id)?.state !== "pass");
const negatives = harness("negatives", []);
const { mutations = [] } = JSON.parse(readFileSync(join(here, "subject.json"), "utf8"));
const ran = Array.isArray(negatives.negatives) ? negatives.negatives : [];
const uncaught = [
  ...ran.filter((n) => n.state !== "pass").map((n) => `${n.mutation} (${n.state}: ${n.detail})`),
  // Every mutation the subject declares must have been run and caught; a missing report is no pass.
  ...mutations.filter((m) => !ran.some((n) => n.mutation === m && n.state === "pass")).map((m) => `${m} (not reported as pass)`),
];

if (notPassed.length) console.error(`not passed: ${notPassed.join(", ")}`);
if (uncaught.length) console.error(`negatives not caught: ${uncaught.join("; ")}`);
console.log(notPassed.length || uncaught.length ? "The reference applier does not pass." : `The reference applier passes its ${ids.length} graded ids and its negatives.`);
process.exit(notPassed.length || uncaught.length ? 1 : 0);
