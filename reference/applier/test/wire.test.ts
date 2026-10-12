import { describe, expect, it } from "vitest";
import { MAX_ACK_ID, MAX_EXTENSION_ITEMS, MAX_DETAIL, MAX_REASON, parseAck, parseDevices, parseDeviceStatus, parseEvent, parseStatus, parseTime } from "../src/bus/wire.js";

const T = "2030-01-01T08:00:00.000Z";
const t = Date.parse(T);

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, stableIdentifier: `test:${id}`, transport: "test", model: { vendor: "demo", model: id }, capabilities: ["onoff"],
  actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }], feedback: "closed",
  reachMs: 1000, proposedClass: "light", classEvidence: "protocol", ...extra,
});

const status = (extra: Record<string, unknown> = {}) => ({
  bridgeId: "b", instanceId: "i-1", v: 1, state: "online", version: "1", levels: ["Serve"], faults: [], ungoverned: [],
  blocked: [], transports: [{ id: "test", kind: "zigbee", state: "up", since: T }],
  devices: [{ id: "lamp", transport: "test", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, timestamp: T,
    lastCheckIn: T, observable: true, since: T }],
  publishedAt: T, ...extra,
});

describe("parseTime", () => {
  it("takes any RFC 3339 offset, and refuses what is not a real instant", () => {
    expect(parseTime(T)).toBe(t);
    expect(parseTime("2030-01-01T08:00:00+00:00")).toBe(t);
    expect(parseTime("2030-01-01T11:00:00+03:00")).toBe(t);
    expect(parseTime("2030-01-01T08:00:00Z")).toBe(t);
    for (const bad of ["2030-02-30T00:00:00Z", "2030-13-01T00:00:00Z", "yesterday", "2030-01-01", 17, null]) {
      expect(parseTime(bad)).toBeUndefined();
    }
  });
});

describe("parseDevices: a plugin's requested tier and tool hash", () => {
  it("keeps an action's requestedTier and toolHash, and drops an action whose requestedTier is no tier, with a fault", () => {
    const r = parseDevices({ devices: [entry("box", { capabilities: ["media"], actions: [
      { action: "media.pause", idempotent: true, stateless: false, confirms: true, requestedTier: "confirm", toolHash: "ab" },
      { action: "media.resume", idempotent: true, stateless: false, confirms: true, requestedTier: "high" }] })] });
    expect(r.value.devices[0]!.actions).toEqual([{ action: "media.pause", idempotent: true, stateless: false, toggles: false, whole_state: false,
      confirms: true, requested_tier: "confirm", tool_hash: "ab" }]);
    expect(r.faults).toEqual([expect.stringMatching(/media.resume\) requests the tier "high"/)]);
  });
});

