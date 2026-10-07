import { randomUUID } from "node:crypto";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Bridge } from "../config/config.js";
import { canonical, storable } from "../core/canonical.js";
import { RequestError, StoreUnavailable } from "../core/errors.js";
import { KEY_HELD_MS, Keys, type KeyClaim } from "../core/keys.js";
import { GATE_MS, within, type Store } from "../core/store.js";
import type { Puback } from "../bus/client.js";
import { cut, MAX_REASON, type BridgeEvent } from "../bus/wire.js";
import type { NoticeAsk } from "../model/home.js";
import { deviceId } from "../model/home.js";
import type { Mutation } from "../mutations.js";
import { opFor, type HomeView } from "./ops.js";
import type { Listed } from "./discovery.js";
import { loadRequests, pruneRequests, saveRequest, saveResult, type ProvisionResult } from "./records.js";

export type { ProvisionResult } from "./records.js";

/** How long a provisioning request waits for its reply (applier, *Constants*, "Provisioning reply awaited"). */
export const REPLY_MS = 2000;

/** A `connect` with no end this long after its publish ends `connect_failed(lost)` (applier, *Constants*). */
export const CONNECT_LOST_MS = 70_000;

/** The reply statuses of the bridge standard; any other is taken as `failed`, the least it can mean (GA-BUS-3). */
const REPLY_STATUSES = new Set(["ok", "accepted", "invalid_request", "failed"]);
/** The provisioning events the hardware did: their cause is `device`, unless they carry a request of ours. */
const DEVICE_ACTS = new Set(["joined", "left", "blocked_rejoin"]);

export interface ProvisionerOptions {
  store: Store;
  clock: Clock;
  mutation?: Mutation;
  home: HomeView;
  /** Publishes a request to a bridge; absent, every request is `unreachable`. */
  request?: (bridge: Bridge, op: string, body: Record<string, unknown>) => Promise<Puback>;
  /** What the broker made of a request to `bridge` (GA-BUS-9): its refusal code, or undefined for a success. */
  published: (bridge: string, refusedCode: number | undefined) => void;
  /** A fault of a bridge's (a reply naming another op than its request's): a `bridge_fault` event, and logged. */
  fault: (bridge: string, what: string) => void;
  /** Serves an event (and hands it to the writer). */
  emit: (type: string, body: Record<string, unknown>) => void;
  /** Raises a notice, kept until taken. */
  notice: (n: NoticeAsk & Record<string, unknown>) => void;
  log: (line: string) => void;
  /** The candidates listed now (slice 5b): what a `connect` may name. */
  listed?: () => Listed[];
}

type Args = Record<string, any>;
/** A request this life holds: the bridge it went to, and its result as it now stands. */
type Held = { bridge: string; result: ProvisionResult; created_ms: number };

/**
 * Provisioning (applier, *Provisioning*; the design, *A `provision` request's life*): each request
 * allowed (the caller's check), keyed, checked, recorded, published, answered. The owner's keys are
 * held in `Keys`, the requests in `provisions`, committed before their publish (the maintainer's ruling K1).
 */
export class Provisioner {
  private readonly keys: Keys<string>;
  /** Requests published and not yet answered: their 2 s wait. */
  private readonly waiting = new Map<string, { done: (r: ProvisionResult) => void; timer: number }>();
  /** Every request of this life, by request id: what a later reply updates. */
  private readonly held = new Map<string, Held>();
  /**
   * Each `connect` published and not yet ended (slice 5b): its bridge and its 70 s timer. Whether its
   * bridge was live at the publish needs no flag (K3): a death is only ever seen for a bridge alive until
   * then, so one dead at the publish is ended by a death only once it came back (the 5b preflight's M6).
   */
  private readonly open = new Map<string, { bridge: string; timer?: number }>();
  /** The `connect`s a start found not ended: each ends `lost` at the resume (K2). */
  private unended: { request_id: string; bridge: string }[] = [];

  constructor(private readonly o: ProvisionerOptions) {
    this.keys = new Keys<string>(() => o.clock.now());
  }

