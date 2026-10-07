import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MpvIpc } from "./ipc.js";

export interface MpvHandle {
  readonly ipc: MpvIpc;
  readonly socketPath: string;
  readonly dir: string;
  stop(): Promise<void>;
}

const MAX_SOCKET_PATH = 107;

export interface StartMpvOptions {
  mpvPath?: string;
  extraArgs?: string[];
  runtimeDir?: string;
  startTimeoutMs?: number;
}

/**
 * Starts mpv idle, with its IPC socket in a fresh directory of mode 0700 under the account's
 * runtime directory, created under umask 0077: only this account can drive the player, and mpv
 * offers no network control.
 */
export async function startMpv(opts: StartMpvOptions = {}): Promise<MpvHandle> {
  const base = opts.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const dir = mkdtempSync(join(base, "galatea-mpv-"));
  const socketPath = join(dir, "ipc.sock");
  // A Unix socket's path holds at most 107 bytes on Linux; past that mpv opens none, silently.
  const length = Buffer.byteLength(socketPath);
  if (length > MAX_SOCKET_PATH) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`mpv's socket path would be ${length} bytes, over the ${MAX_SOCKET_PATH} a Unix socket allows: ${socketPath}`);
  }
  const args = [
    "--idle=yes", "--force-window=no", "--no-terminal", `--input-ipc-server=${socketPath}`,
    // A file's content never takes mpv elsewhere: no EDL or playlist references followed, whatever
    // the file's name, and no URL handed to the ytdl hook (GA-BRIDGE-54).
    "--access-references=no", "--ytdl=no",
    // The keyboard's volume keys stop at the manifest's 0 to 100.
    "--volume-max=100",
    ...(opts.extraArgs ?? []),
  ];

  const previous = process.umask(0o077);
  let child;
  try {
    child = spawn(opts.mpvPath ?? "mpv", args, { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    process.umask(previous);
  }
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
  let exited = false;
  child.on("exit", () => { exited = true; });
  const spawnFailed = new Promise<never>((_, reject) => child.once("error", reject));
  spawnFailed.catch(() => { /* raced below */ });

  const deadline = Date.now() + (opts.startTimeoutMs ?? 10_000);
  const ready = (async () => {
    while (!existsSync(socketPath)) {
      if (exited) throw new Error(`mpv exited before opening its socket: ${stderr.trim()}`);
      if (Date.now() > deadline) throw new Error("mpv did not open its socket in time");
      await sleep(50);
    }
  })();
  let ipc: MpvIpc;
  try {
    await Promise.race([ready, spawnFailed]);
    ipc = await MpvIpc.connect(socketPath);
  } catch (e) {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  return {
    ipc,
    socketPath,
    dir,
    async stop() {
      if (!exited) {
        const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const timeout = sleep(3_000, undefined, { ref: false });
        // The quit races mpv being gone already and the timeout: none of the three may hang stop.
        const quit = ipc.command(["quit"]).catch(() => { /* the socket closes as mpv quits */ });
        await Promise.race([quit, gone, timeout]);
        await Promise.race([gone, timeout]);
        if (!exited) child.kill("SIGKILL");
      }
      ipc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
