import type { Clock } from "@ludentes/galatea-life-test-clock";

/** A clock that moves only when a test says so, firing due timers in order. */
export class FakeClock implements Clock {
  private t: number;
  /** `start`: where the clock starts, so a second life's clock continues the first's. */
  constructor(start = Date.parse("2030-01-01T08:00:00Z")) {
    this.t = start;
  }
  private next = 1;
  private readonly timers = new Map<number, { due: number; fn: () => void }>();
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): number {
    const h = this.next++;
    this.timers.set(h, { due: this.t + ms, fn });
    return h;
  }
  setInterval(): number { throw new Error("the applier never uses setInterval"); }
  clear(h: number): void { this.timers.delete(h); }
  close(): void { this.timers.clear(); }
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
