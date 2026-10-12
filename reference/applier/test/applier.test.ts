import { describe, expect, it, vi } from "vitest";
import { Applier, MAX_PLANS_PER_CLIENT, type BusPort, type ToolResult } from "../src/applier.js";
import { StoreUnavailable } from "../src/core/errors.js";
import { GATE_MS, Store } from "../src/core/store.js";
import { SEQ_LIFE_GAP } from "../src/core/events.js";
import { proofOf } from "../src/gate/token.js";
import { type Mutation, mutantOf } from "../src/mutations.js";
import { lasting, memoryDb, migrations } from "./db.js";
import { FakeClock } from "./fake-clock.js";

const OWNER = "owner-credential";
const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

/** A bus that records what the applier asks of it. */
function fakeBus() {
  const followed: string[][] = [];
  const snapshots: string[] = [];
  const bus: BusPort = { follow: (b) => void followed.push([...b.keys()]),
    snapshot: async (b) => { snapshots.push(b.id); return { kind: "ok" }; }, request: async () => ({ kind: "ok" }),
    command: async () => ({ kind: "ok" }) };
  return { bus, followed, snapshots };
}

async function make(opts: { mutation?: Mutation; runId?: string; db?: Awaited<ReturnType<typeof memoryDb>>;
  bus?: BusPort; backlogCap?: number } = {}) {
  const clock = new FakeClock();
  const retargeted: string[] = [];
  const db = opts.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; }, { migrations, backlogCap: opts.backlogCap });
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: opts.runId ?? "run-1",
    mutant: mutantOf(opts.mutation), retarget: async (s) => { retargeted.push(s); }, bus: opts.bus });
  await a.start();
  const owner = a.caller(OWNER);
  const configure = async (changes: unknown[], extra: Record<string, unknown> = {}) => {
    const { revision } = body(await a.call(owner, "describe", {}));
    return a.call(owner, "configure", { changes, expected_revision: revision, dry_run: false, ...extra });
  };
  return { a, db, store, clock, owner, configure, retargeted };
}

const client = (id: string) => ({ op: "upsert", kind: "client", value: { id, credential: `${id}-credential`, kind: "steward" } });

