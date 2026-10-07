import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bounded, run, RunError } from "../src/linux/run.js";

describe("run", () => {
  it("gives the exit code and both outputs, a non-zero exit being a result", async () => {
    const r = await run("sh", ["-c", "echo out; echo err >&2; exit 3"]);
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("runs in the C locale with the system's PATH, and nothing of this process's environment", async () => {
    process.env.GALATEA_LEAK_CHECK = "leaked";
    try {
      const r = await run("sh", ["-c", 'echo "$LANG $LC_ALL ${GALATEA_LEAK_CHECK:-none}"; echo "$PATH"']);
      expect(r.stdout).toBe("C C none\n/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n");
    } finally {
      delete process.env.GALATEA_LEAK_CHECK;
    }
  });

  it("adds the variables a call names", async () => {
    const r = await run("sh", ["-c", 'echo "$COLUMNS"'], { env: { COLUMNS: "4096" } });
    expect(r.stdout).toBe("4096\n");
  });

  it("keeps 1 MiB of output by default, and as much as a call allows (plan 4b)", async () => {
    const twoMiB = ["-c", "head -c 2097152 /dev/zero"];
    expect((await run("sh", twoMiB)).stdout.length).toBe(1024 * 1024);
    expect((await run("sh", twoMiB, { maxBytes: 4 * 1024 * 1024 })).stdout.length).toBe(2 * 1024 * 1024);
  });

  it("kills a command past its bound and rejects with timeout", async () => {
    const started = Date.now();
    const err = await run("sleep", ["30"], { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills the command's whole process group at its bound, a child it forked included (review M10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "galatea-run-"));
    try {
      const pidFile = join(dir, "pid");
      const err = await run("sh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 }).catch((e: unknown) => e);
      expect((err as RunError).kind).toBe("timeout");
      const pid = Number(readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2_000;
      while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops at once when its signal aborts, the command killed, and starts nothing on a signal already aborted (review M5)", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const pending = run("sleep", ["30"], { signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(RunError);
    expect((err as Error).message).toMatch(/aborted/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(run("sleep", ["30"], { signal: ac.signal })).rejects.toThrow(/aborted/);
  });

  it("rejects a command that is not installed with missing", async () => {
    const err = await run("galatea-no-such-tool", []).catch((e: unknown) => e);
    expect((err as RunError).kind).toBe("missing");
  });
});

describe("bounded", () => {
  it("passes a result through, and rejects with timeout once its time has passed", async () => {
    expect(await bounded(Promise.resolve(7), 100, "x")).toBe(7);
    const err = await bounded(new Promise(() => {}), 50, "the thing").catch((e: unknown) => e);
    expect((err as RunError).kind).toBe("timeout");
    expect((err as Error).message).toBe("the thing did not answer within 50 ms");
  });
});
