import { describe, expect, it, vi } from "vitest";
import { Applier, type BusPort, type ToolResult } from "../src/applier.js";
import type { Puback } from "../src/bus/client.js";
import { StoreUnavailable } from "../src/core/errors.js";
import { GATE_MS, Store } from "../src/core/store.js";
import { ACK_GRACE_MS, LATE_ACK_MS, MAX_ATTEMPTS, REISSUE_GAP_MS, reissuable } from "../src/dispatch/dispatcher.js";
import { HELD_MS } from "../src/dispatch/records.js";
import { proofOf } from "../src/gate/token.js";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const OWNER = "owner-credential";
const KEY = "the-steward's-token-key";
const T = "2030-01-01T08:00:00.000Z";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

type Sent = { bridge: string; device: string; body: Record<string, any>; expiryS: number };

/** A bus that records each command and answers its PUBACK from `next` (success by default), or holds it while `hold` is set. */
function fakeBus() {
  const sent: Sent[] = [];
  const next: Puback[] = [];
  const held: ((p: Puback) => void)[] = [];
  const state: { hold: boolean; snapshot: Puback } = { hold: false, snapshot: { kind: "ok" } };
  const bus: BusPort = {
    follow: () => undefined,
    snapshot: async () => state.snapshot,
    command: (b, device, cmd, expiryS) => {
      sent.push({ bridge: b.id, device, body: cmd, expiryS });
      if (state.hold) return new Promise((r) => held.push(r));
      return Promise.resolve(next.shift() ?? { kind: "ok" });
    },
  };
  return { bus, sent, next, held, state };
}

const lampAt = (id: string, extra: Record<string, unknown> = {}) => ({ id, stableIdentifier: `test:${id}`, transport: "radio",
  capabilities: ["onoff", "level"], actions: [
    { action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true },
    { action: "onoff.turn_off", idempotent: true, stateless: false, confirms: true },
    { action: "level.set_level", idempotent: true, stateless: false, confirms: true }],
  feedback: "closed", reachMs: 0, proposedClass: "light", classEvidence: "protocol", ...extra });
const chime = { id: "chime", stableIdentifier: "test:chime", transport: "radio", capabilities: ["notify"],
  actions: [{ action: "notify.notify", idempotent: false, stateless: true, confirms: true }],
  feedback: "closed", reachMs: 0, proposedClass: "channel", classEvidence: "protocol" };
const pager = { ...chime, id: "pager", stableIdentifier: "test:pager", actions: [{ action: "notify.notify", idempotent: false,
  stateless: true, confirms: false, args: { text: "any", urgency: ["info", "warning", "critical"], from: "any" } }] };
const tv = { id: "tv", stableIdentifier: "test:tv", transport: "radio", capabilities: ["onoff"],
  actions: [{ action: "onoff.turn_on", idempotent: false, stateless: false, confirms: false, toggles: true },
    { action: "onoff.turn_off", idempotent: true, stateless: false, confirms: false }],
  feedback: "open", reachMs: 0, proposedClass: "tv", classEvidence: "protocol" };
// A momentary relay: each command one pulse, so no action on it is idempotent (GA-APPLY-6).
const relay = { id: "relay", stableIdentifier: "test:relay", transport: "radio", capabilities: ["onoff"],
  actions: [{ action: "onoff.turn_on", idempotent: false, stateless: false, confirms: true, toggles: true },
    { action: "onoff.turn_off", idempotent: false, stateless: false, confirms: true, toggles: true }],
  feedback: "closed", reachMs: 0, proposedClass: "socket", classEvidence: "protocol" };
// An IR air conditioner: nothing reports, and every code carries its whole state (GA-APPLY-16).
const ac = { id: "ac", stableIdentifier: "test:ac", transport: "radio", capabilities: ["climate"],
  actions: ["climate.set_mode", "climate.set_setpoint"].map((action) => ({ action, idempotent: true, stateless: false, confirms: false,
    wholeState: true })), feedback: "open", reachMs: 0, proposedClass: "ac", classEvidence: "protocol" };
// A button pusher whose bridge describes a setting of its own: an extension, confirmed by its echo (applier, *Extensions*).
const PUSH = "org.galatea.test.pusher";
const pusher = { id: "pusher", stableIdentifier: "test:pusher", transport: "radio", capabilities: ["onoff"],
  actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true },
    { action: `${PUSH}.set_mode`, idempotent: true, stateless: false, confirms: false, confirmedBy: { key: `${PUSH}.mode`, value: { arg: "mode" } } }],
  extensions: [{ capability: PUSH, description: "The pusher's own settings.", actions: [{ action: `${PUSH}.set_mode`, description: "Sets its mode.",
    schema: { type: "object", properties: { mode: { enum: ["click", "switch"] } } } }],
  keys: [{ key: `${PUSH}.mode`, description: "Its mode.", schema: { type: "string" } }] }],
  feedback: "closed", reachMs: 0, proposedClass: "socket", classEvidence: "protocol" };
const devices = [lampAt("lamp"), lampAt("spot"), chime, pager, tv, relay, ac, pusher];
const status = (bridgeId: string, ids: string[], at = T) => ({ bridgeId, instanceId: "11111111-1111-4111-8111-111111111111", v: 1,
  state: "online", version: "1", levels: ["Serve"], faults: [], ungoverned: [], blocked: [],
  transports: [{ id: "radio", kind: "zigbee", state: "up", since: T }],
  devices: ids.map((id) => ({ id, transport: "radio", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, timestamp: at,
    lastCheckIn: at, observable: true, since: T })), publishedAt: at });

const ask = (target: string, action = "onoff.turn_on", args: Record<string, unknown> = {}) =>
  ({ target, action, args, via: "app", brain: false, for: { person: "demo" } });

async function home(opts: { mutation?: Mutation; db?: Awaited<ReturnType<typeof memoryDb>>; fresh?: boolean;
  /** False: the test calls `a.load()` and `a.resume()` itself. */
  start?: boolean } = {}) {
  const clock = new FakeClock();
  const db = opts.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const fb = fakeBus();
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1", mutation: opts.mutation, bus: fb.bus });
  if (opts.start !== false) await a.start();
  const owner = a.caller(OWNER);
  const configure = async (changes: unknown[]) => {
    const { revision } = body(await a.call(owner, "describe", {}));
    return body(await a.call(owner, "configure", { changes, expected_revision: revision, dry_run: false }));
  };
  const send = (bridge: string, path: string, b: unknown, retained = false) =>
    a.home.message(bridge, path, Buffer.from(JSON.stringify(b)), retained);
  const report = (device: string, values: Record<string, unknown>, at = clock.now()) =>
    send("hall-bridge", `devices/${device}/status`, { deviceId: device, ...values, timestamp: new Date(at).toISOString() });
  const ack = (s: Sent, result: string, extra: Record<string, unknown> = {}) =>
    send(`${s.bridge}-bridge`, `devices/${s.device}/ack`, { commandId: s.body.commandId, source: `${s.bridge}-bridge`, result,
      timestamp: new Date(clock.now()).toISOString(), ...extra });
  if (opts.fresh !== false) {
    await configure([{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } },
      { op: "upsert", kind: "client", value: { id: "h", credential: "h-credential", kind: "steward", token_key: KEY } },
      { op: "upsert", kind: "client", value: { id: "g", credential: "g-credential", kind: "steward" } }]);
    send("hall-bridge", "devices", { devices }, true);
    a.listening("hall");
    send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id)));
    await configure(devices.map((d) => ({ op: "upsert", kind: "adopt", value: { device: `hall:${d.id}`, class: d.proposedClass } })));
  }
  const h = a.caller("h-credential");
  const apply = async (actions: unknown[], who = h) => body(await a.call(who, "apply", { idempotency_key: crypto.randomUUID(),
    request: { actions } }));
  // Read at each call: with `start: false`, the clients are loaded only after `home` returns.
  const outcomes = async (id: string) => body(await a.call(a.caller("h-credential"), "outcome", { apply_id: id })).outcomes;
  const events = async (cursor: string, type: string) =>
    body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === type);
  const cursor = async () => body(await a.call(owner, "events", {})).cursor as string;
  const token = (asked: ReturnType<typeof ask>, id = "t-1", expires = clock.now() + 30_000) => {
    const unsigned = { token_id: id, issuer: "h", ...asked, expires: new Date(expires).toISOString() };
    return { ...unsigned, proof: proofOf(unsigned as never, KEY) };
  };
  return { a, db, store, clock, owner, h, configure, send, report, ack, apply, outcomes, events, cursor, token, ...fb };
}

