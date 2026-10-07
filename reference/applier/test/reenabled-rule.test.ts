import { describe, expect, it } from "vitest";
import { body, DEVICES, flush, home, LEAK, thermo } from "./safe-home.js";

// covers: GA-SAFE-11 and GA-SAFE-13 for a rule a declaration change disabled and the owner set again, within one life.
// A re-enabled rule acts as one newly configured (the maintainer, 2026-10-04): it fires on the next new report that makes its
// trigger true, never on values held before.

const modeRule = { op: "upsert", kind: "safety_rule", value: { id: "leak-stops-heat", trigger: LEAK,
  actions: [{ target: "hall:thermo", action: "climate.set_mode", args: { mode: "off" } }] } };
/** The thermostat re-declared by its bridge. */
const redeclare = (m: Awaited<ReturnType<typeof home>>, action: Record<string, unknown>) =>
  m.send("devices", { devices: DEVICES.map((d) => (d.id === "thermo" ? { ...thermo, actions: [{ ...thermo.actions[0], ...action }] } : d)) }, true);

describe("a disabled rule set again on a leak still going on", () => {
  it("fires on the next new wet report once the owner sets it again, as a rule newly configured would", async () => {
    const m = await home();
    body(await m.configure([modeRule]));
    redeclare(m, { args: { mode: ["heat"] } });
    expect((await m.notices("rule_disabled")).length).toBe(1);
    // The leak starts while the rule is disabled: nothing is sent.
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent).toEqual([]);
    // The thermostat fixed, the owner sets the rule again; the floor is still wet, and the sensor says so again.
    redeclare(m, {});
    body(await m.configure([modeRule]));
    // Setting it again fires nothing on the value held before.
    await flush();
    expect(m.sent).toEqual([]);
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.map((x) => x.device)).toEqual(["thermo"]);
  });

  it("fires the same way when the same body is deleted and added again", async () => {
    const m = await home();
    body(await m.configure([modeRule]));
    redeclare(m, { args: { mode: ["heat"] } });
    m.report("leak", { leak: true });
    await flush();
    redeclare(m, {});
    body(await m.configure([{ op: "delete", kind: "safety_rule", value: { id: "leak-stops-heat" } }]));
    body(await m.configure([modeRule]));
    m.clock.advance(1000);
    m.report("leak", { leak: true });
    await flush();
    expect(m.sent.map((x) => x.device)).toEqual(["thermo"]);
  });
});
