import { afterEach, beforeEach, describe as group, expect, it, type MockInstance, vi } from "vitest";
import { Zdo } from "zigbee-herdsman";
import { findByDevice, type Definition } from "zigbee-herdsman-converters";
import * as reporting from "zigbee-herdsman-converters/lib/reporting";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { CONFIGURE_CALL_MS, CONFIGURE_MS, CONFIGURE_RETRY_MS, CONFIGURE_TRIES, type ConfigureCall, runConfigure } from "../src/herdsman/configure.js";
import { boundOf } from "../src/herdsman/describe.js";
import { HerdsmanDevices } from "../src/herdsman/devices.js";
import { HerdsmanDoer } from "../src/herdsman/doer.js";
import { POLL_BOUND_MS } from "../src/herdsman/polling.js";
import { Refused } from "../src/herdsman/guard.js";
import { FakeClock, settle } from "./fakes.js";
import { core, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";
import { reply, responseTimeout, stubAdapter } from "./zigbee-adapter.js";
import { COORDINATOR_ROW, devices, LIGHT, LIGHT_ROW, message, PUSHER, PUSHER_ROW } from "./zigbee-devices.js";

/**
 * Running `configure` (plan 2c-3): a definition's binds, reporting set-ups and reads reach herdsman's
 * own models over a stubbed adapter, nothing else does, and herdsman's device meta keeps the version
 * configured, from which the freshness bound follows.
 */

let db: ReturnType<typeof devices> | undefined;
let stub: ReturnType<typeof stubAdapter>;
let errors: MockInstance;
beforeEach(() => {
  stub = stubAdapter();
  // A read is answered with one attribute, a reporting set-up with its success.
  stub.answer((f) => (f.command.name === "read" ? reply(f, "readRsp", [{ attrId: 5, status: 0, dataType: 0x42, attrData: "TS0001" }])
    : f.command.name === "configReport" ? reply(f, "configReportRsp", [{ status: 0 }]) : reply(f, "defaultRsp", { cmdId: f.command.ID, statusCode: 0 })));
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stub.restore();
  errors.mockRestore();
  db?.close();
  db = undefined;
});

const COORDINATOR = COORDINATOR_ROW.ieeeAddr as string;
const coordinatorEndpoint = () => db!.get(COORDINATOR).endpoints[0]!;
/** The definition `of` the device, its `configure` replaced by `configure`. */
const withConfigure = (d: Definition, configure: Definition["configure"]): Definition => ({ ...d, configure });
/** A configure that binds genOnOff and sets its reporting up, as the converters' own helpers do. */
const reportingConfigure: Definition["configure"] = async (device, coordinator) => {
  const ep = device.getEndpoint(1)!;
  await reporting.bind(ep, coordinator, ["genOnOff"]);
  await reporting.onOff(ep);
};

group("runConfigure: a definition's configure on the device opened for it", () => {
  it("configures the button pusher: binds genOnOff to the coordinator, reads genBasic, and keeps its version in herdsman's meta", async () => {
    db = devices([PUSHER_ROW]);
    const device = db.get(PUSHER);
    const definition = (await findByDevice(device, true))!;
    const calls: ConfigureCall[] = [];
    const r = await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), calls });
    expect(r).toEqual({ outcome: "configured" });
    expect(calls.map((c) => `${c.call} ${String(c.cluster)}`)).toEqual(["bind genOnOff", "read genBasic"]);
    expect(calls[1]!.options).toMatchObject({ sendPolicy: "immediate" });
    expect(stub.zdo).toEqual([{ ieee: PUSHER, clusterId: Zdo.ClusterId.BIND_REQUEST }]);
    expect(stub.handed.map((h) => `${h.cluster}.${h.command}`)).toEqual(["genBasic.read"]);
    expect(device.meta.configured).toBe(definition.version);
    expect(device.getEndpoint(1)!.binds.map((b) => (b.target as Zh.Endpoint).deviceIeeeAddress)).toEqual([COORDINATOR]);
    // A bind alone sets no periodic report: no bound.
    expect(boundOf(device, definition)).toBeNull();
  });

  it("sets reporting up, each set-up sent at once, and the bound follows from what herdsman recorded", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const definition = withConfigure((await findByDevice(device, true))!, reportingConfigure);
    const calls: ConfigureCall[] = [];
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), calls })).toEqual({ outcome: "configured" });
    expect(calls.map((c) => c.call)).toEqual(["bind", "configureReporting"]);
    expect(calls[1]!.options).toMatchObject({ sendPolicy: "immediate" });
    expect(stub.handed.map((h) => `${h.cluster}.${h.command}`)).toEqual(["genOnOff.configReport"]);
    expect(device.getEndpoint(1)!.configuredReportings.map((c) => c.maximumReportInterval)).toEqual([3600]);
    expect(boundOf(device, definition)).toBe(7_200_000);
  });

  it("sends its reporting set-ups and reads without herdsman's recovery, under CONFIGURE_CALL_MS each, whatever the converter gave (plan 2c-3 review I1)", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const definition = withConfigure((await findByDevice(device, true))!, async (d, coordinator) => {
      const ep = d.getEndpoint(1)!;
      await reporting.bind(ep, coordinator, ["genOnOff"]);
      await reporting.onOff(ep);
      await ep.read("genBasic", ["modelId"], { timeout: 30_000, disableRecovery: false });
    });
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() })).toEqual({ outcome: "configured" });
    expect(stub.handed.map((h) => ({ frame: `${h.cluster}.${h.command}`, disableRecovery: h.disableRecovery, timeout: h.timeout })))
      .toEqual([{ frame: "genOnOff.configReport", disableRecovery: true, timeout: CONFIGURE_CALL_MS },
        { frame: "genBasic.read", disableRecovery: true, timeout: CONFIGURE_CALL_MS }]);
    // Five seconds: one call holds the device's place in herdsman's adapter queue no longer than that.
    expect(CONFIGURE_CALL_MS).toBe(5_000);
  });

  it("sends the button pusher's magic read without herdsman's recovery (the review's probe)", async () => {
    db = devices([PUSHER_ROW]);
    const device = db.get(PUSHER);
    const definition = (await findByDevice(device, true))!;
    await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() });
    expect(stub.handed.map((h) => ({ frame: `${h.cluster}.${h.command}`, disableRecovery: h.disableRecovery, timeout: h.timeout })))
      .toEqual([{ frame: "genBasic.read", disableRecovery: true, timeout: CONFIGURE_CALL_MS }]);
  });

  it("gives configure the coordinator's endpoint opened as the device's: a call the run does not open is refused there too (plan 2c-3 review M5)", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const definition = withConfigure((await findByDevice(device, true))!, async (_d, coordinator) => {
      await coordinator.command("genOnOff", "on", {});
    });
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() })).toEqual({ outcome: "refused" });
    expect(stub.handed).toEqual([]);
    expect(device.meta.configured).toBeUndefined();
  });

  it("refuses a configure that writes, commands or binds to a group: nothing of those sent, no version kept, and says so", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const base = (await findByDevice(device, true))!;
    for (const step of [
      (ep: Zh.Endpoint) => ep.write("genOnOff", { onTime: 1 }),
      (ep: Zh.Endpoint) => ep.command("genOnOff", "on", {}),
      (ep: Zh.Endpoint) => ep.bind("genOnOff", 901),
      (ep: Zh.Endpoint) => ep.unbind("genOnOff", 901),
    ]) {
      const r = await runConfigure(withConfigure(base, async (d) => {
        await step(d.getEndpoint(1)!);
      }), device, coordinatorEndpoint(), { clock: new FakeClock() });
      expect(r).toEqual({ outcome: "refused" });
    }
    // Refused though the converter swallowed the refusal and went on: the guard counts it.
    const swallowed = await runConfigure(withConfigure(base, async (d) => {
      await d.getEndpoint(1)!.write("genOnOff", { onTime: 1 }).catch(() => {});
    }), device, coordinatorEndpoint(), { clock: new FakeClock() });
    expect(swallowed).toEqual({ outcome: "refused" });
    expect(stub.handed).toEqual([]);
    expect(stub.zdo).toEqual([]);
    expect(device.meta.configured).toBeUndefined();
  });

  it("fails, keeping no version, when the device does not answer or refuses, in its own words, never herdsman's", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    const definition = withConfigure((await findByDevice(device, true))!, reportingConfigure);
    stub.answer(() => responseTimeout());
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() }))
      .toEqual({ outcome: "failed", detail: "the device did not answer in time" });
    stub.answer((f) => reply(f, "configReportRsp", [{ status: 0x86 }]));
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() }))
      .toEqual({ outcome: "failed", detail: "the device answered UNSUPPORTED_ATTRIBUTE" });
    stub.answerZdo(Zdo.Status.NOT_SUPPORTED);
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() }))
      .toEqual({ outcome: "failed", detail: "the stack failed after the command was handed to it" });
    // A configure that throws at once, before any call.
    expect(await runConfigure(withConfigure(definition, () => {
      throw new Error("0x00124b0012345678 payload");
    }), device, coordinatorEndpoint(), { clock: new FakeClock() })).toEqual({ outcome: "failed", detail: "the stack failed after the command was handed to it" });
    expect(device.meta.configured).toBeUndefined();
    expect(device.getEndpoint(1)!.configuredReportings).toEqual([]);
  });

  it("fails a configure that has not ended within CONFIGURE_MS, and refuses what it sends after", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let after: Promise<unknown> | undefined;
    const definition = withConfigure((await findByDevice(device, true))!, async (d, coordinator) => {
      await held;
      after = d.getEndpoint(1)!.bind("genOnOff", coordinator);
      await after;
    });
    const clock = new FakeClock();
    const run = runConfigure(definition, device, coordinatorEndpoint(), { clock });
    await settle();
    await clock.advance(CONFIGURE_MS - 1);
    let done = false;
    void run.then(() => { done = true; });
    await settle();
    expect(done).toBe(false);
    await clock.advance(1);
    expect(await run).toEqual({ outcome: "failed", detail: `configure did not end within ${CONFIGURE_MS} ms` });
    release();
    await settle();
    await expect(after).rejects.toBeInstanceOf(Refused);
    expect(stub.zdo).toEqual([]);
    expect(device.meta.configured).toBeUndefined();
  });

  it("refuses a call configure makes after it returned, from a timer, and keeps the version", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    let late: Promise<unknown> | undefined;
    const definition = withConfigure((await findByDevice(device, true))!, async (d, coordinator) => {
      setTimeout(() => { late = d.getEndpoint(1)!.bind("genOnOff", coordinator); }, 0);
    });
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock() })).toEqual({ outcome: "configured" });
    await new Promise((r) => setTimeout(r, 5));
    await expect(late).rejects.toBeInstanceOf(Refused);
    expect(stub.zdo).toEqual([]);
    expect(device.meta.configured).toBe(definition.version);
  });

  it("fails a run cut short by its caller, sending nothing after the cut and keeping no version", async () => {
    db = devices([LIGHT_ROW]);
    const device = db.get(LIGHT);
    let gate: { closed?: boolean } | undefined;
    const definition = withConfigure((await findByDevice(device, true))!, async (d, coordinator) => {
      gate!.closed = true;
      await d.getEndpoint(1)!.bind("genOnOff", coordinator).catch(() => {});
    });
    expect(await runConfigure(definition, device, coordinatorEndpoint(), { clock: new FakeClock(), opened: (g) => { gate = g; } }))
      .toEqual({ outcome: "failed", detail: "the controller closed while configure ran" });
    expect(stub.zdo).toEqual([]);
    expect(device.meta.configured).toBeUndefined();
  });
});

