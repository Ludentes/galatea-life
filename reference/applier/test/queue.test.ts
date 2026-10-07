import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/core/queue.js";

describe("SerialQueue", () => {
  it("runs tasks one at a time, in arrival order, even across awaits", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    const a = q.run(async () => { log.push("a1"); await new Promise((r) => setTimeout(r, 20)); log.push("a2"); });
    const b = q.run(() => { log.push("b"); });
    await Promise.all([a, b]);
    expect(log).toEqual(["a1", "a2", "b"]);
  });

  it("keeps running after a task throws, and gives the throw to its caller", async () => {
    const q = new SerialQueue();
    await expect(q.run(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await q.run(() => 7)).toBe(7);
  });
});
