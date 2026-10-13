import type { Clock } from "@ludentes/galatea-life-test-clock";

/** A clock that moves only when a test says so, firing due timers in order. */
export class FakeClock implements Clock {
  private t = Date.parse("2030-01-01T08:00:00Z");
  private next = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): number {
    const h = this.next++;
    this.timers.set(h, { due: this.t + ms, fn });
    return h;
  }
  setInterval(): number { throw new Error("the steward never uses setInterval"); }
  clear(h: number): void { this.timers.delete(h); }
  close(): void { this.timers.clear(); }
  /** Moves time on `ms` without firing anything, as a host that stalled or a clock that jumped; the next `advance` fires what fell due. */
  jump(ms: number): void {
    this.t += ms;
  }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = Math.max(this.t, due[1].due);
      due[1].fn();
    }
    this.t = end;
  }
}

/**
 * A fake clock whose wall time (`now`) steps by `step` while its timers run on, as a host's timers do across
 * a step of the system clock; `elapsed` is the timers' own time, which no step moves.
 */
export class WallStepClock extends FakeClock {
  private offset = 0;
  elapsed(): number { return super.now(); }
  step(ms: number): void { this.offset += ms; }
  override now(): number { return super.now() + this.offset; }
}
