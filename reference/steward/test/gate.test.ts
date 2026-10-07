import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.js";
import { judge, leased, REASON_ORDER, type ApplierStep } from "../src/gate/reasons.js";
import { resolveRequest, type Resolved } from "../src/gate/resolve.js";
import { furnished } from "./house.js";

type Body = Record<string, any>;

/** The applier's devices as the mirror holds them. */
const device = (id: string, cls: string | null, capabilities: string[], extra: Body = {}): [string, Body] =>
  [id, { id, class: cls, capabilities, adopted: true, ...extra }];
const DEVICES = new Map<string, Body>([
  device("sim-bridge:lamp", "light", ["onoff"]),
  device("sim-bridge:dimmer", "light", ["onoff", "level"]),
  device("sim-bridge:channel", "channel", ["notify"]),
  device("sim-bridge:rack", "socket", ["onoff"], { infrastructure: true }),
  device("sim-bridge:entry", "socket", ["onoff"], { internal: true }),
  device("sim-bridge:stray", null, ["onoff"], { adopted: false }),
  device("sim-bridge:tv", "tv", ["onoff"], { extensions: [{ capability: "org.galatea.test.remote" }] }),
]);

/** The furnished house, with the rack and the relay's entry in the hall too, as the owner put them there before they were marked. */
function house() {
  const h = furnished();
  for (const id of ["sim-bridge:rack", "sim-bridge:entry", "sim-bridge:stray"]) h.targets.set(id, { id, room: "hall" });
  h.groups.get("hall-lights")!.members = ["sim-bridge:dimmer", "sim-bridge:entry", "sim-bridge:lamp", "sim-bridge:rack", "sim-bridge:stray"];
  return h;
}

const on = (x: Body) => ({ action: "onoff.turn_on", args: {}, ...x });
const resolve = (actions: Body[], mutation?: "selects-internal") =>
  resolveRequest(actions as never, { devices: DEVICES, house: house(), mutation }).map((r) => r.target);

describe("resolveRequest", () => {
  it("resolves a selector to every device matching all its fields, in code-point order, never a group (GA-PLAN-5)", () => {
    expect(resolve([on({ selector: { room: "hall" } })])).toEqual(["sim-bridge:dimmer", "sim-bridge:lamp"]);
    expect(resolve([on({ selector: { class: "light" } })])).toEqual(["sim-bridge:dimmer", "sim-bridge:lamp"]);
    expect(resolve([on({ selector: { capability: "level" } })])).toEqual(["sim-bridge:dimmer"]);
    expect(resolve([on({ selector: { room: "hall", capability: "notify" } })])).toEqual([]);
    expect(resolve([on({ selector: { capability: "notify" } })])).toEqual(["sim-bridge:channel"]);
    // An extension's capability is the device's too.
    expect(resolve([on({ selector: { capability: "org.galatea.test.remote" } })])).toEqual(["sim-bridge:tv"]);
    expect(resolve([on({ selector: { room: "kitchen" } })])).toEqual([]);
  });

  it("leaves infrastructure, internal and unadopted devices out of selectors and groups, and reaches them by id (GA-PLAN-6)", () => {
    expect(resolve([on({ selector: { capability: "onoff" } })])).toEqual(["sim-bridge:dimmer", "sim-bridge:lamp", "sim-bridge:tv"]);
    expect(resolve([on({ target: "hall-lights" })])).toEqual(["sim-bridge:dimmer", "sim-bridge:lamp"]);
    expect(resolve([on({ target: "sim-bridge:rack" }), on({ target: "sim-bridge:entry" })])).toEqual(["sim-bridge:rack", "sim-bridge:entry"]);
    expect(resolve([on({ target: "sim-bridge:gone" })])).toEqual(["sim-bridge:gone"]);
  });

  it("lets a device win over a group of its id, which cannot be targeted until it is renamed", () => {
    const h = house();
    h.groups.set("sim-bridge:tv", { id: "sim-bridge:tv", name: "ТВ", aliases: [], room: null, members: ["sim-bridge:lamp"], aggregate: "any" });
    expect(resolveRequest([on({ target: "sim-bridge:tv" })] as never, { devices: DEVICES, house: h }).map((r) => r.target)).toEqual(["sim-bridge:tv"]);
  });

  it("takes internal devices into selectors and groups under selects-internal", () => {
    expect(resolve([on({ selector: { room: "hall" } })], "selects-internal")).toEqual(["sim-bridge:dimmer", "sim-bridge:entry", "sim-bridge:lamp"]);
    expect(resolve([on({ target: "hall-lights" })], "selects-internal")).toEqual(["sim-bridge:dimmer", "sim-bridge:entry", "sim-bridge:lamp"]);
  });

  it("gives one step per distinct target, action and args, in request order, and marks one target and action with two args a conflict (GA-STW-2)", () => {
    const level = (target: string, level: number) => ({ target, action: "level.set_level", args: { level } });
    const r: Resolved[] = resolveRequest([on({ target: "sim-bridge:lamp" }), on({ target: "hall-lights" }), level("sim-bridge:dimmer", 10),
      level("sim-bridge:dimmer", 20), level("sim-bridge:dimmer", 10)] as never, { devices: DEVICES, house: house() });
    expect(r).toEqual([
      { target: "sim-bridge:lamp", action: "onoff.turn_on", args: {}, conflict: false },
      { target: "sim-bridge:dimmer", action: "onoff.turn_on", args: {}, conflict: false },
      { target: "sim-bridge:dimmer", action: "level.set_level", args: { level: 10 }, conflict: true },
      { target: "sim-bridge:dimmer", action: "level.set_level", args: { level: 20 }, conflict: true },
    ]);
  });
});

