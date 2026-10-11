import { describe, expect, it } from "vitest";
import { verdict } from "../src/safety/witnesses.js";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { body, DEVICES, flush, heater, home, status } from "./safe-home.js";

// covers: GA-WIT-1: the verdict of a witnessed step from an apply, a rule or a cap, its timing, unknown on a
// sensor not live throughout, and the bound notices; a watch kept across a restart is judged unknown (the maintainer's ruling 3).

// A room thermometer that reports its temperature, and an IR air conditioner that takes a setpoint.
const temp = { id: "temp", stableIdentifier: "test:temp", transport: "radio", capabilities: ["sensor"], sensorKeys: ["temperature"], actions: [],
  feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", otherAdmins: [] };
const cooler = { id: "cooler", stableIdentifier: "test:cooler", transport: "radio", capabilities: ["climate"], actions: [
  { action: "climate.set_setpoint", idempotent: true, stateless: false, confirms: false }],
feedback: "open", reachMs: 0, proposedClass: "ac", classEvidence: "protocol", otherAdmins: [] };
// A sensor of two keys, its first the humidity.
const climate = { ...temp, id: "climate", stableIdentifier: "test:climate", sensorKeys: ["humidity", "temperature"] };
const temp2 = { ...temp, id: "temp2", stableIdentifier: "test:temp2" };
type Home = Awaited<ReturnType<typeof home>>;
const ids = [...DEVICES, heater, temp, cooler, climate, temp2].map((d) => d.id);
const at = (m: Home) => new Date(m.clock.now()).toISOString();
function online(m: Home): void {
  const s = status(ids, { publishedAt: at(m) });
  m.send("status", { ...s, devices: s.devices.map((d) => ({ ...d, lastCheckIn: at(m), timestamp: at(m) })) });
}
async function advance(m: Home, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5000) {
    m.clock.advance(Math.min(5000, left));
    online(m);
    await flush();
  }
}
const witness = (device: string, action: string, expect: unknown, within_s = 60) =>
  ({ op: "upsert", kind: "witness", value: { device, action, sensor: "hall:temp", expect, within_s } });
async function witnessed(changes: unknown[], o: { db?: Awaited<ReturnType<typeof memoryDb>> } = {}) {
  const m = await home({ ...o, extra: [heater, temp, cooler] });
  body(await m.configure(changes));
  online(m);
  m.report("temp", { temperature: 20 });
  await flush();
  return m;
}
const verdicts = async (m: Home, c: string) => (await m.events(c, "outcome")).filter((e: any) => e.witness);

