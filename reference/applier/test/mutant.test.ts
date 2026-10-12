import { describe, expect, it } from "vitest";
import { Mutant, MUTATIONS, mutantOf } from "../src/mutations.js";

// The mutation as the build reads it: a frozen record of flags, one per mutation (the reach lint finds
// each mutation's sites by its flag, `mutant.<flag>`).
describe("the mutant record", () => {
  it("holds one flag per mutation, every one false in Mutant.none, frozen", () => {
    expect(Object.keys(Mutant.none)).toHaveLength(MUTATIONS.length);
    expect(Object.values(Mutant.none).every((v) => v === false)).toBe(true);
    expect(Object.isFrozen(Mutant.none)).toBe(true);
    expect(Object.isFrozen(Mutant)).toBe(true);
  });

  it("sets only the mutation's flag, named in camel case", () => {
    const m = mutantOf("trusts-any-token");
    expect(Object.entries(m).filter(([, v]) => v)).toEqual([["trustsAnyToken", true]]);
    expect(mutantOf("speaks-only-2025").speaksOnly2025).toBe(true);
    expect(Object.isFrozen(m)).toBe(true);
    expect(mutantOf(undefined)).toEqual(Mutant.none);
  });
});