describe("parseDevices: extensions on any device (bridge, *Extension names*)", () => {
  const PUSH = "org.galatea.test.pusher";
  const ext = (extra: Record<string, unknown> = {}) => ({ capability: PUSH, description: "A button pusher's own settings.",
    actions: [{ action: `${PUSH}.set_mode`, description: "Sets the mode.", schema: { type: "object", properties: { mode: { enum: ["click", "switch"] } } } }],
    keys: [{ key: `${PUSH}.mode`, description: "The mode.", schema: { type: "string" } },
      { key: `${PUSH}.pressed`, kind: "event", description: "A press.", schema: { type: "boolean" } }], ...extra });
  const setMode = { action: `${PUSH}.set_mode`, idempotent: true, stateless: false, confirms: false,
    confirmedBy: { key: `${PUSH}.mode`, value: { arg: "mode" } } };

  it("takes an extension on a device of any bridge, each key's kind state where its bridge left it out, and its stateful action with its confirmedBy", () => {
    const r = parseDevices({ devices: [entry("pusher", { actions: [...entry("pusher").actions, setMode], extensions: [ext()] })] });
    expect(r.faults).toEqual([]);
    const d = r.value.devices[0]!;
    expect(d.extensions).toEqual([{ capability: PUSH, description: "A button pusher's own settings.",
      actions: [{ action: `${PUSH}.set_mode`, description: "Sets the mode.", schema: { type: "object", properties: { mode: { enum: ["click", "switch"] } } } }],
      keys: [{ key: `${PUSH}.mode`, kind: "state", description: "The mode.", schema: { type: "string" } },
        { key: `${PUSH}.pressed`, kind: "event", description: "A press.", schema: { type: "boolean" } }] }]);
    expect(d.actions.map((a) => a.action)).toEqual(["onoff.turn_on", `${PUSH}.set_mode`]);
    expect(d.actions[1]).toMatchObject({ confirmed_by: { key: `${PUSH}.mode`, value: { arg: "mode" } } });
    expect(parseDevices({ devices: [entry("lamp")] }).value.devices[0]).not.toHaveProperty("extensions");
  });

  it("parses an extension's names on the last dot: its actions and keys under its own capability, each name of its form; drops what breaks it, alone, with a fault", () => {
    const r = parseDevices({ devices: [entry("pusher", { actions: [], extensions: [
      ext({ actions: [{ action: "org.galatea.other.set_mode", schema: {} }, { action: `${PUSH}.Set-Mode`, schema: {} }],
        keys: [{ key: `${PUSH}.mode`, schema: { type: "string" } }, { key: `${PUSH}.level`, schema: { type: "object" } },
          { key: `${PUSH}.odd`, kind: "setting", schema: { type: "string" } }] }),
      { capability: "pusher", actions: [], keys: [] },
      { capability: `${PUSH}.deep`, actions: [], keys: [] },
      { capability: "org.galatea.\u0000", actions: [], keys: [] },
    ] })] });
    expect(r.value.devices[0]!.extensions).toEqual([{ capability: PUSH, description: "A button pusher's own settings.", actions: [],
      keys: [{ key: `${PUSH}.mode`, kind: "state", schema: { type: "string" } }] }]);
    expect(r.faults).toEqual([
      `devices[0] (pusher) extensions[0] action org.galatea.other.set_mode is not ${PUSH}, a dot and a name of [a-z][a-z0-9_]*`,
      `devices[0] (pusher) extensions[0] action ${PUSH}.Set-Mode is not ${PUSH}, a dot and a name of [a-z][a-z0-9_]*`,
      `devices[0] (pusher) extensions[0] key ${PUSH}.level has a schema that is not a scalar's`,
      `devices[0] (pusher) extensions[0] key ${PUSH}.odd has a kind this applier does not know; not modelled`,
      "devices[0] (pusher) extensions[1] has no capability that is a namespace with a dot",
      `devices[0] (pusher) extensions[2] (${PUSH}.deep) is ${PUSH} with a segment added; the last dot would be in doubt`,
      "devices[0] (pusher) extensions[3] holds a string with U+0000 or a lone surrogate",
    ]);
  });

  it("takes a key whose schema is an enum of scalars without a type as a scalar's, and keeps its set_ action (the Zigbee bridge's enums)", () => {
    const keys = [
      { key: `${PUSH}.mode`, description: "The mode.", schema: { enum: ["click", "switch"] } },
      { key: `${PUSH}.reverse`, schema: { enum: [true, false] } },
      { key: `${PUSH}.speed`, schema: { enum: [1, 2, 3] } },
      { key: `${PUSH}.mixed`, schema: { enum: ["off", 1, true] } },
      { key: `${PUSH}.whole`, schema: { type: "integer", minimum: 0, multipleOf: 5 } },
      { key: `${PUSH}.pressed`, kind: "event", schema: { enum: ["single"] } },
      // Not a scalar's: an enum holding an object or null, an empty one, a schema saying nothing, an object's or a list of types.
      { key: `${PUSH}.shape`, schema: { enum: [{ a: 1 }] } },
      { key: `${PUSH}.nothing`, schema: { enum: [null] } },
      { key: `${PUSH}.empty`, schema: { enum: [] } },
      { key: `${PUSH}.open`, schema: {} },
      { key: `${PUSH}.either`, schema: { type: ["string", "null"] } },
      { key: `${PUSH}.listed`, schema: { type: "array" } },
    ];
    const r = parseDevices({ devices: [entry("pusher", { actions: [...entry("pusher").actions, { ...setMode, args: { mode: ["click", "switch"] } }],
      extensions: [ext({ keys })] })] });
    const d = r.value.devices[0]!;
    expect(d.extensions![0]!.keys.map((k) => k.key)).toEqual(["mode", "reverse", "speed", "mixed", "whole", "pressed"].map((k) => `${PUSH}.${k}`));
    expect(d.actions.map((a) => a.action)).toEqual(["onoff.turn_on", `${PUSH}.set_mode`]);
    expect(r.faults).toEqual(["shape", "nothing", "empty", "open", "either", "listed"].map((k) =>
      `devices[0] (pusher) extensions[0] key ${PUSH}.${k} has a schema that is not a scalar's`));
  });

  it("says what it leaves out past MAX_EXTENSION_ITEMS capabilities, actions or keys, with a fault for each list cut", () => {
    const many = (n: number, f: (i: number) => unknown) => Array.from({ length: n }, (_, i) => f(i));
    const caps = many(MAX_EXTENSION_ITEMS + 1, (i) => ({ capability: `org.galatea.c${i}`, actions: [], keys: [] }));
    caps[0] = { capability: "org.galatea.c0", actions: many(MAX_EXTENSION_ITEMS + 2, (i) => ({ action: `org.galatea.c0.a${i}`, schema: {} })),
      keys: many(MAX_EXTENSION_ITEMS + 3, (i) => ({ key: `org.galatea.c0.k${i}`, schema: { type: "string" } })) };
    const r = parseDevices({ devices: [entry("pusher", { actions: [], extensions: caps })] });
    expect(r.value.devices[0]!.extensions).toHaveLength(MAX_EXTENSION_ITEMS);
    expect(r.faults).toEqual([
      `devices[0] (pusher) extensions has ${MAX_EXTENSION_ITEMS + 1} entries; the first ${MAX_EXTENSION_ITEMS} are modelled`,
      `devices[0] (pusher) extensions[0] has ${MAX_EXTENSION_ITEMS + 2} actions; the first ${MAX_EXTENSION_ITEMS} are modelled`,
      `devices[0] (pusher) extensions[0] has ${MAX_EXTENSION_ITEMS + 3} keys; the first ${MAX_EXTENSION_ITEMS} are modelled`,
    ]);
  });

  it("drops an extension action its device's extensions do not declare, and a stateful one without a confirmedBy naming one of its state keys", () => {
    const r = parseDevices({ devices: [entry("pusher", { extensions: [ext()], actions: [
      { action: "org.galatea.test.other.go", idempotent: false, stateless: true, confirms: true },
      { ...setMode, confirmedBy: undefined },
      { ...setMode, confirmedBy: { key: `${PUSH}.pressed`, value: true } },
      { ...setMode, confirmedBy: { key: `${PUSH}.mode`, value: { nested: 1 } } },
    ] })] });
    expect(r.value.devices[0]!.actions).toEqual([]);
    expect(r.faults).toEqual([
      "devices[0] (pusher) actions[0] (org.galatea.test.other.go) is an extension action its device's extensions do not declare",
      `devices[0] (pusher) actions[1] (${PUSH}.set_mode) is a stateful extension action with no confirmedBy naming one of its state keys`,
      `devices[0] (pusher) actions[2] (${PUSH}.set_mode) is a stateful extension action with no confirmedBy naming one of its state keys`,
      `devices[0] (pusher) actions[3] (${PUSH}.set_mode) is a stateful extension action with no confirmedBy naming one of its state keys`,
    ]);
  });
});

