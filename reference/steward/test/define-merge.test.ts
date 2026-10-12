import { describe, expect, it } from "vitest";
import { digest } from "../src/core/secret.js";
import { planDefine, type Change } from "../src/house/define.js";
import type { House } from "../src/house/model.js";
import { baseline, context, del, furnished, SECRETS, up } from "./house.js";

const LAMP = "sim-bridge:lamp";
const DIMMER = "sim-bridge:dimmer";
const off = { target: LAMP, action: "onoff.turn_off", args: {} };
const on = { target: LAMP, action: "onoff.turn_on", args: {} };
const lampOn = { target: LAMP, key: "on", op: "eq", value: true };

/** `changes` on `h` (the furnished house by default) as the owner's change set, or under `mutation`. */
const plan = (changes: Change[], h: House = furnished(), o: Parameters<typeof context>[0] = {}) => planDefine(h, changes, context(o)).draft;
const refused = (changes: Change[], message: RegExp, h: House = furnished(), o: Parameters<typeof context>[0] = {}) =>
  expect(() => planDefine(h, changes, context(o))).toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(message) }));

/** The furnished house with a rule, a scenario, a schedule and a satellite's confirm_on. */
function full(): House {
  return plan([
    up("rule", { id: "night", name: "Ночник", trigger: { state: lampOn }, conditions: [{ between: { from: "22:00", until: "06:00" } }], actions: [off],
      exceptions: [{ from: "2030-01-06T21:00:00Z", until: "2030-01-06T22:00:00Z" }] }),
    up("scenario", { id: "eve", name: "Вечер", mode: "single", steps: [on], owned: [LAMP], respect_occupancy: true }),
    up("schedule", { id: "at7", scenario: "eve", time: "07:00", days: [1, 2], exceptions: [{ date: "2030-01-07", action: "skip" }] }),
    up("endpoint", { id: "kitchen-voice", name: "Кухня", type: "voice", room: "kitchen", person: null, served_by: "brain", confirm_on: "olga-app",
      max_role: "guest" }),
  ]);
}