const owner: Principal = { endpoint: "owner-app", person: "owner", via: "app", brain: false, role: "owner" };
const guest: Principal = { endpoint: "hall-panel", person: null, via: "panel", brain: false, role: "guest" };
const visitor: Principal = { ...guest, role: "visitor" };
const voice: Principal = { endpoint: "kitchen-voice", person: "olga", speaker: "olga", via: "voice", brain: true, role: "member" };
const chat: Principal = { endpoint: "olga-chat", person: "olga", via: "app", brain: true, role: "member" };

const step = (o: Partial<Resolved> = {}): Resolved => ({ target: "sim-bridge:lamp", action: "onoff.turn_on", args: {}, conflict: false, ...o });
const applier = (tier: ApplierStep["tier"], verdict: ApplierStep["verdict"] = "op", reason?: ApplierStep["reason"]): ApplierStep =>
  ({ step_id: "s1", target: "sim-bridge:lamp", action: "onoff.turn_on", args: {}, verdict, tier, stale: false, basis: "real", ...(reason ? { reason } : {}) });
const short = (s: { verdict: string; reason?: string }) => (s.reason ? `${s.verdict}(${s.reason})` : s.verdict);
const described = () => undefined;
/** A person's precedence, no device leased. */
const FREE = { precedence: "person" as const, leaseOf: () => undefined };
const verdict = (p: Principal, a: ApplierStep | undefined, o: Partial<Resolved> = {}, mutation?: Parameters<typeof judge>[3]["mutation"]) =>
  short(judge("s1", step(o), a, { ...FREE, principal: p, mutation, tierOf: () => "confirm", described }));

