import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, status } from "./safe-home.js";

// covers: GA-WIT-1 across a crash: a verdict and its watch's delete commit together, and a watch whose
// step's verdict is kept is never judged again (the 7b preflight's M2, its probe kept: on the spike's
// head the verdict committed apart from the delete, and a restart judged the step a second time).

const temp = { id: "temp", stableIdentifier: "test:temp", transport: "radio", capabilities: ["sensor"], sensorKeys: ["temperature"], actions: [],
  feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", otherAdmins: [] };
type Home = Awaited<ReturnType<typeof home>>;
type Db = Awaited<ReturnType<typeof memoryDb>>;
const ids = [...DEVICES, heater, temp].map((d) => d.id);
const at = (m: Home) => new Date(m.clock.now()).toISOString();
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
async function advance(m: Home, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5000) {
    m.clock.advance(Math.min(5000, left));
    online(m);
    await flush();
  }
}
/** A heater's turn_on witnessed by the thermometer, which rises: the verdict is due 60 s after dispatch. */
async function witnessedOn(db: Db) {
  const m = await home({ db: lasting(db), extra: [heater, temp] });
  body(await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:temp",
    expect: "rises", within_s: 60 } }]));
  online(m);
  m.report("temp", { temperature: 20 });
  await flush();
  const r = await m.apply("hall:heater", "onoff.turn_on", { token: true });
  await flush();
  m.ack(m.sent.find((x) => x.device === "heater")!, "confirmed");
  await advance(m, 30_000);
  m.report("temp", { temperature: 22 });
  await m.store.settled();
  return { m, r };
}
async function restarted(m: Home, db: Db) {
  const again = await home({ db, fresh: false, extra: [heater, temp], at: m.clock.now() });
  again.send("devices", { devices: [...DEVICES, heater, temp] }, true);
  again.a.listening("hall");
  online(again);
  return again;
}
const stored = async (db: Db, applyId: string) =>
  (await db.query<{ outcomes: { witness?: { verdict: string } }[] }>("SELECT outcomes FROM applies WHERE apply_id = $1", [applyId])).rows[0]!.outcomes[0]!;

describe("a witness's verdict across a crash (GA-WIT-1)", () => {
  it("commits a verdict with its watch's delete, or neither", async () => {
    const db = await memoryDb();
    const { m, r } = await witnessedOn(db);
    // The watch's delete fails: the verdict, in its write set, does not commit apart from it.
    db.trouble.failOn = /DELETE FROM witness_watches/;
    await advance(m, 31_000);
    await vi.waitFor(() => expect(m.store.down).toBe(true));
    expect((await stored(db, r.apply_id)).witness).toBeUndefined();
    m.a.stop();
  });

  it("never judges again a step whose verdict was kept, its watch's row left behind", async () => {
    const db = await memoryDb();
    const { m, r } = await witnessedOn(db);
    const [row] = (await db.query<Record<string, unknown>>("SELECT * FROM witness_watches")).rows;
    await advance(m, 31_000);
    await m.store.settled();
    expect((await stored(db, r.apply_id)).witness?.verdict).toBe("confirmed");
    // A watch's row left behind by a lost delete.
    await db.query("INSERT INTO witness_watches (apply_id, step_id, run, target, action, witness, due_ms) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [row!.apply_id, row!.step_id, JSON.stringify(row!.run), row!.target, row!.action, JSON.stringify(row!.witness), row!.due_ms]);
    m.a.stop();
    await m.store.close();
    const again = await restarted(m, db);
    await advance(again, 5000);
    await again.store.settled();
    const kept = body(await again.a.call(again.a.caller("h-credential"), "outcome", { apply_id: r.apply_id }));
    expect(kept.outcomes[0].witness?.verdict).toBe("confirmed");
    expect((await db.query("SELECT 1 FROM witness_watches")).rows).toEqual([]);
  });
});
