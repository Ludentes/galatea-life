// A person's lease kept by a steward from before migration 0015 has no hold state; the migration
// drops it rather than carry a lease the hold policy never judged, and keeps a run's lease (the
// final review of the steward 0.12 build, M1; no backward compatibility).
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/core/migrate.js";
import { blankDb } from "./db.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("leases kept from before migration 0015", () => {
  it("lose a person's lease with no hold, and keep a run's lease and the other precedences", async () => {
    const db = await blankDb();
    const before = mkdtempSync(join(tmpdir(), "steward-0014-"));
    dirs.push(before);
    for (const f of readdirSync(MIGRATIONS).filter((f) => f < "0015")) copyFileSync(new URL(f, MIGRATIONS), join(before, f));
    await migrate(db, pathToFileURL(`${before}/`));
    const rows: [string, unknown, string][] = [
      ["lamp.endpoint", { endpoint: "owner-app" }, "person"],
      ["lamp.external", "external", "person"],
      ["heater.cap", "load_cap", "person"],
      ["lamp.run", { run: "r1" }, "person"],
      ["lamp.scheduled", { run: "r2" }, "scheduled_run"],
      ["lamp.rule", { rule: "night" }, "rule"],
    ];
    for (const [target, holder, precedence] of rows) {
      await db.query("INSERT INTO leases (target, holder, precedence, since_ms, expires_ms) VALUES ($1, $2, $3, 0, 20000)",
        [target, JSON.stringify(holder), precedence]);
    }
    expect(await migrate(db)).toEqual(["0015_lease_hold.sql"]);
    const kept = (await db.query<{ target: string }>("SELECT target FROM leases ORDER BY target")).rows.map((r) => r.target);
    expect(kept).toEqual(["lamp.rule", "lamp.run", "lamp.scheduled"]);
  });
});
