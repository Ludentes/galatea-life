import { validate } from "@ludentes/galatea-life-schemas";
import { canonical, storable } from "../core/canonical.js";
import { RequestError } from "../core/errors.js";
import { digest } from "../core/secret.js";
import type { Mutation } from "../mutations.js";
import { markBrain } from "./brain.js";
import { copyHouse, deviceActions, HOLD_DEFAULTS, HOME_DEFAULTS, startsOf, TABLES, type Credential, type Endpoint, type Group, type House, type HoldPolicy, type HomeSettings, type Rule,
  type Scenario, type ScenarioStep, type Schedule, type ScheduleException, type TargetOverlay, type VoiceRecord } from "./model.js";

/** A change of a `define` change set, as the applier's `configure` envelope (the design, *The house model and `define`*). */
export interface Change { op: "upsert" | "delete"; kind: string; value?: unknown }

/** What `define` reads of the applier's model: a device as the mirror holds it. */
export interface DeviceView { adopted: boolean; internal: boolean; actions: string[] }

export interface DefineContext {
  /** A device the applier describes, or undefined. */
  device(id: string): DeviceView | undefined;
  /** Whether the applier reports a `test_run_id`: `time_source` is accepted only then (GA-HARN-2). */
  underHarness: boolean;
  mutation?: Mutation;
  /** A brain's change set: what it creates or changes is marked `brain_authored`, and the diff shows the marks (GA-DEF-7). */
  brain?: boolean;
}

/** The kinds built so far; every other kind the standard's `define` covers is a later slice's. */
const KINDS = new Set(["home", "room", "target", "group", "person", "endpoint", "credential", "voice", "rule", "rule_exception", "scenario",
  "schedule", "schedule_exception"]);
const LATER = new Set(["lift_narrowing"]);
/** The scenario modes this build runs, as `describe.modes` lists them (GA-SCN-5; the other three deferred, ruled Q9). */
export const MODES = ["single"] as const;

const invalid = (message: string) => new RequestError("invalid_request", message);

type Args = Record<string, any>;

/**
 * Plans a change set on `house`: each change is checked against its kind's schema and applied to a
 * copy, then the copy is checked whole, as it would stand (GA-DEF-5, GA-DEF-8, GA-CONF-4). The first
 * problem is an `invalid_request` and nothing changes. A brain's change set marks what it creates or
 * changes (GA-DEF-7). Returns the copy and a readable diff, the marks in it (GA-DEF-1); the caller
 * commits the copy, or, for a dry run or a brain's ask, only shows the diff.
 */
export function planDefine(house: House, changes: Change[], ctx: DefineContext): { draft: House; diff: string[] } {
  const draft = copyHouse(house);
  changes.forEach((c, i) => {
    const at = `change ${i + 1} (${c.op} ${c.kind})`;
    if (LATER.has(c.kind)) throw invalid(`${at}: ${c.kind} is not built yet in this steward`);
    if (!KINDS.has(c.kind)) throw invalid(`${at}: no kind ${c.kind}`);
    if (!storable(c.value)) throw invalid(`${at}: a string holds U+0000 or a lone surrogate`);
    // A delete names its item by its key alone (GA-DEF-14); an upsert is checked against its kind's shape (GA-DEF-13).
    const schema = c.op === "delete" ? "steward/define.delete.json" : `steward/define.${c.kind}.json`;
    const errors = validate(schema, pressUnchecked(c, ctx) ?? c.value ?? {})
      .filter((e) => !(ctx.mutation === "takes-a-short-secret" && c.kind === "credential" && /secret/.test(e)));
    if (errors.length) throw invalid(`${at}: ${errors.join("; ")}`);
    const v = c.value as Args;
    if (c.op === "upsert" && !existsIn(draft, c.kind, v)) checkCreatedWith(c.kind, v, at);
    apply(draft, c.op, c.kind, v, at, ctx);
  });
  check(draft, ctx);
  checkChannels(house.home, draft.home, changes.some((c) => c.kind === "home" && (c.value as Args | undefined)?.notice_channels !== undefined), ctx);
  checkGone(house, draft, ctx);
  if (ctx.brain) markBrain(house, draft);
  return { draft, diff: diffOf(house, draft) };
}

/**
 * `press-on-liveness`: a rule's value with its trigger's `press` left out, so the schema never sees the
 * mark on a trigger that is not an occurrence one (GA-DEF-13, GA-LEASE-9); undefined otherwise.
 */
function pressUnchecked(c: Change, ctx: DefineContext): Args | undefined {
  const v = c.value as Args | undefined;
  const event = v?.trigger?.event;
  if (ctx.mutation !== "press-on-liveness" || c.kind !== "rule" || !event || typeof event !== "object" || !("press" in event)) return undefined;
  const { press: _p, ...rest } = event as Args;
  return { ...v, trigger: { ...v!.trigger, event: rest } };
}

