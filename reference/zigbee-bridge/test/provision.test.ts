import { randomUUID } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import { afterEach, describe, expect, it } from "vitest";
import { JOIN_CAP_MS, ZigbeeBridge, type Mutation } from "../src/bridge.js";
import type { Description } from "../src/port.js";
import { FakeClock, FakeDoer, FakeWire, lamp, MemoryStore, settle } from "./fakes.js";

const ROOT = "home";
const BASE = `${ROOT}/bridges/zigbee`;
const HW = "0x00158d0001a2b3c4";
const ROUTER = "0x00158d0001a2b3d1";
const NEW = "0x00158d0001a2b3e7";

const bridges: ZigbeeBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
});

async function bridge(opts: { mutation?: Mutation; store?: MemoryStore; initial?: Description[] } = {}) {
  const clock = new FakeClock();
  const wire = new FakeWire();
  const doer = new FakeDoer(clock);
  doer.initial = opts.initial ?? [lamp(), lamp({ hardwareId: ROUTER, stableIdentifier: ROUTER, router: true })];
  const store = opts.store ?? new MemoryStore();
  const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store,
    ...(opts.mutation ? { runId: "run-1", mutation: opts.mutation } : {}) });
  bridges.push(b);
  await b.start();
  return { b, clock, wire, doer, store };
}

/** Sends a request and returns its reply. */
async function ask(wire: FakeWire, op: string, fields: Record<string, unknown> = {}, requestId = randomUUID()) {
  await wire.deliver(`${BASE}/request/${op}`, { requestId, issuedAt: new Date().toISOString(), ...fields });
  return wire.all(`${BASE}/reply`).map((r) => r.payload).filter((r) => r.requestId === requestId).at(-1);
}

const events = (wire: FakeWire, type: string) => wire.all(`${BASE}/event`).map((p) => p.payload).filter((e) => e.type === type);
const status = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload;
const join = (windowMs: number, more: Record<string, unknown> = {}) => ({ transport: "coordinator", windowMs, ...more });

