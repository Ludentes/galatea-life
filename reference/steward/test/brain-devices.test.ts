import { describe, expect, it, vi } from "vitest";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { resolveRequest } from "../src/gate/resolve.js";
import { planDefine } from "../src/house/define.js";
import { context, furnished, OWNER_CHAT, SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, eventsSince, heardAt, LAMP, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const STATE = { targets: Object.fromEntries(DEVICES.map((d) => [d.id, { liveness: "live", values: d.id === LAMP || d.id === DIMMER
  ? [{ key: "on", value: false, basis_time: "2030-01-01T08:00:00.000Z" }] : [] }])), transports: [], latches: [] };
const devices = new Map(DEVICES.map((d) => [d.id, d as Body]));

/** A steward whose owner wrote a rule that turns on what `on` names once the lamp turns on; `byBrain` defines through the brain. */
async function moved(on: Body, o: { mutation?: Mutation } = {}) {
  const s = await setup({ state: STATE, mutation: o.mutation, options: { pruneEveryMs: 24 * 3_600_000 } });
  s.applier.answerOutcome = "acked";
  await s.define([OWNER_CHAT, up("room", { id: "study", name: "Кабинет" }),
    up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP], aggregate: "any" }),
    up("rule", { id: "dark", name: "Темно", trigger: { state: { target: LAMP, key: "on", op: "eq", value: true } },
      actions: [{ ...on, action: "onoff.turn_on", args: {} }] })]);
  const byBrain = async (changes: unknown[]) => {
    const revision = (await s.ok(SECRETS.owner, "describe")).revision;
    const plan = await s.ok(SECRETS.brain, "define", { endpoint: "owner-chat", changes, expected_revision: revision, dry_run: false });
    await s.ok(SECRETS.brain, "answer", { plan_id: plan.plan_id, endpoint: "owner-chat", answers: { s1: "yes" },
      utterance: heardAt(s.clock, "owner-chat", { addressed_by: "typed" }) });
    return s.ok(SECRETS.brain, "define", { endpoint: "owner-chat", plan_id: plan.plan_id });
  };
  const turns = async (value: boolean) => {
    s.applier.emit({ type: "state", target: LAMP, key: "on", value, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
    await s.pump();
    await quiet(s.store);
  };
  /** The rule's firings' actions, each `target brain token`. */
  const fired = () => s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith("rule:dark:"))
    .map((a: Body) => (a.request.actions as Body[]).map((x) => `${x.target} brain:${x.brain} token:${x.token !== undefined}`));
  return { ...s, byBrain, turns, fired };
}

describe("devices a brain moved (GA-DEF-7)", () => {
  it("declares authors-a-moved-device", () => {
    expect(MUTATIONS).toContain("authors-a-moved-device");
  });

  it("marks a step reached through a room or a group the device joined through a brain, not one reached by its id", () => {
    const h = planDefine(furnished(), [up("room", { id: "study", name: "Кабинет" }), up("target", { id: DIMMER, room: "study" }),
      up("group", { id: "hall-lights", name: "Свет", room: "hall", members: [LAMP, DIMMER, "sim-bridge:tv"], aggregate: "any" })],
    context({ brain: true, device: (id) => (id === "sim-bridge:tv" ? { adopted: true, internal: false, actions: ["onoff.turn_off"] } : context().device(id)) })).draft;
    const steps = (actions: Body[], authored = true) => resolveRequest(actions as never, { devices, house: h, authored })
      .map((r) => `${r.target}${r.brain ? " brain" : ""}`);
    const on = { action: "onoff.turn_on", args: {} };
    expect(steps([{ selector: { room: "study" }, ...on }])).toEqual([`${DIMMER} brain`]);
    // The tv joined the owner's group through a brain; the lamp and the dimmer were in it already.
    expect(steps([{ target: "hall-lights", ...on }])).toEqual([DIMMER, LAMP, "sim-bridge:tv brain"]);
    expect(steps([{ target: DIMMER, ...on }, { target: "sim-bridge:tv", ...on }])).toEqual([DIMMER, "sim-bridge:tv"]);
    // Reached once directly and once through the brain's group: one step, marked.
    expect(steps([{ target: "sim-bridge:tv", ...on }, { target: "hall-lights", ...on }])).toEqual(["sim-bridge:tv brain", DIMMER, LAMP]);
    // A request's resolution, not authored work, marks nothing.
    expect(steps([{ selector: { room: "study" }, ...on }], false)).toEqual([DIMMER]);
  });

  it("shows a moved device brain_authored in describe, and a group's members as they are", async () => {
    const { byBrain, ok } = await moved({ target: "evening" });
    await byBrain([up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER], aggregate: "any" })]);
    const d = await ok(SECRETS.owner, "describe");
    expect(d.targets.filter((t: Body) => t.brain_authored).map((t: Body) => t.id)).toEqual([DIMMER]);
    expect(d.groups.find((g: Body) => g.id === "evening")).toEqual({ id: "evening", name: "Вечер", aliases: [], room: null, members: [DIMMER, LAMP],
      aggregate: "any" });
  });

  it("refuses an owner's rule's confirm step on a device a brain added to its group refuse(tier), until the owner sets the group again", async () => {
    const { byBrain, define, turns, fired } = await moved({ target: "evening" });
    await byBrain([up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER], aggregate: "any" })]);
    await turns(true);
    await vi.waitFor(() => expect(fired()).toHaveLength(1));
    // The dimmer's turn_on is confirm: brain_authored, it is refused and never sent; the lamp goes as the owner's.
    expect(fired()).toEqual([[`${LAMP} brain:false token:false`]]);
    await define([up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER], aggregate: "any" })]);
    await turns(false);
    await turns(true);
    await vi.waitFor(() => expect(fired()).toHaveLength(2));
    expect(fired()[1]).toEqual([`${DIMMER} brain:false token:true`, `${LAMP} brain:false token:false`]);
  });

  it("refuses a step reached through a room a brain put the device in, and not one naming it by its id", async () => {
    const room = await moved({ selector: { room: "study", class: "light" } });
    await room.byBrain([up("target", { id: DIMMER, room: "study" })]);
    const { cursor } = await room.ok(SECRETS.owner, "events");
    await room.turns(true);
    await vi.waitFor(async () => expect((await eventsSince(room.ok, cursor, "refused")).map((e) => [e.rule, e.target, e.reason]))
      .toEqual([["dark", DIMMER, "tier"]]));
    expect(room.fired()).toEqual([]);
    const id = await moved({ target: DIMMER });
    await id.byBrain([up("target", { id: DIMMER, room: "study" })]);
    await id.turns(true);
    await vi.waitFor(() => expect(id.fired()).toEqual([[`${DIMMER} brain:false token:true`]]));
  });

  it("sends the moved device's step with an authored token under authors-a-moved-device", async () => {
    const { byBrain, turns, fired } = await moved({ target: "evening" }, { mutation: "authors-a-moved-device" });
    await byBrain([up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER], aggregate: "any" })]);
    await turns(true);
    await vi.waitFor(() => expect(fired()).toEqual([[`${DIMMER} brain:false token:true`, `${LAMP} brain:false token:false`]]));
  });
});
