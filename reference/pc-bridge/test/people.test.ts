import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import { ADMINS_REREAD_MS, COMPUTER, HELPER_REFUSED_EVERY_MS } from "../src/bridge.js";
import {
  at, BASE, breakable, bridge, changedOnDisk, computer, cstatus, CSTATUS, faults, own, people, starting, stateDir, useBridges,
} from "./computer.js";
import { FakePort, FakeWire, osSession, settle } from "./fakes.js";

useBridges();

describe("the computer's accounts", () => {
  it("declares each interactive account by token, with its OS name as the label, and one key for each", async () => {
    const { wire, clock } = await bridge({ before: people });
    const d = computer(wire);
    expect(validate("bridge/devices.json", wire.last(`${BASE}/devices`)!.payload)).toEqual([]);
    expect(d.accounts).toEqual({ liza: "liza", u1001: "John.Doe" });
    const keys = ["session.liza", "session.u1001", "app", "camera_in_use", "microphone_in_use"];
    expect(d.personal).toEqual(keys);
    expect(d.selfChanging).toEqual(keys);
    const s = cstatus(wire);
    expect(validate("bridge/device-status.json", s)).toEqual([]);
    expect(s).toEqual({ deviceId: COMPUTER, timestamp: at(clock), available: true, "session.liza": "none", "session.u1001": "none",
      timestamps: { "session.liza": at(clock), "session.u1001": at(clock) } });
  });

  it("writes a new token to disk before the devices that carries it goes out", async () => {
    let onDisk: unknown;
    await bridge({ before: (port, wire) => {
      people(port);
      const publish = wire.publish.bind(wire);
      wire.publish = async (topic, payload, retain) => {
        if (topic === `${BASE}/devices`) onDisk = JSON.parse(readFileSync(join(stateDir(), "state.json"), "utf8")).tokens;
        return publish(topic, payload, retain);
      };
    } });
    expect(onDisk).toMatchObject({ accounts: { 1000: { token: "liza" }, 1001: { token: "u1001" } }, given: ["liza", "u1001", "root"] });
  });

  it("holds devices until the token table is on disk, trying the save again 1 s, then 2 s apart, and names state_unsaved meanwhile", async () => {
    const disk = breakable();
    const { wire, clock } = await bridge({ store: disk.store, before: people });
    expect(wire.all(`${BASE}/devices`)).toEqual([]);
    expect(wire.all(CSTATUS)).toEqual([]);
    expect(faults(wire)).toEqual([{ code: "state_unsaved", detail: "ENOSPC: no space left on device" }]);
    await clock.advance(1000);
    expect(wire.all(`${BASE}/devices`)).toEqual([]);
    disk.set(false);
    await clock.advance(1999);
    await disk.store.flush();
    await settle();
    expect(wire.all(`${BASE}/devices`)).toEqual([]);
    await clock.advance(1);
    await disk.store.flush();
    await settle();
    expect(computer(wire).accounts).toEqual({ liza: "liza", u1001: "John.Doe" });
    expect(cstatus(wire)["session.liza"]).toBe("none");
    expect(faults(wire)).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir(), "state.json"), "utf8")).tokens.accounts[1000].token).toBe("liza");
  });

  it("holds a retirement's devices until it is on disk", async () => {
    const disk = breakable();
    disk.set(false);
    const { wire, port, clock } = await bridge({ store: disk.store, before: people });
    const devices = wire.all(`${BASE}/devices`).length;
    disk.set(true);
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    await port.changed();
    expect(wire.all(`${BASE}/devices`)).toHaveLength(devices);
    expect(faults(wire).map((f: { code: string }) => f.code)).toEqual(["state_unsaved"]);
    disk.set(false);
    await clock.advance(1000);
    await disk.store.flush();
    await settle();
    expect(computer(wire).accounts).toEqual({ u1001: "John.Doe" });
    expect(faults(wire)).toEqual([]);
  });

  it("keeps each token across a restart and a rename, and never gives a held name to a new account", async () => {
    const first = await bridge({ before: people });
    own(first.b);
    await first.b.stop();
    const port = new FakePort();
    people(port);
    port.listed[0] = { osId: 1000, name: "elizaveta", primaryGid: 1000 };
    port.listed.push({ osId: 1002, name: "liza", primaryGid: 1002 });
    const { wire } = await bridge({ port });
    expect(computer(wire).accounts).toEqual({ liza: "elizaveta", u1001: "John.Doe", u1002: "liza" });
  });

  it("retires a deleted account's token: its key leaves the retained status and accounts, never to return", async () => {
    const { wire, port, store } = await bridge({ before: people });
    port.listed = port.listed.filter((a) => a.osId !== 1000);
    port.deleted = [1000];
    await changedOnDisk(port, store);
    expect(computer(wire).accounts).toEqual({ u1001: "John.Doe" });
    expect(cstatus(wire)["session.liza"]).toBeUndefined();
    expect(Object.keys(cstatus(wire).timestamps)).toEqual(["session.u1001"]);
    // The same uid made again, and a new account taking the name: neither gets the token back.
    port.deleted = [];
    port.listed.push({ osId: 1000, name: "liza", primaryGid: 1000 }, { osId: 1003, name: "liza", primaryGid: 1003 });
    await changedOnDisk(port, store);
    expect(computer(wire).accounts).toEqual({ u1000: "liza", u1001: "John.Doe", u1003: "liza" });
  });

  it("asks the OS about every account it holds a token for, and retires at start one deleted while it was stopped", async () => {
    const first = await bridge({ before: people });
    own(first.b);
    await first.port.changed();
    expect(first.port.known.at(-1)!.sort()).toEqual([0, 1000, 1001]);
    await first.b.stop();
    const port = new FakePort();
    people(port);
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    const { wire } = await bridge({ port });
    expect(computer(wire).accounts).toEqual({ u1001: "John.Doe" });
  });

  it("retires again after a crash that lost the retirement: the OS is asked afresh, remembering nothing", async () => {
    const first = await bridge({ before: people });
    own(first.b);
    // The retirement is made in memory, and the process dies before it reaches the disk.
    first.store.save = () => new Promise<void>(() => {});
    first.port.listed = first.port.listed.slice(1);
    first.port.deleted = [1000];
    await first.port.changed();
    const port = new FakePort();
    people(port);
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    const { wire } = await bridge({ port });
    expect(computer(wire).accounts).toEqual({ u1001: "John.Doe" });
  });

  it("keeps a lapsed account's token and key: absent from a listing is not deleted", async () => {
    const { wire, port } = await bridge({ before: people });
    const devices = wire.all(`${BASE}/devices`).length;
    port.listed = port.listed.filter((a) => a.osId !== 1000);
    await port.changed();
    expect(computer(wire).accounts).toEqual({ liza: "liza", u1001: "John.Doe" });
    expect(cstatus(wire)["session.liza"]).toBe("none");
    expect(wire.all(`${BASE}/devices`)).toHaveLength(devices);
  });
});