describe("Applier", () => {
  it("describes an empty model with the run id, and answers unchanged for the current revision", async () => {
    const { a, owner } = await make();
    const d = body(await a.call(owner, "describe", {}));
    expect(d).toMatchObject({ applier_id: "demo-applier", standard_version: "0.16", levels: ["Act"], revision: 0,
      devices: [], clients: [], test_run_id: "run-1" });
    expect(body(await a.call(owner, "describe", { since_revision: 0 }))).toEqual({ revision: 0, unchanged: true });
  });

  it("resolves callers per request, and forgets a removed client at once", async () => {
    const { a, configure } = await make();
    expect(a.caller("nobody")).toEqual({ kind: "anonymous" });
    await configure([client("h")]);
    expect(a.caller("h-credential")).toEqual({ kind: "client", id: "h" });
    await configure([{ op: "delete", kind: "client", value: { id: "h" } }]);
    expect(a.caller("h-credential")).toEqual({ kind: "anonymous" });
  });

  it("keeps a removed client under the mutation session-outlives-revocation", async () => {
    const { a, configure } = await make({ mutation: "session-outlives-revocation" });
    await configure([client("h")]);
    expect(a.caller("h-credential").kind).toBe("client");
    await configure([{ op: "delete", kind: "client", value: { id: "h" } }]);
    expect(a.caller("h-credential")).toEqual({ kind: "client", id: "h" });
  });

  it("lets only the owner configure, and refuses strangers everything", async () => {
    const { a, configure } = await make();
    await configure([client("h")]);
    const h = a.caller("h-credential");
    expect(await a.call(h, "configure", { changes: [], expected_revision: 1, dry_run: false }))
      .toMatchObject({ ok: false, error: "not_permitted" });
    expect(await a.call({ kind: "anonymous" }, "describe", {})).toMatchObject({ ok: false, error: "not_permitted" });
    expect(await a.call(a.caller(OWNER), "plan", { actions: [] })).toMatchObject({ ok: false, error: "not_permitted" });
  });

  it("bumps the revision and emits a model event only for a model change", async () => {
    const { a, owner, configure } = await make();
    const { cursor } = body(await a.call(owner, "events", {}));
    expect(body(await configure([client("h")])).revision).toBe(1);
    expect(body(await configure([client("h")])).revision).toBe(1);
    expect(body(await configure([{ op: "upsert", kind: "time_source", value: "127.0.0.1:9" }])).revision).toBe(1);
    const events = body(await a.call(owner, "events", { cursor })).events;
    expect(events).toEqual([expect.objectContaining({ type: "model", revision: 1 })]);
  });

  it("checks the revision first, changes nothing on a dry run or a refused set", async () => {
    const { a, owner, configure } = await make();
    await configure([client("h")]);
    expect(await a.call(owner, "configure", { changes: [client("x")], expected_revision: 0, dry_run: false }))
      .toMatchObject({ ok: false, error: "stale_revision" });
    const dry = body(await configure([client("x")], { dry_run: true }));
    expect(dry.diff).toContain("+ client x");
    expect(await configure([client("y"), { op: "upsert", kind: "client", value: { id: "" } }]))
      .toMatchObject({ ok: false, error: "invalid_request" });
    expect(body(await a.call(owner, "describe", {})).clients).toEqual(["h"]);
  });

  it("retargets the clock on time_source, and refuses it outside the harness", async () => {
    const inside = await make();
    await inside.configure([{ op: "upsert", kind: "time_source", value: "127.0.0.1:9" }]);
    expect(inside.retargeted).toEqual(["127.0.0.1:9"]);
    const outside = await make({ runId: "" });
    expect(await outside.configure([{ op: "upsert", kind: "time_source", value: "127.0.0.1:9" }]))
      .toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("validates each request against its schema", async () => {
    const { a, owner, configure } = await make();
    expect(await a.call(owner, "configure", { changes: "no" })).toMatchObject({ ok: false, error: "invalid_request" });
    await configure([client("h")]);
    expect(await a.call(a.caller("h-credential"), "plan", { actions: [] })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(await a.call(a.caller("h-credential"), "apply", { plan_id: "p-1" })).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("answers state with no targets, and history by time", async () => {
    const { a, owner, clock, configure } = await make();
    expect(body(await a.call(owner, "state", {}))).toEqual({ targets: {}, transports: [], latches: [] });
    const from = new Date(clock.now()).toISOString();
    await configure([client("h")]);
    const to = new Date(clock.now() + 1000).toISOString();
    expect(body(await a.call(owner, "history", { from, to })).events).toEqual([expect.objectContaining({ type: "model" })]);
  });

  it("keeps its configuration and revision across a clean restart on the same database", async () => {
    const db = lasting(await memoryDb());
    const { a, store, configure } = await make({ db });
    await configure([client("h")]);
    a.stop();
    await store.close();
    const again = await make({ db });
    expect(again.a.caller("h-credential")).toEqual({ kind: "client", id: "h" });
    expect(body(await again.a.call(again.owner, "describe", {})).revision).toBe(1);
  });

  it("moves its revision past the last life's after a stop that was not clean, and keeps the jump at once", async () => {
    const db = lasting(await memoryDb());
    const { store, configure } = await make({ db });
    await configure([client("h")]);
    await store.settled();
    const second = await make({ db });
    const jumped = body(await second.a.call(second.owner, "describe", {})).revision;
    expect(jumped).toBeGreaterThanOrEqual(1 + SEQ_LIFE_GAP);
    await second.store.settled();
    const third = await make({ db });
    expect(body(await third.a.call(third.owner, "describe", {})).revision).toBeGreaterThanOrEqual(jumped + SEQ_LIFE_GAP);
  });

  it("applies an owner's change only once it commits: 10 s without a commit is an error, and the change lands later", async () => {
    const { a, db, store, clock, owner } = await make();
    db.trouble.down = true;
    const pending = a.call(owner, "configure", { changes: [client("h")], expected_revision: 0, dry_run: false });
    await vi.waitFor(() => expect(store.down).toBe(true));
    expect(a.caller("h-credential")).toEqual({ kind: "anonymous" });
    clock.advance(GATE_MS);
    await expect(pending).rejects.toBeInstanceOf(StoreUnavailable);
    expect(body(await a.call(owner, "describe", {})).revision).toBe(0);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(a.caller("h-credential")).toEqual({ kind: "client", id: "h" }); });
    expect(body(await a.call(owner, "describe", {})).revision).toBe(1);
  });

  it("holds the next owner change in line; one that waits out 10 s there is never applied", async () => {
    const { a, db, store, clock, owner } = await make();
    db.trouble.down = true;
    const first = a.call(owner, "configure", { changes: [client("h")], expected_revision: 0, dry_run: false });
    const second = a.call(owner, "configure", { changes: [client("x")], expected_revision: 1, dry_run: false });
    await vi.waitFor(() => expect(store.down).toBe(true));
    clock.advance(GATE_MS);
    await expect(first).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(second).rejects.toBeInstanceOf(StoreUnavailable);
    db.trouble.down = false;
    await vi.waitFor(() => { clock.advance(1000); expect(a.caller("h-credential")).toEqual({ kind: "client", id: "h" }); });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.caller("x-credential")).toEqual({ kind: "anonymous" });
    expect(body(await a.call(owner, "describe", {}))).toMatchObject({ revision: 1, clients: ["h"] });
  });

  it("answers describe and events from memory while the store is down; history fails", async () => {
    const { a, db, store, clock, owner, configure } = await make();
    const { cursor } = body(await a.call(owner, "events", {}));
    const from = new Date(clock.now()).toISOString();
    await configure([client("h")]);
    await store.settled();
    db.trouble.down = true;
    expect(body(await a.call(owner, "describe", {})).revision).toBe(1);
    expect(body(await a.call(owner, "events", { cursor })).events).toEqual([expect.objectContaining({ type: "model" })]);
    const to = new Date(clock.now() + 1000).toISOString();
    const history = a.call(owner, "history", { from, to });
    await vi.waitFor(() => expect(store.down).toBe(true));
    clock.advance(GATE_MS);
    await expect(history).rejects.toBeInstanceOf(StoreUnavailable);
    await expect(a.call(owner, "history", { from, to })).rejects.toBeInstanceOf(StoreUnavailable);
  });

  it("holds an events long-poll until an event, then returns it", async () => {
    const { a, owner, configure } = await make();
    const { cursor } = body(await a.call(owner, "events", {}));
    const polled = a.call(owner, "events", { cursor, wait_s: 30 });
    await configure([client("h")]);
    expect(body(await polled).events).toHaveLength(1);
  });

  describe("with a bridge", () => {
    const T = "2030-01-01T08:00:00.000Z";
    const doc = { devices: [{ id: "lamp", stableIdentifier: "test:lamp", transport: "radio", capabilities: ["onoff"],
      actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }], feedback: "closed",
      reachMs: 0, proposedClass: "light", classEvidence: "protocol" }] };
    const status = { bridgeId: "hall-bridge", instanceId: "11111111-1111-4111-8111-111111111111", v: 1, state: "online",
      version: "1", levels: ["Serve"], faults: [], ungoverned: [], blocked: [],
      transports: [{ id: "radio", kind: "zigbee", state: "up", since: T }],
      devices: [{ id: "lamp", transport: "radio", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, timestamp: T,
        lastCheckIn: T, observable: true, since: T }], publishedAt: T };
    const send = (a: Applier, path: string, body: unknown, retained = false) =>
      a.home.message("hall-bridge", path, Buffer.from(JSON.stringify(body)), retained);
    const bridge = { op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } };

    it("follows a registered bridge on the bus, and takes its devices as a model change, unadopted", async () => {
      const { bus, followed } = fakeBus();
      const { a, owner, configure } = await make({ bus });
      body(await configure([bridge]));
      expect(followed.at(-1)).toEqual(["hall"]);
      const { cursor } = body(await a.call(owner, "events", {}));
      send(a, "devices", doc, true);
      const d = body(await a.call(owner, "describe", {}));
      expect(d.revision).toBe(2);
      expect(d.devices).toMatchObject([{ id: "hall:lamp", adopted: false, class: null, proposed_class: "light" }]);
      expect(body(await a.call(owner, "events", { cursor })).events).toMatchObject([{ type: "model", revision: 2, device: "hall:lamp" }]);
    });

    it("gives state per device: dead until its bridge is heard live, then live", async () => {
      const { bus } = fakeBus();
      const { a, owner, configure } = await make({ bus });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      a.home.listening("hall");
      const lamp = async () => body(await a.call(owner, "state", { targets: ["hall:lamp"] })).targets["hall:lamp"];
      expect((await lamp()).liveness).toBe("dead");
      send(a, "status", status);
      expect(await lamp()).toMatchObject({ liveness: "live", fresh_s: 60, fresh_basis: "declared", last_check_in: T });
    });

    it("adopts a device by the owner's configure: a model change whose event names it, kept across a restart", async () => {
      const db = lasting(await memoryDb());
      const { a, owner, configure, store } = await make({ db });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      const { cursor } = body(await a.call(owner, "events", {}));
      const r = body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
      expect(r.revision).toBe(3);
      expect(body(await a.call(owner, "events", { cursor })).events).toMatchObject([
        { type: "model", revision: 3, device: "hall:lamp", class: "light" }]);
      a.stop();
      await store.close();
      const again = await make({ db });
      const d = body(await again.a.call(again.owner, "describe", {}));
      expect(d.revision).toBe(3);
      expect(d.devices).toMatchObject([{ id: "hall:lamp", adopted: true, class: "light" }]);
      expect(body(await again.a.call(again.owner, "state", {})).targets["hall:lamp"].liveness).toBe("dead");
    });

    const withTransports = (transports: unknown[]) => ({ ...status, transports });

    it("takes a new transport, or a changed kind, as a model change, and one no device names leaving the status; up and state are not", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      a.home.listening("hall");
      const { cursor } = body(await a.call(owner, "events", {}));
      const revision = async () => body(await a.call(owner, "describe", {})).revision;
      send(a, "status", status);
      expect(await revision()).toBe(2);
      send(a, "status", withTransports([{ id: "radio", kind: "zigbee", state: "down", since: T }]));
      send(a, "status", withTransports([{ id: "radio", kind: "zigbee", state: "unknown", since: T }]));
      expect(await revision()).toBe(2);
      send(a, "status", withTransports([{ id: "radio", kind: "matter", state: "up", since: T }]));
      expect(await revision()).toBe(3);
      send(a, "status", withTransports([]));
      expect(await revision()).toBe(4);
      expect(body(await a.call(owner, "describe", {})).transports).toEqual([]);
      const models = body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === "model");
      expect(models).toMatchObject([{ revision: 2, transport: "hall:radio" }, { revision: 3, transport: "hall:radio" },
        { revision: 4, transport: "hall:radio", removed: true }]);
    });

    it("lists a transport a device names until no device does: down once its status omits it, and after its bridge is removed", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      a.home.listening("hall");
      send(a, "status", status);
      send(a, "status", withTransports([]));
      const listed = async () => body(await a.call(owner, "describe", {})).transports;
      expect(await listed()).toEqual([{ id: "hall:radio", kind: "zigbee", up: false, state: "down", bridge: "hall" }]);
      body(await configure([{ op: "delete", kind: "bridge", value: { id: "hall" } }]));
      expect(await listed()).toEqual([{ id: "hall:radio", kind: "zigbee", up: false, state: "down", bridge: "hall" }]);
      expect(body(await a.call(owner, "describe", {})).devices).toMatchObject([{ id: "hall:lamp", transport: "hall:radio" }]);
      body(await configure([{ op: "upsert", kind: "forget", value: { device: "hall:lamp" } }]));
      expect(await listed()).toEqual([]);
    });

    it("keeps its transports across a clean restart, at the same revision", async () => {
      const db = lasting(await memoryDb());
      const { a, owner, configure, store } = await make({ db });
      body(await configure([bridge]));
      a.home.listening("hall");
      send(a, "status", status);
      const before = body(await a.call(owner, "describe", {}));
      a.stop();
      await store.close();
      const again = await make({ db });
      const after = body(await again.a.call(again.owner, "describe", {}));
      expect(after.revision).toBe(before.revision);
      expect(after.transports).toMatchObject([{ id: "hall:radio", kind: "zigbee", bridge: "hall", up: false }]);
    });

    it("judges a bridge silent for 30 s dead on the tick, and its devices with it", async () => {
      const { a, owner, clock, configure } = await make({ bus: fakeBus().bus });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      a.home.listening("hall");
      send(a, "status", status);
      const lamp = async () => body(await a.call(owner, "state", { targets: ["hall:lamp"] })).targets["hall:lamp"];
      expect((await lamp()).liveness).toBe("live");
      const { cursor } = body(await a.call(owner, "events", {}));
      clock.advance(29_000);
      expect((await lamp()).liveness).toBe("live");
      clock.advance(2_000);
      expect((await lamp()).liveness).toBe("dead");
      expect(body(await a.call(owner, "events", { cursor })).events)
        .toContainEqual(expect.objectContaining({ type: "liveness", target: "hall:lamp", old: "live", new: "dead" }));
    });

    it("answers stale_revision to an owner whose revision a bridge moved since it read it", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      const { revision } = body(await a.call(owner, "describe", {}));
      send(a, "devices", doc, true);
      expect(await a.call(owner, "configure", { changes: [client("h")], expected_revision: revision, dry_run: false }))
        .toMatchObject({ ok: false, error: "stale_revision" });
    });

    it("refuses an adoption of a device it does not hold", async () => {
      const { configure } = await make();
      expect(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:kettle", class: "socket" } }]))
        .toMatchObject({ ok: false, error: "invalid_request" });
    });

    it("adopts with declarations and takes each declaration kind as a model change naming its device", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      const { cursor } = body(await a.call(owner, "events", {}));
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light",
        declarations: { tiers: { "onoff.turn_on": "confirm" } } } }]));
      const r = body(await configure([{ op: "upsert", kind: "fresh_s", value: { device: "hall:lamp", fresh_s: 20 } }]));
      const lamp = body(await a.call(owner, "describe", {})).devices[0];
      expect(lamp).toMatchObject({ adopted: true, fresh_s: 20, fresh_basis: "configured",
        actions: [{ action: "onoff.turn_on", tier: "confirm" }] });
      expect(body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === "model")).toMatchObject([
        { revision: r.revision - 1, device: "hall:lamp", class: "light" }, { revision: r.revision, device: "hall:lamp" }]);
      // The owner brings their own raise back down to the floor (HS35, GA-DESC-14).
      expect(await configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "reversible" } }]))
        .toMatchObject({ ok: true });
      expect(body(await a.call(owner, "describe", {})).devices[0].actions).toMatchObject([{ action: "onoff.turn_on", tier: "reversible" }]);
    });

    it("forgets a device once its bridge no longer lists it: gone from describe and the store, and unadopted if it returns (GA-ADOPT-1)", async () => {
      const db = lasting(await memoryDb());
      const { a, owner, configure, store } = await make({ db });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light",
        declarations: { tiers: { "onoff.turn_on": "confirm" } } } }]));
      const forget = { op: "upsert", kind: "forget", value: { device: "hall:lamp" } };
      expect(await configure([forget])).toMatchObject({ ok: false, error: "invalid_request" });
      send(a, "devices", { devices: [] });
      const { cursor } = body(await a.call(owner, "events", {}));
      const r = body(await configure([forget]));
      expect(body(await a.call(owner, "describe", {})).devices).toEqual([]);
      expect(body(await a.call(owner, "events", { cursor })).events).toMatchObject([
        { type: "model", revision: r.revision, device: "hall:lamp", forgotten: true }]);
      a.stop();
      await store.close();
      const again = await make({ db });
      expect(body(await again.a.call(again.owner, "describe", {})).devices).toEqual([]);
      send(again.a, "devices", doc, true);
      expect(body(await again.a.call(again.owner, "describe", {})).devices).toMatchObject([
        { id: "hall:lamp", adopted: false, actions: [{ action: "onoff.turn_on", tier: "reversible" }] }]);
    });

    it("replaces a device: the new hardware takes the id and its declarations but fresh_s, the old identifier retired; kept across a restart (GA-ADOPT-2)", async () => {
      const db = lasting(await memoryDb());
      const { a, owner, configure, store } = await make({ db });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light",
        declarations: { tiers: { "onoff.turn_on": "confirm" }, fresh_s: 20 } } }]));
      const lamp2 = { ...doc.devices[0], id: "lamp-2", stableIdentifier: "test:lamp-2" };
      send(a, "devices", { devices: [lamp2] });
      const { cursor } = body(await a.call(owner, "events", {}));
      const r = body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp-2", class: "light", replaces: "hall:lamp" } }]));
      const replaced = [{ id: "hall:lamp", stable_identifier: "test:lamp-2", previous_identifiers: ["test:lamp"], adopted: true,
        bridge_device: { bridge: "hall-bridge", id: "lamp-2" }, fresh_basis: "unknown", actions: [{ action: "onoff.turn_on", tier: "confirm" }] }];
      expect(body(await a.call(owner, "describe", {})).devices).toMatchObject(replaced);
      expect(body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === "model")).toEqual([
        expect.objectContaining({ revision: r.revision, device: "hall:lamp-2", class: "light", replaces: "hall:lamp" })]);
      // The old hardware back, admitted anew by its bridge: a new device, unadopted.
      send(a, "devices", { devices: [lamp2, { ...doc.devices[0], id: "lamp-3" }] });
      const again = [...replaced, { id: "hall:lamp-3", stable_identifier: "test:lamp", adopted: false }];
      expect(body(await a.call(owner, "describe", {})).devices).toMatchObject(again);
      a.stop();
      await store.close();
      const next = await make({ db });
      expect(body(await next.a.call(next.owner, "describe", {})).devices).toMatchObject(again);
    });

    it("forgets a replacement's retired identifier across a restart under forgets-a-retired-identifier (GA-PERSIST-1)", async () => {
      // As the replacement test above: the lamp replaced by new hardware, its old identifier retired.
      const db = lasting(await memoryDb());
      const { a, configure, store } = await make({ db });
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
      const lamp2 = { ...doc.devices[0], id: "lamp-2", stableIdentifier: "test:lamp-2" };
      send(a, "devices", { devices: [lamp2] });
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp-2", class: "light", replaces: "hall:lamp" } }]));
      a.stop();
      await store.close();
      for (const mutation of [undefined, "forgets-a-retired-identifier"] as const) {
        const again = await make({ db, mutation });
        const lamp = body(await again.a.call(again.owner, "describe", {})).devices.find((d: any) => d.id === "hall:lamp");
        expect(lamp.previous_identifiers).toEqual(mutation ? [] : ["test:lamp"]);
        again.a.stop();
        await again.store.close();
      }
    });

    it("gives the replaced hardware, while its bridge still lists it, an id of its own, unadopted", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      const lamp2 = { ...doc.devices[0], id: "lamp-2", stableIdentifier: "test:lamp-2" };
      send(a, "devices", { devices: [...doc.devices, lamp2] }, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp-2", class: "light", replaces: "hall:lamp" } }]));
      expect(body(await a.call(owner, "describe", {})).devices.map((d: any) => [d.id, d.bridge_device.id, d.adopted]).sort())
        .toEqual([["hall:lamp", "lamp-2", true], ["hall:lamp/2", "lamp", false]]);
    });

    it("says a second door at adoption, and once more for the devices adopted before it said any (GA-ADOPT-3)", async () => {
      const db = lasting(await memoryDb());
      const { a, configure, store } = await make({ db });
      body(await configure([bridge, client("h")]));
      const gate = { ...doc.devices[0], id: "gate", stableIdentifier: "test:gate", capabilities: ["cover"], proposedClass: "gate",
        actions: [{ action: "cover.close", idempotent: false, stateless: false, confirms: true }], otherAdmins: "unknown" };
      send(a, "devices", { devices: [gate] }, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:gate", class: "gate" } }]));
      const h = a.caller("h-credential");
      const [said] = body(await a.call(h, "events", {})).notices;
      expect(said).toMatchObject({ cause: "other_admin", devices: ["hall:gate"] });
      body(await a.call(h, "events", { notice_taken: [said.notice_id] }));
      // As a store from before slice 3 would be: the flag unset.
      await store.settled();
      await db.query("DELETE FROM meta WHERE key = 'other_admins_said'");
      a.stop();
      await store.close();
      const next = await make({ db });
      const h2 = next.a.caller("h-credential");
      expect(body(await next.a.call(h2, "events", {})).notices).toMatchObject([{ cause: "other_admin", devices: ["hall:gate"] }]);
      next.a.stop();
      await next.store.close();
      const third = await make({ db });
      expect(body(await third.a.call(third.a.caller("h-credential"), "events", {})).notices).toHaveLength(1);
    });

    it("takes a devices document that changed only other_admins as state: an other_admins event, the revision unmoved", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      const { revision } = body(await a.call(owner, "describe", {}));
      const { cursor } = body(await a.call(owner, "events", {}));
      const admins = [{ vendor: "demo", label: "remote" }];
      send(a, "devices", { devices: [{ ...doc.devices[0], otherAdmins: admins }] });
      expect(body(await a.call(owner, "describe", {})).revision).toBe(revision);
      expect(body(await a.call(owner, "events", { cursor })).events).toMatchObject([{ type: "other_admins", target: "hall:lamp", other_admins: admins }]);
      expect(body(await a.call(owner, "state", {})).targets["hall:lamp"].other_admins).toEqual(admins);
    });

    it("deletes an adoption: the device unadopted, its declarations gone, one model event naming it", async () => {
      const { a, owner, configure } = await make();
      body(await configure([bridge]));
      send(a, "devices", doc, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light",
        declarations: { fresh_s: 20 } } }]));
      const { cursor } = body(await a.call(owner, "events", {}));
      const r = body(await configure([{ op: "delete", kind: "adopt", value: { device: "hall:lamp" } }]));
      expect(body(await a.call(owner, "describe", {})).devices).toMatchObject([{ id: "hall:lamp", adopted: false, fresh_basis: "unknown" }]);
      expect(body(await a.call(owner, "events", { cursor })).events.filter((e: any) => e.type === "model")).toEqual([
        expect.objectContaining({ revision: r.revision, device: "hall:lamp", adopted: false })]);
    });

    it("carries a device's fault notice in every events response until a client takes it; the owner's take is ignored", async () => {
      const db = lasting(await memoryDb());
      const { a, owner, configure, store } = await make({ db });
      body(await configure([bridge, client("h")]));
      send(a, "devices", doc, true);
      body(await configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
      a.home.listening("hall");
      send(a, "status", { ...status, faults: [{ code: "no_pin", device: "lamp" }] });
      const h = a.caller("h-credential");
      const [notice] = body(await a.call(h, "events", {})).notices;
      expect(notice).toMatchObject({ cause: "bridge_fault", devices: ["hall:lamp"] });
      const { cursor } = body(await a.call(h, "events", {}));
      expect(body(await a.call(h, "events", { cursor })).notices).toEqual([notice]);
      expect(body(await a.call(owner, "events", { notice_taken: [notice.notice_id] })).notices).toEqual([notice]);
      a.stop();
      await store.close();
      const again = await make({ db });
      const h2 = again.a.caller("h-credential");
      expect(body(await again.a.call(h2, "events", {})).notices).toEqual([notice]);
      expect(body(await again.a.call(h2, "events", { notice_taken: [notice.notice_id] })).notices).toEqual([]);
    });

    const KEY = "the-steward's-token-key";
    const steward = { op: "upsert", kind: "client", value: { id: "h", credential: "h-credential", kind: "steward", token_key: KEY } };
    const turnOn = { target: "hall:lamp", action: "onoff.turn_on", args: {}, via: "app", brain: false, for: { person: "demo" } };
    /** A heard bridge with an adopted, live lamp, and a steward with a token key. */
    async function planning(opts: Parameters<typeof make>[0] = {}) {
      const m = await make(opts);
      body(await m.configure([bridge, steward]));
      send(m.a, "devices", doc, true);
      m.a.home.listening("hall");
      send(m.a, "status", status);
      body(await m.configure([{ op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } }]));
      return { ...m, h: m.a.caller("h-credential") };
    }

    it("plans for a client: a step per action, the plan expiring 60 s on, and nothing emitted or written (GA-PLAN-1, GA-PLAN-2)", async () => {
      const { a, h, owner, clock, store } = await planning();
      await store.settled();
      const { cursor } = body(await a.call(owner, "events", {}));
      const events = await store.query("SELECT count(*)::int AS n FROM events");
      const plan = body(await a.call(h, "plan", { actions: [turnOn, turnOn, { ...turnOn, target: "hall:ghost" }] }));
      expect(store.backlog).toBe(0);
      expect(plan).toMatchObject({ revision: 4, client: "h", expires_at: new Date(clock.now() + 60_000).toISOString(),
        request: { actions: [turnOn, turnOn, { ...turnOn, target: "hall:ghost" }] } });
      expect(plan.steps).toEqual([
        { step_id: "s1", target: "hall:lamp", action: "onoff.turn_on", args: {}, verdict: "op", tier: "reversible", stale: false, basis: "real" },
        { step_id: "s2", target: "hall:ghost", action: "onoff.turn_on", args: {}, verdict: "skip", reason: "unknown_target",
          tier: "reversible", stale: false, basis: "real" }]);
      expect(body(await a.call(owner, "events", { cursor })).events).toEqual([]);
      await store.settled();
      expect((await store.query("SELECT count(*)::int AS n FROM events")).rows).toEqual(events.rows);
      expect(body(await a.call(owner, "describe", {})).revision).toBe(4);
    });

    it("skips an action whose live, observed value already holds, and a dead device's (GA-PLAN-4)", async () => {
      const { a, h } = await planning();
      send(a, "devices/lamp/status", { deviceId: "lamp", on: true, timestamp: T });
      expect(body(await a.call(h, "plan", { actions: [turnOn] })).steps[0]).toMatchObject({ verdict: "skip", reason: "already" });
      send(a, "devices/lamp/status", { deviceId: "lamp", on: true, timestamp: T, available: false });
      expect(body(await a.call(h, "plan", { actions: [turnOn] })).steps[0]).toMatchObject({ verdict: "skip", reason: "dead" });
    });

    it("refuses a confirm action without a token, and takes one its steward signed with its key (GA-TOKEN-1)", async () => {
      const { a, h, configure, clock } = await planning();
      body(await configure([{ op: "upsert", kind: "tier", value: { device: "hall:lamp", action: "onoff.turn_on", tier: "confirm" } }]));
      expect(body(await a.call(h, "plan", { actions: [turnOn] })).steps[0]).toMatchObject({ verdict: "refuse", reason: "token", tier: "confirm" });
      const unsigned = { token_id: "t-1", issuer: "h", ...turnOn, expires: new Date(clock.now() + 30_000).toISOString() };
      const token = { ...unsigned, proof: proofOf(unsigned as never, KEY) };
      expect(body(await a.call(h, "plan", { actions: [{ ...turnOn, token }] })).steps[0]).toMatchObject({ verdict: "op" });
      const forged = { ...unsigned, proof: proofOf(unsigned as never, "another-key-of-16-chars") };
      expect(body(await a.call(h, "plan", { actions: [{ ...turnOn, token: forged }] })).steps[0]).toMatchObject({ reason: "token" });
    });

    it("emits an event while planning under plans-with-side-effect", async () => {
      const { a, h, owner } = await planning({ mutation: "plans-with-side-effect" });
      const { cursor } = body(await a.call(owner, "events", {}));
      body(await a.call(h, "plan", { actions: [turnOn] }));
      expect(body(await a.call(owner, "events", { cursor })).events).not.toEqual([]);
    });

    it("holds at most 64 plans per client, dropping the oldest", async () => {
      const { a, h } = await planning();
      const first = body(await a.call(h, "plan", { actions: [turnOn] })).plan_id;
      for (let i = 0; i < MAX_PLANS_PER_CLIENT; i++) body(await a.call(h, "plan", { actions: [turnOn] }));
      expect(a.plans.has(first)).toBe(false);
      expect(a.plans.size).toBe(MAX_PLANS_PER_CLIENT);
    });

    it("drops long-expired plans, and a removed client's, on the prune round, with no client planning (the whole-applier review's M3)", async () => {
      const { a, h, clock, configure } = await planning();
      body(await configure([client("k")]));
      const k = a.caller("k-credential");
      const old = body(await a.call(h, "plan", { actions: [turnOn] })).plan_id;
      clock.advance(30_000);
      const kept = body(await a.call(h, "plan", { actions: [turnOn] })).plan_id;
      const ks = body(await a.call(k, "plan", { actions: [turnOn] })).plan_id;
      body(await configure([{ op: "delete", kind: "client", value: { id: "k" } }]));
      // 120 s on, a prune round: the first plan is past its expiry and held as long again, the second not yet; k is gone.
      clock.advance(90_000);
      expect([...a.plans.keys()].sort()).toEqual([kept].sort());
      expect(a.plans.has(old)).toBe(false);
      expect(a.plans.has(ks)).toBe(false);
    });

    it("takes an action's statelessness from the capability's column, whatever its bridge says (applier, *Action declarations*)", async () => {
      const { a, owner } = await planning();
      send(a, "devices", { devices: [{ ...doc.devices[0], capabilities: ["cover"], actions: [{ action: "cover.stop", idempotent: true,
        stateless: false, confirms: true }] }] }, true);
      expect(body(await a.call(owner, "describe", {})).devices[0].actions[0]).toMatchObject({ action: "cover.stop", stateless: true });
      expect(a.home.gateDevice("hall:lamp")!.actions.get("cover.stop")).toMatchObject({ stateless: true });
    });

    it("refuses a step whose arguments its device's own args do not allow (applier, *Requests*)", async () => {
      const { a, h } = await planning();
      send(a, "devices", { devices: [{ ...doc.devices[0], capabilities: ["onoff", "level"], actions: [...doc.devices[0]!.actions,
        { action: "level.set_level", idempotent: true, stateless: false, confirms: true, args: { level: { min: 10, max: 90 } } }] }] }, true);
      const level = (n: number) => ({ ...turnOn, action: "level.set_level", args: { level: n } });
      expect(body(await a.call(h, "plan", { actions: [level(95)] })).steps[0]).toMatchObject({ verdict: "refuse", reason: "invalid_args" });
      expect(body(await a.call(h, "plan", { actions: [level(50)] })).steps[0]).toMatchObject({ verdict: "op" });
    });

    it("declares an action that toggles never idempotent, whatever its bridge says (GA-PLAN-8)", async () => {
      const { a, owner } = await planning();
      send(a, "devices", { devices: [{ ...doc.devices[0], actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false,
        confirms: true, toggles: true }] }] }, true);
      expect(body(await a.call(owner, "describe", {})).devices[0].actions[0]).toMatchObject({ toggles: true, idempotent: false });
    });

    it("folds a second bridge's copy into the device, refuses its adoption until the owner routes it, and keeps the route across a restart (GA-BUS-11)", async () => {
      const db = lasting(await memoryDb());
      const { a, h, owner, configure, store } = await planning({ db });
      // An adopted device keeps its bridge; unadopted, a copy another bridge shows is folded into it.
      body(await configure([{ op: "upsert", kind: "bridge", value: { id: "porch", identity: "porch-bridge" } },
        { op: "delete", kind: "adopt", value: { device: "hall:lamp" } }]));
      const { cursor } = body(await a.call(owner, "events", {}));
      a.home.message("porch-bridge", "devices", Buffer.from(JSON.stringify({ devices: [{ ...doc.devices[0], id: "0x01" }] })), true);
      expect(body(await a.call(owner, "describe", {})).devices.map((d: any) => d.id)).toEqual(["hall:lamp"]);
      const events = body(await a.call(owner, "events", { cursor })).events;
      expect(events.filter((e: any) => e.type === "model")).toMatchObject([{ device: "hall:lamp" }]);
      expect(events.filter((e: any) => e.type === "route_conflict")).toMatchObject([
        { stable_identifier: "test:lamp", bridges: ["hall", "porch"], devices: ["hall:lamp"] }]);
      // Route first: the one device is not adopted before it is routed, so its steps read not_adopted.
      const adopt = { op: "upsert", kind: "adopt", value: { device: "hall:lamp", class: "light" } };
      expect(await configure([adopt])).toMatchObject({ ok: false, error: "invalid_request", message: expect.stringMatching(/route it first/) });
      expect(body(await a.call(h, "plan", { actions: [turnOn] })).steps[0]).toMatchObject({ verdict: "refuse", reason: "not_adopted" });
      const routed = body(await a.call(owner, "events", {})).cursor;
      body(await configure([{ op: "upsert", kind: "route", value: { stable_identifier: "test:lamp", bridge: "porch" } }, adopt]));
      expect(body(await a.call(owner, "events", { cursor: routed })).events.filter((e: any) => e.type === "model"))
        .toMatchObject([{ device: "hall:lamp", class: "light" }, { device: "porch:0x01", folded_into: "hall:lamp" }]);
      const d = body(await a.call(owner, "describe", {})).devices;
      expect(d).toMatchObject([{ id: "hall:lamp", adopted: true, bridge_device: { bridge: "porch-bridge", id: "0x01" } }]);
      expect(body(await a.call(h, "plan", { actions: [turnOn] })).steps[0]).toMatchObject({ verdict: "skip", reason: "dead" });
      // The route of an adopted device stays.
      expect(await configure([{ op: "delete", kind: "route", value: { stable_identifier: "test:lamp" } }]))
        .toMatchObject({ ok: false, error: "invalid_request" });
      a.stop();
      await store.close();
      const again = await make({ db });
      expect(body(await again.a.call(again.owner, "describe", {})).devices).toMatchObject([
        { id: "hall:lamp", adopted: true, bridge_device: { bridge: "porch-bridge", id: "0x01" } }]);
      expect(again.a.home.devices.get("porch:0x01")).toMatchObject({ bridge: "hall", bridge_device: "lamp", into: "hall:lamp" });
    });

    it("places the rows a route wrote with the document its hardware has when the write commits", async () => {
      const db = lasting(await memoryDb());
      const { a, clock, configure, owner, store } = await planning({ db });
      body(await configure([{ op: "upsert", kind: "bridge", value: { id: "porch", identity: "porch-bridge" } },
        { op: "delete", kind: "adopt", value: { device: "hall:lamp" } }]));
      const porchDoc = (reachMs: number) => a.home.message("porch-bridge", "devices",
        Buffer.from(JSON.stringify({ devices: [{ ...doc.devices[0], id: "0x01", reachMs }] })), false);
      porchDoc(0);
      const { revision } = body(await a.call(owner, "describe", {}));
      db.trouble.down = true;
      const pending = a.call(owner, "configure", { changes: [{ op: "upsert", kind: "route", value: { stable_identifier: "test:lamp",
        bridge: "porch" } }], expected_revision: revision, dry_run: false });
      // The route's write set waits for its commit; meanwhile the copy's document changes.
      await vi.waitFor(() => expect(store.down).toBe(true));
      porchDoc(3000);
      db.trouble.down = false;
      await vi.waitFor(async () => { clock.advance(1000); expect(a.home.devices.get("hall:lamp")?.bridge).toBe("porch"); });
      body(await pending);
      expect(a.home.devices.get("hall:lamp")!.doc.reach_ms).toBe(3000);
      // The store holds what memory holds: a restart reads the same rows.
      await vi.waitFor(() => { clock.advance(1000); expect(store.down).toBe(false); });
      a.stop();
      await store.close();
      const again = await make({ db });
      expect(again.a.home.devices.get("hall:lamp")).toMatchObject({ bridge: "porch", bridge_device: "0x01" });
      expect(again.a.home.devices.get("hall:lamp")!.doc.reach_ms).toBe(3000);
      expect(again.a.home.exposed().map((d) => d.id)).toEqual(["hall:lamp"]);
      expect(again.a.home.devices.get("porch:0x01")).toMatchObject({ bridge: "hall", into: "hall:lamp" });
    });

    it("tells the owner by a notice when the store's backlog reaches its cap", async () => {
      const { a, db, owner, configure } = await make({ backlogCap: 3 });
      body(await configure([bridge]));
      db.trouble.down = true;
      // Each new device is a row and a model event, both dropped past the cap.
      for (const id of ["lamp", "fan", "pump"]) send(a, "devices", { devices: [{ ...doc.devices[0], id, stableIdentifier: `test:${id}` }] });
      expect(body(await a.call(owner, "events", {})).notices).toMatchObject([{ cause: "store", text: expect.stringMatching(/history .*gap/) }]);
    });
  });
});

