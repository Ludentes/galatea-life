import { describe, expect, it } from "vitest";
import { MUTATIONS } from "../src/bridge.js";
import { mutationFromEnv } from "../src/mutation.js";
import { LINK_MUTATIONS } from "../src/transport.js";

describe("mutationFromEnv", () => {
  it("takes no mutation when none is set", () => {
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1" })).toEqual({});
  });

  it("takes a mutation this build implements under a run", () => {
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "ignores-snapshot" })).toEqual({ mutation: "ignores-snapshot" });
  });

  it("refuses a mutation without a run id, and one this build does not implement", () => {
    expect(mutationFromEnv({ GALATEA_MUTATION: "skips-seq" })).toEqual({
      refused: "GALATEA_MUTATION skips-seq is set without GALATEA_TEST_RUN_ID" });
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "frobs" })).toEqual({ refused: "no mutation frobs in this build" });
  });

  it("claims in subject.json exactly the mutations this build implements", async () => {
    const { readFileSync } = await import("node:fs");
    const subject = JSON.parse(readFileSync(new URL("../subject.json", import.meta.url), "utf8")) as { mutations: string[] };
    expect([...subject.mutations].sort()).toEqual([...MUTATIONS].sort());
  });

  it("lists the link's mutations among the build's, so the entry point accepts them", () => {
    for (const m of LINK_MUTATIONS) expect(MUTATIONS).toContain(m);
  });
});
