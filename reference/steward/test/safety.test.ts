import { describe, expect, it, vi } from "vitest";
import { SECRETS, up } from "./house.js";
import { describeOf, DEVICES, eventsSince, judgeAction, LAMP, on, setup } from "./setup.js";
import { LATCHLESS_SAFETY_MS } from "../src/steward.js";

type Body = Record<string, any>;
const VALVE = "sim-bridge:valve";
const LEAK = "sim-bridge:leak";
/** A valve a leak rule closes, and the leak sensor it reads. */
const SAFE_DEVICES = [...DEVICES,
  { id: VALVE, label: "valve", class: "water_valve", capabilities: ["valve"], adopted: true,
    actions: [{ action: "valve.open", tier: "reversible" }, { action: "valve.close", tier: "reversible" }] },
  { id: LEAK, label: "leak", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [] }];
/** The applier's safety rules: `leak` closes the valve and latches; `night` turns the lamp on and has no latch. */
const RULES = [{ id: "leak", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }], latch: { condition: {} } },
  { id: "night", trigger: {}, actions: [{ target: LAMP, action: "onoff.turn_on" }] }];
const described = (revision = 2) => ({ ...describeOf(SAFE_DEVICES, revision), safety_rules: RULES });

let keys = 0;
const key = () => `safety-key-${++keys}`;
const leasesOf = async (ok: (s: string, t: string, a?: Body) => Promise<Body>) => (await ok(SECRETS.owner, "state")).leases as Body;
const holder = (h: unknown) => (typeof h === "string" ? h : (h as Body).safety_rule ?? (h as Body).endpoint);
const leaseEvents = async (ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string) =>
  (await eventsSince(ok, cursor, "lease")).map((e) => `${e.change} ${e.target} ${holder(e.holder)}`);

/** The applier's events of a safety rule's firing: its latch set when it has one, then its actuation's state change and outcome. */
function fire(applier: { emit(e: Body): void }, rule: string, target: string, key2: string, value: unknown, latch: boolean): void {
  if (latch) applier.emit({ type: "latch", rule_id: rule, latch: "set", devices: [target] });
  applier.emit({ type: "state", target, key: key2, value, basis_time: "2030-01-01T08:00:00.000Z", cause: { safety_rule: rule } });
  applier.emit({ type: "outcome", rule_id: rule, step_id: "s1", target, outcome: "acked" });
}

async function safeSetup(o: Parameters<typeof setup>[0] = {}) {
  const s = await setup({ devices: SAFE_DEVICES, state: { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false }] },
    [VALVE]: { liveness: "live", values: [{ key: "open", value: true }] } }, transports: [], latches: [] }, ...o });
  s.steward.onDescribe(described());
  return s;
}

