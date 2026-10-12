import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { SCENARIO_WITHIN_S } from "../src/commands/scenario.js";
import { Lost } from "../src/link.js";
import { fakeDeps, noSecretIn, ok, refused } from "./fakes.js";

const LAMP = "sim-bridge:lamp";
const TURN_ON = "onoff.turn_on";
const TURN_OFF = "onoff.turn_off";
const T0 = "2026-10-07T12:00:00.000Z";

/** `evening`: the lamp on, a second, the lamp off, as the end-to-end test defines it. */
const EVENING = { id: "evening", name: "Вечер", mode: "single", owned: [LAMP],
  steps: [{ target: LAMP, action: TURN_ON, args: {} }, { delay: 1 }, { target: LAMP, action: TURN_OFF, args: {} }] };

function withEvening(o: { tiers?: Record<string, string> } = {}) {
  const a = fakeDeps();
  a.steward.scenarios = [structuredClone(EVENING)];
  Object.assign(a.steward.tiers, o.tiers ?? {});
  return a;
}

describe("galatea scenario list", () => {
  it("lists the steward's scenarios from describe: id, name, mode and step count, 0", async () => {
    const a = withEvening();
    a.steward.scenarios.push({ id: "night", mode: "restart", steps: [] });
    expect(await run(["scenario", "list"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["describe"]);
    expect(a.out).toEqual(["evening  «Вечер»  single  3 steps", "night  no name  restart  0 steps"]);
  });

  it("says when none is defined, 0", async () => {
    const a = fakeDeps();
    expect(await run(["scenario", "list"], a.deps)).toBe(0);
    expect(a.out).toEqual(["no scenario is defined"]);
  });

  it("--json: the revision and the scenarios as describe gives them, one document", async () => {
    const a = withEvening();
    expect(await run(["scenario", "list", "--json"], a.deps)).toBe(0);
    expect(JSON.parse(a.out[0])).toEqual({ revision: 10, scenarios: [EVENING] });
  });
});

describe("galatea scenario run", () => {
  it("plans at owner-app, prints every step, starts the run and prints each step's outcome as it lands, 0", async () => {
    const a = withEvening();
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.steward.tools().slice(0, 3)).toEqual(["events", "scenario_plan", "scenario_run"]);
    expect(a.steward.calls[1].args).toEqual({ scenario: "evening", endpoint: "owner-app" });
    const key = a.steward.calls[2].args.idempotency_key;
    expect(a.steward.calls[2].args).toEqual({ plan_id: "p1", idempotency_key: key });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.out).toEqual([
      "plan p1 of scenario evening at owner-app, revision 10, expires 2026-10-07T12:01:00.000Z:",
      `  s1  ${LAMP}  ${TURN_ON}  {}  tier reversible  op`,
      `  s2  ${LAMP}  ${TURN_OFF}  {}  tier reversible  op`,
      "started: run r1",
      `  s1  ${LAMP}  acked`,
      `  s2  ${LAMP}  acked`,
      "run r1 ended (done)",
    ]);
    expect(a.applier.calls).toEqual([]);
  });

  it("waits on the steward's events while a step is on its way, reading scenario_status between", async () => {
    const a = withEvening();
    a.steward.landAfterMs = 3000;
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.steward.tools()).toContain("scenario_status");
    expect(a.steward.calls.filter((c) => c.tool === "events" && c.args.wait_s > 0).length).toBeGreaterThan(0);
    expect(a.out.at(-1)).toBe("run r1 ended (done)");
  });

  it("starts a run whose steps are already so: the run judges each step again at dispatch (GA-SCN-7)", async () => {
    const a = withEvening();
    a.steward.verdicts[`${LAMP} ${TURN_OFF}`] = { verdict: "skip", reason: "already" };
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.steward.tools()).toContain("scenario_run");
    expect(a.out).toContain(`  s2  ${LAMP}  skipped (already)`);
  });

  it("starts nothing when every step of the plan is refused: 2", async () => {
    const a = withEvening();
    a.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "refuse", reason: "role" };
    a.steward.verdicts[`${LAMP} ${TURN_OFF}`] = { verdict: "refuse", reason: "role" };
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(2);
    expect(a.steward.tools()).not.toContain("scenario_run");
    expect(a.err.join("\n")).toMatch(/every step of the plan is refused; no run was started/);
  });

  it("an unknown scenario is the steward's refusal before anything was done, 2", async () => {
    const a = fakeDeps();
    expect(await run(["scenario", "run", "nope"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/the steward refused scenario_plan: invalid_request: no scenario nope/);
  });

  it("without --yes leaves a plan asked on owner-app open with the answer line, starting nothing, 0", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.steward.tools()).toEqual(["events", "scenario_plan", "events"]);
    expect(a.out.slice(-2)).toEqual(["asked on owner-app: s1; the plan stays open until 2026-10-07T12:05:00.000Z", "  galatea answer p1 s1 yes"]);
  });

  it("with --yes answers the tier's ask, then starts the run and follows it, 0", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    expect(await run(["scenario", "run", "evening", "--yes"], a.deps)).toBe(0);
    expect(a.steward.tools().slice(0, 5)).toEqual(["events", "scenario_plan", "events", "answer", "scenario_run"]);
    expect(a.steward.calls[3].args).toEqual({ plan_id: "p1", answers: { s1: "yes" }, endpoint: "owner-app" });
    expect(a.out).toContain("answered yes: s1");
    expect(a.out).toContain(`  s1  ${LAMP}  acked`);
    expect(a.out.at(-1)).toBe("run r1 ended (done)");
  });

  it("--yes answers only a tier's ask: another reason is left open with its line, nothing started (as do)", async () => {
    const a = withEvening();
    a.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "ask", reason: "toggle_only" };
    expect(await run(["scenario", "run", "evening", "--yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).not.toContain("scenario_run");
    expect(a.out.join("\n")).toMatch(/not answered: s1 \(toggle_only\)/);
    expect(a.out.at(-1)).toBe("  galatea answer p1 s1 yes");
  });

  it("does not answer an ask put on another endpoint: says where, starts nothing, 1", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    a.steward.confirmOn = "owner-phone";
    expect(await run(["scenario", "run", "evening", "--yes"], a.deps)).toBe(1);
    expect(a.steward.tools()).not.toContain("scenario_run");
    expect(a.err.join("\n")).toMatch(/galatea scenario run: the question is put on owner-phone/);
  });

  it("a step that fails under way: the run ends done with it in failed_steps, said, 1", async () => {
    const a = withEvening();
    a.steward.landAs = "failed";
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.out).toContain(`  s1  ${LAMP}  failed`);
    expect(a.out.slice(-3)).toEqual(["run r1 ended (done)", `  failed: s1 failed at ${T0}`, `  failed: s2 failed at ${new Date(Date.parse(T0) + 1000).toISOString()}`]);
  });

  it("a step the owner declined is no failure of the run for the tool: 0 (as do counts it)", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    a.out.length = 0;
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(0);
    expect(a.out).toContain(`  s1  ${LAMP}  skipped (not_confirmed)`);
    expect(a.out.join("\n")).toMatch(/^  failed: s1 skipped \(not_confirmed\) at \S+, as the owner answered$/m);
  });

  it("a start the steward ignores (a single scenario running) says the running run, nothing done: 2", async () => {
    const a = withEvening();
    a.steward.landAfterMs = 600_000;
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    a.out.length = 0;
    a.err.length = 0;
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/scenario evening is running already as run r1 \(mode single\): this start was ignored; galatea scenario status r1/);
  });

  it(`gives up following after SCENARIO_WITHIN_S (${SCENARIO_WITHIN_S} s), printing the run id to follow up with: 1`, async () => {
    const a = withEvening();
    a.steward.scenarios[0].steps[1] = { delay: 600 };
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.out).toContain(`  s1  ${LAMP}  acked`);
    expect(a.err.join("\n")).toMatch(new RegExp(`run r1 is still running ${SCENARIO_WITHIN_S} s after it started; galatea scenario status r1 follows it, galatea scenario stop r1 stops it`));
  });

  it("a run stopped while it is followed ends stopped, not completed: 1", async () => {
    const a = withEvening();
    a.steward.scenarios[0].steps[1] = { delay: 30 };
    a.steward.queue("scenario_status", () => ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] }), () => {
      void a.steward.defaults.scenario_stop({ run_id: "r1", endpoint: "owner-app" });
      return a.steward.defaults.scenario_status({ run_id: "r1" });
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.out.at(-1)).toBe("run r1 ended (stopped)");
    expect(a.err.join("\n")).toMatch(/the run r1 ended \(stopped\), not completed/);
  });

  it("shows an if step's branch and a wait's timeout from the run's scenario events", async () => {
    const a = withEvening();
    a.steward.queue("scenario_status", () => {
      a.steward.feed({ type: "scenario", run_id: "r1", scenario: "evening", change: "if", step_id: "if1", branch: "then", cause: { run: "r1" } },
        { type: "scenario", run_id: "r1", scenario: "evening", change: "wait_timeout", step_id: "w1", on_timeout: "continue", cause: { run: "r1" } },
        { type: "scenario", run_id: "r9", scenario: "other", change: "if", step_id: "if1", branch: "else", cause: { run: "r9" } });
      return ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] });
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.out).toContain("  if1  if: then");
    expect(a.out).toContain("  w1  wait timed out (continue)");
    expect(a.out.join("\n")).not.toMatch(/else/);
  });

  it("shows a re-ask on the run's plan with its answer line, never answering it (GA-SCN-3)", async () => {
    const a = withEvening();
    a.steward.queue("scenario_status", () => {
      a.steward.feed({ type: "ask", plan_id: "p1", run_id: "r1", step_ids: ["s2"], endpoint: "owner-app",
        steps: [{ step_id: "s2", target: LAMP, action: TURN_OFF, args: {}, tier: "reversible", reason: "toggle_only" }] });
      return ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] });
    });
    expect(await run(["scenario", "run", "evening", "--yes"], a.deps)).toBe(0);
    expect(a.out).toContain("asked again on owner-app: s2; the run waits for the answer");
    expect(a.out).toContain(`  s2  ${LAMP}  ${TURN_OFF}  {}  tier reversible  (toggle_only)`);
    expect(a.out).toContain("  galatea answer p1 s2 yes");
    expect(a.steward.tools()).not.toContain("answer");
  });

  it("sends a lost scenario_run once more under the same key; lost twice it may have started, 1", async () => {
    const a = withEvening();
    a.steward.queue("scenario_run", () => {
      throw new Lost("the steward's answer to scenario_run was lost", false);
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    const runs = a.steward.calls.filter((c) => c.tool === "scenario_run");
    expect(runs.length).toBe(2);
    expect(runs[1].args.idempotency_key).toBe(runs[0].args.idempotency_key);

    const b = withEvening();
    const lost = () => {
      throw new Lost("the steward's answer to scenario_run was lost", false);
    };
    b.steward.queue("scenario_run", lost, lost);
    expect(await run(["scenario", "run", "evening"], b.deps)).toBe(1);
    expect(b.err.join("\n")).toMatch(/the run of p1 may have started; galatea history shows what happened/);
  });

  it("Ctrl-C while it follows stops following: the run goes on, its id said, SIGINT given back, 1", async () => {
    const a = withEvening();
    a.steward.landAfterMs = 20_000;
    a.steward.queue("scenario_status", () => {
      a.interrupt();
      return ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] });
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/interrupted: the run r1 goes on; galatea scenario status r1 follows it, galatea scenario stop r1 stops it/);
    expect(a.handlers.size).toBe(0);
  });

  it("a malformed status (no failed_steps) is said: 1", async () => {
    const a = withEvening();
    a.steward.queue("scenario_status", ok({ run_id: "r1", status: "ended", reason: "done" }));
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/scenario_status for r1 is malformed/);
  });

  it("--json: the plan, the start, each event of the run and the final status, one document per line, and no secret", async () => {
    const a = withEvening();
    expect(await run(["scenario", "run", "evening", "--json"], a.deps)).toBe(0);
    const docs = a.out.map((l) => JSON.parse(l));
    expect(docs[0].plan_id).toBe("p1");
    expect(docs[1]).toEqual({ run_id: "r1" });
    expect(docs.filter((d) => d.type === "outcome").map((d) => d.step_id)).toEqual(["s1", "s2"]);
    expect(docs.at(-1)).toEqual({ run_id: "r1", status: "ended", reason: "done", failed_steps: [], sent_steps: [] });
    expect(noSecretIn(a.all())).toBe(true);
  });

  it("refuses a bad line before calling anything, 2", async () => {
    for (const argv of [["scenario"], ["scenario", "nope"], ["scenario", "run"], ["scenario", "run", "a", "b"], ["scenario", "list", "x"],
      ["scenario", "status"], ["scenario", "stop", "r1", "r2"], ["scenario", "status", "r1", "--yes"]]) {
      const a = fakeDeps();
      expect(await run(argv, a.deps), argv.join(" ")).toBe(2);
      expect(a.steward.calls).toEqual([]);
    }
  });
});