describe("judge: the steward's reason order (GA-STW-4)", () => {
  it("lists its order in one place", () => {
    expect(REASON_ORDER).toEqual(["unknown_target, unsupported_action, not_adopted, invalid_args", "conflict",
      "dead, duplicate_route, safety, latched", "role", "tier", "already", "leased", "occupancy", "toggle_only", "token"]);
  });

  it("reports the applier's first reasons before a conflict, a conflict before dead, dead before role, role before tier", () => {
    expect(verdict(owner, applier("reversible", "skip", "unknown_target"), { conflict: true })).toBe("skip(unknown_target)");
    expect(verdict(owner, applier("reversible", "refuse", "invalid_args"), { conflict: true })).toBe("refuse(invalid_args)");
    expect(verdict(owner, applier("reversible", "skip", "dead"), { conflict: true })).toBe("refuse(conflict)");
    expect(verdict(guest, applier("confirm", "skip", "dead"))).toBe("skip(dead)");
    expect(verdict(guest, applier("confirm", "refuse", "latched"))).toBe("refuse(latched)");
    expect(verdict(guest, applier("confirm", "refuse", "token"))).toBe("refuse(role)");
    expect(verdict(guest, applier("reversible"))).toBe("op");
  });

  it("refuses a visitor every step, and a guest every step above reversible (GA-TIER-3)", () => {
    expect(verdict(visitor, applier("reversible"))).toBe("refuse(role)");
    expect(verdict(guest, applier("no_voice", "refuse", "token"))).toBe("refuse(role)");
    expect(verdict(visitor, applier("reversible"), {}, "visitor-acts")).toBe("op");
    expect(verdict(visitor, applier("confirm", "refuse", "token"), {}, "visitor-acts")).toBe("refuse(role)");
  });

  it("refuses a no_voice step through a brain or by voice, and asks an unanswered confirm or no_voice step, never token (GA-TIER-1, GA-TIER-2)", () => {
    expect(verdict(voice, applier("no_voice", "refuse", "tier"))).toBe("refuse(tier)");
    expect(verdict(chat, applier("no_voice", "refuse", "tier"))).toBe("refuse(tier)");
    // The steward's own reading, even where the applier said otherwise.
    expect(verdict(chat, applier("no_voice", "refuse", "token"))).toBe("refuse(tier)");
    expect(verdict(owner, applier("no_voice", "refuse", "token"))).toBe("ask(confirm_tier)");
    expect(verdict(voice, applier("confirm", "refuse", "token"))).toBe("ask(confirm_tier)");
    // A conforming applier never asks a token of a reversible step (applier GA-TOKEN-1): fail closed, never ask at reversible.
    expect(verdict(owner, applier("reversible", "refuse", "token"))).toBe("refuse(tier)");
  });

  it("asks a no_voice step through a brain under unlocks-by-voice", () => {
    expect(verdict(voice, applier("no_voice", "refuse", "tier"), {}, "unlocks-by-voice")).toBe("ask(confirm_tier)");
    expect(verdict(chat, applier("no_voice", "refuse", "token"), {}, "unlocks-by-voice")).toBe("ask(confirm_tier)");
  });

  it("asks the tier before already: a confirm step that would change nothing is still asked", () => {
    expect(verdict(owner, applier("confirm", "skip", "already"))).toBe("ask(confirm_tier)");
    expect(verdict(owner, applier("reversible", "skip", "already"))).toBe("skip(already)");
  });

  it("asks a toggle in its own words, in place of the tier's ask, never as a refusal", () => {
    expect(verdict(owner, applier("reversible", "refuse", "toggle_only"))).toBe("ask(toggle_only)");
    expect(verdict(owner, applier("confirm", "refuse", "toggle_only"))).toBe("ask(toggle_only)");
    // A refusal before it still stands.
    expect(verdict(guest, applier("confirm", "refuse", "toggle_only"))).toBe("refuse(role)");
    expect(verdict(voice, applier("no_voice", "refuse", "tier"))).toBe("refuse(tier)");
    expect(verdict(owner, applier("reversible", "refuse", "toggle_only"), {}, "refuses-the-toggle")).toBe("refuse(toggle_only)");
  });

  it("judges a step the applier did not plan by the mirror first, keeping the order: then conflict, then dead, with the tier the mirror read", () => {
    const s = judge("s1", step(), undefined, { ...FREE, principal: owner, tierOf: () => "confirm", described });
    expect(s).toEqual({ step_id: "s1", target: "sim-bridge:lamp", action: "onoff.turn_on", args: {}, verdict: "skip", reason: "dead",
      tier: "confirm", stale: false, basis: "real" });
    expect(short(judge("s1", step({ conflict: true }), undefined, { ...FREE, principal: owner, tierOf: () => "confirm", described }))).toBe("refuse(conflict)");
    const mirror = (said: "unknown_target" | "unsupported_action" | "not_adopted") =>
      short(judge("s1", step({ conflict: true }), undefined, { ...FREE, principal: guest, tierOf: () => "confirm", described: () => said }));
    expect([mirror("unknown_target"), mirror("unsupported_action"), mirror("not_adopted")])
      .toEqual(["skip(unknown_target)", "skip(unsupported_action)", "refuse(not_adopted)"]);
  });

  it("passes the applier's tier, stale and basis through", () => {
    expect(judge("s7", step(), { ...applier("confirm", "refuse", "token"), stale: true, basis: "emulated" }, { ...FREE, principal: owner, tierOf: () => "reversible", described }))
      .toEqual({ step_id: "s7", target: "sim-bridge:lamp", action: "onoff.turn_on", args: {}, verdict: "ask", reason: "confirm_tier",
        tier: "confirm", stale: true, basis: "emulated" });
  });
});

describe("leased: a lease refuses a lower precedence (GA-LEASE-3)", () => {
  const lease = { holder: { person: "olga", endpoint: "olga-app" }, precedence: "person" as const };
  const of = (p: "rule" | "person" | "scheduled_run" | "safety_rule", action = "onoff.turn_on", mutation?: "ignores-leases") =>
    leased("sim-bridge:lamp", action, { precedence: p, leaseOf: () => lease, mutation });

  it("refuses a lower precedence with the lease's holder, and lets an equal or higher one through", () => {
    expect(of("rule")).toEqual({ verdict: "refuse", reason: "leased", holder: lease.holder });
    expect(of("scheduled_run")).toEqual({ verdict: "refuse", reason: "leased", holder: lease.holder });
    expect(of("person")).toBeUndefined();
    expect(of("safety_rule")).toBeUndefined();
  });

  it("never refuses a session.lock, and never anything under ignores-leases", () => {
    expect(of("rule", "session.lock")).toBeUndefined();
    expect(of("rule", "onoff.turn_on", "ignores-leases")).toBeUndefined();
  });

  it("reports leased after already and before toggle_only, with its holder on the step", () => {
    const j = { principal: owner, precedence: "rule" as const, leaseOf: () => lease, tierOf: () => "reversible" as const, described };
    expect(judge("s1", step(), applier("reversible"), j)).toMatchObject({ verdict: "refuse", reason: "leased", holder: lease.holder });
    expect(short(judge("s1", step(), applier("reversible", "skip", "already"), j))).toBe("skip(already)");
  });
});
