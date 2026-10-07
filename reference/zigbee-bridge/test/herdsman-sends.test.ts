import { afterEach, beforeEach, describe as group, expect, it, type MockInstance, vi } from "vitest";
import { Zcl } from "zigbee-herdsman";
import { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import { Endpoint } from "zigbee-herdsman/dist/controller/model/endpoint.js";
import { Group } from "zigbee-herdsman/dist/controller/model/group.js";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import * as globalStore from "zigbee-herdsman-converters/lib/store";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { Pipeline } from "../src/herdsman/pipeline.js";
import { ANSWER_MS, ANSWERS, answering, CONFIGURE, type ConfigureMethod, configuring, eventExchange, FORCED, type Gate, guard, LIVE, live, messageExchange, MODEL, QUIET,
  readExchange, Refused, REMOVE, type RemovalGate, removing, SENDS } from "../src/herdsman/guard.js";
import { FakeClock } from "./fakes.js";
import { core } from "./herdsman-fakes.js";
import { datapoints, devices, LOCK, LOCK_ROW, message, PUSHER, PUSHER_ROW, row, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

/**
 * Until plan 2c-2, nothing the doer runs sends a device a frame (the maintainer's ruling, 2026-10-04;
 * plan 2c-1 review I1): every converter call gets a guarded device that refuses herdsman's sending
 * methods at once, so nothing waits on the network either. herdsman's own answers to a device's
 * frames are herdsman's, and stay.
 */

const CLASSES = { Device, Endpoint, Group } as const;
type Kind = keyof typeof CLASSES;
const KINDS = Object.keys(CLASSES) as Kind[];

/** The methods a class's own prototype has, as herdsman 10.10.0 defines them. */
const methodsOf = (c: { prototype: object }) => Object.getOwnPropertyNames(c.prototype)
  .filter((k) => k !== "constructor" && typeof Object.getOwnPropertyDescriptor(c.prototype, k)!.value === "function");

let db: ReturnType<typeof devices> | undefined;
/** Every call that reached one of herdsman's own refused methods, as `<Kind>.<method>`. */
let reached: string[];
/** The same calls with their arguments: the cluster, the command or transaction, the payload, the options. */
let reachedWith: unknown[][];
let spies: MockInstance[];
let errors: MockInstance;

beforeEach(() => {
  reached = [];
  reachedWith = [];
  // Spied on herdsman's own prototypes: a call that gets past the guard is seen here, and sends nothing (there is no adapter).
  spies = KINDS.flatMap((kind) => [...SENDS[kind], ...MODEL[kind]].map((m) =>
    vi.spyOn(CLASSES[kind].prototype as never, m as never).mockImplementation(((...args: unknown[]) => {
      reached.push(`${kind}.${m}`);
      reachedWith.push([`${kind}.${m}`, ...args]);
      return Promise.reject(new Error("reached herdsman"));
    }) as never)));
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
  errors.mockRestore();
  db?.close();
  db = undefined;
  vi.useRealTimers();
});

group("guard: herdsman's methods, each quiet or refused", () => {
  it("classifies every method herdsman 10.10.0's Device, Endpoint and Group have, so a new one is a decision", () => {
    for (const kind of KINDS) {
      const known = [...QUIET[kind], ...SENDS[kind], ...MODEL[kind]];
      expect(new Set(known).size, kind).toBe(known.length);
      expect(methodsOf(CLASSES[kind]).sort(), kind).toEqual(known.sort());
    }
  });

  it("refuses every sending method at once, logs it without its payload, and never reaches herdsman", async () => {
    db = devices([PUSHER_ROW]);
    const d = guard(db.get(PUSHER));
    const ep = d.getEndpoint(1)!;
    for (const m of SENDS.Endpoint) {
      const call = (ep as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!("genOnOff", { secret: "s3cr3t" });
      await expect(call).rejects.toBeInstanceOf(Refused);
    }
    for (const m of SENDS.Device) {
      await expect((d as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!()).rejects.toBeInstanceOf(Refused);
    }
    expect(reached).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command genOnOff: the doer sends a device nothing but an action's command, write or read`);
    expect(logged.join("\n")).not.toContain("s3cr3t");
  });

  it("lets the quiet methods through to herdsman's model, and guards every entity they give", async () => {
    db = devices([PUSHER_ROW]);
    const real = db.get(PUSHER);
    const d = guard(real);
    expect(d.ieeeAddr).toBe(PUSHER);
    expect(d.constructor.name).toBe("Device");
    expect(guard(d)).toBe(d);
    expect(d.getEndpoint(1)).toBe(d.endpoints[0]);
    expect(d.getEndpoint(1)!.getDevice()).toBe(d);
    expect(d.getEndpoint(1)!.supportsInputCluster("genOnOff")).toBe(true);
    d.getEndpoint(1)!.saveClusterAttributeKeyValue("genOnOff", { onOff: 1 });
    expect(real.getEndpoint(1)!.getClusterAttributeValue("genOnOff", "onOff")).toBe(1);
    await expect(d.endpoints[0]!.read("genOnOff", ["onOff"])).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual([]);
  });

  it("gives no route to herdsman's adapter or to an unguarded model through constructor: a stand-in carrying the name alone (plan 2c-3 review M2)", () => {
    db = devices([PUSHER_ROW]);
    const model = db.get(PUSHER);
    const gate = (async () => undefined) as unknown as Gate<ConfigureMethod>;
    for (const d of [guard(model), live(model, (async () => undefined) as unknown as Gate), configuring(model, gate),
      answering(model, messageExchange("genBasic", "attributeReport"))]) {
      for (const [entity, name] of [[d, "Device"], [d.getEndpoint(1)!, "Endpoint"]] as const) {
        const ctor = (entity as unknown as { constructor: { name: string; adapter?: unknown; byIeeeAddr?: (a: string) => unknown } }).constructor;
        expect(ctor.name).toBe(name);
        expect({ adapter: ctor.adapter, byIeeeAddr: ctor.byIeeeAddr }).toEqual({ adapter: undefined, byIeeeAddr: undefined });
      }
    }
    // herdsman's own model keeps its class.
    expect(model.constructor).toBe(Device);
  });

  it("answers nothing for a converter's read handler whose answer was refused, so that herdsman answers the device itself", () => {
    db = devices([PUSHER_ROW]);
    const real = db.get(PUSHER);
    const d = guard(real);
    const frame = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 7, "read", "genTime",
      [{ attrId: 0 }], {});
    d.customReadResponse = (_f, endpoint) => {
      void endpoint.readResponse("genTime", 7, { time: 1 });
      return true;
    };
    expect(real.customReadResponse!(frame, real.getEndpoint(1)!)).toBe(false);
    d.customReadResponse = () => true;
    expect(real.customReadResponse!(frame, real.getEndpoint(1)!)).toBe(true);
    expect(reached).toEqual([]);
  });
});

/** Made-up devices of models the converters send from by themselves, with each model's public model and manufacturer strings. */
const ANNOUNCE_QUERY = "0x00000000000a0011";
const INTERVAL_QUERY = "0x00000000000a0012";
const BATTERY_READ = "0x00000000000a0013";
const TIME_WRITE = "0x00000000000a0014";
const SENDERS = [
  // tuyaBase({ queryOnDeviceAnnounce: true }): a Tuya dataQuery on every announce.
  row(11, ANNOUNCE_QUERY, "EndDevice", "TS020C", "_TZ3000_test0001", "Battery", [0, 1, 0x500]),
  // tuyaBase({ queryIntervalSeconds: 10 }): a Tuya dataQuery every 10 s from `start`.
  row(12, INTERVAL_QUERY, "Router", "TS0601", "_TZE204_kobbcyum", "Mains (single phase)", [0, 61184]),
  // Legrand's readInitialBatteryState on an announce; the converters' own read handler for the maker's code.
  row(13, BATTERY_READ, "EndDevice", ` Pocket remote${"\u0000".repeat(17)}`, " Legrand", "Battery", [0, 1, 3], 0x1021),
  // writeTimeDaily: genTime written a day after `start`, then daily.
  row(14, TIME_WRITE, "EndDevice", "HS3AQ-EFA-3.0", "HEIMAN", "Battery", [0, 1, 0x402, 0x405, 0x40d]),
];

group("HerdsmanDevices: nothing a converter does reaches a device (plan 2c-1 review I1)", () => {
  it("reads the bench's two models' messages, the button pusher's gateway-status request and time sync among them, sending nothing under the owner's switch", async () => {
    db = devices([SENSOR_ROW, PUSHER_ROW]);
    const { events, seen } = core();
    // The time sync is sent only with the `time_start` option: given here, so that the converter tries.
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events, overrideOf: () => ({ options: { time_start: "1970" } }),
      noActions: true });
    const pusher = db.get(PUSHER);
    const sensor = db.get(SENSOR);
    await layer.add(pusher);
    await layer.add(sensor);
    await layer.announced(pusher);
    await layer.announced(sensor);
    await layer.heard(message(pusher, { cluster: "manuSpecificTuya", command: "mcuGatewayConnectionStatus", tsn: 9,
      payload: { payloadSize: 1, payload: 0 } }) as never);
    await layer.heard(message(pusher, { cluster: "manuSpecificTuya", command: "mcuSyncTime", tsn: 10, payload: { payloadSize: 0, payload: [] } }) as never);
    await layer.heard(datapoints(pusher, 11, [[101, 4, [0]], [105, 2, [0, 0, 0, 40]]]) as never);
    await layer.heard(message(pusher, { cluster: "genOnOff", command: "report", global: true, tsn: 12,
      payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never);
    await layer.heard(message(sensor, { cluster: "ssIasZone", command: "statusChangeNotification", tsn: 13,
      payload: { zonestatus: 1, extendedstatus: 0, zoneID: 1, delay: 0 } }) as never);
    await layer.clear();
    await layer.idle();
    expect(reached).toEqual([]);
    const refused = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("zigbee: ") && l.includes("refused"));
    expect(refused).toEqual([
      `zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: the doer sends a device nothing but an action's command, write or read`,
      `zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: the doer sends a device nothing but an action's command, write or read`,
    ]);
    // What the messages said still reached the core.
    expect(seen.filter((e) => e[0] === "observed").map((e) => e[2])).toContainEqual({ battery: 40, "org.galatea.zigbee.ts0001_fingerbot.mode": "click" });
  });

  it("gives a converter the message's device, endpoint and meta device guarded alike", async () => {
    db = devices([PUSHER_ROW]);
    const { events } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events, definitionOf: async (d) => {
      const def = (await findByDevice(d, true))!;
      return { ...def, fromZigbee: [{ cluster: "genOnOff", type: "attributeReport",
        convert: async (_m: unknown, msg: { device: Device; endpoint: Endpoint }, _p: unknown, _o: unknown, meta: { device: Device }) => {
          await msg.device.getEndpoint(1)!.read("genOnOff", ["onOff"]).catch(() => {});
          await msg.endpoint.command("genOnOff", "on", {}).catch(() => {});
          await meta.device.endpoints[0]!.write("genOnOff", { onOff: 1 }).catch(() => {});
          return {};
        } }] } as unknown as Definition;
    } });
    const pusher = db.get(PUSHER);
    await layer.add(pusher);
    await layer.heard(message(pusher, { cluster: "genOnOff", command: "report", global: true, tsn: 14,
      payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never);
    expect(reached).toEqual([]);
    const refused = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("zigbee: ") && l.includes("refused"));
    expect(refused.map((l) => l.split(" ")[3])).toEqual(["endpoint.read", "endpoint.command", "endpoint.write"]);
  });

  it("resolves a definition no database knows with nothing read from the device", async () => {
    const uncached = { ...LOCK_ROW, endpoints: { 1: { ...(LOCK_ROW.endpoints as Record<string, Record<string, unknown>>)["1"], clusters: {} } } };
    db = devices([uncached]);
    const { events, seen } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events });
    await layer.add(db.get(LOCK));
    expect(reached).toEqual([]);
    expect(seen.map((e) => e[0])).toEqual(["described"]);
  });

  it("runs the hooks of the models that query, read or write by themselves, on start, announce and timers, sending nothing under the owner's switch, and clears their timers at stop", async () => {
    vi.useFakeTimers();
    db = devices(SENDERS);
    const models: string[] = [];
    const { events } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events, noActions: true,
      definitionOf: async (d) => {
        const def = (await findByDevice(d, true)) as Definition;
        models.push(def.model);
        return def;
      } });
    for (const ieee of [ANNOUNCE_QUERY, INTERVAL_QUERY, BATTERY_READ, TIME_WRITE]) await layer.add(db.get(ieee));
    expect(models).toEqual(["TS020C", "TOWSMR1", "067755", "HS3AQ"]);
    for (const ieee of [ANNOUNCE_QUERY, INTERVAL_QUERY, BATTERY_READ, TIME_WRITE]) await layer.announced(db.get(ieee));
    // The interval query's timer, and the daily time write's.
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    await layer.idle();
    expect(globalStore.getValue(INTERVAL_QUERY, "query_interval")).toBeDefined();
    expect(globalStore.getValue(TIME_WRITE, "time")).toBeDefined();
    // The Legrand device's read handler, as herdsman calls it for the device's own read: refused, so herdsman answers.
    const legrand = db.get(BATTERY_READ);
    const read = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "read", "genBasic",
      [{ attrId: 61440 }], {});
    expect(legrand.customReadResponse!(read, legrand.getEndpoint(1)!)).toBe(false);
    expect(reached).toEqual([]);
    const refused = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("zigbee: ") && l.includes("refused"));
    expect(refused.some((l) => l.startsWith(`zigbee: ${ANNOUNCE_QUERY}/1: refused endpoint.command manuSpecificTuya`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${INTERVAL_QUERY}/1: refused endpoint.command manuSpecificTuya`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${BATTERY_READ}/1: refused endpoint.read genPowerCfg`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${BATTERY_READ}/1: refused endpoint.readResponse genBasic`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${TIME_WRITE}/1: refused endpoint.write genTime`))).toBe(true);
    await layer.clear();
    await layer.idle();
    expect(globalStore.getValue(INTERVAL_QUERY, "query_interval")).toBeUndefined();
    expect(globalStore.getValue(TIME_WRITE, "time")).toBeUndefined();
    const before = errors.mock.calls.length;
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    expect(errors.mock.calls.length).toBe(before);
  });
});

