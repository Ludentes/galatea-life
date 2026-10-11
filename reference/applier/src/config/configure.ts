import { hashSecret, sameSecret } from "../core/secret.js";
import { validate } from "@ludentes/galatea-life-schemas";
import { RequestError } from "../core/errors.js";
import { isExtension, type ConfirmedBy, type Constraint } from "../bus/wire.js";
import {
  below, defaultTier, extensionFloor, higher, MAX_ON_MAX_S, reported, standardKeys, union, VALVES, type Declarations, type Load, type Tier,
  type TierFacts,
} from "../model/declarations.js";
import type { Mutation } from "../mutations.js";
import { argsFault, numberArg, sets } from "../gate/actions.js";
import { canonical } from "../core/canonical.js";
import type { Witness } from "../safety/witnesses.js";
import { actuated, devicesOf, reads, type SafetyRule } from "../safety/language.js";
import { copyConfig, type Bridge, type Client, type Config, type Level } from "./config.js";

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
  /** The keys its bridge awaits, promised and not yet reported (GA-DESC-19): named in a refusal's `data` (GA-SAFE-14). */
  awaited_keys?: string[];
};
/**
 * `devices`: the devices the model holds now, which an adoption and a declaration must name. `levels`:
 * the levels this build can claim; it claims Safe only while the owner's `box` is set and no bridge
 * declares an `ungoverned` path (GA-DESC-6). `plainOffLoopback`: its own broker connection is plain
 * TCP to a host off loopback, so `box: true` is refused.
 */
