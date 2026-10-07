import { describe, expect, it } from "vitest";
import { ending } from "../src/safety/engine.js";
import type { Mutation } from "../src/mutations.js";
import { body, flush, home, LEAK, rule } from "./safe-home.js";

// covers: GA-SAFE-12 and GA-SAFE-8's waiting and late_ack notices within one life; a run waiting across a restart is GA-PERSIST-1's (slice 7), untested here.

type Home = Awaited<ReturnType<typeof home>>;
const latch = { latch: { condition: { ...LEAK, value: false } } };
const short = (o: { outcome: string; reason?: string }) => `${o.outcome}${o.reason ? `(${o.reason})` : ""}`;
const at = (m: Home) => new Date(m.clock.now()).toISOString();

/** The device's `available` flag, as its bridge reports it: false makes it dead at once. */
const available = (m: Home, device: string, up: boolean) => m.send(`devices/${device}/status`, { deviceId: device, available: up, timestamp: at(m) });

/** The action's bound, in ms, as `describe` gives it. */
async function bound(m: Home, target: string, action: string): Promise<number> {
  const d = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === target);
  return d.actions.find((a: any) => a.action === action).ack_within_s * 1000;
}

/** Each action a test sends, bound to 10 s: past 30 s the bridge, silent in a unit test, is found dead. */
const BOUNDS = [["hall:valve", "valve.close"], ["hall:pulse", "onoff.turn_off"], ["hall:ac", "climate.set_mode"]]
  .map(([device, action]) => ({ op: "upsert", kind: "ack_within_s", value: { device, action, ack_within_s: 10 } }));

async function fired(o: { mutation?: Mutation } = {}, r = rule(latch)) {
  const m = await home(o);
  body(await m.configure([...BOUNDS, r]));
  const c = await m.cursor();
  return { m, c };
}

describe("GA-SAFE-12's classes of a final outcome", () => {
  it("parts landed, final, nothing ran, may have run and unanswered", () => {
    expect(["acked", "delivered", "sent"].map((outcome) => ending({ outcome } as never))).toEqual(["landed", "landed", "landed"]);
    expect(ending({ outcome: "skipped", reason: "dead" })).toBe("nothing_ran");
    expect(ending({ outcome: "unreachable" })).toBe("nothing_ran");
    expect(ending({ outcome: "failed", reason: "rejected" })).toBe("nothing_ran");
    expect(ending({ outcome: "failed", reason: "no_ack" })).toBe("may_have_run");
    expect(ending({ outcome: "unanswered" })).toBe("unanswered");
    // A lock nothing can take, or nothing to lock, is not tried for ever (GA-BRIDGE-66).
    expect(ending({ outcome: "failed", reason: "not_locked" })).toBe("final");
    expect(ending({ outcome: "failed", reason: "no_graphical_session" })).toBe("final");
    for (const x of [{ outcome: "refused", reason: "toggle_only" }, { outcome: "skipped", reason: "unsupported_action" },
      { outcome: "failed", reason: "unsupported_action" }, { outcome: "failed", reason: "invalid_request" },
      { outcome: "failed", reason: "unknown_device" }]) expect(ending(x as never)).toBe("final");
  });
});