describe("parseDevices", () => {
  it("keeps every good entry beside a malformed one, and names the bad one (GA-BUS-1)", () => {
    const r = parseDevices({ devices: [entry("lamp"), { id: "ghost" }, entry("tv")] });
    expect(r.value.devices.map((d) => d.id)).toEqual(["lamp", "tv"]);
    expect(r.value.listed).toEqual(["lamp", "ghost", "tv"]);
    expect(r.faults).toEqual(["devices[1] (ghost) has no stableIdentifier, transport, capabilities, actions"]);
  });

  it("drops a malformed action only, and takes unknown enumerated values as the least they can mean (GA-BUS-3)", () => {
    const r = parseDevices({ devices: [entry("lamp", {
      actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }, { action: "BAD" }],
      feedback: "psychic", proposedClass: "robot", classEvidence: "rumour",
    })] });
    expect(r.value.devices[0]).toMatchObject({ feedback: "closed", proposed_class: null, class_evidence: "none",
      actions: [{ action: "onoff.turn_on", confirms: true }] });
    expect(r.faults).toEqual(["devices[0] (lamp) actions[1] is malformed"]);
  });

  it("reads the args table as ruled (2026-10-06): a list, a range with step, \"any\" or {} for no limit, an object's fields, optional", () => {
    const action = { action: "org.galatea.zigbee.ts0601.set_sensitivity", idempotent: true, stateless: true, confirms: true,
      args: { stepped: { min: 0, max: 200, step: 1 }, half: { step: 0.5 }, open: {}, loose: "any", maybe: { optional: true },
        maybeRange: { min: 1, optional: true }, mode: ["click", "switch"],
        search: { series: "any", season: { min: 1, max: 99 }, optional: true },
        zero: { step: 0 }, negative: { step: -1 }, mixed: { min: 1, series: "any" }, odd: { optional: "yes" }, nobody: [] } };
    const r = parseDevices({ devices: [entry("ac", { capabilities: [], actions: [action],
      extensions: [{ capability: "org.galatea.zigbee.ts0601", actions: [{ action: action.action, schema: {} }], keys: [] }] })] });
    expect(r.value.devices[0]!.actions[0]!.args).toEqual({
      stepped: { min: 0, max: 200, step: 1 }, half: { step: 0.5 }, open: "any", loose: "any", maybe: { optional: true },
      maybeRange: { min: 1, optional: true }, mode: { enum: ["click", "switch"] },
      search: { fields: { series: "any", season: { min: 1, max: 99 } }, optional: true },
      // An empty list allows no value: a computer with no interactive account names none (the PC bridge's).
      nobody: { enum: [] } });
    expect(r.faults).toEqual(["zero", "negative", "mixed", "odd"].map((k) => `devices[0] (ac) actions[0] args ${k} is malformed`));
  });

  it("takes an extension action's arguments from its schema's properties where it gives no args (I4, the maintainer's ruling)", () => {
    const X = "org.galatea.test.brew";
    const actions = [
      { action: `${X}.make`, idempotent: false, stateless: true, confirms: true },
      { action: `${X}.press`, idempotent: false, stateless: true, confirms: true },
      { action: `${X}.set_mode`, idempotent: false, stateless: true, confirms: true, args: { mode: ["a", "b"] } },
    ];
    const extensions = [{ capability: X, keys: [], actions: [
      { action: `${X}.make`, schema: { type: "object", required: ["cups"], properties: {
        cups: { type: "integer", minimum: 1, maximum: 4 }, strength: { enum: ["mild", "strong"] }, note: { type: "string" } } } },
      { action: `${X}.press`, schema: { type: "object", properties: {} } },
      // Its args win over its schema.
      { action: `${X}.set_mode`, schema: { type: "object", properties: { other: { type: "string" } } } }] }];
    const r = parseDevices({ devices: [entry("pot", { capabilities: [], actions, extensions })] });
    const [make, press, mode] = r.value.devices[0]!.actions;
    // The table has no optional list: an optional enum is taken as an optional scalar, its bridge checking the rest.
    expect(make!.args).toEqual({ cups: { min: 1, max: 4 }, strength: { optional: true }, note: { optional: true } });
    expect(press!.args).toBeUndefined();
    expect(mode!.args).toEqual({ mode: { enum: ["a", "b"] } });
    expect(r.faults).toEqual([]);
  });

  it("takes optional on a field as malformed: a field is supported, never required (I5, the maintainer's ruling)", () => {
    const action = { action: "org.galatea.test.tv.find", idempotent: true, stateless: true, confirms: true,
      args: { search: { title: "any", kind: { optional: true } }, near: { at: { min: 1, optional: true } }, fine: { title: "any", kind: ["a", "b"] } } };
    const r = parseDevices({ devices: [entry("tv", { capabilities: [], actions: [action],
      extensions: [{ capability: "org.galatea.test.tv", actions: [{ action: action.action, schema: {} }], keys: [] }] })] });
    expect(r.value.devices[0]!.actions[0]!.args).toEqual({ fine: { fields: { title: "any", kind: { enum: ["a", "b"] } } } });
    expect(r.faults).toEqual(["search", "near"].map((k) => `devices[0] (tv) actions[0] args ${k} is malformed`));
  });

  it("parses an action's args constraints, dropping only a constraint it cannot read, with a fault", () => {
    const action = { action: "climate.set_mode", idempotent: true, stateless: false, confirms: true,
      args: { mode: ["off", "cool"], celsius: { min: 16, max: 30 }, text: "any", search: { series: "any", season: { min: 1, max: 99 } },
        bad: { min: "one" }, "no\u0000": "any", worse: [{}] } };
    const r = parseDevices({ devices: [entry("ac", { capabilities: ["climate"], actions: [action] })] });
    expect(r.value.devices[0]!.actions[0]!.args).toEqual({
      mode: { enum: ["off", "cool"] }, celsius: { min: 16, max: 30 }, text: "any",
      search: { fields: { series: "any", season: { min: 1, max: 99 } } } });
    expect(r.faults).toEqual(["devices[0] (ac) actions[0] args bad is malformed", "devices[0] (ac) actions[0] args has a key that holds U+0000 or a lone surrogate",
      "devices[0] (ac) actions[0] args worse is malformed"]);
    const none = parseDevices({ devices: [entry("ac", { actions: [{ ...action, args: "all" }] })] });
    expect(none.value.devices[0]!.actions[0]!.args).toBeUndefined();
    expect(none.faults).toEqual(["devices[0] (ac) actions[0] args is malformed"]);
  });

  it("gives the applier's snake_case", () => {
    const d = parseDevices({ devices: [entry("lamp", { selfChanging: ["mode"], personal: ["app"], otherAdmins: "unknown" })] }).value.devices[0]!;
    expect(d).toMatchObject({ stable_identifier: "test:lamp", reach_ms: 1000, proposed_class: "light", self_changing: ["mode"],
      personal: ["app"], other_admins: "unknown" });
  });
});

