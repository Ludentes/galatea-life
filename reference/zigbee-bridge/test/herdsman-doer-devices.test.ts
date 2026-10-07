import { afterEach, describe as group, expect, it } from "vitest";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import { NAMESPACE } from "../src/herdsman/describe.js";
import { HerdsmanDoer } from "../src/herdsman/doer.js";
import type { Message } from "../src/herdsman/pipeline.js";
import type { Description } from "../src/port.js";
import { EXCHANGE_MS } from "../src/transport.js";
import { FakeClock, settle } from "./fakes.js";
import { core, type FakeStack, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { datapoints, devices, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices> | undefined;
const doers: HerdsmanDoer[] = [];
afterEach(async () => {
  for (const d of doers.splice(0)) await d.stop();
  db?.close();
  db = undefined;
});

const MODE = `${NAMESPACE}.ts0001_fingerbot.mode`;

/** A doer over fake stacks whose herdsman has the bench's two models, as real herdsman devices; `kept` is the store's settings. */
async function started(kept: [string, Record<string, unknown>][] = []) {
  db = devices([SENSOR_ROW, PUSHER_ROW]);
  const clock = new FakeClock();
  const { made, make } = stacks((s) => {
    s.had.add(SENSOR);
    s.had.add(PUSHER);
    s.lookup = (ieee) => db!.get(ieee);
  });
  const doer = new HerdsmanDoer({ clock, coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
    readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES });
  doers.push(doer);
  const { events, seen } = core();
  await doer.start(events, new Map(kept));
  await settle();
  await doer.idle();
  return { clock, doer, made, seen };
}

const described = (seen: unknown[][]) => seen.filter((e) => e[0] === "described").map((e) => e[1] as Description);
const of = (seen: unknown[][], kind: string) => seen.filter((e) => e[0] === kind);
const say = (s: FakeStack, m: unknown) => {
  s.events.heard((m as Message).device.ieeeAddr);
  s.events.message!(m as Message);
};

group("HerdsmanDoer: its devices", () => {
  it("describes every device herdsman has once it resumed, with the actions it carries out", async () => {
    const { seen } = await started();
    expect(described(seen).map((d) => [d.hardwareId, d.actions.map((a) => a.action).includes(`${NAMESPACE}.ts0001_fingerbot.set_mode`)]))
      .toEqual([[SENSOR, false], [PUSHER, true]]);
    // The vibration sensor offers its sensitivity, which the core withholds: its reach is not known (GA-BRIDGE-7).
    expect(described(seen)[0]!.actions.map((a) => a.action)).toEqual([`${NAMESPACE}.ts0210.set_sensitivity`]);
  });

  it("describes a device from the settings the store kept", async () => {
    const { doer } = await started([[PUSHER, { [MODE]: "click" }]]);
    const kept = (doer as unknown as { devices: { description(hw: string): Description } }).devices.description(PUSHER);
    expect(kept.actions.filter((a) => a.action.startsWith("onoff.") || a.action.endsWith(".press")).map((a) => [a.action.split(".").pop(), a.stateless])).toEqual([["press", true]]);
  });

  it("tells the core what a device's message gave, through its converters", async () => {
    const { made, seen, doer, clock } = await started();
    say(made[0]!, datapoints(db!.get(PUSHER), 9, [[105, 2, [0, 0, 0, 40]]]));
    await doer.idle();
    expect(of(seen, "observed")).toEqual([["observed", PUSHER, { battery: 40 }, clock.now(), true]]);
  });

  it("describes a device herdsman interviewed, after telling the core so", async () => {
    const { made, seen, doer } = await started();
    seen.length = 0;
    // The made-up device's description is unchanged: nothing more is sent, but it was asked.
    made[0]!.events.interviewed(PUSHER, "successful");
    await doer.idle();
    expect(seen).toEqual([["interviewed", PUSHER]]);
  });

  it("reads no more messages of a device that left", async () => {
    const { made, seen, doer } = await started();
    made[0]!.events.left(PUSHER);
    await doer.idle();
    seen.length = 0;
    made[0]!.events.message!(datapoints(db!.get(PUSHER), 10, [[105, 2, [0, 0, 0, 40]]]) as never);
    await doer.idle();
    expect(seen).toEqual([]);
  });

  it("reads no message of a controller that is gone, and sends no description again for the next one", async () => {
    const { made, seen, doer, clock } = await started();
    made[0]!.events.disconnected();
    await settle();
    await doer.idle();
    made[0]!.events.message!(datapoints(db!.get(PUSHER), 11, [[105, 2, [0, 0, 0, 40]]]) as never);
    await clock.advance(EXCHANGE_MS);
    await settle();
    await doer.idle();
    expect(made).toHaveLength(2);
    expect(of(seen, "observed")).toEqual([]);
    expect(described(seen)).toHaveLength(2);
    say(made[1]!, datapoints(db!.get(PUSHER), 12, [[105, 2, [0, 0, 0, 41]]]));
    await doer.idle();
    expect(of(seen, "observed")).toHaveLength(1);
  });

  it("still carries out no action", async () => {
    const { doer } = await started();
    expect(await doer.execute()).toMatchObject({ kind: "notSent", reason: "unreachable" });
  });
});

group("HerdsmanDoer: the plan 2c-1 review's findings (M8)", () => {
  /** A doer as `started` gives, its converters' hooks and every stack's close written to one log, in order. */
  async function logged() {
    db = devices([SENSOR_ROW, PUSHER_ROW]);
    const clock = new FakeClock();
    const log: string[] = [];
    const { made, make } = stacks((s, n) => {
      s.had.add(SENSOR);
      s.had.add(PUSHER);
      s.lookup = (ieee) => db!.get(ieee);
      const close = s.close.bind(s);
      s.close = async () => {
        log.push(`close ${n}`);
        await close();
      };
    });
    const doer = new HerdsmanDoer({ clock, coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES,
      definitionOf: async (d) => {
        const def = (await findByDevice(d, true))!;
        return { ...def, onEvent: async (e: { type: string }) => { log.push(`${e.type} ${d.ieeeAddr}`); } } as Definition;
      } });
    doers.push(doer);
    const { events, seen } = core();
    await doer.start(events);
    await settle();
    await doer.idle();
    return { clock, doer, made, seen, log };
  }

  it("stops the devices' converters before it closes their controller", async () => {
    const { made, doer, log } = await logged();
    log.length = 0;
    made[0]!.events.disconnected();
    await settle();
    await doer.idle();
    expect(log).toEqual([`stop ${SENSOR}`, `stop ${PUSHER}`, "close 0"]);
  });

  it("reads no message of a controller that is gone, though the next controller has the same device", async () => {
    const { made, seen, doer, clock } = await logged();
    made[0]!.events.disconnected();
    await settle();
    await doer.idle();
    await clock.advance(EXCHANGE_MS);
    await settle();
    await doer.idle();
    expect(made).toHaveLength(2);
    seen.length = 0;
    made[0]!.events.message!(datapoints(db!.get(PUSHER), 13, [[105, 2, [0, 0, 0, 40]]]) as never);
    await doer.idle();
    expect(of(seen, "observed")).toEqual([]);
  });
});
