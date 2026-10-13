import { validate } from "@ludentes/galatea-life-schemas";
import { expect } from "vitest";

/**
 * Every lease event but a safety rule's (its holder and expires are the reference's own, R-39) is a
 * valid `lease` event (R-38).
 */
export function validLeaseEvents(events: Record<string, unknown>[]): void {
  for (const e of events) {
    const h = e.holder;
    if (typeof h === "object" && h !== null && "safety_rule" in h) continue;
    expect(validate("steward/event.lease.json", { seq: 1, time: new Date(0).toISOString(), type: "lease", ...e }), JSON.stringify(e)).toEqual([]);
  }
}
