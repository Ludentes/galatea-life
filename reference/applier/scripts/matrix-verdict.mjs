// The full matrix's verdict, apart from running it, so it can be unit-tested (test/matrix-verdict.test.ts).
//
// Under each mutation it requires what the conformance script's negatives phase does, so a run of the
// matrix can stand for both: every graded id the mutation's manifest rows break fails, and fails in the
// test's body (`caught`), not because the subject did not start, set up or stay up. It also keeps the
// matrix's own check, which negatives cannot make: no graded id fails outside the mutation's row (the
// ids it breaks and their coupled ids) unless `known-outside.json` lists it. The clean build must pass
// every graded id. A failure that did not come from a test's body (the subject did not start, set up or
// stay up) is reported as a setup failure, never as the subject's behaviour, and fails the matrix too.
//
// A proposed row that names a `clause` grades a clause proposed for the next revision, which the
// standard's text does not yet require: the harness records it on the id's row (`proposed`) and it
// never fails the id. Such a mutation is caught when the clause is recorded not held on each id it
// breaks, the id itself passing; the clean build must hold every proposed clause it is graded on.

/** The ids a mutation may fail: those its rows break, and their coupled ids. */
export function scope(manifest, m) {
  const rows = manifest.filter((r) => (r.negative_subjects ?? []).some((s) => s.subject === m));
  return new Set(rows.flatMap((r) => [r.id, ...r.negative_subjects.filter((s) => s.subject === m).flatMap((s) => s.coupled)]));
}

/** The proposed clause a mutation is graded by on row `r`, or undefined when it breaks the row itself. */
const clauseOf = (r, m) => r.negative_subjects.find((s) => s.subject === m)?.clause;

/** The ids a mutation's rows break. */
export function broken(manifest, m) {
  return manifest.filter((r) => (r.negative_subjects ?? []).some((s) => s.subject === m)).map((r) => r.id);
}

/**
 * The ids a skipping matrix runs under `mutation` (docs/guides/2026-10-05-how-builds-are-checked.md,
 * *Skipping by reach*): those in its reach, every id its rows break or couple, and any id the reach
 * does not hold (a check no covered clean run measured), in the order of `ids`.
 */
export function reachedIds({ ids, reach, manifest, mutation }) {
  const s = scope(manifest, mutation);
  return ids.filter((id) => !(id in reach) || reach[id].includes(mutation) || s.has(id));
}

/** The report's rows with each graded id not in `ran` marked `skipped`: a skipped id is never a pass. */
export function markSkipped(rows, ids, ran) {
  const kept = rows.filter((r) => ran.has(r.id) || !ids.includes(r.id));
  return [...kept, ...ids.filter((id) => !ran.has(id)).map((id) => ({ id, state: "skipped" }))];
}

/**
 * `results` maps each run (`clean` or a mutation) to its report's rows, or to undefined when the run
 * wrote no report. `ran`, in a skipping matrix, maps a mutation to the ids it ran; its other ids are
 * skipped, neither passed nor failed, but an id its rows break is graded whether run or not (a skipped
 * one is not caught), so the rows are never weakened. Returns the problems (the matrix fails on any)
 * and the table of failures outside a row.
 */
