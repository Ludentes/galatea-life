import { describe, expect, it } from "vitest";
import { digest } from "../src/core/secret.js";
import { hasNotifyChannel, planDefine, type Change } from "../src/house/define.js";
import { HOLD_DEFAULTS, houseKey } from "../src/house/model.js";
import { baseline, BASELINE, context, del, DEVICES, furnished, FURNISHED, SECRETS, up, withOwner } from "./house.js";

const refused = (changes: Change[], message: RegExp, ctx = context(), h = baseline()) =>
  expect(() => planDefine(h, changes, ctx)).toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(message) }));

describe("planDefine", () => {
  it("sets the hold policy field by field, a null field back to the steward's own, null whole back to all of it (GA-LEASE-8)", () => {
    const short = planDefine(baseline(), [up("home", { hold: { on_s: 20, off_s: 20, presence_renews: false } })], context()).draft;
    expect(short.home.hold).toEqual({ ...HOLD_DEFAULTS, on_s: 20, off_s: 20, presence_renews: false });
    const one = planDefine(short, [up("home", { hold: { on_s: null } })], context()).draft;
    expect(one.home.hold).toEqual({ ...HOLD_DEFAULTS, off_s: 20, presence_renews: false });
    expect(planDefine(one, [up("home", { hold: null })], context()).draft.home.hold).toEqual(HOLD_DEFAULTS);
  });

  it("accepts every window of 1 s or more, a cap included, and 0 as no cap (GA-LEASE-8)", () => {
    const h = planDefine(baseline(), [up("home", { hold: { on_s: 1, off_s: 1, other_s: 1, fixed_s: 1, load_cap_s: 1, cap_s: 1 } })], context()).draft;
    expect(h.home.hold).toMatchObject({ on_s: 1, off_s: 1, other_s: 1, fixed_s: 1, load_cap_s: 1, cap_s: 1 });
    expect(planDefine(baseline(), [up("home", { hold: { cap_s: 0 } })], context()).draft.home.hold.cap_s).toBe(0);
  });

  it("refuses schedule_ends: true, naming the flag, which this steward does not implement; false and null pass", () => {
    refused([up("home", { hold: { schedule_ends: true } })], /hold\.schedule_ends/);
    expect(() => planDefine(baseline(), [up("home", { hold: { schedule_ends: true } })], context()))
      .toThrow(expect.objectContaining({ code: "invalid_request", data: { field: "schedule_ends" } }));
    expect(planDefine(baseline(), [up("home", { hold: { schedule_ends: false } })], context()).draft.home.hold.schedule_ends).toBe(false);
    expect(planDefine(baseline(), [up("home", { hold: { schedule_ends: null } })], context()).draft.home.hold.schedule_ends).toBe(false);
  });

  it("refuses hold_time_s, gone in steward 0.12 (GA-DEF-13)", () => {
    refused([up("home", { hold_time_s: 7200 })], /hold_time_s|additional/);
  });

  it("defines the baseline house in one change set, and a diff that never shows a secret (GA-DEF-1)", () => {
    const { draft, diff } = planDefine(withOwner(), BASELINE, context());
    expect([...draft.rooms.keys()].sort()).toEqual(["hall", "kitchen"]);
    expect(draft.endpoints.get("kitchen-voice")?.voice?.heard_by).toBe("front");
    expect(draft.credentials.get("brain")?.secret_sha256).toBe(digest(SECRETS.brain));
    expect(diff).toContain("+ room kitchen: name \"Кухня\"");
    expect(diff.some((l) => l.startsWith("home: ") && l.includes("notice_channels [] → [\"sim-bridge:channel\"]"))).toBe(true);
    expect(diff.find((l) => l.startsWith("+ credential brain"))).toContain("secret set");
    expect(diff.join("\n")).not.toContain(SECRETS.brain);
    expect(diff.join("\n")).not.toContain(digest(SECRETS.brain));
  });

  it("changes nothing it was given: the house planned on is left as it was", () => {
    const h = withOwner();
    const before = houseKey(h);
    planDefine(h, BASELINE, context());
    expect(houseKey(h)).toBe(before);
  });

  it("takes a fresh steward's change sets while notice_channels was never set, and a list of announcing channels alone (GA-DEF-8)", () => {
    const room = planDefine(withOwner(), [up("room", { id: "hall", name: "Холл" })], context()).draft;
    expect(room.home.notice_channels).toEqual([]);
    const spoken = planDefine(room, [up("home", { notice_channels: ["sim-bridge:speaker"] })], context()).draft;
    expect(spoken.home.notice_channels).toEqual(["sim-bridge:speaker"]);
    refused([up("home", { notice_channels: ["sim-bridge:stray"] })], /not adopted/, context(), withOwner());
    refused([up("home", { notice_channels: ["sim-bridge:lamp"] })], /neither notify nor media.announce/, context(), withOwner());
    refused([up("home", { notice_channels: ["sim-bridge:gone"] })], /no device the applier describes/, context(), withOwner());
    refused([up("home", { notice_channels: ["sim-bridge:lamp", "sim-bridge:channel"] })], /sim-bridge:lamp has neither notify nor media.announce/);
  });

  it("refuses leaving notice_channels empty once set, by an empty list or a null (GA-DEF-8)", () => {
    refused([up("home", { notice_channels: [] })], /left empty once set \(GA-DEF-8\)/);
    refused([up("home", { notice_channels: null })], /left empty once set/);
    const spoken = planDefine(withOwner(), [up("home", { notice_channels: ["sim-bridge:speaker"] })], context()).draft;
    refused([up("home", { notice_channels: [] })], /left empty once set/, context(), spoken);
  });

  it("checks only the entries a change set sets: a channel that left adoption does not refuse another change (GA-DEF-8)", () => {
    const h = baseline();
    const gone = context({ device: (id) => (id === "sim-bridge:channel" ? { ...DEVICES[id]!, adopted: false } : DEVICES[id]) });
    expect(planDefine(h, [up("room", { id: "attic", name: "Чердак" })], gone).draft.rooms.has("attic")).toBe(true);
    refused([up("home", { notice_channels: ["sim-bridge:channel"] })], /not adopted/, gone, h);
  });

  it("under refuses-the-first-define, refuses a fresh steward's change set naming no channel", () => {
    refused([up("room", { id: "hall", name: "Холл" })], /no notify channel/, context({ mutation: "refuses-the-first-define" }), withOwner());
  });

  it("under refuses-an-announcing-channel, refuses a list of announcing channels alone; under takes-a-silent-channel, takes a lamp", () => {
    refused([up("home", { notice_channels: ["sim-bridge:speaker"] })], /no notify channel/, context({ mutation: "refuses-an-announcing-channel" }), withOwner());
    expect(planDefine(baseline(), [up("home", { notice_channels: ["sim-bridge:lamp", "sim-bridge:channel"] })],
      context({ mutation: "takes-a-silent-channel" })).draft.home.notice_channels).toEqual(["sim-bridge:lamp", "sim-bridge:channel"]);
  });

  it("says whether the house has an adopted notify channel (GA-NOTE-1)", () => {
    expect(hasNotifyChannel(baseline().home, context())).toBe(true);
    expect(hasNotifyChannel(withOwner().home, context())).toBe(false);
    const spoken = planDefine(withOwner(), [up("home", { notice_channels: ["sim-bridge:speaker"] })], context()).draft;
    expect(hasNotifyChannel(spoken.home, context())).toBe(false);
    expect(hasNotifyChannel(baseline().home, context({ device: (id) => (id === "sim-bridge:channel" ? { ...DEVICES[id]!, adopted: false } : DEVICES[id]) })))
      .toBe(false);
  });

  it("refuses a change set whole: a valid room with an invalid endpoint leaves no room (GA-DEF-5)", () => {
    refused([up("room", { id: "attic", name: "Чердак" }),
      up("endpoint", { id: "attic-panel", name: "Чердак", type: "panel", room: "nowhere", person: null, served_by: null })], /no room nowhere/);
  });

  it("refuses what GA-DEF-8 lists, each alone", () => {
    const voice = (v: Record<string, unknown> = {}) => up("voice", { endpoint: "kitchen-voice", listening: "wake_server",
      wake_words: [], zone: null, output: null, follow_up: false, heard_by: "front", ...v });
    const ep = (id: string, v: Record<string, unknown>) => up("endpoint", { id, name: id, type: "voice", room: "kitchen", person: null,
      served_by: "brain", ...v });
    refused([ep("bath-voice", { served_by: null })], /needs served_by/);
    refused([ep("hall-panel", { type: "panel", room: "hall", served_by: null }), voice({ endpoint: "hall-panel" })], /needs served_by/);
    refused([up("endpoint", { id: "app2", name: "a", type: "app", room: null, person: null, served_by: null })], /app endpoint needs a person/);
    refused([voice({ heard_by: "brain" })], /heard_by brain is no front/);
    refused([up("credential", { id: "front2", kind: "front", secret: "front2-secret-0123456789" }), ep("bath-voice", {}),
      voice({ endpoint: "bath-voice", heard_by: "front2" })], /more than one front/);
    refused([up("endpoint", { id: "hall-panel", name: "p", type: "panel", room: "hall", person: null, served_by: "brain" }),
      voice({ endpoint: "hall-panel", skill_account: "acct" })], /skill_account is only on a voice endpoint/);
    refused([ep("bath-voice", { person: "olga" }), voice({ endpoint: "bath-voice", skill_account: "acct" })], /skill_account is only/);
    refused([voice({ skill_account: "acct", skill_surface: "s1" }), ep("bath-voice", {}),
      voice({ endpoint: "bath-voice", skill_account: "acct", skill_surface: "s1" })], /one skill_surface/);
    refused([voice({ skill_account: "acct", skill_surface: "s1" }), ep("bath-voice", {}),
      voice({ endpoint: "bath-voice", skill_account: "acct" })], /both a surfaced endpoint and one without/);
    refused([ep("bath-voice", { room: null })], /only an app endpoint has no room/);
  });

  it("takes an app endpoint without a person under app-without-person, and nothing else of GA-DEF-8", () => {
    const ctx = context({ mutation: "app-without-person" });
    const app = up("endpoint", { id: "app2", name: "a", type: "app", room: null, person: null, served_by: null });
    expect(planDefine(baseline(), [app], ctx).draft.endpoints.get("app2")?.person).toBeNull();
    refused([up("endpoint", { id: "bath", name: "b", type: "voice", room: "kitchen", person: null, served_by: null })], /needs served_by/, ctx);
  });

  it("refuses a confirm_on that names a brain-served endpoint, now or after a later change (GA-CONF-4)", () => {
    const panel = (v: Record<string, unknown>) => up("endpoint", { id: "hall-panel", name: "p", type: "panel", room: "hall", person: null, ...v });
    refused([panel({ served_by: null, confirm_on: "kitchen-voice" })], /served by a brain \(GA-CONF-4\)/);
    // The panel asks on Olga's app; a later change has a brain serve the app.
    const h = planDefine(baseline(), [panel({ served_by: null, confirm_on: "olga-app" })], context()).draft;
    refused([up("endpoint", { id: "olga-app", name: "o", type: "app", room: null, person: "olga", served_by: "brain" })], /GA-CONF-4/, context(), h);
    // A brain credential's own confirm_on.
    refused([up("credential", { id: "brain", kind: "brain", secret: SECRETS.brain, confirm_on: "kitchen-voice" })], /GA-CONF-4/);
    expect(planDefine(baseline(), [up("credential", { id: "brain", kind: "brain", secret: SECRETS.brain, confirm_on: "olga-app" })],
      context()).draft.credentials.get("brain")?.confirm_on).toBe("olga-app");
    // `same` is none.
    expect(planDefine(baseline(), [panel({ served_by: null, confirm_on: "same" })], context()).draft.endpoints.get("hall-panel")?.confirm_on)
      .toBeUndefined();
  });

  it("takes a confirm_on naming a brain-served endpoint under serves-the-confirm-on", () => {
    const ctx = context({ mutation: "serves-the-confirm-on" });
    const h = planDefine(baseline(), [up("endpoint", { id: "hall-panel", name: "p", type: "panel", room: "hall", person: null,
      served_by: null, confirm_on: "kitchen-voice" })], ctx).draft;
    expect(h.endpoints.get("hall-panel")?.confirm_on).toBe("kitchen-voice");
  });

  it("checks references: rooms, persons, served_by, a credential's endpoint, its kind, and secrets", () => {
    refused([del("room", { id: "kitchen" })], /no room kitchen/);
    refused([del("person", { id: "olga" })], /no person olga/);
    refused([del("credential", { id: "brain" })], /served_by brain is no brain credential/);
    refused([up("credential", { id: "p2", kind: "panel", secret: "p2-secret-0123456789xx", endpoint: "olga-app" })], /panel credential is bound to an panel endpoint/);
    refused([up("credential", { id: "p2", kind: "panel", secret: "p2-secret-0123456789xx" })], /names its one endpoint/);
    refused([up("credential", { id: "b2", kind: "brain", secret: "b2-secret-0123456789xx", endpoint: "hall-panel" })], /names none/);
    refused([up("credential", { id: "p2", kind: "panel", secret: SECRETS.panel, endpoint: "hall-panel" })], /another credential has this secret/);
    refused([up("credential", { id: "olga-app", kind: "app", secret: "x-secret-0123456789xxx", endpoint: "olga-app", confirm_on: "hall-panel" })],
      /only a brain credential/);
  });

  it("refuses a schema's error, a kind not built, an unknown kind, and a delete of nothing", () => {
    refused([up("room", { id: "x" })], /change 1 \(upsert room\)/);
    refused([up("scenario", { id: "s" })], /change 1 \(upsert scenario\)/);
    refused([up("lift_narrowing", { endpoint: "kitchen-voice" })], /lift_narrowing is not built yet/);
    refused([up("garden", { id: "g" })], /no kind garden/);
    refused([del("room", { id: "attic" })], /no attic to delete/);
    refused([del("home", { id: "home" })], /never deleted/);
    refused([del("voice", { id: "kitchen-voice" })], /named by its endpoint/);
    refused([up("room", { id: "x", name: "a\u0000b" })], /U\+0000/);
  });

  it("refuses an upsert that creates an item without its kind's created-with fields (GA-DEF-14), each kind's in turn", () => {
    const LAMP = "sim-bridge:lamp";
    const cases: [Change, string][] = [
      [up("room", { id: "attic" }), "name"],
      [up("person", { id: "liza2", name: "Лиза" }), "role"],
      [up("endpoint", { id: "attic-panel", name: "Панель", type: "panel", room: "hall", person: null }), "served_by"],
      [up("voice", { endpoint: "hall-panel", listening: "wake_server", wake_words: [], zone: null, output: "speech", heard_by: "front" }), "follow_up"],
      [up("credential", { id: "b2", kind: "brain" }), "secret"],
      [up("group", { id: "g", name: "Г", room: null, members: [LAMP] }), "aggregate"],
      [up("rule", { id: "r", name: "Р", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }] }), "actions"],
      [up("scenario", { id: "s", name: "С", steps: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }), "mode"],
      [up("schedule", { id: "sc", time: "07:00" }), "scenario"],
    ];
    for (const [c, field] of cases) refused([c], new RegExp(`created with .*\\b${field}\\b.*\\(GA-DEF-14\\)`));
  });

  it("refuses a rule created with neither a trigger nor conditions, or with both null (GA-DEF-14)", () => {
    const actions = [{ target: "sim-bridge:lamp", action: "onoff.turn_off", args: {} }];
    refused([up("rule", { id: "x", name: "x", actions })], /a trigger or conditions \(GA-DEF-14\)/);
    refused([up("rule", { id: "x", name: "x", actions, trigger: null, conditions: null })], /a trigger or conditions \(GA-DEF-14\)/);
  });

  it("takes an upsert of an existing item that leaves out a created-with field: it merges (GA-DEF-14)", () => {
    expect(planDefine(baseline(), [up("room", { id: "hall" })], context()).draft.rooms.get("hall")).toEqual({ id: "hall", name: "Холл" });
    expect(planDefine(baseline(), [up("endpoint", { id: "olga-app", name: "Телефон" })], context()).draft.endpoints.get("olga-app"))
      .toMatchObject({ name: "Телефон", type: "app", person: "olga" });
  });

  it("refuses a delete of an item that does not exist, of every kind keyed by id (GA-DEF-14)", () => {
    for (const kind of ["room", "person", "endpoint", "credential", "target", "group", "rule", "scenario", "schedule"]) {
      refused([del(kind, { id: "nowhere" })], /no nowhere to delete/);
    }
    refused([del("voice", { endpoint: "olga-app" })], /has no voice record/);
  });

  it("deletes a voice record by its endpoint, and an endpoint's upsert keeps its record", () => {
    const kept = planDefine(baseline(), [up("endpoint", { id: "kitchen-voice", name: "Кухня 2", type: "voice", room: "kitchen", person: null,
      served_by: "brain" })], context()).draft;
    expect(kept.endpoints.get("kitchen-voice")?.voice?.listening).toBe("wake_server");
    const gone = planDefine(baseline(), [del("voice", { endpoint: "kitchen-voice" })], context()).draft;
    expect(gone.endpoints.get("kitchen-voice")?.voice).toBeNull();
  });

  it("takes time_source only while the applier reports a test_run_id (GA-HARN-2), and null clears it", () => {
    refused([up("home", { time_source: "127.0.0.1:123" })], /accepted only while the applier reports a test_run_id/, context({ underHarness: false }));
    const set = planDefine(baseline(), [up("home", { time_source: "127.0.0.1:123" })], context()).draft;
    expect(set.home.time_source).toBe("127.0.0.1:123");
    expect(planDefine(set, [up("home", { time_source: null, hold: null })], context()).draft.home)
      .toEqual(expect.not.objectContaining({ time_source: expect.anything() }));
  });

  it("resets a setting given null to its default: timezone to UTC, and notice_channels to none, which is refused", () => {
    const zoned = planDefine(baseline(), [up("home", { timezone: "Europe/Moscow" })], context()).draft;
    expect(planDefine(zoned, [up("home", { timezone: null })], context()).draft.home.timezone).toBe("UTC");
    refused([up("home", { notice_channels: null })], /left empty once set/);
  });

  it("gives no diff for a change set that changes nothing", () => {
    const h = baseline();
    expect(planDefine(h, [up("room", { id: "hall", name: "Холл" })], context()).diff).toEqual([]);
  });
});

