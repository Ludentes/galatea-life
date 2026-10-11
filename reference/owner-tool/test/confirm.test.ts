import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { OUTCOME_WITHIN_S, parseActionArgs } from "../src/commands/confirm.js";
import { HISTORY_PAGES } from "../src/commands/reading.js";
import { Usage } from "../src/context.js";
import { Lost } from "../src/link.js";
import { askEntry, fakeDeps, noSecretIn, ok, refused } from "./fakes.js";

const LAMP = "sim-bridge:lamp";
const TURN_ON = "onoff.turn_on";

describe("--arg k=v", () => {
  it("takes numbers, booleans and strings by their form, and any JSON with k:=", () => {
    expect(parseActionArgs(["level=40", "x=-1.5", "on=true", "off=false", "name=kitchen", "empty=", "code=042", "word=40a"])).toEqual({
      level: 40, x: -1.5, on: true, off: false, name: "kitchen", empty: "", code: "042", word: "40a" });
    expect(parseActionArgs(['code:="042"', 'obj:={"text":"hi","urgency":"low"}', "n:=null", "eq=a=b"])).toEqual({
      code: "042", obj: { text: "hi", urgency: "low" }, n: null, eq: "a=b" });
    expect(parseActionArgs([])).toEqual({});
  });

  it("keeps a decimal that does not round-trip through a number as its string (review M5, probe P3)", () => {
    expect(parseActionArgs(["id=12345678901234567890", "x=1.10", "z=-0", "ok=1.5", "big=9007199254740991"])).toEqual({
      id: "12345678901234567890", x: "1.10", z: "-0", ok: 1.5, big: 9007199254740991 });
  });

  it("refuses a bare value, an empty or odd name, a repeated name, and JSON that does not parse", () => {
    for (const bad of [["40"], ["=40"], ["a b=1"], ["level=1", "level=2"], ["obj:={nope"]]) {
      expect(() => parseActionArgs(bad)).toThrow(Usage);
    }
  });
});

