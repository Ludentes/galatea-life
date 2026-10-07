import { describe, expect, it } from "vitest";
import { body, flush, home, LEAK, rule } from "./safe-home.js";

// covers: GA-SAFE-12 and GA-SAFE-3 when the owner's clear_latch comes while a rule's close waits for a re-send, within one life.
const BOUNDS = [{ op: "upsert", kind: "ack_within_s", value: { device: "hall:valve", action: "valve.close", ack_within_s: 10 } }];
const at = (m: any) => new Date(m.clock.now()).toISOString();

describe("clear_latch and a waiting re-send", () => {
  it("once the owner clears the latch the rule no longer wants its close: complete, the valve no longer refuse(safety), nothing sent again", async () => {
    const m = await home();
    body(await m.configure([...BOUNDS, rule({ latch: { condition: { ...LEAK, value: false } } })]));
    const c = await m.cursor();
    m.report("leak", { leak: true });
    await flush();
    m.clock.advance(100);
    m.send("devices/valve/ack", { commandId: m.sent[0]!.body.commandId, source: "hall-bridge", result: "failed", reason: "rejected", timestamp: at(m) });
    await flush();
    // The close waits for its next attempt; the owner clears the latch (the sensor will never report again).
    body(await m.configure([{ op: "upsert", kind: "clear_latch", value: { rule_id: "leak-closes-valve" } }]));
    const p = await m.plan("hall:valve", "valve.open");
    const fired = await m.events(c, "rule_fired");
    m.clock.advance(10_000);
    await flush();
    expect(fired.length).toBe(1);
    expect(p.reason).not.toBe("safety");
    expect(m.sent.length).toBe(1);
  });
});
