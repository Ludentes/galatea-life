import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";
import { checkApplierUrl } from "./net/applier-url.js";
import { isLoopback } from "./net/loopback.js";
import { mutationFromEnv, type Mutation } from "./mutations.js";

/**
 * The entry points' reading of their settings (the install-core design, *The builds' entry points*):
 * `settingsFromEnv` gives every setting `main.ts` uses, or the first refusal, before anything is
 * opened. A secret comes as a value or as a file (its `_FILE` twin, never both), the store's password
 * from a file, and the TLS files and the applier's CA are read here into PEM and checked. Only
 * `main.ts` and `migrate-main.ts` call this module; the code below them takes values. Every refusal
 * names the settings and never repeats a secret's text. An empty value counts as unset. The
 * applier's build has the same module but for the settings themselves: each build stands alone.
 */

export type Env = Readonly<Record<string, string | undefined>>;
/** A setting's value, or why it is refused. */
export type Setting<T> = { value: T } | { refused: string };
/** Reads a secret file (`readSecretFile`); injected so the rules below are tested without files. */
export type ReadSecret = (path: string, what: string) => Setting<string>;
/** Reads a PEM file whole; injected likewise. */
export type ReadPem = (path: string) => string;

/** The path a setting names, said only when absolute: a value put there by mistake (a secret) is never repeated. */
function absolute(path: string, what: string): Setting<string> {
  return isAbsolute(path) ? { value: path } : { refused: `${what} does not name an absolute path` };
}

/**
 * A secret in a file: the account's own and no other's (0600), its last line end dropped, never
 * blank. Its text is never said, nor a path that is not absolute.
 */
export function readSecretFile(path: string, what: string, euid: number | undefined = process.geteuid?.()): Setting<string> {
  const at = absolute(path, what);
  if ("refused" in at) return at;
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    return { refused: `${what} ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (!st.isFile()) return { refused: `${what} ${path} is not a file` };
  if (euid !== undefined && st.uid !== euid) return { refused: `${what} ${path} is owned by uid ${st.uid}, not by this account (uid ${euid})` };
  if (st.mode & 0o077) {
    return { refused: `${what} ${path} can be reached by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}); it must be this account's alone (0600)` };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    return { refused: `${what} ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (!text.trim()) return { refused: `${what} ${path} is empty` };
  return { value: text };
}

/**
 * A secret given as `name` or as a file named by `name_FILE`; both set is refused. Neither set is
 * `undefined`, for the caller to require or not.
 */
export function secretFromEnv(env: Env, name: string, read: ReadSecret = readSecretFile): Setting<string | undefined> {
  const value = env[name] || undefined;
  const file = env[`${name}_FILE`] || undefined;
  if (value !== undefined && file !== undefined) return { refused: `${name} and ${name}_FILE are both set: set one` };
  if (file !== undefined) {
    const at = absolute(file, `${name}_FILE`);
    return "refused" in at ? at : read(file, `${name}_FILE`);
  }
  return { value };
}

/**
 * A URL (`name`) whose password may come from a file (`passwordName`): the file's text is put into
 * the URL, encoded. A URL that carries a password as well is refused, as is the file without the
 * URL, and a URL that does not parse. With no file set, the URL is used as it is (the harness's full
 * URLs). The URL is never repeated, since it may carry a password.
 */
export function urlFromEnv(env: Env, name: string, passwordName: string, read: ReadSecret = readSecretFile): Setting<string | undefined> {
  const raw = env[name] || undefined;
  const file = env[passwordName] || undefined;
  if (raw === undefined) return file === undefined ? { value: undefined } : { refused: `${passwordName} is set without ${name}` };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { refused: `${name} is not a valid URL` };
  }
  if (file === undefined) return { value: raw };
  if (u.password) return { refused: `${name} carries a password and ${passwordName} is set: set one` };
  if (!u.username) return { refused: `${name} names no user for the password in ${passwordName}` };
  const at = absolute(file, passwordName);
  if ("refused" in at) return at;
  const password = read(file, passwordName);
  if ("refused" in password) return password;
  u.password = encodeURIComponent(password.value);
  return { value: u.toString() };
}