describe("parseDevices: awaitedKeys, settings and undescribed (bridge 0.6, GA-DESC-19)", () => {
  const at = "2026-10-06T10:00:00.000Z";
  it("takes them in the applier's snake_case, and leaves each out where its bridge did", () => {
    const d = parseDevices({ devices: [entry("radar", { awaitedKeys: ["illuminance"], settings: ["org.galatea.test.radar.sensitivity"],
      undescribed: [{ name: "dp108", firstSeen: at }] })] }).value.devices[0]!;
    expect(d).toMatchObject({ awaited_keys: ["illuminance"], settings: ["org.galatea.test.radar.sensitivity"],
      undescribed: [{ name: "dp108", first_seen: Date.parse(at) }] });
    const bare = parseDevices({ devices: [entry("lamp")] }).value.devices[0]!;
    for (const k of ["awaited_keys", "settings", "undescribed"]) expect(bare).not.toHaveProperty(k);
  });
  it("drops what it cannot read, alone, with a fault: a list that is not one of strings, an undescribed entry of a bad name or time", () => {
    const r = parseDevices({ devices: [entry("radar", { awaitedKeys: "illuminance", settings: [3],
      undescribed: [{ name: "dp108", firstSeen: at }, { name: "no spaces", firstSeen: at }, { name: "dp109", firstSeen: "yesterday" }, "dp110"] })] });
    const d = r.value.devices[0]!;
    expect(d).not.toHaveProperty("awaited_keys");
    expect(d).not.toHaveProperty("settings");
    expect(d.undescribed).toEqual([{ name: "dp108", first_seen: Date.parse(at) }]);
    expect(r.faults).toEqual(["devices[0] (radar) awaitedKeys is malformed", "devices[0] (radar) settings is malformed",
      "devices[0] (radar) undescribed[1] is malformed", "devices[0] (radar) undescribed[2] is malformed", "devices[0] (radar) undescribed[3] is malformed"]);
  });
  it("keeps the first 32 undescribed names, with a fault for the rest", () => {
    const many = Array.from({ length: 34 }, (_, i) => ({ name: `dp${i}`, firstSeen: at }));
    const r = parseDevices({ devices: [entry("radar", { undescribed: many })] });
    expect(r.value.devices[0]!.undescribed).toHaveLength(32);
    expect(r.faults).toEqual(["devices[0] (radar) undescribed has 34 names; the first 32 are kept"]);
  });
});