describe("apply and dispatch", () => {
  it("publishes a command per op step with its bound as Message Expiry, and acks it only on the report that matches (GA-EVT-3, GA-BUS-5)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    expect(r.outcomes).toMatchObject([{ step_id: "s1", target: "hall:lamp", outcome: "dispatched" }]);
    expect(m.sent).toMatchObject([{ bridge: "hall", device: "lamp", expiryS: 10,
      body: { resultWithinMs: 10_000, value: { action: "onoff.turn_on" } } }]);
    expect(m.sent[0]!.body.value).not.toHaveProperty("value");
    m.ack(m.sent[0]!, "applied");
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    const c = await m.cursor();
    m.report("lamp", { on: true });
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "acked" });
    expect(await m.events(c, "state")).toMatchObject([{ target: "hall:lamp", key: "on", value: true,
      cause: { apply: r.apply_id, client: "h", for: { person: "demo" } } }]);
    expect(await m.events(c, "outcome")).toMatchObject([{ apply_id: r.apply_id, step_id: "s1", target: "hall:lamp", outcome: "acked" }]);
  });

  it("acks on a matching report that arrives after the publish, whatever its bridge's clock says, and none before (GA-EVT-3)", async () => {
    const m = await home();
    m.report("lamp", { on: false }, m.clock.now() - 20_000);
    m.clock.advance(1000);
    const r = await m.apply([ask("hall:lamp")]);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    // Its bridge's clock runs 6 s slow: the read-back is stamped before the dispatch, and arrives after it.
    m.report("lamp", { on: true }, m.clock.now() - 6_000);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
  });

  it("acks an extension action only on the report of its confirmed_by key at the value it asks, an argument's included, and skips it already where it holds (GA-EVT-3, GA-PLAN-4)", async () => {
    const m = await home();
    const asked = ask("hall:pusher", `${PUSH}.set_mode`, { mode: "click" });
    const r = await m.apply([{ ...asked, token: m.token(asked) }]);
    expect(m.sent[0]!.body.value).toEqual({ action: `${PUSH}.set_mode`, value: { mode: "click" } });
    m.ack(m.sent[0]!, "sent");
    m.report("pusher", { [`${PUSH}.mode`]: "switch" });
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    m.report("pusher", { [`${PUSH}.mode`]: "click" });
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
    const again = body(await m.a.call(m.h, "plan", { actions: [ask("hall:pusher", `${PUSH}.set_mode`, { mode: "click" })] }));
    expect(again.steps[0]).toMatchObject({ verdict: "skip", reason: "already" });
  });

  it("refuses an extension action whose confirmed_by names an argument the step does not give, invalid_args at plan, since nothing could ack it", async () => {
    const m = await home();
    const plan = body(await m.a.call(m.h, "plan", { actions: [ask("hall:pusher", `${PUSH}.set_mode`, {}),
      ask("hall:pusher", `${PUSH}.set_mode`, { mode: { deep: 1 } })] }));
    expect(plan.steps.map((s: any) => [s.verdict, s.reason])).toEqual([["refuse", "invalid_args"], ["refuse", "invalid_args"]]);
  });

  it("holds a report that arrives before the PUBACK until it: a success acks the step, a refusal leaves it unreachable and its token unused (GA-EVT-3, GA-BUS-9)", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    const asked = ask("hall:lamp");
    for (const [puback, want] of [[{ kind: "no_subscribers" }, "unreachable"], [{ kind: "ok" }, "acked"]] as const) {
      m.report("lamp", { on: false });
      m.state.hold = true;
      const p = m.apply([{ ...asked, token: m.token(asked) }]);
      await new Promise((r) => setTimeout(r, 20));
      m.report("lamp", { on: true });
      m.held.shift()!(puback);
      const r = await p;
      expect((await m.outcomes(r.apply_id))[0].outcome).toBe(want);
      expect(m.a.dispatcher.isUsed("h", "t-1")).toBe(want === "acked");
    }
  });

  it("acks a stateful step on applied alone under acks-without-state", async () => {
    const m = await home({ mutation: "acks-without-state" });
    const r = await m.apply([ask("hall:lamp")]);
    m.ack(m.sent[0]!, "applied");
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
  });

  it("dispatches in request order, each after the PUBACK of the one before (GA-PLAN-7)", async () => {
    const m = await home();
    m.state.hold = true;
    const p = m.apply([ask("hall:spot"), ask("hall:lamp")]);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.sent.map((s) => s.device)).toEqual(["spot"]);
    m.held.shift()!({ kind: "ok" });
    await new Promise((r) => setTimeout(r, 20));
    expect(m.sent.map((s) => s.device)).toEqual(["spot", "lamp"]);
    m.held.shift()!({ kind: "ok" });
    expect((await p).outcomes.map((o: any) => o.outcome)).toEqual(["dispatched", "dispatched"]);
  });

  it("ends a step unreachable on 0x10 or any refusal, the token unused, only 0x87 a fault raised once; a lost PUBACK is dispatched (GA-BUS-9)", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    const asked = ask("hall:lamp");
    const t = m.token(asked);
    const c = await m.cursor();
    m.next.push({ kind: "no_subscribers" }, { kind: "refused", code: 0x97 }, { kind: "refused", code: 0x87 }, { kind: "refused", code: 0x87 },
      { kind: "lost" });
    // Only 0x87 is the bridge's fault; 0x97, a quota, is the applier's own condition (GA-BUS-9).
    for (let i = 0; i < 4; i++) expect((await m.apply([{ ...asked, token: t }])).outcomes[0]).toMatchObject({ outcome: "unreachable" });
    expect((await m.events(c, "bridge_fault")).map((e: any) => e.what)).toEqual(["the broker refused a command to this bridge (0x87)"]);
    const r = await m.apply([{ ...asked, token: t }]);
    expect(r.outcomes[0].outcome).toBe("dispatched");
    expect(m.sent).toHaveLength(5);
    // Used now: a second apply with it is refused(token), and nothing is sent again.
    expect((await m.apply([{ ...asked, token: t }])).outcomes[0]).toMatchObject({ outcome: "refused", reason: "token" });
    expect(m.sent).toHaveLength(5);
  });

  it("dispatches a token at most once, even by applies running at once, even under trusts-any-token (GA-TOKEN-4)", async () => {
    for (const mutation of [undefined, "trusts-any-token"] as const) {
      const m = await home({ mutation });
      await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
      const asked = ask("hall:lamp");
      const t = m.token(asked);
      const [x, y] = await Promise.all([m.apply([{ ...asked, token: t }]), m.apply([{ ...asked, token: t }])]);
      expect([x.outcomes[0].outcome, y.outcomes[0].outcome].sort()).toEqual(["dispatched", "refused"]);
      expect(m.sent).toHaveLength(1);
    }
  });

  it("keeps a token used after a late unreachable, and unused for an inline step whose target is dead, skipped(dead) (GA-TOKEN-4, GA-APPLY-5)", async () => {
    for (const mutation of [undefined, "reuses-token-after-late-unreachable"] as const) {
      const m = await home({ mutation });
      await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
      const asked = ask("hall:lamp");
      const t = m.token(asked);
      const r = await m.apply([{ ...asked, token: t }]);
      m.ack(m.sent[0]!, "failed", { reason: "unreachable" });
      expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "unreachable" });
      expect(m.a.dispatcher.isUsed("h", "t-1")).toBe(mutation === undefined);
    }
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    const asked = ask("hall:lamp");
    m.report("lamp", { on: false, available: false });
    // An inline request is planned in the same call: its dead target is skipped(dead), as a planned one is.
    expect((await m.apply([{ ...asked, token: m.token(asked) }])).outcomes[0]).toMatchObject({ outcome: "skipped", reason: "dead" });
    expect(m.a.dispatcher.isUsed("h", "t-1")).toBe(false);
    expect(m.sent).toEqual([]);
  });

  it("re-judges a planned step at dispatch: already both ways, dead, the token (GA-APPLY-9)", async () => {
    const m = await home();
    m.report("lamp", { on: true });
    const plan = body(await m.a.call(m.h, "plan", { actions: [ask("hall:lamp"), ask("hall:spot")] }));
    expect(plan.steps.map((s: any) => s.reason ?? s.verdict)).toEqual(["already", "op"]);
    m.report("lamp", { on: false });
    m.report("spot", { on: true });
    const r = body(await m.a.call(m.h, "apply", { idempotency_key: "k", plan_id: plan.plan_id }));
    expect(r.outcomes).toMatchObject([{ outcome: "dispatched" }, { outcome: "skipped", reason: "already" }]);
    expect(m.sent.map((s) => s.device)).toEqual(["lamp"]);
  });

  it("refuses at dispatch a toggle whose token expired since its plan (GA-APPLY-9)", async () => {
    for (const mutation of [undefined, "applies-without-token"] as const) {
      const m = await home({ mutation });
      const asked = ask("hall:tv");
      const plan = body(await m.a.call(m.h, "plan", { actions: [{ ...asked, token: m.token(asked, "t-1", m.clock.now() + 1000) }] }));
      expect(plan.steps[0]).toMatchObject({ verdict: "op" });
      m.clock.advance(7000);
      m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
      const r = body(await m.a.call(m.h, "apply", { idempotency_key: "k", plan_id: plan.plan_id }));
      // Without a token that stands, the toggle has no person's yes: refused(toggle_only), whatever the token check's own mutation.
      expect(r.outcomes[0]).toMatchObject({ outcome: "refused", reason: "toggle_only" });
    }
  });

  it("refuses an expired plan, one of an older revision and another client's: nothing dispatched (GA-APPLY-2)", async () => {
    const m = await home();
    const plan = async () => body(await m.a.call(m.h, "plan", { actions: [ask("hall:lamp")] })).plan_id;
    const applyPlan = (id: string, who = m.h) => m.a.call(who, "apply", { idempotency_key: "k", plan_id: id });
    const mine = await plan();
    expect(await applyPlan(mine, m.a.caller("g-credential"))).toMatchObject({ ok: false, error: "plan_not_yours" });
    await m.configure([{ op: "upsert", kind: "client", value: { id: "x", credential: "x-credential", kind: "steward" } }]);
    expect(await applyPlan(mine)).toMatchObject({ ok: false, error: "stale_revision" });
    const old = await plan();
    m.clock.advance(60_000);
    expect(await applyPlan(old)).toMatchObject({ ok: false, error: "plan_expired" });
    expect(await applyPlan("nothing")).toMatchObject({ ok: false, error: "unknown_plan" });
    expect(m.sent).toEqual([]);
  });

  it("ends a closed device's step failed(no_ack) at its bound, keeping a no_confirmation's detail; the first final wins (GA-APPLY-8, GA-APPLY-15)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.ack(m.sent[0]!, "received");
    m.ack(m.sent[0]!, "failed", { reason: "no_confirmation", detail: "the bulb did not answer" });
    m.clock.advance(9_000);
    m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
    m.clock.advance(1_000);
    // At the bound, inside the 1 s an ack may still take (GA-BUS-4): still waiting.
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    m.clock.advance(ACK_GRACE_MS);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack", detail: "the bulb did not answer" });
    m.report("lamp", { on: true });
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("takes an ack that arrives in the 1 s after the bound, from a bridge counting the time from receipt (GA-BUS-4)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:chime", "notify.notify", { text: "hi", urgency: "info" })]);
    m.clock.advance(10_500);
    m.ack(m.sent[0]!, "applied");
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("delivered");
  });

  it("never ends a silent step under never-fails-a-silent-ack", async () => {
    const m = await home({ mutation: "never-fails-a-silent-ack" });
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(11_000);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
  });

  it("ends a closed device's waiting step failed(no_ack) at once when its bridge dies (GA-APPLY-8)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp"), ask("hall:tv", "onoff.turn_off")]);
    m.ack(m.sent[0]!, "applied");
    m.send("hall-bridge", "lwt", { instanceId: "11111111-1111-4111-8111-111111111111" });
    expect((await m.outcomes(r.apply_id)).map((o: any) => [o.outcome, o.reason])).toEqual([["failed", "no_ack"], ["dispatched", undefined]]);
    m.clock.advance(11_000);
    expect((await m.outcomes(r.apply_id))[1].outcome).toBe("unanswered");
  });

  it("takes the bridge's acks as the outcomes say, with their detail (GA-APPLY-5, 7, 15)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp"), ask("hall:spot"), ask("hall:chime", "notify.notify", { text: "hi", urgency: "info" }),
      ask("hall:pager", "notify.notify", { text: "hi", urgency: "info" }), ask("hall:tv", "onoff.turn_off")]);
    const [lamp, spot, chime, pager, tvs] = m.sent;
    m.ack(lamp!, "failed", { reason: "rejected", detail: "the bulb is busy" });
    m.ack(spot!, "failed", { reason: "expired" });
    m.ack(chime!, "applied", { detail: "rang" });
    m.ack(pager!, "sent");
    m.ack(tvs!, "sent");
    expect(await m.outcomes(r.apply_id)).toMatchObject([{ outcome: "failed", reason: "rejected", detail: "the bulb is busy" },
      { outcome: "unreachable" }, { outcome: "delivered", detail: "rang" }, { outcome: "sent" }, { outcome: "sent" }]);
  });

  it("drops the ack's detail under drops-the-ack-detail", async () => {
    const m = await home({ mutation: "drops-the-ack-detail" });
    const r = await m.apply([ask("hall:lamp")]);
    m.ack(m.sent[0]!, "failed", { reason: "rejected", detail: "the bulb is busy" });
    expect((await m.outcomes(r.apply_id))[0]).not.toHaveProperty("detail");
  });

  it("takes a sent for an action declared confirms: true as a fault, and the step waits (GA-APPLY-7)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:chime", "notify.notify", { text: "hi", urgency: "info" })]);
    const c = await m.cursor();
    m.ack(m.sent[0]!, "sent");
    expect(await m.events(c, "bridge_fault")).toMatchObject([{ bridge: "hall", what: expect.stringMatching(/confirms: true/) }]);
    m.clock.advance(11_000);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("takes an ack whose source is not its bridge's as a fault and no ack, unless trusts-a-foreign-ack (GA-BUS-13)", async () => {
    for (const mutation of [undefined, "trusts-a-foreign-ack"] as const) {
      const m = await home({ mutation });
      const r = await m.apply([ask("hall:lamp")]);
      const c = await m.cursor();
      m.ack(m.sent[0]!, "failed", { reason: "rejected", source: "another-bridge" });
      expect((await m.outcomes(r.apply_id))[0].outcome).toBe(mutation ? "failed" : "dispatched");
      expect(await m.events(c, "bridge_fault")).toHaveLength(mutation ? 0 : 1);
    }
  });

  it("sends notify's from only to a device that lists it, unless sends-from-to-an-old-bridge (GA-APPLY-14)", async () => {
    for (const mutation of [undefined, "sends-from-to-an-old-bridge"] as const) {
      const m = await home({ mutation });
      const args = { text: "hi", urgency: "info", from: { notice: "n-1" } };
      await m.apply([ask("hall:chime", "notify.notify", args), ask("hall:pager", "notify.notify", args)]);
      expect(m.sent.map((s) => s.body.value.value)).toEqual([mutation ? args : { text: "hi", urgency: "info" }, args]);
    }
  });

  it("gives a report moving towards a dispatched set_level, and its side effect, the apply's cause; one moving away is external (GA-EVT-1, GA-EVT-6)", async () => {
    const m = await home();
    m.report("lamp", { on: false, level: 10 });
    await m.configure(["level", "on"].map((key) => ({ op: "upsert", kind: "self_changing", value: { device: "hall:lamp", key } })));
    const r = await m.apply([ask("hall:lamp", "level.set_level", { level: 80 })]);
    expect(m.sent[0]!.body.value).toEqual({ action: "level.set_level", value: 80 });
    const c = await m.cursor();
    m.report("lamp", { on: true, level: 40 });
    m.report("lamp", { level: 30 });
    m.report("lamp", { level: 80 });
    m.report("lamp", { level: 60 });
    const causes = (await m.events(c, "state")).map((e: any) => [e.key, e.value, typeof e.cause === "string" ? e.cause : "apply"]);
    // `on` is self_changing and only a side effect: the device's; `level` is the action's own key: the apply's.
    expect(causes).toEqual([["on", true, "device"], ["level", 40, "apply"], ["level", 30, "device"], ["level", 80, "apply"], ["level", 60, "device"]]);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
  });

  it("refuses a request holding a string Postgres cannot keep, sending nothing", async () => {
    const m = await home();
    expect(await m.a.call(m.h, "apply", { idempotency_key: "k", request: { actions: [{ ...ask("hall:lamp"), for: { person: "a\u0000b" } }] } }))
      .toMatchObject({ ok: false, error: "invalid_request" });
    expect(m.sent).toEqual([]);
  });

  it("answers outcome only to the client that applied, and unknown_apply otherwise", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    expect(await m.a.call(m.a.caller("g-credential"), "outcome", { apply_id: r.apply_id })).toMatchObject({ ok: false, error: "unknown_apply" });
    expect(await m.a.call(m.h, "outcome", { apply_id: "nothing" })).toMatchObject({ ok: false, error: "unknown_apply" });
  });

  it.each([undefined, "forgets-a-used-token"] as const)(
    "keeps held outcomes, used tokens and waiting steps across a restart, and times the bound again (GA-PERSIST-1), mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    const asked = ask("hall:lamp");
    const r = await m.apply([{ ...asked, token: m.token(asked) }]);
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, mutation });
    expect(again.a.dispatcher.isUsed("h", "t-1")).toBe(mutation === undefined);
    expect((await again.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    again.clock.advance(11_000);
    expect((await again.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it.each([undefined, "forgets-an-ack-deadline"] as const)(
    "keeps a step's ack deadline across a restart, failed(no_ack) at its bound and not before (GA-PERSIST-1), mutation %s", async (mutation) => {
      const db = lasting(await memoryDb());
      const m = await home({ db });
      const r = await m.apply([ask("hall:lamp")]);
      m.a.stop();
      await m.store.close();
      const again = await home({ db, fresh: false, mutation });
      expect((await again.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
      again.clock.advance(11_000);
      expect((await again.outcomes(r.apply_id))[0].outcome).toBe(mutation ? "dispatched" : "failed");
    });

  it("lets a step in flight wait for its bound when the applier loses its broker, which is no bridge found dead (GA-BUS-9, GA-APPLY-8)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.a.lost();
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    m.a.listening("hall");
    m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    m.clock.advance(11_000);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("ends every step an apply held when the process died between its PUBACKs, none left dispatched (GA-APPLY-8, GA-PERSIST-1)", async () => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const c = await m.cursor();
    m.state.hold = true;
    const p = m.apply([ask("hall:spot"), ask("hall:lamp")]);
    void p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    m.held.shift()!({ kind: "ok" });
    await new Promise((r) => setTimeout(r, 20));
    // The lamp's command was published and its PUBACK never came: the process dies.
    expect(m.sent.map((s) => s.device)).toEqual(["spot", "lamp"]);
    const applyId = (await m.events(c, "outcome"))[0].apply_id as string;
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false });
    again.clock.advance(11_000);
    expect((await again.outcomes(applyId)).map((o: any) => [o.outcome, o.reason])).toEqual([["failed", "no_ack"], ["failed", "no_ack"]]);
  });

  it("ends at a start a held step still dispatched whose waiting row was lost, failed(no_ack), never left dispatched (GA-PERSIST-1)", async () => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const r = await m.apply([ask("hall:lamp")]);
    m.a.stop();
    await m.store.close();
    await db.query("DELETE FROM waiting");
    const again = await home({ db, fresh: false });
    expect((await again.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("reads its rows at load and judges nothing until resume: an orphan step ends failed(no_ack) only then (GA-PERSIST-1)", async () => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const c = await m.cursor();
    const r = await m.apply([ask("hall:lamp")]);
    m.a.stop();
    await m.store.close();
    await db.query("DELETE FROM waiting");
    const again = await home({ db, fresh: false, start: false });
    await again.a.load();
    // Loaded: the apply is held, its orphan step not yet judged, no outcome event served.
    expect((await again.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    expect((await again.events(c, "outcome")).filter((e: any) => e.apply_id === r.apply_id && e.outcome === "failed")).toEqual([]);
    await again.a.resume();
    expect((await again.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("takes a snapshot request the broker refused 0x87 as a fault, raised once and cleared by a success (GA-BUS-9)", async () => {
    const m = await home();
    const c = await m.cursor();
    m.state.snapshot = { kind: "refused", code: 0x87 };
    const anew = (instanceId: string) => m.send("hall-bridge", "status", { ...status("hall-bridge", devices.map((d) => d.id),
      new Date(m.clock.now()).toISOString()), instanceId });
    anew("22222222-2222-4222-8222-222222222222");
    anew("33333333-3333-4333-8333-333333333333");
    await new Promise((r) => setTimeout(r, 20));
    expect((await m.events(c, "bridge_fault")).map((e: any) => e.what)).toEqual(["the broker refused a request to this bridge (0x87)"]);
  });

  it("sends a device's command only through the bridge that carries it: a folded copy's bridge is sent nothing, its acks and its death are no one's (GA-BUS-11)", async () => {
    const m = await home();
    // The lamp's hardware shows on a second bridge: folded into it while unadopted, then routed to its first and adopted (route first).
    await m.configure([{ op: "upsert", kind: "bridge", value: { id: "porch", identity: "porch-bridge" } },
      { op: "delete", kind: "adopt", value: { device: "hall:lamp" } }]);
    // The porch bridge also carries a device of its own, whose liveness shows the bridge's.
    m.send("porch-bridge", "devices", { devices: [{ ...lampAt("lamp"), id: "0x01" }, { ...lampAt("porchlight"), id: "0x09" }] }, true);
    m.a.listening("porch");
    const before = await m.cursor();
    m.send("porch-bridge", "status", status("porch-bridge", ["0x01", "0x09"], new Date(m.clock.now()).toISOString()));
    expect((await m.events(before, "liveness")).filter((e: any) => e.target === "porch:0x09").map((e: any) => e.new)).toEqual(["live"]);
    await m.configure([{ op: "upsert", kind: "route", value: { stable_identifier: "test:lamp", bridge: "hall" } },
      { op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]);
    expect(body(await m.a.call(m.owner, "describe", {})).devices.map((d: any) => d.id)).not.toContain("porch:0x01");
    const r = await m.apply([ask("hall:lamp")]);
    expect(m.sent.map((s) => [s.bridge, s.device])).toEqual([["hall", "lamp"]]);
    // The copy's bridge acks the command id: no one's.
    m.send("porch-bridge", "devices/0x01/ack", { commandId: m.sent[0]!.body.commandId, source: "porch-bridge", result: "failed",
      reason: "rejected", timestamp: T });
    m.send("porch-bridge", "devices/0x01/status", { deviceId: "0x01", on: true, timestamp: new Date(m.clock.now()).toISOString() });
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    const c = await m.cursor();
    m.send("porch-bridge", "lwt", { instanceId: "11111111-1111-4111-8111-111111111111" });
    // The copy's bridge did die (its own device went dead), and the lamp's liveness did not change.
    expect((await m.events(c, "liveness")).map((e: any) => [e.target, e.new])).toEqual([["porch:0x09", "dead"]]);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    // An ack for it on another device's topic of its own bridge is a fault, and no ack.
    m.ack({ ...m.sent[0]!, device: "spot" }, "applied");
    expect((await m.events(c, "bridge_fault")).map((e: any) => e.what)).toEqual([expect.stringMatching(/for a command sent to lamp/)]);
    m.report("lamp", { on: true });
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
  });
});

describe("idempotency keys", () => {
  /** `apply` of an inline request under `key`, as `who` (the client h by default). */
  const keyed = (m: Awaited<ReturnType<typeof home>>, key: string, actions: unknown[], who = m.h) =>
    m.a.call(who, "apply", { idempotency_key: key, request: { actions } });

  it("returns the first apply for the same key and body from the same client, dispatching nothing more; another client's key is its own (GA-APPLY-4)", async () => {
    const m = await home();
    const first = body(await keyed(m, "k-1", [ask("hall:lamp")]));
    m.ack(m.sent[0]!, "applied");
    m.report("lamp", { on: true });
    const again = body(await keyed(m, "k-1", [ask("hall:lamp")]));
    expect(again).toEqual({ apply_id: first.apply_id, outcomes: await m.outcomes(first.apply_id) });
    expect(again.outcomes[0].outcome).toBe("acked");
    expect(m.sent).toHaveLength(1);
    m.report("lamp", { on: false });
    const other = body(await keyed(m, "k-1", [ask("hall:lamp")], m.a.caller("g-credential")));
    expect(other.apply_id).not.toBe(first.apply_id);
    expect(m.sent).toHaveLength(2);
  });

  it("takes a retry carrying freshly issued tokens as the same body (GA-APPLY-4)", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    const asked = ask("hall:lamp");
    const first = body(await keyed(m, "k-1", [{ ...asked, token: m.token(asked, "t-1") }]));
    const again = body(await keyed(m, "k-1", [{ ...asked, token: m.token(asked, "t-2") }]));
    expect(again.apply_id).toBe(first.apply_id);
    expect(m.sent).toHaveLength(1);
    expect(m.a.dispatcher.isUsed("h", "t-2")).toBe(false);
  });

  it("is idempotency_conflict for the same key with another body, dispatching nothing (GA-APPLY-10)", async () => {
    const m = await home();
    const first = body(await keyed(m, "k-1", [ask("hall:lamp")]));
    expect(await keyed(m, "k-1", [ask("hall:spot")])).toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect(await m.a.call(m.h, "apply", { idempotency_key: "k-1", plan_id: "p" })).toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect(m.sent.map((x) => x.device)).toEqual(["lamp"]);
    expect((await m.outcomes(first.apply_id))[0].outcome).toBe("dispatched");
  });

  it("answers a repeat that comes while the first apply waits for its PUBACK with the first apply, once that returns (GA-APPLY-4)", async () => {
    const m = await home();
    m.state.hold = true;
    const p1 = keyed(m, "k-1", [ask("hall:lamp")]);
    const p2 = keyed(m, "k-1", [ask("hall:lamp")]);
    await vi.waitFor(() => expect(m.held).toHaveLength(1));
    expect(await Promise.race([p2.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 20))])).toBe("waiting");
    // A repeat after the apply was kept, its first PUBACK still out, waits too: it gets what the first gets.
    const p3 = keyed(m, "k-1", [ask("hall:lamp")]);
    expect(await Promise.race([p3.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 20))])).toBe("waiting");
    m.held.shift()!({ kind: "refused", code: 0x10 });
    const [r1, r2, r3] = [body(await p1), body(await p2), body(await p3)];
    expect(r1.outcomes[0].outcome).toBe("unreachable");
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(m.sent).toHaveLength(1);
  });

  it("frees a key whose apply was a request error, or whose store did not keep it within 10 s; nothing dispatched (GA-APPLY-4)", async () => {
    const m = await home();
    expect(await m.a.call(m.h, "apply", { idempotency_key: "k-1", plan_id: "p" })).toMatchObject({ ok: false, error: "unknown_plan" });
    expect(body(await keyed(m, "k-1", [ask("hall:lamp")])).outcomes[0].outcome).toBe("dispatched");
    m.db.trouble.down = true;
    const pending = keyed(m, "k-2", [ask("hall:spot")]);
    await vi.waitFor(() => expect(m.store.down).toBe(true));
    m.clock.advance(GATE_MS);
    await expect(pending).rejects.toBeInstanceOf(StoreUnavailable);
    expect(m.sent.map((x) => x.device)).toEqual(["lamp"]);
    m.db.trouble.down = false;
    await vi.waitFor(() => { m.clock.advance(1000); expect(m.store.down).toBe(false); });
    expect(body(await keyed(m, "k-2", [ask("hall:lamp")])).outcomes[0].outcome).toBe("dispatched");
  });

  it.each([undefined, "uses-a-token-behind"] as const)(
    "sends nothing for a token whose use the store has not kept, the store down; mutation %s sends it (GA-TOKEN-4)", async (mutation) => {
      const m = await home({ mutation });
      await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
      const asked = ask("hall:lamp");
      m.db.trouble.down = true;
      const pending = m.apply([{ ...asked, token: m.token(asked) }]).catch((err: unknown) => err);
      await vi.waitFor(() => expect(m.store.down).toBe(true));
      m.clock.advance(GATE_MS);
      await pending;
      expect(m.sent.map((x) => x.device)).toEqual(mutation ? ["lamp"] : []);
    });

  it.each([undefined, "forgets-an-idempotency-key"] as const)(
    "keeps a key with its apply across a restart, and frees it 3600 s after its apply (GA-APPLY-4, GA-PERSIST-1), mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const first = body(await keyed(m, "k-1", [ask("hall:lamp")]));
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, mutation });
    const repeat = body(await keyed(again, "k-1", [ask("hall:lamp")]));
    expect(repeat.apply_id === first.apply_id).toBe(mutation === undefined);
    if (mutation) return;
    expect(await keyed(again, "k-1", [ask("hall:spot")])).toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect(again.sent).toHaveLength(0);
    again.clock.advance(HELD_MS);
    again.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(again.clock.now()).toISOString()));
    again.a.listening("hall");
    again.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(again.clock.now()).toISOString()));
    const fresh = body(await keyed(again, "k-1", [ask("hall:spot")]));
    expect(fresh.apply_id).not.toBe(first.apply_id);
    expect(again.sent.map((x) => x.device)).toEqual(["spot"]);
  });
});

