import type { Feedback, TransportState } from "../bus/wire.js";

export type Liveness = "live" | "stale" | "dead";

/** How long past `fresh_s` a bridged device may take to read `stale`: the status interval and 1 s (GA-STATE-5). */
export const FRESH_SLACK_S = 11;

/** The facts a bridged device's verdict rests on, all on the applier's side (ruling 14: the verdict is the applier's). */
export type Facts = {
  feedback: Feedback;
  /** Its bridge found live, which needs the broker (GA-BUS-7). */
  bridgeAlive: boolean;
  /** Its bridge reports it gone: `available: false`, out of `devices` or the roster, its status cleared (GA-STATE-2). */
  gone: boolean;
  /** Its transport's state; undefined when its bridge lists no such transport, which reaches it no more than a down one. */
  transport: TransportState | undefined;
  /** The effective bound in seconds; null when not known (GA-STATE-5). */
  freshS: number | null;
  /** Its latest check-in, from the roster, on the bridge's clock (GA-BUS-10). */
  lastCheckIn: number | null;
  /** A value or check-in stamped more than 5 s ahead of the applier's clock: of unknown age (GA-BUS-2). */
  fastClock: boolean;
};

/**
 * The applier's verdict (applier, *State and liveness*). Dead when what owns the device is, or
 * says it is gone; an open device is live otherwise; a closed one is stale past its bound plus the
 * slack, with no known bound, or on a fast clock. Never judged from when a message arrived.
 */
export function liveness(f: Facts, now: number, o: { liveWhileUnknown?: boolean } = {}): Liveness {
  if (!f.bridgeAlive || f.gone || f.transport === "down" || f.transport === undefined) return "dead";
  if (f.feedback === "open") return "live";
  if (f.fastClock) return "stale";
  if (f.freshS === null) return o.liveWhileUnknown ? "live" : "stale";
  if (f.lastCheckIn === null) return "stale";
  return now - f.lastCheckIn > (f.freshS + FRESH_SLACK_S) * 1000 ? "stale" : "live";
}
