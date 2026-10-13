import { afterEach, describe as group, expect, it, vi } from "vitest";
import { Binary, Enum, findByDevice, Numeric, Text, type Definition } from "zigbee-herdsman-converters";
import { entry } from "../src/declaring.js";
import { descriptionProblem } from "../src/description.js";
import { boundOf, describe, isPlug, NAMESPACE, pinRequiredOf, reachOf, slug, UNKNOWN_REACH_MS, versionOf } from "../src/herdsman/describe.js";
import { overrideFor, type Override } from "../src/herdsman/overrides.js";
import { DRY_RUN_MS } from "../src/herdsman/recording.js";
import { extensionProblems } from "../src/vocabulary.js";
import { CLIMATE_SENSOR, CLIMATE_SENSOR_ROW, devices, LIGHT, LIGHT_ROW, LOCK, LOCK_ROW, PLUG, PLUG_ROW, PRESENCE, PRESENCE_ROW, PUSHER, PUSHER_ROW, row, SENSOR,
  SENSOR_ROW,
  withAttributes } from "./zigbee-devices.js";

let db: ReturnType<typeof devices> | undefined;
afterEach(() => { db?.close(); db = undefined; vi.useRealTimers(); });

/** Describes the made-up device `ieee`, from a database of `rows`, by its real definition. */
async function described(ieee: string, rows = [SENSOR_ROW, PUSHER_ROW, LIGHT_ROW, CLIMATE_SENSOR_ROW, LOCK_ROW], o: Parameters<typeof describe>[2] = {}) {
  db = devices(rows);
  const device = db.get(ieee);
  const definition = (await findByDevice(device, true))!;
  return { device, definition, ...(await describe(device, definition, o)) };
}

const names = (d: { actions: { action: string }[] }) => d.actions.map((a) => a.action);
const extensionOf = (d: { extensions?: { keys?: { key: string; kind?: string }[]; actions?: { action: string }[] }[] }) => d.extensions?.[0];

