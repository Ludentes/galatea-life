#!/usr/bin/env node
import { clockFromEnv } from "@ludentes/galatea-life-test-clock";
import { Bus } from "./bus/client.js";
import { connectPg, maskUrls } from "./core/db.js";
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
const fatal = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const applier = await startApplier(settings.value, { clock, connectPg, bus: (o) => new Bus(o), serveMcp, fatal })
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
