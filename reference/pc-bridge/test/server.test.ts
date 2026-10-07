import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OsAccount, OsSession } from "../src/port.js";
import type { Manifest } from "../src/plugins/manifest.js";
import type { InstalledVersion } from "../src/plugins/record.js";
import {
  BACKOFF_CEILING_MS, chosenSession, CRASH_LOOP_STARTS, PluginServer, serverArgv, START_MS, verifyFiles,
} from "../src/plugins/server.js";
import { SuspendClock } from "../src/suspend-clock.js";
import { FakeClock, FakePort, osSession } from "./fakes.js";
import { manifest } from "./manifests.js";
import { type Behaviour, InProcessServers, pins, tool } from "./servers.js";

const TOOLS = [tool("pause"), tool("set_volume"), tool("scan")];
const PLAYER = "kodi://player/state";
const LIBRARY = "kodi://library/state";
const STATE = { [PLAYER]: { playing: false, volume: 40 }, [LIBRARY]: { "org.example.library.scanning": false } };
const LIZA: OsAccount = { osId: 1000, name: "liza", primaryGid: 1000, home: "/home/liza", path: ["/usr/local/bin", "/usr/bin", "/bin"] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plugin-server-"));
});
const servers: PluginServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop("bridge");
  rmSync(dir, { recursive: true, force: true });
});

/** The version's files written to its directory, and its record. */
function installed(over: Record<string, unknown> = {}): InstalledVersion {
  const files = { "manifest.json": "{}", "server.py": "print('kodi')", "lib/kodi.py": "KODI = 1" };
  mkdirSync(join(dir, "lib"), { recursive: true });
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body);
  return {
    sha256: "0".repeat(64), manifest: manifest({ toolHashes: pins(TOOLS), ...over }) as Manifest, account: "liza", interpreter: "/usr/bin/python3",
    files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)])), activated: true, installedAt: "2026-09-28T11:00:00.000Z",
  };
}

/** A server of `org.example.kodi` 1.0.0 on fakes, each start in-process with `behaviour(n)`. */
function setUp(o: { behaviour?: (n: number) => Behaviour; over?: Record<string, unknown>; sessions?: OsSession[]; mismatch?: { detail: string; at: number }; account?: OsAccount | undefined } = {}) {
  const base = new FakeClock();
  const clock = new SuspendClock(base);
  const port = new FakePort();
  const starts = new InProcessServers((n) => ({ tools: TOOLS, state: structuredClone(STATE), ...(o.behaviour?.(n) ?? {}) }));
  port.serverFactory = starts.factory;
  const told = { changed: 0, served: 0, mismatched: [] as string[], eras: [] as string[] };
  const env = { sessions: o.sessions ?? [], account: "account" in o ? o.account : LIZA };
  const v = installed(o.over);
  const srv = new PluginServer({
    port, clock, wall: () => base.now(), plugin: "org.example.kodi", version: "1.0.0", dir, installed: v,
    deviceId: (key) => `org.example.kodi:1.0.0:${key}`,
    account: () => env.account, sessions: () => env.sessions,
    changed: () => { told.changed += 1; }, served: () => { told.served += 1; },
    mismatched: (d) => told.mismatched.push(d), eraFound: (e) => told.eras.push(e),
  }, o.mismatch);
  servers.push(srv);
  return { srv, base, clock, port, starts, told, env, v };
}

/** Waits (real time) for what the in-process server's streams bring about. */
async function until(ok: () => boolean): Promise<void> {
  // A bound, not a wait: the condition ends it, the bound only a test that would hang.
  for (const end = Date.now() + 10_000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2));
  expect(ok()).toBe(true);
}
/** Lets the in-process exchange settle, when nothing should happen. */
const quiet = () => new Promise((r) => setTimeout(r, 30));

