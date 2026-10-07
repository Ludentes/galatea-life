/**
 * What the standard itself declares of a device, as data (applier, *Default tiers*, *Action
 * declarations*, *Computers and players*): the default tiers table, the default `ack_within_s`,
 * the actions never idempotent, and the keys it declares `personal` and `self_changing`. The PC
 * slice adds its rows (computers, hosted devices, a plugin's `requested_tier`) here.
 */
import { capabilityOf, isExtension } from "../bus/wire.js";
import type { Witness } from "../safety/witnesses.js";

export type Tier = "reversible" | "confirm" | "no_voice";
export type Load = "heating" | "motor" | "lighting" | "other";
export type OpensWith = "onoff.turn_on" | "onoff.turn_off";

/** What the owner declared of one device, through `adopt` and the `configure` kinds. */
export type Declarations = {
  tiers?: Record<string, Tier>;
  load?: Load;
  /** Only with `load: heating`: how long it may be on continuously before the applier turns it off (GA-LOAD-2). */
  max_on_s?: number;
  /** The witness of each action that has one (applier, *Safety rules*, GA-WIT-1). */
  witnesses?: Record<string, Witness>;
  /** Kept when false too: set either way, it outranks the bridge's `proposed_infrastructure` (applier, *Devices*). */
  infrastructure?: boolean;
  /** Only on a computer: the applier itself runs on it (applier, *Devices*, GA-SAFE-6, GA-CFG-3). */
  applier_host?: boolean;
  fresh_s?: number;
  ack_within_s?: Record<string, number>;
  self_changing?: string[];
  personal?: string[];
  opens_with?: OpensWith;
  /**
   * For each extension action whose tier the owner set, the fingerprint of its declarations then: a
   * tier below the table falls back while its declarations differ, until the owner sets it again (GA-DESC-18).
   */
  tier_basis?: Record<string, string>;
};

/** A `heating` load's `max_on_s` where the owner set none (applier, *Loads*, *Constants*: ⚠️ a guess). */
export const DEFAULT_MAX_ON_S = 14_400;
/** The longest `max_on_s` `configure` takes (GA-CFG-3). */
export const MAX_ON_MAX_S = 86_400;

const RANK: Record<Tier, number> = { reversible: 0, confirm: 1, no_voice: 2 };
export const higher = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);
export const below = (a: Tier, b: Tier): boolean => RANK[a] < RANK[b];

/** What the default tiers read of a device. */
export type TierFacts = { cls: string | null; load?: Load; infrastructure: boolean; opensWith: OpensWith };

export const VALVES = new Set(["water_valve", "gas_valve"]);
const GATES = new Set(["gate", "garage_door"]);

/** The rows of *Default tiers* this build holds, in order; the first that matches wins. */
export const DEFAULT_TIERS: { row: string; matches: (f: TierFacts, action: string) => boolean; tier: Tier }[] = [
  { row: "any: lock.unlock", matches: (_f, a) => a === "lock.unlock", tier: "no_voice" },
  { row: "water_valve, gas_valve: valve.open", matches: (f, a) => VALVES.has(f.cls ?? "") && a === "valve.open", tier: "no_voice" },
  { row: "water_valve, gas_valve: the onoff action that opens it", matches: (f, a) => VALVES.has(f.cls ?? "") && a === f.opensWith,
    tier: "no_voice" },
  { row: "gate, garage_door: cover.close", matches: (f, a) => GATES.has(f.cls ?? "") && a === "cover.close", tier: "confirm" },
  { row: "gate, garage_door: every other action", matches: (f) => GATES.has(f.cls ?? ""), tier: "no_voice" },
  { row: "boiler: climate.set_mode, climate.set_setpoint", matches: (f, a) => f.cls === "boiler"
    && (a === "climate.set_mode" || a === "climate.set_setpoint"), tier: "confirm" },
  { row: "load heating: onoff.turn_on", matches: (f, a) => f.load === "heating" && a === "onoff.turn_on", tier: "confirm" },
  { row: "infrastructure: onoff.turn_off", matches: (f, a) => f.infrastructure && a === "onoff.turn_off", tier: "no_voice" },
  { row: "infrastructure: power.sleep, power.shutdown", matches: (f, a) => f.infrastructure
    && (a === "power.sleep" || a === "power.shutdown"), tier: "no_voice" },
  { row: "computer: power.shutdown", matches: (f, a) => f.cls === "computer" && a === "power.shutdown", tier: "confirm" },
];

/** The classes whose rows name only standard actions, and whose floor for an extension action is `no_voice` (applier, *Plugins' actions*). */
const GUARDED = new Set(["door_lock", "water_valve", "gas_valve", "gate", "garage_door"]);

/**
 * An extension action's floor (applier, *Plugins' actions*): the highest tier any row naming the
 * device's class, one of its flags or its load gives any action, whether or not the device offers
 * that action; `no_voice` on a `door_lock`, `water_valve`, `gas_valve`, `gate` or `garage_door`;
 * `reversible` where no such row names it. A plugin's `requested_tier` and a hosting computer's
 * `infrastructure` join it with the PC build.
 */
export function extensionFloor(f: TierFacts): Tier {
  if (GUARDED.has(f.cls ?? "")) return "no_voice";
  let floor: Tier = "reversible";
  if (f.cls === "boiler" || f.cls === "computer") floor = higher(floor, "confirm");
  if (f.load === "heating") floor = higher(floor, "confirm");
  if (f.infrastructure) floor = higher(floor, "no_voice");
  return floor;
}