type Ctx = { levels: Level[]; underHarness: boolean; ownerCredential: string; devices?: ReadonlyMap<string, DeviceInfo>;
  /** The applier's own MQTT identity: no bridge may hold it. */
  ownIdentity?: string;
  mutation?: Mutation; ungoverned?: boolean; plainOffLoopback?: boolean;
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
type Work = Ctx & { devices: Map<string, DeviceInfo> } & Required<Effects> & {
  /** The safety rules this set changed, or whose device it replaced: checked whole once the set is applied. */
  ruled: string[] };
type AdoptValue = { device: string; class: string | null; declarations?: Declarations; replaces?: string };

/**
 * Kinds that need the Safe level (applier, *Conformance levels*): not_claimed below it (GA-LVL-1).
 * A device's `load` is not among them: declaring it raises the device's tiers (GA-DESC-13, Act);
 * only its on-time cap is Safe (the maintainer, 2026-09-28; a standards fix this build shows).
 */
const SAFE_KINDS = new Set(["safety_rule", "max_on_s", "witness", "clear_latch", "accepts_other_admins"]);
/** Fields of an adoption's declarations that need the Safe level: not_claimed below it, before the schema (GA-LVL-1). */
const SAFE_DECLARATIONS = ["max_on_s"];

type Kind = (draft: Config, change: Change, ctx: Work) => string | undefined;

const bad = (message: string): never => { throw new RequestError("invalid_request", message); };

function checked<T>(schema: string, value: unknown): T {
  const errors = validate(schema, value);
  if (errors.length) bad(`${schema}: ${errors.join("; ")}`);
  return value as T;
}

/** GA-CFG-3's bounds on `ack_within_s`. */
export const ACK_MIN_S = 2;
export const ACK_MAX_S = 300;

function device(ctx: Ctx, id: string): DeviceInfo {
  const d = ctx.devices?.get(id);
  if (!d) bad(`no device ${id}`);
  return d!;
}

function declared(draft: Config, id: string): Declarations {
  let d = draft.declarations.get(id);
  if (!d) draft.declarations.set(id, d = {});
  return d;
}

/** Drops a device's declarations once nothing is left in them, so an empty record is no model change. */
function tidy(draft: Config, id: string): void {
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

type Owned = { adoptions: ReadonlyMap<string, { class: string | null }>; declarations: ReadonlyMap<string, Declarations>; safe?: boolean };

/**
 * A device's load as the tiers read it: the owner's, else, on a build that can claim Safe, `heating`
 * for a socket, so that no heater hides behind an undeclared load (GA-DESC-8); else none.
 */
export function loadIn(c: Owned, id: string): Load | undefined {
  return c.declarations.get(id)?.load ?? (c.safe && c.adoptions.get(id)?.class === "socket" ? "heating" : undefined);
}

/** What the default tiers read of a device, as the owner declared it. `ignoreLoad` is the mutation `keeps-a-tier-below-a-new-load`. */
function factsIn(c: Owned, id: string, ignoreLoad = false): TierFacts {
  const d = c.declarations.get(id) ?? {};
  return { cls: c.adoptions.get(id)?.class ?? null, load: ignoreLoad ? undefined : loadIn(c, id), infrastructure: d.infrastructure === true,
    opensWith: d.opens_with ?? "onoff.turn_on" };
}

/**
 * The tier a device's action has: the table's, raised by the owner's (GA-DESC-3); an extension
 * action's, the owner's where the owner set one, which may be below the table down to its floor, and
 * never below the floor as it stands now. Derived each time, never stored, so a change of load or
 * flag re-applies the table in the same change set (GA-DESC-13). `fingerprint` is the action's
 * declarations as they stand: an owner's tier below the table, set on other declarations, falls back
 * to the table until the owner sets it again (GA-DESC-18).
 */
export function tierIn(c: Owned, id: string, action: string, ignoreLoad = false, fingerprint?: string): Tier {
  const facts = factsIn(c, id, ignoreLoad);
  const table = defaultTier(facts, action);
  const d = c.declarations.get(id);
  const owner = d?.tiers?.[action];
  if (owner && isExtension(action)) {
    if (below(owner, table) && fingerprint !== undefined && d?.tier_basis?.[action] !== fingerprint) return table;
    return higher(owner, extensionFloor(facts));
  }
  return owner && below(table, owner) ? owner : table;
}

/**
 * The extension actions of `id` whose tier the owner lowered on declarations that have since changed
 * (`fingerprintOf` gives them as they stand): they fall back to the table and stay fallen back, the
 * declaration's return included, until the owner sets them again, as a replacement's do
 * (GA-DESC-18, GA-DESC-11; the controller's ruling on the preflight's I2).
 */
export function fallenTiers(c: Owned, id: string, fingerprintOf: (action: string) => string | undefined): string[] {
  const d = c.declarations.get(id);
  return Object.entries(d?.tier_basis ?? {}).filter(([action, basis]) => {
    const owner = d!.tiers?.[action];
    return owner !== undefined && fingerprintOf(action) !== basis && below(owner, defaultTier(factsIn(c, id), action));
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

function offered(info: DeviceInfo, id: string, action: string): void {
  if (!info.actions.includes(action)) bad(`${id} offers no ${action}`);
}

/**
 * Sets one action's tier. A standard action's is only raised: a tier below the one it has is refused,
 * never clamped (GA-DESC-3). An extension action's may go down to its floor, and below it is refused,
 * nothing changed, never clamped (GA-DESC-14; `lowers-a-lock-extension` takes it, and the floor clamps
 * it). A tier equal to the one it has is kept too, so a later change of load or flag that lowers the
 * table's floor does not lose it; the diff says so only when what is kept changes.
 */
function setTier(draft: Config, id: string, info: DeviceInfo, action: string, tier: Tier, mutation?: Mutation): string | undefined {
  offered(info, id, action);
  if (isExtension(action)) {
    const floor = extensionFloor(factsIn(draft, id));
    if (below(tier, floor) && mutation !== "lowers-a-lock-extension") {
      bad(`${id} ${action}'s floor is ${floor}: an extension action is lowered to its floor and no further`);
    }
  } else {
    const now = tierIn(draft, id, action);
    if (below(tier, now)) bad(`${id} ${action} is ${now}; configure only raises a tier`);
  }
  const d = declared(draft, id);
  const tiers = (d.tiers ??= {});
  // An extension action's tier is set on its declarations as they stand: set again, it holds on new ones (GA-DESC-18).
  const basis = isExtension(action) ? info.fingerprints?.[action] : undefined;
  if (tiers[action] === tier && d.tier_basis?.[action] === basis) return undefined;
  tiers[action] = tier;
  if (basis !== undefined) (d.tier_basis ??= {})[action] = basis;
  return `~ tier ${id} ${action} ${tier}`;
}

function setLoad(draft: Config, id: string, load: Load): string | undefined {
  if (draft.adoptions.get(id)?.class !== "socket") bad(`a load is declared only on a socket, and ${id} is not an adopted socket`);
  const d = declared(draft, id);
  if (d.load === load) return undefined;
  d.load = load;
  return `~ load ${id} ${load}`;
}

/** GA-CFG-3: a `max_on_s` above 86400 is refused; that it goes only with `load: heating` is checked on the whole set (`consistent`). */
function setMaxOn(draft: Config, id: string, s: number): string | undefined {
  if (s > MAX_ON_MAX_S) bad(`max_on_s ${s} is above ${MAX_ON_MAX_S} (GA-CFG-3)`);
  const d = declared(draft, id);
  if (d.max_on_s === s) return undefined;
  d.max_on_s = s;
  return `~ max_on_s ${id} ${s}`;
}

/** The owner's `infrastructure`, either way, kept: it outranks the bridge's proposal; its delete leaves the proposal to decide. */
function setInfrastructure(draft: Config, id: string, on: boolean): string | undefined {
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
export function brokerAdmins(c: Config, devices: ReadonlyMap<string, DeviceInfo>, mutation?: Mutation):
  { computer: string; admins: { vendor: string; label: string }[] | "unknown" }[] {
  const out: { computer: string; admins: { vendor: string; label: string }[] | "unknown" }[] = [];
  for (const [id, info] of devices) {
    const cls = c.adoptions.has(id) ? c.adoptions.get(id)!.class : info.proposed_class;
    if (cls !== "computer") continue;
    const own = c.declarations.get(id);
    if (!(own?.infrastructure ?? info.proposed_infrastructure === true)) continue;
    if (own?.applier_host === true && mutation !== "counts-the-applier-hosts-admins") continue;
    const admins = info.other_admins ?? "unknown";
    const os = admins === "unknown" ? admins : admins.filter((a) => a.vendor === "os");
    if (os === "unknown" || os.length) out.push({ computer: id, admins: os });
  }
  return out;
}

function setFreshS(draft: Config, id: string, fresh: number): string | undefined {
  const d = declared(draft, id);
  if (d.fresh_s === fresh) return undefined;
  d.fresh_s = fresh;
  return `~ fresh_s ${id} ${fresh}`;
}

/** GA-CFG-3: at least 2, at least twice the device's `reach_s` plus 10, at most 300. */
function setAckWithin(draft: Config, id: string, info: DeviceInfo, action: string, s: number): string | undefined {
  offered(info, id, action);
  if (s < ACK_MIN_S) bad(`ack_within_s ${s} is below ${ACK_MIN_S}`);
  if (s > ACK_MAX_S) bad(`ack_within_s ${s} is above ${ACK_MAX_S}`);
  if (info.reach_s !== undefined && s < 2 * info.reach_s + 10) bad(`ack_within_s ${s} is below twice ${id}'s reach_s (${info.reach_s}) plus 10`);
  const d = declared(draft, id);
  if (d.ack_within_s?.[action] === s) return undefined;
  (d.ack_within_s ??= {})[action] = s;
  return `~ ack_within_s ${id} ${action} ${s}`;
}

type KeyList = "personal" | "self_changing";

/** The keys the standard declares on a device, by its adopted class. */
const standardOf = (draft: Config, id: string, info: DeviceInfo) =>
  standardKeys(draft.adoptions.get(id)?.class ?? null, info.capabilities, info.actions, info.sensor_keys);

/** Adds a key to a device's `personal` or `self_changing`. */
function addKey(draft: Config, id: string, info: DeviceInfo, list: KeyList, key: string): string | undefined {
  const d = declared(draft, id);
  if (union(standardOf(draft, id, info)[list], info[list], d[list]).includes(key)) {
    tidy(draft, id);
    return undefined;
  }
  (d[list] ??= []).push(key);
  return `+ ${list} ${id} ${key}`;
}

/** Removes a key the owner added; one the standard or the bridge declares is never removed (GA-DESC-9). */
function removeKey(draft: Config, id: string, info: DeviceInfo, list: KeyList, key: string): string {
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
function declare(draft: Config, id: string, info: DeviceInfo, d: Declarations, mutation?: Mutation): string[] {
  const lines: (string | undefined)[] = [];
  if (d.opens_with !== undefined) {
    if (!VALVES.has(draft.adoptions.get(id)?.class ?? "")) bad(`opens_with is declared only on a water or gas valve, and ${id} is not one`);
    offered(info, id, d.opens_with);
    const held = declared(draft, id);
    if (held.opens_with !== d.opens_with) lines.push(`~ opens_with ${id} ${d.opens_with}`);
    held.opens_with = d.opens_with;
  }
  if (d.load !== undefined) lines.push(setLoad(draft, id, d.load));
  if (d.max_on_s !== undefined) lines.push(setMaxOn(draft, id, d.max_on_s));
  if (d.infrastructure !== undefined) lines.push(setInfrastructure(draft, id, d.infrastructure));
  for (const [action, tier] of Object.entries(d.tiers ?? {})) lines.push(setTier(draft, id, info, action, tier, mutation));
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
function replace(draft: Config, a: AdoptValue & { replaces: string }, info: DeviceInfo, ctx: Work): string {
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
  if (ctx.mutation === "replaces-without-rules") for (const r of ruled) draft.rules.delete(r.id);
  ctx.ruled.push(...ruled.map((r) => r.id));
  drop(draft, a.device, { retired: true });
  draft.adoptions.set(old, { class: a.class });
  // `replaces-without-rules`: the new hardware takes the id alone.
  const next = ctx.mutation === "replaces-without-rules" ? {} : structuredClone(kept);
  delete next.fresh_s;
  draft.declarations.set(old, next);
  if (was.stable_identifier !== info.stable_identifier) draft.previous.set(old, [...previous, was.stable_identifier]);
  // The same hardware on another bridge: the replacement moves the adopted device there, and its route follows.
  else if (draft.routes.has(info.stable_identifier)) draft.routes.set(info.stable_identifier, info.bridge);
  ctx.devices.delete(a.device);
  ctx.devices.set(old, info);
  ctx.replaced.push({ device: a.device, replaces: old });
  return [`~ adopt ${old} (${a.class}) as ${a.device}, replacing ${was.stable_identifier}`,
    ...declare(draft, old, info, a.declarations ?? {}, ctx.mutation)].join("\n");
}

/**
 * Drops what the owner holds for an id: its adoption and its declarations, and with `retired` the
 * identifiers it retired. An adoption's delete keeps those, so hardware the id replaced still never
 * takes it back when the owner adopts it again; a forget and a replacement's new hardware drop them.
 */
function drop(draft: Config, id: string, o: { retired: boolean }): void {
  draft.adoptions.delete(id);
  draft.declarations.delete(id);
  if (o.retired) draft.previous.delete(id);
}

/** A declaration's `delete` names at least its device, and for `tier` and `ack_within_s` the action, for the keys the key. */
function deleting(value: unknown, fields: string[]): Record<string, string> {
  const v = (value ?? {}) as Record<string, unknown>;
  for (const f of fields) if (typeof v[f] !== "string" || !v[f]) bad(`a delete names its ${fields.join(" and ")}`);
  return v as Record<string, string>;
}

function idOf(value: unknown): string {
  return checked<{ id: string }>("applier/configure.bridge.json", { identity: "-", ...(value as object) }).id;
}

const KINDS: Record<string, Kind> = {
  ignore_candidate(draft, change, ctx) {
    if (change.op !== "upsert") bad("ignore_candidate takes only upsert");
    const { id } = checked<{ id: string }>("applier/configure.ignore_candidate.json", change.value);
    const c = ctx.listed?.().find((x) => x.id === id);
    if (!c) return bad(`candidate ${id} is not listed`);
    const added = c.keys.filter((k) => !draft.ignored_keys.has(k));
    for (const k of added) draft.ignored_keys.add(k);
    return added.length ? `+ ignored ${added.join(", ")}` : undefined;
  },
  unignore_candidate(draft, change) {
    if (change.op !== "upsert") bad("unignore_candidate takes only upsert");
    const { key } = checked<{ key: string }>("applier/configure.unignore_candidate.json", change.value);
    if (!draft.ignored_keys.delete(key)) bad(`key ${key} is not ignored`);
    return `- ignored ${key}`;
  },
  client(draft, change, ctx) {
    if (change.op === "delete") {
      const id = (change.value as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !draft.clients.has(id)) return bad(`no client ${String(id)}`);
      draft.clients.delete(id);
      return `- client ${id}`;
    }
    const c = checked<Omit<Client, "credential_sha256"> & { credential: string }>("applier/configure.client.json", change.value);
    // Only its SHA-256 is held (the whole-applier review's M6).
    const hash = hashSecret(c.credential);
    const next: Client = { id: c.id, credential_sha256: hash, kind: c.kind, ...(c.token_key ? { token_key: c.token_key } : {}) };
    if (sameSecret(c.credential, ctx.ownerCredential)) bad("a client may not hold the owner's credential");
    // Two secrets, so a leaked bearer does not also mint a person's yes (the design's token_key).
    if (c.token_key !== undefined && c.token_key === c.credential) bad("a client's token key may not be its credential");
    for (const other of draft.clients.values()) {
      if (other.id !== c.id && sameSecret(other.credential_sha256, hash)) bad(`client ${other.id} already holds that credential`);
    }
    const held = draft.clients.get(c.id);
    draft.clients.set(c.id, next);
    if (held && JSON.stringify(held) === JSON.stringify(next)) return undefined;
    return `${held ? "~" : "+"} client ${c.id} (${c.kind})`;
  },
  bridge(draft, change, ctx) {
    if (change.op === "delete") {
      const id = idOf(change.value);
      if (!draft.bridges.has(id)) bad(`no bridge ${id}`);
      draft.bridges.delete(id);
      return `- bridge ${id}`;
    }
    const b = checked<Bridge>("applier/configure.bridge.json", change.value);
    // One identity, one bridge: messages are routed by identity, so a second bridge on it would never be
    // fed, and deleting either would unsubscribe the topics the other hears.
    if (ctx.ownIdentity !== undefined && b.identity === ctx.ownIdentity) bad(`identity ${b.identity} is the applier's own`);
    for (const other of draft.bridges.values()) {
      if (other.id !== b.id && other.identity === b.identity) bad(`bridge ${other.id} already holds identity ${b.identity}`);
    }
    const held = draft.bridges.get(b.id);
    draft.bridges.set(b.id, { id: b.id, identity: b.identity });
    if (held && held.identity === b.identity) return undefined;
    return `${held ? "~" : "+"} bridge ${b.id}`;
  },
  /**
   * `adopt { device, class, declarations?, replaces? }` (applier, *Adoption*): a device the model
   * holds, with the owner's class and declarations, each declaration checked as its kind is.
   * A null class is only for a plugin device or a wake relay's entry, which the PC slice brings: it
   * is refused here until then. Its delete makes the device unadopted again.
   */
  adopt(draft, change, ctx) {
    if (change.op === "delete") {
      // The device goes back to unadopted, every action refused again; the owner's declarations,
      // made for the class it had, go with the adoption.
      const { device: id } = deleting(change.value, ["device"]);
      if (!draft.adoptions.has(id)) bad(`${id} is not adopted`);
      drop(draft, id, { retired: false });
      return `- adopt ${id}`;
    }
    const raw = (change.value as { declarations?: unknown } | undefined)?.declarations;
    for (const f of SAFE_DECLARATIONS) {
      if (raw && typeof raw === "object" && Object.hasOwn(raw, f) && !claimsOf(draft, ctx).includes("Safe")) {
        throw new RequestError("not_claimed", `declarations.${f} needs the Safe level, which this applier does not claim`);
      }
    }
    const a = checked<AdoptValue>("applier/configure.adopt.json", change.value);
    const info = device(ctx, a.device);
    if (a.class === null) bad(`a class may be null only for a plugin device or a wake relay's entry, and ${a.device} is neither`);
    if (a.replaces !== undefined) return replace(draft, { ...a, replaces: a.replaces }, info, ctx);
    const held = draft.adoptions.get(a.device);
    // GA-BUS-11: a copy another bridge shows beside an adopted device stays a device of its own, never
    // merged; adopting it too would give one piece of hardware two ids. An adoption with replaces moves
    // the adopted device onto it.
    const copy = held ? undefined : [...ctx.devices].find(([id, d]) => id !== a.device && d.bridge !== info.bridge
      && d.stable_identifier === info.stable_identifier)?.[0];
    if (copy) bad(`${a.device} shows the identifier ${JSON.stringify(info.stable_identifier)} that ${copy} shows on another bridge: `
      + `one piece of hardware on two bridges; an adopted device keeps its bridge, and an adoption of ${a.device} with replaces `
      + `${copy} moves it here`);
    // Route first: the one device two bridges report is adopted only once the owner says which carries it.
    if (!held && info.copies?.length && !draft.routes.has(info.stable_identifier)) {
      bad(`${a.device} is one device that bridges ${[info.bridge, ...info.copies].join(", ")} report: route it first `
        + `(a route of ${JSON.stringify(info.stable_identifier)} to one of them), then adopt it`);
    }
    draft.adoptions.set(a.device, { class: a.class });
    const lines = held && held.class === a.class ? [] : [`${held ? "~" : "+"} adopt ${a.device} (${a.class})`];
    lines.push(...declare(draft, a.device, info, a.declarations ?? {}, ctx.mutation));
    return lines.join("\n") || undefined;
  },
  tier(draft, change, ctx) {
    if (change.op === "delete") {
      // Deleting an extension action's owner tier gives it the table's again, at or above its floor (GA-DESC-14).
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      if (!isExtension(action!)) bad("a tier is never lowered through configure (GA-DESC-3), except an extension action's");
      device(ctx, id!);
      const d = draft.declarations.get(id!);
      if (d?.tiers?.[action!] === undefined) return undefined;
      delete d.tiers![action!];
      delete d.tier_basis?.[action!];
      tidy(draft, id!);
      return `- tier ${id} ${action}`;
    }
    const v = checked<{ device: string; action: string; tier: Tier }>("applier/configure.tier.json", change.value);
    return setTier(draft, v.device, device(ctx, v.device), v.action, v.tier, ctx.mutation);
  },
  load(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (!d?.load) return undefined;
      delete d.load;
      tidy(draft, id);
      return `- load ${id}`;
    }
    const v = checked<{ device: string; load: Load }>("applier/configure.load.json", change.value);
    device(ctx, v.device);
    return setLoad(draft, v.device, v.load);
  },
  /**
   * `max_on_s` (applier, *Loads*, GA-LOAD-2): how long a heating load may be on continuously before the
   * applier turns it off; Safe, so `not_claimed` below it (GA-LVL-1). Its delete gives the default back.
   */
  max_on_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.max_on_s === undefined) return undefined;
      delete d.max_on_s;
      tidy(draft, id);
      return `- max_on_s ${id}`;
    }
    const v = checked<{ device: string; max_on_s: number }>("applier/configure.max_on_s.json", change.value);
    device(ctx, v.device);
    return setMaxOn(draft, v.device, v.max_on_s);
  },
  /**
   * `witness` (applier, *Safety rules*, GA-WIT-1): the sensor that says whether a device's action did
   * what it asked, its expectation and its `within_s`, on an action the device offers, over a device
   * the model holds that reports a sensor key, read on the key it names, one of the sensor's, or else
   * on its first, which is kept as its key from then on, so a restart cannot lose what it read (the
   * whole-applier review's M8); `toward` names an argument of
   * the action that takes a number. Safe, so `not_claimed` below it (GA-LVL-1). Its delete names the
   * device and the action.
   */
  witness(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      device(ctx, id!);
      const d = draft.declarations.get(id!);
      if (d?.witnesses?.[action!] === undefined) return undefined;
      delete d.witnesses[action!];
      tidy(draft, id!);
      return `- witness ${id} ${action}`;
    }
    const v = checked<Witness & { device: string; action: string }>("applier/configure.witness.json", change.value);
    offered(device(ctx, v.device), v.device, v.action);
    const sensor = device(ctx, v.sensor);
    const keys = sensor.sensor_keys;
    if (v.key !== undefined && !keys.includes(v.key)) {
      // A key it declares, but not among its sensor keys (a lamp's `on`): no GA-SAFE-14 refusal, which is for an undeclared key.
      if (stateKeys(sensor).includes(v.key)) bad(`${v.sensor}'s ${v.key} is not among its sensor keys, which a witness reads`);
      // GA-SAFE-14: named, with whether its bridge awaits it.
      const awaited = sensor.awaited_keys?.includes(v.key) ?? false;
      throw new RequestError("invalid_request", `${v.sensor} declares no sensor key ${v.key} for a witness to read`
        + `${awaited ? ", which its bridge awaits: it has not reported it yet" : ""}`, { key: v.key, device: v.sensor, awaited });
    }
    if (!keys.length) {
      const awaited = sensor.awaited_keys ?? [];
      bad(`${v.sensor} declares no sensor key a witness could read${awaited.length
        ? `; its bridge awaits ${awaited.join(", ")}, not reported yet: name one as the witness's key once it is` : ""}`);
    }
    if (typeof v.expect === "object" && "toward" in v.expect && !numberArg(v.action, v.expect.toward.arg)) {
      bad(`${v.action} takes no number ${v.expect.toward.arg} for a witness to move towards`);
    }
    const next: Witness = { sensor: v.sensor, key: v.key ?? keys[0]!, expect: v.expect, within_s: v.within_s };
    const d = declared(draft, v.device);
    if (canonical(d.witnesses?.[v.action]) === canonical(next)) return undefined;
    (d.witnesses ??= {})[v.action] = next;
    return `~ witness ${v.device} ${v.action} ${v.sensor}`;
  },
  /**
   * `applier_host` (applier, *Devices*): the computer the applier itself runs on; its administrators are
   * not the other admins of the broker it carries (GA-SAFE-6). That it names an adopted computer, and
   * no second one, is checked on the whole set (`consistent`, GA-CFG-3). Its delete clears it.
   */
  applier_host(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.applier_host === undefined) return undefined;
      delete d.applier_host;
      tidy(draft, id);
      return `- applier_host ${id}`;
    }
    const v = checked<{ device: string; applier_host: boolean }>("applier/configure.applier_host.json", change.value);
    device(ctx, v.device);
    const d = declared(draft, v.device);
    if ((d.applier_host ?? false) === v.applier_host) return undefined;
    if (v.applier_host) d.applier_host = true;
    else delete d.applier_host;
    tidy(draft, v.device);
    return `~ applier_host ${v.device} ${v.applier_host}`;
  },
  infrastructure(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      return setInfrastructure(draft, id, false);
    }
    const v = checked<{ device: string; infrastructure: boolean }>("applier/configure.infrastructure.json", change.value);
    device(ctx, v.device);
    return setInfrastructure(draft, v.device, v.infrastructure);
  },
  fresh_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.fresh_s === undefined) return undefined;
      delete d.fresh_s;
      tidy(draft, id);
      return `- fresh_s ${id}`;
    }
    const v = checked<{ device: string; fresh_s: number }>("applier/configure.fresh_s.json", change.value);
    device(ctx, v.device);
    return setFreshS(draft, v.device, v.fresh_s);
  },
  ack_within_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.ack_within_s?.[action!] === undefined) return undefined;
      delete d.ack_within_s![action!];
      tidy(draft, id);
      return `- ack_within_s ${id} ${action}`;
    }
    const v = checked<{ device: string; action: string; ack_within_s: number }>("applier/configure.ack_within_s.json", change.value);
    return setAckWithin(draft, v.device, device(ctx, v.device), v.action, v.ack_within_s);
  },
  /**
   * `forget { device }` (applier, *configure*): removes an unadopted or `left` device from the model,
   * its adoption, declarations and replaced identifiers with it; refused while its bridge's `devices`
   * still lists it, or before this life has heard that document (GA-ADOPT-1). The PC slice adds the
   * `wake_via` refusal and GA-PROV-4's exception, and slice 6 the safety rule's.
   */
  forget(draft, change, ctx) {
    if (change.op === "delete") bad("a forget is not undone: the device comes back new when its bridge lists it again");
    const { device: id } = checked<{ device: string }>("applier/configure.forget.json", change.value);
    const info = device(ctx, id);
    if (ctx.replaced.some((r) => r.replaces === id)) bad(`${id} is replaced in this change set: it names the new hardware now`);
    if (info.in_devices) bad(`${id} is still in its bridge's devices, or its bridge has not said otherwise: remove it there first`);
    drop(draft, id, { retired: true });
    ctx.devices.delete(id);
    ctx.forgotten.push(id);
    return `- device ${id}`;
  },
  /**
   * `route { stable_identifier, bridge }` (GA-BUS-11): the bridge that carries hardware two bridges
   * report. The identifier's one device takes the copy on that bridge, and the copies on other bridges
   * fold into it. Refused for a bridge not registered, for one that shows no copy, for one that shows
   * two (hardware admitted anew there, which `replaces` takes), and while a device showing the
   * identifier is adopted: an adopted device keeps its bridge, and a route never moves it (an adoption
   * with replaces does). Its delete names the identifier alone, and is refused while its device is
   * adopted, since route first is what let it be adopted.
   */
  route(draft, change, ctx) {
    if (change.op === "delete") {
      const sid = (change.value as { stable_identifier?: unknown } | undefined)?.stable_identifier;
      if (typeof sid !== "string" || !draft.routes.has(sid)) return bad(`no route for ${JSON.stringify(sid)}`);
      const shown = [...ctx.devices].filter(([, d]) => d.stable_identifier === sid).map(([id]) => id);
      const adopted = shown.find((id) => draft.adoptions.has(id));
      if (adopted) bad(`${adopted} is adopted: its route stays while it is (route first)`);
      draft.routes.delete(sid);
      ctx.unrouted.push(...shown);
      return `- route ${sid}`;
    }
    const r = checked<{ stable_identifier: string; bridge: string }>("applier/configure.route.json", change.value);
    if (!draft.bridges.has(r.bridge)) bad(`no bridge ${r.bridge}`);
    const group = [...ctx.devices].filter(([, d]) => d.stable_identifier === r.stable_identifier);
    if (!group.length) bad(`no device shows ${JSON.stringify(r.stable_identifier)}`);
    const held = draft.routes.get(r.stable_identifier);
    const adopted = group.find(([id]) => draft.adoptions.has(id))?.[0];
    if (adopted && held === r.bridge) return undefined;
    if (adopted) bad(`${adopted} is adopted: an adopted device keeps its bridge (GA-BUS-11), so no route moves it; `
      + "an adoption with replaces moves it to other hardware");
    const on = [...group.filter(([, d]) => d.bridge === r.bridge).map(([id]) => id),
      ...group.flatMap(([id, d]) => (d.copies ?? []).filter((b) => b === r.bridge).map(() => `a copy folded into ${id}`))];
    if (!on.length) bad(`bridge ${r.bridge} shows no device with ${JSON.stringify(r.stable_identifier)}`);
    if (on.length > 1) bad(`bridge ${r.bridge} shows ${JSON.stringify(r.stable_identifier)} twice (${on.join(", ")}): `
      + "hardware admitted anew there, which an adoption with replaces takes");
    const device = (group.find(([, d]) => d.bridge === r.bridge) ?? group[0]!)[0];
    draft.routes.set(r.stable_identifier, r.bridge);
    ctx.routed.push({ stable_identifier: r.stable_identifier, device, bridge: r.bridge });
    return held === r.bridge ? undefined : `${held ? "~" : "+"} route ${r.stable_identifier} ${r.bridge}`;
  },
  personal: (draft, change, ctx) => keyKind(draft, change, ctx, "personal"),
  self_changing: (draft, change, ctx) => keyKind(draft, change, ctx, "self_changing"),
  /**
   * `safety_rule` (applier, *Safety rules*), in the language of `safety/language.ts`; checked whole once
   * the set is applied (`checkRule`). Its delete names its id.
   */
  safety_rule(draft, change, ctx) {
    if (change.op === "delete") {
      const { id } = deleting(change.value, ["id"]);
      if (!draft.rules.delete(id)) bad(`no safety rule ${id}`);
      draft.disabled.delete(id);
      return `- safety_rule ${id}`;
    }
    const r = checked<SafetyRule>("applier/configure.safety_rule.json", change.value);
    const held = draft.rules.get(r.id);
    // A rule a declaration change disabled runs again only when the owner sets it again, checked as new (GA-SAFE-13).
    if (held && JSON.stringify(held) === JSON.stringify(r) && !draft.disabled.has(r.id)) return undefined;
    draft.rules.set(r.id, r);
    draft.disabled.delete(r.id);
    ctx.ruled.push(r.id);
    return `${held ? "~" : "+"} safety_rule ${r.id}`;
  },
  /**
   * `box` (applier, *Bridges*): the owner's word that the box passes GA-BOX-1, without which an applier
   * over bridges claims no Safe (GA-DESC-6); refused while its own broker connection is plain TCP off
   * loopback, which it can see. Its delete is `false`.
   */
  box(draft, change, ctx) {
    const on = change.op === "delete" ? false : checked<boolean>("applier/configure.box.json", change.value);
    if (on && ctx.plainOffLoopback) bad("box is refused while this applier reaches its broker over plain TCP off loopback (GA-DESC-6)");
    if (draft.box === on) return undefined;
    draft.box = on;
    return `~ box ${on}`;
  },
  /**
   * `clear_latch` (applier, *Latches*): the owner clears a held latch, for a sensor that will never
   * report again; it changes no configuration, but is a model change (applier, *Identifiers and
   * revision*). It has no delete.
   */
  clear_latch(_draft, change, ctx) {
    if (change.op === "delete") bad("clear_latch has no delete: an upsert names the rule whose latch it clears");
    const { rule_id } = checked<{ rule_id: string }>("applier/configure.clear_latch.json", change.value);
    if (!ctx.latches?.has(rule_id) || ctx.cleared.includes(rule_id)) bad(`no latch of safety rule ${rule_id} is held`);
    ctx.cleared.push(rule_id);
    return `- latch ${rule_id}`;
  },
  time_source(draft, change, ctx) {
    if (!ctx.underHarness) bad("time_source is accepted only under the conformance harness (GA-HARN-1)");
    if (change.op === "delete") {
      draft.timeSource = undefined;
      return "- time_source";
    }
    const source = checked<string>("applier/configure.time_source.json", change.value);
    if (draft.timeSource === source) return undefined;
    draft.timeSource = source;
    return `~ time_source ${source}`;
  },
};

