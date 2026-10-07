import { detectPersonalKeys } from "./linux-os.js";
import { isOwnAddress } from "./own-address.js";
import { LoginPaths, readAccounts, readIdentity } from "./linux/accounts.js";
import { readAdminFacts } from "./linux/admins.js";
import { dbusNextBus } from "./linux/bus.js";
import { under } from "./linux/etc.js";
import { exists } from "./linux/files.js";
import { Logind, toOsSessions } from "./linux/logind.js";
import { run } from "./linux/run.js";

/**
 * Prints what the Linux backend reads of this machine, and changes nothing: no delay lock, no
 * clock step, no lock, no suspend; sudo runs only as root. `node dist/linux-read.js [broker-host]`.
 * Its output names accounts and the machine's id: share it redacted.
 */
const root = "/";
const euid = process.geteuid!();
const out: Record<string, unknown> = { euid };
const section = async (name: string, read: () => Promise<unknown>) => {
  try {
    out[name] = await read();
  } catch (err) {
    out[name] = { error: (err as Error).message };
  }
};

await section("identity", () => readIdentity(root));
let sessionUids: number[] = [];
await section("sessions", async () => {
  const bus = await dbusNextBus();
  try {
    const logind = new Logind(bus);
    if (!(await logind.present())) return { error: "logind is not on the system bus" };
    const sessions = toOsSessions(await logind.read());
    sessionUids = sessions.map((s) => s.osId);
    return sessions;
  } finally {
    bus.close();
  }
});
await section("accounts", async () => {
  const read = await readAccounts({ root, run }, [], sessionUids);
  const paths = new LoginPaths({ run, euid });
  return Promise.all(read.listed.map(async (e) => ({ osId: e.uid, name: e.name, primaryGid: e.gid, home: e.home, path: await paths.get(e) })));
});
await section("admins", () => readAdminFacts({ root, run, euid }));
await section("personalKeys", () => detectPersonalKeys(root, async (p) => (await exists(under(root, p))).exists));
const host = process.argv[2] ?? "127.0.0.1";
await section("isOwnAddress", async () => ({ host, own: await isOwnAddress(host) }));
console.log(JSON.stringify(out, null, 2));
