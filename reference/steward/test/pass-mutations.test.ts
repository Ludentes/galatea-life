// The passing subjects (steward, *Negative subjects*: GA-LEASE-9, GA-LEASE-10, GA-LEASE-11): each
// mutation's case, through `underMutation` (R-35): a unit's beside its conforming answer, a wire
// scenario's against what its conforming test asserts.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RequestError } from "../src/core/errors.js";
import { planDefine } from "../src/house/define.js";
import type { Rule } from "../src/house/model.js";
import { isNarrowing } from "../src/leases/narrowing.js";
import { passing } from "../src/gate/reasons.js";
import { leaseRefuses, passedBy, type Met, type PassOptions, type Passing } from "../src/leases/table.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { isPressRule } from "../src/rules/engine.js";
import { baseline, context, up } from "./house.js";
import { NARROWING } from "./narrowing-rig.js";
import { BUTTON, HOLDER, KEY, OLGA, PRESS } from "./press-rig.js";
import { LAMP } from "./setup.js";
import { coveredIn, SUBJECT_MUTATIONS, underMutation, type Pointer, type Scenario } from "./under-mutation.js";

const cap: Met = { holder: "load_cap", precedence: "person" };
const safety: Met = { holder: { safety_rule: "night" }, precedence: "safety_rule" };
/** Whether `l` refuses a press's change. */
const refusesThePress = (l: Met) => (m?: Mutation) => leaseRefuses(l, "rule", { press: true }, { guestsPass: true, ...(m ? { mutation: m } : {}) });
/** A scenario's answer as the conforming build gives it, then under `m`. */
const both = async <O>(s: Scenario<O>, m: Mutation) => [await s(), await underMutation(s, m)];
/** A rule on the button's occurrence, not marked press. */
const plain = { id: "single", name: "single", trigger: { event: { target: BUTTON, type: "occurrence", key: KEY, value: "1_single" } },
  actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] } as unknown as Rule;
/** How `define` answers a press rule on the lamp's liveness: undefined when it takes it, else its refusal's code. */
const onLiveness = (m?: Mutation) => {
  try {
    planDefine(baseline(), [up("rule", { id: "dead", name: "dead", trigger: { event: { target: LAMP, type: "liveness", press: true } },
      actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] })], context(m ? { mutation: m } : {}));
    return undefined;
  } catch (e) {
    return (e as RequestError).code;
  }
};
const PRESS_LOCK = { rule: "bench-lock", press: { target: BUTTON, key: KEY, value: "1_single" } };

const member: Met = { holder: { person: "olga", endpoint: "olga-app" }, precedence: "person", role: "member", floorPassed: true };
const guest: Met = { holder: { endpoint: "hall-panel" }, precedence: "person", role: "guest", floorPassed: true };
const ext: Met = { holder: "external", precedence: "person", floorPassed: true, sinceMs: 1000 };
const run: Met = { holder: { run: "r1" }, precedence: "scheduled_run" };
const sw = (switches: ("rule" | "device" | "home")[]) => ({ ownerWork: true as const, switches });
const p = (l: Met, pass: object, m?: Mutation, o: PassOptions = {}) => passedBy(l, pass as Passing, { mutation: m, ...o });

const PASS_SUBJECTS: Mutation[] = ["refuses-the-press", "press-loses-the-hold", "brain-groups-a-press", "press-over-safety", "press-without-a-hold",
  "any-occurrence-is-a-press", "brain-press-overrides", "press-skips-conditions", "press-asks-the-tier", "names-the-presser", "press-on-liveness",
  "press-over-the-cap", "guest-hold-blocks-the-owner", "passes-undeclared", "brain-rule-passes-a-guest", "passes-a-member-hold",
  "named-speaker-is-a-guest", "holds-the-auto-lock", "narrows-a-heater", "narrowing-takes-a-hold", "narrows-over-safety", "closes-by-opens-with",
  "press-lock-holds", "press-hold-dies-with-rule", "press-cancels-on-unreachable", "passes-inside-the-floor", "two-leases-at-once",
  "narrows-over-a-run", "narrows-by-toggle"];

/** The subjects whose mutated-against-conforming case is already in another test file, beside the test it breaks. */
const GUESTS = { file: "./lease-table.test.ts", it: "passes the owner's work through a guest's hold whose floor passed, while declared; nothing else" };
const ELSEWHERE: Partial<Record<Mutation, Pointer>> = {
  "guest-hold-blocks-the-owner": GUESTS, "passes-undeclared": GUESTS, "passes-a-member-hold": GUESTS, "passes-inside-the-floor": GUESTS,
  "brain-rule-passes-a-guest": { file: "./guest-holds.test.ts", it: "passes the brain_authored rule under brain-rule-passes-a-guest" },
  "named-speaker-is-a-guest": { file: "./guest-holds.test.ts", it: "passes the hold of an apply naming a member through a brain under named-speaker-is-a-guest" },
  "two-leases-at-once": { file: "./guest-holds.test.ts", it: "replaces the guest's hold with the scheduled run's lease at its start under two-leases-at-once" },
  "narrows-over-safety": { file: "./narrowing.test.ts", it: "reach the door and leave the safety rule's lease standing under narrows-over-safety" },
  "narrows-over-a-run": { file: "./narrowing.test.ts", it: "reach the door and leave the run's lease standing under narrows-over-a-run" },
};