function keyKind(draft: Config, change: Change, ctx: Ctx, list: KeyList): string | undefined {
  const v = change.op === "delete" ? deleting(change.value, ["device", "key"])
    : checked<{ device: string; key: string }>(`applier/configure.${list}.json`, change.value);
  const info = device(ctx, v.device!);
  return change.op === "delete" ? removeKey(draft, v.device!, info, list, v.key!) : addKey(draft, v.device!, info, list, v.key!);
}

/** What holds across the whole set: a load only on an adopted socket, `opens_with` only on a water or gas valve. */
function consistent(draft: Config, mutation?: Mutation): void {
  for (const id of [...draft.declarations.keys()]) tidy(draft, id);
  for (const [id, d] of draft.declarations) {
    const cls = draft.adoptions.get(id)?.class ?? null;
    if (d.load !== undefined && cls !== "socket") bad(`${id} declares a load but is no longer a socket`);
    // A cap is the heating load's: none on a load that is not heating (applier, *Devices*).
    if (d.max_on_s !== undefined && loadIn(draft, id) !== "heating") bad(`${id} declares max_on_s, which only a heating load carries`);
    if (d.opens_with !== undefined && !VALVES.has(cls ?? "")) bad(`${id} declares opens_with but is no longer a water or gas valve`);
    // GA-CFG-3: the applier runs on one computer. `marks-two-applier-hosts` takes it on anything, twice.
    if (d.applier_host && cls !== "computer" && mutation !== "marks-two-applier-hosts") bad(`applier_host is set only on an adopted computer, and ${id} is not one (GA-CFG-3)`);
  }
  const hosts = [...draft.declarations].filter(([, d]) => d.applier_host).map(([id]) => id);
  if (hosts.length > 1 && mutation !== "marks-two-applier-hosts") bad(`applier_host is set on ${hosts.join(" and ")}: the applier runs on one computer (GA-CFG-3)`);
  // A safety rule reads and actuates adopted devices only: a forget or an adoption's delete of one it names is refused (GA-ADOPT-1).
  for (const r of draft.rules.values()) {
    const lost = devicesOf(r).filter((id) => !draft.adoptions.has(id));
    if (lost.length) bad(`safety rule ${r.id} names ${lost.join(", ")}, which would not be adopted: delete or change the rule first`);
  }
}

