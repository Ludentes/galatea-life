import { beforeEach, describe, expect, it } from "vitest";
import { HELPER_STEADY_MS, Helpers } from "../src/helpers.js";
import type { HelperMessage } from "../src/port.js";
import { FakeClock, FakePort, osSession, settle } from "./fakes.js";

describe("Helpers", () => {
  let port: FakePort;
  let clock: FakeClock;
  let helpers: Helpers;
  let refused: string[];
  let changed: number;
  let running: boolean;

  beforeEach(() => {
    port = new FakePort();
    clock = new FakeClock();
    refused = [];
    changed = 0;
    running = true;
    helpers = new Helpers({ port, clock, refused: (d) => refused.push(d), changed: () => { changed += 1; }, running: () => running });
    port.onHelper((m) => helpers.onMessage(m));
    port.sessions = [osSession({ id: "2" }), osSession({ id: "5", graphical: false }), osSession({ id: "7", osId: 1001, seat0Active: false })];
  });

  it("starts one helper in each graphical session, none in an SSH login, and none twice", async () => {
    await helpers.sync(port.sessions);
    await helpers.sync(port.sessions);
    expect(port.asked).toEqual(["startHelper 2", "startHelper 7"]);
  });

  it("stops the helper of a session gone", async () => {
    await helpers.sync(port.sessions);
    await port.helperConnects("2", 11);
    await helpers.sync(port.sessions.filter((s) => s.id !== "2"));
    expect(port.asked).toContain("stopHelper 2");
    expect(helpers.conn("2")).toBeUndefined();
    // The stopped helper's connection closes; its end reaches these helpers, not the next test's.
    await settle();
  });

  it("hears a stopped helper's connection gone, as the OS reports it, and starts nothing for its session", async () => {
    const seen: HelperMessage[] = [];
    port.onHelper((m) => {
      seen.push(m);
      helpers.onMessage(m);
    });
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await helpers.sync(port.sessions.filter((s) => s.id !== "2"));
    await settle();
    expect(seen.at(-1)).toEqual({ kind: "gone", from });
    await clock.advance(60_000);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(1);
  });

  it("binds the helper it started, from its session as its account, and takes its activity", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    expect(helpers.conn("2")).toBe(11);
    expect(helpers.activity("2")).toBeUndefined();
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "idle", app: "firefox" } });
    expect(helpers.activity("2")).toBe("idle");
    expect(helpers.readings("2", ["app", "camera_in_use"])).toEqual({ app: { value: "firefox", at: clock.now() } });
    expect(refused).toEqual([]);
  });

  it.each([
    ["a process of the session it did not start", (pid: number) => ({ conn: 12, pid: pid + 100, osId: 1000, session: "2" }),
      "session 2: pid 600 is no helper the bridge started"],
    ["its helper, from another session", (pid: number) => ({ conn: 12, pid, osId: 1000, session: "7" }),
      "session 7: the helper started in session 2 connected from session 7"],
    ["its helper, from no session", (pid: number) => ({ conn: 12, pid, osId: 1000, session: null }),
      "session none: the helper started in session 2 connected from session none"],
    ["its helper, as another account", (pid: number) => ({ conn: 12, pid, osId: 1001, session: "2" }),
      "session 2: uid 1001 is not the session's account"],
  ])("refuses %s, closing the connection and naming why", async (_name, from, detail) => {
    await helpers.sync(port.sessions);
    await port.helperSays({ kind: "connected", from: from(port.pidOf("2")) });
    expect(port.closedConns).toEqual([12]);
    expect(refused).toEqual([detail]);
    expect(helpers.conn("2")).toBeUndefined();
  });

  it("refuses a second connection from the session's helper, and keeps the first bound when the refused one goes", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "idle" } });
    await port.helperConnects("2", 12);
    expect(port.closedConns).toEqual([12]);
    expect(refused).toEqual(["session 2: a second connection from its helper"]);
    // The OS reports the refused connection gone, from the same pid: the bound helper stays, nothing restarts.
    await settle();
    await clock.advance(60_000);
    expect(helpers.conn("2")).toBe(11);
    expect(helpers.activity("2")).toBe("idle");
    expect(port.asked).toEqual(["startHelper 2", "startHelper 7"]);
  });

  it("binds a helper that connects before its start has resolved", async () => {
    let release!: () => void;
    port.startHeld = new Promise((r) => { release = r; });
    const syncing = helpers.sync(port.sessions);
    await settle();
    await port.helperConnects("2", 11);
    release();
    port.startHeld = undefined;
    await syncing;
    await settle();
    expect(refused).toEqual([]);
    expect(port.closedConns).toEqual([]);
    expect(helpers.conn("2")).toBe(11);
  });

  it("refuses a connection held while its start ran, once the start names another pid", async () => {
    let release!: () => void;
    port.startHeld = new Promise((r) => { release = r; });
    const syncing = helpers.sync(port.sessions);
    await settle();
    await port.helperSays({ kind: "connected", from: { conn: 12, pid: 9999, osId: 1000, session: "2" } });
    expect(refused).toEqual([]);
    release();
    port.startHeld = undefined;
    await syncing;
    await settle();
    expect(port.closedConns).toEqual([12]);
    expect(refused).toEqual(["session 2: pid 9999 is no helper the bridge started"]);
  });

  it("takes activity only as active or idle, anything else reading as none reported", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "idle" } });
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "sleeping" } as never });
    expect(helpers.activity("2")).toBeUndefined();
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: 1 } as never });
    expect(helpers.activity("2")).toBeUndefined();
  });

  it("drops a personal key of the wrong type, and takes the rest of the report", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { camera_in_use: true, app: "vlc" } });
    await port.helperSays({ kind: "report", from, session: "2",
      values: { activity: "active", camera_in_use: "yes", microphone_in_use: false, app: 5, speakers: true } as never });
    expect(helpers.activity("2")).toBe("active");
    expect(helpers.readings("2", ["app", "camera_in_use", "microphone_in_use", "speakers"])).toEqual({
      app: { value: "vlc", at: clock.now() }, camera_in_use: { value: true, at: clock.now() }, microphone_in_use: { value: false, at: clock.now() },
    });
    await port.helperSays({ kind: "report", from, session: "2", values: { app: null } });
    expect(helpers.readings("2", ["app"])).toEqual({ app: { value: null, at: clock.now() } });
  });

  it("ignores and names a report from an unbound connection, and one for another session", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from: { ...from, conn: 99 }, session: "2", values: { activity: "active" } });
    await port.helperSays({ kind: "report", from, session: "7", values: { activity: "active" } });
    expect(helpers.activity("2")).toBeUndefined();
    expect(helpers.activity("7")).toBeUndefined();
    expect(refused).toEqual([
      "session 2: a report from a connection not bound as its helper",
      "session 2: its helper reported for session 7",
    ]);
  });

  it("forgets a helper whose connection went, stops its process, and starts it again after 1 s, then 2 s, 4 s …", async () => {
    await helpers.sync(port.sessions);
    const starts = () => port.asked.filter((a) => a === "startHelper 2").length;
    let conn = 11;
    for (const wait of [1000, 2000, 4000]) {
      const from = await port.helperConnects("2", conn++);
      await port.helperSays({ kind: "report", from, session: "2", values: { activity: "active" } });
      const before = starts();
      const asked = port.asked.length;
      await port.helperSays({ kind: "gone", from });
      expect(port.asked.slice(asked)).toEqual(["stopHelper 2"]);
      expect(helpers.activity("2")).toBeUndefined();
      expect(helpers.conn("2")).toBeUndefined();
      await clock.advance(wait - 1);
      expect(starts()).toBe(before);
      await clock.advance(1);
      expect(starts()).toBe(before + 1);
    }
  });

  it("starts the backoff again from 1 s after a helper that ran steadily", async () => {
    await helpers.sync(port.sessions);
    await port.helperSays({ kind: "gone", from: await port.helperConnects("2", 11) });
    await clock.advance(1000);
    await port.helperSays({ kind: "gone", from: await port.helperConnects("2", 12) });
    await clock.advance(2000);
    const from = await port.helperConnects("2", 13);
    await clock.advance(HELPER_STEADY_MS);
    const before = port.asked.length;
    await port.helperSays({ kind: "gone", from });
    await clock.advance(1000);
    expect(port.asked.slice(before)).toEqual(["stopHelper 2", "startHelper 2"]);
  });

  it("leaves a restart due while the bridge is not running to the next sync", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    running = false;
    await port.helperSays({ kind: "gone", from });
    await clock.advance(60_000);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(1);
    running = true;
    await helpers.sync(port.sessions);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(2);
  });

  it("stops every helper it started, and none after", async () => {
    await helpers.sync(port.sessions);
    await helpers.stopAll();
    await settle();
    expect(port.asked.filter((a) => a.startsWith("stopHelper")).sort()).toEqual(["stopHelper 2", "stopHelper 7"]);
    expect(clock.pending).toBe(0);
  });

  it("starts nothing once stopped, and stops a helper whose start resolves after the stop", async () => {
    let release!: () => void;
    port.startHeld = new Promise((r) => { release = r; });
    const syncing = helpers.sync(port.sessions);
    await settle();
    await helpers.stopAll();
    release();
    port.startHeld = undefined;
    await syncing;
    await settle();
    expect(port.asked.filter((a) => a.startsWith("stopHelper")).sort()).toEqual(["stopHelper 2", "stopHelper 7"]);
    await helpers.sync(port.sessions);
    expect(port.asked.filter((a) => a.startsWith("startHelper"))).toHaveLength(2);
    expect(port.helpers.size).toBe(0);
  });

  it("starts nothing from a sync that was stopping a gone session's helper when the stop came", async () => {
    await helpers.sync(port.sessions);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const stop = port.stopHelper.bind(port);
    // Only the first stop waits: the sync's, of session 2's helper.
    port.stopHelper = async (pid) => {
      port.stopHelper = stop;
      await held;
      return stop(pid);
    };
    const syncing = helpers.sync([...port.sessions.filter((s) => s.id !== "2"), { ...port.sessions[0]!, id: "9" }]);
    await settle();
    await helpers.stopAll();
    release();
    await syncing;
    await settle();
    expect(port.asked).not.toContain("startHelper 9");
  });

  it("tells the bridge when a helper binds, reports or goes", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { camera_in_use: true } });
    await port.helperSays({ kind: "gone", from });
    expect(changed).toBe(3);
  });

  it("starts a helper again after the backoff when its process ended before it connected (plan 4b)", async () => {
    await helpers.sync(port.sessions);
    const starts = () => port.asked.filter((a) => a === "startHelper 2").length;
    await port.helperSays({ kind: "exited", pid: port.pidOf("2") });
    await clock.advance(999);
    expect(starts()).toBe(1);
    await clock.advance(1);
    expect(starts()).toBe(2);
    await port.helperSays({ kind: "exited", pid: port.pidOf("2") });
    await clock.advance(1999);
    expect(starts()).toBe(2);
    await clock.advance(1);
    expect(starts()).toBe(3);
    // Nothing was bound, so nothing changed for the computer's keys.
    expect(changed).toBe(0);
  });

  it("takes a bound helper's exit as its going: its readings dropped, started again after 1 s, its connection's end then naming none", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "report", from, session: "2", values: { activity: "active", camera_in_use: true } });
    const before = changed;
    await port.helperSays({ kind: "exited", pid: from.pid });
    expect(changed).toBe(before + 1);
    expect(helpers.activity("2")).toBeUndefined();
    expect(helpers.conn("2")).toBeUndefined();
    expect(helpers.readings("2", ["camera_in_use"])).toEqual({});
    // The process is gone already: nothing to stop.
    expect(port.asked).not.toContain("stopHelper 2");
    await port.helperSays({ kind: "gone", from });
    expect(changed).toBe(before + 1);
    await clock.advance(1000);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(2);
  });

  it("takes no word of the end of a process it does not hold: one it stopped, or a pid it never started", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "exited", pid: 4242 });
    expect(helpers.conn("2")).toBe(11);
    await helpers.sync(port.sessions.filter((s) => s.id !== "2"));
    await port.helperSays({ kind: "exited", pid: from.pid });
    await clock.advance(60_000);
    expect(port.asked.filter((a) => a === "startHelper 2")).toHaveLength(1);
  });

  it("names what the endpoint could not read as refused, naming the connection's session, and keeps a bound helper bound", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "malformed", from, detail: "Report takes (sa{sv}), not (s)" });
    await port.helperSays({ kind: "malformed", from: { conn: 40, pid: 9, osId: 1001, session: null }, detail: "no method Shutdown" });
    expect(refused).toEqual(["session 2: Report takes (sa{sv}), not (s)", "session none: no method Shutdown"]);
    expect(helpers.conn("2")).toBe(11);
  });

  it("names nothing when a helper's connection is judged after its process ended, and closes it (review M1)", async () => {
    await helpers.sync(port.sessions);
    const pid = port.pidOf("2");
    // The helper called, then ended (a crash, or its connect bound) while the endpoint was identifying it.
    await port.helperSays({ kind: "exited", pid });
    await port.helperSays({ kind: "connected", from: { conn: 12, pid, osId: 1000, session: "2" } });
    expect(refused).toEqual([]);
    expect(port.closedConns).toEqual([12]);
    expect(helpers.conn("2")).toBeUndefined();
    await port.helperSays({ kind: "gone", from: { conn: 12, pid, osId: 1000, session: "2" } });
    // Once its connection has gone, that pid is no helper's: another process given the number is named.
    await port.helperSays({ kind: "connected", from: { conn: 13, pid, osId: 1000, session: "2" } });
    expect(refused).toEqual([`session 2: pid ${pid} is no helper the bridge started`]);
  });

  it("takes no word of a connection gone that is not the bound one", async () => {
    await helpers.sync(port.sessions);
    const from = await port.helperConnects("2", 11);
    await port.helperSays({ kind: "gone", from: { ...from, conn: 99 } });
    await clock.advance(60_000);
    expect(helpers.conn("2")).toBe(11);
    expect(port.asked).toEqual(["startHelper 2", "startHelper 7"]);
  });
});
