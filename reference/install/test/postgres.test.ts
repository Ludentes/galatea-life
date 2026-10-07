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
});
