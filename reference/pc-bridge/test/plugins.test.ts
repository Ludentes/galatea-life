import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPUTER } from "../src/bridge.js";
import { INSTALL_MS } from "../src/plugins/host.js";
import { BASE, bridge, changedOnDisk, command, faults, own, people, stateDir, useBridges } from "./computer.js";
import type { FakePort, FakeWire } from "./fakes.js";
import { settle } from "./fakes.js";
import { manifest } from "./manifests.js";
import { type Served, serve, sha256, tgz } from "./packages.js";
import { StateStore } from "../src/state-store.js";

useBridges();
let server: Served;
beforeEach(async () => {
  server = await serve();
});
afterEach(async () => {
  await server.close();
});

const PLAYER = "org.example.kodi:1.0.0:player";
const LIBRARY = "org.example.kodi:1.0.0:library";
const RUN = "run-1";

/** liza and John.Doe listed, python3 in /usr/bin. */
function setUp(port: FakePort): void {
  people(port);
  port.files.set("/usr/bin/python3", { executable: true });
}

function pkg(over: Record<string, unknown> = {}): Buffer {
  return tgz([{ name: "manifest.json", body: JSON.stringify(manifest(over)) }, { name: "server.py", body: "print('kodi')" },
    { name: "lib/kodi.py", body: "KODI = 1" }]);
}

function offer(path: string, body = pkg()): { url: string; sha256: string } {
  server.routes[path] = { body };
  return { url: server.url(path), sha256: sha256(body) };
}

const request = (fields: Record<string, unknown>) => ({ requestId: randomUUID(), issuedAt: new Date().toISOString(), ...fields });
const replyTo = (wire: FakeWire, requestId: string) => wire.all(`${BASE}/reply`).map((p) => p.payload).filter((r) => r.requestId === requestId);

/** Delivers a request and waits (real time) for its reply: `accepted` follows a real write of the state file. */
async function ask(wire: FakeWire, op: string, req: Record<string, unknown>): Promise<void> {
  const n = replyTo(wire, req.requestId as string).length;
  await wire.deliver(`${BASE}/request/${op}`, req);
  for (let i = 0; i < 400 && replyTo(wire, req.requestId as string).length === n; i++) await new Promise((r) => setTimeout(r, 5));
}
const events = (wire: FakeWire) => wire.all(`${BASE}/event`).map((p) => p.payload);
const devices = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices as Record<string, any>[];
const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;

