#!/usr/bin/env node
// The owner tool end to end (the design, *Testing*; plans A and B): the reference applier and
// steward as real processes over the harness's simulated bridge and broker, each with a fresh
// database, as the steward's first-light script runs them, and `galatea` run as the owner runs it,
// a process with an installation directory of secret files. Both servers serve TLS with certificates
// from an installation-style CA, which the tool trusts from `<install>/tls/ca.pem` (and the steward
// from GALATEA_APPLIER_CA). It registers the bridge (the steward is registered by the test, as the
// installation's galatea-register-steward does); pairs a device through `galatea join`, the simulated
// bridge claiming Provision and a device joined through its `join` control; adopts it with a name and
// a room before the home has a notice channel (the steward refuses, after the applier's change: exit
// 1 and the line to run again); adopts the simulated notify device without a name and defines the
// home with it as the channel; runs the printed line again; defines a brain's credential; reads
// `status` and `devices`; interrupts a `galatea join` (Ctrl-C closes its window); removes the paired
// device. Then plan C's confirmations: the simulated lamp adopted with `onoff.turn_on` raised to
// confirm; `galatea do ... --yes` (acked, the lamp on) while `galatea events --follow` shows the
// outcome and Ctrl-C ends it; a `do` left open, listed by `galatea asks`, applied by `galatea answer
// ... yes`; a `no` whose step is skipped, nothing sent; `galatea history` reading it back. Run under `galatea-with-postgres` (GALATEA_TEST_PG_URL). Exits 0 when every step holds;
// prints no credential, key or database URL.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The installation's CA (its design, *TLS*): the CA's key in `secrets/ca/`, its certificate public at
 * `tls/ca.pem`, and a server certificate for 127.0.0.1 for each of the applier and the steward, signed
 * by it, their keys beside the CA's. Made with the host's openssl, as the installation's script does.
 */
