#!/usr/bin/env node
// Grades this build with the harness on its graded ids, then runs its negatives. Exits 0 only when
// every graded id passes and every mutation fails exactly the ids the manifest names for it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPartial } from "./partial.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
// The harness's CLI, by its bin (the package is a devDependency); run with this node, as before.
const harnessPkg = fileURLToPath(import.meta.resolve("@ludentes/galatea-life-harness/package.json"));
const cli = join(dirname(harnessPkg), JSON.parse(readFileSync(harnessPkg, "utf8")).bin["galatea-harness"]);
const { ids, partial = {} } = JSON.parse(readFileSync(join(here, "graded-ids.json"), "utf8"));
const out = join(tmpdir(), "galatea-steward-conformance", String(process.pid));

function harness(mode, extra) {
  const r = spawnSync(process.execPath, [cli, mode, "--subject", here, "--out", out, ...extra], { stdio: "inherit" });
  if (r.status === 2) {
    console.error(`the harness stopped on a fault in ${mode}; see ${out}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(join(out, `${mode}.json`), "utf8"));
}

const run = harness("run", ["--ids", ids.join(",")]);
const notPassed = ids.filter((id) => run.rows.find((r) => r.id === id)?.state !== "pass");
const negatives = harness("negatives", []);
const { mutations = [] } = JSON.parse(readFileSync(join(here, "subject.json"), "utf8"));
const ran = Array.isArray(negatives.negatives) ? negatives.negatives : [];
const uncaught = [
  ...ran.filter((n) => n.state !== "pass").map((n) => `${n.mutation} (${n.state}: ${n.detail})`),
  // Every mutation the subject declares must have been run and caught; a missing report is no pass.
  ...mutations.filter((m) => !ran.some((n) => n.mutation === m && n.state === "pass")).map((m) => `${m} (not reported as pass)`),
];

// An id partly graded says so, and the record must agree with the tests' `covers` (graded-ids.json).
const unrecorded = checkPartial(ids, partial, run.rows);
for (const [id, left] of Object.entries(partial)) console.log(`${id}: graded but for ${left.join("; ")}`);
if (unrecorded.length) console.error(`the record of partly graded ids is wrong: ${unrecorded.join("; ")}`);
if (notPassed.length) console.error(`not passed: ${notPassed.join(", ")}`);
if (uncaught.length) console.error(`negatives not caught: ${uncaught.join("; ")}`);
const failed = notPassed.length || uncaught.length || unrecorded.length;
console.log(failed ? "The reference steward does not pass."
  : `The reference steward passes its ${ids.length} graded ids (${Object.keys(partial).length} of them in part, listed above) and its negatives.`);
process.exit(failed ? 1 : 0);
