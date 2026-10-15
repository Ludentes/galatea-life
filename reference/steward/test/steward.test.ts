import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it, vi } from "vitest";
import { StoreUnavailable } from "../src/core/errors.js";
import { SEQ_LIFE_GAP } from "../src/core/events.js";
import { HOLD_DEFAULTS } from "../src/house/model.js";
import { GATE_MS, Store } from "../src/core/store.js";
import type { Mutation } from "../src/mutations.js";
import { OWNERS_CAP, Steward, STANDARD_VERSION } from "../src/steward.js";
import { lasting, memoryDb } from "./db.js";
import { complete } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";
import { BASELINE, SECRETS, up } from "./house.js";

type Db = Awaited<ReturnType<typeof memoryDb>>;

/** A light as `applier/device.json` requires it, from the fields a test names. */
const light = (d: Record<string, unknown>) => complete({ class: "light", capabilities: ["onoff"], ...d, actions: [{ action: "onoff.turn_on", tier: "reversible" }] });
const APPLIER = { applier_id: "sim-applier", standard_version: "0.14", levels: ["Act"], ungoverned: [], revision: 1, test_run_id: "r",
  devices: [{ id: "sim-bridge:channel", label: "channel", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] },
    { id: "sim-bridge:lamp", label: "lamp", class: "light", capabilities: ["onoff"], adopted: true, actions: [{ action: "onoff.turn_on", tier: "reversible" }] }].map(complete) };

/**
 * `db`, whose commits can be held as a store that stalls without failing: the writer does not know
 * it down, so a write waits rather than being refused.
 */
function stalling(db: Db) {
  let gate: Promise<void> | undefined;
  let open = () => undefined as void;
  return {
    db: { ...db, transaction: async <T>(fn: Parameters<Db["transaction"]>[0]) => { if (gate) await gate; return db.transaction(fn) as Promise<T>; } } as Db,
    stall() { gate = new Promise((r) => { open = r; }); },
    release() { gate = undefined; open(); },
  };
}

async function open(o: { db?: Db; clock?: FakeClock; owner?: string | null; mutation?: Mutation; runId?: string } = {}) {
  const clock = o.clock ?? new FakeClock();
  const db = o.db ?? lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; });
  // What the clock was told, in order: a source, or null for the start-up source; and the sources checked.
  const retargeted: (string | null)[] = [];
  const checked: string[] = [];
  const steward = new Steward({ store, clock, stewardId: "demo-steward", ownerCredential: o.owner === null ? undefined : o.owner ?? SECRETS.owner,
    runId: o.runId ?? "r", mutation: o.mutation, retarget: async (s) => { retargeted.push(s); },
    checkTimeSource: async (s) => { checked.push(s); if (s.endsWith(":0")) throw new Error(`no answer from the time source ${s}`); } });
  await steward.start();
  const as = (secret: string) => steward.caller(secret);
  const call = (secret: string, tool: string, args: Record<string, unknown> = {}) => steward.call(as(secret), tool, args);
  const ok = async (secret: string, tool: string, args: Record<string, unknown> = {}) => {
    const r = await call(secret, tool, args);
    if (!r.ok) throw new Error(`${tool}: ${r.error}: ${r.message}`);
    return r.body as Record<string, any>;
  };
  const define = async (changes: unknown[], o2: { secret?: string; endpoint?: string; dry_run?: boolean; expected_revision?: number } = {}) =>
    call(o2.secret ?? SECRETS.owner, "define", { endpoint: o2.endpoint ?? "owner-app", changes,
      expected_revision: o2.expected_revision ?? (await ok(SECRETS.owner, "describe")).revision, dry_run: o2.dry_run ?? false });
  return { clock, db, store, steward, call, ok, define, retargeted, checked };
}

/** A steward whose mirror has the applier's devices, and the baseline house. */
async function withBaseline(o: Parameters<typeof open>[0] = {}) {
  const s = await open(o);
  s.steward.onDescribe(APPLIER);
  const r = await s.define(BASELINE);
  if (!r.ok) throw new Error(r.message);
  return s;
}