describe("an upsert merges (GA-DEF-14)", () => {
  it("keeps what a room's, a person's and a target's upsert leaves out", () => {
    const h = plan([up("room", { id: "hall" }), up("person", { id: "olga", role: "guest" }), up("target", { id: LAMP, name: "Торшер" })]);
    expect(h.rooms.get("hall")).toEqual({ id: "hall", name: "Холл" });
    expect(h.persons.get("olga")).toEqual({ id: "olga", name: "Ольга", role: "guest" });
    expect(h.targets.get(LAMP)).toEqual({ id: LAMP, name: "Торшер", aliases: ["свет"], room: "hall" });
  });

  it("returns a target's field given as null to its default: the label, no aliases, no room", () => {
    const h = plan([up("target", { id: LAMP, name: null, aliases: null, room: null })]);
    expect(h.targets.get(LAMP)).toEqual({ id: LAMP });
  });

  it("keeps a satellite's confirm_on and max_role when it is renamed, and returns them to their defaults given as null", () => {
    const renamed = plan([up("endpoint", { id: "kitchen-voice", name: "Кухня 2" })], full()).endpoints.get("kitchen-voice")!;
    expect(renamed).toMatchObject({ name: "Кухня 2", type: "voice", room: "kitchen", served_by: "brain", confirm_on: "olga-app", max_role: "guest" });
    expect(renamed.voice?.listening).toBe("wake_server");
    const reset = plan([up("endpoint", { id: "kitchen-voice", confirm_on: null, max_role: null })], full()).endpoints.get("kitchen-voice")!;
    expect(reset.confirm_on).toBeUndefined();
    expect(reset.max_role).toBeUndefined();
  });

  it("keeps a voice record's fields an upsert leaves out, and drops a skill_account given as null", () => {
    const skilled = plan([up("voice", { endpoint: "kitchen-voice", skill_account: "acct" })]);
    expect(skilled.endpoints.get("kitchen-voice")!.voice).toMatchObject({ listening: "wake_server", heard_by: "front", skill_account: "acct" });
    const v = plan([up("voice", { endpoint: "kitchen-voice", follow_up: true, skill_account: null })], skilled).endpoints.get("kitchen-voice")!.voice!;
    expect(v).toMatchObject({ listening: "wake_server", follow_up: true, heard_by: "front" });
    expect(v.skill_account).toBeUndefined();
  });

  it("changes a credential's secret alone, keeping its kind and endpoint, and drops a brain's confirm_on given as null", () => {
    const c = plan([up("credential", { id: "olga-app", secret: "olga-new-secret-0123456789" })]).credentials.get("olga-app")!;
    expect(c).toEqual({ id: "olga-app", kind: "app", secret_sha256: digest("olga-new-secret-0123456789"), endpoint: "olga-app" });
    const h = plan([up("credential", { id: "brain", confirm_on: "olga-app" })]);
    expect(h.credentials.get("brain")).toMatchObject({ kind: "brain", secret_sha256: digest(SECRETS.brain), confirm_on: "olga-app" });
    expect(plan([up("credential", { id: "brain", confirm_on: null })], h).credentials.get("brain")!.confirm_on).toBeUndefined();
  });

  it("replaces a group's members whole when named, keeps them when not, and clears its aliases given as null", () => {
    const renamed = plan([up("group", { id: "hall-lights", name: "Свет 2", aliases: ["люстра"] })]).groups.get("hall-lights")!;
    expect(renamed).toMatchObject({ name: "Свет 2", aliases: ["люстра"], room: "hall", members: [DIMMER, LAMP], aggregate: "any" });
    const one = plan([up("group", { id: "hall-lights", members: [LAMP], aliases: null })]).groups.get("hall-lights")!;
    expect(one).toMatchObject({ name: "Свет в холле", aliases: [], members: [LAMP] });
  });

  it("keeps a rule's fields an upsert leaves out; null returns active to true and exceptions to none, and clears a trigger or conditions", () => {
    const h = full();
    expect(plan([up("rule", { id: "night", active: false })], h).rules.get("night")).toMatchObject({ name: "Ночник", trigger: { state: lampOn },
      actions: [off], active: false, exceptions: [{ from: "2030-01-06T21:00:00Z", until: "2030-01-06T22:00:00Z" }] });
    const reset = plan([up("rule", { id: "night", active: null, exceptions: null, trigger: null })], plan([up("rule", { id: "night", active: false })], h)).rules.get("night")!;
    expect(reset.active).toBe(true);
    expect(reset.exceptions).toEqual([]);
    expect(reset.trigger).toBeUndefined();
    expect(reset.conditions).toEqual([{ between: { from: "22:00", until: "06:00" } }]);
    refused([up("rule", { id: "night", trigger: null, conditions: null })], /keeps a trigger or conditions \(GA-DEF-14\)/, h);
  });

  it("keeps a scenario's and a schedule's fields an upsert leaves out, null returning owned, respect_occupancy and days to their defaults", () => {
    const h = full();
    expect(plan([up("scenario", { id: "eve", name: "Вечер 2" })], h).scenarios.get("eve")).toMatchObject({ name: "Вечер 2", mode: "single",
      steps: [on], owned: [LAMP], respect_occupancy: true });
    expect(plan([up("scenario", { id: "eve", owned: null, respect_occupancy: null })], h).scenarios.get("eve")).toMatchObject({ owned: [],
      respect_occupancy: false });
    expect(plan([up("schedule", { id: "at7", time: "07:30" })], h).schedules.get("at7")).toMatchObject({ scenario: "eve", time: "07:30", days: [1, 2],
      exceptions: [{ date: "2030-01-07", action: "skip" }] });
    const every = plan([up("schedule", { id: "at7", days: null, exceptions: null })], h).schedules.get("at7")!;
    expect(every.days).toBeUndefined();
    expect(every.exceptions).toEqual([]);
  });

  it("refuses a target's account_persons until computers' persons are built", () => {
    refused([up("target", { id: LAMP, account_persons: { "1000": "olga" } })], /account_persons is not built yet/);
  });

  it("under renames-away-the-room, clears a target's room and aliases on a rename; under drops-confirm-on, resets a satellite's confirm_on", () => {
    expect(plan([up("target", { id: LAMP, name: "Торшер" })], furnished(), { mutation: "renames-away-the-room" }).targets.get(LAMP))
      .toEqual({ id: LAMP, name: "Торшер" });
    expect(plan([up("endpoint", { id: "kitchen-voice", name: "Кухня 2" })], full(), { mutation: "drops-confirm-on" }).endpoints.get("kitchen-voice")!.confirm_on)
      .toBeUndefined();
  });
});

describe("a delete removes by key (GA-DEF-14)", () => {
  it("removes a schedule exception by its schedule and date", () => {
    expect(plan([del("schedule_exception", { schedule: "at7", date: "2030-01-07" })], full()).schedules.get("at7")!.exceptions).toEqual([]);
    refused([del("schedule_exception", { schedule: "at7", date: "2030-01-08" })], /has no exception on 2030-01-08/, full());
    refused([del("schedule_exception", { schedule: "at7", date: "2030-01-07", action: "skip" })], /change 1 \(delete schedule_exception\)/, full());
  });

  it("refuses a delete keyed for another kind", () => {
    refused([del("room", { endpoint: "hall" })], /a room is deleted by its id/);
    refused([del("rule_exception", { id: "night" })], /a rule_exception is deleted by its rule, from and until/, full());
  });

  it("under deletes-the-missing, takes a delete of a room that does not exist", () => {
    expect(plan([del("room", { id: "attic" })], furnished(), { mutation: "deletes-the-missing" }).rooms.has("attic")).toBe(false);
  });
});