group("describe: the closed vocabulary where a definition matches it exactly", () => {
  it("describes a generated light as onoff and level, with confirmed sets, from the protocol, proposed as a light", async () => {
    const { description: d, keys, actions } = await described(LIGHT);
    expect(d.capabilities).toEqual(["onoff", "level"]);
    expect(d.actions.filter((a) => !a.action.startsWith(NAMESPACE))).toEqual([
      { action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true },
      { action: "onoff.turn_off", idempotent: true, stateless: false, confirms: true },
      { action: "level.set_level", idempotent: true, stateless: false, args: { level: { min: 0, max: 100 } }, confirms: true },
    ]);
    expect(d).toMatchObject({ hardwareId: LIGHT, stableIdentifier: LIGHT, model: { vendor: "galatea-test", model: "test-light" },
      feedback: "closed", reachMs: 0, proposedClass: "light", classEvidence: "protocol", otherAdmins: "unknown", basis: "report",
      cadenceMs: null, basisMaxAgeMs: null });
    expect(keys.get("state")!.key).toBe("on");
    expect([keys.get("state")!.from("ON"), keys.get("state")!.from("OFF"), keys.get("state")!.from("TOGGLE")]).toEqual([true, false, undefined]);
    expect([keys.get("brightness")!.from(254), keys.get("brightness")!.from(127), keys.get("brightness")!.from(0)]).toEqual([100, 50, 0]);
    expect(actions.get("level.set_level")!.value({ level: 100 })).toBe(254);
    expect(actions.get("onoff.turn_off")).toMatchObject({ property: "state" });
    expect(actions.get("onoff.turn_off")!.value({})).toBe("OFF");
  });

  it("never offers a toZigbee key no expose names: no factory reset, no scenes, no toggle, no relative step", async () => {
    const { description: d } = await described(LIGHT);
    for (const a of names(d)) expect(a).not.toMatch(/reset|scene|toggle|step|move|read|write|command/);
  });

  it("describes the vibration sensor from the model database: a battery sensor key, its own keys as an extension", async () => {
    const { description: d, keys } = await described(SENSOR);
    expect(d.capabilities).toEqual(["sensor"]);
    expect(d.sensorKeys).toEqual(["battery"]);
    expect(d.classEvidence).toBe("model_db");
    expect(d.model).toEqual({ vendor: "_TZ3000_fkxmyics", model: "TS0210" });
    const cap = `${NAMESPACE}.ts0210`;
    expect(extensionOf(d)!.keys!.map((k) => k.key)).toEqual([`${cap}.voltage`, `${cap}.vibration`, `${cap}.sensitivity`]);
    expect(d.actions).toEqual([{ action: `${cap}.set_sensitivity`, idempotent: true, stateless: false, args: { value: { min: 0, max: 50 } },
      confirmedBy: { key: `${cap}.sensitivity`, value: { arg: "value" } }, confirms: true }]);
    expect(keys.get("vibration")).toMatchObject({ key: `${cap}.vibration`, kind: "state" });
  });

  it("gives a sleeping device with no Poll Control and no measurement the unknown reach, so the core offers it no action", async () => {
    const { description: d, device } = await described(SENSOR);
    expect(d.reachMs).toBe(UNKNOWN_REACH_MS);
    expect(reachOf(device)).toBe(UNKNOWN_REACH_MS);
    expect(reachOf(device, { reachMs: 2500 })).toBe(2500);
  });

  it("takes a sleeping device's reach from the Poll Control long-poll interval herdsman read, in quarter-seconds", async () => {
    const { device } = await described(SENSOR, [withAttributes(SENSOR_ROW, "genPollCtrl", { longPollInterval: 20 })]);
    expect(reachOf(device)).toBe(5000);
  });

  it("describes the button pusher: onoff confirmed by a Default Response, its Tuya settings sent unconfirmed, their arguments from the exposes", async () => {
    const { description: d } = await described(PUSHER);
    const cap = `${NAMESPACE}.ts0001_fingerbot`;
    expect(d.capabilities).toEqual(["onoff", "sensor"]);
    expect(d.proposedClass).toBeNull();
    expect(d.actions.find((a) => a.action === "onoff.turn_on")!.confirms).toBe(true);
    expect(d.actions.find((a) => a.action === `${cap}.set_mode`)).toEqual({ action: `${cap}.set_mode`, idempotent: true, stateless: false,
      args: { value: ["click", "switch", "program"] }, confirmedBy: { key: `${cap}.mode`, value: { arg: "value" } }, confirms: false });
    // A converter's `value_step` is the argument's step (plan 2c-2 review I1).
    expect(d.actions.find((a) => a.action === `${cap}.set_lower`)!.args).toEqual({ value: { min: 50, max: 100, step: 1 } });
    expect(d.actions.find((a) => a.action === `${cap}.set_reverse`)!.args).toEqual({ value: ["ON", "OFF"] });
    expect(extensionOf(d)!.keys!.map((k) => k.key.slice(cap.length + 1))).toEqual(["mode", "lower", "upper", "delay", "reverse", "touch"]);
  });

  it("proposes a metering plug a socket, from the model database's word for it (the plug rehearsal's F1)", async () => {
    const { description: d, definition } = await described(PLUG, [PLUG_ROW]);
    expect(definition.model).toBe("TS011F_plug_1");
    expect(d.capabilities).toContain("onoff");
    expect(d).toMatchObject({ proposedClass: "socket", classEvidence: "model_db" });
  });

  it("proposes a socket by a whitelabel's own description, which the converters put in the definition's", async () => {
    const { description: d, definition } = await described("0x00000000000a0011",
      [row(11, "0x00000000000a0011", "Router", "TS011F", "_TZ3210_jlf1nepw", "Mains (single phase)", [0, 3, 4, 5, 6, 0x702, 0xb04])]);
    expect(definition.description).toBe("Smart Zigbee Socket");
    expect(d).toMatchObject({ proposedClass: "socket", classEvidence: "model_db" });
  });

  it("proposes no class for an on/off relay, a socket-named relay module or the button pusher: evidence none, nothing found", async () => {
    const relay = await described("0x00000000000a0012",
      [row(12, "0x00000000000a0012", "Router", "TS0001", "_TZ3000_galatea1", "Mains (single phase)", [0, 3, 4, 5, 6])]);
    expect(relay.definition.description).toBe("1 gang switch");
    expect(relay.description).toMatchObject({ proposedClass: null, classEvidence: "none" });
    const module = await described("0x00000000000a0013",
      [row(13, "0x00000000000a0013", "Router", "TS011F", "_TZ3210_cjrngdr3", "Mains (single phase)", [0, 3, 4, 5, 6, 0x702, 0xb04])]);
    expect(module.definition.description).toBe("Smart Socket Switch Module (with power monitoring)");
    expect(module.description).toMatchObject({ proposedClass: null, classEvidence: "none" });
    const pusher = await described(PUSHER);
    expect(pusher.description).toMatchObject({ proposedClass: null, classEvidence: "none" });
  });

  it.each([
    ["Smart plug (with power monitoring)", false, true],
    ["Zigbee smart socket with power meter", false, true],
    ["Smart wall outlet", false, true],
    ["Plug-in smart switch", false, true],
    ["Smart light socket", false, false],
    ["Smart lamp plug", false, false],
    ["Bulb socket adapter", false, false],
    ["Smart Socket Switch Module (with power monitoring)", false, false],
    ["Socket relay", false, false],
    ["Socket relais 16A", false, false],
    ["Thermostat outlet socket", false, false],
    ["Thermostatic radiator plug", false, false],
    ["Water valve socket", false, false],
    ["Smart circuit breaker socket", false, false],
    ["DIN rail smart socket", false, false],
    ["1 gang switch", false, false],
    ["Zigbee fingerbot plus", false, false],
    ["Automatically generated definition: smart plug", true, false],
  ])("takes %j (generated %s) as a plug: %s", (description, generated, plug) => {
    expect(isPlug({ description, ...(generated ? { generated: true } : {}) } as unknown as Definition)).toBe(plug);
  });

  it("describes a lock as the lock capability, requiring a PIN until herdsman read that it does not, and never its PIN codes", async () => {
    const { description: d, keys } = await described(LOCK);
    expect(d.capabilities).toEqual(["lock"]);
    expect(d.proposedClass).toBe("door_lock");
    expect(d.pinRequired).toBe(true);
    expect(names(d).filter((a) => a.startsWith("lock."))).toEqual(["lock.lock", "lock.unlock"]);
    expect(keys.get("state")!.from("LOCK")).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/pin_code|user_type|user_enabled/);
    // The lock's `action` enum is an event key, never a reading.
    expect(keys.get("action")).toMatchObject({ key: `${NAMESPACE}.test_lock.action`, kind: "event" });
    const unpinned = withAttributes(LOCK_ROW, "closuresDoorLock", { numOfPinUsersSupported: 10, requirePinForRfOperation: 0 });
    const r = await described(LOCK, [unpinned]);
    expect(r.description.pinRequired).toBe(false);
    expect(pinRequiredOf(r.device)).toBe(false);
  });

  it("describes a sensor no database knows from its clusters: sensor keys, its own alarms as an extension, no action", async () => {
    const { description: d } = await described(CLIMATE_SENSOR);
    // The clusters' occupancy is a movement reading: `motion`, never `occupancy` (GA-BRIDGE-78).
    expect(d.sensorKeys).toEqual(["battery", "temperature", "humidity", "motion", "battery_low"]);
    expect(d.actions).toEqual([]);
    expect(d.proposedClass).toBe("sensor");
    expect(d.classEvidence).toBe("protocol");
    expect(extensionOf(d)!.keys!.map((k) => k.key.split(".").at(-1))).toEqual(["alarm_1", "alarm_2", "tamper"]);
  });

  it("maps by meaning: a radar's `presence` is `occupancy`, its light `illuminance` (GA-BRIDGE-78)", async () => {
    const { description: d, keys } = await described(PRESENCE, [PRESENCE_ROW]);
    expect(d.sensorKeys).toEqual(expect.arrayContaining(["occupancy", "illuminance", "battery"]));
    expect(d.sensorKeys).not.toContain("motion");
    expect(keys.get("presence")).toMatchObject({ key: "occupancy" });
    expect(keys.get("illuminance")!.from(36)).toBe(36);
    expect(extensionOf(d)!.keys!.map((k) => k.key.split(".").at(-1))).not.toEqual(expect.arrayContaining(["presence", "illuminance"]));
  });

  it("holds back the radar's promised temperature and humidity by its override, the bench's unit sending neither (GA-BRIDGE-80)", async () => {
    const { description: d } = await described(PRESENCE, [PRESENCE_ROW], { override: overrideFor("ZG-204ZV")! });
    expect(d.sensorKeys).toEqual(["occupancy", "illuminance", "battery"]);
    expect(d.awaitedKeys).toEqual(["temperature", "humidity"]);
  });

  it("holds back only the keys its override names as seen missing, until reported, and lists them awaited (GA-BRIDGE-80)", async () => {
    const override: Override = { awaited: ["temperature", "humidity", "leak", "motion"] };
    const { description: d, keys } = await described(CLIMATE_SENSOR, undefined, { override });
    expect(d.sensorKeys).toEqual(["battery", "motion", "battery_low"]);
    // `leak` is not the model's, and `motion` a boolean: named, neither is held back, nor listed.
    expect(d.awaitedKeys).toEqual(["temperature", "humidity"]);
    // The converter stays, so the first report is read and can declare the key.
    expect(keys.get("temperature")).toMatchObject({ key: "temperature" });
    const later = await described(CLIMATE_SENSOR, undefined, { override, reported: new Set(["temperature"]) });
    expect(later.description.sensorKeys).toEqual(["battery", "temperature", "motion", "battery_low"]);
    expect(later.description.awaitedKeys).toEqual(["humidity"]);
    const none = await described(CLIMATE_SENSOR);
    expect(none.description.awaitedKeys).toBeUndefined();
  });

  it("maps a model whose definition uses the PIR name for a radar by its override's `meaning` (GA-BRIDGE-78)", async () => {
    const { description: d } = await described(CLIMATE_SENSOR, undefined, { override: { meaning: { occupancy: "occupancy" } } });
    expect(d.sensorKeys).toContain("occupancy");
    expect(d.sensorKeys).not.toContain("motion");
  });

  it("says a device herdsman has as a router is one, so a window can open at it, and an end device nothing (plan 3a review M4)", async () => {
    const routers: Record<string, boolean | undefined> = {};
    for (const ieee of [LIGHT, LOCK, SENSOR, PUSHER, CLIMATE_SENSOR]) {
      const { description: d, device } = await described(ieee);
      routers[`${device.type} ${ieee}`] = d.router;
      db!.close();
      db = undefined;
    }
    expect(routers).toEqual({ [`Router ${LIGHT}`]: true, [`Router ${LOCK}`]: true, [`EndDevice ${SENSOR}`]: undefined,
      [`EndDevice ${PUSHER}`]: undefined, [`EndDevice ${CLIMATE_SENSOR}`]: undefined });
  });

  it("gives descriptions the port takes, with extensions that keep their names (GA-BRIDGE-77)", async () => {
    for (const ieee of [LIGHT, SENSOR, PUSHER, LOCK, CLIMATE_SENSOR]) {
      const { description: d } = await described(ieee);
      expect(descriptionProblem(d)).toBeUndefined();
      expect(extensionProblems(d.extensions)).toEqual(new Map());
      db!.close();
      db = undefined;
    }
  });
});