group("live: the guard opened for an action's own command, write and read (plan 2c-2)", () => {
  /** A gate that records each call it is given, then makes it. */
  const recording = () => {
    const through: string[] = [];
    const gate: Gate = (endpoint, method, args, send) => {
      through.push(`${endpoint.deviceIeeeAddress}/${endpoint.ID} ${method} ${String(args[0])}`);
      return send(args);
    };
    return { through, gate };
  };

  it("opens exactly an endpoint's command, write and read", () => {
    expect([...LIVE].sort()).toEqual(["command", "read", "write"]);
    for (const m of LIVE) expect(SENDS.Endpoint).toContain(m);
  });

  it("sends an endpoint's command, write and read through the run's gate to herdsman's own endpoint", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const ep = live(db.get(PUSHER), gate).getEndpoint(1)!;
    await expect(ep.command("genOnOff", "on", {})).rejects.toThrow("reached herdsman");
    await expect(ep.write("genOnOff", { onTime: 1 })).rejects.toThrow("reached herdsman");
    await expect(ep.read("genOnOff", ["onOff"])).rejects.toThrow("reached herdsman");
    expect(through).toEqual([`${PUSHER}/1 command genOnOff`, `${PUSHER}/1 write genOnOff`, `${PUSHER}/1 read genOnOff`]);
    expect(reached).toEqual(["Endpoint.command", "Endpoint.write", "Endpoint.read"]);
  });

  it("refuses every other sending or model-changing method of a live device, endpoint and group, never reaching herdsman", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = live(db.get(PUSHER), gate);
    const ep = d.getEndpoint(1)!;
    for (const m of [...SENDS.Endpoint, ...MODEL.Endpoint].filter((x) => !LIVE.has(x))) {
      const r = (ep as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!("genOnOff", {}, {});
      await expect(r, m).rejects.toBeInstanceOf(Refused);
    }
    for (const m of [...SENDS.Device, ...MODEL.Device]) {
      await expect((d as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!(), m).rejects.toBeInstanceOf(Refused);
    }
    // A group's command, write and read are none of an endpoint's: refused too.
    const g = live(Group.create(91), gate);
    for (const m of [...SENDS.Group, ...MODEL.Group]) {
      await expect((g as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!("genOnOff", "on", {}), m).rejects.toBeInstanceOf(Refused);
    }
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
  });

  it("gives every entity it hands out live, for the same run: the device again, its endpoints", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = live(db.get(PUSHER), gate);
    expect(d.constructor.name).toBe("Device");
    expect(d.getEndpoint(1)).toBe(d.endpoints[0]);
    expect(d.getEndpoint(1)!.getDevice()).toBe(d);
    await expect(d.getEndpoint(1)!.getDevice().endpoints[0]!.command("genOnOff", "off", {})).rejects.toThrow("reached herdsman");
    expect(through).toEqual([`${PUSHER}/1 command genOnOff`]);
  });

  it("refuses every call through a gate its run closed, never reaching the gate or herdsman, though the converter kept the endpoint (plan 2c-2 review I2)", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const ep = live(db.get(PUSHER), gate).getEndpoint(1)!;
    const kept = ep.command;
    gate.closed = true;
    await expect(ep.command("genOnOff", "on", {})).rejects.toBeInstanceOf(Refused);
    await expect(kept("genOnOff", "on", {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.write("genOnOff", { onTime: 1 })).rejects.toBeInstanceOf(Refused);
    await expect(ep.read("genOnOff", ["onOff"])).rejects.toBeInstanceOf(Refused);
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
  });

  it("leaves the guard itself shut: a guarded endpoint's command, write and read are still refused", async () => {
    db = devices([PUSHER_ROW]);
    const { gate } = recording();
    live(db.get(PUSHER), gate);
    const ep = guard(db.get(PUSHER)).getEndpoint(1)!;
    await expect(ep.command("genOnOff", "on", {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.write("genOnOff", { onTime: 1 })).rejects.toBeInstanceOf(Refused);
    await expect(ep.read("genOnOff", ["onOff"])).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual([]);
  });
});

group("configuring: the guard opened for configure's binds, reporting and reads (plan 2c-3)", () => {
  /** A gate that records each call it is given, then makes it. */
  const recording = () => {
    const through: string[] = [];
    const gate: Gate<ConfigureMethod> = (endpoint, method, args, send) => {
      through.push(`${endpoint.deviceIeeeAddress}/${endpoint.ID} ${method} ${String(args[0])}`);
      return send(args);
    };
    return { through, gate };
  };

  it("opens exactly an endpoint's bind, reporting set-up and read", () => {
    expect([...CONFIGURE].sort()).toEqual(["bind", "configureReporting", "read"]);
    for (const m of CONFIGURE) expect(SENDS.Endpoint).toContain(m);
  });

  it("sends a bind to an endpoint, a reporting set-up and a read through the run's gate to herdsman's own endpoint", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const coordinator = configuring(db.get("0x00124b0012345678"), gate).getEndpoint(1)!;
    const ep = configuring(db.get(PUSHER), gate).getEndpoint(1)!;
    await expect(ep.bind("genOnOff", coordinator)).rejects.toThrow("reached herdsman");
    await expect(ep.configureReporting("genOnOff", [{ attribute: "onOff", minimumReportInterval: 0, maximumReportInterval: 3600,
      reportableChange: 0 }])).rejects.toThrow("reached herdsman");
    await expect(ep.read("genBasic", ["modelId"])).rejects.toThrow("reached herdsman");
    expect(through).toEqual([`${PUSHER}/1 bind genOnOff`, `${PUSHER}/1 configureReporting genOnOff`, `${PUSHER}/1 read genBasic`]);
    expect(reached).toEqual(["Endpoint.bind", "Endpoint.configureReporting", "Endpoint.read"]);
  });

  it("refuses a bind to a group, by number or by model, and to anything but an endpoint: herdsman would create the group", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const ep = configuring(db.get(PUSHER), gate).getEndpoint(1)!;
    await expect(ep.bind("genOnOff", 901)).rejects.toBeInstanceOf(Refused);
    await expect(ep.bind("genOnOff", Group.create(902))).rejects.toBeInstanceOf(Refused);
    await expect(ep.bind("genOnOff", { deviceIeeeAddress: PUSHER, ID: 1 } as never)).rejects.toBeInstanceOf(Refused);
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.bind genOnOff: configure binds a cluster to an endpoint only, never to a group`);
  });

  it("refuses every other sending or model-changing method, a command and a write among them, never reaching herdsman", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = configuring(db.get(PUSHER), gate);
    const ep = d.getEndpoint(1)!;
    for (const m of [...SENDS.Endpoint, ...MODEL.Endpoint].filter((x) => !CONFIGURE.has(x))) {
      const r = (ep as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!("genOnOff", {}, {});
      await expect(r, m).rejects.toBeInstanceOf(Refused);
    }
    for (const m of [...SENDS.Device, ...MODEL.Device]) {
      await expect((d as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!(), m).rejects.toBeInstanceOf(Refused);
    }
    const g = configuring(Group.create(93), gate);
    for (const m of [...SENDS.Group, ...MODEL.Group]) {
      await expect((g as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!("genOnOff", "on", {}), m).rejects.toBeInstanceOf(Refused);
    }
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.write genOnOff: configure sends a device nothing but a bind to an endpoint, a reporting set-up or a read`);
  });

  it("refuses every call through a gate its run closed, though the converter kept the endpoint", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const coordinator = configuring(db.get("0x00124b0012345678"), gate).getEndpoint(1)!;
    const ep = configuring(db.get(PUSHER), gate).getEndpoint(1)!;
    gate.closed = true;
    await expect(ep.bind("genOnOff", coordinator)).rejects.toBeInstanceOf(Refused);
    await expect(ep.configureReporting("genOnOff", [])).rejects.toBeInstanceOf(Refused);
    await expect(ep.read("genBasic", ["modelId"])).rejects.toBeInstanceOf(Refused);
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.read genBasic: configure has ended`);
  });

  it("leaves the guard and a live run shut for a bind and a reporting set-up", async () => {
    db = devices([PUSHER_ROW]);
    const { gate } = recording();
    configuring(db.get(PUSHER), gate);
    const coordinator = guard(db.get("0x00124b0012345678")).getEndpoint(1)!;
    const guarded = guard(db.get(PUSHER)).getEndpoint(1)!;
    await expect(guarded.bind("genOnOff", coordinator)).rejects.toBeInstanceOf(Refused);
    await expect(guarded.configureReporting("genOnOff", [])).rejects.toBeInstanceOf(Refused);
    const running = live(db.get(PUSHER), (_e, _m, a, send) => send(a)).getEndpoint(1)!;
    await expect(running.bind("genOnOff", coordinator)).rejects.toBeInstanceOf(Refused);
    await expect(running.configureReporting("genOnOff", [])).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual([]);
  });
});

group("removing: the guard opened for one removal (plan 3b)", () => {
  /** A gate that records each call it is given, then makes it. */
  const recording = () => {
    const through: string[] = [];
    const gate: RemovalGate = (device, method, args, send) => {
      through.push(`${device.ieeeAddr} ${method}`);
      return send(args);
    };
    return { through, gate };
  };

  it("opens exactly the device's removeFromNetwork, and with force its removeFromDatabase alone", () => {
    expect([...REMOVE]).toEqual(["removeFromNetwork"]);
    expect([...FORCED]).toEqual(["removeFromDatabase"]);
    expect(SENDS.Device).toContain("removeFromNetwork");
    expect(MODEL.Device).toContain("removeFromDatabase");
  });

  it("sends a removal's Leave Request through its gate to herdsman's own device, and nothing else of the device's", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = removing(db.get(PUSHER), gate, false);
    await expect(d.removeFromNetwork()).rejects.toThrow("reached herdsman");
    expect(through).toEqual([`${PUSHER} removeFromNetwork`]);
    expect(reached).toEqual(["Device.removeFromNetwork"]);
    // Without force, herdsman's record is never dropped without the device's answer.
    for (const m of [...SENDS.Device, ...MODEL.Device].filter((x) => x !== "removeFromNetwork")) {
      await expect((d as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!(), m).rejects.toBeInstanceOf(Refused);
    }
    const ep = d.getEndpoint(1)!;
    for (const m of [...SENDS.Endpoint, ...MODEL.Endpoint]) {
      await expect((ep as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!("genOnOff", {}, {}), m).rejects.toBeInstanceOf(Refused);
    }
    expect(through).toEqual([`${PUSHER} removeFromNetwork`]);
    expect(reached).toEqual(["Device.removeFromNetwork"]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}: refused device.removeFromDatabase: a removal sends a device nothing but its Leave Request, or with force drops herdsman's record`);
  });

  it("drops herdsman's record through a forced removal's gate, sending nothing: its Leave Request refused", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = removing(db.get(PUSHER), gate, true);
    await expect(d.removeFromDatabase()).rejects.toThrow("reached herdsman");
    await expect(d.removeFromNetwork()).rejects.toBeInstanceOf(Refused);
    expect(through).toEqual([`${PUSHER} removeFromDatabase`]);
    expect(reached).toEqual(["Device.removeFromDatabase"]);
  });

  it("refuses every call through a gate its removal closed, though the model was kept", async () => {
    db = devices([PUSHER_ROW]);
    const { through, gate } = recording();
    const d = removing(db.get(PUSHER), gate, false);
    const forced = removing(db.get(PUSHER), gate, true);
    gate.closed = true;
    await expect(d.removeFromNetwork()).rejects.toBeInstanceOf(Refused);
    await expect(forced.removeFromDatabase()).rejects.toBeInstanceOf(Refused);
    expect(through).toEqual([]);
    expect(reached).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}: refused device.removeFromNetwork: the removal has ended`);
  });

  it("leaves the guard, a live run and configure shut for a removal", async () => {
    db = devices([PUSHER_ROW]);
    const { gate } = recording();
    removing(db.get(PUSHER), gate, true);
    const pass = (async (_e: unknown, _m: unknown, a: unknown[], send: (a: unknown[]) => Promise<unknown>) => send(a));
    for (const d of [guard(db.get(PUSHER)), live(db.get(PUSHER), pass as unknown as Gate),
      configuring(db.get(PUSHER), pass as unknown as Gate<ConfigureMethod>)]) {
      await expect(d.removeFromNetwork()).rejects.toBeInstanceOf(Refused);
      await expect((d as unknown as { removeFromDatabase(): Promise<unknown> }).removeFromDatabase()).rejects.toBeInstanceOf(Refused);
    }
    expect(reached).toEqual([]);
  });
});

group("answering: a converter's answers to a device, each in its own exchange (plan 2c-3)", () => {
  it("names five answers, each an endpoint's command or read response", () => {
    expect(ANSWERS.map((a) => `${a.cluster}.${a.command ?? a.method}`)).toEqual(["manuSpecificTuya.mcuGatewayConnectionStatus",
      "manuSpecificTuya.mcuSyncTime", "genBasic.readResponse", "genTime.readResponse", "manuSpecificTuya.dataQuery"]);
    for (const a of ANSWERS) expect(SENDS.Endpoint).toContain(a.method);
  });

  it("lets through a message's own answer, sent at once, and nothing else of the endpoint's", async () => {
    db = devices([PUSHER_ROW]);
    const ex = messageExchange("manuSpecificTuya", "commandMcuGatewayConnectionStatus");
    const ep = answering(db.get(PUSHER), ex).getEndpoint(1)!;
    await expect(ep.command("manuSpecificTuya", "mcuGatewayConnectionStatus", { payloadSize: 1, payload: 1 }, {})).rejects.toThrow("reached herdsman");
    await expect(ep.command("manuSpecificTuya", "mcuSyncTime", {}, {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.command("manuSpecificTuya", "dataQuery", {}, {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.command(0xef00 as never, "mcuGatewayConnectionStatus", {}, {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.write("manuSpecificTuya", {})).rejects.toBeInstanceOf(Refused);
    await expect(ep.readResponse("genTime", 1, { time: 1 })).rejects.toBeInstanceOf(Refused);
    expect(reachedWith).toEqual([["Endpoint.command", "manuSpecificTuya", "mcuGatewayConnectionStatus", { payloadSize: 1, payload: 1 },
      { sendPolicy: "immediate", disableRecovery: true, timeout: ANSWER_MS }]]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${PUSHER}/1: answered manuSpecificTuya.mcuGatewayConnectionStatus: a Tuya device asks whether its gateway is connected`);
    expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: a converter answers a device by itself only as the doer's answers say`);
  });

  it("sends an answer without herdsman's recovery, under ANSWER_MS, whatever options the converter gave (plan 2c-3 review I1)", async () => {
    db = devices([PUSHER_ROW]);
    const ep = answering(db.get(PUSHER), messageExchange("manuSpecificTuya", "commandMcuSyncTime")).getEndpoint(1)!;
    await expect(ep.command("manuSpecificTuya", "mcuSyncTime", {}, { timeout: 10_000, disableRecovery: false, srcEndpoint: 1 }))
      .rejects.toThrow("reached herdsman");
    const read = answering(db.get(PUSHER), readExchange("genTime", [0], 4)).getEndpoint(1)!;
    await expect(read.readResponse("genTime", 4, { time: 1 }, { timeout: 10_000 })).rejects.toThrow("reached herdsman");
    expect(reachedWith.map((c) => c[4])).toEqual([
      { timeout: ANSWER_MS, disableRecovery: true, srcEndpoint: 1, sendPolicy: "immediate" },
      { timeout: ANSWER_MS, disableRecovery: true, sendPolicy: "immediate" }]);
    // A few seconds: an answer holds the device's place in herdsman's adapter queue no longer than that.
    expect(ANSWER_MS).toBe(3_000);
  });

  it("opens nothing for a message no answer names, and refuses its answer once the exchange closed", async () => {
    db = devices([PUSHER_ROW]);
    expect(messageExchange("genOnOff", "attributeReport").answers).toEqual([]);
    const report = answering(db.get(PUSHER), messageExchange("genOnOff", "attributeReport")).getEndpoint(1)!;
    await expect(report.command("manuSpecificTuya", "mcuGatewayConnectionStatus", {}, {})).rejects.toBeInstanceOf(Refused);
    const ex = messageExchange("manuSpecificTuya", "commandMcuSyncTime");
    const ep = answering(db.get(PUSHER), ex).getEndpoint(1)!;
    ex.closed = true;
    await expect(ep.command("manuSpecificTuya", "mcuSyncTime", {}, {})).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual([]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: the exchange it answers has ended`);
  });

  it("lets a read's response through only with the read's transaction and the attributes its answer names", async () => {
    db = devices([PUSHER_ROW]);
    const legrand = answering(db.get(PUSHER), readExchange("genBasic", [0xf000], 7)).getEndpoint(1)!;
    await expect(legrand.readResponse("genBasic", 8, { 61440: { value: 23, type: 0x23 } })).rejects.toBeInstanceOf(Refused);
    await expect(legrand.readResponse("genBasic", 7, { 61440: { value: 23, type: 0x23 }, modelId: "x" })).rejects.toBeInstanceOf(Refused);
    await expect(legrand.readResponse("genBasic", 7, { 61440: { value: 23, type: 0x23 } })).rejects.toThrow("reached herdsman");
    expect(readExchange("genBasic", [5], 7).answers).toEqual([]);
    const time = answering(db.get(PUSHER), readExchange("genTime", [0, 7], 9)).getEndpoint(1)!;
    await expect(time.readResponse("genTime", 9, { time: 1, localTime: 2 })).rejects.toThrow("reached herdsman");
    expect(reached).toEqual(["Endpoint.readResponse", "Endpoint.readResponse"]);
    expect(reachedWith[0]![4]).toEqual({ sendPolicy: "immediate", disableRecovery: true, timeout: ANSWER_MS });
  });

  it("answers a device's read from a read handler set through an answering device, and from none set through the guard", () => {
    db = devices([PUSHER_ROW]);
    const real = db.get(PUSHER);
    const read = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "read", "genBasic",
      [{ attrId: 61440 }], {});
    const handler = (f: Zcl.Frame, endpoint: Endpoint) => {
      void endpoint.readResponse("genBasic", f.header.transactionSequenceNumber, { 61440: { value: 23, type: 0x23 } }).catch(() => {});
      return true;
    };
    const ex = eventExchange("start");
    answering(real, ex).customReadResponse = handler as never;
    ex.closed = true;
    // The start's exchange is long closed: the read is an exchange of its own.
    expect(real.customReadResponse!(read, real.getEndpoint(1)!)).toBe(true);
    expect(reached).toEqual(["Endpoint.readResponse"]);
    guard(real).customReadResponse = handler as never;
    expect(real.customReadResponse!(read, real.getEndpoint(1)!)).toBe(false);
    // A read the answer does not name: refused, and herdsman answers.
    answering(real, eventExchange("start")).customReadResponse = handler as never;
    const other = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 4, "read", "genBasic",
      [{ attrId: 5 }], {});
    expect(real.customReadResponse!(other, real.getEndpoint(1)!)).toBe(false);
    expect(reached).toEqual(["Endpoint.readResponse"]);
  });

  it("refuses a read handler's answer it sends after it returned", async () => {
    db = devices([PUSHER_ROW]);
    const real = db.get(PUSHER);
    const read = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 5, "read", "genTime", [{ attrId: 0 }], {});
    let later: Promise<unknown> | undefined;
    answering(real, eventExchange("start")).customReadResponse = ((f: Zcl.Frame, endpoint: Endpoint) => {
      setTimeout(() => { later = endpoint.readResponse("genTime", f.header.transactionSequenceNumber, { time: 1 }); }, 0);
      return true;
    }) as never;
    expect(real.customReadResponse!(read, real.getEndpoint(1)!)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    await expect(later).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual([]);
  });

  it("answers the button pusher's gateway-status request and time sync as they are read, and nothing else", async () => {
    db = devices([SENSOR_ROW, PUSHER_ROW]);
    const { events } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events, overrideOf: () => ({ options: { time_start: "1970" } }) });
    const pusher = db.get(PUSHER);
    await layer.add(pusher);
    await layer.add(db.get(SENSOR));
    await layer.announced(pusher);
    await layer.heard(message(pusher, { cluster: "manuSpecificTuya", command: "mcuGatewayConnectionStatus", tsn: 9,
      payload: { payloadSize: 1, payload: 0 } }) as never);
    await layer.heard(message(pusher, { cluster: "manuSpecificTuya", command: "mcuSyncTime", tsn: 10, payload: { payloadSize: 0, payload: [] } }) as never);
    await layer.heard(datapoints(pusher, 11, [[101, 4, [0]], [105, 2, [0, 0, 0, 40]]]) as never);
    await layer.clear();
    await layer.idle();
    expect(reachedWith.map((c) => `${String(c[0])} ${String(c[1])}.${String(c[2])}`)).toEqual([
      "Endpoint.command manuSpecificTuya.mcuGatewayConnectionStatus", "Endpoint.command manuSpecificTuya.mcuSyncTime"]);
  });

  it("closes a message's answers once the message is read: an answer a converter sends later is refused", async () => {
    db = devices([PUSHER_ROW]);
    const pusher = db.get(PUSHER);
    const real = (await findByDevice(pusher, true))!;
    await real.onEvent?.({ type: "start", data: { device: pusher, state: {}, options: {}, deviceExposesChanged: () => {} } });
    let kept: Endpoint | undefined;
    const answer = () => kept!.command("manuSpecificTuya", "mcuGatewayConnectionStatus", { payloadSize: 1, payload: 1 }, {});
    const definition = { ...real, fromZigbee: [{ cluster: "manuSpecificTuya", type: ["commandMcuGatewayConnectionStatus"],
      convert: async (_m: unknown, msg: { endpoint: Endpoint }) => {
        kept = msg.endpoint;
        await answer().catch(() => {});
      } }] } as unknown as Definition;
    const p = new Pipeline({ clock: new FakeClock(), late: () => {}, exposesChanged: () => {}, answers: true });
    p.set(PUSHER, { definition, keys: new Map() });
    await p.message(message(pusher, { cluster: "manuSpecificTuya", command: "mcuGatewayConnectionStatus", tsn: 9,
      payload: { payloadSize: 1, payload: 0 } }) as never);
    expect(reached).toEqual(["Endpoint.command"]);
    await expect(answer()).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual(["Endpoint.command"]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: the exchange it answers has ended`);
  });

  it("closes an announce's answers once its hooks returned: a query a hook sends later is refused", async () => {
    db = devices([PUSHER_ROW]);
    const pusher = db.get(PUSHER);
    const real = (await findByDevice(pusher, true))!;
    let kept: Device | undefined;
    const query = () => kept!.getEndpoint(1)!.command("manuSpecificTuya", "dataQuery", {}, {});
    const definition = { ...real, onEvent: async (event: { type: string; data: { device?: Device } }) => {
      if (event.type !== "deviceAnnounce") return real.onEvent?.(event as never);
      kept = event.data.device;
      await query().catch(() => {});
    } } as unknown as Definition;
    const { events } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events, definitionOf: async () => definition });
    await layer.add(pusher);
    await layer.announced(pusher);
    await layer.idle();
    expect(reachedWith.map((c) => `${String(c[0])} ${String(c[1])}.${String(c[2])}`)).toEqual(["Endpoint.command manuSpecificTuya.dataQuery"]);
    await expect(query()).rejects.toBeInstanceOf(Refused);
    expect(reached).toEqual(["Endpoint.command"]);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command manuSpecificTuya: the exchange it answers has ended`);
    await layer.clear();
    await layer.idle();
  });

  it("answers a Tuya model's announce with its query and a Legrand device's security read, and still refuses timers' queries, reads and time writes", async () => {
    vi.useFakeTimers();
    db = devices(SENDERS);
    const { events } = core();
    const layer = new HerdsmanDevices({ clock: new FakeClock(), events: () => events });
    for (const ieee of [ANNOUNCE_QUERY, INTERVAL_QUERY, BATTERY_READ, TIME_WRITE]) await layer.add(db.get(ieee));
    for (const ieee of [ANNOUNCE_QUERY, INTERVAL_QUERY, BATTERY_READ, TIME_WRITE]) await layer.announced(db.get(ieee));
    await vi.advanceTimersByTimeAsync(25 * 3_600_000);
    await layer.idle();
    const legrand = db.get(BATTERY_READ);
    const read = Zcl.Frame.create(Zcl.FrameType.GLOBAL, Zcl.Direction.CLIENT_TO_SERVER, true, undefined, 3, "read", "genBasic",
      [{ attrId: 61440 }], {});
    expect(legrand.customReadResponse!(read, legrand.getEndpoint(1)!)).toBe(true);
    expect(reachedWith.map((c) => `${String(c[0])} ${String(c[1])}`)).toEqual(["Endpoint.command manuSpecificTuya", "Endpoint.readResponse genBasic"]);
    const refused = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("zigbee: ") && l.includes("refused"));
    expect(refused.some((l) => l.startsWith(`zigbee: ${ANNOUNCE_QUERY}/1: refused`))).toBe(false);
    expect(refused.some((l) => l.startsWith(`zigbee: ${INTERVAL_QUERY}/1: refused endpoint.command manuSpecificTuya`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${BATTERY_READ}/1: refused endpoint.read genPowerCfg`))).toBe(true);
    expect(refused.some((l) => l.startsWith(`zigbee: ${TIME_WRITE}/1: refused endpoint.write genTime`))).toBe(true);
    await layer.clear();
    await layer.idle();
  });
});
