#!/usr/bin/env node
// The steward's migrate-only entry (subject.json's database.migrate): brings the schema named by
// GALATEA_DATABASE_URL up to date and exits. The harness runs it once per run into a template database
// that each test's database is cloned from, so the migrate at the steward's start (`Store.open`) finds
// nothing to do. Like main.ts, it is an entry point: only it reads the environment. It is unrelated to
// the installation's galatea-prepare. The password may come from GALATEA_DATABASE_PASSWORD_FILE, as
// for main.ts.
import { connectPg, maskUrls } from "./core/db.js";
import { migrate } from "./core/migrate.js";
import { urlFromEnv } from "./entry.js";

const read = urlFromEnv(process.env, "GALATEA_DATABASE_URL", "GALATEA_DATABASE_PASSWORD_FILE");
if ("refused" in read) {
  console.error(`refusing to migrate: ${read.refused}`);
  process.exit(2);
}
const url = read.value;
if (!url) {
  console.error("GALATEA_DATABASE_URL is not set");
  process.exit(2);
}
// The URL carries a password, so it is never printed.
const db = connectPg(url);
try {
  const applied = await migrate(db);
  console.log(`migrated: ${applied.length ? applied.join(", ") : "nothing to do"}`);
} catch (err) {
  console.error(`the store named by GALATEA_DATABASE_URL could not be migrated: ${maskUrls(err instanceof Error ? err.message : String(err))}`);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => undefined);
}
