import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";
import { beforeEach, describe, expect, it } from "vitest";
import type { HelperMessage, PowerEvent, ServerSpec } from "../src/port.js";
import { SCRIPTED_DEFAULT_PATH, SCRIPTED_IDENTITY, ScriptedOs, type Received } from "../src/scripted-os.js";
import { spawnServer } from "../src/spawn-server.js";
import { FakeWire, settle } from "./fakes.js";

const TOPIC = "t/test/pc/control";
/** Where the scripted OS says plugins go; made only by the test that makes it. */
const PLUGINS = "/var/lib/galatea-test/plugins";

describe("ScriptedOs", () => {
  let wire: FakeWire;
  let os: ScriptedOs;
  let received: Received[];
  let stalls: number[];
  let events: PowerEvent[];
  let changes: number;

  beforeEach(async () => {
    wire = new FakeWire();
    received = [];
    stalls = [];
    events = [];
    changes = 0;
    os = new ScriptedOs({
      device: "computer",
      onReceived: async (r) => { received.push(r); },
      onStall: (ms) => stalls.push(ms),
      pluginsDir: PLUGINS,
    });
    os.onChange(() => { changes += 1; });
    os.onPower(async (e) => { events.push(e); });
    await os.serve(wire, TOPIC);
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;

  it("subscribes to the control topic on its own connection", () => {
    expect(wire.calls).toEqual([`subscribe ${TOPIC}`]);
  });

  it("starts as a healthy host with the machine's identifier", async () => {
    expect(os.observerPresent()).toBe(true);
    await expect(os.observe([])).resolves.toBeDefined();
    expect((await os.identity()).machineId).toMatch(/^[0-9a-f]{32}$/);
    expect(await os.identity()).toEqual(SCRIPTED_IDENTITY);
  });

  it("answers an op it cannot play unsupported, and a malformed one not", async () => {
    await send({ op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    expect(reply()).toMatchObject({ requestId: "r1", ok: false, unsupported: true });
    await send({ op: "transportState", state: "unknown" });
    expect(reply()).toMatchObject({ ok: false, unsupported: true });
    await send({ op: "power", event: "nap" });
    expect(reply().ok).toBe(false);
    expect(reply().unsupported).toBeUndefined();
  });

  it("answers each of the Zigbee doer's ops unsupported", async () => {
    const at = "2030-01-01T08:00:00.000Z";
    for (const msg of [
      { op: "describe", device: "lamp", entry: {} }, { op: "setting", device: "lamp", key: "x.y.mode", value: "click", observedAt: at },
      { op: "occur", device: "lamp", key: "x.y.alarm", value: true, frameId: "f1", observedAt: at },
      { op: "undescribed", device: "lamp", names: ["dp108"] }, { op: "admit", device: "lamp", how: "association" },
      { op: "leave", device: "lamp" }, { op: "windowState", open: true }, { op: "protocolResult", device: "lamp", result: "confirmed" },
      { op: "hostLink", open: true, answers: false },
      { op: "stateMismatch", disagrees: true }, { op: "reporting", device: "lamp", configuredMs: [60000], modelMs: null },
      { op: "foreignBinding", device: "remote", target: "lamp" }, { op: "classFrom", device: "lamp", proposedClass: "light", from: "modelDb" },
      { op: "nativeControl", way: "touchlink", canDisable: false }, { op: "lockPin", device: "door", requiresPin: true },
    ]) {
      await send(msg);
      expect(reply(), msg.op).toMatchObject({ requestId: "r1", ok: false, unsupported: true });
    }
  });

  it("loses and regains the observer on transportState, telling the bridge each time", async () => {
    await send({ op: "transportState", state: "down" });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(os.observerPresent()).toBe(false);
    await expect(os.observe([])).rejects.toThrow(/observer/);
    await send({ op: "transportState", state: "up" });
    expect(os.observerPresent()).toBe(true);
    expect(changes).toBe(2);
  });

  it("passes a stall to the bridge", async () => {
    await send({ op: "stall", ms: 3000 });
    expect(stalls).toEqual([3000]);
  });

  it("suspends, announced or not, and resumes with the time asleep, replying after the bridge", async () => {
    await send({ op: "power", event: "suspend" });
    expect(reply().ok).toBe(true);
    await expect(os.observe([])).rejects.toThrow(/asleep/);
    await send({ op: "power", event: "resume", suspendedMs: 3_600_000 });
    await send({ op: "power", event: "suspend", announced: false });
    await send({ op: "power", event: "resume" });
    expect(events).toEqual([
      { kind: "suspend", announced: true },
      { kind: "resume", asleepMs: 3_600_000 },
      { kind: "suspend", announced: false },
      { kind: "resume", asleepMs: 0 },
    ]);
  });

  it("refuses to resume a host that is not asleep, and anything after a shutdown", async () => {
    await send({ op: "power", event: "resume" });
    expect(reply()).toMatchObject({ ok: false, error: "the host is on, not asleep" });
    await send({ op: "power", event: "shutdown" });
    expect(reply().ok).toBe(true);
    await send({ op: "power", event: "suspend" });
    expect(reply()).toMatchObject({ ok: false, error: "the host is off" });
    expect(events).toEqual([{ kind: "shutdown", announced: true }]);
  });

  it("reports a sleep on received, then announces the suspend", async () => {
    await os.sleep();
    expect(received).toEqual([{ device: "computer", action: "os.sleep", args: {} }]);
    expect(events).toEqual([]);
    await settle();
    expect(events).toEqual([{ kind: "suspend", announced: true }]);
  });

  it("shuts down at once without a delay, and schedules one with it that cancel withdraws", async () => {
    await os.shutdown(120);
    await settle();
    expect(events).toEqual([]);
    expect(await os.cancelShutdown()).toBe(true);
    expect(await os.cancelShutdown()).toBe(false);
    await os.shutdown();
    await settle();
    expect(events).toEqual([{ kind: "shutdown", announced: true }]);
    expect(received.map((r) => [r.action, r.args])).toEqual([
      ["os.shutdown", { delayS: 120 }], ["os.cancel", {}], ["os.cancel", {}], ["os.shutdown", {}],
    ]);
  });

  it("steps its clock unless the harness says it cannot, reporting each ask", async () => {
    expect(await os.stepClock()).toBe(true);
    await send({ op: "clock", steppable: false });
    expect(await os.stepClock()).toBe(false);
    expect(received.map((r) => r.action)).toEqual(["os.step_clock", "os.step_clock"]);
  });

  it("answers a control message that is not an object with an error, and still serves the next", async () => {
    await wire.deliver(TOPIC, null);
    const refused = reply();
    expect(refused).toMatchObject({ requestId: "", ok: false });
    expect(validate("harness/test-control-reply.json", refused)).toEqual([]);
    await send({ op: "stall", ms: 5 });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(stalls).toEqual([5]);
  });

  it("ignores a retained control message", async () => {
    await wire.deliver(TOPIC, { requestId: "old", op: "stall", ms: 1 }, { retained: true });
    expect(stalls).toEqual([]);
    expect(wire.all(`${TOPIC}/reply`)).toEqual([]);
  });

  it("starts with no account, no session, root the only administrator, and every personal key", async () => {
    expect(await os.observe([])).toEqual({ accounts: { listed: [], deleted: [] }, sessions: [] });
    expect(await os.admins()).toEqual({ groups: [], sudo: [], polkit: { users: [], groups: [], unresolved: [], unrecognised: false } });
    expect(os.personalKeys()).toEqual(["app", "camera_in_use", "microphone_in_use"]);
  });

  it("proposes infrastructure for a broker on loopback", async () => {
    expect(await os.isOwnAddress("127.0.0.1")).toBe(true);
  });
});

describe("ScriptedOs: the computer's people", () => {
  let wire: FakeWire;
  let os: ScriptedOs;
  let received: Received[];
  let changes: number;
  let adminChanges: number;
  let helper: HelperMessage[];

  beforeEach(async () => {
    wire = new FakeWire();
    received = [];
    changes = 0;
    adminChanges = 0;
    helper = [];
    os = new ScriptedOs({ device: "computer", onReceived: async (r) => { received.push(r); }, onStall: () => {}, pluginsDir: PLUGINS });
    os.onChange(() => { changes += 1; });
    os.onAdminsChange(() => { adminChanges += 1; });
    os.onHelper((m) => helper.push(m));
    await os.serve(wire, TOPIC);
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;
  /** The accounts as the bridge would ask for them, knowing liza, backup and root. */
  const listed = async () => (await os.observe([0, 998, 1000])).accounts;

  it("lists interactive accounts, follows a rename, and reports only an authoritative deletion", async () => {
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    await send({ op: "account", osId: 998, name: "backup", interactive: false, state: "present" });
    expect(await listed()).toEqual({ listed: [{ osId: 1000, name: "liza", primaryGid: 1000, home: "/home/liza", path: [...SCRIPTED_DEFAULT_PATH] }],
      deleted: [] });
    await send({ op: "account", osId: 1000, name: "elizaveta", state: "renamed" });
    expect((await listed()).listed[0]).toMatchObject({ name: "elizaveta", home: "/home/elizaveta" });
    await send({ op: "account", osId: 1000, state: "absent" });
    expect(await listed()).toEqual({ listed: [], deleted: [] });
    await send({ op: "account", osId: 1000, state: "present" });
    expect((await listed()).listed).toHaveLength(1);
    await send({ op: "account", osId: 1000, state: "lookupFails" });
    expect(await listed()).toEqual({ listed: [], deleted: [] });
    await send({ op: "account", osId: 1000, state: "deleted" });
    expect(await listed()).toEqual({ listed: [], deleted: [1000] });
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    expect((await listed()).deleted).toEqual([]);
    expect(changes).toBe(8);
  });

  it("answers a deletion from what it lists now, for the osIds asked, remembering none", async () => {
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    // An account it has no entry for is gone, whether or not it saw the deletion; root never is.
    expect((await os.observe([0, 1000, 1001])).accounts.deleted).toEqual([1001]);
    await send({ op: "account", osId: 1000, state: "deleted" });
    expect((await os.observe([])).accounts.deleted).toEqual([]);
    expect((await os.observe([1000])).accounts.deleted).toEqual([1000]);
  });

  it("refuses a new account with no name, and a rename of an account it does not know", async () => {
    await send({ op: "account", osId: 1000, state: "present" });
    expect(reply()).toMatchObject({ ok: false, error: "account 1000 is new, and has no name" });
    await send({ op: "account", osId: 1000, name: "x", state: "renamed" });
    expect(reply()).toMatchObject({ ok: false, error: "no account 1000 to rename" });
  });

  it("opens, changes and closes sessions, one of them active at the console", async () => {
    await send({ op: "session", id: "2", osId: 1000, seat0Active: true, state: "active", startedAt: "2026-09-29T08:00:00.000Z" });
    await send({ op: "session", id: "5", osId: 1000, graphical: false, state: "active", idleHint: true });
    await send({ op: "session", id: "7", osId: 1001, seat0Active: true, state: "active" });
    await send({ op: "session", id: "2", state: "locked" });
    const sessions = (await os.observe([])).sessions;
    expect(sessions.find((s) => s.id === "2")).toEqual({ id: "2", osId: 1000, graphical: true, remote: false, seat0Active: false,
      state: "locked", idleHint: false, startedAt: Date.parse("2026-09-29T08:00:00.000Z") });
    expect(sessions.find((s) => s.id === "5")).toMatchObject({ graphical: false, idleHint: true });
    expect(sessions.find((s) => s.id === "7")!.seat0Active).toBe(true);
    await send({ op: "session", id: "5", state: "closed" });
    expect((await os.observe([])).sessions.map((s) => s.id)).toEqual(["2", "7"]);
    await send({ op: "session", id: "9", state: "active" });
    expect(reply()).toMatchObject({ ok: false, error: "session 9 is new, and names no account" });
    expect(changes).toBe(5);
  });

  it("reports the helpers the bridge starts and stops, and plays their connections as the OS identifies them", async () => {
    await send({ op: "session", id: "2", osId: 1000, seat0Active: true, state: "active" });
    await send({ op: "helper", session: "2", action: "start" });
    expect(reply()).toMatchObject({ ok: false, error: "the bridge started no helper in session 2" });
    const pid = await os.startHelper("2");
    await send({ op: "helper", session: "2", action: "start" });
    await send({ op: "helper", session: "2", action: "report", values: { activity: "idle", camera_in_use: true } });
    await send({ op: "helper", session: "2", action: "forge", claims: "7", values: { activity: "active" } });
    const from = { conn: 1, pid, osId: 1000, session: "2" };
    expect(helper).toEqual([
      { kind: "connected", from },
      { kind: "report", from, session: "2", values: { activity: "idle", camera_in_use: true } },
      { kind: "report", from, session: "7", values: { activity: "active" } },
    ]);
    await send({ op: "helper", session: "2", action: "stop" });
    expect(helper.at(-1)).toEqual({ kind: "gone", from });
    await os.stopHelper(pid);
    expect(received).toEqual([{ device: "computer", action: "os.helper_start", args: { session: "2" } }]);
    const again = await os.startHelper("2");
    await os.stopHelper(again);
    expect(received.at(-1)).toEqual({ device: "computer", action: "os.helper_stop", args: { session: "2" } });
  });

  it("plays another process of the session as a connection of its own, with a pid the bridge never started", async () => {
    await send({ op: "session", id: "2", osId: 1000, state: "active" });
    const pid = await os.startHelper("2");
    await send({ op: "helper", session: "2", action: "report", from: "pluginServer", values: { activity: "active" } });
    expect(helper).toHaveLength(2);
    const [connected, report] = helper as [Extract<HelperMessage, { kind: "connected" }>, Extract<HelperMessage, { kind: "report" }>];
    expect(connected.kind).toBe("connected");
    expect(connected.from.pid).not.toBe(pid);
    expect(connected.from).toMatchObject({ osId: 1000, session: "2" });
    expect(report).toEqual({ kind: "report", from: connected.from, session: "2", values: { activity: "active" } });
    await send({ op: "helper", session: "2", action: "stop", from: "sessionProcess" });
    expect(reply().ok).toBe(false);
  });

  it("shows a notification through a helper's connection on the notification hook, and refuses a closed one", async () => {
    await send({ op: "session", id: "2", osId: 1000, state: "active" });
    await os.startHelper("2");
    await send({ op: "helper", session: "2", action: "start" });
    const conn = (helper[0] as Extract<HelperMessage, { kind: "connected" }>).from.conn;
    await os.notify(conn, "От: Galatea\nУжин готов", "info");
    expect(received.at(-1)).toEqual({ device: "computer", action: "os.notify",
      args: { session: "2", text: "От: Galatea\nУжин готов", urgency: "info" } });
    expect(validate("harness/test-received.json", received.at(-1))).toEqual([]);
    await os.closeHelper(conn);
    await expect(os.notify(conn, "x", "info")).rejects.toThrow(/no helper connection/);
  });

  it("reports a connection the bridge closed gone, as the bus does", async () => {
    await send({ op: "session", id: "2", osId: 1000, state: "active" });
    await send({ op: "helper", session: "2", action: "report", from: "sessionProcess", values: {} });
    const from = (helper[0] as Extract<HelperMessage, { kind: "connected" }>).from;
    await os.closeHelper(from.conn);
    await settle();
    expect(helper.at(-1)).toEqual({ kind: "gone", from });
  });

  it("plays a helper's connection while the bridge's start of it has not yet resolved", async () => {
    // The harness plays `helper start` as soon as it reads os.helper_start, before the start returns.
    const early = new ScriptedOs({ device: "computer", onStall: () => {}, pluginsDir: PLUGINS, onReceived: async (r) => {
      if (r.action === "os.helper_start") await early.control({ requestId: "h", op: "helper", session: "2", action: "start" });
    } });
    const seen: HelperMessage[] = [];
    early.onHelper((m) => seen.push(m));
    await early.control({ requestId: "s", op: "session", id: "2", osId: 1000, state: "active" });
    const pid = await early.startHelper("2");
    expect(seen).toEqual([{ kind: "connected", from: { conn: 1, pid, osId: 1000, session: "2" } }]);
  });

  it("locks a session at once by default, and as lockBehaviour says for the next lock only", async () => {
    await send({ op: "session", id: "2", osId: 1000, state: "active" });
    await send({ op: "session", id: "3", osId: 1000, state: "active" });
    await send({ op: "lockBehaviour", session: "3", result: "ignores" });
    const before = changes;
    await os.lock(["2", "3"]);
    expect(received.at(-1)).toEqual({ device: "computer", action: "os.lock", args: { sessions: ["2", "3"] } });
    await new Promise((r) => setTimeout(r, 5));
    const states = async () => Object.fromEntries((await os.observe([])).sessions.map((s) => [s.id, s.state]));
    expect(await states()).toEqual({ 2: "locked", 3: "active" });
    expect(changes).toBe(before + 1);
    await os.lock(["3"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await states()).toEqual({ 2: "locked", 3: "locked" });
  });

  it("locks after the delay lockBehaviour gives", async () => {
    await send({ op: "session", id: "2", osId: 1000, state: "active" });
    await send({ op: "lockBehaviour", session: "2", result: "locks", afterMs: 50 });
    await os.lock(["2"]);
    await new Promise((r) => setTimeout(r, 10));
    expect((await os.observe([])).sessions[0]!.state).toBe("active");
    await new Promise((r) => setTimeout(r, 60));
    expect((await os.observe([])).sessions[0]!.state).toBe("locked");
  });

  it("gives the administrator facts by name, primary groups among the members, and tells the bridge unless unreported", async () => {
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    await send({ op: "account", osId: 1001, name: "ivan", primaryGid: 999, state: "present" });
    await send({ op: "admins", groups: [{ name: "sudo", gid: 27, members: [1000] }, { name: "docker", gid: 999, members: [] }],
      sudo: [{ osId: 0, root: "yes" }], polkit: { identities: ["unix-group:sudo"], unrecognised: true } });
    expect(await os.admins()).toEqual({
      groups: [{ name: "sudo", gid: 27, members: [{ osId: 1000, name: "liza" }] }, { name: "docker", gid: 999, members: [{ osId: 1001, name: "ivan" }] }],
      sudo: [{ osId: 0, name: "root", root: "yes" }],
      polkit: { users: [], groups: [{ name: "sudo", gid: 27 }], unresolved: [], unrecognised: true },
    });
    expect(adminChanges).toBe(1);
    await send({ op: "admins", reported: false });
    expect(adminChanges).toBe(1);
    expect((await os.admins()).groups).toEqual([]);
    await send({ op: "admins", sudo: [{ osId: 1234, root: "yes" }] });
    expect(reply()).toMatchObject({ ok: false, error: "no account 1234" });
  });

  it("drops from the facts an administrator whose account was deleted since, instead of refusing to read them", async () => {
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    await send({ op: "account", osId: 1001, name: "ivan", state: "present" });
    await send({ op: "admins", groups: [{ name: "sudo", gid: 27, members: [1000, 1001] }], sudo: [{ osId: 1000, root: "yes" }] });
    await send({ op: "account", osId: 1000, state: "deleted" });
    const facts = await os.admins();
    expect(facts.groups).toEqual([{ name: "sudo", gid: 27, members: [{ osId: 1001, name: "ivan" }] }]);
    expect(facts.sudo).toEqual([]);
  });

  it("resolves polkit's identities to accounts and groups, as the OS does, and names those it cannot", async () => {
    await send({ op: "account", osId: 1000, name: "liza", state: "present" });
    await send({ op: "admins", groups: [{ name: "wheel", gid: 10, members: [] }],
      polkit: { identities: ["unix-user:liza", "unix-user:root", "unix-group:wheel", "unix-user:ghost", "unix-group:ghosts", "unix-netgroup:ops"],
        unrecognised: false } });
    expect((await os.admins()).polkit).toEqual({
      users: [{ osId: 1000, name: "liza" }, { osId: 0, name: "root" }], groups: [{ name: "wheel", gid: 10 }],
      unresolved: ["unix-user:ghost", "unix-group:ghosts", "unix-netgroup:ops"], unrecognised: false,
    });
  });
});

describe("ScriptedOs: files and plugins", () => {
  let wire: FakeWire;
  let os: ScriptedOs;

  beforeEach(async () => {
    wire = new FakeWire();
    os = new ScriptedOs({ device: "computer", onReceived: async () => {}, onStall: () => {}, pluginsDir: PLUGINS });
    await os.serve(wire, TOPIC);
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;

  it("gives each account the PATH the harness names, a Debian user's when it names none, kept across a rename", async () => {
    await send({ op: "account", osId: 1000, name: "liza", path: ["/srv/liza/bin", "/usr/bin"], state: "present" });
    await send({ op: "account", osId: 1001, name: "ivan", state: "present" });
    await send({ op: "account", osId: 1000, name: "elizaveta", state: "renamed" });
    const listed = (await os.observe([])).accounts.listed;
    expect(listed.map((a) => [a.name, a.path])).toEqual([["elizaveta", ["/srv/liza/bin", "/usr/bin"]], ["ivan", ["/usr/local/bin", "/usr/bin", "/bin"]]]);
  });

  it("answers the write check and PATH resolution from the file op: root writes anything, a path not told of is not there", async () => {
    await send({ op: "file", path: "/usr/bin/python3", executable: true });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    await send({ op: "file", path: "/srv/liza/bin", writableBy: [1000] });
    await send({ op: "file", path: "/usr/local/bin/python3", exists: false, writableBy: [1001] });
    expect(await os.exists("/usr/bin/python3")).toEqual({ exists: true, executable: true });
    expect(await os.exists("/srv/liza/bin")).toEqual({ exists: true, executable: false });
    expect(await os.exists("/usr/local/bin/python3")).toEqual({ exists: false, executable: false });
    expect(await os.exists("/opt/nothing")).toEqual({ exists: false, executable: false });
    expect(await os.canWrite(1000, "/srv/liza/bin")).toBe(true);
    expect(await os.canWrite(1000, "/srv/liza/bin/")).toBe(true);
    expect(await os.canWrite(1001, "/srv/liza/bin")).toBe(false);
    expect(await os.canWrite(1001, "/usr/local/bin/python3")).toBe(true);
    expect(await os.canWrite(1000, "/usr/bin/python3")).toBe(false);
    expect(await os.canWrite(0, "/usr/bin/python3")).toBe(true);
  });

  it("lets no account but root write under the plugins directory, whatever the file op says", async () => {
    await send({ op: "file", path: `${PLUGINS}/org.example.kodi`, writableBy: [1000] });
    expect(await os.canWrite(1000, `${PLUGINS}/org.example.kodi`)).toBe(false);
    expect(await os.canWrite(1000, PLUGINS)).toBe(false);
    expect(await os.canWrite(0, PLUGINS)).toBe(true);
    expect(os.pluginsDir()).toBe(PLUGINS);
  });

  it("refuses a file op for a relative path", async () => {
    await send({ op: "file", path: "bin/python3" });
    expect(reply().ok).toBe(false);
  });

  it("makes the plugins directory as a plain directory, mode 0755", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scripted-os-"));
    try {
      await os.makeRootOnlyDir(join(dir, "plugins"));
      expect(statSync(join(dir, "plugins")).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ScriptedOs: plugin servers", () => {
  let wire: FakeWire;
  let os: ScriptedOs;
  let received: Received[];
  let dir: string;

  beforeEach(async () => {
    wire = new FakeWire();
    received = [];
    dir = mkdtempSync(join(tmpdir(), "scripted-os-server-"));
    os = new ScriptedOs({ device: "computer", onReceived: async (r) => { received.push(r); }, onStall: () => {}, pluginsDir: PLUGINS });
    await os.serve(wire, TOPIC);
    return () => rmSync(dir, { recursive: true, force: true });
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  /** A server that prints how it was started, then echoes each line of its input until its input ends. */
  const ECHO = "process.stdout.write(JSON.stringify({ env: process.env, argv: process.argv.slice(1), cwd: process.cwd() }) + '\\n');"
    + "process.stdin.on('data', (d) => process.stdout.write(d));";
  const spec = (over: Partial<ServerSpec> = {}): ServerSpec => ({
    plugin: "org.example.kodi", version: "1.0.0", osId: 1000, session: "2",
    argv: [process.execPath, "-e", ECHO, "extra"], env: { HOME: "/home/liza", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, cwd: dir, noNewPrivs: true,
    ...over,
  });

  it("reports what the bridge asked on received, then runs it as a real process with that environment alone", async () => {
    const server = await os.startServer(spec());
    try {
      expect(received).toEqual([{ device: "computer", action: "os.server_start", args: {
        plugin: "org.example.kodi", version: "1.0.0", account: 1000, session: "2", noNewPrivs: true,
        env: { HOME: "/home/liza", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, argv: [process.execPath, "-e", ECHO, "extra"],
      } }]);
      expect(validate("harness/test-received.json", received[0])).toEqual([]);
      const started = JSON.parse(await line(server.stdout));
      // Node adds nothing to what it was given but its own knobs; nothing of the harness's own environment reaches the server.
      expect(Object.keys(started.env).filter((k) => !k.startsWith("NODE_")).sort()).toEqual(["HOME", "LANG", "PATH"]);
      expect(started.argv).toEqual(["extra"]);
      expect(started.cwd).toBe(dir);
      server.stdin.write("ping\n");
      expect(await line(server.stdout)).toBe("ping");
    } finally {
      await server.stop();
    }
  });

  it("ends a server on stop, resolving once it has exited, and again at once", async () => {
    const server = await os.startServer(spec());
    await server.stop();
    expect(await server.exited).toMatchObject({ signal: "SIGTERM" });
    await server.stop();
  });

  it("rejects a server whose interpreter is not there, leaving nothing running", async () => {
    await expect(os.startServer(spec({ argv: [join(dir, "no-such-node"), "server.js"] }))).rejects.toThrow(/ENOENT/);
  });

  it("gives no display variables for a session it knows, and refuses a session it does not", async () => {
    await send({ op: "session", id: "2", osId: 1000, graphical: true, state: "active" });
    expect(await os.displayEnv("2")).toEqual({});
    await expect(os.displayEnv("9")).rejects.toThrow(/no session 9/);
  });
});

describe("spawnServer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spawn-server-"));
    return () => rmSync(dir, { recursive: true, force: true });
  });
  const run = (code: string) => spawnServer({ plugin: "p", version: "1", osId: 1000, session: null, argv: [process.execPath, "-e", code],
    env: { PATH: "/usr/bin:/bin" }, cwd: dir, noNewPrivs: true }, 200);

  it("kills a server that ignores the request to stop once the grace has passed, and what it started with it", async () => {
    // It starts a child of its own in its process group, prints that child's pid, and ignores SIGTERM.
    const server = await run("process.on('SIGTERM', () => {});"
      + "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"
      + "process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1000);");
    const grandchild = Number(await line(server.stdout));
    await server.stop();
    expect(await server.exited).toMatchObject({ signal: "SIGKILL" });
    await waitFor(() => !alive(grandchild));
  });

  it("ends what a server that crashed started, when it is stopped after its exit", async () => {
    // It starts a child of its own in its process group, prints its pid, and exits at once.
    const server = await run("const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });"
      + "process.stdout.write(c.pid + '\\n'); process.exit(1);");
    const child = Number(await line(server.stdout));
    expect(await server.exited).toEqual({ code: 1, signal: null });
    expect(alive(child)).toBe(true);
    await server.stop();
    await waitFor(() => !alive(child));
  });

  it("kills a child that ignores the request to stop once the grace has passed, though the server itself exits at once", async () => {
    const server = await run("const c = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });"
      + "process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1000);");
    const child = Number(await line(server.stdout));
    // Let the child set its handler before it is asked.
    await new Promise((r) => setTimeout(r, 300));
    await server.stop();
    expect(await server.exited).toMatchObject({ signal: "SIGTERM" });
    await waitFor(() => !alive(child));
  });

  it("reports a server that exits on its own, its code kept", async () => {
    const server = await run("process.exit(3)");
    expect(await server.exited).toEqual({ code: 3, signal: null });
    await server.stop();
  });

  it("survives a write to a server that has gone", async () => {
    const server = await run("process.exit(0)");
    await server.exited;
    server.stdin.write("anything\n");
    await new Promise((r) => setTimeout(r, 20));
  });
});

/** The next line a stream gives. */
function line(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const on = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      stream.off("data", on);
      stream.unshift(Buffer.from(buf.slice(nl + 1)));
      resolve(buf.slice(0, nl));
    };
    stream.on("data", on);
    stream.once("error", reject);
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits (real time) for a condition a real process brings about. */
async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
}