/**
 * Why a safety rule no longer fits its devices' declarations, or undefined (applier, *Safety rules*,
 * *The applier's own actuations*): every key it reads one the device reports as state, never an event
 * key (GA-EVT-8); every action one its device offers, never one declared `toggles: true` (GA-SAFE-13),
 * with args the vocabulary and the device's own `args` and `confirmed_by` take, as a client's plan is
 * checked (`refuse(invalid_args)`). A device the model does not hold is no fault of its declarations:
 * its adoption is judged apart. `configure` refuses a rule with such a fault, and a change of the
 * declarations that gives one disables it (GA-SAFE-13). `toggles` is `toggles-by-safety-rule`'s switch.
 */
/**
 * The first key a rule or its latch reads that its device does not declare, with whether its bridge
 * awaits it (GA-SAFE-14), as a refusal's `data` gives them; an event key is GA-EVT-8's, not this.
 */
export function undeclaredRead(r: SafetyRule, devices: ReadonlyMap<string, DeviceInfo>): { key: string; device: string; awaited: boolean } | undefined {
  for (const t of reads(r)) {
    const info = devices.get(t.device);
    if (!info || info.extension_keys?.event.includes(t.key)) continue;
    if (!stateKeys(info).includes(t.key)) return { key: t.key, device: t.device, awaited: info.awaited_keys?.includes(t.key) ?? false };
  }
  return undefined;
}

