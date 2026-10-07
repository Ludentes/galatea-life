import { describe, expect, it } from "vitest";
import { EXCHANGE_MS, Link, TransportLink, UP_WINDOW_MS, type LinkMutation, type TransportState } from "../src/transport.js";
import { FakeClock, settle } from "./fakes.js";

/** One check as the link makes it: an exchange if due, then the state. */
function check(t: TransportLink, now: number, succeeds: boolean): boolean {
  if (t.due(now)) t.exchanged(succeeds, now);
  return t.evaluate(now);
}

describe("TransportLink", () => {
  it("starts down with no retry shown, and goes up on the first successful exchange", () => {
    const t = new TransportLink(0);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBeUndefined();
    expect(check(t, 0, true)).toBe(true);
    expect(t.state).toBe("up");
    expect(t.retryIntervalMs).toBeUndefined();
  });

  it("stays up for the window after the last success, and goes down after it", () => {
    const t = new TransportLink(0);
    check(t, 0, true);
    for (let now = 1000; now <= UP_WINDOW_MS; now += 1000) {
      check(t, now, false);
      expect(t.state, `at ${now} ms`).toBe("up");
    }
    expect(check(t, UP_WINDOW_MS + 1000, false)).toBe(true);
    expect(t.state).toBe("down");
    expect(t.since).toBe(UP_WINDOW_MS + 1000);
  });

  it("exchanges at least every 10 s while up", () => {
    const t = new TransportLink(0);
    check(t, 0, true);
    expect(t.due(EXCHANGE_MS - 1)).toBe(false);
    expect(t.due(EXCHANGE_MS)).toBe(true);
  });

  it("goes down at once when the link is lost, and tries again on the backoff", () => {
    const t = new TransportLink(0);
    check(t, 0, true);
    t.lost(500);
    expect(t.evaluate(500)).toBe(true);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBe(10_000);
    expect(t.due(10_499)).toBe(false);
    expect(t.due(10_500)).toBe(true);
  });

  it("backs off 10, 20, 40 s to a 60 s ceiling while down, reached within 180 s", () => {
    const t = new TransportLink(0);
    check(t, 0, false);
    const waits: number[] = [];
    let now = 0;
    for (let i = 0; i < 6; i++) {
      waits.push(t.retryIntervalMs!);
      now += t.retryIntervalMs!;
      expect(t.due(now - 1)).toBe(false);
      check(t, now, false);
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(10_000 + 20_000 + 40_000).toBeLessThanOrEqual(180_000);
  });

  it("tries at once when asked, keeping the backoff", () => {
    const t = new TransportLink(0);
    check(t, 0, false);
    check(t, 10_000, false);
    expect(t.due(10_001)).toBe(false);
    t.exchangeAtOnce(10_001);
    expect(t.due(10_001)).toBe(true);
    expect(t.retryIntervalMs).toBe(20_000);
  });

  it("resets the backoff only on a successful exchange", () => {
    const t = new TransportLink(0);
    check(t, 0, false);
    check(t, 10_000, false);
    expect(t.retryIntervalMs).toBe(20_000);
    check(t, 30_000, true);
    expect(t.state).toBe("up");
    check(t, 30_000 + UP_WINDOW_MS + 1000, false);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBe(10_000);
  });

  it("takes a connect for no exchange: still down, and the backoff goes on", () => {
    const t = new TransportLink(0);
    check(t, 0, false);
    t.connected(10_000);
    expect(t.evaluate(10_000)).toBe(false);
    check(t, 10_000, false);
    expect(t.state).toBe("down");
    expect(t.retryIntervalMs).toBe(20_000);
  });

  it("under resets-on-connect, a connect resets the backoff", () => {
    const t = new TransportLink(0, "resets-on-connect");
    check(t, 0, false);
    for (const now of [10_000, 20_000, 30_000]) {
      t.connected(now);
      check(t, now, false);
      expect(t.retryIntervalMs, `at ${now} ms`).toBe(10_000);
    }
  });

  it("under up-without-exchange, a connect alone is up", () => {
    const t = new TransportLink(0, "up-without-exchange");
    check(t, 0, false);
    t.connected(10_000);
    expect(t.evaluate(10_000)).toBe(true);
    expect(t.state).toBe("up");
  });

  it("goes down when the clock steps back past the last success, never up for the step's length", () => {
    const t = new TransportLink(0);
    check(t, 100_000, true);
    expect(check(t, 100_000 - 3_600_000, false)).toBe(true);
    expect(t.state).toBe("down");
  });

  it("exchanges at once after a small step back past the last success, and stays up through it", () => {
    const t = new TransportLink(0);
    check(t, 100_000, true);
    expect(t.due(98_000)).toBe(true);
    expect(check(t, 98_000, true)).toBe(false);
    expect(t.state).toBe("up");
  });

  it("is up at exactly the window's age and down a millisecond after", () => {
    const t = new TransportLink(0);
    check(t, 0, true);
    t.exchanged(false, UP_WINDOW_MS);
    expect(t.evaluate(UP_WINDOW_MS)).toBe(false);
    expect(t.evaluate(UP_WINDOW_MS + 1)).toBe(true);
    expect(t.state).toBe("down");
  });
});

describe("Link", () => {
  function link(answers: () => boolean, mutation?: LinkMutation) {
    const clock = new FakeClock();
    const reports: { state: TransportState; since: number; retryIntervalMs?: number }[] = [];
    let probes = 0;
    const l: Link = new Link({
      clock,
      probe: async () => {
        probes += 1;
        // Each try while down opens the host link first, as the herdsman doer's rebuild does.
        if (l.t.state === "down") l.connected();
        return answers();
      },
      report: (state, since, retryIntervalMs) => reports.push({ state, since, ...(retryIntervalMs !== undefined ? { retryIntervalMs } : {}) }),
      ...(mutation ? { mutation } : {}),
    });
    return { l, clock, reports, probes: () => probes };
  }

  it("reports down as it starts, then up on its first exchange", async () => {
    const { l, clock, reports } = link(() => true);
    await l.start();
    expect(reports).toEqual([{ state: "down", since: clock.now() }, { state: "up", since: clock.now() }]);
    l.stop();
  });

  it("makes a health exchange every 10 s of its clock while up, and reports nothing new", async () => {
    const { l, clock, reports, probes } = link(() => true);
    await l.start();
    await clock.advance(30_000);
    expect(probes()).toBe(4);
    expect(reports).toHaveLength(2);
    l.stop();
  });

  it("counts a device's message as an exchange, putting the next health exchange off", async () => {
    const { l, clock, probes } = link(() => true);
    await l.start();
    await clock.advance(9_000);
    l.heard();
    await clock.advance(9_000);
    expect(probes()).toBe(1);
    l.stop();
  });

  it("goes down within the window when the coordinator stops answering, then reports each longer retry", async () => {
    let answering = true;
    const { l, clock, reports } = link(() => answering);
    await l.start();
    answering = false;
    await clock.advance(31_000);
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 10_000 });
    await clock.advance(60_000);
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 40_000 });
    answering = true;
    await l.exchangeNow();
    expect(reports.at(-1)).toEqual({ state: "up", since: clock.now() });
    l.stop();
  });

  it("connects on each try while down with no answer, and still backs off to its ceiling", async () => {
    const { l, clock, reports } = link(() => false);
    await l.start();
    await clock.advance(180_000);
    expect(reports.every((r) => r.state === "down")).toBe(true);
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 60_000 });
    l.stop();
  });

  it("under resets-on-connect, never backs off past its first wait", async () => {
    const { l, clock, reports } = link(() => false, "resets-on-connect");
    await l.start();
    await clock.advance(180_000);
    expect(Math.max(...reports.map((r) => r.retryIntervalMs ?? 0))).toBe(10_000);
    l.stop();
  });

  /** A link whose probe waits until the test answers it, as a coordinator slow to reply. */
  function heldLink() {
    const clock = new FakeClock();
    const reports: { state: TransportState; since: number; retryIntervalMs?: number }[] = [];
    const answers: ((ok: boolean | Error) => void)[] = [];
    const l = new Link({
      clock,
      probe: () => new Promise<boolean>((resolve, reject) => {
        answers.push((ok) => (ok instanceof Error ? reject(ok) : resolve(ok)));
      }),
      report: (state, since, retryIntervalMs) => reports.push({ state, since, ...(retryIntervalMs !== undefined ? { retryIntervalMs } : {}) }),
    });
    /** Answers the oldest probe still waiting, and lets the link take the answer. */
    const answer = async (ok: boolean | Error) => {
      answers.shift()!(ok);
      await settle();
    };
    return { l, clock, reports, answer, waiting: () => answers.length };
  }

  it("counts a probe that throws as a failed exchange, and backs off", async () => {
    const { l, clock, reports, answer } = heldLink();
    const started = l.start();
    await answer(new Error("the adapter threw"));
    await started;
    expect(reports.at(-1)).toEqual({ state: "down", since: clock.now(), retryIntervalMs: 10_000 });
    l.stop();
  });

  it("does not show up a link lost while its probe ran, when the probe then succeeds", async () => {
    const { l, clock, reports, answer } = heldLink();
    const started = l.start();
    await answer(true);
    await started;
    expect(l.t.state).toBe("up");
    await clock.advance(10_000);
    // The health exchange is running; the stack says the link is gone.
    l.lost();
    await answer(true);
    expect(l.t.state).toBe("down");
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 10_000 });
    l.stop();
  });

  it("does not back off twice for one loss, when the probe running at the loss then fails", async () => {
    const { l, clock, reports, answer } = heldLink();
    const started = l.start();
    await answer(true);
    await started;
    await clock.advance(10_000);
    l.lost();
    await answer(false);
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 10_000 });
    l.stop();
  });

  it("shows up at once on a device's message while down, and starts its backoff again", async () => {
    const { l, clock, reports, answer } = heldLink();
    const started = l.start();
    await answer(false);
    await started;
    await clock.advance(10_000);
    await answer(false);
    expect(reports.at(-1)).toMatchObject({ state: "down", retryIntervalMs: 20_000 });
    l.heard();
    expect(reports.at(-1)).toEqual({ state: "up", since: clock.now() });
    expect(l.t.retryIntervalMs).toBeUndefined();
    l.stop();
  });

  it("does nothing on a second start while running", async () => {
    const { l, clock, reports, answer, waiting } = heldLink();
    const started = l.start();
    await l.start();
    expect(waiting()).toBe(1);
    await answer(true);
    await started;
    expect(reports).toEqual([{ state: "down", since: clock.now() }, { state: "up", since: clock.now() }]);
    l.stop();
  });

  it("makes a try of its own on a start after a stop, when the try from before the stop is still running", async () => {
    const { l, clock, answer, waiting } = heldLink();
    const started = l.start();
    await answer(true);
    await started;
    await clock.advance(10_000);
    expect(waiting()).toBe(1);
    l.stop();
    const again = l.start();
    // The try from before the stop answers for a link that was stopped; the start makes its own.
    await answer(true);
    expect(waiting()).toBe(1);
    await answer(true);
    await again;
    expect(l.t.state).toBe("up");
    l.stop();
  });

  it("makes a try of its own after one already running, when asked to exchange now", async () => {
    const { l, clock, answer, waiting } = heldLink();
    const started = l.start();
    await answer(true);
    await started;
    await clock.advance(10_000);
    expect(waiting()).toBe(1);
    const now = l.exchangeNow();
    await answer(false);
    // The try that was running is done; exchangeNow's own try now waits for its answer.
    expect(waiting()).toBe(1);
    await answer(true);
    await now;
    expect(l.t.state).toBe("up");
    l.stop();
  });

  it("reports down at once when the link is lost, and nothing after a stop", async () => {
    const { l, clock, reports } = link(() => false);
    await l.start();
    l.lost();
    expect(reports.at(-1)).toMatchObject({ state: "down" });
    const n = reports.length;
    l.stop();
    await clock.advance(120_000);
    expect(reports).toHaveLength(n);
  });
});
