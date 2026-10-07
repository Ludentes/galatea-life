import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Zdo } from "zigbee-herdsman";
import { Adapter } from "zigbee-herdsman/dist/adapter/index.js";
import Database from "zigbee-herdsman/dist/controller/database.js";
import { Entity } from "zigbee-herdsman/dist/controller/model/entity.js";
import type { Network } from "../src/herdsman/network.js";
import { HerdsmanStack, type StackEvents } from "../src/herdsman/stack.js";

/** A made-up network and devices: no bench's. */
const NETWORK: Network = {
  panID: 0x1a2b, extendedPanID: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], channel: 15,
  networkKey: [0x3a, 0x91, 0x07, 0xc4, 0x5e, 0x22, 0xf0, 0x18, 0x6b, 0xd9, 0x40, 0xa7, 0x13, 0x8e, 0x55, 0xec],
  coordinator: "0x00124b0012345678",
};
const SENSOR = "0xa4c1380000000001";
const STRANGER = "0xa4c1380000000002";

/** herdsman's controller, past its types: what a started one holds. */
type Internals = { adapter?: unknown; database?: unknown; adapterDisconnected: boolean; options: { acceptJoiningDeviceHandler(ieee: string): Promise<boolean> } };

let dir: string;
let seen: unknown[][];
let stack: HerdsmanStack;
const inside = () => stack.controller as unknown as Internals;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zigbee-stack-"));
  seen = [];
  const on = (name: string) => (...args: unknown[]) => { seen.push([name, ...args]); };
  const events: StackEvents = {
    joining: async (ieee) => { seen.push(["joining", ieee]); return ieee !== STRANGER; },
    joined: on("joined"), interviewed: on("interviewed"), left: on("left"), heard: on("heard"), disconnected: on("disconnected"),
  };
  stack = new HerdsmanStack({ coordinator: "tcp://127.0.0.1:1", dataDir: dir, network: NETWORK }, events);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** An adapter that records what the controller asks of it; a ZDO request answers as `zdo` says. */
function adapter(zdo: () => Promise<unknown> = async () => [Zdo.Status.SUCCESS, {}]) {
  const a = { hasZdoMessageOverhead: false, removeAllListeners: vi.fn(), stop: vi.fn(async () => {}), sendZdo: vi.fn(zdo),
    znp: { socketPort: { destroy: vi.fn() } } };
  inside().adapter = a;
  return a;
}

