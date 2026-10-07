import { describe, expect, it } from "vitest";
import { classify, Logind, MATCH_RULES, toOsSessions } from "../src/linux/logind.js";
import {
  FakeBusError, FakeLogindBus, LOGIND_OWNER, logindOwnerChanged, prepareForShutdown, prepareForSleep, sessionChanged,
} from "./linux-fakes.js";

/** A desktop: GDM's greeter, liza's session at the console, dima over SSH, and systemd 256's manager session. */
function desktop(): FakeLogindBus {
  const bus = new FakeLogindBus();
  bus.sessions = [
    { id: "c1", uid: 120, class: "greeter", type: "wayland", seat: "seat0", state: "online" },
    { id: "2", uid: 1000, type: "wayland", seat: "seat0", state: "active", timestampUs: 1_790_000_000_123_456n },
    { id: "5", uid: 1001, type: "tty", remote: true, idleHint: true },
    { id: "3", uid: 1000, class: "manager", type: "unspecified" },
  ];
  bus.seat0Active = "2";
  return bus;
}

describe("Logind.read and toOsSessions", () => {
  it("gives a person's sessions with the properties the design lists, the greeter and the manager left out", async () => {
    const sessions = toOsSessions(await new Logind(desktop()).read());
    expect(sessions).toEqual([
      { id: "2", osId: 1000, graphical: true, remote: false, seat0Active: true, state: "active", idleHint: false, startedAt: 1_790_000_000_123 },
      { id: "5", osId: 1001, graphical: false, remote: true, seat0Active: false, state: "active", idleHint: true, startedAt: 1_790_000_000_000 },
    ]);
  });

  it("reads LockedHint as locked, a graphical session in the background of its seat as disconnected, and a closing one as gone", async () => {
    const bus = new FakeLogindBus();
    bus.sessions = [
      { id: "2", uid: 1000, type: "x11", seat: "seat0", lockedHint: true },
      { id: "4", uid: 1001, type: "wayland", seat: "seat0", state: "online" },
      { id: "6", uid: 1002, type: "tty", state: "closing" },
      { id: "7", uid: 1003, type: "mir", class: "user-early" },
    ];
    bus.seat0Active = "7";
    const s = toOsSessions(await new Logind(bus).read());
    expect(s.map((x) => [x.id, x.state, x.graphical, x.seat0Active])).toEqual([
      ["2", "locked", true, false],
      ["4", "disconnected", true, false],
      ["7", "active", true, true],
    ]);
  });

  it("leaves out a session that closed between the list and its read", async () => {
    const bus = desktop();
    const logind = new Logind(bus);
    const original = bus.call.bind(bus);
    bus.call = async (d, p, i, m, s, b) => {
      if (m === "GetAll" && p.endsWith("_35")) throw new FakeBusError("org.freedesktop.DBus.Error.UnknownObject", `Unknown object '${p}'.`);
      return original(d, p, i, m, s, b);
    };
    expect(toOsSessions(await logind.read()).map((s) => s.id)).toEqual(["2"]);
  });

  it("gives no console session on a machine with no seat0, or none active on it", async () => {
    const bus = desktop();
    bus.hasSeat0 = false;
    expect((await new Logind(bus).read()).seat0Active).toBe(null);
    bus.hasSeat0 = true;
    bus.seat0Active = "";
    expect((await new Logind(bus).read()).seat0Active).toBe(null);
  });

  it("fails the read on any other error: the observation fails, no check-in", async () => {
    const bus = desktop();
    bus.failing.set("ListSessions", new FakeBusError("org.freedesktop.DBus.Error.AccessDenied", "denied"));
    await expect(new Logind(bus).read()).rejects.toThrow(/denied/);
    const other = desktop();
    other.failing.set("GetAll", new FakeBusError("org.freedesktop.DBus.Error.NoReply", "no reply"));
    await expect(new Logind(other).read()).rejects.toThrow(/no reply/);
  });
});

