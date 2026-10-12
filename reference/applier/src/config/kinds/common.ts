// What configure's kinds share: the types of a change set and its context, and the helpers that
// check and set a draft's declarations (moved from configure.ts).
import { validate } from "@ludentes/galatea-life-schemas";
import { RequestError } from "../../core/errors.js";
import { type ConfirmedBy, type Constraint, isExtension } from "../../bus/wire.js";
import { below, type Declarations, defaultTier, floorTier, higher, type Load, MAX_ON_MAX_S, reported, standardKeys, type Tier, type TierFacts, union, VALVES } from "../../model/declarations.js";
import type { Mutant } from "../../mutations.js";
import { devicesOf, reads } from "../../safety/language.js";
import type { Config, Level } from "../config.js";

export type Change = { op: "upsert" | "delete"; kind: string; value?: unknown };
/** What `configure` must know of a device the model holds: what it offers and what its bridge declares. */
export type DeviceInfo = {
  capabilities: string[];
  sensor_keys: string[];
  actions: string[];
  /** Undefined when its bridge did not say. */
  reach_s?: number;
  personal: string[];
  self_changing: string[];
  /** Still in its bridge's `devices` document, or not known to have left it: then it cannot be forgotten. */
  in_devices: boolean;
  /** The protocol's identity of the hardware (applier, *Devices*). */
  stable_identifier: string;
  /** The bridge that fronts the hardware now (a replacement may have moved its id to another). */
  bridge: string;
  /** The bridges of the copies folded into it: the same hardware reported by other bridges (GA-BUS-11). */
  copies?: string[];
  /** Each action's declarations, as a fingerprint that changes when its bridge changes them (GA-DESC-18). */
  fingerprints?: Record<string, string>;
  /** The tier a plugin's manifest requests for each action that has one (`requested_tier`): it joins the action's floor. */
  requested_tiers?: Record<string, Tier>;
  /** Its extensions' keys of kind `state` and of kind `event` (applier, *Extensions*, GA-EVT-8). */
  extension_keys?: { state: string[]; event: string[] };
  /** The actions its bridge declares `toggles: true` (GA-SAFE-13). */
  toggles?: string[];
  /** Each action's own `args` constraints and `confirmed_by`, as its bridge declares them: what a rule's args must meet. */
  args?: Record<string, { args?: Record<string, Constraint>; confirmed_by?: ConfirmedBy }>;
  /** Its other admins, as its bridge shows them (GA-SAFE-6). */
  other_admins?: { vendor: string; label: string }[] | "unknown";
  /** The class its bridge proposes: a computer not adopted yet still carries the broker it proposes (GA-SAFE-6). */
  proposed_class?: string | null;
  /** Its bridge's proposal that it carries the broker (GA-BRIDGE-65). */
  proposed_infrastructure?: true;
  /** On a plugin device: the applier's id of the computer that hosts it (applier, *Devices*, `host`). */
  host?: string;
  /** The keys its bridge awaits, promised and not yet reported (GA-DESC-19): named in a refusal's `data` (GA-SAFE-14). */
  awaited_keys?: string[];
};
/**
 * `devices`: the devices the model holds now, which an adoption and a declaration must name. `levels`:
 * the levels this build can claim; it claims Safe only while the owner's `box` is set and no bridge
 * declares an `ungoverned` path (GA-DESC-6). `plainOffLoopback`: its own broker connection is plain
 * TCP to a host off loopback, so `box: true` is refused.
 */
export type Ctx = { levels: Level[]; underHarness: boolean; ownerCredential: string; devices?: ReadonlyMap<string, DeviceInfo>;
  /** The applier's own MQTT identity: no bridge may hold it. */
  ownIdentity?: string;
  mutant: Mutant; ungoverned?: boolean; plainOffLoopback?: boolean;
  /** The safety rules whose latch is held: what `clear_latch` may name (GA-SAFE-7). */
  latches?: ReadonlySet<string>;
  /** The candidates `candidates` lists now (slice 5b): what `ignore_candidate` may name. */
  listed?: () => { id: string; keys: string[] }[] };

