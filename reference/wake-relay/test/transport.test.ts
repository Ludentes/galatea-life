import { describe, expect, it } from "vitest";
import { LinkState, PROBE_MS, RELAY_UP_WITHOUT_ARP, UP_WINDOW_MS } from "../src/transport.js";

/** One check as the relay makes it: the carrier, a probe if due, then the state. */
function check(t: LinkState, now: number, carrier: boolean, answers: boolean): boolean {
  t.setCarrier(carrier, now);
  if (t.probeDue(now)) t.probed(carrier && answers, now);
  return t.evaluate(now);
}

describe("LinkState", () => {
  it("starts down and goes up on the gateway's first answer", () => {
    const t = new LinkState(0);
    expect(t.state).toBe("down");
    expect(check(t, 0, true, true)).toBe(true);
    expect(t.state).toBe("up");
    expect(t.retryIntervalMs).toBeUndefined();
  });

  it("stays up for the window after the last answer, and goes down after it", () => {
    const t = new LinkState(0);
    check(t, 0, true, true);
    for (let now = 1000; now <= UP_WINDOW_MS; now += 1000) {
      check(t, now, true, false);
      expect(t.state, `at ${now} ms`).toBe("up");
    }
    expect(check(t, UP_WINDOW_MS + 1000, true, false)).toBe(true);
    expect(t.state).toBe("down");
    expect(t.since).toBe(UP_WINDOW_MS + 1000);
  });

  it("probes at least every 10 s while up", () => {
    const t = new LinkState(0);
    check(t, 0, true, true);
    expect(t.probeDue(PROBE_MS - 1)).toBe(false);
    expect(t.probeDue(PROBE_MS)).toBe(true);
  });

  it("goes down at once without a carrier", () => {
    const t = new LinkState(0);
    check(t, 0, true, true);
    expect(check(t, 500, false, true)).toBe(true);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBeUndefined();
    expect(t.probeDue(100_000)).toBe(false);
  });

  it("backs off 10, 20, 40 s to a 60 s ceiling while down, reached within 180 s", () => {
    const t = new LinkState(0);
    check(t, 0, true, false);
    const waits: number[] = [];
    let now = 0;
    for (let i = 0; i < 6; i++) {
      waits.push(t.retryIntervalMs!);
      now += t.retryIntervalMs!;
      expect(t.probeDue(now - 1)).toBe(false);
      check(t, now, true, false);
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(10_000 + 20_000 + 40_000).toBeLessThanOrEqual(180_000);
  });

  it("probes at once when the carrier returns, but keeps the backoff", () => {
    const t = new LinkState(0);
    let now = 0;
    check(t, now, true, false);
    for (let i = 0; i < 3; i++) {
      now += t.retryIntervalMs!;
      check(t, now, true, false);
    }
    expect(t.retryIntervalMs).toBe(60_000);
    check(t, now + 1000, false, false);
    expect(t.probeDue(now + 2000)).toBe(false);
    t.setCarrier(true, now + 2000);
    expect(t.probeDue(now + 2000)).toBe(true);
    t.probed(false, now + 2000);
    expect(t.retryIntervalMs).toBe(60_000);
  });

  it("resets the backoff on an answer", () => {
    const t = new LinkState(0);
    check(t, 0, true, false);
    check(t, 10_000, true, false);
    expect(t.retryIntervalMs).toBe(20_000);
    check(t, 30_000, true, true);
    expect(t.state).toBe("up");
    check(t, 30_000 + UP_WINDOW_MS + 1000, true, false);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBe(10_000);
  });

  it("under relay-up-without-arp, is up on a carrier alone", () => {
    const t = new LinkState(0, RELAY_UP_WITHOUT_ARP);
    check(t, 0, true, false);
    expect(t.state).toBe("up");
    check(t, 0, false, false);
    expect(t.state).toBe("down");
  });

  it("goes down when the clock steps back past the last answer, and probes at once", () => {
    const t = new LinkState(0);
    check(t, 100_000, true, true);
    const back = 100_000 - 3_600_000;
    expect(t.probeDue(back)).toBe(true);
    expect(check(t, back, true, false)).toBe(true);
    expect(t.state).toBe("down");
  });

  it("probes at once after a small step back past the last answer, and stays up when it answers", () => {
    const t = new LinkState(0);
    check(t, 100_000, true, true);
    expect(t.probeDue(98_000)).toBe(true);
    expect(check(t, 98_000, true, true)).toBe(false);
    expect(t.state).toBe("up");
  });

  it("backs off after a small step back whose probe fails, never probing every second (GA-BRIDGE-11)", () => {
    const t = new LinkState(0);
    check(t, 100_000, true, true);
    expect(check(t, 98_000, true, false)).toBe(true);
    for (let now = 99_000; now < 98_000 + PROBE_MS; now += 1000) expect(t.probeDue(now), `at ${now} ms`).toBe(false);
    expect(t.probeDue(98_000 + PROBE_MS)).toBe(true);
  });

  it("probes at once after the clock steps back while down, not after the step's length", () => {
    const t = new LinkState(0);
    check(t, 0, true, false);
    check(t, 10_000, true, false);
    expect(t.probeDue(10_001)).toBe(false);
    expect(t.probeDue(10_000 - 3_600_000)).toBe(true);
  });

  it("is never up on an answer dated after now", () => {
    const t = new LinkState(0);
    check(t, 100_000, true, true);
    expect(t.evaluate(98_000)).toBe(true);
    expect(t.state).toBe("down");
  });
});
