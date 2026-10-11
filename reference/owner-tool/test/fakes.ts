import type { Deps } from "../src/context.js";
import { FileProblem } from "../src/context.js";
import type { Reply } from "../src/link.js";
import type { Applier, Change, Requested, Steward } from "../src/servers.js";

type Body = Record<string, any>;
export const ok = (body: Body): Reply => ({ kind: "ok", body });
export const refused = (error: string, message = "no", extra: Body = {}): Reply => ({ kind: "refused", error, message, body: { error, message, ...extra } });

/** The fakes' clock: what `now()` says, moved by a fake long-poll that waits out its `wait_s`. */
export class FakeClock {
  constructor(public t = Date.parse("2026-10-07T12:00:00Z")) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A fake server: every call recorded; each reply taken from a queue for its tool, else from a default. */
class Fake {
  clock = new FakeClock();
  calls: { tool: string; args: Body }[] = [];
  queued = new Map<string, (Reply | (() => Reply | Promise<Reply>))[]>();
  constructor(readonly defaults: Record<string, (args: Body) => Reply>) {}
  queue(tool: string, ...replies: (Reply | (() => Reply | Promise<Reply>))[]): this {
    this.queued.set(tool, [...(this.queued.get(tool) ?? []), ...replies]);
    return this;
  }
  async reply(tool: string, args: Body = {}): Promise<Reply> {
    this.calls.push({ tool, args });
    const q = this.queued.get(tool);
    const next = q?.shift();
    if (next) return typeof next === "function" ? next() : next;
    const d = this.defaults[tool];
    if (!d) throw new Error(`the fake has no reply for ${tool}`);
    return d(args);
  }
  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }
}

export const DEVICES = [
  { id: "sim-bridge:channel", class: "channel", adopted: true, capabilities: ["notify"], feedback: "none", bridge_device: { bridge: "sim-bridge", id: "channel" },
    actions: [{ action: "notify.notify", tier: "reversible", idempotent: false, stateless: true, ack_within_s: 5 }] },
  { id: "sim-bridge:lamp", class: null, proposed_class: "light", class_evidence: "protocol", adopted: false, capabilities: ["onoff"], feedback: "state",
    actions: [{ action: "onoff.turn_on", tier: "reversible", idempotent: true, stateless: false, ack_within_s: 5 },
      { action: "onoff.turn_off", tier: "reversible", idempotent: true, stateless: false, ack_within_s: 5 }] },
];

export const TRANSPORT = { id: "sim-bridge", kind: "zigbee", up: true, state: "up", bridge: "sim-bridge" };

export class FakeApplier extends Fake implements Applier {
  revision = 4;
  devices: Body[] = DEVICES;
  transports: Body[] = [TRANSPORT];
  /** The applier's event log: `feed` appends, `events` reads after a cursor; with none after it and a `wait_s`, the clock moves by it. */
  log: Body[] = [];
  constructor() {
    super({
      describe: () => ok({ applier_id: "applier", standard_version: "0.15", levels: ["Act"], revision: this.revision, devices: this.devices,
        transports: this.transports }),
      configure: (a) => ok(a.dry_run ? { diff: "adopt: x" } : { revision: ++this.revision }),
      events: (a) => {
        const last = String(this.log.length);
        if (a.cursor === undefined) return ok({ events: [], cursor: last, notices: [] });
        const after = this.log.slice(Number(a.cursor));
        if (!after.length && a.wait_s) this.clock.advance(a.wait_s * 1000);
        return ok({ events: after, cursor: last, notices: [] });
      },
      provision: (a) => ok({ request_id: `r${this.calls.length}`, op: Object.keys(a).find((k) => k !== "idempotency_key"),
        status: a.join_close ? "ok" : "accepted" }),
    });
  }
  /** Appends events to the log, each with its seq, time and type `provision` unless given. */
  feed(...events: Body[]): void {
    for (const e of events) this.log.push({ seq: this.log.length + 1, time: new Date(this.clock.now()).toISOString(), type: "provision", ...e });
  }
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply> {
    return this.reply("events", a);
  }
  provision(a: Record<string, unknown>): Promise<Reply> {
    return this.reply("provision", a);
  }
  describe(): Promise<Reply> {
    return this.reply("describe");
  }
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply> {
    return this.reply("configure", a);
  }
}

