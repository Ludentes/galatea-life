import type { Occupancy, Sensor } from "../gate/occupancy.js";
import type { HoldPolicy } from "../house/model.js";
import type { Mutation } from "../mutations.js";

/** What `never-ends-a-quiet-hold` gives for "never": ten years on, finite so the table's clamp re-arms it (R-50). */
const NEVER_MS = 10 * 365 * 24 * 3600 * 1000;

export type Direction = "on" | "off" | "other";
export type HoldEnd = "quiet" | "window" | "cap" | "vacant" | "schedule" | "replaced" | "unreachable" | "removed";
/** A hold's own state, kept with its lease (GA-PERSIST-2). All instants are elapsed milliseconds. */
export interface HoldState {
  kind: "person" | "load_cap";
  /** A person's hold's change direction; none for load_cap (GA-LEASE-7). */
  direction?: Direction;
  changeMs: number;
  /** The moment the room last became quiet as this hold has seen it, or the change; null while the room is busy. */
  quietFromMs: number | null;
  /** The moment the room last became quiet after presence, since the change; absent when quiet throughout. */
  quietSinceMs?: number;
  /** The ack floor: dispatch plus ack_within_s plus 60 s, cleared (null) by a success or late ack; null for an outside change. */
  floorMs: number | null;
  /** `fixed_s`'s anchor: the latest of the change, a move and the moment the room lost its last live source (GA-LEASE-7). */
  fixedFromMs: number;
  /** An apply's derived role, kept and named in the granted event (GA-LEASE-10); a brain-served endpoint's with no person, `guest`. */
  role?: "owner" | "member" | "guest";
  vacantAtChange: boolean;
  seenNotVacant: boolean;
  /** The room and its live presence sources as last judged, to see a move or a source change (GA-LEASE-7). */
  room: string | null;
  sources: string[];
  /** The room's adopted presence sources as last judged, live or not, to see one removed (GA-LEASE-7). */
  adopted: string[];
  /** A policy end that came inside the floor, kept to end the hold once the floor has passed (GA-LEASE-7). */
  pendingEnd?: { why: HoldEnd; quietSinceMs?: number };
}
/** The device's room as it stands at the moment judged. */
export interface RoomNow {
  room: string | null;
  /** Live presence sources (motion, occupancy) in the room, by id, sorted; none when every one is not live (GA-LEASE-7). */
  sources: string[];
  /** Adopted presence sources in the room, live or not, by id, sorted. */
  adopted: string[];
  /** Whether a live source reads presence: a held `true` until it clears, no afterglow (GA-LEASE-7). */
  busy: boolean;
  occupancy: Occupancy;
  /** When the room would turn vacant with no further report (`vacantFrom`), elapsed; absent when it would not. */
  vacantAtMs?: number;
}
export interface Judged {
  state: HoldState;
  /** What the hold shows: windows, cap and floor only; it foresees no vacancy (GA-LEASE-7). */
  expiresMs: number;
  /** When to judge again: `expiresMs`, or the predicted vacancy if sooner. */
  timerAtMs: number;
  end?: { why: HoldEnd; atMs: number };
}

/** An apply's or press's direction (GA-LEASE-7): `onoff.turn_on`/`turn_off`, or an extension action confirmed by `on` true/false; toggles: other. */
export function directionOf(action: string, declared?: { toggles?: unknown; confirmed_by?: { key?: unknown; value?: unknown } }): Direction {
  if (declared?.toggles === true) return "other";
  if (action === "onoff.turn_on") return "on";
  if (action === "onoff.turn_off") return "off";
  const c = declared?.confirmed_by;
  if (c?.key === "on" && typeof c.value === "boolean") return c.value ? "on" : "off";
  return "other";
}

/** An outside change's direction, from what changed: `on` moved to true or false, else other. */
export function directionOfChange(key: string, value: unknown, before: unknown): Direction {
  if (key !== "on" || value === before) return "other";
  return value === true ? "on" : value === false ? "off" : "other";
}

/** The quiet window, in seconds, for a change's direction. */
export function windowS(p: HoldPolicy, d: Direction | undefined, mutation?: Mutation): number {
  if (d === "on") return p.on_s;
  if (d === "off") return mutation === "same-window-both-ways" ? p.on_s : p.off_s;
  return p.other_s;
}

