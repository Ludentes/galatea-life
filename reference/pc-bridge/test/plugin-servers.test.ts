import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The mpv plugin's own packer: the package the guide installs by hand.
import { pack } from "../../plugins/mpv/scripts/pack.js";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER } from "../src/bridge.js";
import { StateStore } from "../src/state-store.js";
import { BASE, bridge, changedOnDisk, own, people, stateDir, useBridges } from "./computer.js";
import { type FakeClock, type FakePort, type FakeWire, osSession, settle } from "./fakes.js";
import { manifest } from "./manifests.js";
import { type Served, serve, sha256, tgz } from "./packages.js";
import { type Behaviour, controlServer, fixturePackage, KODI_TOOLS, kodiServers, pins } from "./servers.js";

/** One `toOutcome` throws when set: a throw after the tool was called (the desktop fix wave's review, M1). */
const outcomeThrows = vi.hoisted(() => ({ next: false }));
vi.mock("../src/plugins/command.js", async (original) => {
  const real = await original<typeof import("../src/plugins/command.js")>();
  return {
    ...real,
    toOutcome: (...args: Parameters<typeof real.toOutcome>) => {
      if (outcomeThrows.next) {
        outcomeThrows.next = false;
        throw new Error("toOutcome threw");
      }
      return real.toOutcome(...args);
    },
  };
});

useBridges();
let server: Served;
beforeEach(async () => {
  server = await serve();
});
afterEach(async () => {
  await server.close();
});

const RUN = "run-1";
const PINNED = { toolHashes: pins(KODI_TOOLS) };
const id = (version: string, key: string) => `org.example.kodi:${version}:${key}`;
const PLAYER = id("1.0.0", "player");
const LIBRARY = id("1.0.0", "library");
const wireTime = (ms: number) => new Date(ms).toISOString();

function pkg(over: Record<string, unknown> = {}): Buffer {
  return tgz([{ name: "manifest.json", body: JSON.stringify(manifest({ ...PINNED, ...over })) }, { name: "server.py", body: "print('kodi')" },
    { name: "lib/kodi.py", body: "KODI = 1" }]);
}

function offer(path: string, body: Buffer): { url: string; sha256: string } {
  server.routes[path] = { body };
  return { url: server.url(path), sha256: sha256(body) };
}

/** Waits (real time) for a condition the servers and the fetches, on real streams and sockets, bring about. */
async function until(ok: () => boolean, what = "the condition"): Promise<void> {
  for (const end = Date.now() + 10_000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2));
  if (!ok()) throw new Error(`${what} did not come about`);
}

const replies = (wire: FakeWire, requestId: string) => wire.all(`${BASE}/reply`).map((p) => p.payload).filter((r) => r.requestId === requestId);
const events = (wire: FakeWire) => wire.all(`${BASE}/event`).map((p) => p.payload);
const statuses = (wire: FakeWire, device: string) => wire.all(`${BASE}/devices/${device}/status`).map((p) => p.payload);
const lastStatus = (wire: FakeWire, device: string) => wire.last(`${BASE}/devices/${device}/status`)?.payload;
const roster = (wire: FakeWire, device: string) => (wire.last(`${BASE}/status`)!.payload.devices as Record<string, any>[]).find((d) => d.id === device);
const faults = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.faults as Record<string, unknown>[];
const acks = (wire: FakeWire, device: string) => wire.all(`${BASE}/devices/${device}/ack`).map((p) => p.payload);

async function ask(wire: FakeWire, op: string, fields: Record<string, unknown>): Promise<Record<string, any>> {
  const requestId = randomUUID();
  await wire.deliver(`${BASE}/request/${op}`, { requestId, issuedAt: new Date().toISOString(), ...fields });
  await until(() => replies(wire, requestId).length > 0, `a reply to ${op}`);
  return { requestId, reply: replies(wire, requestId)[0] };
}

