import type { Tx } from "../core/db.js";
import { canonical } from "../core/canonical.js";
import { digest } from "../core/secret.js";
import type { Store } from "../core/store.js";

/** A person's role, and an endpoint's cap (steward, *Roles*): `visitor` comes only from a cap. */
export type Role = "owner" | "member" | "guest" | "visitor";
export type PersonRole = Exclude<Role, "visitor">;
export type EndpointType = "voice" | "panel" | "app";
export type CredentialKind = "app" | "panel" | "brain" | "front";
export type Listening = "off" | "tap" | "wake_device" | "wake_server";

/** The home's settings (steward, *The house model*). `time_source` only under the harness (GA-HARN-2). */
export interface HomeSettings {
  timezone: string;
  hold_time_s: number;
  occupancy_hold_s: number;
  ask_expiry_s: number;
  notice_channels: string[];
  other_wake_words: string[];
  answer_words: string[];
  audio_retention_s: number;
  time_source?: string;
}

export interface Room { id: string; name: string }

/**
 * The steward's overlay on one of the applier's devices, keyed by its id (steward, *The house model*):
 * its name and aliases, and its room. Absent fields: the applier's label, none, no room.
 */
export interface TargetOverlay {
  id: string;
  name?: string;
  aliases?: string[];
  room?: string | null;
  /** A brain put the device in its room (GA-DEF-7), until the owner sets the overlay again. */
  room_brain_authored?: true;
}

/** A group (steward, *The house model*): its members are the applier's device ids, in code-point order. */
export interface Group {
  id: string;
  name: string;
  aliases: string[];
  room: string | null;
  members: string[];
  aggregate: "any" | "all";
  /** The members that joined the group through a brain (GA-DEF-7), until the owner sets the group again. */
  brain_joined?: string[];
}
export interface Person { id: string; name: string; role: PersonRole }

/** An endpoint's voice record (steward, *Listening*), the owner's, set by `define`'s kind `voice`. */
export interface VoiceRecord {
  listening: Listening;
  wake_words: { word: string; model: string }[];
  zone: string | null;
  output: "speech" | null;
  follow_up: boolean;
  heard_by: string;
  skill_account?: string;
  skill_surface?: string;
}

export interface Endpoint {
  id: string;
  name: string;
  type: EndpointType;
  room: string | null;
  person: string | null;
  /** Absent: the standard's default (`defaultMaxRole`). */
  max_role?: Role;
  served_by: string | null;
  /** Absent or `same`: none. */
  confirm_on?: string;
  voice: VoiceRecord | null;
}

/** A client's credential: its secret's SHA-256 only, never the secret (the design, *Clients, endpoints and principals*). */
export interface Credential {
  id: string;
  kind: CredentialKind;
  secret_sha256: string;
  endpoint?: string;
  confirm_on?: string;
}

/** One device's state key read by a rule (steward, *Rules*): compared with `op` and `value`, or `not_in` its values. */
export interface Reading { target: string; key: string; op?: "eq" | "ne" | "gt" | "ge" | "lt" | "le"; value?: unknown; not_in?: unknown[] }
/** A time window (GA-RULE-3): `HH:MM` in the home's timezone, `days` the ISO weekdays it starts on, every day when absent. */
export interface Window { from: string; until: string; days?: number[] }
export type Trigger = { state: Reading } | { held: Reading & { for_s: number } }
  | { event: { target: string; type: "liveness" | "occurrence"; new?: string; key?: string; value?: unknown } }
  | { time: { at: string; days?: number[] } };
export type Condition = Reading | { between: Window };
/** An action on a target id (a device's or a group's) or a selector, as a request's, with its own `respect_occupancy`. */
export interface DeviceAction { target?: string; selector?: Record<string, unknown>; action: string; args: Record<string, unknown>; respect_occupancy?: boolean }
/** A rule's action: one on devices, or the start of a scenario's run, which acts as the rule (provisional; *Standards fixes*). */
export type RuleAction = DeviceAction | { scenario: string };
/** A rule (steward, *Rules*), as the owner's `define` gave it, `active` and `exceptions` filled in. */
export interface Rule {
  id: string;
  name: string;
  trigger?: Trigger;
  conditions?: Condition[];
  actions: RuleAction[];
  active: boolean;
  exceptions: { from: string; until: string }[];
  /** Defined or changed through a brain (GA-DEF-7), until the owner redefines it whole. */
  brain_authored?: true;
}

