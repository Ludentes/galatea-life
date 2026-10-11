import { createSocket } from "node:dgram";
import { isResponse, request, TestClock, type Clock } from "@ludentes/galatea-life-test-clock";
import { maskUrls, StoreError, type Db } from "./core/db.js";
import { Store } from "./core/store.js";
import type { StewardSettings } from "./entry.js";
import { ApplierLink } from "./link/link.js";
import { NotSent, type ApplierPort } from "./link/port.js";
import type { serveMcp } from "./mcp/server.js";
import { Steward } from "./steward.js";

/** What `startSteward` opens, injected: `main.ts` gives the real ones, the tests fakes that record what they are handed. */
export interface StartDeps {
  clock: Clock;
  connectPg(url: string): Db;
  /** One session to the applier (`McpApplierPort.connect`), with the link's own trust. */
  connectApplier(url: URL, bearer: string, opts: { legacy?: boolean; ca?: string; insecure?: boolean }): Promise<ApplierPort>;
  serveMcp: typeof serveMcp;
  /** A fault the steward cannot run on: the message is said and the process stops (exit 1). */
  fatal(message: string): void;
}

/**
 * The steward started from its settings (`settingsFromEnv`): the store, the steward, its applier link
 * and its MCP server, wired with exactly what the settings hold. `main.ts` owns the process; this
 * owns the order.
 */
export async function startSteward(s: StewardSettings, d: StartDeps): Promise<{ url: string; stop(): Promise<void> }> {
  const { clock } = d;
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
  // The one applier's link, made once the steward has started; the steward plans through it.
  let link: ApplierLink | undefined;
  // The steward cannot start without its store: the house is there (the storage design). The URL
  // carries a password, so it is never printed.
  const store = await Store.open(d.connectPg(s.databaseUrl), clock, (err) => {
    // A statement the store refuses for good would stop every write after it; the steward holds no
    // protection to keep running for, so it stops, and a restart reloads what is kept (the design,
    // *A store fault*).
    const why = err instanceof StoreError
      ? `the store refused a write, which would fail again${err.code ? ` (${err.code})` : ""}`
      : "a write failed with a bug in the steward";
    d.fatal(`${why}: ${maskUrls(err instanceof Error ? err.message : String(err))}; stopping`);
  }).catch((err: unknown) => {
    d.fatal(`the store named by GALATEA_DATABASE_URL could not be opened: ${maskUrls(err instanceof Error ? err.message : String(err))}`);
    throw err;
  });
  const steward = new Steward({
    store, clock, mutation: s.mutation,
    stewardId: s.stewardId,
    ownerCredential: s.ownerCredential,
    runId: s.runId,
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
    applierClient: s.applier.client,
    tokenKey: s.applier.tokenKey,
  });
  await steward.start();

  // The one applier (GA-SEC-2, GA-BIND-2). A URL the binding does not allow is refused once and never
  // tried: the steward serves its clients, and its applier stays out of reach, which it logs.
  // The link's trust is its own (GA-SEC-2): the CA it was given, or the system's store; under the
  // mutation `trusts-any-applier`, none. Nothing else in the process trusts more.
  const applier = s.applier;
  if ("value" in applier.url) {
    const url = applier.url.value;
    link = new ApplierLink({
      clock,
      connect: () => d.connectApplier(url, applier.credential, {
        legacy: s.mutation === "calls-its-applier-at-2025",
        ...(applier.ca === undefined ? {} : { ca: applier.ca }),
        insecure: s.mutation === "trusts-any-applier",
      }),
      steps: { describe: (x) => steward.onDescribe(x), state: (x) => steward.onState(x), events: (e) => steward.onEvents(e),
        notices: (n) => steward.onNotices(n), taken: () => steward.noticesTaken(), since: () => steward.lastApplierEvent(),
        recover: (missed, x, cursor, dropped) => steward.recover(missed, x, cursor, dropped) },
    });
    link.start();
  } else {
    console.error(applier.url.refused);
  }

  const server = await d.serveMcp(steward, s.mcp);
  return {
    url: server.url,
    stop: async () => {
      await server.close();
      await link?.stop();
      steward.stop();
      // What is queued gets up to 3 s to commit; the harness kills a subject 5 s after SIGTERM.
      await store.close(3000);
    },
  };
}