describe("parseDevices otherAdmins", () => {
  const admins = (extra: Record<string, unknown>) => parseDevices({ devices: [entry("lamp", extra)] });
  it("is unknown when absent, and unknown with a fault when malformed", () => {
    expect(admins({}).value.devices[0]!.other_admins).toBe("unknown");
    expect(admins({}).faults).toEqual([]);
    const bad = admins({ otherAdmins: [{ vendor: "x" }] });
    expect(bad.value.devices[0]!.other_admins).toBe("unknown");
    expect(bad.faults).toEqual(["devices[0] (lamp) otherAdmins is malformed"]);
    expect(admins({ otherAdmins: 5 }).faults).toHaveLength(1);
  });
  it("keeps \"unknown\" and a good array", () => {
    expect(admins({ otherAdmins: "unknown" }).value.devices[0]!.other_admins).toBe("unknown");
    const good = admins({ otherAdmins: [{ vendor: "v", label: "l" }] });
    expect(good.value.devices[0]!.other_admins).toEqual([{ vendor: "v", label: "l" }]);
    expect(good.faults).toEqual([]);
    expect(admins({ otherAdmins: [] }).value.devices[0]!.other_admins).toEqual([]);
  });
});

describe("parseDevices proposedInfrastructure", () => {
  const parsed = (extra: Record<string, unknown>) => parseDevices({ devices: [entry("lamp", extra)] });
  it("keeps a true, absent otherwise; anything else is a fault", () => {
    expect(parsed({ proposedInfrastructure: true }).value.devices[0]!.proposed_infrastructure).toBe(true);
    expect(parsed({}).value.devices[0]).not.toHaveProperty("proposed_infrastructure");
    const bad = parsed({ proposedInfrastructure: false });
    expect(bad.value.devices[0]).not.toHaveProperty("proposed_infrastructure");
    expect(bad.faults).toEqual(["devices[0] (lamp) proposedInfrastructure is malformed"]);
  });
});