describe("join windows (GA-BRIDGE-25, 26)", () => {
  it("claims Provision beside Serve", async () => {
    const { wire } = await bridge();
    expect(status(wire).levels).toEqual(["Serve", "Provision"]);
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
  });

  it("accepts a join, opens the window house-wide, and closes it at its time with every device that joined in it", async () => {
    const { wire, doer, clock } = await bridge();
    const reply = await ask(wire, "join", join(60_000));
    expect(reply).toMatchObject({ op: "join", status: "accepted" });
    expect(validate("bridge/reply.json", reply)).toEqual([]);
    expect(doer.windows).toEqual(["join 60000"]);
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    await clock.advance(59_999);
    expect(events(wire, "window_closed")).toEqual([]);
    await clock.advance(1);
    const [closed] = events(wire, "window_closed");
    expect(closed).toMatchObject({ type: "window_closed", transport: "coordinator", devices: [NEW], windowMs: 60_000 });
    expect(validate("bridge/event.json", closed)).toEqual([]);
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("holds a window to the cap of 254 s, and says so in window_closed", async () => {
    const { wire, doer, clock } = await bridge();
    await ask(wire, "join", join(300_000));
    expect(doer.windows).toEqual([`join ${JOIN_CAP_MS}`]);
    await clock.advance(JOIN_CAP_MS - 1);
    expect(events(wire, "window_closed")).toEqual([]);
    await clock.advance(1);
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [], windowMs: JOIN_CAP_MS }]);
  });

  it("closes the window at once on join_close, with its effective windowMs, and answers a second join_close ok with nothing more", async () => {
    const { wire, doer, clock } = await bridge();
    await ask(wire, "join", join(120_000));
    const reply = await ask(wire, "join_close", { transport: "coordinator" });
    expect(reply).toEqual({ requestId: reply.requestId, op: "join_close", status: "ok", data: {} });
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [], windowMs: 120_000 }]);
    expect(doer.windows).toEqual(["join 120000", "close"]);
    expect((await ask(wire, "join_close", { transport: "coordinator" })).status).toBe("ok");
    await clock.advance(120_000);
    expect(events(wire, "window_closed")).toHaveLength(1);
    expect(doer.windows).toEqual(["join 120000", "close"]);
  });

  it("answers a join while a window is open failed(busy), the open window untouched (GA-BRIDGE-4)", async () => {
    const { wire, doer, clock } = await bridge();
    await ask(wire, "join", join(60_000));
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    expect(await ask(wire, "join", join(30_000))).toMatchObject({ op: "join", status: "failed", reason: "busy" });
    expect(doer.windows).toEqual(["join 60000"]);
    expect(events(wire, "window_closed")).toEqual([]);
    await clock.advance(60_000);
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [NEW], windowMs: 60_000 }]);
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("gives two joins delivered together one window and one failed(busy), the window ended in one window_closed", async () => {
    const { wire, doer, clock } = await bridge();
    const [a, b] = [randomUUID(), randomUUID()];
    await Promise.all([a, b].map((requestId, i) =>
      wire.deliver(`${BASE}/request/join`, { requestId, issuedAt: new Date().toISOString(), ...join(i ? 30_000 : 60_000) })));
    const replies = wire.all(`${BASE}/reply`).map((r) => r.payload);
    expect(replies.map((r) => [r.requestId, r.status, r.reason])).toEqual([[a, "accepted", undefined], [b, "failed", "busy"]]);
    await clock.advance(300_000);
    expect(doer.windows).toEqual(["join 60000", "close"]);
    expect(events(wire, "window_closed")).toMatchObject([{ windowMs: 60_000 }]);
  });

  it("hands the doer a join_close and the join right after it in order, the join waiting for the close", async () => {
    const { wire, doer } = await bridge();
    await ask(wire, "join", join(60_000));
    let answer!: () => void;
    doer.closeHeld = new Promise((r) => { answer = r; });
    await ask(wire, "join_close", { transport: "coordinator" });
    expect((await ask(wire, "join", join(30_000))).status).toBe("accepted");
    expect(doer.windows).toEqual(["join 60000"]);
    answer();
    await settle();
    expect(doer.windows).toEqual(["join 60000", "close", "join 30000"]);
  });

  it("hands the doer a join_close only once the join before it settled", async () => {
    const { wire, doer } = await bridge();
    let answer!: () => void;
    doer.joinHeld = new Promise((r) => { answer = r; });
    await ask(wire, "join", join(60_000));
    expect((await ask(wire, "join_close", { transport: "coordinator" })).status).toBe("ok");
    expect(doer.windows).toEqual(["join 60000"]);
    answer();
    await settle();
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("names in window_closed only the devices that joined while it was open", async () => {
    const { wire, doer, clock } = await bridge();
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    await ask(wire, "join", join(10_000));
    await doer.admit(HW, "securedRejoin");
    await doer.admit(HW, "association");
    await clock.advance(10_000);
    const [closed] = events(wire, "window_closed");
    expect(closed.devices).toEqual([`${HW}-2`]);
  });

  it("opens the window at the router near names, and refuses a near that is no device or no router", async () => {
    const { wire, doer } = await bridge();
    expect((await ask(wire, "join", join(60_000, { near: ROUTER }))).status).toBe("accepted");
    expect(doer.windows).toEqual([`join 60000 ${ROUTER}`]);
    expect(await ask(wire, "join", join(60_000, { near: "nothing" }))).toMatchObject({ status: "failed", reason: "unknown_device" });
    expect((await ask(wire, "join", join(60_000, { near: HW }))).status).toBe("invalid_request");
    expect(doer.windows).toEqual([`join 60000 ${ROUTER}`]);
  });

  it("answers a join that does not fit invalid_request, and opens nothing", async () => {
    const { wire, doer } = await bridge();
    for (const fields of [join(60_000, { transport: "radio" }), join(0), join(1.5), { transport: "coordinator" }, join(60_000, { near: 7 })]) {
      expect((await ask(wire, "join", fields)).status).toBe("invalid_request");
    }
    expect((await ask(wire, "join_close", { transport: "radio" })).status).toBe("invalid_request");
    expect(doer.windows).toEqual([]);
  });

  it("refuses a join while the coordinator does not answer", async () => {
    const { wire, doer } = await bridge();
    await doer.transport("down", 10_000);
    expect(await ask(wire, "join", join(60_000))).toMatchObject({ status: "failed", reason: "unreachable" });
    expect(doer.windows).toEqual([]);
  });

  it("refuses provisioning failed(state_mismatch) while the store disagrees with the network, and closes an open window (GA-BRIDGE-12)", async () => {
    const { wire, doer } = await bridge();
    await ask(wire, "join", join(60_000));
    await doer.fault("state_mismatch", "the coordinator answers with another network");
    expect(events(wire, "window_closed")).toHaveLength(1);
    expect(await ask(wire, "join", join(60_000))).toMatchObject({ status: "failed", reason: "state_mismatch" });
    expect(await ask(wire, "join_close", { transport: "coordinator" })).toMatchObject({ status: "failed", reason: "state_mismatch" });
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("closes an open window when the store fails, and refuses a join until it is back, join_close still answered", async () => {
    const store = new MemoryStore();
    const { wire, doer } = await bridge({ store });
    await ask(wire, "join", join(60_000));
    store.down = true;
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW }));
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [], windowMs: 60_000 }]);
    expect(await ask(wire, "join", join(60_000))).toMatchObject({ status: "failed", reason: "store_fault" });
    expect((await ask(wire, "join_close", { transport: "coordinator" })).status).toBe("ok");
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("ends a window the doer could not open at once, with no device", async () => {
    const { wire, doer } = await bridge();
    doer.joinFails = new Error("no answer from the coordinator");
    expect((await ask(wire, "join", join(60_000))).status).toBe("accepted");
    await settle();
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [], windowMs: 60_000 }]);
  });

  it("closes an open window at a leave, its window_closed before the graceful offline and the doer's close before it stops (GA-BRIDGE-22)", async () => {
    const { b, wire, doer } = await bridge();
    await ask(wire, "join", join(60_000));
    bridges.splice(bridges.indexOf(b), 1);
    const mark = wire.calls.length;
    await b.stop();
    const after = wire.calls.slice(mark);
    const closed = after.indexOf(`publish ${BASE}/event`);
    const offline = after.lastIndexOf(`publish ${BASE}/status`);
    expect(closed).toBeGreaterThan(after.findIndex((c) => c.startsWith("unsubscribe")));
    expect(closed).toBeLessThan(offline);
    expect(events(wire, "window_closed")).toMatchObject([{ windowMs: 60_000 }]);
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("answers commission and connect invalid_request, Zigbee having neither, and a repeated requestId with the first reply", async () => {
    const { wire } = await bridge();
    expect((await ask(wire, "commission", { transport: "coordinator", code: "34970112332" })).status).toBe("invalid_request");
    expect((await ask(wire, "connect", { address: "192.0.2.7", keys: ["mac:00:11:22:33:44:55"] })).status).toBe("invalid_request");
    const id = randomUUID();
    await ask(wire, "join", join(60_000), id);
    await ask(wire, "join", join(60_000), id);
    expect(wire.all(`${BASE}/reply`).map((r) => r.payload).filter((r) => r.requestId === id).map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(events(wire, "window_closed")).toEqual([]);
  });
});

const ids = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices.map((d: { id: string }) => d.id);
const remove = (fields: Record<string, unknown>) => ({ blockRejoin: false, ...fields });

describe("removal and the blocklist (GA-BRIDGE-21, 27)", () => {
  it("accepts a remove, the doer removes the hardware, and left names its device, which leaves devices, its status cleared", async () => {
    const { wire, doer, store } = await bridge();
    await doer.observe(HW, { on: true });
    const reply = await ask(wire, "remove", remove({ device: HW }));
    expect(reply).toMatchObject({ op: "remove", status: "accepted" });
    expect(doer.removed).toEqual([HW]);
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    expect(ids(wire)).toEqual([ROUTER]);
    expect(wire.last(`${BASE}/devices/${HW}/status`)!.payload).toBe("");
    expect(store.device(HW)).toBeUndefined();
    expect(status(wire).blocked).toEqual([]);
  });

  it("removes by identifier, the hardware id, and passes force to the doer", async () => {
    const { wire, doer } = await bridge();
    expect((await ask(wire, "remove", remove({ identifier: HW, force: true }))).status).toBe("accepted");
    expect(doer.removed).toEqual([`${HW} force`]);
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
  });

  it("answers a remove of an id or identifier the bridge never had failed(unknown_device), and one that does not fit invalid_request", async () => {
    const { wire, doer } = await bridge();
    expect(await ask(wire, "remove", remove({ device: "nothing" }))).toMatchObject({ status: "failed", reason: "unknown_device" });
    expect(await ask(wire, "remove", remove({ identifier: "0x0000000000000000" }))).toMatchObject({ status: "failed", reason: "unknown_device" });
    for (const fields of [{ blockRejoin: false }, { device: HW }, remove({ device: HW, identifier: HW }), remove({ device: HW, force: "yes" })]) {
      expect((await ask(wire, "remove", fields)).status).toBe("invalid_request");
    }
    expect(doer.removed).toEqual([]);
  });

  it("answers a remove of hardware already gone accepted, and left names it, each time, the doer asked for nothing", async () => {
    const { wire, doer } = await bridge();
    await doer.leave(HW);
    for (const fields of [{ device: HW }, { identifier: HW }, { device: HW }]) {
      expect((await ask(wire, "remove", remove(fields))).status).toBe("accepted");
    }
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW, HW, HW, HW]);
    expect(doer.removed).toEqual([]);
  });

  it("removes only the hardware's device now: an id of an earlier admission is already gone, the new device untouched", async () => {
    const { wire, doer } = await bridge();
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    expect(ids(wire)).toEqual([`${HW}-2`, ROUTER]);
    expect((await ask(wire, "remove", remove({ device: HW }))).status).toBe("accepted");
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW]);
    expect(doer.removed).toEqual([]);
    expect(ids(wire)).toEqual([`${HW}-2`, ROUTER]);
  });

  it("ends a remove in left even when the doer reports none, once", async () => {
    const { wire, doer } = await bridge();
    doer.removeReportsLeft = false;
    await ask(wire, "remove", remove({ device: HW }));
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    expect(ids(wire)).toEqual([ROUTER]);
  });

  it("lets a second remove of hardware being removed wait for the first, one left ending both, unless it adds force", async () => {
    const { wire, doer } = await bridge();
    let answer!: () => void;
    doer.removeHeld = new Promise((r) => { answer = r; });
    await ask(wire, "remove", remove({ device: HW }));
    await ask(wire, "remove", remove({ device: HW }));
    expect(doer.removed).toEqual([HW]);
    expect(events(wire, "left")).toEqual([]);
    expect(ids(wire)).toEqual([HW, ROUTER]);
    await ask(wire, "remove", remove({ device: HW, force: true }));
    expect(doer.removed).toEqual([HW, `${HW} force`]);
    answer();
    await settle();
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
  });

  it("ends a removal the doer resolves after the hardware was admitted anew: left names the old id, and a removal of the new device runs", async () => {
    const { wire, doer } = await bridge();
    let answer!: () => void;
    doer.removeHeld = new Promise((r) => { answer = r; });
    doer.removeReportsLeft = false;
    await ask(wire, "remove", remove({ device: HW }));
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    expect(ids(wire)).toEqual([`${HW}-2`, ROUTER]);
    // The herdsman doer ends the removal still waiting, with no left of its own (plan 3b review I1).
    answer();
    await settle();
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW]);
    expect(ids(wire)).toEqual([`${HW}-2`, ROUTER]);
    doer.removeHeld = undefined;
    doer.removeReportsLeft = true;
    expect((await ask(wire, "remove", remove({ device: `${HW}-2` }))).status).toBe("accepted");
    expect(doer.removed).toEqual([HW, HW]);
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW, `${HW}-2`]);
  });

  it("blocks the identifier before the reply, lists it in status, and turns its rejoin away with blocked_rejoin and no admission", async () => {
    const { wire, doer, store } = await bridge();
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    const writes = store.writes.slice(-2);
    expect(writes).toEqual([`block ${HW}`, `remove ${HW}`]);
    expect(status(wire).blocked).toEqual([HW]);
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    await ask(wire, "join", join(60_000));
    expect(await doer.mayAdmit(HW)).toBe(false);
    expect(await doer.mayAdmit(NEW)).toBe(true);
    const [blocked] = events(wire, "blocked_rejoin");
    expect(blocked).toMatchObject({ type: "blocked_rejoin", identifier: HW });
    expect(validate("bridge/event.json", blocked)).toEqual([]);
    expect(events(wire, "joined")).toEqual([]);
  });

  it("takes an identifier off the blocklist on unblock, ok whether it was on it or not, and lets it in again", async () => {
    const { wire, doer } = await bridge();
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    for (let i = 0; i < 2; i++) {
      const reply = await ask(wire, "unblock", { identifier: HW });
      expect(reply).toEqual({ requestId: reply.requestId, op: "unblock", status: "ok", data: {} });
    }
    expect(status(wire).blocked).toEqual([]);
    expect(await doer.mayAdmit(HW)).toBe(true);
    expect((await ask(wire, "unblock", {})).status).toBe("invalid_request");
  });

  it("keeps the blocklist across a restart (GA-BRIDGE-31)", async () => {
    const store = new MemoryStore();
    const first = await bridge({ store });
    await ask(first.wire, "remove", remove({ device: HW, blockRejoin: true }));
    await first.b.stop();
    bridges.splice(bridges.indexOf(first.b), 1);
    const { wire, doer } = await bridge({ store });
    expect(status(wire).blocked).toEqual([HW]);
    expect(await doer.mayAdmit(HW)).toBe(false);
  });

  it("refuses remove and unblock failed(store_fault) while the store is away, failed(state_mismatch) on a mismatch, and blocks nothing", async () => {
    const store = new MemoryStore();
    const { wire, doer } = await bridge({ store });
    store.down = true;
    expect(await ask(wire, "remove", remove({ device: HW, blockRejoin: true }))).toMatchObject({ status: "failed", reason: "store_fault" });
    expect(await ask(wire, "remove", remove({ device: HW }))).toMatchObject({ status: "failed", reason: "store_fault" });
    expect(await ask(wire, "unblock", { identifier: HW })).toMatchObject({ status: "failed", reason: "store_fault" });
    store.down = false;
    await doer.fault("state_mismatch", "the coordinator answers with another network");
    expect(await ask(wire, "remove", remove({ device: HW }))).toMatchObject({ status: "failed", reason: "state_mismatch" });
    expect(await ask(wire, "unblock", { identifier: HW })).toMatchObject({ status: "failed", reason: "state_mismatch" });
    expect(doer.removed).toEqual([]);
    expect(status(wire).blocked).toEqual([]);
  });

  it("does not take a description whose stableIdentifier is not its hardware id", async () => {
    const { wire, doer } = await bridge();
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: "another" }));
    expect(ids(wire)).toEqual([HW, ROUTER]);
    expect(status(wire).faults).toEqual([{ code: "invalid_description", detail: `${NEW}: stableIdentifier is not the hardware id` }]);
  });
});