group("describe: what is left out", () => {
  const made = (exposes: unknown[]): Definition => ({ model: "Made-up 1", vendor: "test", description: "made up", exposes, fromZigbee: [],
    toZigbee: [{ key: ["position", "lamp"], convertSet: async (e: { command: (...a: unknown[]) => Promise<unknown> }) => { await e.command("genOnOff", "on", {}); } }],
    version: "0.0.0" } as unknown as Definition);

  it("leaves out a property the vocabulary names as a quantity, which no extension may report under its own name", async () => {
    db = devices([LIGHT_ROW]);
    const d = (await describe(db.get(LIGHT), made([new Numeric("position", 7).withValueMin(0).withValueMax(100),
      new Binary("lamp", 7, "ON", "OFF")]))).description;
    expect(slug("Made-up 1")).toBe("made_up_1");
    expect(extensionOf(d)!.keys!.map((k) => k.key)).toEqual([`${NAMESPACE}.made_up_1.lamp`]);
    expect(names(d)).toEqual([`${NAMESPACE}.made_up_1.set_lamp`]);
  });

  it("reads a text key's value only as a string, and an enum's only among its values (plan 2c-2 review M2)", async () => {
    db = devices([LIGHT_ROW]);
    const { keys } = await describe(db.get(LIGHT), made([new Text("label", 1), new Enum("lamp", 1, ["a", "b"])]));
    expect(["x", 5, true].map((v) => keys.get("label")!.from(v))).toEqual(["x", undefined, undefined]);
    expect(["a", "c", 0].map((v) => keys.get("lamp")!.from(v))).toEqual(["a", undefined, undefined]);
  });

  it("declares a numeric's step from the expose: an integer step an integer argument, any other a multiple (plan 2c-2 review I1)", async () => {
    db = devices([LIGHT_ROW]);
    const d = (await describe(db.get(LIGHT), made([new Numeric("lamp", 7).withValueMin(0).withValueMax(10).withValueStep(0.5)]))).description;
    expect(d.actions[0]!.args).toEqual({ value: { min: 0, max: 10, step: 0.5 } });
    expect(extensionOf(d)!.actions![0]!.schema).toEqual({ type: "object", properties: { value: { type: "number", minimum: 0, maximum: 10, multipleOf: 0.5 } } });
    db.close();
    db = devices([LIGHT_ROW]);
    const five = (await describe(db.get(LIGHT), made([new Numeric("lamp", 7).withValueMin(0).withValueMax(100).withValueStep(5)]))).description;
    expect(extensionOf(five)!.actions![0]!.schema).toEqual({ type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 100, multipleOf: 5 } } });
    // No step, no step: the key's own schema keeps no step either, as readings stay unrounded.
    db.close();
    db = devices([LIGHT_ROW]);
    const none = (await describe(db.get(LIGHT), made([new Numeric("lamp", 7).withValueMin(0).withValueMax(10)]))).description;
    expect(none.actions[0]!.args).toEqual({ value: { min: 0, max: 10 } });
    expect(extensionOf(d)!.keys![0]!.schema).toEqual({ type: "number", minimum: 0, maximum: 10 });
  });

  it("offers no set whose dry run cannot say how it is answered", async () => {
    db = devices([LIGHT_ROW]);
    const def = made([new Binary("lamp", 7, "ON", "OFF")]);
    def.toZigbee[0]!.convertSet = async (e) => { await (e as unknown as { bind: (...a: unknown[]) => Promise<void> }).bind("genOnOff", 1); };
    const d = (await describe(db.get(LIGHT), def)).description;
    expect(d.actions).toEqual([]);
    expect(extensionOf(d)!.keys!.map((k) => k.key)).toEqual([`${NAMESPACE}.made_up_1.lamp`]);
  });
});

