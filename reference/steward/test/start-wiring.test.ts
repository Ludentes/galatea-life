import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { settingsFromEnv, type ReadSecret } from "../src/entry.js";
import { startSteward } from "../src/start.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { privateCa } from "./private-ca.js";

// What main wires is what the settings hold (the review of plan A, I2): the URL pg is given, the
// applier link's URL, bearer and trust, and the MCP server's options, each asserted exactly, from the
// installation's settings read through settingsFromEnv.
const parsePg = createRequire(createRequire(import.meta.url).resolve("pg"))("pg-connection-string").parse as
  (url: string) => { user?: string; password?: string; host?: string; port?: string; database?: string };

async function started(env: Record<string, string>, mutation?: string) {
  const pki = privateCa();
  const secrets: ReadSecret = (path) => ({ value: path === "/run/secrets/db" ? "p@ss %#word" : path === "/run/secrets/cred" ? "steward-cr@d %#" : "token-key-of-sixteen-or-more" });
  const pems: Record<string, string> = { "/run/tls/steward.pem": pki.cert, "/run/secrets/tls.key": pki.key, "/run/tls/ca.pem": pki.ca };
  const settings = settingsFromEnv({
    GALATEA_DATABASE_URL: "postgres://steward@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/run/secrets/db",
    GALATEA_MCP_PORT: "18444", GALATEA_STEWARD_HOST: "0.0.0.0", GALATEA_STEWARD_TLS_CERT: "/run/tls/steward.pem", GALATEA_STEWARD_TLS_KEY: "/run/secrets/tls.key",
    GALATEA_APPLIER_URL: "https://applier:18443/mcp", GALATEA_APPLIER_CLIENT: "steward", GALATEA_APPLIER_CREDENTIAL_FILE: "/run/secrets/cred",
    GALATEA_APPLIER_TOKEN_KEY_FILE: "/run/secrets/key", GALATEA_APPLIER_CA: "/run/tls/ca.pem",
    ...(mutation ? { GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: mutation } : {}), ...env,
  }, { secret: secrets, pem: (p) => pems[p]! });
  if ("refused" in settings) throw new Error(settings.refused);
  const db = await memoryDb();
  const pgUrls: string[] = [];
  const links: { url: string; bearer: string; opts: unknown }[] = [];
  const served: unknown[] = [];
  let linked!: () => void;
  const tried = new Promise<void>((r) => (linked = r));
  const steward = await startSteward(settings.value, {
    clock: new FakeClock(),
    connectPg: (url) => { pgUrls.push(url); return db; },
    connectApplier: async (url, bearer, opts) => { links.push({ url: url.href, bearer, opts }); linked(); throw new Error("no applier here"); },
    serveMcp: async (_s, opts) => { served.push(opts); return { url: "https://0.0.0.0:18444/mcp", close: async () => undefined }; },
    fatal: (m) => { throw new Error(m); },
  });
  await tried;
  return { steward, pki, pgUrls, links, served };
}

describe("startSteward wires exactly what the settings hold", () => {
  it("hands pg the file's password, the applier link its URL, bearer and CA, and the MCP server its TLS", async () => {
    const { steward, pki, pgUrls, links, served } = await started({});
    expect(pgUrls).toHaveLength(1);
    expect(parsePg(pgUrls[0]!)).toMatchObject({ user: "steward", password: "p@ss %#word", host: "postgres", port: "5432", database: "galatea" });
    expect(links[0]).toEqual({ url: "https://applier:18443/mcp", bearer: "steward-cr@d %#", opts: { legacy: false, ca: pki.ca, insecure: false } });
    expect(served).toEqual([{ port: 18444, host: "0.0.0.0", tls: { cert: pki.cert, key: pki.key } }]);
    await steward.stop();
  });

  it("makes that link alone insecure under the mutation trusts-any-applier", async () => {
    const { steward, links } = await started({}, "trusts-any-applier");
    expect(links[0]?.opts).toMatchObject({ insecure: true, legacy: false });
    await steward.stop();
  });
});
