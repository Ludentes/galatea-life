import { describe, expect, it } from "vitest";
import type { Db } from "../src/core/db.js";
import { Store } from "../src/core/store.js";
import { blankDb, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

/** Everything a test could meet in the database: the catalogue of its schema, the roles and grants, and every row. */
async function snapshot(db: Db): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await db.query(sql)).rows;
  const tables = (await q(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`)).map((r) => (r as { table_name: string }).table_name);
  const rows: Record<string, unknown> = {};
  for (const t of tables) {
    const all = await q(`SELECT * FROM "${t}"`);
    // When a migration ran is the one thing the template cannot share with a fresh database.
    rows[t] = all.map((r) => JSON.stringify(t === "migrations" ? { ...r, applied_at: undefined } : r)).sort();
  }
  return {
    tables,
    rows,
    columns: await q(`SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default, is_identity
      FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`),
    constraints: await q(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = current_schema()::regnamespace ORDER BY rel, conname`),
    indexes: await q(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() ORDER BY tablename, indexname`),
    views: await q(`SELECT viewname, definition FROM pg_views WHERE schemaname = current_schema() ORDER BY viewname`),
    functions: await q(`SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace ORDER BY proname, def`),
    triggers: await q(`SELECT tgrelid::regclass::text AS rel, tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal ORDER BY rel, tgname`),
    sequences: await q(`SELECT sequencename, start_value, increment_by, last_value FROM pg_sequences
      WHERE schemaname = current_schema() ORDER BY sequencename`),
    types: await q(`SELECT typname, typtype FROM pg_type WHERE typnamespace = current_schema()::regnamespace
      AND typtype IN ('e', 'd', 'c') AND typrelid = 0 ORDER BY typname`),
    roles: await q(`SELECT rolname, rolsuper, rolinherit, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname`),
    grants: await q(`SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = current_schema() ORDER BY grantee, table_name, privilege_type`),
    schemaGrants: await q(`SELECT nspname, nspacl::text FROM pg_namespace WHERE nspname = current_schema()`),
  };
}

describe("memoryDb's template", () => {
  it("holds exactly what a fresh database and Store.open's migrations give", async () => {
    const fresh = await blankDb();
    await Store.open(fresh, new FakeClock(), (err) => { throw err; });
    const templated = await memoryDb();
    const expected = await snapshot(fresh);
    expect((expected.tables as string[]).length).toBeGreaterThan(1);
    expect(await snapshot(templated)).toEqual(expected);
    await fresh.close();
    await templated.close();
  });

  it("gives each call its own database", async () => {
    const a = await memoryDb();
    const b = await memoryDb();
    await a.exec("CREATE TABLE only_in_a (x int)");
    expect((await b.query("SELECT to_regclass('only_in_a') AS t")).rows).toEqual([{ t: null }]);
    await a.close();
    await b.close();
  });
});
