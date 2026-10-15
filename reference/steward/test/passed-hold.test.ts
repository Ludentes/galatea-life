import { describe, expect, it, vi } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { BED, BUTTON_DEVICE, KEY, offRule, pressOn, rig, SHORT } from "./hold-rig.js";
import { SECRETS, up } from "./house.js";
import { AUTO_LOCK, DOOR, rig as doorRig } from "./narrowing-rig.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { DEVICES, eventsSince, LAMP, on, quiet, setup } from "./setup.js";

type Body = Record<string, any>;

const OLGA = { person: "olga", endpoint: "olga-app" };
const LAMP_SWITCH = up("target", { id: LAMP, owner_work_passes_holds: true });
const HOME_SWITCH = up("home", { hold: { owner_work_passes_holds: true } });
/** A scenario owning the lamp, turning it off and keeping it 900 s, run by BED at 11:05. */
const KEEP_OFF = up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [on(LAMP, "onoff.turn_off"), { delay: 900 }] });
/** The press's personal value, as every reader is shown it until slice 8 (R-67). */
const PRESS_WITHHELD = { rule: "press-on", press: { target: BUTTON_DEVICE.id, key: KEY, value: "withheld" } };

/** The device switch passing Olga's hold by the owner's rule, its step acked: the outcome events since, and history's. */
async function devicePasses(mutation?: Mutation) {
  const t = await rig({ mutation, changes: [LAMP_SWITCH] });
  await t.held();
  const { cursor } = await t.ok(SECRETS.owner, "events");
  await t.defineAndSettle([up("rule", offRule())]);
  await t.ackLast();
  const events = (await eventsSince(t.ok, cursor, "outcome")).filter((e) => e.target === LAMP);
  const h = await t.ok(SECRETS.owner, "history", { targets: [LAMP], from: new Date(t.clock.now() - 60_000).toISOString(),
    to: new Date(t.clock.now() + 1_000).toISOString() });
  return { t, events, history: (h.events as Body[]).filter((e) => e.type === "outcome" && e.cause?.rule === "off") };
}

/** A press on a personal key holds the lamp; the owner's marked rule passes that hold: each reader's history of the rule's outcomes. */
async function personalPress(mutation?: Mutation) {
  const t = await rig({ mutation, devices: [...DEVICES, { ...BUTTON_DEVICE, personal: [KEY] }], changes: [up("rule", pressOn())] });
  const { cursor } = await t.ok(SECRETS.owner, "events");
  await t.press();
  await t.ackLast();                                                         // the press's floor passed
  await t.report("on", true);                                                // the lamp reads on, as the press set it
  await t.defineAndSettle([up("rule", offRule({ passes_holds: true }))]);
  await t.ackLast();
  expect(t.turnedOff().length).toBe(1);
  const range = { from: new Date(t.clock.now() - 60_000).toISOString(), to: new Date(t.clock.now() + 1_000).toISOString() };
  const ruled = async (secret: string) => ((await t.ok(secret, "history", range)).events as Body[])
    .filter((e) => e.type === "outcome" && e.cause?.rule === "off");
  const events = async (secret: string) => ((await t.ok(secret, "events", { cursor })).events as Body[])
    .filter((e) => e.type === "outcome" && e.cause?.rule === "off");
  return { t, guest: await ruled(SECRETS.panel), owner: await ruled(SECRETS.owner), guestEvents: await events(SECRETS.panel) };
}