describe("candidates (slice 5b)", () => {
  const status = (at: number) => Buffer.from(JSON.stringify({ finderId: "f", instanceId: "i1", v: 1, levels: ["Find"],
    sources: [{ source: "dhcp", state: "off" }], faults: [], publishedAt: new Date(at).toISOString() }));

  it("answers the owner alone: none before the finder is heard, then live with its sources, then dead with its last list", async () => {
    const { a, owner, clock, configure } = await make();
    expect(body(await a.call(owner, "candidates", {}))).toEqual({ finder: "none", finder_sources: [], finder_faults: [], candidates: [], ignored_keys: [] });
    await configure([client("h")]);
    const refused = await a.call(a.caller("h-credential"), "candidates", {});
    expect(refused.ok ? "ok" : refused.error).toBe("not_permitted");
    a.finder.message("status", status(clock.now()), false);
    a.finder.message("candidates", Buffer.from(JSON.stringify({ publishedAt: new Date(clock.now()).toISOString(), candidates: [
      { id: "c1", sources: ["dhcp"], keys: ["mac:D4A651000001"], hints: {}, matches: [{ bridgeType: "esphome", connect: true }] }] })), false);
    expect(body(await a.call(owner, "candidates", {}))).toMatchObject({ finder: "live", finder_sources: [{ source: "dhcp", state: "off" }],
      candidates: [{ id: "c1" }] });
    clock.advance(31_000);
    expect(body(await a.call(owner, "candidates", {}))).toMatchObject({ finder: "dead", candidates: [{ id: "c1" }] });
    a.stop();
  });
});