group("describe: the override table's word", () => {
  it("takes event keys, added keys, narrowed arguments, a set that is not idempotent, a measured reach and the settings' declarations", async () => {
    const override: Override = {
      events: ["vibration"],
      keys: { tamper: { schema: { type: "boolean" }, description: "The zone's tamper bit" } },
      args: { sensitivity: { min: 0, max: 20 } },
      notIdempotent: ["sensitivity"],
      reachMs: 1500,
      settings: ["sensitivity"],
      declare: (s, actions) => (s.sensitivity === undefined ? [] : actions),
    };
    const cap = `${NAMESPACE}.ts0210`;
    const never = (await described(SENSOR, [SENSOR_ROW], { override })).description;
    expect(never.actions).toEqual([]);
    expect(never.settings).toEqual([`${cap}.sensitivity`]);
    expect(never.reachMs).toBe(1500);
    expect(extensionOf(never)!.keys).toContainEqual({ key: `${cap}.vibration`, kind: "event", description: "Indicates whether the device detected vibration",
      schema: { enum: [true, false] } });
    expect(extensionOf(never)!.keys).toContainEqual({ key: `${cap}.tamper`, description: "The zone's tamper bit", schema: { type: "boolean" } });
    db!.close();
    const seen = (await described(SENSOR, [SENSOR_ROW], { override, settings: { [`${cap}.sensitivity`]: 10 } })).description;
    expect(seen.actions).toEqual([{ action: `${cap}.set_sensitivity`, idempotent: false, stateless: false, args: { value: { min: 0, max: 20 } },
      confirmedBy: { key: `${cap}.sensitivity`, value: { arg: "value" } }, confirms: true }]);
  });
});