async function install(wire: FakeWire, path: string, body: Buffer): Promise<void> {
  const { requestId } = await ask(wire, "install", { host: COMPUTER, package: offer(path, body), account: "liza" });
  await until(() => events(wire).some((e) => e.requestId === requestId && e.type === "installed"), "installed");
  await settle();
}

/** A bridge with the test plugin installed (1.0.0, and any other `versions`), each server started in this process. */
async function installed(o: { over?: (n: number, version: string) => Behaviour; versions?: string[] } = {}) {
  const servers = kodiServers((n, spec) => o.over?.(n, spec.version) ?? {});
  const b = await bridge({ runId: RUN, before: (port) => {
    people(port);
    port.files.set("/usr/bin/python3", { executable: true });
    port.serverFactory = servers.factory;
  } });
  await install(b.wire, "/1.0.0.tar.gz", pkg());
  for (const v of o.versions ?? []) await install(b.wire, `/${v}.tar.gz`, pkg({ version: v }));
  return { ...b, servers };
}

async function activate(wire: FakeWire, version: string, plugin = "org.example.kodi") {
  return (await ask(wire, "activate", { plugin, version })).reply;
}

/** Served: its statuses out `available: true`. */
async function served(wire: FakeWire, version = "1.0.0") {
  await until(() => lastStatus(wire, id(version, "player"))?.available === true && lastStatus(wire, id(version, "library"))?.available === true,
    `${version} served`);
}

function command(clock: FakeClock, value: Record<string, unknown>, resultWithinMs = 10_000) {
  return { commandId: randomUUID(), issuedAt: wireTime(clock.now()), resultWithinMs, value };
}

async function send(wire: FakeWire, device: string, cmd: Record<string, unknown>) {
  const n = acks(wire, device).length;
  await wire.deliver(`${BASE}/devices/${device}/command`, cmd);
  await until(() => acks(wire, device).length > n, "an ack");
  return acks(wire, device).at(-1)!;
}

