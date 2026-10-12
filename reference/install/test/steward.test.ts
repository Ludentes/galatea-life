import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

const STEWARD = "https://steward:18444/mcp";
const APPLIER = "https://applier:18443/mcp";
const REACHED = "the applier reached at MCP revision 2026-07-28";

/**
 * The steward's service (the install-core design, *The applier and the steward as services*): it
 * serves before it is registered, follows its applier over TLS once galatea-register-steward has run,
 * and trusts the CA it is given for that link alone.
 */
describe("the steward's service", () => {
  let s: Stack;
  const owner = () => readFileSync(join(s.mcpSecrets, "steward-owner"), "utf8");
  const applierOwner = () => readFileSync(join(s.mcpSecrets, "applier-owner"), "utf8");
  const reached = async () => (await s.logs("steward")).split(REACHED).length - 1;
  const startedAt = async () => {
    const id = (await s.must(s.compose("ps", "-q", "steward"))).stdout.trim();
    return (await s.must(run("docker", ["inspect", "-f", "{{.State.StartedAt}} {{.RestartCount}}", id], process.env))).stdout.trim();
  };
  async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms: number): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward"]);
    await s.must(s.compose("up", "-d", "--wait", "steward"), "up steward");
  });
  afterAll(async () => s?.destroy());

  it("migrates in its one-off service and turns healthy, serving before it is registered at the applier", async () => {
    const r = await s.must(s.compose("ps", "-a", "--format", "json", "steward-migrate", "steward"));
    const rows = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.find((x) => x.Service === "steward-migrate")).toMatchObject({ State: "exited", ExitCode: 0 });
    expect(rows.find((x) => x.Service === "steward")).toMatchObject({ State: "running", Health: "healthy" });
    expect(await reached()).toBe(0);
    expect(await s.logs("steward")).toContain("the applier is out of reach, retrying: the applier answered not_permitted");
  });

  it("makes its first owner from the file: that credential reaches describe over TLS", async () => {
    const r = await s.mcp(STEWARD, owner(), "describe");
    expect(r.ok, r.error).toBe(true);
    expect((await s.mcp(STEWARD, applierOwner(), "describe")).ok).toBe(false);
  });

  it("follows the applier within 5 s of galatea-register-steward, with no restart", async () => {
    const before = await startedAt();
    const t0 = Date.now();
    await s.must(s.bin("galatea-register-steward"));
    await until("the steward's link", async () => (await reached()) === 1, 5_000);
    expect(Date.now() - t0).toBeLessThan(5_000 + 3_000); // the register container's own start included
    expect(await startedAt()).toBe(before);
    const applierId = (await s.mcp(APPLIER, applierOwner(), "describe")).body.applier_id;
    await until("the applier in the steward's describe", async () => (await s.mcp(STEWARD, owner(), "describe")).body?.applier?.applier_id === applierId, 5_000);
  });

  it("refuses its applier, and says so, when its CA is another's; and still serves", async () => {
    const other = join(s.dir, "other-ca.pem");
    writeFileSync(other, await s.otherCa());
    const override = join(s.dir, "compose.other-ca.yaml");
    writeFileSync(override, `services:\n  steward:\n    volumes:\n      - { type: bind, source: ${other}, target: /run/tls/ca.pem, read_only: true }\n    healthcheck: { disable: true }\n`);
    const env = { ...s.env, COMPOSE_FILE: `${join(PKG, "compose.yaml")}:${override}` };
    try {
      await s.must(run("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", "steward"], env));
      await until("the refusal in the log", async () => /the applier is out of reach, retrying: .*(UNABLE_TO_VERIFY|unable to verify|self.signed|local issuer)/i.test(await s.logs("steward")), 15_000);
      const r = await s.mcp(STEWARD, owner(), "describe");
      expect(r.ok, r.error).toBe(true);
      expect(await reached()).toBe(0); // a recreated container's log starts again
    } finally {
      await s.must(s.compose("up", "-d", "--wait", "--no-deps", "--force-recreate", "steward"));
    }
    await until("the link again", async () => (await reached()) === 1, 10_000);
  });
});