describe("late acks", () => {
  const cause = (e: any, applyId: string) => (typeof e.cause === "object" && e.cause.apply === applyId ? "apply" : e.cause);

  it("reports a report matching a step that ended failed(no_ack), within 60 s, as one late_ack with the apply's cause, never external (GA-APPLY-11)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    const c = await m.cursor();
    m.clock.advance(LATE_ACK_MS - 1000);
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toMatchObject([{ apply_id: r.apply_id, step_id: "s1", target: "hall:lamp", key: "on", value: true,
      cause: { apply: r.apply_id, client: "h", for: { person: "demo" } } }]);
    expect((await m.events(c, "state")).map((e: any) => [e.key, e.value, cause(e, r.apply_id)])).toEqual([["on", true, "apply"]]);
    // The first final outcome stands; a second match is no late_ack.
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.report("lamp", { on: false });
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toHaveLength(1);
    expect((await m.events(c, "state")).map((e: any) => cause(e, r.apply_id))).toEqual(["apply", "external", "external"]);
  });

  it("reports a match after a step failed(no_ack) at its bridge's death as a late_ack too (GA-APPLY-11)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.send("hall-bridge", "lwt", { instanceId: "11111111-1111-4111-8111-111111111111" });
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    const c = await m.cursor();
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toMatchObject([{ apply_id: r.apply_id, key: "on", value: true }]);
  });

  it("takes a match after a bridge's failed ack, or 60 s after the failed(no_ack), as external (GA-APPLY-11)", async () => {
    const m = await home();
    const f = await m.apply([ask("hall:lamp")]);
    m.ack(m.sent[0]!, "failed", { reason: "rejected" });
    expect((await m.outcomes(f.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "rejected" });
    const c = await m.cursor();
    m.report("lamp", { on: true });
    expect((await m.events(c, "state")).map((e: any) => cause(e, f.apply_id))).toEqual(["external"]);
    m.report("lamp", { on: false });
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.clock.advance(LATE_ACK_MS);
    const c2 = await m.cursor();
    m.report("lamp", { on: true });
    expect((await m.events(c2, "state")).map((e: any) => cause(e, r.apply_id))).toEqual(["external"]);
    expect(await m.events(c, "late_ack")).toEqual([]);
  });

  it("closes a late window on a bridge's failed ack that comes after the failed(no_ack): a later match is external (GA-APPLY-11)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.clock.advance(400);
    m.ack(m.sent[0]!, "failed", { reason: "rejected" });
    const c = await m.cursor();
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toEqual([]);
    expect((await m.events(c, "state")).map((e: any) => cause(e, r.apply_id))).toEqual(["external"]);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("keeps a late window across a restart (GA-APPLY-11, GA-PERSIST-1)", async () => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false });
    const c = await again.cursor();
    again.report("lamp", { on: true });
    expect(await again.events(c, "late_ack")).toMatchObject([{ apply_id: r.apply_id, key: "on", value: true }]);
  });
});

