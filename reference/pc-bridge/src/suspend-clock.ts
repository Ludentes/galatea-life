import type { Clock } from "@ludentes/galatea-life-test-clock";

/** One timer of the clock: when it is due on the clock's own time, and whether a base timer is set for it. */
interface Timer {
  due: number;
  fn: () => void;
  base: number | null;
}

/**
 * The core's clock for the plugin servers' times (the 10 s answer, the 120 s start, the backoff,
 * the probes and the reads; GA-BRIDGE-58): the subject's time source, less, at each resume, the
 * part of the time asleep that the source counted (the design's *The core*). That part is the
 * smaller of the time asleep the port reports and the source's own growth across the suspend: zero
 * for Node's monotonic clock, which stops in suspend; the whole of it for the harness's time
 * source, which the harness steps while the host sleeps, or a test-clock on a real OS, whose offset
 * the SNTP poll brings forward at wake. So a sleep neither finds every server hung on waking nor
 * fires a backoff early.
 *
 * `freeze` (a suspend the port announced, or one it reported unannounced) holds every timer and
 * the time; `thaw` (once the resume is applied) takes the counted part off and sets the timers
 * again for what each had left. A resume with no freeze before it (a suspend no one reported) takes
 * off the smaller of the time asleep and the source's growth since the clock last looked at it,
 * which it does at each call and each timer: up to the time between two looks is taken off a
 * source that did not count the sleep, a stated limit.
 *
 * Timers are set on `base` (the bridge's clock) for what each has left, and checked when it fires:
 * one that fires early (the source grew while frozen) is set again for the rest.
 */
export class SuspendClock {
  private readonly timers = new Map<number, Timer>();
  private next = 1;
  /** What has been taken off the source, over every resume. */
  private off = 0;
  /** The source's reading at the freeze, and the clock's time then, while frozen. */
  private frozen: { source: number; at: number } | null = null;
  /** The source's reading when the clock last looked at it. */
  private seen: number;

  constructor(private readonly base: Clock, private readonly source: () => number = () => base.now()) {
    this.seen = source();
  }

  /** The clock's time: held still while frozen. */
  now(): number {
    if (this.frozen) return this.frozen.at;
    const s = this.source();
    this.seen = s;
    return s - this.off;
  }

  get isFrozen(): boolean {
    return this.frozen !== null;
  }

  setTimeout(fn: () => void, ms: number): number {
    const h = this.next++;
    const t: Timer = { due: this.now() + Math.max(0, ms), fn, base: null };
    this.timers.set(h, t);
    if (!this.frozen) this.arm(h, t);
    return h;
  }

  clear(h: number): void {
    const t = this.timers.get(h);
    if (!t) return;
    if (t.base !== null) this.base.clear(t.base);
    this.timers.delete(h);
  }

  /** A suspend: the time and every timer held until `thaw`. A second freeze keeps the first. */
  freeze(): void {
    if (this.frozen) return;
    const at = this.now();
    this.frozen = { source: this.seen, at };
    for (const t of this.timers.values()) {
      if (t.base !== null) this.base.clear(t.base);
      t.base = null;
    }
  }

  /**
   * The resume applied: the part of `asleepMs` the source counted is taken off, and the timers set
   * again. Without a freeze before it, the source's growth is counted from the last look.
   */
  thaw(asleepMs: number): void {
    const from = this.frozen ? this.frozen.source : this.seen;
    const grew = Math.max(0, this.source() - from);
    this.frozen = null;
    // Whatever of the growth was not sleep is time awake around it, and stays on the clock.
    this.off += Math.min(Math.max(0, asleepMs), grew);
    for (const [h, t] of this.timers) {
      if (t.base !== null) this.base.clear(t.base);
      this.arm(h, t);
    }
  }

  /** Sets the base timer for what `t` has left; when it fires, `t` runs if it is due, or is set again for the rest. */
  private arm(h: number, t: Timer): void {
    t.base = this.base.setTimeout(() => {
      t.base = null;
      if (this.frozen || !this.timers.has(h)) return;
      if (this.now() < t.due) {
        this.arm(h, t);
        return;
      }
      this.timers.delete(h);
      t.fn();
    }, Math.max(0, t.due - this.now()));
  }
}
