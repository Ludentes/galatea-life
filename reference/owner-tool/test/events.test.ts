import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { eventLine, EVENTS_WAIT_S, HISTORY_DEFAULT_S, parseTime } from "../src/commands/reading.js";
import { HISTORY_PAGES } from "../src/commands/reading.js";
import { Usage } from "../src/context.js";
import { Lost } from "../src/link.js";
import { fakeDeps, ok, refused } from "./fakes.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");

describe("an event's line", () => {
  it("is its time, seq and type, then its other fields as they are, objects as JSON", () => {
    expect(eventLine({ seq: 7, time: "2026-10-07T12:00:01.000Z", type: "outcome", apply_id: "a1", step_id: "s1", target: "sim-bridge:lamp",
      outcome: "acked", cause: { endpoint: "owner-app", apply: "a1" } }))
      .toBe('2026-10-07T12:00:01.000Z  #7  outcome  apply_id=a1 step_id=s1 target=sim-bridge:lamp outcome=acked cause={"endpoint":"owner-app","apply":"a1"}');
  });
});

describe("an event's line, escaped (review M6)", () => {
  it("escapes control characters in its fields", () => {
    expect(eventLine({ seq: 1, time: "t", type: "notice", text: "a\u001b]0;x\u0007b\nc" })).toBe("t  #1  notice  text=a\\x1b]0;x\\x07b\\nc");
  });
});