  /**
   * Reads the requests of the last 3600 s back (GA-PERSIST-1, GA-PROV-3): each into `held`, and each
   * keyed one's key into `Keys`, so a repeat is answered from its record. A result still `unreachable`
   * stays so: its request went out unanswered, or committed and was never published (a crash between),
   * and either way may not have arrived. Nothing is judged or armed.
   */
  async load(): Promise<void> {
    // Whole milliseconds, as every time the store keeps (the harness's clock gives fractions).
    for (const r of await loadRequests(this.o.store, Math.floor(this.o.clock.now()))) {
      this.held.set(r.request_id, { bridge: r.bridge, result: r.result, created_ms: r.created_ms });
      if (!r.ended) this.unended.push({ request_id: r.request_id, bridge: r.bridge });
      // `forgets-a-provision-key`: the records are read back, the keys not.
      if (r.key !== undefined && r.body !== undefined && this.o.mutation !== "forgets-a-provision-key") {
        this.keys.hold("owner", r.key, r.body, r.request_id, r.created_ms);
      }
    }
  }

  /**
   * After every module loaded: a `connect` the last life left in flight ends `connect_failed(lost)`
   * now, once (the maintainer's ruling K2), its bridge's answer having gone with that life's subscription.
   * `forgets-a-connect`: it is left waiting for ever.
   */
  resume(): void {
    const unended = this.unended;
    this.unended = [];
    if (this.o.mutation === "forgets-a-connect") return;
    for (const u of unended) {
      this.open.set(u.request_id, { bridge: u.bridge });
      this.lose(u.request_id);
    }
  }

  /**
   * A bridge alive until now was found dead: every `connect` open to it ends `lost`, one published while
   * it was dead too, since it came back since (K3; the text's "whose bridge dies", the 5b preflight's M6).
   */
  bridgeDied(bridge: string): void {
    for (const [id, o] of [...this.open]) if (o.bridge === bridge) this.lose(id);
  }

  /**
   * The broker is about to be lost (called before the model learns it): every bridge alive now dies with
   * it, so every `connect` open to one ends `lost`; one to a bridge already dead waits its 70 s (K3).
   */
  lost(): void {
    for (const [id, o] of [...this.open]) if (this.o.home.bridgeFacts(o.bridge)?.alive === true) this.lose(id);
  }

  /** Stops the timers (the applier's stop). */
  stop(): void {
    for (const o of this.open.values()) if (o.timer !== undefined) this.o.clock.clear(o.timer);
  }

  /** Forgets what is past its 3600 s, in memory and behind in the store; a request still waiting is kept. */
  prune(): void {
    const now = Math.floor(this.o.clock.now());
    this.keys.prune(now);
    for (const [id, h] of this.held) if (h.created_ms + KEY_HELD_MS <= now && !this.waiting.has(id)) this.held.delete(id);
    void this.o.store.write((tx) => pruneRequests(tx, now - KEY_HELD_MS), { droppable: true });
  }