/** The kinds that change no device (applier, *Discovery*): a set of only these needs no expected_revision (GA-CFG-2). */
export const IGNORE_KINDS = new Set(["ignore_candidate", "unignore_candidate"]);

/** The levels an applier claims with configuration `c` (GA-DESC-6): Safe only with `box`, and no bridge's `ungoverned` path. */
export function claimsOf(c: Pick<Config, "box">, o: { levels: Level[]; ungoverned?: boolean }): Level[] {
  return o.levels.filter((l) => l !== "Safe" || (c.box && !o.ungoverned));
}
/** An adoption with `replaces`: the hardware `device` takes the id `replaces`. */
export type Replacement = { device: string; replaces: string };
/** A route set: `device`, the one device the identifier's copies are, takes the copy on `bridge` (GA-BUS-11). */
export type Routed = { stable_identifier: string; device: string; bridge: string };
/**
 * What a change set does to the model beside the configuration: the devices it removes, the ids it
 * re-points, the routes it sets, and the devices whose route it deletes.
 */
export type Effects = { forgotten: string[]; replaced: Replacement[]; routed: Routed[]; unrouted?: string[];
  /** The rules whose held latch the owner clears (`clear_latch`). */
  cleared?: string[] };
/** A change set being checked: the devices as its earlier changes left them, and its effects so far. */
export type Work = Ctx & { devices: Map<string, DeviceInfo> } & Required<Effects> & {
  /** The safety rules this set changed, or whose device it replaced: checked whole once the set is applied. */
  ruled: string[];
  /** The index of the change being taken, for a refusal judged once the whole set is applied. */
  at?: number;
  /**
   * The tiers this set gave the owner's value, each judged against the floor the whole set leaves
   * (GA-DESC-14), with the index of the change that set it.
   */
  tiered?: { id: string; action: string; tier: Tier; at?: number }[] };
export type AdoptValue = { device: string; class: string | null; declarations?: Declarations; replaces?: string };

/**
 * Kinds that need the Safe level (applier, *Conformance levels*): not_claimed below it (GA-LVL-1).
 * A device's `load` is not among them: declaring it raises the device's tiers (GA-DESC-13, Act);
 * only its on-time cap is Safe (the maintainer, 2026-09-28; a standards fix this build shows).
 */
export const SAFE_KINDS = new Set(["safety_rule", "max_on_s", "witness", "clear_latch", "accepts_other_admins"]);
/** Fields of an adoption's declarations that need the Safe level: not_claimed below it, before the schema (GA-LVL-1). */
export const SAFE_DECLARATIONS = ["max_on_s"];

export type Kind = (draft: Config, change: Change, ctx: Work) => string | undefined;

export const bad = (message: string): never => { throw new RequestError("invalid_request", message); };

export function checked<T>(schema: string, value: unknown): T {
  const errors = validate(schema, value);
  if (errors.length) bad(`${schema}: ${errors.join("; ")}`);
  return value as T;
}

/** GA-CFG-3's bounds on `ack_within_s`. */
export const ACK_MIN_S = 2;
export const ACK_MAX_S = 300;

export function device(ctx: Ctx, id: string): DeviceInfo {
  const d = ctx.devices?.get(id);
  if (!d) bad(`no device ${id}`);
  return d!;
}

export function declared(draft: Config, id: string): Declarations {
  let d = draft.declarations.get(id);
  if (!d) draft.declarations.set(id, d = {});
  return d;
}

/** Drops a device's declarations once nothing is left in them, so an empty record is no model change. */
export function tidy(draft: Config, id: string): void {
  const d = draft.declarations.get(id);
  if (!d) return;
  for (const k of Object.keys(d) as (keyof Declarations)[]) {
    const v = d[k];
    if (v === undefined || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) || (Array.isArray(v) && !v.length)) {
      delete d[k];
    }
  }
  if (!Object.keys(d).length) draft.declarations.delete(id);
}

export type Owned = { adoptions: ReadonlyMap<string, { class: string | null }>; declarations: ReadonlyMap<string, Declarations>; safe?: boolean };

/**
 * A device's load as the tiers read it: the owner's, else, on a build that can claim Safe, `heating`
 * for a socket, so that no heater hides behind an undeclared load (GA-DESC-8); else none.
 */
