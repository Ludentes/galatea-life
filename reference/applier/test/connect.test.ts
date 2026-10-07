import { describe, expect, it, vi } from "vitest";
import { Applier, type BusPort, type ToolResult } from "../src/applier.js";
import type { Puback } from "../src/bus/client.js";
import { StoreUnavailable } from "../src/core/errors.js";
import { GATE_MS, Store } from "../src/core/store.js";
import type { Mutation } from "../src/mutations.js";
import { CONNECT_LOST_MS } from "../src/provision/provisioner.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

// Slice 5b: provision.connect (applier, *Discovery*, GA-DISC-4), its 70 s, a death (K3) and a restart (K2).

const OWNER = "owner-credential";
const Z = "2030-01-01T08:00:00.000Z";
const INSTANCE = "11111111-1111-4111-8111-111111111111";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

/** An applier whose bus records each request `[bridge, op, body]`, with the bridges `hall` (esphome) and `tas` (tasmota) registered. */
async function make(opts: { mutation?: Mutation; db?: Awaited<ReturnType<typeof memoryDb>>; fresh?: boolean } = {}) {
  const clock = new FakeClock();
  clock.advance(0.5);
  const db = opts.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const t = { sent: [] as [string, string, Record<string, any>][], puback: { kind: "ok" } as Puback, seq: 0 };
  const bus: BusPort = { follow: () => undefined, snapshot: async () => ({ kind: "ok" }), command: async () => ({ kind: "ok" }),
    request: async (b, op, req) => { t.sent.push([b.id, op, req]); return t.puback; } };
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1", mutation: opts.mutation, bus });
  await a.start();
  const owner = a.caller(OWNER);
  const { revision } = body(await a.call(owner, "describe", {}));
  if (opts.fresh !== false) body(await a.call(owner, "configure", { changes: [{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } },
    { op: "upsert", kind: "bridge", value: { id: "tas", identity: "tas-bridge" } }], expected_revision: revision, dry_run: false }));
  return Object.assign(t, { a, db, clock, owner, store });
}
type T = Awaited<ReturnType<typeof make>>;

const send = (t: T, identity: string, path: string, b: unknown, retained = false) =>
  t.a.home.message(identity, path, Buffer.from(JSON.stringify(b)), retained);

/** A live status of `identity`, of `bridgeType`, claiming `levels`. */
const status = (t: T, identity: string, bridgeType: string, levels = ["Serve", "Provision"]) => send(t, identity, "status", {
  bridgeId: identity, instanceId: INSTANCE, v: 1, state: "online", version: "1", levels, bridgeType, faults: [], ungoverned: [], blocked: [],
  transports: [{ id: "radio", kind: "other", state: "up", since: Z }], devices: [], publishedAt: new Date(t.clock.now()).toISOString() });

/** The finder's list, as it publishes it. */
const list = (t: T, cands: Record<string, unknown>[]) => t.a.finder.message("candidates",
  Buffer.from(JSON.stringify({ publishedAt: Z, candidates: cands })), false);

/** The bridges live (hall esphome, tas tasmota) and the finder's list. */
function up(t: T, cands: Record<string, unknown>[]) {
  t.a.listening("hall");
  t.a.listening("tas");
  status(t, "hall-bridge", "esphome");
  status(t, "tas-bridge", "tasmota");
  list(t, cands);
}

/** Advances `ms` in 10 s steps, `hall` sending a live status at each, so no death ends anything. */
function keepAlive(t: T, ms: number) {
  for (let left = ms; left > 0; left -= 10_000) {
    t.clock.advance(Math.min(10_000, left));
    status(t, "hall-bridge", "esphome");
  }
}

const event = (t: T, b: Record<string, unknown>) => send(t, "hall-bridge", "event", { seq: ++t.seq, instanceId: INSTANCE, ...b });
const replyTo = (t: T, i: number, s: string) => send(t, "hall-bridge", "reply", { requestId: t.sent[i]![2].requestId, op: t.sent[i]![1], status: s });

