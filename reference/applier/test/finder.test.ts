import { describe, expect, it } from "vitest";
import { Mutant, mutantOf } from "../src/mutations.js";
import { Finder } from "../src/provision/finder.js";
import { FakeClock } from "./fake-clock.js";

const status = (extra: Record<string, unknown> = {}, at = 0) => Buffer.from(JSON.stringify({ finderId: "f", instanceId: "i1", v: 1,
  levels: ["Find"], sources: [{ source: "mdns", state: "up" }, { source: "dhcp", state: "off" }], faults: [], publishedAt: new Date(at).toISOString(), ...extra }));
const quiet = () => undefined;

describe("Finder", () => {
  it("is none until heard, dead until a live status, then dead 30 s after the last", () => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: Mutant.none });
    expect(f.view()).toEqual({ finder: "none", sources: [], faults: [], candidates: [] });
    f.message("status", status({}, clock.now()), true);
    expect(f.view().finder).toBe("dead");
    f.message("status", status({}, clock.now()), false);
    expect(f.view()).toMatchObject({ finder: "live", sources: [{ source: "mdns", state: "up" }, { source: "dhcp", state: "off" }] });
    clock.advance(30_000);
    f.tick();
    expect(f.view().finder).toBe("live");
    clock.advance(1);
    f.tick();
    expect(f.view().finder).toBe("dead");
  });

  it("dies on its will naming the latest instance, ignores one naming another, and dies on a graceful status or a status without v", () => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: Mutant.none });
    const live = () => f.message("status", status({}, clock.now()), false);
    live();
    f.message("lwt", Buffer.from(JSON.stringify({ finderId: "f", instanceId: "other" })), false);
    expect(f.view().finder).toBe("live");
    f.message("lwt", Buffer.alloc(0), true);
    expect(f.view().finder).toBe("live");
    f.message("lwt", Buffer.from(JSON.stringify({ finderId: "f", instanceId: "i1" })), false);
    expect(f.view().finder).toBe("dead");
    clock.advance(10_000); live();
    expect(f.view().finder).toBe("live");
    f.message("status", status({ graceful: true }, clock.now()), false);
    expect(f.view().finder).toBe("dead");
    clock.advance(10_000); live();
    f.message("status", status({ v: undefined }, clock.now()), false);
    expect(f.view().finder).toBe("dead");
    clock.advance(10_000); live();
    f.message("status", status({ v: 2 }, clock.now()), false);
    expect(f.view().finder).toBe("dead");
  });

  it("takes any finderId: a finder's identity is not checked below Box", () => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: Mutant.none });
    f.message("status", status({ finderId: "another-finder" }, clock.now()), false);
    expect(f.view().finder).toBe("live");
  });

  it("revives only on a live status published no earlier than its death less 5 s (GA-BUS-8)", () => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: Mutant.none });
    f.listening();
    f.message("status", status({}, clock.now() - 6000), false);
    expect(f.view().finder).toBe("dead");
    f.message("status", status({}, clock.now() - 4000), false);
    expect(f.view().finder).toBe("live");
    f.lost();
    expect(f.view().finder).toBe("dead");
  });

  it("adds clock to its faults while its publishedAt is off by more than 5 s, and drops it once right", () => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: Mutant.none });
    f.message("status", status({ faults: [{ code: "overflow", detail: "64" }, { nope: 1 }] }, clock.now() + 60_000), false);
    expect(f.view().faults).toEqual([{ code: "overflow", detail: "64" }, { code: "clock" }]);
    f.message("status", status({ faults: [] }, clock.now()), false);
    expect(f.view().faults).toEqual([]);
  });

  it("keeps its last list when dead, in snake case, and drops a malformed entry, logged once (K6)", () => {
    const clock = new FakeClock();
    const logged: string[] = [];
    const f = new Finder({ clock, log: (l) => void logged.push(l), mutant: Mutant.none });
    const list = Buffer.from(JSON.stringify({ publishedAt: new Date(0).toISOString(), candidates: [
      { id: "c1", sources: ["dhcp"], keys: ["mac:D4A651000001"], address: { ip: "192.0.2.10" }, firstSeen: "1970-01-01T00:00:00Z",
        lastSeen: "1970-01-01T00:00:00Z", hints: { vendor: "demo" }, matches: [{ bridgeType: "esphome", connect: true }] },
      { id: "c2", sources: ["mdns"] },
      { id: "c3", sources: ["mdns"], keys: ["mac:D4A651000003", 7], matches: [] }] }));
    f.message("candidates", list, true);
    f.message("candidates", list, true);
    expect(f.view()).toMatchObject({ finder: "dead", candidates: [{ id: "c1", sources: ["dhcp"], keys: ["mac:D4A651000001"],
      address: { ip: "192.0.2.10" }, first_seen: "1970-01-01T00:00:00Z", last_seen: "1970-01-01T00:00:00Z", hints: { vendor: "demo" },
      matches: [{ bridge_type: "esphome", connect: true }] }] });
    expect(f.view().candidates).toHaveLength(1);
    expect(logged.filter((l) => l.includes("c2"))).toHaveLength(1);
    expect(logged.filter((l) => l.includes("c3"))).toHaveLength(1);
    // A list that is not a list leaves the last one; an empty one clears it.
    f.message("candidates", Buffer.from(JSON.stringify({ publishedAt: new Date(0).toISOString() })), false);
    expect(f.view().candidates).toHaveLength(1);
    f.message("candidates", Buffer.from(JSON.stringify({ publishedAt: new Date(0).toISOString(), candidates: [] })), false);
    expect(f.view().candidates).toEqual([]);
  });

  it.each([undefined, "trusts-a-dead-finder"] as const)("says dead after a death, mutation %s", (mutation) => {
    const clock = new FakeClock();
    const f = new Finder({ clock, log: quiet, mutant: mutantOf(mutation) });
    f.message("status", status({}, clock.now()), false);
    clock.advance(30_001); f.tick();
    expect(f.view().finder).toBe(mutation ? "live" : "dead");
  });
});