/** Whether the item an upsert's value names exists: the upsert updates it, rather than creating it (GA-DEF-14). */
function existsIn(h: House, kind: string, v: Args): boolean {
  switch (kind) {
    case "voice": return h.endpoints.get(v.endpoint)?.voice != null;
    case "rule_exception": return h.rules.get(v.rule)?.exceptions.some((y) => Date.parse(y.from) === Date.parse(v.from) && Date.parse(y.until) === Date.parse(v.until)) ?? false;
    case "schedule_exception": return h.schedules.get(v.schedule)?.exceptions.some((y) => y.date === v.date) ?? false;
    case "home": return true;
    default: {
      const table = TABLES.find(([k]) => k === kind)?.[1];
      return table ? table(h).has(v.id) : false;
    }
  }
}

/**
 * `item` with the fields `v` names merged over it (GA-DEF-14): a field `v` leaves out keeps its value,
 * a list `v` names is replaced whole, and a field `v` gives as null returns to `defaults`' value, or
 * is dropped when it has none (absent being its default). A field of `none` takes null as its value,
 * "none" (an endpoint's room, person and served_by; a voice record's zone and output; a group's room).
 */
function merged<T extends object>(item: T | undefined, v: Args, defaults: Args = {}, none: string[] = []): T {
  const out: Args = { ...(item ?? {}) };
  for (const [k, x] of Object.entries(v)) {
    if (x !== null || none.includes(k)) out[k] = x;
    else if (k in defaults) out[k] = structuredClone(defaults[k]);
    else delete out[k];
  }
  return out as T;
}

/**
 * Whether an owner's upsert redefines its item whole (GA-DEF-7, *Authored work*): it names every field
 * the merged item holds that is not at its default, so nothing a brain wrote survives it; then the
 * item's `brain_authored` mark is cleared. Ruled: under the merge, "redefines whole" is read this way.
 */
function whole(item: Args, v: Args, fields: string[], defaults: Args = {}): boolean {
  return fields.every((f) => f in v || item[f] === undefined || (f in defaults && canonical(item[f]) === canonical(defaults[f])));
}

/**
 * The content fields of what carries a `brain_authored` mark, and their defaults. A rule's `passes_holds`
 * is not among them (ruled, milestone 1 review m1): a brain never writes it (GA-DEF-3), so it carries
 * nothing a brain wrote, and the owner's redefinition that leaves it out still clears the mark.
 */
const RULE_FIELDS = ["name", "trigger", "conditions", "actions", "active"];
const SCENARIO_FIELDS = ["name", "mode", "steps", "owned", "respect_occupancy"];
const SCHEDULE_FIELDS = ["scenario", "time", "days"];
const RULE_DEFAULTS = { active: true, exceptions: [], passes_holds: false };
const SCENARIO_DEFAULTS = { owned: [], respect_occupancy: false };
const SCHEDULE_DEFAULTS = { exceptions: [] };

