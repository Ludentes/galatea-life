import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { clockFromEnv } from "@ludentes/galatea-life-test-clock";
import { COMPUTER, PcBridge } from "./bridge.js";
import { readCredential, CredentialError, LINUX_CREDENTIAL, LINUX_STATE_DIR } from "./credential.js";
import { InstanceError, InstanceLock } from "./instance-lock.js";
import { LinuxOs } from "./linux-os.js";
import type { OsPort } from "./port.js";
import { ScriptedOs } from "./scripted-os.js";
import { ensureStateDir, StateError, StateStore } from "./state-store.js";
import { MqttWire } from "./wire.js";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

/** The subject contract's GALATEA_BROKER: its user name is the bridge's identity. */
function brokerFromEnv(text: string): { url: string; username: string } {
  const u = new URL(text);
  const username = decodeURIComponent(u.username);
  if (!username) fail(`GALATEA_BROKER names no identity: ${text}`);
  return { url: `${u.protocol}//${u.host}`, username };
}

const env = process.env;
// The scripted OS runs only when the harness's start-up option names its control topic (GA-BRIDGE-16);
// without it, the Linux backend reads the OS itself.
const controlTopic = env.GALATEA_TEST_TRANSPORT;
if (!env.GALATEA_BROKER || !env.GALATEA_ROOT) fail("GALATEA_BROKER and GALATEA_ROOT are required");
if (controlTopic && !env.GALATEA_STATE_DIR) fail("GALATEA_STATE_DIR is required with GALATEA_TEST_TRANSPORT");
const stateDir = env.GALATEA_STATE_DIR ?? LINUX_STATE_DIR;

// The broker credential on Linux: a file only root reads (GA-BRIDGE-64), never printed. A development
// run as another account names a file of its own, mode 0600, in GALATEA_CREDENTIAL_FILE.
let password: string | undefined;
if (!controlTopic) {
  try {
    password = readCredential(env.GALATEA_CREDENTIAL_FILE ?? LINUX_CREDENTIAL);
  } catch (err) {
    if (err instanceof CredentialError) fail(`refusing to start: ${err.message}`);
    throw err;
  }
}

// One bridge per state directory, taken before the state is read, in a directory no other account can write to.
let lock: InstanceLock;
try {
  ensureStateDir(stateDir);
  lock = await InstanceLock.acquire(stateDir);
} catch (err) {
  if (err instanceof InstanceError || err instanceof StateError) fail(`refusing to start: ${err.message}`);
  throw err;
}

let store: StateStore;
try {
  store = StateStore.load(stateDir);
} catch (err) {
  // Never an empty store in its place (the design's *Error handling*).
  if (err instanceof StateError) fail(`refusing to start: ${err.message}`);
  throw err;
}

const broker = brokerFromEnv(env.GALATEA_BROKER);
const root = env.GALATEA_ROOT;
const bridgeId = broker.username;
const instanceId = randomUUID();
const runId = env.GALATEA_TEST_RUN_ID;
const clock = await clockFromEnv(env);

// A recoverable fault never makes the bridge exit (GA-BRIDGE-10). A thrown error nobody caught is
// no recoverable fault: the process exits, and the service manager starts it again (plan 4).
process.on("unhandledRejection", (err) => console.error(`unhandled: ${err}`));

// Before `ready`, a stop exits at once: a start may wait on a broker that is away, and the broker's
// will reports whatever it had announced. After it, the bridge leaves in GA-BRIDGE-22's order.
let ready = false;
let stopping = false;
let osWire: MqttWire | undefined;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  if (!ready) {
    console.error("stopped before ready");
    process.exit(0);
  }
  bridge!.stop().then(
    async () => {
      // Dropped, not ended: an end waits for every unacknowledged publish, forever with the broker away,
      // and this connection carries no will.
      await osWire?.drop().catch(() => {});
      await lock.release();
      clock.close();
      process.exit(0);
    },
    (err) => fail(`stopping: ${err}`, 1),
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let bridge: PcBridge | undefined;
let os: OsPort;
let scripted: ScriptedOs | undefined;
if (controlTopic) {
  // The scripted OS has a connection of its own, as the OS is not the bridge: it stays up while the bridge sleeps.
  osWire = await MqttWire.connect({ ...broker, clientId: `${bridgeId}-os-${instanceId.slice(0, 8)}` });
  scripted = new ScriptedOs({
    device: COMPUTER,
    onReceived: (r) => osWire!.publish(`${controlTopic}/received`, r, false),
    onStall: (ms) => bridge?.stall(ms),
    pluginsDir: join(stateDir, "plugins"),
  });
  os = scripted;
} else {
  // The system bus, the watches, the sampler and the delay lock; a bus that is not there is the computer `down`, never an exit.
  const linux = new LinuxOs();
  // No machine id, no stable identifier: the bridge refuses to start rather than make one up.
  await linux.identity().catch((err: Error) => fail(`refusing to start: ${err.message}`));
  await linux.open();
  os = linux;
}
const wire = await MqttWire.connect({
  ...broker,
  ...(password !== undefined ? { password } : {}),
  // Under a run, several subjects share the identity on one broker.
  clientId: `${bridgeId}-${instanceId.slice(0, 8)}`,
  will: { topic: `${root}/bridges/${bridgeId}/lwt`, payload: { bridgeId, instanceId } },
});
// The broker's host as the bridge reaches it: on this machine, the computer proposes itself as infrastructure (GA-BRIDGE-65).
const brokerHost = new URL(env.GALATEA_BROKER).hostname;
bridge = new PcBridge({ bridgeId, instanceId, root, clock, port: os, wire, store, brokerHost, ...(runId ? { runId } : {}) });
if (scripted) await scripted.serve(osWire!, controlTopic!);
await bridge.start();
ready = true;
console.log("ready");