/**
 * The tier the table gives `action` on a device (GA-DESC-3): the first row that matches, else
 * `reversible`; an extension action, a plugin's or a bridge's own, takes the extension row after every
 * class, flag and load row: `confirm`, or its floor where that is higher.
 */
export function defaultTier(f: TierFacts, action: string): Tier {
  if (isExtension(action)) return higher("confirm", extensionFloor(f));
  return DEFAULT_TIERS.find((r) => r.matches(f, action))?.tier ?? "reversible";
}

/**
 * The standard's stateless actions: the capability column, which wins over a bridge's `stateless`
 * (applier, *Action declarations*). An extension action's is its bridge's.
 */
export const STATELESS = new Set(["cover.stop", "media.duck", "media.announce", "notify.notify", "power.wake", "power.sleep",
  "power.shutdown", "power.cancel"]);
/** The standard's stateful actions, whose statelessness is `false` whatever a bridge says. */
const STATEFUL = new Set(["onoff.turn_on", "onoff.turn_off", "level.set_level", "color.set_color", "climate.set_mode",
  "climate.set_setpoint", "cover.open", "cover.close", "cover.set_position", "media.pause", "media.resume", "media.set_volume",
  "media.launch", "valve.open", "valve.close", "lock.lock", "lock.unlock", "session.lock"]);

/** Whether an action is stateless: the capability column for a standard action, else what its bridge declares. */
export function statelessOf(action: string, declared: boolean): boolean {
  return STATELESS.has(action) ? true : STATEFUL.has(action) ? false : declared;
}

/** Never idempotent, whatever a bridge says: the capability column (GA-DESC-4). A bridge may only lower `idempotent`. */
export const NEVER_IDEMPOTENT = new Set(["notify.notify", "media.announce", "power.shutdown", "media.launch"]);

/**
 * Whether an action may be idempotent at all (GA-DESC-4): never one the capability column says is not,
 * and never an extension action, whatever its bridge or manifest proposes, unless the owner declares it
 * at adoption, which this build does not offer yet.
 */
export const mayBeIdempotent = (action: string): boolean => !NEVER_IDEMPOTENT.has(action) && !isExtension(action);

/**
 * The default `ack_within_s` (applier, *Action declarations*), the first that applies: 240 for
 * `power.wake`, 90 for `cover` and a gate or garage door, 60 for `valve` and a water or gas valve, 30
 * for `media.launch`, 10 for `session.lock`, 10 otherwise; never below twice `reach_s` plus 10 where
 * the reach is known.
 */
export function defaultAckWithinS(cls: string | null, action: string, reachS: number | undefined): number {
  const capability = capabilityOf(action);
  const base = action === "power.wake" ? 240
    : capability === "cover" || GATES.has(cls ?? "") ? 90
    : capability === "valve" || VALVES.has(cls ?? "") ? 60
    : action === "media.launch" ? 30
    : 10;
  return reachS === undefined ? base : Math.max(base, 2 * reachS + 10);
}

/** The keys this standard declares `personal` on every device that reports them (GA-DESC-9). */
const STANDARD_PERSONAL = ["app", "camera_in_use", "microphone_in_use", "speech"];

/**
 * The state keys each action's row of the capability table names (applier, *Capabilities and
 * actions*). `session.<account>` is the PC slice's, which brings the accounts.
 */
const ACTION_KEYS: Record<string, string[]> = {
  "onoff.turn_on": ["on"], "onoff.turn_off": ["on"],
  "level.set_level": ["level"],
  "color.set_color": ["color"],
  "climate.set_mode": ["mode", "setpoint", "current"], "climate.set_setpoint": ["mode", "setpoint", "current"],
  "cover.open": ["position"], "cover.close": ["position"], "cover.set_position": ["position"],
  "media.pause": ["playing", "volume"], "media.resume": ["playing", "volume"], "media.set_volume": ["playing", "volume"],
  "media.launch": ["playing", "title", "started_at"],
  "valve.open": ["open"], "valve.close": ["open"],
  "lock.lock": ["locked"], "lock.unlock": ["locked"],
};
/** A player's keys the standard declares `self_changing` (*Computers and players*). */
const PLAYER_SELF_CHANGING = ["playing", "title", "started_at"];

/**
 * The state keys a device reports, as far as its declarations show: those its actions' rows name,
 * its sensor keys, and `speech` for a device with the `media` capability, which reports it where
 * its protocol gives it.
 */
export function reported(capabilities: string[], actions: string[], sensorKeys: string[]): string[] {
  return [...new Set([...actions.flatMap((a) => ACTION_KEYS[a] ?? []), ...sensorKeys,
    ...(capabilities.includes("media") ? ["speech"] : [])])];
}

/**
 * The `personal` and `self_changing` keys the standard declares for a device of class `cls` with
 * these capabilities, actions and sensor keys (GA-DESC-9): every state key a computer reports is
 * `self_changing`, so are the `playing`, `title` and `started_at` a player reports, and `speech` on
 * every device. A computer's session keys are the PC slice's, which brings its `accounts`.
 */
export function standardKeys(cls: string | null, capabilities: string[], actions: string[], sensorKeys: string[]):
  { personal: string[]; self_changing: string[] } {
  const keys = reported(capabilities, actions, sensorKeys);
  const has = (k: string) => keys.includes(k);
  return {
    personal: STANDARD_PERSONAL.filter(has),
    self_changing: cls === "computer" ? keys
      : [...(has("speech") ? ["speech"] : []), ...(cls === "player" ? PLAYER_SELF_CHANGING.filter(has) : [])],
  };
}

/** The union of `lists`, in order, each key once. */
export const union = (...lists: (string[] | undefined)[]): string[] => [...new Set(lists.flatMap((l) => l ?? []))];