function makeCa(dir) {
  mkdirSync(join(dir, "tls"), { recursive: true });
  mkdirSync(join(dir, "secrets", "ca"), { recursive: true, mode: 0o700 });
  const ca = { cert: join(dir, "tls", "ca.pem"), key: join(dir, "secrets", "ca", "ca.key") };
  const ssl = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  ssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", ca.key, "-out", ca.cert, "-days", "1",
    "-subj", "/CN=galatea owner-tool e2e CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  const server = (name) => {
    const key = join(dir, "secrets", "ca", `${name}.key`);
    const csr = join(dir, "secrets", "ca", `${name}.csr`);
    const cert = join(dir, "tls", `${name}.pem`);
    ssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${name}`,
      "-addext", "subjectAltName=IP:127.0.0.1");
    ssl("x509", "-req", "-in", csr, "-CA", ca.cert, "-CAkey", ca.key, "-CAcreateserial", "-out", cert, "-days", "1", "-copy_extensions", "copyall");
    return { cert, key };
  };
  return { ca: ca.cert, applier: server("applier"), steward: server("steward") };
}

/** `galatea <args>` left running: its lines as they come, a wait for one, and its end. */
function galateaLive(install, env, ...args) {
  const child = spawn(process.execPath, [join(here, "dist", "main.js"), ...args], { env: { ...process.env, ...env, GALATEA_INSTALL: install } });
  let out = "";
  let err = "";
  const waiters = [];
  const wake = () => { for (const w of [...waiters]) w(); };
  child.stdout.on("data", (d) => { out += d; wake(); });
  child.stderr.on("data", (d) => { err += d; wake(); });
  const ended = new Promise((resolve) => child.on("exit", (code) => {
    if (secrets.some((s) => out.includes(s) || err.includes(s))) {
      failed = true;
      console.error(`galatea ${args[0]} printed a secret`);
    }
    resolve({ code, out, err });
    wake();
  }));
  const said = (re, ms = 30_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`galatea ${args.join(" ")} did not say ${re} in ${ms} ms: ${out}${err}`)), ms);
    const check = () => {
      const m = re.exec(out);
      if (!m) return;
      clearTimeout(timer);
      waiters.splice(waiters.indexOf(check), 1);
      resolve(m);
    };
    waiters.push(check);
    check();
  });
  cleanup.push(() => child.kill("SIGKILL"));
  return { child, said, ended, out: () => out, err: () => err };
}

/** The words of a line the tool printed to run again: plain words and single-quoted ones (none here holds a quote). */
function words(line) {
  return [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
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
  // The servers' time starts at the machine's own, as on the box, where the tool and both servers read one
  // clock: `asks` and `status` window the steward's history by the tool's clock (backlog, plan A's M4), and
  // the harness's default epoch (2030) puts every ask outside it.
  const time = await TimeServer.start({ startMs: Date.now() });
  cleanup.push(() => time.close());
  const clock = await TestClock.connect(time.source);
  cleanup.push(() => clock.close());

  // The simulated bridge claims Provision, so the applier takes a join window for its transport.
  const bridge = new SimBridge({ brokerUrl: broker.url, root, bridgeId: "sim-bridge", clock, runId, devices: fixtureDevices(["channel", "lamp", "tv"]),
    levels: ["Serve", "Provision"] });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  const install = makeInstall();
  cleanup.push(() => rmSync(install.dir, { recursive: true, force: true }));
  const applierOwner = install.put("applier-owner");
  const stewardOwner = install.put("steward-owner");
  const stewardAtApplier = install.put("steward-at-applier");
  const tokenKey = install.put("steward-token-key");
  install.put("brain_agent");
  const tls = makeCa(install.dir);

  const applierDb = await freshDatabase(admin);
  cleanup.push(() => applierDb.drop());
  const applierPort = await freePort();
  const applierDir = packageDir("@ludentes/galatea-life-applier");
  const applier = await SubjectProcess.start(applierDir, JSON.parse(readFileSync(join(applierDir, "subject.json"), "utf8")), {
    GALATEA_DATABASE_URL: applierDb.url, GALATEA_BROKER: brokerUrl(broker.url, "applier-owner-e2e"), GALATEA_ROOT: root,
    GALATEA_OWNER_CREDENTIAL: applierOwner, GALATEA_MCP_PORT: String(applierPort), GALATEA_TIME_SOURCE: time.source, GALATEA_TEST_RUN_ID: runId,
    GALATEA_APPLIER_TLS_CERT: tls.applier.cert, GALATEA_APPLIER_TLS_KEY: tls.applier.key,
  });
  cleanup.push(() => applier.stop());
  const stewardPort = await freePort();
  const urls = { GALATEA_APPLIER_URL: `https://127.0.0.1:${applierPort}/mcp`, GALATEA_STEWARD_URL: `https://127.0.0.1:${stewardPort}/mcp` };
  const g = (...args) => galatea(install.dir, urls, ...args);

  const CHANNEL = "sim-bridge:channel";
  const NEW = "sim-bridge:newlamp";
  const reg = await g("register", "bridge", "sim-bridge");
  step(1, "galatea register bridge, over TLS from the installation's CA", reg.code === 0, shown(reg));

  // The steward is registered at the applier by the installation's galatea-register-steward, not by
  // the tool: here the test does it, as the owner's configure of client steward over its own link.
  const ownerLink = await Link.connect({ what: "applier", url: new URL(urls.GALATEA_APPLIER_URL), bearer: applierOwner, ca: readFileSync(tls.ca, "utf8") });
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
      GALATEA_STEWARD_TLS_CERT: tls.steward.cert, GALATEA_STEWARD_TLS_KEY: tls.steward.key, GALATEA_APPLIER_CA: tls.ca,
    });
  cleanup.push(() => steward.stop());

  const seen = await until("galatea devices to list the simulated channel, unadopted", async () => {
    const r = await g("devices", "--json");
    if (r.code !== 0) return undefined;
    const d = JSON.parse(r.out).devices.find((x) => x.id === CHANNEL);
    return d && d.adopted === false ? r : undefined;
  });
  step(3, "galatea devices lists the bridge's devices, unadopted", true, `${JSON.parse(seen.out).devices.map((d) => d.id).join(", ")}`);

  // The same installation without its CA: the system's store does not know it, and the tool refuses.
  const bare = mkdtempSync(join(tmpdir(), "galatea-owner-e2e-noca-"));
  cleanup.push(() => rmSync(bare, { recursive: true, force: true }));
  mkdirSync(join(bare, "secrets", "mcp"), { recursive: true, mode: 0o700 });
  chmodSync(join(bare, "secrets"), 0o700);
  for (const name of ["applier-owner", "steward-owner"]) copyFileSync(join(install.dir, "secrets", "mcp", name), join(bare, "secrets", "mcp", name));
  const untrusted = await galatea(bare, urls, "devices");
  step(4, "without tls/ca.pem the servers' certificates are not trusted: refused, 2", untrusted.code === 2 && /no CA at .*tls\/ca\.pem/.test(untrusted.err),
    shown(untrusted));

  // Pairing: the window opened by `galatea join`, a device joined through the simulated bridge's `join` control.
  const joining = galateaLive(install.dir, urls, "join", "--for", "60");
  await joining.said(/join window open on (\S+) \(bridge sim-bridge\) for 60 s/);
  await bridge.control({ requestId: randomUUID(), op: "join", device: "newlamp", capabilities: ["onoff"], feedback: "closed" });
  await joining.said(new RegExp(`joined: ${NEW}`));
  // It joins with no proposed class, so the line names CLASS, and the test passes --class.
  await joining.said(new RegExp(`described: ${NEW}  no class proposed  capabilities: onoff\\n  galatea adopt ${NEW} --class CLASS`));
  const closed = await g("close");
  const joinEnd = await joining.ended;
  step(5, "galatea join: the window opened, the device joined and described with its adopt line; galatea close ends it",
    closed.code === 0 && joinEnd.code === 0 && new RegExp(`window closed on \\S+ after 60 s; 1 joined:\\n  ${NEW}  described`).test(joinEnd.out),
    `${shown(closed)}; join ${shown(joinEnd)}`);

  // Adopted with a name and a room before the home has a notice channel: the applier takes the adoption,
  // the steward (0.10) refuses every define until a channel is set: exit 1, and the line to run again.
  const early = await g("adopt", NEW, "--class", "light", "--name", "Лампа у окна", "--room", "kitchen");
  const rerun = /run again: (galatea adopt .*)$/m.exec(early.err)?.[1];
  step(6, "galatea adopt with a name and a room, refused by the steward after the applier's change: 1, and the line to run again",
    early.code === 1 && /adopted sim-bridge:newlamp as light/.test(early.out) && /notice_channels/.test(early.err) && rerun !== undefined, shown(early));

  const adopted = await g("adopt", CHANNEL, "--class", "channel");
  step(7, "galatea adopt of the notify device, without a name", adopted.code === 0, shown(adopted));

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
  step(8, "galatea define of the home with the channel as its notice channel", dry.code === 0 && defined.code === 0 && /revision \d+/.test(defined.out),
    `${shown(dry)}; ${shown(defined)}`);

  const again = await g(...words(rerun).slice(1));
  step(9, "the printed adopt line run again: the adoption changes nothing, the device is named in a new room",
    again.code === 0 && /it was adopted already/.test(again.out) && new RegExp(`named ${NEW} «Лампа у окна» in kitchen \\(a new room\\)`).test(again.out), shown(again));

  const cred = await g("credential", "brain_agent", "--kind", "brain", "--confirm-on", "owner-app");
  step(10, "galatea credential of a brain, its secret from its file", cred.code === 0, shown(cred));

  await until("the channel to come alive", async () => {
    await bridge.publishStatus();
    const r = await g("devices", "--json");
    return r.code === 0 && JSON.parse(r.out).devices.find((d) => d.id === CHANNEL)?.liveness === "live";
  }, 15_000, 500);
  await bridge.publishStatus();
  const status = await g("status");
  step(11, "galatea status: both servers reached, the transport up, no ask open",
    status.code === 0 && /applier .*reached/.test(status.out) && /steward .*reached/.test(status.out) && /transport \S+ \(\w+\): up, state up, bridge sim-bridge/.test(status.out)
      && /open asks on owner-app: 0/.test(status.out), shown(status));

  const devices = await g("devices");
  step(12, "galatea devices: the channel adopted and live, the paired device named in its room, the lamp unadopted",
    devices.code === 0 && new RegExp(`${CHANNEL}  bridge sim-bridge  adopted, class channel  live`).test(devices.out)
      && new RegExp(`${NEW}  bridge sim-bridge  adopted, class light  .*«Лампа у окна» in kitchen`).test(devices.out)
      && /sim-bridge:lamp  bridge sim-bridge  not adopted/.test(devices.out), shown(devices));

  // Ctrl-C on a join: the tool closes its window, so a new window opens at once (none is left open: no failed(busy)).
  const interrupted = galateaLive(install.dir, urls, "join", "--for", "60");
  await interrupted.said(/join window open on /);
  interrupted.child.kill("SIGINT");
  const intEnd = await interrupted.ended;
  const reopened = await g("join", "--for", "5", "--no-wait");
  const reclosed = await g("close");
  step(13, "Ctrl-C on galatea join closes its window first, then ends 0",
    intEnd.code === 0 && /interrupted: closed the join window on /.test(intEnd.out) && reopened.code === 0 && reclosed.code === 0,
    `join ${shown(intEnd)}; ${shown(reopened)}; ${shown(reclosed)}`);

  // The applier's events from before the remove: the bridge's `left` for the device follows it.
  const { body: before } = await ownerLink.call("events", {});
  const removed = await g("remove", NEW);
  let cursor = before.cursor;
  const left = await until("the bridge's left for the removed device", async () => {
    const r = await ownerLink.call("events", { cursor, wait_s: 1 });
    if (r.kind !== "ok") return undefined;
    cursor = r.body.cursor;
    return r.body.events.find((e) => e.type === "provision" && e.what === "left" && e.device === NEW);
  });
  const blockSent = bridge.requests.find((r) => r.op === "remove")?.body?.blockRejoin;
  step(14, "galatea remove of the paired device, its rejoin not blocked", removed.code === 0 && /removing sim-bridge:newlamp|removed sim-bridge:newlamp/.test(removed.out)
    && left !== undefined && blockSent === false, `${shown(removed)}; blockRejoin ${blockSent}`);

  // Confirmations (plan C): the simulated lamp adopted with its turn_on raised to confirm.
  const LAMP = "sim-bridge:lamp";
  const stewardLink = await Link.connect({ what: "steward", url: new URL(urls.GALATEA_STEWARD_URL), bearer: stewardOwner, ca: readFileSync(tls.ca, "utf8") });
  cleanup.push(() => stewardLink.close());
  const lampOn = async () => {
    const r = await stewardLink.call("state", { targets: [LAMP] });
    return r.kind === "ok" ? r.body.targets?.[LAMP]?.values?.find((v) => v.key === "on")?.value : undefined;
  };
  /** Whether the steward's state shows the lamp `on` as `want` within a few seconds (its report may trail the outcome a little). */
  const lampIs = async (want) => (await until(`the lamp on=${want}`, async () => (await lampOn()) === want, 5_000).catch(() => false)) === true;
  const lampAdopted = await g("adopt", LAMP, "--class", "light", "--tier", "onoff.turn_on=confirm");
  await until("the lamp to be live at the steward", async () => {
    await bridge.publishStatus();
    const r = await g("devices", "--json");
    return r.code === 0 && JSON.parse(r.out).devices.find((d) => d.id === LAMP)?.liveness === "live";
  }, 15_000, 500);
  step(15, "galatea adopt of the lamp with onoff.turn_on raised to confirm", lampAdopted.code === 0 && /onoff\.turn_on at confirm/.test(lampAdopted.out),
    shown(lampAdopted));

  // The steward's events followed from before the first do, ended with Ctrl-C.
  const following = galateaLive(install.dir, urls, "events", "--follow");
  await until("galatea events --follow to take its cursor", async () => /following from cursor \d+/.test(following.err()), 15_000, 100);
  const yes = await g("do", LAMP, "onoff.turn_on", "--yes");
  step(16, "galatea do of the confirm action with --yes: every step printed first, the ask answered, applied, acked, the lamp on",
    yes.code === 0 && new RegExp(`s1  ${LAMP}  onoff\\.turn_on  \\{\\}  tier confirm  ask \\(confirm_tier\\)`).test(yes.out)
      && /answered yes: s1/.test(yes.out) && new RegExp(`s1  ${LAMP}  acked`).test(yes.out) && await lampIs(true), shown(yes));
  await following.said(new RegExp(`#\\d+  outcome  .*target=${LAMP} .*outcome=acked`));
  following.child.kill("SIGINT");
  const followEnd = await following.ended;
  step(17, "galatea events --follow showed the outcome as it came; Ctrl-C ended it 0 with its cursor",
    followEnd.code === 0 && /interrupted; cursor \d+: galatea events --cursor \d+ reads on/.test(followEnd.out), `exit ${followEnd.code}`);

  const off = await g("do", LAMP, "onoff.turn_off");
  const open = await g("do", LAMP, "onoff.turn_on");
  const answerLine = /^  (galatea answer \S+ s1 yes)$/m.exec(open.out)?.[1];
  const planId = answerLine?.split(" ")[2];
  const listed = await g("asks");
  step(18, "galatea do without --yes leaves the plan open with its answer line; galatea asks lists it",
    off.code === 0 && open.code === 0 && answerLine !== undefined && await lampIs(false)
      && new RegExp(`plan ${planId}  asked on owner-app at .* waiting: s1`).test(listed.out) && listed.out.includes(answerLine), `${shown(open)}; ${shown(listed)}`);

  const answered = await g(...words(answerLine).slice(1));
  const emptied = await g("asks");
  step(19, "galatea answer ... yes applies the tool's own plan: acked, the lamp on; galatea asks then lists none",
    answered.code === 0 && /applied: apply /.test(answered.out) && new RegExp(`s1  ${LAMP}  acked`).test(answered.out) && await lampIs(true)
      && /no ask waits on owner-app/.test(emptied.out), `${shown(answered)}; ${shown(emptied)}`);

  const off2 = await g("do", LAMP, "onoff.turn_off");
  const open2 = await g("do", LAMP, "onoff.turn_on");
  const line2 = /^  (galatea answer \S+ s1) yes$/m.exec(open2.out)?.[1];
  const sentBefore = bridge.commands.length;
  const declined = await g(...words(line2).slice(1), "no");
  const afterNo = await g("asks");
  step(20, "galatea answer ... no: the plan applied with its step declined, skipped (not_confirmed); no command sent, the lamp still off, no ask left",
    off2.code === 0 && declined.code === 0 && /declined: s1/.test(declined.out) && new RegExp(`s1  ${LAMP}  skipped \\(not_confirmed\\)`).test(declined.out) && bridge.commands.length === sentBefore && await lampIs(false)
      && /no ask waits on owner-app/.test(afterNo.out), `${shown(declined)}; commands ${sentBefore} -> ${bridge.commands.length}`);

  // A toggle on an open-loop IR TV: the steward asks toggle_only, a question --yes must not answer (review I1).
  const TV = "sim-bridge:tv";
  const tvAdopted = await g("adopt", TV, "--class", "tv");
  const tvSentBefore = bridge.commands.length;
  const toggle = await g("do", TV, "onoff.turn_on", "--yes");
  const tvLine = /^  (galatea answer \S+ s1) yes$/m.exec(toggle.out)?.[1];
  const tvAsks = await g("asks");
  const tvNo = tvLine ? await g(...words(tvLine).slice(1), "no") : { code: -1, out: "", err: "no answer line" };
  step(21, "galatea do --yes on a toggling TV: ask (toggle_only) printed, not answered, left open with its line; nothing sent; a no then closes it",
    tvAdopted.code === 0 && toggle.code === 0 && /ask \(toggle_only\)/.test(toggle.out) && /not answered: s1 \(toggle_only\)/.test(toggle.out)
      && tvLine !== undefined && tvAsks.out.includes(`${tvLine} yes`) && tvNo.code === 0 && bridge.commands.length === tvSentBefore,
    `${shown(toggle)}; ${shown(tvNo)}; commands ${tvSentBefore} -> ${bridge.commands.length}`);

  const lampHistory = await g("history", LAMP, "--from", "10m");
  const allHistory = await g("history", "--from", "10m", "--json");
  const kinds = allHistory.code === 0 ? allHistory.out.trim().split("\n").map((l) => JSON.parse(l)) : [];
  step(22, "galatea history shows the lamp's outcomes, and the asks and answers behind them",
    lampHistory.code === 0 && new RegExp(`outcome  .*target=${LAMP} .*outcome=acked`).test(lampHistory.out)
      && kinds.some((e) => e.type === "ask" && e.endpoint === "owner-app") && kinds.some((e) => e.type === "answer" && e.answers?.s1 === "no"),
    `${lampHistory.out.trim().split("\n").length} lines for the lamp; ${kinds.length} events in all`);
  const finalStatus = await g("status");
  step(23, "galatea status: no ask open", finalStatus.code === 0 && /open asks on owner-app: 0/.test(finalStatus.out), shown(finalStatus));

  const refusedHttp = await g("define", home, "--steward", "http://192.0.2.1:18444/mcp");
  const refused = await g("adopt", "sim-bridge:nothing", "--class", "light");
  step(24, "refusals end 2: plain http off loopback, a device the applier does not describe", refusedHttp.code === 2 && refused.code === 2,
    `${shown(refusedHttp)}; ${shown(refused)}`);
  step(25, "no secret printed by any command", !failed);
  console.log("The owner tool's plans A, B and C end to end, over TLS: registered, paired, adopted and named, defined, interrupted, removed; "
    + "confirmed with --yes and by answer, declined, followed and read back.");
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  while (cleanup.length) await Promise.resolve(cleanup.pop()()).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