function apply(h: House, op: Change["op"], kind: string, v: Args, at: string, ctx: DefineContext): void {
  const del = op === "delete";
  const owners = !ctx.brain;
  if (kind === "voice") {
    if (v.endpoint === undefined) throw invalid(`${at}: a voice record is named by its endpoint`);
    const id: string = v.endpoint;
    const e = h.endpoints.get(id);
    if (!e) throw invalid(`${at}: no endpoint ${id}`);
    if (del) {
      if (!e.voice && ctx.mutation !== "deletes-the-missing") throw invalid(`${at}: endpoint ${id} has no voice record`);
      e.voice = null;
      return;
    }
    const { endpoint: _e, ...record } = v;
    e.voice = merged<VoiceRecord>(e.voice ?? undefined, record, {}, ["zone", "output"]);
    return;
  }
  if (del && kind === "rule_exception" && (v.rule === undefined || v.from === undefined)) throw invalid(`${at}: a rule_exception is deleted by its rule, from and until`);
  if (del && kind === "schedule_exception" && (v.schedule === undefined || v.date === undefined)) throw invalid(`${at}: a schedule_exception is deleted by its schedule and date`);
  if (del && v.id === undefined && !EXCEPTIONS.has(kind)) throw invalid(`${at}: a ${kind} is deleted by its id`);
  const gone = (found: boolean) => need(found || ctx.mutation === "deletes-the-missing", at, v.id);
  switch (kind) {
    case "home": {
      if (del) throw invalid(`${at}: the home's settings are set, never deleted`);
      if (v.time_source !== undefined && v.time_source !== null && !ctx.underHarness) {
        throw invalid(`${at}: time_source is accepted only while the applier reports a test_run_id (GA-HARN-2)`);
      }
      const hold = v.hold as Record<string, unknown> | null | undefined;
      if (hold?.schedule_ends === true) {
        if (ctx.mutation === "refuses-a-flag-unnamed") throw invalid(`${at}: hold: this steward does not implement it`);
        throw new RequestError("invalid_request", `${at}: hold.schedule_ends: this steward does not end a hold at a schedule's step (GA-LEASE-8)`, { field: "schedule_ends" });
      }
      // The mutation: the home's switch refused, though no steward may refuse it (GA-LEASE-12).
      if (ctx.mutation === "refuses-the-owner-switch" && hold?.owner_work_passes_holds === true) {
        throw new RequestError("invalid_request", `${at}: hold.owner_work_passes_holds: this steward does not pass a person's hold`, { field: "owner_work_passes_holds" });
      }
      // The mutation: an owner's short windows refused, though GA-LEASE-8 bounds them by the schema's minimum only.
      if (ctx.mutation === "refuses-a-short-hold" && hold && ["on_s", "off_s", "other_s", "fixed_s"].some((f) => typeof hold[f] === "number" && (hold[f] as number) < 60)) {
        throw invalid(`${at}: hold windows under 60 s are refused`);
      }
      const home = h.home as unknown as Args;
      for (const [k, x] of Object.entries(v)) {
        if (k === "hold") {
          const next = x === null ? structuredClone(HOLD_DEFAULTS) : { ...h.home.hold };
          if (x !== null) for (const [f, y] of Object.entries(x as Record<string, unknown>)) {
            (next as unknown as Record<string, unknown>)[f] = y === null
              ? (ctx.mutation === "null-keeps-the-window" ? (next as unknown as Record<string, unknown>)[f] : HOLD_DEFAULTS[f as keyof HoldPolicy]) : y;
          }
          h.home.hold = next;
          continue;
        }
        if (x === null) {
          if (k === "time_source") delete home[k];
          else home[k] = structuredClone((HOME_DEFAULTS as unknown as Args)[k]);
        } else home[k] = x;
      }
      return;
    }
    case "room": return void (del ? gone(h.rooms.delete(v.id)) : h.rooms.set(v.id, merged(h.rooms.get(v.id), v)));
    case "target": {
      if (del) return void gone(h.targets.delete(v.id));
      if (v.account_persons !== undefined) throw invalid(`${at}: account_persons is not built yet in this steward (GA-DEF-11, slice 8)`);
      named(ctx, v.id, at, v.room != null ? "room" : undefined);
      // The overlay merges: a field left out keeps its value, null returns it to the applier's label, no aliases, no room.
      const was = ctx.mutation === "renames-away-the-room" ? { id: v.id } : h.targets.get(v.id);
      const t = merged<TargetOverlay>(was, v);
      // A target's switch is stored only where true, as a rule's is: false, null or left out all read false (GA-LEASE-12).
      if (t.owner_work_passes_holds !== true) delete t.owner_work_passes_holds;
      // The owner naming the device's room sets it again: a brain's mark on it goes (GA-DEF-7).
      if (owners && "room" in v) delete t.room_brain_authored;
      if (t.room === undefined) delete t.room_brain_authored;
      h.targets.set(v.id, t);
      return;
    }
    case "group": {
      if (del) return void gone(h.groups.delete(v.id));
      if (ctx.device(v.id)) throw invalid(`${at}: group ${v.id}: the applier has a device of that id`);
      const g = merged<Group>(h.groups.get(v.id), v, { aliases: [] }, ["room"]);
      g.aliases ??= [];
      g.members = [...g.members].sort(byCodePoint);
      if (v.members !== undefined) for (const m of g.members) named(ctx, m, at, "group");
      // The owner naming the members sets them again: the marks of those that joined through a brain go (GA-DEF-7).
      if (owners && "members" in v) delete g.brain_joined;
      h.groups.set(v.id, g);
      return;
    }
    case "person": return void (del ? gone(h.persons.delete(v.id)) : h.persons.set(v.id, merged(h.persons.get(v.id), v)));
    case "endpoint": {
      if (del) return void gone(h.endpoints.delete(v.id));
      // An endpoint's voice record is its own kind: an upsert keeps the one it has.
      const was = h.endpoints.get(v.id);
      const base = was && ctx.mutation === "drops-confirm-on" ? (({ confirm_on: _c, ...rest }) => rest)(was) : was;
      const e = merged<Endpoint>(base as Endpoint | undefined, v, {}, ["room", "person", "served_by"]);
      if (e.confirm_on === "same") delete e.confirm_on;
      e.voice = was?.voice ?? null;
      h.endpoints.set(v.id, e);
      return;
    }
    case "rule": {
      if (del) return void gone(h.rules.delete(v.id));
      const was = h.rules.get(v.id);
      const r = merged<Rule>(was, v, RULE_DEFAULTS);
      r.active ??= true;
      r.exceptions = sortedExceptions(r.exceptions ?? []);
      // A rule's mark is stored only where true: false, null or left out on a new rule all read false (GA-LEASE-12).
      if (r.passes_holds !== true) delete r.passes_holds;
      if (r.trigger === undefined && r.conditions === undefined) throw invalid(`${at}: a rule keeps a trigger or conditions (GA-DEF-14)`);
      if (owners && was && whole(r as unknown as Args, v, RULE_FIELDS, RULE_DEFAULTS)) delete r.brain_authored;
      checkRule(h, r, at, ctx);
      h.rules.set(r.id, r);
      return;
    }
    case "scenario": {
      if (del) return void gone(h.scenarios.delete(v.id));
      const sc = merged<Scenario>(h.scenarios.get(v.id), v, SCENARIO_DEFAULTS);
      sc.owned ??= [];
      sc.respect_occupancy ??= false;
      if (owners && h.scenarios.has(v.id) && whole(sc as unknown as Args, v, SCENARIO_FIELDS, SCENARIO_DEFAULTS)) delete sc.brain_authored;
      checkScenario(h, sc, at, ctx);
      h.scenarios.set(sc.id, sc);
      return;
    }
    case "rule_exception": {
      const r = h.rules.get(v.rule);
      if (!r) throw invalid(`${at}: no rule ${v.rule}`);
      const x = { from: v.from as string, until: v.until as string };
      checkException(x, at);
      const same = (y: { from: string; until: string }) => Date.parse(y.from) === Date.parse(x.from) && Date.parse(y.until) === Date.parse(x.until);
      if (del) {
        if (!r.exceptions.some(same) && ctx.mutation !== "deletes-the-missing") throw invalid(`${at}: rule ${r.id} has no such exception`);
        r.exceptions = r.exceptions.filter((y) => !same(y));
      } else if (!r.exceptions.some(same)) {
        if (r.exceptions.length >= MAX_EXCEPTIONS) throw invalid(`${at}: rule ${r.id} has ${MAX_EXCEPTIONS} exceptions; upsert it without the ended ones`);
        r.exceptions = sortedExceptions([...r.exceptions, x]);
      }
      return;
    }
    case "schedule": {
      if (del) return void gone(h.schedules.delete(v.id));
      const was = h.schedules.get(v.id);
      const sc = merged<Schedule>(was, v, SCHEDULE_DEFAULTS);
      const exceptions = (sc.exceptions ?? []) as ScheduleException[];
      for (const x of exceptions) checkDate(x.date, at);
      const dates = exceptions.map((x) => x.date).sort();
      const twice = dates.find((d, i) => dates[i + 1] === d);
      if (twice) throw invalid(`${at}: two exceptions on ${twice}: one exception skips or moves a date's run (GA-SCHED-1)`);
      sc.exceptions = [...exceptions].sort((a, b) => byCodePoint(a.date, b.date));
      if (owners && was && whole(sc as unknown as Args, v, SCHEDULE_FIELDS)) delete sc.brain_authored;
      h.schedules.set(sc.id, sc);
      return;
    }
    case "schedule_exception": {
      const sc = h.schedules.get(v.schedule);
      if (!sc) throw invalid(`${at}: no schedule ${v.schedule}`);
      checkDate(v.date, at);
      if (del) {
        // Removed by its key, its schedule and date (GA-DEF-14).
        if (!sc.exceptions.some((y) => y.date === v.date) && ctx.mutation !== "deletes-the-missing") throw invalid(`${at}: schedule ${sc.id} has no exception on ${v.date}`);
        sc.exceptions = sc.exceptions.filter((y) => y.date !== v.date);
        return;
      }
      const x: ScheduleException = { date: v.date, action: v.action, ...(v.time !== undefined ? { time: v.time } : {}) };
      // One exception per date: an upsert replaces the date's.
      const others = sc.exceptions.filter((y) => y.date !== x.date);
      if (others.length >= MAX_EXCEPTIONS) throw invalid(`${at}: schedule ${sc.id} has ${MAX_EXCEPTIONS} exceptions; upsert it without the ended ones`);
      sc.exceptions = [...others, x].sort((a, b) => byCodePoint(a.date, b.date));
      return;
    }
    case "credential": {
      if (del) return void gone(h.credentials.delete(v.id));
      const { secret, ...rest } = v;
      const c = merged<Credential>(h.credentials.get(v.id), rest);
      if (secret !== undefined) c.secret_sha256 = digest(secret);
      h.credentials.set(v.id, c);
      return;
    }
  }
}