group("HerdsmanDevices: when configure runs", () => {
  /** A device layer over herdsman's models of `rows`, every definition's configure as `configure`, the coordinator's endpoint given. */
  async function layer(rows: Record<string, unknown>[], configure: Definition["configure"],
    extra: { noActions?: boolean; coordinator?: boolean; version?: () => string } = {}) {
    db = devices(rows);
    const clock = new FakeClock();
    const { events, seen } = core();
    let runs = 0;
    const counted: Definition["configure"] = async (...a) => {
      runs += 1;
      await configure!(...a);
    };
    const l = new HerdsmanDevices({ clock, events: () => events, ...(extra.noActions ? { noActions: true } : {}),
      definitionOf: async (d) => ({ ...withConfigure((await findByDevice(d, true))!, counted), ...(extra.version ? { version: extra.version() } : {}) }),
      ...(extra.coordinator === false ? {} : { coordinator: () => coordinatorEndpoint() }) });
    const flush = async () => {
      await settle();
      await l.idle();
      await settle();
      await l.idle();
    };
    return { l, clock, seen, flush, runs: () => runs };
  }
  const report = (ieee: string, tsn: number) => message(db!.get(ieee), { cluster: "genOnOff", command: "report", global: true, tsn,
    payload: [{ attrId: 0, dataType: 16, attrData: 1 }] }) as never;

  it("configures a router when it is described; polled, it keeps its poll's bound, its reporting's known beside it (plan 5b)", async () => {
    const { l, seen, flush, runs } = await layer([LIGHT_ROW], reportingConfigure);
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(1);
    const described = seen.filter((e) => e[0] === "described").map((e) => (e[1] as { basis: string; basisMaxAgeMs: number | null }))
      .map((d) => [d.basis, d.basisMaxAgeMs]);
    expect(described).toEqual([["poll", POLL_BOUND_MS]]);
    expect(boundOf(db!.get(LIGHT), l.target(LIGHT)!.definition)).toBe(7_200_000);
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(`zigbee: ${LIGHT}: configured (${(await findByDevice(db!.get(LIGHT), true))!.model}, version 0.0.0)`);
  });

  it("configures an end device only once heard, or right after its interview: it sleeps otherwise", async () => {
    const { l, flush, runs } = await layer([PUSHER_ROW], async () => {});
    await l.add(db!.get(PUSHER));
    await flush();
    expect(runs()).toBe(0);
    await l.heard(report(PUSHER, 1));
    await flush();
    expect(runs()).toBe(1);
    // Interviewed again, at a new version: configured at once.
    db!.get(PUSHER).meta.configured = "0.0.9";
    await l.add(db!.get(PUSHER), true);
    await flush();
    expect(runs()).toBe(2);
  });

  it("configures once per version: never again while herdsman's meta keeps it, a restart included", async () => {
    const { l, flush, runs } = await layer([LIGHT_ROW], async () => {});
    await l.add(db!.get(LIGHT));
    await flush();
    await l.heard(report(LIGHT, 2));
    await l.add(db!.get(LIGHT), true);
    await l.clear();
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(1);
    expect(db!.get(LIGHT).meta.configured).toBe("0.0.0");
  });

  it("tries a failed configure again at the device's next message, no sooner than CONFIGURE_RETRY_MS after its last try", async () => {
    const { l, clock, flush, runs } = await layer([LIGHT_ROW], reportingConfigure);
    stub.answer(() => responseTimeout());
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(1);
    await clock.advance(CONFIGURE_RETRY_MS - 1);
    await l.heard(report(LIGHT, 3));
    await flush();
    expect(runs()).toBe(1);
    await clock.advance(1);
    stub.answer((f) => reply(f, "configReportRsp", [{ status: 0 }]));
    await l.heard(report(LIGHT, 4));
    await flush();
    expect(runs()).toBe(2);
    expect(db!.get(LIGHT).meta.configured).toBe("0.0.0");
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toContain(`zigbee: ${LIGHT}: configure (${(await findByDevice(db!.get(LIGHT), true))!.model}) failed: the device did not answer in time; tried again at its next message`);
  });

  it("gives up a configure that failed CONFIGURE_TRIES times at its version, until the device is interviewed again (plan 2c-3 review M4)", async () => {
    const { l, clock, flush, runs } = await layer([LIGHT_ROW], reportingConfigure);
    stub.answer(() => responseTimeout());
    await l.add(db!.get(LIGHT));
    await flush();
    for (let tsn = 10; tsn < 14; tsn++) {
      await clock.advance(CONFIGURE_RETRY_MS);
      await l.heard(report(LIGHT, tsn));
      await flush();
    }
    expect(CONFIGURE_TRIES).toBe(3);
    expect(runs()).toBe(CONFIGURE_TRIES);
    const model = (await findByDevice(db!.get(LIGHT), true))!.model;
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged.filter((l) => l.includes("failed"))).toEqual([
      `zigbee: ${LIGHT}: configure (${model}) failed: the device did not answer in time; tried again at its next message`,
      `zigbee: ${LIGHT}: configure (${model}) failed: the device did not answer in time; tried again at its next message`,
      `zigbee: ${LIGHT}: configure (${model}) failed: the device did not answer in time; given up after ${CONFIGURE_TRIES} tries, until the bridge restarts or the device is interviewed again`]);
    // Interviewed again: tried afresh.
    await l.add(db!.get(LIGHT), true);
    await flush();
    expect(runs()).toBe(CONFIGURE_TRIES + 1);
  });

  it("counts a configure's failures per definition version, and forgets them for a device removed", async () => {
    let version = "1.0.0";
    const { l, clock, flush, runs } = await layer([LIGHT_ROW], reportingConfigure, { version: () => version });
    stub.answer(() => responseTimeout());
    const heard = async (tsn: number) => {
      await clock.advance(CONFIGURE_RETRY_MS);
      await l.heard(report(LIGHT, tsn));
      await flush();
    };
    await l.add(db!.get(LIGHT));
    await flush();
    await heard(20);
    expect(runs()).toBe(2);
    // A new version, described again at a controller's start: its own three tries.
    version = "1.0.1";
    await l.add(db!.get(LIGHT));
    await flush();
    for (const tsn of [21, 22, 23]) await heard(tsn);
    expect(runs()).toBe(5);
    // Removed, and described again without an interview: tried afresh.
    await l.remove(LIGHT);
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(6);
  });

  it("tries a refused configure again once the device was removed and joined again (plan 2c-3 review M5)", async () => {
    const { l, flush, runs } = await layer([LIGHT_ROW], async (d) => {
      await d.getEndpoint(1)!.write("genOnOff", { onTime: 1 });
    });
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(1);
    await l.remove(LIGHT);
    await l.add(db!.get(LIGHT), true);
    await flush();
    expect(runs()).toBe(2);
  });

  it("never tries again a configure the guard refused, and keeps no bound", async () => {
    const { l, clock, seen, flush, runs } = await layer([LIGHT_ROW], async (d) => {
      await d.getEndpoint(1)!.write("genOnOff", { onTime: 1 });
    });
    await l.add(db!.get(LIGHT));
    await flush();
    await clock.advance(CONFIGURE_RETRY_MS * 3);
    await l.heard(report(LIGHT, 5));
    await flush();
    expect(runs()).toBe(1);
    expect(stub.handed).toEqual([]);
    expect(seen.filter((e) => e[0] === "described")).toHaveLength(1);
  });

  it("runs no configure under the owner's switch, nor while no controller gives the coordinator", async () => {
    for (const extra of [{ noActions: true }, { coordinator: false }]) {
      const { l, flush, runs } = await layer([LIGHT_ROW], reportingConfigure, extra);
      await l.add(db!.get(LIGHT), true);
      await l.heard(report(LIGHT, 6));
      await flush();
      expect(runs()).toBe(0);
      db!.close();
    }
    expect(stub.handed).toEqual([]);
    expect(stub.zdo).toEqual([]);
  });

  it("cuts a configure under way when the controller closes: nothing it sends later reaches herdsman", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let after: Promise<unknown> | undefined;
    const { l, flush, runs } = await layer([LIGHT_ROW], async (d, coordinator) => {
      await held;
      after = d.getEndpoint(1)!.bind("genOnOff", coordinator);
      await after;
    });
    await l.add(db!.get(LIGHT));
    await flush();
    expect(runs()).toBe(1);
    await l.clear();
    release();
    await flush();
    await expect(after).rejects.toBeInstanceOf(Refused);
    expect(stub.zdo).toEqual([]);
    expect(db!.get(LIGHT).meta.configured).toBeUndefined();
  });
});