describe("safety rules' leases (GA-LEASE-6)", () => {
  it("leases a device a latching rule actuated, at safety_rule precedence, until its latch clears, not when the rule completes", async () => {
    const { ok, applier, pump } = await safeSetup();
    const { cursor } = await ok(SECRETS.owner, "events");
    fire(applier, "leak", VALVE, "open", false, true);
    await pump();
    expect(await leasesOf(ok)).toEqual({ [VALVE]: { holder: { safety_rule: "leak" }, precedence: "safety_rule", expires: "safety_rule" } });
    expect(await leaseEvents(ok, cursor)).toEqual([`granted ${VALVE} leak`]);
    applier.emit({ type: "rule_fired", rule_id: "leak", outcomes: [{ step_id: "s1", target: VALVE, outcome: "acked" }], notice: null, devices: [VALVE] });
    await pump();
    expect(Object.keys(await leasesOf(ok))).toEqual([VALVE]);
    applier.emit({ type: "latch", rule_id: "leak", latch: "cleared_by_owner", devices: [VALVE] });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
    expect(await leaseEvents(ok, cursor)).toEqual([`granted ${VALVE} leak`, `ended ${VALVE} leak`]);
  });

  it("keeps the lease of a rule describe does not list yet once its latch was seen set, past its rule_fired", async () => {
    const { ok, applier, pump } = await setup({ devices: SAFE_DEVICES });
    fire(applier, "leak", VALVE, "open", false, true);
    applier.emit({ type: "rule_fired", rule_id: "leak", outcomes: [], notice: null, devices: [VALVE] });
    await pump();
    expect(Object.keys(await leasesOf(ok))).toEqual([VALVE]);
    applier.emit({ type: "latch", rule_id: "leak", latch: "cleared", devices: [VALVE] });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
  });

  it("leases a device a latchless rule actuated until the rule completes, its rule_fired", async () => {
    const { ok, applier, pump } = await safeSetup();
    fire(applier, "night", LAMP, "on", true, false);
    await pump();
    expect(Object.keys(await leasesOf(ok))).toEqual([LAMP]);
    applier.emit({ type: "latch", rule_id: "leak", latch: "cleared", devices: [VALVE] });
    await pump();
    expect(Object.keys(await leasesOf(ok))).toEqual([LAMP]);
    applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, devices: [LAMP] });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
  });

  it("refuses a person's change and a rule's action on the leased device, naming the rule (GA-LEASE-3); a person's plan meets it at dispatch (GA-STW-8)", async () => {
    const { ok, applier, pump, define } = await safeSetup();
    const plan = await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(LAMP)] });
    expect(plan.steps.map((x: Body) => x.verdict)).toEqual(["op"]);
    fire(applier, "night", LAMP, "on", true, false);
    await pump();
    const r = await ok(SECRETS.olga, "apply", { plan_id: plan.plan_id, idempotency_key: key() });
    expect(r.outcomes.map((o: Body) => `${o.outcome}(${o.reason})`)).toEqual(["refused(leased)"]);
    const inline = await ok(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP, "onoff.turn_off")] }, idempotency_key: key() });
    expect(inline.outcomes.map((o: Body) => `${o.outcome}(${o.reason})`)).toEqual(["refused(leased)"]);
    expect(applier.applies.filter((a) => a.request.actions.some((x: Body) => x.target === LAMP))).toEqual([]);
    const c = (await ok(SECRETS.owner, "events")).cursor;
    await define([up("rule", { id: "off", name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] })]);
    await vi.waitFor(async () => {
      const refused = await eventsSince(ok, c, "refused");
      expect(refused.map((e) => `${e.rule} ${e.reason} ${holder(e.holder)}`)).toEqual(["off leased night"]);
    });
  });

  it("re-evaluates a level rule naming the device when the lease ends (GA-LEASE-4)", async () => {
    const { ok, applier, pump, define } = await safeSetup();
    fire(applier, "night", LAMP, "on", true, false);
    await pump();
    const c = (await ok(SECRETS.owner, "events")).cursor;
    await define([up("rule", { id: "off", name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] })]);
    await vi.waitFor(async () => { expect((await eventsSince(ok, c, "refused")).length).toBe(1); });
    applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [], notice: null, devices: [LAMP] });
    await pump();
    await vi.waitFor(() => {
      expect(applier.applies.some((a) => a.request.actions.some((x: Body) => x.target === LAMP && x.action === "onoff.turn_off"))).toBe(true);
    });
    expect((await eventsSince(ok, c, "rule_fired")).filter((e) => e.rule === "off").length).toBe(2);
  });

  it("reads held latches from state: their devices leased, a latching rule's lease ended once its latch is not listed, a latchless one's kept", async () => {
    const { ok, steward } = await safeSetup();
    steward.onState({ targets: {}, transports: [], latches: [{ rule_id: "leak", devices: [VALVE], since: "2030-01-01T07:00:00.000Z" }] });
    expect(await leasesOf(ok)).toEqual({ [VALVE]: { holder: { safety_rule: "leak" }, precedence: "safety_rule", expires: "safety_rule" } });
    (steward as any).leases.grant({ target: LAMP, holder: { safety_rule: "night" }, precedence: "safety_rule", sinceMs: 0, expiresMs: null });
    steward.onState({ targets: {}, transports: [], latches: [] });
    expect(Object.keys(await leasesOf(ok))).toEqual([LAMP]);
  });

  it("keeps a safety rule's lease across a restart", async () => {
    const a = await safeSetup();
    fire(a.applier, "leak", VALVE, "open", false, true);
    await a.pump();
    await a.store.settled();
    a.steward.stop();
    const b = await setup({ db: a.db, clock: a.clock, define: false, devices: SAFE_DEVICES });
    expect(await leasesOf(b.ok)).toEqual({ [VALVE]: { holder: { safety_rule: "leak" }, precedence: "safety_rule", expires: "safety_rule" } });
  });

  it("grants none under ignores-leases", async () => {
    const { ok, applier, pump } = await safeSetup({ mutation: "ignores-leases" });
    fire(applier, "leak", VALVE, "open", false, true);
    await pump();
    expect(await leasesOf(ok)).toEqual({});
  });
});

