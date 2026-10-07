import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Zcl } from "zigbee-herdsman";
import { findByDevice, type Definition, type Tz } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { getterFor, liveOptions, lostDetail, resultOf, runGet, runSet, type RunOptions } from "../src/herdsman/execute.js";
import { FakeClock } from "./fakes.js";
import { dataConfirmFailure, defaultResponse, reply, responseTimeout, stubAdapter } from "./zigbee-adapter.js";
import { devices, LOCK, LOCK_ROW, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices>;
let stub: ReturnType<typeof stubAdapter>;
let clock: FakeClock;
beforeEach(() => {
  db = devices([SENSOR_ROW, PUSHER_ROW, LOCK_ROW]);
  stub = stubAdapter();
  clock = new FakeClock();
});
afterEach(() => {
  stub.restore();
  db.close();
});

const definition = async (ieee: string) => (await findByDevice(db.get(ieee), true))!;
/** A run's options: the command's time 5 s from now, idempotent unless said. */
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({ now: () => clock.now(), deadline: clock.now() + 5_000, once: false, ...over });
const set = async (ieee: string, property: string, value: unknown, over?: Partial<RunOptions>) =>
  resultOf(await runSet(await definition(ieee), db.get(ieee), property, value, opts(over)));

describe("liveOptions: the doer's options win over the converter's", () => {
  it("gives what remains of the command's time as the timeout, never queues, and sends a non-idempotent action once", () => {
    const o = { now: () => 1_000, deadline: 3_500 };
    expect(liveOptions({ disableDefaultResponse: true, timeout: 30_000 }, { ...o, once: true }))
      .toEqual({ disableDefaultResponse: true, timeout: 2_500, sendPolicy: "immediate", disableRecovery: true });
    expect(liveOptions(undefined, { ...o, once: false })).toEqual({ timeout: 2_500, sendPolicy: "immediate" });
    // At the deadline itself, herdsman still gets a timeout it takes.
    expect(liveOptions({}, { now: () => 3_500, deadline: 3_500, once: false }).timeout).toBe(1);
  });
});

describe("runSet and resultOf: a set carried out, and the protocol's word on it (spike S8)", () => {
  it("confirms the button pusher's on by its Default Response, the doer's options reaching the adapter", async () => {
    expect(await set(PUSHER, "state", "ON")).toEqual({ kind: "confirmed" });
    expect(stub.handed).toEqual([expect.objectContaining({ ieee: PUSHER, cluster: "genOnOff", command: "on", timeout: 5_000, disableRecovery: false })]);
  });

  it("sends an action that is not idempotent once: herdsman's recovery off", async () => {
    await set(PUSHER, "state", "OFF", { once: true });
    expect(stub.handed[0]).toMatchObject({ command: "off", disableRecovery: true });
  });

  it("takes a failure status in the Default Response as a refusal, though the converter carried on as if it succeeded", async () => {
    stub.answer((f) => defaultResponse(f, Zcl.Status.UNSUP_COMMAND));
    expect(await set(PUSHER, "state", "OFF")).toEqual({ kind: "refused", reason: "refused", detail: "UNSUP_COMMAND" });
  });

  it("takes a failure in a Write Response as a refusal, by the status's name", async () => {
    stub.answer((f) => reply(f, "writeRsp", [{ status: Zcl.Status.INVALID_VALUE, attrId: 0x13 }]));
    expect(await set(SENSOR, "sensitivity", 20)).toEqual({ kind: "refused", reason: "refused", detail: "INVALID_VALUE" });
    stub.answer((f) => reply(f, "writeRsp", [{ status: Zcl.Status.SUCCESS }]));
    expect(await set(SENSOR, "sensitivity", 20)).toEqual({ kind: "confirmed" });
  });

  it("takes a failure status in a cluster's own response as a refusal: the lock's unlock answered FAILURE", async () => {
    stub.answer((f) => reply(f, "unlockDoorRsp", { status: 1 }, false));
    expect(await set(LOCK, "state", "UNLOCK")).toEqual({ kind: "refused", reason: "refused", detail: "FAILURE" });
    stub.answer((f) => reply(f, "unlockDoorRsp", { status: 0 }, false));
    expect(await set(LOCK, "state", "UNLOCK")).toEqual({ kind: "confirmed" });
  });

  it("takes a delivery the network lost, or an answer that never came, as lost, never in herdsman's words", async () => {
    stub.answer(() => dataConfirmFailure("MAC_NO_ACK"));
    expect(await set(PUSHER, "state", "OFF")).toEqual({ kind: "lost", detail: "the delivery failed: MAC_NO_ACK" });
    stub.answer(() => responseTimeout());
    expect(await set(PUSHER, "state", "OFF")).toEqual({ kind: "lost", detail: "the device did not answer in time" });
  });

  it("never quotes herdsman's error, which carries the frame's payload: a lock's PIN stays out of the result", async () => {
    stub.answer(() => dataConfirmFailure("MAC_NO_ACK"));
    const run = await runSet(await definition(LOCK), db.get(LOCK), "state", { state: "UNLOCK", code: "40719263" }, opts());
    // herdsman's own error text holds the PIN, as bytes.
    const error = (run.calls[0]!.outcome as { error: Error }).error;
    expect(error.message).toContain('"data":[52,48,55,49,57,50,54,51]');
    const r = resultOf(run);
    expect(r).toEqual({ kind: "lost", detail: "the delivery failed: MAC_NO_ACK" });
    expect(JSON.stringify(r)).not.toMatch(/40719263|52,48,55/);
    expect(lostDetail(new Error("anything else, 40719263"))).toBe("the stack failed after the command was handed to it");
  });

  it("transmits a Tuya datapoint, which waits on no answer: the button pusher's mode", async () => {
    stub.answer(() => undefined);
    expect(await set(PUSHER, "mode", "switch")).toEqual({ kind: "transmitted" });
    expect(stub.handed).toEqual([expect.objectContaining({ cluster: "manuSpecificTuya", command: "sendData" })]);
  });

  it("sends nothing once the command's time ran out: notSent(expired), the adapter never reached", async () => {
    expect(await set(PUSHER, "state", "ON", { deadline: clock.now() })).toMatchObject({ kind: "notSent", reason: "expired" });
    expect(stub.handed).toEqual([]);
  });

  it("is notSent(unreachable) when the converter threw before sending anything", async () => {
    expect(await set(PUSHER, "colour", "red")).toEqual({ kind: "notSent", reason: "unreachable", detail: "the converter sent nothing" });
    expect(stub.handed).toEqual([]);
  });

  it("makes no call once the command's time ran out between two: the first sent, so lost", async () => {
    const def = await definition(PUSHER);
    const twice: Tz.Converter = { key: ["state"], convertSet: async (entity) => {
      await entity.command("genOnOff", "on", {});
      await clock.advance(6_000);
      await entity.command("genOnOff", "off", {});
    } };
    const r = await runSet({ ...def, toZigbee: [twice] } as Definition, db.get(PUSHER), "state", "ON", opts());
    expect(r.calls.map((c) => [c.what, Object.keys(c.outcome)[0]])).toEqual([["on", "value"], ["off", "notMade"]]);
    expect(resultOf(r)).toEqual({ kind: "lost", detail: "the command's time ran out before the converter's next call" });
    expect(stub.handed.map((h) => h.command)).toEqual(["on"]);
  });

  it("refuses a converter's bind in a live run, which reaches nothing: notSent, or lost after a call", async () => {
    const def = await definition(PUSHER);
    const binds = (first: boolean): Tz.Converter => ({ key: ["state"], convertSet: async (entity, _k, _v, meta) => {
      if (first) await entity.command("genOnOff", "on", {});
      await (entity as Zh.Endpoint).bind("genOnOff", meta.device.getEndpoint(1)!);
    } });
    expect(resultOf(await runSet({ ...def, toZigbee: [binds(false)] } as Definition, db.get(PUSHER), "state", "ON", opts())))
      .toEqual({ kind: "notSent", reason: "unreachable", detail: "the converter sent nothing" });
    expect(resultOf(await runSet({ ...def, toZigbee: [binds(true)] } as Definition, db.get(PUSHER), "state", "ON", opts())))
      .toEqual({ kind: "lost", detail: "the converter stopped after sending" });
    expect(stub.handed.map((h) => h.command)).toEqual(["on"]);
  });

  it("is lost when the converter returned before its call's answer came", async () => {
    const def = await definition(PUSHER);
    let answer: (v: unknown) => void = () => {};
    stub.answer(() => new Promise((r) => { answer = r; }));
    const forgets: Tz.Converter = { key: ["state"], convertSet: async (entity) => { void entity.command("genOnOff", "on", {}).catch(() => {}); } };
    const r = await runSet({ ...def, toZigbee: [forgets] } as Definition, db.get(PUSHER), "state", "ON", opts());
    expect(resultOf(r)).toEqual({ kind: "lost", detail: "the converter did not wait for the answer" });
    answer(undefined);
  });

  it("keeps herdsman off its queue for a sleeping device: a failed delivery fails at once, never sent later", async () => {
    db.get(PUSHER).pendingRequestTimeout = 60_000;
    stub.answer(() => dataConfirmFailure("MAC_TRANSACTION_EXPIRED"));
    expect(await set(PUSHER, "state", "OFF")).toEqual({ kind: "lost", detail: "the delivery failed: MAC_TRANSACTION_EXPIRED" });
  });
});

describe("runGet: the read-back by the converter's own get", () => {
  it("reads the button pusher's onoff with a genOnOff read, and nothing for a Tuya datapoint, which has no get", async () => {
    const def = await definition(PUSHER);
    stub.answer((f) => reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: Zcl.DataType.BOOLEAN, attrData: 1 }]));
    const runs = await runGet(def, db.get(PUSHER), ["state", "mode"], opts());
    expect(runs.map(resultOf)).toEqual([{ kind: "confirmed" }]);
    expect(stub.handed).toEqual([expect.objectContaining({ cluster: "genOnOff", command: "read", timeout: 5_000 })]);
    expect(getterFor(def, "mode")).toBeUndefined();
  });

  it("reads a property by the converter zigbee2mqtt's get finds, the first that names it, with a set or not: none when that one has no get", async () => {
    const def = await definition(PUSHER);
    const first: Tz.Converter = { key: ["state"], convertSet: async () => {} };
    const later: Tz.Converter = { key: ["state"], convertSet: async () => {}, convertGet: async () => {} };
    expect(getterFor({ ...def, toZigbee: [first, later] } as Definition, "state")).toBeUndefined();
    expect(getterFor({ ...def, toZigbee: [later, first] } as Definition, "state")).toBe(later);
    // A converter with a get and no set is found too (plan 2c-2 review M4): the set goes to `later`.
    const getOnly: Tz.Converter = { key: ["state"], convertGet: async () => {} };
    expect(getterFor({ ...def, toZigbee: [getOnly, later] } as Definition, "state")).toBe(getOnly);
  });

  it("reads a lock's state, once for every property one converter reads", async () => {
    const def = await definition(LOCK);
    stub.answer((f) => reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: Zcl.DataType.ENUM8, attrData: 1 }]));
    await runGet(def, db.get(LOCK), ["state", "state"], opts());
    expect(stub.handed.map((h) => `${h.cluster} ${h.command}`)).toEqual(["closuresDoorLock read"]);
  });

  it("says what came of a read the device did not answer", async () => {
    stub.answer(() => responseTimeout());
    const runs = await runGet(await definition(PUSHER), db.get(PUSHER), ["state"], opts());
    expect(runs.map(resultOf)).toEqual([{ kind: "lost", detail: "the device did not answer in time" }]);
  });
});

