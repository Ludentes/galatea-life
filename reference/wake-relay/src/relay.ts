import { validate } from "@ludentes/galatea-life-schemas";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Entry } from "./config.js";
import type { Link } from "./link.js";
import { magicPacket } from "./packet.js";
import { UnsupportedOp } from "./test-link.js";
import { LinkState } from "./transport.js";
import { Refused, type Delivery, type Wire } from "./wire.js";

export const VERSION = "0.1.0";
export const TRANSPORT_ID = "lan";
export const RELAY_ENTRY_CLOSED = "relay-entry-closed";

/** `status` at least every 10 s (GA-BRIDGE-17). */
export const STATUS_MS = 10_000;
/** The carrier is read, and a due probe made, every second, so a lost link shows within 1 s. */
export const CHECK_MS = 1_000;
/** A request repeated by `requestId` within 10 s gets the first reply (GA-BRIDGE-4). */
export const DUPLICATE_REQUEST_MS = 10_000;
/** A `commandId` is remembered for at least its `resultWithinMs`, and never less than this. */
export const COMMAND_MEMORY_MS = 60_000;
/** A stop not done within this cuts the connection: the broker may be away. */
export const LEAVE_MS = 5_000;

export interface RelayOptions {
  bridgeId: string;
  instanceId: string;
  root: string;
  clock: Clock;
  entries: Entry[];
  link: Link;
  wire: Wire;
  /** Only under a run (GA-BRIDGE-16). */
  runId?: string;
  /** The test transport: its control topic, and its ops (`stall` is the relay's own). */
  control?: { topic: string; handle(msg: Record<string, unknown>): void };
  /** A negative mutation, honoured only with a run id. */
  mutation?: string;
}

type Ack = { commandId: string; source: string; result: string; reason?: string; detail?: string; timestamp: string };
type Reply = { requestId: string; op: string; status: string; data?: unknown; reason?: string };
type Fault = { code: string; topic?: string; device?: string; detail?: string };

const wireTime = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A wake relay at level Serve: Wake-on-LAN for the entries its owner configured (GA-BRIDGE-55). */
export class Relay {
  private readonly base: string;
  private readonly transport: LinkState;
  private readonly mutation?: string;
  private readonly faults: Fault[] = [];
  private readonly commands = new Map<string, { ack?: Ack; keepUntil: number }>();
  private readonly requests = new Map<string, { reply?: Reply; keepUntil: number }>();
  private readonly timers = new Set<number>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private checking?: Promise<void>;
  private checkAgain = false;
  private stalledUntil = 0;
  private stopped = false;

  constructor(private readonly o: RelayOptions) {
    this.base = `${o.root}/bridges/${o.bridgeId}`;
    this.mutation = o.runId ? o.mutation : undefined;
    this.transport = new LinkState(o.clock.now(), this.mutation);
  }

  private get filters(): string[] {
    return [`${this.base}/devices/+/command`, `${this.base}/request/+`, ...(this.o.control ? [this.o.control.topic] : [])];
  }

  /** Subscribes before the first `status` (GA-BRIDGE-18), clears `lwt`, reads the link, then `devices` and `status`. */
  async start(): Promise<void> {
    this.o.wire.onMessage((d) => this.track(this.onDelivery(d, this.o.clock.now())));
    this.o.wire.onReconnect(() => this.track(this.reconnected()));
    await this.subscribe();
    await this.publish(`${this.base}/lwt`, "", true);
    await this.readLink();
    // The declarations before the first status, so no reader sees a device it has no declaration for.
    await this.publishDevices();
    await this.publishStatus();
    this.every(() => this.publishStatus(), STATUS_MS);
    this.every(() => this.tick(), CHECK_MS);
  }

  /** GA-BRIDGE-22: unsubscribe and wait, finish what is in flight, a graceful `offline`, `lwt` cleared, a clean disconnect. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.timers) this.o.clock.clear(h);
    const cut = { value: false };
    if (!(await this.within(this.leave(cut), LEAVE_MS))) {
      // Cut: what the stop has not done is left undone.
      cut.value = true;
      console.error(`stop: not done within ${LEAVE_MS} ms; the connection is cut`);
      await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
    }
    await this.o.link.close();
  }

  /** GA-BRIDGE-22's steps; with the broker away, only the waits that need no broker (its will has fired already). */
  private async leave(cut: { value: boolean }): Promise<void> {
    if (this.o.wire.connected()) {
      await this.o.wire.unsubscribe(this.filters).catch((err) => console.error(`unsubscribe: ${err}`));
    }
    await Promise.allSettled([...this.inFlight]);
    if (cut.value) return;
    if (!this.o.wire.connected()) {
      await this.o.wire.drop().catch((err) => console.error(`drop: ${err}`));
      return;
    }
    await this.publishStatus({ state: "offline", graceful: true });
    if (cut.value) return;
    await this.publish(`${this.base}/lwt`, "", true);
    if (cut.value) return;
    await this.o.wire.end().catch((err) => console.error(`disconnect: ${err}`));
  }

