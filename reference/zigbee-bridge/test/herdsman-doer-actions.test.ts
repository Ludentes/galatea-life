import { afterEach, describe as group, expect, it, type MockInstance, vi } from "vitest";
import { Zcl } from "zigbee-herdsman";
import { NAMESPACE } from "../src/herdsman/describe.js";
import { POLL_MS } from "../src/herdsman/polling.js";
import { namedArgs } from "../src/vocabulary.js";
import { HerdsmanDoer, PIN_WITHHELD } from "../src/herdsman/doer.js";
import type { Message } from "../src/herdsman/pipeline.js";
import type { Description } from "../src/port.js";
import { FakeClock, settle } from "./fakes.js";
import { core, type FakeStack, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { defaultResponse, reply, responseTimeout, stubAdapter } from "./zigbee-adapter.js";
import { datapoints, devices, LOCK, LOCK_ROW, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW, withAttributes } from "./zigbee-devices.js";

/**
 * The herdsman doer carries actions out (plan 2c-2): the core's execute and read reach herdsman's own
 * endpoints through the converters, over a stubbed adapter; the owner's PIN never reaches a lock.
 */

let db: ReturnType<typeof devices> | undefined;
let stub: ReturnType<typeof stubAdapter> | undefined;
let errors: MockInstance | undefined;
const doers: HerdsmanDoer[] = [];
afterEach(async () => {
  for (const d of doers.splice(0)) await d.stop();
  stub?.restore();
  db?.close();
  errors?.mockRestore();
  db = undefined;
  stub = undefined;
  errors = undefined;
});

const PUSHER_CAP = `${NAMESPACE}.ts0001_fingerbot`;
const PIN = "40719263";

/** A doer over fake stacks whose herdsman has the bench's two models and a lock, as real herdsman devices, its adapter stubbed. */
async function started(lockRow = LOCK_ROW, extra: { noActions?: boolean } = {}) {
  db = devices([SENSOR_ROW, PUSHER_ROW, lockRow]);
  stub = stubAdapter();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const clock = new FakeClock();
  const { made, make } = stacks((s) => {
    for (const hw of [SENSOR, PUSHER, LOCK]) s.had.add(hw);
    s.lookup = (ieee) => db!.get(ieee);
  });
  const doer = new HerdsmanDoer({ clock, coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
    readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES, ...extra });
  doers.push(doer);
  const { events, seen } = core();
  await doer.start(events, new Map());
  await settle();
  await doer.idle();
  return { clock, doer, made, seen, stub: stub!, deadline: () => clock.now() + 5_000 };
}

const say = async (doer: HerdsmanDoer, s: FakeStack, m: unknown) => {
  s.events.heard((m as Message).device.ieeeAddr);
  s.events.message!(m as Message);
  await doer.idle();
};
/** The button pusher reports its mode: click 0, switch 1 (datapoint 101, an enum). */
const mode = (tsn: number, value: 0 | 1) => datapoints(db!.get(PUSHER), tsn, [[101, 4, [value]]]);
const lastDescription = (seen: unknown[][], hw: string) =>
  seen.filter((e) => e[0] === "described" && (e[1] as Description).hardwareId === hw).map((e) => e[1] as Description).at(-1)!;

group("HerdsmanDoer: carrying actions out", () => {
  it("turns the button pusher on in switch mode, confirmed by its Default Response, with herdsman's recovery on", async () => {
    const { doer, made, seen, stub, deadline } = await started();
    await say(doer, made[0]!, mode(3, 1));
    expect(lastDescription(seen, PUSHER).actions.find((a) => a.action === "onoff.turn_on")).toMatchObject({ idempotent: true, confirms: true });
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toEqual({ kind: "confirmed" });
    expect(stub.handed).toEqual([expect.objectContaining({ ieee: PUSHER, cluster: "genOnOff", command: "on", timeout: 5_000, disableRecovery: false })]);
  });

  it("presses the button pusher in click mode once, by its press: not idempotent, so herdsman never sends it again", async () => {
    const { doer, made, stub, deadline } = await started();
    await say(doer, made[0]!, mode(3, 0));
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toMatchObject({ kind: "notSent" });
    expect(await doer.execute(PUSHER, `${PUSHER_CAP}.press`, {}, deadline())).toEqual({ kind: "confirmed" });
    expect(stub.handed[0]).toMatchObject({ command: "on", disableRecovery: true });
  });

  it("polls the button pusher on its cadence while other devices keep the link busy: a message postpones the health exchange, never the poll (code review, plan 5b)", async () => {
    const { clock, doer, made, stub } = await started();
    const polls = () => stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read").length;
    const before = polls();
    // The pusher's mode every 5 s: the link always just heard a device, so no health exchange falls due.
    for (let t = 0, tsn = 10; t <= POLL_MS + 30_000; t += 5_000, tsn++) {
      await say(doer, made[0]!, mode(tsn % 256, 1));
      await clock.advance(5_000);
      await doer.idle();
    }
    expect(polls()).toBeGreaterThan(before);
  });

  it("sets the button pusher's mode as a Tuya datapoint: transmitted, sent once", async () => {
    const { doer, stub, deadline } = await started();
    stub.answer(() => undefined);
    expect(await doer.execute(PUSHER, `${PUSHER_CAP}.set_mode`, { value: "switch" }, deadline())).toEqual({ kind: "transmitted" });
    expect(stub.handed).toEqual([expect.objectContaining({ cluster: "manuSpecificTuya", command: "sendData", disableRecovery: true })]);
  });

  it("gives the device's refusal as the protocol's word", async () => {
    const { doer, made, stub, deadline } = await started();
    await say(doer, made[0]!, mode(3, 1));
    stub.answer((f) => defaultResponse(f, Zcl.Status.FAILURE));
    expect(await doer.execute(PUSHER, "onoff.turn_off", {}, deadline())).toEqual({ kind: "refused", reason: "refused", detail: "FAILURE" });
  });

  it("sends nothing for an action the device does not offer, or a device it has not described", async () => {
    const { doer, stub, deadline } = await started();
    // The button pusher's onoff waits for its mode (GA-BRIDGE-74).
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toEqual({ kind: "notSent", reason: "unreachable", detail: "onoff.turn_on is not offered" });
    expect(await doer.execute("0x00000000000a00ff", "onoff.turn_on", {}, deadline()))
      .toEqual({ kind: "notSent", reason: "unreachable", detail: "the coordinator does not have the device described" });
    expect(stub.handed).toEqual([]);
  });

  it("sends nothing once the doer stopped, from the start of its stop: while it takes the coordinator's backup too", async () => {
    const { doer, made, stub, deadline } = await started();
    await say(doer, made[0]!, mode(3, 1));
    let backedUp: (ok: boolean) => void = () => {};
    made[0]!.backupResult = new Promise((r) => { backedUp = r; });
    const stopping = doer.stop();
    await settle();
    expect(made[0]!.calls).toContain("backup");
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toMatchObject({ kind: "notSent", reason: "unreachable" });
    backedUp(true);
    await stopping;
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toMatchObject({ kind: "notSent", reason: "unreachable" });
    expect(stub.handed).toEqual([]);
  });
});

group("HerdsmanDoer: the owner's PIN is never handed to a lock until spike S6", () => {
  it("sends nothing for a lock's unlock that comes with the owner's PIN, and never writes the PIN anywhere", async () => {
    const { doer, stub, deadline } = await started();
    expect(await doer.execute(LOCK, "lock.unlock", {}, deadline(), PIN)).toEqual({ kind: "notSent", reason: "unreachable", detail: PIN_WITHHELD });
    expect(stub.handed).toEqual([]);
    expect(JSON.stringify(errors!.mock.calls)).not.toContain(PIN);
  });

  it("carries out the unlock of a lock that requires no PIN, which the core gives none", async () => {
    const unpinned = withAttributes(LOCK_ROW, "closuresDoorLock", { numOfPinUsersSupported: 10, requirePinForRfOperation: 0 });
    const { doer, stub, deadline } = await started(unpinned);
    stub.answer((f) => reply(f, "unlockDoorRsp", { status: 0 }, false));
    expect(await doer.execute(LOCK, "lock.unlock", {}, deadline())).toEqual({ kind: "confirmed" });
    expect(stub.handed).toEqual([expect.objectContaining({ cluster: "closuresDoorLock", command: "unlockDoor", payload: { pincodevalue: Buffer.from("") } })]);
  });
});

group("HerdsmanDoer: the read-back", () => {
  it("reads the button pusher's on back with its converter's get, and nothing for its mode, a Tuya datapoint", async () => {
    const { doer, stub, deadline } = await started();
    stub.answer((f) => reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: Zcl.DataType.BOOLEAN, attrData: 1 }]));
    await doer.read(PUSHER, ["on", `${PUSHER_CAP}.mode`], deadline());
    expect(stub.handed).toEqual([expect.objectContaining({ cluster: "genOnOff", command: "read", timeout: 5_000 })]);
    stub.handed.length = 0;
    await doer.read(PUSHER, [`${PUSHER_CAP}.mode`], deadline());
    expect(stub.handed).toEqual([]);
  });

  it("logs a read-back the device did not answer in its own words, and reads nothing of a device it has not described", async () => {
    const { doer, stub, deadline } = await started();
    stub.answer(() => responseTimeout());
    await doer.read(PUSHER, ["on"], deadline());
    expect(errors!.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${PUSHER}: the read-back was lost: the device did not answer in time`);
    stub.handed.length = 0;
    await doer.read("0x00000000000a00ff", ["on"], deadline());
    expect(stub.handed).toEqual([]);
  });
});

group("HerdsmanDoer: the plan 2c-2 review's findings", () => {
  it("declares a numeric's step, so the core refuses a value off it, and sends a value on it as it is, never rounded (I1)", async () => {
    const { doer, seen, stub, deadline } = await started();
    stub.answer(() => undefined);
    const d = lastDescription(seen, PUSHER);
    const decl = d.actions.find((a) => a.action === `${PUSHER_CAP}.set_delay`)!;
    expect(decl.args).toEqual({ value: { min: 0, max: 10, step: 1 } });
    expect(d.extensions![0]!.actions!.find((a) => a.action === `${PUSHER_CAP}.set_delay`)!.schema)
      .toEqual({ type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 10 } } });
    // The bench's garbage: 2.5 would be sent as 512, 75.5 as 19200.
    expect(namedArgs(decl, 2.5)).toBe("value goes in steps of 1 from 0");
    const lower = d.actions.find((a) => a.action === `${PUSHER_CAP}.set_lower`)!;
    expect(namedArgs(lower, 75.5)).toBe("value goes in steps of 1 from 50");
    const args = namedArgs(decl, 3) as Record<string, unknown>;
    expect(await doer.execute(PUSHER, `${PUSHER_CAP}.set_delay`, args, deadline())).toEqual({ kind: "transmitted" });
    const dp = (stub.handed[0]!.payload as { dpValues: { dp: number; data: Buffer }[] }).dpValues[0]!;
    expect(dp.data.readUInt32BE(0)).toBe(3);
  });

  it("tells the core it hands no lock a PIN until spike S6, so the core offers no unlock with one (I3)", async () => {
    const { doer } = await started();
    expect(doer.withholdsPins).toBe(PIN_WITHHELD);
  });

  it("withholds every action and every read-back while the owner says so: nothing offered, nothing sent (M6)", async () => {
    const unpinned = withAttributes(LOCK_ROW, "closuresDoorLock", { numOfPinUsersSupported: 10, requirePinForRfOperation: 0 });
    const { doer, made, seen, stub, deadline } = await started(unpinned, { noActions: true });
    await say(doer, made[0]!, mode(3, 1));
    for (const hw of [SENSOR, PUSHER, LOCK]) {
      const d = lastDescription(seen, hw);
      expect(d.actions, hw).toEqual([]);
      expect(d.extensions?.some((e) => e.actions?.length), hw).toBeFalsy();
    }
    // The pusher's keys are still described and read.
    expect(lastDescription(seen, PUSHER).extensions![0]!.keys!.length).toBeGreaterThan(0);
    expect(await doer.execute(PUSHER, "onoff.turn_on", {}, deadline())).toEqual({ kind: "notSent", reason: "unreachable",
      detail: "the bridge offers no action: GALATEA_ZIGBEE_NO_ACTIONS" });
    expect(await doer.execute(LOCK, "lock.unlock", {}, deadline())).toMatchObject({ kind: "notSent", reason: "unreachable" });
    await doer.read(PUSHER, ["on"], deadline());
    expect(stub.handed).toEqual([]);
  });
});