describe("HerdsmanStack", () => {
  it("tells the doer what herdsman says", () => {
    stack.controller.emit("deviceJoined", { device: { ieeeAddr: SENSOR } } as never);
    stack.controller.emit("deviceInterview", { status: "started", device: { ieeeAddr: SENSOR } } as never);
    stack.controller.emit("deviceInterview", { status: "successful", device: { ieeeAddr: SENSOR } } as never);
    stack.controller.emit("deviceInterview", { status: "failed", device: { ieeeAddr: SENSOR } } as never);
    stack.controller.emit("message", { device: { ieeeAddr: SENSOR } } as never);
    stack.controller.emit("deviceLeave", { ieeeAddr: SENSOR });
    stack.controller.emit("adapterDisconnected");
    expect(seen).toEqual([["joined", SENSOR], ["interviewed", SENSOR, "started"], ["interviewed", SENSOR, "successful"], ["interviewed", SENSOR, "failed"], ["heard", SENSOR],
      ["left", SENSOR], ["disconnected"]]);
  });

  it("hands the doer a message itself after `heard`, and a device's announce", () => {
    const got: unknown[][] = [];
    const s = new HerdsmanStack({ coordinator: "tcp://127.0.0.1:1", dataDir: dir, network: NETWORK }, {
      joining: async () => true, joined() {}, interviewed() {}, left() {}, disconnected() {},
      heard: (ieee) => got.push(["heard", ieee]), message: (m) => got.push(["message", m.type]), announced: (ieee) => got.push(["announced", ieee]) });
    s.controller.emit("message", { type: "attributeReport", device: { ieeeAddr: SENSOR } } as never);
    s.controller.emit("deviceAnnounce", { device: { ieeeAddr: SENSOR } } as never);
    expect(got).toEqual([["heard", SENSOR], ["message", "attributeReport"], ["announced", SENSOR]]);
    expect(s.device(SENSOR)).toBeUndefined();
  });

  it("knows herdsman's devices as soon as its start opens the database, before the start is done", async () => {
    // herdsman's start opens and injects its database first, then wires the join handler, and resolves
    // only after a backup and the coordinator's address: a rejoin can come in between (plan 2b review I1).
    await writeFile(join(dir, "database.db"), `${JSON.stringify({ id: 1, type: "EndDevice", ieeeAddr: SENSOR, nwkAddr: 4660,
      endpoints: {}, interviewState: "SUCCESSFUL", meta: {} })}\n`);
    expect(stack.has(SENSOR)).toBe(false);
    const database = Database.open(join(dir, "database.db"));
    Entity.injectDatabase(database);
    inside().database = database;
    expect(stack.has(SENSOR)).toBe(true);
    expect(stack.has(STRANGER)).toBe(false);
    adapter();
    await stack.close();
    expect(stack.has(SENSOR)).toBe(false);
  });

  it("asks the doer before herdsman lets hardware in", async () => {
    expect(await inside().options.acceptJoiningDeviceHandler(SENSOR)).toBe(true);
    expect(await inside().options.acceptJoiningDeviceHandler(STRANGER)).toBe(false);
    expect(seen).toEqual([["joining", SENSOR], ["joining", STRANGER]]);
  });

  it("closes a started controller without a frame: no permit-join, no backup, the adapter closed and its socket destroyed", async () => {
    const a = adapter();
    // A started controller's database, as its start opens and injects it.
    const database = Database.open(join(dir, "database.db"));
    Entity.injectDatabase(database);
    inside().database = database;
    const write = vi.spyOn(database, "write");
    inside().adapterDisconnected = false;
    const permitJoin = vi.spyOn(stack.controller, "permitJoin");
    const backup = vi.spyOn(stack.controller, "backup");
    await stack.close();
    expect(permitJoin).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(a.sendZdo).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(a.stop).toHaveBeenCalledOnce();
    expect(a.znp.socketPort.destroy).toHaveBeenCalledOnce();
  });

  it("redacts herdsman's words in its error lines: a failed backup, a failed stop, a failed adapter close (re-review N4)", async () => {
    const KEY_HEX = "3a9107c45e22f0186bd940a7138e55ec";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      vi.spyOn(stack.controller, "backup").mockRejectedValue(new Error(`backup: ${KEY_HEX}`));
      expect(await stack.backup()).toBe(false);
      vi.spyOn(stack.controller, "stop").mockRejectedValue(new Error(`stop: ${KEY_HEX}`));
      const a = adapter();
      a.stop.mockRejectedValue(new Error(`adapter: ${KEY_HEX}`));
      await stack.close();
      expect(lines.filter((l) => l.startsWith("herdsman: "))).toHaveLength(3);
      expect(lines.join("\n")).not.toContain(KEY_HEX);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes a controller that never started", async () => {
    await expect(stack.close()).resolves.toBeUndefined();
  });

  it("aborts a start under way when it closes", async () => {
    vi.spyOn(stack.controller, "start").mockImplementation((signal) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const starting = stack.start();
    await stack.close();
    await expect(starting).rejects.toThrow("aborted");
  });

  it("pings the coordinator itself with a ZDO Node Descriptor request: true only on its SUCCESS within the time", async () => {
    const a = adapter();
    expect(await stack.ping(1_000)).toBe(true);
    expect(a.sendZdo).toHaveBeenCalledWith(NETWORK.coordinator, 0, Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST, expect.any(Buffer), false);
    adapter(async () => [Zdo.Status.NOT_SUPPORTED, undefined]);
    expect(await stack.ping(1_000)).toBe(false);
    adapter(async () => { throw new Error("timeout"); });
    expect(await stack.ping(1_000)).toBe(false);
    adapter(() => new Promise(() => {}));
    expect(await stack.ping(50)).toBe(false);
  });

  it("has no devices before it started", () => {
    expect(stack.has(SENSOR)).toBe(false);
    expect(stack.devices()).toEqual([]);
  });
});

describe("HerdsmanStack over herdsman's own start, its adapter stubbed", () => {
  const NEWER = "0xa4c1380000000007";
  const record = (ieee: string, id: number, type = "Router") =>
    JSON.stringify({ id, type, ieeeAddr: ieee, nwkAddr: 4660 + id, endpoints: {}, interviewState: "SUCCESSFUL", meta: {} });
  const databaseOf = (...ieees: string[]) =>
    `${[record(NETWORK.coordinator, 1, "Coordinator"), ...ieees.map((ieee, i) => record(ieee, i + 2))].join("\n")}\n`;
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  type Stub = EventEmitter & { sent: number; zdo: number[]; permits: [number, number | undefined][]; gp: string[] };
  let gates: { backup?: ReturnType<typeof gate>; ieee?: ReturnType<typeof gate> };
  let adapters: Stub[];

  beforeEach(() => {
    gates = {};
    adapters = [];
    vi.spyOn(Adapter, "create").mockImplementation(async () => {
      const a = Object.assign(new EventEmitter(), {
        hasZdoMessageOverhead: false, manufacturerID: 0, sent: 0, zdo: [] as number[], permits: [] as [number, number | undefined][],
        gp: [] as string[],
        start: async () => "resumed",
        getNetworkParameters: async () => ({ channel: 15, nwkUpdateID: 0, panID: NETWORK.panID, extendedPanID: "0x123456789abcdef0" }),
        supportsBackup: async () => { await gates.backup?.p; return false; },
        getCoordinatorIEEE: async () => { await gates.ieee?.p; return NETWORK.coordinator; },
        sendZdo: async (_ieee: string, _nwk: number, clusterId: number) => { a.sent += 1; a.zdo.push(clusterId); return [Zdo.Status.SUCCESS]; },
        permitJoin: async (seconds: number, nwk?: number) => { a.permits.push([seconds, nwk]); },
        // Green Power's commissioning mode, which herdsman sends with every permit: broadcast, or to the router.
        sendZclFrameToAll: async () => { a.gp.push("all"); },
        sendZclFrameToEndpoint: async (ieee: string) => { a.gp.push(ieee); },
        stop: async () => {},
      });
      adapters.push(a);
      return a as never;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("lets a device its database has rejoin while its start waits on its first backup, and asks for any other (review I1)", async () => {
    await writeFile(join(dir, "database.db"), databaseOf(SENSOR));
    gates.backup = gate();
    const starting = stack.start();
    await vi.waitFor(() => expect(adapters).toHaveLength(1));
    await vi.waitFor(() => expect(adapters[0]!.listenerCount("deviceJoined")).toBe(1));
    adapters[0]!.emit("deviceJoined", { ieeeAddr: SENSOR, networkAddress: 4662 });
    adapters[0]!.emit("deviceJoined", { ieeeAddr: STRANGER, networkAddress: 4700 });
    await vi.waitFor(() => expect(seen.filter((e) => e[0] === "joining")).toHaveLength(2));
    expect(seen.filter((e) => e[0] === "joining")).toEqual([["joining", SENSOR], ["joining", STRANGER]]);
    expect(stack.has(SENSOR)).toBe(true);
    gates.backup.open();
    await starting;
    adapters[0]!.removeAllListeners();
    await stack.close();
  });

  it("gives the coordinator's endpoint only once its start is done, and none after its close (plan 2c-3 review M5)", async () => {
    await writeFile(join(dir, "database.db"), `${JSON.stringify({ id: 1, type: "Coordinator", ieeeAddr: NETWORK.coordinator, nwkAddr: 0,
      epList: [1], endpoints: { 1: { profId: 260, epId: 1, devId: 5, inClusterList: [], outClusterList: [], clusters: {}, binds: [],
        configuredReportings: [], meta: {} } }, interviewState: "SUCCESSFUL", meta: {} })}\n`);
    gates.backup = gate();
    const starting = stack.start();
    await vi.waitFor(() => expect(adapters[0]?.listenerCount("deviceJoined")).toBe(1));
    expect(stack.has(NETWORK.coordinator)).toBe(true);
    expect(stack.coordinatorEndpoint()).toBeUndefined();
    gates.backup.open();
    await starting;
    expect(stack.coordinatorEndpoint()?.ID).toBe(1);
    adapters[0]!.removeAllListeners();
    await stack.close();
    expect(stack.coordinatorEndpoint()).toBeUndefined();
  });

  it("leaves nothing behind when a start it closed finishes anyway: no timers, no devices for the next stack (re-review N6)", async () => {
    await writeFile(join(dir, "database.db"), databaseOf(SENSOR));
    await writeFile(join(dir, "coordinator_backup.json"), "{}");
    gates.ieee = gate();
    const starting = stack.start().catch(() => undefined);
    await vi.waitFor(() => expect(adapters[0]?.listenerCount("deviceJoined")).toBe(1));
    await stack.close();
    // The next stack's database: the sensor gone, another device added.
    await writeFile(join(dir, "database.db"), databaseOf(NEWER));
    gates.ieee.open();
    await starting;
    const old = stack.controller as unknown as { backupTimer?: NodeJS.Timeout; databaseSaveTimer?: NodeJS.Timeout };
    // A cleared interval is destroyed: it never runs again.
    expect(old.backupTimer === undefined || (old.backupTimer as unknown as { _destroyed: boolean })._destroyed).toBe(true);
    expect(old.databaseSaveTimer === undefined || (old.databaseSaveTimer as unknown as { _destroyed: boolean })._destroyed).toBe(true);
    gates = {};
    const next = new HerdsmanStack({ coordinator: "tcp://127.0.0.1:1", dataDir: dir, network: NETWORK },
      { joining: async () => true, joined() {}, interviewed() {}, left() {}, heard() {}, disconnected() {} });
    expect(await next.start()).toBe("resumed");
    expect(next.has(SENSOR)).toBe(false);
    expect(next.has(NEWER)).toBe(true);
    await next.close();
  });

  /** A started stack whose database has the sensor (a router here) and NEWER, an end device. */
  async function startedWithRouter(): Promise<Stub> {
    await writeFile(join(dir, "database.db"), `${[record(NETWORK.coordinator, 1, "Coordinator"), record(SENSOR, 2), record(NEWER, 3, "EndDevice")]
      .join("\n")}\n`);
    expect(await stack.start()).toBe("resumed");
    return adapters[0]!;
  }

  it("opens herdsman's permit house-wide, or at a router it has alone, and closes it house-wide (plan 3b)", async () => {
    const a = await startedWithRouter();
    await stack.permitJoin(60);
    expect(stack.controller.getPermitJoin()).toBe(true);
    await stack.permitJoin(30, SENSOR);
    await stack.permitJoin(0);
    expect(stack.controller.getPermitJoin()).toBe(false);
    expect(a.permits).toEqual([[60, undefined], [30, 4662], [0, undefined]]);
    expect(a.gp).toEqual(["all", SENSOR, "all"]);
    a.removeAllListeners();
    await stack.close();
  });

  it("opens no permit at an end device, at hardware herdsman does not have, or with no controller started", async () => {
    const a = await startedWithRouter();
    await expect(stack.permitJoin(60, NEWER)).rejects.toThrow(`${NEWER} is no router herdsman has`);
    await expect(stack.permitJoin(60, STRANGER)).rejects.toThrow(`${STRANGER} is no router herdsman has`);
    a.removeAllListeners();
    await stack.close();
    await expect(stack.permitJoin(60)).rejects.toThrow("no controller is started");
    expect(a.permits).toEqual([]);
  });

  it("clears herdsman's own permit timer at its close: a closed controller raises nothing later", async () => {
    const a = await startedWithRouter();
    await stack.permitJoin(200);
    a.removeAllListeners();
    await stack.close();
    const c = stack.controller as unknown as { permitJoinTimer?: NodeJS.Timeout };
    expect(c.permitJoinTimer === undefined || (c.permitJoinTimer as unknown as { _destroyed: boolean })._destroyed).toBe(true);
    // The close sent no permit of its own.
    expect(a.permits).toEqual([[200, undefined]]);
  });

  it("refused, herdsman sends one Leave Request and changes nothing; let in, hardware it has raises no joined and no interview (spike S7)", async () => {
    const a = await startedWithRouter();
    const before = a.zdo.length;
    a.emit("deviceJoined", { ieeeAddr: STRANGER, networkAddress: 4700 });
    a.emit("deviceJoined", { ieeeAddr: SENSOR, networkAddress: 4800 });
    await vi.waitFor(() => expect(seen.filter((e) => e[0] === "joining")).toHaveLength(2));
    await vi.waitFor(() => expect(a.zdo.slice(before)).toEqual([Zdo.ClusterId.LEAVE_REQUEST]));
    await new Promise((r) => setTimeout(r, 20));
    expect(stack.has(STRANGER)).toBe(false);
    expect(stack.device(SENSOR)!.networkAddress).toBe(4800);
    expect(seen.filter((e) => e[0] === "joined" || e[0] === "interviewed")).toEqual([]);
    a.removeAllListeners();
    await stack.close();
  });
});

describe("HerdsmanStack: herdsman's own daily backup off (plan 2c-3)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("clears herdsman's daily backup timer once its start is done: the doer takes its own", async () => {
    vi.spyOn(Adapter, "create").mockImplementation(async () => Object.assign(new EventEmitter(), {
      hasZdoMessageOverhead: false, manufacturerID: 0,
      start: async () => "resumed",
      getNetworkParameters: async () => ({ channel: 15, nwkUpdateID: 0, panID: NETWORK.panID, extendedPanID: "0x123456789abcdef0" }),
      supportsBackup: async () => false,
      getCoordinatorIEEE: async () => NETWORK.coordinator,
      sendZdo: async () => [Zdo.Status.SUCCESS],
      stop: async () => {},
    }) as never);
    await writeFile(join(dir, "database.db"), `${JSON.stringify({ id: 1, type: "Coordinator", ieeeAddr: NETWORK.coordinator, nwkAddr: 0,
      endpoints: {}, interviewState: "SUCCESSFUL", meta: {} })}\n`);
    await writeFile(join(dir, "coordinator_backup.json"), "{}");
    expect(await stack.start()).toBe("resumed");
    const c = stack.controller as unknown as { backupTimer?: NodeJS.Timeout; databaseSaveTimer?: NodeJS.Timeout };
    expect((c.backupTimer as unknown as { _destroyed: boolean })._destroyed).toBe(true);
    // herdsman's database save stays: it is herdsman's own, and sends nothing.
    expect((c.databaseSaveTimer as unknown as { _destroyed: boolean })._destroyed).toBe(false);
    await stack.close();
  });
});
