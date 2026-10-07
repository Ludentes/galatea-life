import { randomUUID } from "node:crypto";
import { clockFromEnv } from "@ludentes/galatea-life-test-clock";
import { ZigbeeBridge } from "./bridge.js";
import { connectPg, maskUrls } from "./db.js";
import { brokerFromEnv, coordinatorFromEnv, databaseUrlWithPassword, endUnannounced, noActionsFromEnv, privateDirProblem, readPins, readSecret } from "./entry.js";
import { ensureStateDir, InstanceError, InstanceLock } from "./instance-lock.js";
import { mutationFromEnv } from "./mutation.js";
import type { DoerPort } from "./port.js";
import { ScriptedDoer } from "./scripted-doer.js";
import { Store } from "./store.js";
import { LINK_MUTATIONS, type LinkMutation } from "./transport.js";
import { DESCRIBE_MUTATIONS, type DescribeMutation } from "./vocabulary.js";
import { MqttWire } from "./wire.js";

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

const env = process.env;
// The scripted doer runs only when the harness's start-up option names its control topic (GA-BRIDGE-16);
// otherwise the herdsman doer drives the coordinator GALATEA_ZIGBEE_COORDINATOR names.
const controlTopic = env.GALATEA_TEST_TRANSPORT;
if (!env.GALATEA_BROKER || !env.GALATEA_ROOT || !env.GALATEA_STATE_DIR || !env.GALATEA_DATABASE_URL) {
  fail("GALATEA_BROKER, GALATEA_ROOT, GALATEA_STATE_DIR and GALATEA_DATABASE_URL are required");
}
const zigbee = controlTopic ? undefined : coordinatorFromEnv(env.GALATEA_ZIGBEE_COORDINATOR);
if (zigbee && "refused" in zigbee) fail(`refusing to start: ${zigbee.refused}`);
// The owner's switch for read-only work on a real network: every action withheld, nothing sent to a device.
const withheld = noActionsFromEnv(env.GALATEA_ZIGBEE_NO_ACTIONS);
if ("refused" in withheld) fail(`refusing to start: ${withheld.refused}`);
const runId = env.GALATEA_TEST_RUN_ID;
// A negative subject's mutation, only under a run: one without a run, or a name this build does not implement, is refused.
const asked = mutationFromEnv(env);
if ("refused" in asked) fail(`refusing to start: ${asked.refused}`);
const mutation = asked.mutation;
// A broker that is no URL is a configuration error, said plainly before anything is opened.
const named = brokerFromEnv(env.GALATEA_BROKER);
if ("refused" in named) fail(`refusing to start: ${named.refused}`);
// The install keeps the broker's and the store's passwords in files (plan 4a); without them the URLs are used as they are.
let broker: { url: string; username: string; password?: string } = named;
if (env.GALATEA_CREDENTIAL_FILE) {
  const read = readSecret(env.GALATEA_CREDENTIAL_FILE, "GALATEA_CREDENTIAL_FILE");
  if ("refused" in read) fail(`refusing to start: ${read.refused}`);
  broker = { ...named, password: read.secret };
}
let databaseUrl = env.GALATEA_DATABASE_URL;
if (env.GALATEA_DATABASE_PASSWORD_FILE) {
  const read = readSecret(env.GALATEA_DATABASE_PASSWORD_FILE, "GALATEA_DATABASE_PASSWORD_FILE");
  if ("refused" in read) fail(`refusing to start: ${read.refused}`);
  const filled = databaseUrlWithPassword(databaseUrl, read.secret);
  if ("refused" in filled) fail(`refusing to start: ${filled.refused}`);
  databaseUrl = filled.url;
}

// One bridge per data directory, taken before the store is opened, in a directory no other account can write to.
let lock: InstanceLock;
try {
  ensureStateDir(env.GALATEA_STATE_DIR);
  lock = await InstanceLock.acquire(env.GALATEA_STATE_DIR);
} catch (err) {
  if (err instanceof InstanceError) fail(`refusing to start: ${err.message}`);
  throw err;
}
/** The owner's PINs for locks, by device id; none under the test transport, whose doer is given them by its own op. */
let pins = new Map<string, string>();
if (zigbee) {
  // The data directory holds the network key and herdsman's backup of the coordinator, in clear: the
  // bridge's alone, and every file herdsman writes in it readable by its owner only.
  const exposed = privateDirProblem(env.GALATEA_STATE_DIR);
  if (exposed) fail(`refusing to start: ${exposed}`);
  // The owner's PINs for locks, by device id (GA-BRIDGE-36): the bridge's own configuration, beside the network key.
  const read = readPins(env.GALATEA_STATE_DIR);
  if ("refused" in read) fail(`refusing to start: ${read.refused}`);
  pins = read.pins;
  process.umask(0o077);
  // herdsman's log never carries the key (GA-BRIDGE-24); its debug lines only when asked. herdsman is
  // loaded only here: under the harness, the bridge never loads it.
  const { useHerdsmanLogger } = await import("./herdsman/log.js");
  useHerdsmanLogger({ write: (line) => console.error(line), debug: env.GALATEA_ZIGBEE_DEBUG === "1" });
}

