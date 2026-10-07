import { describe, expect, it } from "vitest";
import { EVENT_RETENTION_MS, HISTORY_RETENTION_MS, PERSONAL_RETENTION_MS } from "../src/core/events.js";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, DIMMER, LAMP, setup } from "./setup.js";

type Body = Record<string, any>;
const DAY = 24 * 3_600_000;
/** A camera whose `camera_in_use` is personal, and a television whose `speech` is. */
const CAMERA = "sim-bridge:camera";
const TV2 = "sim-bridge:tv2";
const WITH_PERSONAL = [...DEVICES,
  { id: CAMERA, label: "camera", class: "sensor", capabilities: ["onoff"], adopted: true, personal: ["camera_in_use", "motion_seen"],
    actions: [{ action: "onoff.turn_on", tier: "reversible" }] },
  { id: TV2, label: "tv", class: "tv", capabilities: ["media"], adopted: true, personal: ["speech"], actions: [{ action: "media.pause", tier: "reversible" }] }];

const iso = (ms: number) => new Date(ms).toISOString();
/** `history` as the owner over `[from, to]` on the clock, every target or `targets`. */
/** Moves the clock past the furnishing `define`, so a range from now holds only what the test does. */
function past(s: Awaited<ReturnType<typeof setup>>): number {
  s.clock.advance(1);
  return s.clock.now();
}
async function historyOf(s: Awaited<ReturnType<typeof setup>>, from: number, to: number, targets?: string[]): Promise<Body> {
  return s.ok(SECRETS.owner, "history", { from: iso(from), to: iso(to), ...(targets ? { targets } : {}) });
}
const kinds = (events: Body[]) => events.map((e) => `${e.type}${e.target ? ` ${e.target}` : ""}${e.key ? ` ${e.key}` : ""}`);

