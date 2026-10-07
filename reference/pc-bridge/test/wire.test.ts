import { describe, expect, it } from "vitest";
import { refusedFilters } from "../src/wire.js";

describe("refusedFilters", () => {
  it("names only the filters whose reason code is a refusal", () => {
    expect(refusedFilters(["a/+", "b/#"], [1, 0x87])).toEqual(["b/#"]);
  });

  it("names none when every filter was granted", () => {
    expect(refusedFilters(["a/+", "b/#"], [0, 1])).toEqual([]);
  });

  it("counts a filter the SUBACK gave no code for as refused", () => {
    expect(refusedFilters(["a/+", "b/#"], [1])).toEqual(["b/#"]);
  });
});
