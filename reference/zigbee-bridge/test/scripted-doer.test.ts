import { beforeEach, describe, expect, it } from "vitest";
import type { Description, DoerEvents } from "../src/port.js";
import { SCRIPTED_MODEL_REPORT_MS, ScriptedDoer, type Received } from "../src/scripted-doer.js";
import { closedActions } from "../src/vocabulary.js";
import { FakeClock, FakeWire, settle } from "./fakes.js";

const TOPIC = "t/test/zigbee/control";

/**
 * Every event the doer sent the core, as one line each; `mayAdmit` lets in every hardware but what
 * `refused` holds, and each one asked about is in `asked`, not in `seen`.
 */
function recorder(refused: ReadonlySet<string> = new Set()): { events: DoerEvents; seen: unknown[][]; asked: string[] } {
  const seen: unknown[][] = [];
  const asked: string[] = [];
  const on = (name: string) => (...args: unknown[]) => { seen.push([name, ...args]); };
  const events = {
    described: on("described"), observed: on("observed"), occurred: on("occurred"), undescribed: on("undescribed"),
    admitted: on("admitted"), interviewed: on("interviewed"), left: on("left"), transport: on("transport"), fault: on("fault"),
    ungoverned: on("ungoverned"), availability: on("availability"),
    mayAdmit: (hw: string) => {
      asked.push(hw);
      return !refused.has(hw);
    },
  } as DoerEvents;
  return { events, seen, asked };
}

