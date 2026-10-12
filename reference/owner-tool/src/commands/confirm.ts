import { randomUUID } from "node:crypto";
import { type Ctx, type Exit, Held, need, Usage } from "../context.js";
import { type Body, Lost } from "../link.js";
import { EventFeed, INTERRUPTED, type Interruption, interruption } from "../poll.js";
import { clean, jsonLine, shellQuote } from "../print.js";
import { OWNER_APP, type Steward } from "../servers.js";
import { askWindow, HISTORY_PAGES, openAskList } from "./reading.js";
import { runAnswered } from "./scenario.js";

/** How long `do` and `answer` wait for an apply's every step to have a final outcome (the controller's ruling). */
export const OUTCOME_WITHIN_S = 60;
/** The longest single wait on the steward's events between reads of the outcome. */
const OUTCOME_POLL_S = 5;

/** Outcomes that are not final: the step is on its way (applier, *Outcomes*). */
const PENDING = new Set(["dispatched", "unknown"]);

/**
 * An outcome that did what was asked, as `scenario_status` counts a step that did not fail
 * (GA-SCN-11): `acked`, `delivered`, `sent`, `confirmed`, and `skipped` because it was already so (or
 * the room was occupied or in use, which `do` never asks about). A step the owner answered `no` that
 * ends `skipped(not_confirmed)` did as the owner asked.
 */
function landed(o: Body, answeredNo: Set<string>): boolean {
  if (["acked", "delivered", "sent", "confirmed"].includes(o.outcome)) return true;
  if (o.outcome !== "skipped") return false;
  return ["already", "occupied", "in_use"].includes(o.reason) || (o.reason === "not_confirmed" && answeredNo.has(o.step_id));
}

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * `--arg` (the controller's ruling): `k=v` takes `v` by its form, `true` and `false` as booleans, a
 * plain decimal (no leading zero, so `042` stays a string) as a number, anything else as the string;
 * `k:=json` takes any JSON value, for a string that looks like a number (`code:='"042"'`), `null`, an
 * array or an object. The name is an argument's (a letter or `_` first). Every action's arguments go
 * as one object, `{}` with none, as the steward's request takes them: the applier sends a one-argument
 * action's value bare to its bridge (bridge, *Commands*), not the tool.
 */
export function parseActionArgs(given: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const raw of given) {
    const m = /^([^=:]*)(:?=)(.*)$/s.exec(raw);
    if (!m) throw new Usage(`--arg is name=value, or name:=JSON: ${JSON.stringify(raw)} is not`);
    const [, name, op, text] = m;
    if (!NAME.test(name)) throw new Usage(`--arg's name is a letter or _ then letters, digits, _ . or -: ${JSON.stringify(name)} is not`);
    if (Object.hasOwn(args, name)) throw new Usage(`--arg ${name} is given twice`);
    if (op === ":=") {
      try {
        args[name] = JSON.parse(text);
      } catch {
        throw new Usage(`--arg ${name}:= takes JSON: ${JSON.stringify(text)} does not parse`);
      }
    } else {
      // A decimal that a number would change (20 digits, `1.10`, `-0`) stays the string it is (review M5).
      args[name] = text === "true" ? true : text === "false" ? false : NUMBER.test(text) && String(Number(text)) === text ? Number(text) : text;
    }
  }
  return args;
}

/** Text from a server, cleaned for a plain line (review M6). */
export const t = (v: unknown): string => clean(String(v));

/** A plan's step, as `do` prints it before anything happens: id, target, action, args, tier, verdict and reason, an answer given, and `conditional` for a scenario's step inside an `if`. */
export function stepLine(s: Body): string {
  const verdict = `${t(s.verdict)}${s.reason ? ` (${t(s.reason)})` : ""}${s.answer ? `, answered ${t(s.answer)}` : ""}`;
  // A define's step (confirm_define) has no target: what it asks is its diff.
  if (isDefineStep(s)) return [`  ${t(s.step_id)}`, "define", diffText(s.diff), verdict].join("  ");
  // A scenario's step inside an `if` is planned as if its branch were taken (steward, *Scenario runs*).
  return [`  ${t(s.step_id)}`, t(s.target), t(s.action), JSON.stringify(s.args ?? {}), `tier ${t(s.tier)}`, verdict, ...(s.conditional === true ? ["conditional"] : [])].join("  ");
}

