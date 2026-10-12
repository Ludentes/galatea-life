import { randomUUID } from "node:crypto";
import { type Ctx, type Exit, need, Usage } from "../context.js";
import { type Body, Lost } from "../link.js";
import { EventFeed, INTERRUPTED, type Interruption, interruption } from "../poll.js";
import { jsonLine } from "../print.js";
import { OWNER_APP, type Steward } from "../servers.js";
import { answerLine, askedStepLine, outcomeLine, settleAsks, stepLine, t } from "./confirm.js";
import { askWindow } from "./reading.js";

/**
 * How long `scenario run` follows a run before it gives up and prints the run's id (the design,
 * *Scenarios*): longer than `do`'s wait, a run having steps and delays, and short enough for a
 * command line.
 */
export const SCENARIO_WITHIN_S = 120;
/** The longest single wait on the steward's events between reads of the run's status. */
const POLL_S = 5;

/** The lines that follow a run up after the tool stops following it. */
const followUp = (runId: string): string => `galatea scenario status ${runId} follows it, galatea scenario stop ${runId} stops it`;

/**
 * A `scenario_status` (or `scenario_stop`) body as steward 0.11 shapes it (*Operations*): `running`, or
 * `ended` with its reason, and `failed_steps` and `sent_steps` as arrays. Anything else is malformed.
 */
function runStatus(body: Body, runId: string, tool = "scenario_status"): Body {
  const bad = (why: string) => new Error(`the steward's ${tool} for ${runId} is malformed: ${why}`);
  if (body.status !== "running" && body.status !== "ended") throw bad(`status ${JSON.stringify(body.status)} is neither running nor ended`);
  if (body.status === "ended" && typeof body.reason !== "string") throw bad("an ended run with no reason");
  if (!Array.isArray(body.failed_steps)) throw bad("no failed_steps");
  if (!Array.isArray(body.sent_steps)) throw bad("no sent_steps");
  return body;
}

/**
 * A run's status in plain lines: `running`, or `ended (reason)`; each failed step with its outcome,
 * reason and time, a step the owner declined (`skipped(not_confirmed)` after a `no`) marked so; each
 * step sent without a witness.
 */
function statusLines(st: Body, runId: string, declined: Set<string> = new Set()): string[] {
  const lines = [st.status === "ended" ? `run ${t(runId)} ended (${t(st.reason)})` : `run ${t(runId)} running`];
  for (const f of st.failed_steps as Body[]) {
    const asked = f.outcome === "skipped" && f.reason === "not_confirmed" && declined.has(String(f.step_id)) ? ", as the owner answered" : "";
    lines.push(`  failed: ${t(f.step_id)} ${t(f.outcome)}${f.reason ? ` (${t(f.reason)})` : ""} at ${t(f.time)}${asked}`);
  }
  for (const s of st.sent_steps as Body[]) lines.push(`  sent, not witnessed: ${t(s.step_id)}`);
  return lines;
}

/** The failed steps that count against a run: every one but a step the owner answered `no` to, which did as asked (as `do` counts it). */
const failures = (st: Body, declined: Set<string>): string[] => (st.failed_steps as Body[])
  .filter((f) => !(f.outcome === "skipped" && f.reason === "not_confirmed" && declined.has(String(f.step_id)))).map((f) => String(f.step_id));

/**
 * `galatea scenario list` (the design, *Scenarios*): the scenarios the steward's `describe` lists, each
 * with its id, name, mode and the number of its steps. Ends 0.
 */
export async function list(ctx: Ctx): Promise<Exit> {
  const house = need(await (await ctx.steward()).describe(), "steward", "describe");
  const scenarios: Body[] = Array.isArray(house.scenarios) ? house.scenarios : [];
  if (ctx.json) {
    ctx.say.out(jsonLine({ revision: house.revision, scenarios }));
    return 0;
  }
  if (!scenarios.length) ctx.say.out("no scenario is defined");
  for (const sc of scenarios) {
    const n = Array.isArray(sc.steps) ? sc.steps.length : 0;
    ctx.say.out([t(sc.id), sc.name ? `«${t(sc.name)}»` : "no name", t(sc.mode ?? "no mode"), `${n} step${n === 1 ? "" : "s"}`].join("  "));
  }
  return 0;
}

