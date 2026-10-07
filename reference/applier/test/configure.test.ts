import { describe, expect, it } from "vitest";
import { emptyConfig, modelKey } from "../src/config/config.js";
import { planChanges, tierIn, type Change, type DeviceInfo } from "../src/config/configure.js";

const ctx = { levels: ["Act" as const], underHarness: true, ownerCredential: "owner-credential" };
/** A lamp as the model holds it: what configure must know of it. */
const LAMP: DeviceInfo = { capabilities: ["onoff"], sensor_keys: [], actions: ["onoff.turn_on", "onoff.turn_off"], reach_s: 1,
  personal: [], self_changing: [], in_devices: true, stable_identifier: "test:lamp", bridge: "hall" };
const client = (id: string, credential = `${id}-credential`): Change =>
  ({ op: "upsert", kind: "client", value: { id, credential, kind: "steward" } });

describe("planChanges", () => {
  it("adds, changes and removes clients and bridges, with a readable diff", () => {
    const { draft, diff } = planChanges(emptyConfig(), [client("a"), { op: "upsert", kind: "bridge", value: { id: "b", identity: "b" } }], ctx);
    expect([...draft.clients.keys()]).toEqual(["a"]);
    expect(diff).toEqual(["+ client a (steward)", "+ bridge b"]);
    const second = planChanges(draft, [{ op: "delete", kind: "client", value: { id: "a" } }], ctx);
    expect(second.draft.clients.size).toBe(0);
    expect(second.diff).toEqual(["- client a"]);
  });

  it("leaves the current configuration untouched", () => {
    const current = emptyConfig();
    planChanges(current, [client("a")], ctx);
    expect(current.clients.size).toBe(0);
  });

  it("refuses the whole set when one change is invalid, naming its index", () => {
    expect(() => planChanges(emptyConfig(), [client("a"), { op: "upsert", kind: "client", value: { id: "" } }], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringContaining("changes[1]") }));
  });

  it("refuses a Safe kind on an applier claiming only Act with not_claimed", () => {
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "safety_rule", value: { id: "r" } }], ctx))
      .toThrow(expect.objectContaining({ code: "not_claimed" }));
  });

  it("refuses an unknown kind, a credential already held, and time_source outside the harness", () => {
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "nonsense", value: {} }], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => planChanges(emptyConfig(), [client("a", "same-credential"), client("b", "same-credential")], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => planChanges(emptyConfig(), [client("a", "owner-credential")], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "time_source", value: "127.0.0.1:1" }],
      { ...ctx, underHarness: false })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "constructor", value: {} }], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "toString", value: {} }], ctx))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("refuses a bridge id longer than 32 characters, so every id it prefixes fits 128", () => {
    const bridge = (id: string): Change => ({ op: "upsert", kind: "bridge", value: { id, identity: "hall" } });
    expect(planChanges(emptyConfig(), [bridge("b".repeat(32))], ctx).draft.bridges.size).toBe(1);
    expect(() => planChanges(emptyConfig(), [bridge("b".repeat(33))], ctx)).toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("refuses a client whose token key is its credential: two secrets, or none", () => {
    const same = { op: "upsert", kind: "client", value: { id: "a", credential: "a-credential-of-16", kind: "steward", token_key: "a-credential-of-16" } };
    expect(() => planChanges(emptyConfig(), [same as Change], ctx)).toThrow(expect.objectContaining({ code: "invalid_request",
      message: expect.stringMatching(/token key.*credential/) }));
  });

  it("gives no diff line for an upsert identical to what is held", () => {
    const { draft } = planChanges(emptyConfig(), [client("a")], ctx);
    expect(planChanges(draft, [client("a")], ctx).diff).toEqual([]);
  });

  it("adopts a device the model holds with the owner's class, and changes it; the diff says so", () => {
    const withDevices = { ...ctx, devices: new Map([["hall:lamp", LAMP]]) };
    const adopt = (cls: string | null, extra: Record<string, unknown> = {}): Change =>
      ({ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: cls, ...extra } });
    const first = planChanges(emptyConfig(), [adopt("light")], withDevices);
    expect(first.draft.adoptions.get("hall:lamp")).toEqual({ class: "light" });
    expect(first.diff).toEqual(["+ adopt hall:lamp (light)"]);
    expect(planChanges(first.draft, [adopt("light")], withDevices).diff).toEqual([]);
    expect(planChanges(first.draft, [adopt("socket")], withDevices).diff).toEqual(["~ adopt hall:lamp (socket)"]);
  });

  it("refuses an adoption of a device it does not hold, a null class, replaces naming nothing held, and a delete of a device not adopted", () => {
    const withDevices = { ...ctx, devices: new Map([["hall:lamp", LAMP]]) };
    for (const value of [{ device: "hall:kettle", class: "socket" }, { device: "hall:lamp", class: null },
      { device: "hall:lamp", class: "light", replaces: "hall:old" },
      { device: "hall:lamp", class: "robot" }]) {
      expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "adopt", value }], withDevices), JSON.stringify(value))
        .toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
    expect(() => planChanges(emptyConfig(), [{ op: "delete", kind: "adopt", value: { device: "hall:lamp" } }], withDevices))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("deletes an adoption: the device is unadopted again, and the owner's declarations for it go", () => {
    const withDevices = { ...ctx, devices: new Map([["hall:lamp", LAMP]]) };
    const { draft } = planChanges(emptyConfig(), [{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light",
      declarations: { tiers: { "onoff.turn_on": "confirm" } } } }], withDevices);
    const { draft: after, diff } = planChanges(draft, [{ op: "delete", kind: "adopt", value: { device: "hall:lamp" } }], withDevices);
    expect([after.adoptions.size, after.declarations.size]).toEqual([0, 0]);
    expect(diff).toEqual(["- adopt hall:lamp"]);
  });

  it("replaces an adopted device: the new hardware takes its id, class and declarations but fresh_s; the old identifier is retired (GA-ADOPT-2)", () => {
    const at = { ...ctx, devices: new Map<string, DeviceInfo>([
      ["hall:lamp", { ...LAMP, in_devices: false }], ["hall:lamp-2", { ...LAMP, stable_identifier: "test:lamp-2" }],
      ["hall:probe", { ...LAMP, capabilities: ["sensor"], sensor_keys: ["temperature"], actions: [], stable_identifier: "test:probe" }],
      ["hall:again", LAMP]]) };
    const adopt = (value: Record<string, unknown>): Change => ({ op: "upsert", kind: "adopt", value });
    const replace = (device: string, extra: Record<string, unknown> = {}) => adopt({ device, class: "light", replaces: "hall:lamp", ...extra });
    const refused = (from: ReturnType<typeof emptyConfig>, changes: Change[], why: RegExp) =>
      expect(() => planChanges(from, changes, at)).toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(why) }));
    const { draft: held } = planChanges(emptyConfig(), [adopt({ device: "hall:lamp", class: "light",
      declarations: { tiers: { "onoff.turn_on": "confirm" }, fresh_s: 20, personal: ["on"] } })], at);
    const r = planChanges(held, [replace("hall:lamp-2")], at);
    expect(r.replaced).toEqual([{ device: "hall:lamp-2", replaces: "hall:lamp" }]);
    expect([...r.draft.adoptions]).toEqual([["hall:lamp", { class: "light" }]]);
    expect(r.draft.declarations.get("hall:lamp")).toEqual({ tiers: { "onoff.turn_on": "confirm" }, personal: ["on"] });
    expect(r.draft.previous.get("hall:lamp")).toEqual(["test:lamp"]);
    expect(r.diff).toEqual(["~ adopt hall:lamp (light) as hall:lamp-2, replacing test:lamp"]);
    // A later change in the same set finds the id on the new hardware.
    expect(planChanges(held, [replace("hall:lamp-2"), { op: "upsert", kind: "fresh_s", value: { device: "hall:lamp", fresh_s: 30 } }], at)
      .draft.declarations.get("hall:lamp")).toMatchObject({ fresh_s: 30 });
    refused(held, [replace("hall:probe")], /lacks onoff.turn_on, on/);
    // The retired hardware never takes the id back; the same hardware replacing itself keeps its identifier.
    refused(r.draft, [replace("hall:again")], /retired/);
    expect(planChanges(held, [replace("hall:again")], at).draft.previous.get("hall:lamp")).toBeUndefined();
    refused(emptyConfig(), [replace("hall:lamp-2")], /hall:lamp is not adopted/);
    refused(held, [adopt({ device: "hall:lamp", class: "light", replaces: "hall:lamp" })], /itself/);
    const both = planChanges(held, [adopt({ device: "hall:lamp-2", class: "light" })], at).draft;
    refused(both, [replace("hall:lamp-2")], /adopted already/);
    // One id replaced twice in a set, or forgotten in the set that replaces it, is refused whatever the order.
    refused(held, [replace("hall:lamp-2"), replace("hall:again")], /replaced already in this change set/);
    refused(held, [replace("hall:lamp-2"), { op: "upsert", kind: "forget", value: { device: "hall:lamp" } }], /replaced in this change set/);
    // The same hardware on another bridge takes the adopted id by a replacement: a route never moves an adopted device.
    const porch = { ...at, devices: new Map([...at.devices, ["porch:lamp", { ...LAMP, bridge: "porch" }]]) };
    const moved = planChanges(held, [replace("porch:lamp")], porch);
    expect(moved.replaced).toEqual([{ device: "porch:lamp", replaces: "hall:lamp" }]);
    expect(moved.draft.previous.get("hall:lamp") ?? []).toEqual([]);
    // `replaces-without-rules`: the id alone.
    expect(planChanges(held, [replace("hall:lamp-2")], { ...at, mutation: "replaces-without-rules" as const })
      .draft.declarations.get("hall:lamp")).toBeUndefined();
  });

  it("forgets a device that left its bridge's devices, with its adoption, declarations and replaced identifiers; never one still listed (GA-ADOPT-1)", () => {
    const at = { ...ctx, devices: new Map([["hall:lamp", LAMP], ["hall:old", { ...LAMP, in_devices: false }]]) };
    const forget = (device: string): Change => ({ op: "upsert", kind: "forget", value: { device } });
    const { draft: held } = planChanges(emptyConfig(), [{ op: "upsert", kind: "adopt", value: { device: "hall:old", class: "light",
      declarations: { fresh_s: 20 } } }], at);
    held.previous.set("hall:old", ["test:older"]);
    const { draft, diff, forgotten } = planChanges(held, [forget("hall:old")], at);
    expect(forgotten).toEqual(["hall:old"]);
    expect(diff).toEqual(["- device hall:old"]);
    expect([draft.adoptions.size, draft.declarations.size, draft.previous.size]).toEqual([0, 0, 0]);
    // A later change in the same set finds the device gone.
    expect(() => planChanges(held, [forget("hall:old"), { op: "upsert", kind: "fresh_s", value: { device: "hall:old", fresh_s: 5 } }], at))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/no device hall:old/) }));
    expect(() => planChanges(emptyConfig(), [forget("hall:lamp")], at))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/still in its bridge's devices/) }));
    expect(() => planChanges(held, [{ op: "delete", kind: "forget", value: { device: "hall:old" } }], at))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
  });

  it("refuses to adopt a copy of hardware another bridge also shows beside it: a replacement moves the adopted device there (GA-BUS-11)", () => {
    const at = { ...ctx, devices: new Map([["hall:lamp", LAMP], ["porch:lamp", { ...LAMP, bridge: "porch" }]]) };
    const kin = { ...ctx, devices: new Map([["hall:lamp", LAMP], ["hall:lamp-2", LAMP]]) };
    const adopt = (device: string): Change => ({ op: "upsert", kind: "adopt", value: { device, class: "light" } });
    expect(() => planChanges(emptyConfig(), [adopt("porch:lamp")], at))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/porch:lamp.*hall:lamp.*replaces/) }));
    // A copy on its own bridge (hardware admitted anew) is the owner's to adopt, or to take with replaces.
    expect(planChanges(emptyConfig(), [adopt("hall:lamp-2")], kin).draft.adoptions.has("hall:lamp-2")).toBe(true);
    // A device adopted already keeps taking a new class.
    const held = { ...emptyConfig(), adoptions: new Map([["porch:lamp", { class: "light" }]]) };
    expect(planChanges(held, [{ op: "upsert", kind: "adopt", value: { device: "porch:lamp", class: "socket" } }], at)
      .draft.adoptions.get("porch:lamp")).toEqual({ class: "socket" });
  });
});