/** A define's confirmation, told by its reason (`confirm_define`): no target, action, args or tier; what it asks is its diff. */
const isDefineStep = (s: Body): boolean => s.reason === "confirm_define";

/** A diff as a plain line shows it: a string (or `withheld`, GA-AUTH-7) cleaned, anything else as JSON, cleaned. */
const diffText = (d: unknown): string => clean(typeof d === "string" ? d : JSON.stringify(d ?? null));

/**
 * An asked step as an `ask` event carries it (GA-CONF-5): no verdict, its
 * reason in brackets. A define's entry, `{ step_id, reason: "confirm_define", diff }`, shows as
 * `define <diff>`. Withheld args or diff values (GA-AUTH-7) print as the plan's step line prints them.
 */
export function askedStepLine(s: Body): string {
  if (isDefineStep(s)) return [`  ${t(s.step_id)}`, "define", diffText(s.diff), `(${t(s.reason ?? "confirm_define")})`].join("  ");
  return [`  ${t(s.step_id)}`, t(s.target), t(s.action), JSON.stringify(s.args ?? {}), `tier ${t(s.tier)}`, s.reason ? `(${t(s.reason)})` : ""].filter((x) => x).join("  ");
}

/** An outcome's line: step, target, outcome, reason and detail. */
export function outcomeLine(o: Body): string {
  return `  ${t(o.step_id)}  ${t(o.target)}  ${t(o.outcome)}${o.reason ? ` (${t(o.reason)})` : ""}${o.detail ? `: ${t(o.detail)}` : ""}`;
}

/** The steps a plan would dispatch or ask about: each one's apply has an outcome. */
const dispatchable = (steps: Body[]): string[] => steps.filter((s) => s.verdict === "op" || s.verdict === "ask").map((s) => String(s.step_id));

/** The line that answers `steps` of `plan`. */
export const answerLine = (plan: string, steps: string[], word = "yes"): string => ["galatea", "answer", plan, ...steps, word].map(shellQuote).join(" ");

/**
 * An answer sent to the steward: the plan as it returns it. A held answer (`pending: true`, its store
 * slow) stands in the steward's memory at once and is kept when the store answers, so it is said so,
 * with the line to run again (a repeated answer is taken as the same), and the tool applies nothing
 * on it (review M1).
 */
async function sendAnswer(steward: Steward, planId: string, steps: string[], word: "yes" | "no"): Promise<Body> {
  const reply = await steward.answer({ plan_id: planId, answers: Object.fromEntries(steps.map((s) => [s, word])) });
  if (reply.kind === "held") {
    throw new Held(`the steward holds the answer (${reply.message}): the answer stands at the steward and is kept when its store answers; `
      + `nothing was applied; run again, once the steward answers: ${answerLine(planId, steps, word)}`);
  }
  return need(reply, "steward", "answer");
}

/**
 * Where the steward put a plan's question (GA-CONF-5): the endpoint of the `ask` event for it, read
 * from the steward's events after the cursor taken before the plan. The event is put when the plan
 * is made, so one read without waiting finds it. Undefined when none is seen.
 */
async function askedAt(feed: EventFeed, planId: string): Promise<string | undefined> {
  const seen = await feed.next(0);
  return seen.find((e) => e.type === "ask" && e.plan_id === planId)?.endpoint;
}

/**
 * `galatea do <target> <action> [--arg k=v]... [--yes]` (the design, *Confirmations*): plans the action
 * at `owner-app` and prints every step before anything happens. No step to dispatch ends there: 0 when
 * every step is already so, else 2. A step asked on `owner-app` is answered `yes` with `--yes`; without
 * it the plan is left open with the `galatea answer` line, 0. A question put elsewhere (a
 * `confirm_on`) is not the tool's to answer: said, 1. Then the plan is applied and its outcome waited
 * for (`applyAndWait`).
 */
