// A stand-in for a process the Linux backend starts (plan 4b's tests): it writes what it was started
// with (its arguments, environment and working directory, and, given `--token-fd <fd>`, the token it
// read to that descriptor's end and whether the descriptor is still open after it closed it) to the
// file its first argument names, starts a child of its own (a player, as a server might), then waits
// until it is ended. With `--echo`, it copies its standard input to its standard output.
import { spawn } from "node:child_process";
import { closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [out, ...rest] = process.argv.slice(2);
const at = rest.indexOf("--token-fd");
let token;
let tokenFdOpen;
if (at >= 0) {
  const fd = Number(rest[at + 1]);
  token = readFileSync(fd, "utf8");
  closeSync(fd);
  tokenFdOpen = existsSync(`/proc/self/fd/${fd}`);
}
const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
writeFileSync(out, JSON.stringify({
  argv: rest, env: process.env, cwd: process.cwd(), child: child.pid,
  ...(at >= 0 ? { token, tokenFdOpen } : {}),
}));
if (rest.includes("--echo")) process.stdin.pipe(process.stdout);
setInterval(() => {}, 60_000);