describe("several safety rules on one device (the milestone 7+10+11 review, B4)", () => {
  const TWO = [...RULES, { id: "flush", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }] },
    { id: "frost", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }], latch: { condition: {} } }];

  it("keeps the latched rule's lease after another rule on the same device completes", async () => {
    const s = await safeSetup();
    s.steward.onDescribe({ ...described(3), safety_rules: TWO });
    fire(s.applier, "leak", VALVE, "open", false, true);
    s.applier.emit({ type: "rule_fired", rule_id: "leak", outcomes: [], notice: null, devices: [VALVE] });
    await s.pump();
    // flush fires on the same valve and completes; leak's latch is still set.
    s.applier.emit({ type: "outcome", rule_id: "flush", step_id: "s1", target: VALVE, outcome: "acked" });
    s.applier.emit({ type: "rule_fired", rule_id: "flush", outcomes: [], notice: null, devices: [VALVE] });
    await s.pump();
    expect((await leasesOf(s.ok))[VALVE]?.holder).toEqual({ safety_rule: "leak" });
  });

  it("keeps one latching rule's lease when another's latch on the same device clears, and ends it at its own clearing", async () => {
    const s = await safeSetup();
    s.steward.onDescribe({ ...described(3), safety_rules: TWO });
    const { cursor } = await s.ok(SECRETS.owner, "events");
    fire(s.applier, "leak", VALVE, "open", false, true);
    fire(s.applier, "frost", VALVE, "open", false, true);
    await s.pump();
    s.applier.emit({ type: "latch", rule_id: "frost", latch: "cleared" });
    await s.pump();
    expect((await leasesOf(s.ok))[VALVE]?.holder).toEqual({ safety_rule: "leak" });
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "cleared" });
    await s.pump();
    expect((await leasesOf(s.ok))[VALVE]).toBeUndefined();
    expect(await leaseEvents(s.ok, String(cursor))).toEqual([`granted ${VALVE} leak`, `replaced ${VALVE} frost`, `replaced ${VALVE} leak`,
      `ended ${VALVE} leak`]);
  });
});

describe("a latchless safety rule's lease bounded (the milestone 7+10+11 review, I2)", () => {
  it("ends a latchless rule's lease LATCHLESS_SAFETY_MS after it was granted when its completion never comes; a latching rule's has no end", async () => {
    const s = await safeSetup();
    fire(s.applier, "night", LAMP, "on", true, false);
    fire(s.applier, "leak", VALVE, "open", false, true);
    await s.pump();
    const granted = s.clock.now();
    const leases = await leasesOf(s.ok);
    expect(leases[LAMP]).toEqual({ holder: { safety_rule: "night" }, precedence: "safety_rule", expires: new Date(granted + LATCHLESS_SAFETY_MS).toISOString() });
    expect(leases[VALVE].expires).toBe("safety_rule");
    s.clock.advance(LATCHLESS_SAFETY_MS - 1);
    expect(Object.keys(await leasesOf(s.ok))).toEqual([LAMP, VALVE]);
    s.clock.advance(1);
    await vi.waitFor(async () => expect(Object.keys(await leasesOf(s.ok))).toEqual([VALVE]));
  });
});

