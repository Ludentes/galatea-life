import { describe, expect, it } from "vitest";
import { HostState, OBSERVE_MS, UP_WINDOW_MS } from "../src/host.js";

/** One check as the bridge makes it: the observer, an observation if due, then the state. */
function check(h: HostState, now: number, present: boolean, succeeds: boolean): boolean {
  h.setPresent(present, now);
  if (h.due(now)) h.observed(present && succeeds, now);
  return h.evaluate(now);
}

describe("HostState", () => {
  it("starts down and goes up on the first successful observation", () => {
    const h = new HostState(0);
    expect(h.state).toBe("down");
    expect(check(h, 0, true, true)).toBe(true);
    expect(h.state).toBe("up");
    expect(h.retryIntervalMs).toBeUndefined();
  });

  it("stays up for the window after the last success, and goes down after it", () => {
    const h = new HostState(0);
    check(h, 0, true, true);
    for (let now = 1000; now <= UP_WINDOW_MS; now += 1000) {
      check(h, now, true, false);
      expect(h.state, `at ${now} ms`).toBe("up");
    }
    expect(check(h, UP_WINDOW_MS + 1000, true, false)).toBe(true);
    expect(h.state).toBe("down");
    expect(h.since).toBe(UP_WINDOW_MS + 1000);
  });

  it("observes at least every 10 s while up", () => {
    const h = new HostState(0);
    check(h, 0, true, true);
    expect(h.due(OBSERVE_MS - 1)).toBe(false);
    expect(h.due(OBSERVE_MS)).toBe(true);
  });

  it("goes down at once when the observer is lost, and tries nothing until it returns", () => {
    const h = new HostState(0);
    check(h, 0, true, true);
    expect(check(h, 500, false, true)).toBe(true);
    expect(h.state).toBe("down");
    expect(h.retryIntervalMs).toBeUndefined();
    expect(h.due(100_000)).toBe(false);
  });

  it("backs off 10, 20, 40 s to a 60 s ceiling while down, reached within 180 s", () => {
    const h = new HostState(0);
    check(h, 0, true, false);
    const waits: number[] = [];
    let now = 0;
    for (let i = 0; i < 6; i++) {
      waits.push(h.retryIntervalMs!);
      now += h.retryIntervalMs!;
      expect(h.due(now - 1)).toBe(false);
      check(h, now, true, false);
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(10_000 + 20_000 + 40_000).toBeLessThanOrEqual(180_000);
  });

  it("observes at once when the observer returns, but keeps the backoff", () => {
    const h = new HostState(0);
    let now = 0;
    check(h, now, true, false);
    for (let i = 0; i < 3; i++) {
      now += h.retryIntervalMs!;
      check(h, now, true, false);
    }
    expect(h.retryIntervalMs).toBe(60_000);
    check(h, now + 1000, false, false);
    expect(h.due(now + 2000)).toBe(false);
    h.setPresent(true, now + 2000);
    expect(h.due(now + 2000)).toBe(true);
    h.observed(false, now + 2000);
    expect(h.retryIntervalMs).toBe(60_000);
  });

  it("observes at once when asked at a resume, keeping the backoff", () => {
    const h = new HostState(0);
    check(h, 0, true, false);
    check(h, 10_000, true, false);
    expect(h.due(10_001)).toBe(false);
    h.observeAtOnce(10_001);
    expect(h.due(10_001)).toBe(true);
    expect(h.retryIntervalMs).toBe(20_000);
  });

  it("resets the backoff only on a successful observation", () => {
    const h = new HostState(0);
    check(h, 0, true, false);
    check(h, 10_000, true, false);
    expect(h.retryIntervalMs).toBe(20_000);
    check(h, 30_000, true, true);
    expect(h.state).toBe("up");
    check(h, 30_000 + UP_WINDOW_MS + 1000, true, false);
    expect(h.state).toBe("down");
    expect(h.retryIntervalMs).toBe(10_000);
  });

  it("goes down when the clock steps back past the last success, never up for the step's length", () => {
    const h = new HostState(0);
    check(h, 100_000, true, true);
    expect(h.state).toBe("up");
    // The wall clock steps back an hour and the observations fail: no success is fresh any more.
    expect(check(h, 100_000 - 3_600_000, true, false)).toBe(true);
    expect(h.state).toBe("down");
  });

  it("observes at once after a small step back past the last success, and stays up through it", () => {
    const h = new HostState(0);
    check(h, 100_000, true, true);
    // A step back of 2 s leaves the next observation due within the ceiling, yet the success lies in the future.
    expect(h.due(98_000)).toBe(true);
    expect(check(h, 98_000, true, true)).toBe(false);
    expect(h.state).toBe("up");
  });

  it("backs off after a small step back whose re-check fails, never observing every second (GA-BRIDGE-11)", () => {
    const h = new HostState(0);
    check(h, 100_000, true, true);
    expect(check(h, 98_000, true, false)).toBe(true);
    expect(h.state).toBe("down");
    for (let now = 99_000; now < 98_000 + OBSERVE_MS; now += 1000) expect(h.due(now), `at ${now} ms`).toBe(false);
    expect(h.due(98_000 + OBSERVE_MS)).toBe(true);
    check(h, 98_000 + OBSERVE_MS, true, false);
    expect(h.retryIntervalMs).toBe(20_000);
  });

  it("is up at exactly the window's age and down a millisecond after", () => {
    const h = new HostState(0);
    check(h, 0, true, true);
    h.observed(false, UP_WINDOW_MS);
    expect(h.evaluate(UP_WINDOW_MS)).toBe(false);
    expect(h.state).toBe("up");
    expect(h.evaluate(UP_WINDOW_MS + 1)).toBe(true);
    expect(h.state).toBe("down");
  });

  it("observes at once after the clock steps back, not after the step's length", () => {
    const h = new HostState(0);
    check(h, 100_000, true, true);
    const back = 100_000 - 3_600_000;
    expect(h.due(back)).toBe(true);
    check(h, back, true, true);
    expect(h.state).toBe("up");
    expect(h.due(back + OBSERVE_MS - 1)).toBe(false);
    expect(h.due(back + OBSERVE_MS)).toBe(true);
  });
});
