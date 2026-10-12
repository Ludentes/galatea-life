#!/usr/bin/env node
// Test only (plan C1, first light simulated): the harness's simulated bridge as the installation's
// broker identity bridge_sim, on mqtts. The sim's own entry takes no password, so this one reads it
// from GALATEA_BROKER_PASSWORD_FILE, as the builds do, and gives it to the MQTT client in the URL,
// in this process only. The installation's CA reaches the client through NODE_EXTRA_CA_CERTS, set
// for this process by compose.sim.yaml. Time is the system clock (GALATEA_TIME_SOURCE unset), as
// the applier's and the steward's is. Its devices: a notify channel and a lamp.
import { readFileSync } from "node:fs";
import { clockFromEnv } from "@ludentes/galatea-life-test-clock";
import { fixtureDevices, parseBrokerUrl, SimBridge } from "@ludentes/galatea-life-sim";

const env = process.env;
const need = (name) => env[name] || (console.error(`${name} is not set`), process.exit(2));
const { url, identity } = parseBrokerUrl(need("GALATEA_BROKER"));
const password = readFileSync(need("GALATEA_BROKER_PASSWORD_FILE"), "utf8").trim();
const withPassword = new URL(url);
withPassword.username = encodeURIComponent(identity);
withPassword.password = encodeURIComponent(password);
const clock = await clockFromEnv(env);
const bridge = new SimBridge({
  brokerUrl: withPassword.toString().replace(/\/$/, ""), root: need("GALATEA_ROOT"), bridgeId: identity, clock,
  controlTopic: need("GALATEA_TEST_TRANSPORT"), runId: env.GALATEA_TEST_RUN_ID, devices: fixtureDevices(["channel", "lamp"]),
});
await bridge.start();
console.log("ready");
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void bridge.stop({ graceful: true }).finally(() => {
    clock.close();
    process.exit(0);
  });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