describe("planDefine's targets and groups", () => {
  it("lays the steward's overlay on the applier's devices, and groups them, with a diff line each", () => {
    const { draft, diff } = planDefine(baseline(), FURNISHED, context());
    expect(draft.targets.get("sim-bridge:lamp")).toEqual({ id: "sim-bridge:lamp", name: "Лампа", aliases: ["свет"], room: "hall" });
    expect(draft.targets.get("sim-bridge:dimmer")).toEqual({ id: "sim-bridge:dimmer", room: "hall" });
    // Members in code-point order of their ids, aliases none when not given.
    expect(draft.groups.get("hall-lights")).toEqual({ id: "hall-lights", name: "Свет в холле", aliases: [], room: "hall",
      members: ["sim-bridge:dimmer", "sim-bridge:lamp"], aggregate: "any" });
    expect(diff).toContain("+ target sim-bridge:dimmer: room \"hall\"");
    expect(diff.find((l) => l.startsWith("+ group hall-lights"))).toContain("aggregate \"any\"");
    // An upsert merges into the overlay (GA-DEF-14); a delete takes it away.
    const renamed = planDefine(draft, [up("target", { id: "sim-bridge:lamp", name: "Торшер" })], context()).draft;
    expect(renamed.targets.get("sim-bridge:lamp")).toEqual({ id: "sim-bridge:lamp", name: "Торшер", aliases: ["свет"], room: "hall" });
    expect(planDefine(draft, [del("target", { id: "sim-bridge:lamp" }), del("group", { id: "hall-lights" })], context()).draft.targets
      .has("sim-bridge:lamp")).toBe(false);
  });

  it("refuses a device the applier has not adopted, in a target or a group, and one it does not describe (GA-DEF-9)", () => {
    refused([up("target", { id: "sim-bridge:stray", room: "hall" })], /sim-bridge:stray is not adopted \(GA-DEF-9\)/);
    refused([up("target", { id: "sim-bridge:stray", name: "Чужая" })], /not adopted \(GA-DEF-9\)/);
    refused([up("group", { id: "g", name: "g", room: null, members: ["sim-bridge:lamp", "sim-bridge:stray"], aggregate: "all" })],
      /sim-bridge:stray is not adopted \(GA-DEF-9\)/);
    refused([up("target", { id: "sim-bridge:gone", room: "hall" })], /no device the applier describes/);
  });

  it("takes an unadopted device under defines-unadopted, and nothing else", () => {
    const ctx = context({ mutation: "defines-unadopted" });
    expect(planDefine(baseline(), [up("target", { id: "sim-bridge:stray", room: "hall" })], ctx).draft.targets.get("sim-bridge:stray")?.room)
      .toBe("hall");
    refused([up("target", { id: "sim-bridge:entry", room: "hall" })], /GA-DEF-10/, ctx);
  });

  it("refuses an internal device in a room or a group, and names it without one (GA-DEF-10)", () => {
    refused([up("target", { id: "sim-bridge:entry", room: "hall" })], /sim-bridge:entry is internal: no room \(GA-DEF-10\)/);
    refused([up("group", { id: "g", name: "g", room: "hall", members: ["sim-bridge:entry"], aggregate: "any" })],
      /sim-bridge:entry is internal: no group \(GA-DEF-10\)/);
    expect(planDefine(baseline(), [up("target", { id: "sim-bridge:entry", name: "Реле", room: null })], context()).draft.targets
      .get("sim-bridge:entry")?.name).toBe("Реле");
  });

  it("takes an internal device in a room or a group under rooms-an-internal-device, and nothing else", () => {
    const ctx = context({ mutation: "rooms-an-internal-device" });
    const h = planDefine(baseline(), [up("target", { id: "sim-bridge:entry", room: "hall" }),
      up("group", { id: "g", name: "g", room: null, members: ["sim-bridge:entry"], aggregate: "any" })], ctx).draft;
    expect(h.groups.get("g")?.members).toEqual(["sim-bridge:entry"]);
    refused([up("target", { id: "sim-bridge:stray", room: "hall" })], /GA-DEF-9/, ctx);
  });

  it("checks rooms, and keeps a group's id apart from the applier's device ids", () => {
    refused([up("target", { id: "sim-bridge:lamp", room: "attic" })], /target sim-bridge:lamp: no room attic/);
    refused([up("group", { id: "g", name: "g", room: "attic", members: [], aggregate: "any" })], /group g: no room attic/);
    refused([del("room", { id: "hall" }), del("endpoint", { id: "hall-panel" }), del("credential", { id: "hall-panel" })],
      /no room hall/, context(), furnished());
    refused([up("group", { id: "sim-bridge:lamp", name: "g", room: null, members: [], aggregate: "any" })],
      /group sim-bridge:lamp: the applier has a device of that id/);
  });
});

