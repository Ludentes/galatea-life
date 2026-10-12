import { describe, expect, it, vi } from "vitest";
import { EDGE_REPLAY_MS } from "../src/rules/engine.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { DIMMER, LAMP, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const MOTION = "sim-bridge:motion";
const iso = (ms: number) => new Date(ms).toISOString();
const DEVICES = [
  { id: "sim-bridge:channel", label: "channel", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] },
  { id: LAMP, label: "lamp", class: "light", capabilities: ["onoff"], adopted: true,
    actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "reversible" }] },
  { id: DIMMER, label: "dimmer", class: "light", capabilities: ["onoff", "level"], adopted: true, actions: [{ action: "level.set_level", tier: "reversible" }] },
  { id: MOTION, label: "motion", class: "sensor", capabilities: ["sensor"], adopted: true, actions: [] }];
const STATE = { targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: false }] }, [MOTION]: { liveness: "live", values: [{ key: "motion", value: false }] },
  [DIMMER]: { liveness: "live", values: [{ key: "level", value: 0 }] } }, transports: [], latches: [] };
/** An edge rule on motion's state, and one on a button's occurrence. */
const RULES = [up("rule", { id: "motion", name: "Движение", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
  actions: [{ target: LAMP, action: "onoff.turn_on", args: {} }] }),
up("rule", { id: "press", name: "Кнопка", trigger: { event: { target: DIMMER, type: "occurrence", key: "press" } },
  actions: [{ target: DIMMER, action: "level.set_level", args: { level: 50 } }] })];
const fired = (s: { applier: { applies: Body[] } }, rule: string) => s.applier.applies.filter((a) => String(a.idempotency_key).startsWith(`rule:${rule}:`)).length;

async function gapEnds(s: Awaited<ReturnType<typeof setup>>, state: Body = STATE): Promise<void> {
  const missed = (await s.port.history({ from: iso(0), to: iso(s.clock.now()) })).events;
  s.steward.recover(missed, state, String(missed.at(-1)?.seq ?? 0));
  await quiet(s.store);
}

async function following(mutation?: Parameters<typeof setup>[0] extends infer O ? O extends { mutation?: infer M } ? M : never : never, rules = RULES) {
  const s = await setup({ devices: DEVICES, state: STATE, mutation });
  await s.define(rules);
  // One event followed, so the steward has an applier event to read the gap from.
  s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "device" });
  await s.pump();
  return s;
}

/** The state at the gap's end with motion as `motion` and the lamp as `lamp`. */
const stateWith = (motion: boolean, lamp = false) => ({ ...STATE, targets: { ...STATE.targets,
  [MOTION]: { liveness: "live", values: [{ key: "motion", value: motion }] }, [LAMP]: { liveness: "live", values: [{ key: "on", value: lamp }] } } });
/** The edge rule on motion, its conditions the lamp on. */
const WHILE_ON = up("rule", { id: "motion", name: "Движение", trigger: { state: { target: MOTION, key: "motion", op: "eq", value: true } },
  conditions: [{ target: LAMP, key: "on", op: "eq", value: true }], actions: [{ target: DIMMER, action: "level.set_level", args: { level: 30 } }] });