describe("what candidates lists (slice 5b, GA-DISC-1, GA-DISC-2)", () => {
  const T = (ms: number) => new Date(ms).toISOString();
  const entry = (id: string, connections: string[]) => ({ id, stableIdentifier: `test:${id}`, transport: "radio", capabilities: ["onoff"],
    actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }], feedback: "closed", reachMs: 1000,
    proposedClass: "socket", classEvidence: "protocol", connections });
  const bridgeStatus = (identity: string, at: number) => ({ bridgeId: identity, instanceId: `${identity}-1`, v: 1, state: "online",
    levels: ["Serve", "Provision"], bridgeType: "esphome", faults: [], ungoverned: [], blocked: [],
    transports: [{ id: "radio", kind: "other", state: "up", since: T(at) }], devices: [], publishedAt: T(at) });
  const send = (a: Applier, identity: string, path: string, body: unknown, retained = false) =>
    a.home.message(identity, path, Buffer.from(JSON.stringify(body)), retained);
  const finderSays = (a: Applier, at: number, keys: string[][]) => {
    a.finder.message("status", Buffer.from(JSON.stringify({ finderId: "f", instanceId: "fi", v: 1, levels: ["Find"],
      sources: [{ source: "dhcp", state: "off" }], faults: [], publishedAt: T(at) })), false);
    a.finder.message("candidates", Buffer.from(JSON.stringify({ publishedAt: T(at), candidates: keys.map((k, i) => ({ id: `c${i + 1}`,
      sources: ["dhcp"], keys: k, hints: {}, matches: [{ bridgeType: "esphome", connect: true }] })) })), false);
  };

  /** A live bridge `esp` holding mac:01, a dead one `spare` (retained only) holding mac:02, and candidates c1 to c3. */
  async function home(mutation?: Mutation, db?: Awaited<ReturnType<typeof memoryDb>>) {
    const m = await make({ mutation, ...(db ? { db } : {}) });
    const { a, clock, configure } = m;
    await configure([client("h"), { op: "upsert", kind: "bridge", value: { id: "esp", identity: "esp" } },
      { op: "upsert", kind: "bridge", value: { id: "spare", identity: "spare" } }]);
    a.listening("esp");
    a.listening("spare");
    send(a, "esp", "devices", { devices: [entry("lamp", ["mac:01"])] }, true);
    send(a, "esp", "status", bridgeStatus("esp", clock.now()));
    send(a, "spare", "status", bridgeStatus("spare", clock.now()), true);
    send(a, "spare", "devices", { devices: [entry("plug", ["mac:02"])] }, true);
    finderSays(a, clock.now(), [["mac:01"], ["mac:02"], ["mac:03"]]);
    return m;
  }
  const ids = async (a: Applier) => (body(await a.call(a.caller(OWNER), "candidates", {})).candidates as { id: string }[]).map((c) => c.id);

  it.each([undefined, "lists-a-held-candidate"] as const)("hides a candidate a live or dead bridge holds, offering only live bridges; mutation %s", async (mutation) => {
    const { a } = await home(mutation);
    expect(await ids(a)).toEqual(mutation ? ["c2", "c3"] : ["c3"]);
    const r = body(await a.call(a.caller(OWNER), "candidates", {}));
    expect(r.candidates.find((c: { id: string }) => c.id === "c3").offers).toEqual([{ bridge_type: "esphome", connect: true, bridges: ["esp"] }]);
    a.stop();
  });

  it.each([undefined, "shows-candidates-to-a-client"] as const)("refuses a client's candidates; mutation %s", async (mutation) => {
    const { a } = await home(mutation);
    const r = await a.call(a.caller("h-credential"), "candidates", {});
    expect(r.ok ? "ok" : r.error).toBe(mutation ? "ok" : "not_permitted");
    a.stop();
  });

  it.each([undefined, "hides-the-finders-sources"] as const)("gives the finder's sources; mutation %s", async (mutation) => {
    const { a } = await home(mutation);
    expect(body(await a.call(a.caller(OWNER), "candidates", {})).finder_sources).toEqual(mutation ? [] : [{ source: "dhcp", state: "off" }]);
    a.stop();
  });

  it.each([undefined, "plans-on-a-candidate"] as const)("plans a step naming a candidate as skip(unknown_target); mutation %s", async (mutation) => {
    const { a } = await home(mutation);
    const plan = body(await a.call(a.caller("h-credential"), "plan", { actions: [{ target: "c3", action: "onoff.turn_on", args: {}, via: "app",
      brain: false, for: { person: "demo" } }] }));
    expect(plan.steps.map((x: { verdict: string; reason?: string }) => [x.verdict, x.reason])).toEqual([mutation ? ["op", undefined] : ["skip", "unknown_target"]]);
    a.stop();
  });

  it.each([undefined, "forgets-connections"] as const)("keeps a dead bridge's connections across a restart; mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const first = await home(mutation, db);
    expect(await ids(first.a)).toEqual(["c3"]);
    await first.store.settled();
    first.a.stop();
    await first.store.close();
    const again = await make({ db, mutation });
    again.a.listening("esp");
    again.a.listening("spare");
    send(again.a, "esp", "devices", { devices: [entry("lamp", ["mac:01"])] }, true);
    finderSays(again.a, again.clock.now(), [["mac:01"], ["mac:02"], ["mac:03"]]);
    expect(await ids(again.a)).toEqual(mutation ? ["c2", "c3"] : ["c3"]);
    again.a.stop();
  });
});


