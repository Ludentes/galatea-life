import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OsAccount, OsSession } from "../src/port.js";
import { INSTALL_MS, PluginHost, STAGING } from "../src/plugins/host.js";
import { StateStore } from "../src/state-store.js";
import { SuspendClock } from "../src/suspend-clock.js";
import { FakeClock, FakePort } from "./fakes.js";
import { manifest } from "./manifests.js";
import { type Entry, type Served, serve, sha256, tgz } from "./packages.js";
import { type InProcessServers, KODI_PLAYER, KODI_TOOLS, kodiServers, kodiState, pins } from "./servers.js";
import { pluginDevices } from "../src/plugins/devices.js";

let dir: string;
let server: Served;
const hosts: PluginHost[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pc-bridge-host-"));
  server = await serve();
});

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const LIZA: OsAccount = { osId: 1000, name: "liza", primaryGid: 1000, home: "/home/liza", path: ["/usr/local/bin", "/usr/bin", "/bin"] };
const OLGA: OsAccount = { osId: 1001, name: "olga", primaryGid: 1001, home: "/home/olga", path: ["/usr/bin"] };
const PLUGINS = () => join(dir, "plugins");

/** A package of the test plugin: its manifest, `server.py` and `lib/kodi.py`, and what `extra` adds. */
function pkg(over: Record<string, unknown> = {}, extra: Entry[] = []): Buffer {
  return tgz([{ name: "manifest.json", body: JSON.stringify(manifest(over)) }, { name: "server.py", body: "print('kodi')" },
    { name: "lib/kodi.py", body: "KODI = 1" }, ...extra]);
}

/** Serves a package at `path`, returning what `install` names. */
function offer(path: string, body: Buffer): { url: string; sha256: string } {
  server.routes[path] = { body };
  return { url: server.url(path), sha256: sha256(body) };
}

interface World {
  port: FakePort;
  clock: FakeClock;
  store: StateStore;
  accounts: Map<string, OsAccount>;
  retired: Set<string>;
  changes: number;
  sessions: OsSession[];
  /** The servers the host starts, in this process. */
  servers: InProcessServers;
}

/** A plugin host on fakes: python3 in /usr/bin, liza and olga listed; `world` shared by a restart. */
function host(world?: Partial<World>): PluginHost & { world: World } {
  const w: World = {
    port: world?.port ?? new FakePort(),
    clock: world?.clock ?? new FakeClock(),
    store: world?.store ?? StateStore.load(join(dir, "state")),
    accounts: world?.accounts ?? new Map([["liza", LIZA], ["olga", OLGA]]),
    retired: world?.retired ?? new Set(),
    changes: 0,
    sessions: world?.sessions ?? [],
    servers: world?.servers ?? kodiServers(),
  };
  w.port.pluginsPath = PLUGINS();
  if (!world?.port) w.port.files.set("/usr/bin/python3", { executable: true });
  if (!world?.port) w.port.serverFactory = w.servers.factory;
  const h = new PluginHost({ port: w.port, clock: w.clock, store: w.store, allowHttp: true, account: (t) => w.accounts.get(t),
    retired: (t) => w.retired.has(t), changed: () => { w.changes += 1; },
    serverClock: new SuspendClock(w.clock), sessions: () => w.sessions }) as PluginHost & { world: World };
  h.world = w;
  hosts.push(h);
  return h;
}

async function started(world?: Partial<World>) {
  const h = host(world);
  await h.start();
  return h;
}

