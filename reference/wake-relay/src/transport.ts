/** The transport `up` window: a gateway answer within the last 30 s (GA-BRIDGE-23, GA-BRIDGE-55). */
export const UP_WINDOW_MS = 30_000;
/** A quiet transport's health exchange: at least every 10 s (GA-BRIDGE-23). */
export const PROBE_MS = 10_000;
/** The backoff while `down`, from PROBE_MS doubling to a 60 s ceiling, reached within 180 s (GA-BRIDGE-11). */
export const BACKOFF_CEILING_MS = 60_000;

export const RELAY_UP_WITHOUT_ARP = "relay-up-without-arp";

export type TransportState = "up" | "down";

/**
 * The LAN interface as a transport: `up` only while it has a carrier and the gateway answered ARP
 * within the last 30 s. It holds facts and times; the relay calls it and publishes what changes.
 */
export class LinkState {
  state: TransportState = "down";
  since: number;
  carrier = false;
  private lastAnswer: number | null = null;
  private nextProbeAt: number;
  private retryMs = PROBE_MS;
  /** Failed probes since the transport went `down`: the backoff's exponent. */
  private failuresDown = 0;

  constructor(now: number, private readonly mutation?: string) {
    this.since = now;
    this.nextProbeAt = now;
  }

  /** The wait before the next probe while `down` (the status's `retryIntervalMs`), or undefined while `up` or with no carrier. */
  get retryIntervalMs(): number | undefined {
    return this.state === "down" && this.carrier ? this.retryMs : undefined;
  }

  /**
   * A probe is due: the interface has a carrier and the next probe's time has come. A next time
   * further off than any wait this class sets means the wall clock stepped back: due at once. So does
   * an answer "in the future", after a step back too small for the first test.
   */
  probeDue(now: number): boolean {
    if (!this.carrier) return false;
    if (this.lastAnswer !== null && this.lastAnswer > now) return true;
    return now >= this.nextProbeAt || this.nextProbeAt - now > BACKOFF_CEILING_MS;
  }

  setCarrier(carrier: boolean, now: number): void {
    if (carrier && !this.carrier) this.nextProbeAt = now;
    this.carrier = carrier;
  }

  /** The outcome of one ARP exchange with the gateway. */
  probed(answered: boolean, now: number): void {
    if (answered) {
      this.lastAnswer = now;
      this.resetBackoff();
      this.nextProbeAt = now + PROBE_MS;
      return;
    }
    // An answer "in the future" was re-checked and failed: forgotten, so that `probeDue` backs off (GA-BRIDGE-11).
    if (this.lastAnswer !== null && this.lastAnswer > now) this.lastAnswer = null;
    if (this.isUp(now)) {
      this.nextProbeAt = now + PROBE_MS;
      return;
    }
    // Down: 10, 20, 40, then 60 s between probes, the ceiling reached 70 s after the first failure.
    this.failuresDown += 1;
    this.retryMs = Math.min(PROBE_MS * 2 ** (this.failuresDown - 1), BACKOFF_CEILING_MS);
    this.nextProbeAt = now + this.retryMs;
  }

  /** Only an answer resets the backoff (GA-BRIDGE-11); a carrier regained probes at once but keeps it. */
  private resetBackoff(): void {
    this.failuresDown = 0;
    this.retryMs = PROBE_MS;
  }

  /** Recomputes `state`; true when it changed. */
  evaluate(now: number): boolean {
    const next: TransportState = this.isUp(now) ? "up" : "down";
    if (next === this.state) return false;
    this.state = next;
    this.since = now;
    return true;
  }

  private isUp(now: number): boolean {
    if (!this.carrier) return false;
    if (this.mutation === RELAY_UP_WITHOUT_ARP) return true;
    if (this.lastAnswer === null) return false;
    // An answer "in the future" means the wall clock stepped back: it proves nothing about now.
    const age = now - this.lastAnswer;
    return age >= 0 && age <= UP_WINDOW_MS;
  }
}