/**
 * The fields each kind's upsert creates an item with (steward, *Change sets*, GA-DEF-14); a rule needs
 * a trigger or conditions besides. The schemas take an upsert naming its key only (the merge's update);
 * where they allow null for one (an endpoint's room, person and served_by, a voice record's zone, a
 * group's room), null is a value, "none".
 */
const CREATED_WITH: Record<string, string[]> = {
  room: ["name"], person: ["name", "role"], endpoint: ["name", "type", "room", "person", "served_by"],
  voice: ["listening", "wake_words", "zone", "output", "follow_up", "heard_by"], credential: ["kind", "secret"],
  group: ["name", "room", "members", "aggregate"], rule: ["name", "actions"], scenario: ["name", "mode", "steps"], schedule: ["scenario", "time"],
};

/**
 * An upsert that creates an item gives its kind's created-with fields (GA-DEF-14), and a rule a trigger
 * or conditions, not both null; an upsert of an item that exists merges, and needs none of them.
 */
function checkCreatedWith(kind: string, v: Args, at: string): void {
  const missing = (CREATED_WITH[kind] ?? []).filter((f) => v[f] === undefined);
  if (missing.length) throw invalid(`${at}: a ${kind} is created with ${missing.join(", ")}, which it leaves out (GA-DEF-14)`);
  if (kind === "rule" && (v.trigger ?? undefined) === undefined && (v.conditions ?? undefined) === undefined) {
    throw invalid(`${at}: a rule is created with a trigger or conditions (GA-DEF-14)`);
  }
}