export function loadIn(c: Owned, id: string): Load | undefined {
  return c.declarations.get(id)?.load ?? (c.safe && c.adoptions.get(id)?.class === "socket" ? "heating" : undefined);
}

/** What the default tiers read of a device besides the owner's declarations: what its bridge says of it. */
export type SeenDevice = { proposed_class?: string | null; proposed_infrastructure?: true; host?: string };
export type Seen = { get(id: string): SeenDevice | undefined };

/**
 * How a device's tier is read. `ignoreLoad` is the mutation `keeps-a-tier-below-a-new-load`. `seen` is
 * what the bridges say of the devices (a computer's `proposed_infrastructure`, a plugin device's
 * `host`): without it, neither is read. `fingerprint` and `requested` are the action's declarations as
 * they stand and its manifest's `requested_tier`.
 */
export type TierRead = { ignoreLoad?: boolean; seen?: Seen; mutant?: Mutant; fingerprint?: string; requested?: Tier };

/**
 * A device's `infrastructure` as the tiers read it (applier, *Devices*): the owner's, set either way,
 * else its bridge's proposal. `sleeps-the-proposed-broker-host` reads the owner's alone.
 */
function infrastructureIn(c: Owned, id: string, o: TierRead): boolean {
  const own = c.declarations.get(id)?.infrastructure;
  if (own !== undefined) return own;
  return !o.mutant?.sleepsTheProposedBrokerHost && o.seen?.get(id)?.proposed_infrastructure === true;
}

/**
 * What the default tiers read of a device, as the owner declared it and its bridge says it: its
 * `infrastructure` (`infrastructureIn`), and on a device a computer hosts, that computer's
 * (applier, *Plugins' actions*), re-read each time, so a change of the host's flag re-derives the
 * devices it hosts in the same change set (GA-DESC-13).
 */
export function factsIn(c: Owned, id: string, o: TierRead = {}): TierFacts {
  const d = c.declarations.get(id) ?? {};
  const host = o.seen?.get(id)?.host;
  const hostClass = host === undefined ? undefined : c.adoptions.has(host) ? c.adoptions.get(host)!.class : o.seen?.get(host)?.proposed_class;
  return { cls: c.adoptions.get(id)?.class ?? null, load: o.ignoreLoad ? undefined : loadIn(c, id), infrastructure: infrastructureIn(c, id, o),
    opensWith: d.opens_with ?? "onoff.turn_on",
    ...(host !== undefined && hostClass === "computer" ? { host: { infrastructure: infrastructureIn(c, host, o),
      rows: !o.mutant?.sleepsTheBoxThroughItsPlayer, floor: !o.mutant?.extensionUnderTheBox } } : {}) };
}

/**
 * The tier a device's action has (GA-DESC-3): the higher of its floor and the owner's value where one
 * is set, its default where none is (`floorTier`, `defaultTier`), with its `requested_tier` where its
 * manifest gives one. Derived each time, never stored, so a change of load or flag re-applies the
 * table in the same change set and never rewrites the owner's value (GA-DESC-13). `fingerprint` is the
 * action's declarations as they stand: an owner's tier below the default, set on other declarations,
 * falls back to the default until the owner sets it again (GA-DESC-18, GA-DESC-11). A `kept_tiers`
 * entry is only ever written by the mutation `keeps-a-manifest-kept-tier`, and pins the tier above it.
 */
export function tierIn(c: Owned, id: string, action: string, o: TierRead = {}): Tier {
  const { fingerprint, requested } = o;
  const facts = factsIn(c, id, o);
  const floor = floorTier(facts, action, requested);
  const dflt = defaultTier(facts, action, requested);
  const d = c.declarations.get(id);
  const owner = d?.tiers?.[action];
  const pinned = d?.kept_tiers?.[action];
  const basis = d?.tier_basis?.[action];
  // `forgets-a-tool-hash`: a tier whose basis was not kept holds on whatever declarations come.
  const changed = fingerprint !== undefined && basis !== fingerprint && !(o.mutant?.forgetsAToolHash && basis === undefined);
  const tier = owner === undefined ? dflt : below(owner, dflt) && changed ? dflt : higher(owner, floor);
  return pinned ? higher(tier, pinned) : tier;
}