describe("history (GA-STW-7)", () => {
  it("returns the steward's own events and the applier's relayed, with their causes, oldest first, from the store", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = s.clock.now();
    s.clock.advance(1);
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "external" });
    s.applier.emit({ type: "liveness", target: LAMP, old: "live", new: "stale" });
    await s.pump();
    const h = await historyOf(s, from - 60_000, s.clock.now());
    expect(kinds(h.events)).toEqual(["define", "state sim-bridge:lamp on", "lease sim-bridge:lamp", "liveness sim-bridge:lamp"]);
    const state = h.events.find((e: Body) => e.type === "state");
    expect(state).toMatchObject({ cause: "external", applier_seq: 1 });
    expect(h.events.find((e: Body) => e.type === "lease")).toMatchObject({ change: "granted", holder: "external", precedence: "person" });
    expect(h).not.toHaveProperty("more");
    // The same events `events` serves, seq for seq.
    const seqs = h.events.map((e: Body) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("keeps a speech key and a personal key's occurrence in events only; a personal key's state is in history, withheld", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = past(s);
    const c = (await s.ok(SECRETS.owner, "events")).cursor as string;
    s.applier.emit({ type: "state", target: TV2, key: "speech", value: "новости", basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "occurrence", target: CAMERA, key: "motion_seen", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "state", target: CAMERA, key: "camera_in_use", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    const served = (await s.ok(SECRETS.owner, "events", { cursor: c })).events as Body[];
    expect(kinds(served)).toEqual(["state sim-bridge:tv2 speech", "occurrence sim-bridge:camera motion_seen", "state sim-bridge:camera camera_in_use"]);
    const h = await historyOf(s, from, s.clock.now());
    expect(kinds(h.events)).toEqual(["state sim-bridge:camera camera_in_use"]);
    expect(h.events[0].value).toBe("withheld");
  });

  it("matches targets by an event's target, device, devices or targets", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = s.clock.now();
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "model", revision: 2, device: CAMERA, class: "sensor" });
    s.applier.emit({ type: "rule_fired", rule_id: "leak", outcomes: [], notice: null, devices: ["sim-bridge:valve", LAMP] });
    s.applier.emit({ type: "state", target: CAMERA, key: "on", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    expect(kinds((await historyOf(s, from, s.clock.now(), [LAMP])).events)).toEqual(["state sim-bridge:lamp on", "rule_fired"]);
    expect(kinds((await historyOf(s, from, s.clock.now(), [CAMERA])).events)).toEqual(["model", "state sim-bridge:camera on"]);
    expect((await historyOf(s, from, s.clock.now(), ["sim-bridge:nothing"])).events).toEqual([]);
  });

  it("keeps 90 days past the hour events serve, a personal key's state 7, then prunes", async () => {
    const s = await setup({ devices: WITH_PERSONAL, options: { pruneEveryMs: DAY } });
    const from = s.clock.now();
    const c = (await s.ok(SECRETS.owner, "events")).cursor as string;
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "state", target: CAMERA, key: "camera_in_use", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    s.clock.advance(EVENT_RETENTION_MS + 1);
    expect(await s.error(SECRETS.owner, "events", { cursor: c })).toBe("cursor_expired");
    s.clock.advance(PERSONAL_RETENTION_MS - EVENT_RETENTION_MS - 2 * DAY);
    expect(kinds((await historyOf(s, from, s.clock.now())).events).filter((k) => k.startsWith("state"))).toEqual(
      ["state sim-bridge:lamp on", "state sim-bridge:camera camera_in_use"]);
    s.clock.advance(3 * DAY);
    expect(kinds((await historyOf(s, from, s.clock.now())).events).filter((k) => k.startsWith("state"))).toEqual(["state sim-bridge:lamp on"]);
    s.clock.advance(HISTORY_RETENTION_MS - PERSONAL_RETENTION_MS - 2 * DAY);
    expect(kinds((await historyOf(s, from, s.clock.now())).events).filter((k) => k.startsWith("state"))).toEqual(["state sim-bridge:lamp on"]);
    s.clock.advance(3 * DAY);
    expect((await historyOf(s, from, s.clock.now())).events.filter((e: Body) => e.type === "state")).toEqual([]);
  });

  it("says more past its cap, and reads on after the last event's seq", async () => {
    const s = await setup({ options: { historyCap: 3 } });
    const from = past(s);
    for (let i = 0; i < 5; i++) {
      s.applier.emit({ type: "state", target: LAMP, key: "on", value: i % 2 === 0, basis_time: iso(from), cause: "device" });
      await s.pump();
      s.clock.advance(1_000);
    }
    const first = await historyOf(s, from, s.clock.now());
    expect(first.events).toHaveLength(3);
    expect(first.more).toBe(true);
    const next = await s.ok(SECRETS.owner, "history", { from: iso(from), to: iso(s.clock.now()), after_seq: first.events[2].seq });
    expect(next.events).toHaveLength(2);
    expect(next).not.toHaveProperty("more");
    expect([...first.events, ...next.events].map((e: Body) => e.seq)).toEqual([...new Set([...first.events, ...next.events].map((e: Body) => e.seq))]);
  });

  it("orders by seq when the clock steps back, and pages on past a millisecond holding more than its cap (the milestone 7+10+11 review, I4)", async () => {
    const s = await setup({ options: { historyCap: 2 } });
    const from = past(s);
    s.clock.advance(5_000);
    for (let i = 0; i < 3; i++) s.applier.emit({ type: "state", target: LAMP, key: "on", value: i % 2 === 0, basis_time: iso(from), cause: "device" });
    await s.pump();
    // The clock is stepped back (a time_source retargeted): the next event's time is before the others'.
    s.clock.jump(-4_000);
    s.applier.emit({ type: "state", target: DIMMER, key: "level", value: 7, basis_time: iso(from), cause: "device" });
    await s.pump();
    const seqs: number[] = [];
    let after: number | undefined;
    for (let page = 0; page < 5; page++) {
      const h = await s.ok(SECRETS.owner, "history", { from: iso(from), to: iso(from + 60_000), targets: [LAMP, DIMMER], ...(after !== undefined ? { after_seq: after } : {}) });
      seqs.push(...(h.events as Body[]).map((e) => e.seq));
      if (!h.more) break;
      after = (h.events as Body[]).at(-1)!.seq;
    }
    expect(seqs).toHaveLength(4);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(4);
  });

  it("fails while the store is down, pending false; checks the endpoint it names", async () => {
    const s = await setup();
    expect(await s.error(SECRETS.olga, "history", { from: iso(0), to: iso(s.clock.now()), endpoint: "hall-panel" })).toBe("not_permitted");
    s.db.trouble.down = true;
    s.steward.onEvents([{ seq: 1, time: iso(s.clock.now()), type: "state", target: LAMP, key: "on", value: true, cause: "device" }]);
    for (let i = 0; i < 100 && !s.store.down; i++) await new Promise((r) => setImmediate(r));
    expect(s.store.down).toBe(true);
    await expect(s.call(SECRETS.owner, "history", { from: iso(0), to: iso(s.clock.now()) })).rejects.toMatchObject({ pending: false });
    s.db.trouble.down = false;
  });

  it("gives the reader role a view without any personal key's event", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = s.clock.now();
    s.applier.emit({ type: "state", target: CAMERA, key: "camera_in_use", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    await s.store.settled();
    const rows = await s.db.query<{ type: string; body: Body }>("SELECT type, body FROM history_v WHERE type = 'state' ORDER BY seq");
    expect(rows.rows.map((r) => `${r.body.target} ${r.body.key}`)).toEqual([`${LAMP} on`]);
    const grants = await s.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'reader'");
    expect([...new Set(grants.rows.map((g) => g.table_name))]).toEqual(["history_v"]);
  });
});

describe("a personal key's events by their kept mark (the milestone 7+10+11 review, B5 and I8)", () => {
  it("withholds a personal key's value in history after its device leaves describe", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = past(s);
    s.applier.emit({ type: "state", target: CAMERA, key: "camera_in_use", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    const before = ((await historyOf(s, from - 1000, s.clock.now() + 1000)).events as Body[]).filter((e) => e.target === CAMERA);
    expect(before.map((e) => e.value)).toEqual(["withheld"]);
    // The device is removed from the applier (or the steward restarted and has not read describe yet).
    s.steward.onDescribe(describeOf(DEVICES, 3));
    const after = ((await historyOf(s, from - 1000, s.clock.now() + 1000)).events as Body[]).filter((e) => e.target === CAMERA);
    expect(after.map((e) => e.value)).toEqual(["withheld"]);
  });

  it("serves a personal key's events to the owner only, withheld, in events and history; every other caller gets none", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = past(s);
    const c = (await s.ok(SECRETS.owner, "events")).cursor as string;
    s.applier.emit({ type: "state", target: CAMERA, key: "camera_in_use", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "occurrence", target: CAMERA, key: "motion_seen", value: true, basis_time: iso(from), cause: "device" });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    const range = { from: iso(from - 1000), to: iso(s.clock.now() + 1000) };
    const owner = (await s.ok(SECRETS.owner, "events", { cursor: c })).events as Body[];
    expect(owner.filter((e) => e.target === CAMERA).map((e) => `${e.type} ${e.value}`)).toEqual(["state withheld", "occurrence withheld"]);
    expect(((await s.ok(SECRETS.owner, "history", range)).events as Body[]).filter((e) => e.target === CAMERA).map((e) => e.value))
      .toEqual(["withheld"]);
    for (const other of [SECRETS.olga, SECRETS.panel]) {
      const served = await s.ok(other, "events", { cursor: c });
      expect((served.events as Body[]).filter((e) => e.target === CAMERA)).toEqual([]);
      expect((served.events as Body[]).some((e) => e.target === LAMP)).toBe(true);
      // Its cursor moves past what it was not served.
      expect(served.cursor).toBe((await s.ok(SECRETS.owner, "events", { cursor: c })).events.at(-1).seq.toString());
      expect(((await s.ok(other, "history", range)).events as Body[]).filter((e) => e.target === CAMERA)).toEqual([]);
    }
  });

  it("counts a key of a device not described when its event came as personal", async () => {
    const s = await setup({ devices: WITH_PERSONAL });
    const from = past(s);
    s.applier.emit({ type: "state", target: "sim-bridge:unknown", key: "on", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    const range = { from: iso(from - 1000), to: iso(s.clock.now() + 1000) };
    expect(((await s.ok(SECRETS.owner, "history", range)).events as Body[]).filter((e) => e.target === "sim-bridge:unknown").map((e) => e.value))
      .toEqual(["withheld"]);
    expect(((await s.ok(SECRETS.olga, "history", range)).events as Body[]).filter((e) => e.target === "sim-bridge:unknown")).toEqual([]);
  });
});

describe("history's targets and the events naming a rule (the milestone 7+10+11 review, M4)", () => {
  it("matches an applier's latch and rule_fired by the devices describe's rule actuates, and the steward's rule_fired by its steps' targets", async () => {
    const VALVE = "sim-bridge:valve";
    const devices = [...DEVICES, { id: VALVE, label: "valve", class: "water_valve", capabilities: ["valve"], adopted: true,
      actions: [{ action: "valve.close", tier: "reversible" }] }];
    const s = await setup({ devices, state: { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false }] },
      [DIMMER]: { liveness: "live", values: [{ key: "level", value: 0 }] } }, transports: [], latches: [] } });
    s.steward.onDescribe({ ...describeOf(devices, 2), safety_rules: [{ id: "leak", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }], latch: { condition: {} } }] });
    await s.define([up("rule", { id: "lamp", name: "Лампа", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
      actions: [{ target: DIMMER, action: "level.set_level", args: { level: 30 } }] })]);
    const from = past(s);
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "set" });
    s.applier.emit({ type: "rule_fired", rule_id: "leak", outcomes: [], notice: null });
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: iso(from), cause: "device" });
    await s.pump();
    await new Promise((r) => setTimeout(r, 50));
    const valve = (await historyOf(s, from - 1000, s.clock.now() + 60_000, [VALVE])).events as Body[];
    expect(valve.filter((e) => e.type === "latch" || e.type === "rule_fired").map((e) => `${e.type} ${e.rule_id}`)).toEqual(["latch leak", "rule_fired leak"]);
    const dimmer = (await historyOf(s, from - 1000, s.clock.now() + 60_000, [DIMMER])).events as Body[];
    expect(dimmer.filter((e) => e.type === "rule_fired").map((e) => e.rule)).toEqual(["lamp"]);
  });
});