describe("planDefine's rules", () => {
  const LAMP = "sim-bridge:lamp";
  // A rule, `v` over it; a field given undefined is left out.
  const rule = (v: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ id: "night", name: "Ночник",
    trigger: { state: { target: "sim-bridge:dimmer", key: "on", op: "eq", value: true } },
    actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }], ...v }).filter(([, x]) => x !== undefined));

  it("keeps a rule whole, active and with no exception unless given, a diff line for it, and merges an upsert into it", () => {
    const { draft, diff } = planDefine(baseline(), [up("rule", rule())], context());
    expect(draft.rules.get("night")).toEqual({ ...rule(), active: true, exceptions: [] });
    expect(diff.some((l) => l.startsWith("+ rule night: "))).toBe(true);
    const next = planDefine(draft, [up("rule", rule({ active: false, trigger: null,
      conditions: [{ between: { from: "23:00", until: "06:00" } }] }))], context()).draft;
    expect(next.rules.get("night")!.active).toBe(false);
    expect(next.rules.get("night")!.trigger).toBeUndefined();
    expect(planDefine(next, [del("rule", { id: "night" })], context()).draft.rules.size).toBe(0);
  });

  it("refuses a rule with neither trigger nor conditions, and a reading with both op and not_in, by its schema", () => {
    refused([up("rule", { id: "x", name: "x", actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] })], /change 1 \(upsert rule\)/);
    refused([up("rule", rule({ conditions: [{ target: LAMP, key: "on", op: "eq", value: true, not_in: [false] }] }))], /change 1 \(upsert rule\)/);
  });

  it("refuses a window whose from equals its until (GA-RULE-3), and an exception whose until is not after its from (GA-RULE-6)", () => {
    refused([up("rule", rule({ conditions: [{ between: { from: "21:00", until: "21:00" } }] }))], /from equals its until \(GA-RULE-3\)/);
    refused([up("rule", rule({ trigger: undefined, conditions: [{ between: { from: "07:00", until: "07:00", days: [1] } }] }))], /GA-RULE-3/);
    refused([up("rule", rule({ exceptions: [{ from: "2030-01-06T21:30:00+03:00", until: "2030-01-06T21:30:00+03:00" }] }))], /not after its from .* \(GA-RULE-6\)/);
    refused([up("rule", rule({ exceptions: [{ from: "2030-01-06T21:30:00+03:00", until: "2030-01-06T18:00:00Z" }] }))], /GA-RULE-6/);
  });

  it("adds an exception to a rule, once, in time order, and removes it again; refuses one of no rule, or out of order", () => {
    const h = planDefine(baseline(), [up("rule", rule())], context()).draft;
    const late = { rule: "night", from: "2030-01-07T21:00:00+03:00", until: "2030-01-07T21:30:00+03:00" };
    const early = { rule: "night", from: "2030-01-06T21:00:00+03:00", until: "2030-01-06T21:30:00+03:00" };
    const { draft, diff } = planDefine(h, [up("rule_exception", late), up("rule_exception", early), up("rule_exception", early)], context());
    expect(draft.rules.get("night")!.exceptions).toEqual([{ from: early.from, until: early.until }, { from: late.from, until: late.until }]);
    expect(diff.some((l) => l.startsWith("~ rule night: exceptions"))).toBe(true);
    expect(planDefine(draft, [del("rule_exception", early)], context()).draft.rules.get("night")!.exceptions).toEqual([{ from: late.from, until: late.until }]);
    refused([up("rule_exception", { ...early, rule: "day" })], /no rule day/, context(), h);
    refused([up("rule_exception", { ...early, until: early.from })], /GA-RULE-6/, context(), h);
    refused([del("rule_exception", early)], /no such exception/, context(), h);
  });

  it("refuses a rule naming a device the applier does not describe or has not adopted, in its trigger, conditions or actions (GA-DEF-9)", () => {
    refused([up("rule", rule({ trigger: { state: { target: "sim-bridge:stray", key: "on", op: "eq", value: true } } }))], /not adopted \(GA-DEF-9\)/);
    refused([up("rule", rule({ conditions: [{ target: "sim-bridge:gone", key: "on", not_in: [true] }] }))], /no device the applier describes/);
    refused([up("rule", rule({ actions: [{ target: "sim-bridge:stray", action: "notify.notify", args: {} }] }))], /GA-DEF-9/);
    refused([up("rule", rule({ trigger: { event: { target: "sim-bridge:stray", type: "liveness", new: "dead" } } }))], /GA-DEF-9/);
  });

  it("refuses a rule acting on an internal device (GA-DEF-10), but takes one reading it, and a group's id as a target", () => {
    refused([up("rule", rule({ actions: [{ target: "sim-bridge:entry", action: "onoff.turn_on", args: {} }] }))], /internal: no rule's action \(GA-DEF-10\)/);
    const reads = rule({ conditions: [{ target: "sim-bridge:entry", key: "on", op: "eq", value: false }] });
    expect(planDefine(baseline(), [up("rule", reads)], context()).draft.rules.has("night")).toBe(true);
    const grouped = [up("group", { id: "lights", name: "Свет", room: null, members: [LAMP, "sim-bridge:dimmer"], aggregate: "any" }),
      up("rule", rule({ actions: [{ target: "lights", action: "onoff.turn_off", args: {} }] }))];
    expect(planDefine(baseline(), grouped, context()).draft.rules.has("night")).toBe(true);
  });

  it("takes a rule acting on an internal device under rules-a-wake-relay, and nothing else", () => {
    const wake = rule({ actions: [{ target: "sim-bridge:entry", action: "onoff.turn_on", args: {} }] });
    expect(planDefine(baseline(), [up("rule", wake)], context({ mutation: "rules-a-wake-relay" })).draft.rules.has("night")).toBe(true);
    refused([up("rule", rule({ actions: [{ target: "sim-bridge:stray", action: "notify.notify", args: {} }] }))], /GA-DEF-9/,
      context({ mutation: "rules-a-wake-relay" }));
  });
});

