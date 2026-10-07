import { describe, expect, it, vi } from "vitest";
import { LeaseTable } from "../src/leases/table.js";
import { MUTATIONS } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";
import { SECRETS } from "./house.js";
import { describeOf, DEVICES, eventsSince, LAMP, on, setup } from "./setup.js";

type Body = Record<string, any>;
const HOLD_MS = 7_200_000;
const CHANNEL = "sim-bridge:channel";
const LAPTOP = "pc-bridge:laptop";
/** A computer whose `session.lock` takes no lease (GA-LEASE-1). */
const LAPTOP_DEVICE = { id: LAPTOP, label: "laptop", class: "computer", capabilities: ["session"], adopted: true,
  actions: [{ action: "session.lock", tier: "reversible", stateless: false }] };
let keys = 0;
const key = () => `lease-key-${++keys}`;
const inline = (ok: (s: string, t: string, a?: Body) => Promise<Body>, secret: string, endpoint: string, actions: Body[]) =>
  ok(secret, "apply", { request: { endpoint, actions }, idempotency_key: key() });
const leasesOf = async (ok: (s: string, t: string, a?: Body) => Promise<Body>) => (await ok(SECRETS.owner, "state")).leases as Body;
const leaseEvents = async (ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string) =>
  (await eventsSince(ok, cursor, "lease")).map((e) => `${e.change} ${e.target} ${typeof e.holder === "string" ? e.holder : e.holder.endpoint}`);

