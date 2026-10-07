import { describe, expect, it } from "vitest";
import { body, home, LEAK } from "./safe-home.js";

// covers: the negative toggles-by-safety-rule (GA-SAFE-13) still models a rule that sends a toggle once the
// declaration re-check runs after every configure.
describe("toggles-by-safety-rule under the re-check after a configure", () => {
  it("leaves the rule the mutation let configure take enabled: the re-check reads the same switch", async () => {
    const m = await home({ mutation: "toggles-by-safety-rule" });
    body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "tv-off", trigger: LEAK, actions: [{ target: "hall:tv", action: "onoff.turn_off" }] } }]));
    const r = body(await m.a.call(m.owner, "describe", {})).safety_rules.find((x: any) => x.id === "tv-off");
    expect(r).toBeDefined();
    expect(r.disabled).toBeUndefined();
    expect(await m.notices("rule_disabled")).toEqual([]);
  });
});