describe("chosenSession", () => {
  const s = (id: string, over: Partial<OsSession> = {}) => osSession({ id, seat0Active: false, startedAt: 100, ...over });
  it("takes the account's console session, else its graphical session started first, a tie to the lower id", () => {
    expect(chosenSession([s("7", { startedAt: 50 }), s("9", { seat0Active: true })], 1000)?.id).toBe("9");
    expect(chosenSession([s("7", { startedAt: 50 }), s("3")], 1000)?.id).toBe("7");
    expect(chosenSession([s("10"), s("9")], 1000)?.id).toBe("9");
    expect(chosenSession([s("c2"), s("c10")], 1000)?.id).toBe("c10");
    expect(chosenSession([s("2", { graphical: false }), s("3", { osId: 1001 })], 1000)).toBeUndefined();
  });
});

describe("verifyFiles and serverArgv", () => {
  it("finds a changed file, a missing one and one the package did not have", async () => {
    const v = installed();
    expect(await verifyFiles(dir, v.files)).toBeNull();
    writeFileSync(join(dir, "server.py"), "import os; os.system('x')");
    writeFileSync(join(dir, "extra.py"), "");
    rmSync(join(dir, "lib/kodi.py"));
    expect(await verifyFiles(dir, v.files)).toBe("server.py changed; lib/kodi.py is missing; extra.py is not in the package");
  });

  it("starts the server by the interpreter's path, each file of the package by its own", () => {
    const v = installed({ command: ["python3", "-u", "./server.py", "lib/kodi.py", "--flag"] });
    expect(serverArgv(v.manifest, v, dir)).toEqual(["/usr/bin/python3", "-u", join(dir, "server.py"), join(dir, "lib/kodi.py"), "--flag"]);
    const own = { ...v, interpreter: null, manifest: { ...v.manifest, command: ["bin/serve", "server.py"] } };
    expect(serverArgv(own.manifest, own, dir)).toEqual([join(dir, "bin/serve"), join(dir, "server.py")]);
  });
});