// A store that cannot be opened is no state to serve from: the service manager starts the bridge again.
let store: Store;
try {
  store = await Store.open(connectPg(databaseUrl));
} catch (err) {
  fail(`refusing to start: the store named by GALATEA_DATABASE_URL could not be opened: ${maskUrls(String((err as Error).message ?? err))}`);
}

const root = env.GALATEA_ROOT;
const bridgeId = broker.username;
const instanceId = randomUUID();
const clock = await clockFromEnv(env);

// A recoverable fault never makes the bridge exit (GA-BRIDGE-10): a rejected promise nobody awaited
// is logged, and the bridge serves on. An exception thrown with nobody to catch it still ends the
// process, and the service manager starts it again.
process.on("unhandledRejection", (err) => console.error(`unhandled: ${err}`));

// Before the bridge announced itself, a stop exits at once (a start may wait on a broker that is
// away), ending its connection cleanly so that the will announces nothing. Once it announced, the
// bridge leaves in GA-BRIDGE-22's order.
let ready = false;
let stopping = false;
let doerWire: MqttWire | undefined;
let bridge: ZigbeeBridge | undefined;
let wire: MqttWire | undefined;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  if (!ready && !bridge?.announced) {
    console.error("stopped before ready");
    void Promise.allSettled([wire && endUnannounced(wire), doerWire?.drop()]).finally(() => process.exit(0));
    return;
  }
  bridge!.stop().then(
    async () => {
      // Dropped, not ended: an end waits for every unacknowledged publish, forever with the broker away,
      // and this connection carries no will.
      await doerWire?.drop().catch(() => {});
      await store.close().catch(() => {});
      await lock.release();
      clock.close();
      process.exit(0);
    },
    (err) => fail(`stopping: ${err}`, 1),
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// The scripted doer has a connection of its own, as the radio is not the bridge.
if (controlTopic) doerWire = await MqttWire.connect({ ...broker, clientId: `${bridgeId}-doer-${instanceId.slice(0, 8)}` });
wire = await MqttWire.connect({
  ...broker,
  // Under a run, several subjects share the identity on one broker.
  clientId: `${bridgeId}-${instanceId.slice(0, 8)}`,
  will: { topic: `${root}/bridges/${bridgeId}/lwt`, payload: { bridgeId, instanceId } },
});

const linkMutation = mutation && (LINK_MUTATIONS as readonly string[]).includes(mutation) ? { mutation: mutation as LinkMutation } : {};
let scripted: ScriptedDoer | undefined;
let doer: DoerPort;
if (controlTopic) {
  doer = scripted = new ScriptedDoer({
    clock,
    onReceived: (r) => doerWire!.publish(`${controlTopic}/received`, r, false),
    onStall: (ms) => bridge?.stall(ms),
    onPin: (hardwareId, pin) => bridge?.setPinFor(hardwareId, pin),
    ...linkMutation,
    ...(mutation && (DESCRIBE_MUTATIONS as readonly string[]).includes(mutation) ? { describeMutation: mutation as DescribeMutation } : {}),
  });
} else {
  // A stop before the bridge announced itself abandons a herdsman start under way: the guard lets
  // herdsman only resume, which writes nothing to the coordinator, and the process's end closes its link.
  const { HerdsmanDoer } = await import("./herdsman/doer.js");
  doer = new HerdsmanDoer({ clock, coordinator: zigbee!.coordinator, dataDir: env.GALATEA_STATE_DIR, ...linkMutation,
    ...(withheld.noActions ? { noActions: true } : {}) });
}
bridge = new ZigbeeBridge({ bridgeId, instanceId, root, clock, doer, wire, store, ...(runId ? { runId } : {}),
  ...(mutation ? { mutation } : {}) });
for (const [deviceId, pin] of pins) bridge.setPin(deviceId, pin);
if (scripted) await scripted.serve(doerWire!, controlTopic!);
await bridge.start();
ready = true;
console.log("ready");