/**
 * An asked step as the steward 0.11 draft's `ask` event carries it (GA-CONF-5): a define's
 * confirmation `{ step_id, reason: "confirm_define", diff }`, any other `{ step_id, target, action,
 * args, tier, reason }`; a personal value in either may be `withheld` (GA-AUTH-7).
 */
export function askEntry(s: Body): Body {
  if (s.reason === "confirm_define") return { step_id: s.step_id, reason: s.reason, diff: s.diff };
  return { step_id: s.step_id, target: s.target, action: s.action, args: s.args, tier: s.tier, reason: s.reason };
}

/** A plan the fake steward holds: as made, the answers given, and whether it was applied. */
interface FakePlan {
  plan: Body;
  /** Where its question was put (GA-CONF-5): only that endpoint may answer it (GA-CONF-1). */
  askedAt: string;
  answers: Record<string, "yes" | "no">;
  applied: boolean;
}

/** An apply the fake steward made: its outcomes as dispatched, and when they land on the fake clock. */
interface FakeApply {
  apply_id: string;
  outcomes: Body[];
  at: number;
}

export class FakeSteward extends Fake implements Steward {
  revision = 10;
  targets: Body[] = [{ ...DEVICES[0], name: "Канал", room: null }, { ...DEVICES[1], name: "sim-bridge:lamp", room: null }];
  rooms: Body[] = [];
  /** The steward's event log: `feed` appends (and `plan`, `answer` and an apply's landing do), `events` reads after a cursor. */
  log: Body[] = [];
  /** Each `target action` raised above reversible, with its tier: its step is `ask(confirm_tier)`. */
  tiers: Record<string, string> = {};
  /** A step's verdict and reason the fake gives instead, by `target action` (a refuse or a skip). */
  verdicts: Record<string, { verdict: string; reason?: string }> = {};
  /** Where the fake puts an ask: owner-app's `confirm_on`, else the plan's endpoint. */
  confirmOn?: string;
  /** Whether the fake leaves the `ask` event out, as a steward that emits none would. */
  noAskEvent = false;
  /** The step fields an `ask` event carries (steward 0.11), or none (0.10). */
  askCarriesSteps = false;
  /** The `run_id` the fake's `ask` event names, as a scenario's re-ask may (steward 0.11 draft). */
  askRunId?: string;
  /** How long after the apply a dispatched step lands, and what it lands as. */
  landAfterMs = 0;
  landAs = "acked";
  plans = new Map<string, FakePlan>();
  applies = new Map<string, FakeApply>();
  /** Each idempotency key's apply, so a repeat returns the first, as the reference's `apply` does (GA-STW-6). */
  keys = new Map<string, { plan_id: string; apply_id: string }>();
  constructor() {
    super({
      // A long-poll on the revision it has waits out its wait_s on the fake clock.
      describe: (a) => {
        if (a.since_revision === this.revision && a.wait_s) this.clock.advance(a.wait_s * 1000);
        return ok({ steward_id: "steward", standard_version: "0.10", revision: this.revision, home: { ask_expiry_s: 300 },
          rooms: this.rooms, targets: this.targets });
      },
      state: (a) => ok({ targets: Object.fromEntries((a.targets ?? []).map((id: string) => [id, { liveness: id.endsWith("lamp") ? "dead" : "live" }])),
        transports: [], latches: [] }),
      history: () => ok({ events: [] }),
      define: (a) => ok(a.dry_run ? { diff: "home: x" } : { revision: ++this.revision }),
      events: (a) => {
        const last = String(this.log.length);
        if (a.cursor === undefined) return ok({ events: [], cursor: last });
        if (Number(a.cursor) > this.log.length) return refused("cursor_expired", `cursor ${a.cursor} is not this steward's`);
        const after = this.log.slice(Number(a.cursor));
        if (!after.length && a.wait_s) this.clock.advance(a.wait_s * 1000);
        return ok({ events: after, cursor: last });
      },
      plan: (a) => {
        const plan_id = `p${this.plans.size + 1}`;
        const steps = (a.actions as Body[]).map((x, i) => {
          const key = `${x.target} ${x.action}`;
          const tier = this.tiers[key] ?? "reversible";
          const given = this.verdicts[key];
          const v = given ?? (tier === "reversible" ? { verdict: "op" } : { verdict: "ask", reason: "confirm_tier" });
          return { step_id: `s${i + 1}`, target: x.target, action: x.action, args: x.args, verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}),
            tier, stale: false, basis: "reported" };
        });
        const asked = steps.filter((x) => x.verdict === "ask");
        const plan = { plan_id, expires_at: new Date(this.clock.now() + (asked.length ? 300_000 : 60_000)).toISOString(), revision: this.revision,
          endpoint: a.endpoint, client: "owner-app-credential", request: { endpoint: a.endpoint, actions: a.actions }, steps };
        this.plans.set(plan_id, { plan, askedAt: this.confirmOn ?? a.endpoint, answers: {}, applied: false });
        if (asked.length && !this.noAskEvent) {
          this.feed({ type: "ask", plan_id, step_ids: asked.map((x) => x.step_id), endpoint: this.confirmOn ?? a.endpoint,
            ...(this.askRunId !== undefined ? { run_id: this.askRunId } : {}),
            ...(this.askCarriesSteps ? { steps: asked.map(askEntry) } : {}) });
        }
        return ok(plan);
      },
      answer: (a) => {
        const held = this.plans.get(a.plan_id);
        if (!held) return refused("invalid_request", `no plan ${a.plan_id}`);
        for (const id of Object.keys(a.answers)) {
          if (!held.plan.steps.some((x: Body) => x.step_id === id && x.verdict === "ask")) return refused("invalid_request", `step ${id} was not asked`);
        }
        // As the reference's judgeAnswer: a yes after a no needs a new plan; then who may answer (GA-CONF-1); then expiry.
        const again = Object.entries(a.answers).filter(([id, w]) => w === "yes" && held.answers[id] === "no").map(([id]) => id);
        if (again.length) return refused("invalid_request", `step ${again.join(", ")} was answered no: a yes after a no needs a new plan`);
        if (a.endpoint !== held.askedAt) return refused("not_permitted", `the question is put on ${held.askedAt} (GA-CONF-1)`);
        if (held.applied) return refused("plan_expired", "the plan was applied already");
        held.answers = { ...held.answers, ...a.answers };
        this.feed({ type: "answer", plan_id: a.plan_id, endpoint: a.endpoint, answers: a.answers });
        return ok(this.view(held));
      },
      apply: (a) => {
        const prior = this.keys.get(a.idempotency_key);
        if (prior) {
          if (prior.plan_id !== a.plan_id) return refused("idempotency_conflict", "this key was used with another body (GA-STW-6)");
          const first = this.applies.get(prior.apply_id)!;
          return ok({ apply_id: first.apply_id, outcomes: structuredClone(first.outcomes) });
        }
        const held = this.plans.get(a.plan_id);
        if (!held) return refused("unknown_plan", `no plan ${a.plan_id} is held`);
        if (held.applied) return refused("plan_expired", "the plan was applied already: an apply spends it");
        held.applied = true;
        const time = new Date(this.clock.now()).toISOString();
        const outcomes = held.plan.steps.map((x: Body) => {
          const base = { step_id: x.step_id, target: x.target, time };
          if (x.verdict === "refuse") return { ...base, outcome: "refused", reason: x.reason };
          if (x.verdict === "skip") return { ...base, outcome: "skipped", reason: x.reason };
          if (x.verdict === "ask" && held.answers[x.step_id] !== "yes") return { ...base, outcome: "skipped", reason: "not_confirmed" };
          return { ...base, outcome: "unknown" };
        });
        const r = { apply_id: `a${this.applies.size + 1}`, outcomes, at: this.clock.now() };
        this.applies.set(r.apply_id, r);
        this.keys.set(a.idempotency_key, { plan_id: a.plan_id, apply_id: r.apply_id });
        return ok({ apply_id: r.apply_id, outcomes: structuredClone(outcomes) });
      },
      outcome: (a) => {
        const r = this.applies.get(a.apply_id);
        if (!r) return refused("unknown_apply", `no apply ${a.apply_id}`);
        if (this.clock.now() >= r.at + this.landAfterMs) {
          for (const o of r.outcomes) {
            if (o.outcome !== "unknown") continue;
            o.outcome = this.landAs;
            o.time = new Date(this.clock.now()).toISOString();
            this.feed({ type: "outcome", apply_id: r.apply_id, step_id: o.step_id, target: o.target, outcome: o.outcome });
          }
        }
        return ok({ apply_id: r.apply_id, outcomes: structuredClone(r.outcomes) });
      },
    });
  }
  /** A held plan as `answer` returns it: each answered step with the answer that stands. */
  view(held: FakePlan): Body {
    return { ...held.plan, steps: held.plan.steps.map((x: Body) => (held.answers[x.step_id] ? { ...x, answer: held.answers[x.step_id] } : x)) };
  }
  /** Appends events to the log, each with its seq and time. */
  feed(...events: Body[]): void {
    for (const e of events) this.log.push({ seq: this.log.length + 1, time: new Date(this.clock.now()).toISOString(), ...e });
  }
  describe(a: { since_revision?: number; wait_s?: number } = {}): Promise<Reply> {
    return this.reply("describe", a);
  }
  state(a: { targets?: string[] } = {}): Promise<Reply> {
    return this.reply("state", a);
  }
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply> {
    return this.reply("history", a);
  }
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply> {
    return this.reply("define", a);
  }
  // As the real steward's link does, every call that names an endpoint names owner-app.
  plan(a: { actions: Requested[] }): Promise<Reply> {
    return this.reply("plan", { endpoint: "owner-app", ...a });
  }
  answer(a: { plan_id: string; answers: Record<string, "yes" | "no"> }): Promise<Reply> {
    return this.reply("answer", { ...a, endpoint: "owner-app" });
  }
  apply(a: { plan_id: string; idempotency_key: string }): Promise<Reply> {
    return this.reply("apply", a);
  }
  outcome(a: { apply_id: string }): Promise<Reply> {
    return this.reply("outcome", a);
  }
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply> {
    return this.reply("events", a);
  }
}