describe("galatea events", () => {
  it("reads from now: the current cursor, then one long-poll, its events printed and the cursor to read on from", async () => {
    const a = fakeDeps();
    a.steward.feed({ type: "define", diff: "old" });
    a.steward.queue("events", () => ok({ events: [], cursor: "1" }), () => {
      a.steward.feed({ type: "outcome", target: "sim-bridge:lamp", outcome: "acked" });
      return ok({ events: a.steward.log.slice(1), cursor: "2" });
    });
    expect(await run(["events"], a.deps)).toBe(0);
    expect(a.steward.calls).toEqual([{ tool: "events", args: {} }, { tool: "events", args: { cursor: "1", wait_s: EVENTS_WAIT_S } }]);
    expect(a.out).toEqual(["2026-10-07T12:00:00.000Z  #2  outcome  target=sim-bridge:lamp outcome=acked", "cursor 2: galatea events --cursor 2 reads on"]);
  });

  it("says when nothing came in its wait", async () => {
    const a = fakeDeps();
    expect(await run(["events"], a.deps)).toBe(0);
    expect(a.out).toEqual([`no event in ${EVENTS_WAIT_S} s`, "cursor 0: galatea events --cursor 0 reads on"]);
  });

  it("--cursor reads on from a cursor kept; one the steward no longer has is its refusal, 2", async () => {
    const a = fakeDeps();
    a.steward.feed({ type: "define" }, { type: "notice", text: "hi" });
    expect(await run(["events", "--cursor", "1"], a.deps)).toBe(0);
    expect(a.steward.calls).toEqual([{ tool: "events", args: { cursor: "1", wait_s: EVENTS_WAIT_S } }]);
    expect(a.out[0]).toMatch(/#2  notice  text=hi$/);
    const b = fakeDeps();
    expect(await run(["events", "--cursor", "99"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toMatch(/cursor_expired/);
  });

  it("--follow reads on as they come until Ctrl-C, which ends it 0 with the cursor said", async () => {
    const a = fakeDeps();
    let reads = 0;
    a.steward.queue("events", () => ok({ events: [], cursor: "0" }));
    for (let i = 0; i < 3; i++) {
      a.steward.queue("events", () => {
        reads++;
        a.steward.feed({ type: "state", target: "sim-bridge:lamp", key: "on", value: reads % 2 === 1 });
        if (reads === 3) a.interrupt();
        return ok({ events: [a.steward.log.at(-1)!], cursor: String(a.steward.log.length) });
      });
    }
    a.steward.queue("events", () => new Promise(() => undefined));
    expect(await run(["events", "--follow"], a.deps)).toBe(0);
    // The third read comes back with the Ctrl-C: not printed, and the cursor said is the one before it, so nothing is skipped.
    expect(a.out.filter((l) => / state /.test(l))).toHaveLength(2);
    expect(a.out.at(-1)).toBe("interrupted; cursor 2: galatea events --cursor 2 reads on");
    // Where it starts is said first, on the error stream, so a script (or the owner) knows it is listening.
    expect(a.err[0]).toBe("galatea events: following from cursor 0; Ctrl-C ends it");
    expect(a.handlers.size).toBe(0);
  });

  it("--follow past an expired cursor says events were missed and reads on from now", async () => {
    const a = fakeDeps();
    a.steward.queue("events", () => ok({ events: [], cursor: "5" }), refused("cursor_expired", "no longer kept"), () => ok({ events: [], cursor: "9" }),
      () => {
        a.interrupt();
        return ok({ events: [], cursor: "9" });
      });
    expect(await run(["events", "--follow"], a.deps)).toBe(0);
    expect(a.err.join("\n")).toMatch(/events after cursor 5 were missed \(cursor_expired: no longer kept\); reading on from now/);
    expect(a.steward.calls.map((c) => c.args)).toEqual([{}, { cursor: "5", wait_s: EVENTS_WAIT_S }, {}, { cursor: "9", wait_s: EVENTS_WAIT_S }]);
  });

  it("a lost call ends 1, saying the cursor to read on from (the ruling on a steward restart)", async () => {
    const a = fakeDeps();
    a.steward.queue("events", () => ok({ events: [], cursor: "4" }), () => { throw new Lost("the steward's events: socket hang up"); });
    expect(await run(["events", "--follow"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/lost the steward's events; cursor 4: galatea events --cursor 4 reads on/);
  });

  it("--json: each event as the steward returned it, one per line, then the tool's cursor line", async () => {
    const a = fakeDeps();
    a.steward.feed({ type: "notice", text: "hi" });
    expect(await run(["events", "--cursor", "0", "--json"], a.deps)).toBe(0);
    expect(a.out.map((l) => JSON.parse(l))).toEqual([{ seq: 1, time: "2026-10-07T12:00:00.000Z", type: "notice", text: "hi" }, { galatea: "cursor", cursor: "1" }]);
  });

  it("refuses a positional or an empty cursor, 2", async () => {
    const a = fakeDeps();
    expect(await run(["events", "x"], a.deps)).toBe(2);
    expect(await run(["events", "--cursor", ""], a.deps)).toBe(2);
    expect(a.steward.calls).toEqual([]);
  });
});

describe("--from and --to", () => {
  it("take RFC 3339 times with an offset, or a span ago (s, m, h, d)", () => {
    expect(parseTime("2026-10-07T10:00:00Z", NOW, "--from")).toBe(Date.parse("2026-10-07T10:00:00Z"));
    expect(parseTime("2026-10-07T13:00:00+03:00", NOW, "--from")).toBe(Date.parse("2026-10-07T10:00:00Z"));
    expect(parseTime("90s", NOW, "--from")).toBe(NOW - 90_000);
    expect(parseTime("15m", NOW, "--from")).toBe(NOW - 900_000);
    expect(parseTime("2h", NOW, "--from")).toBe(NOW - 7_200_000);
    expect(parseTime("7d", NOW, "--from")).toBe(NOW - 7 * 86_400_000);
    for (const bad of ["yesterday", "2026-10-07", "2026-10-07T10:00:00", "-2h", "2w", ""]) expect(() => parseTime(bad, NOW, "--from")).toThrow(Usage);
  });
});

describe("galatea history", () => {
  it("reads the last day by default, to a minute past now, and prints each event", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [{ seq: 3, time: "2026-10-07T11:00:00.000Z", type: "define", diff: "home" }] }));
    expect(await run(["history"], a.deps)).toBe(0);
    expect(a.steward.calls).toEqual([{ tool: "history", args: { from: new Date(NOW - HISTORY_DEFAULT_S * 1000).toISOString(), to: "2026-10-07T12:01:00.000Z" } }]);
    expect(a.out).toEqual(["2026-10-07T11:00:00.000Z  #3  define  diff=home"]);
  });

  it("names a target, and takes --from and --to", async () => {
    const a = fakeDeps();
    expect(await run(["history", "sim-bridge:lamp", "--from", "2h", "--to", "2026-10-07T11:30:00Z"], a.deps)).toBe(0);
    expect(a.steward.calls[0].args).toEqual({ from: "2026-10-07T10:00:00.000Z", to: "2026-10-07T11:30:00.000Z", targets: ["sim-bridge:lamp"] });
    expect(a.out).toEqual(["no event for sim-bridge:lamp from 2026-10-07T10:00:00.000Z to 2026-10-07T11:30:00.000Z"]);
  });

  it("refuses a bad time, --from not before --to, and two targets, 2, calling nothing", async () => {
    for (const argv of [["history", "--from", "soon"], ["history", "--from", "1h", "--to", "2h"], ["history", "a", "b"]]) {
      const a = fakeDeps();
      expect(await run(argv, a.deps)).toBe(2);
      expect(a.steward.calls).toEqual([]);
    }
  });

  it("reads on with after_seq while the steward says more, and says the cap when it is hit", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [{ seq: 1, type: "define" }, { seq: 2, type: "define" }], more: true }), ok({ events: [{ seq: 3, type: "define" }] }));
    expect(await run(["history"], a.deps)).toBe(0);
    expect(a.steward.calls.map((c) => c.args.after_seq)).toEqual([undefined, 2]);
    expect(a.out).toHaveLength(3);
    const b = fakeDeps();
    let seq = 0;
    for (let i = 0; i < HISTORY_PAGES + 1; i++) b.steward.queue("history", () => ok({ events: [{ seq: ++seq, type: "define" }], more: true }));
    expect(await run(["history", "--json"], b.deps)).toBe(0);
    expect(b.steward.calls).toHaveLength(HISTORY_PAGES);
    expect(JSON.parse(b.out.at(-1)!)).toEqual({ galatea: "history_partial", pages: HISTORY_PAGES, events: HISTORY_PAGES, after_seq: HISTORY_PAGES });
    expect(b.err.join("\n")).toMatch(new RegExp(`stopped after ${HISTORY_PAGES} pages \\(${HISTORY_PAGES} events\\).*--from`));
  });

  it("a history the steward cannot read is its refusal, 2", async () => {
    const a = fakeDeps();
    a.steward.queue("history", refused("invalid_request", "bad range"));
    expect(await run(["history"], a.deps)).toBe(2);
  });
});