describe("parseDevices host", () => {
  const parsed = (extra: Record<string, unknown>) => parseDevices({ devices: [entry("box", extra)] });
  it("keeps a bridge device id, absent otherwise; anything else, or the device itself, is a fault and read as no host", () => {
    expect(parsed({ host: "pc" }).value.devices[0]!.host).toBe("pc");
    expect(parsed({}).value.devices[0]).not.toHaveProperty("host");
    for (const host of [7, "", "box"]) {
      const bad = parsed({ host });
      expect([bad.value.devices[0]?.host, bad.faults]).toEqual([undefined, ["devices[0] (box) host is malformed"]]);
    }
  });
});

describe("parseStatus", () => {
  it("reads a status's levels and bridgeType, and takes a bad levels list as none (GA-BUS-3)", () => {
    expect(parseStatus(status({ levels: ["Serve", "Provision", 7], bridgeType: "zigbee" })).value)
      .toMatchObject({ levels: ["Serve", "Provision"], bridge_type: "zigbee" });
    expect(parseStatus(status({ levels: "Provision" })).value.levels).toEqual([]);
    expect(parseStatus(status({ bridgeType: 3 })).value).not.toHaveProperty("bridge_type");
  });

  it("takes the ungoverned paths as text, and a list it cannot read as one path and a fault (GA-DESC-6, GA-BUS-3)", () => {
    expect(parseStatus(status()).value.ungoverned).toEqual([]);
    expect(parseStatus(status({ ungoverned: ["a cloud app", { app: "x" }] })).value.ungoverned).toEqual(["a cloud app", '{"app":"x"}']);
    const { ungoverned: _, ...without } = status();
    const r = parseStatus(without);
    expect(r.value.ungoverned).toHaveLength(1);
    expect(r.faults).toContain("status ungoverned is not a list");
  });

  it("parses a status, its transports and its roster", () => {
    const r = parseStatus(status());
    expect(r.faults).toEqual([]);
    expect(r.value).toMatchObject({ bridge_id: "b", instance_id: "i-1", v: 1, graceful: false, published_at: t,
      transports: [{ id: "test", kind: "zigbee", state: "up" }], listed: ["lamp"],
      roster: [{ id: "lamp", basis_max_age_ms: 60_000, last_check_in: t }] });
  });

  it("takes unknown kinds and states as the least they can mean, and only offline with graceful as planned", () => {
    const r = parseStatus(status({ state: "hibernating", transports: [{ id: "x", kind: "lora", state: "sleepy", since: T }] }));
    expect(r.value.transports).toEqual([{ id: "x", kind: "other", state: "down" }]);
    expect(r.value.graceful).toBe(false);
    expect(parseStatus(status({ state: "offline", graceful: true })).value.graceful).toBe(true);
  });

  it("drops a roster entry with a bad field, but lists it as present (GA-BUS-1)", () => {
    const bad = { ...status().devices[0], id: "dimmer", lastCheckIn: "garbage" };
    const r = parseStatus(status({ devices: [...status().devices, bad] }));
    expect(r.value.roster.map((e) => e.id)).toEqual(["lamp"]);
    expect(r.value.listed).toEqual(["lamp", "dimmer"]);
    expect(r.faults).toEqual(["status devices[1] (dimmer): a bad lastCheckIn"]);
  });

  it("gives no publishedAt when it does not parse", () => {
    const r = parseStatus(status({ publishedAt: "2030-02-30T00:00:00.000Z" }));
    expect(r.value.published_at).toBeUndefined();
    expect(r.faults).toHaveLength(1);
  });
});

const NUL = "a\u0000b";
const clean = (faults: string[]) => faults.forEach((f) => expect(f).not.toContain("\u0000"));