describe("Steward", () => {
  it("makes the first owner on a store with no person, and ignores the variable once a person exists (Q2)", async () => {
    const db = lasting(await memoryDb());
    const first = await open({ db });
    const d = await first.ok(SECRETS.owner, "describe");
    expect(d.persons).toEqual([{ id: "owner", name: "Owner", role: "owner" }]);
    expect(d.endpoints).toEqual([{ id: "owner-app", name: "Owner's app", type: "app", room: null, person: "owner", max_role: "owner",
      served_by: null, confirm_on: "same", voice: null }]);
    await first.store.close();
    const again = await open({ db, owner: "another-owner-secret-0123" });
    expect((await again.call("another-owner-secret-0123", "describe")).ok).toBe(false);
    expect((await again.ok(SECRETS.owner, "describe")).persons).toHaveLength(1);
  });

  it("says standard 0.13, and shows the hold policy in force after a define (GA-LEASE-8)", async () => {
    const { ok, define } = await withBaseline();
    expect(STANDARD_VERSION).toBe("0.13");
    expect((await define([up("home", { hold: { off_s: 20 } })])).ok).toBe(true);
    const owner = await ok(SECRETS.owner, "describe");
    expect(owner.home.hold).toEqual({ ...HOLD_DEFAULTS, off_s: 20 });
    expect(owner.standard_version).toBe("0.13");
    expect(validate("steward/describe.response.json", owner)).toEqual([]);
    expect(validate("steward/describe.response.json", await ok(SECRETS.front, "describe"))).toEqual([]);
  });

  it("answers a refused hold flag with data.field on the wire (GA-LEASE-8)", async () => {
    const { define } = await withBaseline();
    expect(await define([up("home", { hold: { schedule_ends: true } })]))
      .toMatchObject({ ok: false, error: "invalid_request", message: expect.stringContaining("hold.schedule_ends"), data: { field: "schedule_ends" } });
  });

  it("makes no first owner from a credential shorter than define allows, and says so once", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const weak = await open({ owner: "short-secret" });
      expect((await weak.call("short-secret", "describe")).ok).toBe(false);
      expect(said.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("GALATEA_OWNER_CREDENTIAL"))).toHaveLength(1);
      expect(said.mock.calls.join(" ")).not.toContain("short-secret");
    } finally {
      said.mockRestore();
    }
  });

  it("describes itself, the applier's devices and the house, persons by id, name and role, and never a credential", async () => {
    const { ok } = await withBaseline();
    const d = await ok(SECRETS.owner, "describe");
    expect(d).toMatchObject({ steward_id: "demo-steward", standard_version: STANDARD_VERSION, test_run_id: "r", modes: ["single"],
      applier: { applier_id: "sim-applier", levels: ["Act"], ungoverned: [] }, groups: [], scenarios: [], rules: [], schedules: [] });
    expect(d.targets.map((t: { id: string }) => t.id)).toEqual(["sim-bridge:channel", "sim-bridge:lamp"]);
    expect(d.targets[0]).toMatchObject({ name: "channel", aliases: [], room: null, adopted: true });
    expect(d.home).toMatchObject({ timezone: "Europe/Moscow", notice_channels: ["sim-bridge:channel"], hold: HOLD_DEFAULTS });
    expect(d.persons.map((p: { id: string }) => p.id).sort()).toEqual(["liza", "olga", "owner"]);
    expect(JSON.stringify(d)).not.toMatch(/secret/);
    expect(d.endpoints.find((e: { id: string }) => e.id === "hall-panel")).toMatchObject({ max_role: "guest", confirm_on: "same" });
  });

  it("gives every list in code-point order of ids, the applier's targets too", async () => {
    const { ok, steward } = await withBaseline();
    steward.onDescribe({ ...APPLIER, revision: 2, devices: [...APPLIER.devices].reverse() });
    const d = await ok(SECRETS.owner, "describe");
    for (const list of ["targets", "rooms", "endpoints", "persons"]) {
      const ids = d[list].map((x: { id: string }) => x.id);
      expect(ids, list).toEqual([...ids].sort());
    }
    expect(d.targets.map((t: { id: string }) => t.id)).toEqual(["sim-bridge:channel", "sim-bridge:lamp"]);
  });

  it("shows each target with the steward's overlay, the groups, and an internal device to the owner's app only", async () => {
    const s = await withBaseline();
    s.steward.onDescribe({ ...APPLIER, revision: 2, devices: [...APPLIER.devices,
      light({ id: "sim-bridge:dimmer", label: "dimmer", adopted: true, actions: [{ action: "onoff.turn_on" }] }),
      light({ id: "sim-bridge:entry", label: "entry", adopted: true, internal: true, actions: [{ action: "onoff.turn_on" }] })] });
    expect((await s.define([up("target", { id: "sim-bridge:lamp", name: "Лампа", aliases: ["свет"], room: "hall" }),
      up("group", { id: "hall-lights", name: "Свет", room: "hall", members: ["sim-bridge:lamp", "sim-bridge:dimmer"], aggregate: "all" })])).ok)
      .toBe(true);
    const d = await s.ok(SECRETS.owner, "describe");
    const target = (id: string) => d.targets.find((t: { id: string }) => t.id === id);
    expect(target("sim-bridge:lamp")).toMatchObject({ label: "lamp", name: "Лампа", aliases: ["свет"], room: "hall", adopted: true });
    expect(target("sim-bridge:dimmer")).toMatchObject({ name: "dimmer", aliases: [], room: null });
    expect(d.groups).toEqual([{ id: "hall-lights", name: "Свет", aliases: [], room: "hall", members: ["sim-bridge:dimmer", "sim-bridge:lamp"],
      aggregate: "all" }]);
    expect(target("sim-bridge:entry")).toMatchObject({ internal: true });
    // Never shown to people but the owner at their app (steward, *Requests and selectors*).
    for (const secret of [SECRETS.olga, SECRETS.panel, SECRETS.brain]) {
      expect((await s.ok(secret, "describe")).targets.map((t: { id: string }) => t.id)).toEqual(["sim-bridge:channel", "sim-bridge:dimmer", "sim-bridge:lamp"]);
    }
  });

  it("leaves a device marked internal after it was grouped out of a group's members, but for the owner's app", async () => {
    const s = await withBaseline();
    const entry = light({ id: "sim-bridge:entry", label: "entry", adopted: true, actions: [{ action: "onoff.turn_on" }] });
    s.steward.onDescribe({ ...APPLIER, revision: 2, devices: [...APPLIER.devices, entry] });
    expect((await s.define([up("group", { id: "g", name: "Г", room: null, members: ["sim-bridge:entry", "sim-bridge:lamp"], aggregate: "any" })])).ok)
      .toBe(true);
    s.steward.onDescribe({ ...APPLIER, revision: 3, devices: [...APPLIER.devices, { ...entry, internal: true }] });
    expect((await s.ok(SECRETS.owner, "describe")).groups[0].members).toEqual(["sim-bridge:entry", "sim-bridge:lamp"]);
    for (const secret of [SECRETS.olga, SECRETS.panel, SECRETS.brain]) {
      expect((await s.ok(secret, "describe")).groups[0].members).toEqual(["sim-bridge:lamp"]);
    }
  });

  it("lets a device the applier brings later win over a group of its id: the group is flagged in describe, and said once in the log", async () => {
    const s = await withBaseline();
    expect((await s.define([up("group", { id: "hall", name: "Холл", room: null, members: ["sim-bridge:lamp"], aggregate: "any" })])).ok).toBe(true);
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hall = light({ id: "hall", label: "hall", adopted: true, actions: [{ action: "onoff.turn_on" }] });
    s.steward.onDescribe({ ...APPLIER, revision: 2, devices: [...APPLIER.devices, hall] });
    s.steward.onDescribe({ ...APPLIER, revision: 3, devices: [...APPLIER.devices, hall] });
    expect((await s.ok(SECRETS.owner, "describe")).groups).toEqual([expect.objectContaining({ id: "hall", shadowed: true })]);
    expect(said.mock.calls.filter(([line]) => String(line).includes("group hall"))).toHaveLength(1);
    // Once the device is gone, the group is the group again.
    s.steward.onDescribe({ ...APPLIER, revision: 4 });
    expect((await s.ok(SECRETS.owner, "describe")).groups[0]).not.toHaveProperty("shadowed");
    said.mockRestore();
  });

  it("refuses a stranger, lists what is not built, and keeps a front to its own five operations (GA-AUTH-4, GA-AUTH-8)", async () => {
    const { call, ok } = await withBaseline();
    expect(await call("nobody-has-this-secret", "describe")).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await call(SECRETS.owner, "zone_sources", {})).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await call(SECRETS.owner, "narrow", { endpoint: "owner-app" })).toMatchObject({ ok: false, error: "invalid_request", message: expect.stringContaining("not built yet") });
    expect(await call(SECRETS.owner, "front_status", {})).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await call(SECRETS.front, "define", {})).toMatchObject({ ok: false, error: "not_permitted" });
    const d = await ok(SECRETS.front, "describe");
    expect(d.targets).toEqual([]);
    expect(d.endpoints.map((e: { id: string }) => e.id)).toEqual(["kitchen-voice"]);
    expect(d.persons).toEqual([{ id: "liza" }, { id: "olga" }, { id: "owner" }]);
    expect(Object.keys(d.home).sort()).toEqual(["audio_retention_s", "other_wake_words"]);
  });

  it("commits an owner's change set, moves the revision once, and records a define event", async () => {
    const { ok, define, store } = await withBaseline();
    const before = (await ok(SECRETS.owner, "describe")).revision;
    const r = await define([up("room", { id: "attic", name: "Чердак" })]);
    expect(r).toEqual({ ok: true, body: { revision: before + 1 } });
    expect((await ok(SECRETS.owner, "describe")).rooms.map((x: { id: string }) => x.id)).toContain("attic");
    // The same again changes nothing, and moves nothing.
    expect(await define([up("room", { id: "attic", name: "Чердак" })])).toEqual({ ok: true, body: { revision: before + 1 } });
    await store.settled();
    const events = (await store.query<{ type: string; body: unknown }>("SELECT type, body FROM events WHERE type = 'define' ORDER BY seq")).rows;
    expect(events.at(-1)?.body).toEqual({ revision: before + 1, endpoint: "owner-app", person: "owner", diff: ["+ room attic: name \"Чердак\""] });
    // The change that changed nothing is no event.
    expect(events.filter((e) => (e.body as { revision: number }).revision === before + 1)).toHaveLength(1);
  });

  it("keeps an owner's rule in the house, lists it in describe, and reads it back after a restart", async () => {
    const db = lasting(await memoryDb());
    const { ok, define, steward, store } = await withBaseline({ db });
    const rule = { id: "night", name: "Ночник", conditions: [{ between: { from: "23:00", until: "06:00" } }],
      actions: [{ target: "sim-bridge:lamp", action: "onoff.turn_on", args: {} }] };
    expect((await define([up("rule", rule)])).ok).toBe(true);
    expect((await ok(SECRETS.owner, "describe")).rules).toEqual([{ ...rule, active: true, exceptions: [], passes_holds: false }]);
    await store.settled();
    steward.stop();
    const again = await open({ db });
    expect((await again.ok(SECRETS.owner, "describe")).rules).toEqual([{ ...rule, active: true, exceptions: [], passes_holds: false }]);
  });

  it("returns a dry run's diff and changes nothing (GA-DEF-1)", async () => {
    const { ok, define } = await withBaseline();
    const before = await ok(SECRETS.owner, "describe");
    const r = await define([up("room", { id: "attic", name: "Чердак" })], { dry_run: true });
    expect(r).toEqual({ ok: true, body: { diff: "+ room attic: name \"Чердак\"" } });
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
  });

  it("refuses a stale expected_revision with stale_revision, changing nothing (GA-DEF-2)", async () => {
    const { ok, define } = await withBaseline();
    const before = await ok(SECRETS.owner, "describe");
    expect(await define([up("room", { id: "attic", name: "Чердак" })], { expected_revision: before.revision - 1 }))
      .toMatchObject({ ok: false, error: "stale_revision" });
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
  });

  it("takes define only from an owner at an endpoint no brain serves (GA-DEF-3)", async () => {
    const { define, steward } = await withBaseline();
    const room = [up("room", { id: "attic", name: "Чердак" })];
    expect(await define(room, { secret: SECRETS.olga, endpoint: "olga-app" })).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await define(room, { secret: SECRETS.panel, endpoint: "hall-panel" })).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await steward.call(steward.caller(SECRETS.brain), "define", { endpoint: "kitchen-voice", speaker: "owner", changes: room,
      expected_revision: 0, dry_run: false })).toMatchObject({ ok: false, error: "not_permitted" });
    // An owner at an endpoint not bound to the credential.
    expect(await define(room, { secret: SECRETS.olga, endpoint: "owner-app" })).toMatchObject({ ok: false, error: "not_permitted" });
    // The owner's own app, once a brain serves it, is the brain's way in too: a change set from it is
    // asked first, as one through a brain (GA-DEF-6), and one the policy never takes is not_permitted.
    expect((await define([up("endpoint", { id: "owner-app", name: "o", type: "app", room: null, person: "owner", served_by: "brain" })])).ok).toBe(true);
    expect(await define(room)).toMatchObject({ ok: true, body: { steps: [{ verdict: "ask", reason: "confirm_define" }] } });
    expect(await define([up("person", { id: "liza", name: "Лиза", role: "guest" })]))
      .toMatchObject({ ok: false, error: "not_permitted", message: expect.stringContaining("through a brain") });
  });

  it("refuses a change set whole (GA-DEF-5), and a plan_id it holds no plan for", async () => {
    const { ok, define, call } = await withBaseline();
    const before = await ok(SECRETS.owner, "describe");
    expect(await define([up("room", { id: "attic", name: "Чердак" }),
      up("endpoint", { id: "attic-panel", name: "p", type: "panel", room: "nowhere", person: null, served_by: null })]))
      .toMatchObject({ ok: false, error: "invalid_request" });
    expect(await ok(SECRETS.owner, "describe")).toEqual(before);
    expect(await call(SECRETS.owner, "define", { endpoint: "owner-app", plan_id: "p1" })).toMatchObject({ ok: false, error: "unknown_plan" });
  });

  it("moves the revision on the applier's model, never on its state, and wakes a describe waiting on it (GA-HOUSE-1)", async () => {
    const { ok, steward, clock } = await withBaseline();
    const r = (await ok(SECRETS.owner, "describe")).revision;
    steward.onState({ targets: { "sim-bridge:lamp": { values: [{ key: "on", value: true }], liveness: "live" } } });
    steward.onEvents([{ type: "state", target: "sim-bridge:lamp", key: "on", value: false }]);
    steward.onDescribe(APPLIER);
    expect((await ok(SECRETS.owner, "describe")).revision).toBe(r);
    const waiting = ok(SECRETS.owner, "describe", { since_revision: r, wait_s: 30 });
    steward.onDescribe({ ...APPLIER, revision: 2 });
    expect((await waiting).revision).toBe(r + 1);
    // With nothing new, it answers after wait_s on the clock, at the same revision.
    const idle = ok(SECRETS.owner, "describe", { since_revision: r + 1, wait_s: 5 });
    clock.advance(5000);
    expect((await idle).revision).toBe(r + 1);
  });

  it("takes time_source only while the applier reports a test_run_id, and only a source that answers (GA-HARN-2)", async () => {
    const s = await open();
    s.steward.onDescribe({ ...APPLIER, test_run_id: undefined });
    expect(await s.define([up("home", { notice_channels: ["sim-bridge:channel"], time_source: "127.0.0.1:9" })]))
      .toMatchObject({ ok: false, error: "invalid_request", message: expect.stringContaining("GA-HARN-2") });
    s.steward.onDescribe({ ...APPLIER, revision: 2 });
    const before = await s.ok(SECRETS.owner, "describe");
    expect(await s.define([up("home", { notice_channels: ["sim-bridge:channel"], time_source: "127.0.0.1:0" })]))
      .toMatchObject({ ok: false, error: "invalid_request", message: expect.stringContaining("no answer") });
    expect(await s.ok(SECRETS.owner, "describe")).toEqual(before);
    expect(s.retargeted).toEqual([]);
    expect((await s.define([up("home", { notice_channels: ["sim-bridge:channel"], time_source: "127.0.0.1:9" })])).ok).toBe(true);
    expect(s.retargeted).toEqual(["127.0.0.1:9"]);
  });

  it("retargets the clock only once the change commits, and back to the start-up clock when time_source is cleared (GA-HARN-2)", async () => {
    const db = stalling(lasting(await memoryDb()));
    const s = await withBaseline({ db: db.db });
    db.stall();
    const r = (await s.ok(SECRETS.owner, "describe")).revision;
    const set = s.define([up("home", { time_source: "127.0.0.1:9" })], { expected_revision: r });
    await vi.waitFor(() => expect(s.checked).toEqual(["127.0.0.1:9"]));
    // Checked, not yet committed: the clock has not moved.
    expect(s.retargeted).toEqual([]);
    db.release();
    expect(await set).toEqual({ ok: true, body: { revision: r + 1 } });
    expect(s.retargeted).toEqual(["127.0.0.1:9"]);
    expect((await s.define([up("home", { time_source: null })])).ok).toBe(true);
    expect(s.retargeted).toEqual(["127.0.0.1:9", null]);
    expect((await s.ok(SECRETS.owner, "describe")).home).not.toHaveProperty("time_source");
    // Clearing what is not set changes nothing, and the clock is not told again.
    expect(await s.define([up("home", { time_source: null })])).toEqual({ ok: true, body: { revision: r + 2 } });
    expect(s.retargeted).toEqual(["127.0.0.1:9", null]);
  });

  it("refuses define at once while the store is known down, and nothing waits for it (Q6)", async () => {
    const { db, store, define, ok } = await withBaseline();
    db.trouble.down = true;
    void store.write(async () => undefined);
    await vi.waitFor(() => expect(store.down).toBe(true));
    await expect(define([up("room", { id: "attic", name: "Чердак" })], { expected_revision: 99 }))
      .rejects.toEqual(expect.objectContaining({ pending: false }));
    // describe answers from memory meanwhile.
    expect((await ok(SECRETS.owner, "describe")).rooms).toHaveLength(2);
    db.trouble.down = false;
  });

  it("answers a commit that takes longer than 10 s pending, and the change lands when the store returns", async () => {
    const { db, store, clock, define, ok } = await withBaseline();
    const r = (await ok(SECRETS.owner, "describe")).revision;
    db.trouble.down = true;
    const late = define([up("room", { id: "attic", name: "Чердак" })], { expected_revision: r });
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    clock.advance(GATE_MS);
    await expect(late).rejects.toEqual(expect.objectContaining({ pending: true }));
    await expect(late).rejects.toBeInstanceOf(StoreUnavailable);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(store.backlog).toBe(0); });
    await vi.waitFor(async () => expect((await ok(SECRETS.owner, "describe")).rooms.map((x: { id: string }) => x.id)).toContain("attic"));
  });

  it("applies a define held in the owners' line past its 10 s answer when its turn comes, and judges its revision then (I1)", async () => {
    const db = stalling(lasting(await memoryDb()));
    const { store, clock, steward, ok } = await withBaseline({ db: db.db });
    const r = (await ok(SECRETS.owner, "describe")).revision;
    const define = (room: string, expected_revision: number) => steward.call(steward.caller(SECRETS.owner), "define",
      { endpoint: "owner-app", changes: [up("room", { id: room, name: room })], expected_revision, dry_run: false });
    db.stall();
    const first = define("attic", r);
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    // Behind it: one made at the revision the first will leave, and one made at the revision before it.
    const second = define("cellar", r + 1);
    const stale = define("garage", r);
    clock.advance(GATE_MS);
    for (const p of [first, second, stale]) {
      await expect(p).rejects.toBeInstanceOf(StoreUnavailable);
      await expect(p).rejects.toEqual(expect.objectContaining({ pending: true, message: expect.stringContaining("its turn") }));
    }
    db.release();
    await vi.waitFor(async () => expect((await ok(SECRETS.owner, "describe")).revision).toBe(r + 2));
    await store.settled();
    const rooms = (await ok(SECRETS.owner, "describe")).rooms.map((x: { id: string }) => x.id);
    expect(rooms).toEqual(expect.arrayContaining(["attic", "cellar"]));
    // The stale one was judged at its turn: stale_revision, and nothing of it took effect.
    expect(rooms).not.toContain("garage");
  });

  it("refuses at once a define past the owners' line's cap, pending: false", async () => {
    const db = stalling(lasting(await memoryDb()));
    const { store, steward, ok } = await withBaseline({ db: db.db });
    const r = (await ok(SECRETS.owner, "describe")).revision;
    const define = (i: number) => steward.call(steward.caller(SECRETS.owner), "define",
      { endpoint: "owner-app", changes: [up("room", { id: `room-${i}`, name: "r" })], expected_revision: r + i, dry_run: false });
    db.stall();
    const held = Array.from({ length: OWNERS_CAP }, (_, i) => define(i));
    await vi.waitFor(() => expect(store.backlog).toBeGreaterThan(0));
    await expect(define(OWNERS_CAP)).rejects.toEqual(expect.objectContaining({ pending: false, message: expect.stringContaining("full") }));
    db.release();
    expect((await Promise.all(held)).every((x) => x.ok)).toBe(true);
    expect((await ok(SECRETS.owner, "describe")).revision).toBe(r + OWNERS_CAP);
  });

  it("keeps the house and its revision across a restart, and moves past an unclean stop's", async () => {
    const db = lasting(await memoryDb());
    const a = await withBaseline({ db });
    const r = (await a.ok(SECRETS.owner, "describe")).revision;
    await a.store.close();
    const b = await open({ db });
    expect((await b.ok(SECRETS.owner, "describe")).revision).toBe(r);
    expect((await b.ok(SECRETS.olga, "describe")).rooms).toHaveLength(2);
    // Not closed: the next life cannot know what this one served.
    await b.store.settled();
    const c = await open({ db });
    expect((await c.ok(SECRETS.owner, "describe")).revision).toBe(r + SEQ_LIFE_GAP);
  });
});