describe("a plugin's server through the bridge", () => {
  it("starts the activated version's server, publishes nothing while it starts, then each device available with its readings", async () => {
    const { wire, clock, servers } = await installed({ over: () => ({ readFails: 2 }) });
    // Before activation: the install's status, available: false.
    expect(statuses(wire, PLAYER)).toEqual([{ deviceId: PLAYER, timestamp: expect.any(String), available: false }]);
    await activate(wire, "1.0.0");
    await until(() => servers.started.length === 1 && servers.last.fixture.log.length >= 2, "the first reads");
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    // Starting: both first reads failed, and the retained status stands.
    expect(statuses(wire, PLAYER)).toHaveLength(1);
    expect(roster(wire, PLAYER)).toMatchObject({ observable: false, lastCheckIn: null });
    // The player's read is tried again at its 5 s cadence, within 10 s.
    await clock.advance(5_000);
    await served(wire);
    const servedAt = clock.now();
    const s = lastStatus(wire, PLAYER);
    expect(s).toEqual({ deviceId: PLAYER, timestamp: wireTime(clock.now()), available: true, playing: false, volume: 40 });
    expect(validate("bridge/device-status.json", s)).toEqual([]);
    // The library, not yet read again (its retry comes within 10 s): available with the server, stamped with its serving, no reading yet.
    expect(lastStatus(wire, LIBRARY)).toEqual({ deviceId: LIBRARY, timestamp: wireTime(clock.now()), available: true });
    await clock.advance(5_000);
    await until(() => lastStatus(wire, LIBRARY)?.["org.example.library.scanning"] === false, "the library's read");
    expect(lastStatus(wire, LIBRARY)!.timestamp).toBe(wireTime(clock.now()));
    await settle();
    // Went out when the device became observable, at its serving read: the routine status carries later check-ins.
    expect(roster(wire, PLAYER)).toMatchObject({ observable: true, lastCheckIn: wireTime(servedAt), timestamp: wireTime(servedAt) });
    expect(validate("bridge/status.json", wire.last(`${BASE}/status`)!.payload)).toEqual([]);
  });

  it("publishes a status only after the devices document that declares it, and a cadence read that changed nothing not at all", async () => {
    const { wire, clock } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    const topics = wire.published.map((p) => p.topic);
    const firstStatus = topics.indexOf(`${BASE}/devices/${PLAYER}/status`);
    const declared = wire.published.findIndex((p) => p.topic === `${BASE}/devices` && JSON.stringify(p.payload).includes(PLAYER));
    expect(declared).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(firstStatus);
    const n = statuses(wire, PLAYER).length;
    await clock.advance(5000);
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(statuses(wire, PLAYER)).toHaveLength(n);
  });

  it("publishes a change the server announces at once, stamped with its read", async () => {
    const { wire, clock, servers } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    await clock.advance(1234);
    servers.last.fixture.set("kodi://player/state", { playing: true, volume: 40, title: "Up" });
    await until(() => lastStatus(wire, PLAYER)?.playing === true, "the change");
    expect(lastStatus(wire, PLAYER)).toEqual({ deviceId: PLAYER, timestamp: wireTime(clock.now()), available: true, playing: true, volume: 40, title: "Up" });
  });

  it("shows a server that exited unavailable at once, and available again once a new start has served", async () => {
    const { wire, clock, servers } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    servers.last.fixture.crash(1);
    await until(() => lastStatus(wire, PLAYER)?.available === false, "unavailable");
    expect(lastStatus(wire, PLAYER)).toEqual({ deviceId: PLAYER, timestamp: wireTime(clock.now()), available: false });
    await settle();
    expect(roster(wire, PLAYER)).toMatchObject({ observable: false });
    await clock.advance(1000);
    await served(wire);
    expect(servers.started).toHaveLength(2);
  });

  it("re-publishes each status at a reconnection as it was, never restamped", async () => {
    const { wire, clock } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    const before = lastStatus(wire, PLAYER);
    await clock.advance(3000);
    const n = statuses(wire, PLAYER).length;
    await wire.reconnected();
    await settle();
    expect(statuses(wire, PLAYER).length).toBeGreaterThan(n);
    expect(lastStatus(wire, PLAYER)).toEqual(before);
  });

  it("names crash_loop per device after five failed starts, cleared once a start serves", { timeout: 20_000 }, async () => {
    const { wire, clock, servers } = await installed({ over: (n) => (n < 5 ? { exitAtStart: 1 } : {}) });
    await activate(wire, "1.0.0");
    for (const [i, wait] of [1, 2, 4, 8].entries()) {
      // The start's exit, then the turns its failure takes to set the backoff: the status alone says
      // nothing, since it went unavailable at the first failure and stays so.
      await until(() => servers.started.length === i + 1, "a start");
      await servers.started[i]!.exited;
      await settle();
      await clock.advance(wait * 1000);
    }
    await until(() => servers.started.length === 5, "the fifth start");
    await until(() => faults(wire).some((f) => f.code === "crash_loop"), "crash_loop");
    expect(faults(wire).filter((f) => f.code === "crash_loop").map((f) => f.device).sort()).toEqual([LIBRARY, PLAYER]);
    await clock.advance(16_000);
    await served(wire);
    await settle();
    expect(faults(wire).filter((f) => f.code === "crash_loop")).toEqual([]);
  });

  it("takes a server that cannot be spawned as a failed start, never the bridge's exit", { timeout: 20_000 }, async () => {
    const { wire, clock, port, b } = await installed();
    port.serverFactory = async () => { throw new Error("spawn /usr/bin/python3 ENOENT"); };
    await activate(wire, "1.0.0");
    await until(() => lastStatus(wire, PLAYER)?.timestamp === wireTime(clock.now()) && lastStatus(wire, PLAYER)?.available === false, "unavailable");
    for (const [i, wait] of [1, 2, 4, 8].entries()) {
      await until(() => port.servers.length === i + 1, "a failed start");
      // The failure sets its backoff a few turns after the start was asked.
      await settle();
      await clock.advance(wait * 1000);
    }
    await until(() => port.servers.length === 5, "five starts");
    await until(() => faults(wire).some((f) => f.code === "crash_loop"), "crash_loop");
    expect(faults(wire).find((f) => f.code === "crash_loop")!.detail).toContain("ENOENT");
    // Still serving the computer: a command to it is answered.
    await wire.deliver(`${BASE}/devices/${COMPUTER}/command`, command(clock, { action: "power.cancel" }));
    await until(() => acks(wire, COMPUTER).length === 1, "the computer's ack");
    expect(acks(wire, COMPUTER)[0]).toMatchObject({ result: "applied" });
    expect(b).toBeDefined();
  });

  it("stops a deleted account's server, its devices unavailable, and starts it no more", async () => {
    const { wire, clock, port, store, servers } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    port.listed = port.listed.filter((a) => a.osId !== 1000);
    port.deleted = [1000];
    await changedOnDisk(port, store);
    await clock.advance(1000);
    await until(() => lastStatus(wire, PLAYER)?.available === false, "unavailable");
    expect(await servers.last.exited).toMatchObject({ signal: "SIGTERM" });
    await clock.advance(600_000);
    expect(servers.started).toHaveLength(1);
    expect(faults(wire)).toContainEqual({ code: "account_deleted", device: PLAYER, detail: "liza's account was deleted" });
  });

  it("stops its servers at a restart with no available: false, and the next start publishes nothing until its server has served", { timeout: 20_000 }, async () => {
    const first = await installed();
    await activate(first.wire, "1.0.0");
    await served(first.wire);
    const shown = lastStatus(first.wire, PLAYER);
    own(first.b);
    await first.b.stop();
    expect(await first.servers.last.exited).toMatchObject({ signal: "SIGTERM" });
    expect(lastStatus(first.wire, PLAYER)).toEqual(shown);
    const servers = kodiServers(() => ({ readFails: 2 }));
    const { wire, clock } = await bridge({ runId: RUN, store: StateStore.load(stateDir()), before: (port) => {
      people(port);
      port.files.set("/usr/bin/python3", { executable: true });
      port.serverFactory = servers.factory;
    } });
    await until(() => servers.started.length === 1, "the start");
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(statuses(wire, PLAYER)).toEqual([]);
    await clock.advance(10_000);
    await served(wire);
  });

  it("finds no server hung across a suspend the OS did not announce, and reads each device after the first status", async () => {
    const { wire, clock, port, servers } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    // The server sleeps with the OS: a read its cadence sent during the hour would find no answer.
    servers.last.fixture.sleep();
    await port.emit({ kind: "suspend", announced: false });
    await clock.advance(3_600_000);
    const reads = servers.last.fixture.log.length;
    servers.last.fixture.wake();
    await port.emit({ kind: "resume", asleepMs: 3_600_000 });
    await until(() => servers.last.fixture.log.length >= reads + 2, "the reads after resume");
    await settle();
    expect(servers.started).toHaveLength(1);
    expect(lastStatus(wire, PLAYER)?.available).toBe(true);
  });
});

