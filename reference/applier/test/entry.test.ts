import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pemFromEnv, readSecretFile, secretFromEnv, settingsFromEnv, urlFromEnv, type ReadSecret } from "../src/entry.js";
import { privateCa } from "./private-ca.js";

const dir = mkdtempSync(join(tmpdir(), "applier-entry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function file(name: string, text: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}
/** A secret file's reader that knows two paths, so the rules are tested apart from the file checks. */
const files: ReadSecret = (path, what) => (path === "/s/pw" ? { value: "p@ss word" } : path === "/s/owner" ? { value: "from-a-file" } : { refused: `${what} ${path} cannot be read (ENOENT)` });

describe("readSecretFile", () => {
  it("reads the account's own 0600 file, dropping one last line end", () => {
    expect(readSecretFile(file("a", "top-secret\n"), "X_FILE")).toEqual({ value: "top-secret" });
    expect(readSecretFile(file("b", "top-secret\r\n"), "X_FILE")).toEqual({ value: "top-secret" });
  });

  it("refuses a file other accounts can reach, another account's, an empty one or none, never saying its text", () => {
    const open = readSecretFile(file("c", "top-secret", 0o640), "X_FILE");
    expect(open).toEqual({ refused: expect.stringMatching(/X_FILE .* can be reached by other accounts \(mode 0640\)/) });
    const other = readSecretFile(file("d", "top-secret"), "X_FILE", 4242);
    expect(other).toEqual({ refused: expect.stringMatching(/not by this account \(uid 4242\)/) });
    expect(readSecretFile(file("e", "\n"), "X_FILE")).toEqual({ refused: expect.stringMatching(/is empty/) });
    expect(readSecretFile(join(dir, "none"), "X_FILE")).toEqual({ refused: expect.stringMatching(/cannot be read \(ENOENT\)/) });
    expect(readSecretFile(dir, "X_FILE")).toEqual({ refused: expect.stringMatching(/is not a file/) });
    for (const r of [open, other]) expect(JSON.stringify(r)).not.toMatch(/top-secret/);
  });
});

describe("secretFromEnv: a secret and its _FILE twin", () => {
  it("unset is undefined; the value alone is the value; the file alone is the file's text", () => {
    expect(secretFromEnv({}, "GALATEA_OWNER_CREDENTIAL", files)).toEqual({ value: undefined });
    expect(secretFromEnv({ GALATEA_OWNER_CREDENTIAL: "v" }, "GALATEA_OWNER_CREDENTIAL", files)).toEqual({ value: "v" });
    expect(secretFromEnv({ GALATEA_OWNER_CREDENTIAL_FILE: "/s/owner" }, "GALATEA_OWNER_CREDENTIAL", files)).toEqual({ value: "from-a-file" });
  });

  it("refuses both set, naming the two settings and neither value", () => {
    const r = secretFromEnv({ GALATEA_OWNER_CREDENTIAL: "the-value", GALATEA_OWNER_CREDENTIAL_FILE: "/s/owner" }, "GALATEA_OWNER_CREDENTIAL", files);
    expect(r).toEqual({ refused: "GALATEA_OWNER_CREDENTIAL and GALATEA_OWNER_CREDENTIAL_FILE are both set: set one" });
  });

  it("passes the file's refusal on", () => {
    expect(secretFromEnv({ GALATEA_OWNER_CREDENTIAL_FILE: "/s/none" }, "GALATEA_OWNER_CREDENTIAL", files))
      .toEqual({ refused: "GALATEA_OWNER_CREDENTIAL_FILE /s/none cannot be read (ENOENT)" });
  });
});

describe("urlFromEnv: a URL and its password file", () => {
  const db = (env: Record<string, string>) => urlFromEnv(env, "GALATEA_DATABASE_URL", "GALATEA_DATABASE_PASSWORD_FILE", files);

  it("uses the full URL as it is when no file is set (the harness's)", () => {
    expect(db({ GALATEA_DATABASE_URL: "postgres://applier:pw@127.0.0.1:5432/x" })).toEqual({ value: "postgres://applier:pw@127.0.0.1:5432/x" });
    expect(db({})).toEqual({ value: undefined });
  });

  it("puts the file's password into a password-less URL, encoded", () => {
    expect(db({ GALATEA_DATABASE_URL: "postgres://applier@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ value: "postgres://applier:p%40ss%20word@postgres:5432/galatea" });
    expect(urlFromEnv({ GALATEA_BROKER: "mqtts://applier@broker:8883", GALATEA_BROKER_PASSWORD_FILE: "/s/pw" }, "GALATEA_BROKER", "GALATEA_BROKER_PASSWORD_FILE", files))
      .toEqual({ value: "mqtts://applier:p%40ss%20word@broker:8883" });
  });

  it("refuses a URL carrying a password with the file set, the file without the URL, and a URL with no user, never repeating the URL", () => {
    const both = db({ GALATEA_DATABASE_URL: "postgres://applier:in-the-url@postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" });
    expect(both).toEqual({ refused: "GALATEA_DATABASE_URL carries a password and GALATEA_DATABASE_PASSWORD_FILE is set: set one" });
    expect(db({ GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" })).toEqual({ refused: "GALATEA_DATABASE_PASSWORD_FILE is set without GALATEA_DATABASE_URL" });
    expect(db({ GALATEA_DATABASE_URL: "postgres://postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ refused: expect.stringMatching(/names no user/) });
    expect(db({ GALATEA_DATABASE_URL: "not a url in-the-url", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ refused: "GALATEA_DATABASE_URL is not a valid URL" });
    expect(db({ GALATEA_DATABASE_URL: "postgres://applier@postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/none" }))
      .toEqual({ refused: expect.stringMatching(/GALATEA_DATABASE_PASSWORD_FILE \/s\/none cannot be read/) });
    expect(JSON.stringify(both)).not.toMatch(/in-the-url/);
  });
});

describe("pemFromEnv", () => {
  it("reads the file a setting names, and refuses one it cannot read, naming the setting", () => {
    expect(pemFromEnv({ GALATEA_BROKER_CA: file("ca.pem", "-----BEGIN CERTIFICATE-----\n", 0o644) }, "GALATEA_BROKER_CA"))
      .toEqual({ value: "-----BEGIN CERTIFICATE-----\n" });
    expect(pemFromEnv({}, "GALATEA_BROKER_CA")).toEqual({ value: undefined });
    expect(pemFromEnv({ GALATEA_BROKER_CA: join(dir, "none.pem") }, "GALATEA_BROKER_CA"))
      .toEqual({ refused: expect.stringMatching(/^GALATEA_BROKER_CA .*none\.pem cannot be read \(ENOENT\)$/) });
  });
});

describe("settingsFromEnv: every setting main uses, read and checked before anything opens", () => {
  const pki = privateCa();
  const PASSWORD = "p@ss %#word";
  /** Secret files and PEM files by path, as the installation binds them. */
  const secrets: ReadSecret = (path, what) =>
    path === "/run/secrets/db" ? { value: PASSWORD } : path === "/run/secrets/broker" ? { value: "b@r %#ker" }
      : path === "/run/secrets/owner" ? { value: "owner-from-the-file" } : { refused: `${what} ${path} cannot be read (ENOENT)` };
  const pems: Record<string, string> = { "/run/tls/applier.pem": pki.cert, "/run/secrets/tls.key": pki.key, "/run/tls/ca.pem": pki.ca,
    "/run/tls/empty.pem": "", "/run/tls/junk.pem": "not a certificate", "/run/tls/other.key": privateCa().key };
  const read = { secret: secrets, pem: (p: string) => { if (!(p in pems)) throw Object.assign(new Error("no"), { code: "ENOENT" }); return pems[p]!; } };
  const INSTALL = {
    GALATEA_DATABASE_URL: "postgres://applier@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/run/secrets/db",
    GALATEA_BROKER: "mqtts://applier@broker:8883", GALATEA_BROKER_PASSWORD_FILE: "/run/secrets/broker", GALATEA_BROKER_CA: "/run/tls/ca.pem",
    GALATEA_ROOT: "galatea", GALATEA_OWNER_CREDENTIAL_FILE: "/run/secrets/owner", GALATEA_MCP_PORT: "18443", GALATEA_APPLIER_HOST: "0.0.0.0",
    GALATEA_APPLIER_TLS_CERT: "/run/tls/applier.pem", GALATEA_APPLIER_TLS_KEY: "/run/secrets/tls.key",
  };
  const settings = (env: Record<string, string | undefined>) => settingsFromEnv(env, read);
  const refusal = (env: Record<string, string | undefined>) => {
    const r = settings(env);
    return "refused" in r ? r.refused : `not refused: ${JSON.stringify(r.value)}`;
  };

  it("gives the installation's settings exactly, the files' passwords encoded into the URLs", () => {
    expect(settings(INSTALL)).toEqual({ value: {
      databaseUrl: "postgres://applier:p%40ss%20%25%23word@postgres:5432/galatea",
      ownerCredential: "owner-from-the-file",
      mcp: { port: 18443, host: "0.0.0.0", tls: { cert: pki.cert, key: pki.key } },
      broker: { url: "mqtts://broker:8883", identity: "applier", password: "b@r %#ker", ca: pki.ca, root: "galatea" },
    } });
  });

  it("gives the harness's settings as it passes them: full URLs and values, no files", () => {
    expect(settings({ GALATEA_DATABASE_URL: "postgres://t:pw@127.0.0.1:5/db", GALATEA_OWNER_CREDENTIAL: "owner-of-sixteen-chars", GALATEA_MCP_PORT: "4000",
      GALATEA_BROKER: "mqtt://subject-applier@127.0.0.1:1883", GALATEA_ROOT: "demo/r/t1", GALATEA_TEST_RUN_ID: "run-1", GALATEA_MUTATION: "retains-request" }))
      .toEqual({ value: { databaseUrl: "postgres://t:pw@127.0.0.1:5/db", ownerCredential: "owner-of-sixteen-chars", mcp: { port: 4000 },
        broker: { url: "mqtt://127.0.0.1:1883", identity: "subject-applier", root: "demo/r/t1" }, runId: "run-1", mutation: "retains-request" } });
  });

  it("counts an empty value as unset", () => {
    expect(settings({ ...INSTALL, GALATEA_OWNER_CREDENTIAL: "", GALATEA_APPLIER_HOST: "", GALATEA_BROKER_PASSWORD_FILE: "" }))
      .toMatchObject({ value: { ownerCredential: "owner-from-the-file", mcp: { port: 18443 } } });
  });

  it("refuses what main would otherwise find wrong only after opening the store", () => {
    expect(refusal({ ...INSTALL, GALATEA_ROOT: undefined })).toBe("GALATEA_ROOT is not set, and GALATEA_BROKER is");
    expect(refusal({ ...INSTALL, GALATEA_BROKER: "http://applier@broker:1", GALATEA_BROKER_CA: undefined, GALATEA_BROKER_PASSWORD_FILE: undefined }))
      .toBe("GALATEA_BROKER is not a valid URL");
    expect(refusal({ ...INSTALL, GALATEA_MCP_PORT: undefined })).toBe("GALATEA_MCP_PORT is not set");
    for (const port of ["0", "65536", "18443.5", "x", "-1"]) expect(refusal({ ...INSTALL, GALATEA_MCP_PORT: port })).toBe("GALATEA_MCP_PORT is not a port (1 to 65535)");
    expect(refusal({ ...INSTALL, GALATEA_TEST_RUN_ID: "r", GALATEA_MUTATION: "nope" })).toBe("GALATEA_MUTATION names no mutation this build has");
    // The owner's credential reaches everything: 16 characters at least (the whole-applier review's M7).
    expect(refusal({ ...INSTALL, GALATEA_OWNER_CREDENTIAL_FILE: undefined, GALATEA_OWNER_CREDENTIAL: "fifteen-chars-x" }))
      .toBe("GALATEA_OWNER_CREDENTIAL is shorter than 16 characters");
    expect(settings({ ...INSTALL, GALATEA_OWNER_CREDENTIAL_FILE: undefined, GALATEA_OWNER_CREDENTIAL: "sixteen-chars-xy" }))
      .toMatchObject({ value: { ownerCredential: "sixteen-chars-xy" } });
    // A mutation that defeats a safety floor needs the harness's clock too (the whole-applier review's M5).
    for (const m of ["trusts-any-token", "applies-without-token", "lets-a-client-undo-safety"]) {
      expect(refusal({ ...INSTALL, GALATEA_TEST_RUN_ID: "r", GALATEA_MUTATION: m })).toMatch(/defeats a safety floor.*GALATEA_TIME_SOURCE/);
      expect(settings({ ...INSTALL, GALATEA_TEST_RUN_ID: "r", GALATEA_TIME_SOURCE: "ws://127.0.0.1:1/time", GALATEA_MUTATION: m }))
        .toMatchObject({ value: { mutation: m } });
    }
    expect(settings({ ...INSTALL, GALATEA_TEST_RUN_ID: "r", GALATEA_MUTATION: "retains-request" })).toMatchObject({ value: { mutation: "retains-request" } });
    expect(refusal({ ...INSTALL, GALATEA_DATABASE_URL: "postgres://applier:pw@127.0.0.1:notaport/x", GALATEA_DATABASE_PASSWORD_FILE: undefined }))
      .toBe("GALATEA_DATABASE_URL is not a valid URL");
  });

  it("refuses a CA without an mqtts broker, and a certificate without its key (M3)", () => {
    expect(refusal({ ...INSTALL, GALATEA_BROKER: "mqtt://applier@broker:1883" })).toBe("GALATEA_BROKER_CA is set, and GALATEA_BROKER is not mqtts://");
    expect(refusal({ ...INSTALL, GALATEA_BROKER: undefined, GALATEA_BROKER_PASSWORD_FILE: undefined })).toBe("GALATEA_BROKER_CA is set without GALATEA_BROKER");
    for (const gone of ["GALATEA_APPLIER_TLS_CERT", "GALATEA_APPLIER_TLS_KEY"]) {
      expect(refusal({ ...INSTALL, [gone]: undefined })).toBe("GALATEA_APPLIER_TLS_CERT and GALATEA_APPLIER_TLS_KEY are set together or not at all");
    }
  });

  it("refuses a CA that is no certificate, and a certificate and key that do not serve TLS together (M2)", () => {
    expect(refusal({ ...INSTALL, GALATEA_BROKER_CA: "/run/tls/empty.pem" })).toBe("GALATEA_BROKER_CA holds no PEM certificate");
    expect(refusal({ ...INSTALL, GALATEA_BROKER_CA: "/run/tls/junk.pem" })).toBe("GALATEA_BROKER_CA holds no PEM certificate");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_TLS_KEY: "/run/tls/other.key" }))
      .toBe("GALATEA_APPLIER_TLS_CERT and GALATEA_APPLIER_TLS_KEY are not a PEM certificate and its key");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_TLS_CERT: "/run/tls/junk.pem" }))
      .toBe("GALATEA_APPLIER_TLS_CERT and GALATEA_APPLIER_TLS_KEY are not a PEM certificate and its key");
  });

  it("refuses serving off loopback without TLS (GA-SEC-1), before the store opens", () => {
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_TLS_CERT: undefined, GALATEA_APPLIER_TLS_KEY: undefined }))
      .toBe("GALATEA_APPLIER_HOST 0.0.0.0 is not loopback, and no GALATEA_APPLIER_TLS_CERT and _KEY are set (GA-SEC-1)");
  });

  it("never repeats a value put into a path setting by mistake (M1)", () => {
    for (const [name, value] of [["GALATEA_DATABASE_PASSWORD_FILE", "Tr0ub4dor&3-db-pw"], ["GALATEA_OWNER_CREDENTIAL_FILE", "owner-cred-value-xyz"],
      ["GALATEA_APPLIER_TLS_KEY", "the key's PEM text, put here by mistake"]] as const) {
      const r = settings({ ...INSTALL, [name]: value });
      expect(r).toEqual({ refused: `${name} does not name an absolute path` });
    }
  });
});
