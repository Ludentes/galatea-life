import type { Clock } from "@ludentes/galatea-life-test-clock";

/** The transport `up` window: a successful exchange within the last 30 s (GA-BRIDGE-23). */
export const UP_WINDOW_MS = 30_000;
/** A health exchange at least every 10 s when nothing else has passed (GA-BRIDGE-23). */
export const EXCHANGE_MS = 10_000;
/** The backoff while `down`, from EXCHANGE_MS doubling to a 60 s ceiling, reached within 180 s (GA-BRIDGE-11). */
export const BACKOFF_CEILING_MS = 60_000;
/** How often the link checks whether an exchange is due, so that a change shows within 1 s (GA-BRIDGE-17). */
export const CHECK_MS = 1_000;

/** A coordinator answers or it does not: never `unknown`, which is for a transmitter that can answer nothing (GA-BRIDGE-72). */
export type TransportState = "up" | "down";

/**
 * The negative subjects that live in the link (bridge, *Negative subjects*): `resets-on-connect`
 * resets the backoff when the host link opens, `up-without-exchange` counts that opening as an
 * exchange. Honoured only under a run, as the core's are.
 */
export const LINK_MUTATIONS = ["resets-on-connect", "up-without-exchange"] as const;
export type LinkMutation = (typeof LINK_MUTATIONS)[number];

/**
 * A transport with an exchange window and a backoff: `up` only while an exchange succeeded within
 * the last 30 s. It holds facts and times; the doer calls it and reports what changes. The PC
 * bridge's host state, with the observer's presence replaced by the link: a link lost (the stack's
 * own word, a closed socket) is `down` at once, and its next try waits on the backoff.
 */
export class TransportLink {
  state: TransportState = "down";
  since: number;
  private lastSuccess: number | null = null;
  private nextAt: number;
  private retryMs = EXCHANGE_MS;
  /** Failed tries since the transport went `down`: the backoff's exponent. */
  private failuresDown = 0;
  /** Whether anything was tried yet: before the first try, there is no retry to show. */
  private tried = false;

  constructor(now: number, private readonly mutation?: LinkMutation) {
    this.since = now;
    this.nextAt = now;
  }

  /** The wait before the next try while `down` (the status's `retryIntervalMs`), or undefined while `up` or before any try. */
  get retryIntervalMs(): number | undefined {
    return this.state === "down" && this.tried ? this.retryMs : undefined;
  }

  /**
   * An exchange is due. A next time further off than any wait this class sets means the wall clock
   * stepped back: due at once. So does a last success "in the future".
   */
  due(now: number): boolean {
    if (this.lastSuccess !== null && this.lastSuccess > now) return true;
    return now >= this.nextAt || this.nextAt - now > BACKOFF_CEILING_MS;
  }

  /** The next exchange is due at once, the backoff kept: the link came back, or a command wants to know. */
  exchangeAtOnce(now: number): void {
    this.nextAt = now;
  }

  /** The outcome of one exchange: a health exchange, a read, or a message the device sent (a success). */
  exchanged(ok: boolean, now: number): void {
    this.tried = true;
    if (ok) {
      this.lastSuccess = now;
      this.failuresDown = 0;
      this.retryMs = EXCHANGE_MS;
      this.nextAt = now + EXCHANGE_MS;
      return;
    }
    // A success "in the future" was re-checked and failed: forgotten, so that `due` backs off (GA-BRIDGE-11).
    if (this.lastSuccess !== null && this.lastSuccess > now) this.lastSuccess = null;
    if (this.isUp(now)) {
      this.nextAt = now + EXCHANGE_MS;
      return;
    }
    this.backOff(now);
  }

  /**
   * The host link opened (the stack's controller started) with no exchange yet: no success, so
   * neither `up` (GA-BRIDGE-23) nor a reset of the backoff (GA-BRIDGE-11).
   */
  connected(now: number): void {
    if (this.mutation === "resets-on-connect") {
      this.failuresDown = 0;
      this.retryMs = EXCHANGE_MS;
    }
    if (this.mutation === "up-without-exchange") this.lastSuccess = now;
  }

  /** The link is gone, as the stack says it: `down` at the next evaluate, and the next try on the backoff. */
  lost(now: number): void {
    this.tried = true;
    this.lastSuccess = null;
    this.backOff(now);
  }

  /** Recomputes `state`; true when it changed. */
  evaluate(now: number): boolean {
    const next: TransportState = this.isUp(now) ? "up" : "down";
    if (next === this.state) return false;
    this.state = next;
    this.since = now;
    return true;
  }