export const SECRETS: Record<string, string> = {
  "applier-owner": "applier-owner-secret-0123456789",
  "steward-owner": "steward-owner-secret-0123456789",
  "steward-at-applier": "steward-at-applier-secret-0123",
  "steward-token-key": "steward-token-key-secret-01234",
  brain_agent: "brain-agent-secret-0123456789ab",
};

/** Deps over the fakes, with what was said kept. */
export function fakeDeps(o: { applier?: FakeApplier; steward?: FakeSteward; inputs?: Record<string, string>; now?: number;
  applierFails?: Error; stewardFails?: Error } = {}) {
  const applier = o.applier ?? new FakeApplier();
  const steward = o.steward ?? new FakeSteward();
  const clock = new FakeClock(o.now);
  applier.clock = clock;
  steward.clock = clock;
  /** The interrupt handlers registered now: `interrupt()` calls each, as a SIGINT would. */
  const handlers = new Set<() => void>();
  const out: string[] = [];
  const err: string[] = [];
  /** Every secret file a command asked for, by name, in order. */
  const secretReads: string[] = [];
  const deps: Deps = {
    say: { out: (l) => void out.push(l), err: (l) => void err.push(l) },
    applier: async () => {
      if (o.applierFails) throw o.applierFails;
      return applier;
    },
    steward: async () => {
      if (o.stewardFails) throw o.stewardFails;
      return steward;
    },
    secret: (name) => {
      secretReads.push(name);
      const s = SECRETS[name];
      if (s === undefined) throw new FileProblem(`secrets/mcp/${name} cannot be read (ENOENT)`);
      return s;
    },
    input: async (path) => {
      const t = o.inputs?.[path];
      if (t === undefined) throw new FileProblem(`${path} cannot be read (ENOENT)`);
      return t;
    },
    now: () => clock.now(),
    onInterrupt: (h) => {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
  };
  const interrupt = () => {
    for (const h of [...handlers]) h();
  };
  return { deps, applier, steward, clock, out, err, secretReads, interrupt, handlers, all: () => [...out, ...err].join("\n") };
}

/** No secret of the installation in anything said. */
export function noSecretIn(text: string): boolean {
  return Object.values(SECRETS).every((s) => !text.includes(s));
}