describe("the computer's sessions", () => {
  it("reads each account's key from its sessions at once when the OS reports a change, and the check-in with it", async () => {
    const { wire, clock, port } = await bridge({ before: people });
    await clock.advance(3000);
    port.sessions = [osSession({ id: "2", state: "locked" }), osSession({ id: "5", osId: 1001, graphical: false, idleHint: true })];
    await port.changed();
    expect(cstatus(wire)).toMatchObject({ "session.liza": "locked", "session.u1001": "idle", timestamp: at(clock) });
    expect(cstatus(wire).timestamps).toEqual({ "session.liza": at(clock), "session.u1001": at(clock) });
  });

  it("publishes the computer's status only when a key's value changes", async () => {
    const { wire, clock } = await bridge({ before: people });
    const before = wire.all(CSTATUS).length;
    await clock.advance(30_000);
    expect(wire.all(CSTATUS)).toHaveLength(before);
  });

  it("restamps no key from a failed observation", async () => {
    const { wire, clock, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
    } });
    const read = at(clock);
    await port.helperConnects("2", 11);
    port.observeFails = new Error("logind: no reply");
    await clock.advance(10_000);
    // A value reported now goes out; the session keys keep the time of the read that did happen.
    await port.helperSays({ kind: "report", from: { conn: 11, pid: port.pidOf("2"), osId: 1000, session: "2" }, session: "2",
      values: { activity: "active", camera_in_use: true } });
    const s = cstatus(wire);
    expect(s).toMatchObject({ "session.liza": "active", camera_in_use: true, timestamp: read });
    expect(s.timestamps).toEqual({ "session.liza": read, "session.u1001": read, camera_in_use: at(clock) });
    expect(validate("bridge/device-status.json", s)).toEqual([]);
  });

  it("starts a helper in each graphical session, reads unknown until it reports, then its activity, at once", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession(), osSession({ id: "ssh", graphical: false })];
    } });
    expect(port.asked).toEqual(["startHelper 2"]);
    expect(cstatus(wire)["session.liza"]).toBe("unknown");
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "idle" } });
    expect(cstatus(wire)["session.liza"]).toBe("idle");
  });

  it("takes no helper's word for a session the OS reports locked", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ state: "locked" })];
    } });
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "active" } });
    expect(cstatus(wire)["session.liza"]).toBe("locked");
  });

  it("reads a session unknown once its helper goes, and starts the helper again after 1 s", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
    } });
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "active" } });
    await port.helperSays({ kind: "gone", from });
    expect(cstatus(wire)["session.liza"]).toBe("unknown");
    await clock.advance(1000);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(2);
  });

  it("stops the helper of a session that closed, every helper at its stop, and none at a suspend", async () => {
    const { b, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession(), osSession({ id: "7", osId: 1001, seat0Active: false })];
    } });
    own(b);
    port.sessions = [osSession()];
    await port.changed();
    expect(port.asked).toContain("stopHelper 7");
    await port.emit({ kind: "suspend", announced: true });
    expect(port.asked.filter((a) => a === "stopHelper 2")).toEqual([]);
    await b.stop();
    expect(port.asked.filter((a) => a === "stopHelper 2")).toHaveLength(1);
  });
});

