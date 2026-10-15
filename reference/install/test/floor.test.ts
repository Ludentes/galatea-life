import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

const BRAIN_UID = 4242;

/**
 * The install-core design's *The security floor*, as far as files and Compose's own view can show it
 * without starting a service: each service's mounts, the published ports, no secret in the
 * configuration, and the brain's account, which reads its own two files and nothing of the owner's.
 * (The broker's refusals are broker.test.ts's; a model's bare `answer` refused is plan C1's.)
 */
describe("the security floor", () => {
  let s: Stack;
  let services: Record<string, { volumes?: { type: string; source?: string; target: string }[]; environment?: Record<string, string>;
    ports?: { host_ip?: string; published?: string }[] }>;
  let fakes: string;
  let brainHome: string;
  /** galatea-secret with `getent` and `sudo` standing in for the system's: the brain's account is uid 4242, and root is a container. */
  const secret = (...args: string[]) => run(join(PKG, "bin", "galatea-secret"), args, { ...s.env, PATH: `${fakes}:${process.env.PATH}` });
  /** A shell as the brain's account, the installation's directory and the brain's home bound at their own paths. */
  const asBrain = (script: string) => run("docker", ["run", "--rm", "--network", "none", "--user", `${BRAIN_UID}:${BRAIN_UID}`,
    "-v", `${s.dir}:${s.dir}:ro`, "alpine:3", "sh", "-c", script], process.env);
  const secretsOf = (svc: string) => (services[svc]!.volumes ?? []).map((v) => v.source ?? "")
    .filter((p) => p.startsWith(s.secretsRoot)).map((p) => p.slice(s.secretsRoot.length + 1)).sort();

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward", "bridge_zigbee"]);
    const r = await s.must(s.compose("--profile", "zigbee", "config", "--format", "json"));
    services = JSON.parse(r.stdout).services;
    fakes = join(s.dir, "fakes");
    brainHome = join(s.dir, "home", "galatea-brain");
    mkdirSync(fakes);
    mkdirSync(brainHome, { recursive: true });
    writeFileSync(join(fakes, "getent"), `#!/bin/sh
case "$1 $2" in
  "passwd galatea-brain") echo "galatea-brain:x:${BRAIN_UID}:${BRAIN_UID}::${brainHome}:/bin/sh" ;;
  "passwd galatea-dockered") echo "galatea-dockered:x:4343:4343::${brainHome}:/bin/sh" ;;
  "passwd me") echo "me:x:$(id -u):$(id -g)::/nowhere:/bin/sh" ;;
  "group docker") echo "docker:x:999:galatea-dockered" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(fakes, "sudo"), `#!/bin/sh\nexec docker run --rm --network none -v ${s.dir}:${s.dir} alpine:3 "$@"\n`, { mode: 0o755 });
    await s.must(run("docker", ["run", "--rm", "-v", `${s.dir}:${s.dir}`, "alpine:3", "chown", `${BRAIN_UID}:${BRAIN_UID}`, brainHome], process.env));
    // The test's directory is 0700 from mkdtemp; open it as a home directory may be, so that secrets/ is the barrier.
    chmodSync(s.dir, 0o755);
    chmodSync(join(s.dir, "home"), 0o755);
  });
  afterAll(async () => {
    // Files the brain's account owns: removed by root, in a container.
    await run("docker", ["run", "--rm", "-v", `${s.dir}:${s.dir}`, "alpine:3", "rm", "-rf", join(s.dir, "home")], process.env);
    await s?.destroy();
  });

  it("mounts into each build's service its own secrets alone, and secrets/mcp, secrets/ca and the rest of secrets/tls into nothing else", () => {
    expect(secretsOf("applier-migrate")).toEqual(["db/applier"]);
    expect(secretsOf("applier")).toEqual(["broker/applier", "db/applier", "mcp/applier-owner", "tls/applier.key"]);
    expect(secretsOf("steward-migrate")).toEqual(["db/steward"]);
    expect(secretsOf("steward")).toEqual(["db/steward", "mcp/steward-at-applier", "mcp/steward-owner", "mcp/steward-token-key", "tls/steward.key"]);
    expect(secretsOf("zigbee-bridge")).toEqual(["broker/bridge_zigbee", "db/bridge_zigbee"]);
    for (const svc of ["postgres", "db-init", "backup"]) expect(secretsOf(svc), svc).toEqual(["db"]);
    expect(secretsOf("broker")).toEqual(["broker", "tls/broker.key"]);
  });

  it("passes the Zigbee bridge its switches from .env, each off unless set", () => {
    const env = services["zigbee-bridge"]!.environment ?? {};
    expect(env.GALATEA_ZIGBEE_NO_ACTIONS).toBe("0");
    expect(env.GALATEA_ZIGBEE_DEBUG).toBe("0");
  });

  it("binds every secret, certificate, backup and instances path, file or directory, refusing a missing source", () => {
    const roots = [s.secretsRoot, s.tls, s.backups, s.instancesFile];
    let seen = 0;
    for (const [name, svc] of Object.entries(services)) {
      for (const v of svc.volumes ?? []) {
        if (v.type !== "bind" || !roots.some((r) => (v.source ?? "").startsWith(r))) continue;
        seen++;
        expect((v as { bind?: { create_host_path?: boolean } }).bind?.create_host_path, `${name} ${v.target}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("starts nothing, and makes no directory as root, when a secrets directory is missing", async () => {
    const other = Stack.bare();
    try {
      const r = await other.compose("up", "-d", "postgres");
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/bind source path does not exist: .*secrets\/db/);
      expect(existsSync(other.secretsRoot)).toBe(false);
    } finally {
      await other.destroy();
    }
  });

  it("mounts the secrets archive's directory and the CA's key into no service", () => {
    for (const [name, svc] of Object.entries(services)) {
      for (const v of svc.volumes ?? []) {
        expect(v.source ?? "", name).not.toContain(s.archive);
        expect(v.source ?? "", name).not.toContain(join(s.secretsRoot, "ca"));
        expect(v.source ?? "", name).not.toBe(s.secretsRoot);
      }
    }
  });

  it("publishes the applier and the steward on the host's loopback alone, and Postgres and the broker not at all", () => {
    const published = Object.fromEntries(Object.entries(services).map(([n, svc]) => [n, (svc.ports ?? []).map((p) => `${p.host_ip}:${p.published}`)]));
    expect(published.applier).toEqual([`127.0.0.1:${s.applierPort}`]);
    expect(published.steward).toEqual([`127.0.0.1:${s.stewardPort}`]);
    for (const n of Object.keys(services).filter((n) => n !== "applier" && n !== "steward")) expect(published[n], n).toEqual([]);
  });

  it("publishes the broker alone on the LAN through compose.lan.yaml, on GALATEA_LAN_ADDRESS, and refuses it unset", async () => {
    const files = `${join(PKG, "compose.yaml")}:${join(PKG, "compose.lan.yaml")}`;
    let r = await run("docker", ["compose", "config", "--format", "json"], { ...s.env, COMPOSE_FILE: files });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("set GALATEA_LAN_ADDRESS");
    r = await s.must(run("docker", ["compose", "config", "--format", "json"], { ...s.env, COMPOSE_FILE: files, GALATEA_LAN_ADDRESS: "192.0.2.10" }));
    const lan = JSON.parse(r.stdout).services as typeof services;
    expect((lan.broker!.ports ?? []).map((p) => `${p.host_ip}:${p.published}`)).toEqual(["192.0.2.10:8883"]);
    expect((lan.steward!.ports ?? []).map((p) => p.host_ip)).toEqual(["127.0.0.1"]);
    expect((lan.applier!.ports ?? []).map((p) => p.host_ip)).toEqual(["127.0.0.1"]);
  });

  it("holds no secret in the configuration, and nothing turns certificate validation off", async () => {
    const config = (await s.must(s.compose("--profile", "zigbee", "config"))).stdout;
    const files = ["db/postgres", "db/reader", "db/applier", "db/steward", "db/bridge_zigbee", "broker/applier", "broker/bridge_zigbee",
      "mcp/applier-owner", "mcp/steward-owner", "mcp/steward-at-applier", "mcp/steward-token-key"];
    for (const f of files) expect(config.includes(readFileSync(join(s.secretsRoot, f), "utf8")), f).toBe(false);
    expect(config).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    // The one process-wide trust: the Zigbee bridge's, until it has a CA option.
    expect(Object.entries(services).filter(([, svc]) => svc.environment?.NODE_EXTRA_CA_CERTS).map(([n]) => n)).toEqual(["zigbee-bridge"]);
  });

  it("galatea-secret makes a brain's credential once, and refuses the installation's own names", async () => {
    let r = await s.must(secret("brain_agent"));
    expect(r.stdout).toContain("wrote");
    const value = readFileSync(join(s.mcpSecrets, "brain_agent"), "utf8");
    expect(value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(statSync(join(s.mcpSecrets, "brain_agent")).mode & 0o777).toBe(0o600);
    r = await s.must(secret("brain_agent"));
    expect(r.stdout).toBe("");
    expect(readFileSync(join(s.mcpSecrets, "brain_agent"), "utf8")).toBe(value);
    for (const id of ["steward-owner", "applier-owner", "Bad"]) expect((await secret(id)).code, id).not.toBe(0);
  });

  it("galatea-secret --for copies the credential and the CA into the brain's account, owned by it", async () => {
    const r = await s.must(secret("brain_agent", "--for", "galatea-brain"));
    expect(r.stdout).toContain("installed");
    const dir = join(brainHome, ".config", "galatea");
    const own = await s.must(asBrain(`stat -c '%u %a' ${dir} ${dir}/brain_agent ${dir}/ca.pem; cat ${dir}/brain_agent`));
    const [d, cred, ca, value] = own.stdout.trim().split("\n");
    expect(d).toBe(`${BRAIN_UID} 700`);
    expect(cred).toBe(`${BRAIN_UID} 600`);
    expect(ca).toBe(`${BRAIN_UID} 644`);
    expect(value).toBe(readFileSync(join(s.mcpSecrets, "brain_agent"), "utf8"));
  });

  it("leaves the brain's account no owner credential, no other secret and no key to read", async () => {
    for (const f of ["mcp/steward-owner", "mcp/applier-owner", "mcp/steward-at-applier", "ca/ca.key", "tls/steward.key", "db/steward", "broker/applier"]) {
      const r = await asBrain(`cat ${join(s.secretsRoot, f)}`);
      expect(r.code, f).not.toBe(0);
      expect(r.stderr, f).toMatch(/Permission denied/);
    }
    // What it may read: its own copies, and the public certificates.
    expect((await asBrain(`cat ${join(s.tls, "ca.pem")} >/dev/null`)).code).toBe(0);
  });

  it("refuses --for an account in the docker group, or the owner's own", async () => {
    let r = await secret("brain_agent", "--for", "galatea-dockered");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("is in the docker group");
    r = await secret("brain_agent", "--for", "me");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("is root or yourself");
  });
});