describe("galatea do", () => {
  it("plans at owner-app, prints every step, applies, waits for the outcome and ends 0", async () => {
    const a = fakeDeps();
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "plan", "apply", "outcome"]);
    expect(a.steward.calls[1].args).toEqual({ endpoint: "owner-app", actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }] });
    const key = a.steward.calls[2].args.idempotency_key;
    expect(a.steward.calls[2].args).toEqual({ plan_id: "p1", idempotency_key: key });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.out).toEqual([
      expect.stringMatching(/^plan p1 at owner-app, revision 10, expires 2026-10-07T12:01:00\.000Z:$/),
      `  s1  ${LAMP}  onoff.turn_off  {}  tier reversible  op`,
      "applied: apply a1",
      `  s1  ${LAMP}  acked`,
    ]);
    expect(a.applier.calls).toEqual([]);
  });

  it("sends the arguments it parsed as the request's args object", async () => {
    const a = fakeDeps();
    expect(await run(["do", "sim-bridge:dimmer", "level.set_level", "--arg", "level=40", "--arg", "fade:=2"], a.deps)).toBe(0);
    expect(a.steward.calls[1].args.actions).toEqual([{ target: "sim-bridge:dimmer", action: "level.set_level", args: { level: 40, fade: 2 } }]);
    expect(a.out[1]).toBe('  s1  sim-bridge:dimmer  level.set_level  {"level":40,"fade":2}  tier reversible  op');
  });

  it("refuses a missing target or action and a bad --arg before calling anything, 2", async () => {
    for (const argv of [["do"], ["do", LAMP], ["do", LAMP, TURN_ON, "extra"], ["do", LAMP, TURN_ON, "--arg", "40"], ["do", LAMP, TURN_ON, "--arg", "a=1", "--arg", "a=2"]]) {
      const a = fakeDeps();
      expect(await run(argv, a.deps)).toBe(2);
      expect(a.steward.calls).toEqual([]);
    }
  });

  it("without --yes leaves a plan asked on owner-app open, printing the answer line, and ends 0", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    expect(await run(["do", LAMP, TURN_ON], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "plan", "events"]);
    expect(a.out).toEqual([
      expect.stringMatching(/^plan p1 at owner-app/),
      `  s1  ${LAMP}  ${TURN_ON}  {}  tier confirm  ask (confirm_tier)`,
      "asked on owner-app: s1; the plan stays open until 2026-10-07T12:05:00.000Z",
      "  galatea answer p1 s1 yes",
    ]);
  });

  it("with --yes answers the ask put on owner-app, applies, and waits for the outcome", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "no_voice";
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "plan", "events", "answer", "apply", "outcome"]);
    expect(a.steward.calls[3].args).toEqual({ plan_id: "p1", answers: { s1: "yes" }, endpoint: "owner-app" });
    expect(a.out.slice(2)).toEqual(["answered yes: s1", "applied: apply a1", `  s1  ${LAMP}  acked`]);
  });

  for (const reason of ["toggle_only", "in_use", "in_use_unknown", "occupancy_unknown"]) {
    it(`--yes does not answer an ask(${reason}): printed with why, the plan left open with its line, 0 (review I1, probe P1)`, async () => {
      const a = fakeDeps();
      a.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "ask", reason };
      expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(0);
      expect(a.steward.tools()).toEqual(["events", "plan", "events"]);
      expect(a.out.slice(1)).toEqual([
        `  s1  ${LAMP}  ${TURN_ON}  {}  tier reversible  ask (${reason})`,
        `not answered: s1 (${reason}): --yes answers only a tier's confirmation; this question is for the owner to read and answer`,
        "asked on owner-app: s1; the plan stays open until 2026-10-07T12:05:00.000Z",
        "  galatea answer p1 s1 yes",
      ]);
    });
  }

  it("--yes answers the confirm_tier steps and leaves another reason asked, applying nothing yet (review I1)", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.verdicts["sim-bridge:tv media.power"] = { verdict: "ask", reason: "toggle_only" };
    a.steward.queue("plan", () => a.steward.defaults.plan({ endpoint: "owner-app",
      actions: [{ target: LAMP, action: TURN_ON, args: {} }, { target: "sim-bridge:tv", action: "media.power", args: {} }] }));
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "plan", "events", "answer"]);
    expect(a.steward.calls[3].args.answers).toEqual({ s1: "yes" });
    expect(a.out.slice(3)).toEqual([
      "not answered: s2 (toggle_only): --yes answers only a tier's confirmation; this question is for the owner to read and answer",
      "answered yes: s1",
      "asked on owner-app: s2; the plan stays open until 2026-10-07T12:05:00.000Z",
      "  galatea answer p1 s2 yes",
    ]);
  });

  it("does not answer an ask put on another endpoint (a confirm_on): says where, leaves the plan open, ends 1", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.confirmOn = "phone";
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(1);
    expect(a.steward.tools()).toEqual(["events", "plan", "events"]);
    expect(a.err.join("\n")).toMatch(/the question is put on phone, not on owner-app/);
  });

  it("with no ask event seen, takes the ask as owner-app's and lets the steward judge the answer", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.noAskEvent = true;
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toContain("answer");
  });

  it("with no ask event seen and the question put elsewhere, the steward refuses the yes: not_permitted, 2", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.noAskEvent = true;
    a.steward.confirmOn = "phone";
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(2);
    expect(a.steward.tools()).toEqual(["events", "plan", "events", "answer"]);
    expect(a.err.join("\n")).toMatch(/the steward refused answer: not_permitted/);
  });

  it("a lost apply resent under its key gets the first apply back from the steward, not a second", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", () => {
      const r = a.steward.defaults.apply(a.steward.calls.at(-1)!.args);
      if (r.kind === "ok") throw new Lost("the steward's apply: socket hang up");
      return r;
    });
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(0);
    expect(a.steward.applies.size).toBe(1);
    expect(a.out.at(-1)).toBe(`  s1  ${LAMP}  acked`);
  });

  it("applies nothing when no step would be dispatched: 0 when every step is already so, else 2", async () => {
    const a = fakeDeps();
    a.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "skip", reason: "already" };
    expect(await run(["do", LAMP, TURN_ON], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "plan"]);
    expect(a.out.at(-1)).toBe("nothing to do: every step is already so");
    const b = fakeDeps();
    b.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "refuse", reason: "not_adopted" };
    expect(await run(["do", LAMP, TURN_ON, "--yes"], b.deps)).toBe(2);
    expect(b.steward.tools()).toEqual(["events", "plan"]);
    expect(b.out[1]).toBe(`  s1  ${LAMP}  ${TURN_ON}  {}  tier reversible  refuse (not_adopted)`);
    expect(b.err.join("\n")).toMatch(/no step of the plan would be dispatched; nothing was applied/);
  });

  it("waits on the steward's events between reads of the outcome until the step lands", async () => {
    const a = fakeDeps();
    a.steward.landAfterMs = 12_000;
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(0);
    const tools = a.steward.tools();
    expect(tools.slice(0, 3)).toEqual(["events", "plan", "apply"]);
    expect(tools.filter((t) => t === "outcome").length).toBeGreaterThan(1);
    expect(a.steward.calls.filter((c) => c.tool === "events" && c.args.cursor !== undefined).every((c) => c.args.wait_s <= 5)).toBe(true);
    expect(a.out.at(-1)).toBe(`  s1  ${LAMP}  acked`);
  });

  it("gives up waiting after OUTCOME_WITHIN_S, saying the action stands, and ends 1", async () => {
    const a = fakeDeps();
    a.steward.landAfterMs = (OUTCOME_WITHIN_S + 100) * 1000;
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.out.at(-1)).toBe(`  s1  ${LAMP}  unknown`);
    expect(a.err.join("\n")).toMatch(new RegExp(`no final outcome ${OUTCOME_WITHIN_S} s after the apply.*galatea events`));
  });

  it("an apply that returns no outcome for a step it was to dispatch is not success: 1, naming it (review M3, probe P2)", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", ok({ apply_id: "a1" }));
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/the steward gave no outcome for s1 of apply a1/);
    const b = fakeDeps();
    b.steward.queue("plan", () => b.steward.defaults.plan({ endpoint: "owner-app",
      actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }, { target: "sim-bridge:other", action: "onoff.turn_off", args: {} }] }));
    b.steward.queue("apply", ok({ apply_id: "a1", outcomes: [{ step_id: "s1", target: LAMP, outcome: "acked", time: "2026-10-07T12:00:00.000Z" }] }));
    expect(await run(["do", LAMP, "onoff.turn_off"], b.deps)).toBe(1);
    expect(b.err.join("\n")).toMatch(/no outcome for s2 of apply a1/);
  });

  it("ends 1 when a step does not land, saying its reason", async () => {
    const a = fakeDeps();
    a.steward.landAs = "failed";
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.out.at(-1)).toBe(`  s1  ${LAMP}  failed`);
  });

  it("sends a lost apply once more under the same key; lost twice it may have been applied, 1", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", () => { throw new Lost("the steward's apply: socket hang up"); });
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(0);
    const applies = a.steward.calls.filter((c) => c.tool === "apply");
    expect(applies).toHaveLength(2);
    expect(applies[0].args.idempotency_key).toBe(applies[1].args.idempotency_key);
    const b = fakeDeps();
    const lost = () => { throw new Lost("the steward's apply: socket hang up"); };
    b.steward.queue("apply", lost, lost);
    expect(await run(["do", LAMP, "onoff.turn_off"], b.deps)).toBe(1);
    expect(b.err.join("\n")).toMatch(/may have been applied/);
  });

  it("a refused apply ends 2 before anything was done, 1 after the tool's answer", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", refused("stale_revision", "the house moved"));
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/the steward refused apply: stale_revision/);
    const b = fakeDeps();
    b.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    b.steward.queue("apply", refused("plan_expired", "too late"));
    expect(await run(["do", LAMP, TURN_ON, "--yes"], b.deps)).toBe(1);
  });

  it("a refused plan ends 2", async () => {
    const a = fakeDeps();
    a.steward.queue("plan", refused("invalid_request", "bad action"));
    expect(await run(["do", LAMP, "nope"], a.deps)).toBe(2);
    expect(a.steward.tools()).toEqual(["events", "plan"]);
  });

  it("--json: the plan, the answer, the apply and the final outcome, one document per line, and no secret", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.landAfterMs = 3000;
    expect(await run(["do", LAMP, TURN_ON, "--yes", "--json"], a.deps)).toBe(0);
    const docs = a.out.map((l) => JSON.parse(l));
    expect(docs.map((d) => Object.keys(d).includes("steps") ? "plan" : d.apply_id ? "outcomes" : "?")).toEqual(["plan", "plan", "outcomes", "outcomes"]);
    expect(docs[1].steps[0].answer).toBe("yes");
    expect(docs[3].outcomes[0].outcome).toBe("acked");
    expect(noSecretIn(a.all())).toBe(true);
  });

  it("--json without --yes: the plan, then the tool's own line for the open plan", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    expect(await run(["do", LAMP, TURN_ON, "--json"], a.deps)).toBe(0);
    expect(JSON.parse(a.out[1])).toEqual({ galatea: "open", plan_id: "p1", step_ids: ["s1"], endpoint: "owner-app",
      expires_at: "2026-10-07T12:05:00.000Z", answer: "galatea answer p1 s1 yes" });
  });

  it("Ctrl-C while the apply is in flight says the apply may stand, 1, SIGINT given back (review M4)", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", () => {
      a.interrupt();
      return new Promise(() => undefined);
    });
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/interrupted while applying p1: the apply may stand; galatea history shows what happened/);
    expect(a.handlers.size).toBe(0);
  });

  it("Ctrl-C while it waits for the outcome stops waiting: the action stands, 1", async () => {
    const a = fakeDeps();
    a.steward.landAfterMs = 20_000;
    a.steward.queue("outcome", ...Array.from({ length: 2 }, () => () => {
      a.interrupt();
      return ok({ apply_id: "a1", outcomes: [{ step_id: "s1", target: LAMP, outcome: "unknown", time: "2026-10-07T12:00:00.000Z" }] });
    }));
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/interrupted: the apply a1 stands/);
    expect(a.handlers.size).toBe(0);
  });
});