describe("the personal keys", () => {
  async function twoSessions() {
    const r = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" }), osSession({ id: "7", osId: 1001, seat0Active: false, remote: true })];
    } });
    const console = await r.port.helperConnects("2", 11);
    const remote = await r.port.helperConnects("7", 12);
    return { ...r, console, remote };
  }

  it("takes them from the console session's helper alone, and leaves out a key it never reported", async () => {
    const { wire, port, clock, console, remote } = await twoSessions();
    await port.helperSays({ kind: "report", from: remote, session: "7", values: { camera_in_use: true, app: "vlc" } });
    expect(cstatus(wire).camera_in_use).toBeUndefined();
    expect(cstatus(wire).app).toBeUndefined();
    await clock.advance(500);
    await port.helperSays({ kind: "report", from: console, session: "2", values: { microphone_in_use: false, app: null } });
    const s = cstatus(wire);
    expect(s).toMatchObject({ microphone_in_use: false, app: null });
    expect(s.camera_in_use).toBeUndefined();
    expect(s.timestamps.app).toBe(at(clock));
  });

  it("follows the console to another session", async () => {
    const { wire, port, remote } = await twoSessions();
    await port.helperSays({ kind: "report", from: remote, session: "7", values: { camera_in_use: true } });
    port.sessions = [osSession({ id: "2", seat0Active: false }), osSession({ id: "7", osId: 1001, seat0Active: true })];
    await port.changed();
    expect(cstatus(wire).camera_in_use).toBe(true);
  });
});

