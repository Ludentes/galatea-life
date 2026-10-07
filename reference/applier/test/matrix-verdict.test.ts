import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain script module, with no types.
import { markSkipped, reachedIds, verdict, withProposed } from "../scripts/matrix-verdict.mjs";

// A manifest of three rows: `m` breaks GA-A (GA-B coupled), `n` breaks GA-C, which is not graded.
const manifest = [
  { id: "GA-A", negative_subjects: [{ subject: "m", coupled: ["GA-B"] }] },
  { id: "GA-B", negative_subjects: [] },
  { id: "GA-C", negative_subjects: [{ subject: "n", coupled: [] }] },
  { id: "GA-D", negative_subjects: [] },
];
const ids = ["GA-A", "GA-B", "GA-D"];
type Row = { id: string; state: string; caught?: boolean; error?: string; proposed?: { clause: string; held: boolean; note: string }[] };
const pass = (id: string): Row => ({ id, state: "pass" });
const caught = (id: string): Row => ({ id, state: "fail", caught: true, error: "the body failed" });
const stopped = (id: string, error = "the subject was not ready in 30000 ms"): Row => ({ id, state: "fail", caught: false, error });
const judge = (runs: Record<string, Row[] | undefined>, known: Record<string, string[]> = {}) =>
  verdict({ mutations: Object.keys(runs), results: new Map(Object.entries(runs)), manifest, ids, known }).problems as string[];
const clean = [pass("GA-A"), pass("GA-B"), pass("GA-D")];

describe("the full matrix's verdict", () => {
  it("passes a clean build that passes and a mutation caught in its row's body, a coupled id failing too", () => {
    expect(judge({ clean, m: [caught("GA-A"), caught("GA-B"), pass("GA-D")] })).toEqual([]);
  });

  it("fails a clean build that fails an id, and a run with no report", () => {
    expect(judge({ clean: [pass("GA-A"), caught("GA-B"), pass("GA-D")], m: undefined })).toEqual([
      "the clean build fails GA-B", "m: the harness wrote no report"]);
  });

  it("reports an id failed outside the test's body as a setup failure, not as behaviour outside the row, and still fails", () => {
    const eaddr = "the subject exited (1) before it was ready";
    const problems = judge({ clean: [pass("GA-A"), stopped("GA-B", eaddr), pass("GA-D")],
      m: [caught("GA-A"), pass("GA-B"), stopped("GA-D", eaddr)] }, { m: ["GA-D"] });
    expect(problems).toEqual([
      `the clean build: GA-B failed in setup, not in the test's body (GA-B: ${eaddr})`,
      `m: GA-D failed in setup, not in the test's body (GA-D: ${eaddr})`]);
    const { lines } = verdict({ mutations: ["m"], results: new Map([["m", [caught("GA-A"), pass("GA-B"), stopped("GA-D")]]]), manifest, ids, known: {} });
    expect(lines.join("\n")).not.toMatch(/GA-D/);
  });

  it("fails a mutation that still passes an id its row breaks", () => {
    expect(judge({ clean, m: [pass("GA-A"), caught("GA-B"), pass("GA-D")] })).toEqual(["m is not caught: it still passes GA-A"]);
  });

  it("fails a mutation whose row's id failed outside the test's body: a subject that did not start proves nothing", () => {
    expect(judge({ clean, m: [stopped("GA-A"), pass("GA-B"), pass("GA-D")] })).toEqual([
      "m is not caught: GA-A failed outside the test's body (the subject was not ready in 30000 ms), which proves nothing there"]);
    // A row with no `caught` (a report from an older harness) is not taken as caught either.
    expect(judge({ clean, m: [{ id: "GA-A", state: "fail" }, pass("GA-B"), pass("GA-D")] })).toHaveLength(1);
  });

  it("fails a mutation that breaks no graded id", () => {
    expect(judge({ clean, n: clean })).toEqual(["n breaks no graded id, so the matrix cannot show it caught"]);
  });

  it("fails an id failed outside the row unless known-outside lists it", () => {
    const run = [caught("GA-A"), pass("GA-B"), caught("GA-D")];
    expect(judge({ clean, m: run })).toEqual(["m fails GA-D, outside its row and not known"]);
    expect(judge({ clean, m: run }, { m: ["GA-D"] })).toEqual([]);
  });
});

