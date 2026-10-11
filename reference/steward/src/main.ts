#!/usr/bin/env node
import { clockFromEnv } from "@ludentes/galatea-life-test-clock";
import { connectPg, maskUrls } from "./core/db.js";
import { settingsFromEnv } from "./entry.js";
import { McpApplierPort } from "./link/port.js";
import { serveMcp } from "./mcp/server.js";
import { startSteward } from "./start.js";

// Every setting is read and checked before anything is opened (`settingsFromEnv`); a refusal stops
// the steward with one line that carries no secret.
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
const steward = await startSteward(settings.value, {
  clock, connectPg, serveMcp, fatal,
  connectApplier: (url, bearer, opts) => McpApplierPort.connect(url, bearer, opts),
}).catch((err: unknown) => fatal(`the steward could not start: ${maskUrls(err instanceof Error ? err.message : String(err))}`));
console.log(`ready on ${steward.url}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await steward.stop();
  clock.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
