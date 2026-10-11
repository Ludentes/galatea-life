import { TestClock, type Clock } from "@ludentes/galatea-life-test-clock";
import { Applier, type BusPort } from "./applier.js";
import { plainOffLoopback } from "./bus/broker-url.js";
import type { BusOptions } from "./bus/client.js";
import { maskUrls, StoreError, type Db } from "./core/db.js";
import { Store } from "./core/store.js";
import type { ApplierSettings } from "./entry.js";
import type { serveMcp } from "./mcp/server.js";

/** What `startApplier` opens, injected: `main.ts` gives the real ones, the tests fakes that record what they are handed. */
export interface StartDeps {
  clock: Clock;
  connectPg(url: string): Db;
  bus(options: BusOptions): BusPort & { start(): Promise<void>; close(): Promise<void> };
  serveMcp: typeof serveMcp;
  /** A fault the applier cannot run on: the message is said and the process stops (exit 1). */
  fatal(message: string): void;
}

/**
 * The applier started from its settings (`settingsFromEnv`): the store, the bus, the applier and its
 * MCP server, wired with exactly what the settings hold. `main.ts` owns the process; this owns the
 * order.
 */
export async function startApplier(s: ApplierSettings, d: StartDeps): Promise<{ url: string; stop(): Promise<void> }> {
  const { clock } = d;
  // The applier cannot start without its store: its configuration is there (the storage design).
  // The URL carries a password, so it is never printed.
  const store = await Store.open(d.connectPg(s.databaseUrl), clock, (err) => {
    // A statement the store refuses for good would stop every write after it, safety's included, while
    // the applier ran on state the store does not hold. Stopping says so loudly, and a restart reloads.
    // A write set that threw something the store did not say is a bug; it would fail again too.
    const why = err instanceof StoreError
      ? `the store refused a write, which would fail again${err.code ? ` (${err.code})` : ""}`
      : "a write failed with a bug in the applier";
    d.fatal(`${why}: ${maskUrls(err instanceof Error ? err.message : String(err))}; stopping`);
  }).catch((err: unknown) => {
    d.fatal(`the store named by GALATEA_DATABASE_URL could not be opened: ${maskUrls(err instanceof Error ? err.message : String(err))}`);
    throw err;
  });
  // The broker, with the applier's MQTT identity as its user name (the subject contract). Without one,
  // the applier serves an empty home: every bridge it is given reads dead.
  const broker = s.broker;
  let applier: Applier | undefined;
  const bus = broker && d.bus({
    url: broker.url,
    identity: broker.identity,
    ...(broker.password === undefined ? {} : { password: broker.password }),
    ...(broker.ca === undefined ? {} : { ca: broker.ca }),
    retainsRequests: s.mutation === "retains-request",
    root: broker.root,
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
    ownerCredential: s.ownerCredential,
    applierId: broker?.identity ?? "applier",
    runId: s.runId,
    mutation: s.mutation,
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
  const server = await d.serveMcp(applier, s.mcp);
  return {
    url: server.url,
    stop: async () => {
      await server.close();
      await bus?.close();
      applier!.stop();
      // What is queued gets up to 3 s to commit; the harness kills a subject 5 s after SIGTERM.
      await store.close(3000);
    },
  };
}
