import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import * as globalStore from "zigbee-herdsman-converters/lib/store";
import { answerOf, type Call, confirmsOf, DRY_RUN_MS, dryDevice, dryRun } from "../src/herdsman/recording.js";
import { devices, LIGHT, LIGHT_ROW, LOCK, LOCK_ROW, PUSHER, PUSHER_ROW, SENSOR, SENSOR_ROW } from "./zigbee-devices.js";

let db: ReturnType<typeof devices>;
beforeEach(() => { db = devices([SENSOR_ROW, PUSHER_ROW, LIGHT_ROW, LOCK_ROW]); });
afterEach(() => { db.close(); vi.useRealTimers(); });

const definition = async (ieee: string) => (await findByDevice(db.get(ieee), true))!;
/** A run's calls, each as `call cluster.what answer`. */
const shape = (r: Awaited<ReturnType<typeof dryRun>>) =>
  "threw" in r ? `threw: ${r.threw}` : r.calls.map((c) => `${c.call} ${String(c.cluster)}.${JSON.stringify(c.what)} ${c.answer}`);

describe("dryRun: a set through the converters, sending nothing (spike S5)", () => {
  it("records the vibration sensor's sensitivity as one write, which waits on its Write Response", async () => {
    const r = await dryRun(await definition(SENSOR), db.get(SENSOR), "sensitivity", 50);
    expect(shape(r)).toEqual(['write ssIasZone.{"currentZoneSensitivityLevel":50} writeResponse']);
    expect(confirmsOf([r])).toBe(true);
  });

  it("records the button pusher's on and off as genOnOff commands that wait on a Default Response", async () => {
    const def = await definition(PUSHER);
    const on = await dryRun(def, db.get(PUSHER), "state", "ON");
    const off = await dryRun(def, db.get(PUSHER), "state", "OFF");
    expect(shape(on)).toEqual(['command genOnOff."on" defaultResponse']);
    expect(shape(off)).toEqual(['command genOnOff."off" defaultResponse']);
    expect(confirmsOf([on, off])).toBe(true);
  });

  it("records the button pusher's mode as a Tuya datapoint send, which waits on nothing: confirms false", async () => {
    const def = await definition(PUSHER);
    const runs = await Promise.all(["click", "switch"].map((v) => dryRun(def, db.get(PUSHER), "mode", v)));
    for (const r of runs) expect(shape(r)).toEqual(['command manuSpecificTuya."sendData" none']);
    expect((runs[0] as { calls: Call[] }).calls[0]!.options).toEqual({ disableDefaultResponse: true });
    expect(confirmsOf(runs)).toBe(false);
  });

  it("records a generated light's brightness as a level command, and leaves the converters' store of the real light alone", async () => {
    const def = await definition(LIGHT);
    const r = await dryRun(def, db.get(LIGHT), "brightness", 254);
    expect(shape(r)).toEqual(['command genLevelCtrl."moveToLevelWithOnOff" defaultResponse']);
    // The converter keeps a light's brightness to restore it: under the dry device's own name, never the light's.
    expect(globalStore.getValue(db.get(LIGHT).getEndpoint(1)!, "brightness")).toBeUndefined();
  });

  it("records a lock's lock and unlock as commands that wait on the Door Lock's own response", async () => {
    const def = await definition(LOCK);
    expect(shape(await dryRun(def, db.get(LOCK), "state", "UNLOCK"))).toEqual(['command closuresDoorLock."unlockDoor" response']);
    expect(shape(await dryRun(def, db.get(LOCK), "state", "LOCK"))).toEqual(['command closuresDoorLock."lockDoor" response']);
  });

  it("says why it could not run: no converter takes the key, or the converter threw", async () => {
    expect(await dryRun(await definition(SENSOR), db.get(SENSOR), "colour", "red")).toEqual({ threw: "no converter takes colour" });
    // The button pusher's Tuya datapoints take every key, and throw for one its definition has no datapoint for.
    expect(await dryRun(await definition(PUSHER), db.get(PUSHER), "colour", "red")).toEqual({ threw: "No datapoint defined for 'colour'" });
    const throwing = { ...(await definition(SENSOR)), toZigbee: [{ key: ["x"], convertSet: async () => { throw new Error("out of range"); } }] };
    expect(await dryRun(throwing as Definition, db.get(SENSOR), "x", 1)).toEqual({ threw: "out of range" });
  });

  it("counts a converter that never ends as one that threw, after DRY_RUN_MS", async () => {
    vi.useFakeTimers();
    const stuck = { ...(await definition(SENSOR)), toZigbee: [{ key: ["x"], convertSet: () => new Promise(() => {}) }] };
    const r = dryRun(stuck as Definition, db.get(SENSOR), "x", 1);
    await vi.advanceTimersByTimeAsync(DRY_RUN_MS);
    expect(await r).toEqual({ threw: `no end within ${DRY_RUN_MS} ms` });
  });
});

