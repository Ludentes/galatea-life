import { describe, expect, it } from "vitest";
import { SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, judgeAction, LAMP, setup } from "./setup.js";

type Body = Record<string, any>;
const turnOn = (target: string) => ({ target, action: "onoff.turn_on", args: {} });
const asks = (events: Body[]) => events.filter((e) => e.type === "ask");
/** The dimmer with `level` personal: a `set_level` step's `level` sets a personal key. */
const PERSONAL = DEVICES.map((d: Body) => (d.id === DIMMER ? { ...d, personal: ["level"],
  actions: d.actions.map((a: Body) => (a.action === "level.set_level" ? { ...a, tier: "confirm" } : a)) } : d));

/** A plan by Olga at her app with an asked step, and the events cursor from before it. */
async function asked(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup(o);
  const { cursor } = await s.ok(SECRETS.owner, "events");
  const plan = await s.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [turnOn(LAMP), turnOn(DIMMER)] });
  const read = async (secret: string, extra: Body = {}) => asks((await s.ok(secret, "events", { cursor, ...extra })).events);
  return { ...s, cursor: String(cursor), plan, read };
}

describe("the ask event's steps (GA-CONF-5)", () => {
  it("carries each asked step as the plan gives it, in the order of step_ids", async () => {
    const { plan, read } = await asked();
    const step = plan.steps.find((x: Body) => x.verdict === "ask");
    expect(await read(SECRETS.owner)).toEqual([expect.objectContaining({ plan_id: plan.plan_id, step_ids: ["s2"], endpoint: "olga-app",
      steps: [{ step_id: "s2", target: DIMMER, action: "onoff.turn_on", args: {}, tier: step.tier, reason: "confirm_tier" }] })]);
  });

  it("gives the steps to a read at the ask's endpoint and to the owner, and the event without them to every other read", async () => {
    const { read } = await asked();
    expect((await read(SECRETS.olga))[0].steps).toHaveLength(1);
    expect((await read(SECRETS.owner))[0].steps).toHaveLength(1);
    const panel = (await read(SECRETS.panel))[0];
    expect(panel).toMatchObject({ step_ids: ["s2"], endpoint: "olga-app" });
    expect(panel).not.toHaveProperty("steps");
    // A brain's read naming no endpoint derives no reader: no steps.
    expect((await read(SECRETS.brain))[0]).not.toHaveProperty("steps");
  });

  it("gives the steps to a read whose derived person is the plan's speaker", async () => {
    const s = await setup();
    const { cursor } = await s.ok(SECRETS.owner, "events");
    await s.define([up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain",
      confirm_on: "hall-panel" })]);
    await s.ok(SECRETS.brain, "plan", { endpoint: "kitchen-voice", speaker: "olga", actions: [turnOn(DIMMER)] });
    const read = async (secret: string, extra: Body = {}) => asks((await s.ok(secret, "events", { cursor, ...extra })).events);
    expect((await read(SECRETS.olga))[0].steps).toHaveLength(1);
    expect((await read(SECRETS.panel))[0].steps).toHaveLength(1);
    expect((await read(SECRETS.brain, { endpoint: "kitchen-voice" }))[0]).not.toHaveProperty("steps");
    expect((await read(SECRETS.brain, { endpoint: "kitchen-voice", speaker: "olga" }))[0].steps).toHaveLength(1);
  });

  it("filters history the same way", async () => {
    const { ok, clock } = await asked();
    const range = { from: new Date(clock.now() - 60_000).toISOString(), to: new Date(clock.now() + 60_000).toISOString() };
    expect(asks((await ok(SECRETS.olga, "history", range)).events)[0].steps).toHaveLength(1);
    expect(asks((await ok(SECRETS.panel, "history", range)).events)[0]).not.toHaveProperty("steps");
  });

  it("withholds an arg setting a personal key from a guest's read at the ask's endpoint (GA-AUTH-7)", async () => {
    const s = await setup({ devices: PERSONAL });
    // The dimmer's set_level asks for a confirmation, as its turn_on does.
    s.applier.planner = (a: Body) => (a.action === "level.set_level" ? (a.token ? { tier: "confirm" } : { verdict: "refuse", reason: "token", tier: "confirm" }) : judgeAction(a));
    await s.define([up("endpoint", { id: "olga-app", name: "Телефон Ольги", type: "app", room: null, person: "olga", served_by: null, confirm_on: "hall-panel" })]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    await s.ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [{ target: DIMMER, action: "level.set_level", args: { level: 40 } }] });
    const read = async (secret: string) => asks((await s.ok(secret, "events", { cursor })).events)[0];
    expect((await read(SECRETS.panel)).steps[0].args).toEqual({ level: "withheld" });
    expect((await read(SECRETS.owner)).steps[0].args).toEqual({ level: 40 });
  });

  it("under asks-without-the-steps, carries none; under broadcasts-the-steps, gives them to every read", async () => {
    expect((await (await asked({ mutation: "asks-without-the-steps" })).read(SECRETS.owner))[0]).not.toHaveProperty("steps");
    expect((await (await asked({ mutation: "broadcasts-the-steps" })).read(SECRETS.panel))[0].steps).toHaveLength(1);
  });
});

describe("the define event's diff (GA-STW-7)", () => {
  const attic = up("room", { id: "attic", name: "Чердак" });
  async function defined(o: Parameters<typeof setup>[0] = {}) {
    const s = await setup(o);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    await s.define([attic]);
    const read = async (secret: string) => (await s.ok(secret, "events", { cursor })).events.filter((e: Body) => e.type === "define")[0];
    return { ...s, read };
  }

  it("gives the diff to the define's endpoint and the owner's role, and the event without it to every other read", async () => {
    const { read } = await defined();
    expect((await read(SECRETS.owner)).diff).toEqual([expect.stringContaining("attic")]);
    const panel = await read(SECRETS.panel);
    expect(panel).toMatchObject({ endpoint: "owner-app" });
    expect(panel).not.toHaveProperty("diff");
    expect(await read(SECRETS.olga)).not.toHaveProperty("diff");
  });

  it("under broadcasts-the-diff, gives it to every read", async () => {
    const { read } = await defined({ mutation: "broadcasts-the-diff" });
    expect((await read(SECRETS.panel)).diff).toEqual([expect.stringContaining("attic")]);
  });
});
