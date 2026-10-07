#!/usr/bin/env node
// The owner tool end to end, plan A's skeleton (the design, *Testing*): the reference applier and
// steward as real processes over the harness's simulated bridge and broker, each with a fresh
// database, as the steward's first-light script runs them, and `galatea` run as the owner runs it,
// a process with an installation directory of secret files. It registers the bridge with the applier
// (the steward is registered by the test, as the installation's galatea-register-steward does), adopts the simulated notify device without a name, defines the home with it as
// the notice channel once the steward sees it adopted, defines a brain's credential, and reads
// `status` and `devices`. Run under `galatea-with-postgres` (GALATEA_TEST_PG_URL). Exits 0 when every
// step holds; prints no credential, key or database URL.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDatabase } from "@ludentes/galatea-life-harness/database";
import { SubjectProcess } from "@ludentes/galatea-life-harness";
import { brokerUrl, fixtureDevices, freePort, SimBridge, startBroker, TimeServer } from "@ludentes/galatea-life-sim";
import { TestClock } from "@ludentes/galatea-life-test-clock";
import { Link } from "../dist/link.js";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDir = (name) => dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`)));
const admin = process.env.GALATEA_TEST_PG_URL;
if (!admin) {
  console.error("GALATEA_TEST_PG_URL is not set: run under galatea-with-postgres");
  process.exit(2);
}

const cleanup = [];
let failed = false;
const secrets = [];
function step(n, what, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${n} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) throw new Error(`step ${n} failed: ${what}`);
}
async function until(what, fn, ms = 15_000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/** The installation's layout (its design, *Credentials*): `secrets/mcp/<name>`, mode 0600 in 0700 directories. */
function makeInstall() {
  const dir = mkdtempSync(join(tmpdir(), "galatea-owner-e2e-"));
  mkdirSync(join(dir, "secrets", "mcp"), { recursive: true, mode: 0o700 });
  chmodSync(join(dir, "secrets"), 0o700);
  const put = (name) => {
    const value = randomBytes(24).toString("base64url");
    const p = join(dir, "secrets", "mcp", name);
    writeFileSync(p, `${value}\n`, { mode: 0o600 });
    secrets.push(value);
    return value;
  };
  return { dir, put };
}

/** `galatea <args>` as a process; what it said, and its exit. */
function galatea(install, env, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, "dist", "main.js"), ...args], { env: { ...process.env, ...env, GALATEA_INSTALL: install } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      const leaked = secrets.some((s) => out.includes(s) || err.includes(s));
      if (leaked) {
        failed = true;
        console.error(`galatea ${args[0]} printed a secret`);
      }
      resolve({ code, out, err, leaked });
    });
  });
}
const shown = (r) => `exit ${r.code}${r.out.trim() ? `; ${r.out.trim().split("\n").join(" | ")}` : ""}${r.err.trim() ? `; err ${r.err.trim()}` : ""}`;

try {
  const runId = `owner-e2e-${randomUUID().slice(0, 8)}`;
  const root = `demo/${runId}`;
  const broker = await startBroker();
  cleanup.push(() => broker.stop());
  const time = await TimeServer.start();
  cleanup.push(() => time.close());
  const clock = await TestClock.connect(time.source);
  cleanup.push(() => clock.close());

  const bridge = new SimBridge({ brokerUrl: broker.url, root, bridgeId: "sim-bridge", clock, runId, devices: fixtureDevices(["channel", "lamp"]) });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  const install = makeInstall();
  cleanup.push(() => rmSync(install.dir, { recursive: true, force: true }));
  const applierOwner = install.put("applier-owner");
  const stewardOwner = install.put("steward-owner");
  const stewardAtApplier = install.put("steward-at-applier");
  const tokenKey = install.put("steward-token-key");
  install.put("brain_agent");

  const applierDb = await freshDatabase(admin);
  cleanup.push(() => applierDb.drop());
  const applierPort = await freePort();
  const applierDir = packageDir("@ludentes/galatea-life-applier");
  const applier = await SubjectProcess.start(applierDir, JSON.parse(readFileSync(join(applierDir, "subject.json"), "utf8")), {
    GALATEA_DATABASE_URL: applierDb.url, GALATEA_BROKER: brokerUrl(broker.url, "applier-owner-e2e"), GALATEA_ROOT: root,
    GALATEA_OWNER_CREDENTIAL: applierOwner, GALATEA_MCP_PORT: String(applierPort), GALATEA_TIME_SOURCE: time.source, GALATEA_TEST_RUN_ID: runId,
  });
  cleanup.push(() => applier.stop());
  const stewardPort = await freePort();
  const urls = { GALATEA_APPLIER_URL: `http://127.0.0.1:${applierPort}/mcp`, GALATEA_STEWARD_URL: `http://127.0.0.1:${stewardPort}/mcp` };
  const g = (...args) => galatea(install.dir, urls, ...args);

  const CHANNEL = "sim-bridge:channel";
  const reg = await g("register", "bridge", "sim-bridge");
  step(1, "galatea register bridge", reg.code === 0, shown(reg));

  // The steward is registered at the applier by the installation's galatea-register-steward, not by
  // the tool: here the test does it, as the owner's configure of client steward over its own link.
  const ownerLink = await Link.connect({ what: "applier", url: new URL(urls.GALATEA_APPLIER_URL), bearer: applierOwner });
  cleanup.push(() => ownerLink.close());
  let registered;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { body } = await ownerLink.call("describe");
    registered = await ownerLink.call("configure", { changes: [{ op: "upsert", kind: "client",
      value: { id: "steward", credential: stewardAtApplier, kind: "steward", token_key: tokenKey } }], expected_revision: body.revision, dry_run: false });
    if (registered.kind !== "refused" || registered.error !== "stale_revision") break;
  }
  step(2, "the steward registered at the applier (by the test, as galatea-register-steward does)", registered.kind === "ok",
    registered.kind === "ok" ? `revision ${registered.body.revision}` : registered.kind);

  const steward = await SubjectProcess.start(packageDir("@ludentes/galatea-life-steward"),
    JSON.parse(readFileSync(join(packageDir("@ludentes/galatea-life-steward"), "subject.json"), "utf8")), {
      GALATEA_DATABASE_URL: (await (async () => { const db = await freshDatabase(admin); cleanup.push(() => db.drop()); return db.url; })()),
      GALATEA_OWNER_CREDENTIAL: stewardOwner, GALATEA_MCP_PORT: String(stewardPort), GALATEA_APPLIER_URL: urls.GALATEA_APPLIER_URL,
      GALATEA_APPLIER_CLIENT: "steward", GALATEA_APPLIER_CREDENTIAL: stewardAtApplier, GALATEA_APPLIER_TOKEN_KEY: tokenKey,
      GALATEA_TIME_SOURCE: time.source, GALATEA_TEST_RUN_ID: runId,
    });
  cleanup.push(() => steward.stop());

  const seen = await until("galatea devices to list the simulated channel, unadopted", async () => {
    const r = await g("devices", "--json");
    if (r.code !== 0) return undefined;
    const d = JSON.parse(r.out).devices.find((x) => x.id === CHANNEL);
    return d && d.adopted === false ? r : undefined;
  });
  step(3, "galatea devices lists the bridge's devices, unadopted", true, `${JSON.parse(seen.out).devices.map((d) => d.id).join(", ")}`);

  const adopted = await g("adopt", CHANNEL, "--class", "channel");
  step(4, "galatea adopt of the notify device, without a name", adopted.code === 0, shown(adopted));

  // The steward's describe shows it adopted (checkChannels reads the steward's mirror) before the home is defined.
  await until("the steward to see the channel adopted", async () => {
    const r = await g("status", "--json");
    const t = r.code === 0 ? JSON.parse(r.out).steward?.targets?.find((x) => x.id === CHANNEL) : undefined;
    return t?.adopted === true;
  });
  const home = join(install.dir, "home.json");
  writeFileSync(home, JSON.stringify([{ op: "upsert", kind: "home", value: { timezone: "Europe/Moscow", notice_channels: [CHANNEL] } }]));
  const dry = await g("define", home, "--dry-run");
  const defined = await g("define", home);
  step(5, "galatea define of the home with the channel as its notice channel", dry.code === 0 && defined.code === 0 && /revision \d+/.test(defined.out),
    `${shown(dry)}; ${shown(defined)}`);

  const cred = await g("credential", "brain_agent", "--kind", "brain", "--confirm-on", "owner-app");
  step(6, "galatea credential of a brain, its secret from its file", cred.code === 0, shown(cred));

  await until("the channel to come alive", async () => {
    await bridge.publishStatus();
    const r = await g("devices", "--json");
    return r.code === 0 && JSON.parse(r.out).devices.find((d) => d.id === CHANNEL)?.liveness === "live";
  }, 15_000, 500);
  await bridge.publishStatus();
  const status = await g("status");
  step(7, "galatea status: both servers reached, the transport up, the channel live, no ask open",
    status.code === 0 && /applier .*reached/.test(status.out) && /steward .*reached/.test(status.out) && /transport \S+ \(\w+\): up, state up, bridge sim-bridge/.test(status.out)
      && /every adopted device is live \(1\)/.test(status.out) && /open asks on owner-app: 0/.test(status.out), shown(status));

  const devices = await g("devices");
  step(8, "galatea devices: the channel adopted and live, the lamp unadopted with its proposal",
    devices.code === 0 && new RegExp(`${CHANNEL}  bridge sim-bridge  adopted, class channel  live`).test(devices.out)
      && /sim-bridge:lamp  bridge sim-bridge  not adopted/.test(devices.out), shown(devices));

  const again = await g("define", home, "--steward", "http://192.0.2.1:18444/mcp");
  const refused = await g("adopt", "sim-bridge:nothing", "--class", "light");
  step(9, "refusals end 2: plain http off loopback, a device the applier does not describe", again.code === 2 && refused.code === 2,
    `${shown(again)}; ${shown(refused)}`);
  step(10, "no secret printed by any command", !failed);
  console.log("The owner tool's plan A skeleton: registered, adopted, defined, and read back through both servers.");
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  while (cleanup.length) await Promise.resolve(cleanup.pop()()).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