describe("passed_hold (GA-LEASE-12)", () => {
  it("is on the rule's outcome event, in events and history, naming the hold and the device switch", async () => {
    const { events, history } = await devicePasses();
    expect(events.length).toBe(2);                                          // the steward's own at the answer, then the applier's ack relayed
    for (const ev of events) {
      expect(ev.passed_hold).toEqual({ holder: OLGA, switch: "device" });
      expect(ev.holder).toBeUndefined();
    }
    expect(history.length).toBe(2);
    expect(history.every((e) => e.passed_hold?.switch === "device")).toBe(true);
  });

  it("is on a scheduled run's scenario_status step", async () => {
    const t = await rig({ changes: [SHORT, HOME_SWITCH, KEEP_OFF, BED] });
    await t.held();
    t.applier.answerOutcome = "sent";                                       // the run's step ends sent: in sent_steps
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * 60_000);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).sent_steps.length).toBe(1));
    const st = await t.ok(SECRETS.owner, "scenario_status", { run_id });
    expect(st.sent_steps[0].passed_hold).toEqual({ holder: OLGA, switch: "home" });
    expect(st.sent_steps[0].holder).toBeUndefined();
    const ev = (await eventsSince(t.ok, cursor, "outcome")).find((e) => e.target === LAMP);
    expect(ev!.passed_hold).toEqual({ holder: OLGA, switch: "home" });
  });

  it("is on a run's failed step should it fail", async () => {
    const t = await rig({ changes: [SHORT, HOME_SWITCH, KEEP_OFF, BED] });
    await t.held();
    t.applier.answerOutcome = "failed";
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * 60_000);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).failed_steps.length).toBe(1));
    const st = await t.ok(SECRETS.owner, "scenario_status", { run_id });
    expect(st.failed_steps[0]).toMatchObject({ outcome: "failed", passed_hold: { holder: OLGA, switch: "home" } });
  });

  it("is on no narrowing's and no press's outcome", async () => {
    const d = await doorRig();
    await d.unlocked();
    const { cursor } = await d.ok(SECRETS.owner, "events");
    await d.define([up("rule", { ...AUTO_LOCK, passes_holds: true })]);
    await d.settle();
    expect(d.locks().length).toBe(1);
    const locked = (await eventsSince(d.ok, cursor, "outcome")).filter((e) => e.target === DOOR);
    expect(locked.length).toBeGreaterThan(0);
    for (const e of locked) expect(e).not.toHaveProperty("passed_hold");

    const t = await rig({ devices: [...DEVICES, BUTTON_DEVICE], changes: [up("rule", pressOn({ passes_holds: true }))] });
    await t.held({ action: "onoff.turn_off" });
    const { cursor: c2 } = await t.ok(SECRETS.owner, "events");
    await t.press();
    await t.ackLast();
    const pressed = (await eventsSince(t.ok, c2, "outcome")).filter((e) => e.target === LAMP);
    expect(pressed.length).toBe(2);
    for (const e of pressed) expect(e).not.toHaveProperty("passed_hold");
  });

  it("is left out whole for a guest when the hold passed is a personal press's", async () => {
    const { guest, owner, guestEvents } = await personalPress();
    expect(guest.length).toBe(2);
    for (const e of [...guest, ...guestEvents]) expect(e).not.toHaveProperty("passed_hold");
    expect(guestEvents.length).toBe(2);
    expect(owner.length).toBe(2);
    for (const e of owner) expect(e.passed_hold).toEqual({ holder: PRESS_WITHHELD, switch: "rule" });
  });

  it("names a personal press's hold to the owner's app in scenario_status, its value withheld (R-67)", async () => {
    const t = await rig({ devices: [...DEVICES, { ...BUTTON_DEVICE, personal: [KEY] }], changes: [SHORT, HOME_SWITCH, up("rule", pressOn()), KEEP_OFF, BED] });
    await t.press();
    await t.ackLast();
    t.applier.answerOutcome = "sent";
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(5 * 60_000);
    const run_id = await t.runStarted(cursor);
    await vi.waitFor(async () => expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).sent_steps.length).toBe(1));
    expect((await t.ok(SECRETS.owner, "scenario_status", { run_id })).sent_steps[0].passed_hold).toEqual({ holder: PRESS_WITHHELD, switch: "home" });
  });
});

describe("passed_hold across a restart (GA-LEASE-12, GA-PERSIST-2)", () => {
  it("is on the relayed outcome of a rule's step the applier settles after the steward restarts", async () => {
    const clock = new FakeClock();
    const initial = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false, basis_time: new Date(clock.now()).toISOString() }] } },
      transports: [], latches: [] };
    const a = await setup({ db: lasting(await memoryDb()), clock, state: initial });
    await a.define([LAMP_SWITCH]);
    await a.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "passed-restart" });
    await a.pump();
    a.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: new Date(clock.now()).toISOString() });
    a.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "acked" });
    await a.pump();
    await a.define([up("rule", offRule())]);
    await quiet(a.store);
    expect(a.applier.applies.length).toBe(2);                               // the rule's turn_off, answered dispatched, still open
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db: a.db, clock, define: false, applier: a.applier, fromNow: true, state: initial });
    const { cursor } = await b.ok(SECRETS.owner, "events");
    b.applier.emit({ type: "outcome", apply_id: "applier-apply-2", step_id: "s1", target: LAMP, outcome: "acked" });
    await b.pump();
    const ev = (await eventsSince(b.ok, cursor, "outcome")).find((e) => e.target === LAMP);
    expect(ev).toMatchObject({ outcome: "acked", cause: { rule: "off" }, passed_hold: { holder: OLGA, switch: "device" } });
  });
});

describe("passed_hold under its mutations (GA-LEASE-12)", () => {
  it("is not recorded under pass-unrecorded", async () => {
    const { t, events, history } = await devicePasses("pass-unrecorded");
    expect(t.turnedOff().length).toBe(1);
    for (const e of [...events, ...history]) expect(e).not.toHaveProperty("passed_hold");
  });

  it("names the passed hold as the step's holder under pass-as-a-lease", async () => {
    const { events } = await devicePasses("pass-as-a-lease");
    expect(events[0]!.holder).toEqual(OLGA);
  });

  it("is shown to a guest under pass-reveals-a-personal-press", async () => {
    const { guest } = await personalPress("pass-reveals-a-personal-press");
    expect(guest.some((e) => e.passed_hold !== undefined)).toBe(true);
  });
});
