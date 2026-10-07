import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaRoot } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import { vocabulary } from "../src/vocabulary.js";

const read = (p: string) => JSON.parse(readFileSync(join(schemaRoot, p), "utf8"));

describe("the vocabulary (review M7)", () => {
  it("is the standard's schemas', not a copy", () => {
    const v = vocabulary();
    expect(v.classes).toEqual(read("common.json").$defs.deviceClass.enum);
    expect(v.tiers).toEqual(read("common.json").$defs.tier.enum);
    expect(v.bridgeId.source).toBe(read("applier/configure.bridge.json").properties.id.pattern);
    expect(v.identity.source).toBe(read("applier/configure.bridge.json").properties.identity.pattern);
  });
});