export async function doAction(ctx: Ctx, target: string | undefined, action: string | undefined, rawArgs: string[], yes: boolean): Promise<Exit> {
  if (!target || !action) throw new Usage("galatea do <target> <action> [--arg k=v]... [--yes]: name the target and the action");
  const args = parseActionArgs(rawArgs);
  const steward = await ctx.steward();
  // The cursor first, so the plan's ask event and the outcomes that follow are all after it.
  const feed = await EventFeed.start(steward, "steward");
  const plan = need(await steward.plan({ actions: [{ target, action, args }] }), "steward", "plan");
  const steps: Body[] = plan.steps ?? [];
  if (ctx.json) ctx.say.out(jsonLine(plan));
  else {
    ctx.say.out(`plan ${plan.plan_id} at ${plan.endpoint}, revision ${plan.revision}, expires ${plan.expires_at}:`);
    for (const s of steps) ctx.say.out(stepLine(s));
  }
  if (!steps.some((s) => s.verdict === "op" || s.verdict === "ask")) {
    if (steps.length && steps.every((s) => s.verdict === "skip" && s.reason === "already")) {
      if (!ctx.json) ctx.say.out("nothing to do: every step is already so");
      return 0;
    }
    ctx.say.err("galatea do: no step of the plan would be dispatched; nothing was applied");
    return 2;
  }
  const settled = await settleAsks(ctx, steward, feed, plan, "do", yes);
  if (settled !== undefined) return settled;
  return applyAndWait(ctx, steward, feed, plan.plan_id, new Set(), dispatchable(steps));
}

/**
 * A plan's asks, settled before anything is applied or started (the design, *Confirmations*), by `do`
 * and `scenario run` alike. Where the question was put is read from the plan's `ask` event; one put
 * elsewhere (a `confirm_on`) is said and left there, 1. `--yes` answers the steps asked for their tier
 * (`confirm_tier`) and nothing else; a step asked for another reason is printed with it and left
 * open with its `galatea answer` line, 0. Returns the command's exit when it ends here, else
 * undefined: nothing waits for an answer any more.
 */
export async function settleAsks(ctx: Ctx, steward: Steward, feed: EventFeed, plan: Body, command: string, yes: boolean): Promise<Exit | undefined> {
  const steps: Body[] = plan.steps ?? [];
  const asked = steps.filter((s) => s.verdict === "ask").map((s) => String(s.step_id));
  if (asked.length) {
    // GA-CONF-5 puts an ask event for every such plan; one not found in the read just after the plan (a
    // missed read) is said, and the question taken as owner-app's: the steward judges the answer (GA-CONF-1).
    let where = await askedAt(feed, plan.plan_id);
    if (where === undefined) {
      ctx.say.err(`galatea ${command}: no ask event was seen for ${plan.plan_id} in the read after the plan; `
        + "the question is taken as owner-app's (the steward judges the answer)");
      where = OWNER_APP;
    }
    if (where !== OWNER_APP) {
      ctx.say.err(`galatea ${command}: the question is put on ${where}, not on owner-app (owner-app's confirm_on): answer it there; `
        + `the plan ${plan.plan_id} stays open until ${plan.expires_at}, and only this tool's credential can apply it`);
      return 1;
    }
    // `--yes` is consent to the tier's question only: an ask for another reason (a toggle whose state is
    // not known, a computer in use, a room not known to be empty) is the owner's to read and answer (review I1).
    const byStep = new Map(steps.map((s) => [String(s.step_id), s]));
    const mine = yes ? asked.filter((id) => byStep.get(id)?.reason === "confirm_tier") : [];
    const left = asked.filter((id) => !mine.includes(id));
    if (yes) {
      for (const id of left) {
        const reason = byStep.get(id)?.reason;
        if (ctx.json) ctx.say.out(jsonLine({ galatea: "not_answered", plan_id: plan.plan_id, step_id: id, reason: reason ?? null }));
        else ctx.say.out(`not answered: ${id} (${clean(String(reason))}): --yes answers only a tier's confirmation; this question is for the owner to read and answer`);
      }
    }
    if (mine.length) {
      const answered = await sendAnswer(steward, plan.plan_id, mine, "yes");
      ctx.done = true;
      ctx.say.out(ctx.json ? jsonLine(answered) : `answered yes: ${mine.join(", ")}`);
    }
    if (left.length) {
      const line = answerLine(plan.plan_id, left);
      if (ctx.json) ctx.say.out(jsonLine({ galatea: "open", plan_id: plan.plan_id, step_ids: left, endpoint: where, expires_at: plan.expires_at, answer: line }));
      else {
        ctx.say.out(`asked on owner-app: ${left.join(", ")}; the plan stays open until ${plan.expires_at}`);
        ctx.say.out(`  ${line}`);
      }
      return 0;
    }
  }
  return undefined;
}

