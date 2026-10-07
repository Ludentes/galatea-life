/**
 * Runs tasks one at a time, in arrival order, each to its end before the next starts, awaits
 * included. The applier's own steps are synchronous and need no queue; this is the line the owner's
 * changes wait in, one at a time, each until its commit (the storage design).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