/**
 * The extension actions of `id` whose tier the owner set below the default on declarations that have
 * since changed (`fingerprintOf` gives them as they stand): they fall back to the default and stay
 * fallen back, the declaration's return included, until the owner sets them again, as a replacement's
 * do (GA-DESC-18, GA-DESC-11; the controller's ruling on the preflight's I2).
 */
export function fallenTiers(c: Owned, id: string, fingerprintOf: (action: string) => string | undefined,
  requestedOf: (action: string) => Tier | undefined = () => undefined, o: TierRead = {}): string[] {
  const d = c.declarations.get(id);
  return Object.entries(d?.tier_basis ?? {}).filter(([action, basis]) => {
    const owner = d!.tiers?.[action];
    return owner !== undefined && fingerprintOf(action) !== basis && below(owner, defaultTier(factsIn(c, id, o), action, requestedOf(action)));
  }).map(([action]) => action);
}

/** Drops the owner's tier of each of `actions` on `id`, and the declarations it was set on, from `draft`. */
export function dropTiers(draft: Config, id: string, actions: string[]): void {
  const d = draft.declarations.get(id);
  if (!d) return;
  for (const action of actions) {
    delete d.tiers?.[action];
    delete d.tier_basis?.[action];
  }
  tidy(draft, id);
}

export function offered(info: DeviceInfo, id: string, action: string): void {
  if (!info.actions.includes(action)) bad(`${id} offers no ${action}`);
}

/**
 * Sets one action's tier, the owner's value (GA-DESC-3, GA-DESC-14): any tier at or above the action's
 * floor, for a standard action as for an extension one. It is judged against the floor the whole change
 * set leaves (`judgeTiers`, once the set is applied), so a set that lowers a load and the tier together is
 * taken in either order; one below that floor is refused there, nothing changed, never clamped. A tier
 * equal to the one it has is kept too, as the owner's value; the diff says so only when what is kept
 * changes. `keeps-an-owner-raise-on-a-set` refuses any tier below the one the action has now, as 0.15 did.
 */
export function setTier(draft: Config, id: string, info: DeviceInfo, action: string, tier: Tier, ctx: Work): string | undefined {
  offered(info, id, action);
  if (ctx.mutant.keepsAnOwnerRaiseOnASet && !isExtension(action)) {
    const now = tierIn(draft, id, action, { requested: info.requested_tiers?.[action], seen: ctx.devices, mutant: ctx.mutant });
    if (below(tier, now)) bad(`${id} ${action} is ${now}; configure only raises a tier`);
  }
  (ctx.tiered ??= []).push({ id, action, tier, ...(ctx.at !== undefined ? { at: ctx.at } : {}) });
  const d = declared(draft, id);
  const tiers = (d.tiers ??= {});
  // An extension action's tier is set on its declarations as they stand: set again, it holds on new ones (GA-DESC-18).
  const basis = isExtension(action) ? info.fingerprints?.[action] : undefined;
  if (tiers[action] === tier && d.tier_basis?.[action] === basis) return undefined;
  tiers[action] = tier;
  if (basis !== undefined) (d.tier_basis ??= {})[action] = basis;
  return `~ tier ${id} ${action} ${tier}`;
}

/**
 * Deletes the owner's value of one action's tier (GA-DESC-3, GA-DESC-14): the action falls back to its
 * default, for a standard action as for an extension one, a replacement's kept tier included (GA-DESC-11).
 * `keeps-an-owner-raise` refuses it for a standard action, as 0.15 did.
 */
export function deleteTier(draft: Config, id: string, action: string, mutant: Mutant): string | undefined {
  if (mutant.keepsAnOwnerRaise && !isExtension(action)) bad("a tier is never lowered through configure (GA-DESC-3), except an extension action's");
  const d = draft.declarations.get(id);
  if (d?.tiers?.[action] === undefined) return undefined;
  delete d.tiers![action];
  delete d.tier_basis?.[action];
  tidy(draft, id);
  return `- tier ${id} ${action}`;
}

