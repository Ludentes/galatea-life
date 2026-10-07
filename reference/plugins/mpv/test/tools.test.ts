import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TOOLS, toolHash } from "../src/tools.js";

describe("TOOLS", () => {
  it("are the four the manifest maps to actions", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["launch", "pause", "resume", "set_volume"]);
  });

  it("let launch take a title and a kind, and nothing else", () => {
    const launch = TOOLS.find((t) => t.name === "launch")!;
    const search = (launch.inputSchema.properties as Record<string, { properties: object; additionalProperties: boolean }>).search;
    expect(Object.keys(search.properties)).toEqual(["title", "kind"]);
    expect(search.additionalProperties).toBe(false);
    expect(launch.inputSchema).toMatchObject({ additionalProperties: false, required: ["search"] });
  });
});

describe("toolHash", () => {
  it("hashes the canonical JSON of the fields the standard names, in any key order", () => {
    const a = { name: "x", inputSchema: { type: "object" as const, properties: { b: {}, a: {} } }, description: "d" };
    const b = { description: "d", inputSchema: { properties: { a: {}, b: {} }, type: "object" as const }, name: "x" };
    const expected = createHash("sha256")
      .update('{"description":"d","inputSchema":{"properties":{"a":{},"b":{}},"type":"object"},"name":"x"}')
      .digest("hex");
    expect(toolHash(a)).toBe(expected);
    expect(toolHash(b)).toBe(expected);
  });

  it("ignores fields the standard does not name", () => {
    const t = { name: "x", inputSchema: { type: "object" as const } };
    expect(toolHash({ ...t, _meta: { v: 1 } } as typeof t)).toBe(toolHash(t));
  });

  it("changes when the description changes", () => {
    const t = { name: "x", inputSchema: { type: "object" as const }, description: "a" };
    expect(toolHash({ ...t, description: "b" })).not.toBe(toolHash(t));
  });
});