/**
 * One hold judged at `nowMs` (GA-LEASE-7): its anchors moved by the room as it stands, the moment it
 * ends as of now, and its end when that is now or past. Only the policy's own ends are here; a
 * replacement, an unreachable step and a removed device are the caller's. `expiresMs` is what the
 * hold shows (windows, cap and floor; it foresees no vacancy); `timerAtMs` is when to judge again,
 * which may be the predicted vacancy.
 */
export function judgeHold(h: HoldState, p: HoldPolicy, r: RoomNow, nowMs: number, mutation?: Mutation): Judged {
  const s: HoldState = { ...h };
  const S = 1000;
  const floor = mutation === "ends-a-hold-before-the-ack" ? null : h.floorMs;
  // The prior state's end first, before what the room says now moves it: an end that came inside the floor
  // is kept though a report lands before its timer fires (R-60).
  let lapsed: HoldState["pendingEnd"];
  if (h.kind === "person" && !h.pendingEnd && floor !== null && nowMs < floor) {
    const e = policyEnd(h, p, !h.room || !h.sources.length, nowMs, mutation);
    if (e.ending && e.at <= nowMs) lapsed = { why: e.why, ...(h.quietSinceMs !== undefined ? { quietSinceMs: h.quietSinceMs } : {}) };
  }
  // A move, a live source not live before (adopted or returned) or an adopted source removed restarts the
  // count no earlier than now; a source going stale does not. fixed_s counts from the latest of the change,
  // a move and the loss of the last live source (GA-LEASE-7).
  const moved = s.room !== r.room;
  const restart = moved || r.sources.some((x) => !s.sources.includes(x)) || s.adopted.some((x) => !r.adopted.includes(x));
  if (restart && s.quietFromMs !== null) s.quietFromMs = Math.max(s.quietFromMs, nowMs);
  if (moved || (s.sources.length > 0 && r.sources.length === 0)) s.fixedFromMs = Math.max(s.fixedFromMs, nowMs);
  s.room = r.room;
  s.sources = r.sources;
  s.adopted = r.adopted;
  if (r.busy) s.quietFromMs = null;
  else if (s.quietFromMs === null) {
    s.quietFromMs = nowMs;
    s.quietSinceMs = nowMs;
  }
  if (r.occupancy !== "vacant") s.seenNotVacant = true;
  if (s.kind === "load_cap" && mutation !== "renews-a-capped-heater") {
    const at = s.changeMs + p.load_cap_s * S;
    return { state: s, expiresMs: at, timerAtMs: at, ...(at <= nowMs ? { end: { why: "window" as const, atMs: at } } : {}) };
  }
  if (lapsed) s.pendingEnd = lapsed;
  // A policy end kept from inside the floor ends the hold once the floor has passed, whatever presence did since.
  if (s.pendingEnd) {
    if (floor === null || nowMs >= floor) return { state: s, expiresMs: floor ?? nowMs, timerAtMs: floor ?? nowMs, end: { why: s.pendingEnd.why, atMs: floor ?? nowMs } };
    return { state: s, expiresMs: mutation === "fixed-expires" ? s.changeMs + windowS(p, s.direction, mutation) * S : floor, timerAtMs: floor };
  }
  const w = windowS(p, s.direction, mutation) * S;
  let { at, why, ending } = policyEnd(s, p, !r.room || !r.sources.length, nowMs, mutation);
  const vacantMay = p.vacant_ends && (!s.vacantAtChange || s.seenNotVacant || mutation === "vacant-ends-a-remote-hold");
  if (vacantMay && r.occupancy === "vacant" && nowMs < at) { at = nowMs; why = "vacant"; ending = true; }
  // Judged continuously: a timer at the moment the room would turn vacant with no report (GA-LEASE-7).
  let timer = at;
  if (vacantMay && mutation !== "misses-a-vacancy" && r.vacantAtMs !== undefined && r.vacantAtMs > nowMs && r.vacantAtMs < at) timer = r.vacantAtMs;
  let expires = at;
  if (floor !== null) {
    expires = Math.max(at, floor);
    // An end or a predicted vacancy that comes inside the floor is judged when it comes, to be kept until
    // the floor passes (R-60); a busy room's moving end waits for the floor.
    const comes = ending || timer < at ? timer : Infinity;
    timer = comes < floor ? comes : Math.max(timer, floor);
  }
  if (mutation === "fixed-expires" && floor !== null) expires = s.changeMs + w;
  if (!ending || at > nowMs) return { state: s, expiresMs: expires, timerAtMs: timer };
  if (floor !== null && nowMs < floor) {
    s.pendingEnd = { why, ...(s.quietSinceMs !== undefined ? { quietSinceMs: s.quietSinceMs } : {}) };
    return { state: s, expiresMs: mutation === "fixed-expires" ? s.changeMs + w : floor, timerAtMs: floor };
  }
  return { state: s, expiresMs: expires, timerAtMs: timer, end: { why, atMs: floor !== null ? Math.max(at, floor) : at } };
}

