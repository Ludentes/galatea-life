// A throwaway installation for one test file: its own Compose project,
// settings file, secrets, instances, backups and volumes.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The client the tests connect with: a build's view, from another container. */
const CLIENT = "postgres:18-alpine";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

async function must(p: Promise<Run>, what: string): Promise<Run> {
  const r = await p;
  if (r.code !== 0) throw new Error(`${what} exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  return r;
}

export class Stack {
  readonly dir: string;
  readonly project: string;
  readonly envFile: string;
  /** secrets/, and its parts: the store's passwords, the broker's, the MCP credentials, the servers' keys, the CA's key. */
  readonly secretsRoot: string;
  readonly secrets: string;
  readonly brokerSecrets: string;
  readonly mcpSecrets: string;
  /** tls/: the CA's and the servers' certificates. */
  readonly tls: string;
  /** The secrets archive's directory, which no service mounts. */
  readonly archive: string;
  /** The ports the applier and the steward are published on, on the host's loopback. */
  readonly applierPort: number;
  readonly stewardPort: number;
  readonly backups: string;
  readonly instancesFile: string;
  /** Compose files added after compose.yaml, for a test's own services (a test-only file). */
  readonly files: string[];

  private constructor(settings: Record<string, string>, files: string[] = []) {
    this.files = files;
    this.dir = mkdtempSync(join(tmpdir(), "galatea-install-"));
    this.project = `gtest-${randomBytes(4).toString("hex")}`;
    this.envFile = join(this.dir, ".env");
    this.secretsRoot = join(this.dir, "secrets");
    this.secrets = join(this.secretsRoot, "db");
    this.brokerSecrets = join(this.secretsRoot, "broker");
    this.mcpSecrets = join(this.secretsRoot, "mcp");
    this.tls = join(this.dir, "tls");
    this.archive = join(this.dir, "backups-secrets");
    // Each test file's stack publishes its own ports, so files run side by side.
    this.applierPort = 20000 + randomBytes(2).readUInt16BE() % 20000;
    this.stewardPort = this.applierPort + 1;
    this.backups = join(this.dir, "backups");
    this.instancesFile = join(this.dir, "instances");
    const all = {
      GALATEA_SECRETS: this.secretsRoot,
      GALATEA_TLS: this.tls,
      GALATEA_SECRETS_BACKUPS: this.archive,
      GALATEA_APPLIER_PORT: String(this.applierPort),
      GALATEA_STEWARD_PORT: String(this.stewardPort),
      GALATEA_INSTANCES: this.instancesFile,
      GALATEA_BACKUPS: this.backups,
      GALATEA_ZIGBEE_DATA: join(this.dir, "zigbee"),
      GALATEA_PGDATA_PREFIX: `${this.project}-pgdata`,
      GALATEA_UID: String(process.getuid!()),
      GALATEA_GID: String(process.getgid!()),
      ...settings,
    };
    writeFileSync(this.envFile, Object.entries(all).map(([k, v]) => `${k}=${v}\n`).join(""));
  }

  /** A stack with these instances and their secrets; not started. */
  static async create(instances: string[], settings: Record<string, string> = {}): Promise<Stack> {
    const s = new Stack(settings);
    s.setInstances(instances);
    await must(s.bin("galatea-prepare"), "galatea-prepare");
    return s;
  }

  /** A stack with no files at all yet: no instances, no secrets, no certificates. */
  static bare(settings: Record<string, string> = {}, files: string[] = []): Stack {
    return new Stack(settings, files);
  }

  get env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.PG_MAJOR;
    return {
      ...env,
      COMPOSE_FILE: [join(PKG, "compose.yaml"), ...this.files].join(":"),
      COMPOSE_PROJECT_NAME: this.project,
      COMPOSE_ENV_FILES: this.envFile,
    };
  }

  setInstances(names: string[]): void {
    writeFileSync(this.instancesFile, names.map((n) => `${n}\n`).join(""));
  }

  compose(...args: string[]): Promise<Run> {
    return run("docker", ["compose", ...args], this.env);
  }

  bin(name: string, ...args: string[]): Promise<Run> {
    return run(join(PKG, "bin", name), args, this.env);
  }

  must(p: Promise<Run>, what = "command"): Promise<Run> {
    return must(p, what);
  }

  /** Starts Postgres and runs db-init, as `docker compose up` would. */
  async up(): Promise<void> {
    await must(this.compose("up", "-d", "--wait", "postgres"), "up postgres");
    await must(this.compose("run", "--rm", "db-init"), "db-init");
  }

  /**
   * Runs SQL as a role from another container on the stack's network, as a
   * build connects. (Inside the postgres container, loopback is trusted.)
   */
  sql(role: string, password: string, sql: string, db = "galatea"): Promise<Run> {
    return run("docker", [
      "run", "--rm", "--network", this.network, "-e", `PGPASSWORD=${password}`, CLIENT,
      "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-h", "postgres", "-U", role, "-d", db, "-c", sql,
    ], process.env);
  }

  /**
   * An MQTT 5 client from another container on the stack's network, as a build connects: Mosquitto's
   * own `mosquitto_pub` or `mosquitto_sub`, over TLS to broker:8883 trusting the installation's CA,
   * with the password on its standard input's file, never on a command line the host's `ps` shows.
   * Without `password`, it connects with none. `tls: "plain"` tries port 1883 without TLS; `tls:
   * "untrusted"` connects over TLS trusting another CA (the image's system store).
   */
  mqtt(tool: "mosquitto_pub" | "mosquitto_sub" | "mosquitto_rr", user: string | undefined, password: string | undefined, args: string[],
    tls: "ca" | "plain" | "untrusted" = "ca"): Promise<Run> {
    const auth = user === undefined ? "" : password === undefined ? `-u ${user}` : `-u ${user} -P "$(cat)"`;
    const how = tls === "ca" ? "-p 8883 --cafile /run/tls/ca.pem" : tls === "plain" ? "-p 1883" : "-p 8883 --capath /etc/ssl/certs";
    return run("docker", [
      "run", "--rm", "-i", "--network", this.network, "-v", `${join(this.tls, "ca.pem")}:/run/tls/ca.pem:ro`,
      "--entrypoint", "sh", "eclipse-mosquitto:2",
      "-c", `exec ${tool} -h broker ${how} -V mqttv5 ${auth} "$@"`, "mqtt", ...args,
    ], process.env, password ?? "");
  }

  /** The stack's Compose network. */
  get network(): string {
    return `${this.project}_default`;
  }

  /**
   * An MCP call from another container on the stack's network, in the steward's image (which has the
   * MCP client): `test/mcp-call.mjs` with its request on standard input, the credential included, so
   * nothing is on a command line. `ca` is the PEM the call trusts (the installation's unless given);
   * `plain` sends plain HTTP. `host` runs it on the host's network, as a client on the box reaching a
   * port published on its loopback (`https://127.0.0.1:<port>/mcp`).
   */
  async mcp(url: string, credential: string, tool: string, args: Record<string, unknown> = {},
    opts: { ca?: string; plain?: boolean; host?: boolean } = {}): Promise<{ ok: boolean; body?: any; error?: string }> {
    const ca = opts.ca ?? readFileSync(join(this.tls, "ca.pem"), "utf8");
    const r = await run("docker", [
      "run", "--rm", "-i", "--network", opts.host ? "host" : this.network, "--entrypoint", "node",
      "-v", `${join(PKG, "test", "mcp-call.mjs")}:/app/mcp-call.mjs:ro`, "galatea-steward:local", "/app/mcp-call.mjs",
    ], process.env, JSON.stringify({ url, credential, tool, args, ca, plain: opts.plain === true }));
    try {
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    } catch {
      return { ok: false, error: `mcp-call exited ${r.code}: ${r.stderr}` };
    }
  }

  /** A CA certificate the installation never made: a client trusting it alone trusts none of the stack's servers. */
  async otherCa(): Promise<string> {
    const r = await must(run("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh", "galatea-certs:local", "-c",
      "openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout /dev/null -subj /CN=another -days 1 2>/dev/null"], process.env), "another CA");
    return r.stdout;
  }

  /**
   * age and age-keygen for the scripts, from a small image when the desktop has no package: wrappers
   * in a directory of this stack's, returned for PATH.
   */
  async ageBin(): Promise<string> {
    await must(run("docker", ["build", "-q", "-t", "galatea-test-age:local", join(PKG, "test", "age")], process.env), "build age");
    const bin = join(this.dir, "test-bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["age", "age-keygen"]) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nexec docker run --rm -i galatea-test-age:local ${tool} "$@"\n`, { mode: 0o755 });
    }
    return bin;
  }

  /** A file under the installation's directory, as text. */
  read(...path: string[]): string {
    return readFileSync(join(this.dir, ...path), "utf8");
  }

  /** A service's logs, both streams. */
  async logs(service: string): Promise<string> {
    const r = await this.compose("logs", "--no-log-prefix", service);
    return r.stdout + r.stderr;
  }

  /** The service's container as `docker compose ps --format json` gives it. */
  async container(service: string): Promise<{ Mounts: string; Publishers: { PublishedPort: number }[] }> {
    const r = await must(this.compose("ps", "--format", "json", service), `ps ${service}`);
    return JSON.parse(r.stdout.trim().split("\n")[0]!);
  }

  /** Runs SQL as the superuser, through the local socket. */
  admin(sql: string, db = "galatea"): Promise<Run> {
    return must(
      this.compose("exec", "-T", "postgres", "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-c", sql),
      `admin: ${sql}`,
    );
  }

  async destroy(): Promise<void> {
    await this.compose("down", "-v", "--remove-orphans");
    // `down -v` removes the current major's volume; an upgrade leaves the old one.
    const vols = await run("docker", ["volume", "ls", "-q", "--filter", `name=${this.project}`], process.env);
    const names = vols.stdout.split("\n").filter(Boolean);
    if (names.length) await run("docker", ["volume", "rm", ...names], process.env);
    rmSync(this.dir, { recursive: true, force: true });
  }
}