describe("a latchless safety lease ended early (GA-LEASE-6: steward 0.11)", () => {
  /** The valve declaring a 1200 s ack bound, and a latchless rule `shut` closing it. */
  const SLOW_VALVE = SAFE_DEVICES.map((d: Body) => (d.id === VALVE ? { ...d, actions: d.actions.map((a: Body) => ({ ...a, ack_within_s: 1200 })) } : d));
  const SHUT = { id: "shut", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }] };
  const slowSetup = async (mutation?: Parameters<typeof setup>[0] extends infer O ? O extends { mutation?: infer M } ? M : never : never) => {
    const s = await safeSetup({ devices: SLOW_VALVE, mutation });
    s.steward.onDescribe({ ...describeOf(SLOW_VALVE, 3), safety_rules: [...RULES, SHUT] });
    return s;
  };
  const rulesFired = (s: { applier: { applies: Body[] } }, rule: string) => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith(`rule:${rule}:`)).length;

  it("states safety_lease_s, 900, in describe; leaves it out under ends-a-safety-lease-undeclared", async () => {
    expect((await (await safeSetup()).ok(SECRETS.owner, "describe")).safety_lease_s).toBe(LATCHLESS_SAFETY_MS / 1000);
    expect(await (await safeSetup({ mutation: "ends-a-safety-lease-undeclared" })).ok(SECRETS.owner, "describe")).not.toHaveProperty("safety_lease_s");
  });

  it("holds the lease no shorter than its device's ack bound plus the late-ack window; at the ack bound under ends-a-safety-lease-early", async () => {
    for (const [mutation, ms] of [[undefined, 1_260_000], ["ends-a-safety-lease-early", 1_200_000]] as const) {
      const s = await slowSetup(mutation);
      fire(s.applier, "shut", VALVE, "open", false, false);
      await s.pump();
      expect((await leasesOf(s.ok))[VALVE].expires).toBe(new Date(s.clock.now() + ms).toISOString());
    }
  });

  it("re-evaluates a level rule the applier refused safety, once the safety rule's completion is relayed, raising no notice; not under forgets-a-safety-refusal", async () => {
    for (const [mutation, want] of [[undefined, 2], ["forgets-a-safety-refusal", 1]] as const) {
      const s = await slowSetup(mutation);
      let running = true;
      s.applier.planner = (a: Body) => (a.target === VALVE && running ? { verdict: "refuse", reason: "safety" } : judgeAction(a));
      fire(s.applier, "shut", VALVE, "open", false, false);
      await s.pump();
      s.clock.advance(1_260_000);
      await vi.waitFor(async () => expect(await leasesOf(s.ok)).toEqual({}));
      await s.define([up("rule", { id: "reopen", name: "Открыть", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
        actions: [{ target: VALVE, action: "valve.open", args: {} }] })]);
      const { cursor } = await s.ok(SECRETS.owner, "events");
      s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
      await s.pump();
      await vi.waitFor(() => expect(rulesFired(s, "reopen")).toBe(1));
      await vi.waitFor(async () => expect((await eventsSince(s.ok, cursor, "outcome")).filter((e) => e.cause?.rule === "reopen")
        .map((e) => `${e.outcome}(${e.reason})`)).toEqual(["refused(safety)"]));
      running = false;
      s.applier.emit({ type: "rule_fired", rule_id: "shut", outcomes: [{ step_id: "s1", target: VALVE, outcome: "acked" }], notice: null });
      await s.pump();
      if (want === 2) await vi.waitFor(() => { s.clock.advance(0); expect(rulesFired(s, "reopen")).toBe(2); });
      else {
        for (let i = 0; i < 5; i++) { s.clock.advance(0); await new Promise((r) => setTimeout(r, 0)); }
        expect(rulesFired(s, "reopen")).toBe(1);
      }
      s.clock.advance(120_000);
      await new Promise((r) => setTimeout(r, 0));
      expect(s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:")).map((a) => JSON.stringify(a.request.actions))
        .filter((x) => !x.includes("fresh_s is not known"))).toEqual([]);
    }
  });
});