/** Waits (real time, the suite's 10 s bound) until the host has ended the request, and gives its outcome. */
async function ending(h: PluginHost, requestId: string) {
  for (const end = Date.now() + 10_000; Date.now() < end; ) {
    const r = h.ended().find((x) => x.requestId === requestId);
    if (r) return r.ended;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error(`${requestId} never ended`);
}

const onDisk = () => JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8"));
const kodi = (h: PluginHost) => h.state.installed["org.example.kodi"];

describe("install", () => {
  it("keeps the request on disk before accepted, then installs: files in place, the record as installed, and an installed end", async () => {
    const h = await started();
    const p = offer("/kodi.tar.gz", pkg());
    expect(await h.install("r1", p, "liza")).toEqual({ status: "accepted" });
    expect(onDisk().plugins.requests).toEqual([{ requestId: "r1", op: "install", acceptedAt: new Date(h.world.clock.now()).toISOString(),
      package: p, account: "liza" }]);
    expect(await ending(h, "r1")).toEqual({ type: "installed", manifest: manifest() });
    const v = kodi(h)!.versions["1.0.0"]!;
    expect(v).toEqual({ sha256: p.sha256, manifest: manifest(), account: "liza", interpreter: "/usr/bin/python3",
      files: { "manifest.json": sha256(JSON.stringify(manifest())), "server.py": sha256("print('kodi')"), "lib/kodi.py": sha256("KODI = 1") },
      activated: false, installedAt: new Date(h.world.clock.now()).toISOString() });
    expect(readFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "lib", "kodi.py"), "utf8")).toBe("KODI = 1");
    expect(onDisk().plugins.installed["org.example.kodi"].versions["1.0.0"]).toEqual(v);
    expect(readdirSync(join(PLUGINS(), STAGING))).toEqual([]);
    expect(h.world.changes).toBeGreaterThan(0);
  });

  it("forgets a request once its event went out", async () => {
    const h = await started();
    await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza");
    await ending(h, "r1");
    expect(h.request("r1")?.requestId).toBe("r1");
    await h.announced("r1");
    expect(h.request("r1")).toBeUndefined();
    expect(onDisk().plugins.requests).toEqual([]);
  });

  it.each([
    ["a package that is not the one named", () => ({ ...offer("/kodi.tar.gz", pkg()), sha256: sha256("another") }), "liza", "hash_mismatch"],
    ["a package it cannot fetch", () => ({ url: server.url("/missing.tar.gz"), sha256: sha256("x") }), "liza", "fetch_failed"],
    ["a package holding a link", () => offer("/link.tar.gz", pkg({}, [{ name: "lib/etc", type: "2" }])), "liza", "invalid_package"],
    ["a manifest with a key holding a colon", () => offer("/colon.tar.gz", pkg({ devices: [{ ...manifest().devices[0], key: "a:b" }] })), "liza",
      "invalid_manifest"],
    ["a package with no manifest", () => offer("/bare.tar.gz", tgz([{ name: "server.py", body: "x" }])), "liza", "invalid_manifest"],
    ["an account the computer does not list", () => offer("/kodi.tar.gz", pkg()), "ghost", "unknown_account"],
  ])("ends %s install_failed, nothing installed", async (_what, what, account, reason) => {
    const h = await started();
    await h.install("r1", what(), account);
    expect(await ending(h, "r1")).toMatchObject({ type: "install_failed", reason });
    expect(h.state.installed).toEqual({});
    expect(readdirSync(PLUGINS()).sort()).toEqual([STAGING]);
    expect(readdirSync(join(PLUGINS(), STAGING))).toEqual([]);
  });

  it("answers failed(state_unsaved) and accepts nothing when the request cannot be kept", async () => {
    const h = await started();
    h.world.store.save = () => Promise.reject(new Error("ENOSPC: no space left on device"));
    expect(await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza"))
      .toEqual({ status: "failed", reason: "state_unsaved", detail: "ENOSPC: no space left on device" });
    expect(h.state.requests).toEqual([]);
  });

  it("runs installs one at a time, in the order accepted", async () => {
    const h = await started();
    server.routes["/slow.tar.gz"] = { body: pkg(), stallAfter: 10 };
    await h.install("r1", { url: server.url("/slow.tar.gz"), sha256: sha256(pkg()) }, "liza");
    await h.world.clock.advance(1000);
    await h.install("r2", offer("/other.tar.gz", pkg({ id: "org.example.other" })), "liza");
    await new Promise((r) => setTimeout(r, 50));
    expect(server.hits).toEqual(["/slow.tar.gz"]);
    await h.world.clock.advance(INSTALL_MS - 1000);
    h.expire(h.world.clock.now());
    expect(await ending(h, "r1")).toMatchObject({ reason: "timeout" });
    expect(await ending(h, "r2")).toMatchObject({ type: "installed" });
    expect(server.hits).toEqual(["/slow.tar.gz", "/other.tar.gz"]);
  });

  it("ends an install not done within 600 s of its accepted timeout, cutting its download, nothing installed", async () => {
    const h = await started();
    server.routes["/slow.tar.gz"] = { body: pkg(), stallAfter: 10 };
    await h.install("r1", { url: server.url("/slow.tar.gz"), sha256: sha256(pkg()) }, "liza");
    await h.world.clock.advance(INSTALL_MS - 1);
    h.expire(h.world.clock.now());
    expect(h.ended().filter((r) => r.ended.type === "uninstalled")).toEqual([]);
    await h.world.clock.advance(1);
    h.expire(h.world.clock.now());
    expect(await ending(h, "r1")).toEqual({ type: "install_failed", reason: "timeout", detail: `not ended within ${INSTALL_MS} ms of its accepted` });
    expect(h.state.installed).toEqual({});
    expect(readdirSync(join(PLUGINS(), STAGING))).toEqual([]);
  });

  it("installs a new version beside the installed one", async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await ending(h, "r1");
    await h.install("r2", offer("/2.tar.gz", pkg({ version: "1.1.0" })), "olga");
    expect(await ending(h, "r2")).toMatchObject({ type: "installed" });
    expect(Object.keys(kodi(h)!.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(readdirSync(join(PLUGINS(), "org.example.kodi")).sort()).toEqual(["1.0.0", "1.1.0"]);
  });
});

/** Waits (real time) until the request's end is set, saved or not. */
async function endSet(h: PluginHost, requestId: string) {
  for (let i = 0; i < 400; i++) {
    const r = h.state.requests.find((x) => x.requestId === requestId);
    if (r?.ended) return r.ended;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error(`${requestId} never ended`);
}

describe("an end on disk before its event", () => {
  it("holds an end whose save fails, names it, tries again each tick, and gives it once it is on disk", async () => {
    const h = await started();
    const save = h.world.store.save.bind(h.world.store);
    await h.install("r1", { ...offer("/kodi.tar.gz", pkg()), sha256: sha256("another") }, "liza");
    h.world.store.save = () => Promise.reject(new Error("ENOSPC: no space left on device"));
    expect(await endSet(h, "r1")).toMatchObject({ reason: "hash_mismatch" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.ended().filter((r) => r.ended.type === "uninstalled")).toEqual([]);
    expect(h.unsavedEnds()).toBe(true);
    expect(onDisk().plugins.requests[0].ended).toBeUndefined();
    h.expire(h.world.clock.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.ended().filter((r) => r.ended.type === "uninstalled")).toEqual([]);
    h.world.store.save = save;
    h.expire(h.world.clock.now());
    expect(await ending(h, "r1")).toMatchObject({ type: "install_failed", reason: "hash_mismatch" });
    expect(h.unsavedEnds()).toBe(false);
    expect(onDisk().plugins.requests[0].ended).toMatchObject({ reason: "hash_mismatch" });
  });

  it("sends after a restart exactly the end it saved, running nothing again", async () => {
    const first = await started();
    await first.install("r1", { ...offer("/kodi.tar.gz", pkg()), sha256: sha256("another") }, "liza");
    await ending(first, "r1");
    await first.close();
    const h = await started({ port: first.world.port, clock: first.world.clock, store: StateStore.load(join(dir, "state")) });
    expect(h.ended().map((r) => r.ended)).toEqual([{ type: "install_failed", reason: "hash_mismatch",
      detail: `the package's SHA-256 is ${sha256(pkg())}` }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.hits).toEqual(["/kodi.tar.gz"]);
  });

  it("an uninstall's end too: held until saved, so a restart never removes and ends it twice", async () => {
    const h = await started();
    await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza");
    await ending(h, "r1");
    await h.announced("r1");
    const save = h.world.store.save.bind(h.world.store);
    let fail = false;
    h.world.store.save = () => (fail ? Promise.reject(new Error("EIO")) : save());
    await h.uninstall("u1", "org.example.kodi");
    fail = true;
    expect(await endSet(h, "u1")).toEqual({ type: "uninstalled", plugin: "org.example.kodi" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.ended().filter((r) => r.ended.type === "uninstalled")).toEqual([]);
    fail = false;
    h.expire(h.world.clock.now());
    expect(await ending(h, "u1")).toEqual({ type: "uninstalled", plugin: "org.example.kodi" });
  });
});

describe("the move into place", () => {
  it("takes the files back out when the record cannot be saved, and ends state_unsaved once that end is on disk", async () => {
    const h = await started();
    const save = h.world.store.save.bind(h.world.store);
    await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza");
    h.world.store.save = () => Promise.reject(new Error("EIO"));
    expect(await endSet(h, "r1")).toMatchObject({ type: "install_failed", reason: "state_unsaved" });
    expect(existsSync(join(PLUGINS(), "org.example.kodi", "1.0.0"))).toBe(false);
    expect(h.state.installed).toEqual({});
    h.world.store.save = save;
    h.expire(h.world.clock.now());
    expect(await ending(h, "r1")).toMatchObject({ reason: "state_unsaved" });
  });

  it("is not cut by the 600 s once it has begun: the end is installed, and no timeout is ever saved", async () => {
    const h = await started();
    const saved: string[] = [];
    const save = h.world.store.save.bind(h.world.store);
    h.world.store.save = () => { saved.push(JSON.stringify(h.state.requests)); return save(); };
    await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza");
    // The move's first reading of the clock (the install's time) comes after it has begun: the 600 s pass then.
    const clock = h.world.clock;
    const now = clock.now.bind(clock);
    let fired = false;
    clock.now = () => {
      const t = now();
      if (!fired) {
        fired = true;
        h.expire(t + INSTALL_MS);
      }
      return t;
    };
    expect(await ending(h, "r1")).toMatchObject({ type: "installed" });
    expect(fired).toBe(true);
    expect(saved.some((s) => s.includes("timeout"))).toBe(false);
  });

  it("is never begun for an install its 600 s ended while it was being checked: nothing installed", async () => {
    const h = await started();
    const exists = h.world.port.exists.bind(h.world.port);
    h.world.port.exists = async (p: string) => {
      h.expire(h.world.clock.now() + INSTALL_MS);
      return exists(p);
    };
    await h.install("r1", offer("/kodi.tar.gz", pkg()), "liza");
    expect(await ending(h, "r1")).toMatchObject({ reason: "timeout" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.state.installed).toEqual({});
    expect(existsSync(join(PLUGINS(), "org.example.kodi"))).toBe(false);
  });

  it("never runs a queued install its 600 s ended while it waited", async () => {
    const h = await started();
    server.routes["/slow.tar.gz"] = { body: pkg(), stallAfter: 10 };
    await h.install("r1", { url: server.url("/slow.tar.gz"), sha256: sha256(pkg()) }, "liza");
    await h.install("r2", offer("/other.tar.gz", pkg({ id: "org.example.other" })), "liza");
    await new Promise((r) => setTimeout(r, 30));
    await h.world.clock.advance(INSTALL_MS);
    h.expire(h.world.clock.now());
    expect(await ending(h, "r2")).toMatchObject({ reason: "timeout" });
    expect(await ending(h, "r1")).toMatchObject({ reason: "timeout" });
    await new Promise((r) => setTimeout(r, 50));
    expect(server.hits).toEqual(["/slow.tar.gz"]);
  });
});

describe("a plugins directory it cannot make", () => {
  function unmakeable(port: FakePort): () => void {
    const make = port.makeRootOnlyDir.bind(port);
    port.makeRootOnlyDir = () => Promise.reject(new Error("EACCES: permission denied"));
    return () => { port.makeRootOnlyDir = make; };
  }

  it("still ends an install cut short restart at once, holds an uninstall, refuses new requests, and runs it once the directory is made", async () => {
    const first = await started();
    await first.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await ending(first, "r1");
    await first.announced("r1");
    const at = new Date(first.world.clock.now()).toISOString();
    first.state.requests.push({ requestId: "u1", op: "uninstall", acceptedAt: at, plugin: "org.example.kodi" },
      { requestId: "r2", op: "install", acceptedAt: at, package: offer("/2.tar.gz", pkg({ version: "1.1.0" })), account: "liza" });
    await first.world.store.save();
    await first.close();
    const restore = unmakeable(first.world.port);
    const h = host({ port: first.world.port, clock: first.world.clock, store: StateStore.load(join(dir, "state")) });
    await h.start();
    expect(h.unready()).toBe("EACCES: permission denied");
    expect(h.ended().map((r) => [r.requestId, r.ended])).toEqual([["r2", { type: "install_failed", reason: "restart",
      detail: "plugins_unready: EACCES: permission denied" }]]);
    expect(h.request("u1")?.ended).toBeUndefined();
    expect(kodi(h)).toBeDefined();
    expect(await h.install("r3", offer("/3.tar.gz", pkg()), "liza")).toEqual({ status: "failed", reason: "plugins_unready",
      detail: "EACCES: permission denied" });
    expect(await h.uninstall("u2", "org.example.kodi")).toMatchObject({ status: "failed", reason: "plugins_unready" });
    h.expire(h.world.clock.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.request("u1")?.ended).toBeUndefined();
    restore();
    h.expire(h.world.clock.now());
    expect(await ending(h, "u1")).toEqual({ type: "uninstalled", plugin: "org.example.kodi" });
    expect(h.unready()).toBeUndefined();
    expect(existsSync(join(PLUGINS(), "org.example.kodi"))).toBe(false);
  });
});

describe("the interpreter", () => {
  const installed = async (setup: (port: FakePort) => void, over: Record<string, unknown> = {}, extra: Entry[] = [], account = LIZA) => {
    const port = new FakePort();
    port.files.set("/usr/bin/python3", { executable: true });
    setup(port);
    const h = await started({ port, accounts: new Map([["liza", account]]) });
    await h.install("r1", offer("/kodi.tar.gz", pkg(over, extra)), "liza");
    return { h, end: await ending(h, "r1") };
  };

  it("records the first executable of that name in the account's PATH, by its absolute path", async () => {
    const { h } = await installed((port) => port.files.set("/usr/local/bin/python3", { exists: true, executable: false }));
    expect(kodi(h)!.versions["1.0.0"]!.interpreter).toBe("/usr/bin/python3");
  });

  it.each([
    ["found nowhere in PATH", (port: FakePort) => port.files.delete("/usr/bin/python3"), "python3 is not found in liza's PATH"],
    ["a file the account can write", (port: FakePort) => port.files.set("/usr/bin/python3", { executable: true, writableBy: [1000] }),
      "liza can write /usr/bin/python3"],
    ["a directory on its path the account can write", (port: FakePort) => port.files.set("/usr", { writableBy: [1000] }),
      "liza can write /usr, where python3 is looked for"],
    ["an earlier directory, empty now, the account can write", (port: FakePort) => port.files.set("/usr/local/bin", { writableBy: [1000] }),
      "liza can write /usr/local/bin, where python3 is looked for"],
    ["a file there, not executable, the account can write", (port: FakePort) =>
      port.files.set("/usr/local/bin/python3", { executable: false, writableBy: [1000] }), "liza can write /usr/local/bin/python3"],
  ])("refuses an interpreter %s: invalid_manifest", async (_what, setup, detail) => {
    const { h, end } = await installed(setup);
    expect(end).toEqual({ type: "install_failed", reason: "invalid_manifest", detail });
    expect(h.state.installed).toEqual({});
  });

  it("refuses a relative directory in PATH before the interpreter is found", async () => {
    const { end } = await installed(() => {}, {}, [], { ...LIZA, path: ["bin", "/usr/bin"] });
    expect(end).toMatchObject({ reason: "invalid_manifest", detail: "liza's PATH holds \"bin\", not an absolute directory, before python3 is found" });
  });

  it("takes a file of the package as the command, executable in the archive, with no interpreter to record", async () => {
    const { h } = await installed(() => {}, { command: ["./bin/kodi-server"] }, [{ name: "bin/kodi-server", body: "#!/bin/sh", mode: 0o755 }]);
    expect(kodi(h)!.versions["1.0.0"]!.interpreter).toBeNull();
  });

  it("refuses a file of the package as the command that the archive does not mark executable", async () => {
    const { end } = await installed(() => {}, { command: ["bin/kodi-server"] }, [{ name: "bin/kodi-server", body: "#!/bin/sh", mode: 0o644 }]);
    expect(end).toMatchObject({ reason: "invalid_manifest", detail: "bin/kodi-server is not executable in the package" });
  });
});

describe("a reinstall", () => {
  async function installedOnce() {
    const h = await started();
    const first = offer("/kodi.tar.gz", pkg());
    await h.install("r1", first, "liza");
    await ending(h, "r1");
    return { h, first };
  }

  it("of the same package for the same account repairs the files, keeping the activation and install time", async () => {
    const { h, first } = await installedOnce();
    // Its server never answers: nothing of the server's (an era, a mismatch) enters the record.
    h.world.servers.behaviour = () => ({ exitAtStart: 1 });
    await h.activate("org.example.kodi", "1.0.0");
    const was = structuredClone(kodi(h)!.versions["1.0.0"]!);
    writeFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py"), "tampered");
    await h.world.clock.advance(5000);
    await h.install("r2", first, "liza");
    expect(await ending(h, "r2")).toEqual({ type: "installed", manifest: manifest() });
    expect(kodi(h)!.versions["1.0.0"]).toEqual(was);
    expect(readFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py"), "utf8")).toBe("print('kodi')");
  });

  it.each([
    ["from another package", () => offer("/other.tar.gz", pkg({ hosts: ["media.example"] })), "liza", "from another package"],
    ["for another account", () => offer("/kodi.tar.gz", pkg()), "olga", "for liza"],
  ])("%s ends version_conflict, changing nothing", async (_what, what, account, detail) => {
    const { h } = await installedOnce();
    const was = structuredClone(h.state.installed);
    await h.install("r2", what(), account);
    expect(await ending(h, "r2")).toEqual({ type: "install_failed", reason: "version_conflict", detail: `org.example.kodi 1.0.0 is installed ${detail}` });
    expect(h.state.installed).toEqual(was);
  });

  it("of the same package whose recorded manifest differs ends version_conflict", async () => {
    const { h, first } = await installedOnce();
    kodi(h)!.versions["1.0.0"]!.manifest.hosts = ["media.example"];
    await h.install("r2", first, "liza");
    expect(await ending(h, "r2")).toEqual({ type: "install_failed", reason: "version_conflict",
      detail: "org.example.kodi 1.0.0 is installed with another manifest" });
  });

  it("of a version whose account was deleted ends version_conflict, whatever account it names", async () => {
    const { h, first } = await installedOnce();
    h.world.retired.add("liza");
    h.world.accounts.delete("liza");
    await h.install("r2", first, "olga");
    expect(await ending(h, "r2")).toMatchObject({ reason: "version_conflict", detail: "org.example.kodi 1.0.0 is installed for liza, whose account was deleted" });
    await h.install("r3", first, "ghost");
    expect(await ending(h, "r3")).toMatchObject({ reason: "version_conflict" });
  });
});

describe("uninstall", () => {
  it("answers failed(unknown_plugin) at once for a plugin not installed, keeping nothing", async () => {
    const h = await started();
    expect(await h.uninstall("u1", "org.example.kodi")).toEqual({ status: "failed", reason: "unknown_plugin", detail: "org.example.kodi is not installed" });
    expect(h.state.requests).toEqual([]);
  });

  it("removes every version's files and record, ends uninstalled, and names the devices it removed", async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await h.install("r2", offer("/2.tar.gz", pkg({ version: "1.1.0" })), "liza");
    await ending(h, "r2");
    expect(await h.uninstall("u1", "org.example.kodi")).toEqual({ status: "accepted" });
    expect(await ending(h, "u1")).toEqual({ type: "uninstalled", plugin: "org.example.kodi" });
    expect(h.state.installed).toEqual({});
    expect(existsSync(join(PLUGINS(), "org.example.kodi"))).toBe(false);
    const removed = ["org.example.kodi:1.0.0:player", "org.example.kodi:1.0.0:library", "org.example.kodi:1.1.0:player", "org.example.kodi:1.1.0:library"];
    expect(h.clears()).toEqual(removed);
    await h.world.store.flush();
    expect(onDisk().plugins.installed).toEqual({});
    // On disk with the end, until the bridge's clears are taken.
    expect(onDisk().plugins.clears).toEqual(removed);
    await h.cleared(removed.slice(0, 2));
    expect(onDisk().plugins.clears).toEqual(removed.slice(2));
    await h.cleared(removed.slice(2));
    expect(h.clears()).toEqual([]);
    expect(onDisk().plugins.clears).toBeUndefined();
  });
});

describe("activate", () => {
  async function two() {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await h.install("r2", offer("/2.tar.gz", pkg({ version: "1.1.0" })), "liza");
    await ending(h, "r2");
    return h;
  }
  const ok = (version: string) => ({ status: "ok", data: { plugin: "org.example.kodi", version } });

  it("answers failed(unknown_plugin) for a plugin or version not installed", async () => {
    const h = await two();
    expect(await h.activate("org.example.mpv", "1.0.0")).toMatchObject({ status: "failed", reason: "unknown_plugin" });
    expect(await h.activate("org.example.kodi", "9.9.9")).toMatchObject({ status: "failed", reason: "unknown_plugin" });
  });

  it("activates a version when none is, recorded on disk before the ok, and again changes nothing", async () => {
    const h = await two();
    expect(await h.activate("org.example.kodi", "1.0.0")).toEqual(ok("1.0.0"));
    expect(onDisk().plugins.installed["org.example.kodi"].versions["1.0.0"].activated).toBe(true);
    expect(await h.activate("org.example.kodi", "1.0.0")).toEqual(ok("1.0.0"));
    expect(kodi(h)!.pending).toBeUndefined();
  });

  it("records another version's activation as pending while one is active, and the active one's cancels it", async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    expect(await h.activate("org.example.kodi", "1.1.0")).toEqual(ok("1.1.0"));
    expect(kodi(h)!.pending).toBe("1.1.0");
    expect(kodi(h)!.versions["1.1.0"]!.activated).toBe(false);
    expect(onDisk().plugins.installed["org.example.kodi"].pending).toBe("1.1.0");
    expect(await h.activate("org.example.kodi", "1.1.0")).toEqual(ok("1.1.0"));
    expect(await h.activate("org.example.kodi", "1.0.0")).toEqual(ok("1.0.0"));
    expect(kodi(h)!.pending).toBeUndefined();
    expect(onDisk().plugins.installed["org.example.kodi"].pending).toBeUndefined();
    expect(kodi(h)!.versions["1.0.0"]!.activated).toBe(true);
  });

  it("activates the pending version again with nothing saved and nothing changed", async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await h.activate("org.example.kodi", "1.1.0");
    const changes = h.world.changes;
    let saves = 0;
    const save = h.world.store.save.bind(h.world.store);
    h.world.store.save = () => { saves += 1; return save(); };
    expect(await h.activate("org.example.kodi", "1.1.0")).toEqual(ok("1.1.0"));
    expect(saves).toBe(0);
    expect(h.world.changes).toBe(changes);
  });

  it("answers failed(state_unsaved) when the activation cannot be kept, leaving it as it was", async () => {
    const h = await two();
    h.world.store.save = () => Promise.reject(new Error("EIO"));
    expect(await h.activate("org.example.kodi", "1.0.0")).toEqual({ status: "failed", reason: "state_unsaved", detail: "EIO" });
    expect(kodi(h)!.versions["1.0.0"]!.activated).toBe(false);
  });
});

describe("a restart", () => {
  /** A host stopped with `r1` accepted and its download stalled; the next one on the same disk, clock and OS. */
  async function cutShort(advanceMs: number) {
    const first = await started();
    server.routes["/slow.tar.gz"] = { body: pkg(), stallAfter: 10 };
    await first.install("r1", { url: server.url("/slow.tar.gz"), sha256: sha256(pkg()) }, "liza");
    await new Promise((r) => setTimeout(r, 30));
    await first.close();
    expect(first.ended()).toEqual([]);
    expect(onDisk().plugins.requests.map((r: { requestId: string }) => r.requestId)).toEqual(["r1"]);
    const { port, clock, accounts } = first.world;
    await clock.advance(advanceMs);
    return { next: () => started({ port, clock, accounts, store: StateStore.load(join(dir, "state")) }) };
  }

  it("resumes an install within its 600 s from the fetch, and ends it installed", async () => {
    const { next } = await cutShort(60_000);
    server.routes["/slow.tar.gz"] = { body: pkg() };
    const h = await next();
    expect(await ending(h, "r1")).toMatchObject({ type: "installed" });
    expect(kodi(h)!.versions["1.0.0"]).toBeDefined();
  });

  it("ends one whose 600 s passed while it was down install_failed(restart) at once, nothing installed", async () => {
    const { next } = await cutShort(INSTALL_MS);
    const h = await next();
    expect(h.ended().map((r) => r.ended)).toEqual([{ type: "install_failed", reason: "restart", detail: "its 600 s passed while the bridge was down" }]);
    expect(h.state.installed).toEqual({});
  });

  it("ends a resumed install that fails restart, naming why", async () => {
    const { next } = await cutShort(60_000);
    server.routes["/slow.tar.gz"] = { body: pkg() };
    const h = await next();
    h.world.accounts.delete("liza");
    expect(await ending(h, "r1")).toEqual({ type: "install_failed", reason: "restart",
      detail: "unknown_account: liza is no account the computer's accounts lists" });
  });

  it("finishes an accepted uninstall before anything else, and removes what no record holds", async () => {
    const first = await started();
    await first.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await ending(first, "r1");
    await first.announced("r1");
    // Accepted, then the bridge stopped before the job ran: the request is on disk, the files still there.
    first.state.requests.push({ requestId: "u1", op: "uninstall", acceptedAt: new Date(first.world.clock.now()).toISOString(), plugin: "org.example.kodi" });
    await first.world.store.save();
    await first.close();
    mkdirSync(join(PLUGINS(), "org.example.stray", "0.1.0"), { recursive: true });
    mkdirSync(join(PLUGINS(), "org.example.kodi", "9.9.9"));
    mkdirSync(join(PLUGINS(), STAGING, "install-cut"));
    const h = host({ port: first.world.port, clock: first.world.clock, store: StateStore.load(join(dir, "state")) });
    await h.start();
    expect(h.ended().map((r) => r.ended)).toEqual([{ type: "uninstalled", plugin: "org.example.kodi" }]);
    expect(h.clears()).toEqual(["org.example.kodi:1.0.0:player", "org.example.kodi:1.0.0:library"]);
    expect(readdirSync(PLUGINS()).sort()).toEqual([STAGING]);
    expect(readdirSync(join(PLUGINS(), STAGING))).toEqual([]);
    expect(first.world.port.rootOnly).toContain(PLUGINS());
  });

  it("keeps an ended request whose event had not gone out, for the next start to send", async () => {
    const first = await started();
    await first.install("r1", offer("/1.tar.gz", pkg()), "liza");
    await ending(first, "r1");
    await first.world.store.flush();
    await first.close();
    const h = await started({ port: first.world.port, clock: first.world.clock, store: StateStore.load(join(dir, "state")) });
    expect(h.ended().map((r) => [r.requestId, r.ended.type])).toEqual([["r1", "installed"]]);
  });
});

describe("servers and the swap", () => {
  const PINNED = { toolHashes: pins(KODI_TOOLS) };
  const ids = (version: string) => [`org.example.kodi:${version}:library`, `org.example.kodi:${version}:player`];

  /** Waits (real time) for what the in-process servers bring about. */
  async function until(ok: () => boolean): Promise<void> {
    for (const end = Date.now() + 10_000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 2));
    expect(ok()).toBe(true);
  }
  const alive = (h: PluginHost & { world: World }, version: string) =>
    h.world.servers.specs.map((s, i) => [s.version, i] as const).filter(([v]) => v === version).map(([, i]) => h.world.servers.started[i]!);
  const exited = async (p: { exited: Promise<unknown> }) => Promise.race([p.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 30))]);

  /** Two versions of the test plugin, pinned to its fixture's tools unless `second` says otherwise. */
  async function two(second: Record<string, unknown> = {}) {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await h.install("r2", offer("/2.tar.gz", pkg({ version: "1.1.0", ...PINNED, ...second })), "liza");
    await ending(h, "r2");
    return h;
  }

  it("starts the activated version's server as its account, in its directory, verified, and has its devices served", async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    expect(h.world.port.servers.map((s) => [s.plugin, s.version, s.osId, s.cwd])).toEqual([
      ["org.example.kodi", "1.0.0", 1000, join(PLUGINS(), "org.example.kodi", "1.0.0")]]);
    expect(h.world.port.servers[0]!.argv).toEqual(["/usr/bin/python3", join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py")]);
    expect(h.view("org.example.kodi", "1.0.0", "player")).toMatchObject({ available: true, values: { playing: false, volume: 40 } });
    // The era it spoke is kept with the version.
    await h.world.store.flush();
    expect(onDisk().plugins.installed["org.example.kodi"].versions["1.0.0"].era).toBe("2026-07-28");
  });

  it("switches over when a later version is activated with none active (M6): the earlier one removed once the later has served", async () => {
    const h = await two();
    expect(await h.activate("org.example.kodi", "1.1.0")).toEqual({ status: "ok", data: { plugin: "org.example.kodi", version: "1.1.0" } });
    expect(kodi(h)!.pending).toBe("1.1.0");
    await until(() => kodi(h)!.pending === undefined);
    expect(h.world.port.servers.map((s) => s.version)).toEqual(["1.1.0"]);
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.1.0"]);
    expect(kodi(h)!.versions["1.1.0"]!.activated).toBe(true);
    expect(kodi(h)!.replaced).toEqual({ version: "1.0.0", keys: ["player", "library"] });
    expect(h.clears()).toEqual(ids("1.0.0").reverse());
    await until(() => !existsSync(join(PLUGINS(), "org.example.kodi", "1.0.0")));
    // No uninstalled: the applier would forget every version of the plugin.
    expect(h.ended().filter((r) => r.ended.type === "uninstalled")).toEqual([]);
    const devices = pluginDevices(h.state);
    expect(devices.map((d) => [d.id, d.stagedFor])).toEqual([
      ["org.example.kodi:1.1.0:library", "org.example.kodi:1.0.0:library"], ["org.example.kodi:1.1.0:player", "org.example.kodi:1.0.0:player"]]);
    await h.world.store.flush();
    expect(onDisk().plugins.installed["org.example.kodi"].replaced).toEqual({ version: "1.0.0", keys: ["player", "library"] });
  });

  it("keeps the old server running until the new one has served, then stops it and removes its version", { timeout: 20_000 }, async () => {
    const h = await two();
    h.world.servers.behaviour = (_n, spec) => ({ tools: KODI_TOOLS, state: kodiState(), ...(spec.version === "1.1.0" ? { readFails: 3 } : {}) });
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    await h.activate("org.example.kodi", "1.1.0");
    await until(() => alive(h, "1.1.0").length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(kodi(h)!.pending).toBe("1.1.0");
    expect(await exited(alive(h, "1.0.0")[0]!)).toBe(false);
    // Both first reads failed; the next one, within 10 s, serves.
    await h.world.clock.advance(10_000);
    await until(() => kodi(h)!.pending === undefined);
    expect(await alive(h, "1.0.0")[0]!.exited).toMatchObject({ signal: "SIGTERM" });
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.1.0"]);
    expect(h.server("org.example.kodi", "1.0.0")).toBeUndefined();
  });

  it("swaps nothing while the new version fails its check, the old one running on", async () => {
    const h = await two({ toolHashes: { ...pins(KODI_TOOLS), pause: "0".repeat(64) } });
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    await h.activate("org.example.kodi", "1.1.0");
    await until(() => h.server("org.example.kodi", "1.1.0")?.phase === "mismatch");
    expect(h.faults().map((f) => [f.code, f.device])).toEqual(ids("1.1.0").map((d) => ["pin_mismatch", d]).reverse());
    await h.world.clock.advance(600_000);
    expect(kodi(h)!.pending).toBe("1.1.0");
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(h.server("org.example.kodi", "1.0.0")?.serving).toBe(true);
    // Kept with the version, so a restart starts no server of it.
    await h.world.store.flush();
    expect(onDisk().plugins.installed["org.example.kodi"].versions["1.1.0"].mismatch).toMatchObject({ detail: expect.stringContaining("tool pause") });
  });

  it("cancels a pending activation on the running version's activate: the new server stopped, never swapped to", async () => {
    const h = await two();
    h.world.servers.behaviour = (_n, spec) => ({ tools: KODI_TOOLS, state: kodiState(), ...(spec.version === "1.1.0" ? { readFails: Infinity } : {}) });
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    await h.activate("org.example.kodi", "1.1.0");
    await until(() => alive(h, "1.1.0").length === 1);
    await h.activate("org.example.kodi", "1.0.0");
    expect(kodi(h)!.pending).toBeUndefined();
    expect(await alive(h, "1.1.0")[0]!.exited).toMatchObject({ signal: "SIGTERM" });
    expect(h.view("org.example.kodi", "1.1.0", "player")).toMatchObject({ available: false });
    h.world.servers.behaviour = () => ({ tools: KODI_TOOLS, state: kodiState() });
    await h.world.clock.advance(600_000);
    expect(alive(h, "1.1.0")).toHaveLength(1);
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(pluginDevices(h.state).find((d) => d.id === "org.example.kodi:1.1.0:player")?.stagedFor).toBe("org.example.kodi:1.0.0:player");
  });

  it("makes a swap whose save failed at a later reconcile, changing nothing meanwhile", async () => {
    const h = await two();
    const save = h.world.store.save.bind(h.world.store);
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    await h.activate("org.example.kodi", "1.1.0");
    h.world.store.save = () => Promise.reject(new Error("EIO"));
    await until(() => h.server("org.example.kodi", "1.1.0")?.serving === true);
    await new Promise((r) => setTimeout(r, 30));
    expect(kodi(h)!.pending).toBe("1.1.0");
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(h.clears()).toEqual([]);
    h.world.store.save = save;
    h.reconcile();
    await until(() => kodi(h)!.pending === undefined);
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.1.0"]);
  });

  /**
   * A tick's reconcile landing just after a reinstall's or an uninstall's stop of the server, before
   * the record changed; gives whether that reconcile made a server of the version again.
   */
  function tickAfterDrop(h: PluginHost): { made: boolean } {
    const seen = { made: false };
    const x = h as unknown as { dropServer: (...a: unknown[]) => Promise<void> };
    const drop = x.dropServer.bind(h);
    x.dropServer = async (...a: unknown[]) => {
      await drop(...a);
      h.reconcile();
      if (h.server("org.example.kodi", "1.0.0")) seen.made = true;
    };
    return seen;
  }

  it("clears a mismatch with a reinstall that verifies, though a tick reconciles while the files are replaced", { timeout: 20_000 }, async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r1");
    writeFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py"), "tampered");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.phase === "mismatch");
    const tick = tickAfterDrop(h);
    await h.install("r3", offer("/1.tar.gz", pkg(PINNED)), "liza");
    expect(await ending(h, "r3")).toMatchObject({ type: "installed" });
    // No server of the record as it was, made while the files were replaced.
    expect(tick.made).toBe(false);
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    expect(h.faults()).toEqual([]);
    expect(kodi(h)!.versions["1.0.0"]!.mismatch).toBeUndefined();
  });

  it("leaves no server and no fault after an uninstall a tick reconciled during, and installs that version again", { timeout: 20_000 }, async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r1");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const tick = tickAfterDrop(h);
    await h.uninstall("u1", "org.example.kodi");
    await ending(h, "u1");
    expect(tick.made).toBe(false);
    h.reconcile();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.server("org.example.kodi", "1.0.0")).toBeUndefined();
    expect(h.faults()).toEqual([]);
    expect(h.world.port.servers).toHaveLength(1);
    await h.install("r2", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r2");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    expect(h.faults()).toEqual([]);
  });

  it("stops and forgets a server whose version is no longer in the record, its faults with it", async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r1");
    writeFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py"), "tampered");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.phase === "mismatch");
    delete h.state.installed["org.example.kodi"];
    h.reconcile();
    expect(h.server("org.example.kodi", "1.0.0")).toBeUndefined();
    expect(h.faults()).toEqual([]);
  });

  it("makes a server of the record as it is once the record was replaced under a running one, after the old one stopped", async () => {
    const h = await started();
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r1");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const first = h.server("org.example.kodi", "1.0.0")!;
    kodi(h)!.versions["1.0.0"] = { ...kodi(h)!.versions["1.0.0"]! };
    h.reconcile();
    await until(() => h.server("org.example.kodi", "1.0.0") !== first && h.server("org.example.kodi", "1.0.0")?.serving === true);
    expect(h.server("org.example.kodi", "1.0.0")!.installed).toBe(kodi(h)!.versions["1.0.0"]);
    expect(await h.world.servers.started[0]!.exited).toMatchObject({ signal: "SIGTERM" });
    expect(h.world.servers.started).toHaveLength(2);
  });

  it("keeps the old version in memory until the swap's save succeeds, and answers its activate from what was kept", { timeout: 20_000 }, async () => {
    const h = await two();
    const save = h.world.store.save.bind(h.world.store);
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    await h.activate("org.example.kodi", "1.1.0");
    let fail: ((e: Error) => void) | undefined;
    h.world.store.save = () => new Promise<void>((_, reject) => { fail = reject; });
    await until(() => fail !== undefined);
    // The swap's save under way: nothing of it in memory yet.
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.0.0", "1.1.0"]);
    expect(kodi(h)!.pending).toBe("1.1.0");
    const answer = h.activate("org.example.kodi", "1.0.0");
    h.world.store.save = save;
    fail!(new Error("EIO"));
    expect(await answer).toEqual({ status: "ok", data: { plugin: "org.example.kodi", version: "1.0.0" } });
    expect(kodi(h)!.pending).toBeUndefined();
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.0.0", "1.1.0"]);
  });

  /**
   * Makes a server process's stop take `ms` longer, as a group slow to exit does; `asked` says
   * whether its stop was asked for, `done` calls back as the stop resolves (the group gone).
   */
  function slowStop(proc: { stop(): Promise<void> }, ms: number, done?: () => void): { asked: boolean } {
    const seen = { asked: false };
    const stop = proc.stop.bind(proc);
    proc.stop = async () => {
      seen.asked = true;
      await new Promise((r) => setTimeout(r, ms));
      await stop();
      done?.();
    };
    return seen;
  }

  it("answers an activate within 1 s while the swap waits for a slow old server to exit, and the swap completes after (GA-BRIDGE-42)", { timeout: 20_000 }, async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const old = slowStop(alive(h, "1.0.0")[0]!, 2500);
    await h.activate("org.example.kodi", "1.1.0");
    await until(() => old.asked);
    const t0 = Date.now();
    // The applier's retry, while the swap stops the old server.
    expect(await h.activate("org.example.kodi", "1.1.0")).toEqual({ status: "ok", data: { plugin: "org.example.kodi", version: "1.1.0" } });
    expect(Date.now() - t0).toBeLessThan(1000);
    await until(() => !existsSync(join(PLUGINS(), "org.example.kodi", "1.0.0")));
    // The swap completed after: the old server gone, and its version with it.
    expect(Date.now() - t0).toBeGreaterThan(2000);
    expect(h.server("org.example.kodi", "1.0.0")).toBeUndefined();
    expect(Object.keys(kodi(h)!.versions)).toEqual(["1.1.0"]);
  });

  it("removes the old version's files only once its server has exited, though a tick in the swap's save stopped it", { timeout: 20_000 }, async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const dir = join(PLUGINS(), "org.example.kodi", "1.0.0");
    const proc = alive(h, "1.0.0")[0]!;
    let filesAtExit: boolean | undefined;
    slowStop(proc, 300, () => { filesAtExit ??= existsSync(dir); });
    // Hold the swap's second save: the second save made while memory shows the swap.
    const save = h.world.store.save.bind(h.world.store);
    let swapped = 0;
    let release: (() => void) | undefined;
    h.world.store.save = () => {
      if (kodi(h)?.versions["1.0.0"] === undefined && ++swapped === 2) {
        const out = save();
        return new Promise<void>((r) => { release = r; }).then(() => out);
      }
      return save();
    };
    await h.activate("org.example.kodi", "1.1.0");
    await until(() => release !== undefined);
    // The bridge's 1 s tick, during that save.
    h.reconcile();
    release!();
    await until(() => !existsSync(dir) && filesAtExit !== undefined);
    // The files were still there when the old server's stop resolved: none removed under it.
    expect(filesAtExit).toBe(true);
  });

  it("gives a device no check-in before its own read, though its server has served", async () => {
    const h = await started({ servers: kodiServers(() => ({ state: { [KODI_PLAYER]: { playing: false, volume: 40 } } })) });
    await h.install("r1", offer("/1.tar.gz", pkg(PINNED)), "liza");
    await ending(h, "r1");
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const now = h.world.clock.now();
    const at = (key: string) => h.observation(`org.example.kodi:1.0.0:${key}`, h.view("org.example.kodi", "1.0.0", key), 5000, now, now);
    // The library's read fails (the server has no such resource): available, as its server has served, but never checked in.
    expect(h.view("org.example.kodi", "1.0.0", "library")).toMatchObject({ available: true });
    expect(at("library")).toMatchObject({ lastCheckIn: null, observable: false });
    expect(at("player")).toMatchObject({ lastCheckIn: now, observable: true });
  });

  it("stops a deleted account's server, never starting it again, its devices unavailable", async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    h.world.retired.add("liza");
    h.reconcile();
    expect(await alive(h, "1.0.0")[0]!.exited).toMatchObject({ signal: "SIGTERM" });
    await until(() => h.view("org.example.kodi", "1.0.0", "player")?.available === false);
    await h.world.clock.advance(600_000);
    h.reconcile();
    expect(h.world.port.servers).toHaveLength(1);
  });

  it("stops the servers before an uninstall removes the files", async () => {
    const h = await two();
    await h.activate("org.example.kodi", "1.0.0");
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    const p = alive(h, "1.0.0")[0]!;
    let filesAtExit: boolean | undefined;
    void p.exited.then(() => { filesAtExit = existsSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py")); });
    await h.uninstall("u1", "org.example.kodi");
    await ending(h, "u1");
    expect(filesAtExit).toBe(true);
    expect(h.server("org.example.kodi", "1.0.0")).toBeUndefined();
  });

  it("starts no server of a version kept mismatched after a restart, and a reinstall that verifies clears it and starts one", { timeout: 20_000 }, async () => {
    const first = await two();
    writeFileSync(join(PLUGINS(), "org.example.kodi", "1.0.0", "server.py"), "tampered");
    await first.activate("org.example.kodi", "1.0.0");
    await until(() => first.server("org.example.kodi", "1.0.0")?.phase === "mismatch");
    expect(first.world.port.servers).toEqual([]);
    await first.world.store.flush();
    await first.close();
    const h = await started({ port: first.world.port, clock: first.world.clock, servers: first.world.servers, store: StateStore.load(join(dir, "state")) });
    const changes = h.world.changes;
    h.reconcile();
    expect(h.faults().map((f) => f.code)).toEqual(["pin_mismatch", "pin_mismatch"]);
    // Told at once, so the next status shows it, not the one after STATUS_MS.
    expect(h.world.changes).toBeGreaterThan(changes);
    expect(h.view("org.example.kodi", "1.0.0", "player")).toMatchObject({ available: false });
    expect(h.world.port.servers).toEqual([]);
    await h.install("r3", offer("/1.tar.gz", pkg(PINNED)), "liza");
    expect(await ending(h, "r3")).toMatchObject({ type: "installed" });
    await until(() => h.server("org.example.kodi", "1.0.0")?.serving === true);
    expect(kodi(h)!.versions["1.0.0"]!.mismatch).toBeUndefined();
    expect(h.faults()).toEqual([]);
  });
});
