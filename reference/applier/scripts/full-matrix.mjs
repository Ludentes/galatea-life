#!/usr/bin/env node
// The full mutation matrix, the gate's one harness pass: the clean build and each mutation the subject
// declares, every one against every graded id. Its verdict (`matrix-verdict.mjs`) fails on the clean
// build failing an id; on a mutation not caught, as `conformance`'s negatives would find it (an id
// its row breaks that still passes, or fails outside the test's body); and on an id a mutation fails
// outside its manifest row (the ids it breaks and their coupled ids), which negatives cannot see. Rows
// known to be incomplete are listed in `known-outside.json`, to be fixed in the next applier revision.
// Mutations of rows the standard does not name yet are graded through `proposed-rows.json`.
//
// It skips by reach unless given `--full` (the maintainer's ruling, 2026-10-06; the guide's *Skipping by
// reach*). The clean run comes first, runs every graded id and collects V8 coverage; its reach is
// added to the stored reach, which carries observed pairs across builds (`--reach <store>`, by default
// ~/.cache/galatea-reach). Each mutation then runs only the ids in its reach, with every id its rows
// break or couple; its other ids are skipped, never passed. A lint problem (a mutation with no
// direct site) refuses to skip. `--full` runs every id under every mutation, the weekly and
// pre-release matrix; with `--reach` it records the clean run's reach alone, resetting the store's
// carried pairs. Without `--full`, `--only` runs the clean run too, whatever it lists, and a clean
// build that fails an id stops the matrix before its mutations.
//
// `--changed <base>` scopes the matrix to the change against `<base>` (the guide's *What runs when*):
// the clean run as ever, then only the mutations the change puts in scope, each printed with its
// reasons and still skipping by reach (the harness's `scripts/changed.mjs`). `--uncommitted` adds the
// working tree's changes. It combines with `--only` (both must hold) and is refused with `--full`.
// When the change cannot be scoped (a base git cannot diff, a mutation whose sites cannot be mapped,
// a reach that does not hold this build's sites), every mutation runs, by reach, and the matrix says why.
//
// Usage (from reference/applier, after `pnpm build`): pnpm conformance:matrix [--full] [--jobs <n>] [--only <m,m>] [--reach <store>]
//   [--changed <base> [--uncommitted]]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "@ludentes/galatea-life-harness";
import { afterReach, passLine, scopeClause, scopeLines, selectMutations, unscoped } from "@ludentes/galatea-life-harness/changed";
import { scopeOfChange } from "@ludentes/galatea-life-harness/scripts/changed.mjs";
import { timingLines } from "@ludentes/galatea-life-harness/scripts/matrix-timing.mjs";
import { collectReach, ownRows } from "@ludentes/galatea-life-harness/scripts/reach.mjs";
import { markSkipped, reachedIds, verdict, withProposed } from "./matrix-verdict.mjs";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
// The harness's CLI, by its bin (the package is a devDependency); run with this node, as before.
const harnessPkg = fileURLToPath(import.meta.resolve("@ludentes/galatea-life-harness/package.json"));
const cli = join(dirname(harnessPkg), JSON.parse(readFileSync(harnessPkg, "utf8")).bin["galatea-harness"]);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const subject = read(join(here, "subject.json"));
const { ids } = read(join(here, "graded-ids.json"));
const known = read(join(here, "known-outside.json")).known;
// Rows proposed for the next applier revision (the maintainer's ruling 6, 2026-10-05): graded as the standard's own.
const proposed = read(join(here, "proposed-rows.json"));
const manifest = withProposed(loadManifest(subject.standard), proposed);

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const jobs = Number(arg("--jobs") ?? 3);
const only = arg("--only")?.split(",");
const full = process.argv.includes("--full");
if (process.argv.includes("--changed") && (!arg("--changed") || arg("--changed").startsWith("--"))) {
  console.error("usage: --changed takes the base to diff against (origin/main)");
  process.exit(2);
}
const changedBase = arg("--changed");
if (changedBase && full) {
  console.error("--changed scopes a skipping matrix; --full runs every mutation on every id. Give one of them.");
  process.exit(2);
}
if (process.argv.includes("--uncommitted") && !changedBase) {
  console.error("--uncommitted adds the working tree's changes to --changed's; give --changed too.");
  process.exit(2);
}
if (process.argv.includes("--reach") && (!arg("--reach") || arg("--reach").startsWith("--"))) {
  console.error("usage: --reach takes the store's directory");
  process.exit(2);
}
const reachStore = arg("--reach") ?? (full ? undefined : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "galatea-reach"));
const declared = [...subject.mutations, ...proposed.rows.map((r) => r.mutation)];
// The change's scope, before anything runs: which mutations it puts in scope, and why.
const changed = changedBase ? await scopeOfChange({ buildDir: here, base: changedBase, uncommitted: process.argv.includes("--uncommitted") })
  : undefined;