describe("leases", () => {
  it("declares ignores-leases", () => {
    expect(MUTATIONS).toContain("ignores-leases");
  });

  it("leases each device a person's apply dispatched a stateful action to, from dispatch for the hold time, then ends it (GA-LEASE-1)", async () => {
    const { ok, clock, steward } = await setup();
    const { cursor } = await ok(SECRETS.owner, "events");
    const at = clock.now();
    await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    expect(await leasesOf(ok)).toEqual({ [LAMP]: { holder: { person: "olga", endpoint: "olga-app" }, precedence: "person",
      expires: new Date(at + HOLD_MS).toISOString() } });
    expect(await leaseEvents(ok, cursor)).toEqual([`granted ${LAMP} olga-app`]);
    clock.advance(HOLD_MS - 1);
    expect(Object.keys(await leasesOf(ok))).toEqual([LAMP]);
    const late = (await ok(SECRETS.owner, "events")).cursor;
    clock.advance(1);
    expect(await leasesOf(ok)).toEqual({});
    expect(await leaseEvents(ok, late)).toEqual([`ended ${LAMP} olga-app`]);
    steward.stop();
  });

  it("takes none for a stateless action, a session.lock, or a step that sent nothing (GA-LEASE-1)", async () => {
    const { ok, steward, applier } = await setup();
    steward.onDescribe(describeOf([...DEVICES, LAPTOP_DEVICE], 2));
    await inline(ok, SECRETS.owner, "owner-app", [{ target: CHANNEL, action: "notify.notify", args: { text: "x", urgency: "info" } },
      { target: LAPTOP, action: "session.lock", args: { account: "liza" } }]);
    applier.planner = (a) => (a.target === LAMP ? { verdict: "skip", reason: "dead" } : {});
    const r = await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    expect(r.outcomes.map((o: Body) => `${o.target} ${o.outcome}(${o.reason})`)).toEqual([`${LAMP} skipped(dead)`]);
    expect(await leasesOf(ok)).toEqual({});
  });

  it("ends a step's lease when the step later ends unreachable, and only that apply's (GA-LEASE-1)", async () => {
    const { ok, applier, pump } = await setup();
    await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    await pump();
    expect(Object.keys(await leasesOf(ok))).toEqual([LAMP]);
    applier.emit({ type: "outcome", apply_id: "applier-apply-1", step_id: "s1", target: LAMP, outcome: "unreachable" });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
  });

  it("lifts an apply's provisional lease when its step sent nothing, the device's lease standing; keeps it when the answer was lost", async () => {
    const { ok, steward } = await setup({ reach: false });
    const r = await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    expect(r.outcomes.map((o: Body) => o.outcome)).toEqual(["unreachable"]);
    expect((steward as any).leases.holding(LAMP)).toBeUndefined();
    const b = await setup();
    b.applier.loseAnswers = 1000;
    const lost = b.call(SECRETS.olga, "apply", { request: { endpoint: "olga-app", actions: [on(LAMP)] }, idempotency_key: "lost" });
    lost.catch(() => undefined);
    // While the answer is awaited, the provisional lease sits on the lamp.
    await vi.waitFor(() => { expect(b.applier.applies.length).toBeGreaterThan(0); });
    expect((b.steward as any).leases.holding(LAMP)).toMatchObject({ precedence: "person", holder: { person: "olga", endpoint: "olga-app" } });
    expect(await leasesOf(b.ok)).toEqual({});
    let over = false;
    lost.then(() => undefined, () => { over = true; });
    await vi.waitFor(() => { b.clock.advance(500); expect(over).toBe(true); });
    await expect(lost).rejects.toEqual(expect.objectContaining({ pending: true }));
    expect(Object.keys(await leasesOf(b.ok))).toEqual([LAMP]);
  });

  it("gives an outside change, or a load cap's, a person-precedence lease for the hold time; a device's own change and the steward's own apply's take none (GA-LEASE-2)", async () => {
    const { ok, applier, pump } = await setup();
    applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "device" });
    applier.emit({ type: "state", target: LAMP, key: "on", value: false, cause: { apply: "elsewhere", client: "steward", for: { endpoint: "olga-app" } } });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
    applier.emit({ type: "state", target: LAMP, key: "on", value: true, cause: "external" });
    applier.emit({ type: "state", target: "sim-bridge:dimmer", key: "on", value: false, cause: "load_cap" });
    await pump();
    const leases = await leasesOf(ok);
    expect(Object.fromEntries(Object.entries(leases).map(([t, l]) => [t, `${(l as Body).holder} ${(l as Body).precedence}`])))
      .toEqual({ [LAMP]: "external person", "sim-bridge:dimmer": "load_cap person" });
  });

  it("lets an equal precedence replace a lease, saying so, and gives the outside change's lease no hold over a person's apply (GA-LEASE-3)", async () => {
    const { ok, applier, pump } = await setup();
    const { cursor } = await ok(SECRETS.owner, "events");
    await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    applier.emit({ type: "state", target: LAMP, key: "on", value: false, cause: "external" });
    await pump();
    const r = await inline(ok, SECRETS.panel, "hall-panel", [on(LAMP)]);
    expect(r.outcomes.map((o: Body) => o.outcome)).toEqual(["dispatched"]);
    expect(await leaseEvents(ok, cursor)).toEqual([`granted ${LAMP} olga-app`, `replaced ${LAMP} external`, `replaced ${LAMP} hall-panel`]);
  });

  it("changes no lease when planning (GA-STW-1)", async () => {
    const { ok } = await setup();
    await ok(SECRETS.olga, "plan", { endpoint: "olga-app", actions: [on(LAMP)] });
    expect(await leasesOf(ok)).toEqual({});
  });

  it("keeps its leases across a restart, and ends at start one whose time passed while it was down (GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const a = await setup({ db, clock });
    await inline(a.ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    clock.advance(1000);
    await inline(a.ok, SECRETS.olga, "olga-app", [on("sim-bridge:dimmer", "level.set_level", { level: 5 })]);
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, define: false });
    expect(Object.keys(await leasesOf(b.ok))).toEqual(["sim-bridge:dimmer", LAMP]);
    b.steward.stop();
    await b.store.close();
    clock.advance(HOLD_MS - 500);
    const c = await setup({ db, clock, define: false });
    expect(Object.keys(await leasesOf(c.ok))).toEqual(["sim-bridge:dimmer"]);
    clock.advance(1000);
    expect(await leasesOf(c.ok)).toEqual({});
    await c.store.settled();
    expect((await c.store.query("SELECT target FROM leases")).rows).toEqual([]);
  });

  it("takes no lease at all under ignores-leases", async () => {
    const { ok, applier, pump } = await setup({ mutation: "ignores-leases" });
    await inline(ok, SECRETS.olga, "olga-app", [on(LAMP)]);
    applier.emit({ type: "state", target: "sim-bridge:dimmer", key: "on", value: true, cause: "external" });
    await pump();
    expect(await leasesOf(ok)).toEqual({});
  });
});

describe("the lease table: a provisional lease lifted (the milestone review, B6)", () => {
  const table = (ended: string[]) => new LeaseTable({ clock: new FakeClock(), store: { write: async () => undefined } as never,
    event: () => undefined, ended: (t) => { ended.push(t); } });
  it("is no lease ending when it refused nothing: the re-evaluation hook is not told", () => {
    const ended: string[] = [];
    const t = table(ended);
    t.lay(LAMP, { apply: "a1", step: "s1", holder: { endpoint: "olga-app" }, precedence: "person" });
    t.settle(LAMP, "a1", "s1", undefined);
    expect(ended).toEqual([]);
    expect(t.holding(LAMP)).toBeUndefined();
  });

  it("re-evaluates what it held off when a change was refused by it", () => {
    const ended: string[] = [];
    const t = table(ended);
    t.lay(LAMP, { apply: "a1", step: "s1", holder: { endpoint: "olga-app" }, precedence: "person" });
    t.refused(LAMP);
    t.settle(LAMP, "a1", "s1", undefined);
    expect(ended).toEqual([LAMP]);
  });
});
