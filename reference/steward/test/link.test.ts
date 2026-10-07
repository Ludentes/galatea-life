import { describe, expect, it, vi } from "vitest";
import { ApplierLink, FIRST_BACKOFF_MS, LAST_BACKOFF_MS, RECOVERY_AHEAD_MS, RECOVERY_PAGE_MS, type Dropped } from "../src/link/link.js";
import { Mirror } from "../src/link/mirror.js";
import { NotSent } from "../src/link/port.js";
import { FakeApplier } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";

const CHANNEL = { id: "sim-bridge:channel", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] };
const LAMP = { id: "sim-bridge:lamp", class: "light", capabilities: ["onoff"], adopted: true, actions: [{ action: "onoff.turn_on", tier: "reversible" }] };

function setup(applier = new FakeApplier()) {
  const clock = new FakeClock();
  const mirror = new Mirror(() => undefined);
  const moved: number[] = [];
  const lines: string[] = [];
  const link = new ApplierLink({
    clock, connect: async () => applier.port(), log: (l) => lines.push(l),
    steps: {
      describe: (d) => { if (mirror.setDescribe(d)) moved.push(d.revision); },
      state: (s) => mirror.setState(s),
      events: (events) => { for (const e of events) mirror.applyEvent(e); },
    },
  });
  return { applier, clock, mirror, moved, lines, link };
}