describe("Logind's other calls", () => {
  it("asks whether logind is on the bus", async () => {
    const bus = desktop();
    expect(await new Logind(bus).present()).toBe(true);
    bus.logindPresent = false;
    expect(await new Logind(bus).present()).toBe(false);
  });

  it("asks the bus for logind's signals and its arrival or loss", async () => {
    const bus = desktop();
    await new Logind(bus).watch();
    expect(bus.matches).toEqual([...MATCH_RULES]);
    expect(bus.matches).toEqual([
      "type='signal',sender='org.freedesktop.login1'",
      "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.login1'",
    ]);
  });

  it("suspends through Suspend(false), never interactive", async () => {
    const bus = desktop();
    await new Logind(bus).suspend();
    expect(bus.calls).toEqual(["org.freedesktop.login1.Manager.Suspend /org/freedesktop/login1 [false]"]);
  });

  it("reads ScheduledShutdown: nothing scheduled as systemd 255 and 257 give it, and a poweroff scheduled", async () => {
    const bus = desktop();
    const logind = new Logind(bus);
    expect(await logind.scheduledShutdown()).toBe(false);
    bus.scheduled = ["", 0n];
    expect(await logind.scheduledShutdown()).toBe(false);
    bus.scheduled = ["poweroff", 1_790_000_120_000_000n];
    expect(await logind.scheduledShutdown()).toBe(true);
  });
});

