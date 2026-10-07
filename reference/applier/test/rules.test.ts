import { describe, expect, it } from "vitest";
import type { Ack } from "../src/bus/wire.js";
import { onAck, onBound, onBridgeDead, type StepKind } from "../src/dispatch/rules.js";

const ack = (result: Ack["result"], reason?: string): Ack => ({ command_id: "c-1", source: "b", result, ...(reason ? { reason } : {}) });
const kind = (feedback: "open" | "closed", stateless: boolean, confirms = feedback === "closed"): StepKind => ({ feedback, stateless, confirms });

/** The effect, written short: `final:acked`, `final:failed(rejected)`, `wait`, `wait!` (with a fault), `ignore`. */
function effect(k: StepKind, a: Ack, acksWithoutState = false): string {
  const e = onAck(k, a, acksWithoutState);
  if (e.kind === "final") return `final:${e.final.outcome}${e.final.reason ? `(${e.final.reason})` : ""}${e.acted ? "" : " not acted"}`;
  return e.kind === "wait" && e.fault ? "wait!" : e.kind;
}

describe("the ack rules (applier, *Outcomes*; the bridge standard's table)", () => {
  it("waits for a closed device's report after applied or a sent it may give, and fails or ends unreachable as the ack says", () => {
    const stateful = kind("closed", false);
    expect(effect(stateful, ack("applied"))).toBe("wait");
    expect(effect(stateful, ack("failed", "rejected"))).toBe("final:failed(rejected) not acted");
    expect(effect(stateful, ack("failed", "unreachable"))).toBe("final:unreachable not acted");
    expect(effect(stateful, ack("failed", "expired"))).toBe("final:unreachable not acted");
    expect(effect(stateful, ack("failed", "no_confirmation"))).toBe("wait");
    expect(effect(stateful, ack("failed", "not_locked"))).toBe("final:failed(not_locked)");
    expect(effect(stateful, ack("unsupported"))).toBe("final:failed(unsupported_action) not acted");
    expect(effect(kind("closed", false, false), ack("sent"))).toBe("wait");
  });

  it("ends a closed device's stateless step delivered on applied, sent on a sent it may give, and never acked (GA-APPLY-7)", () => {
    expect(effect(kind("closed", true), ack("applied"))).toBe("final:delivered");
    expect(effect(kind("closed", true, false), ack("sent"))).toBe("final:sent");
  });

  it("takes a sent for an action declared confirms: true as a bridge fault, and waits (GA-APPLY-7)", () => {
    expect(effect(kind("closed", true, true), ack("sent"))).toBe("wait!");
    expect(effect(kind("closed", false, true), ack("sent"))).toBe("wait!");
    // The fault names no command id, so one stands per device while the bridge keeps doing it.
    const fault = (id: string) => (onAck(kind("closed", true, true), { ...ack("sent"), command_id: id }) as { fault?: string }).fault;
    expect(fault("c-1")).toBe(fault("c-2"));
  });

  it("ends an open device's step sent on applied or sent, and as the ack says otherwise (GA-STATE-4)", () => {
    expect(effect(kind("open", false), ack("applied"))).toBe("final:sent");
    expect(effect(kind("open", false, false), ack("sent"))).toBe("final:sent");
    expect(effect(kind("open", true, false), ack("failed", "unreachable"))).toBe("final:unreachable not acted");
  });

  it("ignores the non-terminal received and a result it does not know, which are no terminal ack (GA-BUS-4, GA-BUS-6)", () => {
    for (const k of [kind("closed", false), kind("open", false)]) {
      expect(effect(k, ack("received"))).toBe("ignore");
      expect(effect(k, ack("unknown"))).toBe("ignore");
    }
  });

  it("acks a stateful step on applied under acks-without-state", () => {
    expect(effect(kind("closed", false), ack("applied"), true)).toBe("final:acked");
    expect(effect(kind("closed", true), ack("applied"), true)).toBe("final:delivered");
  });

  it("ends a closed device's step failed(no_ack) at its bound or its bridge's death, an open one's unanswered at its bound only (GA-APPLY-8)", () => {
    expect(onBound(kind("closed", false))).toEqual({ outcome: "failed", reason: "no_ack" });
    expect(onBound(kind("open", false))).toEqual({ outcome: "unanswered" });
    expect(onBridgeDead(kind("closed", true))).toEqual({ outcome: "failed", reason: "no_ack" });
    expect(onBridgeDead(kind("open", false))).toBeUndefined();
  });
});