describe("a U+0000 in a bridge's string, which Postgres cannot keep, is a malformed field", () => {
  it("drops a reading whose value or key holds one, and only that reading", () => {
    const r = parseDeviceStatus({ deviceId: "d", timestamp: T, label: NUL, [NUL]: 1, level: 4 });
    expect(r.value.readings).toEqual([{ key: "level", value: 4, basis: t }]);
    expect(r.faults).toHaveLength(2);
    clean(r.faults);
  });

  it("drops a devices entry whose field holds one, keeps its neighbours, and never echoes a bad id", () => {
    for (const bad of [{ stableIdentifier: NUL }, { transport: NUL }, { model: { vendor: NUL, model: "m" } },
      { otherAdmins: [{ vendor: "v", label: NUL }] }, { capabilities: [NUL] }]) {
      const r = parseDevices({ devices: [entry("lamp", bad), entry("tv")] });
      const kept = r.value.devices.map((d) => d.id);
      // A bad model or otherAdmins is a malformed field of the entry, not the entry.
      expect(kept).toContain("tv");
      const lamp = r.value.devices.find((d) => d.id === "lamp");
      expect(JSON.stringify(lamp ?? {})).not.toContain("\u0000");
      clean(r.faults);
    }
    const r = parseDevices({ devices: [entry(NUL), entry("tv")] });
    expect(r.value.devices.map((d) => d.id)).toEqual(["tv"]);
    expect(r.value.listed).toEqual(["tv"]);
    expect(r.faults).toEqual(["devices[0] has no id"]);
  });

  it("treats a lone surrogate, which Postgres jsonb also rejects, as it treats a U+0000", () => {
    const LONE = JSON.parse('"a\\ud800b"') as string;
    const r = parseDeviceStatus({ deviceId: "d", timestamp: T, label: LONE, [LONE]: 1, level: 4 });
    expect(r.value.readings).toEqual([{ key: "level", value: 4, basis: t }]);
    expect(r.faults).toHaveLength(2);
    expect(parseDevices({ devices: [entry(LONE), entry("tv")] }).value.listed).toEqual(["tv"]);
  });

  it("drops a transport whose id holds one, and takes a roster id the same way", () => {
    const r = parseStatus(status({ transports: [{ id: NUL, kind: "zigbee", state: "up" }, { id: "test", kind: "zigbee", state: "up" }],
      devices: [{ id: NUL, basisMaxAgeMs: 1, lastCheckIn: T }] }));
    expect(r.value.transports).toEqual([{ id: "test", kind: "zigbee", state: "up" }]);
    expect(r.value.roster).toEqual([]);
    expect(r.value.listed).toEqual([]);
    clean(r.faults);
    expect(r.faults).toHaveLength(2);
  });

  it("reads an instanceId or bridgeId that holds one as absent, and drops a fault code that does", () => {
    const r = parseStatus(status({ bridgeId: NUL, instanceId: NUL, faults: [{ code: NUL }, { code: "ok" }] }));
    expect(r.value).toMatchObject({ bridge_id: "", instance_id: "", faults: [{ code: "ok" }] });
  });
});

describe("parseStatus transports", () => {
  it("keeps the first entry of a repeated transport id and names the repeat", () => {
    const r = parseStatus(status({ transports: [{ id: "t", kind: "zigbee", state: "up" }, { id: "t", kind: "matter", state: "up" }] }));
    expect(r.value.transports).toEqual([{ id: "t", kind: "zigbee", state: "up" }]);
    expect(r.faults).toEqual(["status transports[1] (t) repeats an id"]);
  });
});

describe("parseDeviceStatus", () => {
  it("stamps each reading with its own time, and drops only a bad field", () => {
    const r = parseDeviceStatus({ deviceId: "d", state: "on", on: true, level: 40, color: { r: 1 }, timestamp: T,
      timestamps: { level: "2030-01-01T07:59:00.000Z", on: T, temperature: "soon" }, temperature: 21, available: true });
    expect(r.value.readings).toEqual([{ key: "on", value: true, basis: t }, { key: "level", value: 40, basis: t - 60_000 }]);
    expect(r.value.available).toBe(true);
    expect(r.faults).toEqual(["reading color is not a scalar", "timestamps.temperature is not a time"]);
  });

  it("keeps a reading named like an Object.prototype member", () => {
    expect(parseDeviceStatus({ deviceId: "d", constructor: 3, timestamp: T, available: true }).value.readings)
      .toEqual([{ key: "constructor", value: 3, basis: t }]);
  });

  it("keeps readings of \"unknown\"", () => {
    expect(parseDeviceStatus({ deviceId: "d", leak: "unknown", timestamp: T, available: true }).value.readings)
      .toEqual([{ key: "leak", value: "unknown", basis: t }]);
  });
});

describe("parseEvent", () => {
  it("needs a seq and an instanceId, and keeps a type it does not know", () => {
    expect(parseEvent({ seq: 3, instanceId: "i", type: "teleported" }).value).toMatchObject({ seq: 3, instance_id: "i", type: "teleported" });
    expect(parseEvent({ seq: "3", instanceId: "i", type: "joined" }).value).toBeUndefined();
  });
});

describe("a list that is missing or not a list", () => {
  it("is no list at all, never an empty one, and is a fault (GA-BUS-1, lesson 4)", () => {
    const s = parseStatus(status({ devices: "oops", transports: 7 }));
    expect(s.value.listed).toBeUndefined();
    expect(s.value.transports).toBeUndefined();
    expect(s.faults).toEqual(expect.arrayContaining(["status has no devices list", "status has no transports list"]));
    const d = parseDevices({ devices: "oops" });
    expect(d.value.listed).toBeUndefined();
    expect(d.faults).toEqual(["devices has no devices list"]);
    expect(parseStatus(status({ devices: [] })).value.listed).toEqual([]);
  });
});

