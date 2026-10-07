import { describe, expect, it, vi } from "vitest";
import { EDGE_REPLAY_MS } from "../src/rules/engine.js";
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

async function following() {
  const s = await setup({ devices: DEVICES, state: STATE });
  await s.define(RULES);
  // One event followed, so the steward has an applier event to read the gap from.
  s.applier.emit({ type: "state", target: LAMP, key: "on", value: false, time: iso(s.clock.now()), cause: "device" });
  await s.pump();
  return s;
}

describe("edges missed in a gap (ruled 2026-10-04: replayed within EDGE_REPLAY_MS)", () => {
  it("fires an edge rule once for a change into its reading in the gap, within five minutes, its conditions judged now", async () => {
    const s = await following();
    s.clock.advance(EDGE_REPLAY_MS);
    const at = s.clock.now() - EDGE_REPLAY_MS + 1_000;
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: false, time: iso(at), cause: "device" });
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    await gapEnds(s);
    await vi.waitFor(() => expect(fired(s, "motion")).toBe(1));
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(1);
  });

  it("loses an edge older than five minutes, as the standard loses every edge in a gap", async () => {
    const s = await following();
    s.clock.advance(EDGE_REPLAY_MS + 60_000);
    const at = s.clock.now() - EDGE_REPLAY_MS - 1;
    s.applier.emit({ type: "state", target: MOTION, key: "motion", value: true, time: iso(at), cause: "device" });
    s.applier.emit({ type: "occurrence", target: DIMMER, key: "press", value: true, time: iso(at), cause: "device" });
    await gapEnds(s);
    await quiet(s.store);
    expect(fired(s, "motion")).toBe(0);
    expect(fired(s, "press")).toBe(0);
  });

  it("fires an event trigger the gap held; never a level rule's edge, nor a rule inside an exception", async () => {
    const s = await following();
    s.applier.emit({ type: "occurrence", target: DIMMER, key: "press", value: true, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s);
    await vi.waitFor(() => expect(fired(s, "press")).toBe(1));
    await s.define([up("rule_exception", { rule: "press", from: iso(s.clock.now() - 1_000), until: iso(s.clock.now() + 3_600_000) })]);
    s.applier.emit({ type: "occurrence", target: DIMMER, key: "press", value: true, time: iso(s.clock.now()), cause: "device" });
    await gapEnds(s);
    await quiet(s.store);
    expect(fired(s, "press")).toBe(1);
    expect((await s.ok(SECRETS.owner, "describe")).rules.length).toBe(2);
  });
});