/**
 * Applies a plan this credential made, under a new idempotency key, a lost call sent once more with
 * the same key (GA-STW-6: the steward answers a repeat from its first apply and dispatches nothing);
 * then, while a step is `dispatched` or `unknown`, waits on the steward's events (at most 5 s at a
 * time) between reads of `outcome`, up to `OUTCOME_WITHIN_S`. Ends 0 when every step did what was
 * asked, else 1; a wait given up, or stopped with Ctrl-C, says the action stands, 1.
 */
async function applyAndWait(ctx: Ctx, steward: Steward, feed: EventFeed, planId: string, answeredNo: Set<string>, expected: string[]): Promise<Exit> {
  // Ctrl-C is the tool's from the apply on: the house may change, so it is never ended without a word (review M4).
  const stop = interruption(ctx.onInterrupt);
  try {
    return await applyWatched(ctx, steward, feed, planId, answeredNo, expected, stop);
  } finally {
    stop.dispose();
  }
}

class Stopped extends Error {}

async function applyWatched(ctx: Ctx, steward: Steward, feed: EventFeed, planId: string, answeredNo: Set<string>, expected: string[],
  stop: Interruption): Promise<Exit> {
  const args = { plan_id: planId, idempotency_key: randomUUID() };
  const send = async () => {
    const r = await stop.race(steward.apply(args));
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
          throw new Lost(`${again.message}: the plan ${planId} may have been applied; galatea history shows what happened before trying again`, again.answered);
        }
        throw again;
      }
    }
  } catch (err) {
    if (!(err instanceof Stopped)) throw err;
    ctx.say.err(`galatea: interrupted while applying ${planId}: the apply may stand; galatea history shows what happened`);
    return 1;
  }
  const applied = need(reply, "steward", "apply");
  ctx.done = true;
  ctx.say.out(ctx.json ? jsonLine(applied) : `applied: apply ${applied.apply_id}`);
  let now: Body = applied;
  const pending = () => ((now.outcomes ?? []) as Body[]).some((o) => PENDING.has(o.outcome));
  if (pending()) {
    const deadline = ctx.now() + OUTCOME_WITHIN_S * 1000;
    for (;;) {
      now = need(await steward.outcome({ apply_id: applied.apply_id }), "steward", "outcome");
      if (!pending() || stop.fired || ctx.now() >= deadline) break;
      const woke = await stop.race(feed.next(Math.min(OUTCOME_POLL_S, (deadline - ctx.now()) / 1000)));
      if (woke === INTERRUPTED) break;
    }
    if (ctx.json) ctx.say.out(jsonLine(now));
    if (pending()) {
      if (!ctx.json) for (const o of now.outcomes ?? []) ctx.say.out(outcomeLine(o));
      ctx.say.err(stop.fired
        ? `galatea: interrupted: the apply ${applied.apply_id} stands; galatea events or galatea history shows when its steps land`
        : `galatea: no final outcome ${OUTCOME_WITHIN_S} s after the apply ${applied.apply_id}; the action stands; galatea events or galatea history shows when it lands`);
      return 1;
    }
  }
  const outcomes: Body[] = now.outcomes ?? [];
  if (!ctx.json) for (const o of outcomes) ctx.say.out(outcomeLine(o));
  // A step the plan would dispatch with no outcome in the reply is not done (review M3).
  const missing = expected.filter((id) => !outcomes.some((o) => o.step_id === id));
  if (missing.length) {
    ctx.say.err(`galatea: the steward gave no outcome for ${missing.join(", ")} of apply ${applied.apply_id}; galatea history shows what happened`);
    return 1;
  }
  if (stop.fired) {
    // Ctrl-C came after the outcomes were read: they are said; the action stands whatever they are.
    ctx.say.err(`galatea: interrupted after the apply ${applied.apply_id}: the action stands`);
    return 1;
  }
  return outcomes.every((o) => landed(o, answeredNo)) ? 0 : 1;
}

