import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain script beside the build, without types
import { checkPartial, LEFT } from "../scripts/partial.mjs";

const graded = JSON.parse(readFileSync(new URL("../graded-ids.json", import.meta.url), "utf8"));
const row = (id: string, covers: string) => ({ id, state: "pass", covers });

describe("the record of partly graded ids", () => {
  it("lists only graded ids, each with the clauses left", () => {
    expect(checkPartial(graded.ids, graded.partial, [])).toEqual([]);
    expect(checkPartial(["GA-A-1"], { "GA-B-1": ["x"] }, [])).toEqual(["GA-B-1 is listed as partly graded but is not a graded id"]);
    expect(checkPartial(["GA-A-1"], { "GA-A-1": [] }, [])).toEqual(["GA-A-1 is listed as partly graded with no clause left"]);
  });

  it("fails an id claimed whole whose test says clauses are left, and one listed partial whose test says none", () => {
    expect(LEFT.test("applied inline is slice 2b's")).toBe(true);
    expect(checkPartial(["GA-A-1"], {}, [row("GA-A-1", "leases are slice 3's")]))
      .toEqual(["GA-A-1 is claimed whole, but its test leaves clauses: leases are slice 3's"]);
    expect(checkPartial(["GA-A-1"], { "GA-A-1": ["leases (3)"] }, [row("GA-A-1", "every clause")]))
      .toEqual(["GA-A-1 is listed as partly graded, but its test names no clause left"]);
    expect(checkPartial(["GA-A-1"], { "GA-A-1": ["leases (3)"] }, [row("GA-A-1", "leases are slice 3's")])).toEqual([]);
  });
});