describe("parseAck", () => {
  const ID = "0b5f2c3e-1d4a-4f6b-8c9d-0e1f2a3b4c5d";
  it("takes the command id, source, result, reason and detail", () => {
    expect(parseAck({ commandId: ID, source: "b", result: "failed", reason: "rejected", detail: "busy", timestamp: T }))
      .toEqual({ value: { command_id: ID, source: "b", result: "failed", reason: "rejected", detail: "busy" }, faults: [] });
    expect(parseAck({ commandId: ID, source: "b", result: "applied", timestamp: T }).value)
      .toEqual({ command_id: ID, source: "b", result: "applied" });
  });

  it("takes the non-terminal received, and a result it does not know as no ack at all (GA-BUS-3)", () => {
    expect(parseAck({ commandId: ID, source: "b", result: "received" }).value?.result).toBe("received");
    expect(parseAck({ commandId: ID, source: "b", result: "half-done" })).toEqual({ value: { command_id: ID, source: "b", result: "unknown" }, faults: [] });
  });

  it("is no one's without a command id, and takes a failed without a reason as no_confirmation, a fault", () => {
    expect(parseAck({ source: "b", result: "applied" })).toEqual({ value: undefined, faults: ["an ack without a commandId"] });
    const f = parseAck({ commandId: ID, source: "b", result: "failed" });
    expect(f.value).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(f.faults).toEqual(["an ack is failed without a reason"]);
  });

  it("names no command id in its faults, so one fault stands per kind; and bounds the command id and the reason", () => {
    const other = "1c6a3d4f-2e5b-4a7c-9d0e-1f2a3b4c5d6e";
    expect(parseAck({ commandId: other, source: "b", result: "failed" }).faults).toEqual(parseAck({ commandId: ID, source: "b", result: "failed" }).faults);
    expect(parseAck({ commandId: "x".repeat(MAX_ACK_ID + 1), source: "b", result: "applied" }))
      .toEqual({ value: undefined, faults: [`an ack whose commandId is longer than ${MAX_ACK_ID} characters`] });
    const long = parseAck({ commandId: ID, source: "b", result: "failed", reason: "r".repeat(500) });
    expect(long.value?.reason).toHaveLength(MAX_REASON);
  });

  it("never cuts a detail or a reason inside a surrogate pair, so what it keeps is well formed", () => {
    const detail = `${"a".repeat(MAX_DETAIL - 1)}\u{1F514}more`;
    const d = parseAck({ commandId: ID, source: "b", result: "applied", detail }).value!.detail!;
    expect(d).toBe("a".repeat(MAX_DETAIL - 1));
    expect(d.isWellFormed()).toBe(true);
    const reason = `${"r".repeat(MAX_REASON - 1)}\u{1F514}`;
    expect(parseAck({ commandId: ID, source: "b", result: "failed", reason }).value!.reason!.isWellFormed()).toBe(true);
  });

  it("drops a detail Postgres could not keep, and cuts a long one", () => {
    const bad = parseAck({ commandId: ID, source: "b", result: "applied", detail: "a\u0000b" });
    expect(bad.value?.detail).toBeUndefined();
    expect(bad.faults).toHaveLength(1);
    expect(parseAck({ commandId: ID, source: "b", result: "applied", detail: "x".repeat(5000) }).value?.detail).toHaveLength(MAX_DETAIL);
    expect(parseAck({ commandId: ID, result: "applied" }).value?.source).toBe("");
  });
});

describe("connections (slice 5b)", () => {
  it("keeps a device's connections apart from its document, strings only, none where they are not a list of strings", () => {
    const r = parseDevices({ devices: [entry("lamp", { connections: ["mac:D4A651000001"] }), entry("tv", { connections: ["x", 7] }), entry("plug")] });
    expect([...r.value.connections]).toEqual([["lamp", ["mac:D4A651000001"]], ["tv", []], ["plug", []]]);
    expect(r.value.devices[0]).not.toHaveProperty("connections");
    expect(r.faults).toEqual([]);
  });

  it("keeps a transport's connections on its facts", () => {
    const s = parseStatus(status({ transports: [{ id: "test", kind: "zigbee", state: "up", since: T, connections: ["zigbee:pan-1"] },
      { id: "ir", kind: "ir", state: "up", since: T }] }));
    expect(s.value.transports).toEqual([{ id: "test", kind: "zigbee", state: "up", connections: ["zigbee:pan-1"] },
      { id: "ir", kind: "ir", state: "up" }]);
  });
});