  /** The owner's `provision`, its body already checked against `provision.request.json`. */
  async provision(a: Args): Promise<Record<string, unknown>> {
    const { idempotency_key: key, ...rest } = a;
    if (!storable(rest)) throw new RequestError("invalid_request", "provision carries a string the store cannot keep");
    const body = canonical(rest);
    // `provisions-twice`: the key is not honoured; every repeat is a new request.
    const keyed = typeof key === "string" && this.o.mutation !== "provisions-twice";
    let claim: KeyClaim<string> | undefined;
    if (keyed) {
      // The key first, before any check of the model (the spec review's I1); a request still running waits, within the gate.
      const deadline = this.o.clock.now() + GATE_MS;
      for (;;) {
        const c = this.keys.claim("owner", key, body);
        if (c.kind === "held") return { ...this.held.get(c.record)!.result };
        if (c.kind === "wait") {
          await within(this.o.clock, Math.max(0, deadline - this.o.clock.now()), c.done);
          continue;
        }
        claim = c.claim;
        break;
      }
    }
    try {
      const { op, bridge, wire } = opFor(rest, this.o.home, this.o.listed, this.o.mutation);
      // `opFor` resolved to a registered bridge, so its facts are there.
      const facts = this.o.home.bridgeFacts(bridge)!;
      if (!facts.levels.includes("Provision")) throw new RequestError("not_claimed", `bridge ${bridge}'s status does not claim Provision`);
      const requestId = randomUUID();
      // Whole milliseconds: the store keeps them as bigint, and the harness clock gives fractions.
      const created = Math.floor(this.o.clock.now());
      const result: ProvisionResult = { request_id: requestId, op, status: "unreachable" };
      this.held.set(requestId, { bridge, result, created_ms: created });
      if (claim) this.keys.kept(claim, requestId, created);
      // Committed before the publish, keyed or not (K1). Never sent late (the maintainer, 2026-10-05): a row that
      // lands after its caller's 10 s gate is not published; its record stays `unreachable`, its key held.
      let late = false;
      // A connect's row waits for its end (slice 5b): `ended` false, its 70 s from now.
      const connect = op === "connect";
      const committed = this.o.store.write((tx) => saveRequest(tx, { request_id: requestId, op, bridge,
        ...(keyed ? { key, body } : {}), result, created_ms: created, ...(connect ? { ends_ms: created + CONNECT_LOST_MS } : {}) }));
      const answered = committed.then(() => (late ? { ...result } : this.publish(bridge, facts.identity, op, requestId, wire, connect)));
      if (claim) {
        const c = claim;
        claim = undefined;
        void answered.then(() => this.keys.release(c), () => this.keys.forget(c));
      }
      return { ...await within(this.o.clock, GATE_MS, answered).catch((err: unknown) => {
        if (err instanceof StoreUnavailable) {
          late = true;
          // A connect never published never ends by itself: ended now, behind its row, so no start
          // ends it `lost` for a request the owner was never given (the 5b preflight's M3).
          if (connect) void this.o.store.write((tx) => saveResult(tx, result, true));
        }
        throw err;
      }) };
    } catch (err) {
      if (claim) this.keys.release(claim);
      throw err;
    }
  }

  /** Publishes, then waits up to 2 s for the reply; resolves with the result as it then stands. */
  private async publish(bridge: string, identity: string, op: string, requestId: string, wire: Record<string, unknown>,
    connect = false): Promise<ProvisionResult> {
    const reply = new Promise<ProvisionResult>((done) => {
      const timer = this.o.clock.setTimeout(() => this.settle(requestId), REPLY_MS);
      this.waiting.set(requestId, { done, timer });
    });
    const body = { requestId, issuedAt: new Date(Math.floor(this.o.clock.now())).toISOString(), ...wire };
    // A connect is open from just before its publish, so a reply that comes before the PUBACK finds it.
    // Its 70 s run from the publish; a bridge dead at it is answered unreachable at once (K3).
    const alive = this.o.home.bridgeFacts(bridge)?.alive === true;
    if (connect) this.opened(requestId, bridge);
    let p: Puback;
    try {
      p = this.o.request ? await this.o.request({ id: bridge, identity }, op, body) : { kind: "offline" };
    } catch (err) {
      this.o.log(`applier bug: a provisioning request threw: ${err instanceof Error ? err.message : String(err)}`);
      p = { kind: "offline" };
    }
    if (p.kind === "ok" || p.kind === "refused") this.o.published(bridge, p.kind === "refused" ? p.code : undefined);
    // Refused, no subscriber, or never sent: unreachable at once. A PUBACK lost may have arrived: it waits its 2 s.
    if (p.kind === "refused" || p.kind === "no_subscribers" || p.kind === "offline") this.settle(requestId);
    if (connect && !alive) this.settle(requestId);
    return reply;
  }

  /** A `connect` published: it ends at a reply other than `accepted`, its bridge's event, 70 s, or its bridge's death. */
  private opened(requestId: string, bridge: string): void {
    // `never-ends-a-connect`: no timer; only the bridge's own event ends it.
    const timer = this.o.mutation === "never-ends-a-connect" ? undefined
      : this.o.clock.setTimeout(() => this.lose(requestId), CONNECT_LOST_MS);
    this.open.set(requestId, { bridge, ...(timer !== undefined ? { timer } : {}) });
  }