/** The `provision` events served so far. */
async function provisionEvents(t: T): Promise<Record<string, any>[]> {
  const r = body(await t.a.call(t.owner, "history", { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" }));
  return (r.events as { type: string }[]).filter((e) => e.type === "provision") as Record<string, any>[];
}

const C = { id: "c1", sources: ["dhcp"], keys: ["mac:01", "mdns:a"], address: { ip: "192.0.2.10" }, firstSeen: Z, lastSeen: Z, hints: {},
  matches: [{ bridgeType: "esphome", connect: true }, { bridgeType: "tasmota", connect: false }] };

describe("connect", () => {
  const err = async (t: T, args: unknown) => {
    const r = await t.a.call(t.owner, "provision", { connect: args });
    return r.ok ? body(r).status : r.error;
  };
  const connect = (t: T, bridge = "hall", address: unknown = C.address) =>
    t.a.call(t.owner, "provision", { connect: { candidate: "c1", bridge, ...(address !== undefined ? { address } : {}) } });
  const accepted = async (t: T) => {
    const n = t.sent.length;
    const p = connect(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(n + 1));
    replyTo(t, n, "accepted");
    return body(await p).request_id as string;
  };
  const endsOf = async (t: T, id: string, what = "connect_failed") =>
    (await provisionEvents(t)).filter((e) => e.what === what && e.request_id === id);

  it("refuses in the design's order: not listed, then the bridge, then the address", async () => {
    const t = await make();
    up(t, [C]);
    expect(await err(t, { candidate: "nope", bridge: "nobody", address: C.address })).toBe("invalid_request");
    expect(await err(t, { candidate: "c1", bridge: "nobody", address: { ip: "192.0.2.99" } })).toBe("not_claimed");
    expect(await err(t, { candidate: "c1", bridge: "tas", address: C.address })).toBe("not_claimed");
    expect(await err(t, { candidate: "c1", bridge: "hall" })).toBe("invalid_request");
    expect(await err(t, { candidate: "c1", bridge: "hall", address: { ip: "192.0.2.11" } })).toBe("invalid_request");
    status(t, "hall-bridge", "esphome", ["Serve"]);
    expect(await err(t, { candidate: "c1", bridge: "hall", address: C.address })).toBe("not_claimed");
    status(t, "hall-bridge", "zigbee");
    expect(await err(t, { candidate: "c1", bridge: "hall", address: C.address })).toBe("not_claimed");
    expect(t.sent).toEqual([]);
    t.a.stop();
  });

  it("refuses an address on a candidate that has none (M3), and takes one with none without", async () => {
    const t = await make();
    up(t, [{ ...C, id: "b1", keys: ["ble:AA"], address: undefined }]);
    expect(await err(t, { candidate: "b1", bridge: "hall", address: { ip: "192.0.2.10" } })).toBe("invalid_request");
    const p = t.a.call(t.owner, "provision", { connect: { candidate: "b1", bridge: "hall" } });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]![2]).not.toHaveProperty("address");
    expect(t.sent[0]![2].keys).toEqual(["ble:AA"]);
    replyTo(t, 0, "accepted");
    await p;
    t.a.stop();
  });

  it("sends the owner's address and the candidate's keys, and returns the reply with its request_id", async () => {
    const t = await make();
    up(t, [C]);
    const p = connect(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject(["hall", "connect", { address: C.address, keys: C.keys }]);
    replyTo(t, 0, "accepted");
    expect(body(await p)).toEqual({ request_id: t.sent[0]![2].requestId, op: "connect", status: "accepted" });
    t.a.stop();
  });

  it.each([undefined, "ignores-the-address"] as const)("refuses the address the owner saw once the finder moved it; mutation %s", async (mutation) => {
    const t = await make({ mutation });
    up(t, [C]);
    list(t, [{ ...C, address: { ip: "192.0.2.12" } }]);
    if (!mutation) {
      expect(await err(t, { candidate: "c1", bridge: "hall", address: C.address })).toBe("invalid_request");
      expect(t.sent).toEqual([]);
    } else {
      void connect(t);
      await vi.waitFor(() => expect(t.sent).toHaveLength(1));
      expect(t.sent[0]![2].address).toEqual({ ip: "192.0.2.12" });
    }
    t.a.stop();
  });

  it.each([undefined, "never-ends-a-connect"] as const)("ends lost 70 s after the publish, then still issues connected; mutation %s", async (mutation) => {
    const t = await make({ mutation });
    up(t, [C]);
    const id = await accepted(t);
    keepAlive(t, CONNECT_LOST_MS - 10);
    expect(await endsOf(t, id)).toHaveLength(0);
    keepAlive(t, 10);
    const lost = await endsOf(t, id);
    expect(lost).toEqual(mutation ? [] : [expect.objectContaining({ bridge: "hall", reason: "lost", request_id: id, cause: { provision: id } })]);
    event(t, { type: "connected", requestId: id, device: "taken-1" });
    expect(await endsOf(t, id, "connected")).toEqual([expect.objectContaining({ device: "hall:taken-1", cause: { provision: id } })]);
    keepAlive(t, CONNECT_LOST_MS);
    expect(await endsOf(t, id)).toHaveLength(mutation ? 0 : 1);
    t.a.stop();
  });

  it("ends lost when its bridge dies after the publish, and waits its 70 s when the bridge was dead before (K3)", async () => {
    const t = await make();
    up(t, [C]);
    const id = await accepted(t);
    send(t, "hall-bridge", "lwt", { bridgeId: "hall-bridge", instanceId: INSTANCE });
    expect(await endsOf(t, id)).toHaveLength(1);
    const r = body(await connect(t));
    expect(r.status).toBe("unreachable");
    expect(t.sent.filter(([, op]) => op === "connect")).toHaveLength(2);
    t.clock.advance(CONNECT_LOST_MS - 1);
    expect(await endsOf(t, r.request_id)).toHaveLength(0);
    t.clock.advance(1);
    expect(await endsOf(t, r.request_id)).toEqual([expect.objectContaining({ reason: "lost", request_id: r.request_id })]);
    t.a.stop();
  });

  it("ends lost when the broker is lost", async () => {
    const t = await make();
    up(t, [C]);
    const id = await accepted(t);
    t.a.lost();
    expect(await endsOf(t, id)).toHaveLength(1);
    t.a.stop();
  });

  it.each([undefined, "forgets-a-connect"] as const)("ends lost exactly once at the resume after a restart (K2); mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const t = await make({ db, mutation });
    up(t, [C]);
    const id = await accepted(t);
    await t.store.settled();
    t.a.stop();
    await t.store.close();
    const again = await make({ db, fresh: false, mutation });
    again.clock.advance(80_000);
    await again.store.settled();
    expect(await endsOf(again, id)).toHaveLength(mutation ? 0 : 1);
    again.a.stop();
    await again.store.settled();
    const third = await make({ db, fresh: false, mutation });
    expect(await endsOf(third, id)).toHaveLength(mutation ? 0 : 1);
    third.a.stop();
  });

  it.each([undefined, "event-without-request-id"] as const)("carries the request_id on connected and on lost; mutation %s", async (mutation) => {
    const t = await make({ mutation });
    up(t, [C]);
    const id = await accepted(t);
    event(t, { type: "connected", requestId: id, device: "taken-1" });
    const done = (await provisionEvents(t)).find((e) => e.what === "connected")!;
    expect(done.request_id === id && JSON.stringify(done.cause) === JSON.stringify({ provision: id })).toBe(!mutation);
    t.a.stop();
  });

  it.each([undefined, "connects-to-the-wrong-bridge"] as const)("never sends a connect to a bridge whose match says connect false; mutation %s", async (mutation) => {
    const t = await make({ mutation });
    up(t, [C]);
    const p = connect(t, "tas");
    if (mutation) {
      await vi.waitFor(() => expect(t.sent.some(([b, op]) => b === "tas" && op === "connect")).toBe(true));
    } else {
      expect(await p).toMatchObject({ ok: false, error: "not_claimed" });
      expect(t.sent).toEqual([]);
    }
    t.a.stop();
  });
});

// The 5b preflight's findings, each probe a regression test.
describe("connect's ends (the 5b preflight)", () => {
  const keyed = (t: T, key?: string) =>
    t.a.call(t.owner, "provision", { connect: { candidate: "c1", bridge: "hall", address: C.address }, ...(key ? { idempotency_key: key } : {}) });
  const endsOf = async (t: T, id: string) => (await provisionEvents(t)).filter((e) => e.what === "connect_failed" && e.request_id === id);
  const accept = async (t: T, key?: string) => {
    const n = t.sent.length;
    const p = keyed(t, key);
    await vi.waitFor(() => expect(t.sent).toHaveLength(n + 1));
    replyTo(t, n, "accepted");
    return { id: t.sent[n]![2].requestId as string, r: body(await p) };
  };

  it("I1: a connect its reply ends (failed(busy)) is never ended again as lost, nor across a restart", async () => {
    const db = lasting(await memoryDb());
    const t = await make({ db });
    up(t, [C]);
    const p = keyed(t);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    send(t, "hall-bridge", "reply", { requestId: t.sent[0]![2].requestId, op: "connect", status: "failed", reason: "busy" });
    const r = body(await p);
    expect(r).toMatchObject({ status: "failed", reason: "busy" });
    keepAlive(t, CONNECT_LOST_MS + 10_000);
    send(t, "hall-bridge", "lwt", { bridgeId: "hall-bridge", instanceId: INSTANCE });
    await t.store.settled();
    expect(await endsOf(t, r.request_id)).toEqual([]);
    t.a.stop();
    const again = await make({ db, fresh: false });
    await again.store.settled();
    expect(await endsOf(again, r.request_id)).toEqual([]);
    again.a.stop();
  });

  it("I2: a keyed repeat after connected answers accepted, as GA-PROV-3's record says", async () => {
    const t = await make();
    up(t, [C]);
    const { id } = await accept(t, "k1");
    event(t, { type: "connected", requestId: id, device: "taken-1" });
    const again = body(await keyed(t, "k1"));
    expect(t.sent).toHaveLength(1);
    expect(again).toEqual({ request_id: id, op: "connect", status: "accepted" });
    t.a.stop();
  });

  it("I2: a keyed repeat after connect_failed answers accepted too", async () => {
    const t = await make();
    up(t, [C]);
    const { id } = await accept(t, "k3");
    event(t, { type: "connect_failed", requestId: id, reason: "unreachable" });
    expect(body(await keyed(t, "k3"))).toEqual({ request_id: id, op: "connect", status: "accepted" });
    t.a.stop();
  });

  it("I2: the applier's own lost is not the record's outcome: a keyed repeat still answers the reply", async () => {
    const t = await make();
    up(t, [C]);
    const { id } = await accept(t, "k2");
    keepAlive(t, CONNECT_LOST_MS + 10_000);
    expect(await endsOf(t, id)).toHaveLength(1);
    expect(body(await keyed(t, "k2"))).toEqual({ request_id: id, op: "connect", status: "accepted" });
    t.a.stop();
  });

  it("M3: a connect whose row lands after its caller's gate is never published, and no restart ends it lost", async () => {
    const db = lasting(await memoryDb());
    const t = await make({ db });
    up(t, [C]);
    t.db.trouble.down = true;
    const p = keyed(t);
    const failed = expect(p).rejects.toBeInstanceOf(StoreUnavailable);
    await new Promise((r) => setTimeout(r, 20));
    t.clock.advance(GATE_MS);
    await failed;
    t.db.trouble.down = false;
    t.clock.advance(5000);
    await vi.waitFor(async () =>
      expect((await t.db.query<{ ended: boolean }>("SELECT ended FROM provisions")).rows).toEqual([{ ended: true }]));
    expect(t.sent).toEqual([]);
    const id = (await t.db.query<{ request_id: string }>("SELECT request_id FROM provisions")).rows[0]!.request_id;
    t.a.stop();
    const again = await make({ db, fresh: false });
    again.clock.advance(80_000);
    await again.store.settled();
    expect(await endsOf(again, id)).toEqual([]);
    again.a.stop();
  });

  it("M4: a connect's end commits its event and its record as one", async () => {
    const t = await make();
    up(t, [C]);
    const { id } = await accept(t);
    await t.store.settled();
    t.db.trouble.failOn = /UPDATE provisions/;
    keepAlive(t, CONNECT_LOST_MS);
    await new Promise((r) => setTimeout(r, 50));
    const committed = async () => (await t.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE body->>'request_id' = $1", [id])).rows[0]!.n;
    expect(await committed()).toBe(0);
    t.db.trouble.failOn = undefined;
    t.clock.advance(5000);
    await vi.waitFor(async () => expect(await committed()).toBe(1));
    expect((await t.db.query<{ ended: boolean }>("SELECT ended FROM provisions WHERE request_id = $1", [id])).rows).toEqual([{ ended: true }]);
    t.a.stop();
  });

  it("M6: a connect published to a dead bridge ends lost when that bridge comes back and dies again", async () => {
    const t = await make();
    up(t, [C]);
    send(t, "hall-bridge", "lwt", { bridgeId: "hall-bridge", instanceId: INSTANCE });
    const r = body(await keyed(t));
    expect(r.status).toBe("unreachable");
    t.clock.advance(10_000);
    status(t, "hall-bridge", "esphome");
    expect(await endsOf(t, r.request_id)).toHaveLength(0);
    send(t, "hall-bridge", "lwt", { bridgeId: "hall-bridge", instanceId: INSTANCE });
    expect(await endsOf(t, r.request_id)).toEqual([expect.objectContaining({ reason: "lost", request_id: r.request_id })]);
    t.a.stop();
  });
});