let scope = changed?.scope;
// A scope that could read nothing names no mutation: unscoped, it stands for every one this build declares.
if (scope?.mode === "unscoped" && scope.of !== declared.length) scope = unscoped(declared, scope.why);
for (const w of changed?.warnings ?? []) console.log(`Warning: ${w}`);
if (scope) console.log(scopeLines(scope, changedBase, only).join("\n"));
// Skipping needs the clean run's reach: it always runs, whatever `--only` says.
let mutations = [...(!only || only.includes("clean") || !full ? ["clean"] : []), ...selectMutations({ declared, only, scope })];
const out = join(tmpdir(), "galatea-applier-matrix", String(process.pid));
// Node's compile cache, one directory per matrix: every run's harness and subjects share it, so a
// module is compiled once per matrix rather than once per process (the lifecycle design, phase 1).
// The harness passes every variable but GALATEA_* through to the subject.
process.env.NODE_COMPILE_CACHE ??= join(out, "compile-cache");

/** A migrate command with a relative first argument resolved against this build's directory. */
const fromHere = ({ command, args = [] }) =>
  ({ command, args: args.length && !isAbsolute(args[0]) ? [join(here, args[0]), ...args.slice(1)] : args });

/** Runs `runIds` against the build under `m` (none for `clean`); resolves with its report. */
function run(m, runIds) {
  const dir = join(out, m);
  mkdirSync(dir, { recursive: true });
  const env = m === "clean" ? [] : [`GALATEA_MUTATION=${m}`];
  writeFileSync(join(dir, "subject.json"), JSON.stringify({ ...subject, mutations: [],
    start: { ...subject.start, command: "env", args: [...env, process.execPath, join(here, subject.start.args[0])] },
    // The copy lives in another directory: a migrate-only command's relative first argument (its script)
    // is named from the build's; the command and any other argument stay as declared.
    ...(typeof subject.database === "object" ? { database: { migrate: fromHere(subject.database.migrate) } } : {}) }));
  return new Promise((resolve) => {
    const coverage = m === "clean" && reachStore ? ["--coverage", join(dir, "coverage")] : [];
    const child = spawn(process.execPath, [cli, "run", "--subject", dir, "--out", join(dir, "out"), "--ids", runIds.join(","), ...coverage], { stdio: "ignore" });
    child.on("exit", () => {
      try {
        resolve(read(join(dir, "out", "run.json")));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const results = new Map();
const timed = [];
/** In a skipping matrix, the ids each mutation ran. */
const ran = new Map();
const t0 = Date.now();

/** Runs `m` on `lane` over `runIds`, keeps its rows (the ids it did not run marked skipped) and prints its line. */
async function runOne(m, lane, runIds) {
  const r0 = Date.now();
  const report = runIds.length ? await run(m, runIds) : { rows: [] };
  timed.push({ mutation: m, lane, wallMs: Date.now() - r0, report });
  const skipping = ran.has(m);
  const rows = report?.rows && (skipping ? markSkipped(report.rows, ids, ran.get(m)) : report.rows);
  results.set(m, rows);
  const failed = rows && runIds.filter((id) => rows.find((r) => r.id === id)?.state !== "pass");
  const counted = skipping ? `ran ${runIds.length} of ${ids.length}; ` : "";
  console.log(`${m}: ${counted}${failed === undefined ? "no report" : failed.length ? failed.join(", ") : "nothing"} failed`);
  return report;
}

let reach;
const reachLines = [];
/** Adds the clean run's reach to the store; undefined without a store or a report. */
function collect(report) {
  if (!reachStore || !report) return undefined;
  let commit = "unknown";
  try { commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim(); } catch { /* not a checkout */ }
  // A full matrix resets the store's carried pairs to its own run (the reach preflight's I1).
  const r = collectReach({ buildDir: here, report, store: reachStore, out: join(out, "clean"), mutations: declared,
    ...ownRows(manifest, declared), known, commit, reset: full });
  // The coverage, some 220 MB, is read; the reach and its report stay.
  rmSync(join(out, "clean", "coverage"), { recursive: true, force: true });
  reachLines.push(`\nReach: ${r.problems.length ? "not stored, the lint fails" : r.file}; report ${join(out, "clean", "reach.md")}`,
    ...r.md.split("\n").slice(2, 8),
    ...r.warnings.map((w) => `Warning: ${w}`),
    // An id a mutation's rows break, or a known coupling, outside its reach: the matrix runs the rows'
    // ids anyway, but a known coupling outside reach is no longer seen. Study it.
    ...r.misses.filter((x) => x.source === "own" || x.source === "known")
      .map((x) => `Warning: ${x.mutation} does not reach ${x.id} (${x.source === "own" ? "an id its rows break" : "a known coupling"})`));
  return r;
}

// `--full` keeps the clean run in the queue with every mutation; skipping runs it first, alone, since
// its coverage is part of the reach every mutation reads.
const queue = mutations.filter((m) => full || m !== "clean");
if (!full) {
  const cleanRun = await runOne("clean", 0, ids);
  const unclean = cleanRun?.rows && ids.filter((id) => cleanRun.rows.find((x) => x.id === id)?.state !== "pass");
  if (unclean?.length) {
    // No mutation is judged against a clean build that fails: stop before running any.
    console.error(`The clean build fails ${unclean.join(", ")}, so the matrix stops before its mutations. Reports: ${out}`);
    console.log("The matrix does not pass.");
    process.exit(1);
  }
  let r;
  try {
    r = collect(cleanRun);
  } catch (err) {
    console.error(`The reach could not be recorded (${err instanceof Error ? err.message : err}), so the matrix refuses to skip. `
      + "Fix it, or run with --full.");
    console.log("The matrix does not pass.");
    process.exit(1);
  }
  if (!r || r.problems.length) {
    console.error(!r ? "The clean run wrote no report, so there is no reach: the matrix refuses to skip. Rerun it, or run with --full."
      : `The reach lint fails, so the matrix refuses to skip (fix the sites, or run with --full):\n${r.problems.join("\n")}`);
    console.log("The matrix does not pass.");
    process.exit(1);
  }
  reach = r.reach;
  if (scope) {
    // The scope maps sites in the sources; the reach holds them as built. Without as many, it cannot be trusted.
    const next = afterReach({ scope, siteCounts: changed.siteCounts, reachSites: reach.sites, declared, only, base: changedBase });
    if (next.lines.length) {
      scope = next.scope;
      console.log(next.lines.join("\n"));
      mutations = ["clean", ...next.mutations];
      queue.splice(0, queue.length, ...next.mutations);
    }
  }
  for (const m of queue) ran.set(m, new Set(reachedIds({ ids, reach: reach.reach, manifest, mutation: m })));
}

await Promise.all(Array.from({ length: Math.max(1, jobs) }, async (_, lane) => {
  for (let m = queue.shift(); m !== undefined; m = queue.shift()) {
    const report = await runOne(m, lane, ran.has(m) ? ids.filter((id) => ran.get(m).has(id)) : ids);
    if (m === "clean") {
      // In a full matrix the reach is a record beside the run: its failure must not cost the verdict.
      try {
        collect(report);
      } catch (err) {
        reachLines.push(`\nWarning: the reach was not recorded: ${err instanceof Error ? err.message : err}`);
        rmSync(join(out, "clean", "coverage"), { recursive: true, force: true });
      }
    }
  }
}));

const graded = mutations.filter((m) => m !== "clean");
const { problems, lines } = verdict({ mutations, results, manifest, ids, known, ...(full ? {} : { ran }) });
if (reachLines.length) console.log(reachLines.join("\n"));
console.log(lines.length > 3 ? lines.join("\n") : "\nNo mutation fails an id outside its row.");
console.log(`\nReports: ${out}`);
const mode = full ? "full: every graded id under every mutation"
  : `${scope ? `${scopeClause(scope, changedBase, graded.length)}, ` : ""}skipping by reach: each mutation ran its reach and its rows' ids (build ${reach.build.slice(0, 12)}, ${reach.runs} clean run(s) in the union); a skipped id is reported skipped, never passed`;
console.log(`Mode: ${mode}.`);
// Where the time went (the profile of `tools/heavy.sh`, so far, when it runs under one).
const so = process.env.GALATEA_PROFILE_DIR && join(process.env.GALATEA_PROFILE_DIR, "summary-so-far.txt");
const profile = so && existsSync(so) ? readFileSync(so, "utf8").trim().split("\n") : [];
const checks = full ? [] : graded.map((m) => ({ mutation: m, ran: ran.get(m).size, of: ids.length }));
console.log(timingLines({ wallMs: Date.now() - t0, runs: timed, lanes: Math.max(1, jobs), profile, checks }).join("\n"));
if (problems.length) {
  console.error(`\n${problems.join("\n")}`);
  console.log("The matrix does not pass.");
  process.exit(1);
}
console.log(passLine({ full, scope, base: changedBase, runs: mutations.length, ids: ids.length, graded: graded.length }));
