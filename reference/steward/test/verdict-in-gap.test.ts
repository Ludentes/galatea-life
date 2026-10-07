// For the port of slice 11 onto the slice 7 PR branch (the milestone 7+10+11 review, *The hand merge of `relay`*):
// a witness's verdict (an `outcome` carrying `witness`, #40) relayed in a gap must not reach `ruleOutcome`, so
// `settleLater` stays inside `relay`'s `!verdict` branch. On a branch without #40 the verdict is taken as the
// step's outcome and this fails; on the ported branch it must pass.
import { describe, expect, it, vi } from "vitest";
import { up } from "./house.js";
import { SECRETS } from "./house.js";
import { DIMMER, eventsSince, LAMP, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const iso = (ms: number) => new Date(ms).toISOString();
const live = (on: boolean) => ({ targets: { [LAMP]: { liveness: "live", values: [{ key: "on", value: on }] },
  [DIMMER]: { liveness: "live", values: [{ key: "level", value: 0 }] } }, transports: [], latches: [] });
const LAMP_RULE = up("rule", { id: "lamp", name: "Лампа", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
  actions: [{ target: DIMMER, action: "level.set_level", args: { level: 30 } }] });

describe("a witness's verdict read in a gap (the hand merge of relay)", () => {
  it("does not reach the rule firing's step outcome: no retry, no failure notice", async () => {
    const s = await setup({ state: live(false) });
    await s.define([LAMP_RULE]);
    const begun = String((await s.ok(SECRETS.owner, "events")).cursor);
    s.applier.emitsOutcomes = false;
    s.applier.emit({ type: "state", target: LAMP, key: "on", value: true, time: iso(s.clock.now()), cause: "device" });
    await s.pump();
    await vi.waitFor(() => expect(s.applier.applies).toHaveLength(1));
    // In the gap: the witness's verdict on that step, failed.
    s.applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: DIMMER, outcome: "failed", reason: "no_ack",
      witness: { device: "sim-bridge:witness" }, time: iso(s.clock.now()) });
    const missed = (await s.port.history({ from: iso(0), to: iso(s.clock.now() + 60_000) })).events;
    s.steward.recover(missed, live(true), String(missed.at(-1)!.seq));
    await quiet(s.store);
    s.clock.advance(120_000);
    await quiet(s.store);
    expect(s.applier.applies.filter((a: Body) => String(a.idempotency_key).startsWith("rule:lamp:"))).toHaveLength(1);
    // No failure notice: the verdict never became the firing step's outcome (`ruleOutcome`).
    const notices = (await eventsSince(s.ok, begun, "notice")).filter((e: Body) => e.change === "raised" && e.cause === "rule_failed");
    expect(notices).toEqual([]);
  });
});