/** Waits (real time) for an event of this type naming the request, as a fetch runs on real sockets. */
async function eventFor(wire: FakeWire, type: string, requestId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 400; i++) {
    const e = events(wire).find((x) => x.type === type && x.requestId === requestId);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no ${type} for ${requestId}; events: ${JSON.stringify(events(wire))}`);
}

/** Waits (real time) until the server has been asked `n` paths, as a fetch connects on real sockets. */
async function hits(n: number): Promise<void> {
  for (let i = 0; i < 400 && server.hits.length < n; i++) await new Promise((r) => setTimeout(r, 5));
}

async function install(wire: FakeWire, pkgOffer: { url: string; sha256: string }, over: Record<string, unknown> = {}) {
  const req = request({ host: COMPUTER, package: pkgOffer, account: "liza", ...over });
  await ask(wire, "install", req);
  return req.requestId as string;
}

async function installed(extra: Parameters<typeof bridge>[0] = {}) {
  const b = await bridge({ runId: RUN, before: setUp, ...extra });
  const id = await install(b.wire, offer("/kodi.tar.gz"));
  const ev = await eventFor(b.wire, "installed", id);
  await settle();
  return { ...b, id, ev };
}

describe("install through the bridge", () => {
  it("answers accepted, then publishes devices with the plugin's devices, their statuses, the roster, and installed after them", async () => {
    const { wire } = await bridge({ runId: RUN, before: setUp });
    const id = await install(wire, offer("/kodi.tar.gz"));
    expect(replyTo(wire, id)).toEqual([{ requestId: id, op: "install", status: "accepted" }]);
    const ev = await eventFor(wire, "installed", id);
    expect(ev).toMatchObject({ type: "installed", requestId: id, manifest: manifest() });
    expect(validate("bridge/event.json", ev)).toEqual([]);
    await settle();
    const doc = wire.last(`${BASE}/devices`)!.payload;
    expect(validate("bridge/devices.json", doc)).toEqual([]);
    expect(doc.devices.map((d: { id: string }) => d.id)).toEqual([COMPUTER, LIBRARY, PLAYER]);
    const player = doc.devices[2];
    expect(player).toMatchObject({ host: COMPUTER, plugin: "org.example.kodi", version: "1.0.0", feedback: "closed", reachMs: 0,
      classEvidence: "none", model: { vendor: "org.example.kodi", model: "player" } });
    expect(player.otherAdmins).toEqual([{ vendor: "os", label: "root" }, { vendor: "os", label: "liza" }, { vendor: "kodi", label: "web interface" }]);
    // The event after the devices document that carries the plugin's devices.
    const topics = wire.published.map((p) => `${p.topic} ${JSON.stringify(p.payload).includes(PLAYER)}`);
    expect(topics.indexOf(`${BASE}/devices true`)).toBeLessThan(topics.findIndex((t) => t.startsWith(`${BASE}/event`)));
    const s = wire.last(`${BASE}/devices/${PLAYER}/status`)!;
    expect(s.retain).toBe(true);
    expect(s.payload).toMatchObject({ deviceId: PLAYER, available: false });
    expect(validate("bridge/device-status.json", s.payload)).toEqual([]);
    const st = status(wire);
    expect(validate("bridge/status.json", st)).toEqual([]);
    expect(st.levels).toEqual(["Serve", "Host"]);
    expect(st.devices.map((d: { id: string }) => d.id)).toEqual([COMPUTER, LIBRARY, PLAYER]);
    expect(st.devices[2]).toMatchObject({ basis: "poll", cadenceMs: 5000, basisMaxAgeMs: 15000, observable: false, lastCheckIn: null });
  });

  it("refuses an install for another host, or with a malformed hash, as invalid_request, fetching nothing", async () => {
    const { wire } = await bridge({ runId: RUN, before: setUp });
    const a = await install(wire, offer("/kodi.tar.gz"), { host: "nas" });
    const b = await install(wire, { url: server.url("/kodi.tar.gz"), sha256: "abc" });
    expect(replyTo(wire, a)).toEqual([{ requestId: a, op: "install", status: "invalid_request" }]);
    expect(replyTo(wire, b)).toEqual([{ requestId: b, op: "install", status: "invalid_request" }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.hits).toEqual([]);
  });

  it("fetches no http: package outside a test run", async () => {
    const { wire } = await bridge({ before: setUp });
    const id = await install(wire, offer("/kodi.tar.gz"));
    expect(await eventFor(wire, "install_failed", id)).toMatchObject({ reason: "fetch_failed" });
    expect(server.hits).toEqual([]);
  });

  it("ends install_failed(hash_mismatch) with nothing installed and no plugin device declared", async () => {
    const { wire } = await bridge({ runId: RUN, before: setUp });
    const id = await install(wire, { url: offer("/kodi.tar.gz").url, sha256: "0".repeat(64) });
    const ev = await eventFor(wire, "install_failed", id);
    expect(ev).toMatchObject({ reason: "hash_mismatch" });
    expect(validate("bridge/event.json", ev)).toEqual([]);
    expect(devices(wire).map((d) => d.id)).toEqual([COMPUTER]);
  });

  it("answers a request repeated after the reply window, while in flight, accepted again, fetching once", async () => {
    const { wire, clock, store } = await bridge({ runId: RUN, before: setUp });
    const body = pkg();
    server.routes["/slow.tar.gz"] = { body, stallAfter: 10 };
    const req = request({ host: COMPUTER, package: { url: server.url("/slow.tar.gz"), sha256: sha256(body) }, account: "liza" });
    await ask(wire, "install", req);
    await clock.advance(11_000);
    await ask(wire, "install", req);
    expect(replyTo(wire, req.requestId).map((r) => r.status)).toEqual(["accepted", "accepted"]);
    // One request in the record: a second would be a second job, and a record the next start refuses.
    expect(store.state.plugins!.requests.map((r) => r.requestId)).toEqual([req.requestId]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.hits).toEqual(["/slow.tar.gz"]);
  });

  it("ends an install not ended within 600 s install_failed(timeout)", async () => {
    const { wire, clock } = await bridge({ runId: RUN, before: setUp });
    const body = pkg();
    server.routes["/slow.tar.gz"] = { body, stallAfter: 10 };
    const id = await install(wire, { url: server.url("/slow.tar.gz"), sha256: sha256(body) });
    await clock.advance(INSTALL_MS + 1000);
    expect(await eventFor(wire, "install_failed", id)).toMatchObject({ reason: "timeout" });
  });
});

describe("a plugins directory that cannot be made", () => {
  it("is the fault plugins_unready, the bridge staying online", async () => {
    const { wire } = await bridge({ runId: RUN, before: (port) => {
      setUp(port);
      writeFileSync(join(stateDir(), "blocker"), "");
      port.pluginsPath = join(stateDir(), "blocker", "plugins");
    } });
    expect(status(wire).state).toBe("online");
    expect(faults(wire)).toEqual([expect.objectContaining({ code: "plugins_unready" })]);
    const req = request({ host: COMPUTER, package: offer("/kodi.tar.gz"), account: "liza" });
    await ask(wire, "install", req);
    expect(replyTo(wire, req.requestId)).toEqual([{ requestId: req.requestId, op: "install", status: "failed", reason: "plugins_unready" }]);
  });
});

describe("a restart mid-install", () => {
  it("resumes the install cut short, and ends it installed exactly once", async () => {
    const first = await bridge({ runId: RUN, before: setUp });
    const body = pkg();
    server.routes["/kodi.tar.gz"] = { body, stallAfter: 10 };
    const id = await install(first.wire, { url: server.url("/kodi.tar.gz"), sha256: sha256(body) });
    await new Promise((r) => setTimeout(r, 30));
    own(first.b);
    await first.b.stop();
    server.routes["/kodi.tar.gz"] = { body };
    const { wire } = await bridge({ runId: RUN, before: setUp, store: StateStore.load(stateDir()) });
    expect(await eventFor(wire, "installed", id)).toMatchObject({ requestId: id });
    await settle();
    expect(events(wire).filter((e) => e.requestId === id)).toHaveLength(1);
  });

  it("answers the request repeated after the restart, still in flight, accepted again, fetching nothing more", async () => {
    const first = await bridge({ runId: RUN, before: setUp });
    const body = pkg();
    server.routes["/kodi.tar.gz"] = { body, stallAfter: 10 };
    const req = request({ host: COMPUTER, package: { url: server.url("/kodi.tar.gz"), sha256: sha256(body) }, account: "liza" });
    await ask(first.wire, "install", req);
    // The `accepted` goes out before the fetch connects: stopped sooner, the first fetch never reaches the server.
    await hits(1);
    own(first.b);
    await first.b.stop();
    const { wire, store } = await bridge({ runId: RUN, before: setUp, store: StateStore.load(stateDir()) });
    await hits(2);
    expect(server.hits).toEqual(["/kodi.tar.gz", "/kodi.tar.gz"]);
    await ask(wire, "install", req);
    expect(replyTo(wire, req.requestId)).toEqual([{ requestId: req.requestId, op: "install", status: "accepted" }]);
    expect(store.state.plugins!.requests.map((r) => r.requestId)).toEqual([req.requestId]);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.hits).toEqual(["/kodi.tar.gz", "/kodi.tar.gz"]);
  });

  it("ends one whose 600 s passed while the bridge was down install_failed(restart)", async () => {
    const first = await bridge({ runId: RUN, before: setUp });
    const body = pkg();
    server.routes["/kodi.tar.gz"] = { body, stallAfter: 10 };
    const id = await install(first.wire, { url: server.url("/kodi.tar.gz"), sha256: sha256(body) });
    own(first.b);
    await first.b.stop();
    first.clock.step(INSTALL_MS + 1);
    const { wire } = await bridge({ runId: RUN, before: setUp, clock: first.clock, store: StateStore.load(stateDir()) });
    expect(await eventFor(wire, "install_failed", id)).toMatchObject({ reason: "restart" });
  });
});

describe("uninstall and activate", () => {
  it("uninstalls: devices without the plugin's, their statuses cleared, then uninstalled", async () => {
    const { wire } = await installed();
    const req = request({ host: COMPUTER, plugin: "org.example.kodi" });
    await ask(wire, "uninstall", req);
    expect(replyTo(wire, req.requestId)).toEqual([{ requestId: req.requestId, op: "uninstall", status: "accepted" }]);
    const ev = await eventFor(wire, "uninstalled", req.requestId);
    expect(ev).toMatchObject({ plugin: "org.example.kodi" });
    await settle();
    expect(devices(wire).map((d) => d.id)).toEqual([COMPUTER]);
    const cleared = wire.last(`${BASE}/devices/${PLAYER}/status`)!;
    expect(cleared.payload).toBe("");
    expect(cleared.retain).toBe(true);
    expect(status(wire).devices.map((d: { id: string }) => d.id)).toEqual([COMPUTER]);
  });

  it("clears no status while the devices without it is held back, and clears it after that devices goes out", async () => {
    const { wire, port, clock, store } = await installed();
    const save = store.save.bind(store);
    let failNext = false;
    store.save = () => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("EIO"));
      }
      return save();
    };
    // A new account's token that cannot be written: devices is held back until it is.
    failNext = true;
    port.listed.push({ osId: 1002, name: "olga", primaryGid: 1002 });
    await port.changed();
    await settle();
    const req = request({ host: COMPUTER, plugin: "org.example.kodi" });
    await ask(wire, "uninstall", req);
    await new Promise((r) => setTimeout(r, 50));
    await settle();
    expect(devices(wire).map((d) => d.id)).toContain(PLAYER);
    expect(wire.all(`${BASE}/devices/${PLAYER}/status`).map((p) => p.payload)).not.toContain("");
    await clock.advance(1000);
    await store.flush();
    await eventFor(wire, "uninstalled", req.requestId);
    await settle();
    const topics = wire.published.map((p) => `${p.topic} ${p.payload === "" ? "clear" : JSON.stringify(p.payload).includes(PLAYER)}`);
    const dropped = topics.lastIndexOf(`${BASE}/devices false`);
    expect(dropped).toBeGreaterThan(-1);
    expect(topics.indexOf(`${BASE}/devices/${PLAYER}/status clear`)).toBeGreaterThan(dropped);
  });

  it("keeps an end whose event the broker refused, and sends it when the broker takes it", async () => {
    const { wire, store } = await bridge({ runId: RUN, before: setUp });
    wire.refusePublish = [`${BASE}/event`];
    const id = await install(wire, offer("/kodi.tar.gz"));
    for (let i = 0; i < 400 && !store.state.plugins!.requests[0]?.ended; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(events(wire)).toEqual([]);
    expect(store.state.plugins!.requests.map((r) => r.requestId)).toEqual([id]);
    wire.refusePublish = [];
    await wire.reconnected();
    expect(await eventFor(wire, "installed", id)).toMatchObject({ requestId: id });
    await store.flush();
    expect(store.state.plugins!.requests).toEqual([]);
  });

  it("clears after a restart a status whose uninstall ended while the broker was away", async () => {
    const first = await installed();
    const req = request({ host: COMPUTER, plugin: "org.example.kodi" });
    // The broker goes away as soon as the request is in: the uninstall runs only after its save.
    first.wire.hand(`${BASE}/request/uninstall`, req);
    first.wire.isConnected = false;
    for (let i = 0; i < 400 && !first.store.state.plugins!.requests.find((r) => r.requestId === req.requestId)?.ended; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await first.store.flush();
    expect(first.wire.all(`${BASE}/devices/${PLAYER}/status`).map((p) => p.payload)).not.toContain("");
    own(first.b);
    await first.b.stop();
    const { wire, store } = await bridge({ runId: RUN, before: setUp, store: StateStore.load(stateDir()) });
    await settle();
    const cleared = wire.last(`${BASE}/devices/${PLAYER}/status`)!;
    expect(cleared.payload).toBe("");
    expect(cleared.retain).toBe(true);
    await store.flush();
    expect(store.state.plugins!.clears).toBeUndefined();
  });

  it("tries a refused clear again at the next tick, and forgets it once the broker took it", async () => {
    const { wire, clock, store } = await installed();
    const topic = `${BASE}/devices/${PLAYER}/status`;
    wire.refusePublish = [topic];
    const req = request({ host: COMPUTER, plugin: "org.example.kodi" });
    await ask(wire, "uninstall", req);
    await eventFor(wire, "uninstalled", req.requestId);
    await settle();
    expect(store.state.plugins!.clears).toContain(PLAYER);
    expect(faults(wire)).toContainEqual({ code: "publish_refused", topic });
    wire.refusePublish = [];
    await clock.advance(1000);
    await settle();
    expect(wire.last(topic)!.payload).toBe("");
    await store.flush();
    expect(store.state.plugins!.clears).toBeUndefined();
  });

  it("answers an uninstall of a plugin not installed failed(unknown_plugin)", async () => {
    const { wire } = await bridge({ runId: RUN, before: setUp });
    const req = request({ host: COMPUTER, plugin: "org.example.none" });
    await ask(wire, "uninstall", req);
    expect(replyTo(wire, req.requestId)).toEqual([{ requestId: req.requestId, op: "uninstall", status: "failed", reason: "unknown_plugin" }]);
  });

  it("activates an installed version, ok with the plugin and version, and refuses one not installed", async () => {
    const { wire } = await installed();
    const ok = request({ plugin: "org.example.kodi", version: "1.0.0" });
    const no = request({ plugin: "org.example.kodi", version: "9.9.9" });
    await ask(wire, "activate", ok);
    await ask(wire, "activate", no);
    expect(replyTo(wire, ok.requestId)).toEqual([{ requestId: ok.requestId, op: "activate", status: "ok", data: { plugin: "org.example.kodi", version: "1.0.0" } }]);
    expect(replyTo(wire, no.requestId)).toEqual([{ requestId: no.requestId, op: "activate", status: "failed", reason: "unknown_plugin" }]);
    for (const r of replyTo(wire, ok.requestId)) expect(validate("bridge/reply.json", r)).toEqual([]);
  });
});

describe("commands to a plugin device", () => {
  it("acks a declared action failed(unreachable), no server running, and an undeclared one unsupported", async () => {
    const { wire } = await installed();
    const ack = `${BASE}/devices/${PLAYER}/ack`;
    await wire.deliver(`${BASE}/devices/${PLAYER}/command`, command({ action: "media.pause" }));
    expect(wire.last(ack)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
    await wire.deliver(`${BASE}/devices/${PLAYER}/command`, command({ action: "power.off" }));
    expect(wire.last(ack)!.payload).toMatchObject({ result: "unsupported" });
    expect(validate("bridge/ack.json", wire.last(ack)!.payload)).toEqual([]);
  });

  it("acks a declared extension action failed(unreachable), and an undeclared one unsupported, both valid commands", async () => {
    const { wire } = await installed();
    const ack = `${BASE}/devices/${LIBRARY}/ack`;
    const scan = command({ action: "org.example.library.scan", value: "/media" });
    expect(validate("bridge/command.json", scan)).toEqual([]);
    await wire.deliver(`${BASE}/devices/${LIBRARY}/command`, scan);
    expect(wire.last(ack)!.payload).toMatchObject({ result: "failed", reason: "unreachable" });
    await wire.deliver(`${BASE}/devices/${LIBRARY}/command`, command({ action: "org.example.library.erase" }));
    expect(wire.last(ack)!.payload).toMatchObject({ result: "unsupported" });
  });
});

describe("a plugin's account deleted", () => {
  it("names account_deleted once per device, takes the account out of otherAdmins with one event per device, and refuses a reinstall", async () => {
    const { wire, port, store } = await installed();
    const before = events(wire).length;
    port.listed = port.listed.filter((a) => a.osId !== 1000);
    port.deleted = [1000];
    await changedOnDisk(port, store);
    await settle();
    expect(faults(wire)).toEqual(expect.arrayContaining([
      { code: "account_deleted", device: LIBRARY, detail: "liza's account was deleted" },
      { code: "account_deleted", device: PLAYER, detail: "liza's account was deleted" },
    ]));
    const player = devices(wire).find((d) => d.id === PLAYER)!;
    expect(player.otherAdmins).toEqual([{ vendor: "os", label: "root" }, { vendor: "kodi", label: "web interface" }]);
    const changed = events(wire).slice(before).filter((e) => e.type === "other_admins_changed");
    expect(changed.map((e) => e.device).sort()).toEqual([LIBRARY, PLAYER]);
    // A reinstall, whatever account it names, is version_conflict.
    const id = await install(wire, offer("/kodi.tar.gz"), { account: "u1001" });
    expect(await eventFor(wire, "install_failed", id)).toMatchObject({ reason: "version_conflict" });
  });
});

describe("a plugin that needs a session", () => {
  it("lists its account in the computer's otherAdmins, an other_admins_changed for the computer following", async () => {
    const { wire } = await bridge({ runId: RUN, before: setUp });
    const id = await install(wire, offer("/kodi.tar.gz", pkg({ needsSession: true })));
    await eventFor(wire, "installed", id);
    await settle();
    expect(devices(wire)[0]!.otherAdmins).toEqual([{ vendor: "os", label: "liza" }, { vendor: "os", label: "root" }]);
    expect(events(wire).filter((e) => e.type === "other_admins_changed").map((e) => e.device)).toEqual([COMPUTER]);
  });
});