/** The state keys a device declares: its capabilities', its sensor keys and its extensions' `state` keys. */
const stateKeys = (info: DeviceInfo): string[] => [...reported(info.capabilities, info.actions, info.sensor_keys), ...info.extension_keys?.state ?? []];

export function declarationFault(r: SafetyRule, devices: ReadonlyMap<string, DeviceInfo>, o: { toggles?: boolean; keys?: boolean } = {}): string | undefined {
  for (const t of reads(r)) {
    const info = devices.get(t.device);
    if (!info) continue;
    if (info.extension_keys?.event.includes(t.key)) {
      return `${t.device}'s ${t.key} is an event key, an occurrence and never a value a rule can read (GA-EVT-8)`;
    }
    if (o.keys !== false && !stateKeys(info).includes(t.key)) return `${t.device} reports no state key ${t.key}`;
  }
  for (const a of r.actions) {
    const info = devices.get(a.target);
    if (!info) continue;
    if (!info.actions.includes(a.action)) return `${a.target} offers no ${a.action}`;
    const own = info.args?.[a.action];
    const fault = argsFault(a.action, a.args ?? {}, own?.args, own?.confirmed_by);
    if (fault) return `${a.target} ${a.action}: ${fault}`;
    if (info.toggles?.includes(a.action) && !o.toggles) {
      return `${a.target}'s ${a.action} is declared toggles: true, which the applier never sends on its own (GA-SAFE-13)`;
    }
  }
  return undefined;
}

