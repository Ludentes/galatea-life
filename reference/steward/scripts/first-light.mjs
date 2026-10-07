#!/usr/bin/env node
// First light (the design, *The slices*, slice 2b): the reference applier over the simulated bridge,
// the reference steward over it, and one MCP client playing both a brain and the owner's tool. It
// walks a person's yes from a plan to a lamp: an adopted notify channel; the owner's app and the
// brain's endpoint defined; the lamp's onoff.turn_on raised to confirm by the applier's configure; the
// brain's plan asking; the ask put on the owner's app through confirm_on; the brain's own answer
// refused not_permitted; the owner's yes; a token minted; the applier dispatching, the simulated lamp
// on, and the outcome relayed. Then a rule over the same chain (HS3's night light, slice 3b): «the lamp
// on for 10 s → off», refused by the person's lease, firing again when the lease ends (a five-minute
// hold), the applier dispatching and the simulated lamp off. Then what a rule's outcome does (slice 4):
// «while the lamp is off → turn it on», the simulated lamp rejecting the command, and the steward's
// notice of the failure delivered on the channel. Then a person's scene (slice 5): the lamp on, 30 s, off.
// Then a scheduled scene (slice 6): the lamp on at a time of day two minutes on, its confirm step sent with
// the steward's authored token. Then work through a brain (slice 10): a scene the brain defines at the
// owner's chat window, asked first, marked brain_authored, its confirm step refused. Then a restart (slice 11): an
// outcome the applier gave while the steward was down read back at its start. Run under with-postgres.mjs
// (GALATEA_TEST_PG_URL). Exits 0 when every step holds. Prints no credential, key, token or database URL.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpSeam } from "@ludentes/galatea-life-harness/seams/mcp";
import { freshDatabase } from "@ludentes/galatea-life-harness/database";
import { SubjectProcess } from "@ludentes/galatea-life-harness";
import { brokerUrl, fixtureDevices, freePort, SimBridge, startBroker, TimeServer } from "@ludentes/galatea-life-sim";
import { TestClock } from "@ludentes/galatea-life-test-clock";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(here, "..", "..");

const admin = process.env.GALATEA_TEST_PG_URL;
if (!admin) {
  console.error("GALATEA_TEST_PG_URL is not set: run under galatea-with-postgres");
  process.exit(2);
}

