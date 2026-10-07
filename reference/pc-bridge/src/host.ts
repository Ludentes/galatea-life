/** The transport `up` window: a successful observation within the last 30 s (GA-BRIDGE-23). */
export const UP_WINDOW_MS = 30_000;
/** The host is observed at least every 10 s (GA-BRIDGE-23, GA-BRIDGE-37). */
export const OBSERVE_MS = 10_000;
/** The backoff while `down`, from OBSERVE_MS doubling to a 60 s ceiling, reached within 180 s (GA-BRIDGE-11). */
export const BACKOFF_CEILING_MS = 60_000;

export type TransportState = "up" | "down";

/**
 * The host as a transport: `up` only while the OS's observer is there and an observation succeeded
 * within the last 30 s. It holds facts and times; the bridge calls it and publishes what changes.
 */
export class HostState {
  state: TransportState = "down";
  since: number;
  present = false;
  private lastSuccess: number | null = null;
  private nextAt: number;
  private retryMs = OBSERVE_MS;
  /** Failed observations since the transport went `down`: the backoff's exponent. */
  private failuresDown = 0;

  constructor(now: number) {
    this.since = now;
    this.nextAt = now;
  }

  /** The wait before the next observation while `down` (the status's `retryIntervalMs`), or undefined while `up` or with no observer. */
  get retryIntervalMs(): number | undefined {
    return this.state === "down" && this.present ? this.retryMs : undefined;
  }

  /**
   * An observation is due: the observer is there and the next one's time has come. A next time
   * further off than any wait this class sets means the wall clock stepped back: due at once. So does
   * a last success "in the future", after a step back too small for the first test: it makes the
   * transport `down` until re-checked, so it is re-checked now, not at the next due time up to 10 s on.
   */
  due(now: number): boolean {
    if (!this.present) return false;
    if (this.lastSuccess !== null && this.lastSuccess > now) return true;
    return now >= this.nextAt || this.nextAt - now > BACKOFF_CEILING_MS;
  }

  /** An observer regained is observed at once; one lost is `down` at the next evaluate. */
  setPresent(present: boolean, now: number): void {
    if (present && !this.present) this.nextAt = now;
    this.present = present;
  }

  /** At a resume the last observation says nothing about now: the next is due at once, the backoff kept. */
  observeAtOnce(now: number): void {
    this.nextAt = now;
  }

  /** The outcome of one observation. */
  observed(ok: boolean, now: number): void {
    if (ok) {
      this.lastSuccess = now;
      this.failuresDown = 0;
      this.retryMs = OBSERVE_MS;
      this.nextAt = now + OBSERVE_MS;
      return;
    }
    // A success "in the future" was re-checked and failed: forgotten, so that `due` backs off (GA-BRIDGE-11)
    // instead of finding it still ahead and observing every second.
    if (this.lastSuccess !== null && this.lastSuccess > now) this.lastSuccess = null;
    if (this.isUp(now)) {
      this.nextAt = now + OBSERVE_MS;
      return;
    }
    // Down: 10, 20, 40, then 60 s between tries, the ceiling reached 70 s after the first failure.
    this.failuresDown += 1;
    this.retryMs = Math.min(OBSERVE_MS * 2 ** (this.failuresDown - 1), BACKOFF_CEILING_MS);
    this.nextAt = now + this.retryMs;
  }

  /** Recomputes `state`; true when it changed. */
  evaluate(now: number): boolean {
    const next: TransportState = this.isUp(now) ? "up" : "down";
    if (next === this.state) return false;
    this.state = next;
    this.since = now;
    return true;
  }

  /** A success "in the future" means the wall clock stepped back: it proves nothing about now. */
  private isUp(now: number): boolean {
    if (!this.present || this.lastSuccess === null) return false;
    const age = now - this.lastSuccess;
    return age >= 0 && age <= UP_WINDOW_MS;
  }
}
