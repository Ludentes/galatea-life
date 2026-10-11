import { describe, expect, it } from "vitest";
import { EventFeed, waitForTarget } from "../src/poll.js";
import { fakeDeps, ok, refused } from "./fakes.js";

describe("EventFeed", () => {
  it("takes the cursor before anything happens, then reads only what came after it", async () => {
    const a = fakeDeps();
    a.applier.feed({ what: "joined", device: "before" });
    const feed = await EventFeed.start(a.applier);
    expect(a.applier.calls).toEqual([{ tool: "events", args: {} }]);
    a.applier.feed({ what: "joined", device: "after" });
    const got = await feed.next(5);
    expect(got.map((e) => e.device)).toEqual(["after"]);
    expect(a.applier.calls[1]).toEqual({ tool: "events", args: { cursor: "1", wait_s: 5 } });
    expect(await feed.next(0)).toEqual([]);
    expect(a.applier.calls[2].args.cursor).toBe("2");
  });

  it("bounds its wait to 0..30 s, as the applier takes it", async () => {
    const a = fakeDeps();
    const feed = await EventFeed.start(a.applier);
    await feed.next(90);
    await feed.next(-3);
    expect(a.applier.calls.slice(1).map((c) => c.args.wait_s)).toEqual([30, 0]);
  });

  it("throws a refusal (an expired cursor) as the applier's", async () => {
    const a = fakeDeps();
    const feed = await EventFeed.start(a.applier);
    a.applier.queue("events", refused("cursor_expired", "gone"));
    await expect(feed.next(1)).rejects.toThrow(/the applier refused events: cursor_expired: gone/);
  });
});

describe("waitForTarget", () => {
  it("answers at once when the model it has already holds the target", async () => {
    const a = fakeDeps();
    const r = await waitForTarget(a.steward, a.deps.now, { until: a.deps.now() + 30_000, found: (m) => m.targets.find((t: { id: string }) => t.id === "sim-bridge:lamp") });
    expect(r.value?.id).toBe("sim-bridge:lamp");
    expect(r.revision).toBe(10);
    expect(a.steward.calls).toEqual([{ tool: "describe", args: {} }]);
  });

  it("reads once without waiting, then long-polls on the revision it last read until the target shows, the wait bounded by what is left (review I2)", async () => {
    const a = fakeDeps();
    const start = a.deps.now();
    a.steward.queue("describe", () => ok({ revision: 10, targets: [] }), () => {
      a.clock.advance(3000);
      return ok({ revision: 11, targets: [] });
    }, () => ok({ revision: 12, targets: [{ id: "x", adopted: true }] }));
    const r = await waitForTarget(a.steward, a.deps.now, { until: start + 20_000, found: (m) => m.targets.find((t: { adopted: boolean }) => t.adopted) });
    expect(r.value).toEqual({ id: "x", adopted: true });
    expect(a.steward.calls.map((c) => c.args)).toEqual([{}, { since_revision: 10, wait_s: 20 }, { since_revision: 11, wait_s: 17 }]);
  });

  it("gives up at its deadline with no value, and never waits past 30 s in one call", async () => {
    const a = fakeDeps();
    const start = a.deps.now();
    const r = await waitForTarget(a.steward, a.deps.now, { until: start + 45_000, found: () => undefined });
    expect(r.value).toBeUndefined();
    expect(a.deps.now() - start).toBe(45_000);
    expect(a.steward.calls.map((c) => c.args.wait_s)).toEqual([undefined, 30, 15]);
  });
});