/**
 * `galatea scenario run <id> [--yes]` (the design, *Scenarios*): plans the scenario's run at
 * `owner-app` (`scenario_plan`) and prints every step before anything happens. A plan whose every step
 * is refused starts nothing, 2; any other run is started, since the run judges each step again at its
 * dispatch (GA-SCN-7), so a step already so now may not be after a delay. Its asks are settled as
 * `do` settles them (`settleAsks`); then the run is started (`scenario_run`) and followed.
 */
export async function runScenario(ctx: Ctx, id: string | undefined, yes: boolean): Promise<Exit> {
  if (!id) throw new Usage("galatea scenario run <id> [--yes]: name the scenario");
  const steward = await ctx.steward();
  // The cursor first, so the plan's ask event and the run's events that follow are all after it.
  const feed = await EventFeed.start(steward, "steward");
  const plan = need(await steward.scenarioPlan({ scenario: id }), "steward", "scenario_plan");
  const steps: Body[] = plan.steps ?? [];
  if (ctx.json) ctx.say.out(jsonLine(plan));
  else {
    ctx.say.out(`plan ${t(plan.plan_id)} of scenario ${t(id)} at ${t(plan.endpoint)}, revision ${t(plan.revision)}, expires ${t(plan.expires_at)}:`);
    for (const s of steps) ctx.say.out(stepLine(s));
  }
  if (steps.length && steps.every((s) => s.verdict === "refuse")) {
    ctx.say.err("galatea scenario run: every step of the plan is refused; no run was started");
    return 2;
  }
  const settled = await settleAsks(ctx, steward, feed, plan, "scenario run", yes);
  if (settled !== undefined) return settled;
  return startAndFollow(ctx, steward, feed, String(plan.plan_id), id, new Set(), "scenario run");
}

/**
 * The run of a scenario's plan that `galatea answer` has just answered, once nothing in it waits. An
 * `ask` event for the plan that names a run is a running run's question asked again (GA-SCN-3,
 * GA-CONF-5): the run takes the answer and goes on, so nothing is started. GA-CONF-5 says a re-ask
 * may name its run, so one that does not is found when `scenario_run` refuses the spent plan
 * (`startAndFollow`). Otherwise the run is started and followed, as `scenario run` does; `declinedNow`,
 * the steps this answer declined, are said once it has started.
 */
export async function runAnswered(ctx: Ctx, steward: Steward, planId: string, scenario: string, declined: Set<string>,
  declinedNow: string[]): Promise<Exit> {
  const house = need(await steward.describe(), "steward", "describe");
  const window = await askWindow(ctx, Number(house.home?.ask_expiry_s ?? 300));
  const reask = window.events.find((e) => e.type === "ask" && e.plan_id === planId && e.run_id !== undefined);
  if (reask) {
    const runId = String(reask.run_id);
    if (ctx.json) ctx.say.out(jsonLine({ galatea: "run_waits", plan_id: planId, run_id: runId }));
    else ctx.say.out(`the run ${t(runId)} waits on this answer and goes on; galatea scenario status ${t(runId)} follows it`);
    return 0;
  }
  const feed = await EventFeed.start(steward, "steward");
  return startAndFollow(ctx, steward, feed, planId, scenario, declined, "answer", declinedNow);
}

class Stopped extends Error {}

/**
 * Starts the run of `planId` under a new idempotency key, a lost call sent once more with the same key
 * (GA-SCN-6: the steward answers a repeat with the first run and starts nothing), then follows it
 * (`follow`). A start that `single` ignored says the running run, nothing done by it: 2, or 1 after an
 * answer. Ctrl-C is the tool's from the start on, as `do`'s apply.
 */