describe("ApplierLink", () => {
  it("reads the applier's model and state, then follows its events", async () => {
    const applier = new FakeApplier();
    applier.devices = [CHANNEL, LAMP];
    applier.targets = { [LAMP.id]: { values: [{ key: "on", value: false }], liveness: "live" } };
    const { mirror, moved, link } = setup(applier);
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    expect([...mirror.devices.keys()]).toEqual([CHANNEL.id, LAMP.id]);
    expect(mirror.deviceView(CHANNEL.id)).toEqual({ adopted: true, internal: false, actions: ["notify.notify"] });
    expect(mirror.underHarness).toBe(true);
    expect(moved).toEqual([1]);
    applier.emit({ type: "state", target: LAMP.id, key: "on", value: true });
    await vi.waitFor(() => expect(mirror.state.get(LAMP.id)?.values).toEqual([{ key: "on", value: true, basis_time: undefined }]));
    // A state change moves no model.
    expect(moved).toEqual([1]);
    await link.stop();
  });

  it("hands on every answer's notices, the sync's and an empty batch's too, and names the delivered ones in notice_taken (GA-NOTE-1)", async () => {
    const applier = new FakeApplier();
    applier.devices = [CHANNEL];
    applier.raise({ notice_id: "n-1", cause: "join_window", text: "a" });
    const seen: string[][] = [];
    let taken: string[] = [];
    const clock = new FakeClock();
    const mirror = new Mirror(() => undefined);
    const link = new ApplierLink({ clock, connect: async () => applier.port(), log: () => undefined,
      steps: { describe: (d) => mirror.setDescribe(d), state: (s) => mirror.setState(s), events: () => undefined,
        notices: (n) => { seen.push(n.map((x) => `${x.notice_id}${mirror.devices.has(CHANNEL.id) ? "" : " before the model"}`)); }, taken: () => taken } });
    link.start();
    await vi.waitFor(() => expect(seen[0]).toEqual(["n-1"]));
    applier.raise({ notice_id: "n-2", cause: "join_window", text: "b" });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["n-1", "n-2"]));
    taken = ["n-1"];
    applier.emit({ type: "state", target: CHANNEL.id, key: "x", value: 1 });
    // Taken on the next call, which waits; its answer no longer lists it.
    await vi.waitFor(() => expect(applier.taken).toEqual(["n-1"]));
    applier.emit({ type: "state", target: CHANNEL.id, key: "x", value: 2 });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["n-2"]));
    await link.stop();
  });

  it("re-reads describe and state on a model event, and the model moves with the applier's revision (GA-HOUSE-1)", async () => {
    const { applier, mirror, moved, link } = setup();
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    applier.devices = [CHANNEL, LAMP];
    // A device the model brings reports no state event for the values it came with.
    applier.targets = { [LAMP.id]: { values: [{ key: "on", value: true }], liveness: "live" } };
    applier.emit({ type: "model", revision: 2 });
    await vi.waitFor(() => expect(moved).toEqual([1, 2]));
    expect(mirror.devices.has(CHANNEL.id)).toBe(true);
    await vi.waitFor(() => expect(mirror.state.get(LAMP.id)?.values).toEqual([{ key: "on", value: true }]));
    await link.stop();
  });

  it("plans on the applier while a session is up, and says it is out of reach otherwise", async () => {
    const { applier, link } = setup();
    await expect(link.plan({ actions: [] })).rejects.toThrow(/out of reach/);
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    const plan = await link.plan({ actions: [{ target: LAMP.id, action: "onoff.turn_on", args: {}, via: "app", brain: false, for: { endpoint: "e" } }] });
    expect(plan.steps).toEqual([expect.objectContaining({ target: LAMP.id, verdict: "op", tier: "reversible" })]);
    expect(applier.plans).toHaveLength(1);
    await link.stop();
  });

  it("applies on the session that is up, and says nothing was sent while none is", async () => {
    const { applier, link } = setup();
    const body = { request: { actions: [{ target: LAMP.id, action: "onoff.turn_on", args: {}, via: "app", brain: false, for: { endpoint: "e" } }] },
      idempotency_key: "a-1" };
    await expect(link.apply(body, 10_000)).rejects.toBeInstanceOf(NotSent);
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    expect((await link.apply(body, 10_000)).outcomes).toEqual([expect.objectContaining({ target: LAMP.id, outcome: "dispatched" })]);
    expect(applier.applies).toEqual([body]);
    await link.stop();
  });

  it("reads the model and the state again on cursor_expired, in the same session", async () => {
    const { applier, link } = setup();
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    const reads = () => applier.calls.filter((c) => c === "describe" || c === "state").length;
    expect(reads()).toBe(2);
    applier.emit({ type: "state", target: "x", key: "on", value: true });
    applier.expire();
    await vi.waitFor(() => expect(reads()).toBe(4));
    expect(applier.connects).toBe(1);
    await link.stop();
  });

  it("after a gap reads the applier's history from the last event the steward had, and hands it to recover with the state, not to state", async () => {
    const applier = new FakeApplier();
    const clock = new FakeClock();
    const got: string[] = [];
    let since: { seq: number; timeMs: number } | undefined;
    const link = new ApplierLink({ clock, connect: async () => applier.port(), log: () => undefined,
      steps: { describe: () => undefined, state: () => got.push("state"),
        events: (events) => { since = { seq: events.at(-1)!.seq, timeMs: clock.now() }; },
        since: () => since, recover: (missed, _s, cursor) => got.push(`recover ${missed.map((e) => e.seq).join(",")} up to ${cursor}`) } });
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    expect(got).toEqual(["state"]);
    expect(applier.histories).toEqual([]);
    applier.emit({ type: "state", target: "x", key: "on", value: true });
    await vi.waitFor(() => expect(since?.seq).toBe(1));
    applier.emit({ type: "state", target: "x", key: "on", value: false });
    applier.expire();
    await vi.waitFor(() => expect(got).toEqual(["state", "recover 2 up to 2"]));
    expect(applier.histories).toEqual([{ from: new Date(clock.now()).toISOString(), to: new Date(clock.now() + RECOVERY_AHEAD_MS).toISOString() }]);
    await link.stop();
  });

  it("goes on without the history when the applier refuses it, and says so", async () => {
    const { ApplierRefused } = await import("../src/link/port.js");
    const applier = new FakeApplier();
    applier.failNext.set("history", new ApplierRefused("not_claimed", "no history here"));
    const got: string[] = [];
    const lines: string[] = [];
    const link = new ApplierLink({ clock: new FakeClock(), connect: async () => applier.port(), log: (l) => lines.push(l),
      steps: { describe: () => undefined, state: () => got.push("state"), events: () => undefined,
        since: () => ({ seq: 0, timeMs: 0 }), recover: () => got.push("recover") } });
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    expect(got).toEqual(["state"]);
    expect(lines.filter((l) => l.includes("refused its history"))).toHaveLength(1);
    await link.stop();
  });

  it("goes on without the history when reading it fails otherwise, a timeout, and says so (the code review, CR2)", async () => {
    const applier = new FakeApplier();
    const got: string[] = [];
    const lines: string[] = [];
    const timingOut = async () => ({ ...applier.port(), history: async () => { throw new Error("the applier did not answer history within 10 s"); } });
    const link = new ApplierLink({ clock: new FakeClock(), connect: timingOut, log: (l) => lines.push(l),
      steps: { describe: () => undefined, state: () => got.push("state"), events: () => undefined,
        since: () => ({ seq: 0, timeMs: 0 }), recover: () => got.push("recover") } });
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    expect(got).toEqual(["state"]);
    expect(lines.filter((l) => l.includes("could not be read") && l.includes("within 10 s"))).toHaveLength(1);
    await link.stop();
  });

  it("makes the session again with backoff on the clock, 250 ms doubling to 5 s, and says so once", async () => {
    const { applier, clock, lines, link } = setup();
    const failing = applier.port.bind(applier);
    let fails = 6;
    applier.port = () => {
      const p = failing();
      if (fails-- > 0) return { ...p, describe: async () => { throw new Error("down"); } };
      return p;
    };
    link.start();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await vi.waitFor(() => expect(applier.connects).toBe(i + 1));
      // The failed session closes, then the pause is set on the clock.
      await new Promise((r) => setTimeout(r, 5));
      const before = applier.connects;
      let waited = 0;
      while (applier.connects === before) {
        clock.advance(FIRST_BACKOFF_MS);
        waited += FIRST_BACKOFF_MS;
        await new Promise((r) => setTimeout(r, 1));
      }
      waits.push(waited);
    }
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, LAST_BACKOFF_MS]);
    await vi.waitFor(() => { clock.advance(LAST_BACKOFF_MS); expect(link.connected).toBe(true); });
    expect(lines.filter((l) => l.includes("out of reach"))).toHaveLength(1);
    await link.stop();
  });
});