describe("a witness's verdict (GA-WIT-1)", () => {
  it.each([undefined, "forgets-a-watch"] as const)(
    "judges a watch armed before a restart unknown at its due, a second outcome event, once; mutation %s says nothing", async (mutation?: Mutation) => {
      const db = await memoryDb();
      const m = await witnessed([witness("hall:heater", "onoff.turn_on", "rises")], { db: lasting(db) });
      const r = await m.apply("hall:heater", "onoff.turn_on", { token: true });
      await flush();
      m.ack(m.sent.find((x) => x.device === "heater")!, "confirmed");
      await advance(m, 20_000);
      await m.store.settled();
      m.a.stop();
      await m.store.close();
      const again = await home({ db, fresh: false, mutation, extra: [heater, temp, cooler], at: m.clock.now() });
      again.send("devices", { devices: [...DEVICES, heater, temp, cooler] }, true);
      again.a.listening("hall");
      online(again);
      const c = await again.cursor();
      await advance(again, 35_000);
      expect(await verdicts(again, c)).toEqual([]);
      await advance(again, 6000);
      const v = await verdicts(again, c);
      expect(v.map((e: any) => [e.apply_id, e.witness.verdict])).toEqual(mutation ? [] : [[r.apply_id, "unknown"]]);
      await advance(again, 60_000);
      expect(await verdicts(again, c)).toHaveLength(mutation ? 0 : 1);
    });

  it.each([
    ["rises", 20, 21, "confirmed"], ["rises", 20, 20, "unconfirmed"], ["falls", 20, 19, "confirmed"], ["rises", undefined, 21, "unknown"],
    [{ becomes: true }, false, true, "confirmed"], [{ becomes: true }, false, false, "unconfirmed"],
    [{ toward: { arg: "celsius", by: 1 } }, 28, 26.5, "confirmed"], [{ toward: { arg: "celsius", by: 1 } }, 28, 27.5, "unconfirmed"],
    // A room already within by of where it was asked to go has nothing to show.
    [{ toward: { arg: "celsius", by: 1 } }, 22.4, 22.5, "unknown"], [{ toward: { arg: "celsius", by: 1 } }, 22, 22.9, "unknown"],
    // Moved less than by, or past the setpoint by less than by, ending near it: not confirmed.
    [{ toward: { arg: "celsius", by: 1 } }, 23.5, 22.9, "unconfirmed"], [{ toward: { arg: "celsius", by: 1 } }, 23.5, 21.2, "unconfirmed"],
    [{ toward: { arg: "celsius", by: 1 } }, 28, "warm", "unknown"], [{ toward: { arg: "celsius", by: 1 } }, undefined, 22, "unknown"],
  ] as const)("%j from %j to %j is %s", (expect_, baseline, latest, v) => {
    expect(verdict(expect_ as never, baseline, latest, { celsius: 22 })).toBe(v);
  });

  it("reports a client's witnessed step at within_s from dispatch, as a second outcome event; the step's own outcome stays", async () => {
    const m = await witnessed([witness("hall:heater", "onoff.turn_on", "rises")]);
    const c = await m.cursor();
    const r = await m.apply("hall:heater", "onoff.turn_on", { token: true });
    await flush();
    m.ack(m.sent.find((x) => x.device === "heater")!, "confirmed");
    m.report("heater", { on: true });
    await advance(m, 30_000);
    m.report("temp", { temperature: 21.5 });
    await advance(m, 25_000);
    expect(await verdicts(m, c)).toEqual([]);
    await advance(m, 5000);
    const [v] = await verdicts(m, c);
    expect(v).toMatchObject({ apply_id: r.apply_id, target: "hall:heater", outcome: "confirmed",
      witness: { sensor: "hall:temp", expect: "rises", within_s: 60 } });
    expect((await m.events(c, "outcome")).filter((e: any) => !e.witness).map((e: any) => e.outcome)).toEqual(["dispatched", "acked"]);
    // outcome carries the verdict beside the step's own outcome, which does not change.
    const held = body(await m.a.call(m.a.caller("h-credential"), "outcome", { apply_id: r.apply_id }));
    expect(held.outcomes).toMatchObject([{ step_id: "s1", outcome: "acked",
      witness: { sensor: "hall:temp", expect: "rises", within_s: 60, verdict: "confirmed" } }]);
    expect(v.witness.verdict).toBe("confirmed");
  });

  it("reads the key the witness names on a sensor of several keys", async () => {
    const m = await home({ extra: [heater, temp, cooler, climate] });
    body(await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:climate",
      key: "temperature", expect: "rises", within_s: 60 } }]));
    online(m);
    m.report("climate", { humidity: 50, temperature: 20 });
    await flush();
    const c = await m.cursor();
    await m.apply("hall:heater", "onoff.turn_on", { token: true });
    await flush();
    // The humidity falls, the temperature rises: the named key is the one judged.
    m.report("climate", { humidity: 40, temperature: 21 });
    await advance(m, 60_000);
    expect((await verdicts(m, c)).map((e: any) => [e.outcome, e.witness.key])).toEqual([["confirmed", "temperature"]]);
    const refused = await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:climate",
      key: "pressure", expect: "rises", within_s: 60 } }]);
    expect(refused.ok ? "accepted" : refused.message).toMatch(/hall:climate declares no sensor key pressure/);
  });

  it("says unconfirmed when the sensor did not move as expected, and unknown when it was not live throughout", async () => {
    const m = await witnessed([witness("hall:heater", "onoff.turn_on", "rises")]);
    const c = await m.cursor();
    await m.apply("hall:heater", "onoff.turn_on", { token: true });
    await advance(m, 60_000);
    await m.apply("hall:heater", "onoff.turn_on", { token: true });
    await flush();
    // The thermometer is dead for a moment, then live again with a warmer reading: not live throughout.
    m.send("devices/temp/status", { deviceId: "temp", available: false, timestamp: at(m) });
    await advance(m, 5000);
    m.send("devices/temp/status", { deviceId: "temp", available: true, timestamp: at(m) });
    m.report("temp", { temperature: 25 });
    await advance(m, 60_000);
    expect((await verdicts(m, c)).map((e: any) => e.outcome)).toEqual(["unconfirmed", "unknown"]);
  });

  it("judges toward against the step's own argument", async () => {
    const m = await witnessed([witness("hall:cooler", "climate.set_setpoint", { toward: { arg: "celsius", by: 1 } }, 600)]);
    m.report("temp", { temperature: 28 });
    const c = await m.cursor();
    await m.apply("hall:cooler", "climate.set_setpoint", { args: { celsius: 22 }, token: true });
    await flush();
    m.ack(m.sent.find((x) => x.device === "cooler")!, "sent");
    await advance(m, 300_000);
    m.report("temp", { temperature: 26.8 });
    await advance(m, 300_000);
    expect((await verdicts(m, c)).map((e: any) => e.outcome)).toEqual(["confirmed"]);
  });

  it("watches a step the applier sends on its own: the heating cap's", async () => {
    const m = await witnessed([{ op: "upsert", kind: "load", value: { device: "hall:heater", load: "heating" } },
      { op: "upsert", kind: "max_on_s", value: { device: "hall:heater", max_on_s: 20 } },
      witness("hall:heater", "onoff.turn_off", "falls", 30)]);
    const c = await m.cursor();
    m.report("heater", { on: true });
    await advance(m, 25_000);
    m.report("temp", { temperature: 19 });
    await advance(m, 25_000);
    expect(await verdicts(m, c)).toMatchObject([{ load_cap: "hall:heater", target: "hall:heater", outcome: "confirmed" }]);
  });
});