describe("a safety rule's re-sends (GA-SAFE-12)", () => {
  it("sends a close skipped on a dead valve at once on its return; a waiting notice at once, replaced by the completion notice; guarded until complete (GA-SAFE-8, GA-SAFE-2, GA-SAFE-3)", async () => {
    const { m, c } = await fired();
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent).toEqual([]);
    const [waiting] = await m.notices("safety_rule");
    expect(waiting).toMatchObject({ rule_id: "leak-closes-valve", waiting: true, outcomes: [{ target: "hall:valve", outcome: "skipped", reason: "dead" }] });
    expect(await m.events(c, "rule_fired")).toEqual([]);
    // Its return from dead sends at once, whatever the bound.
    available(m, "valve", true);
    await flush();
    expect(m.sent.map((x) => [x.device, x.body.value.action])).toEqual([["valve", "valve.close"]]);
    expect((await m.apply("hall:valve", "valve.open")).outcomes[0].reason).toBe("safety");
    expect((await m.events(c, "outcome")).filter((e: any) => e.rule_id).at(-1)).toMatchObject({ rule_id: "leak-closes-valve", step_id: "s1.2", outcome: "dispatched" });
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    await flush();
    const [done] = await m.events(c, "rule_fired");
    expect(done.outcomes.map(short)).toEqual(["acked"]);
    const notices = await m.notices("safety_rule");
    expect(notices.map((n: any) => n.notice_id)).toEqual([done.notice]);
  });

  it("gives up on a dead valve under gives-up-on-dead: complete at once, no waiting notice, nothing sent on its return", async () => {
    const { m, c } = await fired({ mutation: "gives-up-on-dead" });
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    expect((await m.events(c, "rule_fired"))[0].outcomes.map(short)).toEqual(["skipped(dead)"]);
    expect((await m.notices("safety_rule")).filter((n: any) => n.waiting)).toEqual([]);
    available(m, "valve", true);
    await flush();
    expect(m.sent).toEqual([]);
  });

  it("sends an idempotent close that ended failed(no_ack) again while the valve does not report closed", async () => {
    const { m, c } = await fired();
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(await bound(m, "hall:valve", "valve.close") + 1000);
    await flush();
    expect(m.sent.length).toBe(2);
    expect((await m.notices("safety_rule")).find((n: any) => n.waiting)).toBeDefined();
    m.ack(m.sent[1]!, "applied");
    m.report("valve", { open: false });
    await flush();
    expect((await m.events(c, "rule_fired"))[0].outcomes.map(short)).toEqual(["acked"]);
  });

  it("gives the re-send a new commandId, the attempt a new command, each a version 5 UUID (the maintainer's ruling 2)", async () => {
    const { m } = await fired();
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(await bound(m, "hall:valve", "valve.close") + 1000);
    await flush();
    const ids = m.sent.filter((s) => s.device === "valve").map((s) => s.body.commandId as string);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  // One home per test: several in one outlast the test's bound under a parallel run.
  it.each([undefined, "resends-what-may-have-run" as const])(
    "never sends a non-idempotent turn_off that ended failed(no_ack) again, its notice saying so, but under resends-what-may-have-run (GA-SAFE-5), mutation %s", async (mutation) => {
      const p = await fired({ mutation }, { op: "upsert", kind: "safety_rule", value: { id: "leak-cuts-pump", trigger: LEAK,
        actions: [{ target: "hall:pulse", action: "onoff.turn_off" }], ...latch } });
      p.m.report("leak", { leak: true });
      await flush();
      p.m.clock.advance(await bound(p.m, "hall:pulse", "onoff.turn_off") + 1000);
      await flush();
      expect(p.m.sent.length).toBe(mutation ? 2 : 1);
      if (!mutation) {
        const [n] = await p.m.notices("safety_rule");
        expect(n.outcomes.map(short)).toEqual(["failed(no_ack)"]);
        expect(n.text).toMatch(/not sent again: it may have run, and is not idempotent/);
      }
    });

  it("spaces attempts that did not run by the action's bound after the last began", async () => {
    const { m } = await fired();
    m.report("leak", { leak: true });
    await flush();
    const ms = await bound(m, "hall:valve", "valve.close");
    m.clock.advance(100);
    m.send("devices/valve/ack", { commandId: m.sent[0]!.body.commandId, source: "hall-bridge", result: "failed", reason: "rejected", timestamp: at(m) });
    await flush();
    m.clock.advance(ms - 300);
    await flush();
    expect(m.sent.length).toBe(1);
    m.clock.advance(300);
    await flush();
    expect(m.sent.length).toBe(2);
  });

  it("sends an idempotent action unanswered on an open device once more, then no more", async () => {
    const { m, c } = await fired({}, { op: "upsert", kind: "safety_rule", value: { id: "leak-stops-ac", trigger: LEAK,
      actions: [{ target: "hall:ac", action: "climate.set_mode", args: { mode: "off" } }], ...latch } });
    m.report("leak", { leak: true });
    await flush();
    const ms = await bound(m, "hall:ac", "climate.set_mode");
    m.clock.advance(ms + 1000);
    await flush();
    expect(m.sent.length).toBe(2);
    m.clock.advance(ms + 1000);
    await flush();
    m.clock.advance(ms + 1000);
    await flush();
    expect(m.sent.length).toBe(2);
    const [f] = await m.events(c, "rule_fired");
    expect(f.outcomes.map(short)).toEqual(["unanswered"]);
    expect((await m.notices("safety_rule")).at(-1).text).toMatch(/nothing will say whether it ran/);
  });

  it("stops wanting a rule without a latch once its trigger is false: complete with the last attempt's outcome", async () => {
    const { m, c } = await fired({}, rule());
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    expect(await m.events(c, "rule_fired")).toEqual([]);
    m.clock.advance(1000);
    m.report("leak", { leak: false });
    expect((await m.events(c, "rule_fired"))[0].outcomes.map(short)).toEqual(["skipped(dead)"]);
    available(m, "valve", true);
    await flush();
    expect(m.sent).toEqual([]);
  });

  it("takes a report matching a waiting close as landed: complete, its notice saying so", async () => {
    const { m, c } = await fired();
    m.report("leak", { leak: true });
    await flush();
    m.send("devices/valve/ack", { commandId: m.sent[0]!.body.commandId, source: "hall-bridge", result: "failed", reason: "rejected", timestamp: at(m) });
    await flush();
    m.report("valve", { open: false });
    const [f] = await m.events(c, "rule_fired");
    expect(f.outcomes.map(short)).toEqual(["failed(rejected)"]);
    expect((await m.notices("safety_rule")).at(-1).text).toMatch(/hall:valve did what it was asked/);
  });

  it("sends a close waiting on a dead valve on its return though the valve last reported closed before the rule fired", async () => {
    const { m, c } = await fired();
    m.report("valve", { open: false });
    m.clock.advance(1000);
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    m.report("leak", { leak: true, battery: 90 });
    available(m, "valve", true);
    await flush();
    expect(m.sent.map((x) => x.body.value.action)).toEqual(["valve.close"]);
    m.ack(m.sent[0]!, "applied");
    m.report("valve", { open: false });
    await flush();
    expect((await m.events(c, "rule_fired"))[0].outcomes.map(short)).toEqual(["acked"]);
  });

  it("raises one waiting notice while a live valve keeps refusing its close for the same reason, an attempt each bound (GA-SAFE-8)", async () => {
    const { m } = await fired();
    m.report("leak", { leak: true });
    await flush();
    const ms = await bound(m, "hall:valve", "valve.close");
    const reject = (i: number) => m.send("devices/valve/ack", { commandId: m.sent[i]!.body.commandId, source: "hall-bridge", result: "failed",
      reason: "rejected", timestamp: at(m) });
    m.clock.advance(100);
    reject(0);
    await flush();
    const [first] = (await m.notices("safety_rule")).filter((n: any) => n.waiting);
    for (const i of [1, 2]) {
      m.clock.advance(ms);
      await flush();
      expect(m.sent.length).toBe(i + 1);
      reject(i);
      await flush();
    }
    expect((await m.notices("safety_rule")).filter((n: any) => n.waiting).map((n: any) => n.notice_id)).toEqual([first.notice_id]);
  });

  it("takes a failed(not_locked) as final: not sent again, the completion notice saying why (GA-BRIDGE-66)", async () => {
    // The valve stands in for a computer's session.lock: the engine reads the reason, whatever the action.
    const { m, c } = await fired();
    m.report("leak", { leak: true });
    await flush();
    m.send("devices/valve/ack", { commandId: m.sent[0]!.body.commandId, source: "hall-bridge", result: "failed", reason: "not_locked", timestamp: at(m) });
    await flush();
    const [f] = await m.events(c, "rule_fired");
    expect(f.outcomes.map(short)).toEqual(["failed(not_locked)"]);
    expect((await m.notices("safety_rule")).find((n: any) => n.notice_id === f.notice).text).toMatch(/not sent again: .*not_locked/);
    m.clock.advance(await bound(m, "hall:valve", "valve.close") + 1000);
    await flush();
    expect(m.sent.length).toBe(1);
  });

  it("withdraws the waiting notice of a rule deleted while it waited", async () => {
    const { m } = await fired();
    available(m, "valve", false);
    m.report("leak", { leak: true });
    await flush();
    expect((await m.notices("safety_rule")).filter((n: any) => n.waiting).length).toBe(1);
    body(await m.configure([{ op: "delete", kind: "safety_rule", value: { id: "leak-closes-valve" } }]));
    const left = await m.notices("safety_rule");
    expect(left.filter((n: any) => n.waiting)).toEqual([]);
    expect(left.map((n: any) => n.text)).toEqual([expect.stringMatching(/was deleted while it ran/)]);
  });

  it("takes a late_ack as landing a waiting close, though the bridge's clock stamped its report before the rule fired", async () => {
    const { m, c } = await fired();
    const leakAt = m.clock.now();
    m.report("leak", { leak: true });
    await flush();
    // The valve dies before the close's bound: it ends failed(no_ack) and waits for the valve's return.
    m.clock.advance(5000);
    available(m, "valve", false);
    m.clock.advance(await bound(m, "hall:valve", "valve.close"));
    await flush();
    expect(await m.events(c, "rule_fired")).toEqual([]);
    // It reports closed, stamped by a bridge clock 2 s behind the applier's firing.
    m.report("valve", { open: false }, leakAt - 2000);
    await flush();
    expect((await m.events(c, "late_ack")).length).toBe(1);
    const [f] = await m.events(c, "rule_fired");
    expect(f.outcomes.map(short)).toEqual(["failed(no_ack)"]);
    expect(m.sent.length).toBe(1);
  });
});

describe("a safety rule's late_ack (GA-SAFE-8)", () => {
  it("gives a failed actuation's later late_ack a second notice, once the rule is complete", async () => {
    const { m, c } = await fired({}, { op: "upsert", kind: "safety_rule", value: { id: "leak-cuts-pump", trigger: LEAK,
      actions: [{ target: "hall:pulse", action: "onoff.turn_off" }] } });
    m.report("pulse", { on: true });
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(await bound(m, "hall:pulse", "onoff.turn_off") + 1000);
    await flush();
    expect((await m.events(c, "rule_fired"))[0].outcomes.map(short)).toEqual(["failed(no_ack)"]);
    m.report("pulse", { on: false });
    expect((await m.events(c, "late_ack"))[0]).toMatchObject({ rule_id: "leak-cuts-pump", target: "hall:pulse" });
    const late = (await m.notices("safety_rule")).filter((n: any) => n.late_ack);
    expect(late).toMatchObject([{ rule_id: "leak-cuts-pump", devices: ["hall:pulse"] }]);
  });
});
