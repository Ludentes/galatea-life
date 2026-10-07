import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

describe("galatea-db-prepare", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await Stack.create(["applier"]);
  });
  afterAll(async () => s?.destroy());

  it("writes a password for postgres, reader and each instance, readable by the owner only", () => {
    expect(statSync(s.secrets).mode & 0o777).toBe(0o700);
    for (const n of ["postgres", "reader", "applier"]) {
      const f = join(s.secrets, n);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(readFileSync(f, "utf8")).toMatch(/^[A-Za-z0-9]{32}$/);
    }
  });

  it("creates the backups directory, owned by the owner", () => {
    expect(statSync(s.backups).isDirectory()).toBe(true);
    expect(statSync(s.backups).uid).toBe(process.getuid!());
    expect(statSync(s.backups).mode & 0o777).toBe(0o700);
  });

  it("refuses a bad instance name before it writes any file", async () => {
    s.setInstances(["applier", "../x", "Bad"]);
    const r = await s.bin("galatea-db-prepare");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("../x");
    expect(existsSync(join(s.secrets, "..", "x"))).toBe(false);
    s.setInstances(["applier"]);
  });

  it("never changes a password that exists, and adds the missing ones", async () => {
    writeFileSync(join(s.secrets, "applier"), "kept");
    s.setInstances(["applier", "steward"]);
    const r = await s.must(s.bin("galatea-db-prepare"));
    expect(readFileSync(join(s.secrets, "applier"), "utf8")).toBe("kept");
    expect(r.stdout).toContain("steward");
    expect(r.stdout).not.toContain("applier");
  });

  it("refuses to run without an instances file", async () => {
    rmSync(s.instancesFile);
    const r = await s.bin("galatea-db-prepare");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("no instances file");
  });
});
