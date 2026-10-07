import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Zdo } from "zigbee-herdsman";
import { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import { Entity } from "zigbee-herdsman/dist/controller/model/entity.js";
import { type Definition, findByDevice } from "zigbee-herdsman-converters";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { HerdsmanDoer, NO_ACTIONS } from "../src/herdsman/doer.js";
import type { RemovalGate } from "../src/herdsman/guard.js";
import { PERMIT_MAX_S, PERMIT_MS, permitSeconds, removeDevice } from "../src/herdsman/provision.js";
import { FakeClock, settle } from "./fakes.js";
import { core, type FakeStack, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { devices, message, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

/**
 * The herdsman doer's provisioning (plan 3b), over fake stacks: what it asks of herdsman for a join
 * window, a removal and a join, and what it tells the core.
 */

const ROUTER = "0xa4c1380000000011";

const STRANGER = "0xa4c1380000000013";

let db: ReturnType<typeof devices> | undefined;
const doers: HerdsmanDoer[] = [];
afterEach(async () => {
  for (const d of doers.splice(0)) await d.stop();
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
});

/** Stacks whose herdsman has the bench's two models, as real herdsman devices, so the doer describes them. */
const withDevices = (s: FakeStack) => {
  db ??= devices([SENSOR_ROW, PUSHER_ROW]);
  s.had.add(SENSOR);
  s.had.add(PUSHER);
  s.lookup = (ieee) => db!.get(ieee);
};

const of = (seen: unknown[][], ...names: string[]) => seen.filter((e) => names.includes(e[0] as string))
  .map((e) => (e[0] === "described" ? ["described", (e[1] as { hardwareId: string }).hardwareId] : e));

interface Setup {
  prepare?: (s: FakeStack, n: number) => void;
  refuse?: (hw: string) => boolean;
  kept?: string[];
  noActions?: boolean;
  /** Each converter hook a definition is told, as `<ieee> <type>`. */
  hooks?: string[];
}

async function started(o: Setup = {}) {
  const clock = new FakeClock();
  const { made, make } = stacks(o.prepare);
  const doer = new HerdsmanDoer({ clock, coordinator: "tcp://coordinator.invalid:6638", dataDir: "/data/zigbee", makeStack: make,
    readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES, backupTakenAt: async () => clock.now(),
    ...(o.noActions ? { noActions: true } : {}),
    ...(o.hooks ? { definitionOf: async (d: Parameters<typeof findByDevice>[0]) => {
      const def = (await findByDevice(d, true))!;
      return { ...def, onEvent: async (e: Parameters<NonNullable<Definition["onEvent"]>>[0]) => {
        o.hooks!.push(`${d.ieeeAddr} ${e.type}`);
        await def.onEvent?.(e);
      } } as Definition;
    } } : {}) });
  doers.push(doer);
  const { events, seen } = core(o.refuse);
  await doer.start(events, new Map((o.kept ?? []).map((hw) => [hw, {}])));
  await settle();
  return { clock, doer, made, seen };
}

/**
 * The close a doer's first controller sends once it resumed: a bridge that stopped without closing its
 * window may have left the coordinator permitting joins (plan 3b review I2).
 */
const START_CLOSE = "permitJoin 0";

/** The permits a stack was asked for, in order. */
const permits = (s: FakeStack) => s.calls.filter((c) => c.startsWith("permitJoin"));

describe("HerdsmanDoer: Provision claimed (plan 3b)", () => {
  it("provisions, so the bridge claims Provision; not under the owner's switch, which sends nothing", async () => {
    const { doer } = await started();
    const withheld = await started({ noActions: true });
    expect([doer.provisions, withheld.doer.provisions]).toEqual([true, false]);
  });
});

describe("HerdsmanDoer: join windows (GA-BRIDGE-25, 26)", () => {
  it("asks herdsman for the window's whole seconds, rounded up, at least 1, at most 254", () => {
    expect([permitSeconds(60_000), permitSeconds(1_500), permitSeconds(100), permitSeconds(254_000), permitSeconds(999_000)])
      .toEqual([60, 2, 1, 254, 254]);
    expect(PERMIT_MAX_S).toBe(254);
  });

  it("opens herdsman's permit house-wide, or at the router near names, and closes it with a permit of 0", async () => {
    const { doer, made } = await started();
    await doer.join(60_000);
    await doer.joinClose();
    await doer.join(1_500, ROUTER);
    await doer.joinClose();
    expect(permits(made[0]!)).toEqual([START_CLOSE, "permitJoin 60", "permitJoin 0", `permitJoin 2 ${ROUTER}`, "permitJoin 0"]);
  });

  it("sends no close while its window is not open: none opened, or closed already", async () => {
    const { doer, made } = await started();
    await doer.joinClose();
    await doer.join(60_000);
    await doer.joinClose();
    await doer.joinClose();
    expect(permits(made[0]!)).toEqual([START_CLOSE, "permitJoin 60", "permitJoin 0"]);
  });

  it("rejects a join herdsman rejects, keeping its window open until the core closes it", async () => {
    const { doer, made } = await started();
    made[0]!.permitResult = async () => { throw new Error(`${ROUTER} is no router herdsman has`); };
    await expect(doer.join(60_000, ROUTER)).rejects.toThrow("is no router herdsman has");
    made[0]!.permitResult = async () => {};
    await doer.joinClose();
    expect(permits(made[0]!)).toEqual([START_CLOSE, `permitJoin 60 ${ROUTER}`, "permitJoin 0"]);
  });

  it("gives up on a permit herdsman does not settle within PERMIT_MS", async () => {
    const { clock, doer, made } = await started();
    made[0]!.permitResult = () => new Promise(() => {});
    const joining = doer.join(60_000).then(() => "resolved", (e: Error) => e.message);
    await clock.advance(PERMIT_MS - 1);
    await settle();
    const early = await Promise.race([joining, Promise.resolve("pending")]);
    await clock.advance(1);
    expect([early, await joining]).toEqual(["pending", `no answer within ${PERMIT_MS} ms`]);
    // The window stays the doer's until its close, which herdsman answers now.
    made[0]!.permitResult = async () => {};
    await doer.joinClose();
    expect(permits(made[0]!)).toEqual([START_CLOSE, "permitJoin 60", "permitJoin 0"]);
  });

  it("rejects a join while no controller is up, sending nothing", async () => {
    const { clock, doer, made } = await started();
    made[0]!.events.disconnected();
    await settle();
    await expect(doer.join(60_000)).rejects.toThrow("the coordinator is not connected");
    await clock.advance(10_000);
    // The start's close alone: the window the core still holds open is owed no close, and given no permit.
    expect(made.flatMap(permits)).toEqual([START_CLOSE]);
  });

  it("closes an open window on the coordinator before the stop's backup and close; none when none is open", async () => {
    const { doer, made } = await started();
    await doer.join(200_000);
    await doer.stop();
    expect(made[0]!.calls.slice(1)).toEqual([START_CLOSE, "permitJoin 200", "permitJoin 0", "backup", "close"]);
    const other = await started();
    await other.doer.stop();
    expect(other.made[0]!.calls.slice(1)).toEqual([START_CLOSE, "backup", "close"]);
  });

  it("stops though the close of its window fails, and says so", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => { lines.push(String(l)); });
    const { doer, made } = await started();
    await doer.join(200_000);
    made[0]!.permitResult = async () => { throw new Error("no answer"); };
    await doer.stop();
    expect(made[0]!.calls.slice(-2)).toEqual(["backup", "close"]);
    expect(lines).toContain("herdsman: the join window was not closed at the stop: no answer");
  });

  it("opens no window under the owner's switch: nothing sent", async () => {
    const { doer, made } = await started({ noActions: true });
    await expect(doer.join(60_000)).rejects.toThrow(NO_ACTIONS);
    await doer.joinClose();
    await doer.stop();
    expect(permits(made[0]!)).toEqual([]);
  });
});

describe("HerdsmanDoer: the close the coordinator is owed (plan 3b review I2, M1, M4)", () => {
  it("closes, once its first controller resumed, any permit a bridge that stopped without closing left; none at the next controller", async () => {
    const { clock, doer, made } = await started();
    await doer.idle();
    expect(made[0]!.calls).toEqual(["start", START_CLOSE]);
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    expect(permits(made[1]!)).toEqual([]);
  });

  it("owes the close of a window closed while no controller is up, and sends it once, when the next is up", async () => {
    const { clock, doer, made } = await started();
    await doer.join(200_000);
    made[0]!.events.disconnected();
    await settle();
    await doer.joinClose();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    expect(permits(made[0]!)).toEqual([START_CLOSE, "permitJoin 200"]);
    expect(permits(made[1]!)).toEqual(["permitJoin 0"]);
    made[1]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(3);
    expect(permits(made[2]!)).toEqual([]);
  });

  it("owes no close once the coordinator's permit has run out on its own", async () => {
    let resume!: (r: string) => void;
    const { clock, doer, made } = await started({ prepare: (s, n) => {
      if (n === 1) s.result = new Promise((r) => { resume = r; });
    } });
    await doer.join(60_000);
    made[0]!.events.disconnected();
    await settle();
    await doer.joinClose();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    await clock.advance(50_000);
    resume("resumed");
    await settle();
    expect(made[1]!.calls).toEqual(["start"]);
  });

  it("ends its window though the close fails, and owes the close to the next controller", async () => {
    const { clock, doer, made, seen } = await started({ prepare: withDevices });
    await doer.idle();
    await doer.join(200_000);
    made[0]!.permitResult = async () => { throw new Error("no answer"); };
    await expect(doer.joinClose()).rejects.toThrow("no answer");
    seen.length = 0;
    // Outside the window: hardware herdsman has rejoins with its id, the core not asked.
    expect(await made[0]!.events.joining(SENSOR)).toBe(true);
    expect(of(seen, "mayAdmit", "admitted")).toEqual([["admitted", SENSOR, "securedRejoin"]]);
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(permits(made[1]!)).toEqual(["permitJoin 0"]);
  });

  it("sends no owed close while a window is open: that window's own close follows", async () => {
    const { clock, doer, made } = await started();
    await doer.join(200_000);
    made[0]!.permitResult = async () => { throw new Error("no answer"); };
    await expect(doer.joinClose()).rejects.toThrow("no answer");
    made[0]!.permitResult = async () => {};
    // A close owed, and a window open again before the next controller.
    await doer.join(200_000);
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    expect(permits(made[1]!)).toEqual([]);
    await doer.joinClose();
    expect(permits(made[1]!)).toEqual(["permitJoin 0"]);
  });

  for (const how of ["no controller up", "a close that fails"] as const) {
    it(`owes the close of a window whose permit never settled, with ${how}`, async () => {
      const { clock, doer, made } = await started();
      made[0]!.permitResult = () => new Promise(() => {});
      const joining = doer.join(200_000).catch((e: Error) => e.message);
      await clock.advance(PERMIT_MS);
      expect(await joining).toBe(`no answer within ${PERMIT_MS} ms`);
      if (how === "no controller up") {
        made[0]!.events.disconnected();
        await settle();
        await doer.joinClose();
      } else {
        made[0]!.permitResult = async () => { throw new Error("no answer"); };
        await expect(doer.joinClose()).rejects.toThrow("no answer");
        made[0]!.events.disconnected();
        await settle();
      }
      await clock.advance(10_000);
      expect(made).toHaveLength(2);
      expect(permits(made[1]!)).toEqual(["permitJoin 0"]);
    });
  }

  it("owes a close it could not send again, for as long as the permit it may close runs", async () => {
    let resume!: (r: string) => void;
    const { clock, doer, made } = await started({ prepare: (s, n) => {
      if (n === 0) s.permitResult = async () => { throw new Error("no answer"); };
      if (n === 1) s.result = new Promise((r) => { resume = r; });
    } });
    await settle();
    // The start's close failed: owed again. A window whose close fails cannot shorten it.
    expect(permits(made[0]!)).toEqual([START_CLOSE]);
    made[0]!.permitResult = async () => {};
    await doer.join(60_000);
    made[0]!.permitResult = async () => { throw new Error("no answer"); };
    await expect(doer.joinClose()).rejects.toThrow("no answer");
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    // The next controller resumes after the window's 60 s.
    await clock.advance(60_000);
    resume("resumed");
    await settle();
    expect(permits(made[1]!)).toEqual(["permitJoin 0"]);
  });

  it("owes nothing more once a close reached the coordinator", async () => {
    const { clock, doer, made } = await started();
    await doer.join(200_000);
    made[0]!.permitResult = async () => { throw new Error("no answer"); };
    await expect(doer.joinClose()).rejects.toThrow("no answer");
    made[0]!.permitResult = async () => {};
    await doer.join(200_000);
    await doer.joinClose();
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    expect(permits(made[1]!)).toEqual([]);
  });

  it("sends a join's permit only after the close under way, never before it", async () => {
    let answered!: () => void;
    const { doer, made } = await started({ prepare: (s) => {
      s.permitResult = () => new Promise<void>((r) => { answered = r; });
    } });
    const s = made[0]!;
    const joining = doer.join(60_000);
    await settle();
    expect(permits(s)).toEqual([START_CLOSE]);
    s.permitResult = async () => {};
    answered();
    await joining;
    expect(permits(s)).toEqual([START_CLOSE, "permitJoin 60"]);
  });

  it("closes again a permit that lands after its window closed, given up on at PERMIT_MS", async () => {
    const { clock, doer, made } = await started();
    const s = made[0]!;
    let landed!: () => void;
    s.permitResult = () => new Promise<void>((r) => { landed = r; });
    const joining = doer.join(60_000).catch((e: Error) => e.message);
    await clock.advance(PERMIT_MS);
    expect(await joining).toBe(`no answer within ${PERMIT_MS} ms`);
    const land = landed;
    s.permitResult = async () => {};
    await doer.joinClose();
    expect(permits(s)).toEqual([START_CLOSE, "permitJoin 60", "permitJoin 0"]);
    land();
    await settle();
    expect(permits(s)).toEqual([START_CLOSE, "permitJoin 60", "permitJoin 0", "permitJoin 0"]);
  });

  it("gives up on a close herdsman does not answer within PERMIT_MS: neither join_close nor the stop hangs", async () => {
    const { clock, doer, made } = await started();
    await doer.join(60_000);
    made[0]!.permitResult = () => new Promise(() => {});
    const closing = doer.joinClose().then(() => "closed", (e: Error) => e.message);
    await clock.advance(PERMIT_MS);
    expect(await closing).toBe(`no answer within ${PERMIT_MS} ms`);
    made[0]!.permitResult = async () => {};
    await doer.join(60_000);
    made[0]!.permitResult = () => new Promise(() => {});
    doers.splice(doers.indexOf(doer), 1);
    let stopped = false;
    const stopping = doer.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    await clock.advance(PERMIT_MS);
    await stopping;
    expect(made[0]!.calls.slice(-2)).toEqual(["backup", "close"]);
  });
});

describe("HerdsmanDoer: the join handler, by the window rule (the maintainer's ruling, 2026-10-05)", () => {
  it("lets in hardware herdsman has, outside its window, with its id: a secured rejoin, the core not asked", async () => {
    const { doer, made, seen } = await started({ prepare: withDevices, refuse: () => true });
    await doer.idle();
    seen.length = 0;
    expect(await made[0]!.events.joining(PUSHER)).toBe(true);
    await doer.idle();
    expect(of(seen, "mayAdmit", "admitted", "described")).toEqual([["admitted", PUSHER, "securedRejoin"]]);
  });

  it("reports a rejoin of hardware herdsman has though not described yet: the core keeps the device the store kept for it", async () => {
    let answer: boolean | undefined;
    const { seen } = await started({ prepare: (s) => {
      withDevices(s);
      s.midStart = async () => { answer = await s.events.joining(PUSHER); };
    }, refuse: () => true });
    expect(answer).toBe(true);
    expect(of(seen, "mayAdmit", "admitted")).toEqual([["admitted", PUSHER, "securedRejoin"]]);
  });

  it("asks the core about hardware herdsman has inside its window, and reports it let in as new, its description again under the new id", async () => {
    const { doer, made, seen } = await started({ prepare: withDevices });
    await doer.idle();
    await doer.join(60_000);
    seen.length = 0;
    expect(await made[0]!.events.joining(PUSHER)).toBe(true);
    await doer.idle();
    expect(of(seen, "mayAdmit", "admitted", "described", "interviewed")).toEqual([["mayAdmit", PUSHER], ["admitted", PUSHER, "association"],
      ["described", PUSHER]]);
  });

  it("refuses hardware herdsman has inside its window when the core refuses it: herdsman's Leave Request, and nothing reported", async () => {
    const { doer, made, seen } = await started({ prepare: withDevices, refuse: (hw) => hw === PUSHER });
    await doer.idle();
    await doer.join(60_000);
    seen.length = 0;
    expect(await made[0]!.events.joining(PUSHER)).toBe(false);
    await doer.idle();
    expect(of(seen, "mayAdmit", "admitted", "described")).toEqual([["mayAdmit", PUSHER]]);
  });

  it("takes hardware herdsman has for a rejoin again once its window is closed", async () => {
    const { doer, made, seen } = await started({ prepare: withDevices });
    await doer.idle();
    await doer.join(60_000);
    await doer.joinClose();
    seen.length = 0;
    expect(await made[0]!.events.joining(SENSOR)).toBe(true);
    expect(of(seen, "mayAdmit", "admitted")).toEqual([["admitted", SENSOR, "securedRejoin"]]);
  });

  it("asks the core about other hardware in a window or out, and refuses what it refuses", async () => {
    const { doer, made, seen } = await started({ prepare: withDevices, refuse: (hw) => hw === STRANGER });
    expect(await made[0]!.events.joining(STRANGER)).toBe(false);
    await doer.join(60_000);
    expect(await made[0]!.events.joining(STRANGER)).toBe(false);
    expect(await made[0]!.events.joining(ROUTER)).toBe(true);
    expect(of(seen, "mayAdmit", "admitted")).toEqual([["mayAdmit", STRANGER], ["mayAdmit", STRANGER], ["mayAdmit", ROUTER]]);
  });

  it("sends the description of hardware admitted anew while its controller restarts, though the controller before described it", async () => {
    const { clock, doer, made, seen } = await started({ prepare: (s, n) => {
      withDevices(s);
      if (n === 1) s.midStart = async () => { await s.events.joining(PUSHER); };
    } });
    await doer.idle();
    await doer.join(200_000);
    made[0]!.events.disconnected();
    await settle();
    seen.length = 0;
    await clock.advance(10_000);
    await doer.idle();
    expect(made).toHaveLength(2);
    expect(of(seen, "mayAdmit", "admitted", "described")).toEqual([["mayAdmit", PUSHER], ["admitted", PUSHER, "association"],
      ["described", PUSHER]]);
  });

  it("refuses nothing under the owner's switch, since a refusal sends a Leave Request, and asks the core nothing", async () => {
    const { made, seen } = await started({ prepare: withDevices, refuse: () => true, noActions: true });
    expect(await made[0]!.events.joining(STRANGER)).toBe(true);
    expect(of(seen, "mayAdmit")).toEqual([]);
  });
});

describe("HerdsmanDoer: a new device's join and interview, and its converters' hooks (plan 3b)", () => {
  it("reports herdsman's admission and interview, describes the device, and tells its converters deviceJoined and deviceInterview after", async () => {
    const hooks: string[] = [];
    const joined = vi.spyOn(HerdsmanDevices.prototype, "joined");
    const { doer, made, seen } = await started({ prepare: (s) => { withDevices(s); s.had.delete(PUSHER); }, hooks });
    await doer.idle();
    seen.length = 0;
    hooks.length = 0;
    const s = made[0]!;
    s.had.add(PUSHER);
    s.events.joined(PUSHER);
    s.events.interviewed(PUSHER, "started");
    s.events.interviewed(PUSHER, "successful");
    await doer.idle();
    expect(of(seen, "admitted", "interviewed", "described")).toEqual([["admitted", PUSHER, "association"], ["interviewed", PUSHER],
      ["described", PUSHER]]);
    // No definition before the interview: deviceJoined and the interview's start reach the converters' own hook alone.
    expect(hooks).toEqual([`${PUSHER} start`, `${PUSHER} deviceInterview`]);
    expect(joined.mock.calls.map(([m]) => m.ieeeAddr), "deviceJoined, to the converters' own hook").toEqual([PUSHER]);
    joined.mockRestore();
  });

  it("tells a failed interview to the converters, and reports and describes nothing", async () => {
    const hooks: string[] = [];
    const { doer, made, seen } = await started({ prepare: withDevices, hooks });
    await doer.idle();
    seen.length = 0;
    hooks.length = 0;
    made[0]!.events.interviewed(PUSHER, "failed");
    await doer.idle();
    expect(of(seen, "interviewed", "described")).toEqual([]);
    expect(hooks).toEqual([`${PUSHER} deviceInterview`]);
  });
});

describe("HerdsmanDoer: remove, over herdsman's own models (GA-BRIDGE-21, 27)", () => {
  /** Stacks over herdsman's own models: what they have is what herdsman's caches have, so a removal's deletion shows. */
  const overModels = (s: FakeStack) => {
    withDevices(s);
    s.lookup = (ieee) => Device.byIeeeAddr(ieee);
    s.has = (ieee) => s.opened && Device.byIeeeAddr(ieee) !== undefined;
  };
  /** herdsman's adapter, stubbed: each ZDO request recorded as `<ieee> <cluster>`, answered as `answer` says. */
  let answer: () => Promise<unknown>;
  let zdo: string[];
  const LEAVE = Zdo.ClusterId.LEAVE_REQUEST;
  beforeEach(() => {
    zdo = [];
    answer = async () => [Zdo.Status.SUCCESS, undefined];
    Entity.injectAdapter({ hasZdoMessageOverhead: false, sendZdo: async (ieee: string, _nwk: number, clusterId: number) => {
      zdo.push(`${ieee} ${clusterId}`);
      return await answer();
    } } as never);
  });
  afterEach(() => { Entity.injectAdapter(undefined as never); });

  /** The sensor's battery report: a message from it, so it is awake. */
  const awake = (s: FakeStack, tsn: number) => {
    const m = message(Device.byIeeeAddr(SENSOR)!, { cluster: "genPowerCfg", command: "report", global: true, tsn,
      payload: [{ attrId: 0x21, dataType: 0x20, attrData: 200 }] });
    s.events.heard(SENSOR);
    s.events.message!(m as never);
  };
  const silent = () => new Error("AREQ - ZDO - mgmtLeaveRsp after 10000ms");

  it("sends a device that answers herdsman's Leave Request, and reports it left once herdsman deleted it", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    await doer.remove(SENSOR, false);
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`]);
    expect(made[0]!.has(SENSOR)).toBe(false);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("reports hardware herdsman does not have left at once, sending nothing", async () => {
    const { doer, seen } = await started({ prepare: overModels });
    await doer.remove(STRANGER, false);
    await doer.remove(STRANGER, true);
    expect(zdo).toEqual([]);
    expect(of(seen, "left")).toEqual([["left", STRANGER], ["left", STRANGER]]);
  });

  it("waits for a device that does not answer, trying again at its next message, one try at a time, until it is out", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    answer = async () => { throw silent(); };
    let settled = false;
    const removal = doer.remove(SENSOR, false).then(() => { settled = true; });
    await settle();
    expect([zdo.length, settled, made[0]!.has(SENSOR)]).toEqual([1, false, true]);
    // Awake, but its answer does not come while it is tried: a second message makes no second try.
    let release!: (v: unknown) => void;
    answer = () => new Promise((r) => { release = r; });
    awake(made[0]!, 1);
    awake(made[0]!, 2);
    await settle();
    expect(zdo).toHaveLength(2);
    release([Zdo.Status.SUCCESS, undefined]);
    await removal;
    expect(made[0]!.has(SENSOR)).toBe(false);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("is tried again at the device's announce too", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    answer = async () => { throw silent(); };
    const removal = doer.remove(SENSOR, false);
    await settle();
    answer = async () => [Zdo.Status.SUCCESS, undefined];
    made[0]!.events.announced!(SENSOR);
    await removal;
    expect(zdo).toHaveLength(2);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("ends the wait on herdsman's own leave of the device, reported once though its Leave Request's answer comes after", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    // The device leaves, and herdsman hears its leave, before the Leave Request's answer comes.
    answer = async () => {
      made[0]!.events.left(SENSOR);
      return [Zdo.Status.SUCCESS, undefined];
    };
    await doer.remove(SENSOR, false);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
    // And a removal waiting for a silent device ends when herdsman hears it leave.
    answer = async () => { throw silent(); };
    const removal = doer.remove(PUSHER, false);
    await settle();
    made[0]!.events.left(PUSHER);
    await removal;
    expect(of(seen, "left")).toEqual([["left", SENSOR], ["left", PUSHER]]);
  });

  it("rejects when the device refuses its removal, herdsman keeping it: the core keeps the removal pending", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    answer = async () => [Zdo.Status.NOT_SUPPORTED, undefined];
    await expect(doer.remove(SENSOR, false)).rejects.toThrow("the device refused its removal: Status 'NOT_SUPPORTED'");
    expect(made[0]!.has(SENSOR)).toBe(true);
    expect(of(seen, "left")).toEqual([]);
    // Not waiting any more: its next message tries nothing.
    awake(made[0]!, 3);
    await settle();
    expect(zdo).toHaveLength(1);
  });

  it("drops herdsman's record with force, sending nothing, and ends a removal still waiting for the device", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    answer = async () => { throw silent(); };
    const waiting = doer.remove(SENSOR, false);
    await settle();
    await doer.remove(SENSOR, true);
    await waiting;
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`]);
    expect(made[0]!.has(SENSOR)).toBe(false);
    expect(Device.byIeeeAddr(SENSOR, true)?.isDeleted).toBe(true);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("tries a removal asked with no controller up once the next one is up, hardware it lacks ending then", async () => {
    const { clock, doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    made[0]!.events.disconnected();
    await settle();
    const removal = doer.remove(SENSOR, false);
    const lacking = doer.remove(STRANGER, false);
    await settle();
    expect(zdo).toEqual([]);
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    await Promise.all([removal, lacking]);
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`]);
    expect(of(seen, "left").map(([, hw]) => hw).sort()).toEqual([SENSOR, STRANGER].sort());
  });

  it("queues a forced removal asked with no controller up, and drops herdsman's record before the next controller describes the device", async () => {
    const hooks: string[] = [];
    const { clock, doer, made, seen } = await started({ prepare: overModels, hooks });
    await doer.idle();
    made[0]!.events.disconnected();
    await settle();
    await doer.idle();
    seen.length = 0;
    hooks.length = 0;
    let removed = false;
    const forced = doer.remove(PUSHER, true).then(() => { removed = true; });
    await settle();
    expect(removed).toBe(false);
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    await forced;
    await doer.idle();
    expect(zdo).toEqual([]);
    // herdsman's record dropped as the controller resumed: no later start describes it, so it is never admitted anew.
    expect([Device.byIeeeAddr(PUSHER, true)?.isDeleted, made[1]!.has(PUSHER), made[1]!.has(SENSOR)]).toEqual([true, false, true]);
    expect(of(seen, "left", "described")).toEqual([["left", PUSHER]]);
    // Its converters never started on the new controller: it was dropped before the descriptions.
    expect(hooks.filter((h) => h.startsWith(PUSHER))).toEqual([]);
    expect(hooks).toContain(`${SENSOR} start`);
  });

  it("ends a removal waiting for its device when the hardware is admitted anew: no Leave Request to the new device, no left; a later removal of it runs", async () => {
    const { doer, made, seen } = await started({ prepare: overModels });
    await doer.idle();
    // The owner removes the sensor; it is asleep and does not answer.
    answer = async () => { throw silent(); };
    let removed = false;
    void doer.remove(SENSOR, false).then(() => { removed = true; });
    await settle();
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`]);
    // It is paired again in a window: a new admission of the hardware herdsman still has.
    await doer.join(60_000);
    expect(await made[0]!.events.joining(SENSOR)).toBe(true);
    await doer.idle();
    await doer.joinClose();
    expect(removed).toBe(true);
    expect(of(seen, "admitted", "left")).toEqual([["admitted", SENSOR, "association"]]);
    seen.length = 0;
    // The new device talks: nothing is tried on it.
    answer = async () => [Zdo.Status.SUCCESS, undefined];
    awake(made[0]!, 7);
    await settle();
    await doer.idle();
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`]);
    expect([of(seen, "left"), made[0]!.has(SENSOR)]).toEqual([[], true]);
    // A removal of the new device is a removal of its own: its Leave Request, and left.
    await doer.remove(SENSOR, false);
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`, `${SENSOR} ${LEAVE}`]);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("forgets hardware it removed: the next controller reports no second left", async () => {
    const { clock, doer, made, seen } = await started({ prepare: overModels, kept: [SENSOR, PUSHER] });
    await doer.idle();
    await doer.remove(SENSOR, false);
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(10_000);
    expect(made).toHaveLength(2);
    await doer.idle();
    expect(of(seen, "left")).toEqual([["left", SENSOR]]);
  });

  it("closes the removal's gate once herdsman's call ended, answered or not: a model kept from it opens nothing more", async () => {
    db = devices([SENSOR_ROW, PUSHER_ROW]);
    for (const [hw, force, a] of [[SENSOR, false, async () => [Zdo.Status.SUCCESS, undefined]], [PUSHER, false, async () => { throw silent(); }],
      [PUSHER, true, async () => [Zdo.Status.SUCCESS, undefined]]] as const) {
      answer = a;
      let gate: RemovalGate | undefined;
      await removeDevice(Device.byIeeeAddr(hw)!, force, (g) => { gate = g; }).catch(() => undefined);
      expect(gate?.closed, `${hw} ${force}`).toBe(true);
    }
    // Through the guard a closed gate is never reached: `removing` refuses (herdsman-sends.test.ts).
    expect(zdo).toEqual([`${SENSOR} ${LEAVE}`, `${PUSHER} ${LEAVE}`]);
  });

  it("removes nothing under the owner's switch: nothing sent", async () => {
    const { doer, made } = await started({ prepare: overModels, noActions: true });
    await expect(doer.remove(SENSOR, false)).rejects.toThrow(NO_ACTIONS);
    await expect(doer.remove(SENSOR, true)).rejects.toThrow(NO_ACTIONS);
    expect(zdo).toEqual([]);
    expect(made[0]!.has(SENSOR)).toBe(true);
  });
});