describe("a witness's configuration (GA-WIT-1, GA-CFG-3)", () => {
  it("is shown on its action, refused on an action not offered, a sensor with no sensor key, and toward an argument that is no number", async () => {
    const m = await home({ extra: [heater, temp, cooler] });
    const refused = async (change: unknown) => {
      const r = await m.configure([change]);
      return r.ok ? "accepted" : r.message;
    };
    expect(await refused(witness("hall:heater", "level.set_level", "rises"))).toMatch(/level.set_level/);
    expect(await refused({ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:valve", expect: "rises", within_s: 60 } }))
      .toMatch(/hall:valve declares no sensor key/);
    expect(await refused(witness("hall:thermo", "climate.set_mode", { toward: { arg: "mode", by: 1 } }))).toMatch(/takes no number mode/);
    expect(await refused({ ...witness("hall:heater", "onoff.turn_on", "cools") })).not.toBe("accepted");
    body(await m.configure([witness("hall:heater", "onoff.turn_on", "rises")]));
    const d = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:heater");
    // A witness given no key keeps its sensor's first, the one it reads, as its key (the whole-applier review's M8).
    expect(d.actions.find((a: any) => a.action === "onoff.turn_on").witness).toEqual({ sensor: "hall:temp", key: "temperature", expect: "rises", within_s: 60 });
    body(await m.configure([{ op: "delete", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on" } }]));
    const e = body(await m.a.call(m.owner, "describe", {})).devices.find((x: any) => x.id === "hall:heater");
    expect(e.actions.find((a: any) => a.action === "onoff.turn_on")).not.toHaveProperty("witness");
  });

  it("is not_claimed while the applier claims no Safe (GA-LVL-1)", async () => {
    const m = await home({ extra: [heater, temp], box: false });
    const r = await m.configure([witness("hall:heater", "onoff.turn_on", "rises")]);
    expect(r.ok ? "accepted" : r.error).toBe("not_claimed");
  });

  it("is a liveness notice over a sensor whose fresh_s is not known, or the owner's longer than the declared one", async () => {
    const m = await home({ extra: [heater, temp, cooler] });
    const texts = async () => (await m.notices("liveness")).filter((n: any) => n.witness).map((n: any) => n.text);
    // Its bridge declares no bound for the thermometer.
    const s = status(ids, { publishedAt: at(m) });
    m.send("status", { ...s, devices: s.devices.map((d) => d.id === "temp" ? { ...d, basisMaxAgeMs: null } : d) });
    body(await m.configure([witness("hall:heater", "onoff.turn_on", "rises")]));
    expect(await texts()).toEqual(["The witness of hall:heater's onoff.turn_on reads hall:temp, whose fresh_s is not known: "
      + "it can never be live, so the witness can only say unknown until the owner sets one."]);
    // Its bound declared again, the owner's shorter: nothing more to say.
    body(await m.configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:temp", fresh_s: 30 } }]));
    online(m);
    expect(await texts()).toHaveLength(1);
    body(await m.configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:temp", fresh_s: 600 } }]));
    // The newer replaces the untaken older.
    expect(await texts()).toEqual([expect.stringMatching(/whose fresh_s, 600 s, is longer than the 60 s its bridge declares/)]);
    body(await m.configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:temp", fresh_s: 30 } }]));
    expect(await texts()).toHaveLength(1);
  });

  it("follows a witness moved to another sensor, and goes with a deleted witness", async () => {
    const m = await home({ extra: [heater, temp, cooler, temp2] });
    const named = async () => (await m.notices("liveness")).filter((n: any) => n.witness).map((n: any) => n.witness.sensor);
    const s = status(ids, { publishedAt: at(m) });
    m.send("status", { ...s, devices: s.devices.map((d) => d.id === "temp" || d.id === "temp2" ? { ...d, basisMaxAgeMs: null } : d) });
    await flush();
    body(await m.configure([witness("hall:heater", "onoff.turn_on", "rises")]));
    expect(await named()).toEqual(["hall:temp"]);
    body(await m.configure([{ op: "upsert", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on", sensor: "hall:temp2",
      expect: "rises", within_s: 60 } }]));
    expect(await named()).toEqual(["hall:temp2"]);
    body(await m.configure([{ op: "delete", kind: "witness", value: { device: "hall:heater", action: "onoff.turn_on" } }]));
    expect(await named()).toEqual([]);
  });
});