describe("reissue after the bound", () => {
  /** Lets each PUBACK the fake bus answers land. */
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it("reissues an idempotent step 500 ms after its failed(no_ack), and again after each reissue's bound, under fresh command ids, three attempts in all; its outcome stays (GA-APPLY-6)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS - 1);
    expect(m.sent).toHaveLength(1);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.clock.advance(1);
    await settle();
    expect(m.sent).toHaveLength(2);
    // Inside the reissue's own bound, nothing more.
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS - 1);
    expect(m.sent).toHaveLength(2);
    m.clock.advance(1);
    await settle();
    m.clock.advance(LATE_ACK_MS);
    await settle();
    expect(m.sent).toHaveLength(MAX_ATTEMPTS);
    const ids = m.sent.map((x) => x.body.commandId);
    expect(new Set(ids).size).toBe(3);
    expect(m.sent.map((x) => [x.device, x.body.value])).toEqual(Array(3).fill(["lamp", { action: "onoff.turn_on" }]));
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("takes a reissue's match as the step's late_ack, and reissues no more; an ack for a reissue changes nothing (GA-APPLY-6, GA-APPLY-11)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent).toHaveLength(2);
    const c = await m.cursor();
    m.ack(m.sent[1]!, "failed", { reason: "rejected" });
    m.ack(m.sent[1]!, "applied");
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toMatchObject([{ apply_id: r.apply_id, value: true }]);
    m.clock.advance(LATE_ACK_MS);
    await settle();
    expect(m.sent).toHaveLength(2);
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
  });

  it("fits every reissue's bound inside the step's 60 s late window", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "ack_within_s", value: { device: "hall:lamp", action: "onoff.turn_on", ack_within_s: 30 } }]);
    await m.apply([ask("hall:lamp")]);
    // Its bridge's status every 5 s, so it stays alive through the bound.
    for (let t = 0; t < 30_000 + ACK_GRACE_MS + REISSUE_GAP_MS + LATE_ACK_MS; t += 100) {
      if (t % 5000 === 0) m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
      m.clock.advance(100);
      if (t % 5000 === 0) await settle();
    }
    // The second reissue's bound would end past the window.
    expect(m.sent).toHaveLength(2);
  });

  it("never reissues a non-idempotent action, or one whose step used a token (GA-APPLY-6, GA-TOKEN-4)", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:spot", action: "onoff.turn_on", tier: "confirm" } }]);
    const spot = ask("hall:spot");
    await m.apply([ask("hall:relay"), { ...spot, token: m.token(spot) }]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent.map((x) => x.device)).toEqual(["relay", "spot"]);
  });

  it("never reissues a step whose device reported a value moving away from it, while it waited or after (applier, *Reissue*)", async () => {
    for (const when of ["waiting", "late"]) {
      const m = await home();
      m.report("lamp", { level: 50 });
      const r = await m.apply([ask("hall:lamp", "level.set_level", { level: 80 })]);
      if (when === "waiting") m.report("lamp", { level: 20 });
      m.clock.advance(10_000 + ACK_GRACE_MS);
      expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
      if (when === "late") m.report("lamp", { level: 20 });
      m.clock.advance(REISSUE_GAP_MS);
      await settle();
      expect(m.sent).toHaveLength(1);
    }
  });

  it("never reissues a step whose device is dead, nor one the gate now refuses (GA-APPLY-6)", async () => {
    const m = await home();
    await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    m.send("hall-bridge", "lwt", { instanceId: "11111111-1111-4111-8111-111111111111" });
    m.clock.advance(REISSUE_GAP_MS);
    await settle();
    expect(m.sent).toHaveLength(1);
    const n = await home();
    await n.apply([ask("hall:lamp")]);
    n.clock.advance(10_000 + ACK_GRACE_MS);
    await n.configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]);
    n.clock.advance(REISSUE_GAP_MS);
    await settle();
    expect(n.sent).toHaveLength(1);
  });

  it("stops a pending reissue once a later action on the same key is dispatched, its late window kept (GA-APPLY-6)", async () => {
    const m = await home();
    const on = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS);
    expect((await m.outcomes(on.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.clock.advance(100);
    await m.apply([ask("hall:lamp", "onoff.turn_off")]);
    m.clock.advance(REISSUE_GAP_MS);
    await settle();
    // Up to the turn_off's own bound: the turn_on's second reissue would have gone by now.
    m.clock.advance(10_000);
    await settle();
    expect(m.sent.map((x) => x.body.value.action)).toEqual(["onoff.turn_on", "onoff.turn_off"]);
  });

  it("never reissues inside the first command's bound, though its bridge died and came back within it (GA-BUS-4, GA-APPLY-6)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(1000);
    m.send("hall-bridge", "lwt", { instanceId: "11111111-1111-4111-8111-111111111111" });
    expect((await m.outcomes(r.apply_id))[0]).toMatchObject({ outcome: "failed", reason: "no_ack" });
    m.clock.advance(100);
    m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
    for (let t = 1100; t < 10_000 + ACK_GRACE_MS + REISSUE_GAP_MS - 1; t += 1000) {
      m.clock.advance(Math.min(1000, 10_000 + ACK_GRACE_MS + REISSUE_GAP_MS - 1 - t));
      m.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(m.clock.now()).toISOString()));
      await settle();
    }
    expect(m.sent).toHaveLength(1);
    m.clock.advance(1);
    await settle();
    expect(m.sent).toHaveLength(2);
  });

  it("gives a reissue's report moving towards the action its apply's cause (applier, *Causes*)", async () => {
    const m = await home();
    m.report("lamp", { on: false, level: 0 });
    const r = await m.apply([ask("hall:lamp", "level.set_level", { level: 40 })]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent).toHaveLength(2);
    const c = await m.cursor();
    m.report("lamp", { on: false, level: 20 });
    expect((await m.events(c, "state")).map((e: any) => [e.key, e.cause?.apply === r.apply_id ? "apply" : e.cause]))
      .toEqual([["level", "apply"]]);
  });

  it("keeps a late window open after the first command's failed ack once a reissue went out (GA-APPLY-11)", async () => {
    const m = await home();
    const r = await m.apply([ask("hall:lamp")]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent).toHaveLength(2);
    // Every attempt sent: none is pending, and the window still stays.
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent).toHaveLength(MAX_ATTEMPTS);
    m.ack(m.sent[0]!, "failed", { reason: "rejected" });
    const c = await m.cursor();
    m.report("lamp", { on: true });
    expect(await m.events(c, "late_ack")).toMatchObject([{ apply_id: r.apply_id, value: true }]);
  });

  it("reissues only an action whose effective declaration is idempotent, on a closed device (GA-APPLY-6)", () => {
    expect(reissuable({ idempotent: true, feedback: "closed" })).toBe(true);
    expect(reissuable({ idempotent: false, feedback: "closed" })).toBe(false);
    expect(reissuable({ idempotent: true, feedback: "open" })).toBe(false);
  });

  it("never reissues an extension action, which is not idempotent whatever its bridge declares (GA-DESC-4, GA-APPLY-6)", async () => {
    const m = await home();
    expect(m.a.home.target("hall:pusher", `${PUSH}.set_mode`)).toMatchObject({ idempotent: false, feedback: "closed" });
    expect(m.a.home.target("hall:pusher", "onoff.turn_on")).toMatchObject({ idempotent: true });
    // Lowered to reversible by the owner, it goes with no token: only its idempotency keeps it from a reissue.
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:pusher", action: `${PUSH}.set_mode`, tier: "reversible" } }]);
    const r = await m.apply([ask("hall:pusher", `${PUSH}.set_mode`, { mode: "click" })]);
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("dispatched");
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    m.clock.advance(LATE_ACK_MS);
    await settle();
    expect(m.sent.map((x) => x.device)).toEqual(["pusher"]);
  });

  it("reissues a non-idempotent action, its token too, under reissues-on-timeout", async () => {
    const m = await home({ mutation: "reissues-on-timeout" });
    const asked = ask("hall:relay");
    await m.apply([{ ...asked, token: m.token(asked) }]);
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    expect(m.sent.map((x) => x.device)).toEqual(["relay", "relay"]);
  });
});

