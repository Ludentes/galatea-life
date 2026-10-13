import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { MUTATIONS, type Mutation } from "../src/mutations.js";

/** A conforming scenario, by its name: what it observes, run as the conforming build when given no mutation. */
export type Scenario<O> = (mutation?: Mutation) => O | Promise<O>;

/**
 * A negative subject's case (R-35): the named conforming scenario its own test runs and asserts, run
 * again under `mutation`, a declared one, returning what it observes there. Each case is then one line,
 * its scenario's last assertion inverted; no test body is copied.
 */
export async function underMutation<O>(scenario: Scenario<O>, mutation: Mutation): Promise<O> {
  expect(MUTATIONS).toContain(mutation);
  return await scenario(mutation);
}

/** The mutations of steward's `subject.json`, which the matrix runs. */
export const SUBJECT_MUTATIONS: string[] = JSON.parse(readFileSync(new URL("../subject.json", import.meta.url), "utf8")).mutations;

/** Where a subject's mutated-against-conforming case already is: a test file and the title of its test. */
export interface Pointer { file: string; it: string }

/**
 * Checks pointers to the tests that already run a mutation against its conforming build: each named
 * test is in its file, and its body runs the mutation (hands it on as `mutation: "…"`, an argument or a
 * table's entry), not merely mentions it.
 */
export function coveredIn(pointers: Partial<Record<Mutation, Pointer>>): void {
  for (const [m, p] of Object.entries(pointers)) {
    const text = readFileSync(new URL(p.file, import.meta.url), "utf8");
    const title = `it(${JSON.stringify(p.it)}`;
    const at = text.indexOf(title);
    expect(at, `${m}: no test "${p.it}" in ${p.file}`).toBeGreaterThanOrEqual(0);
    const rest = text.slice(at + title.length);
    const next = rest.search(/\n\s*(it|describe)\(/);
    expect(next < 0 ? rest : rest.slice(0, next), `${m} run in "${p.it}"`).toMatch(new RegExp(`(mutation: |, |\\[)"${m}"`));
  }
}
