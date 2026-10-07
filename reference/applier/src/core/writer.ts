import type { Clock } from "@ludentes/galatea-life-test-clock";
import { isFault, maskUrls, StoreError, type Db, type Tx } from "./db.js";

/** One step's writes. The writer may run it twice (see `Writer`), so it must be safe to. */
export type WriteSet = (tx: Tx) => Promise<void>;

export const FIRST_RETRY_MS = 250;
export const LAST_RETRY_MS = 5000;
/**
 * How many write sets may wait before the writer drops those that can be derived again: well below
 * the million a life's `seq` moves by (`SEQ_LIFE_GAP`), and a bound on memory while the store is away.
 */
export const BACKLOG_CAP = 100_000;

/**
 * `droppable`: a write set that can be derived again (a bridge's facts, an event row), which the
 * writer drops past its cap (the maintainer, 2026-09-29). Never an owner's change, a latch or a notice.
 */
export type WriteOptions = { droppable?: boolean };

/**
 * The store's single writer (the storage design, *The applier, safety first*). Write sets commit one
 * at a time, each in one transaction, in the order they were given, so a step hands its writes over
 * and never waits for them. A failure that passes (the store down, a timeout) is retried with
 * backoff until the write set commits; a commit whose answer was lost is retried too, which is why
 * every write set must be safe to run twice. A fault, a statement Postgres refuses for good, stops
 * the writer: nothing after it is written, and `onFault` is told. So does anything a write set
 * throws that is not a `StoreError`: that is a bug, and retrying it would wedge every write after
 * it (the design, *Error handling*). The writer logs once when the store goes away and once when
 * it is back.
 */
export class Writer {
  private readonly line: { ws: WriteSet; committed: () => void }[] = [];
  private running = false;
  private stopped = false;
  private retryMs = FIRST_RETRY_MS;
  /** Whether the last try failed, and the writer is waiting to try again. */
  down = false;
  /** Write sets dropped at the cap in this life: then events were lost, and this life's stop is not clean. */
  dropped = 0;
  /** Whether the cap was reached since the line last emptied. */
  private full = false;
  /** Told once each time the cap is reached, until the line empties again. */
  onFull?: () => void;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly onFault: (err: unknown) => void,
    private readonly log: (line: string) => void = (line) => console.error(line),
    private readonly cap = BACKLOG_CAP,
  ) {}

  /**
   * Queues `ws`; resolves when it has committed. A `droppable` write set that finds `cap` waiting is
   * dropped: it resolves at once, and is never written.
   */
  write(ws: WriteSet, o: WriteOptions = {}): Promise<void> {
    if (o.droppable && this.line.length >= this.cap) {
      this.dropped++;
      if (!this.full) {
        this.full = true;
        this.log(`the store's backlog reached ${this.cap}: dropping what can be derived again`);
        try {
          this.onFull?.();
        } catch (err) {
          this.log(`applier bug: onFull threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return Promise.resolve();
    }
    return new Promise((committed) => {
      this.line.push({ ws, committed });
      void this.drain();
    });
  }

  /** Write sets given and not yet committed. */
  get backlog(): number {
    return this.line.length;
  }

  /** Writes nothing more; what is queued is dropped. */
  stop(): void {
    this.stopped = true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.line.length && !this.stopped) {
      const head = this.line[0]!;
      try {
        await this.db.transaction(head.ws);
      } catch (err) {
        if (isFault(err) || !(err instanceof StoreError)) {
          this.stopped = true;
          this.onFault(err);
          break;
        }
        if (!this.down) this.log(`store unreachable, retrying: ${maskUrls(err.message)}`);
        this.down = true;
        await new Promise<void>((resolve) => { this.clock.setTimeout(resolve, this.retryMs); });
        this.retryMs = Math.min(this.retryMs * 2, LAST_RETRY_MS);
        continue;
      }
      if (this.down) this.log("store back");
      this.down = false;
      this.retryMs = FIRST_RETRY_MS;
      this.line.shift();
      if (!this.line.length) this.full = false;
      head.committed();
    }
    this.running = false;
  }
}
