import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/core/store.js";
import { ApplierRefused } from "../src/link/port.js";
import type { Mutation } from "../src/mutations.js";
import { MAX_PLANS_PER_CREDENTIAL, PLAN_EXPIRY_MS, Steward } from "../src/steward.js";
import { lasting, memoryDb } from "./db.js";
import { complete, FakeApplier } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";
import { BASELINE, SECRETS, up } from "./house.js";

type Body = Record<string, any>;
type Db = Awaited<ReturnType<typeof memoryDb>>;

const LAMP = "sim-bridge:lamp";
const DIMMER = "sim-bridge:dimmer";
const describeOf = (devices: Body[], revision = 1) => ({ applier_id: "sim-applier", standard_version: "0.14", levels: ["Act"], ungoverned: [],
  revision, test_run_id: "r", devices: devices.map(complete) });
const DEVICES = [
  { id: "sim-bridge:channel", label: "channel", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] },
  { id: LAMP, label: "lamp", class: "light", capabilities: ["onoff"], adopted: true, personal: ["presence"],
    actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "reversible" }] },
  { id: DIMMER, label: "dimmer", class: "light", capabilities: ["onoff", "level"], adopted: true, actions: [{ action: "onoff.turn_on", tier: "confirm" },
    { action: "level.set_level", tier: "reversible" }] },
  { id: "sim-bridge:leak", label: "leak", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [] },
];
const STATE = { targets: {
  [LAMP]: { values: [{ key: "on", value: true, basis_time: "2030-01-01T07:59:00.000Z" }, { key: "presence", value: true, basis_time: "2030-01-01T07:59:00.000Z" }],
    liveness: "live", last_check_in: "2030-01-01T07:59:00.000Z", fresh_s: 60, fresh_basis: "declared", other_admins: [] },
  [DIMMER]: { values: [{ key: "on", value: false, basis_time: "2030-01-01T07:59:00.000Z" }], liveness: "live",
    last_check_in: "2030-01-01T07:59:00.000Z", fresh_s: 60, fresh_basis: "declared", other_admins: [] },
}, transports: [], latches: [] };

/** A steward over a fake applier's planner, its mirror read, and the baseline house with the lamp and dimmer in the hall. */
async function setup(o: { db?: Db; mutation?: Mutation; reach?: boolean; planWith?: (r: Body) => Promise<Body> } = {}) {
  const clock = new FakeClock();
  const db = o.db ?? lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; });
  const applier = new FakeApplier();
  // The dimmer's turn_on is confirm: planned without a token, the applier refuses it token, its last reason.
  applier.planner = (a) => (a.target === DIMMER && a.action === "onoff.turn_on" ? { verdict: "refuse", reason: "token", tier: "confirm" } : {});
  const port = applier.port();
  const steward = new Steward({ store, clock, stewardId: "demo-steward", ownerCredential: SECRETS.owner, runId: "r", mutation: o.mutation,
    applierPlan: (r) => (o.planWith ? o.planWith(r) : o.reach === false ? Promise.reject(new Error("the applier is out of reach")) : port.plan(r)) });
  await steward.start();
  steward.onDescribe(describeOf(DEVICES));
  steward.onState(STATE);
  const call = (secret: string, tool: string, args: Body = {}) => steward.call(steward.caller(secret), tool, args);
  const ok = async (secret: string, tool: string, args: Body = {}) => {
    const r = await call(secret, tool, args);
    if (!r.ok) throw new Error(`${tool}: ${r.error}: ${r.message}`);
    return r.body as Body;
  };
  const define = async (changes: unknown[]) => ok(SECRETS.owner, "define", { endpoint: "owner-app", changes,
    expected_revision: (await ok(SECRETS.owner, "describe")).revision, dry_run: false });
  await define([...BASELINE, up("target", { id: LAMP, room: "hall" }), up("target", { id: DIMMER, room: "hall" }),
    up("group", { id: "hall-lights", name: "Свет", room: "hall", members: [LAMP, DIMMER], aggregate: "any" })]);
  return { clock, db, store, applier, steward, call, ok, define };
}