group("HerdsmanDoer: configure with the controller's coordinator", () => {
  /** A doer over a fake stack whose herdsman has the button pusher, its coordinator's endpoint given. */
  async function started(noActions = false) {
    db = devices([PUSHER_ROW]);
    const { made, make } = stacks((s) => {
      s.had.add(PUSHER);
      s.lookup = (ieee) => db!.get(ieee);
      s.coordinator = () => coordinatorEndpoint();
    });
    const doer = new HerdsmanDoer({ clock: new FakeClock(), coordinator: "tcp://127.0.0.1:1", dataDir: "/nonexistent", makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES, ...(noActions ? { noActions: true } : {}) });
    await doer.start(core().events, new Map());
    await settle();
    await doer.idle();
    return { doer, stack: made[0]! };
  }

  it("leaves the sleeping button pusher alone at the start, and configures it once its interview is done", async () => {
    const { doer, stack } = await started();
    expect(stub.zdo).toEqual([]);
    stack.events.interviewed(PUSHER, "successful");
    await settle();
    await doer.idle();
    await settle();
    expect(stub.zdo).toEqual([{ ieee: PUSHER, clusterId: Zdo.ClusterId.BIND_REQUEST }]);
    expect(db!.get(PUSHER).meta.configured).toBe("0.0.0");
    await doer.stop();
  });

  it("configures nothing under the owner's switch", async () => {
    const { doer, stack } = await started(true);
    stack.events.interviewed(PUSHER, "successful");
    await settle();
    await doer.idle();
    await settle();
    expect(stub.zdo).toEqual([]);
    expect(stub.handed).toEqual([]);
    await doer.stop();
  });
});
