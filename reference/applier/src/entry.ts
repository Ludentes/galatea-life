import { OWNER_CREDENTIAL_MIN_LENGTH } from "./core/secret.js";
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createSecureContext } from "node:tls";
import { brokerFromUrl } from "./bus/broker-url.js";
import { isLoopback } from "./net/loopback.js";
import { mutationFromEnv, type Mutation } from "./mutations.js";

/**
 * The entry points' reading of their settings (the install-core design, *The builds' entry points*):
 * `settingsFromEnv` gives every setting `main.ts` uses, or the first refusal, before anything is
 * opened. A secret comes as a value or as a file (its `_FILE` twin, never both), a URL's password
 * from a file, and the TLS files and the broker's CA are read here into PEM and checked. Only
 * `main.ts` and `migrate-main.ts` call this module; the code below them takes values. Every refusal
 * names the settings and never repeats a secret's text. An empty value counts as unset.
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

/** Everything the applier's `main.ts` uses, read and checked. */
export interface ApplierSettings {
  /** With its password, put in from its file when one was given; never printed. */
  databaseUrl: string;
  ownerCredential: string;
  mcp: { port: number; host?: string; tls?: { cert: string; key: string } };
  /** The broker, its identity, password and CA, and the MQTT `{root}`; without it the applier has no bus. */
  broker?: { url: string; identity: string; password?: string; ca?: string; root: string };
  runId?: string;
  mutation?: Mutation;
}

/**
 * Every setting the applier's `main.ts` uses, or the first refusal. Pure but for the reads, which
 * are injected; it never throws.
 */
export function settingsFromEnv(env: Env, read: { secret?: ReadSecret; pem?: ReadPem } = {}): Setting<ApplierSettings> {
  try {
    return settings(env, read.secret ?? readSecretFile, read.pem);
  } catch {
    return { refused: "the settings could not be read" };
  }
}

/** Why `mutationFromEnv` does not take the environment's mutation; undefined when it does (none, or one it may run). */
function mutationRefused(env: Env): string | undefined {
  try {
    mutationFromEnv(env as NodeJS.ProcessEnv);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : "GALATEA_MUTATION is refused";
  }
}

function settings(env: Env, secret: ReadSecret, pem: ReadPem | undefined): Setting<ApplierSettings> {
  const databaseUrl = urlFromEnv(env, "GALATEA_DATABASE_URL", "GALATEA_DATABASE_PASSWORD_FILE", secret);
  if ("refused" in databaseUrl) return databaseUrl;
  if (databaseUrl.value === undefined) return { refused: "GALATEA_DATABASE_URL is not set" };
  const ownerCredential = secretFromEnv(env, "GALATEA_OWNER_CREDENTIAL", secret);
  if ("refused" in ownerCredential) return ownerCredential;
  if (ownerCredential.value === undefined) return { refused: "GALATEA_OWNER_CREDENTIAL is not set" };
  if (ownerCredential.value.length < OWNER_CREDENTIAL_MIN_LENGTH) {
    return { refused: `GALATEA_OWNER_CREDENTIAL is shorter than ${OWNER_CREDENTIAL_MIN_LENGTH} characters` };
  }
  const port = portFromEnv(env, "GALATEA_MCP_PORT");
  if ("refused" in port) return port;
  const cert = pemFromEnv(env, "GALATEA_APPLIER_TLS_CERT", pem);
  if ("refused" in cert) return cert;
  const key = pemFromEnv(env, "GALATEA_APPLIER_TLS_KEY", pem);
  if ("refused" in key) return key;
  const tls = checkTls(cert.value, key.value, "GALATEA_APPLIER_TLS_CERT", "GALATEA_APPLIER_TLS_KEY");
  if ("refused" in tls) return tls;
  const host = env.GALATEA_APPLIER_HOST || undefined;
  if (host !== undefined && !isLoopback(host) && !tls.value) {
    return { refused: `GALATEA_APPLIER_HOST ${host} is not loopback, and no GALATEA_APPLIER_TLS_CERT and _KEY are set (GA-SEC-1)` };
  }

  const brokerUrl = urlFromEnv(env, "GALATEA_BROKER", "GALATEA_BROKER_PASSWORD_FILE", secret);
  if ("refused" in brokerUrl) return brokerUrl;
  const ca = pemFromEnv(env, "GALATEA_BROKER_CA", pem);
  if ("refused" in ca) return ca;
  let broker: ApplierSettings["broker"];
  if (brokerUrl.value !== undefined) {
    let parsed;
    try {
      parsed = brokerFromUrl(brokerUrl.value);
    } catch (err) {
      return { refused: err instanceof Error ? err.message : "GALATEA_BROKER is not a valid URL" };
    }
    const root = env.GALATEA_ROOT || undefined;
    if (root === undefined) return { refused: "GALATEA_ROOT is not set, and GALATEA_BROKER is" };
    let checkedCa: string | undefined;
    if (ca.value !== undefined) {
      if (!parsed.url.startsWith("mqtts:")) return { refused: "GALATEA_BROKER_CA is set, and GALATEA_BROKER is not mqtts://" };
      const c = checkCa(ca.value, "GALATEA_BROKER_CA");
      if ("refused" in c) return c;
      checkedCa = c.value;
    }
    broker = { ...parsed, ...(checkedCa === undefined ? {} : { ca: checkedCa }), root };
  } else if (ca.value !== undefined) {
    return { refused: "GALATEA_BROKER_CA is set without GALATEA_BROKER" };
  }

  const refusedMutation = mutationRefused(env);
  if (refusedMutation !== undefined) return { refused: refusedMutation };
  const mutation = mutationFromEnv(env as NodeJS.ProcessEnv);
  const runId = env.GALATEA_TEST_RUN_ID || undefined;
  return {
    value: {
      databaseUrl: databaseUrl.value,
      ownerCredential: ownerCredential.value,
      mcp: { port: port.value, ...(host ? { host } : {}), ...(tls.value ? { tls: tls.value } : {}) },
      ...(broker ? { broker } : {}),
      ...(runId ? { runId } : {}),
      mutation,
    },
  };
}
