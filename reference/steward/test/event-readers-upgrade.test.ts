// A `define` event kept from before migration 0013 has no readers: its diff still goes only to its
// endpoint and the owner's role (GA-STW-7; the whole-branch review, I2).
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/core/migrate.js";
import { blankDb } from "./db.js";
import { SECRETS, up } from "./house.js";
import { setup } from "./setup.js";

type Body = Record<string, any>;
const MIGRATIONS = new URL("../migrations/", import.meta.url);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("define events kept from before migration 0013 (GA-STW-7)", () => {
  it("are given their own endpoint as reader by the migration, and an ask event none", async () => {
    const db = await blankDb();
    const before = mkdtempSync(join(tmpdir(), "steward-0012-"));
    dirs.push(before);
    for (const f of readdirSync(MIGRATIONS).filter((f) => f < "0013")) copyFileSync(new URL(f, MIGRATIONS), join(before, f));
    await migrate(db, pathToFileURL(`${before}/`));
    await db.query("INSERT INTO events (seq, time_ms, type, body) VALUES (1, 0, 'define', $1), (2, 0, 'ask', $2)",
      [JSON.stringify({ endpoint: "owner-app", diff: ["room attic added"] }), JSON.stringify({ endpoint: "olga-app", step_ids: ["s1"] })]);
    expect(await migrate(db)).toContain("0013_event_readers.sql");
    const rows = (await db.query<{ type: string; readers: Body | null }>("SELECT type, readers FROM events ORDER BY seq")).rows;
    expect(rows).toEqual([{ type: "define", readers: { endpoint: "owner-app" } }, { type: "ask", readers: null }]);
    // The reader role's view strips the diff of a row with readers.
    const view = (await db.query<{ body: Body }>("SELECT body FROM history_v WHERE type = 'define'")).rows[0]!;
    expect(view.body).not.toHaveProperty("diff");
  });

  it("withhold their diff from a panel's read even with no readers kept, and give it to the owner", async () => {
    const s = await setup();
    await s.define([up("room", { id: "attic", name: "Чердак" })]);
    await s.store.settled();
    await s.store.query("UPDATE events SET readers = NULL WHERE type = 'define'");
    const range = { from: new Date(s.clock.now() - 3_600_000).toISOString(), to: new Date(s.clock.now() + 60_000).toISOString() };
    const defines = async (secret: string) => (await s.ok(secret, "history", range)).events.filter((e: Body) => e.type === "define");
    const panel = await defines(SECRETS.panel);
    expect(panel.length).toBeGreaterThan(0);
    for (const e of panel) expect(e).not.toHaveProperty("diff");
    expect((await defines(SECRETS.owner)).some((e: Body) => Array.isArray(e.diff))).toBe(true);
  });
});
