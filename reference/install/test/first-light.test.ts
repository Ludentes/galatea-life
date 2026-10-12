import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PKG, run, Stack } from "./stack.js";

const REPO = join(PKG, "..", "..");
const AGENT_BRAIN = join(REPO, "reference", "agent-brain");
const SIM_FILE = join(PKG, "test", "sim", "compose.sim.yaml");
/** The brain's account: a uid of its own, neither the owner's nor root, and in no docker group. */
const BRAIN_UID = 4242;
const ROOT = "galatea";
const CHANNEL = "sim:channel";
const LAMP = "sim:lamp";
const REACHED = "the applier reached at MCP revision 2026-07-28";

type Reply = { ok: boolean; body?: any; error?: string };

/**
 * First light, simulated (the install-core design, plan C1, and its runbook): from an empty
 * directory, the installed stack (the real images, mqtts and MCP over TLS from the installation's
 * CA) with the harness's simulated bridge as broker identity `bridge_sim` and bridge id `sim`, in the
 * test-only compose.sim.yaml. The owner's tool is played by MCP calls on the owner's two credentials
 * from the host's loopback; the brain by the agent-brain's own launcher and .mcp.json, under an account
 * of its own that holds only its credential and ca.pem. The simulated bridge's notify device is the
 * first define's notice channel (steward 0.10, GA-NOTE-1), standing in for the flat's PC bridge.
 */