/**
 * A hold's policy end as `s` stands at `nowMs` (GA-LEASE-7): `fixed_s` with no room or no live source, the
 * window from the change without `presence_renews`, else the quiet window (moving while busy, so not
 * ending), each bounded by `cap_s`. Vacancy and the floor are the caller's.
 */
function policyEnd(s: HoldState, p: HoldPolicy, noSource: boolean, nowMs: number, mutation?: Mutation): { at: number; why: HoldEnd; ending: boolean } {
  const S = 1000;
  let at: number;
  let why: HoldEnd;
  let ending = true;
  const w = windowS(p, s.direction, mutation) * S;
  if (noSource && mutation !== "roomless-on-window") { at = s.fixedFromMs + p.fixed_s * S; why = "window"; }
  else if (noSource) { at = s.changeMs + w; why = "window"; }
  else if ((!p.presence_renews && mutation !== "renews-when-told-not-to") || mutation === "ends-a-hold-while-busy") { at = s.changeMs + w; why = "window"; }
  else if (s.quietFromMs === null) { at = nowMs + w; why = "quiet"; ending = false; }
  else { at = mutation === "never-ends-a-quiet-hold" ? nowMs + NEVER_MS : Math.max(s.changeMs, s.quietFromMs) + w; why = "quiet"; }
  // cap_s above 0 bounds every end, but never ends a hold before its floor (the caller's).
  if (p.cap_s > 0 && mutation !== "ignores-the-cap" && s.changeMs + p.cap_s * S < at) { at = s.changeMs + p.cap_s * S; why = "cap"; ending = true; }
  return { at, why, ending };
}

/**
 * The first moment, at or after `nowWallMs`, at which `occupancyOf` would read the room `vacant` with
 * no further report, or undefined when it never would so (a sensor reading presence, a motion-only
 * room, one not live, one with no bound within the hold). On the wall clock, as the mirror's times are.
 */
export function vacantFrom(sensors: Sensor[], nowWallMs: number, holdMs: number): number | undefined {
  const presence = sensors.filter((s) => s.key === "occupancy");
  if (!presence.length) return undefined;
  if (sensors.some((s) => s.value === true)) return undefined;
  if (presence.some((s) => s.liveSinceMs === undefined || s.freshS === null || s.slackS === null || (s.freshS + s.slackS) * 1000 > holdMs)) return undefined;
  const at = Math.max(...presence.map((s) => s.liveSinceMs! + holdMs), ...sensors.map((s) => (s.lastTrueMs ?? -Infinity) + holdMs));
  return Math.max(at, nowWallMs);
}

/** `h` with every instant it keeps moved by `deltaMs` (elapsed to wall and back, GA-PERSIST-2). */
export function shiftHold(h: HoldState, deltaMs: number): HoldState {
  return { ...h, changeMs: h.changeMs + deltaMs, fixedFromMs: h.fixedFromMs + deltaMs, quietFromMs: h.quietFromMs === null ? null : h.quietFromMs + deltaMs,
    ...(h.quietSinceMs !== undefined ? { quietSinceMs: h.quietSinceMs + deltaMs } : {}),
    floorMs: h.floorMs === null ? null : h.floorMs + deltaMs,
    ...(h.pendingEnd ? { pendingEnd: { ...h.pendingEnd, ...(h.pendingEnd.quietSinceMs !== undefined ? { quietSinceMs: h.pendingEnd.quietSinceMs + deltaMs } : {}) } } : {}) };
}
