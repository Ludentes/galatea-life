#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { run } from "./cli.js";
import { type Deps, FileProblem } from "./context.js";
import { checkUrl, Link, Unreachable } from "./link.js";
import { type Applier, McpApplier, McpSteward, type Steward } from "./servers.js";

/** The installation's URLs (its design, *How the owner and a brain reach the steward*). */
export const DEFAULT_APPLIER_URL = "https://127.0.0.1:18443/mcp";
export const DEFAULT_STEWARD_URL = "https://127.0.0.1:18444/mcp";

/**
 * A secret the installation keeps in a file, as the builds read theirs (the Zigbee bridge's
 * `readSecret`): this account's file and no other's, mode 0600, not empty, one trailing newline
 * dropped. Its text is never said.
 */
export function readSecretFile(path: string, euid: number | undefined = process.geteuid?.()): string {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    throw new FileProblem(`${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!st.isFile()) throw new FileProblem(`${path} is not a file`);
  if (euid !== undefined && st.uid !== euid) throw new FileProblem(`${path} is owned by uid ${st.uid}, not by this account (uid ${euid})`);
  if (st.mode & 0o077) {
    throw new FileProblem(`${path} can be reached by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}); it must be this account's alone (0600)`);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    throw new FileProblem(`${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!text) throw new FileProblem(`${path} is empty`);
  return text;
}

/** The installation's CA, `tls/ca.pem` beside its public certificates (0644), when it has one: not secret, so not held to the owner-only test. */
function readCa(install: string): string | undefined {
  const path = join(install, "tls", "ca.pem");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new FileProblem(`${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The only reader of the environment, argv and files (the design, *The package*): the installation
 * directory (`--install` or `GALATEA_INSTALL`, else the current directory), its secrets and CA, and the
 * two URLs (`--applier`/`--steward` or `GALATEA_APPLIER_URL`/`GALATEA_STEWARD_URL`). Each link is
 * opened when a command first needs it, and closed at the end.
 */
export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const pre = parseArgs({ args: argv, options: { install: { type: "string" }, applier: { type: "string" }, steward: { type: "string" } },
    strict: false, allowPositionals: true }).values;
  const install = (typeof pre.install === "string" ? pre.install : undefined) ?? env.GALATEA_INSTALL ?? process.cwd();
  const secret = (name: string) => readSecretFile(join(install, "secrets", "mcp", name));
  const links: Link[] = [];
  const open = async (what: string, raw: string, credentialFile: string) => {
    const url = checkUrl(raw, what);
    const bearer = secret(credentialFile);
    const ca = url.protocol === "https:" ? readCa(install) : undefined;
    let link: Link;
    try {
      link = await Link.connect({ what, url, bearer, ca });
    } catch (err) {
      // Said why the system's store was trusted when it fails a certificate (review M6).
      if (err instanceof Unreachable && err.certificate && url.protocol === "https:" && ca === undefined) {
        throw new Unreachable(`${err.message} (no CA at ${join(install, "tls", "ca.pem")}; the system's store was used)`, true);
      }
      throw err;
    }
    links.push(link);
    return link;
  };
  let applier: Promise<Applier> | undefined;
  let steward: Promise<Steward> | undefined;
  const say = { out: (l: string) => void process.stdout.write(`${l}\n`), err: (l: string) => void process.stderr.write(`${l}\n`) };
  const deps: Deps = {
    say,
    applier: () => (applier ??= open("applier", (pre.applier as string | undefined) ?? env.GALATEA_APPLIER_URL ?? DEFAULT_APPLIER_URL, "applier-owner")
      .then((l) => new McpApplier(l))),
    steward: () => (steward ??= open("steward", (pre.steward as string | undefined) ?? env.GALATEA_STEWARD_URL ?? DEFAULT_STEWARD_URL, "steward-owner")
      .then((l) => new McpSteward(l))),
    secret,
    input: async (path) => {
      try {
        return path === "-" ? await readStdin() : await readFile(path, "utf8");
      } catch (err) {
        throw new FileProblem(`${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
    },
    now: () => Date.now(),
  };
  try {
    return await run(argv, deps);
  } finally {
    await Promise.all(links.map((l) => l.close()));
  }
}

/** Run as the bin (through its link too), not when a test imports `main`. */
const invoked = process.argv[1] !== undefined && (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2), process.env);