export function verdict({ mutations, results, manifest, ids, known, ran }) {
  const problems = [];
  const lines = ["", "| Mutation | Outside its row | Known | New |", "|---|---|---|---|"];
  for (const m of mutations) {
    const rows = results.get(m);
    if (rows === undefined) {
      problems.push(`${m}: the harness wrote no report`);
      continue;
    }
    const row = (id) => rows.find((r) => r.id === id);
    const runIds = ran?.get(m) ? ids.filter((id) => ran.get(m).has(id)) : ids;
    const failed = runIds.filter((id) => row(id)?.state !== "pass");
    const inBody = (id) => row(id)?.state === "fail" && row(id)?.caught === true;
    const why = (list) => list.map((id) => `${id}: ${row(id)?.error ?? row(id)?.state ?? "no row"}`).join("; ");
    const setup = (list) => `${m === "clean" ? "the clean build" : m}: ${list.join(", ")} failed in setup, not in the test's body (${why(list)})`;
    const breaks = (id, clause) => (row(id)?.proposed ?? []).some((c) => c.clause === clause && c.held === false);
    if (m === "clean") {
      const behaviour = failed.filter(inBody);
      const notBody = failed.filter((id) => !inBody(id));
      if (behaviour.length) problems.push(`the clean build fails ${behaviour.join(", ")}`);
      if (notBody.length) problems.push(setup(notBody));
      const unheld = ids.flatMap((id) => (row(id)?.proposed ?? []).filter((c) => c.held === false).map((c) => `${id}'s ${c.clause}`));
      if (unheld.length) problems.push(`the clean build does not hold the proposed clauses ${unheld.join(", ")}`);
      continue;
    }
    const s = scope(manifest, m);
    const outsideAll = failed.filter((id) => !s.has(id));
    const notBody = outsideAll.filter((id) => !inBody(id));
    if (notBody.length) problems.push(setup(notBody));
    const outside = outsideAll.filter(inBody);
    const fresh = outside.filter((id) => !(known[m] ?? []).includes(id));
    if (outside.length) lines.push(`| \`${m}\` | ${outside.join(", ")} | ${outside.filter((id) => !fresh.includes(id)).join(", ") || "none"} | ${fresh.join(", ") || "none"} |`);
    if (fresh.length) problems.push(`${m} fails ${fresh.join(", ")}, outside its row and not known`);
    const graded = broken(manifest, m).filter((id) => ids.includes(id));
    if (!graded.length) {
      problems.push(`${m} breaks no graded id, so the matrix cannot show it caught`);
      continue;
    }
    const byClause = graded.filter((id) => clauseOf(manifest.find((r) => r.id === id), m) !== undefined);
    const unbroken = byClause.filter((id) => !breaks(id, clauseOf(manifest.find((r) => r.id === id), m)));
    if (unbroken.length) {
      problems.push(`${m} is not caught: ${unbroken.map((id) => `${id} holds or never judged its proposed clause `
        + clauseOf(manifest.find((r) => r.id === id), m)).join(", ")}`);
    }
    // A clause never fails its id: the mutation must pass each id it is graded on by a clause (the 7b preflight's M4).
    const failing = byClause.filter((id) => row(id)?.state !== "pass");
    if (failing.length) problems.push(`${m} fails ${failing.join(", ")}, which it is graded on by a proposed clause only: ${why(failing)}`);
    const byState = graded.filter((id) => !byClause.includes(id));
    const still = byState.filter((id) => row(id)?.state !== "fail");
    if (still.length) problems.push(`${m} is not caught: it still passes ${still.join(", ")}`);
    const stopped = byState.filter((id) => row(id)?.state === "fail" && row(id)?.caught !== true);
    if (stopped.length) {
      problems.push(`${m} is not caught: ${stopped.join(", ")} failed outside the test's body (${stopped
        .map((id) => row(id)?.error ?? "no error").join("; ")}), which proves nothing there`);
    }
  }
  return { problems, lines };
}

/**
 * The manifest with the rows `proposed-rows.json` proposes for the next applier revision: each
 * mutation added to the rows of the ids it breaks, so the matrix grades it as the standard's own. A
 * row naming an id the manifest lacks, or a mutation the standard already names, is a mistake. A row
 * naming a `clause` is graded by that proposed clause, not by the id's pass or fail (the controller's
 * ruling, 2026-10-05: a clause the text does not yet hold never fails the id).
 */
export function withProposed(manifest, proposed) {
  const named = new Set(manifest.flatMap((r) => (r.negative_subjects ?? []).map((s) => s.subject)));
  const out = manifest.map((r) => ({ ...r, negative_subjects: [...(r.negative_subjects ?? [])] }));
  for (const p of proposed.rows ?? []) {
    if (named.has(p.mutation)) throw new Error(`${p.mutation} is already a row of the standard: list it in subject.json`);
    for (const id of p.breaks) {
      const row = out.find((r) => r.id === id);
      if (!row) throw new Error(`${p.mutation} breaks ${id}, which the manifest does not hold`);
      row.negative_subjects.push({ subject: p.mutation, coupled: p.coupled ?? [], ...(p.clause !== undefined ? { clause: p.clause } : {}) });
    }
  }
  return out;
}