/**
 * `galatea answer <plan> <step>... yes|no` (the design, *Confirmations*): answers the named steps from
 * `owner-app` and prints the plan as `answer` returns it. A plan made at `owner-app` is the tool's own
 * (only its credential is bound there), so once nothing in it waits for an answer it applies it and
 * waits for the outcome, as `do` does; a step answered `no` is named and ends skipped(not_confirmed),
 * the rest applied (review M2). A scenario's plan is started instead, and its run followed, as
 * `scenario run` does (`runAnswered`). A plan made elsewhere is applied by whoever made it (GA-STW-5).
 */
export async function answer(ctx: Ctx, positionals: string[]): Promise<Exit> {
  const word = positionals.at(-1);
  const [planId, ...steps] = positionals.slice(0, -1);
  if (!planId || !steps.length || (word !== "yes" && word !== "no")) {
    throw new Usage("galatea answer <plan> <step>... yes|no: name the plan, at least one step, and the answer");
  }
  if (new Set(steps).size !== steps.length) throw new Usage("a step is named twice");
  const steward = await ctx.steward();
  const plan = await sendAnswer(steward, planId, steps, word);
  ctx.done = true;
  // The plan returned marks each asked step with the answer that stands for it (steward, *Steps*): the
  // steps just answered among them. One without its mark is a malformed reply; the answer was taken.
  const all: Body[] = plan.steps ?? [];
  if (ctx.json) ctx.say.out(jsonLine(plan));
  const unmarked = steps.filter((id) => all.find((s) => s.step_id === id)?.answer === undefined);
  if (unmarked.length) {
    throw new Error(`the steward's answer returned ${planId} with no answer on ${unmarked.join(", ")} (steward, Steps): `
      + "the answer was taken; galatea asks shows the plan");
  }
  if (!ctx.json) {
    ctx.say.out(`answered ${word}: ${steps.join(", ")}`);
    for (const s of all.filter((x) => steps.includes(x.step_id))) ctx.say.out(stepLine(s));
  }
  if (plan.endpoint !== OWNER_APP) {
    if (!ctx.json) ctx.say.out(`the plan was made at ${plan.endpoint}: whoever made it applies it`);
    return 0;
  }
  const asked = all.filter((s) => s.verdict === "ask");
  const waiting = asked.filter((s) => s.answer === undefined).map((s) => String(s.step_id));
  if (waiting.length) {
    const line = answerLine(planId, waiting);
    if (ctx.json) ctx.say.out(jsonLine({ galatea: "waiting", plan_id: planId, step_ids: waiting, answer: line }));
    else {
      ctx.say.out(`still waiting for an answer: ${waiting.join(", ")}`);
      ctx.say.out(`  ${line}`);
    }
    return 0;
  }
  // The owner declined the question, not the request: the plan is applied all the same, each declined
  // step ending skipped(not_confirmed) and the steps that needed no answer running (review M2).
  const declined = asked.filter((s) => s.answer === "no").map((s) => String(s.step_id));
  // The line names only the steps this answer declined (review M3); an earlier no still counts as the owner's.
  const declinedNow = declined.filter((id) => steps.includes(id));
  // A scenario's plan is started with scenario_run, never applied (steward, *Scenario runs*); its run says
  // what was declined once it has started.
  const scenario = typeof plan.request?.scenario === "string" ? String(plan.request.scenario) : undefined;
  if (scenario !== undefined) return runAnswered(ctx, steward, planId, scenario, new Set(declined), declinedNow);
  if (declinedNow.length) {
    if (ctx.json) ctx.say.out(jsonLine({ galatea: "declined", plan_id: planId, step_ids: declinedNow }));
    else ctx.say.out(`declined: ${declinedNow.join(", ")}; applied, so the plan is spent: each declined step ends skipped (not_confirmed)`);
  }
  const feed = await EventFeed.start(steward, "steward");
  return applyAndWait(ctx, steward, feed, planId, new Set(declined), dispatchable(all));
}

