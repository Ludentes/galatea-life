import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { BusOptions } from "../src/bus/client.js";
import { settingsFromEnv, type ReadSecret } from "../src/entry.js";
import { startApplier } from "../src/start.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { privateCa } from "./private-ca.js";

// What main wires is what the settings hold (the review of plan A, I2): the URL pg is given, the bus's
// options and the MCP server's, each asserted exactly, from the installation's settings read through
// settingsFromEnv. pg parses its URL with pg-connection-string; that parse is what reaches Postgres.
const parsePg = createRequire(createRequire(import.meta.url).resolve("pg"))("pg-connection-string").parse as
  (url: string) => { user?: string; password?: string; host?: string; port?: string; database?: string };

describe("startApplier wires exactly what the settings hold", () => {
  it("hands pg the file's password, the bus its password and CA, and the MCP server its TLS", async () => {
    const pki = privateCa();
    const DB_PW = "p@ss %#word";
    const BROKER_PW = "b@r %#ker";
    const secrets: ReadSecret = (path) => ({ value: path === "/run/secrets/db" ? DB_PW : path === "/run/secrets/broker" ? BROKER_PW : "owner-from-the-file" });
    const pems: Record<string, string> = { "/run/tls/applier.pem": pki.cert, "/run/secrets/tls.key": pki.key, "/run/tls/ca.pem": pki.ca };
    const settings = settingsFromEnv({
      GALATEA_DATABASE_URL: "postgres://applier@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/run/secrets/db",
      GALATEA_BROKER: "mqtts://applier@broker:8883", GALATEA_BROKER_PASSWORD_FILE: "/run/secrets/broker", GALATEA_BROKER_CA: "/run/tls/ca.pem",
      GALATEA_ROOT: "galatea", GALATEA_OWNER_CREDENTIAL_FILE: "/run/secrets/owner", GALATEA_MCP_PORT: "18443", GALATEA_APPLIER_HOST: "0.0.0.0",
      GALATEA_APPLIER_TLS_CERT: "/run/tls/applier.pem", GALATEA_APPLIER_TLS_KEY: "/run/secrets/tls.key",
    }, { secret: secrets, pem: (p) => pems[p]! });
    if ("refused" in settings) throw new Error(settings.refused);

    const db = await memoryDb();
    const pgUrls: string[] = [];
    const busOptions: BusOptions[] = [];
    const served: unknown[] = [];
    const started = await startApplier(settings.value, {
      clock: new FakeClock(),
      connectPg: (url) => { pgUrls.push(url); return db; },
      bus: (o) => { busOptions.push(o); return { follow: () => undefined, snapshot: async () => "ok", request: async () => "ok", command: async () => "ok",
        start: async () => undefined, close: async () => undefined } as never; },
      serveMcp: async (_applier, opts) => { served.push(opts); return { url: "https://0.0.0.0:18443/mcp", close: async () => undefined }; },
      fatal: (m) => { throw new Error(m); },
    });

    expect(pgUrls).toHaveLength(1);
    expect(parsePg(pgUrls[0]!)).toMatchObject({ user: "applier", password: DB_PW, host: "postgres", port: "5432", database: "galatea" });
    expect(busOptions).toHaveLength(1);
    expect(busOptions[0]).toMatchObject({ url: "mqtts://broker:8883", identity: "applier", password: BROKER_PW, ca: pki.ca, root: "galatea", retainsRequests: false });
    expect(served).toEqual([{ port: 18443, host: "0.0.0.0", tls: { cert: pki.cert, key: pki.key } }]);
    await started.stop();
  });
});
