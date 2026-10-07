import { readdirSync, readFileSync } from "node:fs";
import type { Db } from "./db.js";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/**
 * Applies the numbered SQL files in `migrations/` that `migrations` does not yet record, in one
 * transaction, and returns their names (the storage design, *Inside a build*). It names no schema
 * and creates none: the tables land in the schema the installation made for the applier's role,
 * which its search path finds first because it bears the role's name.
 */
export async function migrate(db: Db, dir: URL = MIGRATIONS): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return db.transaction(async (tx) => {
    await tx.exec("CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await tx.query<{ name: string }>("SELECT name FROM migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of files.filter((f) => !done.has(f))) {
      await tx.exec(readFileSync(new URL(file, dir), "utf8"));
      await tx.query("INSERT INTO migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }
    return applied;
  });
}
