import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dropArgs, envWords, killGroup, launch, launcherScript, SETPRIV, untilRunning, type Launched } from "../src/linux/launch.js";

/**
 * The launcher (*Starting a process in a session*) with plain commands, as this account: the gate on
 * fd 3, the command's argv kept out of the script, the move into a stand-in `cgroup.procs`, and the
 * real `setpriv` dropping to this account's own uid with `--keep-groups` (`--init-groups` needs root,
 * so the drop to another account waits for the VM).
 */
const ENV = { PATH: "/usr/bin:/bin" };
const dirs: string[] = [];
const started: Launched[] = [];
afterEach(async () => {
  for (const l of started.splice(0)) {
    killGroup(l.pid);
    await l.exited;
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "galatea-launch-"));
  dirs.push(d);
  return d;
}

async function output(l: Launched): Promise<string> {
  const chunks: Buffer[] = [];
  l.child.stdout!.on("data", (c: Buffer) => chunks.push(c));
  await l.exited;
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the launcher's command line", () => {
  it("drops to the account with its groups and no new privileges, the command after --, all by absolute path", () => {
    expect(dropArgs(1000, 1000)).toEqual([SETPRIV, "--reuid=1000", "--regid=1000", "--init-groups", "--no-new-privs", "--"]);
    expect(SETPRIV).toBe("/usr/bin/setpriv");
    expect(launcherScript(dropArgs(1000, 1000))).toBe(
      'read -r _ <&3 && exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs -- /usr/bin/env -i "$@" 3<&-',
    );
    expect(launcherScript([])).toBe('read -r _ <&3 && exec /usr/bin/env -i "$@" 3<&-');
  });

  it("passes the environment to env -i as words before the command, and refuses what env would misread (review M4)", () => {
    expect(envWords({ HOME: "/home/liza", X: "a b=c" }, ["/usr/bin/node", "x"])).toEqual(["HOME=/home/liza", "X=a b=c"]);
    expect(() => envWords({ "A=B": "1" }, ["/usr/bin/node"])).toThrow(/not a variable's name/);
    expect(() => envWords({ "-u": "1" }, ["/usr/bin/node"])).toThrow(/not a variable's name/);
    expect(() => envWords({}, ["/opt/a=b/node"])).toThrow(/env would misread/);
    expect(() => envWords({}, [])).toThrow(/env would misread/);
  });

  it("refuses an id that is not one, and a drop word that would need quoting", () => {
    expect(() => dropArgs(-1, 1000)).toThrow(/not an account's id/);
    expect(() => dropArgs(1000, 1.5)).toThrow(/not an account's id/);
    expect(() => launcherScript(["/usr/bin/setpriv", "--reuid=1000; rm -rf /"])).toThrow(/would need quoting/);
  });
});

describe("launch", () => {
  it("runs nothing until the line comes on fd 3, then the command", async () => {
    const d = temp();
    const mark = join(d, "ran");
    const l = await launch({ argv: ["/usr/bin/touch", mark], env: ENV, drop: [], stdio: ["ignore", "ignore", "inherit"] });
    started.push(l);
    await sleep(300);
    expect(existsSync(mark)).toBe(false);
    expect(l.child.exitCode).toBe(null);
    await l.release();
    expect(await l.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(mark)).toBe(true);
  });

  it("runs nothing when fd 3 closes with no line: the launcher ends", async () => {
    const d = temp();
    const mark = join(d, "ran");
    const l = await launch({ argv: ["/usr/bin/touch", mark], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    (l.child.stdio[3] as NodeJS.WritableStream).end();
    const end = await l.exited;
    expect(end.code).not.toBe(0);
    expect(existsSync(mark)).toBe(false);
  });

  it("leaves fd 3 closed in the command, and passes it the environment given and nothing else", async () => {
    const l = await launch({
      argv: ["/bin/sh", "-c", "if [ -e /proc/self/fd/3 ]; then echo held; else echo free; fi; /usr/bin/env"],
      env: { ...ENV, GALATEA_PLUGIN_DIR: "/x" }, cwd: tmpdir(), drop: [], stdio: ["ignore", "pipe", "inherit"],
    });
    started.push(l);
    const out = output(l);
    await l.release();
    const lines = (await out).trim().split("\n");
    expect(lines[0]).toBe("free");
    // The inner shell of this test's command exports its own PWD; the launcher's is dropped before the exec.
    expect(lines.slice(1).filter((x) => !x.startsWith("PWD=")).sort()).toEqual(["GALATEA_PLUGIN_DIR=/x", "PATH=/usr/bin:/bin"]);
  });

  it.skipIf(!existsSync("/bin/bash"))("gives the command exactly the environment given under a bash /bin/sh: no SHLVL, PWD or _ (review M4)", async () => {
    const l = await launch({
      argv: ["/usr/bin/env"], env: { ...ENV, GALATEA_PLUGIN_DIR: "/x" }, cwd: tmpdir(), drop: [], stdio: ["ignore", "pipe", "inherit"],
      shell: "/bin/bash",
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim().split("\n").sort()).toEqual(["GALATEA_PLUGIN_DIR=/x", "PATH=/usr/bin:/bin"]);
  });

  it("gives the command exactly the environment given under this machine's /bin/sh", async () => {
    const l = await launch({ argv: ["/usr/bin/env"], env: { A: "1" }, cwd: tmpdir(), drop: [], stdio: ["ignore", "pipe", "inherit"] });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim()).toBe("A=1");
  });

  it("hands a token on fd 4 only, written before the release and closed: never in the argv, the environment or a command line (review N1)", async () => {
    const token = "0123456789abcdef".repeat(4);
    const spawned: number[] = [];
    const l = await launch({
      // The command reads fd 4 to its end, then shows its argv and environment.
      argv: ["/bin/sh", "-c", 'cat <&4; echo; echo "$0 $*"; /usr/bin/env', "x"], env: ENV, cwd: tmpdir(), drop: [],
      stdio: ["ignore", "pipe", "inherit"], token, onSpawn: (pid) => spawned.push(pid),
    });
    started.push(l);
    expect(spawned).toEqual([l.pid]);
    expect(l.cmdlines.flat().join(" ")).not.toContain(token);
    const out = output(l);
    await l.release();
    const lines = (await out).split("\n");
    expect(lines[0]).toBe(token);
    expect(lines.slice(1).join("\n")).not.toContain(token);
  });

  it("hands a Node command the token it reads with the helper's own reader, which closes fd 4 (review N1)", async () => {
    const token = "fedcba9876543210".repeat(4);
    const fixture = fileURLToPath(new URL("./fixtures/read-token.ts", import.meta.url));
    const resolve = fileURLToPath(new URL("./fixtures/ts-resolve.mjs", import.meta.url));
    const l = await launch({
      argv: [process.execPath, "--experimental-transform-types", "--no-warnings", "--import", resolve, fixture], env: ENV,
      cwd: fileURLToPath(new URL("..", import.meta.url)), drop: [], stdio: ["ignore", "pipe", "inherit"], token,
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim().split("\n")).toEqual([token, "fd 4 closed"]);
  });

  it("gives a command started with no token no fd 4", async () => {
    const l = await launch({
      argv: ["/bin/sh", "-c", "[ -e /proc/self/fd/4 ] && echo open || echo none"], env: ENV, drop: [], stdio: ["ignore", "pipe", "inherit"],
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim()).toBe("none");
  });

  it("passes the argv as words, never as the script's text", async () => {
    const d = temp();
    const l = await launch({
      argv: ["/bin/echo", `$(touch ${join(d, "a")})`, `; touch ${join(d, "b")}`, "'", '"$@"'], env: ENV, cwd: d, drop: [],
      stdio: ["ignore", "pipe", "inherit"],
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim()).toBe(`$(touch ${join(d, "a")}) ; touch ${join(d, "b")} ' "$@"`);
    expect(existsSync(join(d, "a")) || existsSync(join(d, "b"))).toBe(false);
  });

  it("leads its own process group, its pid the command's once released", async () => {
    const l = await launch({ argv: ["/bin/sleep", "30"], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    await l.release();
    await untilRunning(l);
    const stat = readFileSync(`/proc/${l.pid}/stat`, "utf8");
    const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    expect(pgid).toBe(l.pid);
    expect(readFileSync(`/proc/${l.pid}/cmdline`, "utf8")).toBe("/bin/sleep\u000030\u0000");
  });

  it("writes its pid into the session scope's cgroup.procs before it resolves, and before anything runs", async () => {
    const d = temp();
    const procs = join(d, "cgroup.procs");
    writeFileSync(procs, "");
    const l = await launch({ argv: ["/usr/bin/true"], env: ENV, drop: [], procs, stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    expect(readFileSync(procs, "utf8")).toBe(`${l.pid}\n`);
    expect(l.child.exitCode).toBe(null);
    await l.release();
    expect((await l.exited).code).toBe(0);
  });

  it("rejects, with nothing left running and nothing run, when the move into the scope fails", async () => {
    const d = temp();
    const mark = join(d, "ran");
    let pid = 0;
    const err = await launch({
      argv: ["/usr/bin/touch", mark], env: ENV, drop: [], procs: join(d, "no-such-scope", "cgroup.procs"), stdio: ["ignore", "ignore", "ignore"],
      writeProcs: async (path, p) => {
        pid = p;
        writeFileSync(path, String(p));
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/moving the launcher into .*no-such-scope\/cgroup\.procs: ENOENT/);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    await sleep(100);
    expect(existsSync(mark)).toBe(false);
  });

  it("rejects a move that never answers at its bound, killing the launcher", async () => {
    let pid = 0;
    const err = await launch({
      argv: ["/usr/bin/true"], env: ENV, drop: [], procs: "/x", stdio: ["ignore", "ignore", "ignore"], boundMs: 200,
      writeProcs: (_path, p) => {
        pid = p;
        return new Promise(() => {});
      },
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/did not answer within 200 ms/);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  });

  it("rejects a release once the launcher has gone", async () => {
    const l = await launch({ argv: ["/usr/bin/true"], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    killGroup(l.pid);
    await l.exited;
    await expect(l.release()).rejects.toThrow(/releasing the launcher/);
  });
});

describe("untilRunning", () => {
  it("resolves once the launcher has become its command", async () => {
    const l = await launch({ argv: ["/bin/sleep", "30"], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    await l.release();
    await untilRunning(l);
    expect(readFileSync(`/proc/${l.pid}/cmdline`, "utf8").split("\0")[0]).toBe("/bin/sleep");
  });

  it("rejects a command that is not there, as the launcher ends first", async () => {
    const l = await launch({ argv: ["/nonexistent/server"], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    await l.release();
    await expect(untilRunning(l)).rejects.toThrow(/ended before it ran \(exit code 127/);
  });

  it("rejects one still at its gate at the bound, its group killed", async () => {
    const l = await launch({ argv: ["/bin/sleep", "30"], env: ENV, drop: [], stdio: ["ignore", "ignore", "ignore"] });
    started.push(l);
    await expect(untilRunning(l, 200)).rejects.toThrow(/did not run within 200 ms/);
    expect((await l.exited).signal).toBe("SIGKILL");
  });
});

describe.skipIf(!existsSync(SETPRIV))("the real setpriv, to this account's own uid", () => {
  it("runs the command with no_new_privs, as the uid and gid given, through the same script", async () => {
    const l = await launch({
      argv: ["/bin/sh", "-c", "id -u; id -g; grep NoNewPrivs /proc/self/status"], env: ENV,
      drop: dropArgs(process.getuid!(), process.getgid!(), "keep"), stdio: ["ignore", "pipe", "inherit"],
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect((await out).trim().split("\n")).toEqual([String(process.getuid!()), String(process.getgid!()), "NoNewPrivs:\t1"]);
  });

  it("hands the token through setpriv on fd 4 too (review N1)", async () => {
    const l = await launch({
      argv: ["/bin/sh", "-c", "cat <&4"], env: ENV, drop: dropArgs(process.getuid!(), process.getgid!(), "keep"),
      stdio: ["ignore", "pipe", "inherit"], token: "t".repeat(64),
    });
    started.push(l);
    const out = output(l);
    await l.release();
    expect(await out).toBe("t".repeat(64));
  });

  it("rejects through untilRunning when setpriv refuses (init-groups without root), nothing run", async () => {
    const l = await launch({
      argv: ["/usr/bin/true"], env: ENV, drop: dropArgs(process.getuid!(), process.getgid!()), stdio: ["ignore", "ignore", "ignore"],
    });
    started.push(l);
    await l.release();
    const err = await untilRunning(l).catch((e: unknown) => e);
    if (process.getuid!() === 0) expect(err).toBeUndefined();
    else expect(String(err)).toMatch(/ended before it ran/);
  });
});
