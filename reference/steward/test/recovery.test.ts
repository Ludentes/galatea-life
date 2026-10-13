import { describe, expect, it, vi } from "vitest";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, DIMMER, eventsSince, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const HOLD_MS = 3_600_000;
const VALVE = "sim-bridge:valve";
const iso = (ms: number) => new Date(ms).toISOString();
const live = (on: boolean) => ({ targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: on }] },
  [DIMMER]: { liveness: "live", values: [{ key: "level", value: 0 }] } }, transports: [], latches: [] });
/** A level rule: the lamp on sets the dimmer's level. */
const LAMP_RULE = up("rule", { id: "lamp", name: "Лампа", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
  actions: [{ target: DIMMER, action: "level.set_level", args: { level: 30 } }] });
const firings = (s: { applier: { applies: Body[] } }) => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("rule:lamp:")).length;

/** A steward following the fake applier, the lamp on and the lamp rule fired once on it. */
async function following(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ state: live(false), ...o });
  await s.define([LAMP_RULE]);
  s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(s.clock.now()), cause: "device" });
  await s.pump();
  await vi.waitFor(() => expect(firings(s)).toBe(1));
  return s;
}

/** What a sync after a gap hands the steward: the applier's history, its state, its cursor. */
async function gapEnds(s: Awaited<ReturnType<typeof setup>>, state: Body): Promise<void> {
  const missed = (await s.port.history({ from: iso(0), to: iso(s.clock.now()) })).events;
  s.steward.recover(missed, state, String(missed.at(-1)?.seq ?? 0));
  await quiet(s.store);
}