  /** Takes a `connect` out of `open`, its timer cleared: true when it was still open. */
  private close(requestId: string): boolean {
    const o = this.open.get(requestId);
    if (!o) return false;
    this.open.delete(requestId);
    if (o.timer !== undefined) this.o.clock.clear(o.timer);
    return true;
  }

  /**
   * A `connect` in flight ends `connect_failed(lost)`: one `provision` event, and its row ended in the
   * same write set (the 5b preflight's M4). The record keeps what the bridge said: the applier's own
   * `lost` is no outcome of the bridge's (GA-PROV-3; the controller's ruling on the preflight's I2).
   */
  private lose(requestId: string): void {
    const bridge = this.open.get(requestId)?.bridge;
    if (bridge === undefined || !this.close(requestId)) return;
    this.o.store.group(() => {
      this.o.emit("provision", this.connectBody(bridge, "connect_failed", requestId, { reason: "lost" }));
      this.ended(requestId);
    });
  }

  /**
   * The `provision` event of a `connect`'s end: it carries the `request_id` `provision` returned, and its
   * cause is that request; `event-without-request-id` leaves it out, the cause then the bridge.
   */
  private connectBody(bridge: string, what: string, requestId: string, extra: Record<string, unknown>): Record<string, unknown> {
    if (this.o.mutation === "event-without-request-id") return { bridge, what, ...extra, cause: "bridge" };
    return { bridge, what, ...extra, request_id: requestId, cause: { provision: requestId } };
  }

  /**
   * A `connect`'s row at its end, written `ended`: its record as it stands, `accepted` when `heard` (an
   * event of the bridge's carrying its requestId) found it still `unreachable`, as GA-PROV-3 keeps it.
   */
  private ended(requestId: string, heard = false): void {
    const h = this.held.get(requestId);
    const result: ProvisionResult = h?.result ?? { request_id: requestId, op: "connect", status: "unreachable" };
    const next: ProvisionResult = heard && result.status === "unreachable" ? { ...result, status: "accepted" } : result;
    if (h) h.result = next;
    void this.o.store.write((tx) => saveResult(tx, next, true));
  }

  /**
   * Ends a request's 2 s wait, once, with its result as it now stands; with `saved`, once that write of
   * it has committed, so the owner is never told a result a crash could take back (the caller's 10 s
   * gate still bounds the wait).
   */
  private settle(requestId: string, saved?: Promise<void>): void {
    const w = this.waiting.get(requestId);
    if (!w) return;
    this.waiting.delete(requestId);
    this.o.clock.clear(w.timer);
    const result = { ...this.held.get(requestId)!.result };
    if (saved) void saved.then(() => w.done(result));
    else w.done(result);
  }

  /**
   * A bridge's reply (not a snapshot's), routed on its `requestId`: only the bridge the request went to
   * answers it, and a reply naming another `op` than its request's is a fault of the bridge's and no
   * answer (GA-BUS-3's least meaning). It replaces the request's result, in memory and in the store,
   * and ends its wait, if it still waits, once that write has committed; a later reply is written behind.
   * True when the reply was that request's, a faulty one included.
   */
  reply(bridge: string, b: Record<string, unknown>): boolean {
    const h = this.held.get(b.requestId as string);
    if (!h || h.bridge !== bridge) return false;
    if (b.op !== h.result.op) {
      this.o.fault(bridge, `a reply to ${h.result.op} request ${h.result.request_id} names op ${JSON.stringify(b.op)}`);
      return true;
    }
    const status = typeof b.status === "string" && REPLY_STATUSES.has(b.status) ? b.status as ProvisionResult["status"] : "failed";
    const reason = typeof b.reason === "string" ? b.reason : status === "failed" && b.status !== "failed" ? "unknown_status" : undefined;
    const extra = { ...(b.data !== undefined ? { data: b.data } : {}), ...(reason !== undefined ? { reason } : {}) };
    // What the store cannot keep is not kept: a reply that carries it keeps its status alone.
    const next: ProvisionResult = { request_id: h.result.request_id, op: h.result.op, status, ...(storable(extra) ? extra : {}) };
    h.result = next;
    // A connect's reply other than `accepted` (`failed(busy)`, `invalid_request`) is its end: no 70 s,
    // no death and no restart ends it again (the 5b preflight's I1).
    const ends = next.op === "connect" && next.status !== "accepted" && this.close(next.request_id);
    const saved = this.o.store.write((tx) => saveResult(tx, next, ends || undefined));
    this.settle(next.request_id, saved);
    return true;
  }

