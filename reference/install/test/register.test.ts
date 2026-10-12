import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Stack } from "./stack.js";

const REACHED = "the applier reached at MCP revision 2026-07-28";

/** galatea-register-steward (the install-core design, *Credentials*): the one way the steward is registered. */
describe("galatea-register-steward", () => {
  let s: Stack;
  const file = (n: string) => join(s.mcpSecrets, n);
  const pair = () => [readFileSync(file("steward-at-applier"), "utf8"), readFileSync(file("steward-token-key"), "utf8")];
  const reached = async () => (await s.logs("steward")).split(REACHED).length - 1;
  async function until(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  /** Runs it while sampling every process's command line, so a value on one would be caught. */
  async function watched(...args: string[]) {
    const lines = new Set<string>();
    const timer = setInterval(() => {
      for (const l of execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n")) lines.add(l);
    }, 50);
    try {
      return { r: await s.bin("galatea-register-steward", ...args), ps: [...lines].join("\n") };
    } finally {
      clearInterval(timer);
    }
  }

  beforeAll(async () => {
    s = await Stack.create(["applier", "steward"]);
    await s.must(s.compose("up", "-d", "--wait", "steward"), "up steward");
  });
  afterAll(async () => s?.destroy());

  it("configures the steward's client once, printing the diff and no value, with none on a command line", async () => {
    const values = [...pair(), readFileSync(file("applier-owner"), "utf8")];
    const { r, ps } = await watched();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("register-steward: + client steward (steward)");
    for (const v of values) {
      expect((r.stdout + r.stderr).includes(v)).toBe(false);
      expect(ps.includes(v)).toBe(false);
    }
    expect(ps).toContain("register-steward.mjs"); // the sampling saw the run
    await until("the steward's link", async () => (await reached()) === 1, 5_000);
  });

  it("changes nothing when run again", async () => {
    const r = await s.must(s.bin("galatea-register-steward"));
    expect(r.stdout.trim()).toBe("register-steward: no change (the steward is registered with these files)");
  });

  it("rotates the pair with --rotate: configured, moved over the old files, the steward restarted and following", async () => {
    const before = pair();
    const links = await reached();
    const r = await s.must(s.bin("galatea-register-steward", "--rotate"));
    expect(r.stdout).toContain("register-steward: ~ client steward (steward)");
    expect(r.stdout).toContain("galatea-register-steward: restarted the steward");
    const after = pair();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after.every((v) => /^[A-Za-z0-9]{32}$/.test(v))).toBe(true);
    expect(existsSync(file("steward-at-applier.next"))).toBe(false);
    // A restart keeps the container's log: one more link than before.
    await until("the steward's link on the new pair", async () => (await reached()) > links, 10_000);
  });

  it("leaves the steward on its old pair when the configure fails, and configures the waiting pair on the next run", async () => {
    const before = pair();
    // The applier refuses the configure: the owner's credential the script presents is not the applier's.
    const logged = (await s.logs("steward")).length;
    const ownerFile = file("applier-owner");
    const owner = readFileSync(ownerFile, "utf8");
    writeFileSync(ownerFile, "not-the-applier-owner-credential");
    const r = await s.bin("galatea-register-steward", "--rotate");
    writeFileSync(ownerFile, owner);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the new pair was not configured; the steward keeps its old pair");
    expect(pair()).toEqual(before);
    expect(existsSync(file("steward-at-applier.next"))).toBe(true);
    // The old pair still holds: the steward was never restarted, and its link stands.
    expect((await s.mcp("https://steward:18444/mcp", readFileSync(file("steward-owner"), "utf8"), "describe")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    expect((await s.logs("steward")).slice(logged)).not.toContain("out of reach");
    // galatea-register-steward needs the applier's container only; the next run takes the waiting pair.
    const next = readFileSync(file("steward-at-applier.next"), "utf8");
    const links = await reached();
    const again = await s.must(s.bin("galatea-register-steward"));
    expect(again.stdout).toContain("the new pair is in place");
    expect(pair()[0]).toBe(next);
    await until("the link on the waited pair", async () => (await reached()) > links, 10_000);
  });

  it("refuses to run while the applier's service is stopped, and one .next file without the other", async () => {
    await s.must(s.compose("stop", "applier"));
    const stopped = await s.bin("galatea-register-steward");
    expect(stopped.code).not.toBe(0);
    expect(stopped.stderr).toContain("the applier's service is not running");
    await s.must(s.compose("start", "applier"));
    writeFileSync(file("steward-token-key.next"), "x".repeat(32), { mode: 0o600 });
    const r = await s.bin("galatea-register-steward");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("there without the other");
  });
});