const turnOn = (target: Body) => ({ ...target, action: "onoff.turn_on", args: {} });
const short = (s: Body) => `${s.target} ${s.verdict}${s.reason ? `(${s.reason})` : ""}`;

describe("plan", () => {
  it("resolves a request, plans it on the applier with the principal's via, brain and for, and gives the steward's plan", async () => {
    const { ok, applier, clock } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: "hall-lights" })] });
    expect(validate("steward/plan.response.json", plan)).toEqual([]);
    expect(plan).toMatchObject({ endpoint: "olga-app", client: "olga-app", expires_at: new Date(clock.now() + 300_000).toISOString(),
      request: { endpoint: "olga-app", actions: [turnOn({ target: "hall-lights" })] } });
    expect(plan.steps.map(short)).toEqual([`${DIMMER} ask(confirm_tier)`, `${LAMP} op`]);
    expect(plan.steps.map((s: Body) => s.step_id)).toEqual(["s1", "s2"]);
    expect(applier.plans.at(-1)!.actions).toEqual([DIMMER, LAMP].map((target) => ({ target, action: "onoff.turn_on", args: {},
      via: "app", brain: false, for: { person: "olga", endpoint: "olga-app" } })));
    // With no ask, a plan lives 60 s.
    const quick = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    expect(quick.expires_at).toBe(new Date(clock.now() + PLAN_EXPIRY_MS).toISOString());
  });

  it("keeps the request as the fields it read, nothing a caller added", async () => {
    const { ok } = await setup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })], respect_occupancy: false, note: "чужое" });
    expect(plan.request).toEqual({ endpoint: "olga-app", actions: [turnOn({ target: LAMP })], respect_occupancy: false });
  });

  it("names via and brain from the endpoint, a guest's for with no person, and a brain's speaker as its person", async () => {
    const { ok, applier } = await setup();
    await ok(SECRETS.panel, "plan", { endpoint: "hall-panel", actions: [turnOn({ target: LAMP })] });
    expect(applier.plans.at(-1)!.actions[0]).toMatchObject({ via: "panel", brain: false, for: { endpoint: "hall-panel" } });
    expect(applier.plans.at(-1)!.actions[0].for).not.toHaveProperty("person");
    const p = await ok(SECRETS.brain, "plan", { endpoint: "kitchen-voice", speaker: "olga", actions: [turnOn({ target: LAMP })] });
    expect(applier.plans.at(-1)!.actions[0]).toMatchObject({ via: "voice", brain: true, for: { person: "olga", endpoint: "kitchen-voice" } });
    expect(p.speaker).toBe("olga");
  });

  it("refuses an endpoint the credential is not bound to, and a speaker no brain names", async () => {
    const { call } = await setup();
    expect(await call(SECRETS.brain, "plan", { endpoint: "hall-panel", actions: [turnOn({ target: LAMP })] }))
      .toMatchObject({ ok: false, error: "not_permitted" });
    expect(await call(SECRETS.panel, "plan", { endpoint: "hall-panel", speaker: "owner", actions: [turnOn({ target: LAMP })] }))
      .toMatchObject({ ok: false, error: "invalid_request" });
    expect(await call(SECRETS.front, "plan", { endpoint: "kitchen-voice", actions: [turnOn({ target: LAMP })] }))
      .toMatchObject({ ok: false, error: "not_permitted" });
  });

  it("changes nothing: describe, state, events and the store are as they were, a plan with no ask (GA-STW-1)", async () => {
    const { ok, store } = await setup();
    const cursor = (await ok(SECRETS.owner, "events")).cursor;
    const before = [await ok(SECRETS.owner, "describe"), await ok(SECRETS.owner, "state")];
    await store.settled();
    const rows = async () => (await store.query<{ n: string | number }>("SELECT (SELECT count(*) FROM events) + (SELECT count(*) FROM plans) AS n")).rows[0]!.n;
    const kept = await rows();
    await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    expect([await ok(SECRETS.owner, "describe"), await ok(SECRETS.owner, "state")]).toEqual(before);
    expect((await ok(SECRETS.owner, "events", { cursor })).events).toEqual([]);
    await store.settled();
    expect(await rows()).toBe(kept);
  });

  it("keeps a plan with an ask for ask_expiry_s, commits it before answering, and emits its ask event (GA-STW-1, GA-CONF-5)", async () => {
    const { ok, store, clock } = await setup();
    // A time source's clock reads fractions of a millisecond.
    clock.advance(0.25);
    const cursor = (await ok(SECRETS.owner, "events")).cursor;
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: "hall-lights" })] });
    expect(plan.expires_at).toBe(new Date(clock.now() + 300_000).toISOString());
    // What slice 2b reads back at start: when the plan was made, and when each step was asked.
    const kept = await store.query<{ plan_id: string; made_ms: string | number; asked: Record<string, number> }>("SELECT plan_id, made_ms, asked FROM plans");
    const made = Math.floor(clock.now());
    expect(kept.rows.map((r) => [r.plan_id, Number(r.made_ms), r.asked])).toEqual([[plan.plan_id, made, { s1: made }]]);
    const events = (await ok(SECRETS.owner, "events", { cursor })).events;
    expect(events).toEqual([{ seq: expect.any(Number), time: new Date(clock.now()).toISOString(), type: "ask", plan_id: plan.plan_id,
      step_ids: ["s1"], endpoint: "olga-app" }]);
  });

  it("puts the question on the confirm_on that applies: the endpoint's, else its brain credential's", async () => {
    const { ok, define } = await setup();
    const asked = async () => {
      const cursor = (await ok(SECRETS.owner, "events")).cursor;
      await ok(SECRETS.brain, "plan", { endpoint: "kitchen-voice", speaker: "olga", actions: [turnOn({ target: DIMMER })] });
      return (await ok(SECRETS.owner, "events", { cursor })).events.map((e: Body) => e.endpoint);
    };
    expect(await asked()).toEqual(["kitchen-voice"]);
    await define([up("credential", { id: "brain", kind: "brain", secret: SECRETS.brain, confirm_on: "hall-panel" })]);
    expect(await asked()).toEqual(["hall-panel"]);
    await define([up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain",
      confirm_on: "olga-app" })]);
    expect(await asked()).toEqual(["olga-app"]);
  });

  it("emits no ask event under skips-the-ask-event", async () => {
    const { ok } = await setup({ mutation: "skips-the-ask-event" });
    const cursor = (await ok(SECRETS.owner, "events")).cursor;
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: DIMMER })] });
    expect(plan.steps.map(short)).toEqual([`${DIMMER} ask(confirm_tier)`]);
    expect((await ok(SECRETS.owner, "events", { cursor })).events).toEqual([]);
  });

  it("refuses a plan with an ask at once while the store is known down, and answers one without from memory", async () => {
    const { db, store, call } = await setup();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(call(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: DIMMER })] }))
      .rejects.toEqual(expect.objectContaining({ pending: false }));
    expect(await call(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] })).toMatchObject({ ok: true });
    db.trouble.down = false;
  });

  it("drops a plan with an ask whose commit outlasts 10 s, pending: false, and no ask event comes", async () => {
    const { db, store, clock, call, ok } = await setup();
    const cursor = (await ok(SECRETS.owner, "events")).cursor;
    await store.settled();
    db.trouble.down = true;
    const late = call(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: DIMMER })] });
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    clock.advance(10_000);
    await expect(late).rejects.toEqual(expect.objectContaining({ pending: false }));
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    await store.settled();
    expect((await store.query("SELECT plan_id FROM plans")).rows).toEqual([]);
    expect((await ok(SECRETS.owner, "events", { cursor })).events).toEqual([]);
  });

  it("judges by the mirror what it can while the applier is out of reach, in the order, and skips the rest dead", async () => {
    const { ok, steward } = await setup({ reach: false });
    steward.onDescribe(describeOf([...DEVICES, { id: "sim-bridge:stray", label: "stray", class: "light", capabilities: ["onoff"], adopted: false,
      actions: [{ action: "onoff.turn_on", tier: "reversible" }] }], 2));
    const level = (n: number) => ({ target: DIMMER, action: "level.set_level", args: { level: n } });
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP }), level(1), level(2),
      turnOn({ target: "sim-bridge:nothing" }), { target: LAMP, action: "level.set_level", args: { level: 1 } }, turnOn({ target: "sim-bridge:stray" })] });
    expect(plan.steps.map(short)).toEqual([`${LAMP} skip(dead)`, `${DIMMER} refuse(conflict)`, `${DIMMER} refuse(conflict)`,
      "sim-bridge:nothing skip(unknown_target)", `${LAMP} skip(unsupported_action)`, "sim-bridge:stray refuse(not_adopted)"]);
    expect(steward.applierFault).toBeUndefined();
  });

  it("shows an applier's refusal of its plan as a fault, judging the steps as while it is out of reach, and clears it on the next plan", async () => {
    let refuse = true;
    const applier = new FakeApplier();
    const { ok, steward } = await setup({ planWith: (r) => (refuse ? Promise.reject(new ApplierRefused("not_permitted", "who are you")) : applier.port().plan(r)) });
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    expect(plan.steps.map(short)).toEqual([`${LAMP} skip(dead)`]);
    expect(steward.applierFault).toBe("not_permitted");
    refuse = false;
    await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    expect(steward.applierFault).toBeUndefined();
  });

  it("says a failing applier plan once per kind, however its message varies, and masks any address in it", async () => {
    let n = 0;
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ok } = await setup({ planWith: () => Promise.reject(n++ < 2
      ? new ApplierRefused("invalid_request", `step ${n} at postgres://user:pw@db.example/demo`) : new Error(`connect refused ${n}`)) });
    for (let i = 0; i < 4; i++) await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    const lines = said.mock.calls.map(([line]) => String(line)).filter((l) => l.includes("did not plan"));
    said.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines.join()).not.toContain("pw@");
  });

  it("fails a plan whose applier plan leaves out a step, a bug, rather than call it dead", async () => {
    const applier = new FakeApplier();
    const { call } = await setup({ planWith: async (r) => ({ ...(await applier.port().plan(r)), steps: [] }) });
    await expect(call(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] }))
      .rejects.toThrow(/did not return the step/);
  });

  it("queues no store write for a plan never written: past the cap with the store down, the writer's line stays as it was", async () => {
    const { db, store, call } = await setup();
    await store.settled();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    const line = store.backlog;
    for (let i = 0; i < MAX_PLANS_PER_CREDENTIAL + 6; i++) {
      expect(await call(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] })).toMatchObject({ ok: true });
    }
    expect(store.backlog).toBe(line);
    db.trouble.down = false;
  });

  it("holds a credential's plans up to its cap, dropping its oldest, and forgets them once long expired", async () => {
    const { ok, steward, clock, store } = await setup();
    for (let i = 0; i <= MAX_PLANS_PER_CREDENTIAL; i++) await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: DIMMER })] });
    await ok(SECRETS.owner, "plan", { endpoint: "owner-app", actions: [turnOn({ target: DIMMER })] });
    expect(steward.heldPlans()).toBe(MAX_PLANS_PER_CREDENTIAL + 1);
    await store.settled();
    expect((await store.query("SELECT plan_id FROM plans")).rows).toHaveLength(MAX_PLANS_PER_CREDENTIAL + 1);
    // Held as long again as it lived, then pruned from memory and the store.
    clock.advance(2 * 300_000 + 60_000);
    await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: LAMP })] });
    expect(steward.heldPlans()).toBe(1);
    await store.settled();
    expect((await store.query("SELECT plan_id FROM plans")).rows).toEqual([]);
  });
});

