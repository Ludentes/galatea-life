import { describe, expect, it, vi } from "vitest";
import { Applier, type BusPort, type ToolResult } from "../src/applier.js";
import type { Puback } from "../src/bus/client.js";
import { StoreUnavailable } from "../src/core/errors.js";
import { GATE_MS, Store } from "../src/core/store.js";
import type { Mutation } from "../src/mutations.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const OWNER = "owner-credential";
const T = "2030-01-01T08:00:00.000Z";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

/** An applier whose bus records each request `[bridge, op, body]` and answers it `t.puback`. */
async function make(opts: { mutation?: Mutation; db?: Awaited<ReturnType<typeof memoryDb>>; fresh?: boolean } = {}) {
  const clock = new FakeClock();
  // The harness's clock gives fractions of a millisecond: every time the store keeps must be whole.
  clock.advance(0.5);
  const db = opts.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const t = { sent: [] as [string, string, Record<string, any>][], puback: { kind: "ok" } as Puback };
  const bus: BusPort = { follow: () => undefined, snapshot: async () => ({ kind: "ok" }), command: async () => ({ kind: "ok" }),
    request: async (b, op, req) => { t.sent.push([b.id, op, req]); return t.puback; } };
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1", mutation: opts.mutation, bus });
  await a.start();
  const owner = a.caller(OWNER);
  const { revision } = body(await a.call(owner, "describe", {}));
  // A restart on the same database finds the bridge and the client already configured.
  if (opts.fresh !== false) body(await a.call(owner, "configure", { changes: [{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } },
    { op: "upsert", kind: "client", value: { id: "h", credential: "h-credential", kind: "steward" } }],
    expected_revision: revision, dry_run: false }));
  return Object.assign(t, { a, db, clock, owner, store, seq: 0 });
}
type T = Awaited<ReturnType<typeof make>>;

const send = (t: T, path: string, b: unknown, retained = false) =>
  t.a.home.message("hall-bridge", path, Buffer.from(JSON.stringify(b)), retained);

/** The bridge `hall`, live, with a lamp on its transport `radio`, claiming `levels`. */
function bridgeUp(t: T, { levels }: { levels: string[] }) {
  send(t, "devices", { devices: [{ id: "lamp", stableIdentifier: "test:lamp", transport: "radio", capabilities: ["onoff"],
    actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }], feedback: "closed",
    reachMs: 0, proposedClass: "light", classEvidence: "protocol" }] }, true);
  t.a.home.listening("hall");
  send(t, "status", { bridgeId: "hall-bridge", instanceId: "11111111-1111-4111-8111-111111111111", v: 1, state: "online",
    version: "1", levels, faults: [], ungoverned: [], blocked: [], transports: [{ id: "radio", kind: "zigbee", state: "up", since: T }],
    devices: [{ id: "lamp", transport: "radio", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, timestamp: T,
      lastCheckIn: T, observable: true, since: T }], publishedAt: new Date(t.clock.now()).toISOString() });
}

/** A bridge event, the next `seq` of the bridge's instance. */
const event = (t: T, b: Record<string, unknown>) => send(t, "event", { seq: ++t.seq, instanceId: "11111111-1111-4111-8111-111111111111", ...b });

/** The bridge's reply to the `i`th request it was sent. */
const replyTo = (t: T, i: number, status: string, extra: Record<string, unknown> = {}) =>
  send(t, "reply", { requestId: t.sent[i]![2].requestId, op: t.sent[i]![1], status, ...extra });