/**
 * The tiers a change set gave the owner's value, each judged against the floor the whole set leaves:
 * its own `load`, `infrastructure`, adoption and replacement changes applied (GA-DESC-14). One below it
 * is refused, nothing changed, never clamped. A value a later change of the set removed, or a device it
 * no longer holds, is not judged. `lowers-a-lock-extension` takes an extension action's below its floor,
 * and `lowers-a-heater-below-the-table` a standard action's: the floor then clamps it.
 */
export function judgeTiers(draft: Config, ctx: Work): void {
  for (const t of ctx.tiered ?? []) {
    const info = ctx.devices.get(t.id);
    if (!info || draft.declarations.get(t.id)?.tiers?.[t.action] !== t.tier) continue;
    const floor = floorTier(factsIn(draft, t.id, { seen: ctx.devices, mutant: ctx.mutant }), t.action, info.requested_tiers?.[t.action]);
    if (!below(t.tier, floor)) continue;
    if (isExtension(t.action) ? ctx.mutant.lowersALockExtension : ctx.mutant.lowersAHeaterBelowTheTable) continue;
    const where = t.at !== undefined ? `changes[${t.at}]: ` : "";
    bad(`${where}${t.id} ${t.action}'s floor is ${floor}, as the change set leaves it: a tier is set at or above its floor and no lower`);
  }
}

export function setLoad(draft: Config, id: string, load: Load, mutant?: Mutant, seen?: Seen): string | undefined {
  if (draft.adoptions.get(id)?.class !== "socket") bad(`a load is declared only on a socket, and ${id} is not an adopted socket`);
  const d = declared(draft, id);
  if (d.load === load) return undefined;
  // `keeps-a-table-tier-over-a-new-load`: a declared load changed to one with a lower floor leaves turn_on at
  // the tier the old load gave, written as the owner's value (GA-DESC-13 never writes the owner's value).
  const was = mutant?.keepsATableTierOverANewLoad && d.load !== undefined && d.tiers?.["onoff.turn_on"] === undefined
    ? tierIn(draft, id, "onoff.turn_on", { seen, mutant }) : undefined;
  d.load = load;
  if (was && below(tierIn(draft, id, "onoff.turn_on", { seen, mutant }), was)) (d.tiers ??= {})["onoff.turn_on"] = was;
  return `~ load ${id} ${load}`;
}

/** GA-CFG-3: a `max_on_s` above 86400 is refused; that it goes only with `load: heating` is checked on the whole set (`consistent`). */
export function setMaxOn(draft: Config, id: string, s: number): string | undefined {
  if (s > MAX_ON_MAX_S) bad(`max_on_s ${s} is above ${MAX_ON_MAX_S} (GA-CFG-3)`);
  const d = declared(draft, id);
  if (d.max_on_s === s) return undefined;
  d.max_on_s = s;
  return `~ max_on_s ${id} ${s}`;
}

/** The owner's `infrastructure`, either way, kept: it outranks the bridge's proposal; its delete leaves the proposal to decide. */
export function setInfrastructure(draft: Config, id: string, on: boolean): string | undefined {
  const d = declared(draft, id);
  if (d.infrastructure === on) return undefined;
  d.infrastructure = on;
  return `~ infrastructure ${id} ${on}`;
}

/**
 * The administrators of the computers that carry the broker (applier, *Safety rules*, GA-SAFE-6): of
 * each computer, adopted or proposed as one, whose `infrastructure` is true, the owner's or else its
 * bridge's proposal, and which is not the `applier_host`, its `os` entries, or its `unknown`. They run
 * the broker and its grants, so they are other admins of every device a safety rule actuates.
 * `counts-the-applier-hosts-admins` counts the applier host's too.
 */
export function brokerAdmins(c: Config, devices: ReadonlyMap<string, DeviceInfo>, mutant: Mutant):
  { computer: string; admins: { vendor: string; label: string }[] | "unknown" }[] {
  const out: { computer: string; admins: { vendor: string; label: string }[] | "unknown" }[] = [];
  for (const [id, info] of devices) {
    const cls = c.adoptions.has(id) ? c.adoptions.get(id)!.class : info.proposed_class;
    if (cls !== "computer") continue;
    const own = c.declarations.get(id);
    if (!(own?.infrastructure ?? info.proposed_infrastructure === true)) continue;
    if (own?.applier_host === true && !mutant.countsTheApplierHostsAdmins) continue;
    const admins = info.other_admins ?? "unknown";
    const os = admins === "unknown" ? admins : admins.filter((a) => a.vendor === "os");
    if (os === "unknown" || os.length) out.push({ computer: id, admins: os });
  }
  return out;
}