describe("state", () => {
  it("gives the applier's state from the mirror, each group's on, and withholds every personal value until slice 8", async () => {
    const { ok, steward } = await setup();
    const s = await ok(SECRETS.owner, "state");
    expect(validate("steward/state.response.json", s)).toEqual([]);
    expect(s.targets[LAMP].values).toEqual([{ key: "on", value: true, basis_time: "2030-01-01T07:59:00.000Z" },
      { key: "presence", value: "withheld", basis_time: "2030-01-01T07:59:00.000Z" }]);
    expect(s.groups).toEqual({ "hall-lights": { on: true } });
    steward.onEvents([{ type: "state", target: LAMP, key: "on", value: false, basis_time: "2030-01-01T08:00:00.000Z" }]);
    expect((await ok(SECRETS.owner, "state", { targets: [LAMP, "hall-lights"] }))).toMatchObject({
      targets: { [LAMP]: { values: [{ key: "presence" }, { key: "on", value: false }] } }, groups: { "hall-lights": { on: false } } });
    expect(Object.keys((await ok(SECRETS.owner, "state", { targets: [DIMMER] })).targets)).toEqual([DIMMER]);
  });

  it("gives a group null while none of its onoff members has a reading, and counts a member with none as not on once one has", async () => {
    const { ok, steward, define } = await setup();
    await define([up("group", { id: "both", name: "Оба", room: null, members: [LAMP, DIMMER], aggregate: "all" })]);
    steward.onState({ targets: {}, transports: [], latches: [] });
    expect((await ok(SECRETS.owner, "state")).groups).toEqual({ both: { on: null }, "hall-lights": { on: null } });
    steward.onEvents([{ type: "state", target: LAMP, key: "on", value: true }]);
    expect((await ok(SECRETS.owner, "state")).groups).toEqual({ both: { on: false }, "hall-lights": { on: true } });
  });

  it("shows an internal device's state only to the owner's app", async () => {
    const { ok, steward } = await setup();
    steward.onDescribe(describeOf([...DEVICES, { id: "sim-bridge:entry", label: "entry", class: "socket", capabilities: ["onoff"], adopted: true,
      internal: true, actions: [] }], 2));
    steward.onState({ ...STATE, targets: { ...STATE.targets, "sim-bridge:entry": { values: [{ key: "on", value: true }], liveness: "live" } } });
    expect(Object.keys((await ok(SECRETS.owner, "state")).targets)).toContain("sim-bridge:entry");
    for (const secret of [SECRETS.olga, SECRETS.panel]) expect(Object.keys((await ok(secret, "state")).targets)).not.toContain("sim-bridge:entry");
    expect(Object.keys((await ok(SECRETS.olga, "state", { targets: ["sim-bridge:entry"] })).targets)).toEqual([]);
  });

  it("gives a group's on by its aggregate over its onoff members, and null with none (GA-GRP-1)", async () => {
    const { ok, define, steward } = await setup();
    // A sensor in an `all` group is not one of its onoff members: it never holds the group off.
    await define([up("group", { id: "both", name: "Оба", room: null, members: [LAMP, DIMMER, "sim-bridge:leak"], aggregate: "all" }),
      up("group", { id: "dry", name: "Датчик", room: null, members: ["sim-bridge:leak"], aggregate: "any" })]);
    const groups = async () => (await ok(SECRETS.owner, "state")).groups;
    expect(await groups()).toEqual({ both: { on: false }, dry: { on: null }, "hall-lights": { on: true } });
    steward.onEvents([{ type: "state", target: DIMMER, key: "on", value: true }]);
    expect(await groups()).toEqual({ both: { on: true }, dry: { on: null }, "hall-lights": { on: true } });
    steward.onEvents([{ type: "state", target: LAMP, key: "on", value: false }, { type: "state", target: DIMMER, key: "on", value: false }]);
    expect(await groups()).toEqual({ both: { on: false }, dry: { on: null }, "hall-lights": { on: false } });
  });
});

describe("events", () => {
  it("gives the current cursor with no events, then what came after a cursor, waking a long poll on the next one", async () => {
    const { ok, clock } = await setup();
    const first = await ok(SECRETS.olga, "events");
    expect(first.events).toEqual([]);
    const waiting = ok(SECRETS.olga, "events", { cursor: first.cursor, wait_s: 30 });
    await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn({ target: DIMMER })] });
    const woke = await waiting;
    expect(woke.events.map((e: Body) => e.type)).toEqual(["ask"]);
    expect(woke.cursor).toBe(String(woke.events[0].seq));
    const idle = ok(SECRETS.olga, "events", { cursor: woke.cursor, wait_s: 5 });
    clock.advance(5000);
    expect(await idle).toEqual({ events: [], cursor: woke.cursor });
  });
});