/** A rule's actions on devices, in order; the scenarios it starts are `startsOf`'s. */
export const deviceActions = (r: Rule): DeviceAction[] => r.actions.filter((a): a is DeviceAction => !("scenario" in a));
/** The scenarios a rule starts, in order. */
export const startsOf = (r: Rule): string[] => r.actions.flatMap((a) => ("scenario" in a ? [a.scenario] : []));

/** An `if` step's condition (steward, *Scenarios*): a target's state key compared with a value. */
export interface ScenarioCondition { target: string; key: string; op: NonNullable<Reading["op"]>; value: unknown }
/** A `wait` step (GA-SCN-10): `on_timeout` absent is `stop`. */
export interface ScenarioWait { target: string; key: string; value: unknown; timeout_s: number; on_timeout?: "continue" | "stop" }
/** One step of a scenario (steward, *Scenarios*). */
export type ScenarioStep = DeviceAction | { if: ScenarioCondition; then: ScenarioStep[]; else?: ScenarioStep[] } | { delay: number }
  | { wait: ScenarioWait } | { run: string };
/** A scenario (steward, *Scenarios*), as the owner's `define` gave it, `owned` and `respect_occupancy` filled in. */
export interface Scenario {
  id: string;
  name: string;
  mode: "single" | "restart" | "queued" | "parallel";
  owned: string[];
  respect_occupancy: boolean;
  steps: ScenarioStep[];
  /** Defined or changed through a brain (GA-DEF-7), until the owner redefines it whole. */
  brain_authored?: true;
}

/** A schedule's exception (GA-SCHED-1): the run on `date` (`YYYY-MM-DD` in the home's timezone) skipped, or moved to `time` that date. */
export interface ScheduleException {
  date: string;
  action: "skip" | "move";
  time?: string;
  /** A move made through a brain: that date's run is `brain_authored` (GA-DEF-7). */
  brain_authored?: true;
}
/**
 * A schedule (steward, *Schedules*), as the owner's `define` gave it, `exceptions` filled in, in date
 * order: `scenario` run at `time` (`HH:MM` in the home's timezone) on `days` (ISO weekdays, every day
 * when absent).
 */
export interface Schedule {
  id: string;
  scenario: string;
  time: string;
  days?: number[];
  exceptions: ScheduleException[];
  /** Defined or changed through a brain (GA-DEF-7), until the owner redefines it whole. */
  brain_authored?: true;
}

/** The house model: the home's settings, rooms, the target overlay, groups, persons, endpoints, credentials, rules, scenarios and schedules. */
export interface House {
  home: HomeSettings;
  rooms: Map<string, Room>;
  targets: Map<string, TargetOverlay>;
  groups: Map<string, Group>;
  persons: Map<string, Person>;
  endpoints: Map<string, Endpoint>;
  credentials: Map<string, Credential>;
  rules: Map<string, Rule>;
  scenarios: Map<string, Scenario>;
  schedules: Map<string, Schedule>;
}

/** The assistants a house must never address (steward, *Listening*), which the owner edits. */
export const OTHER_WAKE_WORDS = ["Алиса", "Алекса", "Alexa", "Салют", "Сбер", "Джой", "Афина", "Маруся", "Окей, Гугл"];
/** The words that answer a question (steward, *Listening*), which the owner edits. */
export const ANSWER_WORDS = ["да", "нет", "конечно", "хорошо", "ладно", "верно", "точно", "можно", "окей", "ок", "давай",
  "давайте", "отмена", "отменить", "подтверждаю", "согласен", "согласна", "ага", "угу", "не надо"];

/**
 * The defaults of the home's settings (steward, *The house model*). The standard gives none for
 * `timezone`; until the owner sets it the home keeps UTC, which the owner tool shows.
 */