/**
 * A safety rule as the set leaves the model (applier, *Safety rules*): every device it reads or
 * actuates adopted (GA-ADOPT-1) and the applier's own; its declarations fitting it
 * (`declarationFault`); on a device with no other admin, or `other_admins: unknown`, unless the rule
 * says `accepts_other_admins` (GA-SAFE-6); an order compares a number; and no two rules set one key of
 * one device to different values (GA-SAFE-11).
 */
function checkRule(draft: Config, r: SafetyRule, ctx: Work): void {
  const named = (id: string): DeviceInfo => {
    const info = ctx.devices.get(id);
    if (!info) return bad(`safety rule ${r.id}: no device ${id}`);
    if (!draft.adoptions.has(id)) bad(`safety rule ${r.id}: ${id} is not adopted (GA-ADOPT-1)`);
    return info;
  };
  for (const t of reads(r)) {
    named(t.device);
    if (t.op !== "eq" && t.op !== "ne" && typeof t.value !== "number") bad(`safety rule ${r.id}: ${t.op} compares a number, not ${JSON.stringify(t.value)}`);
  }
  for (const a of r.actions) named(a.target);
  // A key its device does not declare: a rule on a reading that never comes never fires (GA-SAFE-14).
  // `accepts-a-safety-rule-on-an-undeclared-key` takes it.
  const lax = ctx.mutation === "accepts-a-safety-rule-on-an-undeclared-key";
  const missing = lax ? undefined : undeclaredRead(r, ctx.devices);
  if (missing) {
    throw new RequestError("invalid_request", `safety rule ${r.id}: ${missing.device} declares no state key ${missing.key}`
      + `${missing.awaited ? ", which its bridge awaits: it has not reported it yet" : ""}`, missing);
  }
  const fault = declarationFault(r, ctx.devices, { toggles: ctx.mutation === "toggles-by-safety-rule", keys: !lax });
  if (fault) bad(`safety rule ${r.id}: ${fault}`);
  // The broker's host's administrators reach every device a rule actuates (GA-SAFE-6). `ignores-the-broker-hosts-admins` leaves them out.
  const broker = ctx.mutation === "ignores-the-broker-hosts-admins" ? [] : brokerAdmins(draft, ctx.devices, ctx.mutation);
  if (broker.length && r.accepts_other_admins !== true && actuated(r).length) {
    bad(`safety rule ${r.id}: ${broker.map((b) => b.computer).join(", ")} carries the broker and has `
      + `${broker.some((b) => b.admins === "unknown") ? "administrators not known" : "administrators"}, who reach every device it actuates `
      + "and can undo the rule; the rule needs accepts_other_admins: true, or the computer adopted and marked applier_host "
      + "if the applier itself runs on it (GA-SAFE-6)");
  }
  for (const id of actuated(r)) {
    const admins = ctx.devices.get(id)?.other_admins;
    const other = admins === "unknown" || (Array.isArray(admins) && admins.length > 0);
    if (other && r.accepts_other_admins !== true) {
      bad(`safety rule ${r.id}: ${id} has ${admins === "unknown" ? "other admins not known" : "another admin"}, who can undo the rule; `
        + "the rule needs accepts_other_admins: true (GA-SAFE-6)");
    }
  }
  // Two rules setting one key of one device to different values would undo each other (GA-SAFE-11).
  for (const other of draft.rules.values()) {
    if (other.id === r.id) continue;
    for (const a of r.actions) {
      const mine = sets(a.action, a.args ?? {});
      if (mine?.value === undefined) continue;
      for (const b of other.actions) {
        const theirs = b.target === a.target ? sets(b.action, b.args ?? {}) : undefined;
        if (theirs?.key === mine.key && theirs.value !== undefined && JSON.stringify(theirs.value) !== JSON.stringify(mine.value)) {
          bad(`safety rules ${r.id} and ${other.id} set ${a.target}'s ${mine.key} to different values (GA-SAFE-11)`);
        }
      }
    }
  }
}

