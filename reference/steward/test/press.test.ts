import { describe, expect, it, vi } from "vitest";
import { HALL_DEVICES, hallState, iso } from "./hall.js";
import { SECRETS, up } from "./house.js";
import { BUTTON, BUTTON_DEVICE, HOLDER, key, KEY, OFF, OLGA, press, PRESS, rig, WITHHELD } from "./press-rig.js";
import { describeOf, eventsSince, LAMP, on } from "./setup.js";

type Body = Record<string, any>;

describe("a press is a person's (GA-LEASE-9)", () => {
  it("replaces a member's hold at dispatch and takes a hold held by { rule, press }", async () => {
    const o = await PRESS.overAMembersHold();
    expect(o.sent).toMatchObject({ via: "rule", for: { rule: "bench-on" } });
    expect(o.events).toEqual([["ended", "replaced"], ["granted", undefined]]);
    expect(o.refused).toEqual([]);
    expect(o.lease).toMatchObject({ precedence: "person", holder: HOLDER });
  });

  it("takes a hold held by { rule, press } on a lamp no one holds", async () => {
    expect(await PRESS.pressed()).toEqual(HOLDER);
  });

  it("replaces a guest's hold", async () => {
    const t = await rig();
    await t.ok(SECRETS.panel, "apply", { request: { endpoint: "hall-panel", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    await t.pump();
    expect((await t.leases())[LAMP].holder).toEqual({ endpoint: "hall-panel" });
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    expect((await t.leases())[LAMP].holder).toEqual(HOLDER);
  });

  it("is refused by a load_cap lease", async () => {
    const t = await rig();
    await t.outside(LAMP, "on", false, "load_cap");
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "bench-on", reason: "leased", holder: "load_cap" });
  });

  it("is refused by a safety rule's lease", async () => {
    const t = await rig();
    t.steward.onDescribe({ ...describeOf([...HALL_DEVICES, BUTTON_DEVICE], 2),
      safety_rules: [{ id: "night", trigger: {}, actions: [{ target: LAMP, action: "onoff.turn_on" }] }] });
    t.applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: { safety_rule: "night" }, time: t.at() });
    t.applier.emit({ type: "outcome", rule_id: "night", step_id: "s1", target: LAMP, outcome: "acked" });
    await t.pump();
    expect((await t.leases())[LAMP].holder).toEqual({ safety_rule: "night" });
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "bench-on", reason: "leased", holder: { safety_rule: "night" } });
  });

  it("is refused by a run's lease", async () => {
    const t = await rig();
    await t.define([up("scenario", { id: "keep", name: "Keep", mode: "single", owned: [LAMP], steps: [{ delay: 600 }] })]);
    const plan = await t.ok(SECRETS.owner, "scenario_plan", { scenario: "keep", endpoint: "owner-app" });
    const { run_id } = await t.ok(SECRETS.owner, "scenario_run", { plan_id: plan.plan_id, idempotency_key: key() });
    expect((await t.leases())[LAMP].holder).toEqual({ run: run_id });
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ rule: "bench-on", reason: "leased", holder: { run: run_id } });
  });

  it("leaves the earlier hold when its step is skipped(already)", async () => {
    expect(await PRESS.alreadyDone()).toEqual(OLGA);
  });

  it("is a rule's when its trigger is not marked press, whatever value it matches", async () => {
    const t = await rig();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    await t.pump();
    const plain = (id: string, value: string) => {
      const { trigger, ...rest } = press(id, {}, value);
      return { ...rest, trigger: { event: { ...trigger.event, press: undefined } } };
    };
    await t.define([up("rule", plain("single", "1_single")), up("rule", plain("double", "2_double"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt("1_single");
    await t.pressIt("2_double");
    expect((await eventsSince(t.ok, cursor, "refused")).map((e) => [e.rule, e.reason])).toEqual([["single", "leased"], ["double", "leased"]]);
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
  });

  it("keeps its hold after its rule is deleted", async () => {
    expect(await PRESS.ruleDeleted()).toEqual(HOLDER);
  });

  it("fires only while its rule's conditions hold", async () => {
    expect(await PRESS.outsideItsConditions()).toBe(0);     // 11:00 Moscow at the fake clock's start: outside
  });

  it("ending unreachable restores the member's hold it replaced, which still refuses the rule it refused", async () => {
    const o = await PRESS.endsUnreachable();
    expect(o.pressed).toEqual(HOLDER);
    expect(o.events).toEqual([
      ["ended", "replaced", undefined, undefined], ["granted", undefined, undefined, undefined],
      ["ended", "unreachable", undefined, undefined], ["granted", undefined, true, "member"]]);
    expect(o.turnedOff).toBe(0);
    expect(o.holder).toEqual(OLGA);
  });

  it("ending unreachable restores a replaced hold whose end has passed only to end it at once, by its policy", async () => {
    const t = await rig();
    await t.ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    await t.pump();
    t.clock.advance(500_000);
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    t.clock.advance(200_000);                             // past the member's off_s (600 s) from her change, inside the press's on_s
    expect((await t.leases())[LAMP].holder).toEqual(HOLDER);
    const applierApply = `applier-apply-${new Set(t.applier.applies.map((a: Body) => a.idempotency_key)).size}`;
    t.applier.emit({ type: "outcome", apply_id: applierApply, step_id: "s1", target: LAMP, outcome: "unreachable", time: t.at() });
    await t.settle();
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).slice(2).map((e) => [e.change, e.end, e.restored])).toEqual([
      ["ended", "unreachable", undefined], ["granted", undefined, true], ["ended", "quiet", undefined]]);
  });

  it("on a personal key, withholds its hold, its lease events and the holder of a refusal from a member, and its value from the owner (R-67)", async () => {
    const t = await rig({ button: { ...BUTTON_DEVICE, personal: [KEY] } });
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    await t.define([up("rule", OFF)]);
    await t.settle();
    const owners = await eventsSince(t.ok, cursor);
    expect(owners.filter((e) => e.type === "lease").map((e) => e.holder)).toEqual([WITHHELD]);
    expect(owners.find((e) => e.type === "refused")).toMatchObject({ rule: "off", reason: "leased", holder: WITHHELD });
    const olgas = (await t.ok(SECRETS.olga, "events", { cursor })).events as Body[];
    expect(olgas.filter((e) => e.type === "lease")).toEqual([]);
    const refused = olgas.find((e) => e.type === "refused");
    expect(refused).toMatchObject({ rule: "off", reason: "leased" });
    expect(refused).not.toHaveProperty("holder");
    expect(((await t.ok(SECRETS.olga, "state")).leases as Body)[LAMP]).toBeUndefined();
    expect((await t.leases())[LAMP].holder).toEqual(WITHHELD);
    const range = { from: new Date(t.clock.now() - 60_000).toISOString(), to: new Date(t.clock.now() + 1000).toISOString() };
    const refusedIn = async (secret: string) => ((await t.ok(secret, "history", range)).events as Body[]).find((e) => e.type === "refused");
    expect(await refusedIn(SECRETS.owner)).toMatchObject({ rule: "off", holder: WITHHELD });
    expect(await refusedIn(SECRETS.olga)).not.toHaveProperty("holder");
  });

  it("on a personal key, withholds from a member the end of her hold it replaced and that hold's restoring", async () => {
    const t = await rig({ button: { ...BUTTON_DEVICE, personal: [KEY] } });
    await t.olgaOff();
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    t.applier.emit({ type: "outcome", apply_id: t.lastApply(), step_id: "s1", target: LAMP, outcome: "unreachable", time: t.at() });
    await t.settle();
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.restored])).toEqual([["ended", "replaced", undefined],
      ["granted", undefined, undefined], ["ended", "unreachable", undefined], ["granted", undefined, true]]);
    const olgas = (await t.ok(SECRETS.olga, "events", { cursor })).events as Body[];
    expect(olgas.filter((e) => e.type === "lease")).toEqual([]);
  });

  it("ending unreachable in a following gap restores the hold it replaced as of the outcome's time, ending it there by its policy (GA-LEASE-9, GA-LEASE-7)", async () => {
    const t = await rig();
    const t0 = t.clock.now();
    await t.olgaOff();
    t.clock.advance(500_000);
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    // Missed: unreachable at 550 s, inside the member's off_s (600 s); read back at 700 s.
    t.clock.advance(50_000);
    t.applier.emitUnseen({ type: "outcome", apply_id: t.lastApply(), step_id: "s1", target: LAMP, outcome: "unreachable", time: t.at() });
    t.clock.advance(150_000);
    const missed = (await t.port.history({ from: iso(0), to: t.at() })).events;
    t.steward.recover(missed, hallState(false, t.clock.now()), String(missed.at(-1)?.seq ?? 0));
    await t.settle();
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).slice(2).map((e) => [e.change, e.end, e.restored, e.end_time])).toEqual([
      ["ended", "unreachable", undefined, iso(t0 + 550_000)], ["granted", undefined, true, undefined], ["ended", "quiet", undefined, iso(t0 + 600_000)]]);
  });

  it("leaves the earlier hold standing until the applier answers", async () => {
    const t = await rig();
    await t.olgaOff();
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    let open!: () => void;
    t.applier.answerGate = new Promise((r) => { open = r; });
    t.applier.emit({ type: "occurrence", target: BUTTON, key: KEY, value: "1_single", cause: "device", time: t.at() });
    await t.pump();
    await vi.waitFor(() => expect(t.applier.applies.at(-1)!.request.actions[0]).toMatchObject({ for: { rule: "bench-on" } }));
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
    open();
    await t.settle();
    expect((await t.leases())[LAMP].holder).toEqual(HOLDER);
  });

  it("leaves the earlier hold when the applier refuses its step", async () => {
    const t = await rig();
    t.applier.planner = (a) => (a.via === "rule" ? { verdict: "refuse", reason: "safety" } : {});
    await t.olgaOff();
    await t.define([up("rule", press("bench-on"))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    expect((await eventsSince(t.ok, cursor, "outcome")).filter((e) => e.cause?.rule === "bench-on").map((e) => [e.outcome, e.reason]))
      .toContainEqual(["refused", "safety"]);
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
    expect(await eventsSince(t.ok, cursor, "lease")).toEqual([]);
  });

  it("starts its { scenario } action as the rule's, its step refused(leased) by a member's hold", async () => {
    const t = await rig();
    await t.olgaOff();
    await t.define([up("scenario", { id: "lamp-on", name: "lamp-on", mode: "single", steps: [on(LAMP)] }),
      up("rule", press("bench-on", { actions: [{ scenario: "lamp-on" }] }))]);
    const { cursor } = await t.ok(SECRETS.owner, "events");
    await t.pressIt();
    await vi.waitFor(async () => expect((await eventsSince(t.ok, cursor, "refused"))[0]).toMatchObject({ reason: "leased",
      holder: { person: "olga", endpoint: "olga-app" } }));
    expect((await t.leases())[LAMP].holder).toEqual({ person: "olga", endpoint: "olga-app" });
  });

  it("ends its hold as a person's hold ends, by the policy's on_s in a quiet room (GA-LEASE-7)", async () => {
    const t = await rig();
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    const { cursor } = await t.ok(SECRETS.owner, "events");
    t.clock.advance(3_599_000);
    await t.settle();
    expect((await t.leases())[LAMP].holder).toEqual(HOLDER);
    t.clock.advance(2_000);
    await t.settle();
    expect((await t.leases())[LAMP]).toBeUndefined();
    expect((await eventsSince(t.ok, cursor, "lease")).map((e) => [e.change, e.end, e.holder])).toEqual([["ended", "quiet", HOLDER]]);
  });

  it("keeps its hold after its rule is made inactive", async () => {
    const t = await rig();
    await t.define([up("rule", press("bench-on"))]);
    await t.pressIt();
    await t.define([up("rule", press("bench-on", { active: false }))]);
    await t.settle();
    expect((await t.leases())[LAMP].holder).toEqual(HOLDER);
  });

  it("asks nothing of a confirm step its author defined from an app: the step goes with a token (GA-SCN-4)", async () => {
    expect(await PRESS.confirmStep()).toEqual({ outcomes: [["dispatched", undefined]], sent: [true] });
  });

  it("acts as the rule's on a device its step is brain_authored for: written by a brain, refused(leased) by the member's hold", async () => {
    expect(await PRESS.brainWritten()).toEqual(OLGA);
  });

  it("acts as the rule's on a device a brain joined to the group it acts on, refused(leased) by the member's hold there", async () => {
    expect(await PRESS.brainJoinedGroup()).toEqual(OLGA);
  });

  it("is refused by define on a liveness trigger with invalid_request", async () => {
    const t = await rig();
    const { revision } = await t.ok(SECRETS.owner, "describe");
    const r = await t.call(SECRETS.owner, "define", { endpoint: "owner-app", expected_revision: revision, dry_run: false,
      changes: [up("rule", { ...press("dead"), trigger: { event: { target: BUTTON, type: "liveness", press: true } } })] });
    expect(r).toMatchObject({ ok: false, error: "invalid_request" });
  });
});