describe("recovery after a gap (the design, *Recovery*)", () => {
  it("fires a level rule again once its condition went false and true inside the gap, and only then (GA-RULE-1)", async () => {
    const s = await following();
    s.applier.emit({ type: "state", target: DIMMER, key: "level", value: 30, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s, live(true));
    expect(firings(s)).toBe(1);
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "device" });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s, live(true));
    await vi.waitFor(() => expect(firings(s)).toBe(2));
  });

  it("records each missed event once, marked recovered, with its cause and the applier's time; acts on none", async () => {
    const s = await following();
    const c = (await s.ok(SECRETS.owner, "events")).cursor;
    const at = s.clock.now() - 60_000;
    s.applier.emit({ type: "state", target: DIMMER, key: "level", value: 30, time: iso(at), cause: "device" });
    s.applier.emit({ type: "liveness", target: DIMMER, old: "live", new: "stale", time: iso(at) });
    await gapEnds(s, live(true));
    await gapEnds(s, live(true));
    const got = (await eventsSince(s.ok, c)).filter((e) => e.recovered);
    expect(got.map((e) => `${e.type} ${e.applier_seq} ${e.applier_time}`)).toEqual([`state 3 ${iso(at)}`, `liveness 4 ${iso(at)}`]);
    expect(got[0].cause).toBe("device");
    const h = (await s.ok(SECRETS.owner, "history", { from: iso(0), to: iso(s.clock.now()) })).events as Body[];
    expect(h.filter((e) => e.recovered).map((e) => e.type)).toEqual(["state", "liveness"]);
  });

  it("leases a missed external or load_cap change for what is left of its hold, none past it, never over a later lease (GA-LEASE-2)", async () => {
    const s = await following();
    // The gap's changes come after the steward's last live reading, which no gap event counts before (GA-LEASE-7).
    s.clock.jump(2 * HOLD_MS);
    const now = s.clock.now();
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(now - HOLD_MS - 1_000), cause: "external" });
    s.applier.emit({ type: "state", target: DIMMER, key: "level", value: 10, time: iso(now - 1_800_000), cause: "load_cap" });
    await gapEnds(s, live(false));
    const leases = (await s.ok(SECRETS.owner, "state")).leases as Body;
    expect(leases).toEqual({ [DIMMER]: { holder: "load_cap", precedence: "person", expires: iso(now - 1_800_000 + HOLD_MS) } });
    // A person's apply after the missed change: its lease stands.
    await s.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] },
      idempotency_key: "after-the-change" });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(now - 60_000), cause: "external" });
    await gapEnds(s, live(false));
    expect(((await s.ok(SECRETS.owner, "state")).leases as Body)[LAMP]).toMatchObject({ holder: { person: "olga" } });
  });

  it("grants a missed safety rule's lease, ends one whose rule completed in the gap, and reads the latches state lists (GA-LEASE-6)", async () => {
    const devices = [...DEVICES, { id: VALVE, label: "valve", class: "water_valve", capabilities: ["valve"], adopted: true,
      actions: [{ action: "valve.close", tier: "reversible" }] }];
    const s = await following({ devices });
    s.steward.onDescribe({ ...describeOf(devices, 2), safety_rules: [{ id: "night", actions: [{ target: LAMP }] },
      { id: "leak", actions: [{ target: VALVE }], latch: { condition: {} } }] });
    const at = iso(s.clock.now());
    s.applier.emit({ type: "outcome", rule_id: "night", step_id: "s1", target: LAMP, outcome: "acked", time: at });
    s.applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, devices: [LAMP], time: at });
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "set", devices: [VALVE], time: at });
    await gapEnds(s, { ...live(true), latches: [{ rule_id: "leak", devices: [VALVE], since: at }] });
    expect(Object.keys((await s.ok(SECRETS.owner, "state")).leases as Body)).toEqual([VALVE]);
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "cleared", devices: [VALVE], time: at });
    // The clearing missed, and state lists no latch: the lease ends either way.
    await gapEnds(s, live(true));
    expect((await s.ok(SECRETS.owner, "state")).leases).toEqual({});
  });

  it("ends a latchless rule's lease on its completion relayed after the grant, by the applier's order, never by its time (GA-LEASE-6; the code review, CR3)", async () => {
    const s = await following();
    s.steward.onDescribe({ ...describeOf(DEVICES, 2), safety_rules: [{ id: "night", actions: [{ target: LAMP }] }] });
    // A completion before the grant ends nothing granted after it.
    s.applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, devices: [LAMP], time: iso(s.clock.now()) });
    await s.pump();
    s.clock.advance(1_000);
    s.applier.emit({ type: "outcome", rule_id: "night", step_id: "s1", target: LAMP, outcome: "acked", time: iso(s.clock.now()) });
    await s.pump();
    expect(Object.keys((await s.ok(SECRETS.owner, "state")).leases as Body)).toEqual([LAMP]);
    // The applier's clock a minute behind: its completion, read from history after the grant, still ends it.
    s.applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, devices: [LAMP], time: iso(s.clock.now() - 60_000) });
    await gapEnds(s, live(true));
    expect((await s.ok(SECRETS.owner, "state")).leases).toEqual({});
  });

  it("takes nothing from another applier's history", async () => {
    const s = await following();
    const c = (await s.ok(SECRETS.owner, "events")).cursor;
    s.steward.onDescribe(describeOf(DEVICES, 1, "another-applier"));
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "external" });
    await gapEnds(s, live(false));
    expect((await eventsSince(s.ok, c)).filter((e) => e.recovered)).toEqual([]);
    expect((await s.ok(SECRETS.owner, "state")).leases).toEqual({});
  });

  it("past its cap records the newest, and counts a level rule reading a device the dropped ones named as become false", async () => {
    const said: string[] = [];
    const s = await following({ options: { recoveryCap: 2, logger: (l: string) => said.push(l) } });
    const c = (await s.ok(SECRETS.owner, "events")).cursor;
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(s.clock.now()), cause: "device" });
    for (let i = 0; i < 2; i++) s.applier.emit({ type: "state", target: DIMMER, key: "level", value: i, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s, live(true));
    expect((await eventsSince(s.ok, c)).filter((e) => e.recovered).map((e) => e.applier_seq)).toEqual([4, 5]);
    expect(said).toContain("a gap held more than 2 of the applier's events: the oldest were not recorded");
    await vi.waitFor(() => expect(firings(s)).toBe(2));
  });

  it("at a restart, reads the gap from the last event the store kept: a rule whose condition went false and true while down fires once", async () => {
    const a = await following();
    await a.store.settled();
    a.steward.stop();
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(a.clock.now()), cause: "device" });
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(a.clock.now()), cause: "device" });
    const b = await setup({ db: a.db, clock: a.clock, define: false, applier: a.applier, state: live(true) });
    // `setup` read the state as a plain sync; a restart's link hands the gap to recover first: the gap is read on top.
    expect(b.steward.lastApplierEvent()).toMatchObject({ seq: 1 });
    await gapEnds(b, live(true));
    await vi.waitFor(() => expect(firings(b)).toBe(2));
  });
});