describe("provision", () => {
  it("is the owner's only, sends join to the transport's bridge in its own ids, and returns its reply", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const client = t.a.caller("h-credential");
    expect(await t.a.call(client, "provision", { join: { transport: "hall:radio", window_s: 60 } }))
      .toMatchObject({ ok: false, error: "not_permitted" });
    const p = t.a.call(t.owner, "provision", { join: { transport: "hall:radio", window_s: 60, near: "hall:lamp" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject(["hall", "join", { transport: "radio", windowMs: 60_000, near: "lamp", issuedAt: T }]);
    expect(t.sent[0]![2].requestId).toMatch(/^[0-9a-f-]{36}$/);
    replyTo(t, 0, "accepted");
    expect(body(await p)).toEqual({ request_id: t.sent[0]![2].requestId, op: "join", status: "accepted" });
    const r = t.a.call(t.owner, "provision", { remove: { device: "hall:lamp", block_rejoin: true, force: true } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    expect(t.sent[1]).toMatchObject(["hall", "remove", { device: "lamp", blockRejoin: true, force: true }]);
    replyTo(t, 1, "failed", { reason: "busy" });
    expect(body(await r)).toEqual({ request_id: t.sent[1]![2].requestId, op: "remove", status: "failed", reason: "busy" });
  });

  it("is not_claimed against a bridge without Provision, invalid_request for an unknown id, a near on another bridge, install and uninstall", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve"] });
    const err = async (args: unknown) => { const r = await t.a.call(t.owner, "provision", args); return r.ok ? "ok" : r.error; };
    expect(await err({ remove: { device: "hall:lamp", block_rejoin: false } })).toBe("not_claimed");
    expect(await err({ remove: { device: "hall:nothing", block_rejoin: false } })).toBe("invalid_request");
    expect(await err({ join: { transport: "hall:nothing", window_s: 60 } })).toBe("invalid_request");
    expect(await err({ unblock: { identifier: "test:old", bridge: "porch" } })).toBe("not_claimed");   // not registered
    expect(await err({ install: { host: "hall:lamp", package: { url: "https://x", sha256: "0".repeat(64) }, account: "a" } })).toBe("invalid_request");
    expect(await err({ uninstall: { host: "hall:lamp", plugin: "p" } })).toBe("invalid_request");
    expect(await err({ connect: { candidate: "c1", bridge: "hall" } })).toBe("invalid_request");
    expect(await err({ join: { transport: "hall:radio", window_s: 60 }, dry_run: true })).toBe("invalid_request");
    expect(await err({ join: { transport: "hall:radio", window_s: 60 }, unblock: { identifier: "x", bridge: "hall" } })).toBe("invalid_request");
    expect(await err({})).toBe("invalid_request");
    expect(t.sent).toEqual([]);
  });

  it("is unreachable with its request_id when no reply comes within 2 s, and at once when the broker has no subscriber", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const p = t.a.call(t.owner, "provision", { unblock: { identifier: "test:old", bridge: "hall" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject(["hall", "unblock", { identifier: "test:old" }]);
    t.clock.advance(1999);
    await Promise.resolve();
    t.clock.advance(1);
    expect(body(await p)).toEqual({ request_id: t.sent[0]![2].requestId, op: "unblock", status: "unreachable" });
    t.puback = { kind: "no_subscribers" };
    expect(body(await t.a.call(t.owner, "provision", { unblock: { identifier: "test:old", bridge: "hall" } })).status).toBe("unreachable");
  });

  it("takes a reply only from the bridge the request went to", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const { revision } = body(await t.a.call(t.owner, "describe", {}));
    body(await t.a.call(t.owner, "configure", { changes: [{ op: "upsert", kind: "bridge", value: { id: "porch", identity: "porch-bridge" } }],
      expected_revision: revision, dry_run: false }));
    const p = t.a.call(t.owner, "provision", { unblock: { identifier: "test:old", bridge: "hall" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    t.a.home.message("porch-bridge", "reply", Buffer.from(JSON.stringify({ requestId: t.sent[0]![2].requestId, op: "unblock", status: "ok" })), false);
    t.clock.advance(2000);
    expect(body(await p).status).toBe("unreachable");
  });

  it("answers a repeated key from its record, sends it once, whatever changed since; another body is a conflict (GA-PROV-3)", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { remove: { device: "hall:lamp", block_rejoin: false }, idempotency_key: "k1" };
    const p = t.a.call(t.owner, "provision", args);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    const again = t.a.call(t.owner, "provision", args);     // waits for the first's answer
    replyTo(t, 0, "accepted");
    const first = body(await p);
    expect(body(await again)).toEqual(first);
    bridgeUp(t, { levels: ["Serve"] });                       // the bridge no longer claims Provision
    expect(body(await t.a.call(t.owner, "provision", args))).toEqual(first);
    expect(await t.a.call(t.owner, "provision", { ...args, remove: { device: "hall:lamp", block_rejoin: true } }))
      .toMatchObject({ ok: false, error: "idempotency_conflict" });
    expect(t.sent).toHaveLength(1);
    // A key whose checks refused it is free again.
    expect(await t.a.call(t.owner, "provision", { unblock: { identifier: "x", bridge: "hall" }, idempotency_key: "k9" }))
      .toMatchObject({ ok: false, error: "not_claimed" });
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const q = t.a.call(t.owner, "provision", { join_close: { transport: "hall:radio" }, idempotency_key: "k9" });
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    replyTo(t, 1, "ok");
    expect(body(await q).status).toBe("ok");
  });

  it.each([undefined, "provisions-twice"] as const)("keeps an unreachable record under its key, mutation %s", async (mutation) => {
    const t = await make({ mutation });
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { remove: { device: "hall:lamp", block_rejoin: false }, idempotency_key: "k2" };
    const p = t.a.call(t.owner, "provision", args);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    t.clock.advance(2000);
    const first = body(await p);
    expect(first.status).toBe("unreachable");
    t.clock.advance(11_000);
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const second = t.a.call(t.owner, "provision", args);
    if (mutation) {
      await vi.waitFor(() => expect(t.sent).toHaveLength(2));
      t.clock.advance(2000);
      expect(body(await second).request_id).not.toBe(first.request_id);
    } else {
      expect(body(await second)).toEqual(first);
      expect(t.sent).toHaveLength(1);
    }
  });

  it("lets a client provision under the mutation provisions-for-anyone", async () => {
    const t = await make({ mutation: "provisions-for-anyone" });
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const p = t.a.call(t.a.caller("h-credential"), "provision", { join_close: { transport: "hall:radio" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    replyTo(t, 0, "ok");
    expect(body(await p).status).toBe("ok");
    expect(await t.a.call(t.a.caller("h-credential"), "configure", { changes: [], expected_revision: 0, dry_run: false }))
      .toMatchObject({ ok: false, error: "not_permitted" });
  });

  it("records every request, keyed or not, with its result as it ends, on a clock that gives fractions of a millisecond", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    t.clock.advance(0.25);                                    // the harness's clock is not whole: the row must still commit
    const p = t.a.call(t.owner, "provision", { join: { transport: "hall:radio", window_s: 30 } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    replyTo(t, 0, "accepted", { data: { windowMs: 30_000 } });
    const r = body(await p);
    expect(r.data).toEqual({ windowMs: 30_000 });
    await vi.waitFor(async () => {
      const rows = (await t.db.query<Record<string, any>>("SELECT * FROM provisions")).rows;
      expect(rows).toMatchObject([{ request_id: r.request_id, op: "join", bridge: "hall", idempotency_key: null,
        result: { status: "accepted", data: { windowMs: 30_000 } }, }]);
      expect(Number(rows[0]!.created_ms)).toBe(Math.floor(t.clock.now()));
    });
  });

  it("commits the request before its publish; a caller past 10 s gets the internal error, and a row landing after it is never sent, its key answering unreachable (K1; the maintainer, preflight M2)", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    t.db.trouble.down = true;
    const args = { unblock: { identifier: "test:old", bridge: "hall" }, idempotency_key: "k3" };
    const p = t.a.call(t.owner, "provision", args);
    const failed = expect(p).rejects.toBeInstanceOf(StoreUnavailable);
    await new Promise((r) => setTimeout(r, 20));
    t.clock.advance(GATE_MS);
    await failed;
    expect(t.sent).toEqual([]);
    const again = t.a.call(t.owner, "provision", args);       // waits on the held claim
    t.db.trouble.down = false;
    t.clock.advance(5000);                                    // the writer's next try
    const r = body(await again);
    expect(r).toMatchObject({ op: "unblock", status: "unreachable" });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.sent).toEqual([]);
    const rows = (await t.db.query<{ request_id: string; result: { status: string } }>(
      "SELECT request_id, result FROM provisions WHERE idempotency_key = 'k3'")).rows;
    expect(rows).toMatchObject([{ request_id: r.request_id, result: { status: "unreachable" } }]);
  });

  // Preflight M2, the maintainer's ruling: never send late. An unkeyed join the owner gave up on half an hour
  // ago must not open a window now.
  it("never publishes a request whose row commits half an hour after its caller's internal error", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    t.db.trouble.down = true;
    const p = t.a.call(t.owner, "provision", { join: { transport: "hall:radio", window_s: 254 } });
    const failed = expect(p).rejects.toBeInstanceOf(StoreUnavailable);
    await new Promise((r) => setTimeout(r, 20));
    t.clock.advance(GATE_MS);
    await failed;
    for (let i = 0; i < 360; i++) t.clock.advance(5000);
    t.db.trouble.down = false;
    t.clock.advance(5000);
    await vi.waitFor(async () =>
      expect((await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM provisions")).rows[0]!.n).toBe(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(t.sent).toEqual([]);
  });

  // Preflight M1: a transport the model keeps after its bridge left the configuration.
  it("is not_claimed, never thrown, for a transport whose bridge is no longer registered, and frees the key", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const { revision } = body(await t.a.call(t.owner, "describe", {}));
    body(await t.a.call(t.owner, "configure", { changes: [{ op: "delete", kind: "bridge", value: { id: "hall" } }],
      expected_revision: revision, dry_run: false }));
    expect(await t.a.call(t.owner, "provision", { join_close: { transport: "hall:radio" } })).toMatchObject({ ok: false, error: "not_claimed" });
    expect(await t.a.call(t.owner, "provision", { remove: { device: "hall:lamp", block_rejoin: false }, idempotency_key: "u1" }))
      .toMatchObject({ ok: false, error: "not_claimed" });
    expect(await t.a.call(t.owner, "provision", { remove: { device: "hall:lamp", block_rejoin: true }, idempotency_key: "u1" }))
      .toMatchObject({ ok: false, error: "not_claimed" });   // the key was freed: another body is no conflict
    expect(t.sent).toEqual([]);
  });

  // Preflight I1: the owner is told a reply only once it is kept.
  it("answers a reply only once its record has committed", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    let settled = false;
    const p = t.a.call(t.owner, "provision", { unblock: { identifier: "test:old", bridge: "hall" } });
    void p.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    t.db.trouble.down = true;
    replyTo(t, 0, "ok");
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    t.db.trouble.down = false;
    t.clock.advance(1000);                                    // the writer's next try, inside the 10 s gate
    expect(body(await p).status).toBe("ok");
    expect((await t.db.query<{ result: { status: string } }>("SELECT result FROM provisions")).rows).toMatchObject([{ result: { status: "ok" } }]);
  });

  // Preflight M5: a reply is routed on its requestId; one naming another op is a fault, and no answer.
  it("takes a reply naming another op than its request's as a bridge_fault, and no answer", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const { cursor } = body(await t.a.call(t.owner, "events", {}));
    const p = t.a.call(t.owner, "provision", { unblock: { identifier: "test:old", bridge: "hall" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    send(t, "reply", { requestId: t.sent[0]![2].requestId, op: "join", status: "ok" });
    t.clock.advance(2000);
    expect(body(await p).status).toBe("unreachable");
    const evs = (body(await t.a.call(t.owner, "events", { cursor })).events as any[]).filter((e) => e.type === "bridge_fault");
    expect(evs).toMatchObject([{ bridge: "hall", what: expect.stringMatching(/names op "join"/) }]);
  });

  it.each([undefined, "hides-new-devices"] as const)(
    "relays joined and window_closed as provision events with causes, and raises a window_closed notice naming the joined, mutation %s", async (mutation) => {
      const t = await make({ mutation });
      bridgeUp(t, { levels: ["Serve", "Provision"] });
      const { cursor } = body(await t.a.call(t.owner, "events", {}));
      event(t, { type: "joined", device: "kettle" });
      event(t, { type: "interviewed", device: "kettle" });
      event(t, { type: "window_closed", transport: "radio", devices: ["kettle"], windowMs: 60_000 });
      const evs = (body(await t.a.call(t.owner, "events", { cursor })).events as any[]).filter((e) => e.type === "provision");
      expect(evs.map((e) => [e.what, e.cause])).toEqual([["joined", "device"], ["window_closed", "bridge"]]);
      expect(evs[0]).toMatchObject({ bridge: "hall", device: "hall:kettle" });
      expect(evs[1]).toMatchObject({ bridge: "hall", transport: "hall:radio", devices: ["hall:kettle"], window_s: 60 });
      const notices = (body(await t.a.call(t.owner, "events", {})).notices as any[]).filter((n) => n.cause === "window_closed");
      expect(notices.map((n) => n.devices)).toEqual(mutation ? [] : [["hall:kettle"]]);
    });

  it("raises a notice for a window in which nothing joined, and one per window (K4)", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    event(t, { type: "window_closed", transport: "radio", devices: [], windowMs: 30_000 });
    event(t, { type: "window_closed", transport: "radio", devices: [], windowMs: 30_000 });
    const notices = (body(await t.a.call(t.owner, "events", {})).notices as any[]).filter((n) => n.cause === "window_closed");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ devices: [], transport: "hall:radio", bridge: "hall" });
  });

  it("gives an event carrying a request it holds that request as its cause, and records accepted for one unreachable", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { remove: { device: "hall:lamp", block_rejoin: false }, idempotency_key: "k6" };
    const p = t.a.call(t.owner, "provision", args);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    t.clock.advance(2000);
    const first = body(await p);
    expect(first.status).toBe("unreachable");
    const { cursor } = body(await t.a.call(t.owner, "events", {}));
    event(t, { type: "left", device: "lamp", requestId: first.request_id });
    event(t, { type: "left", device: "lamp", requestId: "not-ours" });
    const evs = (body(await t.a.call(t.owner, "events", { cursor })).events as any[]).filter((e) => e.type === "provision");
    expect(evs.map((e) => e.cause)).toEqual([{ provision: first.request_id }, "bridge"]);
    expect(evs[1].request_id).toBe("not-ours");
    expect(body(await t.a.call(t.owner, "provision", args))).toEqual({ ...first, status: "accepted" });
  });

  // Preflight M4: an empty device id is no device; it never becomes an applier id.
  it("leaves out an empty device or identifier of a provisioning event", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const { cursor } = body(await t.a.call(t.owner, "events", {}));
    event(t, { type: "left", device: "" });
    event(t, { type: "window_closed", transport: "radio", devices: ["", "kettle"], windowMs: 1000 });
    event(t, { type: "blocked_rejoin", identifier: "" });
    const evs = (body(await t.a.call(t.owner, "events", { cursor })).events as any[]).filter((e) => e.type === "provision");
    expect(evs).toHaveLength(3);
    expect(evs[0]).not.toHaveProperty("device");
    expect(evs[1].devices).toEqual(["hall:kettle"]);
    expect(evs[2]).not.toHaveProperty("identifier");
  });

  it("keeps provision events in history, matched by device and transport", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    event(t, { type: "joined", device: "kettle" });
    event(t, { type: "window_closed", transport: "radio", devices: [], windowMs: 1000 });
    await t.a.call(t.owner, "events", {});
    const h = async (targets?: string[]) => (body(await t.a.call(t.owner, "history", { from: new Date(0).toISOString(),
      to: new Date(t.clock.now() + 1000).toISOString(), ...(targets ? { targets } : {}) })).events as any[])
      .filter((e) => e.type === "provision").map((e) => e.what);
    await vi.waitFor(async () => expect(await h()).toEqual(["joined", "window_closed"]));
    expect(await h(["hall:kettle"])).toEqual(["joined"]);
    expect(await h(["hall:radio"])).toEqual(["window_closed"]);
  });

  it.each([undefined, "forgets-a-provision-key"] as const)(
    "answers a key from its record after a restart, and sends nothing, mutation %s", async (mutation) => {
      const db = lasting(await memoryDb());
      const t = await make({ db, mutation });
      bridgeUp(t, { levels: ["Serve", "Provision"] });
      const args = { unblock: { identifier: "test:old", bridge: "hall" }, idempotency_key: "k4" };
      const p = t.a.call(t.owner, "provision", args);
      await vi.waitFor(() => expect(t.sent).toHaveLength(1));
      replyTo(t, 0, "ok");
      const first = body(await p);
      await t.store.settled();
      t.a.stop();
      const again = await make({ db, fresh: false, mutation });
      bridgeUp(again, { levels: ["Serve", "Provision"] });
      const r = again.a.call(again.owner, "provision", args);
      if (mutation) {
        await vi.waitFor(() => expect(again.sent).toHaveLength(1));
        replyTo(again, 0, "ok");
        expect(body(await r).request_id).not.toBe(first.request_id);
      } else {
        expect(body(await r)).toEqual(first);
        expect(again.sent).toHaveLength(0);
      }
    });

  it("keeps an unreachable record across a restart, and a later reply to it replaces it", async () => {
    const db = lasting(await memoryDb());
    const t = await make({ db });
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { remove: { device: "hall:lamp", block_rejoin: false }, idempotency_key: "k7" };
    const p = t.a.call(t.owner, "provision", args);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    t.clock.advance(2000);
    const first = body(await p);
    await t.store.settled();
    t.a.stop();
    const again = await make({ db, fresh: false });
    bridgeUp(again, { levels: ["Serve", "Provision"] });
    expect(body(await again.a.call(again.owner, "provision", args))).toEqual(first);
    send(again, "reply", { requestId: first.request_id, op: "remove", status: "accepted" });
    expect(body(await again.a.call(again.owner, "provision", args))).toEqual({ ...first, status: "accepted" });
    expect(again.sent).toEqual([]);
  });

  // Preflight I1: a reply the owner was told never rolls back in a crash, since it is told only once kept.
  it("tells the owner no reply a crash could take back: a keyed repeat after the crash agrees with what the owner had", async () => {
    const db = lasting(await memoryDb());
    const t = await make({ db });
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { unblock: { identifier: "test:old", bridge: "hall" }, idempotency_key: "lost-1" };
    let told: ToolResult | undefined;
    void t.a.call(t.owner, "provision", args).then((r) => { told = r; }, () => undefined);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));    // the row committed: the request went out
    await t.store.settled();
    db.trouble.down = true;                                    // the store stalls now ...
    replyTo(t, 0, "ok");
    await new Promise((r) => setTimeout(r, 20));
    expect(told).toBeUndefined();                              // ... and the owner is told nothing yet
    t.a.stop();                                                // the crash, before the reply was kept
    db.trouble.down = false;
    const again = await make({ db, fresh: false });
    bridgeUp(again, { levels: ["Serve", "Provision"] });
    expect(body(await again.a.call(again.owner, "provision", args))).toMatchObject({ status: "unreachable" });
    expect(again.sent).toEqual([]);
    expect(told).toBeUndefined();
  });

  it("prunes a record 3600 s after its first use, freeing its key", async () => {
    const t = await make();
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const args = { unblock: { identifier: "test:old", bridge: "hall" }, idempotency_key: "k5" };
    const p = t.a.call(t.owner, "provision", args);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    replyTo(t, 0, "ok");
    await p;
    t.clock.advance(3_600_000 + 60_000);
    await vi.waitFor(async () =>
      expect((await t.db.query<{ n: number }>("SELECT count(*)::int AS n FROM provisions")).rows[0]!.n).toBe(0));
    bridgeUp(t, { levels: ["Serve", "Provision"] });
    const again = t.a.call(t.owner, "provision", { ...args, unblock: { identifier: "test:other", bridge: "hall" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(2));
    replyTo(t, 1, "ok");
    expect(body(await again).status).toBe("ok");
  });
});