describe("planDefine's scenarios", () => {
  const LAMP = "sim-bridge:lamp";
  const off = { target: LAMP, action: "onoff.turn_off", args: {} };
  // A scenario, `v` over it.
  const scenario = (v: Record<string, unknown> = {}) => ({ id: "night", name: "Ночь", mode: "single", steps: [off], ...v });
  const cycle = (changes: Change[], message: RegExp, h = furnished()) =>
    expect(() => planDefine(h, changes, context())).toThrow(expect.objectContaining({ code: "cycle", message: expect.stringMatching(message) }));

  it("keeps a scenario whole, owning nothing and not respecting occupancy unless given, a diff line for it", () => {
    const { draft, diff } = planDefine(furnished(), [up("scenario", scenario())], context());
    expect(draft.scenarios.get("night")).toEqual({ ...scenario(), owned: [], respect_occupancy: false });
    expect(diff.find((l) => l.startsWith("+ scenario night"))).toContain("mode \"single\"");
    // What a scenario owns is the author's to list; the diff shows it, so an empty one is seen (G11, ratified by the maintainer 2026-10-05).
    expect(diff.find((l) => l.startsWith("+ scenario night"))).toContain("owned []");
    const h = planDefine(draft, [up("scenario", scenario({ owned: ["hall-lights"], respect_occupancy: true, steps: [{ delay: 5 }] }))], context()).draft;
    expect(h.scenarios.get("night")).toEqual({ ...scenario(), owned: ["hall-lights"], respect_occupancy: true, steps: [{ delay: 5 }] });
    expect(planDefine(h, [del("scenario", { id: "night" })], context()).draft.scenarios.size).toBe(0);
  });

  it("refuses deleting a group a rule or a scenario still names, listing each; deleting them in the same change set is taken", () => {
    const h = planDefine(furnished(), [up("scenario", scenario({ owned: ["hall-lights"] })), up("scenario", scenario({ id: "eve", steps: [{ target: "hall-lights", action: "onoff.turn_on", args: {} }] })),
      up("rule", { id: "dark", name: "Темно", conditions: [{ target: LAMP, key: "on", op: "eq", value: false }], actions: [{ target: "hall-lights", action: "onoff.turn_on", args: {} }] })], context()).draft;
    refused([del("group", { id: "hall-lights" })], /group hall-lights is still named by rule dark, scenario eve, scenario night/, context(), h);
    const gone = planDefine(h, [del("group", { id: "hall-lights" }), del("rule", { id: "dark" }), del("scenario", { id: "eve" }), del("scenario", { id: "night" })], context()).draft;
    expect(gone.groups.has("hall-lights")).toBe(false);
  });

  it("refuses a mode the steward does not run, with invalid_request (GA-SCN-5): it lists single only", () => {
    for (const mode of ["restart", "queued", "parallel"]) refused([up("scenario", scenario({ mode }))], new RegExp(`mode ${mode} is not one this steward runs`), context(), furnished());
    refused([up("scenario", scenario({ mode: "sometimes" }))], /change 1 \(upsert scenario\)/, context(), furnished());
  });

  it("checks each branch of an if as a scenario's steps", () => {
    const iff = (then: unknown[]) => ({ if: { target: LAMP, key: "on", op: "eq", value: true }, then });
    refused([up("scenario", scenario({ steps: [iff([{ delay: 0 }])] }))], /a branch of an if/, context(), furnished());
    refused([up("scenario", scenario({ steps: [iff([iff([{ target: LAMP, action: "onoff.turn_off" }])])] }))], /a branch of an if/, context(), furnished());
    expect(planDefine(furnished(), [up("scenario", scenario({ steps: [iff([iff([off])])] }))], context()).draft.scenarios.has("night")).toBe(true);
  });

  it("refuses a device not described or not adopted in an action, an if, a wait or owned (GA-DEF-9)", () => {
    const iff = (target: string) => ({ if: { target, key: "on", op: "eq", value: true }, then: [off] });
    const wait = (target: string) => ({ wait: { target, key: "on", value: true, timeout_s: 10 } });
    for (const id of ["sim-bridge:stray", "sim-bridge:gone"]) {
      const why = id === "sim-bridge:stray" ? /not adopted \(GA-DEF-9\)/ : /no device the applier describes/;
      refused([up("scenario", scenario({ steps: [{ target: id, action: "notify.notify", args: {} }] }))], why, context(), furnished());
      refused([up("scenario", scenario({ steps: [iff(id)] }))], why, context(), furnished());
      refused([up("scenario", scenario({ steps: [wait(id)] }))], why, context(), furnished());
      refused([up("scenario", scenario({ owned: [id] }))], why, context(), furnished());
      refused([up("scenario", scenario({ steps: [iff(LAMP), { if: iff(LAMP).if, then: [{ target: id, action: "notify.notify", args: {} }] }] }))], why, context(), furnished());
    }
  });

  it("refuses a scenario acting on an internal device (GA-DEF-10), but takes one reading, waiting on or owning it, and a group's id", () => {
    const ENTRY = "sim-bridge:entry";
    refused([up("scenario", scenario({ steps: [{ target: ENTRY, action: "onoff.turn_on", args: {} }] }))], /internal: no scenario's action \(GA-DEF-10\)/,
      context(), furnished());
    refused([up("scenario", scenario({ steps: [{ if: { target: LAMP, key: "on", op: "eq", value: true }, then: [{ target: ENTRY, action: "onoff.turn_on", args: {} }] }] }))],
      /internal: no scenario's action/, context(), furnished());
    refused([up("scenario", scenario({ steps: [{ target: ENTRY, action: "onoff.turn_on", args: {} }] }))], /internal/, context({ mutation: "rooms-an-internal-device" }), furnished());
    const ok = scenario({ owned: [ENTRY], steps: [{ if: { target: ENTRY, key: "on", op: "eq", value: true }, then: [{ target: "hall-lights", action: "onoff.turn_on", args: {} }] },
      { wait: { target: ENTRY, key: "on", value: false, timeout_s: 30 } }] });
    expect(planDefine(furnished(), [up("scenario", ok)], context()).draft.scenarios.has("night")).toBe(true);
  });

  it("refuses run steps that form a cycle, with cycle (GA-DEF-4), itself included, and a run step or a rule's start naming no scenario", () => {
    cycle([up("scenario", scenario({ steps: [{ run: "night" }] }))], /night → night/);
    cycle([up("scenario", scenario({ id: "a", steps: [off, { run: "b" }] })), up("scenario", scenario({ id: "b", steps: [{ if: { target: LAMP, key: "on", op: "eq", value: true },
      then: [{ run: "c" }] }] })), up("scenario", scenario({ id: "c", steps: [{ run: "a" }] }))], /a → b → c → a/);
    const chain = planDefine(furnished(), [up("scenario", scenario({ id: "a", steps: [{ run: "b" }] })), up("scenario", scenario({ id: "b" }))], context()).draft;
    cycle([up("scenario", scenario({ id: "b", steps: [{ run: "a" }] }))], /a → b → a/, chain);
    refused([up("scenario", scenario({ steps: [{ run: "nowhere" }] }))], /its run step names no scenario nowhere/, context(), furnished());
    refused([del("scenario", { id: "b" })], /scenario a: its run step names no scenario b/, context(), chain);
    const rule = { id: "door", name: "Дверь", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }], actions: [{ scenario: "b" }] };
    const ruled = planDefine(chain, [up("rule", rule)], context()).draft;
    refused([up("rule", { ...rule, actions: [{ scenario: "nowhere" }] })], /rule door: it starts no scenario nowhere/, context(), chain);
    refused([del("scenario", { id: "a" }), del("scenario", { id: "b" })], /rule door: it starts no scenario b/, context(), ruled);
  });
});