describe("what plan 3a's review found", () => {
  it("removes the hardware's device now too when a remove with blockRejoin names an earlier id, left naming each id (GA-BRIDGE-27)", async () => {
    const { wire, doer } = await bridge();
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    expect(ids(wire)).toEqual([`${HW}-2`, ROUTER]);
    expect((await ask(wire, "remove", remove({ device: HW, blockRejoin: true }))).status).toBe("accepted");
    await settle();
    expect(status(wire).blocked).toEqual([HW]);
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW, `${HW}-2`]);
    expect(doer.removed).toEqual([HW]);
    expect(ids(wire)).toEqual([ROUTER]);
  });

  it("starts again at its start the removal of blocked hardware it still has, which a restart cut off (GA-BRIDGE-27)", async () => {
    const store = new MemoryStore();
    const first = await bridge({ store });
    first.doer.removeHeld = new Promise(() => {});
    expect((await ask(first.wire, "remove", remove({ device: HW, blockRejoin: true }))).status).toBe("accepted");
    await first.b.stop();
    bridges.splice(bridges.indexOf(first.b), 1);
    const { wire, doer } = await bridge({ store });
    await settle();
    expect(status(wire).blocked).toEqual([HW]);
    expect(doer.removed).toEqual([HW]);
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    expect(ids(wire)).toEqual([ROUTER]);
  });

  it("claims Serve alone, and answers the Provision ops invalid_request, over a doer that does not provision", async () => {
    const clock = new FakeClock();
    const wire = new FakeWire();
    const doer = new FakeDoer(clock);
    doer.initial = [lamp()];
    doer.provisions = false;
    const b = new ZigbeeBridge({ bridgeId: "zigbee", instanceId: randomUUID(), root: ROOT, clock, doer, wire, store: new MemoryStore() });
    bridges.push(b);
    await b.start();
    expect(status(wire).levels).toEqual(["Serve"]);
    for (const [op, fields] of [["join", join(60_000)], ["join_close", { transport: "coordinator" }],
      ["remove", remove({ device: HW })], ["unblock", { identifier: HW }]] as const) {
      expect((await ask(wire, op, fields)).status).toBe("invalid_request");
    }
    expect([doer.windows, doer.removed]).toEqual([[], []]);
  });

  it("keeps a removal the doer rejected pending, named in a fault, until a remove with force ends it", async () => {
    const { wire, doer } = await bridge();
    doer.removeFails = new Error("the coordinator refused the leave");
    expect((await ask(wire, "remove", remove({ device: HW }))).status).toBe("accepted");
    await settle();
    expect(events(wire, "left")).toEqual([]);
    expect(ids(wire)).toEqual([HW, ROUTER]);
    expect(status(wire).faults).toEqual([{ code: "remove_refused", device: HW, detail: "the coordinator refused the leave" }]);
    expect(validate("bridge/status.json", status(wire))).toEqual([]);
    await ask(wire, "remove", remove({ device: HW }));
    expect(doer.removed).toEqual([HW]);
    await ask(wire, "remove", remove({ device: HW, force: true }));
    await settle();
    expect(doer.removed).toEqual([HW, `${HW} force`]);
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    expect(ids(wire)).toEqual([ROUTER]);
    expect(status(wire).faults).toEqual([]);
  });

  it("ends a refused removal when the device leaves on its own, its fault cleared, and removes its next admission anew", async () => {
    const { wire, doer } = await bridge();
    doer.removeFails = new Error("the coordinator refused the leave");
    await ask(wire, "remove", remove({ device: HW }));
    await settle();
    expect(status(wire).faults).toMatchObject([{ code: "remove_refused", device: HW }]);
    await doer.leave(HW);
    expect(status(wire).faults).toEqual([]);
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    doer.removeFails = undefined;
    await doer.admit(HW, "association");
    await doer.describe(lamp());
    expect((await ask(wire, "remove", remove({ device: `${HW}-2` }))).status).toBe("accepted");
    await settle();
    expect(doer.removed).toEqual([HW, HW]);
    expect(events(wire, "left").map((e) => e.device)).toEqual([HW, `${HW}-2`]);
  });

  it("names no fault for a rejection that comes after a forced removal ended the device", async () => {
    const { wire, doer } = await bridge();
    let answer!: () => void;
    doer.removeHeld = new Promise((r) => { answer = r; });
    await ask(wire, "remove", remove({ device: HW }));
    await ask(wire, "remove", remove({ device: HW, force: true }));
    expect(events(wire, "left")).toMatchObject([{ device: HW }]);
    doer.removeFails = new Error("the device was gone already");
    answer();
    await settle();
    expect(status(wire).faults).toEqual([]);
    expect(events(wire, "left")).toHaveLength(1);
  });

  it("turns blocked hardware a doer brings in without asking away: blocked_rejoin, removed, never admitted", async () => {
    const { wire, doer, clock } = await bridge();
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    await ask(wire, "join", join(10_000));
    await doer.describe(lamp());
    await doer.admit(HW, "association");
    await clock.advance(10_000);
    expect(status(wire).blocked).toEqual([HW]);
    expect(events(wire, "joined")).toEqual([]);
    expect(events(wire, "blocked_rejoin")).toMatchObject([{ identifier: HW }, { identifier: HW }]);
    expect(events(wire, "window_closed")).toMatchObject([{ devices: [] }]);
    expect(doer.removed).toEqual([HW, HW, HW]);
    expect(ids(wire)).toEqual([ROUTER]);
  });

  it("writes an unblock to the store", async () => {
    const { wire, store } = await bridge();
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    expect(store.blocked().map((b) => b.hardwareId)).toEqual([HW]);
    await ask(wire, "unblock", { identifier: HW });
    expect(store.blocked()).toEqual([]);
  });

  it("removes by its id hardware admitted and waiting for its description", async () => {
    const { wire, doer } = await bridge();
    await doer.admit(NEW, "association");
    expect((await ask(wire, "remove", remove({ device: NEW }))).status).toBe("accepted");
    expect(doer.removed).toEqual([NEW]);
    expect(events(wire, "left")).toMatchObject([{ device: NEW }]);
  });

  it("lists blocked hardware in a status at once, while its removal waits for the device", async () => {
    const { wire, doer } = await bridge();
    doer.removeHeld = new Promise(() => {});
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    expect(events(wire, "left")).toEqual([]);
    expect(status(wire).blocked).toEqual([HW]);
  });

  it("waits for the doer's close of an open window before the doer stops", async () => {
    const { b, wire, doer } = await bridge();
    await ask(wire, "join", join(60_000));
    doer.closeHeld = new Promise((r) => setTimeout(r, 20));
    bridges.splice(bridges.indexOf(b), 1);
    await b.stop();
    expect(doer.windows).toEqual(["join 60000", "close"]);
  });

  it("does not take a description whose router is no boolean", async () => {
    const { wire, doer } = await bridge();
    await doer.describe(lamp({ hardwareId: NEW, stableIdentifier: NEW, router: "yes" as unknown as boolean }));
    expect(ids(wire)).toEqual([HW, ROUTER]);
    expect(status(wire).faults).toEqual([{ code: "invalid_description", detail: `${NEW}: router is no boolean` }]);
  });
});

