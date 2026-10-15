import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, Stack } from "./stack.js";

describe("the postgres service", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await Stack.create([]);
    await s.up();
  });
  afterAll(async () => s?.destroy());

  it("runs the stock Postgres 18 image with the galatea database", async () => {
    expect((await s.admin("SHOW server_version")).stdout).toMatch(/^18\./);
    expect((await s.admin("SELECT current_database()")).stdout.trim()).toBe("galatea");
  });

  it("keeps its data in the named volume, where the 18 image expects it", async () => {
    expect((await s.admin("SHOW data_directory")).stdout.trim()).toBe("/var/lib/postgresql/18/docker");
    const id = (await s.must(s.compose("ps", "-q", "postgres"))).stdout.trim();
    const mounts = await s.must(run("docker", ["inspect", "--format", "{{json .Mounts}}", id], process.env));
    expect(JSON.parse(mounts.stdout)).toContainEqual(
      expect.objectContaining({ Name: `${s.project}-pgdata-18`, Destination: "/var/lib/postgresql" }),
    );
  });

  it("publishes no port", async () => {
    const c = await s.container("postgres");
    expect(c.Publishers.filter((p) => p.PublishedPort !== 0)).toEqual([]);
  });

  it("takes the superuser's password from its secret file", async () => {
    const pw = readFileSync(join(s.secrets, "postgres"), "utf8");
    expect((await s.sql("postgres", pw, "SELECT 1")).stdout.trim()).toBe("1");
    expect((await s.sql("postgres", "wrong", "SELECT 1")).code).not.toBe(0);
  });

  it("reads healthy only once it answers over TCP, not while a first start's init server listens on its socket alone", async () => {
    // The image's entrypoint initialises a fresh volume behind a server started with listen_addresses='',
    // and db-init, connecting over TCP, was refused while a socket-only check already read healthy.
    const cfg = JSON.parse((await s.must(s.compose("config", "--format", "json"))).stdout);
    const check: string[] = cfg.services.postgres.healthcheck.test;
    expect(check[0]).toBe("CMD");
    const name = `${s.project}-socket-only`;
    // Labelled as the stack's, so the stack's `down` removes it should this test die before its `finally`.
    await s.must(run("docker", ["run", "-d", "--name", name, "--label", `com.docker.compose.project=${s.project}`, "--label", "com.docker.compose.service=socket-only",
      "-e", "POSTGRES_PASSWORD=x", "-e", "POSTGRES_DB=galatea", cfg.services.postgres.image, "postgres", "-c", "listen_addresses="], process.env));
    try {
      // Past the init's own temporary server, which is socket-only too, to the one that stays.
      const onSocket = ["pg_isready", "-U", "postgres", "-d", "galatea"];
      const settled = async () => (await run("docker", ["exec", name, ...onSocket], process.env)).code === 0
        && (await run("docker", ["logs", name], process.env)).stdout.includes("PostgreSQL init process complete");
      for (const end = Date.now() + 60_000; Date.now() < end && !(await settled());) await new Promise((r) => setTimeout(r, 500));
      expect((await run("docker", ["exec", name, ...onSocket], process.env)).code, "the socket answers").toBe(0);
      expect((await run("docker", ["exec", name, ...check.slice(1)], process.env)).code, "the healthcheck").not.toBe(0);
    } finally {
      await run("docker", ["rm", "-f", "-v", name], process.env);
    }
  });
});