/**
 * `galatea asks` (the design, *Confirmations*): the `ask` events put on `owner-app` in the steward's
 * history over the last `ask_expiry_s`, less the steps a later `answer` answered (as `status` counts
 * them); each with its plan, where and when it was put, until when it is open, the steps waiting, what
 * is asked (the event's `steps`, which GA-CONF-5 gives a read at the ask's endpoint: one entry per
 * asked step), and the line that answers the steps shown. A waiting step the event shows nothing for
 * (no `steps`, none for it, or an entry with no target that is not a define's) makes the event
 * malformed: said on its line and on stderr, never offered in the answer line, the rest shown, ending 1.
 * A plan applied or expired in the window is not seen.
 */
export async function asks(ctx: Ctx): Promise<Exit> {
  const house = need(await (await ctx.steward()).describe(), "steward", "describe");
  const expiry = Number(house.home?.ask_expiry_s ?? 300);
  const window = await askWindow(ctx, expiry);
  const open = openAskList(window.events);
  let malformed = false;
  for (const { event: e, waiting } of open) {
    const carried = new Map<string, Body>((Array.isArray(e.steps) ? e.steps as Body[] : [])
      .filter((s) => s && typeof s === "object" && (typeof s.target === "string" || isDefineStep(s)))
      .map((s) => [String(s.step_id), s]));
    const unshown = waiting.filter((id) => !carried.has(id));
    const shown = waiting.filter((id) => carried.has(id));
    if (unshown.length) {
      malformed = true;
      ctx.say.err(`galatea asks: the steward's ask event for ${t(e.plan_id)} is malformed: no step shown for ${unshown.map(t).join(", ")} (GA-CONF-5)`);
    }
    const openUntil = typeof e.time === "string" ? new Date(Date.parse(e.time) + expiry * 1000).toISOString() : "unknown";
    const line = shown.length ? answerLine(String(e.plan_id), shown) : undefined;
    if (ctx.json) {
      ctx.say.out(jsonLine({ galatea: "ask", plan_id: e.plan_id, ...(e.run_id !== undefined ? { run_id: e.run_id } : {}), waiting, endpoint: e.endpoint,
        asked_at: e.time ?? null, open_until: openUntil, ...(unshown.length ? { not_shown: unshown } : {}), event: e }));
      continue;
    }
    // A scenario's re-ask may name its run (GA-CONF-5).
    const run = e.run_id !== undefined ? `, run ${t(e.run_id)}` : "";
    ctx.say.out(`plan ${t(e.plan_id)}  asked on ${t(e.endpoint)} at ${t(e.time ?? "an unknown time")}${run}, open until ${openUntil}  waiting: ${waiting.map(t).join(", ")}`);
    for (const id of waiting) {
      const s = carried.get(id);
      ctx.say.out(s ? askedStepLine(s) : `  ${t(id)}: what is asked is missing from the steward's ask event (GA-CONF-5); not answerable here`);
    }
    if (line) ctx.say.out(`  ${line}`);
  }
  if (!open.length && !ctx.json) ctx.say.out("no ask waits on owner-app");
  if (window.partial) ctx.say.err(`galatea asks: read from the first ${HISTORY_PAGES} pages of history only; an ask past them is not shown`);
  return malformed ? 1 : 0;
}
