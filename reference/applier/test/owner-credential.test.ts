import { describe, expect, it } from "vitest";
import { Applier, type ToolResult } from "../src/applier.js";
import { Store } from "../src/core/store.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

// The whole-applier review's M7: the owner's credential is 16 characters at least, and no client is
// ever taken for the owner, a rotation of the owner's to a stored client's credential included.

const OWNER = "owner-credential";
const CLIENT = "client-credential-01";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

async function open(db: Awaited<ReturnType<typeof memoryDb>>, ownerCredential: string) {
  const clock = new FakeClock();
  const store = await Store.open(db, clock, (err) => { throw err; });
  return { store, a: new Applier({ store, clock, ownerCredential, applierId: "demo-applier", runId: "run-1" }) };
}

describe("the owner's credential", () => {
  it("is refused under 16 characters", async () => {
    await expect(open(await memoryDb(), "fifteen-chars-x")).rejects.toThrow(/shorter than 16 characters/);
    await expect(open(await memoryDb(), "sixteen-chars-xy")).resolves.toBeDefined();
  });

  it("is refused at start when a stored client holds it, and a client is never taken for the owner", async () => {
    const db = await memoryDb();
    const first = await open(lasting(db), OWNER);
    await first.a.start();
    const owner = first.a.caller(OWNER);
    const { revision } = body(await first.a.call(owner, "describe", {}));
    body(await first.a.call(owner, "configure", { expected_revision: revision, dry_run: false,
      changes: [{ op: "upsert", kind: "client", value: { id: "h", credential: CLIENT, kind: "steward" } }] }));
    await first.store.settled();
    first.a.stop();
    await first.store.close();
    // The owner rotated to the client's credential: the start is refused, naming the client and not the secret.
    const rotated = await open(lasting(db), CLIENT);
    const refused = await rotated.a.start().then(() => undefined, (err: unknown) => err as Error);
    expect(refused?.message).toMatch(/the owner's credential is the one client h holds/);
    expect(refused?.message).not.toContain(CLIENT);
    rotated.a.stop();
    // Were both ever to hold one bearer, it is no one's: never the owner.
    const again = await open(db, OWNER);
    await again.a.start();
    (again.a as unknown as { o: { ownerCredential: string } }).o.ownerCredential = CLIENT;
    expect(again.a.caller(CLIENT)).toEqual({ kind: "anonymous" });
  });
});