group("describe: the plan 2c-1 review's findings", () => {
  const COVER = "0x00000000000a0007";
  const THERMOSTAT = "0x00000000000a0008";
  const MAINS_END_DEVICE = "0x00000000000a0009";

  it("gives an unmapped specific expose (a cover, a thermostat) keys only, and no action (I4)", async () => {
    const rows = [
      withAttributes(row(7, COVER, "Router", "test-cover", "galatea-test", "Mains (single phase)", [0, 0x102]), "closuresWindowCovering",
        { windowCoveringType: 0 }),
      withAttributes(row(8, THERMOSTAT, "Router", "test-thermostat", "galatea-test", "Mains (single phase)", [0, 0x201]), "hvacThermostat",
        { ctrlSeqeOfOper: 2, systemMode: 4 }),
    ];
    const cover = await described(COVER, rows);
    expect(names(cover.description)).toEqual([]);
    expect(extensionOf(cover.description)!.keys!.map((k) => k.key)).toEqual([`${NAMESPACE}.test_cover.state`, `${NAMESPACE}.test_cover.tilt`]);
    expect(extensionOf(cover.description)!.actions).toBeUndefined();
    db!.close();
    db = undefined;
    const thermostat = await described(THERMOSTAT, rows);
    expect(names(thermostat.description)).toEqual([]);
    expect(extensionOf(thermostat.description)!.keys!.map((k) => k.key.split(".").at(-1))).toEqual(["local_temperature", "occupied_heating_setpoint",
      "system_mode", "running_state"]);
  });

  it("gives a mains-powered end device, which listens when idle, the reach 0 (M7)", async () => {
    const { device, description: d } = await described(MAINS_END_DEVICE,
      [row(9, MAINS_END_DEVICE, "EndDevice", "test-light", "galatea-test", "Mains (single phase)", [0, 3, 4, 5, 6, 8])]);
    expect(d.reachMs).toBe(0);
    expect(reachOf(device)).toBe(0);
  });

  const made = (exposes: unknown[], convertSet: (...a: unknown[]) => Promise<unknown>): Definition => ({ model: "Made-up 2", vendor: "test",
    description: "made up", exposes, fromZigbee: [], toZigbee: [{ key: ["lamp", "lamp_l1", "dim", "mode"], convertSet }], version: "0.0.0" }
    ) as unknown as Definition;
  const commands = async (e: unknown) => { await (e as { command: (...a: unknown[]) => Promise<unknown> }).command("genOnOff", "on", {}); };

  it("offers no action for an expose on one endpoint of several, and keeps its key (M8)", async () => {
    db = devices([LIGHT_ROW]);
    const d = (await describe(db.get(LIGHT), made([new Binary("lamp", 7, "ON", "OFF").withEndpoint("l1")], commands))).description;
    expect(extensionOf(d)!.keys!.map((k) => k.key)).toEqual([`${NAMESPACE}.made_up_2.lamp_l1`]);
    expect(d.actions).toEqual([]);
    expect(extensionOf(d)!.actions).toBeUndefined();
  });

  it("gives every extension key and action a description from the expose's own text (M1)", async () => {
    db = devices([LIGHT_ROW]);
    const d = (await describe(db.get(LIGHT), made([new Binary("lamp", 7, "ON", "OFF").withDescription("The lamp in the hood"),
      new Numeric("dim", 7).withValueMin(0).withValueMax(9)], commands))).description;
    expect(extensionOf(d)!.keys).toEqual([
      { key: `${NAMESPACE}.made_up_2.lamp`, description: "The lamp in the hood", schema: { enum: ["ON", "OFF"] } },
      { key: `${NAMESPACE}.made_up_2.dim`, description: "Dim", schema: { type: "number", minimum: 0, maximum: 9 } },
    ]);
    expect(extensionOf(d)!.actions).toEqual([
      { action: `${NAMESPACE}.made_up_2.set_lamp`, description: "Sets Lamp: The lamp in the hood",
        schema: { type: "object", properties: { value: { enum: ["ON", "OFF"] } } } },
      { action: `${NAMESPACE}.made_up_2.set_dim`, description: "Sets Dim", schema: { type: "object", properties: { value: { type: "number",
        minimum: 0, maximum: 9 } } } },
    ]);
  });

  it("runs the dry runs in parallel, and once per definition and action (M2)", async () => {
    vi.useFakeTimers();
    db = devices([LIGHT_ROW]);
    let runs = 0;
    const stuck = made([new Binary("lamp", 7, "ON", "OFF"), new Numeric("dim", 7).withValueMin(0).withValueMax(9),
      new Enum("mode", 7, ["a", "b"])], () => {
      runs += 1;
      return new Promise(() => {});
    });
    let done = false;
    const first = describe(db.get(LIGHT), stuck).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(DRY_RUN_MS);
    expect(done).toBe(true);
    expect((await first).description.actions).toEqual([]);
    const ran = runs;
    expect(ran).toBe(6);
    await describe(db.get(LIGHT), stuck, { settings: { x: 1 } });
    expect(runs).toBe(ran);
  });
});

