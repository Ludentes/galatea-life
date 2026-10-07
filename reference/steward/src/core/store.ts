import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Db, Tx } from "./db.js";
import { CLEAN_STOP } from "./events.js";
import { StoreUnavailable } from "./errors.js";
import { migrate } from "./migrate.js";
import { Writer, type WriteOptions, type WriteSet } from "./writer.js";

/** How long a caller waits for a commit its reply depends on (the storage design). */
export const GATE_MS = 10_000;

/**
 * The steward's durable state, in its Postgres schema: reads of what is committed, and one writer
 * that commits write sets in order.
 */
export class Store {
  private constructor(private readonly db: Db, private readonly writer: Writer, private readonly clock: Clock) {}

  /**
   * Brings the schema up to date and opens the store; the steward cannot start without it.
   * `onFault` is told when the writer stops on a statement the store refuses for good.
   */
  static async open(db: Db, clock: Clock, onFault: (err: unknown) => void, o: { backlogCap?: number } = {}): Promise<Store> {
    await migrate(db);
    return new Store(db, new Writer(db, clock, onFault, undefined, o.backlogCap), clock);
  }

  /** Reads what is committed; fails while the store is unreachable. */
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
    return this.db.query<R>(sql, params);
  }

  /** Hands `ws` to the writer; resolves when it has committed, or at once when it was `droppable` and dropped. */
  write(ws: WriteSet, o?: WriteOptions): Promise<void> {
    return this.writer.write(ws, o);
  }

  /** Told once each time the backlog reaches its cap (the owner's notice, from a later slice). */
  set onFull(fn: (() => void) | undefined) {
    this.writer.onFull = fn;
  }

  /** Write sets dropped at the cap in this life. */
  get dropped(): number {
    return this.writer.dropped;
  }

  /** Resolves once everything handed to the writer so far has committed. */
  settled(): Promise<void> {
    return this.writer.write(async () => undefined);
  }

  /** Whether the writer's last try failed. */
  get down(): boolean {
    return this.writer.down;
  }

  get backlog(): number {
    return this.writer.backlog;
  }

  /**
   * Waits up to `ms` on the clock for the backlog to commit, then closes the connection. Only when
   * all of it committed, and nothing was dropped at the cap, does it leave the clean-stop marker, in
   * the same wait, so the next start keeps the cursors of this life (the design, *Restart loss*).
   */
  async close(ms = 5000): Promise<void> {
    const clean = this.settled().then(() => (this.dropped ? undefined : this.write((tx) => setMeta(tx, CLEAN_STOP, "1"))));
    await Promise.race([clean, new Promise<void>((resolve) => { this.clock.setTimeout(resolve, ms); })]);
    this.writer.stop();
    await this.db.close();
  }
}

/**
 * `p`, or a `StoreUnavailable` once `ms` pass on the clock. `p` goes on either way, so the error
 * says `pending`: what it waited for still takes effect when the store returns, unless the steward
 * restarts first (the design, *The store unreachable*). `held` is its message, for a caller whose
 * `p` is still judged when its turn comes; `pending` false for a caller whose `p` is dropped when it
 * lands late, as a plan's.
 */
export function within<T>(clock: Clock, ms: number, p: Promise<T>,
  held = `the store did not commit within ${ms} ms; held, it takes effect when the store returns, unless the steward restarts first`,
  pending = true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new StoreUnavailable(held, pending)), ms);
    p.then((v) => { clock.clear(timer); resolve(v); }, (err: unknown) => { clock.clear(timer); reject(err); });
  });
}

export async function getMeta(q: Pick<Tx, "query">, key: string): Promise<string | undefined> {
  return (await q.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [key])).rows[0]?.value;
}

export async function setMeta(tx: Tx, key: string, value: string): Promise<void> {
  await tx.query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
}

/** Writes `key` as `value` unless a higher value is already kept: safe to run twice, and in any order. */
export async function raiseMeta(tx: Tx, key: string, value: number): Promise<void> {
  await tx.query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) "
    + "DO UPDATE SET value = GREATEST(meta.value::bigint, EXCLUDED.value::bigint)::text", [key, String(value)]);
}

/**
 * A number kept in `meta` that only rises (`last_seq`, `revision`), written behind and coalesced: one
 * write waits in the writer's line at a time, never dropped at the cap, and writes the value `read`
 * gives when it runs. A value that moved while that write was in flight is written again once it
 * commits, so the store ends at the last value served (GA-DESC-2), ahead of a later clean-stop marker.
 */
export class RisingMeta {
  private queued = false;

  constructor(private readonly store: Store, private readonly key: string, private readonly read: () => number) {}

  /** The value moved: make sure a write of it is on its way. */
  schedule(): void {
    if (this.queued) return;
    this.queued = true;
    let written: number | undefined;
    void this.store.write((tx) => { written = this.read(); return raiseMeta(tx, this.key, written); }).then(() => {
      this.queued = false;
      if (this.read() !== written) this.schedule();
    });
  }
}
