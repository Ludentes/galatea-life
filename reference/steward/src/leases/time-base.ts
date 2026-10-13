import type { Clock } from "@ludentes/galatea-life-test-clock";

/**
 * How far the wall clock may part from the elapsed clock before it counts as a step: a host's two clocks
 * differ by a fraction of a millisecond between reads (an integer wall clock beside a fractional monotonic
 * one) and drift apart slowly; a step of the wall clock moves it at once by far more.
 */
export const WALL_STEP_MS = 100;

/**
 * One life's wall and elapsed clocks, related by one offset (GA-LEASE-7, GA-PERSIST-2; R-73, R-74). A hold's
 * windows run on elapsed time; what it shows (`expires`, `quiet_since`, `end_time`) and what the store keeps
 * are wall instants. Converting both ways by the same number, an instant born on the wall clock (a dispatch, a
 * gap event's time) comes back as the same integer millisecond. The offset is sampled once and sampled again
 * only on a step of the wall clock, so a step still moves a shown end. With no separate elapsed clock (the
 * harness's, GA-HARN-2) the offset is 0 and an instant is the same number on both.
 */
export class TimeBase {
  private offset: number | undefined;

  constructor(private readonly clock: Clock, private readonly elapsedClock?: () => number) {}

  /** The wall clock less the elapsed clock, as this life relates them. */
  offsetMs(): number {
    if (!this.elapsedClock) return 0;
    const live = this.clock.now() - this.elapsedClock();
    if (this.offset === undefined || Math.abs(live - this.offset) > WALL_STEP_MS) this.offset = live;
    return this.offset;
  }

  /**
   * Now on the elapsed clock, as the wall clock's timers see it: a timer armed at a converted wall instant
   * finds that instant's elapsed time when it fires.
   */
  now(): number { return this.clock.now() - this.offsetMs(); }

  /** An elapsed instant on the wall clock, rounded to the millisecond a wall instant is. */
  wall(elMs: number): number { return Math.round(elMs + this.offsetMs()); }

  /** An elapsed instant on the wall clock, unrounded: a timer rounds it up itself. */
  wallExact(elMs: number): number { return elMs + this.offsetMs(); }

  /** A wall instant on the elapsed clock. */
  el(wallMs: number): number { return wallMs - this.offsetMs(); }
}
