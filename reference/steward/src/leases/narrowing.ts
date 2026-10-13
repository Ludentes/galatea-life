import type { Mutation } from "../mutations.js";

/**
 * Whether `action` on `device` narrows (GA-LEASE-11): `lock.lock`, `valve.close`, or on an `onoff`
 * `water_valve` or `gas_valve` the `onoff` action that is not its `opens_with` (the applier's full action name,
 * `onoff.turn_on` or `onoff.turn_off`; `onoff.turn_on` when absent);
 * never an action `declared` `toggles`, whose direction is not known when it is sent. A narrowing action
 * passes a person's hold and takes none (*Narrowing actions*).
 */
export function isNarrowing(action: string, device: { class?: unknown; opens_with?: unknown } | undefined,
  declared?: { toggles?: unknown }, mutation?: Mutation): boolean {
  if (mutation === "holds-the-auto-lock" && action === "lock.lock") return false;
  if (declared?.toggles === true && mutation !== "narrows-by-toggle") return false;
  if (action === "lock.lock" || action === "valve.close") return true;
  if (mutation === "narrows-a-heater" && action === "onoff.turn_on" && device?.class === "socket") return true;
  const valve = device?.class === "water_valve" || device?.class === "gas_valve";
  if (!valve || !action.startsWith("onoff.")) return false;
  const opens = mutation === "closes-by-opens-with" ? "onoff.turn_on" : typeof device!.opens_with === "string" ? device!.opens_with : "onoff.turn_on";
  return action !== opens;
}
