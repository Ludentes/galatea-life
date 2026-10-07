import { describe, expect, it } from "vitest";
import { body, DEVICES, flush, home, LEAK, status } from "./safe-home.js";

// covers: GA-SAFE-7 for an action whose side effect undoes a latch, within one life (GA-PERSIST-1 untested here).
// A latch over a dimmer's `on`: `level.set_level` turns it on as a side effect, so it is an undo too.
const lamp = { id: "lamp", stableIdentifier: "test:lamp", transport: "radio", capabilities: ["onoff", "level"], actions: [
  { action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true },
  { action: "onoff.turn_off", idempotent: true, stateless: false, confirms: true },
  { action: "level.set_level", idempotent: true, stateless: false, confirms: true }],
feedback: "closed", reachMs: 0, proposedClass: "light", classEvidence: "protocol", otherAdmins: [] };

describe("a latch's undo by a side effect", () => {
  it("refuses level.set_level on a dimmer a latched rule turned off: it turns the dimmer on (GA-SAFE-7)", async () => {
    const m = await home();
    m.send("devices", { devices: [...DEVICES, lamp] }, true);
    m.send("status", status([...DEVICES, lamp].map((d) => d.id)));
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
    body(await m.configure([{ op: "upsert", kind: "safety_rule", value: { id: "leak-cuts-heat-lamp", trigger: LEAK,
      actions: [{ target: "hall:lamp", action: "onoff.turn_off" }], latch: { condition: { ...LEAK, value: false } } } }]));
    m.report("leak", { leak: true });
    await flush();
    m.ack(m.sent[0]!, "applied");
    m.report("lamp", { on: false });
    await flush();
    expect((await m.plan("hall:lamp", "onoff.turn_on")).reason).toBe("latched");
    expect((await m.plan("hall:lamp", "level.set_level", { level: 80 })).reason).toBe("latched");
  });
});
