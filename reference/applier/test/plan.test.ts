import { describe, expect, it } from "vitest";
import { planSteps, type Gate, type GateDevice, type Requested } from "../src/gate/plan.js";
import { proofOf } from "../src/gate/token.js";
import { type Mutation, mutantOf } from "../src/mutations.js";

const KEY = "a-token-key-of-the-steward";
const NOW = Date.parse("2030-01-01T08:00:00Z");

/** A live, adopted, closed lamp, off, with `onoff` at reversible, unless `extra` says otherwise. */
function device(extra: Partial<GateDevice> = {}): GateDevice {
  return {
    actions: new Map([["onoff.turn_on", { tier: "reversible", stateless: false, toggles: false }],
      ["onoff.turn_off", { tier: "reversible", stateless: false, toggles: false }]]),
    adopted: true, liveness: "live", feedback: "closed", duplicateRoute: false, values: new Map([["on", false]]), ...extra,
  };
}

function gate(devices: Record<string, GateDevice>, mutation?: Mutation): Gate {
  return { device: (id) => devices[id], client: "steward", key: KEY, now: NOW, used: () => false, mutant: mutantOf(mutation) };
}

const ask = (target: string, action = "onoff.turn_on", extra: Partial<Requested> = {}): Requested =>
  ({ target, action, args: {}, via: "app", brain: false, for: { person: "demo" }, ...extra });

/** A valid token for `a`, as the steward signs it; `extra` changes it before it is signed. */
function signed(a: Requested, extra: Record<string, unknown> = {}) {
  const unsigned = { token_id: `t-${Math.random()}`, issuer: "steward", target: a.target, action: a.action, args: a.args, via: a.via,
    brain: a.brain, for: a.for, expires: new Date(NOW + 60_000).toISOString(), ...extra };
  return { ...unsigned, proof: proofOf(unsigned as never, KEY) };
}

const one = (g: Gate, a: Requested) => planSteps([a], g)[0]!;
const why = (g: Gate, a: Requested) => { const s = one(g, a); return `${s.verdict}${s.reason ? `(${s.reason})` : ""}`; };

