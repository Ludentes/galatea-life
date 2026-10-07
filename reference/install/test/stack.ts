// A throwaway installation for one test file: its own Compose project,
// settings file, secrets, instances, backups and volumes.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  readonly secrets: string;
  readonly brokerSecrets: string;
  readonly backups: string;
  readonly instancesFile: string;

  private constructor(settings: Record<string, string>) {
    this.dir = mkdtempSync(join(tmpdir(), "galatea-install-"));
    this.project = `gtest-${randomBytes(4).toString("hex")}`;
    this.envFile = join(this.dir, ".env");
    this.secrets = join(this.dir, "secrets", "db");
    this.brokerSecrets = join(this.dir, "secrets", "broker");
    this.backups = join(this.dir, "backups");
    this.instancesFile = join(this.dir, "instances");
    const all = {
      GALATEA_DB_SECRETS: this.secrets,
      GALATEA_BROKER_SECRETS: this.brokerSecrets,
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
    await must(s.bin("galatea-db-prepare"), "galatea-db-prepare");
    return s;
  }

  get env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env.PG_MAJOR;
    return {
      ...env,
      COMPOSE_FILE: join(PKG, "compose.yaml"),
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
      "run", "--rm", "--network", `${this.project}_default`, "-e", `PGPASSWORD=${password}`, CLIENT,
      "psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", "-h", "postgres", "-U", role, "-d", db, "-c", sql,
    ], process.env);
  }

  /**
   * An MQTT 5 client from another container on the stack's network, as a build connects: Mosquitto's
   * own `mosquitto_pub` or `mosquitto_sub`, with the password on its standard input's file, never on a
   * command line the host's `ps` shows. Without `password`, it connects with none.
   */
  mqtt(tool: "mosquitto_pub" | "mosquitto_sub", user: string | undefined, password: string | undefined, args: string[]): Promise<Run> {
    const auth = user === undefined ? "" : password === undefined ? `-u ${user}` : `-u ${user} -P "$(cat)"`;
    return run("docker", [
      "run", "--rm", "-i", "--network", `${this.project}_default`, "--entrypoint", "sh", "eclipse-mosquitto:2",
      "-c", `exec ${tool} -h broker -V mqttv5 ${auth} "$@"`, "mqtt", ...args,
    ], process.env, password ?? "");
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
