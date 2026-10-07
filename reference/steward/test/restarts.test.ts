import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS } from "./house.js";
import { eventsSince, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const iso = (ms: number) => new Date(ms).toISOString();
const live = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false }] } }, transports: [], latches: [] };

describe("the applier's events across a restart (slice 2b's preflight, M5)", () => {
  it("moves a step dispatched before the stop to the outcome the applier gave while the steward was down, read from its history at the start", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock, state: live });
    const applied = await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "m5" });
    expect(applied.outcomes.map((o: Body) => o.outcome)).toEqual(["dispatched"]);
    await a.pump();
    await quiet(a.store);
    a.steward.stop();
    await a.store.close();
    // While the steward is down, the step is acked: its outcome event is in the applier's history only.
    clock.advance(2_000);
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(clock.now()), cause: { apply: "applier-apply-1", client: "steward",
      for: { person: "olga", endpoint: "olga-app", apply: applied.apply_id } } });
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: iso(clock.now()) });
    clock.advance(5_000);
    const b = await setup({ db, clock, define: false, applier: a.applier, sync: false, fromNow: true });
    const begun = String((await b.ok(SECRETS.owner, "events")).cursor);
    // The restart's link: the gap since the last event the store kept, then the state.
    const missed = (await b.port.history({ from: iso(0), to: iso(clock.now()) })).events;
    b.steward.recover(missed, live, String(missed.at(-1)?.seq ?? 0));
    await quiet(b.store);
    const now = await b.ok(SECRETS.olga, "outcome", { apply_id: applied.apply_id });
    expect(now.outcomes.map((o: Body) => o.outcome)).toEqual(["acked"]);
    const relayed = (await eventsSince(b.ok, begun, "outcome")).filter((e) => e.apply_id === applied.apply_id);
    expect(relayed.map((e) => [e.step_id, e.outcome, e.recovered, e.cause])).toEqual([[applied.outcomes[0].step_id, "acked", true,
      { person: "olga", endpoint: "olga-app", apply: applied.apply_id }]]);
    expect(now.outcomes[0].time).toBe(relayed[0]!.time);
    // A repeat of the key returns the same, and sends nothing.
    expect(await b.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "m5" })).toEqual(now);
    expect(b.applier.applies).toHaveLength(1);
    // Kept so: a second restart reads it back acked.
    await quiet(b.store);
    b.steward.stop();
    await b.store.close();
    const c = await setup({ db, clock, define: false, applier: a.applier, state: live, fromNow: true });
    expect((await c.ok(SECRETS.olga, "outcome", { apply_id: applied.apply_id })).outcomes.map((o: Body) => o.outcome)).toEqual(["acked"]);
  });

  it("relays none of the applier's events twice when the kept position lags the events the store kept, as after a crash", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock, state: live });
    clock.advance(1_000);
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(clock.now()), cause: "device" });
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(clock.now()), cause: "device" });
    await a.pump();
    await quiet(a.store);
    a.steward.stop();
    await a.store.close();
    // The kept position as a crash may leave it: behind the events the store kept relayed.
    const last = JSON.parse((await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'applier_last'")).rows[0]!.value);
    await db.query("UPDATE meta SET value = $1 WHERE key = 'applier_last'", [JSON.stringify({ ...last, seq: last.seq - 2 })]);
    const b = await setup({ db, clock, define: false, applier: a.applier, sync: false, fromNow: true });
    const missed = (await b.port.history({ from: iso(0), to: iso(clock.now()) })).events;
    b.steward.recover(missed, live, String(missed.at(-1)?.seq ?? 0));
    await quiet(b.store);
    const kept = (await b.store.query<{ body: Body }>("SELECT body FROM events WHERE body ? 'applier_seq' ORDER BY seq")).rows.map((r) => r.body.applier_seq);
    expect(kept).toEqual([...new Set(kept)]);
    expect(kept.length).toBe(2);
  });

  it("reads again at a restart an orphan held unrelayed when it stopped, though later events moved the kept position past it (the code review, CR5)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock, state: live, options: { parkedCap: 2 } });
    // An apply whose answer is slow: its outcome event, of an apply not yet known, is held once the cap releases the batches.
    a.applier.emitsOutcomes = false;
    a.applier.answerGate = new Promise<void>(() => undefined);
    const applying = a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "cr5" });
    applying.catch(() => undefined);
    await vi.waitFor(() => expect(a.applier.applies).toHaveLength(1));
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked", time: iso(clock.now()) });
    const orphanSeq = 1;
    for (let i = 0; i < 3; i++) a.applier.emit({ type: "state", target: LAMP, key: "on", value: i % 2 === 0, time: iso(clock.now()), cause: "device" });
    await a.pump();
    await quiet(a.store);
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false, applier: a.applier, sync: false, fromNow: true });
    const begun = String((await b.ok(SECRETS.owner, "events")).cursor);
    expect(b.steward.lastApplierEvent()).toMatchObject({ seq: orphanSeq - 1 });
    const missed = (await b.port.history({ from: iso(0), to: iso(clock.now()) })).events;
    b.steward.recover(missed, live, String(missed.at(-1)?.seq ?? 0));
    await quiet(b.store);
    const outcomes = await eventsSince(b.ok, begun, "outcome");
    expect(outcomes.map((e) => [e.applier_seq, e.outcome, e.recovered])).toEqual([[orphanSeq, "acked", true]]);
    // Read and relayed once: the kept value names it no longer.
    expect(JSON.parse((await db.query<{ value: string }>("SELECT value FROM meta WHERE key = 'applier_last'")).rows[0]!.value).held).toBeUndefined();
  });

  it("never commits applier_last past the last relayed event row committed (the milestone 7+10+11 review, B1)", async () => {
    const base = lasting(await memoryDb());
    const ahead: string[] = [];
    let watching = false;
    const db = { ...base, async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const r = await base.transaction(fn);
      if (watching) {
        const meta = (await base.query<{ value: string }>("SELECT value FROM meta WHERE key = 'applier_last'")).rows[0];
        const kept = (await base.query<{ n: number | null }>("SELECT max((body->>'applier_seq')::int) AS n FROM events WHERE body ? 'applier_seq'")).rows[0]?.n ?? 0;
        if (meta) {
          const seq = JSON.parse(meta.value).seq as number;
          if (seq > Number(kept)) ahead.push(`applier_last ${seq}, last relayed row kept ${kept}`);
        }
      }
      return r;
    } };
    const clock = new FakeClock();
    const a = await setup({ db, clock, state: live });
    await quiet(a.store);
    watching = true;
    for (let i = 0; i < 20; i++) {
      a.applier.emit({ type: "state", target: LAMP, key: "on", value: i % 2 === 0, time: iso(clock.now()), cause: "device" });
    }
    await a.pump();
    await quiet(a.store);
    watching = false;
    a.steward.stop();
    await a.store.close();
    expect(ahead).toEqual([]);
    // And it moved: the last of them is kept.
    const meta = (await base.query<{ value: string }>("SELECT value FROM meta WHERE key = 'applier_last'")).rows[0];
    expect(JSON.parse(meta!.value).seq).toBe(20);
  });
});