describe("commands to a plugin device's server", () => {
  it("acks failed(unreachable) while the server starts, nothing called", async () => {
    const { wire, clock, servers } = await installed({ over: () => ({ readFails: Infinity }) });
    await activate(wire, "1.0.0");
    await until(() => servers.started.length === 1, "the start");
    const ack = await send(wire, PLAYER, command(clock, { action: "media.pause" }));
    expect(ack).toMatchObject({ result: "failed", reason: "unreachable", detail: "its server is still starting" });
    expect(servers.last.fixture.log.filter((l) => "call" in l)).toEqual([]);
  });

  it("calls the tool with the argument as the manifest names it, acks applied, and reads the device at once", async () => {
    const { wire, clock, servers } = await installed({ over: () => ({ subscribe: false, calls: { set_volume: { result: "ok", sets: "kodi://player/state" } } }) });
    await activate(wire, "1.0.0");
    await served(wire);
    const ack = await send(wire, PLAYER, command(clock, { action: "media.set_volume", value: 20 }));
    expect(ack).toMatchObject({ result: "applied" });
    expect(validate("bridge/ack.json", ack)).toEqual([]);
    expect(servers.last.fixture.log).toContainEqual({ call: "set_volume", args: { volume: 20 } });
    await until(() => lastStatus(wire, PLAYER)?.volume === 20, "the early read");
  });

  it("reads the device back at issuedAt plus resultWithinMs less 2 s, publishing it though nothing changed", async () => {
    const { wire, clock } = await installed({ over: () => ({ calls: { pause: { result: "ok" } } }) });
    await activate(wire, "1.0.0");
    await served(wire);
    const cmd = command(clock, { action: "media.pause" });
    await send(wire, PLAYER, cmd);
    await until(() => lastStatus(wire, PLAYER)?.timestamp === wireTime(clock.now()), "the early read");
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    const n = statuses(wire, PLAYER).length;
    await clock.advance(7_999);
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(statuses(wire, PLAYER).length).toBe(n);
    await clock.advance(1);
    await until(() => statuses(wire, PLAYER).length === n + 1, "the read-back");
    expect(lastStatus(wire, PLAYER)!.timestamp).toBe(wireTime(Date.parse(cmd.issuedAt) + 8_000));
  });

  it("after a throw once the tool was called, acks failed(no_confirmation) and still reads the device back at the same time", async () => {
    const { wire, clock } = await installed({ over: () => ({ calls: { pause: { result: "ok" } } }) });
    await activate(wire, "1.0.0");
    await served(wire);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    outcomeThrows.next = true;
    const cmd = command(clock, { action: "media.pause" });
    const ack = await send(wire, PLAYER, cmd);
    errors.mockRestore();
    expect(ack).toMatchObject({ result: "failed", reason: "no_confirmation", detail: "toOutcome threw" });
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    const n = statuses(wire, PLAYER).length;
    await clock.advance(7_999);
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(statuses(wire, PLAYER).length).toBe(n);
    await clock.advance(1);
    await until(() => statuses(wire, PLAYER).length === n + 1, "the read-back");
    expect(lastStatus(wire, PLAYER)!.timestamp).toBe(wireTime(Date.parse(cmd.issuedAt) + 8_000));
  });

  it("acks sent for an action that does not confirm", async () => {
    const { wire, clock } = await installed();
    // The library's scan declared confirms: false in a version of its own.
    await install(wire, "/2.0.0.tar.gz", pkg({ version: "2.0.0", devices: manifest().devices.map((d) => ({ ...d,
      actions: d.actions.map((a) => ({ ...a, confirms: false, ...(a.confirmedBy ? { stateless: true, confirmedBy: undefined } : {}) })) })) }));
    await activate(wire, "2.0.0");
    await served(wire, "2.0.0");
    expect(await send(wire, id("2.0.0", "player"), command(clock, { action: "media.pause" }))).toMatchObject({ result: "sent" });
  });

  it("acks isError failed(no_confirmation) with the tool's text capped at 1 KiB, and a request for input the same", async () => {
    const { wire, clock } = await installed({ over: () => ({ calls: { pause: { result: "error", text: "x".repeat(3000) }, set_volume: { result: "sdk-input" } } }) });
    await activate(wire, "1.0.0");
    await served(wire);
    const err = await send(wire, PLAYER, command(clock, { action: "media.pause" }));
    expect(err).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(Buffer.byteLength(err.detail)).toBeLessThanOrEqual(1024);
    expect(err.detail.endsWith("…")).toBe(true);
    const input = await send(wire, PLAYER, command(clock, { action: "media.set_volume", value: 5 }));
    expect(input).toMatchObject({ result: "failed", reason: "no_confirmation" });
  });

  it("acks a value that does not fit the action's args invalid_request, nothing called", async () => {
    const { wire, clock, servers } = await installed();
    await activate(wire, "1.0.0");
    await served(wire);
    expect(await send(wire, PLAYER, command(clock, { action: "media.set_volume", value: 101 }))).toMatchObject({ result: "failed", reason: "invalid_request" });
    expect(await send(wire, PLAYER, command(clock, { action: "media.set_volume", value: { volume: 5 } }))).toMatchObject({ result: "failed", reason: "invalid_request" });
    expect(await send(wire, LIBRARY, command(clock, { action: "org.example.library.scan" }))).toMatchObject({ result: "failed", reason: "invalid_request" });
    expect(servers.last.fixture.log.filter((l) => "call" in l)).toEqual([]);
  });

  it("acks a tool that outlasts the command's time failed(no_confirmation) when the time runs out", async () => {
    const { wire, clock } = await installed({ over: () => ({ calls: { scan: { result: "hang" } } }) });
    await activate(wire, "1.0.0");
    await served(wire);
    const n = acks(wire, LIBRARY).length;
    await wire.deliver(`${BASE}/devices/${LIBRARY}/command`, command(clock, { action: "org.example.library.scan", value: "/media" }, 3000));
    await new Promise((r) => setTimeout(r, 30));
    expect(acks(wire, LIBRARY)).toHaveLength(n);
    await clock.advance(3000);
    await until(() => acks(wire, LIBRARY).length === n + 1, "the ack");
    expect(acks(wire, LIBRARY).at(-1)).toMatchObject({ result: "failed", reason: "no_confirmation" });
  });
});