/**
 * The devices a rule reads, in its trigger and conditions, in order, repeats kept; with `values`, only
 * those whose values it reads, an event trigger's device left out (GA-RULE-2 governs values, not liveness).
 */
export function readsOf(r: Rule, values = false): string[] {
  const t = r.trigger;
  return [...(t && "state" in t ? [t.state.target] : t && "held" in t ? [t.held.target] : t && "event" in t && !values ? [t.event.target] : []),
    ...(r.conditions ?? []).flatMap((c) => ("target" in c ? [c.target] : []))];
}

/** A rule's or a schedule's exceptions at most, as their schemas cap them. */
const MAX_EXCEPTIONS = 64;
/** The kinds whose delete names the thing whole, not by an id. */
const EXCEPTIONS = new Set(["rule_exception", "schedule_exception"]);

/** A schedule exception's date is one the calendar has (its schema checks only its form). */
function checkDate(date: string, at: string): void {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m! - 1 || t.getUTCDate() !== d) throw invalid(`${at}: no date ${date}`);
}

const sortedExceptions = (xs: { from: string; until: string }[]) =>
  [...xs].sort((a, b) => Date.parse(a.from) - Date.parse(b.from) || Date.parse(a.until) - Date.parse(b.until));

/** An exception's `until` is after its `from` (GA-RULE-6). */
function checkException(x: { from: string; until: string }, at: string): void {
  if (!(Date.parse(x.until) > Date.parse(x.from))) throw invalid(`${at}: an exception's until ${x.until} is not after its from ${x.from} (GA-RULE-6)`);
}

/**
 * A rule's own checks (steward, *Rules*): no window whose `from` equals its `until` (GA-RULE-3), no
 * exception whose `until` is not after its `from` (GA-RULE-6), every device it reads or acts on by id
 * one the applier describes and has adopted (GA-DEF-9), and none it acts on `internal` (GA-DEF-10); an
 * action's target may be a group the model holds. `rules-a-wake-relay` takes an internal one.
 */
function checkRule(h: House, r: Rule, at: string, ctx: DefineContext): void {
  const windows = (r.conditions ?? []).flatMap((c) => ("between" in c ? [c.between] : []));
  for (const w of windows) if (w.from === w.until) throw invalid(`${at}: a window whose from equals its until (GA-RULE-3): ${w.from}`);
  for (const x of r.exceptions) checkException(x, at);
  for (const id of readsOf(r)) named(ctx, id, at);
  for (const a of deviceActions(r)) {
    if (a.target === undefined || (h.groups.has(a.target) && !ctx.device(a.target))) continue;
    named(ctx, a.target, at, ctx.mutation === "rules-a-wake-relay" ? undefined : "rule's action");
  }
}

/**
 * A scenario's own checks (steward, *Scenarios*): a mode the steward lists (GA-SCN-5), each branch a
 * scenario's steps by its schema, every device it reads, waits on, owns or acts on by id one the applier
 * describes and has adopted (GA-DEF-9), and none it acts on `internal` (GA-DEF-10); a target id may be
 * a group the model holds. Its `run` steps are checked on the whole model (`check`).
 */
