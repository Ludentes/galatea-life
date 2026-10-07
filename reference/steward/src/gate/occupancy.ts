import type { Mutation } from "../mutations.js";

/** A room's occupancy (steward, *Occupancy*). */
export type Occupancy = "occupied" | "vacant" | "unknown";

/** What a room's occupancy is read from: one of its sensors, as the mirror holds it. */
export interface Sensor {
  id: string;
  /** Which of the two keys it reports: `occupancy` (presence) or `motion`. */
  key: "occupancy" | "motion";
  /** Its value now: true is presence, or motion. */
  value: unknown;
  /** The last time it read true, or undefined. */
  lastTrueMs?: number;
  /** Since when it has been `live` without a break, or undefined while it is not (or not yet known to be) live. */
  liveSinceMs?: number;
  /** Its effective `fresh_s` and its `fresh_slack_s`, null where not known. */
  freshS: number | null;
  slackS: number | null;
}

/**
 * A room's occupancy (GA-OCC-1), from its sensors, at `now`, with the home's `occupancy_hold_s` as
 * `holdMs`. `occupied` while an occupancy sensor reads presence or a motion sensor reported motion
 * within the hold. `vacant` only with at least one occupancy sensor, every one `live` throughout the
 * hold, each with a known `fresh_s` that with its `fresh_slack_s` is within the hold, and none
 * reporting presence in it: a sensor with a longer bound, or none known, reads `live` long after it
 * died, and a motion sensor cannot see a person sitting still. `unknown` otherwise, and for a room
 * with no such sensor. `vacant-on-a-slow-sensor` takes a sensor's bound as within the hold whatever it is.
 */
export function occupancyOf(sensors: Sensor[], now: number, holdMs: number, mutation?: Mutation): Occupancy {
  const within = (ms: number | undefined) => ms !== undefined && ms > now - holdMs;
  if (sensors.some((s) => (s.key === "occupancy" && s.value === true) || (s.key === "motion" && (s.value === true || within(s.lastTrueMs))))) {
    return "occupied";
  }
  const presence = sensors.filter((s) => s.key === "occupancy");
  const quiet = (s: Sensor) => s.liveSinceMs !== undefined && s.liveSinceMs <= now - holdMs
    && (mutation === "vacant-on-a-slow-sensor" || (s.freshS !== null && s.slackS !== null && (s.freshS + s.slackS) * 1000 <= holdMs))
    && !within(s.lastTrueMs);
  return presence.length > 0 && presence.every(quiet) ? "vacant" : "unknown";
}