describe("the wait after an early end, bounded and kept per safety rule (the code review, CR1)", () => {
  const SLOW_VALVE = SAFE_DEVICES.map((d: Body) => (d.id === VALVE ? { ...d, actions: d.actions.map((a: Body) => ({ ...a, ack_within_s: 1200 })) } : d));
  const SHUT = { id: "shut", trigger: {}, actions: [{ target: VALVE, action: "valve.close" }] };
  const fired = (s: { applier: { applies: Body[] } }) => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("rule:reopen:")).length;
  const told = (s: { applier: { applies: Body[] } }) => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:"))
    .flatMap((a) => (a.request.actions as Body[]).map((x) => String(x.args.text))).filter((t) => t.includes("reopen"));
  /** shut's lease on the valve ended early, then a level rule reopening the valve refused safety by the applier, waiting. */
  async function waiting() {
    const s = await safeSetup({ devices: SLOW_VALVE });
    s.steward.onDescribe({ ...describeOf(SLOW_VALVE, 3), safety_rules: [...RULES, SHUT] });
    const flags = { running: true };
    s.applier.planner = (a: Body) => (a.target === VALVE && flags.running ? { verdict: "refuse", reason: "safety" } : judgeAction(a));
    fire(s.applier, "shut", VALVE, "open", false, false);
    await s.pump();
    s.clock.advance(1_260_000);
    await vi.waitFor(async () => expect(await leasesOf(s.ok)).toEqual({}));
    const endedAt = s.clock.now();
    await s.define([up("rule", { id: "reopen", name: "Открыть", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
      actions: [{ target: VALVE, action: "valve.open", args: {} }] })]);
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
    await s.pump();
    await vi.waitFor(() => expect(fired(s)).toBe(1));
    return { ...s, flags, endedAt };
  }
  const settle = async (s: { clock: { advance(ms: number): void }; pump(): Promise<void> }) => {
    for (let i = 0; i < 5; i++) { s.clock.advance(0); await s.pump(); }
  };

  it("lets the wait go at the latchless bound plus the late-ack window after the early end, re-evaluating its rules, a refusal then noticed", async () => {
    const s = await waiting();
    s.clock.advance(1_260_000 + 60_000 - (s.clock.now() - s.endedAt) - 1);
    await settle(s);
    expect(fired(s)).toBe(1);
    s.clock.advance(1);
    await vi.waitFor(() => { s.clock.advance(0); expect(fired(s)).toBe(2); });
    await vi.waitFor(() => { s.clock.advance(60_000); expect(told(s).length).toBeGreaterThan(0); });
  });

  it("lets the wait go when the device is seen dead, re-evaluating its rules", async () => {
    const s = await waiting();
    s.flags.running = false;
    s.applier.emit({ type: "liveness", target: VALVE, old: "live", new: "dead" });
    await s.pump();
    s.applier.emit({ type: "liveness", target: VALVE, old: "dead", new: "live" });
    await s.pump();
    await vi.waitFor(() => { s.clock.advance(0); expect(fired(s)).toBe(2); });
  });
});

describe("a latchless rule's lease past its end, beneath another rule's (the code review, CR4)", () => {
  it("grants the rule again though its expired lease lies beneath, so the device keeps it when the other rule's ends", async () => {
    const s = await safeSetup();
    const guard = { id: "guard", trigger: {}, actions: [{ target: LAMP, action: "onoff.turn_on" }], latch: { condition: {} } };
    s.steward.onDescribe({ ...describeOf(SAFE_DEVICES, 3), safety_rules: [...RULES, guard] });
    fire(s.applier, "night", LAMP, "on", true, false);
    await s.pump();
    fire(s.applier, "guard", LAMP, "on", true, true);
    await s.pump();
    expect(holder((await leasesOf(s.ok))[LAMP].holder)).toBe("guard");
    // night's lease beneath guard's passes its end; night fires again.
    s.clock.advance(LATCHLESS_SAFETY_MS + 1);
    fire(s.applier, "night", LAMP, "on", true, false);
    await s.pump();
    s.applier.emit({ type: "latch", rule_id: "guard", latch: "cleared", devices: [LAMP] });
    await s.pump();
    expect(holder((await leasesOf(s.ok))[LAMP]?.holder)).toBe("night");
  });
});