describe("the passing subjects", () => {
  it("are all declared, all in subject.json, twenty-nine", () => {
    expect(PASS_SUBJECTS).toHaveLength(29);
    for (const m of PASS_SUBJECTS) expect([MUTATIONS.includes(m), SUBJECT_MUTATIONS.includes(m)], m).toEqual([true, true]);
  });

  it("those run elsewhere are run there", () => coveredIn(ELSEWHERE));

  it("move leaseRefuses, isNarrowing, isPressRule and define where their rows say", async () => {
    expect(await both(refusesThePress(cap), "press-over-the-cap")).toEqual([true, false]);
    expect(await both(refusesThePress(safety), "press-over-safety")).toEqual([true, false]);
    expect(await both((m) => isNarrowing("lock.lock", { class: "door_lock" }, undefined, m), "holds-the-auto-lock")).toEqual([true, false]);
    expect(await both((m) => isNarrowing("onoff.turn_on", { class: "socket" }, undefined, m), "narrows-a-heater")).toEqual([false, true]);
    expect(await both((m) => isNarrowing("onoff.turn_off", { class: "water_valve", opens_with: "onoff.turn_off" }, undefined, m), "closes-by-opens-with"))
      .toEqual([false, true]);
    expect(await both((m) => isNarrowing("onoff.turn_off", { class: "water_valve" }, { toggles: true }, m), "narrows-by-toggle")).toEqual([false, true]);
    expect(await both((m) => isPressRule(plain, m), "any-occurrence-is-a-press")).toEqual([false, true]);
    expect(await both(onLiveness, "press-on-liveness")).toEqual(["invalid_request", undefined]);
  });

  it("move a press on the wire where their rows say", async () => {
    expect(await underMutation(PRESS.overAMembersHold, "refuses-the-press")).toMatchObject({ refused: [["bench-on", "leased"]], lease: { holder: OLGA } });
    expect(await underMutation(PRESS.pressed, "press-without-a-hold")).toBeUndefined();
    // The button has no room: the press's hold is named by its author, the first owner; its granted event carries role owner (validated).
    expect((await underMutation(PRESS.overAMembersHold, "names-the-presser")).lease.holder).toEqual({ person: "owner", endpoint: "owner-app" });
    expect(await underMutation(PRESS.alreadyDone, "press-loses-the-hold")).toBeUndefined();
    expect(await underMutation(PRESS.outsideItsConditions, "press-skips-conditions")).toBe(1);
    expect((await underMutation(PRESS.endsUnreachable, "press-cancels-on-unreachable")).holder).toBeUndefined();
    expect(await underMutation(PRESS.ruleDeleted, "press-hold-dies-with-rule")).toBeUndefined();
    expect((await underMutation(PRESS.confirmStep, "press-asks-the-tier")).outcomes).toEqual([["skipped", "not_confirmed"]]);
    expect(await underMutation(PRESS.brainWritten, "brain-press-overrides")).toEqual(HOLDER);
    expect(await underMutation(PRESS.brainJoinedGroup, "brain-groups-a-press")).toEqual(HOLDER);
  });

  it("move narrowing on the wire where their rows say", async () => {
    expect((await underMutation(NARROWING.pressLocks, "press-lock-holds")).holder).toEqual(PRESS_LOCK);
    expect((await underMutation(NARROWING.memberCloses, "narrowing-takes-a-hold")).lease?.holder).toEqual(OLGA);
  });
});