describe("the swap through the bridge", () => {
  it("switches over to a later version activated with none active (M6): the earlier one's devices removed, their statuses cleared after devices, no uninstalled", { timeout: 20_000 }, async () => {
    const { wire } = await installed({ versions: ["1.1.0"] });
    expect(await activate(wire, "1.1.0")).toMatchObject({ status: "ok" });
    await served(wire, "1.1.0");
    await until(() => lastStatus(wire, PLAYER) === "", "the old status cleared");
    const doc = wire.last(`${BASE}/devices`)!.payload.devices as Record<string, any>[];
    expect(doc.map((d) => [d.id, d.stagedFor])).toEqual([[COMPUTER, undefined],
      [id("1.1.0", "library"), LIBRARY], [id("1.1.0", "player"), PLAYER]]);
    const topics = wire.published.map((p) => `${p.topic} ${p.payload === "" ? "clear" : JSON.stringify(p.payload).includes(PLAYER)}`);
    expect(topics.lastIndexOf(`${BASE}/devices false`)).toBeLessThan(topics.indexOf(`${BASE}/devices/${PLAYER}/status clear`));
    expect(events(wire).filter((e) => e.type === "uninstalled")).toEqual([]);
    expect(wire.last(`${BASE}/devices/${PLAYER}/status`)!.retain).toBe(true);
  });

  it("keeps the old version's devices serving until the new server has served", { timeout: 20_000 }, async () => {
    const { wire, clock, servers } = await installed({ versions: ["1.1.0"], over: (_n, v) => (v === "1.1.0" ? { readFails: 2 } : {}) });
    await activate(wire, "1.0.0");
    await served(wire);
    await activate(wire, "1.1.0");
    await until(() => servers.started.length === 2, "the new start");
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(lastStatus(wire, PLAYER)?.available).toBe(true);
    await clock.advance(10_000);
    await served(wire, "1.1.0");
    await until(() => lastStatus(wire, PLAYER) === "" && lastStatus(wire, LIBRARY) === "", "the old statuses cleared");
    await clock.advance(5_000);
    await settle();
    // Each old status cleared once, and nothing after the clear: a status publication overtaken by the
    // swap would put a removed device's retained status back.
    for (const old of [PLAYER, LIBRARY]) expect(statuses(wire, old).slice(statuses(wire, old).indexOf(""))).toEqual([""]);
  });
});

