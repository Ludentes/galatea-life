import { afterEach, beforeEach, describe as group, expect, it, type MockInstance, vi } from "vitest";
import { Zcl } from "zigbee-herdsman";
import { active, COMMAND_MISSES, noAnswer, POLL_MISSES, POLL_RETRY_MS, reachOf } from "../src/herdsman/availability.js";
import { NAMESPACE } from "../src/herdsman/describe.js";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { HerdsmanDoer } from "../src/herdsman/doer.js";
import { Expired } from "../src/herdsman/execute.js";
import type { Message } from "../src/herdsman/pipeline.js";
import { POLL_MS } from "../src/herdsman/polling.js";
import type { DoerEvents } from "../src/port.js";
import { UPKEEP_MS } from "../src/herdsman/doer.js";
import { FakeClock, settle } from "./fakes.js";
import { core, type FakeStack, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { dataConfirmFailure, defaultResponse, reply, responseTimeout, srspTimeout, stubAdapter } from "./zigbee-adapter.js";
import { COORDINATOR_ROW, datapoints, devices, LIGHT, LIGHT_ROW, message, PLUG_ROW, PUSHER, PUSHER_ROW, row, SENSOR_ROW } from "./zigbee-devices.js";

/**
 * A mains device that stops answering goes `dead` (the maintainer's ruling of 2026-10-12; first
 * light's FL-GAP-4): the herdsman doer tells the core a device covered by the rule is unavailable
 * after POLL_MISSES polls or COMMAND_MISSES commands in a row get no answer, and available again at
 * the next frame heard from it. The rule is keyed to the device (zigbee2mqtt's active device), never
 * to whether the doer polls it: the button pusher is polled and runs on a battery.
 */

let db: ReturnType<typeof devices> | undefined;
let stub: ReturnType<typeof stubAdapter>;
let errors: MockInstance;
/** A read answered with the ZCL version, anything else a Default Response SUCCESS. */
const answersAll = (f: Zcl.Frame) => (f.command.name === "read" ? reply(f, "readRsp", [{ attrId: 0, status: 0, dataType: 0x20, attrData: 8 }])
  : defaultResponse(f));
beforeEach(() => {
  stub = stubAdapter();
  stub.answer(answersAll);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stub.restore();
  errors.mockRestore();
  db?.close();
  db = undefined;
});

const COORDINATOR = COORDINATOR_ROW.ieeeAddr as string;
const availability = (seen: unknown[][]) => seen.filter((e) => e[0] === "availability").map((e) => [e[1], e[2]]);
const report = (ieee: string, tsn: number) => message(db!.get(ieee), { cluster: "genOnOff", command: "report", global: true, tsn,
  payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never as Message;

group("which devices the rule covers: zigbee2mqtt's active device", () => {
  const model = (type: string, powerSource: string | undefined) => ({ type, powerSource }) as never;

  it("covers a router on the mains, and any device whose power source is known and not a battery", () => {
    expect(active(model("Router", "Mains (single phase)"))).toBe(true);
    expect(active(model("Router", "Unknown"))).toBe(true);
    expect(active(model("Router", undefined))).toBe(true);
    expect(active(model("EndDevice", "Mains (single phase)"))).toBe(true);
    expect(active(model("EndDevice", "DC Source"))).toBe(true);
  });

  it("covers no device on a battery, a router among them, and no end device whose power source is unknown", () => {
    expect(active(model("EndDevice", "Battery"))).toBe(false);
    expect(active(model("Router", "Battery"))).toBe(false);
    expect(active(model("EndDevice", "Unknown"))).toBe(false);
    expect(active(model("EndDevice", undefined))).toBe(false);
  });

  it("covers the bench's plug and the test light, not the button pusher or the sensors", () => {
    db = devices([PLUG_ROW, LIGHT_ROW, PUSHER_ROW, SENSOR_ROW]);
    expect(active(db.get(PLUG_ROW.ieeeAddr as string))).toBe(true);
    expect(active(db.get(LIGHT))).toBe(true);
    expect(active(db.get(PUSHER))).toBe(false);
    expect(active(db.get(SENSOR_ROW.ieeeAddr as string))).toBe(false);
    expect(active(db.get(COORDINATOR))).toBe(false);
  });
});

group("what counts as no answer", () => {
  for (const status of ["MAC_NO_ACK", "NWK_NO_ROUTE", "MAC_TRANSACTION_EXPIRED", "APS_NO_ACK"]) {
    it(`counts a data confirm of ${status}: the device did not take the frame`, () => {
      expect(noAnswer(dataConfirmFailure(status))).toBe(true);
      // As herdsman's endpoint wraps it.
      expect(noAnswer(new Error(`ZCL command 0x00000000000a0003/1 genBasic.read(["zclVersion"], {}) failed (${dataConfirmFailure(status).message})`)))
        .toBe(true);
    });
  }

  it("counts the cluster waitress giving up on the response, in herdsman 10.10.0's words", () => {
    expect(responseTimeout().message).toBe("Timeout after 5000ms [address=4660 endpoint=1 clusterId=6 cmdId=11 tsn=7]");
    expect(noAnswer(responseTimeout())).toBe(true);
    expect(noAnswer(new Error(`ZCL command 0x00000000000a0003/1 genOnOff.on({}, {}) failed (${responseTimeout().message})`))).toBe(true);
  });

  for (const status of ["MAC_CHANNEL_ACCESS_FAILURE", "BUFFER_FULL", "MAC_NO_RESOURCES", "TIMEOUT"]) {
    it(`counts a data confirm of ${status} neither way: the coordinator's own trouble`, () => {
      expect(noAnswer(dataConfirmFailure(status))).toBe(false);
    });
  }

  it("counts the coordinator not taking the data request (its SRSP after 6000 ms) neither way", () => {
    expect(srspTimeout().message).toBe("SRSP - AF - dataRequest after 6000ms");
    expect(noAnswer(srspTimeout())).toBe(false);
  });

  it("counts a status the device sent back, the command's own time, and any other error neither way", () => {
    expect(noAnswer(new Zcl.StatusError(Zcl.Status.UNSUP_COMMAND))).toBe(false);
    expect(noAnswer(new Expired("late"))).toBe(false);
    expect(noAnswer(new Error("the adapter is closed"))).toBe(false);
  });

  it("reads a command's run by its first decisive call: an answer, a refusal or a status error answers; a lost delivery does not", () => {
    const call = (answer: string, outcome: unknown) => ({ call: "command", cluster: "genOnOff", what: "on", answer, outcome }) as never;
    expect(reachOf({ calls: [call("defaultResponse", { value: { cmdId: 1, statusCode: 0 } })] })).toBe("answered");
    expect(reachOf({ calls: [call("defaultResponse", { value: { cmdId: 1, statusCode: Zcl.Status.FAILURE } })] })).toBe("answered");
    expect(reachOf({ calls: [call("defaultResponse", { error: new Zcl.StatusError(Zcl.Status.UNSUP_COMMAND) })] })).toBe("answered");
    expect(reachOf({ calls: [call("defaultResponse", { error: responseTimeout() })] })).toBe("unanswered");
    expect(reachOf({ calls: [call("defaultResponse", { error: dataConfirmFailure() })] })).toBe("unanswered");
    // Answered once in the run: reachable moments ago, whatever came after.
    expect(reachOf({ calls: [call("response", { value: {} }), call("defaultResponse", { error: responseTimeout() })] })).toBe("answered");
    // A frame that waits on no answer, nothing sent, the command's time run out, or the stack's own error: neither.
    expect(reachOf({ calls: [call("none", { value: undefined })] })).toBeUndefined();
    expect(reachOf({ calls: [] })).toBeUndefined();
    expect(reachOf({ calls: [call("defaultResponse", { notMade: "expired" })] })).toBeUndefined();
    expect(reachOf({ calls: [call("defaultResponse", { error: new Error("the adapter is closed") })] })).toBeUndefined();
    expect(reachOf({ calls: [call("defaultResponse", { pending: true })] })).toBeUndefined();
  });
});

group("HerdsmanDevices: polls that go unanswered", () => {
  function layer(rows: Record<string, unknown>[], extra: { mutation?: "marks-a-battery-device-dead" } = {}) {
    db = devices(rows);
    const clock = new FakeClock();
    const { events, seen } = core();
    /** Whether the core listens: the doer gives none while it is stopped. */
    const listening = { value: true };
    const l = new HerdsmanDevices({ clock, events: () => (listening.value ? events : undefined),
      ...(extra.mutation ? { mutation: extra.mutation } : {}) });
    const flush = async () => {
      await settle();
      await l.idle();
    };
    /** One round of polls, POLL_MS after the last. */
    const round = async () => {
      await l.pollDue();
      await flush();
      await clock.advance(POLL_MS);
    };
    return { l, clock, seen, flush, round, listening };
  }
  const reads = () => stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read");

  it("tells a router unavailable once POLL_MISSES polls in a row go unanswered, and not after one", async () => {
    expect(POLL_MISSES).toBe(2);
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    expect(availability(seen)).toEqual([]);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
    // Told once: a third miss says nothing more.
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("counts a delivery the network reported lost as no answer", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => dataConfirmFailure("MAC_NO_ACK"));
    await round();
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("starts the row again at a poll answered, with an error status too", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    stub.answer((f) => reply(f, "defaultRsp", { cmdId: f.command.ID, statusCode: Zcl.Status.UNSUPPORTED_ATTRIBUTE }));
    await round();
    stub.answer(() => responseTimeout());
    await round();
    expect(availability(seen)).toEqual([]);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("starts the row again at any frame heard from the device", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await l.heard(report(LIGHT, 1));
    await flush();
    // Heard just now: no poll is due for POLL_MS, so the next round reads it once more.
    await round();
    await round();
    expect(availability(seen)).toEqual([]);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("tells the router available at the next frame heard, before that frame's observation", async () => {
    const { l, clock, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await round();
    seen.length = 0;
    await l.heard(report(LIGHT, 7));
    await flush();
    expect(seen.map((e) => e[0])).toEqual(["availability", "observed"]);
    expect(seen[0]).toEqual(["availability", LIGHT, true, clock.now()]);
    // Once: the next frame is only an observation.
    await l.heard(report(LIGHT, 8));
    await flush();
    expect(availability(seen)).toEqual([[LIGHT, true]]);
  });

  it("tells the router available at a poll answered, its answer the frame heard", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await round();
    stub.answer(answersAll);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false], [LIGHT, true]]);
  });

  it("tells the router available at its announce, as a device plugged back in sends", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await round();
    await l.announced(db!.get(LIGHT));
    await flush();
    expect(availability(seen)).toEqual([[LIGHT, false], [LIGHT, true]]);
  });

  it("never tells the button pusher unavailable, though it is polled: it runs on a battery, and goes stale instead", async () => {
    const { l, seen, flush, round } = layer([PUSHER_ROW]);
    await l.add(db!.get(PUSHER));
    await flush();
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 5; i++) await round();
    expect(stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read")).toHaveLength(5);
    expect(availability(seen)).toEqual([]);
  });

  it("under `marks-a-battery-device-dead`, keys the rule to polling, and tells the button pusher unavailable", async () => {
    const { l, seen, flush, round } = layer([PUSHER_ROW], { mutation: "marks-a-battery-device-dead" });
    await l.add(db!.get(PUSHER));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await round();
    expect(availability(seen)).toEqual([[PUSHER, false]]);
  });

  it("forgets the count with the device: hardware removed starts at zero", async () => {
    const { l, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await l.remove(LIGHT);
    await l.add(db!.get(LIGHT));
    await flush();
    await round();
    expect(availability(seen)).toEqual([]);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("says in the log why the device is unavailable, and that it is heard again", async () => {
    const { l, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    await round();
    await l.heard(report(LIGHT, 9));
    await flush();
    const logged = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("available"));
    expect(logged).toEqual([`zigbee: ${LIGHT}: ${POLL_MISSES} polls in a row got no answer: available: false until it is heard`,
      `zigbee: ${LIGHT}: heard again: available: true`]);
  });

  it("reads a router again POLL_RETRY_MS after a poll it did not answer, with herdsman's recovery; a retry answered is no miss", async () => {
    expect(POLL_RETRY_MS).toBe(3_000);
    const { l, clock, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    // A stale route (the review, I2): a frame sent once is lost; one sent with recovery (route discovery) gets through.
    stub.answer((f) => (f.command.name === "read" && stub.handed.at(-1)!.disableRecovery ? dataConfirmFailure("MAC_NO_ACK") : answersAll(f)));
    const start = clock.now();
    await l.pollDue();
    await flush();
    await clock.advance(POLL_RETRY_MS - 1);
    expect(reads().map((h) => h.disableRecovery)).toEqual([true]);
    await clock.advance(1);
    await flush();
    expect(reads().map((h) => h.disableRecovery)).toEqual([true, false]);
    expect(clock.now() - start).toBe(POLL_RETRY_MS);
    await clock.advance(POLL_MS - POLL_RETRY_MS);
    for (let i = 0; i < 4; i++) await round();
    expect(reads().map((h) => h.disableRecovery)).toEqual([true, false, true, false, true, false, true, false, true, false]);
    expect(availability(seen)).toEqual([]);
  });

  it("sends no retry for a device the rule does not cover", async () => {
    const { l, clock, flush } = layer([PUSHER_ROW]);
    await l.add(db!.get(PUSHER));
    await flush();
    stub.answer(() => responseTimeout());
    await l.pollDue();
    await flush();
    await clock.advance(POLL_RETRY_MS);
    expect(reads()).toHaveLength(1);
  });

  for (const status of ["MAC_CHANNEL_ACCESS_FAILURE", "BUFFER_FULL", "MAC_NO_RESOURCES", "TIMEOUT"]) {
    it(`never tells a reachable plug unavailable on the coordinator's own ${status} (the review, I1)`, async () => {
      const PLUG = PLUG_ROW.ieeeAddr as string;
      const { l, seen, flush, round } = layer([PLUG_ROW]);
      await l.add(db!.get(PLUG));
      await flush();
      stub.answer(() => dataConfirmFailure(status));
      for (let i = 0; i < 4; i++) await round();
      expect(availability(seen)).toEqual([]);
    });
  }

  it("counts no poll during which the device was heard (the review, M3)", async () => {
    const { l, clock, seen, flush, round } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    // The device reports while its poll's answer is lost: it answered something meanwhile.
    stub.answer(() => {
      // Its retry is lost too, with nothing heard.
      stub.answer(() => responseTimeout());
      clock.step(1_000);
      void l.heard(report(LIGHT, 20));
      return responseTimeout();
    });
    await round();
    await round();
    expect(availability(seen)).toEqual([]);
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("keeps reading an unplugged plug every POLL_MS while it is unavailable, and tells it available at the next poll answered (the review)", async () => {
    const PLUG = PLUG_ROW.ieeeAddr as string;
    const { l, clock, seen, flush } = layer([PLUG_ROW]);
    await l.add(db!.get(PLUG));
    await flush();
    stub.answer(() => responseTimeout());
    const at: number[] = [];
    // The doer's upkeep, as often as it runs, for the time given.
    const tick = async (ms: number) => {
      for (let t = 0; t < ms; t += 10_000) {
        const n = reads().length;
        await l.pollDue();
        await flush();
        if (reads().length > n) at.push(clock.now());
        await clock.advance(10_000);
      }
    };
    await tick(30 * 60_000);
    expect(availability(seen)).toEqual([[PLUG, false]]);
    expect(at.length).toBeGreaterThanOrEqual(5);
    for (const [i, t] of at.slice(1).entries()) expect(t - at[i]!).toBeLessThanOrEqual(POLL_MS + 10_000);
    // Plugged back in, quiet: no frame, no announce. The next poll is answered.
    stub.answer(answersAll);
    await tick(POLL_MS + 20_000);
    expect(availability(seen)).toEqual([[PLUG, false], [PLUG, true]]);
  });

  it("records the device unavailable only once the core heard it, and says so at the next miss (the review, M6)", async () => {
    const { l, seen, flush, round, listening } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    stub.answer(() => responseTimeout());
    await round();
    listening.value = false;
    await round();
    expect(availability(seen)).toEqual([]);
    listening.value = true;
    await round();
    expect(availability(seen)).toEqual([[LIGHT, false]]);
  });

  it("sets no retry for a poll that returns after the controller closed, nor one that crosses to the next controller (the re-review, N1)", async () => {
    const { l, clock, seen, flush } = layer([LIGHT_ROW]);
    await l.add(db!.get(LIGHT));
    await flush();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    stub.answer(async () => {
      await held;
      return responseTimeout();
    });
    const polling = l.pollDue();
    await settle();
    expect(reads()).toHaveLength(1);
    // The controller closes while the poll is in flight; the next one describes the device again, from its own model.
    await l.clear();
    db!.close();
    db = devices([LIGHT_ROW]);
    await l.add(db.get(LIGHT));
    await flush();
    const pending = clock.pending;
    release();
    await polling;
    await flush();
    expect(clock.pending).toBe(pending);
    await clock.advance(POLL_RETRY_MS);
    await flush();
    expect(reads()).toHaveLength(1);
    expect(availability(seen)).toEqual([]);
  });
});

group("HerdsmanDoer: commands that go unanswered", () => {
  /** A bare router no database knows, with genOnOff but no genBasic: never polled, so only its commands count. */
  const SWITCH = "0x00000000000a0011";
  const SWITCH_ROW = row(20, SWITCH, "Router", "test-switch", "galatea-test", "Mains (single phase)", [6]);

  async function started(rows: Record<string, unknown>[], had: string[], extra: { availabilityMutation?: "marks-a-battery-device-dead" } = {}) {
    db = devices(rows);
    const clock = new FakeClock();
    const { made, make } = stacks((s) => {
      for (const hw of had) s.had.add(hw);
      s.lookup = (ieee) => db!.get(ieee);
    });
    const doer = new HerdsmanDoer({ clock, coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES, ...extra });
    const { events, seen } = core();
    await doer.start(events, new Map());
    await settle();
    await doer.idle();
    const turnOn = async () => {
      const r = await doer.execute(SWITCH, "onoff.turn_on", {}, clock.now() + 5_000);
      await settle();
      await doer.idle();
      return r;
    };
    return { clock, doer, made, seen, turnOn };
  }
  const say = async (doer: HerdsmanDoer, s: FakeStack, m: Message) => {
    s.events.message!(m);
    await doer.idle();
  };

  it("tells a router unavailable once COMMAND_MISSES commands in a row get no answer; each still acked as lost", async () => {
    expect(COMMAND_MISSES).toBe(3);
    const { doer, seen, turnOn } = await started([SWITCH_ROW], [SWITCH]);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 2; i++) expect(await turnOn()).toMatchObject({ kind: "lost" });
    expect(availability(seen)).toEqual([]);
    expect(await turnOn()).toMatchObject({ kind: "lost", detail: "the device did not answer in time" });
    expect(availability(seen)).toEqual([[SWITCH, false]]);
    await doer.stop();
  });

  it("starts the row again at a command the device refused: a refusal is an answer", async () => {
    const { doer, seen, turnOn } = await started([SWITCH_ROW], [SWITCH]);
    stub.answer(() => responseTimeout());
    await turnOn();
    await turnOn();
    stub.answer((f) => defaultResponse(f, Zcl.Status.UNSUP_COMMAND));
    expect(await turnOn()).toMatchObject({ kind: "refused" });
    stub.answer(() => responseTimeout());
    await turnOn();
    await turnOn();
    expect(availability(seen)).toEqual([]);
    await turnOn();
    expect(availability(seen)).toEqual([[SWITCH, false]]);
    await doer.stop();
  });

  it("counts no command that sent nothing or ran out of time before its call", async () => {
    const { clock, doer, seen } = await started([SWITCH_ROW], [SWITCH]);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 4; i++) {
      expect(await doer.execute(SWITCH, "onoff.turn_on", {}, clock.now())).toMatchObject({ kind: "notSent", reason: "expired" });
    }
    expect(await doer.execute(SWITCH, "nothing.offered", {}, clock.now() + 5_000)).toMatchObject({ kind: "notSent" });
    await settle();
    await doer.idle();
    expect(availability(seen)).toEqual([]);
    await doer.stop();
  });

  it("tells the router available at its next frame, before the frame's observation", async () => {
    const { doer, made, seen, turnOn } = await started([SWITCH_ROW], [SWITCH]);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 3; i++) await turnOn();
    seen.length = 0;
    await say(doer, made[0]!, report(SWITCH, 4));
    expect(seen.map((e) => e[0]).slice(0, 2)).toEqual(["availability", "observed"]);
    expect(availability(seen)).toEqual([[SWITCH, true]]);
    await doer.stop();
  });

  it("never tells the button pusher unavailable for its commands", async () => {
    const { clock, doer, made, seen } = await started([PUSHER_ROW], [PUSHER]);
    // Switch mode, so that turn_on is offered.
    const { datapoints } = await import("./zigbee-devices.js");
    await say(doer, made[0]!, datapoints(db!.get(PUSHER), 3, [[101, 4, [1]]]) as never);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 4; i++) expect(await doer.execute(PUSHER, "onoff.turn_on", {}, clock.now() + 5_000)).toMatchObject({ kind: "lost" });
    await settle();
    await doer.idle();
    expect(availability(seen)).toEqual([]);
    await doer.stop();
  });

  it("reads a router no poll covers once it is unavailable, on its first endpoint, and tells it available at the answer (the review, M2)", async () => {
    const { clock, doer, seen, turnOn } = await started([SWITCH_ROW], [SWITCH]);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 3; i++) await turnOn();
    expect(availability(seen)).toEqual([[SWITCH, false]]);
    stub.handed.length = 0;
    stub.answer(answersAll);
    await clock.advance(UPKEEP_MS);
    await settle();
    await doer.idle();
    expect(stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read").map((h) => [h.ieee, h.endpoint])).toEqual([[SWITCH, 1]]);
    expect(availability(seen)).toEqual([[SWITCH, false], [SWITCH, true]]);
    await doer.stop();
  });

  it("counts no command sent once without herdsman's recovery: a press, under the mutation that covers the button pusher", async () => {
    const { clock, doer, made, seen } = await started([PUSHER_ROW], [PUSHER], { availabilityMutation: "marks-a-battery-device-dead" });
    // Click mode: the press is offered, sent once (not idempotent).
    await say(doer, made[0]!, datapoints(db!.get(PUSHER), 3, [[101, 4, [0]]]) as never);
    stub.answer(() => responseTimeout());
    const press = async () => {
      const r = await doer.execute(PUSHER, `${NAMESPACE}.ts0001_fingerbot.press`, {}, clock.now() + 5_000);
      await settle();
      await doer.idle();
      return r;
    };
    for (let i = 0; i < 4; i++) expect(await press()).toMatchObject({ kind: "lost" });
    expect(stub.handed.filter((h) => h.command === "on").every((h) => h.disableRecovery)).toBe(true);
    expect(availability(seen)).toEqual([]);
    // Switch mode: turn_on is idempotent, sent with recovery, so its misses count.
    stub.answer(answersAll);
    await say(doer, made[0]!, datapoints(db!.get(PUSHER), 4, [[101, 4, [1]]]) as never);
    stub.answer(() => responseTimeout());
    for (let i = 0; i < 3; i++) await doer.execute(PUSHER, "onoff.turn_on", {}, clock.now() + 5_000);
    await settle();
    await doer.idle();
    expect(availability(seen)).toEqual([[PUSHER, false]]);
    await doer.stop();
  });

  it("counts no command whose Default Response is lost while the device reports what it did (the review)", async () => {
    const { doer, made, seen, turnOn } = await started([SWITCH_ROW], [SWITCH]);
    let tsn = 1;
    stub.answer((f) => {
      if (f.cluster.name !== "genOnOff") return answersAll(f);
      made[0]!.events.message!(report(SWITCH, tsn++));
      return responseTimeout();
    });
    for (let i = 0; i < 3; i++) await turnOn();
    expect(seen.filter((e) => e[0] === "observed").length).toBeGreaterThanOrEqual(3);
    expect(availability(seen)).toEqual([]);
    await doer.stop();
  });

  it("leaves no timer behind at a stop, a poll's retry among them (the re-review, N1)", async () => {
    const { clock, doer } = await started([LIGHT_ROW], [LIGHT]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    stub.answer(async (f) => {
      if (f.command.name !== "read") return answersAll(f);
      await held;
      return responseTimeout();
    });
    // The upkeep's tick finds the router's poll due; its answer is lost after the stop.
    await clock.advance(UPKEEP_MS);
    await settle();
    expect(stub.handed.filter((h) => h.cluster === "genBasic" && h.command === "read").length).toBeGreaterThan(0);
    const stopping = doer.stop();
    await settle();
    release();
    await stopping;
    await settle();
    await settle();
    expect(clock.pending).toBe(0);
  });
});
