import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { proofOf } from "../src/gate/token.js";

// The applier keeps its own copy of the token's proof until it moves onto @ludentes/galatea-life-binding; until then
// its proof must agree with the binding's vectors on every case. (Moved here from the binding's tests,
// so the binding's package is tested without this build.)
type Case = { name: string; key: string; unsigned: unknown; proof: string };
const vectors = createRequire(import.meta.url).resolve("@ludentes/galatea-life-binding/vectors/token.json");
const { cases } = JSON.parse(readFileSync(vectors, "utf8")) as { cases: Case[] };

describe("the applier's token proof against the binding's vectors", () => {
  it("has vectors to check", () => expect(cases.length).toBeGreaterThanOrEqual(3));

  for (const c of cases) {
    it(`agrees with the binding's proof: ${c.name}`, () => {
      expect(proofOf(c.unsigned as never, c.key)).toBe(c.proof);
    });
  }
});