describe("a held answer (review M1)", () => {
  const HELD = { kind: "held" as const, message: "the store did not answer within 10 s" };

  it("do --yes: says the yes stands at the steward, prints the line to run again, applies nothing, 1", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    a.steward.queue("answer", HELD);
    expect(await run(["do", LAMP, TURN_ON, "--yes"], a.deps)).toBe(1);
    expect(a.steward.tools()).not.toContain("apply");
    expect(a.err.join("\n")).toMatch(/the answer stands at the steward and is kept when its store answers.*galatea answer p1 s1 yes/s);
  });

  it("answer: the same, with the owner's own word in the line", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    await a.steward.plan({ actions: [{ target: LAMP, action: TURN_ON, args: {} }] });
    a.steward.calls.length = 0;
    a.steward.queue("answer", HELD);
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(1);
    expect(a.steward.tools()).toEqual(["answer"]);
    expect(a.err.join("\n")).toMatch(/galatea answer p1 s1 no/);
  });
});

describe("galatea answer", () => {
  /** A plan asked on owner-app, made through `do` without --yes. */
  async function asked(tiers: Record<string, string> = { [`${LAMP} ${TURN_ON}`]: "confirm" }) {
    const a = fakeDeps();
    Object.assign(a.steward.tiers, tiers);
    await a.steward.plan({ actions: Object.keys(tiers).map((k) => ({ target: k.split(" ")[0], action: k.split(" ")[1], args: {} })) });
    a.steward.calls.length = 0;
    return a;
  }

  it("answers, and applies the tool's own plan once nothing in it waits, waiting for the outcome", async () => {
    const a = await asked();
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer", "events", "apply", "outcome"]);
    expect(a.steward.calls[0].args).toEqual({ plan_id: "p1", answers: { s1: "yes" }, endpoint: "owner-app" });
    expect(a.out).toEqual(["answered yes: s1", `  s1  ${LAMP}  ${TURN_ON}  {}  tier confirm  ask (confirm_tier), answered yes`,
      "applied: apply a1", `  s1  ${LAMP}  acked`]);
  });

  it("takes the steps it answered as answered when the returned plan does not mark them", async () => {
    const a = await asked();
    a.steward.queue("answer", () => {
      const r = a.steward.defaults.answer({ plan_id: "p1", endpoint: "owner-app", answers: { s1: "yes" } });
      if (r.kind === "ok") for (const s of r.body.steps) delete s.answer;
      return r;
    });
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer", "events", "apply", "outcome"]);
  });

  it("without the field, takes an earlier run's answers from history's answer events, so a plan with an earlier no is applied (review M7)", async () => {
    const a = await asked({ [`${LAMP} ${TURN_ON}`]: "confirm", "sim-bridge:door lock.unlock": "no_voice" });
    expect(await run(["answer", "p1", "s2", "no"], a.deps)).toBe(0);
    a.steward.calls.length = 0;
    a.steward.queue("answer", () => {
      const r = a.steward.defaults.answer({ plan_id: "p1", endpoint: "owner-app", answers: { s1: "yes" } });
      if (r.kind === "ok") for (const x of r.body.steps) delete x.answer;
      return r;
    });
    a.steward.queue("history", () => ok({ events: a.steward.log.filter((e) => e.type === "answer") }));
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer", "describe", "history", "events", "apply", "outcome"]);
    expect(a.steward.calls[2].args).toEqual({ from: "2026-10-07T11:59:00.000Z", to: "2026-10-07T12:01:00.000Z" });
    expect(a.out.slice(-2)).toEqual([`  s1  ${LAMP}  acked`, "  s2  sim-bridge:door  skipped (not_confirmed)"]);
  });

  it("a no still applies the plan: the declined step is named and ends skipped, nothing sent for it, 0 (review M2)", async () => {
    const a = await asked();
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer", "events", "apply"]);
    expect(a.out.slice(2)).toEqual(["declined: s1; applied, so the plan is spent: each declined step ends skipped (not_confirmed)",
      "applied: apply a1", `  s1  ${LAMP}  skipped (not_confirmed)`]);
  });

  it("every asked step no, a step that needed no answer still runs (review M2, probe P4)", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    await a.steward.plan({ actions: [{ target: LAMP, action: TURN_ON, args: {} }, { target: "sim-bridge:other", action: TURN_ON, args: {} }] });
    a.steward.calls.length = 0;
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer", "events", "apply", "outcome"]);
    expect(a.out.slice(-2)).toEqual([`  s1  ${LAMP}  skipped (not_confirmed)`, `  s2  sim-bridge:other  acked`]);
  });

  it("applies nothing while a step still waits, printing the line for it", async () => {
    const a = await asked({ [`${LAMP} ${TURN_ON}`]: "confirm", "sim-bridge:door unlock.unlock": "no_voice" });
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer"]);
    expect(a.out.slice(-2)).toEqual(["still waiting for an answer: s2", "  galatea answer p1 s2 yes"]);
  });

  it("with a yes and a no, applies: the step answered no is skipped as the owner asked, 0", async () => {
    const a = await asked({ [`${LAMP} ${TURN_ON}`]: "confirm", "sim-bridge:door unlock.unlock": "no_voice" });
    expect(await run(["answer", "p1", "s2", "no"], a.deps)).toBe(0);
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.out.slice(-2)).toEqual([`  s1  ${LAMP}  acked`, "  s2  sim-bridge:door  skipped (not_confirmed)"]);
  });

  it("answers only a plan made elsewhere: its maker applies it", async () => {
    const a = fakeDeps();
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    // A voice endpoint whose confirm_on puts its questions on owner-app.
    a.steward.confirmOn = "owner-app";
    a.steward.queue("plan", () => {
      const r = a.steward.defaults.plan({ endpoint: "kitchen-voice", actions: [{ target: LAMP, action: TURN_ON, args: {} }] });
      return r;
    });
    await a.steward.plan({ actions: [] });
    a.steward.calls.length = 0;
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["answer"]);
    expect(a.out.at(-1)).toBe("the plan was made at kitchen-voice: whoever made it applies it");
  });

  it("refuses a malformed line before calling anything, 2", async () => {
    for (const argv of [["answer"], ["answer", "p1"], ["answer", "p1", "yes"], ["answer", "p1", "s1"], ["answer", "p1", "s1", "maybe"], ["answer", "p1", "s1", "s1", "yes"]]) {
      const a = fakeDeps();
      expect(await run(argv, a.deps)).toBe(2);
      expect(a.steward.calls).toEqual([]);
    }
  });

  it("a refused answer ends 2", async () => {
    const a = await asked();
    a.steward.queue("answer", refused("not_permitted", "another endpoint"));
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/the steward refused answer: not_permitted/);
  });

  it("--json: the plan as answered, the apply, the final outcome", async () => {
    const a = await asked();
    a.steward.landAfterMs = 2000;
    expect(await run(["answer", "p1", "s1", "yes", "--json"], a.deps)).toBe(0);
    const docs = a.out.map((l) => JSON.parse(l));
    expect(docs[0].steps[0].answer).toBe("yes");
    expect(docs.at(-1).outcomes[0].outcome).toBe("acked");
  });
});

