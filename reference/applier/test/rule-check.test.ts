import { describe, expect, it } from "vitest";
import { judgeOwn } from "../src/dispatch/dispatcher.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, home, LEAK, refused, thermo } from "./safe-home.js";

// covers: M2 and GA-SAFE-13's rule_disabled within one life; a disabled rule kept for a restart (migration 0012) is GA-PERSIST-1's (slice 7), untested here.

/** A leak rule setting the thermostat's mode, which it may or may not take. */
const modeRule = (mode: string, id = "leak-stops-heat") => ({ op: "upsert", kind: "safety_rule", value: { id, trigger: LEAK,
  actions: [{ target: "hall:thermo", action: "climate.set_mode", args: { mode } }] } });
/** The thermostat re-declared by its bridge: a code re-taught, or a firmware's other modes. */
const redeclare = (m: Awaited<ReturnType<typeof home>>, action: Record<string, unknown>) =>
  m.send("devices", { devices: DEVICES.map((d) => (d.id === "thermo" ? { ...thermo, actions: [{ ...thermo.actions[0], ...action }] } : d)) }, true);

describe("a safety rule's args, against its device's declarations (M2)", () => {
  it("refuses at configure args the device's own args refuse, as a client's plan is refused invalid_args", async () => {
    const m = await home();
    await refused(m.configure([modeRule("cool")]), /hall:thermo climate.set_mode: mode is not one of heat, off on this device/);
    body(await m.configure([modeRule("off")]));
  });

  it("refuses a replacement whose new hardware refuses a rule's args (GA-ADOPT-2)", async () => {
    const m = await home();
    body(await m.configure([modeRule("off")]));
    const other = { ...thermo, id: "thermo-2", stableIdentifier: "test:thermo-2",
      actions: [{ ...thermo.actions[0], args: { mode: ["heat", "cool"] } }] };
    m.send("devices", { devices: [...DEVICES, other] }, true);
    await refused(m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:thermo-2", class: "ac", replaces: "hall:thermo" } }]),
      /mode is not one of heat, cool on this device/);
  });

  it("refuses at dispatch a rule's step whose args its device now refuses: refused(invalid_args), never sent", () => {
    const d = { actions: new Map([["climate.set_mode", { tier: "reversible" as const, stateless: false, toggles: false,
      args: { mode: { enum: ["heat"] } } }]]), adopted: true, liveness: "live" as const, feedback: "closed" as const,
      duplicateRoute: false, values: new Map() };
    const asked = (mode: string) => ({ target: "hall:thermo", action: "climate.set_mode", args: { mode }, via: "app", brain: false,
      for: { safety_rule: "r" } }) as never;
    expect(judgeOwn(asked("off"), d)).toEqual({ verdict: "refuse", reason: "invalid_args" });
    expect(judgeOwn(asked("heat"), d)).toEqual({ verdict: "op" });
  });
});

describe("a safety rule disabled on a declaration change (GA-SAFE-13)", () => {
  it("disables a rule whose args its device no longer takes: a rule_disabled notice, describe says why, the revision moves, and it fires no more", async () => {
    const m = await home();
    body(await m.configure([modeRule("off")]));
    const c = await m.cursor();
    const { revision } = body(await m.a.call(m.owner, "describe", {}));
    redeclare(m, { args: { mode: ["heat"] } });
    const [n] = await m.notices("rule_disabled");
    expect(n).toMatchObject({ rule_id: "leak-stops-heat", devices: ["hall:thermo"] });
    expect(n.text).toMatch(/mode is not one of heat on this device/);
    const d = body(await m.a.call(m.owner, "describe", {}));
    expect(d.safety_rules[0].disabled).toMatch(/mode is not one of heat/);
    expect(d.revision).toBeGreaterThan(revision);
    expect((await m.events(c, "model")).some((e: any) => e.safety_rule === "leak-stops-heat" && e.disabled === true)).toBe(true);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent).toEqual([]);
  });

  // One home per test: several in one outlast the test's bound under a parallel run.
  it.each([undefined, "keeps-a-rule-on-a-re-taught-code" as const])(
    "disables a rule whose action is now declared toggles: true, but under keeps-a-rule-on-a-re-taught-code; neither sends the toggle, mutation %s", async (mutation) => {
      const m = await home({ mutation });
      body(await m.configure([modeRule("off")]));
      redeclare(m, { toggles: true, idempotent: false });
      expect((await m.notices("rule_disabled")).length).toBe(mutation ? 0 : 1);
      m.report("leak", { leak: true });
      await flush();
      expect(m.sent).toEqual([]);
      if (mutation) expect((await m.notices("safety_rule"))[0].outcomes).toMatchObject([{ outcome: "refused", reason: "toggle_only" }]);
    });

  it("stays disabled, the declarations' return included, until the owner sets it again; refused while it does not fit", async () => {
    const m = await home();
    body(await m.configure([modeRule("off")]));
    redeclare(m, { args: { mode: ["heat"] } });
    await refused(m.configure([modeRule("off")]), /mode is not one of heat on this device/);
    redeclare(m, {});
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules[0].disabled).toBeDefined();
    expect((await m.notices("rule_disabled")).length).toBe(1);
    body(await m.configure([modeRule("off")]));
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules[0].disabled).toBeUndefined();
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.map((x) => [x.device, x.body.value.action])).toEqual([["thermo", "climate.set_mode"]]);
  });

  it("keeps a rule whose devices' declarations changed in a way it does not use", async () => {
    const m = await home();
    body(await m.configure([modeRule("off")]));
    redeclare(m, { args: { mode: ["heat", "off", "auto"] } });
    expect(await m.notices("rule_disabled")).toEqual([]);
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules[0].disabled).toBeUndefined();
  });

  it("disables at start a rule whose disable a crash lost, the devices written and the rule not: the retained document says nothing new", async () => {
    const db = lasting(await memoryDb());
    // The mutation stands in for the crash: the new declarations are written, the disable is not.
    const m = await home({ db, mutation: "keeps-a-rule-on-a-re-taught-code" });
    body(await m.configure([modeRule("off")]));
    redeclare(m, { args: { mode: ["heat"] } });
    await flush();
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false });
    expect(body(await again.a.call(again.owner, "describe", {})).safety_rules[0].disabled).toMatch(/mode is not one of heat/);
    expect((await again.notices("rule_disabled")).map((n: any) => n.rule_id)).toEqual(["leak-stops-heat"]);
  });
});