describe("an open device's assumed state and whole-state commands", () => {
  const mode = (m: string) => ask("hall:ac", "climate.set_mode", { mode: m });
  const setpoint = (c: number) => ask("hall:ac", "climate.set_setpoint", { celsius: c });
  const assumed = async (m: Awaited<ReturnType<typeof home>>) => Object.fromEntries(
    (body(await m.a.call(m.h, "state", { targets: ["hall:ac"] })).targets["hall:ac"].values as any[]).map((v) => {
      expect(v).toMatchObject({ assumed: true, basis_time: expect.any(String) });
      return [v.key, v.value];
    }));
  /** The `state` the last command to the air conditioner carried. */
  const frame = (m: Awaited<ReturnType<typeof home>>) => m.sent.filter((x) => x.device === "ac").at(-1)!.body.value.state;

  it("assumes the value an action asks for once it ends sent or unanswered, never unreachable or failed, marked assumed (GA-STATE-4)", async () => {
    for (const mutation of [undefined, "assumes-a-failed-write", "forgets-the-unanswered"] as const) {
      const m = await home({ mutation });
      await m.apply([mode("cool")]);
      m.ack(m.sent.at(-1)!, "sent");
      expect(await assumed(m)).toEqual({ mode: "cool" });
      await m.apply([mode("heat")]);
      m.ack(m.sent.at(-1)!, "failed", { reason: "unreachable" });
      await m.apply([mode("fan")]);
      m.ack(m.sent.at(-1)!, "failed", { reason: "rejected" });
      expect((await assumed(m)).mode).toBe(mutation === "assumes-a-failed-write" ? "fan" : "cool");
      const r = await m.apply([setpoint(22)]);
      m.clock.advance(10_000 + ACK_GRACE_MS);
      expect((await m.outcomes(r.apply_id))[0].outcome).toBe("unanswered");
      expect((await assumed(m)).setpoint).toBe(mutation === "forgets-the-unanswered" ? undefined : 22);
    }
  });

  it("puts in a whole-state command the assumed state, the latest earlier action in flight from any apply, and its own value; nothing waits (GA-APPLY-16)", async () => {
    for (const mutation of [undefined, "sends-the-old-mode"] as const) {
      const m = await home({ mutation });
      await m.apply([mode("off")]);
      m.ack(m.sent.at(-1)!, "sent");
      await m.apply([mode("cool")]);
      expect(frame(m)).toEqual({ mode: "cool" });
      await m.apply([setpoint(22)]);
      expect(frame(m)).toEqual({ mode: mutation ? "off" : "cool", setpoint: 22 });
      await m.apply([mode("heat"), setpoint(23)]);
      expect(frame(m)).toEqual({ mode: mutation ? "off" : "heat", setpoint: 23 });
      expect(m.sent.filter((x) => x.device === "ac").map((x) => x.body.value.value)).toEqual(["off", "cool", 22, "heat", 23]);
    }
  });

  it("follows the order commands were dispatched in, not the order they ended in (GA-APPLY-16, GA-STATE-4)", async () => {
    // An earlier mode still in flight never overlays a later one already assumed, nor, ending later, replaces it.
    const m = await home();
    await m.apply([mode("cool")]);
    const cool = m.sent.at(-1)!;
    await m.apply([mode("heat")]);
    m.ack(m.sent.at(-1)!, "sent");
    await m.apply([setpoint(22)]);
    expect(frame(m)).toEqual({ mode: "heat", setpoint: 22 });
    m.ack(cool, "sent");
    expect((await assumed(m)).mode).toBe("heat");
    await m.apply([setpoint(23)]);
    expect(frame(m)).toEqual({ mode: "heat", setpoint: 23 });

    // A frame that ends after a later one keeps none of the keys the later one set.
    const n = await home();
    await n.apply([setpoint(22)]);
    n.ack(n.sent.at(-1)!, "sent");
    await n.apply([mode("heat")]);
    const heat = n.sent.at(-1)!;
    expect(frame(n)).toEqual({ mode: "heat", setpoint: 22 });
    await n.apply([setpoint(23)]);
    n.ack(n.sent.at(-1)!, "sent");
    n.ack(heat, "sent");
    expect(await assumed(n)).toEqual({ mode: "heat", setpoint: 23 });
    await n.apply([mode("cool")]);
    expect(frame(n)).toEqual({ mode: "cool", setpoint: 23 });
  });

  it("leaves out an action that ended failed or unreachable, unless keeps-a-failed-mode (GA-APPLY-16)", async () => {
    for (const mutation of [undefined, "keeps-a-failed-mode"] as const) {
      const m = await home({ mutation });
      await m.apply([mode("off")]);
      m.ack(m.sent.at(-1)!, "sent");
      await m.apply([mode("cool")]);
      m.ack(m.sent.at(-1)!, "failed", { reason: "unreachable" });
      await m.apply([setpoint(22)]);
      expect(frame(m)).toEqual({ mode: mutation ? "cool" : "off", setpoint: 22 });
      expect((await assumed(m)).mode).toBe("off");
    }
  });

  it("assumes every key a frame that ended sent carried, so a mode it carried outlives its own failed step, unless forgets-what-the-frame-said (GA-APPLY-16, GA-STATE-4)", async () => {
    for (const mutation of [undefined, "forgets-what-the-frame-said"] as const) {
      const m = await home({ mutation });
      await m.apply([mode("off")]);
      m.ack(m.sent.at(-1)!, "sent");
      await m.apply([mode("fan")]);
      const fan = m.sent.at(-1)!;
      await m.apply([setpoint(24)]);
      expect(frame(m)).toEqual({ mode: "fan", setpoint: 24 });
      m.ack(m.sent.at(-1)!, "sent");
      m.ack(fan, "failed", { reason: "rejected" });
      await m.apply([setpoint(25)]);
      expect(frame(m)).toEqual({ mode: mutation ? "off" : "fan", setpoint: 25 });
    }
  });

  it.each([undefined, "sends-a-bare-setpoint"] as const)(
    "keeps the assumed state and the actions in flight across a restart (GA-APPLY-16, GA-PERSIST-1), mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    await m.apply([mode("cool")]);
    m.ack(m.sent.at(-1)!, "sent");
    await m.apply([setpoint(22)]);
    m.ack(m.sent.at(-1)!, "sent");
    await m.apply([mode("heat")]);
    const heat = m.sent.at(-1)!;
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false, mutation });
    again.a.listening("hall");
    again.send("hall-bridge", "status", status("hall-bridge", devices.map((d) => d.id), new Date(again.clock.now()).toISOString()));
    expect(await assumed(again)).toEqual(mutation ? {} : { mode: "cool", setpoint: 22 });
    // Under the mutation the assumed state is not read back; what is in flight still is.
    if (mutation) return;
    await again.apply([setpoint(23)]);
    expect(frame(again)).toEqual({ mode: "heat", setpoint: 23 });
    again.ack(heat, "sent");
    expect(await assumed(again)).toEqual({ mode: "heat", setpoint: 22 });
  });
});

