import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { startMpv } from "../src/mpv-process.js";

const temps: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function nothingRunsUnder(dir: string): boolean {
  try {
    execFileSync("pgrep", ["-f", dir]);
    return false;
  } catch {
    return true;
  }
}

async function eventually(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

describe("startMpv", () => {
  it("stops mpv and removes its directory when it cannot connect to the socket", async () => {
    // Final review M7: the connect sat outside the clean-up, so a failed connect left mpv running
    // and its directory in place. The stand-in makes a plain file where the socket belongs, and
    // stays up, as an mpv whose socket refuses connections would.
    const bin = join(temp("not-mpv-"), "mpv");
    writeFileSync(bin, [
      "#!/bin/sh",
      'for a in "$@"; do case "$a" in --input-ipc-server=*) : > "${a#--input-ipc-server=}";; esac; done',
      "while :; do sleep 0.1; done",
      "",
    ].join("\n"));
    chmodSync(bin, 0o755);
    const runtime = temp("rt-");
    await expect(startMpv({ mpvPath: bin, runtimeDir: runtime })).rejects.toThrow();
    expect(readdirSync(runtime)).toEqual([]);
    expect(await eventually(() => nothingRunsUnder(runtime))).toBe(true);
  });

  it("fails at once, naming the length, when the socket's path is too long for a Unix socket", async () => {
    // Final review M12: mpv cannot open a socket at a path over 107 bytes, and says nothing, so
    // the start used to wait out its whole timeout.
    const runtime = temp(`rt-${"x".repeat(100)}-`);
    const started = Date.now();
    await expect(startMpv({ runtimeDir: runtime, extraArgs: ["--vo=null", "--ao=null", "--no-config"] }))
      .rejects.toThrow(/\d+ bytes/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(readdirSync(runtime)).toEqual([]);
    expect(nothingRunsUnder(runtime)).toBe(true);
  });
});