describe("interviews", () => {
  it("names an interviewed device in an interviewed event, and nothing for hardware with no id", async () => {
    const { wire, doer } = await bridge();
    doer.events!.interviewed(HW);
    doer.events!.interviewed(NEW);
    await settle();
    const [interviewed, ...more] = events(wire, "interviewed");
    expect([interviewed, more]).toMatchObject([{ type: "interviewed", device: HW }, []]);
    expect(validate("bridge/event.json", interviewed)).toEqual([]);
  });
});

describe("Provision's mutations", () => {
  it("window-never-closes: the window outlives its time, and closes only on join_close", async () => {
    const { wire, clock } = await bridge({ mutation: "window-never-closes" });
    await ask(wire, "join", join(60_000));
    await clock.advance(JOIN_CAP_MS * 2);
    expect(events(wire, "window_closed")).toEqual([]);
    await ask(wire, "join_close", { transport: "coordinator" });
    expect(events(wire, "window_closed")).toHaveLength(1);
  });

  it("ignores-near: a join near a router opens the window everywhere", async () => {
    const { wire, doer } = await bridge({ mutation: "ignores-near" });
    expect((await ask(wire, "join", join(30_000, { near: ROUTER }))).status).toBe("accepted");
    expect(doer.windows).toEqual(["join 30000"]);
  });

  it("forgets-the-blocklist: blocked hardware is kept out only while a window is open", async () => {
    const { wire, doer } = await bridge({ mutation: "forgets-the-blocklist" });
    await ask(wire, "remove", remove({ device: HW, blockRejoin: true }));
    expect(status(wire).blocked).toEqual([HW]);
    expect(await doer.mayAdmit(HW)).toBe(true);
    await ask(wire, "join", join(60_000));
    expect(await doer.mayAdmit(HW)).toBe(false);
  });

  it("provisions-the-wrong-way: commission on the Zigbee transport is accepted", async () => {
    const { wire } = await bridge({ mutation: "provisions-the-wrong-way" });
    expect((await ask(wire, "commission", { transport: "coordinator", code: "34970112332" })).status).toBe("accepted");
    const { wire: plain } = await bridge();
    expect((await ask(plain, "commission", { transport: "coordinator", code: "34970112332" })).status).toBe("invalid_request");
  });

  it("forgets-on-restart: a restart drops the blocklist", async () => {
    const store = new MemoryStore();
    const first = await bridge({ store, mutation: "forgets-on-restart" });
    await ask(first.wire, "remove", remove({ device: HW, blockRejoin: true }));
    await first.b.stop();
    bridges.splice(bridges.indexOf(first.b), 1);
    const { wire, doer } = await bridge({ store, mutation: "forgets-on-restart" });
    expect(status(wire).blocked).toEqual([]);
    expect(await doer.mayAdmit(HW)).toBe(true);
  });
});