async function startAndFollow(ctx: Ctx, steward: Steward, feed: EventFeed, planId: string, scenario: string, declined: Set<string>,
  command: string, declinedNow: string[] = []): Promise<Exit> {
  const stop = interruption(ctx.onInterrupt);
  try {
    const args = { plan_id: planId, idempotency_key: randomUUID() };
    const send = async () => {
      const r = await stop.race(steward.scenarioRun(args));
      if (r === INTERRUPTED) throw new Stopped();
      return r;
    };
    let reply;
    try {
      try {
        reply = await send();
      } catch (err) {
        if (!(err instanceof Lost)) throw err;
        try {
          reply = await send();
        } catch (again) {
          if (again instanceof Lost) {
            throw new Lost(`${again.message}: the run of ${planId} may have started; galatea history shows what happened before trying again`, again.answered);
          }
          throw again;
        }
      }
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
      ctx.say.err(`galatea: interrupted while starting the run of ${planId}: it may have started; galatea history shows what happened`);
      return 1;
    }
    // After an answer, a plan refused as spent was run already: the answer went to its run's re-ask (review M2).
    if (command === "answer" && reply.kind === "refused" && reply.error === "plan_expired") {
      if (ctx.json) ctx.say.out(jsonLine({ galatea: "run_waits", plan_id: planId, refused: reply.body }));
      else ctx.say.out(`the plan ${t(planId)} has run already: the answer is taken by its run, which goes on; galatea history shows it`);
      return 0;
    }
    const started = need(reply, "steward", "scenario_run");
    const runId = String(started.run_id);
    if (ctx.json) ctx.say.out(jsonLine(started));
    if (started.ignored === true) {
      ctx.say.err(`galatea ${command}: scenario ${t(scenario)} is running already as run ${t(runId)} (mode single): this start was ignored; ${followUp(runId)}`);
      return ctx.done ? 1 : 2;
    }
    ctx.done = true;
    if (!ctx.json) ctx.say.out(`started: run ${t(runId)}`);
    if (declinedNow.length) {
      if (ctx.json) ctx.say.out(jsonLine({ galatea: "declined", plan_id: planId, step_ids: declinedNow }));
      else ctx.say.out(`declined: ${declinedNow.join(", ")}; the run started, so the plan is spent: each declined step ends skipped (not_confirmed)`);
    }
    return await follow(ctx, steward, feed, planId, runId, declined, stop, command);
  } finally {
    stop.dispose();
  }
}

/**
 * Follows a run up to `SCENARIO_WITHIN_S`: reads `scenario_status`, then the steward's events (at most
 * 5 s at a time while it runs), printing each event of the run as it comes: a step's `outcome`, an
 * `if`'s branch, a `wait`'s timeout, and its plan asked again (GA-SCN-3), with the line that answers it,
 * which `--yes` never answers. Once the run has ended, the events up to then are read and its status
 * printed: 0 for `ended(done)` with no failed step (a step the owner declined is none), else 1. A run
 * still running when the wait ends, or when Ctrl-C stops it, goes on: its id is said, 1. The last read,
 * once the run has ended, is not raced with Ctrl-C; one that came meanwhile is said after the end, 1.
 */
async function follow(ctx: Ctx, steward: Steward, feed: EventFeed, planId: string, runId: string, declined: Set<string>, stop: Interruption,
  command: string): Promise<Exit> {
  const deadline = ctx.now() + SCENARIO_WITHIN_S * 1000;
  let st: Body;
  for (;;) {
    st = runStatus(need(await steward.scenarioStatus({ run_id: runId }), "steward", "scenario_status"), runId);
    const ended = st.status === "ended";
    // Once the run has ended its last events are read whole, never raced with Ctrl-C (review M1), as do reads its outcomes.
    const got = ended ? await feed.next(0)
      : await stop.race(feed.next(stop.fired || ctx.now() >= deadline ? 0 : Math.min(POLL_S, (deadline - ctx.now()) / 1000)));
    if (got === INTERRUPTED) break;
    for (const e of got) show(ctx, e, planId, runId);
    if (ended || stop.fired || ctx.now() >= deadline) break;
  }
  if (st.status !== "ended") {
    if (ctx.json) ctx.say.out(jsonLine(st));
    ctx.say.err(stop.fired ? `galatea: interrupted: the run ${t(runId)} goes on; ${followUp(runId)}`
      : `galatea: the run ${t(runId)} is still running ${SCENARIO_WITHIN_S} s after it started; ${followUp(runId)}`);
    return 1;
  }
  if (ctx.json) ctx.say.out(jsonLine(st));
  else for (const l of statusLines(st, runId, declined)) ctx.say.out(l);
  if (stop.fired) {
    // Ctrl-C came once the run had ended: its end is said; the command ends 1, as do's after its outcomes.
    ctx.say.err(`galatea: interrupted after the run ${t(runId)} ended: its end is as printed`);
    return 1;
  }
  if (st.reason !== "done") {
    ctx.say.err(`galatea ${command}: the run ${t(runId)} ended (${t(st.reason)}), not completed`);
    return 1;
  }
  const failed = failures(st, declined);
  if (failed.length) {
    ctx.say.err(`galatea ${command}: the run ${t(runId)} ended (done) with failed steps: ${failed.map(t).join(", ")}`);
    return 1;
  }
  return 0;
}

