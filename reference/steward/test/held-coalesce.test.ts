// Held notices coalesce per kind and target (GA-NOTE-1): the steward's own notices name their rule,
// scenario or group as fields, so two rules' notices held together stay apart (the whole-branch review, I1).
import { describe, expect, it, vi } from "vitest";
import { BASELINE, SECRETS, up } from "./house.js";
import { DEVICES, DIMMER, LAMP, setup } from "./setup.js";

type Body = Record<string, any>;
const CHANNEL = "sim-bridge:channel";
const SILENT = BASELINE.map((c) => (c.kind === "home" ? up("home", { timezone: "Europe/Moscow" }) : c));
const reading = (id: string, name: string, on: string, act: string) => up("rule", { id, name,
  trigger: { state: { target: on, key: "on", op: "eq", value: true } }, actions: [{ target: act, action: "onoff.turn_on", args: {} }] });

/** Defines `rules` on a steward with no channel set, then sets the channel; the texts delivered and `held_notices` before. */
async function heldThenSent(rules: ReturnType<typeof up>[]) {
  const { ok, define, applier, clock } = await setup({ define: false, devices: DEVICES });
  applier.answerOutcome = "delivered";
  await define(SILENT);
  for (const r of rules) await define([r]);
  const held = (await ok(SECRETS.owner, "describe")).held_notices;
  await define([up("home", { notice_channels: [CHANNEL] })]);
  const sent: string[] = [];
  await vi.waitFor(() => {
    clock.advance(0);
    sent.splice(0, sent.length, ...applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:"))
      .flatMap((a) => (a.request.actions as Body[]).map((x) => String(x.args.text))));
    expect(sent.length).toBeGreaterThanOrEqual(rules.length);
  });
  return { held, sent };
}

describe("held notices of the steward's own, per kind and target (GA-NOTE-1)", () => {
  it("keeps two rules' rule_unbounded notices apart when they read different devices", async () => {
    const { held, sent } = await heldThenSent([reading("r1", "Один", DIMMER, LAMP), reading("r2", "Два", LAMP, DIMMER)]);
    expect(held).toBe(2);
    expect(sent.some((t) => t.includes("rule r1"))).toBe(true);
    expect(sent.some((t) => t.includes("rule r2"))).toBe(true);
  });

  it("keeps them apart when both rules read the same device", async () => {
    const { held, sent } = await heldThenSent([reading("r1", "Один", DIMMER, LAMP), reading("r2", "Два", DIMMER, LAMP)]);
    expect(held).toBe(2);
    expect(sent.some((t) => t.includes("rule r1"))).toBe(true);
    expect(sent.some((t) => t.includes("rule r2"))).toBe(true);
  });
});