describe("third-party text in plain output (review M6)", () => {
  it("escapes control characters in an outcome's detail and reason, and in a step's target", async () => {
    const a = fakeDeps();
    a.steward.queue("apply", ok({ apply_id: "a1", outcomes: [{ step_id: "s1", target: "sim-bridge:la\u001bmp", outcome: "failed", reason: "x\u0007y",
      detail: "\u001b[2Jgone\nnext\u009b", time: "2026-10-07T12:00:00.000Z" }] }));
    expect(await run(["do", LAMP, "onoff.turn_off"], a.deps)).toBe(1);
    expect(a.out.at(-1)).toBe("  s1  sim-bridge:la\\x1bmp  failed (x\\x07y): \\x1b[2Jgone\\nnext\\x9b");
    expect(a.all()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it("prints a define step (confirm_define) by its diff, not undefined", async () => {
    const a = fakeDeps();
    a.steward.queue("answer", ok({ plan_id: "p9", endpoint: "kitchen-voice", expires_at: "2026-10-07T12:05:00.000Z", revision: 3,
      steps: [{ step_id: "s1", verdict: "ask", reason: "confirm_define", diff: "rule: lights_off\nnew", answer: "yes" }] }));
    expect(await run(["answer", "p9", "s1", "yes"], a.deps)).toBe(0);
    expect(a.out[1]).toBe("  s1  define  rule: lights_off\\nnew  ask (confirm_define), answered yes");
  });
});

describe("galatea asks", () => {
  const ASK1 = { seq: 1, type: "ask", plan_id: "p1", step_ids: ["s1"], endpoint: "owner-app", time: "2026-10-07T11:58:00.000Z" };
  const ASK2 = { seq: 2, type: "ask", plan_id: "p2", step_ids: ["s1", "s2"], endpoint: "owner-app", time: "2026-10-07T11:59:00.000Z" };

  it("reads the asks put on owner-app over ask_expiry_s, less the answered, and shows what there is", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [ASK1, ASK2, { seq: 3, type: "ask", plan_id: "p3", step_ids: ["s1"], endpoint: "kitchen-voice" },
      { seq: 4, type: "answer", plan_id: "p2", answers: { s1: "yes" } }] }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.steward.calls[1].args).toEqual({ from: "2026-10-07T11:55:00.000Z", to: "2026-10-07T12:01:00.000Z" });
    expect(a.out).toEqual([
      "plan p1  asked on owner-app at 2026-10-07T11:58:00.000Z, open until 2026-10-07T12:03:00.000Z  waiting: s1",
      "  what is asked: not carried by this steward's ask event (steward 0.11 carries it)",
      "  galatea answer p1 s1 yes",
      "plan p2  asked on owner-app at 2026-10-07T11:59:00.000Z, open until 2026-10-07T12:04:00.000Z  waiting: s2",
      "  what is asked: not carried by this steward's ask event (steward 0.11 carries it)",
      "  galatea answer p2 s2 yes",
    ]);
  });

  it("shows each asked step when the ask event carries it (steward 0.11), whatever version the steward reports", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [{ ...ASK2, steps: [
      { step_id: "s1", target: LAMP, action: TURN_ON, args: {}, tier: "confirm", reason: "confirm_tier" },
      { step_id: "s2", target: "sim-bridge:door", action: "lock.unlock", args: {}, tier: "no_voice", reason: "confirm_tier" }] }] }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.out.slice(1, 3)).toEqual([
      `  s1  ${LAMP}  ${TURN_ON}  {}  tier confirm  (confirm_tier)`,
      "  s2  sim-bridge:door  lock.unlock  {}  tier no_voice  (confirm_tier)",
    ]);
  });

  it("shows a define's asked step as define and its diff, escaped (steward 0.11 draft: no target, its reason confirm_define)", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [{ ...ASK2, steps: [
      askEntry({ step_id: "s1", reason: "confirm_define", diff: "rooms: + kitchen\u001b[2J", target: "ignored" }),
      askEntry({ step_id: "s2", target: LAMP, action: TURN_ON, args: {}, tier: "confirm", reason: "confirm_tier" })] }] }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.out.slice(1, 3)).toEqual([
      "  s1  define  rooms: + kitchen\\x1b[2J  (confirm_define)",
      `  s2  ${LAMP}  ${TURN_ON}  {}  tier confirm  (confirm_tier)`,
    ]);
    expect(a.out.join("\n")).not.toMatch(/not carried/);
  });

  it("prints withheld args and a withheld diff as the plan output does, and never fails on them (GA-AUTH-7)", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [{ ...ASK2, steps: [
      { step_id: "s1", target: LAMP, action: "media.announce", args: { text: "withheld" }, tier: "confirm", reason: "confirm_tier" },
      { step_id: "s2", target: LAMP, action: TURN_ON, args: "withheld", tier: "confirm", reason: "confirm_tier" }] },
    { ...ASK1, plan_id: "p9", steps: [{ step_id: "s1", reason: "confirm_define", diff: "withheld" }] }] }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.out).toContain(`  s1  ${LAMP}  media.announce  {"text":"withheld"}  tier confirm  (confirm_tier)`);
    expect(a.out).toContain(`  s2  ${LAMP}  ${TURN_ON}  "withheld"  tier confirm  (confirm_tier)`);
    expect(a.out).toContain("  s1  define  withheld  (confirm_define)");
  });

  it("shows a re-ask's run_id when the event names one, and --json passes it through", async () => {
    const a = fakeDeps();
    a.steward.askCarriesSteps = true;
    a.steward.askRunId = "r7";
    a.steward.tiers[`${LAMP} ${TURN_ON}`] = "confirm";
    expect(await run(["do", LAMP, TURN_ON], a.deps)).toBe(0);
    const asked = a.steward.log.filter((e) => e.type === "ask");
    expect(asked[0].run_id).toBe("r7");
    a.out.length = 0;
    a.steward.queue("history", ok({ events: asked }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.out[0]).toMatch(/^plan p1  asked on owner-app at .*, run r7, open until .*  waiting: s1$/);
    expect(a.out[1]).toBe(`  s1  ${LAMP}  ${TURN_ON}  {}  tier confirm  (confirm_tier)`);
    const b = fakeDeps();
    b.steward.queue("history", ok({ events: [{ ...ASK1, run_id: "r7" }] }));
    expect(await run(["asks", "--json"], b.deps)).toBe(0);
    expect(JSON.parse(b.out[0])).toMatchObject({ galatea: "ask", plan_id: "p1", run_id: "r7", event: { run_id: "r7" } });
    const c = fakeDeps();
    c.steward.queue("history", ok({ events: [ASK1] }));
    expect(await run(["asks", "--json"], c.deps)).toBe(0);
    expect(JSON.parse(c.out[0])).not.toHaveProperty("run_id");
  });

  it("says when none waits, and --json prints one document per open ask", async () => {
    const a = fakeDeps();
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.out).toEqual(["no ask waits on owner-app"]);
    const b = fakeDeps();
    b.steward.queue("history", ok({ events: [ASK1] }));
    expect(await run(["asks", "--json"], b.deps)).toBe(0);
    expect(b.out.map((l) => JSON.parse(l))).toEqual([{ galatea: "ask", plan_id: "p1", waiting: ["s1"], endpoint: "owner-app",
      asked_at: ASK1.time, open_until: "2026-10-07T12:03:00.000Z", event: ASK1 }]);
  });

  it("says the list is partial past the history cap", async () => {
    const a = fakeDeps();
    let seq = 0;
    for (let i = 0; i < HISTORY_PAGES + 1; i++) a.steward.queue("history", () => ok({ events: [{ ...ASK1, seq: ++seq, plan_id: `p${seq}` }], more: true }));
    expect(await run(["asks"], a.deps)).toBe(0);
    expect(a.err.join("\n")).toMatch(new RegExp(`read from the first ${HISTORY_PAGES} pages of history only`));
  });
});
