import { describe, expect, it } from "vitest";
import { MUTATIONS } from "../src/bridge.js";
import { bridgeMutationOptions, claimed, mutationFromEnv, UNCLAIMED_MUTATIONS } from "../src/mutation.js";
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

  it("takes the build's own mutations under a run, and keeps them out of subject.json and the core's", async () => {
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "marks-a-battery-device-dead" }))
      .toEqual({ mutation: "marks-a-battery-device-dead" });
    expect(mutationFromEnv({ GALATEA_MUTATION: "marks-a-battery-device-dead" })).toHaveProperty("refused");
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "leaves-a-reading-unmarked" }))
      .toEqual({ mutation: "leaves-a-reading-unmarked" });
    expect(mutationFromEnv({ GALATEA_MUTATION: "leaves-a-reading-unmarked" })).toHaveProperty("refused");
    const { readFileSync } = await import("node:fs");
    const subject = JSON.parse(readFileSync(new URL("../subject.json", import.meta.url), "utf8")) as { mutations: string[] };
    for (const m of UNCLAIMED_MUTATIONS) {
      expect(subject.mutations).not.toContain(m);
      expect(MUTATIONS).not.toContain(m);
      expect(claimed(m)).toBe(false);
    }
    expect(claimed("skips-seq")).toBe(true);
  });

  it("refuses a doer's mutation under the scripted doer, which would ignore them (the review, M4)", () => {
    const env = { GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "marks-a-battery-device-dead" };
    expect(mutationFromEnv(env, true)).toEqual({
      refused: "GALATEA_MUTATION marks-a-battery-device-dead is honoured only by the herdsman doer, not the scripted one" });
    expect(mutationFromEnv(env, false)).toEqual({ mutation: "marks-a-battery-device-dead" });
    // A claimed mutation is the core's, honoured under either doer.
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "skips-seq" }, true)).toEqual({ mutation: "skips-seq" });
    expect(mutationFromEnv({ GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "leaves-a-reading-unmarked" }, true)).toEqual({ mutation: "leaves-a-reading-unmarked" });
  });

  it("hands the core a claimed mutation as `mutation`, the build's own as its option, and nothing for none", () => {
    expect(bridgeMutationOptions(undefined)).toEqual({});
    expect(bridgeMutationOptions("skips-seq")).toEqual({ mutation: "skips-seq" });
    expect(bridgeMutationOptions("leaves-a-reading-unmarked")).toEqual({ leavesReadingsUnmarked: true });
    expect(bridgeMutationOptions("marks-a-battery-device-dead")).toEqual({});
    for (const m of UNCLAIMED_MUTATIONS) expect(bridgeMutationOptions(m)).not.toHaveProperty("mutation");
  });

  it("lists the link's mutations among the build's, so the entry point accepts them", () => {
    for (const m of LINK_MUTATIONS) expect(MUTATIONS).toContain(m);
  });
});
