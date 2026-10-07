#!/usr/bin/env node
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { clockFromEnv, isResponse, request, TestClock } from "@ludentes/galatea-life-test-clock";
import { connectPg, maskUrls, StoreError } from "./core/db.js";
import { Store } from "./core/store.js";
import { ApplierLink } from "./link/link.js";
import { checkApplierUrl, McpApplierPort, NotSent, trustAnyApplier, trustApplierCa } from "./link/port.js";
import { isLoopback, serveMcp } from "./mcp/server.js";
import { mutationFromEnv } from "./mutations.js";
import { Steward } from "./steward.js";

const env = process.env;
function need(name: string): string {
  const v = env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
}

/** A secret from the environment, refused (never printed) when shorter than 16 characters. */
function needSecret(name: string): string {
  const v = need(name);
  if ([...v].length < 16) {
    console.error(`${name} is shorter than 16 characters`);
    process.exit(2);
  }
  return v;
}

// Plain HTTP only on loopback (GA-SEC-2): a steward told to serve it elsewhere refuses to start,
// before it opens its store or calls its applier.
const tls = env.GALATEA_STEWARD_TLS_CERT && env.GALATEA_STEWARD_TLS_KEY
  ? { cert: env.GALATEA_STEWARD_TLS_CERT, key: env.GALATEA_STEWARD_TLS_KEY } : undefined;
const host = env.GALATEA_STEWARD_HOST || undefined;
if (host && !isLoopback(host) && !tls) {
  console.error(`GALATEA_STEWARD_HOST ${host} is not loopback, and no GALATEA_STEWARD_TLS_CERT and _KEY are set: refusing to serve plain HTTP there (GA-SEC-2)`);
  process.exit(2);
}

const clock = await clockFromEnv(env);
// The source the clock started on, which clearing `time_source` returns it to (GA-HARN-2).
const startSource = clock instanceof TestClock ? clock.source : undefined;

/** Resolves once `source` answers one SNTP request, within 1 s; the clock is not moved. */
function checkTimeSource(source: string): Promise<void> {
  if (!(clock instanceof TestClock)) return Promise.reject(new Error("started without GALATEA_TIME_SOURCE"));
  const i = source.lastIndexOf(":");
  const port = Number(source.slice(i + 1));
  if (i < 1 || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error(`time source must be host:port, not ${source}`));
  const socket = createSocket("udp4");
  return new Promise<void>((resolve, reject) => {
    const req = request(Date.now());
    const timer = setTimeout(() => reject(new Error(`no answer from the time source ${source}`)), 1000);
    socket.on("message", (msg) => {
      if (!isResponse(msg) || !msg.subarray(24, 32).equals(req.subarray(40, 48))) return;
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (err) => { clearTimeout(timer); reject(err); });
    socket.send(req, port, source.slice(0, i));
  }).finally(() => socket.close());
}
const mutation = mutationFromEnv(env);
// The one applier's link, made once the steward has started; the steward plans through it.
let link: ApplierLink | undefined;
// The steward cannot start without its store: the house is there (the storage design). The URL
// carries a password, so it is never printed.
const store = await Store.open(connectPg(need("GALATEA_DATABASE_URL")), clock, (err) => {
  // A statement the store refuses for good would stop every write after it; the steward holds no
  // protection to keep running for, so it stops, and a restart reloads what is kept (the design,
  // *A store fault*).
  const why = err instanceof StoreError
    ? `the store refused a write, which would fail again${err.code ? ` (${err.code})` : ""}`
    : "a write failed with a bug in the steward";
  console.error(`${why}: ${maskUrls(err instanceof Error ? err.message : String(err))}; stopping`);
  process.exit(1);
}).catch((err: unknown) => {
  console.error(`the store named by GALATEA_DATABASE_URL could not be opened: ${maskUrls(err instanceof Error ? err.message : String(err))}`);
  process.exit(1);
});
const steward = new Steward({
  store, clock, mutation,
  stewardId: env.GALATEA_STEWARD_ID || "steward",
  ownerCredential: env.GALATEA_OWNER_CREDENTIAL || undefined,
  runId: env.GALATEA_TEST_RUN_ID || undefined,
  retarget: async (source) => {
    if (!(clock instanceof TestClock)) {
      if (source === null) return;
      throw new Error("started without GALATEA_TIME_SOURCE");
    }
    await clock.retarget(source ?? startSource!);
  },
  checkTimeSource,
  applierPlan: (request) => (link ? link.plan(request) : Promise.reject(new Error("the applier link was not made"))),
  applierApply: (body, ms) => (link ? link.apply(body, ms) : Promise.reject(new NotSent("the applier link was not made"))),
  // Its client id at the applier, every token's issuer, and the key that proves them; never printed.
  applierClient: need("GALATEA_APPLIER_CLIENT"),
  tokenKey: needSecret("GALATEA_APPLIER_TOKEN_KEY"),
});
await steward.start();

// The one applier (GA-SEC-2, GA-BIND-2). A URL the binding does not allow is refused once and never
// tried: the steward serves its clients, and its applier stays out of reach, which it logs.
const applierCredential = need("GALATEA_APPLIER_CREDENTIAL");
if (env.GALATEA_APPLIER_CA) trustApplierCa(readFileSync(env.GALATEA_APPLIER_CA, "utf8"));
if (mutation === "trusts-any-applier") trustAnyApplier();
try {
  const url = checkApplierUrl(need("GALATEA_APPLIER_URL"));
  link = new ApplierLink({
    clock,
    connect: () => McpApplierPort.connect(url, applierCredential, { legacy: mutation === "calls-its-applier-at-2025" }),
    steps: { describe: (d) => steward.onDescribe(d), state: (s) => steward.onState(s), events: (e) => steward.onEvents(e),
      notices: (n) => steward.onNotices(n), taken: () => steward.noticesTaken(), since: () => steward.lastApplierEvent(),
      recover: (missed, s, cursor, dropped) => steward.recover(missed, s, cursor, dropped) },
  });
  link.start();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
}

const server = await serveMcp(steward, { port: Number(need("GALATEA_MCP_PORT")), host, tls });
console.log(`ready on ${server.url}`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await server.close();
  await link?.stop();
  steward.stop();
  // What is queued gets up to 3 s to commit; the harness kills a subject 5 s after SIGTERM.
  await store.close(3000);
  clock.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