describe("dryDevice: what a converter reaches is recorded, never sent", () => {
  it("records every call but the quiet ones, the device's own and through any of its endpoints, and keeps the constructor", async () => {
    const calls: Call[] = [];
    const real = db.get(PUSHER);
    const dry = dryDevice(real, calls);
    const ep = dry.getEndpoint(1)!;
    // No adapter is there: had any of these reached herdsman, it would have thrown.
    await ep.bind("genOnOff", 1 as never);
    await ep.getDevice().endpoints[0]!.configureReporting("genOnOff", []);
    await dry.save();
    expect(await ep.read("genBasic", ["modelId"])).toEqual({});
    expect(calls.map((c) => `${c.call} ${c.answer}`)).toEqual(["bind other", "configureReporting other", "device.save other",
      "read readResponse"]);
    expect(ep.constructor.name).toBe("Endpoint");
    expect(dry.constructor.name).toBe("Device");
    expect(ep.supportsInputCluster("genOnOff")).toBe(true);
    expect(dry.ieeeAddr).toBe(`${PUSHER}~dry`);
    expect(ep.deviceIeeeAddress).toBe(`${PUSHER}~dry`);
    expect(dry.getEndpoint(1)).toBe(ep);
  });
});

describe("dryDevice: what a converter writes stays in the dry copy (plan 2c-1 review M3)", () => {
  it("keeps a converter's assignments, to the device, an endpoint or their meta, from herdsman's model", async () => {
    const real = db.get(LIGHT);
    const dry = dryDevice(real, []);
    const ep = dry.getEndpoint(1)!;
    (ep as unknown as { meta: Record<string, unknown> }).meta.onLevelSupported = false;
    (ep as unknown as Record<string, unknown>).sendSeq = 3;
    (dry as unknown as { meta: Record<string, unknown> }).meta.configured = 1;
    dry.powerSource = "Battery";
    expect((ep as unknown as { meta: Record<string, unknown> }).meta.onLevelSupported).toBe(false);
    expect((ep as unknown as Record<string, unknown>).sendSeq).toBe(3);
    expect(dry.powerSource).toBe("Battery");
    expect(real.getEndpoint(1)!.meta).toEqual({});
    expect((real.getEndpoint(1)! as unknown as Record<string, unknown>).sendSeq).toBeUndefined();
    expect(real.meta).toEqual({});
    expect(real.powerSource).toBe("Mains (single phase)");
  });
});

describe("answerOf: how herdsman waits on a call", () => {
  it("names the response a command's definition gives, a Default Response, none, and calls of no known command", () => {
    const d = db.get(LOCK);
    expect(answerOf(d, "command", "closuresDoorLock", "lockDoor", undefined)).toBe("response");
    expect(answerOf(d, "command", "genOnOff", "on", undefined)).toBe("defaultResponse");
    expect(answerOf(d, "command", "genOnOff", "on", { disableDefaultResponse: true })).toBe("none");
    expect(answerOf(d, "write", "genOnOff", {}, { disableResponse: true })).toBe("none");
    expect(answerOf(d, "command", "genOnOff", "noSuchCommand", undefined)).toBe("other");
    expect(answerOf(d, "bind", "genOnOff", undefined, undefined)).toBe("other");
  });
});

describe("confirmsOf", () => {
  const call = (answer: Call["answer"]): Call => ({ call: "command", answer });
  it("offers no action for a run that threw, made no call, or made a call of another kind", () => {
    expect(confirmsOf([])).toBeUndefined();
    expect(confirmsOf([{ calls: [] }])).toBeUndefined();
    expect(confirmsOf([{ calls: [call("defaultResponse")] }, { threw: "x" }])).toBeUndefined();
    expect(confirmsOf([{ calls: [call("defaultResponse"), call("other")] }])).toBeUndefined();
  });
  it("confirms only when every call of every run waits on an answer", () => {
    expect(confirmsOf([{ calls: [call("defaultResponse")] }, { calls: [call("writeResponse"), call("readResponse")] }])).toBe(true);
    expect(confirmsOf([{ calls: [call("defaultResponse")] }, { calls: [call("none")] }])).toBe(false);
  });
});