describe("undescribed names (applier 0.15, GA-DESC-19, GA-PERSIST-1)", () => {
  const T = (ms: number) => new Date(ms).toISOString();
  const send = (a: Applier, path: string, body: unknown, retained = false) => a.home.message("hall", path, Buffer.from(JSON.stringify(body)), retained);
  const doc = (names: string[]) => ({ devices: [{ id: "radar", stableIdentifier: "test:radar", transport: "radio", capabilities: ["sensor"],
    sensorKeys: ["occupancy"], actions: [], feedback: "closed", reachMs: 1000, proposedClass: "sensor", classEvidence: "protocol",
    undescribed: names.map((name) => ({ name, firstSeen: T(0) })) }] });
  const cursor = async (a: Applier) => body(await a.call(a.caller(OWNER), "events", {})).cursor as string;
  const announced = async (a: Applier, from: string) => (body(await a.call(a.caller(OWNER), "events", { cursor: from })).events as { type: string; name?: string }[])
    .filter((e) => e.type === "undescribed").map((e) => e.name);

  it.each([undefined, "forgets-announced-names"] as const)("announces a name once, across a restart too; mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const first = await make({ db, mutation });
    await first.configure([{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall" } }]);
    first.a.listening("hall");
    const c1 = await cursor(first.a);
    send(first.a, "devices", doc(["dp108"]), true);
    expect(await announced(first.a, c1)).toEqual(["dp108"]);
    await first.store.settled();
    first.a.stop();
    await first.store.close();
    const again = await make({ db, mutation });
    again.a.listening("hall");
    const c2 = await cursor(again.a);
    send(again.a, "devices", doc(["dp108", "dp109"]), true);
    expect(await announced(again.a, c2)).toEqual(mutation ? ["dp108", "dp109"] : ["dp109"]);
    again.a.stop();
  });
});

describe("ignores (slice 5b, GA-DISC-3, GA-CFG-2)", () => {
  const T = (ms: number) => new Date(ms).toISOString();
  const finderSays = (a: Applier, at: number) => {
    a.finder.message("status", Buffer.from(JSON.stringify({ finderId: "f", instanceId: "fi", v: 1, levels: ["Find"], sources: [], faults: [],
      publishedAt: T(at) })), false);
    a.finder.message("candidates", Buffer.from(JSON.stringify({ publishedAt: T(at), candidates: [
      { id: "c1", sources: ["dhcp"], keys: ["mac:01", "mdns:x"], hints: {}, matches: [] },
      { id: "c2", sources: ["mdns"], keys: ["mdns:x", "ip:192.0.2.9"], hints: {}, matches: [] },
      { id: "c3", sources: ["dhcp"], keys: ["mac:03"], hints: {}, matches: [] }] })), false);
  };
  const ignore = [{ op: "upsert", kind: "ignore_candidate", value: { id: "c1" } }];

  it.each([undefined, "ignore-moves-the-revision", "checks-revision-for-ignores"] as const)(
    "takes a set of only ignores with no expected_revision or a stale one, moving no revision; mutation %s", async (mutation) => {
      const { a, owner, clock, configure } = await make({ mutation });
      await configure([client("h")]);
      finderSays(a, clock.now());
      const { revision } = body(await a.call(owner, "describe", {}));
      const { cursor } = body(await a.call(owner, "events", {}));
      const none = await a.call(owner, "configure", { changes: ignore, dry_run: false });
      if (mutation === "checks-revision-for-ignores") {
        expect(none.ok ? "ok" : none.error).toBe("invalid_request");
        const stale = await a.call(owner, "configure", { changes: ignore, expected_revision: revision - 1, dry_run: false });
        expect(stale.ok ? "ok" : stale.error).toBe("stale_revision");
        a.stop();
        return;
      }
      expect(none.ok).toBe(true);
      const after = body(await a.call(owner, "describe", {})).revision;
      expect(after).toBe(mutation ? revision + 1 : revision);
      const unignore = await a.call(owner, "configure", { changes: [{ op: "upsert", kind: "unignore_candidate", value: { key: "mac:01" } }],
        expected_revision: revision - 1, dry_run: false });
      expect(unignore.ok).toBe(true);
      const r = body(await a.call(owner, "candidates", {}));
      expect(r.ignored_keys).toEqual(["mdns:x"]);
      expect(r.candidates.map((c: { id: string }) => c.id)).toEqual(["c3"]);
      const evs = body(await a.call(owner, "events", { cursor })).events as { type: string }[];
      expect(evs.some((e) => e.type === "model")).toBe(false);
      // Any other set still needs its expected_revision.
      const other = await a.call(owner, "configure", { changes: [client("k")], dry_run: false });
      expect(other.ok ? "ok" : other.error).toBe("invalid_request");
      a.stop();
    });

  it.each([undefined, "forgets-an-ignore"] as const)("keeps the ignores across a restart; mutation %s", async (mutation) => {
    const db = lasting(await memoryDb());
    const first = await make({ db, mutation });
    finderSays(first.a, first.clock.now());
    expect((await first.a.call(first.owner, "configure", { changes: ignore, dry_run: false })).ok).toBe(true);
    first.a.stop();
    await first.store.close();
    const again = await make({ db, mutation });
    finderSays(again.a, again.clock.now());
    const r = body(await again.a.call(again.owner, "candidates", {}));
    expect(r.candidates.map((c: { id: string }) => c.id)).toEqual(mutation ? ["c1", "c2", "c3"] : ["c3"]);
    expect(r.ignored_keys).toEqual(mutation ? [] : ["mac:01", "mdns:x"]);
    again.a.stop();
  });
});