describe("the helper binding", () => {
  it("publishes nothing of the computer before start's devices, though a helper binds while the administrators are read", async () => {
    let release!: () => void;
    const r = starting({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.adminsHeld = new Promise((x) => { release = x; });
    } });
    // The start waits on the administrators, the tokens on disk: nothing but the gate holds the computer back.
    while (r.port.adminsReads === 0) await settle();
    await r.store.flush();
    await settle();
    const from = await r.port.helperConnects("2", 11);
    await r.port.helperSays({ kind: "report", from, session: "2", values: { activity: "active" } });
    expect(r.wire.all(`${BASE}/devices`)).toEqual([]);
    expect(r.wire.all(CSTATUS)).toEqual([]);
    release();
    r.port.adminsHeld = undefined;
    await r.started;
    const topics = r.wire.published.map((p) => p.topic).filter((t) => t === `${BASE}/devices` || t === CSTATUS);
    expect(topics[0]).toBe(`${BASE}/devices`);
    expect(cstatus(r.wire)["session.liza"]).toBe("active");
  });

  it("refuses a forged helper and names it on the computer, one entry with the latest detail, kept", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" }), osSession({ id: "7", osId: 1001, seat0Active: false })];
    } });
    const helper = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "connected", from: { conn: 20, pid: 9999, osId: 1000, session: "2" } });
    expect(port.closedConns).toEqual([20]);
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session 2: pid 9999 is no helper the bridge started" }]);
    await port.helperSays({ kind: "report", from: helper, session: "7", values: { activity: "active" } });
    expect(cstatus(wire)["session.u1001"]).toBe("unknown");
    // A second refusal within HELPER_REFUSED_EVERY_MS is named when the bound has passed (review M2).
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session 2: pid 9999 is no helper the bridge started" }]);
    await clock.advance(HELPER_REFUSED_EVERY_MS);
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session 2: its helper reported for session 7" }]);
    expect(validate("bridge/status.json", wire.last(`${BASE}/status`)!.payload)).toEqual([]);
    await clock.advance(60_000);
    expect(faults(wire)).toHaveLength(1);
  });

  it("republishes the computer's status for refusals at most once each bound, however many come (review M2)", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" })];
    } });
    await port.helperConnects("2", 11);
    const statuses = () => wire.published.filter((m) => m.topic === `${BASE}/status`).length;
    const before = statuses();
    // Any account: connect, Hello, leave, again and again, each from a new pid.
    for (let i = 0; i < 50; i++) await port.helperSays({ kind: "connected", from: { conn: 100 + i, pid: 20_000 + i, osId: 1001, session: null } });
    expect(statuses()).toBe(before + 1);
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session none: pid 20000 is no helper the bridge started" }]);
    await clock.advance(HELPER_REFUSED_EVERY_MS);
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session none: pid 20049 is no helper the bridge started" }]);
    // The next burst, a bound after that naming, changes the status once again, at once.
    await clock.advance(HELPER_REFUSED_EVERY_MS);
    const next = statuses();
    for (let i = 0; i < 50; i++) await port.helperSays({ kind: "connected", from: { conn: 200 + i, pid: 30_000 + i, osId: 1001, session: null } });
    expect(statuses()).toBe(next + 1);
  });

  it("names a message the endpoint could not read on the computer, a fault and never an exit (plan 4b)", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" })];
    } });
    const helper = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from: helper, session: "2", values: { activity: "active" } });
    await port.helperSays({ kind: "malformed", from: helper, detail: "Report takes (sa{sv}), not (s)" });
    expect(faults(wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session 2: Report takes (sa{sv}), not (s)" }]);
    expect(cstatus(wire)["session.liza"]).toBe("active");
    expect(validate("bridge/status.json", wire.last(`${BASE}/status`)!.payload)).toEqual([]);
  });
});

