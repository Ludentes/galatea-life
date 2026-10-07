import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hasDbusDaemon } from "./private-bus.js";

/**
 * Reviews I1 and N1 end to end (`fixtures/pid-reuse.ts`): a connection whose opener has exited keeps
 * the opener's pid at the bus daemon, and the service's helper is then started on that very pid. Run
 * in a private user and pid namespace, where the pid can be reused at once; skipped where
 * unprivileged namespaces, `dbus-daemon` or `python3` are not to be had. Everything runs on a
 * private bus daemon.
 */
const SCENARIO = fileURLToPath(new URL("./fixtures/pid-reuse.ts", import.meta.url));
const RESOLVE = fileURLToPath(new URL("./fixtures/ts-resolve.mjs", import.meta.url));
const UNSHARE = ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc"];
const namespaces = existsSync("/usr/bin/unshare") && spawnSync("/usr/bin/unshare", [...UNSHARE, "/bin/true"]).status === 0;
const python = spawnSync("python3", ["-c", "pass"]).status === 0;

interface Outcome { mode: string; reused: boolean; hello: string; seen: { kind: string; detail?: string }[] }

function scenario(mode: "hello" | "late"): Outcome {
  const r = spawnSync("/usr/bin/unshare", [...UNSHARE, process.execPath, "--experimental-transform-types", "--no-warnings", "--import", RESOLVE, SCENARIO, mode], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000,
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1)!) as Outcome;
}

describe.skipIf(!namespaces || !hasDbusDaemon || !python)("a connection not the helper's, its pid reused (reviews I1, N1)", () => {
  it("is refused and named when it said the bus's Hello before the helper's spawn: an old name", () => {
    const out = scenario("hello");
    // The scenario holds only if the bus daemon gave the dead opener's pid and the helper got it.
    expect(out.reused).toBe(true);
    expect(out.hello).toBe("error");
    expect(out.seen.map((m) => m.kind)).toEqual(["malformed"]);
    expect(out.seen[0]!.detail).toMatch(/^pid \d+'s connection :\d+\.\d+ is older than its helper/);
  }, 40_000);

  it("is refused and named when it says the bus's Hello only after the release: a newer name, but no token", () => {
    const out = scenario("late");
    expect(out.reused).toBe(true);
    expect(out.hello).toBe("error");
    expect(out.seen.map((m) => m.kind)).toEqual(["malformed"]);
    expect(out.seen[0]!.detail).toMatch(/^pid \d+'s connection :\d+\.\d+ presented a wrong token$/);
  }, 40_000);
});
