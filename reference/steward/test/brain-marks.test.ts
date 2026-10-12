import { describe, expect, it } from "vitest";
import type { Principal } from "../src/auth/principal.js";
import { brainMayDefine, deviceMarked, joinedThroughBrain, BRAIN_KINDS } from "../src/house/brain.js";
import { planDefine, type Change } from "../src/house/define.js";
import type { House } from "../src/house/model.js";
import { context, del, furnished, up } from "./house.js";

const LAMP = "sim-bridge:lamp";
const DIMMER = "sim-bridge:dimmer";
/** The owner, through a brain: a chat window in the owner's app that a brain serves. */
const ownerThroughBrain: Principal = { endpoint: "owner-chat", person: "owner", via: "app", brain: true, role: "owner" };
const off = { target: LAMP, action: "onoff.turn_off", args: {} };
const scenario = (v: Record<string, unknown> = {}) => ({ id: "night", name: "Ночь", mode: "single", steps: [off], ...v });
const rule = (v: Record<string, unknown> = {}) => ({ id: "dark", name: "Темно", trigger: { state: { target: LAMP, key: "on", op: "eq", value: true } },
  actions: [off], ...v });
const schedule = (v: Record<string, unknown> = {}) => ({ id: "eve", scenario: "night", time: "22:00", ...v });

/** `changes` on `h` as a brain's change set (`brain`) or the owner's. */
const by = (h: House, changes: Change[], brain: boolean) => planDefine(h, changes, context({ brain }));

describe("brainMayDefine (ruled, Q4; GA-DEF-3)", () => {
  it("takes the owner's change set of scenarios, rules, schedules, their exceptions, names, rooms and groups", () => {
    expect([...BRAIN_KINDS].sort()).toEqual(["group", "room", "rule", "rule_exception", "scenario", "schedule", "schedule_exception", "target"]);
    expect(() => brainMayDefine(ownerThroughBrain, [...BRAIN_KINDS].map((kind) => ({ kind })))).not.toThrow();
  });

  it("refuses not_permitted a member, a guest or a visitor through a brain, whatever the change set", () => {
    for (const role of ["member", "guest", "visitor"] as const) {
      expect(() => brainMayDefine({ ...ownerThroughBrain, role }, [{ kind: "room" }]))
        .toThrow(expect.objectContaining({ code: "not_permitted", message: expect.stringMatching(new RegExp(`owner role only.*${role}`)) }));
    }
  });

  it("refuses not_permitted persons, endpoints, voice records, credentials, the home's settings, a lifted narrowing and a kind it does not know, even with a room beside them", () => {
    for (const kind of ["person", "endpoint", "voice", "credential", "home", "lift_narrowing", "nonsense"]) {
      expect(() => brainMayDefine(ownerThroughBrain, [{ kind: "room" }, { kind }]))
        .toThrow(expect.objectContaining({ code: "not_permitted", message: expect.stringContaining(`change 2 (${kind})`) }));
    }
  });
});