describe("galatea answer, of a scenario's plan", () => {
  it("starts the run once nothing waits, and follows it, as scenario run --yes would", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    a.out.length = 0;
    a.steward.calls.length = 0;
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).not.toContain("apply");
    expect(a.steward.tools()).toContain("scenario_run");
    expect(a.out).toContain("started: run r1");
    expect(a.out.at(-1)).toBe("run r1 ended (done)");
  });

  it("says a run that did not complete under answer's own name", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    a.steward.landAs = "failed";
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    a.err.length = 0;
    expect(await run(["answer", "p1", "s1", "yes"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/^galatea answer: the run r1 ended \(done\) with failed steps: s1, s2$/m);
  });

  /** A run of `evening` whose turn_off is asked toggle_only: answered yes and started, then asked again by its run (GA-SCN-3). */
  async function reasked(o: { runId: boolean }) {
    const a = withEvening();
    a.steward.scenarios[0].steps[1] = { delay: 600 };
    a.steward.verdicts[`${LAMP} ${TURN_OFF}`] = { verdict: "ask", reason: "toggle_only" };
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(await run(["answer", "p1", "s2", "yes"], a.deps)).toBe(1); // started; still running when the follow gives up
    a.steward.reask("p1", ["s2"], o.runId ? { runId: "r1" } : {});
    a.out.length = 0;
    a.err.length = 0;
    a.steward.calls.length = 0;
    return a;
  }

  it("an answer to a running run's re-ask that names its run starts nothing: the run goes on, 0", async () => {
    const a = await reasked({ runId: true });
    a.steward.queue("history", () => ok({ events: a.steward.log }));
    expect(await run(["answer", "p1", "s2", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).not.toContain("scenario_run");
    expect(a.out).toContain("the run r1 waits on this answer and goes on; galatea scenario status r1 follows it");
  });

  it("an answer to a re-ask that names no run (GA-CONF-5's may): scenario_run refused plan_expired is the run's answer, said, 0 (review M2)", async () => {
    const a = await reasked({ runId: false });
    expect(await run(["answer", "p1", "s2", "yes"], a.deps)).toBe(0);
    expect(a.steward.tools()).toContain("scenario_run");
    expect(a.out.join("\n")).toMatch(/the plan p1 has run already: the answer is taken by its run, which goes on; galatea history shows it/);
    expect(a.err.join("\n")).not.toMatch(/refused/);
  });

  it("names only the steps declined in this answer, and none when a re-ask is answered (review M3, probe P3)", async () => {
    const a = withEvening();
    a.steward.scenarios[0].steps[1] = { delay: 600 };
    a.steward.verdicts[`${LAMP} ${TURN_ON}`] = { verdict: "ask", reason: "confirm_tier" };
    a.steward.verdicts[`${LAMP} ${TURN_OFF}`] = { verdict: "ask", reason: "toggle_only" };
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(0); // s2 still waits
    expect(await run(["answer", "p1", "s2", "yes"], a.deps)).toBe(1); // started, still running at the bound
    a.steward.reask("p1", ["s2"], { runId: "r1" });
    a.out.length = 0;
    expect(await run(["answer", "p1", "s2", "yes"], a.deps)).toBe(0);
    expect(a.out.join("\n")).not.toMatch(/declined/);
  });

  it("says no plan is spent when the start is ignored (review M3)", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    a.steward.scenarios[0].steps[1] = { delay: 600 };
    expect(await run(["scenario", "run", "evening", "--yes"], a.deps)).toBe(1);
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    a.out.length = 0;
    a.err.length = 0;
    expect(await run(["answer", "p2", "s1", "no"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/running already as run r1/);
    expect(a.out.join("\n")).not.toMatch(/declined|spent/);
  });
});

describe("galatea scenario status", () => {
  it("prints a running run, 0", async () => {
    const a = fakeDeps();
    a.steward.queue("scenario_status", ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] }));
    expect(await run(["scenario", "status", "r1"], a.deps)).toBe(0);
    expect(a.steward.calls[0]).toEqual({ tool: "scenario_status", args: { run_id: "r1" } });
    expect(a.out).toEqual(["run r1 running"]);
  });

  it("an ended run with failed and unwitnessed steps: each said; the read worked, 0 (the maintainer's ruling, review M4)", async () => {
    const a = fakeDeps();
    a.steward.queue("scenario_status", ok({ run_id: "r1", status: "ended", reason: "done",
      failed_steps: [{ step_id: "s2", outcome: "skipped", reason: "occupancy_unknown", time: T0 }], sent_steps: [{ step_id: "s3" }] }));
    expect(await run(["scenario", "status", "r1"], a.deps)).toBe(0);
    expect(a.out).toEqual(["run r1 ended (done)", `  failed: s2 skipped (occupancy_unknown) at ${T0}`, "  sent, not witnessed: s3"]);
  });

  it("is a read: 0 however the run ended (the maintainer's ruling, review M4)", async () => {
    for (const [reason, code] of [["done", 0], ["timeout", 0], ["stopped", 0], ["interrupted", 0]] as const) {
      const a = fakeDeps();
      a.steward.queue("scenario_status", ok({ run_id: "r1", status: "ended", reason, failed_steps: [], sent_steps: [] }));
      expect(await run(["scenario", "status", "r1"], a.deps), reason).toBe(code);
      expect(a.out[0]).toBe(`run r1 ended (${reason})`);
    }
  });

  it("an unknown run is the steward's refusal, 2; --json prints the body", async () => {
    const a = fakeDeps();
    expect(await run(["scenario", "status", "r9"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/unknown_run/);
    const b = fakeDeps();
    const body = { run_id: "r1", status: "running", failed_steps: [], sent_steps: [] };
    b.steward.queue("scenario_status", ok(body));
    expect(await run(["scenario", "status", "r1", "--json"], b.deps)).toBe(0);
    expect(JSON.parse(b.out[0])).toEqual(body);
  });

  it("the run answer ended 0 with a declined step reads 0 too (probe P4)", async () => {
    const a = withEvening({ tiers: { [`${LAMP} ${TURN_ON}`]: "confirm" } });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(await run(["answer", "p1", "s1", "no"], a.deps)).toBe(0);
    expect(await run(["scenario", "status", "r1"], a.deps)).toBe(0);
  });

  it("a malformed reply is 1", async () => {
    const a = fakeDeps();
    a.steward.queue("scenario_status", ok({ run_id: "r1", status: "ended", failed_steps: [], sent_steps: [] }));
    expect(await run(["scenario", "status", "r1"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/malformed/);
  });
});

describe("following a run (review M1, M2)", () => {
  it("Ctrl-C during the last read after the run ended: the last outcomes printed, the interrupt said, 1, as do (probe P1)", async () => {
    const a = withEvening();
    a.steward.queue("scenario_status", ok({ run_id: "r1", status: "ended", reason: "done", failed_steps: [], sent_steps: [] }));
    a.steward.queue("events", () => a.steward.defaults.events({}), () => {
      a.interrupt();
      return ok({ events: [{ seq: 9, time: T0, type: "outcome", step_id: "s1", target: LAMP, outcome: "acked", cause: { run: "r1" } }], cursor: "9" });
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(1);
    expect(a.out).toContain(`  s1  ${LAMP}  acked`);
    expect(a.out).toContain("run r1 ended (done)");
    expect(a.err.join("\n")).toMatch(/interrupted after the run r1 ended: its end is as printed/);
    expect(a.handlers.size).toBe(0);
  });

  it("shows an ask on the run's plan that names no run_id as the run's (probe P2)", async () => {
    const a = withEvening();
    a.steward.queue("scenario_status", () => {
      a.steward.feed({ type: "ask", plan_id: "p1", step_ids: ["s2"], endpoint: "owner-app",
        steps: [{ step_id: "s2", target: LAMP, action: TURN_OFF, args: {}, tier: "reversible", reason: "toggle_only" }] });
      return ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] });
    });
    expect(await run(["scenario", "run", "evening"], a.deps)).toBe(0);
    expect(a.out).toContain("asked again on owner-app: s2; the run waits for the answer");
    expect(a.out).toContain("  galatea answer p1 s2 yes");
  });
});

describe("galatea scenario stop", () => {
  it("stops a running run at owner-app: it ends stopped, 0", async () => {
    const a = withEvening();
    a.steward.scenarios[0].steps[1] = { delay: 600 };
    a.steward.landAfterMs = 0;
    await run(["scenario", "run", "evening"], a.deps);
    a.out.length = 0;
    a.steward.calls.length = 0;
    expect(await run(["scenario", "stop", "r1"], a.deps)).toBe(0);
    expect(a.steward.calls[0]).toEqual({ tool: "scenario_stop", args: { run_id: "r1", endpoint: "owner-app" } });
    expect(a.out).toEqual(["stopped: run r1 ended (stopped)"]);
  });

  it("a run that had ended already is said so, 0", async () => {
    const a = fakeDeps();
    a.steward.queue("scenario_stop", ok({ run_id: "r1", status: "ended", reason: "done", failed_steps: [], sent_steps: [] }));
    expect(await run(["scenario", "stop", "r1"], a.deps)).toBe(0);
    expect(a.out).toEqual(["run r1 had ended already (done); nothing was stopped"]);
  });

  it("a stop answered with the run still running is said, 1", async () => {
    const a = fakeDeps();
    a.steward.queue("scenario_stop", ok({ run_id: "r1", status: "running", failed_steps: [], sent_steps: [] }));
    expect(await run(["scenario", "stop", "r1"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/answered the stop with the run r1 still running/);
  });

  it("a refusal (unknown_run, not_permitted) is 2", async () => {
    for (const r of [refused("unknown_run", "no run r9 is held"), refused("not_permitted", "a member may not stop a run an owner started (GA-SCN-9)")]) {
      const a = fakeDeps();
      a.steward.queue("scenario_stop", r);
      expect(await run(["scenario", "stop", "r9"], a.deps)).toBe(2);
    }
  });
});
