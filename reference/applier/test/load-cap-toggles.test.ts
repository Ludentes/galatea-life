import { describe, expect, it } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { body, DEVICES, flush, heater, home, status } from "./safe-home.js";

// covers: GA-SAFE-13's load_cap clauses: a load: heating refused on a socket whose turn_off toggles, a
// notice when such a socket taken as heating is adopted, and when a heating load's turn-off is re-taught
// as a toggle; within one life (what a restart keeps of a notice is GA-PERSIST-1's, slice 7's).

// A closed relay whose turn_off flips it: a toggle, which the applier never sends on its own.
const relay = { ...heater, id: "relay", stableIdentifier: "test:relay",
  actions: heater.actions.map((a) => ({ ...a, idempotent: false, toggles: true })) };
type Home = Awaited<ReturnType<typeof home>>;
const ids = [...DEVICES, heater, relay].map((d) => d.id);
const at = (m: Home) => new Date(m.clock.now()).toISOString();
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
const cannot = async (m: Home) => (await m.notices("load_cap")).filter((n: any) => /cannot act/.test(n.text)).map((n: any) => n.devices);
const heating = (device: string) => ({ op: "upsert", kind: "load", value: { device, load: "heating" } });

describe("a heating load's cap that would press a toggle (GA-SAFE-13)", () => {
  it.each([[undefined, false], ["toggles-a-cap-off" as const, true]])("refuses load: heating on a socket whose turn_off toggles (mutation %s)", async (mutation, taken) => {
    const m = await home({ mutation, extra: [heater, relay] });
    const r = await m.configure([heating("hall:relay")]);
    expect(r.ok).toBe(taken);
    if (!r.ok) expect(r.message).toMatch(/hall:relay's onoff.turn_off is declared toggles: true/);
    // An adoption declaring it is refused the same way.
    body(await m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:relay" } }]));
    const again = await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:relay", class: "socket", declarations: { load: "heating" } } }]);
    expect(again.ok).toBe(taken);
  });

  it.each([[undefined, [["hall:relay"]]], ["adopts-an-uncappable-socket-quietly" as const, []]])("says at its adoption that a socket taken as heating, its turn_off a toggle, has a cap that cannot act (mutation %s)", async (mutation, said) => {
    const m = await home({ mutation: mutation as Mutation | undefined, extra: [heater, relay] });
    expect(await cannot(m)).toEqual([]);
    body(await m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:relay" } }]));
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:relay", class: "socket" } }]));
    const d = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:relay");
    expect(d.load).toBe("heating");
    expect(await cannot(m)).toEqual(said);
    // A load configured clears it; the same socket taken as heating again is said again.
    body(await m.configure([{ op: "upsert", kind: "load", value: { device: "hall:relay", load: "lighting" } }]));
    if (!mutation) {
      const [n] = await m.notices("load_cap");
      body(await m.a.call(m.a.caller("h-credential"), "events", { notice_taken: [n.notice_id] }));
      body(await m.configure([{ op: "delete", kind: "load", value: { device: "hall:relay" } }]));
      expect(await cannot(m)).toEqual([["hall:relay"]]);
    }
  });

  it("says a heating load's turn-off re-taught as a toggle cannot act, and never sends it when the cap comes", async () => {
    const m = await home({ extra: [heater, relay] });
    body(await m.configure([heating("hall:heater"), { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } }]));
    online(m);
    const devices = [...DEVICES, { ...heater, actions: heater.actions.map((a) => a.action === "onoff.turn_off" ? { ...a, idempotent: false, toggles: true } : a) },
      relay];
    m.send("devices", { devices }, true);
    await flush();
    expect(await cannot(m)).toEqual([["hall:heater"]]);
    m.report("heater", { on: true });
    for (let i = 0; i < 6; i++) {
      m.clock.advance(5000);
      online(m);
      await flush();
    }
    expect(m.sent.filter((x) => x.device === "heater")).toEqual([]);
    // Still one notice: the one already standing says it.
    expect(await cannot(m)).toEqual([["hall:heater"]]);
    // Its discrete turn-off back: the notice's key clears, and the cap, armed again, acts while the socket stays on.
    m.send("devices", { devices: [...DEVICES, heater, relay] }, true);
    await flush();
    expect(await cannot(m)).toEqual([["hall:heater"]]);
    expect(m.sent.filter((x) => x.device === "heater").map((x) => x.body.value.action)).toEqual(["onoff.turn_off"]);
  });

  it.each([[undefined, false], ["toggles-a-cap-off" as const, true]])("refuses max_on_s on a socket whose turn_off toggles, its load not configured (mutation %s)", async (mutation, taken) => {
    const m = await home({ mutation, extra: [heater, relay] });
    body(await m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:relay" } }]));
    body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:relay", class: "socket" } }]));
    const r = await m.configure([{ op: "upsert", kind: "max_on_s", value: { device: "hall:relay", max_on_s: 600 } }]);
    expect(r.ok).toBe(taken);
    if (!r.ok) expect(r.message).toMatch(/hall:relay's onoff.turn_off is declared toggles: true, so it cannot carry a max_on_s/);
  });
});
