import { spawn } from "node:child_process";
import type { ServerExit, ServerProcess, ServerSpec } from "./port.js";

/** A server asked to stop whose process group has not emptied within this is killed (the port's own grace). */
export const STOP_GRACE_MS = 3_000;
/** How often, within the grace, a stop looks whether the group has emptied. */
const GROUP_POLL_MS = 20;

/**
 * A plugin's server as a plain child process of this one: `spec.argv` run with `spec.env` and
 * nothing else, in `spec.cwd`, its standard input and output piped, its standard error this
 * process's. It leads a process group of its own, so that `stop` ends whatever it started too
 * (`serverProcess`). The scripted OS starts servers so, as the harness's own user and without
 * `setpriv` (*The scripted OS*); the Linux port (plan 4b) starts them through its launcher, the
 * account and the session, and keeps this `stop` through `serverProcess`.
 */
export async function spawnServer(spec: ServerSpec, graceMs = STOP_GRACE_MS): Promise<ServerProcess> {
  const child = spawn(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "inherit"], detached: true });
  // A write after the server died is an EPIPE on its stdin: the transport sees the exit, and the error must not reach the process.
  child.stdin!.on("error", () => {});
  child.stdout!.on("error", () => {});
  const exited = new Promise<ServerExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return serverProcess({ pid: child.pid!, stdin: child.stdin!, stdout: child.stdout!, exited }, graceMs);
}

/**
 * A running process that leads its own process group, as a `ServerProcess`: `stop` sends SIGTERM to
 * the whole group, whether or not the leader itself has exited (a server that crashed leaves its
 * player running), waits up to the grace for the group to empty, sends SIGKILL to what is left, and
 * resolves once the leader has exited; any number of calls share the one stop.
 */
export function serverProcess(
  p: { pid: number; stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; exited: Promise<ServerExit> },
  graceMs = STOP_GRACE_MS,
): ServerProcess {
  return { pid: p.pid, stdin: p.stdin, stdout: p.stdout, exited: p.exited, stop: groupStop(p.pid, p.exited, graceMs) };
}

/**
 * The stop of a process that leads its own group (`serverProcess`'s, and the Linux backend's for its
 * helpers): SIGTERM to the group, SIGKILL to what is left after the grace, resolved once the leader
 * has exited; every call shares the one stop.
 */
export function groupStop(pid: number, exited: Promise<unknown>, graceMs = STOP_GRACE_MS): () => Promise<void> {
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // The group is gone already.
    }
  };
  // A group id is not given to a new process while any member of the group lives, so the group
  // is the server's for as long as it answers.
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      if (!groupAlive()) return void (await exited);
      signal("SIGTERM");
      const deadline = Date.now() + graceMs;
      // The server first, then whatever it started, each within the one grace.
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); });
      await Promise.race([exited, late]);
      clearTimeout(timer);
      while (groupAlive() && Date.now() < deadline) await sleep(GROUP_POLL_MS);
      if (groupAlive()) signal("SIGKILL");
      await exited;
    })();
    return stopping;
  };
}