describe("routes (GA-BUS-11)", () => {
  const withBridges = () => {
    const c = emptyConfig();
    for (const id of ["hall", "porch", "attic"]) c.bridges.set(id, { id, identity: `${id}-bridge` });
    return c;
  };
  const route = (bridge: string, sid = "test:lamp"): Change => ({ op: "upsert", kind: "route", value: { stable_identifier: sid, bridge } });
  const folded = { ...ctx, devices: new Map([["hall:lamp", { ...LAMP, copies: ["porch"] }]]) };

  it("routes an identifier to a bridge that shows a copy of it: its device takes that copy", () => {
    const r = planChanges(withBridges(), [route("porch")], folded);
    expect(r.draft.routes.get("test:lamp")).toBe("porch");
    expect(r.routed).toEqual([{ stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" }]);
    expect(r.diff).toEqual(["+ route test:lamp porch"]);
    expect(planChanges(r.draft, [route("porch")], folded).diff).toEqual([]);
    expect(planChanges(r.draft, [route("hall")], folded).diff).toEqual(["~ route test:lamp hall"]);
  });

  it("never moves an adopted device: a route of an identifier an adopted device shows is refused, and so is deleting it", () => {
    const held = { ...withBridges(), adoptions: new Map([["hall:lamp", { class: "light" }]]) };
    const at = { ...ctx, devices: new Map([["hall:lamp", LAMP], ["porch:lamp", { ...LAMP, bridge: "porch" }]]) };
    expect(() => planChanges(held, [route("porch")], at)).toThrow(expect.objectContaining({ code: "invalid_request",
      message: expect.stringMatching(/hall:lamp is adopted.*keeps its bridge.*replaces/) }));
    expect(() => planChanges(held, [route("hall")], at)).toThrow(/keeps its bridge/);
    const routed = { ...held, routes: new Map([["test:lamp", "hall"]]) };
    expect(() => planChanges(routed, [{ op: "delete", kind: "route", value: { stable_identifier: "test:lamp" } }], folded))
      .toThrow(/hall:lamp is adopted/);
    // With neither adopted, the copy on the route's bridge is the device.
    expect(planChanges(withBridges(), [route("porch")], at).routed[0]!.device).toBe("porch:lamp");
  });

  it("refuses to adopt the one device of two bridges until it is routed: route it first", () => {
    const adopt: Change = { op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } };
    expect(() => planChanges(withBridges(), [adopt], folded)).toThrow(expect.objectContaining({ code: "invalid_request",
      message: expect.stringMatching(/route it first/) }));
    expect(planChanges(withBridges(), [route("hall"), adopt], folded).draft.adoptions.has("hall:lamp")).toBe(true);
    // A route to the copy's bridge moves the device there in the same set, and the adoption follows it.
    expect(planChanges(withBridges(), [route("porch"), adopt], folded).draft.adoptions.has("hall:lamp")).toBe(true);
    // Routed earlier, it is adopted alone.
    const routed = { ...withBridges(), routes: new Map([["test:lamp", "hall"]]) };
    expect(planChanges(routed, [adopt], folded).draft.adoptions.has("hall:lamp")).toBe(true);
  });

  it("refuses a bridge not registered, one that shows no copy or two, and an identifier no device shows", () => {
    const refused = (changes: Change[], at = folded) => expect(() => planChanges(withBridges(), changes, at)).toThrow(
      expect.objectContaining({ code: "invalid_request" }));
    refused([route("cellar")]);
    expect(() => planChanges(withBridges(), [route("cellar")], folded)).toThrow(/no bridge cellar/);
    expect(() => planChanges(withBridges(), [route("attic")], folded)).toThrow(/attic shows no device/);
    expect(() => planChanges(withBridges(), [route("hall", "test:ghost")], folded)).toThrow(/no device shows "test:ghost"/);
    const twice = { ...ctx, devices: new Map([["hall:lamp", { ...LAMP, copies: ["porch"] }], ["hall:lamp-2", LAMP]]) };
    expect(() => planChanges(withBridges(), [route("hall")], twice)).toThrow(/shows "test:lamp" twice/);
    refused([{ op: "upsert", kind: "route", value: { stable_identifier: "test:lamp", bridge: "porch", extra: 1 } }]);
  });

  it("deletes a route by its identifier alone", () => {
    const { draft } = planChanges(withBridges(), [route("porch")], folded);
    const r = planChanges(draft, [{ op: "delete", kind: "route", value: { stable_identifier: "test:lamp" } }], folded);
    expect(r.draft.routes.size).toBe(0);
    expect(r.diff).toEqual(["- route test:lamp"]);
    expect(() => planChanges(r.draft, [{ op: "delete", kind: "route", value: { stable_identifier: "test:lamp" } }], folded))
      .toThrow(/no route/);
  });
});

describe("declarations", () => {
  const SOCKET: DeviceInfo = { ...LAMP, reach_s: 0 };
  const GATE: DeviceInfo = { capabilities: ["cover"], sensor_keys: [], actions: ["cover.open", "cover.close"], reach_s: 30,
    personal: [], self_changing: [], in_devices: true, stable_identifier: "test:gate", bridge: "hall" };
  const DESK: DeviceInfo = { capabilities: ["sensor"], sensor_keys: ["app", "temperature"], actions: [], personal: ["temperature"],
    self_changing: ["temperature"], in_devices: true, stable_identifier: "test:desk", bridge: "hall" };
  const devices = new Map([["hall:lamp", LAMP], ["hall:heater", SOCKET], ["hall:gate", GATE], ["hall:desk", DESK]]);
  const at = { ...ctx, devices };
  const adopt = (device: string, cls: string, declarations?: Record<string, unknown>): Change =>
    ({ op: "upsert", kind: "adopt", value: { device, class: cls, ...(declarations ? { declarations } : {}) } });
  const up = (kind: string, value: Record<string, unknown>): Change => ({ op: "upsert", kind, value });
  const del = (kind: string, value: Record<string, unknown>): Change => ({ op: "delete", kind, value });
  const refused = (changes: Change[], why: RegExp) =>
    expect(() => planChanges(emptyConfig(), changes, at)).toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(why) }));
  const heater = () => planChanges(emptyConfig(), [adopt("hall:heater", "socket")], at).draft;

  it("raises a tier, never lowers one, and refuses a tier for an action the device does not offer (GA-DESC-3)", () => {
    const { draft, diff } = planChanges(emptyConfig(), [adopt("hall:gate", "gate"), up("tier", { device: "hall:gate", action: "cover.close", tier: "no_voice" })], at);
    expect(tierIn(draft, "hall:gate", "cover.close")).toBe("no_voice");
    expect(diff).toEqual(["+ adopt hall:gate (gate)", "~ tier hall:gate cover.close no_voice"]);
    refused([adopt("hall:gate", "gate"), up("tier", { device: "hall:gate", action: "cover.close", tier: "reversible" })], /only raises/);
    expect(() => planChanges(draft, [up("tier", { device: "hall:gate", action: "cover.close", tier: "confirm" })], at))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    refused([up("tier", { device: "hall:lamp", action: "lock.unlock", tier: "confirm" })], /offers no lock.unlock/);
    refused([del("tier", { device: "hall:lamp", action: "onoff.turn_on" })], /never lowered/);
    // Equal to the floor: kept, so a later change of the floor does not lose it; a line only when what is kept changes.
    const kept = planChanges(heater(), [up("tier", { device: "hall:heater", action: "onoff.turn_off", tier: "reversible" })], at);
    expect(kept.draft.declarations.get("hall:heater")).toEqual({ tiers: { "onoff.turn_off": "reversible" } });
    expect(kept.diff).toEqual(["~ tier hall:heater onoff.turn_off reversible"]);
    expect(planChanges(kept.draft, [up("tier", { device: "hall:heater", action: "onoff.turn_off", tier: "reversible" })], at).diff).toEqual([]);
  });

  it("lowers an extension action to its floor, never below it, refused with nothing changed and never clamped; deletes the owner's tier back to the table (GA-DESC-3, GA-DESC-14)", () => {
    const go = "org.galatea.test.box.go";
    const BOX: DeviceInfo = { ...LAMP, actions: [...LAMP.actions, go] };
    const boxes = { ...ctx, devices: new Map([["hall:box", BOX], ["hall:lock", BOX], ["hall:heater", BOX]]) };
    const set = (changes: Change[], from = emptyConfig()) => planChanges(from, changes, boxes);
    const plain = set([adopt("hall:box", "socket")]).draft;
    expect(tierIn(plain, "hall:box", go)).toBe("confirm");
    const lowered = set([up("tier", { device: "hall:box", action: go, tier: "reversible" })], plain);
    expect(lowered.diff).toEqual([`~ tier hall:box ${go} reversible`]);
    expect(tierIn(lowered.draft, "hall:box", go)).toBe("reversible");
    // A heating load raises its floor in the same change set; the owner's lowering stays under it (GA-DESC-13).
    expect(tierIn(set([up("load", { device: "hall:box", load: "heating" })], lowered.draft).draft, "hall:box", go)).toBe("confirm");
    const back = set([del("tier", { device: "hall:box", action: go })], lowered.draft);
    expect([back.diff, tierIn(back.draft, "hall:box", go)]).toEqual([[`- tier hall:box ${go}`], "confirm"]);
    // A door lock's floor is no_voice: confirm is refused, never clamped, nothing changed.
    const lock = set([adopt("hall:lock", "door_lock")]).draft;
    expect(() => set([up("tier", { device: "hall:lock", action: go, tier: "confirm" })], lock))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/floor is no_voice/) }));
    expect(() => set([adopt("hall:heater", "socket", { load: "heating", tiers: { [go]: "reversible" } })]))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringMatching(/floor is confirm/) }));
    // A standard action is still never lowered.
    expect(() => set([del("tier", { device: "hall:box", action: "onoff.turn_on" })], plain)).toThrow(expect.objectContaining({ message: expect.stringMatching(/never lowered/) }));
  });

  it("accepts a door lock's extension action below its floor under lowers-a-lock-extension, clamped there", () => {
    const go = "org.galatea.test.box.go";
    const at2 = { ...ctx, devices: new Map([["hall:lock", { ...LAMP, actions: [go] }]]), mutation: "lowers-a-lock-extension" as const };
    const lock = planChanges(emptyConfig(), [adopt("hall:lock", "door_lock")], at2).draft;
    const r = planChanges(lock, [up("tier", { device: "hall:lock", action: go, tier: "confirm" })], at2);
    expect(tierIn(r.draft, "hall:lock", go)).toBe("no_voice");
  });

  it("keeps an owner's tier equal to the floor through a load change that lowers the floor (GA-DESC-13)", () => {
    const heating = planChanges(heater(), [up("load", { device: "hall:heater", load: "heating" }),
      up("tier", { device: "hall:heater", action: "onoff.turn_on", tier: "confirm" })], at);
    expect(heating.diff).toEqual(["~ load hall:heater heating", "~ tier hall:heater onoff.turn_on confirm"]);
    const lighting = planChanges(heating.draft, [up("load", { device: "hall:heater", load: "lighting" })], at).draft;
    expect(tierIn(lighting, "hall:heater", "onoff.turn_on")).toBe("confirm");
  });

  it("re-applies the table when a load or the infrastructure flag changes, keeping a tier at or above it (GA-DESC-13)", () => {
    const lighting = planChanges(heater(), [up("load", { device: "hall:heater", load: "lighting" }),
      up("tier", { device: "hall:heater", action: "onoff.turn_off", tier: "confirm" })], at).draft;
    expect(tierIn(lighting, "hall:heater", "onoff.turn_on")).toBe("reversible");
    const heating = planChanges(lighting, [up("load", { device: "hall:heater", load: "heating" }),
      up("infrastructure", { device: "hall:heater", infrastructure: true })], at).draft;
    expect(tierIn(heating, "hall:heater", "onoff.turn_on")).toBe("confirm");
    expect(tierIn(heating, "hall:heater", "onoff.turn_off")).toBe("no_voice");
    expect(tierIn(heating, "hall:heater", "onoff.turn_off", true)).toBe("no_voice");
    expect(tierIn(heating, "hall:heater", "onoff.turn_on", true)).toBe("reversible");
    const cleared = planChanges(heating, [del("infrastructure", { device: "hall:heater" })], at).draft;
    expect(tierIn(cleared, "hall:heater", "onoff.turn_off")).toBe("confirm");
  });

  it("takes a load only on an adopted socket, and refuses a class change that leaves one elsewhere", () => {
    refused([up("load", { device: "hall:lamp", load: "heating" })], /only on a socket/);
    const { draft } = planChanges(heater(), [up("load", { device: "hall:heater", load: "heating" })], at);
    expect(() => planChanges(draft, [adopt("hall:heater", "light")], at)).toThrow(expect.objectContaining({ message: expect.stringMatching(/no longer a socket/) }));
    expect(planChanges(draft, [del("load", { device: "hall:heater" })], at).draft.declarations.size).toBe(0);
  });

  it("refuses an ack_within_s below 2, below twice reach_s plus 10, or above 300 (GA-CFG-3)", () => {
    const ack = (s: number, device = "hall:gate") => up("ack_within_s", { device, action: device === "hall:gate" ? "cover.close" : "onoff.turn_on", ack_within_s: s });
    refused([ack(1, "hall:heater")], /below 2/);
    refused([ack(69)], /twice hall:gate's reach_s \(30\) plus 10/);
    refused([ack(301)], /above 300/);
    expect(planChanges(emptyConfig(), [ack(70), ack(10, "hall:heater")], at).draft.declarations.get("hall:gate")).toEqual({ ack_within_s: { "cover.close": 70 } });
    expect(planChanges(emptyConfig(), [ack(300)], at).diff).toEqual(["~ ack_within_s hall:gate cover.close 300"]);
  });

  it("adds personal and self_changing keys, and removes only the owner's (GA-DESC-9)", () => {
    const { draft } = planChanges(emptyConfig(), [up("personal", { device: "hall:desk", key: "temperature" }),
      up("personal", { device: "hall:desk", key: "app" }), up("self_changing", { device: "hall:desk", key: "app" })], at);
    // temperature is the bridge's and app the standard's: only self_changing app is the owner's.
    expect(draft.declarations.get("hall:desk")).toEqual({ self_changing: ["app"] });
    refused([del("personal", { device: "hall:desk", key: "app" })], /standard declares app personal/);
    refused([del("self_changing", { device: "hall:desk", key: "temperature" })], /bridge declares temperature self_changing/);
    refused([del("personal", { device: "hall:desk", key: "mood" })], /no personal key mood/);
    expect(planChanges(draft, [del("self_changing", { device: "hall:desk", key: "app" })], at).draft.declarations.size).toBe(0);
  });

  it("takes an owner's fresh_s, and deletes it", () => {
    const { draft } = planChanges(emptyConfig(), [up("fresh_s", { device: "hall:lamp", fresh_s: 20 })], at);
    expect(draft.declarations.get("hall:lamp")).toEqual({ fresh_s: 20 });
    expect(planChanges(draft, [del("fresh_s", { device: "hall:lamp" })], at).draft.declarations.size).toBe(0);
    refused([up("fresh_s", { device: "hall:nowhere", fresh_s: 20 })], /no device hall:nowhere/);
  });

  it("adopts with declarations, each checked as its kind: a valve that opens with turn_off", () => {
    const { draft, diff } = planChanges(emptyConfig(), [adopt("hall:lamp", "water_valve", { opens_with: "onoff.turn_off",
      tiers: { "onoff.turn_on": "confirm" }, fresh_s: 600 })], at);
    expect(tierIn(draft, "hall:lamp", "onoff.turn_off")).toBe("no_voice");
    expect(tierIn(draft, "hall:lamp", "onoff.turn_on")).toBe("confirm");
    expect(diff).toEqual(["+ adopt hall:lamp (water_valve)\n~ opens_with hall:lamp onoff.turn_off\n~ tier hall:lamp onoff.turn_on confirm\n~ fresh_s hall:lamp 600"]);
    refused([adopt("hall:lamp", "light", { opens_with: "onoff.turn_off" })], /only on a water or gas valve/);
    refused([adopt("hall:gate", "gate", { tiers: { "cover.close": "reversible" } })], /only raises/);
    // A Safe field is not_claimed on an applier claiming only Act, before the schema is read (GA-LVL-1).
    expect(() => planChanges(emptyConfig(), [adopt("hall:lamp", "light", { max_on_s: 3600 })], at))
      .toThrow(expect.objectContaining({ code: "not_claimed", message: expect.stringMatching(/max_on_s/) }));
    expect(() => planChanges(emptyConfig(), [adopt("hall:lamp", "light", { max_on_s: "x", nonsense: 1 })], at))
      .toThrow(expect.objectContaining({ code: "not_claimed" }));
    refused([adopt("hall:lamp", "light", { nonsense: 1 })], /declarations/);
    // An empty set of declarations is the same as none.
    expect(planChanges(emptyConfig(), [adopt("hall:lamp", "light", {})], at).draft.declarations.size).toBe(0);
  });
});


