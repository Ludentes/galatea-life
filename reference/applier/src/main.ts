#!/usr/bin/env node
import { clockFromEnv, TestClock } from "@ludentes/galatea-life-test-clock";
import { Bus } from "./bus/client.js";
import { MIGRATIONS_DIR, migrationsFrom } from "./adapters/migrations.js";
import { connectPg } from "./adapters/pg.js";
import { maskUrls } from "./core/db.js";
import { settingsFromEnv } from "./entry.js";
import { serveMcp } from "./mcp/server.js";
import { startApplier } from "./start.js";

// Every setting is read and checked before anything is opened (`settingsFromEnv`); a refusal stops
// the applier with one line that carries no secret.
const settings = settingsFromEnv(process.env);
if ("refused" in settings) {
  console.error(`refusing to start: ${settings.refused}`);
  process.exit(2);
}
const clock = await clockFromEnv(process.env);
const log = (line: string): void => console.error(line);
const fatal = (message: string): never => {
  console.error(message);
  process.exit(1);
};
let migrations;
try {
  migrations = migrationsFrom(MIGRATIONS_DIR);
} catch (err) {
  fatal(`the applier's migrations could not be read: ${err instanceof Error ? err.message : String(err)}`);
}
// The harness's `time_source` moves its clock; any other clock refuses it.
const retarget = async (source: string): Promise<void> => {
  if (!(clock instanceof TestClock)) throw new Error("started without GALATEA_TIME_SOURCE");
  await clock.retarget(source);
};
const applier = await startApplier(settings.value, { clock, connectPg, bus: (o) => new Bus(o), serveMcp, migrations: migrations!, retarget, log, fatal })
  .catch((err: unknown) => fatal(`the applier could not start: ${maskUrls(err instanceof Error ? err.message : String(err))}`));
console.log(`ready on ${applier.url}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await applier.stop();
  clock.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