/** A PEM file named by `name` (a certificate, a key or a CA); unset is `undefined`. */
export function pemFromEnv(env: Env, name: string, read: ReadPem = (p) => readFileSync(p, "utf8")): Setting<string | undefined> {
  const path = env[name] || undefined;
  if (path === undefined) return { value: undefined };
  const at = absolute(path, name);
  if ("refused" in at) return at;
  try {
    return { value: read(path) };
  } catch (err) {
    return { refused: `${name} ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

/** A CA certificate, refused unless it parses as one (an empty or non-PEM file included). */
export function checkCa(pem: string, name: string): Setting<string> {
  try {
    new X509Certificate(pem);
    return { value: pem };
  } catch {
    return { refused: `${name} holds no PEM certificate` };
  }
}

/** A certificate and key, given both or neither, refused unless TLS can be served with them. */
export function checkTls(cert: string | undefined, key: string | undefined, certName: string, keyName: string):
Setting<{ cert: string; key: string } | undefined> {
  if (cert === undefined && key === undefined) return { value: undefined };
  if (cert === undefined || key === undefined) return { refused: `${certName} and ${keyName} are set together or not at all` };
  try {
    createSecureContext({ cert, key });
    return { value: { cert, key } };
  } catch {
    return { refused: `${certName} and ${keyName} are not a PEM certificate and its key` };
  }
}

/** A TCP port, an integer from 1 to 65535. */
export function portFromEnv(env: Env, name: string): Setting<number> {
  const raw = env[name] || undefined;
  if (raw === undefined) return { refused: `${name} is not set` };
  const port = Number(raw);
  return /^\d+$/.test(raw) && port >= 1 && port <= 65535 ? { value: port } : { refused: `${name} is not a port (1 to 65535)` };
}

/** The shortest secret the steward takes: its token key, and the first owner's credential (the steward's own floor). */
const MIN_SECRET = 16;

/** Everything the steward's `main.ts` uses, read and checked. */
export interface StewardSettings {
  /** With its password, put in from its file when one was given; never printed. */
  databaseUrl: string;
  /** Makes the first owner on a store with no person. */
  ownerCredential?: string;
  stewardId: string;
  mcp: { port: number; host?: string; tls?: { cert: string; key: string } };
  applier: {
    /** The URL GA-SEC-2 allows, or why it does not: then the steward serves, and its applier stays out of reach, which it logs. */
    url: { value: URL } | { refused: string };
    client: string;
    credential: string;
    tokenKey: string;
    /** The CA the link alone trusts, instead of the system's store. */
    ca?: string;
  };
  runId?: string;
  mutation?: Mutation;
}

/**
 * Every setting the steward's `main.ts` uses, or the first refusal. Pure but for the reads, which
 * are injected; it never throws.
 */
export function settingsFromEnv(env: Env, read: { secret?: ReadSecret; pem?: ReadPem } = {}): Setting<StewardSettings> {
  try {
    return settings(env, read.secret ?? readSecretFile, read.pem);
  } catch {
    return { refused: "the settings could not be read" };
  }
}

/** Whether `mutationFromEnv` takes the environment's mutation (none, or one this build has). */
function knowsMutation(env: Env): boolean {
  try {
    mutationFromEnv(env as NodeJS.ProcessEnv);
    return true;
  } catch {
    return false;
  }
}

function required(env: Env, name: string, secret: ReadSecret, floor = 0): Setting<string> {
  const v = secretFromEnv(env, name, secret);
  if ("refused" in v) return v;
  if (v.value === undefined) return { refused: `${name} is not set` };
  if ([...v.value].length < floor) return { refused: `${name} is shorter than ${floor} characters` };
  return { value: v.value };
}

function settings(env: Env, secret: ReadSecret, pem: ReadPem | undefined): Setting<StewardSettings> {
  const databaseUrl = urlFromEnv(env, "GALATEA_DATABASE_URL", "GALATEA_DATABASE_PASSWORD_FILE", secret);
  if ("refused" in databaseUrl) return databaseUrl;
  if (databaseUrl.value === undefined) return { refused: "GALATEA_DATABASE_URL is not set" };
  const ownerCredential = secretFromEnv(env, "GALATEA_OWNER_CREDENTIAL", secret);
  if ("refused" in ownerCredential) return ownerCredential;
  const port = portFromEnv(env, "GALATEA_MCP_PORT");
  if ("refused" in port) return port;
  const cert = pemFromEnv(env, "GALATEA_STEWARD_TLS_CERT", pem);
  if ("refused" in cert) return cert;
  const key = pemFromEnv(env, "GALATEA_STEWARD_TLS_KEY", pem);
  if ("refused" in key) return key;
  const tls = checkTls(cert.value, key.value, "GALATEA_STEWARD_TLS_CERT", "GALATEA_STEWARD_TLS_KEY");
  if ("refused" in tls) return tls;
  // Plain HTTP only on loopback (GA-SEC-2): a steward told to serve it elsewhere refuses to start.
  const host = env.GALATEA_STEWARD_HOST || undefined;
  if (host !== undefined && !isLoopback(host) && !tls.value) {
    return { refused: `GALATEA_STEWARD_HOST ${host} is not loopback, and no GALATEA_STEWARD_TLS_CERT and _KEY are set: refusing to serve plain HTTP there (GA-SEC-2)` };
  }

  const rawUrl = env.GALATEA_APPLIER_URL || undefined;
  if (rawUrl === undefined) return { refused: "GALATEA_APPLIER_URL is not set" };
  let url: { value: URL } | { refused: string };
  try {
    url = { value: checkApplierUrl(rawUrl) };
  } catch (err) {
    url = { refused: err instanceof Error ? err.message : "GALATEA_APPLIER_URL is refused" };
  }
  const client = env.GALATEA_APPLIER_CLIENT || undefined;
  if (client === undefined) return { refused: "GALATEA_APPLIER_CLIENT is not set" };
  const credential = required(env, "GALATEA_APPLIER_CREDENTIAL", secret);
  if ("refused" in credential) return credential;
  const tokenKey = required(env, "GALATEA_APPLIER_TOKEN_KEY", secret, MIN_SECRET);
  if ("refused" in tokenKey) return tokenKey;
  const ca = pemFromEnv(env, "GALATEA_APPLIER_CA", pem);
  if ("refused" in ca) return ca;
  if (ca.value !== undefined) {
    if ("value" in url && url.value.protocol !== "https:") return { refused: "GALATEA_APPLIER_CA is set, and GALATEA_APPLIER_URL is not https://" };
    const c = checkCa(ca.value, "GALATEA_APPLIER_CA");
    if ("refused" in c) return c;
  }

  if (!knowsMutation(env)) return { refused: "GALATEA_MUTATION names no mutation this build has" };
  const mutation = mutationFromEnv(env as NodeJS.ProcessEnv);
  const runId = env.GALATEA_TEST_RUN_ID || undefined;
  return {
    value: {
      databaseUrl: databaseUrl.value,
      ...(ownerCredential.value === undefined ? {} : { ownerCredential: ownerCredential.value }),
      stewardId: env.GALATEA_STEWARD_ID || "steward",
      mcp: { port: port.value, ...(host ? { host } : {}), ...(tls.value ? { tls: tls.value } : {}) },
      applier: { url, client, credential: credential.value, tokenKey: tokenKey.value, ...(ca.value === undefined ? {} : { ca: ca.value }) },
      ...(runId ? { runId } : {}),
      mutation,
    },
  };
}
