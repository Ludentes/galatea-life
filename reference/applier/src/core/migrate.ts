import type { Db } from "./db.js";

/** One numbered SQL file of the applier's schema: its name (`0001_skeleton.sql`) and its statements. */
export interface Migration {
  name: string;
  sql: string;
}

/**
 * Applies the migrations `migrations` does not yet record, in the order of their names, in one
 * transaction, and returns their names (the storage design, *Inside a build*). It names no schema
 * and creates none: the tables land in the schema the installation made for the applier's role,
 * which its search path finds first because it bears the role's name. It reads no file: the entry
 * points read the package's `migrations/` (`migrationsFrom` in `adapters/migrations.ts`).
 */
export async function migrate(db: Db, files: readonly Migration[]): Promise<string[]> {
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return db.transaction(async (tx) => {
    await tx.exec("CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await tx.query<{ name: string }>("SELECT name FROM migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const m of ordered.filter((f) => !done.has(f.name))) {
      await tx.exec(m.sql);
      await tx.query("INSERT INTO migrations (name) VALUES ($1)", [m.name]);
      applied.push(m.name);
    }
    return applied;
  });
}