export const HOME_DEFAULTS: HomeSettings = {
  timezone: "UTC", hold_time_s: 7200, occupancy_hold_s: 300, ask_expiry_s: 300, notice_channels: [],
  other_wake_words: OTHER_WAKE_WORDS, answer_words: ANSWER_WORDS, audio_retention_s: 0,
};

export function emptyHouse(): House {
  return { home: structuredClone(HOME_DEFAULTS), rooms: new Map(), targets: new Map(), groups: new Map(), persons: new Map(),
    endpoints: new Map(), credentials: new Map(), rules: new Map(), scenarios: new Map(), schedules: new Map() };
}

export function copyHouse(h: House): House {
  return structuredClone(h);
}

type Kind = "home" | "room" | "target" | "group" | "person" | "endpoint" | "credential" | "rule" | "scenario" | "schedule";
/** Each kind of object the model keeps in a table, with where it lives; `define`'s diff reads it too. */
export const TABLES: [Exclude<Kind, "home">, (h: House) => Map<string, unknown>][] = [
  ["room", (h) => h.rooms], ["target", (h) => h.targets], ["group", (h) => h.groups], ["person", (h) => h.persons],
  ["endpoint", (h) => h.endpoints], ["credential", (h) => h.credentials], ["rule", (h) => h.rules], ["scenario", (h) => h.scenarios],
  ["schedule", (h) => h.schedules],
];

/** The model as rows of the `house` table: one per object, the home's settings as `('home', 'home')`. */
export function houseRows(h: House): { kind: Kind; id: string; doc: unknown }[] {
  return [{ kind: "home", id: "home", doc: h.home },
    ...TABLES.flatMap(([kind, of]) => [...of(h)].map(([id, doc]) => ({ kind, id, doc })))];
}

/** A key that changes exactly when the model does, for the revision (GA-HOUSE-1). */
export function houseKey(h: House): string {
  return canonical(houseRows(h).sort((a, b) => (a.kind + "\u0000" + a.id < b.kind + "\u0000" + b.id ? -1 : 1)));
}

/**
 * Writes the whole model: what the store held is replaced by `h`. One transaction, safe to run
 * twice; a home's model is small, so a change writes all of it.
 */
export async function saveHouse(tx: Tx, h: House): Promise<void> {
  await tx.query("DELETE FROM house");
  for (const r of houseRows(h)) await tx.query("INSERT INTO house (kind, id, doc) VALUES ($1, $2, $3)", [r.kind, r.id, JSON.stringify(r.doc)]);
}

export async function loadHouse(store: Pick<Store, "query">): Promise<House> {
  const h = emptyHouse();
  const rows = await store.query<{ kind: string; id: string; doc: any }>("SELECT kind, id, doc FROM house ORDER BY kind, id");
  for (const r of rows.rows) {
    if (r.kind === "home") h.home = { ...structuredClone(HOME_DEFAULTS), ...r.doc };
    else (TABLES.find(([k]) => k === r.kind)?.[1](h) as Map<string, unknown> | undefined)?.set(r.id, r.doc);
  }
  return h;
}

/** The ids of what the first owner's credential creates (ruled, Q2). */
export const FIRST_OWNER = { person: "owner", endpoint: "owner-app", credential: "owner-app" } as const;

/**
 * The first owner (ruled, Q2): on a store with no person, the owner's credential creates person
 * `owner` (role `owner`), endpoint `owner-app` (an app, that person, no room, served by no brain) and
 * a credential bound to it. Made without `define`, whose checks a house with no notice channel yet
 * could not pass; the owner renames, adds and removes from there.
 */
export function withFirstOwner(h: House, secret: string): House {
  const next = copyHouse(h);
  next.persons.set(FIRST_OWNER.person, { id: FIRST_OWNER.person, name: "Owner", role: "owner" });
  next.endpoints.set(FIRST_OWNER.endpoint, { id: FIRST_OWNER.endpoint, name: "Owner's app", type: "app", room: null,
    person: FIRST_OWNER.person, served_by: null, voice: null });
  next.credentials.set(FIRST_OWNER.credential, { id: FIRST_OWNER.credential, kind: "app", secret_sha256: digest(secret),
    endpoint: FIRST_OWNER.endpoint });
  return next;
}