/** A row as herdsman keeps a device `configure` set up at `version`, with the reporting herdsman recorded on its endpoint. */
const configuredRow = (base: Record<string, unknown>, version: string | undefined, reportings: [cluster: number, attrId: number, max: number][]) => {
  const eps = base.endpoints as Record<string, Record<string, unknown>>;
  return { ...base, meta: version === undefined ? {} : { configured: version },
    endpoints: { 1: { ...eps["1"], configuredReportings: reportings.map(([cluster, attrId, max]) =>
      ({ cluster, attrId, minRepIntval: 0, maxRepIntval: max, repChange: 1 })) } } };
};

group("describe: the freshness bound from the reporting configure set up (plan 2c-3)", () => {
  it("is twice the longest maximum reporting interval herdsman recorded, once configure succeeded at the definition's version", async () => {
    db = devices([configuredRow(PUSHER_ROW, "0.0.0", [[6, 0, 3600], [1, 33, 65000], [6, 0x4003, 0]])]);
    const device = db.get(PUSHER);
    const definition = (await findByDevice(device, true))!;
    expect(versionOf(definition)).toBe("0.0.0");
    expect(boundOf(device, definition)).toBe(130_000_000);
    expect((await describe(device, definition)).description.basisMaxAgeMs).toBe(130_000_000);
  });

  it("takes the longest across every endpoint, not the first alone (plan 2c-3 review M5)", async () => {
    const base = configuredRow(PUSHER_ROW, "0.0.0", [[6, 0, 600]]);
    const eps = base.endpoints as Record<string, Record<string, unknown>>;
    db = devices([{ ...base, epList: [1, 2], endpoints: { ...eps, 2: { ...eps["1"], epId: 2,
      configuredReportings: [{ cluster: 6, attrId: 0, minRepIntval: 0, maxRepIntval: 1800, repChange: 1 }] } } }]);
    const device = db.get(PUSHER);
    expect(device.endpoints.map((e) => e.ID)).toEqual([1, 2]);
    expect(boundOf(device, (await findByDevice(device, true))!)).toBe(3_600_000);
  });

  it("is null before configure succeeded at this version, though herdsman recorded reporting", async () => {
    db = devices([configuredRow(PUSHER_ROW, undefined, [[6, 0, 3600]])]);
    const device = db.get(PUSHER);
    const definition = (await findByDevice(device, true))!;
    expect(boundOf(device, definition)).toBeNull();
    expect(boundOf(device, { ...definition, version: "0.0.1" })).toBeNull();
    device.meta.configured = "0.0.1";
    expect(boundOf(device, { ...definition, version: "0.0.1" })).toBe(7_200_000);
    expect(boundOf(device, definition)).toBeNull();
  });

  it("is null where configure set up no periodic report: a bind alone, a report on change only, a reporting turned off", async () => {
    db = devices([configuredRow(PUSHER_ROW, "0.0.0", [[6, 0, 0], [6, 0x4003, 0xffff]])]);
    const device = db.get(PUSHER);
    const definition = (await findByDevice(device, true))!;
    expect(boundOf(device, definition)).toBeNull();
    expect((await describe(device, definition)).description.basisMaxAgeMs).toBeNull();
  });

  it("is null for a definition with no configure, whatever herdsman recorded: the vibration sensor", async () => {
    db = devices([configuredRow(SENSOR_ROW, "0.0.0", [[1, 33, 3600]])]);
    const device = db.get(SENSOR);
    const definition = (await findByDevice(device, true))!;
    expect(definition.configure).toBeUndefined();
    expect(boundOf(device, definition)).toBeNull();
  });

  it("takes the converters' own default version for a definition that gives none", async () => {
    db = devices([configuredRow(PUSHER_ROW, "0.0.0", [[6, 0, 600]])]);
    const device = db.get(PUSHER);
    const { version: _v, ...definition } = (await findByDevice(device, true))!;
    expect(versionOf(definition as Definition)).toBe("0.0.0");
    expect(boundOf(device, definition as Definition)).toBe(1_200_000);
  });
});