  /**
   * A `connect` of ours ended by its bridge: `connected` naming the device it now holds, or
   * `connect_failed` with its reason. Issued even after it ended `lost`; its record becomes `accepted` if still `unreachable`.
   */
  private connectEnded(bridge: string, type: string, requestId: string, b: Record<string, unknown>): void {
    this.close(requestId);
    const str = (x: unknown): x is string => typeof x === "string" && x !== "" && storable(x);
    const device = str(b.device) ? this.o.home.idFor(bridge, b.device) : undefined;
    const reason = str(b.reason) ? cut(b.reason, MAX_REASON) : undefined;
    this.o.store.group(() => {
      this.o.emit("provision", this.connectBody(bridge, type, requestId, { ...(device !== undefined ? { device } : {}),
        ...(reason !== undefined ? { reason } : {}) }));
      this.ended(requestId, true);
    });
  }

  /**
   * A bridge's provisioning event, taken once by its `seq` (the design, *The `provision` event*): one
   * `provision` event, its ids the applier's, with its cause; a `window_closed` also a notice, one per
   * window, an empty one included (the maintainer's ruling K4). An event carrying a request this life holds
   * whose record is still `unreachable` records `accepted`: the bridge took it. Provisional: the text
   * names neither `what` nor `cause` (the spec review's I5).
   */
  event(bridge: string, e: BridgeEvent): void {
    const b = e.body;
    if ((e.type === "connected" || e.type === "connect_failed") && typeof b.requestId === "string") {
      const h = this.held.get(b.requestId);
      if (h !== undefined && h.bridge === bridge && h.result.op === "connect") return this.connectEnded(bridge, e.type, b.requestId, b);
    }
    // An empty string, or one the store cannot keep, is left out, as a bridge's other malformed fields are.
    const str = (x: unknown): x is string => typeof x === "string" && x !== "" && storable(x);
    const requestId = str(b.requestId) ? b.requestId : undefined;
    const held = requestId === undefined ? undefined : this.held.get(requestId);
    const mine = held !== undefined && held.bridge === bridge;
    const devices = Array.isArray(b.devices) ? b.devices.filter(str).map((d) => this.o.home.idFor(bridge, d)) : undefined;
    const transport = str(b.transport) ? this.o.home.transportHeld(deviceId(bridge, b.transport))?.id : undefined;
    const cause = mine ? { provision: requestId } : DEVICE_ACTS.has(e.type) && requestId === undefined ? "device" : "bridge";
    const body: Record<string, unknown> = {
      bridge, what: e.type,
      ...(transport !== undefined ? { transport } : {}),
      ...(devices ? { devices } : {}),
      ...(str(b.device) ? { device: this.o.home.idFor(bridge, b.device) } : {}),
      ...(str(b.identifier) ? { identifier: b.identifier } : {}),
      ...(requestId !== undefined ? { request_id: requestId } : {}),
      ...(str(b.reason) ? { reason: cut(b.reason, MAX_REASON) } : {}),
      ...(typeof b.windowMs === "number" && Number.isFinite(b.windowMs) ? { window_s: Math.round(b.windowMs / 1000) } : {}),
      cause,
    };
    this.o.emit("provision", body);
    if (mine && held.result.status === "unreachable") {
      const next: ProvisionResult = { ...held.result, status: "accepted" };
      held.result = next;
      void this.o.store.write((tx) => saveResult(tx, next));
    }
    // `hides-new-devices`: a closed window is no notice.
    if (e.type === "window_closed" && this.o.mutation !== "hides-new-devices") {
      const named = devices ?? [];
      const where = transport ?? bridge;
      this.o.notice({ cause: "window_closed", bridge, ...(transport !== undefined ? { transport } : {}), devices: named,
        text: named.length ? `A join window closed on ${where}; joined: ${named.join(", ")}. Each is new and unadopted.`
          : `A join window closed on ${where}; nothing joined.` });
    }
  }
}