describe("brain_authored marks (GA-DEF-7)", () => {
  it("marks a scenario, a rule and a schedule a brain creates, and shows the marks in the diff", () => {
    const { draft, diff } = by(furnished(), [up("scenario", scenario()), up("rule", rule()), up("schedule", schedule())], true);
    expect(draft.scenarios.get("night")?.brain_authored).toBe(true);
    expect(draft.rules.get("dark")?.brain_authored).toBe(true);
    expect(draft.schedules.get("eve")?.brain_authored).toBe(true);
    for (const kind of ["scenario night", "rule dark", "schedule eve"]) expect(diff.find((l) => l.startsWith(`+ ${kind}`))).toContain("brain_authored true");
  });

  it("marks what a brain changes, keeps the mark on what it upserts unchanged, and leaves unmarked what it upserts unchanged of the owner's", () => {
    const h = by(furnished(), [up("scenario", scenario()), up("rule", rule())], false).draft;
    expect(h.scenarios.get("night")?.brain_authored).toBeUndefined();
    // The same scenario, unchanged, through a brain: nothing changed, so nothing marked, and no diff.
    const same = by(h, [up("scenario", scenario())], true);
    expect(same.draft.scenarios.get("night")?.brain_authored).toBeUndefined();
    expect(same.diff).toEqual([]);
    // Renamed through a brain: changed, so marked.
    const renamed = by(h, [up("scenario", scenario({ name: "Ночь тихая" }))], true);
    expect(renamed.draft.scenarios.get("night")?.brain_authored).toBe(true);
    expect(renamed.diff.find((l) => l.startsWith("~ scenario night"))).toContain("brain_authored unset → true");
    // The marked one upserted unchanged through a brain again keeps its mark.
    expect(by(renamed.draft, [up("scenario", scenario({ name: "Ночь тихая" }))], true).draft.scenarios.get("night")?.brain_authored).toBe(true);
  });

  it("clears a mark when the owner redefines the scenario, rule or schedule whole, even unchanged; an exception the owner adds keeps it", () => {
    const h = by(furnished(), [up("scenario", scenario()), up("rule", rule()), up("schedule", schedule())], true).draft;
    const x = { rule: "dark", from: "2026-10-06T10:00:00Z", until: "2026-10-06T11:00:00Z" };
    const kept = by(h, [up("rule_exception", x), up("schedule_exception", { schedule: "eve", date: "2026-10-07", action: "skip" })], false).draft;
    expect(kept.rules.get("dark")?.brain_authored).toBe(true);
    expect(kept.schedules.get("eve")?.brain_authored).toBe(true);
    const cleared = by(h, [up("scenario", scenario()), up("rule", rule()), up("schedule", schedule())], false);
    expect(cleared.draft.scenarios.get("night")?.brain_authored).toBeUndefined();
    expect(cleared.draft.rules.get("dark")?.brain_authored).toBeUndefined();
    expect(cleared.draft.schedules.get("eve")?.brain_authored).toBeUndefined();
    expect(cleared.diff.find((l) => l.startsWith("~ rule dark"))).toContain("brain_authored true → unset");
  });

  it("marks a moved date, never the schedule; a skip a brain adds, and a rule exception, mark nothing", () => {
    const h = by(furnished(), [up("scenario", scenario()), up("rule", rule()), up("schedule", schedule())], false).draft;
    const { draft } = by(h, [up("schedule_exception", { schedule: "eve", date: "2026-10-07", action: "move", time: "23:00" }),
      up("schedule_exception", { schedule: "eve", date: "2026-10-08", action: "skip" }),
      up("rule_exception", { rule: "dark", from: "2026-10-06T10:00:00Z", until: "2026-10-06T11:00:00Z" })], true);
    expect(draft.schedules.get("eve")?.brain_authored).toBeUndefined();
    expect(draft.schedules.get("eve")?.exceptions).toEqual([{ date: "2026-10-07", action: "move", time: "23:00", brain_authored: true },
      { date: "2026-10-08", action: "skip" }]);
    expect(draft.rules.get("dark")?.brain_authored).toBeUndefined();
    // A move a brain made is removed by its key, its schedule and date (GA-DEF-14).
    expect(by(draft, [del("schedule_exception", { schedule: "eve", date: "2026-10-07" })], false)
      .draft.schedules.get("eve")?.exceptions).toEqual([{ date: "2026-10-08", action: "skip" }]);
    // The owner sets that date again: the move is the owner's.
    const owners = by(draft, [up("schedule_exception", { schedule: "eve", date: "2026-10-07", action: "move", time: "23:00" })], false).draft;
    expect(owners.schedules.get("eve")?.exceptions[0]).toEqual({ date: "2026-10-07", action: "move", time: "23:00" });
    // A brain's whole schedule, its exceptions unchanged and its time changed: the schedule marked, the dates as they were.
    const whole = by(draft, [up("schedule", schedule({ time: "21:30", exceptions: draft.schedules.get("eve")!.exceptions
      .map(({ brain_authored: _b, ...x }) => x) }))], true).draft;
    expect(whole.schedules.get("eve")?.brain_authored).toBe(true);
    expect(whole.schedules.get("eve")?.exceptions.map((x) => x.brain_authored ?? false)).toEqual([true, false]);
  });

  it("marks a device a brain puts in a room or a group, not one it renames or leaves where it was, until the owner sets it again", () => {
    const h = by(furnished(), [up("room", { id: "study", name: "Кабинет" })], false).draft;
    // The lamp is in the hall and the group; the dimmer too. A brain moves the lamp to the study, renames the dimmer,
    // and makes a group of the lamp and the dimmer.
    const { draft, diff } = by(h, [up("target", { id: LAMP, room: "study" }), up("target", { id: DIMMER, name: "Бра", room: "hall" }),
      up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER], aggregate: "any" })], true);
    expect(joinedThroughBrain(draft, LAMP)).toEqual({ room: "study", groups: ["evening"] });
    expect(joinedThroughBrain(draft, DIMMER)).toEqual({ room: null, groups: ["evening"] });
    expect(deviceMarked(draft, LAMP)).toBe(true);
    expect(diff.find((l) => l.startsWith("~ target sim-bridge:lamp"))).toContain("room_brain_authored unset → true");
    // A brain adds nothing new to the owner's group: no member joined through it.
    const kept = by(draft, [up("group", { id: "hall-lights", name: "Свет", room: "hall", members: [LAMP, DIMMER], aggregate: "any" })], true).draft;
    expect(kept.groups.get("hall-lights")?.brain_joined).toBeUndefined();
    // The owner sets the lamp's room again, and the group: the marks go.
    const owners = by(draft, [up("target", { id: LAMP, room: "study" }), up("group", { id: "evening", name: "Вечер", room: null, members: [LAMP, DIMMER],
      aggregate: "any" })], false).draft;
    expect(joinedThroughBrain(owners, LAMP)).toEqual({ room: null, groups: [] });
    expect(deviceMarked(owners, LAMP)).toBe(false);
    // A group deleted takes its marks with it.
    const gone = by(draft, [del("group", { id: "evening" })], true).draft;
    expect(joinedThroughBrain(gone, DIMMER).groups).toEqual([]);
  });
});