describe("the shapes bind (GA-DEF-13)", () => {
  it("refuses a secret under 16 characters, a field its kind does not name, and 65 exceptions", () => {
    refused([up("credential", { id: "b2", kind: "brain", secret: "short-12" })], /secret/);
    refused([up("room", { id: "attic", name: "Чердак", colour: "blue" })], /change 1 \(upsert room\)/);
    const many = Array.from({ length: 65 }, (_, i) => ({ from: `2030-01-${String(i % 28 + 1).padStart(2, "0")}T0${i % 10}:00:00Z`,
      until: `2030-01-${String(i % 28 + 1).padStart(2, "0")}T1${i % 10}:00:00Z` }));
    refused([up("rule", { id: "night", exceptions: many })], /change 1 \(upsert rule\)/, full());
  });

  it("under takes-a-short-secret, takes a secret of 8 characters", () => {
    expect(plan([up("credential", { id: "b2", kind: "brain", secret: "short-12" })], furnished(), { mutation: "takes-a-short-secret" }).credentials.has("b2"))
      .toBe(true);
  });
});

describe("brain_authored under the merge (GA-DEF-7)", () => {
  const marked = () => planDefine(full(), [up("rule", { id: "night", name: "Ночник мозга" }), up("scenario", { id: "eve", name: "Вечер мозга" }),
    up("schedule", { id: "at7", time: "07:15" }), up("target", { id: DIMMER, room: "kitchen" }),
    up("group", { id: "hall-lights", members: [LAMP, DIMMER, "sim-bridge:channel"] })], context({ brain: true })).draft;

  it("marks what a brain's merge changed", () => {
    const h = marked();
    expect([h.rules.get("night")?.brain_authored, h.scenarios.get("eve")?.brain_authored, h.schedules.get("at7")?.brain_authored]).toEqual([true, true, true]);
    expect(h.targets.get(DIMMER)?.room_brain_authored).toBe(true);
    expect(h.groups.get("hall-lights")?.brain_joined).toEqual(["sim-bridge:channel"]);
  });

  it("keeps a mark on an owner's upsert naming part of the item, and clears it when the owner names every field the item holds", () => {
    const h = marked();
    const part = plan([up("rule", { id: "night", active: false }), up("scenario", { id: "eve", name: "Вечер" }), up("schedule", { id: "at7", time: "07:00" })], h);
    expect([part.rules.get("night")?.brain_authored, part.scenarios.get("eve")?.brain_authored, part.schedules.get("at7")?.brain_authored]).toEqual([true, true, true]);
    const whole = plan([
      up("rule", { id: "night", name: "Ночник", trigger: { state: lampOn }, conditions: [{ between: { from: "22:00", until: "06:00" } }], actions: [off], active: true }),
      up("scenario", { id: "eve", name: "Вечер", mode: "single", steps: [on], owned: [LAMP], respect_occupancy: true }),
      up("schedule", { id: "at7", scenario: "eve", time: "07:00", days: [1, 2] })], h);
    expect([whole.rules.get("night")?.brain_authored, whole.scenarios.get("eve")?.brain_authored, whole.schedules.get("at7")?.brain_authored])
      .toEqual([undefined, undefined, undefined]);
  });

  it("clears a device's marks when the owner names its room, and a group's members, not on a rename", () => {
    const h = marked();
    const renamed = plan([up("target", { id: DIMMER, name: "Бра" }), up("group", { id: "hall-lights", name: "Свет 3" })], h);
    expect(renamed.targets.get(DIMMER)?.room_brain_authored).toBe(true);
    expect(renamed.groups.get("hall-lights")?.brain_joined).toEqual(["sim-bridge:channel"]);
    const set = plan([up("target", { id: DIMMER, room: "kitchen" }), up("group", { id: "hall-lights", members: [LAMP, DIMMER, "sim-bridge:channel"] })], h);
    expect(set.targets.get(DIMMER)?.room_brain_authored).toBeUndefined();
    expect(set.groups.get("hall-lights")?.brain_joined).toBeUndefined();
  });
});

describe("created-with only on creation (GA-DEF-14)", () => {
  it("takes an upsert of an existing item naming its key alone, changing nothing", () => {
    const h = baseline();
    const { diff } = planDefine(h, [up("room", { id: "hall" }), up("endpoint", { id: "olga-app" })], context());
    expect(diff).toEqual([]);
  });
});