describe("planSteps", () => {
  it("gives one step per distinct target, action, args, via, brain, for and token, in request order (GA-PLAN-2)", () => {
    const g = gate({ "hall:lamp": device() });
    const steps = planSteps([ask("hall:lamp"), ask("hall:lamp"), ask("hall:lamp", "onoff.turn_on", { via: "panel" }), ask("hall:ghost")], g);
    expect(steps.map((s) => [s.step_id, s.target, s.verdict, s.reason])).toEqual([
      ["s1", "hall:lamp", "op", undefined], ["s2", "hall:lamp", "op", undefined], ["s3", "hall:ghost", "skip", "unknown_target"]]);
  });

  it("says each step is real, with its tier and whether its device is stale (GA-PLAN-3)", () => {
    const g = gate({ "hall:lamp": device({ liveness: "stale" }) });
    expect(one(g, ask("hall:lamp"))).toEqual({ step_id: "s1", target: "hall:lamp", action: "onoff.turn_on", args: {},
      verdict: "op", tier: "reversible", stale: true, basis: "real" });
  });

  it("gives the first reason of the standard's order when a step has several, each next one as the one before is put right", () => {
    // Every fault at once (true: present): not adopted, dead, on a duplicate route, guarded, latched, no_voice asked by voice, already on, no token.
    const faults = { adopted: true, dead: true, duplicateRoute: true, guarded: true, latched: true, voice: true, on: true };
    const step = () => {
      const d = device({ adopted: !faults.adopted, liveness: faults.dead ? "dead" : "live", duplicateRoute: faults.duplicateRoute,
        guarded: faults.guarded, latched: () => faults.latched, values: new Map([["on", faults.on]]),
        actions: new Map([["onoff.turn_on", { tier: faults.voice ? "no_voice" : "confirm", stateless: false, toggles: false }]]) });
      return why(gate({ "hall:lamp": d }), ask("hall:lamp", "onoff.turn_on", faults.voice ? { via: "voice" } : {}));
    };
    const seen: string[] = [step()];
    for (const k of ["adopted", "dead", "duplicateRoute", "guarded", "latched", "voice", "on"] as const) {
      faults[k] = false;
      seen.push(step());
    }
    expect(seen).toEqual(["refuse(not_adopted)", "skip(dead)", "refuse(duplicate_route)", "refuse(safety)", "refuse(latched)",
      "refuse(tier)", "skip(already)", "refuse(token)"]);
  });

  it("refuses a latch's undo latched, after safety and before tier, its tier no_voice (GA-SAFE-7)", () => {
    const latched = () => true;
    const g = gate({ "hall:guarded": device({ guarded: true, latched }), "hall:latched": device({ latched }) });
    expect(why(g, ask("hall:guarded"))).toBe("refuse(safety)");
    expect(one(g, ask("hall:latched", "onoff.turn_on", { via: "voice" }))).toMatchObject({ verdict: "refuse", reason: "latched", tier: "no_voice" });
  });

  it("reports the first reason that applies (GA-PLAN-4)", () => {
    const g = gate({
      "hall:new": device({ adopted: false, liveness: "dead" }),
      "hall:dead": device({ liveness: "dead", duplicateRoute: true }),
      "hall:twin": device({ duplicateRoute: true, values: new Map([["on", true]]) }),
      "hall:door": device({ actions: new Map([["lock.unlock", { tier: "no_voice", stateless: false, toggles: false }]]),
        values: new Map([["locked", false]]) }),
      "hall:held": device({ actions: new Map([["onoff.turn_off", { tier: "confirm", stateless: false, toggles: false }]]) }),
    });
    expect(why(g, ask("hall:new", "level.set_level"))).toBe("skip(unsupported_action)");
    expect(why(g, ask("hall:new"))).toBe("refuse(not_adopted)");
    expect(why(g, ask("hall:dead", "onoff.turn_on", { args: { level: 1 } }))).toBe("refuse(invalid_args)");
    expect(why(g, ask("hall:dead"))).toBe("skip(dead)");
    expect(why(g, ask("hall:twin"))).toBe("refuse(duplicate_route)");
    // Already unlocked, asked by voice with no token: tier comes before already and token.
    expect(why(g, ask("hall:door", "lock.unlock", { via: "voice" }))).toBe("refuse(tier)");
    // Already off, with no token for its confirm tier: already comes before token.
    expect(why(g, ask("hall:held", "onoff.turn_off"))).toBe("skip(already)");
  });

  it("refuses invalid_args for a value the device's own constraints do not allow", () => {
    const ac = device({ actions: new Map([["climate.set_mode", { tier: "reversible", stateless: false, toggles: false,
      args: { mode: { enum: ["off", "cool"] } } }]]), values: new Map() });
    expect(why(gate({ ac }), ask("ac", "climate.set_mode", { args: { mode: "heat" } }))).toBe("refuse(invalid_args)");
    expect(why(gate({ ac }), ask("ac", "climate.set_mode", { args: { mode: "cool" } }))).toBe("op");
  });

  it("evaluates already only on a live, closed device's observed value, and never for a stateless action", () => {
    const on = new Map<string, unknown>([["on", true]]);
    expect(why(gate({ d: device({ values: on }) }), ask("d"))).toBe("skip(already)");
    expect(why(gate({ d: device({ values: on, liveness: "stale" }) }), ask("d"))).toBe("op");
    expect(why(gate({ d: device({ values: on, feedback: "open" }) }), ask("d"))).toBe("op");
    const stop = device({ actions: new Map([["cover.stop", { tier: "reversible", stateless: true, toggles: false }]]),
      values: new Map([["position", 0]]) });
    expect(why(gate({ d: stop }), ask("d", "cover.stop"))).toBe("op");
  });

  it("refuses a confirm or no_voice action without a token that stands, and takes one that does (GA-TOKEN-1, GA-TOKEN-2)", () => {
    const actions = new Map([["cover.close", { tier: "confirm" as const, stateless: false, toggles: false }],
      ["cover.open", { tier: "no_voice" as const, stateless: false, toggles: false }]]);
    const g = gate({ gate: device({ actions, values: new Map([["position", 50]]) }) });
    const close = ask("gate", "cover.close");
    expect(one(g, close)).toMatchObject({ verdict: "refuse", reason: "token", tier: "confirm" });
    expect(why(g, { ...close, token: signed(close) })).toBe("op");
    expect(why(g, { ...close, token: signed(close, { issuer: "other" }) })).toBe("refuse(token)");
    const open = ask("gate", "cover.open");
    expect(why(g, { ...open, token: signed(open) })).toBe("op");
    // GA-TOKEN-3: a no_voice action by voice or through a brain is refused whatever its token.
    const byVoice = ask("gate", "cover.open", { via: "voice" });
    expect(why(g, { ...byVoice, token: signed(byVoice) })).toBe("refuse(tier)");
    const byBrain = ask("gate", "cover.open", { brain: true });
    expect(why(g, { ...byBrain, token: signed(byBrain) })).toBe("refuse(tier)");
  });

  it("refuses a toggle on an open device without a person's token, after already and before token (GA-PLAN-8)", () => {
    const tv = device({ feedback: "open", values: new Map(),
      actions: new Map([["onoff.turn_off", { tier: "reversible", stateless: false, toggles: true }]]) });
    const g = gate({ tv });
    const off = ask("tv", "onoff.turn_off");
    expect(why(g, off)).toBe("refuse(toggle_only)");
    expect(why(g, { ...off, token: signed(off) })).toBe("op");
    const byRule = ask("tv", "onoff.turn_off", { via: "rule", for: { rule: "evening" } });
    expect(why(g, { ...byRule, token: signed(byRule) })).toBe("refuse(toggle_only)");
    const byRun = ask("tv", "onoff.turn_off", { via: "schedule", for: { run: "r-1" } });
    expect(why(g, { ...byRun, token: signed(byRun) })).toBe("refuse(toggle_only)");
    const byPanel = ask("tv", "onoff.turn_off", { via: "panel", for: { run: "r-1", endpoint: "hall-panel" } });
    expect(why(g, { ...byPanel, token: signed(byPanel) })).toBe("op");
    // A closed device's toggle is planned from its observed state, as any other.
    const socket = device({ actions: new Map([["onoff.turn_off", { tier: "reversible", stateless: false, toggles: true }]]),
      values: new Map([["on", true]]) });
    expect(why(gate({ socket }), ask("socket", "onoff.turn_off"))).toBe("op");
    expect(why(gate({ socket }), ask("socket", "onoff.turn_off", { args: {} }))).toBe("op");
    expect(why(gate({ socket: { ...socket, values: new Map([["on", false]]) } }), ask("socket", "onoff.turn_off"))).toBe("skip(already)");
  });

  it("breaks exactly the step each mutation names, and leaves every other step as it was", () => {
    const tv = device({ feedback: "open", values: new Map(),
      actions: new Map([["onoff.turn_off", { tier: "reversible", stateless: false, toggles: true }]]) });
    const socket = device({ actions: new Map([["onoff.turn_off", { tier: "reversible", stateless: false, toggles: true }]]),
      values: new Map([["on", true]]) });
    const actions = new Map([["cover.close", { tier: "confirm" as const, stateless: false, toggles: false }]]);
    const g = (m?: Mutation) => gate({ tv, socket, gate: device({ actions, values: new Map() }) }, m);
    const off = ask("tv", "onoff.turn_off");
    const close = ask("gate", "cover.close");
    const byRule = ask("tv", "onoff.turn_off", { via: "rule", for: { rule: "evening" } });
    const byPanel = ask("tv", "onoff.turn_off", { via: "panel", for: { run: "r-1", endpoint: "hall-panel" } });
    const cases: Record<string, Requested> = {
      "toggle, no token": off, "toggle, person's token": { ...off, token: signed(off) },
      "toggle, rule's token": { ...byRule, token: signed(byRule) }, "toggle, panel run's token": { ...byPanel, token: signed(byPanel) },
      "closed toggle": ask("socket", "onoff.turn_off"), "confirm, no token": close,
      "confirm, token": { ...close, token: signed(close) }, "confirm, another's token": { ...close, token: signed(close, { issuer: "other" }) },
    };
    const run = (m?: Mutation) => Object.fromEntries(Object.entries(cases).map(([name, a]) => [name, why(g(m), a)]));
    const base = run();
    expect(base).toEqual({
      "toggle, no token": "refuse(toggle_only)", "toggle, person's token": "op", "toggle, rule's token": "refuse(toggle_only)",
      "toggle, panel run's token": "op", "closed toggle": "op", "confirm, no token": "refuse(token)", "confirm, token": "op",
      "confirm, another's token": "refuse(token)",
    });
    const broken: Record<string, Record<string, string>> = {
      "toggles-to-reach-a-state": { "toggle, no token": "op", "toggle, rule's token": "op" },
      "answers-a-toggle-by-rule": { "toggle, rule's token": "op" },
      "refuses-a-panel-toggle": { "toggle, panel run's token": "refuse(toggle_only)" },
      "asks-a-closed-loop-toggle": { "closed toggle": "refuse(toggle_only)" },
      "applies-without-token": { "confirm, no token": "op", "confirm, another's token": "op" },
      "trusts-any-token": { "confirm, another's token": "op" },
    };
    for (const [m, changed] of Object.entries(broken)) expect(run(m as Mutation), m).toEqual({ ...base, ...changed });
  });
});
