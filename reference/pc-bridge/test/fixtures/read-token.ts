// The helper's own token read (review N1) in a process the launcher started: prints the token it read
// from fd 4, then whether fd 4 is still open. Run with Node's type stripping and ts-resolve.mjs.
import { existsSync } from "node:fs";
import { readToken } from "../../src/helper/token.js";

const token = await readToken(4).catch((err: Error) => `refused: ${err.message}`);
process.stdout.write(`${token}\n${existsSync("/proc/self/fd/4") ? "fd 4 open" : "fd 4 closed"}\n`);