/**
 * Applies a change set to a copy of the configuration. Every change is checked before anything is
 * kept, so a set is applied whole or refused whole (GA-CFG-2). `current` is never changed.
 */
export function planChanges(current: Config, changes: Change[], ctx: Ctx): { draft: Config; diff: string[] } & Required<Effects> {
  const draft = copyConfig(current);
  const diff: string[] = [];
  const work: Work = { ...ctx, devices: new Map(ctx.devices ?? []), forgotten: [], replaced: [], routed: [], unrouted: [], cleared: [], ruled: [] };
  changes.forEach((change, i) => {
    try {
      // A rule's delete is taken whatever is claimed: an owner whose claim lapsed can still remove one.
      const removal = change.kind === "safety_rule" && change.op === "delete";
      if (SAFE_KINDS.has(change.kind) && !removal && !claimsOf(draft, ctx).includes("Safe")) {
        throw new RequestError("not_claimed", `${change.kind} needs the Safe level, which this applier does not claim`);
      }
      const kind = Object.hasOwn(KINDS, change.kind) ? KINDS[change.kind] : undefined;
      if (!kind) bad(`kind ${change.kind} is not configurable on this applier`);
      const line = kind!(draft, change, work);
      if (line) diff.push(line);
    } catch (err) {
      if (err instanceof RequestError) throw new RequestError(err.code, `changes[${i}]: ${err.message}`, err.data);
      throw err;
    }
  });
  consistent(draft, ctx.mutation);
  // A heating load's cap would have to press a toggle (applier, *The applier's own actuations*, GA-SAFE-13): refused when this
  // set makes the load heating, sets its max_on_s ("a socket whose onoff.turn_off is declared toggles: true cannot carry one",
  // *Loads*), or moves it to new hardware; a re-taught code under a load already heating is a notice instead.
  for (const [id, d] of draft.declarations) {
    const was = current.declarations.get(id);
    const capSet = d.max_on_s !== undefined && d.max_on_s !== was?.max_on_s;
    if (!capSet && (d.load !== "heating" || (was?.load === "heating" && !work.replaced.some((r) => r.replaces === id)))) continue;
    if (work.devices.get(id)?.toggles?.includes("onoff.turn_off") && ctx.mutation !== "toggles-a-cap-off") {
      bad(capSet ? `${id}'s onoff.turn_off is declared toggles: true, so it cannot carry a max_on_s: the applier never sends a toggle on its own (GA-SAFE-13)`
        : `${id}'s onoff.turn_off is declared toggles: true, so a heating load's cap could never turn it off: the applier never sends a toggle on its own (GA-SAFE-13)`);
    }
  }
  for (const id of new Set(work.ruled)) {
    const r = draft.rules.get(id);
    if (r) checkRule(draft, r, work);
  }
  return { draft, diff, forgotten: work.forgotten, replaced: work.replaced, routed: work.routed, unrouted: work.unrouted, cleared: work.cleared };
}
