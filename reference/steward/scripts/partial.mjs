// The record of partly graded ids (`graded-ids.json`'s `partial`): each id whose test grades some of
// its clauses, with the clauses left and the slice that grades them. A test's `covers` that names a
// later slice, or what is not built, must have an entry here, and an entry must have such a test, so
// a run cannot report an id whole while clauses of it are left.

/** The words in a `covers` that say clauses are left. */
export const LEFT = /slice \d|later slice|not built/i;

/** What is wrong with `partial` against the graded `ids` and the run's `rows` (none checked when empty). */
export function checkPartial(ids, partial = {}, rows = []) {
  const problems = [];
  for (const [id, left] of Object.entries(partial)) {
    if (!ids.includes(id)) problems.push(`${id} is listed as partly graded but is not a graded id`);
    else if (!Array.isArray(left) || !left.length || left.some((c) => typeof c !== "string" || !c)) {
      problems.push(`${id} is listed as partly graded with no clause left`);
    }
  }
  for (const r of rows) {
    if (!ids.includes(r.id) || typeof r.covers !== "string") continue;
    const says = r.covers.match(LEFT);
    if (says && !partial[r.id]) problems.push(`${r.id} is claimed whole, but its test leaves clauses: ${r.covers.slice(Math.max(0, r.covers.lastIndexOf(";", says.index) + 1)).trim()}`);
    if (!says && partial[r.id]) problems.push(`${r.id} is listed as partly graded, but its test names no clause left`);
  }
  return problems;
}