describe("classify", () => {
  it("tells power announcements, changes and logind's presence apart, and ignores the rest", () => {
    expect(classify(prepareForSleep(true))).toEqual({ kind: "sleep", start: true });
    expect(classify(prepareForSleep(false))).toEqual({ kind: "sleep", start: false });
    expect(classify(prepareForShutdown(true))).toEqual({ kind: "shutdown", start: true });
    expect(classify(sessionChanged("2"))).toEqual({ kind: "changed" });
    const manager = { path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager" };
    expect(classify({ ...manager, member: "SessionNew", body: ["7", "/org/freedesktop/login1/session/_37"] })).toEqual({ kind: "changed" });
    expect(classify({ ...manager, member: "SessionRemoved", body: ["7", "/org/freedesktop/login1/session/_37"] })).toEqual({ kind: "changed" });
    expect(classify({ path: "/org/freedesktop/login1/seat/seat0", interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", body: [] }))
      .toEqual({ kind: "changed" });
    expect(classify({ path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", body: ["org.freedesktop.login1", ":1.5", ""] }))
      .toEqual({ kind: "presence" });
    expect(classify({ path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", body: [":1.99", ":1.99", ""] }))
      .toBeUndefined();
    // The manager's own properties (its IdleHint, ScheduledShutdown) are no observation.
    expect(classify({ path: "/org/freedesktop/login1", interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged", body: [] })).toBeUndefined();
  });
});

describe("Logind.accept: only logind's own signals, and the bus daemon's word on who logind is (review C1)", () => {
  async function watched() {
    const bus = desktop();
    const logind = new Logind(bus);
    await logind.watch();
    return { bus, logind };
  }

  it("learns logind's unique name when it starts watching", async () => {
    const { logind } = await watched();
    expect(logind.owner).toBe(LOGIND_OWNER);
  });

  it("acts on logind's signals from logind's unique name", async () => {
    const { logind } = await watched();
    expect(logind.accept(prepareForShutdown(true))).toEqual({ kind: "shutdown", start: true });
    expect(logind.accept(prepareForSleep(true))).toEqual({ kind: "sleep", start: true });
    expect(logind.accept(sessionChanged("2"))).toEqual({ kind: "changed" });
  });

  it("ignores the same signals sent by any other connection, as any local account may send them", async () => {
    const { logind } = await watched();
    expect(logind.accept(prepareForShutdown(true, ":1.99"))).toBeUndefined();
    expect(logind.accept(prepareForSleep(true, ":1.99"))).toBeUndefined();
    expect(logind.accept(prepareForSleep(false, ":1.99"))).toBeUndefined();
    expect(logind.accept(sessionChanged("2", ":1.99"))).toBeUndefined();
    // Even one claiming logind's well-known name: the bus daemon stamps the unique name.
    expect(logind.accept(prepareForShutdown(true, "org.freedesktop.login1"))).toBeUndefined();
  });

  it("takes logind's arrival or loss only from the bus daemon, and follows the new owner", async () => {
    const { logind } = await watched();
    expect(logind.accept(logindOwnerChanged(LOGIND_OWNER, "", ":1.99"))).toBeUndefined();
    expect(logind.owner).toBe(LOGIND_OWNER);
    expect(logind.accept(logindOwnerChanged(LOGIND_OWNER, ""))).toEqual({ kind: "presence" });
    expect(logind.owner).toBeNull();
    expect(logind.accept(prepareForShutdown(true))).toBeUndefined();
    expect(logind.accept(logindOwnerChanged("", ":1.42"))).toEqual({ kind: "presence" });
    expect(logind.owner).toBe(":1.42");
    expect(logind.accept(prepareForShutdown(true))).toBeUndefined();
    expect(logind.accept(prepareForShutdown(true, ":1.42"))).toEqual({ kind: "shutdown", start: true });
  });

  it("never lets GetNameOwner's reply overwrite an owner a NameOwnerChanged gave meanwhile (review N3)", async () => {
    // logind leaves as its owner is asked: the reply (still :1.5) and the loss come in one read.
    const gone = desktop();
    const lost = new Logind(gone);
    gone.onReply = () => {
      gone.onReply = undefined;
      gone.logindPresent = false;
      expect(lost.accept(logindOwnerChanged(LOGIND_OWNER, ""))).toEqual({ kind: "presence" });
    };
    expect(await lost.present()).toBe(false);
    expect(lost.owner).toBeNull();
    expect(lost.accept(prepareForSleep(true))).toBeUndefined();
    // logind restarts as its owner is asked: the new owner stands, the old one's signals are not taken.
    const moved = desktop();
    const logind = new Logind(moved);
    moved.onReply = () => {
      moved.onReply = undefined;
      moved.logindOwner = ":1.42";
      logind.accept(logindOwnerChanged(LOGIND_OWNER, ":1.42"));
    };
    expect(await logind.present()).toBe(true);
    expect(logind.owner).toBe(":1.42");
    expect(logind.accept(prepareForSleep(true))).toBeUndefined();
    // Nothing meanwhile: the reply is the owner.
    const still = desktop();
    const quiet = new Logind(still);
    expect(await quiet.present()).toBe(true);
    expect(quiet.owner).toBe(LOGIND_OWNER);
  });

  it("reads whether logind is still preparing for a sleep or a shutdown, from its own properties (review N4)", async () => {
    const bus = desktop();
    const logind = new Logind(bus);
    expect(await logind.preparing()).toBe(false);
    bus.preparingForShutdown = true;
    expect(await logind.preparing()).toBe(true);
    bus.preparingForShutdown = false;
    bus.preparingForSleep = true;
    expect(await logind.preparing()).toBe(true);
    expect(bus.calls.filter((c) => /PreparingFor/.test(c)).every((c) => c.startsWith("org.freedesktop.DBus.Properties.Get /org/freedesktop/login1 "))).toBe(true);
  });

  it("has no owner, and accepts nothing of logind's, while logind is not on the bus", async () => {
    const bus = desktop();
    bus.logindPresent = false;
    const logind = new Logind(bus);
    await logind.watch();
    expect(logind.owner).toBeNull();
    expect(await logind.present()).toBe(false);
    expect(logind.accept(prepareForSleep(true))).toBeUndefined();
  });

  it("puts a sender in every match rule", () => {
    for (const rule of MATCH_RULES) expect(rule).toMatch(/sender='[^']+'/);
  });
});
