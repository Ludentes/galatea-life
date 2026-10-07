import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { ServerExit } from "../port.js";
import { bounded, COMMAND_MS } from "./run.js";

/** The shell the launcher runs, and the privilege drop, by absolute path: never looked up in an account's `PATH`. */
export const SH = "/bin/sh";
export const SETPRIV = "/usr/bin/setpriv";
/** Sets the command's environment to exactly the one given, whatever the launcher's shell exported (review M4). */
export const ENV = "/usr/bin/env";
/** The launcher's name in `ps` (its `$0`). */
export const LAUNCHER_NAME = "galatea-launcher";
/** How often, while a start waits for its command to run, the launcher's `/proc/<pid>/cmdline` is read. */
const EXEC_POLL_MS = 10;

/**
 * The drop to the account (*Starting a process in a session*): `setpriv --reuid=<uid> --regid=<gid>
 * --init-groups --no-new-privs --`, run as root, so the account's supplementary groups are set
 * (`--init-groups`, from its name in the account database) and nothing it runs gains privileges.
 * `keep` keeps the caller's groups instead (`--keep-groups`), which needs no root: the tests' own
 * drop to their own account.
 */
export function dropArgs(uid: number, gid: number, groups: "init" | "keep" = "init"): string[] {
  for (const id of [uid, gid]) {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error(`not an account's id: ${id}`);
  }
  return [SETPRIV, `--reuid=${uid}`, `--regid=${gid}`, groups === "init" ? "--init-groups" : "--keep-groups", "--no-new-privs", "--"];
}

/**
 * The launcher's script: it blocks reading a line from file descriptor 3, and only once one comes
 * replaces itself with the drop, then `env -i` with the environment's `NAME=value` words and the
 * command, fd 3 closed (`3<&-`) so that the command does not hold the pipe; fd 4, where the start
 * hands a token (`LaunchOptions.token`), stays open to the command, which reads and closes it. `env -i` gives the
 * command exactly the environment given, nothing a shell exports (dash's `PWD`; bash's `SHLVL`,
 * `PWD` and `_` where `/bin/sh` is bash; review M4). The environment's words and the command are the
 * script's positional parameters (`"$@"`), never part of its text; the drop's words are checked to
 * need no quoting. A pipe closed with no line ends the launcher (`read` fails), and nothing runs.
 */
export function launcherScript(drop: readonly string[]): string {
  for (const w of drop) {
    if (!/^[A-Za-z0-9_/=.,:+-]+$/.test(w)) throw new Error(`a launcher word that would need quoting: ${JSON.stringify(w)}`);
  }
  return `read -r _ <&3 && exec ${[...drop, ENV, "-i", '"$@"'].join(" ")} 3<&-`;
}

/**
 * The environment as `env`'s words, in order. A name must be a plain one, and the command's first
 * word must hold no `=`, which `env` would take for one more variable.
 */
export function envWords(env: Record<string, string>, argv: readonly string[]): string[] {
  const words: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`not a variable's name: ${JSON.stringify(k)}`);
    words.push(`${k}=${v}`);
  }
  if (argv.length === 0 || argv[0]!.includes("=")) throw new Error(`a command env would misread: ${JSON.stringify(argv[0] ?? "")}`);
  return words;
}

export interface LaunchOptions {
  /** The command: its first element an absolute path, the rest its arguments, passed to the script as positional parameters. */
  argv: readonly string[];
  /** The environment, and nothing else: set by `env -i`, the launcher itself given none. */
  env: Record<string, string>;
  cwd?: string;
  /** The privilege drop (`dropArgs`); empty runs the command as the caller, the tests' plain command. */
  drop: readonly string[];
  /** The session scope's `cgroup.procs`, into which the launcher's pid is written before it is released (*Starting a process in a session*). */
  procs?: string;
  /** stdin, stdout and stderr; fd 3 is always the launcher's pipe. */
  stdio: ["pipe" | "ignore", "pipe" | "ignore" | "inherit", "pipe" | "ignore" | "inherit"];
  /** Writes the pid into `procs`; the tests' stand-in for the cgroup file system. */
  writeProcs?: (path: string, pid: number) => Promise<void>;
  /** Each step's bound: the spawn, the move. */
  boundMs?: number;
  /** The launcher's shell, `/bin/sh`; the tests give bash, as `/bin/sh` is on some systems (review M4). */
  shell?: string;
  /**
   * A secret for the command alone (a helper's start token, review N1): handed on fd 4, a pipe the
   * launcher, the drop and `env` keep open and the command inherits. It is written and the pipe's end
   * here closed at the release, before the line on fd 3; it is never in the argv, the environment or
   * a command line. Without it, the command has no fd 4.
   */
  token?: string;
  /** Called with the launcher's pid as soon as it is spawned, before the move into `procs` (review N2). */
  onSpawn?: (pid: number) => void;
}

/** A launcher waiting at its gate: its pid (the command's, once released), its child, how it ended, and the release. */
export interface Launched {
  pid: number;
  child: ChildProcess;
  /** Settles once, when the process has exited, however it ended; never rejects. */
  exited: Promise<ServerExit>;
  /** Writes the token on fd 4 and closes it (with one), then the line on fd 3, and closes it: the launcher drops and runs the command. Rejects when either could not be written. */
  release(): Promise<void>;
  /** The launcher's command line, and the drop's, as `/proc/<pid>/cmdline` shows each before the command runs. */
  cmdlines: string[][];
}

