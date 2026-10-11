import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pemFromEnv, readSecretFile, secretFromEnv, settingsFromEnv, urlFromEnv, type ReadSecret } from "../src/entry.js";
import { privateCa } from "./private-ca.js";

const dir = mkdtempSync(join(tmpdir(), "steward-entry-"));
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
    expect(secretFromEnv({}, "GALATEA_APPLIER_CREDENTIAL", files)).toEqual({ value: undefined });
    expect(secretFromEnv({ GALATEA_APPLIER_CREDENTIAL: "v" }, "GALATEA_APPLIER_CREDENTIAL", files)).toEqual({ value: "v" });
    expect(secretFromEnv({ GALATEA_APPLIER_CREDENTIAL_FILE: "/s/owner" }, "GALATEA_APPLIER_CREDENTIAL", files)).toEqual({ value: "from-a-file" });
  });

  it("refuses both set, naming the two settings and neither value", () => {
    const r = secretFromEnv({ GALATEA_APPLIER_CREDENTIAL: "the-value", GALATEA_APPLIER_CREDENTIAL_FILE: "/s/owner" }, "GALATEA_APPLIER_CREDENTIAL", files);
    expect(r).toEqual({ refused: "GALATEA_APPLIER_CREDENTIAL and GALATEA_APPLIER_CREDENTIAL_FILE are both set: set one" });
  });

  it("passes the file's refusal on", () => {
    expect(secretFromEnv({ GALATEA_APPLIER_CREDENTIAL_FILE: "/s/none" }, "GALATEA_APPLIER_CREDENTIAL", files))
      .toEqual({ refused: "GALATEA_APPLIER_CREDENTIAL_FILE /s/none cannot be read (ENOENT)" });
  });
});

