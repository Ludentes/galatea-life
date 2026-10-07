import { homedir } from "node:os";
import { join } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { findBest, readFolders, scan } from "./library.js";
import { PLUGIN_VERSION } from "./manifest.js";
import { startMpv, type MpvHandle } from "./mpv-process.js";
import { Player } from "./player.js";
import { createMcpServer } from "./server.js";

/**
 * The plugin's server: mpv idle behind its private socket, the player over it, MCP on stdio in
 * either protocol era (`serveStdio` picks the era from the client's opening message).
 * Extra arguments are passed to mpv (the tests pass `--vo=null --ao=null --no-config`); the
 * manifest's command passes none. stdout is MCP's; anything else goes to stderr.
 *
 * The bridge can end the connection (closing stdin, or SIGTERM) at any point, including while mpv
 * is still starting or while the player is still attaching. `stop` always resolves `mpvPromise`
 * first, so mpv and its socket directory are stopped and removed however early the signal
 * arrives; `startMpv` already cleans up after its own start-up failures.
 */
async function main(mpvArgs: string[]): Promise<void> {
  const home = homedir();
  const foldersFile = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "galatea-mpv", "folders");

  let mpvPromise: Promise<MpvHandle> | undefined;
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    await mpvPromise?.then(
      (mpv) => mpv.stop(),
      () => { /* startMpv failed on its own and already cleaned up after itself */ },
    );
    process.exit(code);
  };
  // Registered before `startMpv` is called, not only before it settles: it makes the socket
  // directory and spawns mpv before its first await, so a signal that came after the directory
  // appeared but before the handlers were in would kill this process by default and leave mpv
  // running. A signal during start-up stops mpv and removes its socket directory once `startMpv`
  // resolves (or does nothing further if it rejected); a handler runs only after this synchronous
  // code, so `mpvPromise` is set by then.
  process.stdin.once("end", () => { void stop(0); });
  process.on("SIGTERM", () => { void stop(0); });
  const started = startMpv({ extraArgs: mpvArgs });
  mpvPromise = started;

  let mpv: MpvHandle;
  try {
    mpv = await started;
  } catch (e) {
    if (stopping) return; // `stop` above is already exiting the process.
    throw e;
  }
  if (stopping) {
    await mpv.stop();
    return;
  }
  mpv.ipc.on("close", () => {
    if (stopping) return;
    stopping = true;
    console.error("mpv exited; the server exits so that the bridge starts it again");
    void mpv.stop().finally(() => process.exit(1));
  });

  let player: Player;
  try {
    player = await Player.attach(mpv.ipc, {
      findFile: async (search) => findBest(await scan(await readFolders(foldersFile, home)), search)?.path,
    });
  } catch (e) {
    // Stopping already (a signal, or mpv gone): whoever set `stopping` exits the process once mpv
    // is stopped; rethrowing here would exit it first, while that stop is still running.
    if (stopping) return;
    await mpv.stop();
    throw e;
  }
  if (stopping) return;

  serveStdio(() => createMcpServer(player, PLUGIN_VERSION));
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