describe("ignores (slice 5b, GA-DISC-3)", () => {
  const listed = () => [{ id: "c1", keys: ["mac:01", "mdns:x"] }];
  const withList = { ...ctx, listed };
  it("adds a listed candidate's keys, removes one key, and refuses an id not listed or a key not ignored; never the model", () => {
    const one = planChanges(emptyConfig(), [{ op: "upsert", kind: "ignore_candidate", value: { id: "c1" } }], withList);
    expect([...one.draft.ignored_keys].sort()).toEqual(["mac:01", "mdns:x"]);
    expect(one.diff).toEqual(["+ ignored mac:01, mdns:x"]);
    const two = planChanges(one.draft, [{ op: "upsert", kind: "unignore_candidate", value: { key: "mdns:x" } }], withList);
    expect([...two.draft.ignored_keys]).toEqual(["mac:01"]);
    expect([...one.draft.ignored_keys].sort()).toEqual(["mac:01", "mdns:x"]);
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "ignore_candidate", value: { id: "nope" } }], withList))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringContaining("not listed") }));
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "unignore_candidate", value: { key: "mac:09" } }], withList))
      .toThrow(expect.objectContaining({ code: "invalid_request", message: expect.stringContaining("not ignored") }));
    expect(() => planChanges(emptyConfig(), [{ op: "delete", kind: "ignore_candidate", value: { id: "c1" } }], withList)).toThrow(/upsert/);
    expect(() => planChanges(emptyConfig(), [{ op: "upsert", kind: "ignore_candidate", value: { id: "c1", extra: 1 } }], withList))
      .toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(modelKey(one.draft)).toBe(modelKey(emptyConfig()));
  });
});