describe("urlFromEnv: a URL and its password file", () => {
  const db = (env: Record<string, string>) => urlFromEnv(env, "GALATEA_DATABASE_URL", "GALATEA_DATABASE_PASSWORD_FILE", files);

  it("uses the full URL as it is when no file is set (the harness's)", () => {
    expect(db({ GALATEA_DATABASE_URL: "postgres://steward:pw@127.0.0.1:5432/x" })).toEqual({ value: "postgres://steward:pw@127.0.0.1:5432/x" });
    expect(db({})).toEqual({ value: undefined });
  });

  it("puts the file's password into a password-less URL, encoded", () => {
    expect(db({ GALATEA_DATABASE_URL: "postgres://steward@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ value: "postgres://steward:p%40ss%20word@postgres:5432/galatea" });
  });

  it("refuses a URL carrying a password with the file set, the file without the URL, and a URL with no user, never repeating the URL", () => {
    const both = db({ GALATEA_DATABASE_URL: "postgres://steward:in-the-url@postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" });
    expect(both).toEqual({ refused: "GALATEA_DATABASE_URL carries a password and GALATEA_DATABASE_PASSWORD_FILE is set: set one" });
    expect(db({ GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" })).toEqual({ refused: "GALATEA_DATABASE_PASSWORD_FILE is set without GALATEA_DATABASE_URL" });
    expect(db({ GALATEA_DATABASE_URL: "postgres://postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ refused: expect.stringMatching(/names no user/) });
    expect(db({ GALATEA_DATABASE_URL: "not a url in-the-url", GALATEA_DATABASE_PASSWORD_FILE: "/s/pw" }))
      .toEqual({ refused: "GALATEA_DATABASE_URL is not a valid URL" });
    expect(db({ GALATEA_DATABASE_URL: "postgres://steward@postgres/g", GALATEA_DATABASE_PASSWORD_FILE: "/s/none" }))
      .toEqual({ refused: expect.stringMatching(/GALATEA_DATABASE_PASSWORD_FILE \/s\/none cannot be read/) });
    expect(JSON.stringify(both)).not.toMatch(/in-the-url/);
  });
});

describe("pemFromEnv", () => {
  it("reads the file a setting names, and refuses one it cannot read, naming the setting", () => {
    expect(pemFromEnv({ GALATEA_APPLIER_CA: file("ca.pem", "-----BEGIN CERTIFICATE-----\n", 0o644) }, "GALATEA_APPLIER_CA"))
      .toEqual({ value: "-----BEGIN CERTIFICATE-----\n" });
    expect(pemFromEnv({}, "GALATEA_APPLIER_CA")).toEqual({ value: undefined });
    expect(pemFromEnv({ GALATEA_APPLIER_CA: join(dir, "none.pem") }, "GALATEA_APPLIER_CA"))
      .toEqual({ refused: expect.stringMatching(/^GALATEA_APPLIER_CA .*none\.pem cannot be read \(ENOENT\)$/) });
  });
});

describe("settingsFromEnv: every setting main uses, read and checked before anything opens", () => {
  const pki = privateCa();
  const PASSWORD = "p@ss %#word";
  const secrets: ReadSecret = (path, what) =>
    path === "/run/secrets/db" ? { value: PASSWORD } : path === "/run/secrets/cred" ? { value: "steward-credential" }
      : path === "/run/secrets/key" ? { value: "token-key-of-sixteen-or-more" } : path === "/run/secrets/owner" ? { value: "owner-from-a-file-xyz" }
        : { refused: `${what} ${path} cannot be read (ENOENT)` };
  const pems: Record<string, string> = { "/run/tls/steward.pem": pki.cert, "/run/secrets/tls.key": pki.key, "/run/tls/ca.pem": pki.ca,
    "/run/tls/empty.pem": "", "/run/tls/junk.pem": "not a certificate", "/run/tls/other.key": privateCa().key };
  const read = { secret: secrets, pem: (p: string) => { if (!(p in pems)) throw Object.assign(new Error("no"), { code: "ENOENT" }); return pems[p]!; } };
  const INSTALL = {
    GALATEA_DATABASE_URL: "postgres://steward@postgres:5432/galatea", GALATEA_DATABASE_PASSWORD_FILE: "/run/secrets/db",
    GALATEA_OWNER_CREDENTIAL_FILE: "/run/secrets/owner", GALATEA_MCP_PORT: "18444", GALATEA_STEWARD_HOST: "0.0.0.0",
    GALATEA_STEWARD_TLS_CERT: "/run/tls/steward.pem", GALATEA_STEWARD_TLS_KEY: "/run/secrets/tls.key",
    GALATEA_APPLIER_URL: "https://applier:18443/mcp", GALATEA_APPLIER_CLIENT: "steward", GALATEA_APPLIER_CREDENTIAL_FILE: "/run/secrets/cred",
    GALATEA_APPLIER_TOKEN_KEY_FILE: "/run/secrets/key", GALATEA_APPLIER_CA: "/run/tls/ca.pem",
  };
  const settings = (env: Record<string, string | undefined>) => settingsFromEnv(env, read);
  const refusal = (env: Record<string, string | undefined>) => {
    const r = settings(env);
    return "refused" in r ? r.refused : `not refused: ${JSON.stringify(r.value)}`;
  };

  it("gives the installation's settings exactly, the file's password encoded into the URL", () => {
    expect(settings(INSTALL)).toEqual({ value: {
      databaseUrl: "postgres://steward:p%40ss%20%25%23word@postgres:5432/galatea",
      ownerCredential: "owner-from-a-file-xyz",
      stewardId: "steward",
      mcp: { port: 18444, host: "0.0.0.0", tls: { cert: pki.cert, key: pki.key } },
      applier: { url: { value: new URL("https://applier:18443/mcp") }, client: "steward", credential: "steward-credential",
        tokenKey: "token-key-of-sixteen-or-more", ca: pki.ca },
    } });
  });

  it("keeps an applier URL GA-SEC-2 does not allow as a refusal the steward logs and serves on", () => {
    const r = settings({ ...INSTALL, GALATEA_APPLIER_URL: "http://192.0.2.10/mcp", GALATEA_APPLIER_CA: undefined });
    expect(r).toMatchObject({ value: { applier: { url: { refused: expect.stringMatching(/must be https \(GA-SEC-2\)/) } } } });
  });

  it("refuses what main would otherwise find wrong only after opening the store", () => {
    expect(refusal({ ...INSTALL, GALATEA_MCP_PORT: undefined })).toBe("GALATEA_MCP_PORT is not set");
    for (const port of ["0", "65536", "1.5", "x"]) expect(refusal({ ...INSTALL, GALATEA_MCP_PORT: port })).toBe("GALATEA_MCP_PORT is not a port (1 to 65535)");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_URL: undefined })).toBe("GALATEA_APPLIER_URL is not set");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_CLIENT: "" })).toBe("GALATEA_APPLIER_CLIENT is not set");
    expect(refusal({ ...INSTALL, GALATEA_TEST_RUN_ID: "r", GALATEA_MUTATION: "nope" })).toBe("GALATEA_MUTATION names no mutation this build has");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_TOKEN_KEY_FILE: undefined, GALATEA_APPLIER_TOKEN_KEY: "short" }))
      .toBe("GALATEA_APPLIER_TOKEN_KEY is shorter than 16 characters");
  });

  it("refuses the applier's CA for a URL that is not https, and a certificate without its key (M3)", () => {
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_URL: "http://127.0.0.1:18443/mcp" })).toBe("GALATEA_APPLIER_CA is set, and GALATEA_APPLIER_URL is not https://");
    for (const gone of ["GALATEA_STEWARD_TLS_CERT", "GALATEA_STEWARD_TLS_KEY"]) {
      expect(refusal({ ...INSTALL, [gone]: undefined })).toBe("GALATEA_STEWARD_TLS_CERT and GALATEA_STEWARD_TLS_KEY are set together or not at all");
    }
  });

  it("refuses a CA that is no certificate, and a certificate and key that do not serve TLS together (M2)", () => {
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_CA: "/run/tls/empty.pem" })).toBe("GALATEA_APPLIER_CA holds no PEM certificate");
    expect(refusal({ ...INSTALL, GALATEA_APPLIER_CA: "/run/tls/junk.pem" })).toBe("GALATEA_APPLIER_CA holds no PEM certificate");
    expect(refusal({ ...INSTALL, GALATEA_STEWARD_TLS_KEY: "/run/tls/other.key" }))
      .toBe("GALATEA_STEWARD_TLS_CERT and GALATEA_STEWARD_TLS_KEY are not a PEM certificate and its key");
  });

  it("refuses serving off loopback without TLS (GA-SEC-2)", () => {
    expect(refusal({ ...INSTALL, GALATEA_STEWARD_TLS_CERT: undefined, GALATEA_STEWARD_TLS_KEY: undefined })).toMatch(/^GALATEA_STEWARD_HOST 0\.0\.0\.0 is not loopback/);
  });

  it("never repeats a value put into a path setting by mistake (M1)", () => {
    for (const [name, value] of [["GALATEA_DATABASE_PASSWORD_FILE", "Tr0ub4dor&3-db-pw"], ["GALATEA_APPLIER_CREDENTIAL_FILE", "cred-value-xyz"],
      ["GALATEA_APPLIER_TOKEN_KEY_FILE", "token-key-value-xyz"], ["GALATEA_STEWARD_TLS_KEY", "the key's PEM text, put here by mistake"]] as const) {
      expect(settings({ ...INSTALL, [name]: value })).toEqual({ refused: `${name} does not name an absolute path` });
    }
  });
});