group("selfChanging on the bench's devices, from their real definitions (FL-GAP-2)", () => {
  const plain = { claimsProtocol: false, hidesOtherAdmins: false };
  /** A TS0044 scene switch: the bench's manufacturer string is not recorded here, so a whitelabel the converters know as TS0044. */
  const SWITCH = "0x00000000000a0044";
  const SWITCH_ROW = row(44, SWITCH, "EndDevice", "TS0044", "_TZ3000_wkai4ga5", "Battery", [0, 1, 6]);
  const selfChanging = async (ieee: string, r: Parameters<typeof devices>[0], model: string) => {
    const override = overrideFor(model);
    const { description } = await described(ieee, r, override ? { override } : {});
    db?.close(); db = undefined;
    return (entry("x", description, "zigbee", [], plain).selfChanging ?? []) as string[];
  };
  const own = (keys: string[]) => keys.filter((k) => !k.includes("."));

  it("marks each sensor key its own and keeps `on` out, on the plug, the presence and vibration sensors, the scene switch and the pusher", async () => {
    const plug = await selfChanging(PLUG, [PLUG_ROW], "TS011F");
    expect(own(plug)).toEqual([]);
    expect(plug).toEqual(expect.arrayContaining([`${NAMESPACE}.ts011f_plug_1.power`, `${NAMESPACE}.ts011f_plug_1.energy`]));
    expect(own(await selfChanging(PRESENCE, [PRESENCE_ROW], "ZG-204ZV"))).toEqual(["occupancy", "illuminance", "battery"]);
    expect(own(await selfChanging(SENSOR, [SENSOR_ROW], "TS0210"))).toEqual(["battery", "battery_low"]);
    expect(own(await selfChanging(SWITCH, [SWITCH_ROW], "TS0044"))).toEqual(["battery"]);
    const pusher = await selfChanging(PUSHER, [PUSHER_ROW], "TS0001");
    expect(own(pusher)).toEqual(["battery"]);
    expect(pusher.some((k) => k.endsWith(".mode"))).toBe(false);
  });
});
