import { requestSchemaFor } from "@ludentes/galatea-life-schemas";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { Body, Link, Reply } from "../src/link.js";
import { McpSteward } from "../src/servers.js";

const addFormats = ((formatsModule as unknown as { default?: unknown }).default ?? formatsModule) as (a: Ajv2020) => Ajv2020;

/**
 * Each request `McpSteward` sends, judged by the steward's own tool schema (`requestSchemaFor`, as its tools/list serves it).
 * The steward's request schemas are open (no `additionalProperties: false`), so this catches a missing required field or a
 * wrong type, not an extra or misspelled one; the four scenario requests are also compared exactly below.
 */
function check(tool: string, args: Body): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const fn = ajv.compile(requestSchemaFor("steward", tool));
  return fn(args) ? [] : (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** A link that records each call and answers it with an empty body. */
function recording() {
  const calls: { tool: string; args: Body }[] = [];
  const link = { call: async (tool: string, args: Body = {}): Promise<Reply> => {
    calls.push({ tool, args });
    return { kind: "ok", body: {} };
  } } as unknown as Link;
  return { steward: new McpSteward(link), calls };
}

describe("the steward requests the tool sends", () => {
  it("each fits the steward's request schema for its operation, the four scenario operations among them", async () => {
    const { steward, calls } = recording();
    await steward.describe();
    await steward.describe({ since_revision: 3, wait_s: 10 });
    await steward.state({ targets: ["sim-bridge:lamp"] });
    await steward.history({ from: "2026-10-07T11:00:00.000Z", to: "2026-10-07T12:00:00.000Z", after_seq: 4 });
    await steward.define({ changes: [{ op: "upsert", kind: "room", value: { id: "kitchen", name: "Кухня" } }], expected_revision: 3, dry_run: false });
    await steward.plan({ actions: [{ target: "sim-bridge:lamp", action: "onoff.turn_on", args: {} }] });
    await steward.answer({ plan_id: "p1", answers: { s1: "yes" } });
    await steward.apply({ plan_id: "p1", idempotency_key: "k1" });
    await steward.outcome({ apply_id: "a1" });
    await steward.events({ cursor: "3", wait_s: 5 });
    await steward.scenarioPlan({ scenario: "evening" });
    await steward.scenarioRun({ plan_id: "p2", idempotency_key: "k2" });
    await steward.scenarioStatus({ run_id: "r1" });
    await steward.scenarioStop({ run_id: "r1" });
    expect(calls.map((c) => c.tool)).toEqual(["describe", "describe", "state", "history", "define", "plan", "answer", "apply", "outcome", "events",
      "scenario_plan", "scenario_run", "scenario_status", "scenario_stop"]);
    for (const c of calls) expect(check(c.tool, c.args), `${c.tool} ${JSON.stringify(c.args)}`).toEqual([]);
    expect(calls.slice(-4).map((c) => c.args)).toEqual([{ scenario: "evening", endpoint: "owner-app" }, { plan_id: "p2", idempotency_key: "k2" },
      { run_id: "r1" }, { run_id: "r1", endpoint: "owner-app" }]);
  });

  it("the check can fail: a scenario_plan or scenario_stop with no endpoint, a scenario_run with no key", () => {
    expect(check("scenario_plan", { scenario: "evening" })).not.toEqual([]);
    expect(check("scenario_stop", { run_id: "r1" })).not.toEqual([]);
    expect(check("scenario_run", { plan_id: "p1" })).not.toEqual([]);
    expect(check("scenario_status", {})).not.toEqual([]);
  });
});
