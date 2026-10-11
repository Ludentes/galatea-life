import { validate } from "@ludentes/galatea-life-schemas";
import { canonical, storable } from "../core/canonical.js";
import { RequestError } from "../core/errors.js";
import { digest } from "../core/secret.js";
import type { Mutation } from "../mutations.js";
import { markBrain } from "./brain.js";
import { copyHouse, deviceActions, HOME_DEFAULTS, startsOf, TABLES, type Credential, type Endpoint, type Group, type House, type HomeSettings, type Rule,
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
    // An exception is removed by naming it whole: its rule, from and until; its schedule, date, action and time.
    const schema = c.op === "delete" && !EXCEPTIONS.has(c.kind) ? "steward/define.delete.json" : `steward/define.${c.kind}.json`;
    const errors = validate(schema, c.value ?? {});
    if (errors.length) throw invalid(`${at}: ${errors.join("; ")}`);
    if (c.op === "upsert") checkCreatedWith(c.kind, c.value as Args, at);
    apply(draft, c.op, c.kind, c.value as Args, at, ctx);
  });
  check(draft, ctx);
  checkGone(house, draft, ctx);
  if (ctx.brain) markBrain(house, draft);
  return { draft, diff: diffOf(house, draft) };
}

function apply(h: House, op: Change["op"], kind: string, v: Args, at: string, ctx: DefineContext): void {
  const del = op === "delete";
  if (kind === "voice") {
    if (v.endpoint === undefined) throw invalid(`${at}: a voice record is named by its endpoint`);
    const id: string = v.endpoint;
    const e = h.endpoints.get(id);
    if (!e) throw invalid(`${at}: no endpoint ${id}`);
    if (del && !e.voice) throw invalid(`${at}: endpoint ${id} has no voice record`);
    const { endpoint: _e, ...record } = v;
    e.voice = del ? null : (record as VoiceRecord);
    return;
  }
  if (del && v.id === undefined && !EXCEPTIONS.has(kind)) throw invalid(`${at}: a ${kind} is deleted by its id`);
  switch (kind) {
    case "home": {
      if (del) throw invalid(`${at}: the home's settings are set, never deleted`);
      if (v.time_source !== undefined && v.time_source !== null && !ctx.underHarness) {
        throw invalid(`${at}: time_source is accepted only while the applier reports a test_run_id (GA-HARN-2)`);
      }
      const home = h.home as unknown as Args;
      for (const [k, x] of Object.entries(v)) {
        if (x === null) {
          if (k === "time_source") delete home[k];
          else home[k] = structuredClone((HOME_DEFAULTS as unknown as Args)[k]);
        } else home[k] = x;
      }
      return;
    }
    case "room": return void (del ? need(h.rooms.delete(v.id), at, v.id) : h.rooms.set(v.id, { id: v.id, name: v.name }));
    case "target": {
      if (del) return void need(h.targets.delete(v.id), at, v.id);
      named(ctx, v.id, at, v.room != null ? "room" : undefined);
      // An upsert replaces the overlay whole: a field left out is the applier's label, no alias, no room.
      const t: TargetOverlay = { id: v.id, ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.aliases !== undefined ? { aliases: v.aliases } : {}), ...(v.room !== undefined ? { room: v.room } : {}) };
      h.targets.set(v.id, t);
      return;
    }
    case "group": {
      if (del) return void need(h.groups.delete(v.id), at, v.id);
      if (ctx.device(v.id)) throw invalid(`${at}: group ${v.id}: the applier has a device of that id`);
      const members = [...(v.members as string[])].sort(byCodePoint);
      for (const m of members) named(ctx, m, at, "group");
      const g: Group = { id: v.id, name: v.name, aliases: v.aliases ?? [], room: v.room, members, aggregate: v.aggregate };
      h.groups.set(v.id, g);
      return;
    }
    case "person": return void (del ? need(h.persons.delete(v.id), at, v.id) : h.persons.set(v.id, { id: v.id, name: v.name, role: v.role }));
    case "endpoint": {
      if (del) return void need(h.endpoints.delete(v.id), at, v.id);
      // An endpoint's voice record is its own kind: an upsert keeps the one it has.
      const e: Endpoint = { id: v.id, name: v.name, type: v.type, room: v.room, person: v.person, served_by: v.served_by,
        ...(v.max_role !== undefined ? { max_role: v.max_role } : {}),
        ...(v.confirm_on !== undefined && v.confirm_on !== "same" ? { confirm_on: v.confirm_on } : {}),
        voice: h.endpoints.get(v.id)?.voice ?? null };
      h.endpoints.set(v.id, e);
      return;
    }
    case "rule": {
      if (del) return void need(h.rules.delete(v.id), at, v.id);
      const r = { ...v, active: v.active ?? true, exceptions: sortedExceptions(v.exceptions ?? []) } as Rule;
      checkRule(h, r, at, ctx);
      h.rules.set(r.id, r);
      return;
    }
    case "scenario": {
      if (del) return void need(h.scenarios.delete(v.id), at, v.id);
      const sc: Scenario = { ...v, owned: v.owned ?? [], respect_occupancy: v.respect_occupancy ?? false } as Scenario;
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
        if (!r.exceptions.some(same)) throw invalid(`${at}: rule ${r.id} has no such exception`);
        r.exceptions = r.exceptions.filter((y) => !same(y));
      } else if (!r.exceptions.some(same)) {
        if (r.exceptions.length >= MAX_EXCEPTIONS) throw invalid(`${at}: rule ${r.id} has ${MAX_EXCEPTIONS} exceptions; upsert it without the ended ones`);
        r.exceptions = sortedExceptions([...r.exceptions, x]);
      }
      return;
    }
    case "schedule": {
      if (del) return void need(h.schedules.delete(v.id), at, v.id);
      const exceptions = (v.exceptions ?? []) as ScheduleException[];
      for (const x of exceptions) checkDate(x.date, at);
      const dates = exceptions.map((x) => x.date).sort();
      const twice = dates.find((d, i) => dates[i + 1] === d);
      if (twice) throw invalid(`${at}: two exceptions on ${twice}: one exception skips or moves a date's run (GA-SCHED-1)`);
      const sc: Schedule = { id: v.id, scenario: v.scenario, time: v.time, ...(v.days !== undefined ? { days: v.days } : {}),
        exceptions: [...exceptions].sort((a, b) => byCodePoint(a.date, b.date)) };
      h.schedules.set(sc.id, sc);
      return;
    }
    case "schedule_exception": {
      const sc = h.schedules.get(v.schedule);
      if (!sc) throw invalid(`${at}: no schedule ${v.schedule}`);
      checkDate(v.date, at);
      const x: ScheduleException = { date: v.date, action: v.action, ...(v.time !== undefined ? { time: v.time } : {}) };
      if (del) {
        // Named whole, its mark aside: a move a brain made is removed by naming the move.
        const same = ({ brain_authored: _b, ...y }: ScheduleException) => canonical(y) === canonical(x);
        if (!sc.exceptions.some(same)) throw invalid(`${at}: schedule ${sc.id} has no such exception`);
        sc.exceptions = sc.exceptions.filter((y) => !same(y));
        return;
      }
      // One exception per date: an upsert replaces the date's.
      const others = sc.exceptions.filter((y) => y.date !== x.date);
      if (others.length >= MAX_EXCEPTIONS) throw invalid(`${at}: schedule ${sc.id} has ${MAX_EXCEPTIONS} exceptions; upsert it without the ended ones`);
      sc.exceptions = [...others, x].sort((a, b) => byCodePoint(a.date, b.date));
      return;
    }
    case "credential": {
      if (del) return void need(h.credentials.delete(v.id), at, v.id);
      const c: Credential = { id: v.id, kind: v.kind, secret_sha256: digest(v.secret),
        ...(v.endpoint !== undefined ? { endpoint: v.endpoint } : {}), ...(v.confirm_on !== undefined ? { confirm_on: v.confirm_on } : {}) };
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
 * An upsert gives its kind's created-with fields (GA-DEF-14), and a rule a trigger or conditions, not
 * both null. Ruled: the build still replaces an item whole on an upsert (the merge GA-DEF-14 asks for is
 * not built yet), so an upsert of an item that exists must give them too, refused rather than leaving the
 * item without them; once the merge is built, this applies to an upsert that creates an item only.
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
  checkChannels(h.home, ctx);
  checkReferences(h);
}

/**
 * `notice_channels` names targets with `notify` or `media.announce`, adopted, and at least one with
 * `notify`, or `define` refuses (GA-DEF-8, GA-NOTE-1, GA-DEF-9). Read literally, so a fresh steward's
 * first change set must name one (the design, *Standards problems found*).
 */
function checkChannels(home: HomeSettings, ctx: DefineContext): void {
  let notify = false;
  for (const id of home.notice_channels) {
    const d = ctx.device(id);
    if (!d) throw invalid(`notice channel ${id} is no device the applier describes`);
    if (!d.adopted) throw invalid(`notice channel ${id} is not adopted (GA-DEF-9)`);
    const speaks = d.actions.includes("media.announce");
    if (d.actions.includes("notify.notify")) notify = true;
    else if (!speaks) throw invalid(`notice channel ${id} has neither notify nor media.announce`);
  }
  if (!notify) throw invalid("notice_channels names no notify channel (GA-DEF-8, GA-NOTE-1)");
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
