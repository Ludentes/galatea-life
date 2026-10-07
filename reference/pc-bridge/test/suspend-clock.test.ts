import { describe, expect, it } from "vitest";
import { SuspendClock } from "../src/suspend-clock.js";
import { FakeClock } from "./fakes.js";

/** A clock over a fake time source, and the times its timers fired at, on its own time. */
function setUp(source?: () => number) {
  const base = new FakeClock(1_000_000);
  const clock = new SuspendClock(base, source);
  const fired: [string, number][] = [];
  const at = (name: string, ms: number) => clock.setTimeout(() => fired.push([name, clock.now()]), ms);
  return { base, clock, fired, at };
}

describe("SuspendClock", () => {
  it("fires each timer at its time while awake, as the source runs", async () => {
    const { base, clock, fired, at } = setUp();
    const t0 = clock.now();
    at("ten", 10_000);
    at("two", 2_000);
    const gone = at("gone", 5_000);
    clock.clear(gone);
    await base.advance(9_999);
    expect(fired).toEqual([["two", t0 + 2_000]]);
    await base.advance(1);
    expect(fired).toEqual([["two", t0 + 2_000], ["ten", t0 + 10_000]]);
  });

  it("takes the whole sleep off a source that counted it, so a step over the suspend fires nothing", async () => {
    // The harness's order: power suspend, the clock stepped by N, power resume with suspendedMs N.
    const { base, clock, fired, at } = setUp();
    const t0 = clock.now();
    at("answer", 10_000);
    await base.advance(4_000);
    clock.freeze();
    expect(clock.isFrozen).toBe(true);
    await base.advance(3_600_000);
    expect(clock.now()).toBe(t0 + 4_000);
    clock.thaw(3_600_000);
    expect(fired).toEqual([]);
    expect(clock.now()).toBe(t0 + 4_000);
    await base.advance(5_999);
    expect(fired).toEqual([]);
    await base.advance(1);
    expect(fired).toEqual([["answer", t0 + 10_000]]);
  });

  it("takes nothing off a source that stopped in the suspend, as Node's monotonic clock does", async () => {
    let mono = 0;
    const { base, clock, fired, at } = setUp(() => mono);
    const awake = async (ms: number) => {
      for (let i = 0; i < ms / 1000; i++) {
        mono += 1000;
        await base.advance(1000);
      }
    };
    at("answer", 10_000);
    await awake(4_000);
    clock.freeze();
    // Asleep: the base clock's timers run on (they are checked and set again), the monotonic source does not.
    await base.advance(60_000);
    clock.thaw(60_000);
    expect(clock.now()).toBe(4_000);
    await awake(5_000);
    expect(fired).toEqual([]);
    await awake(1_000);
    expect(fired).toEqual([["answer", 10_000]]);
  });

  it("takes off only the time asleep when the source grew more across the suspend, the rest being time awake", async () => {
    const { base, clock, fired, at } = setUp();
    const t0 = clock.now();
    at("answer", 10_000);
    clock.freeze();
    await base.advance(20_000);
    // The OS slept 15 s of those 20: the other 5 s were awake, before the suspend or after the resume.
    clock.thaw(15_000);
    expect(clock.now()).toBe(t0 + 5_000);
    await base.advance(4_999);
    expect(fired).toEqual([]);
    await base.advance(1);
    expect(fired).toEqual([["answer", t0 + 10_000]]);
  });

  it("counts a suspend no one announced from the source's last look, the time asleep at most", async () => {
    const { base, clock, fired, at } = setUp();
    const t0 = clock.now();
    at("answer", 10_000);
    await base.advance(2_000);
    expect(clock.now()).toBe(t0 + 2_000);
    // The process froze with no word: the source jumped, and the resume reports the time asleep.
    base.step(3_600_000);
    clock.thaw(3_600_000);
    expect(clock.now()).toBe(t0 + 2_000);
    await base.advance(7_999);
    expect(fired).toEqual([]);
    await base.advance(1);
    expect(fired).toEqual([["answer", t0 + 10_000]]);
  });

  it("holds a timer set while frozen until the thaw, and keeps the first freeze of two", async () => {
    const { base, clock, fired, at } = setUp();
    const t0 = clock.now();
    clock.freeze();
    at("set asleep", 1_000);
    await base.advance(10_000);
    clock.freeze();
    await base.advance(10_000);
    expect(fired).toEqual([]);
    clock.thaw(20_000);
    await base.advance(1_000);
    expect(fired).toEqual([["set asleep", t0 + 1_000]]);
  });

  it("sets a timer due at once to fire at the next turn of the base clock", async () => {
    const { base, fired, at } = setUp();
    at("now", 0);
    at("negative", -5);
    await base.advance(0);
    expect(fired.map(([n]) => n)).toEqual(["now", "negative"]);
  });
});
