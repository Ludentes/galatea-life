import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { NotSent } from "../src/link/port.js";
import type { Mutation } from "../src/mutations.js";
import { Steward, type StewardOptions } from "../src/steward.js";
import { lasting, memoryDb } from "./db.js";
import { complete, FakeApplier } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";
import { BASELINE, SECRETS, up } from "./house.js";

type Body = Record<string, any>;
export type Db = Awaited<ReturnType<typeof memoryDb>>;

/** The key the applier holds for the steward, which proves its tokens. */
export const TOKEN_KEY = "a-token-key-of-the-steward-0123";
export const LAMP = "sim-bridge:lamp";
export const DIMMER = "sim-bridge:dimmer";
export const TV = "sim-bridge:tv";
export { complete };
export const describeOf = (devices: Body[], revision = 1, applierId = "sim-applier") => ({ applier_id: applierId, standard_version: "0.14", levels: ["Act"],
  ungoverned: [], revision, test_run_id: "r", devices: devices.map(complete) });
/** The applier's devices: a notify channel; a lamp; a dimmer whose `turn_on` is `confirm`; an open-loop tv whose power code toggles. */
export const DEVICES = [
  { id: "sim-bridge:channel", label: "channel", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] },
  { id: LAMP, label: "lamp", class: "light", capabilities: ["onoff"], adopted: true,
    actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "reversible" }] },
  { id: DIMMER, label: "dimmer", class: "light", capabilities: ["onoff", "level"], adopted: true, actions: [{ action: "onoff.turn_on", tier: "confirm" },
    { action: "onoff.turn_off", tier: "no_voice" }, { action: "level.set_level", tier: "reversible" }] },
  { id: TV, label: "tv", class: "tv", capabilities: ["onoff"], adopted: true, feedback: "open",
    actions: [{ action: "onoff.turn_off", tier: "reversible", toggles: true }] },
];

/**
 * How the fake applier judges a plan's or an apply's action without a token: the dimmer's `turn_on`
 * and `turn_off` `refuse(token)` (the latter `refuse(tier)` through a brain), the tv's toggle
 * `refuse(toggle_only)`; with a token, each is an op.
 */
export function judgeAction(a: Body): Body {
  if (a.target === DIMMER && a.action === "onoff.turn_off" && (a.brain || a.via === "voice")) return { verdict: "refuse", reason: "tier", tier: "no_voice" };
  if (a.target === DIMMER && a.action === "onoff.turn_on") return a.token ? { tier: "confirm" } : { verdict: "refuse", reason: "token", tier: "confirm" };
  if (a.target === DIMMER && a.action === "onoff.turn_off") return a.token ? { tier: "no_voice" } : { verdict: "refuse", reason: "token", tier: "no_voice" };
  if (a.target === TV) return a.token ? {} : { verdict: "refuse", reason: "toggle_only" };
  return {};
}

/** The baseline house, the lamp and dimmer in the hall, a group of both, and the brain serving a chat window in Olga's app. */
export const FURNISHED = [...BASELINE, up("target", { id: LAMP, room: "hall" }), up("target", { id: DIMMER, room: "hall" }),
  up("group", { id: "hall-lights", name: "Свет", room: "hall", members: [LAMP, DIMMER], aggregate: "any" }),
  up("endpoint", { id: "olga-chat", name: "Чат Ольги", type: "app", room: null, person: "olga", served_by: "brain" })];

/**
 * A steward over the fake applier, its mirror read, and the furnished house; `db` keeps the store across
 * a restart. `sync: false` leaves the applier's state unread, as a restart's link that reads the gap
 * first (`recover`); `fromNow` starts the follower at the applier's latest event, not its first.
 */
export async function setup(o: { db?: Db; clock?: FakeClock; mutation?: Mutation; reach?: boolean; define?: boolean;
  options?: Partial<StewardOptions>; applier?: FakeApplier; applierRevision?: number; applierId?: string; devices?: Body[]; state?: Body;
  sync?: boolean; fromNow?: boolean } = {}) {
  const clock = o.clock ?? new FakeClock();
  const db = o.db ?? lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; });
  const applier = o.applier ?? new FakeApplier();
  applier.planner = judgeAction;
  const port = applier.port();
  const steward = new Steward({ store, clock, stewardId: "demo-steward", ownerCredential: SECRETS.owner, runId: "r", mutation: o.mutation,
    applierPlan: (r) => (o.reach === false ? Promise.reject(new Error("the applier is out of reach")) : port.plan(r)),
    applierApply: (b, ms) => (o.reach === false ? Promise.reject(new NotSent("the applier is out of reach")) : port.apply(b, ms)),
    applierClient: "steward", tokenKey: TOKEN_KEY, ...o.options });
  await steward.start();
  steward.onDescribe(describeOf(o.devices ?? DEVICES, o.applierRevision, o.applierId));
  if (o.sync !== false) steward.onState(o.state ?? { targets: {}, transports: [], latches: [] });
  const call = (secret: string, tool: string, args: Body = {}) => steward.call(steward.caller(secret), tool, args);
  const ok = async (secret: string, tool: string, args: Body = {}) => {
    const r = await call(secret, tool, args);
    if (!r.ok) throw new Error(`${tool}: ${r.error}: ${r.message}`);
    return r.body as Body;
  };
  const error = async (secret: string, tool: string, args: Body = {}) => {
    const r = await call(secret, tool, args);
    return r.ok ? "ok" : r.error;
  };
  const define = async (changes: unknown[]) => ok(SECRETS.owner, "define", { endpoint: "owner-app", changes,
    expected_revision: (await ok(SECRETS.owner, "describe")).revision, dry_run: false });
  if (o.define !== false) await define(FURNISHED);
  // The link's follower, by hand: the applier's events since the last pump, handed to the steward as one batch.
  let cursor = o.fromNow ? String((await port.events(undefined, 0)).cursor) : "0";
  const pump = async () => {
    const r = await port.events(cursor, 0, steward.noticesTaken());
    cursor = r.cursor;
    steward.onNotices(r.notices ?? []);
    if (r.events.length) steward.onEvents(r.events);
  };
  return { clock, db, store, applier, port, steward, call, ok, error, define, pump };
}

export const on = (target: string, action = "onoff.turn_on", args: Body = {}) => ({ target, action, args });

let said = 0;
/**
 * An utterance record from `endpoint`, `ms` after the clock's now, with `extra` over it. Each has its
 * own transcript: two records of one endpoint, time and transcript are one utterance (GA-CONF-2).
 */
export function heardAt(clock: FakeClock, endpoint: string, extra: Body = {}, ms = 0): Body {
  return { utterance_id: randomUUID(), endpoint, time: new Date(clock.now() + ms).toISOString(), transcript: `да ${++said}`, addressed_by: "wake", ...extra };
}

/** The events since `cursor`, of `type` when given. */
export async function eventsSince(ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string, type?: string): Promise<Body[]> {
  const events = (await ok(SECRETS.owner, "events", { cursor })).events as Body[];
  return type ? events.filter((e) => e.type === type) : events;
}

/**
 * Lets what the steward started settle before an absence is asserted: every write committed, and the
 * turns after each, so the proof waits on the work itself, never on wall time (the milestone 5+6
 * review, I4). A step that is due commits its record and is sent within these rounds.
 */
export async function quiet(store: { settled(): Promise<void> }, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await store.settled();
    await new Promise((r) => setImmediate(r));
  }
}