export function setFreshS(draft: Config, id: string, fresh: number): string | undefined {
  const d = declared(draft, id);
  if (d.fresh_s === fresh) return undefined;
  d.fresh_s = fresh;
  return `~ fresh_s ${id} ${fresh}`;
}

/** GA-CFG-3: at least 2, at least twice the device's `reach_s` plus 10, at most 300. */
export function setAckWithin(draft: Config, id: string, info: DeviceInfo, action: string, s: number): string | undefined {
  offered(info, id, action);
  if (s < ACK_MIN_S) bad(`ack_within_s ${s} is below ${ACK_MIN_S}`);
  if (s > ACK_MAX_S) bad(`ack_within_s ${s} is above ${ACK_MAX_S}`);
  if (info.reach_s !== undefined && s < 2 * info.reach_s + 10) bad(`ack_within_s ${s} is below twice ${id}'s reach_s (${info.reach_s}) plus 10`);
  const d = declared(draft, id);
  if (d.ack_within_s?.[action] === s) return undefined;
  (d.ack_within_s ??= {})[action] = s;
  return `~ ack_within_s ${id} ${action} ${s}`;
}

export type KeyList = "personal" | "self_changing";

/** The keys the standard declares on a device, by its adopted class. */
export const standardOf = (draft: Config, id: string, info: DeviceInfo) =>
  standardKeys(draft.adoptions.get(id)?.class ?? null, info.capabilities, info.actions, info.sensor_keys);

/** Adds a key to a device's `personal` or `self_changing`. */
export function addKey(draft: Config, id: string, info: DeviceInfo, list: KeyList, key: string): string | undefined {
  const d = declared(draft, id);
  if (union(standardOf(draft, id, info)[list], info[list], d[list]).includes(key)) {
    tidy(draft, id);
    return undefined;
  }
  (d[list] ??= []).push(key);
  return `+ ${list} ${id} ${key}`;
}

/** Removes a key the owner added; one the standard or the bridge declares is never removed (GA-DESC-9). */
export function removeKey(draft: Config, id: string, info: DeviceInfo, list: KeyList, key: string): string {
  if (standardOf(draft, id, info)[list].includes(key)) bad(`the standard declares ${key} ${list} on ${id}`);
  if (info[list].includes(key)) bad(`${id}'s bridge declares ${key} ${list}`);
  const d = draft.declarations.get(id);
  if (!d?.[list]?.includes(key)) bad(`${id} has no ${list} key ${key} of the owner's`);
  d![list] = d![list]!.filter((k) => k !== key);
  tidy(draft, id);
  return `- ${list} ${id} ${key}`;
}

/**
 * An adoption's declarations, each checked as its own kind would check it, the class, load, flag and
 * `opens_with` first, since the tiers are judged against them.
 */
export function declare(draft: Config, id: string, info: DeviceInfo, d: Declarations, mutant: Mutant, ctx: Work): string[] {
  const lines: (string | undefined)[] = [];
  if (d.opens_with !== undefined) {
    if (!VALVES.has(draft.adoptions.get(id)?.class ?? "")) bad(`opens_with is declared only on a water or gas valve, and ${id} is not one`);
    offered(info, id, d.opens_with);
    const held = declared(draft, id);
    if (held.opens_with !== d.opens_with) lines.push(`~ opens_with ${id} ${d.opens_with}`);
    held.opens_with = d.opens_with;
  }
  if (d.load !== undefined) lines.push(setLoad(draft, id, d.load, mutant, ctx.devices));
  if (d.max_on_s !== undefined) lines.push(setMaxOn(draft, id, d.max_on_s));
  if (d.infrastructure !== undefined) lines.push(setInfrastructure(draft, id, d.infrastructure));
  for (const [action, tier] of Object.entries(d.tiers ?? {})) lines.push(setTier(draft, id, info, action, tier, ctx));
  if (d.fresh_s !== undefined) lines.push(setFreshS(draft, id, d.fresh_s));
  for (const [action, s] of Object.entries(d.ack_within_s ?? {})) lines.push(setAckWithin(draft, id, info, action, s));
  for (const key of d.personal ?? []) lines.push(addKey(draft, id, info, "personal", key));
  for (const key of d.self_changing ?? []) lines.push(addKey(draft, id, info, "self_changing", key));
  tidy(draft, id);
  return lines.filter((l): l is string => !!l);
}

