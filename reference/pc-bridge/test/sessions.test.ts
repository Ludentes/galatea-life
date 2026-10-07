import { describe, expect, it } from "vitest";
import type { OsSession } from "../src/port.js";
import { accountState, readSession, sessionKeys } from "../src/sessions.js";

const session = (over: Partial<OsSession> = {}): OsSession => ({
  id: "2", osId: 1000, graphical: true, remote: false, seat0Active: true, state: "active", idleHint: false, startedAt: 0, ...over,
});
const none = () => undefined;

describe("readSession", () => {
  it.each([
    ["the OS's lock, whatever the helper says", session({ state: "locked" }), "active", "locked"],
    ["the OS's disconnect, whatever the helper says", session({ state: "disconnected" }), "active", "disconnected"],
    ["a graphical session with no helper", session(), undefined, "unknown"],
    ["a graphical session its helper reads active", session(), "active", "active"],
    ["a graphical session its helper reads idle", session(), "idle", "idle"],
    ["an SSH login, not idle, with no helper", session({ graphical: false }), undefined, "active"],
    ["an SSH login the OS reports idle", session({ graphical: false, idleHint: true }), undefined, "idle"],
    ["an SSH login locked by the OS", session({ graphical: false, state: "locked" }), undefined, "locked"],
  ] as const)("reads %s", (_name, s, activity, expected) => {
    expect(readSession(s, activity)).toBe(expected);
  });
});

describe("accountState", () => {
  it("reads none with no session", () => {
    expect(accountState([], none)).toBe("none");
  });

  it("takes the most in-use session: locked at the console and active over Remote Desktop reads active", () => {
    const sessions = [session({ id: "c", state: "locked" }), session({ id: "rdp", remote: true, seat0Active: false })];
    expect(accountState(sessions, (id) => (id === "rdp" ? "active" : undefined))).toBe("active");
  });

  it("prefers unknown to locked, and locked to disconnected", () => {
    expect(accountState([session({ id: "a", state: "locked" }), session({ id: "b" })], none)).toBe("unknown");
    expect(accountState([session({ id: "a", state: "locked" }), session({ id: "b", state: "disconnected" })], none)).toBe("locked");
  });

  it("keys an account with a graphical session by its graphical sessions alone: a lock reads locked beside an SSH login", () => {
    expect(accountState([session({ state: "locked" }), session({ id: "ssh", graphical: false })], none)).toBe("locked");
  });

  it("reads an account on SSH alone from the OS: active, or idle", () => {
    expect(accountState([session({ graphical: false })], none)).toBe("active");
    expect(accountState([session({ graphical: false, idleHint: true })], none)).toBe("idle");
  });
});

describe("sessionKeys", () => {
  it("gives every interactive account a key, none with no session, and ignores other accounts' sessions", () => {
    const keys = sessionKeys(
      [{ osId: 1000, token: "liza" }, { osId: 1001, token: "u1001" }],
      [session({ id: "2", osId: 1000 }), session({ id: "9", osId: 120 })],
      (id) => (id === "2" ? "idle" : undefined),
    );
    expect(keys).toEqual({ "session.liza": "idle", "session.u1001": "none" });
  });
});