describe("a packaged server run as a real process", () => {
  it("installs the fixture as a package run by node, starts it as the account with its environment built from nothing, and serves", async () => {
    const control = await controlServer();
    try {
      const nodeDir = dirname(process.execPath);
      const m = manifest({ ...PINNED, command: ["node", "server.mjs"] });
      const body = fixturePackage(m, { tools: KODI_TOOLS, state: { "kodi://player/state": { volume: 3 }, "kodi://library/state": {} } }, control.port);
      const b = await bridge({ runId: RUN, before: (port: FakePort) => {
        port.listed = [{ osId: 1000, name: "liza", primaryGid: 1000, path: [nodeDir] }];
        port.files.set(join(nodeDir, "node"), { executable: true });
      } });
      await install(b.wire, "/fixture.tar.gz", body);
      await activate(b.wire, "1.0.0");
      await served(b.wire);
      expect(lastStatus(b.wire, PLAYER)).toMatchObject({ available: true, volume: 3 });
      expect(control.started).toHaveLength(1);
      const dir = join(b.port.pluginsDir(), "org.example.kodi", "1.0.0");
      expect(control.started[0]!.env).toEqual({ HOME: "/home/liza", PATH: nodeDir, LANG: "C.UTF-8", GALATEA_PLUGIN_DIR: dir });
      expect(control.started[0]!.cwd).toBe(dir);
      expect(control.started[0]!.argv).toEqual([join(dir, "server.mjs")]);
    } finally {
      await control.close();
    }
  }, 20_000);

  it("runs the real mpv package in the account's session, against a stand-in mpv on its PATH, and pauses it", async () => {
    const bin = mkdtempSync(join(tmpdir(), "fake-mpv-bin-"));
    const runtime = mkdtempSync(join(tmpdir(), "fake-mpv-run-"));
    // Packed apart from the mpv plugin's own dist/, which its tests pack into at the same time under `pnpm -r test`.
    const out = mkdtempSync(join(tmpdir(), "mpv-pack-"));
    try {
      const nodeDir = dirname(process.execPath);
      const fake = fileURLToPath(new URL("./fixtures/fake-mpv.mjs", import.meta.url));
      writeFileSync(join(bin, "mpv"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
      const { tarball, stage } = await pack(out);
      expect([tarball, stage].every((p) => p.startsWith(out))).toBe(true);
      const body = readFileSync(tarball);
      const b = await bridge({ runId: RUN, before: (port: FakePort) => {
        port.listed = [{ osId: 1000, name: "liza", primaryGid: 1000, path: [bin, nodeDir] }];
        port.files.set(join(nodeDir, "node"), { executable: true });
        port.sessions = [osSession({ id: "3" })];
        port.display.set("3", { XDG_RUNTIME_DIR: runtime, DISPLAY: ":0" });
      } });
      const { requestId } = await ask(b.wire, "install", { host: COMPUTER, package: offer("/mpv.tar.gz", body), account: "liza" });
      await until(() => events(b.wire).some((e) => e.requestId === requestId), "the install's end");
      const ev = events(b.wire).find((e) => e.requestId === requestId)!;
      expect(ev.type).toBe("installed");
      const m = ev.manifest as { id: string; version: string; devices: { key: string }[] };
      await activate(b.wire, m.version, m.id);
      const player = `${m.id}:${m.version}:${m.devices[0]!.key}`;
      await until(() => lastStatus(b.wire, player)?.available === true, "the mpv server served");
      expect(b.port.servers[0]).toMatchObject({ plugin: m.id, session: "3", env: expect.objectContaining({ XDG_RUNTIME_DIR: runtime, DISPLAY: ":0" }) });
      // Nothing is loaded: the tool's isError, with its text.
      expect(await send(b.wire, player, command(b.clock, { action: "media.pause" })))
        .toMatchObject({ result: "failed", reason: "no_confirmation", detail: "nothing is loaded" });
      expect(await send(b.wire, player, command(b.clock, { action: "media.set_volume", value: 30 }))).toMatchObject({ result: "applied" });
      await until(() => lastStatus(b.wire, player)?.volume === 30, "the volume read");
    } finally {
      rmSync(bin, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