/**
 * `adopt` with `replaces` (applier, *Adoption*, GA-ADOPT-2): the new hardware takes the replaced
 * device's id, with the class the owner gives, the old device's declarations but an owner-set
 * `fresh_s`, and the adoption's own declarations on top; the old identifier goes to the end of
 * `previous_identifiers`, unless the hardware is the same. Refused when the old device is not adopted
 * or the new one is, when the new hardware's identifier was retired from that id (it never takes the
 * id back), and when the new device lacks an action or state key the old one's declarations use.
 * The PC slice adds a plugin device's exceptions, and slice 6 the safety rules it inherits.
 */
export function replace(draft: Config, a: AdoptValue & { replaces: string }, info: DeviceInfo, ctx: Work): string {
  const old = a.replaces;
  if (old === a.device) bad(`${a.device} cannot replace itself`);
  const was = device(ctx, old);
  if (ctx.replaced.some((r) => r.replaces === old)) bad(`${old} is replaced already in this change set`);
  if (!draft.adoptions.has(old)) bad(`${old} is not adopted: a replacement takes an adopted device's id`);
  if (draft.adoptions.has(a.device)) bad(`${a.device} is adopted already: only a device not yet adopted replaces another`);
  const previous = draft.previous.get(old) ?? [];
  if (previous.includes(info.stable_identifier)) {
    bad(`${info.stable_identifier} was retired from ${old}: replaced hardware never takes the id back`);
  }
  const kept = draft.declarations.get(old) ?? {};
  // The tier each action had on the old hardware, the owner's value included: what a lower manifest keeps (GA-DESC-11).
  const read = { seen: ctx.devices, mutant: ctx.mutant };
  const had = new Map(was.actions.map((x): [string, Tier] => [x, tierIn(draft, old, x, { ...read, fingerprint: was.fingerprints?.[x], requested: was.requested_tiers?.[x] })]));
  // The safety rules naming the old device follow its id (GA-ADOPT-2): the new hardware must offer what they use.
  const ruled = [...draft.rules.values()].filter((r) => devicesOf(r).includes(old));
  const actions = union(Object.keys(kept.tiers ?? {}), Object.keys(kept.ack_within_s ?? {}), Object.keys(kept.witnesses ?? {}),
    kept.opens_with ? [kept.opens_with] : [],
    ruled.flatMap((r) => r.actions.filter((x) => x.target === old).map((x) => x.action)));
  const keys = union(kept.personal, kept.self_changing, ruled.flatMap((r) => reads(r).filter((t) => t.device === old).map((t) => t.key)));
  const offered = [...reported(info.capabilities, info.actions, info.sensor_keys), ...info.extension_keys?.state ?? []];
  const lacking = [...actions.filter((x) => !info.actions.includes(x)), ...keys.filter((k) => !offered.includes(k))];
  if (lacking.length) bad(`${a.device} lacks ${lacking.join(", ")}, which ${old}'s declarations or safety rules use`);
  // `replaces-without-rules`: the new hardware takes the id alone, its rules gone with the old hardware.
  if (ctx.mutant.replacesWithoutRules) for (const r of ruled) draft.rules.delete(r.id);
  ctx.ruled.push(...ruled.map((r) => r.id));
  drop(draft, a.device, { retired: true });
  draft.adoptions.set(old, { class: a.class });
  // `replaces-without-rules`: the new hardware takes the id alone.
  const next = ctx.mutant.replacesWithoutRules ? {} : structuredClone(kept);
  delete next.fresh_s;
  draft.declarations.set(old, next);
  if (was.stable_identifier !== info.stable_identifier) draft.previous.set(old, [...previous, was.stable_identifier]);
  // The same hardware on another bridge: the replacement moves the adopted device there, and its route follows.
  else if (draft.routes.has(info.stable_identifier)) draft.routes.set(info.stable_identifier, info.bridge);
  // `keeps-a-lowered-tier`: every tier the owner set is set again on the new declarations, a lowered one kept.
  if (ctx.mutant.keepsALoweredTier) {
    const basis = next.tier_basis ?? {};
    for (const action of Object.keys(basis)) if (info.fingerprints?.[action] !== undefined) basis[action] = info.fingerprints[action]!;
  }
  ctx.devices.delete(a.device);
  ctx.devices.set(old, info);
  ctx.replaced.push({ device: a.device, replaces: old });
  const lines = [`~ adopt ${old} (${a.class}) as ${a.device}, replacing ${was.stable_identifier}`];
  // A manifest that lowers an action's requested_tier does not lower its tier by itself: the tier it had
  // is kept, stored as the owner's value, which the owner may delete like any other (GA-DESC-11).
  for (const action of info.actions) {
    // `lowers-by-a-new-manifest`: the new manifest's lower formula taken as it stands.
    if (ctx.mutant.lowersByANewManifest) break;
    const before = was.requested_tiers?.[action];
    const after = info.requested_tiers?.[action];
    const tier = had.get(action);
    if (!tier || !before || (after && !below(after, before))) continue;
    if (!below(tierIn(draft, old, action, { ...read, fingerprint: info.fingerprints?.[action], requested: after }), tier)) continue;
    const d = declared(draft, old);
    // `keeps-a-manifest-kept-tier`: kept as a pin beside the owner's value, which no delete reaches.
    if (ctx.mutant.keepsAManifestKeptTier) (d.kept_tiers ??= {})[action] = tier;
    else {
      (d.tiers ??= {})[action] = tier;
      const basis = info.fingerprints?.[action];
      if (isExtension(action) && basis !== undefined) (d.tier_basis ??= {})[action] = basis;
      else delete d.tier_basis?.[action];
    }
    lines.push(`~ tier ${old} ${action} ${tier} (kept from ${was.stable_identifier}: its manifest requests ${after ?? "none"})`);
  }
  return [...lines, ...declare(draft, old, info, a.declarations ?? {}, ctx.mutant, ctx)].join("\n");
}