describe("a latch as applier 0.14 gives it, naming no devices (the milestone 7+10+11 review, I6)", () => {
  it("leases the devices describe's rule actuates for a latch event naming none", async () => {
    const s = await safeSetup();
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "set" });
    await s.pump();
    expect(await leasesOf(s.ok)).toEqual({ [VALVE]: { holder: { safety_rule: "leak" }, precedence: "safety_rule", expires: "safety_rule" } });
    s.applier.emit({ type: "latch", rule_id: "leak", latch: "cleared" });
    await s.pump();
    expect(await leasesOf(s.ok)).toEqual({});
  });

  it("leases them for a latch state lists with no devices, as after a restart", async () => {
    const { ok, steward } = await safeSetup();
    steward.onState({ targets: {}, transports: [], latches: [{ rule_id: "leak", since: "2030-01-01T07:00:00.000Z" }] });
    expect(await leasesOf(ok)).toEqual({ [VALVE]: { holder: { safety_rule: "leak" }, precedence: "safety_rule", expires: "safety_rule" } });
  });
});

describe("a latchless lease ended early over another rule's (the code review, CR4)", () => {
  it("records the early end when the lease beneath comes back, so a refusal after that one ends waits for the completion", async () => {
    const s = await safeSetup();
    const guard = { id: "guard", trigger: {}, actions: [{ target: LAMP, action: "onoff.turn_on" }], latch: { condition: {} } };
    s.steward.onDescribe({ ...describeOf(SAFE_DEVICES, 3), safety_rules: [...RULES, guard] });
    let night = true;
    s.applier.planner = (a: Body) => (a.target === LAMP && night ? { verdict: "refuse", reason: "safety" } : judgeAction(a));
    fire(s.applier, "guard", LAMP, "on", true, true);
    await s.pump();
    fire(s.applier, "night", LAMP, "on", true, false);
    await s.pump();
    expect(holder((await leasesOf(s.ok))[LAMP].holder)).toBe("night");
    // night's lease runs out, its completion not read: guard's comes back; then guard's latch clears.
    s.clock.advance(LATCHLESS_SAFETY_MS + 1);
    await vi.waitFor(async () => expect(holder((await leasesOf(s.ok))[LAMP].holder)).toBe("guard"));
    s.applier.emit({ type: "latch", rule_id: "guard", latch: "cleared", devices: [LAMP] });
    await s.pump();
    await vi.waitFor(async () => expect(await leasesOf(s.ok)).toEqual({}));
    await s.define([up("rule", { id: "lit", name: "Свет", conditions: [{ target: VALVE, key: "open", op: "eq", value: false }],
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] })]);
    const fired = () => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("rule:lit:")).length;
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.applier.emit({ type: "state", target: VALVE, key: "open", value: false, basis_time: new Date(s.clock.now()).toISOString(), cause: "device" });
    await s.pump();
    await vi.waitFor(async () => expect((await eventsSince(s.ok, cursor, "outcome")).filter((e) => e.cause?.rule === "lit")
      .map((e) => `${e.outcome}(${e.reason})`)).toEqual(["refused(safety)"]));
    night = false;
    s.applier.emit({ type: "rule_fired", rule_id: "night", outcomes: [{ step_id: "s1", target: LAMP, outcome: "acked" }], notice: null });
    await s.pump();
    await vi.waitFor(() => { s.clock.advance(0); expect(fired()).toBe(2); });
    s.clock.advance(120_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:")).map((a) => JSON.stringify(a.request.actions))
      .filter((x) => !x.includes("fresh_s is not known"))).toEqual([]);
  });
});
