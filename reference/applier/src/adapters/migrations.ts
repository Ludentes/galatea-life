import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Migration } from "../core/migrate.js";

/** The package's own migrations: `migrations/` beside `dist/`. */
export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

/** The numbered SQL files in `dir` (`0001_skeleton.sql`), read and sorted by name, for `migrate` and `Store.open`. */
export function migrationsFrom(dir: URL | string): Migration[] {
  const base = typeof dir === "string" ? pathToFileURL(dir.endsWith("/") ? dir : `${dir}/`) : dir;
  return readdirSync(base).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, base), "utf8") }));
}