describe("edges missed in a gap (GA-RULE-1: a state edge replayed within edge_replay_s)", () => {
  it("states edge_replay_s, 300, in describe; leaves it out under replays-undeclared", async () => {
    expect((await (await setup()).ok(SECRETS.owner, "describe")).edge_replay_s).toBe(EDGE_REPLAY_MS / 1000);
    expect(await (await setup({ mutation: "replays-undeclared" })).ok(SECRETS.owner, "describe")).not.toHaveProperty("edge_replay_s");
  });

  it("fires an edge rule once for the changes into its reading in the gap, within the bound, its reading holding at the end", async () => {
    const s = await following();
    s.clock.advance(EDGE_REPLAY_MS);
    const at = s.clock.now() - EDGE_REPLAY_MS + 1_000;
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: false, time: iso(at), cause: "device" });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    await gapEnds(s, stateWith(true));
    await vi.waitFor(() => expect(fired(s, "motion")).toBe(1));
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(1);
  });

  it("replays no edge whose reading no longer holds when the gap is read", async () => {
    const s = await following();
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(s.clock.now()), cause: "device" });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: false, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s, stateWith(false));
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(0);
  });

  it("loses an edge older than the bound, as the standard loses every edge in a gap; replays it under replays-past-its-bound", async () => {
    for (const [mutation, want] of [[undefined, 0], ["replays-past-its-bound", 1]] as const) {
      const s = await following(mutation);
      s.clock.advance(EDGE_REPLAY_MS + 60_000);
      s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(s.clock.now() - EDGE_REPLAY_MS - 1), cause: "device" });
      await gapEnds(s, stateWith(true));
      await quiet(s.store);
      expect(fired(s, "motion")).toBe(want);
    }
  });

  it("never replays an event trigger: an occurrence in a gap is lost", async () => {
    const s = await following();
    s.applier.emit({ type: "occurrence", target: DIMMER, key: "press", value: true, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s);
    await quiet(s.store);
    expect(fired(s, "press")).toBe(0);
  });

  it("replays an edge after an earlier firing with the applier's clock ten minutes ahead, the firing found by the applier's time (the code review, CR2)", async () => {
    const s = await following();
    const ahead = (ms: number) => iso(s.clock.now() + 600_000 + ms);
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: ahead(0), cause: "device" });
    await s.pump();
    await vi.waitFor(() => { s.clock.advance(0); expect(fired(s, "motion")).toBe(1); });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: false, time: ahead(1_000), cause: "device" });
    await s.pump();
    s.clock.advance(10_000);
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: ahead(5_000), cause: "device" });
    // The applier's history, read to its own now.
    const missed = (await s.port.history({ from: iso(0), to: ahead(10_000) })).events;
    s.steward.recover(missed, stateWith(true), String(missed.at(-1)!.seq));
    await quiet(s.store);
    await vi.waitFor(() => { s.clock.advance(0); expect(fired(s, "motion")).toBe(2); });
  });

  it("judges an exception by the steward's clock, the edge's time moved by how far the applier's clock was off (the code review, CR2)", async () => {
    const s = await following();
    // Followed live with the applier's clock two minutes behind; then the edge, a minute ago by the steward's clock, missed.
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now() - 120_000), cause: "device" });
    await s.pump();
    const edge = s.clock.now() - 60_000;
    await s.define([up("rule_exception", { rule: "motion", from: iso(edge - 1_000), until: iso(edge + 1_000) })]);
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(edge - 120_000), cause: "device" });
    await gapEnds(s, stateWith(true));
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(0);
  });

  it("replays no edge that fell inside one of the rule's exceptions", async () => {
    const s = await following();
    const at = s.clock.now();
    await s.define([up("rule_exception", { rule: "motion", from: iso(at - 1_000), until: iso(at + 1_000) })]);
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    s.clock.advance(5_000);
    await gapEnds(s, stateWith(true));
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(0);
  });

  it("judges the conditions now: an edge from when the lamp was on does not fire once it is off; under replays-on-old-conditions it does", async () => {
    for (const [mutation, want] of [[undefined, 0], ["replays-on-old-conditions", 1]] as const) {
      const s = await following(mutation, [WHILE_ON]);
      s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(s.clock.now()), cause: "device" });
      await s.pump();
      s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(s.clock.now()), cause: "device" });
      s.clock.advance(10_000);
      s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "device" });
      await gapEnds(s, stateWith(true, false));
      await quiet(s.store);
      expect(fired(s, "motion")).toBe(want);
    }
  });

  it("replays no edge whose rule_fired is already in history from before a restart; replays it under replays-a-fired-edge", async () => {
    for (const [mutation, want] of [[undefined, 1], ["replays-a-fired-edge", 2]] as const) {
      const db = lasting(await memoryDb());
      const clock = new FakeClock();
      const a = await setup({ devices: DEVICES, state: STATE, mutation, db, clock });
      await a.define(RULES);
      // The edge followed: the rule fires, its rule_fired in the log.
      a.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(clock.now()), cause: "device" });
      await a.pump();
      await vi.waitFor(() => expect(fired(a, "motion")).toBe(1));
      await quiet(a.store);
      a.steward.stop();
      await a.store.close();
      clock.advance(10_000);
      const b = await setup({ devices: DEVICES, state: stateWith(true), mutation, db, clock, applier: a.applier, define: false, sync: false });
      // The edge read back as if the restart had lost its place past it.
      const missed = (await b.port.history({ from: iso(0), to: iso(clock.now()) })).events as Body[];
      const lost = missed.map((e) => ({ ...e, seq: (e.seq as number) + 10_000 }));
      b.steward.recover(mutation ? missed : lost, stateWith(true), String(10_000 + (missed.at(-1)?.seq ?? 0)));
      await quiet(b.store);
      expect(fired(b, "motion")).toBe(want);
    }
  });
});