describe("ScriptedDoer", () => {
  let wire: FakeWire;
  let clock: FakeClock;
  let doer: ScriptedDoer;
  let received: Received[];
  let stalls: number[];
  let seen: unknown[][];
  /** The hardware the core refuses, and the hardware the doer asked about. */
  let refused: Set<string>;
  let asked: string[];

  beforeEach(async () => {
    wire = new FakeWire();
    clock = new FakeClock();
    received = [];
    stalls = [];
    refused = new Set();
    doer = new ScriptedDoer({ clock, onReceived: async (r) => { received.push(r); }, onStall: (ms) => stalls.push(ms) });
    const r = recorder(refused);
    seen = r.seen;
    asked = r.asked;
    await doer.serve(wire, TOPIC);
    await doer.start(r.events);
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;
  const lampJoins = () => send({ op: "join", device: "lamp", capabilities: ["onoff", "level"], feedback: "closed" });
  const kinds = () => seen.map((e) => e[0]);

  it("subscribes to the control topic on its own connection, and again on each reconnection", async () => {
    expect(wire.calls).toEqual([`subscribe ${TOPIC}`]);
    await wire.reconnected();
    expect(wire.calls).toEqual([`subscribe ${TOPIC}`, `subscribe ${TOPIC}`]);
  });

  it("starts with the coordinator answering: down, then up at once", () => {
    expect(seen).toEqual([["transport", "down", clock.now(), undefined], ["transport", "up", clock.now(), undefined]]);
  });

  it("answers an op it cannot play unsupported, and a malformed one not", async () => {
    await lampJoins();
    for (const op of [{ op: "link", carrier: true, gatewayAnswers: true }, { op: "power", event: "suspend" }, { op: "clock", steppable: true },
      { op: "transportState", state: "unknown" }, { op: "commands", subscribed: false },
      { op: "commandResult", device: "lamp", result: "unsupported" }, { op: "commandResult", device: "lamp", result: "received" },
      { op: "commandResult", device: "lamp", result: "confirmed", source: "another-bridge" }]) {
      await send(op);
      expect(reply(), JSON.stringify(op)).toMatchObject({ requestId: "r1", ok: false, unsupported: true });
    }
    await send({ op: "join", device: "lamp" });
    expect(reply().ok).toBe(false);
    expect(reply().unsupported).toBeUndefined();
  });

  it("describes a device that joins from its capabilities, confirmed by the protocol on a closed device", async () => {
    await lampJoins();
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    // Described, then interviewed: it came in.
    expect(seen.at(-1)).toEqual(["interviewed", "lamp"]);
    const d = seen.at(-2)![1] as Description;
    expect(seen.at(-2)![0]).toBe("described");
    expect(d).toEqual({
      hardwareId: "lamp", stableIdentifier: "lamp", model: { vendor: "galatea", model: "scripted" }, capabilities: ["onoff", "level"],
      actions: [...closedActions("onoff", true), ...closedActions("level", true)], feedback: "closed", reachMs: 0,
      proposedClass: null, classEvidence: "none", otherAdmins: "unknown", basis: "report", cadenceMs: null,
      basisMaxAgeMs: SCRIPTED_MODEL_REPORT_MS,
    });
    await send({ op: "join", device: "plug", capabilities: ["onoff"], feedback: "open", model: { vendor: "acme", model: "p1" } });
    const plug = seen.at(-2)![1] as Description;
    // Described again, it is not interviewed again.
    const n = seen.length;
    await lampJoins();
    expect(seen.slice(n).map((e) => e[0])).toEqual(["described"]);
    expect(plug).toMatchObject({ model: { vendor: "acme", model: "p1" }, actions: closedActions("onoff", false), basisMaxAgeMs: null });
  });

  it("passes a report and a check-in on as check-ins, stamped with their times", async () => {
    await lampJoins();
    const observedAt = new Date(clock.now() - 5000).toISOString();
    await send({ op: "report", device: "lamp", values: { on: true }, observedAt });
    await send({ op: "checkIn", device: "lamp", at: new Date(clock.now()).toISOString() });
    expect(seen.slice(-2)).toEqual([["observed", "lamp", { on: true }, Date.parse(observedAt), true], ["observed", "lamp", {}, clock.now(), true]]);
    await send({ op: "report", device: "nas", values: {}, observedAt });
    expect(reply()).toMatchObject({ ok: false, error: "no device nas has joined" });
  });

  it("carries out a command: received names it, the device confirms and reports what it reached", async () => {
    await lampJoins();
    const result = await doer.execute("lamp", "level.set_level", { level: 40 }, clock.now() + 5000);
    expect(result).toEqual({ kind: "confirmed" });
    expect(received).toEqual([{ device: "lamp", action: "level.set_level", args: { level: 40 } }]);
    expect(seen.at(-1)).toEqual(["observed", "lamp", { level: 40 }, clock.now(), true]);
    await doer.read("lamp", ["level", "on"]);
    expect(seen.at(-1)).toEqual(["observed", "lamp", { level: 40 }, clock.now(), true]);
  });

  it("answers as commandResult said, once, and reports later when told", async () => {
    await lampJoins();
    await send({ op: "commandResult", device: "lamp", result: "rejected" });
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toEqual({ kind: "refused", reason: "refused", detail: "FAILURE" });
    await send({ op: "commandResult", device: "lamp", result: "none" });
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toMatchObject({ kind: "lost" });
    await send({ op: "commandResult", device: "lamp", result: "confirmed", afterMs: 200, reportAfterMs: 1000 });
    const n = seen.length;
    const pending = doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000);
    await settle();
    await clock.advance(200);
    expect(await pending).toEqual({ kind: "confirmed" });
    expect(seen.length).toBe(n);
    await clock.advance(1000);
    expect(seen.at(-1)).toEqual(["observed", "lamp", { on: true }, clock.now(), true]);
  });

  it.each([
    ["sent", { kind: "transmitted" }, true],
    ["no_confirmation", { kind: "lost", detail: "MAC_NO_ACK" }, true],
    ["unreachable", { kind: "notSent", reason: "unreachable", detail: "MAC_NO_ACK" }, false],
    ["expired", { kind: "notSent", reason: "expired", detail: "MAC_NO_ACK" }, false],
  ])("brings about the ack %s that commandResult names, the radio sending nothing for a not-sent one", async (result, expected, sends) => {
    await lampJoins();
    await send({ op: "commandResult", device: "lamp", result, detail: "MAC_NO_ACK" });
    expect(reply().ok).toBe(true);
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toEqual(expected);
    expect(received).toHaveLength(sends ? 1 : 0);
  });

  it("transmits to an open device with no answer", async () => {
    await send({ op: "join", device: "plug", capabilities: ["onoff"], feedback: "open" });
    expect(await doer.execute("plug", "onoff.turn_on", {}, clock.now() + 5000)).toEqual({ kind: "transmitted" });
  });

  it("loses a command to a silent device at its deadline, and the device answers no read", async () => {
    await lampJoins();
    await send({ op: "silence", device: "lamp", silent: true });
    const pending = doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 3000);
    await settle();
    await clock.advance(3000);
    expect(await pending).toMatchObject({ kind: "lost" });
    const n = seen.length;
    await doer.read("lamp", ["on"]);
    expect(seen.length).toBe(n);
  });

  it("loses the link at once on transportState down, sends nothing, and brings it back on up", async () => {
    await lampJoins();
    await send({ op: "transportState", state: "down" });
    expect(seen.at(-1)).toEqual(["transport", "down", clock.now(), 10_000]);
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toMatchObject({ kind: "notSent", reason: "unreachable" });
    expect(received).toEqual([]);
    await send({ op: "transportState", state: "up" });
    expect(seen.at(-1)).toEqual(["transport", "up", clock.now(), undefined]);
  });

  it("plays hostLink: no link is the link lost; a link with no answer connects on each try and stays down; answers bring it up", async () => {
    await lampJoins();
    await send({ op: "hostLink", open: false, answers: false });
    expect(reply()).toMatchObject({ ok: true });
    expect(seen.at(-1)).toEqual(["transport", "down", clock.now(), 10_000]);
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toMatchObject({ kind: "notSent", reason: "unreachable" });
    await send({ op: "hostLink", open: true, answers: false });
    await clock.advance(180_000);
    const states = seen.filter((e) => e[0] === "transport").slice(-3);
    expect(states.every((e) => e[1] === "down")).toBe(true);
    expect(seen.at(-1)).toMatchObject(["transport", "down", expect.any(Number), 60_000]);
    await send({ op: "hostLink", open: true, answers: true });
    expect(seen.at(-1)).toEqual(["transport", "up", clock.now(), undefined]);
  });

  it("under resets-on-connect, a coordinator that connects and is silent is tried every 10 s", async () => {
    const r = recorder();
    const w = new FakeWire();
    const d = new ScriptedDoer({ clock, onReceived: async () => {}, onStall: () => {}, mutation: "resets-on-connect" });
    await d.serve(w, TOPIC);
    await d.start(r.events);
    await w.deliver(TOPIC, { requestId: "r2", op: "hostLink", open: true, answers: false });
    await clock.advance(180_000);
    const retries = r.seen.filter((e) => e[0] === "transport").map((e) => e[3]);
    expect(Math.max(...retries.map((x) => (x as number | undefined) ?? 0))).toBe(10_000);
    await d.stop();
  });

  it("passes a stall to the bridge", async () => {
    await send({ op: "stall", ms: 3000 });
    expect(stalls).toEqual([3000]);
    await settle();
    expect(kinds().filter((k) => k !== "transport")).toEqual([]);
  });

  it("opens a window house-wide or at a router, and closes it, each shown on received; not at a device that is no router", async () => {
    await lampJoins();
    await send({ op: "describe", device: "router", entry: { capabilities: ["onoff"], feedback: "closed", router: true } });
    expect(seen.filter((e) => e[0] === "described").map((e) => (e[1] as Description).router)).toEqual([undefined, true]);
    await doer.join(60_000);
    await doer.joinClose();
    await doer.joinClose();
    await doer.join(30_000, "router");
    await doer.joinClose();
    await expect(doer.join(30_000, "lamp")).rejects.toThrow("no router");
    expect(received).toEqual([
      { device: "*", action: "provision.window", args: { windowMs: 60_000 } },
      { device: "*", action: "provision.window", args: { windowMs: 0 } },
      { device: "router", action: "provision.window", args: { windowMs: 30_000 } },
      { device: "router", action: "provision.window", args: { windowMs: 0 } },
    ]);
  });

  it("removes a device that answers at once, reported left, and resolves at once for hardware it does not have", async () => {
    await lampJoins();
    const n = seen.length;
    await doer.remove("lamp", false);
    await doer.remove("lamp", false);
    await doer.remove("nothing", false);
    expect(seen.slice(n)).toEqual([["left", "lamp"]]);
    await send({ op: "report", device: "lamp", values: { on: true }, observedAt: new Date(clock.now()).toISOString() });
    expect(reply()).toMatchObject({ ok: false, error: "lamp has left the network" });
  });

  it("waits to remove a device that does not answer until it answers, unless forced", async () => {
    await lampJoins();
    await send({ op: "describe", device: "plug", entry: { capabilities: ["onoff"], feedback: "closed" } });
    await send({ op: "silence", device: "lamp", silent: true });
    await send({ op: "silence", device: "plug", silent: true });
    const n = seen.length;
    let lampOut = false;
    const lamp = doer.remove("lamp", false).then(() => { lampOut = true; });
    await expect(doer.remove("lamp", false)).rejects.toThrow("being removed already");
    await settle();
    expect([lampOut, seen.slice(n)]).toEqual([false, []]);
    await send({ op: "silence", device: "lamp", silent: false });
    await lamp;
    expect(seen.slice(n)).toEqual([["left", "lamp"]]);
    // The plug never answers: forced out, the removal waiting for it ends with it.
    const plug = doer.remove("plug", false);
    await doer.remove("plug", true);
    await plug;
    expect(seen.slice(n)).toEqual([["left", "lamp"], ["left", "plug"]]);
  });

  it("ends a removal waiting for a device that answers once the coordinator answers again, and fails one waiting at its stop", async () => {
    await lampJoins();
    await send({ op: "describe", device: "plug", entry: { capabilities: ["onoff"], feedback: "closed" } });
    await send({ op: "transportState", state: "down" });
    await send({ op: "silence", device: "plug", silent: true });
    const lamp = doer.remove("lamp", false);
    const plug = doer.remove("plug", false);
    await send({ op: "transportState", state: "up" });
    await lamp;
    expect(seen.filter((e) => e[0] === "left")).toEqual([["left", "lamp"]]);
    await doer.stop();
    await expect(plug).rejects.toThrow("the doer stopped");
  });

  it("asks the core before letting in hardware out of the network, and keeps a refused one out", async () => {
    await lampJoins();
    expect(asked).toEqual(["lamp"]);
    await send({ op: "describe", device: "lamp", entry: { capabilities: ["onoff"], feedback: "closed" } });
    expect(asked).toEqual(["lamp"]);
    await doer.remove("lamp", false);
    refused.add("lamp");
    const n = seen.length;
    await send({ op: "admit", device: "lamp", how: "securedRejoin" });
    await send({ op: "describe", device: "lamp", entry: { capabilities: ["onoff"], feedback: "closed" } });
    await send({ op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    expect(seen.slice(n)).toEqual([]);
    expect(asked).toEqual(["lamp", "lamp", "lamp", "lamp"]);
    await send({ op: "report", device: "lamp", values: { on: true }, observedAt: new Date(clock.now()).toISOString() });
    expect(reply()).toMatchObject({ ok: false, error: "lamp has left the network" });
    refused.delete("lamp");
    await send({ op: "admit", device: "lamp", how: "securedRejoin" });
    expect(seen.slice(n).map((e) => e.slice(0, 2))).toEqual([["admitted", "lamp"], ["described", expect.anything()]]);
    // Refused while new, kept out, and let in once allowed.
    refused.add("plug");
    await send({ op: "describe", device: "plug", entry: { capabilities: ["onoff"], feedback: "closed" } });
    expect(seen.filter((e) => e[0] === "described" && (e[1] as Description).hardwareId === "plug")).toEqual([]);
    refused.delete("plug");
    await send({ op: "admit", device: "plug", how: "association" });
    expect(seen.filter((e) => e[0] === "described" && (e[1] as Description).hardwareId === "plug")).toHaveLength(1);
  });

  it("asks the core before an association or a trust-centre rejoin under the well-known key of hardware it has, and turns a refused one out", async () => {
    await lampJoins();
    const n = seen.length;
    await send({ op: "admit", device: "lamp", how: "securedRejoin" });
    await send({ op: "admit", device: "lamp", how: "tcRejoinUniqueKey" });
    expect(asked).toEqual(["lamp"]);
    await send({ op: "admit", device: "lamp", how: "association" });
    await send({ op: "admit", device: "lamp", how: "tcRejoinWellKnown" });
    expect(asked).toEqual(["lamp", "lamp", "lamp"]);
    refused.add("lamp");
    const m = seen.length;
    await send({ op: "admit", device: "lamp", how: "association" });
    expect(asked).toHaveLength(4);
    expect(seen.slice(m)).toEqual([["left", "lamp"]]);
    expect(seen.slice(n, m).map((e) => (e[0] === "admitted" ? e.slice(0, 3) : e.slice(0, 1)))).toEqual([
      ["admitted", "lamp", "securedRejoin"], ["described"], ["admitted", "lamp", "tcRejoinUniqueKey"], ["described"],
      ["admitted", "lamp", "association"], ["described"], ["admitted", "lamp", "tcRejoinWellKnown"], ["described"],
    ]);
  });

  it("opens no window while the coordinator does not answer", async () => {
    await send({ op: "transportState", state: "down" });
    await expect(doer.join(60_000)).rejects.toThrow("not answering");
    expect(received).toEqual([]);
  });
});

describe("ScriptedDoer, the doer's ops", () => {
  const NS = "org.galatea.test.pusher";
  const MODE = `${NS}.mode`;
  const setMode = { action: `${NS}.set_mode`, idempotent: true, stateless: false, confirms: false,
    args: { mode: ["click", "switch"] }, confirmedBy: { key: MODE, value: { arg: "mode" } } };
  /** A button pusher: set_mode only, until its mode is known; onoff, idempotent only in switch mode, after. */
  const entry = {
    capabilities: [], actions: [setMode], reachMs: 2500,
    extensions: [{ capability: NS, keys: [{ key: MODE, kind: "state", schema: { enum: ["click", "switch"] } }],
      actions: [{ action: setMode.action, schema: { enum: ["click", "switch"] } }] }],
  };
  const onoff = (idempotent: boolean) => [...closedActions("onoff", true).map((a) => ({ ...a, idempotent })), setMode];
  const bySetting = { key: MODE, entries: { click: { capabilities: ["onoff"], actions: onoff(false) },
    switch: { capabilities: ["onoff"], actions: onoff(true) } } };

  let wire: FakeWire;
  let clock: FakeClock;
  let doer: ScriptedDoer;
  let seen: unknown[][];

  async function start(settings?: Map<string, Record<string, unknown>>): Promise<void> {
    wire = new FakeWire();
    clock = new FakeClock();
    doer = new ScriptedDoer({ clock, onReceived: async () => {}, onStall: () => {} });
    const r = recorder();
    seen = r.seen;
    await doer.serve(wire, TOPIC);
    await doer.start(r.events, settings);
  }

  beforeEach(() => start());

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;
  const at = () => new Date(clock.now()).toISOString();
  const after = (n: number) => seen.slice(n).filter((e) => e[0] !== "transport");
  const described = () => seen.filter((e) => e[0] === "described").at(-1)![1] as Description;

  it("describes a device from its entry, the setting named, the setting's declarations left out until its value is known", async () => {
    await send({ op: "describe", device: "pusher", entry, bySetting });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(described()).toEqual({
      hardwareId: "pusher", stableIdentifier: "pusher", model: { vendor: "galatea", model: "scripted" }, capabilities: [],
      actions: [setMode], feedback: "closed", reachMs: 2500, proposedClass: null, classEvidence: "none", otherAdmins: "unknown",
      extensions: entry.extensions, settings: [MODE], basis: "report", cadenceMs: null, basisMaxAgeMs: SCRIPTED_MODEL_REPORT_MS,
    });
  });

  it("describes the device again before a setting that changes its declarations, and not for the same value", async () => {
    await send({ op: "describe", device: "pusher", entry, bySetting });
    const n = seen.length;
    const t = at();
    await send({ op: "setting", device: "pusher", key: MODE, value: "click", observedAt: t });
    expect(after(n).map((e) => e[0])).toEqual(["described", "observed"]);
    expect(described().actions).toEqual(onoff(false));
    expect(seen.at(-1)).toEqual(["observed", "pusher", { [MODE]: "click" }, Date.parse(t), true]);
    const m = seen.length;
    await send({ op: "setting", device: "pusher", key: MODE, value: "click", observedAt: at() });
    expect(after(m).map((e) => e[0])).toEqual(["observed"]);
  });

  it("declares from the setting the core kept across its restart", async () => {
    await start(new Map([["pusher", { [MODE]: "switch" }]]));
    await send({ op: "describe", device: "pusher", entry, bySetting });
    expect(described().actions).toEqual(onoff(true));
  });

  it("carries out an extension action, reaching its confirmedBy's value, and is described again for it", async () => {
    await send({ op: "describe", device: "pusher", entry, bySetting });
    const n = seen.length;
    expect(await doer.execute("pusher", setMode.action, { mode: "switch" }, clock.now() + 5000)).toEqual({ kind: "confirmed" });
    expect(after(n).map((e) => e[0])).toEqual(["described", "observed"]);
    expect(seen.at(-1)).toEqual(["observed", "pusher", { [MODE]: "switch" }, clock.now(), true]);
  });

  it("passes an occurrence and undescribed names on, nothing while the coordinator is down", async () => {
    await send({ op: "join", device: "bed", capabilities: ["sensor"], feedback: "closed" });
    const t = at();
    await send({ op: "occur", device: "bed", key: "org.galatea.test.bed.vibration", value: true, frameId: "tsn-1", observedAt: t });
    await send({ op: "undescribed", device: "bed", names: ["dp108"] });
    expect(seen.slice(-2)).toEqual([["occurred", "bed", "org.galatea.test.bed.vibration", true, Date.parse(t), "tsn-1"],
      ["undescribed", "bed", ["dp108"]]]);
    await send({ op: "transportState", state: "down" });
    const n = seen.length;
    await send({ op: "occur", device: "bed", key: "org.galatea.test.bed.vibration", value: true, frameId: "tsn-2", observedAt: at() });
    expect(after(n)).toEqual([]);
  });

  it("leaves, refuses the device's ops while it is gone, and admits it again with its declarations", async () => {
    await send({ op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    await send({ op: "leave", device: "lamp" });
    expect(seen.at(-1)).toEqual(["left", "lamp"]);
    await send({ op: "report", device: "lamp", values: { on: true }, observedAt: at() });
    expect(reply()).toMatchObject({ ok: false, error: "lamp has left the network" });
    expect(await doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000)).toMatchObject({ kind: "notSent", reason: "unreachable" });
    const n = seen.length;
    await send({ op: "admit", device: "lamp", how: "securedRejoin" });
    expect(after(n).map((e) => e.slice(0, 3))).toEqual([["admitted", "lamp", "securedRejoin"], ["described", expect.anything()]]);
    await send({ op: "admit", device: "socket", how: "association" });
    expect(reply()).toMatchObject({ ok: false, error: "no device socket has joined, so nothing is known to admit" });
  });

  it("answers the next command as protocolResult says", async () => {
    await send({ op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    const next = async (msg: Record<string, unknown>) => {
      await send({ op: "protocolResult", device: "lamp", ...msg });
      return doer.execute("lamp", "onoff.turn_on", {}, clock.now() + 5000);
    };
    expect(await next({ result: "refused", detail: "UNSUP_COMMAND" })).toEqual({ kind: "refused", reason: "refused", detail: "UNSUP_COMMAND" });
    expect(await next({ result: "refused", reason: "busy" })).toEqual({ kind: "refused", reason: "busy" });
    expect(await next({ result: "transmitted" })).toEqual({ kind: "transmitted" });
    expect(await next({ result: "lost", detail: "MAC_NO_ACK" })).toEqual({ kind: "lost", detail: "MAC_NO_ACK" });
    expect(await next({ result: "notSent", reason: "expired" })).toEqual({ kind: "notSent", reason: "expired" });
    // The control schema refuses a reason the result cannot carry.
    await send({ op: "protocolResult", device: "lamp", result: "notSent", reason: "busy" });
    expect(reply()).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
    await send({ op: "protocolResult", device: "lamp", result: "refused", reason: "unreachable" });
    expect(reply()).toMatchObject({ ok: false, error: expect.stringContaining("reason") });
  });

  it("answers windowState unsupported: the scripted network opens no window of its own", async () => {
    await send({ op: "windowState", open: true });
    expect(reply()).toMatchObject({ ok: false, unsupported: true });
  });

});

describe("ScriptedDoer, the network's facts", () => {
  let wire: FakeWire;
  let clock: FakeClock;
  let doer: ScriptedDoer;
  let seen: unknown[][];

  beforeEach(async () => {
    wire = new FakeWire();
    clock = new FakeClock();
    doer = new ScriptedDoer({ clock, onReceived: async () => {}, onStall: () => {} });
    const r = recorder();
    seen = r.seen;
    await doer.serve(wire, TOPIC);
    await doer.start(r.events);
  });

  const send = (msg: Record<string, unknown>) => wire.deliver(TOPIC, { requestId: "r1", ...msg });
  const reply = () => wire.last(`${TOPIC}/reply`)!.payload;
  const described = (hw: string) => seen.filter((e) => e[0] === "described" && (e[1] as Description).hardwareId === hw).at(-1)![1] as Description;
  const ACME = { vendor: "acme", model: "leak-1" };

  it("derives the bound from the reporting facts: twice the longest configured interval, else the model's, else null", async () => {
    await send({ op: "describe", device: "leak", entry: { capabilities: [], sensorKeys: ["leak"], model: ACME } });
    // No reporting configuration, and no model entry for acme's: the bound cannot be known.
    expect(described("leak").basisMaxAgeMs).toBeNull();
    await send({ op: "reporting", device: "leak", configuredMs: [300_000, 3_600_000], modelMs: 900_000 });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(described("leak").basisMaxAgeMs).toBe(7_200_000);
    await send({ op: "reporting", device: "leak", configuredMs: [], modelMs: 900_000 });
    expect(described("leak").basisMaxAgeMs).toBe(900_000);
    await send({ op: "reporting", device: "leak", configuredMs: [], modelMs: null });
    expect(described("leak").basisMaxAgeMs).toBeNull();
    // The facts outlive a description of the device again.
    await send({ op: "reporting", device: "leak", configuredMs: [60_000], modelMs: null });
    await send({ op: "describe", device: "leak", entry: { capabilities: [], sensorKeys: ["leak"], model: ACME } });
    expect(described("leak").basisMaxAgeMs).toBe(120_000);
  });

  it("takes the scripted model's entry, three times a poll's cadence, null for an open device, and never a bound from the entry", async () => {
    await send({ op: "join", device: "lamp", capabilities: ["onoff"], feedback: "closed" });
    expect(described("lamp").basisMaxAgeMs).toBe(SCRIPTED_MODEL_REPORT_MS);
    await send({ op: "describe", device: "meter", entry: { capabilities: [], sensorKeys: ["temperature"], model: ACME,
      basis: "poll", cadenceMs: 20_000, basisMaxAgeMs: 999_999_999 } });
    expect(described("meter")).toMatchObject({ basis: "poll", cadenceMs: 20_000, basisMaxAgeMs: 60_000 });
    await send({ op: "describe", device: "plug", entry: { capabilities: ["onoff"], feedback: "open" } });
    await send({ op: "reporting", device: "plug", configuredMs: [60_000], modelMs: null });
    expect(described("plug").basisMaxAgeMs).toBeNull();
    await send({ op: "reporting", device: "nas", configuredMs: [], modelMs: null });
    expect(reply()).toMatchObject({ ok: false, error: "no device nas has joined" });
  });

  it("polls a device described as polled at its cadence: each answer a check-in, none while it is silent, gone, or the coordinator is down", async () => {
    await send({ op: "describe", device: "meter", entry: { capabilities: [], sensorKeys: ["temperature"], model: ACME, basis: "poll", cadenceMs: 20_000 } });
    await send({ op: "describe", device: "probe", entry: { capabilities: [], sensorKeys: ["temperature"], model: ACME } });
    const checkIns = () => seen.filter((e) => e[0] === "observed" && e[1] === "meter").map((e) => [e[2], e[3], e[4]]);
    await clock.advance(19_999);
    expect(checkIns()).toEqual([]);
    await clock.advance(1);
    expect(checkIns()).toEqual([[{}, clock.now(), true]]);
    await clock.advance(20_000);
    expect(checkIns()).toHaveLength(2);
    // A device reporting on its own is never read.
    expect(seen.filter((e) => e[0] === "observed" && e[1] === "probe")).toEqual([]);
    // Silent: the read goes unanswered; answering again, the next read is answered.
    await send({ op: "silence", device: "meter", silent: true });
    await clock.advance(60_000);
    expect(checkIns()).toHaveLength(2);
    await send({ op: "silence", device: "meter", silent: false });
    await clock.advance(20_000);
    expect(checkIns()).toHaveLength(3);
    await send({ op: "transportState", state: "down" });
    await clock.advance(20_000);
    expect(checkIns()).toHaveLength(3);
    await send({ op: "transportState", state: "up" });
    // Described again as reporting on its own: no longer read.
    await send({ op: "describe", device: "meter", entry: { capabilities: [], sensorKeys: ["temperature"], model: ACME } });
    await clock.advance(60_000);
    expect(checkIns()).toHaveLength(3);
    // Polled again, then gone from the network: no read reaches it.
    await send({ op: "describe", device: "meter", entry: { capabilities: [], sensorKeys: ["temperature"], model: ACME, basis: "poll", cadenceMs: 20_000 } });
    await clock.advance(20_000);
    expect(checkIns()).toHaveLength(4);
    await send({ op: "leave", device: "meter" });
    await clock.advance(60_000);
    expect(checkIns()).toHaveLength(4);
  });

  it("stops polling when it stops", async () => {
    await send({ op: "describe", device: "meter", entry: { capabilities: [], model: ACME, basis: "poll", cadenceMs: 20_000 } });
    await doer.stop();
    await clock.advance(60_000);
    expect(seen.filter((e) => e[0] === "observed")).toEqual([]);
  });

  it("takes the class and its evidence from where it found it, never from the entry", async () => {
    await send({ op: "describe", device: "lamp", entry: { capabilities: ["onoff"], proposedClass: "socket", classEvidence: "protocol" } });
    expect(described("lamp")).toMatchObject({ proposedClass: null, classEvidence: "none" });
    for (const [from, evidence] of [["device", "protocol"], ["modelDb", "model_db"], ["guess", "none"]]) {
      await send({ op: "classFrom", device: "lamp", proposedClass: "light", from });
      expect(reply().ok).toBe(true);
      expect(described("lamp")).toMatchObject({ proposedClass: "light", classEvidence: evidence });
    }
  });

  it("keeps every device's otherAdmins unknown, a foreign binding taken: it reads no binding table", async () => {
    await send({ op: "describe", device: "valve", entry: { capabilities: ["onoff"], otherAdmins: [] } });
    await send({ op: "describe", device: "remote", entry: { capabilities: [] } });
    expect(described("valve").otherAdmins).toBe("unknown");
    await send({ op: "foreignBinding", device: "remote", target: "valve" });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(described("valve").otherAdmins).toBe("unknown");
    await send({ op: "foreignBinding", device: "remote", target: "boiler" });
    expect(reply()).toMatchObject({ ok: false, error: "no device boiler has joined" });
  });

  it("disables each native way it can, and reports the ways it cannot", async () => {
    await send({ op: "nativeControl", way: "touchlink", canDisable: true });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(seen.at(-1)).toEqual(["ungoverned", []]);
    await send({ op: "nativeControl", way: "a web frontend", canDisable: false });
    expect(seen.at(-1)).toEqual(["ungoverned", ["a web frontend"]]);
    await send({ op: "nativeControl", way: "a web frontend", canDisable: true });
    expect(seen.at(-1)).toEqual(["ungoverned", []]);
  });

  it("replays the ways it cannot disable to the events it starts with, so a nativeControl sent before start is kept", async () => {
    const w = new FakeWire();
    const early = new ScriptedDoer({ clock, onReceived: async () => {} });
    await early.serve(w, TOPIC);
    await w.deliver(TOPIC, { requestId: "r0", op: "nativeControl", way: "a web frontend", canDisable: false });
    const r = recorder();
    await early.start(r.events);
    expect(r.seen.filter((e) => e[0] === "ungoverned")).toEqual([["ungoverned", ["a web frontend"]]]);
  });

  it("describes a lock that requires a PIN, and hands the owner's PIN to the bridge, never to the core's events", async () => {
    const pins: [string, string][] = [];
    const w = new FakeWire();
    const r = recorder();
    const d = new ScriptedDoer({ clock, onReceived: async () => {}, onStall: () => {}, onPin: (hw, pin) => pins.push([hw, pin]) });
    await d.serve(w, TOPIC);
    await d.start(r.events);
    const last = () => r.seen.filter((e) => e[0] === "described").at(-1)![1] as Description;
    await w.deliver(TOPIC, { requestId: "r2", op: "describe", device: "door", entry: { capabilities: ["lock"] } });
    expect(last().pinRequired).toBeUndefined();
    await w.deliver(TOPIC, { requestId: "r2", op: "lockPin", device: "door", requiresPin: true });
    expect(last().pinRequired).toBe(true);
    expect(pins).toEqual([]);
    await w.deliver(TOPIC, { requestId: "r2", op: "lockPin", device: "door", requiresPin: true, pin: "40719263" });
    expect(pins).toEqual([["door", "40719263"]]);
    expect(JSON.stringify(r.seen)).not.toContain("40719263");
    await d.stop();
  });

  it("reports a state mismatch as its fault, and clears it", async () => {
    await send({ op: "stateMismatch", disagrees: true });
    expect(reply()).toEqual({ requestId: "r1", ok: true });
    expect(seen.at(-1)).toEqual(["fault", "state_mismatch", expect.stringContaining("another network")]);
    await send({ op: "stateMismatch", disagrees: false });
    expect(seen.at(-1)).toEqual(["fault", "state_mismatch", null]);
  });
});

describe("ScriptedDoer: the bridge 0.6 hooks", () => {
  const TOPIC6 = "t/test/zigbee/control6";
  async function doerWith(o: { settings?: Map<string, Record<string, unknown>>; reported?: Map<string, string[]>;
    describeMutation?: "maps-motion-to-occupancy" | "holds-back-the-leak" } = {}) {
    const wire = new FakeWire();
    const clock = new FakeClock();
    const doer = new ScriptedDoer({ clock, onReceived: async () => undefined, onStall: () => undefined,
      ...(o.describeMutation ? { describeMutation: o.describeMutation } : {}) });
    const r = recorder();
    await doer.serve(wire, TOPIC6);
    await doer.start(r.events, o.settings, o.reported);
    let sent = 0;
    const send = async (msg: Record<string, unknown>) => {
      const id = `r${++sent}`;
      await wire.deliver(TOPIC6, { requestId: id, ...msg });
      // An op may wait on an import (a library device's describing): its reply comes when it is done.
      for (let i = 0; i < 200 && wire.last(`${TOPIC6}/reply`)?.payload.requestId !== id; i++) await new Promise((r) => setTimeout(r, 10));
      expect(wire.last(`${TOPIC6}/reply`)!.payload, JSON.stringify(msg)).toMatchObject({ requestId: id, ok: true });
    };
    return { send, seen: r.seen, clock };
  }
  const SENSOR = { capabilities: ["sensor"], sensorKeys: ["occupancy", "temperature", "leak"], feedback: "closed" };
  const lastDescription = (seen: unknown[][]) => seen.filter((e) => e[0] === "described").at(-1)![1] as Description;

  it("does not interview hardware the core kept across its restart on its first description", async () => {
    const { send, seen } = await doerWith({ settings: new Map([["radar", {}]]) });
    await send({ op: "describe", device: "radar", entry: SENSOR });
    await send({ op: "describe", device: "lamp", entry: { capabilities: ["onoff"], feedback: "closed" } });
    expect(seen.filter((e) => e[0] === "interviewed")).toEqual([["interviewed", "lamp"]]);
  });

  it("interviews a device again on `interview`, before describing it by its settings' worst case", async () => {
    const { send, seen, clock } = await doerWith();
    await send({ op: "describe", device: "radar", entry: { ...SENSOR, settings: ["x.y.sens"] } });
    await send({ op: "setting", device: "radar", key: "x.y.sens", value: 3, observedAt: new Date(clock.now()).toISOString() });
    const n = seen.length;
    await send({ op: "interview", device: "radar" });
    expect(seen.slice(n).map((e) => e[0])).toEqual(["interviewed", "described"]);
  });

  it("holds back a numeric key its records name seen missing, never a boolean, and declares it before its first value", async () => {
    const { send, seen, clock } = await doerWith();
    await send({ op: "describe", device: "radar", entry: SENSOR, seenMissing: ["temperature", "leak"] });
    expect(lastDescription(seen)).toMatchObject({ sensorKeys: ["occupancy", "leak"], awaitedKeys: ["temperature"] });
    const n = seen.length;
    await send({ op: "report", device: "radar", values: { temperature: 20 }, observedAt: new Date(clock.now()).toISOString() });
    expect(seen.slice(n).map((e) => e[0])).toEqual(["described", "observed"]);
    expect(lastDescription(seen).sensorKeys).toEqual(["occupancy", "temperature", "leak"]);
    expect(lastDescription(seen).awaitedKeys).toBeUndefined();
  });

  it("never holds back again a key the core kept as reported; the mutation holds back the leak", async () => {
    const kept = await doerWith({ reported: new Map([["radar", ["temperature"]]]) });
    await kept.send({ op: "describe", device: "radar", entry: SENSOR, seenMissing: ["temperature"] });
    expect(lastDescription(kept.seen).awaitedKeys).toBeUndefined();
    const leaky = await doerWith({ describeMutation: "holds-back-the-leak" });
    await leaky.send({ op: "describe", device: "radar", entry: SENSOR, seenMissing: ["leak"] });
    expect(lastDescription(leaky.seen).awaitedKeys).toEqual(["leak"]);
  });

  it("describes a library device through the converters' mapping: a PIR's occupancy is motion, and the mutation keeps occupancy", async () => {
    for (const mutation of [undefined, "maps-motion-to-occupancy"] as const) {
      const { send, seen, clock } = await doerWith(mutation ? { describeMutation: mutation } : {});
      await send({ op: "libraryDevice", device: "pir", readings: [{ name: "occupancy", means: "movement" }] });
      const key = mutation ? "occupancy" : "motion";
      expect(lastDescription(seen)).toMatchObject({ capabilities: ["sensor"], sensorKeys: [key] });
      await send({ op: "report", device: "pir", values: { occupancy: false }, observedAt: new Date(clock.now()).toISOString() });
      expect(seen.at(-1)).toEqual(["observed", "pir", { [key]: false }, clock.now(), true]);
    }
  });
});