describe("the administrators", () => {
  const events = (wire: FakeWire) => wire.all(`${BASE}/event`);

  it("declares root alone on a machine with no other, and no event for the first set", async () => {
    const { wire } = await bridge({ before: people });
    expect(computer(wire).otherAdmins).toEqual([{ vendor: "os", label: "root" }]);
    expect(events(wire)).toEqual([]);
  });

  it("on a change the OS reports: devices again, then other_admins_changed, seq from 1, not retained", async () => {
    const { wire, port, b } = await bridge({ before: people });
    port.facts.groups = [{ name: "sudo", gid: 27, members: [{ osId: 1001, name: "John.Doe" }] }];
    const mark = wire.calls.length;
    await port.adminsChanged();
    expect(wire.calls.slice(mark)).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/event`]);
    expect(computer(wire).otherAdmins).toEqual([{ vendor: "os", label: "root" }, { vendor: "os", label: "u1001" }]);
    const e = events(wire)[0]!;
    expect(e.retain).toBe(false);
    expect(e.payload).toEqual({ seq: 1, instanceId: e.payload.instanceId, type: "other_admins_changed", device: COMPUTER });
    expect(validate("bridge/event.json", e.payload)).toEqual([]);
    port.facts.groups = [];
    await port.adminsChanged();
    expect(events(wire).map((x) => x.payload.seq)).toEqual([1, 2]);
    await port.adminsChanged();
    expect(events(wire)).toHaveLength(2);
    expect(b).toBeDefined();
  });

  it("sends a change read while the broker was away after the reconnection, the devices that carries it first", async () => {
    const { wire, port } = await bridge({ before: people });
    wire.isConnected = false;
    port.facts.groups = [{ name: "sudo", gid: 27, members: [{ osId: 1001, name: "John.Doe" }] }];
    await port.adminsChanged();
    expect(events(wire)).toEqual([]);
    wire.isConnected = true;
    const mark = wire.calls.length;
    await wire.reconnected();
    const out = wire.calls.slice(mark).filter((c) => c === `publish ${BASE}/devices` || c === `publish ${BASE}/event`);
    expect(out).toEqual([`publish ${BASE}/devices`, `publish ${BASE}/event`]);
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["root", "u1001"]);
    expect(events(wire)).toHaveLength(1);
  });

  it("reads the administrators again when an account it names is deleted, so its retired token leaves them", async () => {
    const { wire, port, store } = await bridge({ before: (p) => {
      people(p);
      p.facts.sudo = [{ osId: 1000, name: "liza", root: "yes" }];
    } });
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["liza", "root"]);
    const reads = port.adminsReads;
    // The OS deletes the account, and with it its sudo rule; it reports the account, not the administrators.
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    port.facts.sudo = [];
    await changedOnDisk(port, store);
    await settle();
    expect(port.adminsReads).toBe(reads + 1);
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["root"]);
    expect(events(wire)).toHaveLength(1);
  });

  it("does not read the administrators again when a retired token is none of them", async () => {
    const { port, store } = await bridge({ before: people });
    const reads = port.adminsReads;
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    await changedOnDisk(port, store);
    expect(port.adminsReads).toBe(reads);
  });

  it("finds a change the OS did not report within 24 h of its clock", async () => {
    const { wire, port, clock } = await bridge({ before: people });
    port.facts.sudo = [{ osId: 1000, name: "liza", root: "yes" }];
    await clock.leap(ADMINS_REREAD_MS - 1000);
    expect(events(wire)).toEqual([]);
    await clock.advance(1000);
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["liza", "root"]);
    expect(events(wire)).toHaveLength(1);
  });

  it("keeps the last set and adds unknown when a read fails, naming the failure, and clears it on the next read", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.facts.groups = [{ name: "wheel", gid: 10, members: [{ osId: 1000, name: "liza" }] }];
    } });
    port.adminsFail = new Error("sudo: timed out");
    await port.adminsChanged();
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["liza", "root", "unknown"]);
    expect(faults(wire)).toEqual([{ code: "admins_unread", device: COMPUTER, detail: "sudo: timed out" }]);
    expect(wire.last(`${BASE}/status`)!.payload.state).toBe("online");
    port.adminsFail = undefined;
    await port.adminsChanged();
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["liza", "root"]);
    expect(faults(wire)).toEqual([]);
    expect(events(wire)).toHaveLength(2);
  });

  it("gives root and unknown when the first read ever fails", async () => {
    const { wire } = await bridge({ before: (p) => {
      people(p);
      p.adminsFail = new Error("polkit: unreadable");
    } });
    expect(computer(wire).otherAdmins).toEqual([{ vendor: "os", label: "root" }, { vendor: "os", label: "unknown" }]);
    expect(faults(wire)).toEqual([{ code: "admins_unread", device: COMPUTER, detail: "polkit: unreadable" }]);
  });

  it("keeps the set across a restart: one that changed meanwhile is an event at the start, the same one none", async () => {
    const first = await bridge({ before: people });
    own(first.b);
    await first.b.stop();
    const port = new FakePort();
    people(port);
    port.facts.groups = [{ name: "docker", gid: 999, members: [{ osId: 1000, name: "liza" }] }];
    const second = await bridge({ port });
    expect(events(second.wire).map((e) => e.payload)).toEqual([
      { seq: 1, instanceId: events(second.wire)[0]!.payload.instanceId, type: "other_admins_changed", device: COMPUTER },
    ]);
    own(second.b);
    await second.b.stop();
    const third = await bridge({ port });
    expect(events(third.wire)).toEqual([]);
    expect(computer(third.wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["liza", "root"]);
  });

  it("proposes infrastructure when the broker is on this machine, and nothing otherwise", async () => {
    const own = await bridge({ brokerHost: "127.0.0.1", before: (p) => { p.own = true; } });
    expect(own.port.asked).toEqual(["isOwnAddress 127.0.0.1"]);
    expect(computer(own.wire).proposedInfrastructure).toBe(true);
    const other = await bridge({ brokerHost: "broker.lan" });
    expect(computer(other.wire).proposedInfrastructure).toBeUndefined();
  });
});

describe("the start gate", () => {
  const out = (wire: FakeWire) => wire.published.map((p) => p.topic).filter((t) => t !== `${BASE}/lwt`);

  it("publishes nothing before start's devices, though the OS reports an administrators' change while they are read", async () => {
    // A set kept from the last run, so that a re-read's change is a change.
    const first = await bridge({ before: people });
    own(first.b);
    await first.b.stop();
    let release!: () => void;
    const held = new Promise<void>((x) => { release = x; });
    let reads = 0;
    const r = starting({ before: (p) => {
      people(p);
      // The start's read waits and gets the kept set; the re-read the OS asks for meanwhile answers at once, changed.
      const read = p.admins.bind(p);
      p.admins = async () => {
        const mine = ++reads;
        if (mine === 1) await held;
        const facts = await read();
        if (mine > 1) facts.groups = [{ name: "sudo", gid: 27, members: [{ osId: 1001, name: "John.Doe" }] }];
        return facts;
      };
    } });
    while (reads === 0) await settle();
    await r.port.adminsChanged();
    release();
    await r.started;
    await settle();
    expect(out(r.wire)[0]).toBe(`${BASE}/devices`);
    // The change's event follows the devices that carries it.
    expect(r.wire.all(`${BASE}/event`)).toHaveLength(1);
    const carried = r.wire.published.findIndex((p) => p.topic === `${BASE}/devices`
      && p.payload.devices[0].otherAdmins.some((a: { label: string }) => a.label === "u1001"));
    expect(carried).toBeGreaterThanOrEqual(0);
    expect(carried).toBeLessThan(r.wire.published.findIndex((p) => p.topic === `${BASE}/event`));
  });

  it("publishes no status for a helper refused during the start before start's devices", async () => {
    let release!: () => void;
    const r = starting({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.adminsHeld = new Promise((x) => { release = x; });
    } });
    while (r.port.adminsReads === 0) await settle();
    await r.port.helperSays({ kind: "connected", from: { conn: 20, pid: 9999, osId: 1000, session: "2" } });
    expect(r.port.closedConns).toEqual([20]);
    expect(out(r.wire)).toEqual([]);
    release();
    r.port.adminsHeld = undefined;
    await r.started;
    await settle();
    expect(out(r.wire)[0]).toBe(`${BASE}/devices`);
    expect(faults(r.wire)).toEqual([{ code: "helper_refused", device: COMPUTER, detail: "session 2: pid 9999 is no helper the bridge started" }]);
  });

  it("holds an administrators' event while the token table is not on disk, and sends it after the devices that carries it", async () => {
    const disk = breakable();
    const { wire, port, clock } = await bridge({ store: disk.store, before: people });
    port.facts.groups = [{ name: "sudo", gid: 27, members: [{ osId: 1001, name: "John.Doe" }] }];
    await port.adminsChanged();
    expect(wire.all(`${BASE}/event`)).toEqual([]);
    expect(wire.all(`${BASE}/devices`)).toEqual([]);
    disk.set(false);
    await clock.advance(1000);
    await disk.store.flush();
    await settle();
    const topics = wire.published.map((p) => p.topic);
    const devices = topics.indexOf(`${BASE}/devices`);
    expect(devices).toBeGreaterThanOrEqual(0);
    expect(computer(wire).otherAdmins.map((a: { label: string }) => a.label)).toEqual(["root", "u1001"]);
    expect(wire.all(`${BASE}/event`)).toHaveLength(1);
    expect(topics.indexOf(`${BASE}/event`)).toBeGreaterThan(devices);
  });
});

describe("a helper's launcher that never answers", () => {
  it("holds up neither the start nor the check-ins", async () => {
    const { wire, clock, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.startHeld = new Promise(() => {});
    } });
    expect(port.asked).toContain("startHelper 2");
    const observations = port.observations;
    await clock.advance(30_000);
    expect(port.observations).toBeGreaterThan(observations);
    const status = wire.last(`${BASE}/status`)!.payload;
    // Checked in within the last cadence, not only at the start.
    expect(Date.parse(status.devices[0].lastCheckIn)).toBeGreaterThanOrEqual(clock.now() - 10_000);
    expect(status.devices[0].observable).toBe(true);
  });
});
