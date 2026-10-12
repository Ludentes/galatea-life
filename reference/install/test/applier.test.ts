import { chmodSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, Stack } from "./stack.js";

const URL_IN = "https://applier:18443/mcp";

/** The applier's service (the install-core design, *The applier and the steward as services*). */
describe("the applier's service", () => {
  let s: Stack;
  const owner = () => readFileSync(join(s.mcpSecrets, "applier-owner"), "utf8");
  /** Every secret file the installation holds, as text: none may show anywhere but in its file. */
  const secretValues = () => [
    ...["postgres", "reader", "applier", "steward"].map((n) => readFileSync(join(s.secrets, n), "utf8")),
    readFileSync(join(s.brokerSecrets, "applier"), "utf8"),
    ...["applier-owner", "steward-owner", "steward-at-applier", "steward-token-key"].map((n) => readFileSync(join(s.mcpSecrets, n), "utf8")),
  ];

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward"]);
    await s.must(s.compose("up", "-d", "--wait", "applier"), "up applier");
  });
  afterAll(async () => s?.destroy());

  it("migrates in its one-off service, which exits 0, then turns healthy", async () => {
    const r = await s.must(s.compose("ps", "-a", "--format", "json", "applier-migrate", "applier"));
    const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.find((x) => x.Service === "applier-migrate")).toMatchObject({ State: "exited", ExitCode: 0 });
    expect(rows.find((x) => x.Service === "applier")).toMatchObject({ State: "running", Health: "healthy" });
    const health = await s.must(s.compose("exec", "-T", "applier", "node", "/health/mcp-health.mjs", "18443"));
    expect(health.stdout).toMatch(/^healthy: HTTP \d+, certificate 7\d\d days left/);
  });

  it("answers describe with the owner's credential, over TLS validated against the installation's CA", async () => {
    const r = await s.mcp(URL_IN, owner(), "describe");
    expect(r.ok, r.error).toBe(true);
    expect(r.body.revision).toEqual(expect.any(Number));
  });

  it("is published on the host's loopback alone", async () => {
    const c = await s.container("applier");
    expect(c.Publishers.filter((p) => p.PublishedPort)).toEqual([expect.objectContaining({ URL: "127.0.0.1", PublishedPort: s.applierPort, TargetPort: 18443 })]);
  });

  it("refuses plain HTTP, a client that does not trust the CA, and a wrong credential", async () => {
    const plain = await s.mcp(URL_IN, owner(), "describe", {}, { plain: true });
    expect(plain.ok).toBe(false);
    const untrusted = await s.mcp(URL_IN, owner(), "describe", {}, { ca: await s.otherCa() });
    expect(untrusted.ok).toBe(false);
    expect(untrusted.error).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|unable to verify|unable to get local issuer/i);
    const wrong = await s.mcp(URL_IN, "not-the-owner-credential", "describe");
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).toMatch(/not_permitted|401|Unauthorized/);
  });

  it("reaches its broker over mqtts, so it accepts box: true", async () => {
    expect(await s.logs("broker")).toMatch(/New client connected from .* as applier \(p5/);
    const change = async (op: "upsert" | "delete") => {
      const { body } = await s.mcp(URL_IN, owner(), "describe");
      return s.mcp(URL_IN, owner(), "configure", { changes: [{ op, kind: "box", value: true }], expected_revision: body.revision, dry_run: false });
    };
    const on = await change("upsert");
    expect(on.ok, JSON.stringify(on)).toBe(true);
    const off = await change("delete");
    expect(off.ok, JSON.stringify(off)).toBe(true);
  });

  it("runs as the owner's account, with only its own files mounted", async () => {
    const r = await s.must(s.compose("exec", "-T", "applier", "sh", "-c", "id -u; ls /run/secrets /run/tls"));
    const [uid, ...rest] = r.stdout.trim().split(/\s+/);
    expect(uid).toBe(String(process.getuid!()));
    expect(rest).toEqual(["/run/secrets:", "broker", "db", "owner", "tls.key", "/run/tls:", "applier.pem", "ca.pem"]);
  });

  it("shows no secret in docker inspect, docker compose config or its logs", async () => {
    const id = (await s.must(s.compose("ps", "-q", "applier"))).stdout.trim();
    const seen = [
      (await s.must(s.compose("config"))).stdout,
      (await s.must(run("docker", ["inspect", id], process.env))).stdout,
      await s.logs("applier"), await s.logs("applier-migrate"), await s.logs("broker"),
    ].join("\n");
    for (const v of secretValues()) expect(seen.includes(v)).toBe(false);
  });

  it("stops at its start on a secret file another account could read, naming the setting and not the value", async () => {
    const f = join(s.mcpSecrets, "applier-owner");
    chmodSync(f, 0o644);
    try {
      await s.compose("up", "-d", "--force-recreate", "--no-deps", "applier");
      await new Promise((r) => setTimeout(r, 3000));
      const logs = await s.logs("applier");
      expect(logs).toContain("refusing to start: GALATEA_OWNER_CREDENTIAL_FILE /run/secrets/owner can be reached by other accounts");
      expect(logs.includes(owner())).toBe(false);
    } finally {
      chmodSync(f, 0o600);
    }
    await s.must(s.compose("up", "-d", "--wait", "--force-recreate", "--no-deps", "applier"));
  });

  it("refuses to start with a secret file missing, rather than Docker making it as a directory", async () => {
    const f = join(s.secrets, "applier");
    const held = readFileSync(f, "utf8");
    renameSync(f, `${f}.away`);
    try {
      const up = await s.compose("up", "-d", "--force-recreate", "--no-deps", "applier-migrate");
      expect(up.code).not.toBe(0);
      expect(up.stderr).toMatch(/bind source path does not exist: .*secrets\/db\/applier/);
    } finally {
      renameSync(`${f}.away`, f);
    }
    expect(readFileSync(f, "utf8")).toBe(held);
  });
});