/** Writes a pid into a cgroup's `cgroup.procs`, which moves the process (as root, *Starting a process in a session*). */
export const writeCgroupProcs = (path: string, pid: number): Promise<void> => writeFile(path, `${pid}\n`, { flag: "w" });

/** Kills a process group, whatever is left of it. */
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

/**
 * Starts the launcher (*Starting a process in a session*): `/bin/sh -c <script> galatea-launcher
 * <argv…>`, spawned as this process's own user (root in the service: never with Node's `uid`/`gid`,
 * which would drop the supplementary groups before `setpriv` sets them), its own process group, with
 * no environment of its own (the command gets `env` and nothing else, through `env -i`), fd 3 a pipe
 * it waits on. With `procs`, the launcher's pid is moved into
 * that cgroup before this resolves; a move that fails kills the launcher and its group, closes the
 * pipe and rejects, so nothing is left running and nothing ran. Every step is bounded.
 */
export async function launch(o: LaunchOptions): Promise<Launched> {
  const bound = o.boundMs ?? COMMAND_MS;
  const script = launcherScript(o.drop);
  const words = [...envWords(o.env, o.argv), ...o.argv];
  const sh = o.shell ?? SH;
  // The launcher itself gets no environment: the command's is env -i's words.
  const child = spawn(sh, ["-c", script, LAUNCHER_NAME, ...words], {
    env: {}, ...(o.cwd ? { cwd: o.cwd } : {}), detached: true, stdio: [...o.stdio, "pipe", ...(o.token !== undefined ? ["pipe"] : [])] as StdioOptions,
  });
  const exited = new Promise<ServerExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    // A spawn that failed outright (no /bin/sh, a cwd not there) never exits.
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  const gate = child.stdio[3] as Writable;
  gate.on("error", () => {});
  const secret = o.token !== undefined ? child.stdio[4] as Writable : undefined;
  secret?.on("error", () => {});
  for (const s of [child.stdin, child.stdout, child.stderr]) s?.on("error", () => {});
  const fail = async (err: Error): Promise<never> => {
    gate.destroy();
    secret?.destroy();
    if (child.pid !== undefined) killGroup(child.pid);
    await bounded(exited, bound, "the launcher's end").catch(() => {});
    throw err;
  };
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    }), bound, "the launcher's start");
  } catch (err) {
    return fail(err as Error);
  }
  const pid = child.pid!;
  o.onSpawn?.(pid);
  if (o.procs) {
    try {
      await bounded((o.writeProcs ?? writeCgroupProcs)(o.procs, pid), bound, `moving the launcher into ${o.procs}`);
    } catch (err) {
      return fail(new Error(`moving the launcher into ${o.procs}: ${(err as Error).message}`));
    }
  }
  let released: Promise<void> | undefined;
  return {
    pid,
    child,
    exited,
    // The launcher, setpriv (with a drop), then env, before the command runs.
    cmdlines: [
      [sh, "-c", script, LAUNCHER_NAME, ...words],
      ...(o.drop.length ? [[...o.drop, ENV, "-i", ...words]] : []),
      [ENV, "-i", ...words],
    ],
    release() {
      released ??= new Promise<void>((resolve, reject) => {
        const line = () => gate.write("\n", (err) => {
          gate.end();
          if (err) reject(new Error(`releasing the launcher: ${err.message}`));
          else resolve();
        });
        if (!secret) return line();
        // The token first, its pipe's end here closed, so the command reads it to its end; then the line.
        secret.end(o.token, () => line());
        secret.once("error", (err: Error) => {
          gate.destroy();
          reject(new Error(`handing the launcher its token: ${err.message}`));
        });
      });
      return released;
    },
  };
}

/**
 * Waits until the launcher has become its command: its `/proc/<pid>/cmdline` is neither the
 * launcher's nor the drop's (`l.cmdlines`). Rejects when it ends first (the drop refused, the
 * command not there) or has not got there within the bound, its group then killed: nothing is left
 * running.
 */
export async function untilRunning(l: Launched, boundMs = COMMAND_MS, proc = "/proc"): Promise<void> {
  let ended: ServerExit | undefined;
  void l.exited.then((e) => { ended = e; });
  const deadline = Date.now() + boundMs;
  const before = l.cmdlines.map((c) => c.join("\0"));
  for (;;) {
    if (ended) throw new Error(`it ended before it ran (exit code ${ended.code}${ended.signal ? `, ${ended.signal}` : ""})`);
    const text = await readFile(`${proc}/${l.pid}/cmdline`, "utf8").catch(() => "");
    const args = text.replace(/\0$/, "");
    if (args !== "" && !before.includes(args)) return;
    if (Date.now() >= deadline) {
      killGroup(l.pid);
      await l.exited;
      throw new Error(`it did not run within ${boundMs} ms`);
    }
    await new Promise((r) => setTimeout(r, EXEC_POLL_MS));
  }
}
