// The start's two phases are each taken once, in order (the 7a preflight's M1: a second `resume` moved
// `revision` back to what `load` read; its probe, inverted, is the second test here).
import { describe, expect, it } from "vitest";
import { Applier, type ToolResult } from "../src/applier.js";
import { Store } from "../src/core/store.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const OWNER = "owner-credential";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

async function fresh() {
  const clock = new FakeClock();
  const store = await Store.open(await memoryDb(), clock, (err) => { throw err; });
  return new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1" });
}

describe("the start's phases", () => {
  it("loads only a new applier, and resumes only a loaded one", async () => {
    const a = await fresh();
    await expect(a.resume()).rejects.toThrow(/resume once new/);
    await a.load();
    await expect(a.load()).rejects.toThrow(/load once loaded/);
    await a.resume();
    await expect(a.load()).rejects.toThrow(/load once resumed/);
    a.stop();
  });

  it("refuses a second resume, which leaves the revision where configure moved it", async () => {
    const a = await fresh();
    await a.start();
    const owner = a.caller(OWNER);
    const { revision } = body(await a.call(owner, "describe", {}));
    body(await a.call(owner, "configure", { changes: [{ op: "upsert", kind: "client", value: { id: "h", credential: "h-credential", kind: "steward" } }],
      expected_revision: revision, dry_run: false }));
    const moved = body(await a.call(owner, "describe", {})).revision;
    expect(moved).toBeGreaterThan(revision);
    await expect(a.resume()).rejects.toThrow(/resume once resumed/);
    expect(body(await a.call(owner, "describe", {})).revision).toBe(moved);
    a.stop();
  });
});