describe("the link at the start (the milestone review, B4)", () => {
  it("is up before the first state's step runs, so a rule fired by it can plan and apply", async () => {
    const applier = new FakeApplier();
    applier.devices = [CHANNEL, LAMP];
    const clock = new FakeClock();
    const mirror = new Mirror(() => undefined);
    let upAtState: boolean | undefined;
    const link: ApplierLink = new ApplierLink({ clock, connect: async () => applier.port(), log: () => undefined,
      steps: { describe: (d) => mirror.setDescribe(d), state: () => { upAtState = link.connected; }, events: () => undefined } });
    link.start();
    await vi.waitFor(() => expect(upAtState).toBe(true));
    await link.stop();
  });
});

describe("the mirror and a malformed describe (the milestone review, M4)", () => {
  it("leaves out a device missing what applier/device.json requires, saying so once, and reads a declared ack_within_s of 0 as 0", () => {
    // Its lines go to the injected logger, never to standard error (the milestone 7+10+11 review, M6).
    const lines: string[] = [];
    const mirror = new Mirror((l) => lines.push(l));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const ok = { ...LAMP, feedback: "closed", actions: [{ action: "onoff.turn_on", tier: "reversible", idempotent: true, stateless: false, ack_within_s: 0 }] };
      const bad = { ...CHANNEL, feedback: "closed", actions: [{ action: "notify.notify", tier: "reversible", idempotent: false, stateless: true }] };
      const d = { applier_id: "a", standard_version: "0.14", levels: ["Act"], ungoverned: [], revision: 1, devices: [ok, bad] };
      mirror.setDescribe(d);
      mirror.setDescribe({ ...d, revision: 2 });
      expect([...mirror.devices.keys()]).toEqual([LAMP.id]);
      expect(mirror.ackWithinS(LAMP.id, "onoff.turn_on")).toBe(0);
      expect(mirror.idempotent(LAMP.id, "onoff.turn_on")).toBe(true);
      expect(lines.filter((l) => l.includes(CHANNEL.id))).toHaveLength(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the link's recovery read (the milestone 7+10+11 review, B2)", () => {
  it("hands recover every event up to the cursor, even one the applier stamped after the steward's now", async () => {
    const applier = new FakeApplier();
    const clock = new FakeClock();
    const iso = (ms: number) => new Date(ms).toISOString();
    let since: { seq: number; timeMs: number } | undefined;
    const recovered: number[][] = [];
    const link = new ApplierLink({ clock, connect: async () => applier.port(), log: () => undefined,
      steps: { describe: () => undefined, state: () => undefined,
        events: (events) => { const e = events.at(-1)!; since = { seq: e.seq, timeMs: Date.parse(e.time) }; },
        since: () => since, recover: (missed, _s, cursor) => { recovered.push(missed.filter((e) => e.seq <= Number(cursor)).map((e) => e.seq)); } } });
    link.start();
    await vi.waitFor(() => expect(link.connected).toBe(true));
    applier.emit({ type: "state", target: "x", key: "on", value: true, time: iso(clock.now()) });
    await vi.waitFor(() => expect(since?.seq).toBe(1));
    // The applier's clock is 2 s ahead of the steward's.
    applier.emit({ type: "state", target: "x", key: "on", value: false, time: iso(clock.now() + 2_000), cause: "external" });
    applier.expire();
    await vi.waitFor(() => expect(recovered.length).toBe(1));
    await link.stop();
    // Seq 1 the steward had; seq 2 is at or before the sync's cursor, so `events` will never serve it.
    expect(recovered[0]).toEqual([2]);
  });
});

describe("the link's recovery read in pages (the milestone 7+10+11 review, I2 and I3)", () => {
  it("reads the gap back from now in windows, holds at most the cap of the newest, and every event that grants or ends a lease", async () => {
    const applier = new FakeApplier();
    const clock = new FakeClock();
    const now = clock.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const H = 3_600_000;
    applier.emit({ type: "state", target: "x", key: "on", value: true, time: iso(now - 5 * H) });
    applier.emit({ type: "state", target: "door", key: "open", value: true, time: iso(now - 4.5 * H), cause: "external" });
    applier.emit({ type: "latch", rule_id: "leak", latch: "set", time: iso(now - 4 * H) });
    for (let i = 0; i < 6; i++) applier.emit({ type: "state", target: `d${i}`, key: "on", value: true, time: iso(now - (3.5 - i * 0.5) * H), cause: "device" });
    applier.emit({ type: "rule_fired", rule_id: "flush", outcomes: [], notice: null, time: iso(now - 3.2 * H) });
    let handed: { seqs: number[]; dropped?: Dropped } | undefined;
    const link = new ApplierLink({ clock, connect: async () => applier.port(), log: () => undefined, recoveryCap: 2,
      steps: { describe: () => undefined, state: () => undefined, events: () => undefined,
        since: () => ({ seq: 1, timeMs: now - 5 * H }), recover: (missed, _s, _c, dropped) => { handed = { seqs: missed.map((e) => e.seq), dropped }; } } });
    link.start();
    await vi.waitFor(() => expect(handed).toBeDefined());
    await link.stop();
    // The door's outside change, leak's latch and flush's completion, and the two newest of the rest.
    expect(handed!.seqs).toEqual([2, 3, 8, 9, 10]);
    expect(handed!.dropped).toEqual({ count: 4, targets: ["d0", "d1", "d2", "d3"] });
    // Paged back from now: the first window an hour, none reaching past the last event had.
    expect(applier.histories.length).toBeGreaterThan(1);
    expect(applier.histories[0]).toEqual({ from: iso(now - RECOVERY_PAGE_MS), to: iso(now + RECOVERY_AHEAD_MS) });
    expect(Date.parse(applier.histories.at(-1)!.from)).toBe(now - 5 * H);
    for (let i = 1; i < applier.histories.length; i++) expect(Date.parse(applier.histories[i]!.to)).toBe(Date.parse(applier.histories[i - 1]!.from) - 1);
  });
});