describe("declarations that change (GA-DESC-18)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 10));
  /** The bridge re-publishes `devices` with `device`'s entry changed by `edit`. */
  const redescribe = (m: Awaited<ReturnType<typeof home>>, device: string, edit: (d: any) => any) =>
    m.send("hall-bridge", "devices", { devices: devices.map((d) => d.id === device ? edit(structuredClone(d)) : d) }, true);
  const turnOnOnce = (d: any) => ({ ...d, actions: d.actions.map((a: any) => a.action === "onoff.turn_on" ? { ...a, idempotent: false } : a) });

  it("takes a devices document that changes a known device's declarations as a model change: the revision moves, a model event names it, and a plan made before is stale_revision", async () => {
    const m = await home();
    const plan = body(await m.a.call(m.h, "plan", { actions: [ask("hall:pusher")] }));
    const c = await m.cursor();
    redescribe(m, "pusher", turnOnOnce);
    expect(await m.events(c, "model")).toMatchObject([{ revision: plan.revision + 1, device: "hall:pusher" }]);
    const r = await m.a.call(m.h, "apply", { idempotency_key: "k", plan_id: plan.plan_id });
    expect(r).toMatchObject({ ok: false, error: "stale_revision" });
    expect(m.sent).toEqual([]);
  });

  it("keeps the revision and applies the stale plan under plans-on-a-stale-declaration", async () => {
    const m = await home({ mutation: "plans-on-a-stale-declaration" });
    const plan = body(await m.a.call(m.h, "plan", { actions: [ask("hall:pusher")] }));
    redescribe(m, "pusher", turnOnOnce);
    expect(body(await m.a.call(m.h, "apply", { idempotency_key: "k", plan_id: plan.plan_id })).outcomes[0].outcome).toBe("dispatched");
  });

  it("refuses an undispatched step whose action's declarations changed as declaration_changed, at dispatch; a step of an unchanged action goes (GA-APPLY-9)", async () => {
    for (const [mutation, want] of [[undefined, { outcome: "refused", reason: "declaration_changed" }],
      ["dispatches-a-changed-step", { outcome: "dispatched" }]] as const) {
      const m = await home({ mutation });
      m.state.hold = true;
      const p = m.apply([ask("hall:spot"), ask("hall:pusher"), ask("hall:lamp")]);
      await new Promise((r) => setTimeout(r, 20));
      redescribe(m, "pusher", turnOnOnce);
      m.state.hold = false;
      m.held.shift()!({ kind: "ok" });
      const r = await p;
      expect(r.outcomes[1]).toMatchObject(want);
      expect(r.outcomes.map((o: any) => o.outcome)).toEqual(["dispatched", want.outcome, "dispatched"]);
    }
  });

  it("judges declaration_changed before already, unsupported_action and the token: only not_adopted, safety, latched and dead outrank it (GA-DESC-18, GA-APPLY-9)", async () => {
    const setMode = ask("hall:pusher", `${PUSH}.set_mode`, { mode: "click" });
    const changeMode = (d: any) => ({ ...d, extensions: [{ ...d.extensions[0], actions: [{ ...d.extensions[0].actions[0],
      schema: { type: "object", properties: { mode: { enum: ["click", "switch", "hold"] } } } }] }] });
    /** Holds the lamp's PUBACK, applies `asked` after it, runs `meanwhile`, then lets the lamp's go. */
    const after = async (m: Awaited<ReturnType<typeof home>>, asked: ReturnType<typeof ask>, meanwhile: () => void) => {
      m.state.hold = true;
      const p = m.apply([ask("hall:lamp"), asked]);
      await new Promise((r) => setTimeout(r, 20));
      meanwhile();
      m.state.hold = false;
      m.held.shift()!({ kind: "ok" });
      return (await p).outcomes[1];
    };
    const cases: [string, (m: Awaited<ReturnType<typeof home>>) => Promise<unknown>, unknown][] = [
      // The pusher already on, where turn_on now means something else: never a success judged on declarations the plan never saw.
      ["already", async (m) => { m.report("pusher", { on: true }); return after(m, ask("hall:pusher"), () => redescribe(m, "pusher", turnOnOnce)); },
        { outcome: "refused", reason: "declaration_changed" }],
      ["unsupported_action", async (m) => after(m, ask("hall:pusher"), () => redescribe(m, "pusher", (d) => ({ ...d,
        actions: d.actions.filter((a: any) => a.action !== "onoff.turn_on") }))), { outcome: "refused", reason: "declaration_changed" }],
      // A lowered extension tier falls back with the change; the step needs a token now, and the cause is the change.
      ["token", async (m) => {
        await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:pusher", action: `${PUSH}.set_mode`, tier: "reversible" } }]);
        return after(m, setMode, () => redescribe(m, "pusher", changeMode));
      }, { outcome: "refused", reason: "declaration_changed" }],
      // An inline request's dead target is skipped(dead), as its plan says (GA-APPLY-5).
      ["dead", async (m) => after(m, ask("hall:pusher"), () => { redescribe(m, "pusher", turnOnOnce); m.report("pusher", { available: false }); }),
        { outcome: "skipped", reason: "dead" }],
    ];
    for (const [, run, want] of cases) {
      const m = await home();
      expect(await run(m)).toMatchObject(want as object);
      expect(m.sent.map((x) => x.device)).toEqual(["lamp"]);
    }
  });

  it("keeps a dispatched action's outcome rules: its confirmed_by as it was dispatched acks it", async () => {
    const m = await home();
    await m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:pusher", action: `${PUSH}.set_mode`, tier: "reversible" } }]);
    const r = await m.apply([ask("hall:pusher", `${PUSH}.set_mode`, { mode: "click" })]);
    redescribe(m, "pusher", (d) => ({ ...d,
      actions: d.actions.map((a: any) => a.confirmedBy ? { ...a, confirmedBy: { key: `${PUSH}.style`, value: { arg: "mode" } } } : a),
      extensions: [{ ...d.extensions[0], keys: [...d.extensions[0].keys, { key: `${PUSH}.style`, schema: { type: "string" } }] }] }));
    m.report("pusher", { [`${PUSH}.mode`]: "click" });
    expect((await m.outcomes(r.apply_id))[0].outcome).toBe("acked");
  });

  it("re-sends a dispatched action only where both its old and its new declaration say idempotent (GA-APPLY-6)", async () => {
    const m = await home();
    redescribe(m, "lamp", turnOnOnce);
    await m.apply([ask("hall:lamp")]);
    redescribe(m, "lamp", (d) => d);
    expect(m.a.home.target("hall:lamp", "onoff.turn_on")).toMatchObject({ idempotent: true });
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    m.clock.advance(LATE_ACK_MS);
    await settle();
    expect(m.sent.map((x) => x.device)).toEqual(["lamp"]);
  });

  it("re-sends a dispatched action only on the declarations it was dispatched on: a changed reach changes its bound, so it goes no more (GA-DESC-18)", async () => {
    const m = await home();
    await m.apply([ask("hall:lamp")]);
    redescribe(m, "lamp", (d) => ({ ...d, reachMs: 2000 }));
    expect(m.a.home.target("hall:lamp", "onoff.turn_on")).toMatchObject({ idempotent: true });
    m.clock.advance(10_000 + ACK_GRACE_MS + REISSUE_GAP_MS);
    await settle();
    m.clock.advance(LATE_ACK_MS);
    await settle();
    expect(m.sent.map((x) => x.device)).toEqual(["lamp"]);
  });

  it("lets a tier the owner lowered on an extension action fall back to the table when its declarations change, and stay so, the declaration's return and a restart included, until the owner sets it again", async () => {
    const db = lasting(await memoryDb());
    const m = await home({ db });
    const tierOf = async (x = m) => ((body(await x.a.call(x.owner, "describe", {})).devices as any[]).find((d) => d.id === "hall:pusher").actions as any[])
      .find((a) => a.action === `${PUSH}.set_mode`).tier;
    const lower = () => m.configure([{ op: "upsert", kind: "tier", value: { device: "hall:pusher", action: `${PUSH}.set_mode`, tier: "reversible" } }]);
    await lower();
    expect(await tierOf()).toBe("reversible");
    redescribe(m, "pusher", (d) => ({ ...d, extensions: [{ ...d.extensions[0], actions: [{ ...d.extensions[0].actions[0],
      schema: { type: "object", properties: { mode: { enum: ["click", "switch", "hold"] } } } }] }] }));
    expect(await tierOf()).toBe("confirm");
    // The bridge returns to the declaration the owner judged: the tier stays fallen back (GA-DESC-11's dropped tier).
    redescribe(m, "pusher", (d) => d);
    expect(await tierOf()).toBe("confirm");
    await settle();
    m.a.stop();
    await m.store.close();
    const again = await home({ db, fresh: false });
    expect(await tierOf(again)).toBe("confirm");
    await again.configure([{ op: "upsert", kind: "tier", value: { device: "hall:pusher", action: `${PUSH}.set_mode`, tier: "reversible" } }]);
    expect(await tierOf(again)).toBe("reversible");
  });
});
