import { describe, expect, it } from "vitest";
import { BridgeRules, DEAD_AFTER_MS } from "../src/bus/bridge-rules.js";
import type { Status } from "../src/bus/wire.js";

const T0 = Date.parse("2030-01-01T08:00:00.000Z");
const status = (at: number, extra: Partial<Status> = {}): Status => ({
  bridge_id: "b", instance_id: "i-1", v: 1, graceful: false, published_at: at, transports: [], roster: [], listed: [],
  faults: [], ...extra,
});
const ev = (seq: number, instance_id = "i-1") => ({ seq, instance_id, type: "joined", body: {} });

function live(now = T0): BridgeRules {
  const b = new BridgeRules("b", now);
  b.listening(now);
  b.status(status(now), false, now);
  return b;
}

describe("BridgeRules", () => {
  it("checks the identity unless anyIdentity (the finder's), and says while a skew stands", () => {
    const checked = new BridgeRules("b", T0);
    expect(checked.status(status(T0, { bridge_id: "other" }), false, T0).faults).toEqual(['a status naming bridge "other"']);
    expect(checked.alive).toBe(false);
    const any = new BridgeRules("", T0, { anyIdentity: true });
    expect(any.status(status(T0, { bridge_id: "other" }), false, T0)).toMatchObject({ faults: [], changed: true });
    expect(any.alive).toBe(true);
    expect(any.skewed).toBe(false);
    any.status(status(T0 + 60_000), false, T0 + 1000);
    expect(any.skewed).toBe(true);
    any.status(status(T0 + 2000), false, T0 + 2000);
    expect(any.skewed).toBe(false);
  });

  it("is dead until a status arrives live; a retained one names the instance but never revives (GA-BUS-8)", () => {
    const b = new BridgeRules("b", T0);
    expect(b.listening(T0)).toMatchObject({ faults: [], changed: false });
    expect(b.status(status(T0), true, T0 + 100)).toMatchObject({ take: true, changed: false, snapshot: false });
    expect(b.alive).toBe(false);
    expect(b.instanceId).toBe("i-1");
    expect(b.status(status(T0 + 200), false, T0 + 200)).toMatchObject({ changed: true, take: true, snapshot: true, faults: [] });
    expect(b.alive).toBe(true);
  });

  it("revives only on a status published no earlier than the death less 5 s; one that does not changes nothing", () => {
    const b = live();
    b.lost(T0 + 10_000);
    expect(b.status(status(T0 + 4_000), false, T0 + 11_000)).toEqual({ faults: [expect.any(String)], changed: false, snapshot: false, take: false });
    expect(b.alive).toBe(false);
    expect(b.status(status(T0 + 5_000), false, T0 + 11_000)).toMatchObject({ changed: true, faults: [] });
  });

  it("dies 30 s after its last status, with no fault", () => {
    const b = live();
    expect(b.tick(T0 + DEAD_AFTER_MS)).toMatchObject({ changed: false });
    expect(b.tick(T0 + DEAD_AFTER_MS + 1)).toEqual({ faults: [], changed: true, snapshot: false, take: false });
  });

  it("dies on a will naming its latest instance, with no fault; ignores another's, and an empty one", () => {
    const b = live();
    expect(b.will(undefined, T0)).toMatchObject({ changed: false, faults: [] });
    expect(b.will("i-0", T0)).toMatchObject({ changed: false, faults: [] });
    expect(b.alive).toBe(true);
    expect(b.will("i-1", T0 + 1)).toMatchObject({ changed: true, faults: [] });
  });

  it("dies on a graceful offline with no fault", () => {
    const b = live();
    expect(b.status(status(T0 + 1000, { graceful: true }), false, T0 + 1000)).toMatchObject({ changed: true, faults: [] });
    expect(b.alive).toBe(false);
  });

  it("takes a status without v, with another v or naming another bridge as a fault, dead until a valid one (GA-BUS-14)", () => {
    for (const bad of [{ v: undefined }, { v: 2 }, { bridge_id: "other" }]) {
      const b = live();
      const o = b.status(status(T0 + 1000, bad), false, T0 + 1000);
      expect(o).toMatchObject({ changed: true, take: false });
      expect(o.faults).toHaveLength(1);
      expect(b.status(status(T0 + 2000, bad), false, T0 + 2000).faults).toEqual([]);
      expect(b.status(status(T0 + 3000), false, T0 + 3000)).toMatchObject({ changed: true });
    }
  });

  it("names a publishedAt more than 5 s from arrival, either way, once while it stands, and stays live (GA-BUS-2)", () => {
    const b = live();
    expect(b.status(status(T0 + 6_000 + 1000), false, T0 + 1000).faults).toHaveLength(1);
    expect(b.status(status(T0 - 6_000 + 2000), false, T0 + 2000).faults).toEqual([]);
    expect(b.status(status(T0 + 4_000 + 3000), false, T0 + 3000).faults).toEqual([]);
    expect(b.status(status(T0 + 6_000 + 4000), false, T0 + 4000).faults).toHaveLength(1);
    expect(b.alive).toBe(true);
  });

  it("without an instanceId is a fault, and no instance is remembered for it", () => {
    const b = live();
    const o = b.status(status(T0 + 1000, { instance_id: "" }), false, T0 + 1000);
    expect(o).toMatchObject({ changed: true, take: false, snapshot: false });
    expect(o.faults).toHaveLength(1);
    expect(b.status(status(T0 + 2000), false, T0 + 2000)).toMatchObject({ changed: true, snapshot: false });
  });

  it("takes an unparseable publishedAt as a fault, neither a heartbeat nor a revival (lesson 14)", () => {
    const b = live();
    expect(b.status(status(0, { published_at: undefined }), false, T0 + 20_000)).toMatchObject({ take: false, faults: [expect.any(String)] });
    expect(b.tick(T0 + DEAD_AFTER_MS + 1)).toMatchObject({ changed: true });
  });

  it("names an unparseable publishedAt once while it stands, not at every status", () => {
    const b = live();
    const bad = (at: number) => b.status(status(0, { published_at: undefined }), false, at);
    expect(bad(T0 + 1_000).faults).toHaveLength(1);
    expect(bad(T0 + 11_000).faults).toEqual([]);
    expect(b.status(status(T0 + 12_000), false, T0 + 12_000).faults).toEqual([]);
    expect(bad(T0 + 13_000).faults).toHaveLength(1);
  });

  it("asks for a snapshot on a new instance in a live status, a new instance in an event, and a seq gap; drops duplicates (GA-BUS-6)", () => {
    const b = live();
    expect(b.status(status(T0 + 1000), false, T0 + 1000).snapshot).toBe(false);
    expect(b.event(ev(1))).toMatchObject({ take: true, snapshot: false });
    expect(b.event(ev(1))).toMatchObject({ take: false, snapshot: false });
    expect(b.event(ev(2))).toMatchObject({ take: true, snapshot: false });
    expect(b.event(ev(4))).toMatchObject({ take: true, snapshot: true });
    expect(b.event(ev(3))).toMatchObject({ take: false });
    expect(b.event(ev(7, "i-2"))).toMatchObject({ take: true, snapshot: true });
    expect(b.status(status(T0 + 2000, { instance_id: "i-3" }), false, T0 + 2000).snapshot).toBe(true);
  });

  it("under its switches: trusts a retained status, takes a bad one, ignores a gap", () => {
    const r = new BridgeRules("b", T0, { trustsRetained: true });
    r.listening(T0);
    expect(r.status(status(T0), true, T0)).toMatchObject({ changed: true });
    const f = new BridgeRules("b", T0, { takesBadStatus: true });
    f.listening(T0);
    expect(f.status(status(T0, { v: undefined }), false, T0)).toMatchObject({ changed: true, faults: [] });
    const gaps = new BridgeRules("b", T0, { ignoresGaps: true });
    gaps.event(ev(1));
    expect(gaps.event(ev(5)).snapshot).toBe(false);
  });

  it("trusts-retained-online stays revived when the retained status lands before its SUBACK", () => {
    // The broker may deliver a bridge's retained status before the client sees that bridge's SUBACK
    // (the 5b port's matrix): the switch's revival must outlive the listening that follows.
    const r = new BridgeRules("b", T0, { trustsRetained: true });
    expect(r.status(status(T0), true, T0 + 400)).toMatchObject({ changed: true });
    r.listening(T0 + 401);
    expect(r.alive).toBe(true);
    // The switch off: the retained status names the instance, never a revival, and listening keeps it dead.
    const honest = new BridgeRules("b", T0);
    honest.status(status(T0), true, T0 + 400);
    honest.listening(T0 + 401);
    expect(honest.alive).toBe(false);
  });
});
