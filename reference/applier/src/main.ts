#!/usr/bin/env node
import { clockFromEnv, TestClock } from "@ludentes/galatea-life-test-clock";
import { Applier } from "./applier.js";
import { brokerFromUrl, plainOffLoopback } from "./bus/broker-url.js";
import { Bus } from "./bus/client.js";
import { connectPg, maskUrls, StoreError } from "./core/db.js";
import { Store } from "./core/store.js";
import { serveMcp } from "./mcp/server.js";
import { mutationFromEnv } from "./mutations.js";

const env = process.env;
function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
}

const clock = await clockFromEnv(env);
// The applier cannot start without its store: its configuration is there (the storage design).
// The URL carries a password, so it is never printed.
const store = await Store.open(connectPg(need("GALATEA_DATABASE_URL")), clock, (err) => {
  // A statement the store refuses for good would stop every write after it, safety's included, while
  // the applier ran on state the store does not hold. Stopping says so loudly, and a restart reloads.
  // A write set that threw something the store did not say is a bug; it would fail again too.
  const why = err instanceof StoreError
    ? `the store refused a write, which would fail again${err.code ? ` (${err.code})` : ""}`
    : "a write failed with a bug in the applier";
  console.error(`${why}: ${maskUrls(err instanceof Error ? err.message : String(err))}; stopping`);
  process.exit(1);
}).catch((err: unknown) => {
  console.error(`the store named by GALATEA_DATABASE_URL could not be opened: ${maskUrls(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
});
// The broker, with the applier's MQTT identity as its user name (the subject contract). Without one,
// the applier serves an empty home: every bridge it is given reads dead.
const broker = env.GALATEA_BROKER ? parseBroker(env.GALATEA_BROKER) : undefined;
let applier: Applier | undefined;
const mutation = mutationFromEnv(env);
const bus = broker && new Bus({
  ...broker,
  retainsRequests: mutation === "retains-request",
  root: need("GALATEA_ROOT"),
  clock,
  onMessage: (identity, path, payload, retained) => applier?.home.message(identity, path, payload, retained),
  onListening: (bridge) => applier?.listening(bridge),
  onLost: () => applier?.lost(),
  onFinder: (path, payload, retained) => applier?.finder.message(path, payload, retained),
  onFinderListening: () => applier?.finder.listening(),
  onFinderRefused: (reason) => applier?.finder.refused(reason),
  onFault: (what, bridge) => {
    // A bridge's fault is logged by the home, once while it stands; the bus retries it silently.
    if (bridge) applier?.home.bridgeFault(bridge, what);
    else console.error(`the bus: ${what}`);
  },
});
applier = new Applier({
  store, clock, bus,
  ownerCredential: need("GALATEA_OWNER_CREDENTIAL"),
  applierId: broker?.identity ?? "applier",
  runId: env.GALATEA_TEST_RUN_ID || undefined,
  mutation,
  // This build can claim Safe; it does once the owner sets `box`, while no bridge declares an `ungoverned` path (GA-DESC-6).
  levels: ["Act", "Safe"],
  plainOffLoopback: broker !== undefined && plainOffLoopback(broker.url),
  retarget: async (source) => {
    if (!(clock instanceof TestClock)) throw new Error("started without GALATEA_TIME_SOURCE");
    await clock.retarget(source);
  },
});
await applier.start();
// The MCP server and the bus start only after `start()` returns: its revision jump after an unclean stop
// depends on `load` having written `last_seq`, so nothing can serve or take a revision before that.
// Connected, or its first try failed and it goes on trying, before `ready`: the harness's first
// configure then finds the bus there to follow the bridge it registers.
await bus?.start();
const tls = env.GALATEA_APPLIER_TLS_CERT && env.GALATEA_APPLIER_TLS_KEY
  ? { cert: env.GALATEA_APPLIER_TLS_CERT, key: env.GALATEA_APPLIER_TLS_KEY } : undefined;
const server = await serveMcp(applier, { port: Number(need("GALATEA_MCP_PORT")), host: env.GALATEA_APPLIER_HOST, tls });
console.log(`ready on ${server.url}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await bus?.close();
  applier!.stop();
  // What is queued gets up to 3 s to commit; the harness kills a subject 5 s after SIGTERM.
  await store.close(3000);
  clock.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

/** The broker's parts; a bad value stops the applier with a message that repeats none of it. */
function parseBroker(raw: string): ReturnType<typeof brokerFromUrl> {
  try {
    return brokerFromUrl(raw);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "GALATEA_BROKER is not a valid URL");
    process.exit(2);
  }
}