  /** Down: 10, 20, 40, then 60 s between tries, the ceiling reached 70 s after the first failure. */
  private backOff(now: number): void {
    this.failuresDown += 1;
    this.retryMs = Math.min(EXCHANGE_MS * 2 ** (this.failuresDown - 1), BACKOFF_CEILING_MS);
    this.nextAt = now + this.retryMs;
  }

  /** A success "in the future" means the wall clock stepped back: it proves nothing about now. */
  private isUp(now: number): boolean {
    if (this.lastSuccess === null) return false;
    const age = now - this.lastSuccess;
    return age >= 0 && age <= UP_WINDOW_MS;
  }
}

/** What a doer reports to the core about its transport (the port's `transport`). */
export type TransportReport = (state: TransportState, since: number, retryIntervalMs?: number) => void;

export interface LinkOptions {
  clock: Clock;
  /**
   * One try: a health exchange while the link is up, or bringing the link back while it is down (the
   * herdsman doer rebuilds its controller). True when the coordinator answered.
   */
  probe(): Promise<boolean>;
  report: TransportReport;
  /** A negative mutation of the link, only under a run. */
  mutation?: LinkMutation;
}

/**
 * Drives a `TransportLink` on the clock: every second it tries an exchange when one is due, one at
 * a time, and reports the transport whenever its state or its `retryIntervalMs` changes. Each doer
 * owns one.
 */
export class Link {
  readonly t: TransportLink;
  private timer: number | null = null;
  private trying?: Promise<void>;
  private reported?: string;
  private running = false;
  /**
   * Counts the link's losses and stops. A try's outcome counts only in the generation it began in: a
   * probe still running when the link was lost answers for a link that is gone, so its success must
   * not show the coordinator `up`, and its failure must not back off a second time.
   */
  private generation = 0;

  constructor(private readonly o: LinkOptions) {
    this.t = new TransportLink(o.clock.now(), o.mutation);
  }

  /**
   * Reports the transport as it starts (`down`, nothing exchanged yet), then tries at once: after a
   * try still running from before a stop, whose answer no longer counts. A second start while
   * running does nothing, and resolves at once, before the first start's try is done.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.publish();
    this.schedule();
    while (this.trying) await this.trying;
    await this.check();
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    if (this.timer !== null) this.o.clock.clear(this.timer);
    this.timer = null;
  }

  /** A message from a device: an exchange that succeeded. */
  heard(): void {
    const now = this.o.clock.now();
    this.t.exchanged(true, now);
    this.t.evaluate(now);
    this.publish();
  }

  /** The host link opened, before its exchange: what the state shows, if anything changed. */
  connected(): void {
    const now = this.o.clock.now();
    this.t.connected(now);
    this.t.evaluate(now);
    this.publish();
  }

  /** The stack lost the link: `down` now, reported at once. */
  lost(): void {
    this.generation += 1;
    const now = this.o.clock.now();
    this.t.lost(now);
    this.t.evaluate(now);
    this.publish();
  }

  /**
   * Tries at once, and resolves when that try is done and reported. A try already running began
   * before this call, so it is waited for, and a new one made after it.
   */
  async exchangeNow(): Promise<void> {
    while (this.trying) await this.trying;
    this.t.exchangeAtOnce(this.o.clock.now());
    await this.check();
  }

  /** One pass: a try when one is due, then the state against now. */
  check(): Promise<void> {
    if (this.trying) return this.trying;
    this.trying = (async () => {
      if (this.running && this.t.due(this.o.clock.now())) {
        const began = this.generation;
        let ok = false;
        try {
          ok = await this.o.probe();
        } catch (err) {
          console.error(`transport: ${err}`);
        }
        // The link was lost, or stopped, while the probe ran: its answer is about a link that is gone.
        if (began === this.generation) this.t.exchanged(ok, this.o.clock.now());
      }
      this.t.evaluate(this.o.clock.now());
      this.publish();
    })().finally(() => { this.trying = undefined; });
    return this.trying;
  }

  private publish(): void {
    if (!this.running) return;
    const retry = this.t.retryIntervalMs;
    const shown = `${this.t.state} ${this.t.since} ${retry}`;
    if (shown === this.reported) return;
    this.reported = shown;
    this.o.report(this.t.state, this.t.since, retry);
  }

  /** Reschedules itself from its own callback, never an interval, so a clock step runs it once. */
  private schedule(): void {
    this.timer = this.o.clock.setTimeout(() => {
      if (!this.running) return;
      this.schedule();
      this.check().catch((err) => console.error(`transport: ${err}`));
    }, CHECK_MS);
  }
}