describe("skipping by reach", () => {
  // The reach: GA-D is reached by `m`; GA-B by nothing; GA-A by nothing (its row's id: run anyway).
  const reach = { "GA-A": [], "GA-B": [], "GA-D": ["m"] };

  it("runs a mutation's reach, every id its rows break or couple, and any id the reach does not hold", () => {
    expect(reachedIds({ ids, reach, manifest, mutation: "m" })).toEqual(["GA-A", "GA-B", "GA-D"]);
    expect(reachedIds({ ids, reach: { "GA-A": [], "GA-B": [], "GA-D": [] }, manifest, mutation: "m" })).toEqual(["GA-A", "GA-B"]);
    expect(reachedIds({ ids, reach: { "GA-A": [] }, manifest, mutation: "n" })).toEqual(["GA-B", "GA-D"]);
  });

  it("marks each id it did not run as skipped, never as passed", () => {
    expect(markSkipped([pass("GA-A"), { id: "GA-B", state: "untested" }], ids, new Set(["GA-A"]))).toEqual([
      pass("GA-A"), { id: "GA-B", state: "skipped" }, { id: "GA-D", state: "skipped" }]);
  });

  it("grades a mutation on the ids it ran: a skipped id is neither a failure nor a setup failure", () => {
    const ran = new Map([["m", new Set(["GA-A", "GA-B"])]]);
    const m = markSkipped([caught("GA-A"), pass("GA-B")], ids, ran.get("m")!);
    expect(verdict({ mutations: ["clean", "m"], results: new Map([["clean", clean], ["m", m]]), manifest, ids, known: {}, ran }).problems).toEqual([]);
  });

  it("still fails a mutation whose row's id was skipped: the rows are never weakened", () => {
    const ran = new Map([["m", new Set(["GA-B"])]]);
    const m = markSkipped([pass("GA-B")], ids, ran.get("m")!);
    expect(verdict({ mutations: ["m"], results: new Map([["m", m]]), manifest, ids, known: {}, ran }).problems)
      .toEqual(["m is not caught: it still passes GA-A"]);
  });
});

describe("rows proposed for the next revision", () => {
  it("adds each proposed mutation to the rows it breaks, so the verdict grades it as a row of the standard", () => {
    const more = withProposed(manifest, { rows: [{ mutation: "p", breaks: ["GA-D"], coupled: [] }] });
    expect(more.find((r: { id: string }) => r.id === "GA-D").negative_subjects).toEqual([{ subject: "p", coupled: [] }]);
    // The manifest itself is not changed.
    expect(manifest.find((r) => r.id === "GA-D")!.negative_subjects).toEqual([]);
    const problems = verdict({ mutations: ["clean", "p"], results: new Map(Object.entries({ clean, p: [pass("GA-A"), pass("GA-B"), caught("GA-D")] })),
      manifest: more, ids, known: {} }).problems;
    expect(problems).toEqual([]);
  });

  it("grades a row naming a clause by that clause, never by the id's pass or fail: caught when it is not held, the clean build holding it", () => {
    const more = withProposed(manifest, { rows: [{ mutation: "q", breaks: ["GA-D"], coupled: [], clause: "same-id" }] });
    expect(more.find((r: { id: string }) => r.id === "GA-D").negative_subjects).toEqual([{ subject: "q", coupled: [], clause: "same-id" }]);
    const held = (ok: boolean): Row => ({ ...pass("GA-D"), proposed: [{ clause: "same-id", held: ok, note: "" }] });
    const run = (cleanD: Row, qD: Row) => verdict({ mutations: ["clean", "q"], results: new Map(Object.entries({
      clean: [pass("GA-A"), pass("GA-B"), cleanD], q: [pass("GA-A"), pass("GA-B"), qD] })), manifest: more, ids, known: {} }).problems;
    // The id passes under the mutation, its clause not held: caught.
    expect(run(held(true), held(false))).toEqual([]);
    // The clause held, or never judged: not caught.
    expect(run(held(true), held(true))).toEqual(["q is not caught: GA-D holds or never judged its proposed clause same-id"]);
    expect(run(held(true), pass("GA-D"))).toEqual(["q is not caught: GA-D holds or never judged its proposed clause same-id"]);
    // A clause never fails its id: the id failing under the mutation is a problem, its clause not held or not.
    const failed = (r: Row): Row => ({ ...r, state: "fail", caught: true, error: "e" });
    expect(run(held(true), failed(held(false)))).toEqual(["q fails GA-D, which it is graded on by a proposed clause only: GA-D: e"]);
    // The clean build must hold it; its pass alone is not enough.
    expect(run(held(false), held(false))).toEqual(["the clean build does not hold the proposed clauses GA-D's same-id"]);
  });

  it("refuses a proposed row for an id the manifest lacks, or a mutation the standard already names", () => {
    expect(() => withProposed(manifest, { rows: [{ mutation: "p", breaks: ["GA-Z"], coupled: [] }] })).toThrow(/GA-Z/);
    expect(() => withProposed(manifest, { rows: [{ mutation: "m", breaks: ["GA-D"], coupled: [] }] })).toThrow(/already/);
  });
});