function checkScenario(h: House, sc: Scenario, at: string, ctx: DefineContext): void {
  if (!(MODES as readonly string[]).includes(sc.mode)) throw invalid(`${at}: mode ${sc.mode} is not one this steward runs (${MODES.join(", ")}; GA-SCN-5)`);
  const grouped = (id: string) => h.groups.has(id) && !ctx.device(id);
  for (const id of sc.owned) if (!grouped(id)) named(ctx, id, at);
  const walk = (steps: ScenarioStep[]): void => {
    for (const st of steps) {
      if ("if" in st) {
        for (const branch of [st.then, st.else ?? []]) {
          const errors = branch.length ? validate("steward/define.scenario.json", { id: sc.id, name: sc.name, mode: sc.mode, steps: branch }) : [];
          if (errors.length) throw invalid(`${at}: a branch of an if: ${errors.join("; ")}`);
        }
        named(ctx, st.if.target, at);
        walk(st.then);
        walk(st.else ?? []);
      } else if ("wait" in st) named(ctx, st.wait.target, at);
      else if ("action" in st && st.target !== undefined && !grouped(st.target)) named(ctx, st.target, at, "scenario's action");
    }
  };
  walk(sc.steps);
}

/** The scenarios a scenario's `run` steps name, in order, branches included. */
export function runsOf(steps: ScenarioStep[]): string[] {
  return steps.flatMap((st) => ("run" in st ? [st.run] : "if" in st ? [...runsOf(st.then), ...runsOf(st.else ?? [])] : []));
}

/** The devices a scenario's `if` steps read, in order, `run` steps not followed (GA-RULE-2's notice is per scenario). */
export function ifReadsOf(steps: ScenarioStep[]): string[] {
  return steps.flatMap((st) => ("if" in st ? [st.if.target, ...ifReadsOf(st.then), ...ifReadsOf(st.else ?? [])] : []));
}

/** Every id a scenario's steps name: its actions' targets and its `if`s' and `wait`s' devices, `run` steps not followed. */
export function targetsOfSteps(steps: ScenarioStep[]): string[] {
  return steps.flatMap((st) => ("run" in st || "delay" in st ? [] : "wait" in st ? [st.wait.target]
    : "if" in st ? [st.if.target, ...targetsOfSteps(st.then), ...targetsOfSteps(st.else ?? [])] : st.target !== undefined ? [st.target] : []));
}

/**
 * A group the change set deletes that a rule or a scenario still names (in its actions, its reads, an
 * `if`, a `wait` or `owned`) is refused with `invalid_request`, the message listing each that names
 * it, so nothing points at nothing (`define` is checked and atomic, *Rulings*, rather than
 * leaving a dangling name to be skipped at fire time). The dependants are changed or deleted in the same set.
 */
function checkGone(before: House, h: House, ctx: DefineContext): void {
  for (const id of [...before.groups.keys()].sort(byCodePoint)) {
    if (h.groups.has(id) || ctx.device(id)) continue;
    const by = [...[...h.rules.values()].filter((r) => readsOf(r).includes(id) || deviceActions(r).some((a) => a.target === id)).map((r) => `rule ${r.id}`),
      ...[...h.scenarios.values()].filter((sc) => sc.owned.includes(id) || targetsOfSteps(sc.steps).includes(id)).map((sc) => `scenario ${sc.id}`)]
      .sort(byCodePoint);
    if (by.length) throw invalid(`group ${id} is still named by ${by.join(", ")}: change or delete them in the same change set`);
  }
}

/**
 * The scenarios', rules' and schedules' references on the model as it would stand: every `run` step,
 * every rule's start and every schedule names a scenario it holds (`invalid_request`), and no `run` steps form a cycle, a
 * scenario reaching itself (GA-DEF-4: `cycle`).
 */
function checkReferences(h: House): void {
  for (const sc of h.scenarios.values()) for (const id of runsOf(sc.steps)) {
    if (!h.scenarios.has(id)) throw invalid(`scenario ${sc.id}: its run step names no scenario ${id}`);
  }
  for (const r of h.rules.values()) for (const id of startsOf(r)) if (!h.scenarios.has(id)) throw invalid(`rule ${r.id}: it starts no scenario ${id}`);
  for (const sc of h.schedules.values()) if (!h.scenarios.has(sc.scenario)) throw invalid(`schedule ${sc.id}: it runs no scenario ${sc.scenario}`);
  const done = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (path.includes(id)) throw new RequestError("cycle", `the run steps form a cycle: ${[...path.slice(path.indexOf(id)), id].join(" → ")} (GA-DEF-4)`);
    if (done.has(id)) return;
    for (const next of runsOf(h.scenarios.get(id)!.steps)) visit(next, [...path, id]);
    done.add(id);
  };
  for (const id of [...h.scenarios.keys()].sort(byCodePoint)) visit(id, []);
}