const cleanup = [];
const steps = [];
let failed = false;
/** One step of the walk: its name, and whether it held. */
function step(n, what, ok, detail = "") {
  steps.push(`${ok ? "PASS" : "FAIL"} ${n} ${what}${detail ? `: ${detail}` : ""}`);
  console.log(steps.at(-1));
  if (!ok) throw new Error(`step ${n} failed: ${what}`);
}
async function until(what, fn, ms = 10_000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
const okOf = (r, what) => {
  if (!r.ok) throw new Error(`${what} returned ${r.error}: ${r.message}`);
  return r.body;
};

try {
  const runId = `first-light-${randomUUID().slice(0, 8)}`;
  const root = `demo/${runId}`;
  const broker = await startBroker();
  cleanup.push(() => broker.stop());
  const time = await TimeServer.start();
  cleanup.push(() => time.close());
  const clock = await TestClock.connect(time.source);
  cleanup.push(() => clock.close());

  // The simulated bridge, with a notify channel and a lamp.
  const bridge = new SimBridge({ brokerUrl: broker.url, root, bridgeId: "sim-bridge", clock, runId, devices: fixtureDevices(["channel", "lamp"]) });
  await bridge.start();
  cleanup.push(() => bridge.stop());

  // The reference applier, its own database, schema and role.
  const applierDb = await freshDatabase(admin);
  cleanup.push(() => applierDb.drop());
  const applierOwner = randomUUID();
  const applierPort = await freePort();
  const applierSpec = JSON.parse(readFileSync(join(repo, "reference", "applier", "subject.json"), "utf8"));
  const applier = await SubjectProcess.start(join(repo, "reference", "applier"), applierSpec, {
    GALATEA_DATABASE_URL: applierDb.url, GALATEA_BROKER: brokerUrl(broker.url, "applier-first-light"), GALATEA_ROOT: root,
    GALATEA_OWNER_CREDENTIAL: applierOwner, GALATEA_MCP_PORT: String(applierPort), GALATEA_TIME_SOURCE: time.source, GALATEA_TEST_RUN_ID: runId,
  });
  cleanup.push(() => applier.stop());
  const applierUrl = `http://127.0.0.1:${applierPort}/mcp`;
  const applierOwnerTool = await McpSeam.connect(applierUrl, applierOwner);
  cleanup.push(() => applierOwnerTool.close());
  const configure = async (changes) => {
    for (let attempt = 1; ; attempt++) {
      const { revision } = await applierOwnerTool.callOk("describe");
      const r = await applierOwnerTool.call("configure", { changes, expected_revision: revision, dry_run: false });
      if (r.ok) return r.body;
      if (r.error !== "stale_revision" || attempt === 5) throw new Error(`the applier's configure returned ${r.error}: ${r.message}`);
    }
  };
  const stewardCredential = randomUUID();
  const tokenKey = randomUUID();
  await configure([
    { op: "upsert", kind: "client", value: { id: "steward", credential: stewardCredential, kind: "steward", token_key: tokenKey } },
    { op: "upsert", kind: "bridge", value: { id: "sim-bridge", identity: "sim-bridge" } },
  ]);
  const CHANNEL = "sim-bridge:channel";
  const LAMP = "sim-bridge:lamp";
  await until("the applier to describe the bridge's devices", async () => {
    const ids = ((await applierOwnerTool.callOk("describe")).devices ?? []).map((d) => d.id);
    return ids.includes(CHANNEL) && ids.includes(LAMP);
  });
  await configure([{ op: "upsert", kind: "adopt", value: { device: CHANNEL, class: "channel" } },
    { op: "upsert", kind: "adopt", value: { device: LAMP, class: "light" } }]);
  const stewardAtApplier = await McpSeam.connect(applierUrl, stewardCredential);
  cleanup.push(() => stewardAtApplier.close());
  await until("the bridge's devices to come alive", async () => {
    await bridge.publishStatus();
    const s = await stewardAtApplier.callOk("state", { targets: [CHANNEL, LAMP] });
    return [CHANNEL, LAMP].every((id) => s.targets?.[id] && s.targets[id].liveness !== "dead");
  }, 10_000, 500);
  const adopted = (await applierOwnerTool.callOk("describe")).devices.find((d) => d.id === CHANNEL);
  step(1, "an adopted notify channel", adopted?.adopted === true, `${CHANNEL} adopted ${adopted?.adopted}`);

  // The reference steward, over the applier.
  const stewardDb = await freshDatabase(admin);
  cleanup.push(() => stewardDb.drop());
  const owner = randomUUID();
  const brainSecret = randomUUID();
  const frontSecret = randomUUID();
  const stewardPort = await freePort();
  const stewardSpec = JSON.parse(readFileSync(join(here, "subject.json"), "utf8"));
  const steward = await SubjectProcess.start(here, stewardSpec, {
    GALATEA_DATABASE_URL: stewardDb.url, GALATEA_OWNER_CREDENTIAL: owner, GALATEA_MCP_PORT: String(stewardPort),
    GALATEA_APPLIER_URL: applierUrl, GALATEA_APPLIER_CLIENT: "steward", GALATEA_APPLIER_CREDENTIAL: stewardCredential,
    GALATEA_APPLIER_TOKEN_KEY: tokenKey, GALATEA_TIME_SOURCE: time.source, GALATEA_TEST_RUN_ID: runId,
  });
  cleanup.push(() => steward.stop());
  const stewardUrl = `http://127.0.0.1:${stewardPort}/mcp`;
  // One MCP client, two hats: the owner's tool and the brain.
  const ownerTool = await McpSeam.connect(stewardUrl, owner);
  cleanup.push(() => ownerTool.close());
  await until("the steward to follow the applier", async () => ((await ownerTool.callOk("describe")).targets ?? []).some((t) => t.id === CHANNEL));
  const define = async (changes) => {
    for (let attempt = 1; ; attempt++) {
      const { revision } = await ownerTool.callOk("describe");
      const r = await ownerTool.call("define", { endpoint: "owner-app", changes, expected_revision: revision, dry_run: false });
      if (r.ok) return r.body;
      if (r.error !== "stale_revision" || attempt === 5) throw new Error(`define returned ${r.error}: ${r.message}`);
    }
  };
  const up = (kind, value) => ({ op: "upsert", kind, value });
  const del = (kind, value) => ({ op: "delete", kind, value });
  await define([
    // A five-minute hold, so the night light's rule meets the person's lease and outlives it within the run.
    up("home", { timezone: "Europe/Moscow", notice_channels: [CHANNEL], hold_time_s: 300 }),
    up("room", { id: "kitchen", name: "Кухня" }),
    up("target", { id: LAMP, room: "kitchen" }),
    up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain", confirm_on: "owner-app" }),
    up("voice", { endpoint: "kitchen-voice", listening: "wake_server", wake_words: [{ word: "Галатея", model: "transcript" }],
      zone: "downstairs", output: "speech", follow_up: false, heard_by: "front" }),
    up("credential", { id: "brain", kind: "brain", secret: brainSecret }),
    up("credential", { id: "front", kind: "front", secret: frontSecret }),
  ]);
  const house = await ownerTool.callOk("describe");
  const endpoints = (house.endpoints ?? []).map((e) => e.id);
  step(2, "the owner's app and the brain's endpoint defined", endpoints.includes("owner-app") && endpoints.includes("kitchen-voice"),
    `endpoints ${endpoints.join(", ")}`);

  const before = house.revision;
  await configure([up("tier", { device: LAMP, action: "onoff.turn_on", tier: "confirm" })]);
  const raised = await until("the steward to follow the raised tier", async () => {
    const d = await ownerTool.callOk("describe");
    return d.revision > before ? d : undefined;
  });
  const lampAction = (await applierOwnerTool.callOk("describe")).devices.find((d) => d.id === LAMP).actions.find((a) => a.action === "onoff.turn_on");
  step(3, "the lamp's onoff.turn_on raised to confirm by the applier's configure", lampAction.tier === "confirm",
    `the applier's tier ${lampAction.tier}; the steward at revision ${raised.revision}`);

  const brain = await McpSeam.connect(stewardUrl, brainSecret);
  cleanup.push(() => brain.close());
  const { cursor } = await ownerTool.callOk("events");
  const plan = okOf(await brain.call("plan", { endpoint: "kitchen-voice", speaker: "owner", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }),
    "the brain's plan");
  const verdicts = plan.steps.map((x) => `${x.verdict}(${x.reason ?? ""})`);
  step(4, "the brain's plan asking", verdicts.join() === "ask(confirm_tier)", verdicts.join(", "));

  const asks = ((await ownerTool.callOk("events", { cursor })).events ?? []).filter((e) => e.type === "ask" && e.plan_id === plan.plan_id);
  step(5, "the ask put on the owner's app through confirm_on", asks.length === 1 && asks[0].endpoint === "owner-app",
    `ask events ${JSON.stringify(asks.map((e) => e.endpoint))}`);

  const said = await brain.call("answer", { plan_id: plan.plan_id, endpoint: "kitchen-voice", speaker: "owner", answers: { s1: "yes" },
    // A record as a front gives it at an endpoint with a voice record: the asking say heard in full,
    // ended half a second before (GA-CONF-2's asked_by), so not_permitted is the only answer allowed.
    utterance: { utterance_id: randomUUID(), endpoint: "kitchen-voice", time: new Date(clock.now()).toISOString(), transcript: "да", addressed_by: "wake",
      asked_by: { say_id: randomUUID(), status: "full", ended_at: new Date(clock.now() - 500).toISOString() } } });
  step(6, "the brain's own answer refused not_permitted", !said.ok && said.error === "not_permitted", said.ok ? "accepted" : said.error);

  const yes = await ownerTool.call("answer", { plan_id: plan.plan_id, endpoint: "owner-app", answers: { s1: "yes" } });
  step(7, "the owner's yes", yes.ok && yes.body.steps?.[0]?.answer === "yes", yes.ok ? `step s1 answered ${yes.body.steps?.[0]?.answer}` : yes.error);

  const { cursor: applierCursor } = await stewardAtApplier.callOk("events");
  const applied = okOf(await brain.call("apply", { plan_id: plan.plan_id, idempotency_key: randomUUID() }), "the brain's apply");
  const first = applied.outcomes[0];
  // The applier dispatches a confirm step only with a token that stands (applier GA-TOKEN-2): dispatched is the token's proof.
  step(8, "a token minted", first?.outcome === "dispatched", `the applier's outcome ${first?.outcome}${first?.reason ? `(${first.reason})` : ""}`);

  const on = await until("the simulated lamp to report on", async () => {
    const s = await ownerTool.callOk("state", { targets: [LAMP] });
    const values = s.targets?.[LAMP]?.values ?? [];
    return values.some((v) => v.key === "on" && v.value === true) ? values : undefined;
  });
  const acked = await until("the outcome to be relayed as acked", async () => {
    const o = await brain.callOk("outcome", { apply_id: applied.apply_id });
    return o.outcomes[0]?.outcome === "acked" ? o.outcomes[0] : undefined;
  });
  const relayed = ((await ownerTool.callOk("events", { cursor })).events ?? [])
    .filter((e) => e.type === "outcome" && e.apply_id === applied.apply_id).map((e) => e.outcome);
  const applierSaw = ((await stewardAtApplier.callOk("events", { cursor: applierCursor })).events ?? [])
    .filter((e) => e.type === "state" && e.target === LAMP && e.key === "on").map((e) => e.cause?.for?.apply);
  step(9, "the applier dispatching, the simulated lamp on, and the outcome relayed",
    on.length > 0 && acked.time !== undefined && relayed.includes("dispatched") && relayed.includes("acked") && applierSaw.includes(applied.apply_id),
    `lamp on; outcome ${acked.outcome} at ${acked.time}; relayed ${relayed.join(", ")}; the applier's state event caused by the steward's apply`);

  // HS3's night light: a rule turns the lamp off once it has been on for 10 s; the person's lease refuses it until it ends.
  const { cursor: ruled } = await ownerTool.callOk("events");
  await define([up("rule", { id: "night", name: "Ночник гаснет сам", trigger: { held: { target: LAMP, key: "on", op: "eq", value: true, for_s: 10 } },
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] })]);
  // Past the lease's end in five-second steps, the bridge reporting at each, so the lamp stays live throughout.
  for (let t = 0; t < 310_000; t += 5_000) {
    await bridge.publishStatus();
    await time.advance(5_000, { chunkMs: 5_000 });
  }
  await bridge.publishStatus();
  const off = await until("the rule to turn the lamp off", async () => {
    const s = await ownerTool.callOk("state", { targets: [LAMP] });
    return (s.targets?.[LAMP]?.values ?? []).some((v) => v.key === "on" && v.value === false) || undefined;
  }).catch(async (err) => {
    const seen = (await ownerTool.callOk("events", { cursor: ruled })).events ?? [];
    console.error(JSON.stringify(seen.map((e) => [e.type, e.rule ?? e.target, e.outcome ?? e.change ?? e.value, e.reason, e.time])));
    throw err;
  });
  const after = (await ownerTool.callOk("events", { cursor: ruled })).events ?? [];
  const refused = after.filter((e) => e.type === "refused" && e.rule === "night").map((e) => e.reason);
  const fired = after.filter((e) => e.type === "rule_fired" && e.rule === "night").length;
  const offBy = after.filter((e) => e.type === "state" && e.target === LAMP && e.key === "on" && e.value === false).map((e) => e.cause?.rule);
  const held = off === true && refused.includes("leased") && fired >= 2 && offBy.includes("night");
  // On a failure, what happened, so it can be read rather than guessed.
  const trail = held ? "" : `; events ${JSON.stringify(after.map((e) => [e.type, e.rule ?? e.target, e.outcome ?? e.change ?? e.value, e.reason, e.time]))}`;
  step(10, "a rule refused by the person's lease, firing again when it ends, the applier turning the lamp off", held,
    `refused ${refused.join(", ")}; fired ${fired} times; the lamp off by rule ${offBy.join(", ")}${trail}`);

  // What a rule's outcome does: the lamp rejects the rule's turn_on, failed(rejected), which no retry fixes; a notice on the channel.
  const { cursor: failing } = await ownerTool.callOk("events");
  const notifiesBefore = bridge.received.filter((x) => x.action === "notify.notify").length;
  await bridge.control({ requestId: randomUUID(), op: "commandResult", device: "lamp", result: "rejected" });
  await define([up("rule", { id: "back-on", name: "Свет обратно", conditions: [{ target: LAMP, key: "on", op: "eq", value: false }],
    actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] })]);
  const noticed = await until("the steward's notice of the rule's failure", async () => ((await ownerTool.callOk("events", { cursor: failing })).events ?? [])
    .find((e) => e.type === "notice" && e.change === "raised" && e.cause === "rule_failed" && e.rule === "back-on"));
  const told = await until("the notice delivered on the channel", async () => bridge.received.slice(notifiesBefore)
    .find((x) => x.action === "notify.notify" && String(x.args?.text ?? "").includes("back-on")));
  step(11, "a rule's action the lamp rejects, its failure a notice delivered on the channel",
    noticed.outcome === "failed" && noticed.reason === "rejected" && noticed.target === LAMP && told !== undefined,
    `${noticed.action} on ${noticed.target} ended ${noticed.outcome}(${noticed.reason}); the channel received «${told.args.text}»`);

  // A person's scene (slice 5): «the lamp on, 30 s, the lamp off», planned and answered on the owner's app, run over the same chain.
  await define([del("rule", { id: "night" }), del("rule", { id: "back-on" }),
    up("scenario", { id: "evening", name: "Вечер", mode: "single", steps: [{ target: LAMP, action: "onoff.turn_on", args: {} }, { delay: 30 },
      { target: LAMP, action: "onoff.turn_off", args: {} }] })]);
  const { cursor: scened } = await ownerTool.callOk("events");
  const scenePlan = okOf(await ownerTool.call("scenario_plan", { scenario: "evening", endpoint: "owner-app" }), "the owner's scenario plan");
  okOf(await ownerTool.call("answer", { plan_id: scenePlan.plan_id, endpoint: "owner-app", answers: { s1: "yes" } }), "the owner's yes to the scene");
  const { run_id } = okOf(await ownerTool.call("scenario_run", { plan_id: scenePlan.plan_id, idempotency_key: randomUUID() }), "the owner's run");
  const lampIs = (value) => until(`the simulated lamp to report ${value ? "on" : "off"}`, async () => {
    await bridge.publishStatus();
    const st = await ownerTool.callOk("state", { targets: [LAMP] });
    return (st.targets?.[LAMP]?.values ?? []).some((v) => v.key === "on" && v.value === value) || undefined;
  });
  await lampIs(true);
  for (let t = 0; t < 30_000; t += 5_000) {
    await bridge.publishStatus();
    await time.advance(5_000, { chunkMs: 5_000 });
  }
  await lampIs(false);
  const sceneEnd = await until("the run to end", async () => {
    const st = await ownerTool.callOk("scenario_status", { run_id });
    return st.status === "ended" ? st : undefined;
  });
  const sceneEvents = ((await ownerTool.callOk("events", { cursor: scened })).events ?? []).filter((e) => e.type === "state" && e.target === LAMP && e.key === "on")
    .map((e) => `${e.value} by ${JSON.stringify(e.cause)}`);
  step(12, "a person's scene: the lamp on, a delay, the lamp off, the run ended done",
    sceneEnd.reason === "done" && sceneEnd.failed_steps.length === 0 && sceneEvents.length >= 2,
    `ended(${sceneEnd.reason}), failed ${JSON.stringify(sceneEnd.failed_steps)}; the lamp ${sceneEvents.join(", ")}`);

  // A scheduled scene (slice 6): «the lamp on» at a time of day two minutes on, in the home's Moscow time.
  const at = Math.ceil((time.now() + 120_000) / 60_000) * 60_000;
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Moscow", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  await define([up("scenario", { id: "dusk", name: "Сумерки", mode: "single", steps: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }),
    up("schedule", { id: "dusk", scenario: "dusk", time: hhmm })]);
  const { cursor: timed } = await ownerTool.callOk("events");
  // Time passes in 5 s steps until the run starts, then no more: the lamp's ack comes in its own time.
  const startOf = async () => ((await ownerTool.callOk("events", { cursor: timed })).events ?? [])
    .find((e) => e.type === "scenario" && e.change === "started" && e.cause?.schedule === "dusk");
  let started;
  while (!(started = await startOf()) && time.now() < at + 30_000) {
    await bridge.publishStatus();
    await time.advance(5_000, { chunkMs: 5_000 });
  }
  started ??= await until("the schedule to start its run", startOf);
  await lampIs(true);
  const timedEnd = await until("the scheduled run to end", async () => {
    const st = await ownerTool.callOk("scenario_status", { run_id: started.run_id });
    return st.status === "ended" ? st : undefined;
  });
  step(13, "a scheduled scene: the lamp on at its time of day, its confirm step authored, the run ended done",
    timedEnd.reason === "done" && timedEnd.failed_steps.length === 0 && Date.parse(started.time) >= at,
    `the schedule at ${hhmm} started its run at ${started.time}; ended(${timedEnd.reason}), failed ${JSON.stringify(timedEnd.failed_steps)}`);

  // History (slice 7): the lamp's story kept by the store, read through the reference applier's events, with their causes.
  // `to` a minute past now: the steward's clock may run a little ahead of the time server's (the milestone 7+10+11 review, I1).
  const range = { from: new Date(0).toISOString(), to: new Date(time.now() + 60_000).toISOString() };
  const story = (await ownerTool.callOk("history", { targets: [LAMP], ...range })).events ?? [];
  // A rule's firing names its rule, not the lamp: read from the whole history.
  const whole = (await ownerTool.callOk("history", range)).events ?? [];
  const firings = whole.filter((e) => e.type === "rule_fired" && e.rule === "night").length;
  const kinds = new Set(story.map((e) => e.type));
  const byRule = story.some((e) => e.type === "state" && e.key === "on" && e.cause?.rule === "night");
  const byRun = story.some((e) => e.type === "state" && e.key === "on" && e.cause?.schedule === "dusk");
  const ordered = story.every((e, i) => i === 0 || story[i - 1].seq < e.seq);
  step(14, "history keeps the lamp's story: its lease, a rule refused and fired, its changes with their causes, oldest first",
    ["lease", "refused", "state", "outcome"].every((k) => kinds.has(k)) && firings >= 2 && byRule && byRun && ordered,
    `${story.length} events of the lamp: ${[...kinds].sort().join(", ")}; the rule fired ${firings} times; a change by the rule ${byRule}, by the schedule's run ${byRun}`);

  // Work through a brain (slice 10): the owner's chat window, which the brain serves; the brain's define of
  // a scene is asked (confirm_define), the owner's typed yes relayed, define { plan_id } applies it marked
  // brain_authored, and the owner's own plan of it refuses the lamp's confirm step refuse(tier).
  await define([up("endpoint", { id: "owner-chat", name: "Чат владельца", type: "app", room: null, person: "owner", served_by: "brain" })]);
  const { revision: now } = await ownerTool.callOk("describe");
  const cosy = { op: "upsert", kind: "scenario", value: { id: "cosy", name: "Уют", mode: "single", steps: [{ target: LAMP, action: "onoff.turn_on", args: {} }] } };
  const asked = okOf(await brain.call("define", { endpoint: "owner-chat", changes: [cosy], expected_revision: now, dry_run: false }), "the brain's define");
  okOf(await brain.call("answer", { plan_id: asked.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
    utterance: { utterance_id: randomUUID(), endpoint: "owner-chat", time: new Date(clock.now()).toISOString(), transcript: "да", addressed_by: "typed" } }),
  "the owner's typed yes");
  const defined = okOf(await brain.call("define", { endpoint: "owner-chat", plan_id: asked.plan_id }), "define { plan_id }");
  const marked = (await ownerTool.callOk("describe")).scenarios.find((x) => x.id === "cosy");
  const own = okOf(await ownerTool.call("scenario_plan", { scenario: "cosy", endpoint: "owner-app" }), "the owner's plan of the brain's scene");
  const ownSteps = own.steps.map((x) => `${x.verdict}${x.reason ? `(${x.reason})` : ""}${x.brain_authored ? " brain_authored" : ""}`);
  step(15, "through a brain: a scene asked confirm_define, defined on the owner's yes, marked, its confirm step refuse(tier)",
    asked.steps?.map((x) => `${x.verdict}(${x.reason})`).join() === "ask(confirm_define)" && defined.revision > now && marked?.brain_authored === true
      && ownSteps.join() === "refuse(tier) brain_authored",
    `asked ${JSON.stringify(asked.steps?.map((x) => x.reason))}; at revision ${defined.revision}; brain_authored ${marked?.brain_authored}; the owner's plan ${ownSteps.join(", ")}`);

  // Restarts (slice 11): the owner's notify on the channel, its delivery held 4 s at the bridge, the steward
  // stopped and started again meanwhile. The outcome the applier gave while it was down is read from the
  // applier's history at the start, the key's repeat returns the same apply, the house is as it was, and
  // history keeps what came before the restart.
  const houseBefore = await ownerTool.callOk("describe");
  const stopped = clock.now();
  await bridge.control({ requestId: randomUUID(), op: "commandResult", device: "channel", result: "confirmed", afterMs: 4_000 });
  const noteKey = randomUUID();
  const note = { request: { endpoint: "owner-app", actions: [{ target: CHANNEL, action: "notify.notify", args: { text: "Перезапуск", urgency: "info" } }] },
    idempotency_key: noteKey };
  const noted = okOf(await ownerTool.call("apply", note), "the owner's notify before the restart");
  await steward.restart(() => new Promise((r) => setTimeout(r, 6_000)));
  const ownerAgain = await until("the restarted steward to answer", async () => McpSeam.connect(stewardUrl, owner).catch(() => undefined), 15_000, 200);
  cleanup.push(() => ownerAgain.close());
  const ended = await until("the notify's outcome read back after the restart", async () => {
    const o = await ownerAgain.callOk("outcome", { apply_id: noted.apply_id });
    return o.outcomes[0] && !["dispatched", "unknown"].includes(o.outcomes[0].outcome) ? o.outcomes[0] : undefined;
  }, 15_000);
  const relayedBack = (await ownerAgain.callOk("history", { from: new Date(stopped).toISOString(), to: new Date(clock.now() + 60_000).toISOString() })).events
    .filter((e) => e.type === "outcome" && e.apply_id === noted.apply_id && e.outcome === ended.outcome);
  const again = okOf(await ownerAgain.call("apply", note), "the repeat of the notify's key after the restart");
  const houseAfter = await ownerAgain.callOk("describe");
  // Kept from before the restart: the events of the last life, by seq, not by the clock.
  const lastBefore = Math.max(0, ...whole.map((e) => e.seq));
  const kept = (await ownerAgain.callOk("history", { from: new Date(stopped - 3_600_000).toISOString(), to: new Date(clock.now() + 60_000).toISOString() }))
    .events.filter((e) => e.seq <= lastBefore);
  step(16, "a restart: an outcome the applier gave while the steward was down read back, the key's repeat the same apply, the house and history kept",
    noted.outcomes[0]?.outcome === "dispatched" && relayedBack.some((e) => e.recovered === true) && again.apply_id === noted.apply_id
      && houseAfter.revision === houseBefore.revision && kept.length > 0,
    `the notify ${noted.outcomes[0]?.outcome} before, ${ended.outcome} after (recovered ${relayedBack.map((e) => e.recovered).join(", ")}); the repeat ${again.apply_id === noted.apply_id ? "the same apply" : "another apply"}; revision ${houseBefore.revision} then ${houseAfter.revision}; ${kept.length} events from before the restart`);
  console.log("First light: the steward walked a person's yes to the lamp, a rule turned it off once the person's lease ended, a rule's failure reached the channel, a person's scene ran, a schedule ran a scene at its time, history kept the lamp's story, the brain's scene, asked and defined, was held to its author, and a restart kept what it must.");
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  while (cleanup.length) await Promise.resolve(cleanup.pop()()).catch(() => undefined);
}
process.exit(failed ? 1 : 0);