describe("PluginServer", () => {
  it("starts as the account with an environment built from nothing, reads each device at once, and has served", async () => {
    const { srv, port, starts, told } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    expect(port.servers).toEqual([{ plugin: "org.example.kodi", version: "1.0.0", osId: 1000, session: null,
      argv: ["/usr/bin/python3", join(dir, "server.py")], cwd: dir, noNewPrivs: true,
      env: { HOME: "/home/liza", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GALATEA_PLUGIN_DIR: dir } }]);
    expect(starts.last.fixture.log).toEqual(expect.arrayContaining([{ read: PLAYER }, { read: LIBRARY }]));
    await until(() => srv.view("library")?.available === true && "values" in srv.view("library")! && Object.keys((srv.view("library") as { values: object }).values).length > 0);
    expect(srv.view("player")).toMatchObject({ available: true, values: { playing: false, volume: 40 } });
    expect(told.served).toBe(1);
    expect(told.eras).toEqual(["2026-07-28"]);
    expect(srv.faults()).toEqual([]);
  });

  it("publishes nothing about its devices while it starts, and fails a start that has not served within 120 s", async () => {
    const { srv, base, starts } = setUp({ behaviour: (n) => (n === 0 ? { readFails: Infinity } : {}) });
    srv.start();
    await until(() => starts.started.length === 1 && starts.last.fixture.log.length >= 2);
    await base.advance(START_MS - 1);
    await quiet();
    expect(srv.phase).toBe("starting");
    expect(srv.view("player")).toBeUndefined();
    // Read again every 10 s meanwhile (GA-BRIDGE-60).
    expect(starts.started[0]!.fixture.log.filter((l) => "read" in l && l.read === PLAYER).length).toBeGreaterThanOrEqual(12);
    await base.advance(1);
    await until(() => srv.phase === "backoff");
    expect(srv.view("player")).toMatchObject({ available: false });
    await base.advance(1000);
    await until(() => srv.phase === "served");
    expect(starts.started).toHaveLength(2);
  });

  it("serves after reads that failed, tried again every 10 s", async () => {
    const { srv, base, starts } = setUp({ behaviour: () => ({ readFails: 4 }) });
    srv.start();
    await until(() => starts.last?.fixture.log.filter((l) => "read" in l).length === 2);
    // Both devices' first reads failed; at 10 s each is read again, and the second of those serves.
    await base.advance(10_000);
    await until(() => srv.phase === "served");
    expect(starts.started).toHaveLength(1);
  });

  it("backs off between failed starts, 1 s doubling to a 60 s ceiling, crash_loop after 5, cleared once a start serves", { timeout: 20_000 }, async () => {
    const { srv, base, starts, port } = setUp({ behaviour: (n) => (n < 8 ? { exitAtStart: 1 } : {}) });
    const startedAt: number[] = [];
    port.serverFactory = async (spec) => {
      startedAt.push(base.now());
      return starts.factory(spec);
    };
    const t0 = base.now();
    srv.start();
    const waits = [1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * 1000);
    for (const [i, wait] of waits.entries()) {
      await until(() => startedAt.length === i + 1 && srv.phase === "backoff");
      if (i === CRASH_LOOP_STARTS - 2) expect(srv.faults()).toEqual([]);
      if (i === CRASH_LOOP_STARTS - 1) expect(srv.faults().map((f) => f.code)).toEqual(["crash_loop", "crash_loop"]);
      await base.advance(wait - 1);
      await quiet();
      expect(startedAt).toHaveLength(i + 1);
      await base.advance(1);
    }
    await until(() => srv.phase === "served");
    expect(startedAt.map((t) => (t - t0) / 1000)).toEqual([0, 1, 3, 7, 15, 31, 63, 123, 183]);
    expect(waits.at(-1)).toBe(BACKOFF_CEILING_MS);
    expect(srv.faults()).toEqual([]);
  });

  it("names crash_loop per device after 5 failed starts in a row, and a failure after serving does not count", { timeout: 20_000 }, async () => {
    const { srv, base, starts } = setUp({ behaviour: (n) => (n === 0 ? {} : { exitAtStart: 1 }) });
    srv.start();
    await until(() => srv.phase === "served");
    starts.last.fixture.crash(1);
    await until(() => srv.phase === "backoff");
    expect(srv.view("player")).toMatchObject({ available: false });
    // Each wait exactly: a longer step would run the next start too, should the failure land inside it.
    for (const [i, wait] of [1, 2, 4, 8].entries()) {
      await base.advance(wait * 1000);
      await until(() => starts.started.length === i + 2 && srv.phase === "backoff");
    }
    expect(srv.faults()).toEqual([]);
    await base.advance(16_000);
    await until(() => starts.started.length === 6 && srv.phase === "backoff");
    expect(srv.faults().map((f) => [f.code, f.device])).toEqual([
      ["crash_loop", "org.example.kodi:1.0.0:player"], ["crash_loop", "org.example.kodi:1.0.0:library"],
    ]);
  });

  it("fails a served server that answers nothing within 10 s, however long its cadence, and starts it again", { timeout: 20_000 }, async () => {
    // The library alone, read every 60 s: only the probe finds it hung.
    const one = manifest({ toolHashes: pins(TOOLS) }).devices[1]!;
    const { srv, base, starts } = setUp({ over: { devices: [one] } });
    srv.start();
    await until(() => srv.phase === "served");
    starts.last.fixture.hang();
    await base.advance(10_000);
    await quiet();
    expect(srv.phase).toBe("served");
    await base.advance(10_000);
    await until(() => srv.phase === "backoff");
    expect(srv.view("library")).toMatchObject({ available: false });
    await base.advance(1000);
    await until(() => srv.phase === "served" && starts.started.length === 2);
  });

  it("fails a server whose process exits, its devices unavailable at once, and one that floods", { timeout: 20_000 }, async () => {
    const { srv, base, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    starts.last.fixture.flood();
    await until(() => srv.phase === "backoff");
    await base.advance(1000);
    await until(() => srv.phase === "served");
    starts.last.fixture.crash(3);
    await until(() => srv.phase === "backoff");
    expect(srv.view("player")).toMatchObject({ available: false });
  });

  it("reads a device at once on a change it announces", async () => {
    const { srv, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    starts.last.fixture.set(PLAYER, { playing: true, volume: 40 });
    await until(() => (srv.view("player") as { values: Record<string, unknown> }).values.playing === true);
  });

  it("reads each device at its cadence, and a read that failed within 10 s", async () => {
    const { srv, base, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    const reads = () => starts.last.fixture.log.filter((l) => "read" in l && l.read === PLAYER).length;
    const before = reads();
    await base.advance(5000);
    await until(() => reads() === before + 1);
    starts.last.fixture.behave({ readFails: 1 });
    await base.advance(5000);
    await until(() => reads() === before + 2);
    await base.advance(5000);
    await until(() => reads() === before + 3);
  });

  it("names a reading that fails its type as reading_dropped, the rest published", async () => {
    const { srv } = setUp({ behaviour: () => ({ state: { ...structuredClone(STATE), [PLAYER]: { playing: "yes", volume: 12 } } }) });
    srv.start();
    await until(() => srv.phase === "served" && srv.faults().length > 0);
    expect(srv.view("player")).toMatchObject({ available: true, values: { volume: 12 } });
    expect(srv.faults()).toEqual([{ code: "reading_dropped", device: "org.example.kodi:1.0.0:player", detail: "playing: not a boolean" }]);
  });

  it("stops for good on tools that do not verify at its start, naming pin_mismatch per device", async () => {
    const { srv, base, starts, told } = setUp({ behaviour: () => ({ tools: [...TOOLS, tool("shell")] }) });
    srv.start();
    await until(() => srv.phase === "mismatch");
    expect(told.mismatched).toEqual(["its tools do not verify: tool shell is not in the manifest"]);
    expect(srv.faults().map((f) => f.code)).toEqual(["pin_mismatch", "pin_mismatch"]);
    expect(srv.view("player")).toMatchObject({ available: false });
    await base.advance(600_000);
    expect(starts.started).toHaveLength(1);
    expect(await Promise.race([starts.last.exited.then(() => "exited"), quiet().then(() => "running")])).toBe("exited");
  });

  it("stops on a tool changed after start that it announced, and not on one it did not announce", async () => {
    const quietChange = setUp();
    quietChange.srv.start();
    await until(() => quietChange.srv.phase === "served");
    quietChange.starts.last.fixture.setTools([...TOOLS, tool("shell")], false);
    await quiet();
    expect(quietChange.srv.phase).toBe("served");
    quietChange.starts.last.fixture.setTools([...TOOLS, tool("shell")], true);
    await until(() => quietChange.srv.phase === "mismatch");
  });

  it("verifies the files at each start, never starting a server whose files changed", async () => {
    const { srv, port } = setUp();
    writeFileSync(join(dir, "server.py"), "import os");
    srv.start();
    await until(() => srv.phase === "mismatch");
    expect(port.servers).toEqual([]);
    expect(srv.faults()[0]).toMatchObject({ code: "pin_mismatch", detail: "its files do not verify: server.py changed" });
  });

  it("starts none for a version kept mismatched", async () => {
    const { srv, port } = setUp({ mismatch: { detail: "its tools do not verify: tool shell is missing", at: Date.parse("2026-09-28T11:30:00Z") } });
    srv.start();
    await quiet();
    expect(port.servers).toEqual([]);
    expect(srv.faults()[0]).toMatchObject({ code: "pin_mismatch" });
  });

  it("waits for a graphical session for needsSession, starting in the chosen one with its display variables alone", async () => {
    const { srv, port, env } = setUp({ over: { needsSession: true }, sessions: [osSession({ id: "4", graphical: false })] });
    port.display.set("7", { DISPLAY: ":1", XAUTHORITY: "/run/user/1000/gdm/Xauthority", MQTT_PASSWORD: "hunter2" });
    srv.start();
    await until(() => srv.phase === "waiting");
    expect(srv.view("player")).toMatchObject({ available: false });
    expect(port.servers).toEqual([]);
    env.sessions = [osSession({ id: "4", graphical: false }), osSession({ id: "7", seat0Active: false })];
    srv.sessionsChanged();
    await until(() => srv.phase === "served");
    expect(port.servers[0]).toMatchObject({ session: "7" });
    expect(port.servers[0]!.env).toEqual({ HOME: "/home/liza", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GALATEA_PLUGIN_DIR: dir,
      DISPLAY: ":1", XAUTHORITY: "/run/user/1000/gdm/Xauthority" });
  });

  it("keeps running while its session is locked, ends with it, and starts in the next", async () => {
    const { srv, port, env, starts } = setUp({ over: { needsSession: true }, sessions: [osSession({ id: "7" })] });
    srv.start();
    await until(() => srv.phase === "served");
    env.sessions = [osSession({ id: "7", state: "locked" })];
    srv.sessionsChanged();
    await quiet();
    expect(srv.phase).toBe("served");
    env.sessions = [];
    srv.sessionsChanged();
    await until(() => srv.phase === "waiting");
    expect(await Promise.race([starts.last.exited.then(() => "exited"), quiet().then(() => "running")])).toBe("exited");
    expect(srv.view("player")).toMatchObject({ available: false });
    env.sessions = [osSession({ id: "8" })];
    srv.sessionsChanged();
    await until(() => srv.phase === "served");
    expect(port.servers.map((s) => s.session)).toEqual(["7", "8"]);
    expect(srv.faults()).toEqual([]);
  });

  it("counts a start whose account is not listed as a failed start", async () => {
    const { srv, port } = setUp({ account: undefined });
    srv.start();
    await until(() => srv.phase === "backoff");
    expect(port.servers).toEqual([]);
  });

  it("finds no server hung across a suspend, and reads each device again at the resume", async () => {
    const { srv, base, clock, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    clock.freeze();
    await base.advance(3_600_000);
    clock.thaw(3_600_000);
    await quiet();
    expect(srv.phase).toBe("served");
    const reads = starts.last.fixture.log.length;
    srv.resumed();
    await until(() => starts.last.fixture.log.length >= reads + 2);
    expect(starts.started).toHaveLength(1);
  });

  it("leaves its devices as they were when the bridge stops it, and shows them unavailable when its account was deleted", async () => {
    const a = setUp();
    a.srv.start();
    await until(() => a.srv.phase === "served");
    await a.srv.stop("bridge");
    expect(a.srv.view("player")).toBeUndefined();
    expect(await a.starts.last.exited).toMatchObject({ signal: "SIGTERM" });
    const b = setUp();
    b.srv.start();
    await until(() => b.srv.phase === "served");
    await b.srv.stop("account_deleted");
    expect(b.srv.view("player")).toMatchObject({ available: false });
    await b.base.advance(600_000);
    expect(b.starts.started).toHaveLength(1);
  });
});

describe("PluginServer.call", () => {
  const never = () => new AbortController().signal;

  it("calls nothing while its server is starting, unreachable with why", async () => {
    const { srv, starts } = setUp({ behaviour: () => ({ readFails: Infinity }) });
    srv.start();
    await until(() => starts.started.length === 1);
    expect(await srv.call("player", "pause", {}, never())).toEqual({ kind: "unreachable", text: "its server is still starting" });
    expect(starts.last.fixture.log.filter((l) => "call" in l)).toEqual([]);
  });

  it("calls the tool with the arguments, then reads the device at once", async () => {
    // No subscription: the read after the call is the early read, not a change announced.
    const { srv, starts } = setUp({ behaviour: () => ({ subscribe: false, calls: { set_volume: { result: "ok", sets: PLAYER } } }) });
    srv.start();
    await until(() => srv.phase === "served");
    await quiet();
    const reads = starts.last.fixture.log.length;
    expect(await srv.call("player", "set_volume", { volume: 9 }, never())).toEqual({ kind: "ok", text: "done" });
    await until(() => (srv.view("player") as { values: Record<string, unknown> }).values.volume === 9);
    expect(starts.last.fixture.log.slice(reads)).toEqual([{ call: "set_volume", args: { volume: 9 } }, { read: PLAYER }]);
  });

  it("reads nothing early after an isError, and gives up a call whose time ran out", async () => {
    const { srv, starts } = setUp({ behaviour: () => ({ calls: { pause: { result: "error", text: "no" }, scan: { result: "hang" } } }) });
    srv.start();
    await until(() => srv.phase === "served");
    await quiet();
    const reads = starts.last.fixture.log.length;
    expect(await srv.call("player", "pause", {}, never())).toEqual({ kind: "error", text: "no" });
    await quiet();
    expect(starts.last.fixture.log.slice(reads)).toEqual([{ call: "pause", args: {} }]);
    const a = new AbortController();
    const hung = srv.call("library", "scan", {}, a.signal);
    await until(() => starts.last.fixture.log.length === reads + 2);
    a.abort(new Error("the command's time ran out"));
    expect(await hung).toMatchObject({ kind: "failed" });
    expect(srv.phase).toBe("served");
  });
});

/** How many of the started servers still run, once the exchange has settled. */
async function running(starts: InProcessServers): Promise<number> {
  const alive = await Promise.all(starts.started.map((p) => Promise.race([p.exited.then(() => 0), quiet().then(() => 1)])));
  return alive.reduce((a, b) => a + b, 0);
}

/** Holds the process's stop until `open`: the old process slow to exit; `asked` counts the stops asked of it. */
function slowToExit(p: { stop(): Promise<void> }): (() => void) & { asked: number } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const stop = p.stop.bind(p);
  const out = Object.assign(() => open(), { asked: 0 });
  p.stop = async () => {
    out.asked += 1;
    await gate;
    await stop();
  };
  return out;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("PluginServer: one start at a time, and its stop", () => {
  it("makes one start when the bridge's tick calls start() while a session change's restart waits for the old process", async () => {
    const { srv, env, starts } = setUp({ over: { needsSession: true }, sessions: [osSession({ id: "7" })] });
    srv.start();
    await until(() => srv.phase === "served");
    const open = slowToExit(starts.last);
    env.sessions = [osSession({ id: "8" })];
    srv.sessionsChanged();
    // The bridge's 1 s tick: reconcile() calls start() on every wanted server; a no-op while the restart waits.
    srv.start();
    await quiet();
    expect(open.asked).toBe(1);
    open();
    await until(() => srv.phase === "served");
    expect(await running(starts)).toBe(1);
    expect(starts.started).toHaveLength(2);
  });

  it("makes one start when start() comes twice while a stopped server's process is still exiting", async () => {
    const { srv, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    const open = slowToExit(starts.last);
    void srv.stop("deactivated");
    srv.start();
    srv.start();
    // The first start waits for the old process; the second makes no attempt of its own.
    await quiet();
    expect(open.asked).toBe(2);
    open();
    await until(() => srv.phase === "served");
    expect(await running(starts)).toBe(1);
    expect(starts.started).toHaveLength(2);
  });

  it("starts nothing after a stop that came while the old process was still exiting", async () => {
    const { srv, env, starts } = setUp({ over: { needsSession: true }, sessions: [osSession({ id: "7" })] });
    srv.start();
    await until(() => srv.phase === "served");
    const open = slowToExit(starts.last);
    env.sessions = [osSession({ id: "8" })];
    srv.sessionsChanged();
    const stopping = srv.stop("deactivated");
    open();
    await stopping;
    await quiet();
    expect(starts.started).toHaveLength(1);
    expect(srv.phase).toBe("stopped");
  });

  it("resolves the bridge's stop only once a start whose spawn was under way is stopped too", async () => {
    const { srv, port, starts } = setUp();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    port.serverFactory = async (spec) => {
      await gate;
      return starts.factory(spec);
    };
    srv.start();
    await until(() => port.servers.length === 1);
    let done = false;
    const stopping = srv.stop("bridge").then(() => { done = true; });
    await quiet();
    expect(done).toBe(false);
    open();
    await stopping;
    expect(starts.started).toHaveLength(1);
    expect(await Promise.race([starts.last.exited.then(() => true), quiet().then(() => false)])).toBe(true);
  });
});

describe("PluginServer: reads and probes on time", () => {
  it("reads its devices at once, not after a subscription the server never acknowledges, in either era", async () => {
    for (const era of ["both", "legacy"] as const) {
      const { srv, starts } = setUp({ behaviour: () => ({ era, subscribe: "hang" }) });
      srv.start();
      await until(() => srv.phase === "served");
      expect(starts.last.fixture.log).toEqual(expect.arrayContaining([{ read: PLAYER }, { read: LIBRARY }]));
    }
  });

  it("probes 10 s after its last request, so a hang is found within 20 s of it", { timeout: 20_000 }, async () => {
    // The library alone, read every 60 s.
    const one = manifest({ toolHashes: pins(TOOLS) }).devices[1]!;
    const { srv, base, starts } = setUp({ over: { devices: [one] } });
    srv.start();
    await until(() => srv.phase === "served");
    await base.advance(5_000);
    srv.readNow("library");
    await until(() => srv.view("library")?.at === base.now());
    starts.last.fixture.hang();
    // The probe goes at 15 s, 10 s after the read; unanswered, the server has failed at 25 s.
    await base.advance(10_000);
    await quiet();
    expect(srv.phase).toBe("served");
    await base.advance(10_000);
    await until(() => srv.phase === "backoff");
  });
});

describe("PluginServer: the server's text, capped", () => {
  it("caps a tool mismatch's text in its faults, its record and why, however many tools and however long their names", async () => {
    const many = Array.from({ length: 200 }, (_, i) => tool(`t${i}-${"x".repeat(2000)}`));
    const { srv, told } = setUp({ behaviour: () => ({ tools: many }) });
    srv.start();
    await until(() => srv.phase === "mismatch");
    expect(bytes(told.mismatched[0]!)).toBeLessThanOrEqual(1024);
    expect(told.mismatched[0]).toMatch(/and \d+ more/);
    for (const f of srv.faults()) expect(bytes(f.detail)).toBeLessThanOrEqual(1024);
    expect(bytes(srv.why)).toBeLessThanOrEqual(1024);
  });

  it("caps a failure's text in crash_loop, why and the log", { timeout: 20_000 }, async () => {
    const { srv, base, port } = setUp();
    port.serverFactory = async () => {
      throw new Error("e".repeat(5000));
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(" ")); });
    try {
      srv.start();
      for (const [i, wait] of [1, 2, 4, 8].entries()) {
        await until(() => port.servers.length === i + 1 && srv.phase === "backoff");
        await base.advance(wait * 1000);
      }
      await until(() => port.servers.length === 5 && srv.phase === "backoff");
    } finally {
      spy.mockRestore();
    }
    expect(srv.faults().map((f) => f.code)).toEqual(["crash_loop", "crash_loop"]);
    for (const f of srv.faults()) expect(bytes(f.detail)).toBeLessThanOrEqual(1024);
    expect(bytes(srv.why)).toBeLessThanOrEqual(1024);
    expect(logged.length).toBeGreaterThan(0);
    for (const l of logged) expect(bytes(l)).toBeLessThanOrEqual(1024);
  });
});

describe("PluginServer: a crashed server's process", () => {
  it("is stopped, and so its process group, before the server is started again", { timeout: 20_000 }, async () => {
    const { srv, base, starts } = setUp();
    srv.start();
    await until(() => srv.phase === "served");
    const first = starts.last;
    let stopped = false;
    const stop = first.stop.bind(first);
    first.stop = async () => {
      stopped = true;
      await stop();
    };
    first.fixture.crash(1);
    await until(() => srv.phase === "backoff");
    await until(() => stopped);
    await base.advance(1000);
    await until(() => starts.started.length === 2 && srv.phase === "served");
  });
});
