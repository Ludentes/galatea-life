import { describe, expect, it } from "vitest";
import { storable } from "../src/core/canonical.js";
import { migrate } from "../src/core/migrate.js";
import {
  dropLate, dropWaiting, forgetAssumed, HELD_MS, loadRecords, pruneRecords, releaseToken, saveApply, saveAssumed, saveLate, saveWaiting, useToken, type Late,
  type Waiting,
} from "../src/dispatch/records.js";
import { memoryDb } from "./db.js";

const NOW = Date.parse("2030-01-01T08:00:00Z");
const waiting: Waiting = {
  command_id: "c-1", apply_id: "a-1", step_id: "s1", target: "hall:lamp", action: "onoff.turn_on", args: {},
  bridge: "hall", bridge_device: "lamp", kind: { feedback: "closed", stateless: false, confirms: true },
  cause: { apply: "a-1", client: "h", for: { person: "demo" } }, dispatched_ms: NOW, bound_ms: NOW + 12_000, terminal: false,
};

describe("dispatch's records (GA-PERSIST-1)", () => {
  it("keeps held applies, waiting steps and used tokens, each write safe to run twice, and loads what still holds", async () => {
    const db = await memoryDb();
    await migrate(db);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) {
        await saveApply(tx, { apply_id: "a-1", client: "h", created_ms: NOW, outcomes: [{ step_id: "s1", target: "hall:lamp", outcome: "dispatched" }] });
        await saveApply(tx, { apply_id: "a-0", client: "h", created_ms: NOW - HELD_MS, outcomes: [] });
        await saveWaiting(tx, waiting, NOW + 13_000);
        await useToken(tx, "h", "t-1", NOW + HELD_MS);
        await useToken(tx, "h", "t-0", NOW);
      }
      await saveApply(tx, { apply_id: "a-1", client: "h", created_ms: NOW, outcomes: [{ step_id: "s1", target: "hall:lamp", outcome: "acked" }] });
    });
    const r = await loadRecords(db, NOW);
    expect(r.applies).toEqual([{ apply_id: "a-1", client: "h", created_ms: NOW, outcomes: [{ step_id: "s1", target: "hall:lamp", outcome: "acked" }] }]);
    expect(r.waiting).toEqual([{ w: waiting, deadline_ms: NOW + 13_000 }]);
    expect(r.used).toEqual([{ issuer: "h", token_id: "t-1", until_ms: NOW + HELD_MS }]);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) {
        await dropWaiting(tx, "c-1");
        await releaseToken(tx, "h", "t-1");
        await pruneRecords(tx, NOW);
      }
    });
    expect((await db.query("SELECT apply_id FROM applies")).rows).toEqual([{ apply_id: "a-1" }]);
    expect((await db.query("SELECT * FROM waiting")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM used_tokens")).rows).toEqual([]);
  });

  it("loads waiting steps in dispatch order, and prunes one its apply outlived (M8, M4)", async () => {
    const db = await memoryDb();
    await migrate(db);
    await db.transaction(async (tx) => {
      // Dispatched later, with a shorter bound: its deadline comes first, its dispatch second.
      await saveWaiting(tx, { ...waiting, command_id: "c-2", dispatched_ms: NOW + 1000, bound_ms: NOW + 3000 }, NOW + 4000);
      await saveWaiting(tx, waiting, NOW + 13_000);
      await saveWaiting(tx, { ...waiting, command_id: "c-old", dispatched_ms: NOW - 2 * HELD_MS }, NOW - 2 * HELD_MS + 13_000);
    });
    expect((await loadRecords(db, NOW)).waiting.map((x) => x.w.command_id)).toEqual(["c-old", "c-1", "c-2"]);
    await db.transaction((tx) => pruneRecords(tx, NOW));
    expect((await loadRecords(db, NOW)).waiting.map((x) => x.w.command_id)).toEqual(["c-1", "c-2"]);
  });

  it("keeps an apply's idempotency key and body with it, and a later write of its outcomes keeps them (GA-APPLY-4)", async () => {
    const db = await memoryDb();
    await migrate(db);
    const held = { apply_id: "a-1", client: "h", created_ms: NOW, outcomes: [], idempotency_key: "k-1", body: '{"request":{}}' };
    await db.transaction(async (tx) => {
      await saveApply(tx, held);
      await saveApply(tx, { ...held, outcomes: [{ step_id: "s1", target: "hall:lamp", outcome: "dispatched" }] });
      await saveApply(tx, { apply_id: "a-2", client: "h", created_ms: NOW, outcomes: [] });
    });
    expect((await loadRecords(db, NOW)).applies).toEqual([
      { ...held, outcomes: [{ step_id: "s1", target: "hall:lamp", outcome: "dispatched" }] },
      { apply_id: "a-2", client: "h", created_ms: NOW, outcomes: [] }]);
  });

  it("keeps a late window until its deadline, each write safe to run twice (GA-APPLY-11)", async () => {
    const db = await memoryDb();
    await migrate(db);
    const late: Late = { command_id: "c-1", apply_id: "a-1", step_id: "s1", target: "hall:lamp", action: "onoff.turn_on", args: {},
      cause: { apply: "a-1", client: "h", for: { person: "demo" } }, until_ms: NOW + 60_000 };
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) {
        await saveLate(tx, late);
        await saveLate(tx, { ...late, command_id: "c-2", until_ms: NOW });
      }
    });
    expect((await loadRecords(db, NOW)).late).toEqual([late]);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) await pruneRecords(tx, NOW);
    });
    expect((await db.query("SELECT command_id FROM late")).rows).toEqual([{ command_id: "c-1" }]);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) await dropLate(tx, "c-1");
    });
    expect((await loadRecords(db, NOW)).late).toEqual([]);
  });

  it("keeps an open device's assumed state, the latest value of each key with the dispatch it came from, each write safe to run twice; a forget drops it (GA-STATE-4)", async () => {
    const db = await memoryDb();
    await migrate(db);
    const src = { source_seq: 2 };
    await db.transaction(async (tx) => {
      for (let i = 0; i < 2; i++) {
        await saveAssumed(tx, [{ device: "hall:ac", key: "mode", value: "cool", basis_ms: NOW, ...src },
          { device: "hall:ac", key: "setpoint", value: 22, basis_ms: NOW, ...src }]);
        await saveAssumed(tx, [{ device: "hall:ac", key: "mode", value: "heat", basis_ms: NOW + 1, source_seq: 3 }]);
        await saveAssumed(tx, [{ device: "hall:tv", key: "on", value: true, basis_ms: NOW, ...src }]);
      }
    });
    expect((await loadRecords(db, NOW)).assumed).toEqual([
      { device: "hall:ac", key: "mode", value: "heat", basis_ms: NOW + 1, source_seq: 3 },
      { device: "hall:ac", key: "setpoint", value: 22, basis_ms: NOW, ...src },
      { device: "hall:tv", key: "on", value: true, basis_ms: NOW, ...src }]);
    for (let i = 0; i < 2; i++) await db.transaction((tx) => forgetAssumed(tx, ["hall:tv"]));
    expect((await loadRecords(db, NOW)).assumed.map((x) => x.device)).toEqual(["hall:ac", "hall:ac"]);
  });

  it("tells a value Postgres could keep from one holding U+0000 or a lone surrogate, keys included", () => {
    expect(storable({ a: ["x", 1, true, null, { b: "y" }] })).toBe(true);
    expect(storable({ a: ["x\u0000"] })).toBe(false);
    expect(storable({ ["k\u0000"]: 1 })).toBe(false);
    expect(storable("\ud800")).toBe(false);
  });
  it("keeps an apply a rule or a cap still runs past its hour, in the store and at load (GA-SAFE-12, GA-LOAD-2)", async () => {
    const db = await memoryDb();
    await migrate(db);
    await db.transaction(async (tx) => {
      for (const id of ["ruled", "capped", "done"]) await saveApply(tx, { apply_id: id, client: "", created_ms: NOW, outcomes: [] });
      await tx.query("INSERT INTO safety_state (rule_id, trigger_true, apply_id) VALUES ('r', true, 'ruled'), ('q', false, NULL)");
      await tx.query("INSERT INTO load_caps (device, apply_id, attempt, state, began_ms) VALUES ('d', 'capped', 1, 'wait', 0)");
    });
    const later = NOW + HELD_MS + 1;
    expect((await loadRecords(db, later)).applies.map((a) => a.apply_id).sort()).toEqual(["capped", "ruled"]);
    await db.transaction((tx) => pruneRecords(tx, later));
    expect((await db.query<{ apply_id: string }>("SELECT apply_id FROM applies ORDER BY apply_id")).rows.map((r) => r.apply_id)).toEqual(["capped", "ruled"]);
  });
});
