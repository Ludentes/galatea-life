/**
 * Runs tasks one at a time, in arrival order, each to its end before the next starts, awaits
 * included. The steward's own steps are synchronous and need no queue; this is the line the owner's
 * changes wait in, one at a time, each until its commit (the storage design). Like every queue it
 * has a cap (the design, *Bounds*): it holds at most `cap` tasks, the running one included, and
 * `run` throws past it, so the caller refuses at once.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private held = 0;

  constructor(readonly cap = Infinity) {}

  /** Whether `run` would throw. */
  get full(): boolean {
    return this.held >= this.cap;
  }

  run<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.full) throw new RangeError(`the line is full: ${this.held} tasks wait`);
    this.held++;
    const result = this.tail.then(task).finally(() => { this.held--; });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