describe("recovery while events are parked (the milestone 7+10+11 review, B3)", () => {
  it("relays each of the applier's events once when a gap is read while a batch is parked", async () => {
    const lampLive = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false }] } }, transports: [], latches: [] };
    const a = await setup({ state: lampLive });
    const { cursor } = await a.ok(SECRETS.owner, "events");
    // An event relayed before: the steward has had one of the applier's events.
    a.applier.emit({ type: "state", target: DIMMER, key: "level", value: 10, time: iso(a.clock.now()), cause: "device" });
    await a.pump();
    // An apply whose answer is slow: its events park behind it.
    let open!: () => void;
    a.applier.emitsOutcomes = false;
    a.applier.answerGate = new Promise<void>((r) => { open = r; });
    const applying = a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(DIMMER, "level.set_level", { level: 50 })] },
      idempotency_key: "parked-1" });
    await vi.waitFor(() => expect(a.applier.applies).toHaveLength(1));
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(a.clock.now()), cause: "external" });
    await a.pump();
    // The session is made again (or the cursor expired): the link reads the gap from the last event had.
    const missed = (await a.port.history({ from: iso(0), to: iso(a.clock.now() + 1000) })).events;
    a.steward.recover(missed, { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: true }] } }, transports: [], latches: [] },
      String(missed.at(-1)!.seq));
    open();
    await applying;
    await quiet(a.store);
    const lamp = (await eventsSince(a.ok, String(cursor), "state")).filter((e: Body) => e.target === LAMP);
    expect(lamp.map((e: Body) => [e.applier_seq, e.recovered ?? false])).toEqual([[2, false]]);
  });
});

describe("the recovery cap (the milestone 7+10+11 review, I2)", () => {
  it("never drops an event that grants or ends a lease: an outside change and a latchless safety rule's completion past the cap still act", async () => {
    const s = await following({ options: { recoveryCap: 1 } });
    s.steward.onDescribe({ ...describeOf(DEVICES, 2), safety_rules: [{ id: "night", trigger: {}, actions: [{ target: DIMMER, action: "level.set_level" }] }] });
    s.applier.emit({ type: "state", target: DIMMER, key: "level", value: 5, time: iso(s.clock.now()), cause: { safety_rule: "night" } });
    s.applier.emit({ type: "outcome", rule_id: "night", step_id: "s1", target: DIMMER, outcome: "acked", time: iso(s.clock.now()) });
    await s.pump();
    expect(Object.keys((await s.ok(SECRETS.owner, "state")).leases)).toEqual([DIMMER]);
    const c = (await s.ok(SECRETS.owner, "events")).cursor;
    // The gap: night's completion and an outside change of the lamp, then more than the cap of others.
    s.applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, time: iso(s.clock.now()) });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "external" });
    for (let i = 0; i < 3; i++) s.applier.emit({ type: "state", target: DIMMER, key: "level", value: i, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s, live(false));
    const leases = (await s.ok(SECRETS.owner, "state")).leases as Body;
    expect(Object.keys(leases)).toEqual([LAMP]);
    expect(leases[LAMP].holder).toBe("external");
    expect((await eventsSince(s.ok, String(c))).filter((e) => e.recovered).map((e) => e.type)).toEqual(["rule_fired", "state", "state"]);
  });
});