/**
 * Drops what the owner holds for an id: its adoption and its declarations, and with `retired` the
 * identifiers it retired. An adoption's delete keeps those, so hardware the id replaced still never
 * takes it back when the owner adopts it again; a forget and a replacement's new hardware drop them.
 */
export function drop(draft: Config, id: string, o: { retired: boolean }): void {
  draft.adoptions.delete(id);
  draft.declarations.delete(id);
  if (o.retired) draft.previous.delete(id);
}

/** A declaration's `delete` names at least its device, and for `tier` and `ack_within_s` the action, for the keys the key. */
export function deleting(value: unknown, fields: string[]): Record<string, string> {
  const v = (value ?? {}) as Record<string, unknown>;
  for (const f of fields) if (typeof v[f] !== "string" || !v[f]) bad(`a delete names its ${fields.join(" and ")}`);
  return v as Record<string, string>;
}

export function idOf(value: unknown): string {
  return checked<{ id: string }>("applier/configure.bridge.json", { identity: "-", ...(value as object) }).id;
}

export function keyKind(draft: Config, change: Change, ctx: Ctx, list: KeyList): string | undefined {
  const v = change.op === "delete" ? deleting(change.value, ["device", "key"])
    : checked<{ device: string; key: string }>(`applier/configure.${list}.json`, change.value);
  const info = device(ctx, v.device!);
  return change.op === "delete" ? removeKey(draft, v.device!, info, list, v.key!) : addKey(draft, v.device!, info, list, v.key!);
}

export const stateKeys = (info: DeviceInfo): string[] => [...reported(info.capabilities, info.actions, info.sensor_keys), ...info.extension_keys?.state ?? []];