describe("first light, simulated", () => {
  let s: Stack;
  let brainHome: string;
  let fakes: string;
  const simSecrets = () => join(s.dir, "sim-secrets");
  const mcpSecret = (n: string) => readFileSync(join(s.mcpSecrets, n), "utf8");
  const applier = (tool: string, args: Record<string, unknown> = {}) =>
    s.mcp(`https://127.0.0.1:${s.applierPort}/mcp`, mcpSecret("applier-owner"), tool, args, { host: true });
  const owner = (tool: string, args: Record<string, unknown> = {}) =>
    s.mcp(`https://127.0.0.1:${s.stewardPort}/mcp`, mcpSecret("steward-owner"), tool, args, { host: true });
  const ok = (r: Reply, what: string) => {
    if (!r.ok) throw new Error(`${what} returned ${r.error}: ${JSON.stringify(r.body ?? {})}`);
    return r.body;
  };
  /**
   * One call as the brain: the agent-brain's launcher, run as the brain's account with only the brain's
   * own config directory and the agent-brain's files mounted, on the host's network, starting the
   * test's stand-in agent (brain-call.mjs) where it would start `claude`. Nothing on its command line
   * or standard input is a credential.
   */
  const brain = async (tool: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const r = await run("docker", [
      "run", "--rm", "-i", "--network", "host", "--user", `${BRAIN_UID}:${BRAIN_UID}`,
      "-e", "HOME=/srv/galatea-brain", "-e", `GALATEA_STEWARD_URL=https://127.0.0.1:${s.stewardPort}/mcp`,
      "-v", `${join(brainHome, ".config", "galatea")}:/srv/galatea-brain/.config/galatea:ro`,
      "-v", `${AGENT_BRAIN}:/agent-brain:ro`,
      "-v", `${join(PKG, "test", "brain-call.mjs")}:/app/brain-call.mjs:ro`,
      "--entrypoint", "/agent-brain/bin/galatea-agent-brain", "galatea-steward:local", "node", "/app/brain-call.mjs",
    ], process.env, JSON.stringify({ tool, args }));
    try {
      return JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    } catch {
      return { ok: false, error: `the brain exited ${r.code}: ${r.stderr}` };
    }
  };
  async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const configure = async (changes: unknown[]) => {
    for (let attempt = 1; ; attempt++) {
      const { revision } = ok(await applier("describe"), "the applier's describe");
      const r = await applier("configure", { changes, expected_revision: revision, dry_run: false });
      if (r.ok) return r.body;
      if (r.error !== "stale_revision" || attempt === 5) throw new Error(`configure returned ${r.error}: ${JSON.stringify(r.body)}`);
    }
  };
  const define = async (changes: unknown[]) => {
    for (let attempt = 1; ; attempt++) {
      const { revision } = ok(await owner("describe"), "the steward's describe");
      const r = await owner("define", { endpoint: "owner-app", changes, expected_revision: revision, dry_run: false });
      if (r.ok) return r.body;
      if (r.error !== "stale_revision" || attempt === 5) throw new Error(`define returned ${r.error}: ${JSON.stringify(r.body)}`);
    }
  };
  const up = (kind: string, value: unknown) => ({ op: "upsert", kind, value });
  /** The lamp's `on` as the steward reports it, or undefined. */
  const lampOn = async () => {
    const st = ok(await owner("state", { targets: [LAMP] }), "the owner's state");
    return (st.targets?.[LAMP]?.values ?? []).find((v: { key: string }) => v.key === "on")?.value as boolean | undefined;
  };
  /** How many times the broker has logged sim_control connecting: a subscriber is up once it grows. */
  const controlConnects = async () => (await s.logs("broker")).split("u'sim_control'").length - 1;
  /**
   * What the simulated lamp's radio received next: the test transport's `received` (GA-BRIDGE-16),
   * read as sim_control, the test's own identity, so the state changed in the simulation and not only
   * in a report. Resolves once a subscriber is up; `got` resolves with the message.
   */
  const nextReceived = async (): Promise<{ got: Promise<{ device: string; action: string }> }> => {
    const before = await controlConnects();
    const got = s.mqtt("mosquitto_sub", "sim_control", readFileSync(join(simSecrets(), "sim_control"), "utf8"),
      ["-t", `${ROOT}/test/bridge_sim/control/received`, "-C", "1", "-W", "60"]).then((r) => {
      if (r.code !== 0) throw new Error(`no command reached the simulated bridge: ${r.stderr}`);
      return JSON.parse(r.stdout.trim());
    });
    await until("the test's subscriber on the test transport", async () => (await controlConnects()) > before);
    await new Promise((r) => setTimeout(r, 500));
    return { got };
  };

  /**
   * A message on the test transport's control topic (conformance/README.md, *The test transport*), sent
   * as sim_control, the test's own identity: never under a service's name, since the broker's ClientID
   * is the user name and a second client would take the service's session over.
   */
  const control = (msg: Record<string, unknown>) => s.must(s.mqtt("mosquitto_pub", "sim_control",
    readFileSync(join(simSecrets(), "sim_control"), "utf8"),
    ["-t", `${ROOT}/test/bridge_sim/control`, "-q", "1", "-m", JSON.stringify({ requestId: randomUUID(), ...msg })]), "control");

  beforeAll(() => {
    // Through this package's own node_modules: the workspace's packages here, the registry's in a tree
    // that takes them from npm.
    for (const p of ["galatea-life-sim", "galatea-life-test-clock"]) {
      const d = join(PKG, "node_modules", "@ludentes", p, "dist", "index.js");
      if (!existsSync(d)) throw new Error(`@ludentes/${p} is not built: run pnpm -r build first`);
    }
    s = Stack.bare({
      GALATEA_ROOT: ROOT,
      GALATEA_REPO: REPO,
      GALATEA_SIM_SECRETS: "",
      GALATEA_SIM_RUN_ID: `c1-${randomBytes(4).toString("hex")}`,
    }, [SIM_FILE]);
    // The sim's own secret, outside secrets/ and outside the installation's files: the test's alone.
    writeFileSync(s.envFile, readFileSync(s.envFile, "utf8").replace("GALATEA_SIM_SECRETS=\n", `GALATEA_SIM_SECRETS=${simSecrets()}\n`));
    mkdirSync(simSecrets(), { mode: 0o700 });
    writeFileSync(join(simSecrets(), "sim_control"), randomBytes(24).toString("base64url"), { mode: 0o600 });
    // galatea-secret --for, with `getent` and `sudo` standing in for the system's, as floor.test.ts does.
    fakes = join(s.dir, "fakes");
    brainHome = join(s.dir, "home", "galatea-brain");
    mkdirSync(fakes);
    mkdirSync(brainHome, { recursive: true });
    writeFileSync(join(fakes, "getent"), `#!/bin/sh
case "$1 $2" in
  "passwd galatea-brain") echo "galatea-brain:x:${BRAIN_UID}:${BRAIN_UID}::${brainHome}:/bin/sh" ;;
  "group docker") echo "docker:x:999:" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(fakes, "sudo"), `#!/bin/sh\nexec docker run --rm --network none -v ${s.dir}:${s.dir} alpine:3 "$@"\n`, { mode: 0o755 });
  });
  afterAll(async () => {
    if (!s) return;
    // Files the brain's account owns: removed by root, in a container.
    await run("docker", ["run", "--rm", "-v", `${s.dir}:${s.dir}`, "alpine:3", "rm", "-rf", join(s.dir, "home")], process.env);
    await s.destroy();
  });

  it("starts from an empty directory: prepare makes the secrets and the certificates, and the stack comes up healthy", async () => {
    expect(readdirSync(s.dir).sort()).toEqual([".env", "fakes", "home", "sim-secrets"]);
    s.setInstances(["applier", "steward", "bridge_sim"]);
    await s.must(s.bin("galatea-prepare"), "galatea-prepare");
    for (const f of ["db/postgres", "db/applier", "db/steward", "broker/applier", "broker/bridge_sim", "mcp/applier-owner",
      "mcp/steward-owner", "mcp/steward-at-applier", "mcp/steward-token-key", "tls/applier.key", "tls/steward.key", "tls/broker.key"]) {
      expect(existsSync(join(s.secretsRoot, f)), f).toBe(true);
    }
    expect(existsSync(join(s.secretsRoot, "broker", "steward")), "the steward has no broker identity").toBe(false);
    for (const f of ["ca.pem", "applier.pem", "steward.pem", "broker.pem"]) expect(existsSync(join(s.tls, f)), f).toBe(true);
    await s.must(s.compose("up", "-d", "--wait", "applier", "steward", "broker"), "up");
    await s.must(s.compose("up", "-d", "sim-bridge"), "up sim-bridge");
    const rows = (await s.must(s.compose("ps", "-a", "--format", "json"))).stdout.trim().split("\n").map((l) => JSON.parse(l));
    const by = (n: string) => rows.find((x: { Service: string }) => x.Service === n);
    for (const n of ["postgres", "broker", "applier", "steward"]) expect(by(n), n).toMatchObject({ State: "running", Health: "healthy" });
    for (const n of ["db-init", "applier-migrate", "steward-migrate"]) expect(by(n), n).toMatchObject({ State: "exited", ExitCode: 0 });
    await until("the simulated bridge ready", async () => (await s.logs("sim-bridge")).includes("ready"));
    expect(await s.logs("broker")).toContain("broker-sim: the test transport's grants added");
  });

  it("registers the steward with galatea-register-steward: it follows the applier over TLS", async () => {
    await s.must(s.bin("galatea-register-steward"), "galatea-register-steward");
    await until("the steward's link", async () => (await s.logs("steward")).includes(REACHED), 10_000);
  });

  it("registers the simulated bridge at the applier, which describes its devices live; the owner adopts both", async () => {
    await configure([up("bridge", { id: "sim", identity: "bridge_sim" })]);
    const described = await until("the applier to describe the bridge's devices", async () => {
      const d = ok(await applier("describe"), "describe");
      const ids = (d.devices ?? []).map((x: { id: string }) => x.id);
      return ids.includes(CHANNEL) && ids.includes(LAMP) ? d : undefined;
    });
    // The bridge publishes its test run id (GA-BRIDGE-16), and this applier, which has none, takes it.
    expect(described.test_run_id).toBeUndefined();
    await configure([up("adopt", { device: CHANNEL, class: "channel" }), up("adopt", { device: LAMP, class: "light" })]);
    const devices = ok(await applier("describe"), "describe").devices as { id: string; adopted: boolean; actions?: { action: string; tier: string }[] }[];
    expect(devices.filter((d) => [CHANNEL, LAMP].includes(d.id)).map((d) => [d.id, d.adopted])).toEqual(
      expect.arrayContaining([[CHANNEL, true], [LAMP, true]]));
    expect(devices.find((d) => d.id === LAMP)!.actions!.find((a) => a.action === "onoff.turn_on")!.tier).toBe("reversible");
    // A device is live from its first check-in the applier hears; the simulated bridge's come every 30 s,
    // so the test's radio checks both in now, as the steward's first-light walk has its bridge report.
    const live = async () => {
      const st = ok(await applier("state", { targets: [CHANNEL, LAMP] }), "the applier's state");
      return [CHANNEL, LAMP].every((id) => st.targets?.[id]?.liveness === "live");
    };
    await until("both devices live", async () => {
      if (await live()) return true;
      for (const device of ["channel", "lamp"]) await control({ op: "checkIn", device, at: new Date().toISOString() });
      return live();
    }, 60_000);
  });

  it("defines the home with the simulated notify device as its notice channel, then the room, the brain's credential and its chat endpoint", async () => {
    await until("the steward to follow the adopted devices", async () =>
      ((ok(await owner("describe"), "describe").targets ?? []) as { id: string }[]).some((t) => t.id === CHANNEL));
    // Steward 0.11: a change set is accepted while notice_channels is still unset (GA-DEF-8), so a room
    // alone is taken, and the answer says no notify channel is set yet (GA-NOTE-1).
    const early = await owner("define", { endpoint: "owner-app", changes: [up("room", { id: "lounge", name: "Гостиная" })],
      expected_revision: ok(await owner("describe"), "describe").revision, dry_run: false });
    expect(ok(early, "a room alone, before any notice channel").no_notify_channel).toBe(true);
    await define([up("home", { timezone: "Europe/Moscow", notice_channels: [CHANNEL] })]);
    // The brain's credential, made on the box and installed into the brain's account.
    const secret = (...args: string[]) => run(join(PKG, "bin", "galatea-secret"), args, { ...s.env, PATH: `${fakes}:${process.env.PATH}` });
    chmodSync(s.dir, 0o755);
    chmodSync(join(s.dir, "home"), 0o755);
    await s.must(run("docker", ["run", "--rm", "-v", `${s.dir}:${s.dir}`, "alpine:3", "chown", `${BRAIN_UID}:${BRAIN_UID}`, brainHome], process.env));
    await s.must(secret("brain_agent", "--for", "galatea-brain"), "galatea-secret --for");
    await define([
      up("room", { id: "lounge", name: "Гостиная" }),
      up("target", { id: LAMP, room: "lounge" }),
      up("credential", { id: "brain_agent", kind: "brain", secret: mcpSecret("brain_agent"), confirm_on: "owner-app" }),
      up("endpoint", { id: "owner-chat", name: "Чат владельца", type: "app", room: null, person: "owner", served_by: "brain_agent", confirm_on: "owner-app" }),
    ]);
    const house = ok(await owner("describe"), "describe");
    expect((house.endpoints ?? []).map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(["owner-app", "owner-chat"]));
  });

  it("holds in the brain's account only its own credential and ca.pem", async () => {
    const r = await s.must(run("docker", ["run", "--rm", "--network", "none", "--user", `${BRAIN_UID}:${BRAIN_UID}`,
      "-v", `${s.dir}:${s.dir}:ro`, "alpine:3", "sh", "-c",
      `ls -A ${brainHome}/.config/galatea; cat ${s.mcpSecrets}/steward-owner >/dev/null 2>&1 && echo READ-OWNER || echo no-owner`], process.env));
    expect(r.stdout.trim().split("\n")).toEqual(["brain_agent", "ca.pem", "no-owner"]);
  });

  it("switches the lamp on through a model's endpoint: the brain plans and applies, and the simulated lamp is on", async () => {
    const plan = ok(await brain("plan", { endpoint: "owner-chat", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }), "the brain's plan");
    expect(plan.steps.map((x: { verdict: string }) => x.verdict)).toEqual(["op"]);
    const radio = await nextReceived();
    const applied = ok(await brain("apply", { plan_id: plan.plan_id, idempotency_key: randomUUID() }), "the brain's apply");
    expect(applied.outcomes[0].outcome).toBe("dispatched");
    expect(await radio.got).toMatchObject({ device: "lamp", action: "onoff.turn_on" });
    await until("the outcome acked", async () =>
      ok(await brain("outcome", { apply_id: applied.apply_id }), "outcome").outcomes[0]?.outcome === "acked");
    await until("the lamp on in the steward's state", async () => (await lampOn()) === true);
  });

  it("asks a confirm-tier action on the owner's app, refuses the model's own answer not_permitted, and applies on the owner's yes", async () => {
    const before = ok(await owner("describe"), "describe").revision as number;
    await configure([up("tier", { device: LAMP, action: "onoff.turn_on", tier: "confirm" }),
      up("tier", { device: LAMP, action: "onoff.turn_off", tier: "confirm" })]);
    // The steward's revision moves when it takes the applier's change (as the steward's first-light walk waits).
    await until("the steward to follow the raised tiers", async () => ok(await owner("describe"), "describe").revision > before);
    const { cursor } = ok(await owner("events"), "the owner's events");
    const plan = ok(await brain("plan", { endpoint: "owner-chat", actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] }), "the brain's plan");
    expect(plan.steps.map((x: { verdict: string; reason?: string }) => `${x.verdict}(${x.reason ?? ""})`)).toEqual(["ask(confirm_tier)"]);
    const step = plan.steps[0].step_id as string;

    const ask = await until("the ask on the owner's app", async () =>
      ((ok(await owner("events", { cursor }), "events").events ?? []) as { type: string; plan_id?: string; endpoint?: string }[])
        .find((e) => e.type === "ask" && e.plan_id === plan.plan_id));
    expect(ask.endpoint).toBe("owner-app");

    // A bare answer, with no utterance record, fails the record's check at a brain-served endpoint
    // (GA-CONF-2) before confirm_on is reached: invalid_request, not the refusal first light is after.
    const bare = await brain("answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { [step]: "yes" } });
    expect(bare.ok).toBe(false);
    expect(bare.error).toBe("invalid_request");
    // The model answers: a well-formed record, typed at its own endpoint, after the ask (GA-CONF-2 passes), so
    // what refuses it is confirm_on (GA-CONF-1).
    const said = await brain("answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { [step]: "yes" },
      utterance: { utterance_id: randomUUID(), endpoint: "owner-chat", time: new Date().toISOString(), transcript: "да", addressed_by: "typed" } });
    expect(said.ok).toBe(false);
    expect(said.error).toBe("not_permitted");

    const yes = ok(await owner("answer", { plan_id: plan.plan_id, endpoint: "owner-app", answers: { [step]: "yes" } }), "the owner's yes");
    expect(yes.steps[0].answer).toBe("yes");
    const radio = await nextReceived();
    const applied = ok(await brain("apply", { plan_id: plan.plan_id, idempotency_key: randomUUID() }), "the brain's apply");
    // The applier dispatches a confirm step only with a token that stands (GA-TOKEN-2).
    expect(applied.outcomes[0].outcome).toBe("dispatched");
    expect(await radio.got).toMatchObject({ device: "lamp", action: "onoff.turn_off" });
    await until("the outcome acked", async () =>
      ok(await brain("outcome", { apply_id: applied.apply_id }), "outcome").outcomes[0]?.outcome === "acked");
    await until("the lamp off in the steward's state", async () => (await lampOn()) === false);
  });

  it("has the launcher refuse root, and an account without the brain's two files", async () => {
    const launch = (user: string, config: string) => run("docker", ["run", "--rm", "--network", "none", "--user", user, "-e", "HOME=/srv/galatea-brain",
      "-v", `${config}:/srv/galatea-brain/.config/galatea:ro`, "-v", `${AGENT_BRAIN}:/agent-brain:ro`,
      "--entrypoint", "/agent-brain/bin/galatea-agent-brain", "galatea-steward:local", "true"], process.env);
    const asRoot = await launch("0:0", join(brainHome, ".config", "galatea"));
    expect(asRoot.code).not.toBe(0);
    expect(asRoot.stderr).toContain("not as root");
    const empty = join(s.dir, "empty-config");
    mkdirSync(empty);
    const bare = await launch(`${BRAIN_UID}:${BRAIN_UID}`, empty);
    expect(bare.code).not.toBe(0);
    expect(bare.stderr).toContain("no credential /srv/galatea-brain/.config/galatea/brain_agent");
    expect((await launch(`${BRAIN_UID}:${BRAIN_UID}`, join(brainHome, ".config", "galatea"))).code).toBe(0);
  });
});