describe("passedBy (GA-LEASE-12)", () => {
  it("passes a person's hold past its floor by the first switch covering the step", () => {
    expect(p(member, sw(["rule", "device", "home"]))).toBe("rule");
    expect(p(member, sw(["device", "home"]))).toBe("device");
    expect(p(ext, sw(["home"]))).toBe("home");
    expect(p(guest, sw(["home"]), undefined, { guestsPass: true })).toBe("home");
    expect(p(guest, sw([]), undefined, { guestsPass: true })).toBe("guest");
    expect(p(member, sw([]), undefined, { guestsPass: true })).toBeUndefined();
  });
  it("passes nothing inside the floor, nor for work that is not the owner's", () => {
    expect(p({ ...member, floorPassed: false }, sw(["rule"]))).toBeUndefined();
    expect(p(member, { switches: ["rule"] })).toBeUndefined();
  });
  it("passes no load_cap, safety_rule or run's lease", () => {
    for (const l of [cap, safety, run]) expect(p(l, sw(["rule", "device", "home"]))).toBeUndefined();
  });
  it("moves where each mutation's row says", () => {
    expect(p(cap, sw(["rule"]), "owner-passes-the-cap")).toBe("rule");
    expect(p(run, sw(["rule"]), "owner-passes-a-run")).toBe("rule");
    expect(p(safety, sw(["rule"]), "owner-passes-safety")).toBe("rule");
    expect(p({ ...member, floorPassed: false }, sw(["rule"]), "passes-a-hold-in-its-floor")).toBe("rule");
    expect(p(ext, sw(["home"]), "switch-spares-held-holds", { homeSetMs: 2000 })).toBeUndefined();
    expect(p(ext, sw(["home"]), undefined, { homeSetMs: 2000 })).toBe("home");
  });
  it("withholds only the home's switch from a step undoing a narrowing (R-9)", () => {
    expect(p(ext, { ...sw(["home"]), undoesNarrowing: true })).toBeUndefined();
    expect(p(ext, { ...sw(["home"]), undoesNarrowing: true }, "home-switch-reopens")).toBe("home");
    expect(p(ext, { ...sw(["device", "home"]), undoesNarrowing: true })).toBe("device");
    expect(p(member, { ...sw(["rule", "home"]), undoesNarrowing: true })).toBe("rule");
    // GA-LEASE-10's guest flag still passes it.
    expect(p(guest, { ...sw(["home"]), undoesNarrowing: true }, undefined, { guestsPass: true })).toBe("guest");
  });
  it("leaseRefuses follows it", () => {
    expect(leaseRefuses(member, "rule", sw(["device"]))).toBe(false);
    expect(leaseRefuses(member, "rule", sw([]))).toBe(true);
    expect(leaseRefuses(safety, "rule", sw(["device"]))).toBe(true);
  });
});

describe("passing (GA-LEASE-12)", () => {
  const j = (l: Met | undefined, pass: Passing, o: PassOptions = {}) => ({ leaseOf: () => l, precedence: "rule" as const, pass, ...o });
  it("names the hold the owner's work passes and the switch, on a step leased lets through", () => {
    expect(passing(LAMP, "onoff.turn_on", j(member, sw(["device", "home"])))).toEqual({ holder: member.holder, switch: "device" });
    expect(passing(LAMP, "onoff.turn_on", j(guest, sw([]), { guestsPass: true }))).toEqual({ holder: guest.holder, switch: "guest" });
  });
  it("names none for a refused step, a lease below the step, no lease, session.lock, a press or a narrowing action", () => {
    expect(passing(LAMP, "onoff.turn_on", j(member, sw([])))).toBeUndefined();
    expect(passing(LAMP, "onoff.turn_on", j({ holder: { rule: "r" }, precedence: "rule" }, sw(["rule"])))).toBeUndefined();
    expect(passing(LAMP, "onoff.turn_on", j(undefined, sw(["rule"])))).toBeUndefined();
    expect(passing(LAMP, "session.lock", j(member, sw(["rule"])))).toBeUndefined();
    expect(passing(LAMP, "onoff.turn_on", j(member, { press: true, ...sw(["rule"]) }))).toBeUndefined();
    expect(passing(LAMP, "onoff.turn_on", j(member, { narrowing: true, ...sw(["rule"]) }))).toBeUndefined();
  });
  it("reads the home switch's time from the judge", () => {
    // At the hold's own precedence the step is not refused, so only the switch's time decides whether it passes.
    const atPerson = (o: PassOptions) => ({ ...j(ext, sw(["home"]), o), precedence: "person" as const });
    expect(passing(LAMP, "onoff.turn_on", atPerson({ homeSetMs: 2000 }))).toEqual({ holder: "external", switch: "home" });
    expect(passing(LAMP, "onoff.turn_on", atPerson({ homeSetMs: 2000, mutation: "switch-spares-held-holds" }))).toBeUndefined();
  });
});

const OWNER_SUBJECTS: Mutation[] = ["refuses-the-owner-switch", "brain-sets-the-device-switch", "brain-marks-a-rule", "brain-sets-the-home-switch",
  "owner-passes-the-cap", "owner-passes-a-run", "owner-passes-safety", "passes-a-hold-in-its-floor", "switch-spares-held-holds",
  "refuses-on-the-persons-own-report", "unmarked-rule-passes", "ignores-the-device-switch", "ignores-the-home-switch", "brain-rule-passes-holds",
  "brain-groups-past-a-hold", "marked-press-passes", "passing-ends-the-hold", "pass-moves-the-end", "pass-re-evaluates-early",
  "marked-run-refused", "brain-edits-a-passing-scenario", "passing-takes-a-lease", "pass-unrecorded", "pass-as-a-lease", "pass-reveals-a-personal-press",
  "home-switch-reopens"];
it("declares and lists the 0.13 subjects, twenty-six", async () => {
  expect(OWNER_SUBJECTS).toHaveLength(26);
  const subject = JSON.parse(await readFile(new URL("../subject.json", import.meta.url), "utf8"));
  for (const m of OWNER_SUBJECTS) { expect(MUTATIONS).toContain(m); expect(subject.mutations).toContain(m); }
});