describe("the plan 2c-2 review's findings", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("refuses a converter's call made after its set returned, as a real converter's timer makes it: only the run's own call reaches herdsman (I2)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const def = await definition(PUSHER);
      // As a Tuya light's converter does: its set returns, and a timer reads the state back through the same endpoint.
      const late: Tz.Converter = { key: ["state"], convertSet: async (entity) => {
        await entity.command("genOnOff", "on", {});
        setTimeout(() => { void entity.read("genOnOff", ["onOff"]).catch(() => {}); }, 20);
        setTimeout(() => { void entity.command("genOnOff", "toggle", { secret: "40719263" }).catch(() => {}); }, 20);
      } };
      const run = await runSet({ ...def, toZigbee: [late] } as Definition, db.get(PUSHER), "state", "ON", opts());
      expect(resultOf(run)).toEqual({ kind: "confirmed" });
      await wait(60);
      expect(stub.handed.map((h) => h.command)).toEqual(["on"]);
      expect(run.calls).toHaveLength(1);
      const logged = errors.mock.calls.map((c) => String(c[0]));
      expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.read genOnOff: the action's run has ended`);
      expect(logged).toContain(`zigbee: ${PUSHER}/1: refused endpoint.command genOnOff: the action's run has ended`);
      // Logged without its payload.
      expect(JSON.stringify(errors.mock.calls)).not.toContain("40719263");
    } finally {
      errors.mockRestore();
    }
  });

  it("refuses a converter's late call after a read-back's get returned, too (I2)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const def = await definition(PUSHER);
      stub.answer((f) => reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: Zcl.DataType.BOOLEAN, attrData: 1 }]));
      const retries: Tz.Converter = { key: ["state"], convertSet: async () => {}, convertGet: async (entity) => {
        await entity.read("genOnOff", ["onOff"]);
        setTimeout(() => { void entity.read("genOnOff", ["onOff"]).catch(() => {}); }, 20);
      } };
      const runs = await runGet({ ...def, toZigbee: [retries] } as Definition, db.get(PUSHER), ["state"], opts());
      expect(runs.map(resultOf)).toEqual([{ kind: "confirmed" }]);
      await wait(60);
      expect(stub.handed.map((h) => h.command)).toEqual(["read"]);
    } finally {
      errors.mockRestore();
    }
  });

  it("takes a refusal as the word only when the refusing call was the converter's last: a later call sent is lost (M1)", async () => {
    const def = await definition(PUSHER);
    let n = 0;
    stub.answer((f) => defaultResponse(f, n++ === 0 ? Zcl.Status.FAILURE : Zcl.Status.SUCCESS));
    const two: Tz.Converter = { key: ["state"], convertSet: async (entity) => {
      await entity.command("genOnOff", "off", {});
      await entity.command("genOnOff", "on", {});
    } };
    expect(resultOf(await runSet({ ...def, toZigbee: [two] } as Definition, db.get(PUSHER), "state", "ON", opts())))
      .toEqual({ kind: "lost", detail: "the device refused one call (FAILURE), and a later one was sent" });
    // The refusal as the last call is the word.
    n = 1;
    stub.answer((f) => defaultResponse(f, n++ === 1 ? Zcl.Status.SUCCESS : Zcl.Status.FAILURE));
    expect(resultOf(await runSet({ ...def, toZigbee: [two] } as Definition, db.get(PUSHER), "state", "ON", opts())))
      .toEqual({ kind: "refused", reason: "refused", detail: "FAILURE" });
    // A Write Response's refusal followed by a call sent is lost too.
    const writes: Tz.Converter = { key: ["state"], convertSet: async (entity) => {
      await entity.write("genOnOff", { onTime: 1 }).catch(() => {});
      await entity.command("genOnOff", "on", {});
    } };
    stub.answer((f) => (f.command.name === "write" ? reply(f, "writeRsp", [{ status: Zcl.Status.INVALID_VALUE, attrId: 0x4001 }]) : defaultResponse(f, 0)));
    expect(resultOf(await runSet({ ...def, toZigbee: [writes] } as Definition, db.get(PUSHER), "state", "ON", opts())))
      .toEqual({ kind: "lost", detail: "the device refused one call (INVALID_VALUE), and a later one was sent" });
  });
});