  /** Whether `p` settles within `ms` of the clock. */
  private async within(p: Promise<unknown>, ms: number): Promise<boolean> {
    let handle = 0;
    const late = new Promise<boolean>((r) => { handle = this.o.clock.setTimeout(() => r(false), ms); });
    const inTime = await Promise.race([p.then(() => true, () => true), late]);
    this.o.clock.clear(handle);
    return inTime;
  }

  // --- The transport -------------------------------------------------------------------------

  /** A carrier lost shows at once, even while a probe waits on its answer (GA-BRIDGE-17's 1 s); then a check. */
  private async tick(): Promise<void> {
    const t = this.transport;
    if (!(await this.o.link.carrier())) {
      t.setCarrier(false, this.o.clock.now());
      if (t.evaluate(this.o.clock.now())) await this.publishStatus();
    }
    await this.check();
  }

  /** Reads the carrier, probes the gateway when due, and publishes a status when the state changed. */
  private check(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.checkAgain = false;
        if (await this.readLink()) await this.publishStatus();
      } while (this.checkAgain && !this.stopped);
    })().finally(() => { this.checking = undefined; });
    return this.checking;
  }

  /** Reads the carrier, probes the gateway when due, and recomputes the state; true when it changed. */
  private async readLink(): Promise<boolean> {
    const t = this.transport;
    t.setCarrier(await this.o.link.carrier(), this.o.clock.now());
    if (t.probeDue(this.o.clock.now())) t.probed(await this.o.link.arp(), this.o.clock.now());
    return t.evaluate(this.o.clock.now());
  }

  // --- What the relay publishes ----------------------------------------------------------------

  private get observable(): boolean {
    return this.transport.state === "up";
  }

  private async publishStatus(extra: Record<string, unknown> = {}): Promise<void> {
    await this.whenFree();
    // Not while the broker is away: the client would queue it and deliver it stale before the
    // resubscription; the reconnection publishes a fresh one after it (GA-BRIDGE-18).
    if (!this.o.wire.connected()) return;
    const now = this.o.clock.now();
    const t = this.transport;
    const retry = t.retryIntervalMs;
    const status: Record<string, unknown> = {
      bridgeId: this.o.bridgeId,
      instanceId: this.o.instanceId,
      v: 1,
      state: this.o.entries.length === 0 || this.observable ? "online" : "offline",
      version: VERSION,
      levels: ["Serve"],
      faults: [...this.faults],
      ungoverned: [],
      blocked: [],
      transports: [{ id: TRANSPORT_ID, kind: "other", state: t.state, since: wireTime(t.since),
        ...(retry !== undefined ? { retryIntervalMs: retry } : {}) }],
      // A `feedback: open` device has no check-ins: its liveness is its transport's.
      devices: this.o.entries.map((e) => ({
        id: e.id, transport: TRANSPORT_ID, basis: "none", cadenceMs: null, basisMaxAgeMs: null, timestamp: null,
        lastCheckIn: null, observable: this.observable, since: wireTime(t.since),
      })),
      publishedAt: wireTime(now),
      ...extra,
    };
    if (this.o.runId) status.testRunId = this.o.runId;
    await this.publish(`${this.base}/status`, status, true);
  }

  private async publishDevices(): Promise<void> {
    const closed = this.mutation === RELAY_ENTRY_CLOSED;
    await this.publish(`${this.base}/devices`, {
      publishedAt: wireTime(this.o.clock.now()),
      devices: this.o.entries.map((e) => ({
        id: e.id,
        stableIdentifier: e.mac,
        transport: TRANSPORT_ID,
        model: { vendor: "wake-on-lan", model: "magic-packet" },
        capabilities: ["power"],
        sensorKeys: [],
        actions: [{ action: "power.wake", idempotent: true, stateless: true, confirms: false }],
        feedback: closed ? "closed" : "open",
        reachMs: 0,
        proposedClass: null,
        classEvidence: "none",
        // Wake-on-LAN shows no other controller, and anything on the segment can send the packet.
        otherAdmins: "unknown",
        connections: [`mac:${e.mac}`],
        ...(closed ? {} : { internal: true }),
      })),
    }, true);
  }

  private async publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
    try {
      await this.o.wire.publish(topic, payload, retain);
      // Accepted now: an earlier refusal no longer holds, and the next status says so.
      this.clearFault("publish_refused", topic);
    } catch (err) {
      if (err instanceof Refused) this.addFault({ code: "publish_refused", topic: err.topic });
      else console.error(`publish ${topic}: ${err}`);
    }
  }

  private addFault(f: Fault): void {
    if (!this.faults.some((x) => x.code === f.code && x.topic === f.topic)) this.faults.push(f);
  }

  private clearFault(code: string, topic: string): void {
    const i = this.faults.findIndex((x) => x.code === code && x.topic === topic);
    if (i >= 0) this.faults.splice(i, 1);
  }

  /** Every filter is asked for again: one granted now clears its refusal, one refused now is a fault (GA-BRIDGE-20). */
  private async subscribe(): Promise<void> {
    const refused = await this.o.wire.subscribe(this.filters);
    for (const topic of this.filters) {
      if (refused.includes(topic)) this.addFault({ code: "subscribe_refused", topic });
      else this.clearFault("subscribe_refused", topic);
    }
  }

  /** The session is clean, so the broker forgot the subscriptions: subscribed again before `status` (GA-BRIDGE-9, GA-BRIDGE-18). */
  private async reconnected(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.subscribe();
    } catch (err) {
      // No SUBACK: the connection closed first, and its next connect renews them; no status without them.
      console.error(`resubscribe: ${err}`);
      return;
    }
    await this.publish(`${this.base}/lwt`, "", true);
    await this.publishDevices();
    await this.publishStatus();
  }

  // --- What the relay receives -----------------------------------------------------------------

  private async onDelivery(d: Delivery, receivedAt: number): Promise<void> {
    await this.whenFree();
    if (this.o.control && d.topic === this.o.control.topic) return this.stopped ? undefined : this.onControl(d);
    // A retained command or request is never acted on (GA-BRIDGE-19).
    if (d.retained) return;
    const command = d.topic.match(/\/devices\/([^/]+)\/command$/);
    // A command the broker delivers while stopping still gets its one ack (GA-BRIDGE-4, GA-BRIDGE-22).
    if (command && d.topic.startsWith(`${this.base}/`)) return this.onCommand(command[1]!, d, receivedAt);
    if (this.stopped) return;
    const request = d.topic.match(/\/request\/([^/]+)$/);
    if (request && d.topic.startsWith(`${this.base}/`)) return this.onRequest(request[1]!, d, receivedAt);
  }

  private async onCommand(id: string, d: Delivery, receivedAt: number): Promise<void> {
    let cmd: Record<string, any>;
    try {
      cmd = JSON.parse(d.payload.toString());
    } catch {
      return;
    }
    if (!cmd || typeof cmd !== "object" || typeof cmd.commandId !== "string") return;
    const commandId: string = cmd.commandId;
    this.prune(receivedAt);
    // A repeated commandId gets the first ack, or nothing while the first runs, and does nothing more (GA-BRIDGE-4).
    const seen = this.commands.get(commandId);
    if (seen) {
      if (seen.ack) await this.publish(this.ackTopic(id), seen.ack, false);
      return;
    }
    const within = Number.isInteger(cmd.resultWithinMs) && cmd.resultWithinMs >= 0 ? (cmd.resultWithinMs as number) : 0;
    this.commands.set(commandId, { keepUntil: receivedAt + Math.max(within, COMMAND_MEMORY_MS) });
    const errors = validate("bridge/command.json", cmd);
    if (errors.length) return this.ack(id, commandId, "failed", "invalid_request", errors.join("; "));
    const entry = this.o.entries.find((e) => e.id === id);
    if (!entry) return this.ack(id, commandId, "failed", "unknown_device", `no device ${id}`);
    // The command's time: the lesser of the Message Expiry left on delivery and resultWithinMs from receipt.
    const deadline = receivedAt + Math.min(within, d.expirySeconds !== undefined ? d.expirySeconds * 1000 : Infinity);
    // A clock that stepped back since receipt says nothing of the time left: expired, never stretched.
    const now = this.o.clock.now();
    if (now > deadline || now < receivedAt) return this.ack(id, commandId, "failed", "expired");
    const value = cmd.value as Record<string, unknown>;
    if (value.action !== "power.wake") return this.ack(id, commandId, "unsupported", undefined, `${String(value.action)} is not offered`);
    const unknown = Object.keys(value).filter((k) => k !== "action" && k !== "value" && k !== "state");
    if (value.value !== undefined || unknown.length) {
      return this.ack(id, commandId, "failed", "invalid_request", "power.wake takes no argument");
    }
    // Nothing was transmitted: `unreachable` while stopping, as for a command in flight (GA-BRIDGE-22).
    if (this.stopped) return this.ack(id, commandId, "failed", "unreachable", "the relay is stopping");
    if (this.transport.state !== "up") return this.ack(id, commandId, "failed", "unreachable", "the LAN interface is down");
    try {
      await this.o.link.send(entry, magicPacket(entry.mac));
    } catch (err) {
      return this.ack(id, commandId, "failed", "send_failed", (err as Error).message);
    }
    // A magic packet confirms nothing: `sent`, as power.wake is declared confirms: false (GA-BRIDGE-8).
    return this.ack(id, commandId, "sent");
  }

  private async onRequest(op: string, d: Delivery, receivedAt: number): Promise<void> {
    let req: Record<string, any>;
    try {
      req = JSON.parse(d.payload.toString());
    } catch {
      return;
    }
    if (!req || typeof req !== "object" || typeof req.requestId !== "string") return;
    const requestId: string = req.requestId;
    this.prune(receivedAt);
    const seen = this.requests.get(requestId);
    if (seen) {
      if (seen.reply) await this.publish(`${this.base}/reply`, seen.reply, false);
      return;
    }
    this.requests.set(requestId, { keepUntil: receivedAt + DUPLICATE_REQUEST_MS });
    if (validate("bridge/request.json", req).length) return this.reply({ requestId, op, status: "invalid_request" });
    if (op === "snapshot") {
      // No device of the relay has a status of its own: nothing is observed (GA-BRIDGE-30).
      await this.publishDevices();
      await this.publishStatus();
      return this.reply({ requestId, op, status: "ok", data: {} });
    }
    // At Serve with no join window, no provisioning and no plugins, every other op is invalid here.
    return this.reply({ requestId, op, status: "invalid_request" });
  }

  private async onControl(d: Delivery): Promise<void> {
    const topic = `${this.o.control!.topic}/reply`;
    let msg: Record<string, unknown> = {};
    try {
      msg = JSON.parse(d.payload.toString());
      const errors = validate("harness/test-control.json", msg);
      if (errors.length) throw new Error(errors.join("; "));
      if (msg.op === "stall") this.stalledUntil = Date.now() + (msg.ms as number);
      else {
        // The interface as the harness set it, read at once: a lost carrier is down, a regained one
        // probes; a gateway that answers again is heard on the probe cadence, as on a real LAN.
        this.o.control!.handle(msg);
        await this.check();
      }
      await this.publish(topic, { requestId: msg.requestId, ok: true }, false);
    } catch (err) {
      await this.publish(topic, { requestId: String(msg.requestId ?? ""), ok: false, error: String((err as Error).message ?? err),
        ...(err instanceof UnsupportedOp ? { unsupported: true } : {}) }, false);
    }
  }

  private async ack(id: string, commandId: string, result: string, reason?: string, detail?: string): Promise<void> {
    const ack: Ack = { commandId, source: this.o.bridgeId, result, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}),
      timestamp: wireTime(this.o.clock.now()) };
    const record = this.commands.get(commandId);
    if (record) record.ack = ack;
    await this.publish(this.ackTopic(id), ack, false);
  }

  private async reply(r: Reply): Promise<void> {
    const record = this.requests.get(r.requestId);
    if (record) record.reply = r;
    await this.publish(`${this.base}/reply`, r, false);
  }

  private ackTopic(id: string): string {
    return `${this.base}/devices/${id}/ack`;
  }

  /** Forgets what has had its answer and its time; one still running is kept, however the clock stepped, so its repeat never runs it twice. */
  private prune(now: number): void {
    for (const [k, v] of this.commands) if (v.ack && now > v.keepUntil) this.commands.delete(k);
    for (const [k, v] of this.requests) if (v.reply && now > v.keepUntil) this.requests.delete(k);
  }

  // --- Time and the main loop ------------------------------------------------------------------

  /** Keeps a handler's promise until it settles, so `stop` can wait for what is in flight. */
  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err) => console.error(err)).finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private later(fn: () => unknown, ms: number): void {
    const h = this.o.clock.setTimeout(() => {
      this.timers.delete(h);
      if (!this.stopped) this.track(Promise.resolve().then(fn));
    }, ms);
    this.timers.add(h);
  }

  /** Runs `fn` every `ms` of the clock, rescheduling after each run, so a clock step runs it once. */
  private every(fn: () => unknown, ms: number): void {
    const tick = () => {
      this.later(tick, ms);
      return fn();
    };
    this.later(tick, ms);
  }

  /** The harness's `stall`: the main loop waits, as a hung loop would (real time). */
  private async whenFree(): Promise<void> {
    const wait = this.stalledUntil - Date.now();
    if (wait > 0) await sleep(wait);
  }
}