/** One event of the steward's, shown when it is the run's: its outcomes, its `if` and `wait` steps, its plan asked again. */
function show(ctx: Ctx, e: Body, planId: string, runId: string): void {
  const ours = (e.type === "outcome" && e.cause?.run === runId) || (e.type === "scenario" && e.run_id === runId)
    // Once the run has started, its plan is asked nothing but as the run's re-ask, named or not (GA-CONF-5's may; review M2).
    || (e.type === "ask" && e.plan_id === planId);
  if (!ours) return;
  if (ctx.json) {
    ctx.say.out(jsonLine(e));
    return;
  }
  if (e.type === "outcome") ctx.say.out(outcomeLine(e));
  else if (e.type === "scenario" && e.change === "if") {
    ctx.say.out(`  ${t(e.step_id)}  if: ${e.branch !== undefined ? t(e.branch) : `${t(e.outcome)}${e.reason ? ` (${t(e.reason)})` : ""}`}`);
  } else if (e.type === "scenario" && e.change === "wait_timeout") ctx.say.out(`  ${t(e.step_id)}  wait timed out (${t(e.on_timeout)})`);
  else if (e.type === "ask") {
    const ids = ((e.step_ids ?? []) as unknown[]).map(String);
    if (e.endpoint !== OWNER_APP) {
      ctx.say.out(`asked again on ${t(e.endpoint)}, not on owner-app: ${ids.map(t).join(", ")}; answer it there, the run waits for the answer`);
      return;
    }
    ctx.say.out(`asked again on owner-app: ${ids.map(t).join(", ")}; the run waits for the answer`);
    for (const s of Array.isArray(e.steps) ? e.steps as Body[] : []) ctx.say.out(askedStepLine(s));
    ctx.say.out(`  ${answerLine(planId, ids)}`);
  }
}

/**
 * `galatea scenario status <run>` (the design, *Scenarios*): the run's `scenario_status`, its failed
 * and unwitnessed steps. A read: 0 whenever it worked, however the run stands or ended, which its lines
 * (and `--json`) say; 1 for a malformed reply; 2 on a refusal (`unknown_run`) (the maintainer's ruling).
 */
export async function status(ctx: Ctx, runId: string | undefined): Promise<Exit> {
  if (!runId) throw new Usage("galatea scenario status <run>: name the run");
  const st = runStatus(need(await (await ctx.steward()).scenarioStatus({ run_id: runId }), "steward", "scenario_status"), runId);
  if (ctx.json) ctx.say.out(jsonLine(st));
  else for (const l of statusLines(st, runId)) ctx.say.out(l);
  return 0;
}

/**
 * `galatea scenario stop <run>` (the design, *Scenarios*): `scenario_stop` at `owner-app` (GA-SCN-9).
 * A run it stopped, or one that had ended already (said so), ends 0; a refusal (`unknown_run`,
 * `not_permitted`) 2; an answer with the run still running, or malformed, 1.
 */
export async function stopRun(ctx: Ctx, runId: string | undefined): Promise<Exit> {
  if (!runId) throw new Usage("galatea scenario stop <run>: name the run");
  const body = need(await (await ctx.steward()).scenarioStop({ run_id: runId }), "steward", "scenario_stop");
  ctx.done = true;
  const st = runStatus(body, runId, "scenario_stop");
  if (st.status === "running") throw new Error(`the steward answered the stop with the run ${runId} still running`);
  if (ctx.json) ctx.say.out(jsonLine(st));
  else {
    const [head, ...rest] = statusLines(st, runId);
    ctx.say.out(st.reason === "stopped" ? `stopped: ${head}` : `run ${t(runId)} had ended already (${t(st.reason)}); nothing was stopped`);
    for (const l of rest) ctx.say.out(l);
  }
  return 0;
}
