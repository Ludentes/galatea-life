import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { clockFromEnv, systemClock } from "@ludentes/galatea-life-test-clock";
import { ConfigError, loadConfig } from "./config.js";
import type { Link } from "./link.js";
import { LinuxLink } from "./linux-link.js";
import { Relay } from "./relay.js";
import { TestLink } from "./test-link.js";
import { MqttWire, readSecret } from "./wire.js";

const USAGE = "usage: node dist/main.js --config <file>";

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

const argv = process.argv.slice(2);
const at = argv.indexOf("--config");
const configPath = at >= 0 ? argv[at + 1] : undefined;
if (!configPath) fail(USAGE);

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  if (err instanceof ConfigError) fail(err.message);
  throw err;
}

const env = process.env;
// The test transport runs only when the harness's start-up option names its control topic (GA-BRIDGE-16).
const controlTopic = env.GALATEA_TEST_TRANSPORT;
const under = controlTopic !== undefined && controlTopic !== "";

let broker: { url: string; username: string; password?: string; ca?: Buffer };
let root: string;
if (under) {
  if (!env.GALATEA_BROKER || !env.GALATEA_ROOT) fail("GALATEA_BROKER and GALATEA_ROOT are required with GALATEA_TEST_TRANSPORT");
  broker = brokerFromEnv(env.GALATEA_BROKER);
  root = env.GALATEA_ROOT;
} else {
  if (!config.broker || !config.root) fail("the configuration needs `broker` and `root`");
  broker = { url: config.broker.url, username: config.broker.username };
  const password = readSecret(config.broker.passwordFile);
  if (password !== undefined) broker.password = password;
  if (config.broker.caFile) broker.ca = readFileSync(config.broker.caFile);
  root = config.root;
}

const bridgeId = broker.username;
const instanceId = randomUUID();
const runId = under ? env.GALATEA_TEST_RUN_ID : undefined;
const clock = under ? await clockFromEnv(env) : systemClock();

// A recoverable fault never makes the bridge exit (GA-BRIDGE-10).
process.on("unhandledRejection", (err) => console.error(`unhandled: ${err}`));

// Before `ready`, a stop exits at once: the connect may wait on a broker that is away, and the
// broker's will reports whatever it had announced. After it, the relay leaves in GA-BRIDGE-22's order.
let relay: Relay | undefined;
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  if (!relay) {
    console.error("stopped before ready");
    process.exit(0);
  }
  relay.stop().then(
    () => {
      clock.close();
      process.exit(0);
    },
    (err) => fail(`stopping: ${err}`, 1),
  );
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const wire = await MqttWire.connect({
  ...broker,
  // Under a run, several subjects share the identity on one broker; in a home, the ClientID is the identity.
  clientId: under ? `${bridgeId}-${instanceId.slice(0, 8)}` : bridgeId,
  will: { topic: `${root}/bridges/${bridgeId}/lwt`, payload: { bridgeId, instanceId } },
});

let link: Link;
let control: { topic: string; handle(msg: Record<string, unknown>): void } | undefined;
if (under) {
  const test = new TestLink(config.interface, (sent) => wire.publish(`${controlTopic}/received`, sent, false));
  link = test;
  control = { topic: controlTopic, handle: (msg) => test.control(msg) };
} else {
  link = new LinuxLink(config.interface, config.gateway);
}

const started = new Relay({
  bridgeId, instanceId, root, clock, entries: config.entries, link, wire,
  ...(runId ? { runId } : {}),
  ...(control ? { control } : {}),
  ...(runId && env.GALATEA_MUTATION ? { mutation: env.GALATEA_MUTATION } : {}),
});
try {
  await started.start();
} catch (err) {
  // A subscription with no SUBACK at start: the service manager starts the relay again.
  fail(`starting: ${err}`, 1);
}
relay = started;
console.log("ready");