function need(found: boolean, at: string, id: string): void {
  if (!found) throw invalid(`${at}: no ${id} to delete`);
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A device a change names: one the applier describes and has adopted (GA-DEF-9), and, put `into` a room
 * or a group, not `internal` (GA-DEF-10). Only the devices a change names are checked, so an overlay
 * whose device the applier later forgot or marked internal does not block every later change set.
 */
function named(ctx: DefineContext, id: string, at: string, into?: "room" | "group" | "rule's action" | "scenario's action"): void {
  const d = ctx.device(id);
  if (!d) throw invalid(`${at}: ${id} is no device the applier describes`);
  if (!d.adopted && ctx.mutation !== "defines-unadopted") throw invalid(`${at}: ${id} is not adopted (GA-DEF-9)`);
  if (into && d.internal && !((into === "room" || into === "group") && ctx.mutation === "rooms-an-internal-device")) throw invalid(`${at}: ${id} is internal: no ${into} (GA-DEF-10)`);
}

/** The checks on the model as the change set would leave it; the first that fails refuses it whole. */
function check(h: House, ctx: DefineContext): void {
  const endpoints = [...h.endpoints.values()];
  const credentials = [...h.credentials.values()];
  const brainServed = (id: string) => h.endpoints.get(id)?.served_by != null;
  for (const t of h.targets.values()) if (t.room != null && !h.rooms.has(t.room)) throw invalid(`target ${t.id}: no room ${t.room}`);
  for (const g of h.groups.values()) if (g.room !== null && !h.rooms.has(g.room)) throw invalid(`group ${g.id}: no room ${g.room}`);
  for (const e of endpoints) {
    const at = `endpoint ${e.id}`;
    if (e.room !== null && !h.rooms.has(e.room)) throw invalid(`${at}: no room ${e.room}`);
    if (e.person !== null && !h.persons.has(e.person)) throw invalid(`${at}: no person ${e.person}`);
    if (e.served_by !== null && h.credentials.get(e.served_by)?.kind !== "brain") throw invalid(`${at}: served_by ${e.served_by} is no brain credential`);
    // GA-DEF-8, in the order the requirement lists them.
    if (e.served_by === null && (e.type === "voice" || e.voice)) throw invalid(`${at}: a voice endpoint, or one with a voice record, needs served_by (GA-DEF-8)`);
    if (e.type === "app" && e.person === null && ctx.mutation !== "app-without-person") throw invalid(`${at}: an app endpoint needs a person (GA-DEF-8)`);
    if (e.voice && h.credentials.get(e.voice.heard_by)?.kind !== "front") throw invalid(`${at}: heard_by ${e.voice.heard_by} is no front credential (GA-DEF-8)`);
    if (e.voice?.skill_account !== undefined && (e.type !== "voice" || e.person !== null)) {
      throw invalid(`${at}: a skill_account is only on a voice endpoint with no person (GA-DEF-8)`);
    }
    if (e.voice?.skill_surface !== undefined && e.voice.skill_account === undefined) throw invalid(`${at}: a skill_surface needs a skill_account`);
    if (e.room === null && e.type !== "app") throw invalid(`${at}: only an app endpoint has no room (GA-DEF-8)`);
    if (e.confirm_on !== undefined) {
      if (!h.endpoints.has(e.confirm_on)) throw invalid(`${at}: confirm_on names no endpoint ${e.confirm_on}`);
      if (brainServed(e.confirm_on) && ctx.mutation !== "serves-the-confirm-on") {
        throw invalid(`${at}: confirm_on ${e.confirm_on} is served by a brain (GA-CONF-4)`);
      }
    }
  }
  const fronts = new Set(endpoints.flatMap((e) => (e.voice ? [e.voice.heard_by] : [])));
  if (fronts.size > 1) throw invalid(`voice records name more than one front: ${[...fronts].sort().join(", ")} (GA-DEF-8)`);
  const skills = endpoints.filter((e) => e.voice?.skill_account !== undefined).map((e) => e.voice!);
  const seen = new Set<string>();
  for (const v of skills) {
    const key = canonical([v.skill_account, v.skill_surface ?? null]);
    if (seen.has(key)) throw invalid(`two endpoints have skill_account ${v.skill_account} and one skill_surface (GA-DEF-8)`);
    seen.add(key);
    if (skills.some((w) => w.skill_account === v.skill_account && (w.skill_surface === undefined) !== (v.skill_surface === undefined))) {
      throw invalid(`skill_account ${v.skill_account} has both a surfaced endpoint and one without (GA-DEF-8)`);
    }
  }
  const secrets = new Set<string>();
  for (const c of credentials) {
    const at = `credential ${c.id}`;
    if (secrets.has(c.secret_sha256)) throw invalid(`${at}: another credential has this secret`);
    secrets.add(c.secret_sha256);
    if (c.kind === "app" || c.kind === "panel") {
      const e = c.endpoint === undefined ? undefined : h.endpoints.get(c.endpoint);
      if (!e) throw invalid(`${at}: an ${c.kind} credential names its one endpoint`);
      if (e.type !== c.kind) throw invalid(`${at}: an ${c.kind} credential is bound to an ${c.kind} endpoint, not ${e.type} ${e.id}`);
    } else if (c.endpoint !== undefined) throw invalid(`${at}: a ${c.kind} credential is bound through its endpoints, and names none`);
    if (c.confirm_on !== undefined) {
      if (c.kind !== "brain") throw invalid(`${at}: only a brain credential carries its own confirm_on`);
      if (!h.endpoints.has(c.confirm_on)) throw invalid(`${at}: confirm_on names no endpoint ${c.confirm_on}`);
      if (brainServed(c.confirm_on) && ctx.mutation !== "serves-the-confirm-on") {
        throw invalid(`${at}: confirm_on ${c.confirm_on} is served by a brain (GA-CONF-4)`);
      }
    }
  }
  checkReferences(h);
}

/**
 * `notice_channels` (GA-DEF-8): empty until the owner first sets it, and change sets are taken while it
 * is so; once set (non-empty before this change set: once set it is never empty again, so no flag is
 * kept), a change set that leaves it empty is refused. A change set that sets the list has each entry
 * checked: a device the applier describes, adopted, offering `notify` or `media.announce`; a list of
 * announcing channels alone is taken. Only the entries a change set sets are checked, so a channel that
 * later leaves adoption refuses nothing else (it is noticed instead, GA-NOTE-4).
 */
function checkChannels(before: HomeSettings, after: HomeSettings, sets: boolean, ctx: DefineContext): void {
  if (!after.notice_channels.length) {
    if (before.notice_channels.length) throw invalid("notice_channels cannot be left empty once set (GA-DEF-8)");
    if (ctx.mutation === "refuses-the-first-define") throw invalid("notice_channels names no notify channel (GA-DEF-8, GA-NOTE-1)");
    return;
  }
  if (!sets) return;
  for (const id of after.notice_channels) {
    const d = ctx.device(id);
    if (!d) throw invalid(`notice channel ${id} is no device the applier describes`);
    if (!d.adopted) throw invalid(`notice channel ${id} is not adopted (GA-DEF-8, GA-DEF-9)`);
    const offers = d.actions.includes("notify.notify") || d.actions.includes("media.announce");
    if (!offers && ctx.mutation !== "takes-a-silent-channel") throw invalid(`notice channel ${id} has neither notify nor media.announce (GA-DEF-8)`);
  }
  if (ctx.mutation === "refuses-an-announcing-channel" && !hasNotifyChannel(after, ctx)) {
    throw invalid("notice_channels names no notify channel (GA-DEF-8, GA-NOTE-1)");
  }
}

/** Whether `notice_channels` has an adopted channel offering `notify` (GA-NOTE-1): without one, notices are held. */
export function hasNotifyChannel(home: HomeSettings, ctx: Pick<DefineContext, "device">): boolean {
  return notifyChannels(home, ctx).length > 0;
}

/**
 * The channels of `notice_channels` that carry a notice now, in code-point order: adopted, with
 * `notify.notify` among their actions. One predicate for holding and for sending (the code review, CR5).
 */
export function notifyChannels(home: HomeSettings, ctx: Pick<DefineContext, "device">): string[] {
  return [...home.notice_channels].sort().filter((id) => {
    const d = ctx.device(id);
    return d !== undefined && d.adopted && d.actions.includes("notify.notify");
  });
}

/** A readable diff of the model, one line per object added, removed or changed; a secret is never shown. */
export function diffOf(before: House, after: House): string[] {
  const lines: string[] = [];
  const shown = (v: unknown) => JSON.stringify(v);
  const fields = (a: Args, b: Args) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    .filter((k) => canonical(a[k]) !== canonical(b[k]))
    .map((k) => (k === "secret_sha256" ? "secret changed" : `${k} ${a[k] === undefined ? "unset" : shown(a[k])} → ${b[k] === undefined ? "unset" : shown(b[k])}`));
  const home = fields(before.home as unknown as Args, after.home as unknown as Args);
  if (home.length) lines.push(`home: ${home.join("; ")}`);
  for (const [kind, of] of TABLES) {
    const a = of(before);
    const b = of(after);
    for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(id) as Args | undefined;
      const y = b.get(id) as Args | undefined;
      if (!y) lines.push(`- ${kind} ${id}`);
      else if (!x) lines.push(`+ ${kind} ${id}: ${Object.keys(y).filter((k) => k !== "id").sort()
        .map((k) => (k === "secret_sha256" ? "secret set" : `${k} ${shown(y[k])}`)).join("; ")}`);
      else {
        const f = fields(x, y);
        if (f.length) lines.push(`~ ${kind} ${id}: ${f.join("; ")}`);
      }
    }
  }
  return lines;
}
