import { spawn } from "node:child_process";

/** How long any command the Linux backend runs may take, unless its call says otherwise: a hung tool never stalls the bridge. */
export const COMMAND_MS = 5_000;
/** What is kept of a command's output: more is cut, and the command is not stopped for it. */
const OUTPUT_CAP = 1024 * 1024;

/**
 * The environment every command runs with, and nothing else: the system's own `PATH`, and the C
 * locale, so that each tool writes the English text its parser reads (sudo, loginctl and dpkg
 * translate their messages).
 */
export const COMMAND_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};

/** A command that ran to its end: its exit code (null when a signal ended it) and what it wrote. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Why a command gave no result: not installed, over its bound (and killed), or not started at all. */
export class RunError extends Error {
  constructor(readonly kind: "missing" | "timeout" | "failed", message: string) {
    super(message);
  }
}

export interface RunOptions {
  /** The bound, `COMMAND_MS` by default. */
  timeoutMs?: number;
  /** Variables added to `COMMAND_ENV`. */
  env?: Record<string, string>;
  /** Ends the command at once (its process group killed) and rejects: the port's `close` (review M5). */
  signal?: AbortSignal;
  /** What is kept of the output, 1 MiB by default (plan 4b: a PipeWire graph may be larger). */
  maxBytes?: number;
}

/**
 * The one way the Linux backend asks the OS's tools anything (`sudo`, `loginctl`, `shutdown`,
 * `chronyc`, `timedatectl`, `systemctl`, `dpkg`, `dpkg-query`, `getent`, `setpriv`, a login shell):
 * the unit tests hand the backend a fake that answers in the real tools' formats.
 */
export type Runner = (file: string, args: readonly string[], o?: RunOptions) => Promise<RunResult>;

/**
 * Runs a command with no shell and no standard input, in `COMMAND_ENV`, bounded: past its bound it
 * is killed and the call rejects with `timeout`; a command not installed rejects with `missing`; an
 * aborted `signal` kills it and rejects at once. The command is its own process group, and the kill
 * (SIGKILL) is the group's, so a login shell under `setpriv` or a child it forked goes with it
 * (review M10). A non-zero exit is a result, not an error: each caller reads what the tool meant by it.
 */
export const run: Runner = (file, args, o = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const bound = o.timeoutMs ?? COMMAND_MS;
    if (o.signal?.aborted) {
      reject(new RunError("failed", `${file}: aborted`));
      return;
    }
    const child = spawn(file, [...args], { env: { ...COMMAND_ENV, ...o.env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Gone already, or never started.
      }
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let kept = 0;
    const cap = o.maxBytes ?? OUTPUT_CAP;
    const keep = (into: Buffer[]) => (chunk: Buffer) => {
      if (kept >= cap) return;
      into.push(chunk.subarray(0, cap - kept));
      kept += chunk.length;
    };
    child.stdout.on("data", keep(out));
    child.stderr.on("data", keep(err));
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      reject(new RunError("failed", `${file}: aborted`));
    };
    const done = () => {
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      done();
      killGroup();
      reject(new RunError("timeout", `${file} did not finish within ${bound} ms`));
    }, bound);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      done();
      reject(new RunError(e.code === "ENOENT" ? "missing" : "failed", `${file}: ${e.message}`));
    });
    child.once("close", (code) => {
      if (settled) return;
      done();
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
  });

/** Settles as `work` does, or rejects with `what` once `ms` has passed: every bus call and read the backend waits on is bounded. */
export function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RunError("timeout", `${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
