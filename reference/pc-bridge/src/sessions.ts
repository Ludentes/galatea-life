import type { OsSession } from "./port.js";

/** The value of a `session.<token>` key (`standard/applier.md`, the capability table). */
export type SessionState = "active" | "idle" | "unknown" | "locked" | "disconnected" | "none";

/** The most in-use first: an account's key takes the first any of its sessions reads (GA-BRIDGE-52). */
export const IN_USE: readonly SessionState[] = ["active", "idle", "unknown", "locked", "disconnected", "none"];

/**
 * One session's reading. `locked` and `disconnected` are the OS's alone. A graphical session the OS
 * reports active takes its bound helper's `activity`, and reads `unknown` with no helper or no
 * report yet: a helper's word counts only while the OS reports the session active, so one that
 * claims its own session locked changes nothing. A non-graphical session (an SSH login) has no
 * helper and is read from the OS alone: `idle` where the OS reports idleness, else `active`.
 */
export function readSession(s: OsSession, activity: "active" | "idle" | undefined): SessionState {
  if (s.state === "locked") return "locked";
  if (s.state === "disconnected") return "disconnected";
  if (!s.graphical) return s.idleHint ? "idle" : "active";
  return activity ?? "unknown";
}

/**
 * An account's one key from its sessions: the graphical ones alone when it has any, else the
 * non-graphical ones, the most in-use reading winning; `none` with no session at all (GA-BRIDGE-52).
 */
export function accountState(sessions: OsSession[], activity: (session: string) => "active" | "idle" | undefined): SessionState {
  const graphical = sessions.filter((s) => s.graphical);
  const counted = graphical.length ? graphical : sessions;
  let best: SessionState = "none";
  for (const s of counted) {
    const r = readSession(s, activity(s.id));
    if (IN_USE.indexOf(r) < IN_USE.indexOf(best)) best = r;
  }
  return best;
}

/** Every interactive account's key, `session.<token>`, from the sessions the OS reports. */
export function sessionKeys(
  accounts: { osId: number; token: string }[],
  sessions: OsSession[],
  activity: (session: string) => "active" | "idle" | undefined,
): Record<string, SessionState> {
  const keys: Record<string, SessionState> = {};
  for (const a of accounts) keys[`session.${a.token}`] = accountState(sessions.filter((s) => s.osId === a.osId), activity);
  return keys;
}
