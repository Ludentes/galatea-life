#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dbusNextBus, type Bus } from "./linux/bus.js";
import { run } from "./linux/run.js";
import { SessionHelper } from "./helper/session-helper.js";
import { readToken } from "./helper/token.js";

/**
 * The session helper's entry point (`galatea-pc-helper`), which the service starts in each graphical
 * session through its launcher (*Starting a process in a session*): `--session <id> --idle-after
 * <s> --keys <k,…> --token-fd 4`, as the session's account, with the session's display variables,
 * and its start token on fd 4, which it reads at once and closes (review N1). It is not run
 * by the unit, and it is no use run by hand against the real system bus: the service binds only the
 * helper it started itself. The system bus is `DBUS_SYSTEM_BUS_ADDRESS`'s, or the stock socket.
 */
const { values } = parseArgs({
  options: {
    session: { type: "string" }, "idle-after": { type: "string", default: "300" }, keys: { type: "string", default: "" },
    "token-fd": { type: "string" },
  },
  strict: true,
});
const log = (line: string) => console.error(`galatea-pc-helper: ${line}`);
const sessionId = values.session;
const idleAfterS = Number(values["idle-after"]);
const tokenFd = Number(values["token-fd"]);
if (!sessionId || !Number.isFinite(idleAfterS) || idleAfterS <= 0 || !Number.isSafeInteger(tokenFd) || tokenFd < 3) {
  log("usage: --session <id> --token-fd <fd> [--idle-after <seconds>] [--keys app,camera_in_use,microphone_in_use]");
  process.exit(2);
}

// First, before any bus: nothing the helper opens or starts may hold the descriptor.
let token: string;
try {
  token = await readToken(tokenFd);
} catch (err) {
  log((err as Error).message);
  process.exit(1);
}

let system: Bus;
try {
  system = await dbusNextBus();
} catch (err) {
  log(`the system bus: ${(err as Error).message}`);
  process.exit(1);
}
let session: Bus | undefined;
const address = process.env.DBUS_SESSION_BUS_ADDRESS;
if (address) {
  session = await dbusNextBus({ address }).catch((err: Error) => {
    log(`the session bus: ${err.message}; idleness from logind, no notifications`);
    return undefined;
  });
}
const helper = new SessionHelper({
  system, ...(session ? { session } : {}), run, sessionId, idleAfterS, keys: values.keys.split(",").filter(Boolean), token,
  env: process.env, log, exit: (code) => process.exit(code),
});
process.on("SIGTERM", () => helper.end(0, "stopped"));
process.on("SIGINT", () => helper.end(0, "stopped"));
await helper.start();
