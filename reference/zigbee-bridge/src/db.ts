import pg from "pg";

/** Statements, inside a transaction or outside one. */
export interface Tx {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Statements with no parameters, several at once (a migration). */
  exec(sql: string): Promise<void>;
}

/**
 * The store's connection: `pg` in production, PGlite in the unit tests (the storage design, *Inside
 * a build*).
 */
export interface Db extends Tx {
  /** Runs `fn` in one transaction, committed when it returns and rolled back when it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Every statement's bound, on the server and on the client, so a hung store fails a try. */
export const STATEMENT_TIMEOUT_MS = 5000;

/** A failure the store's driver gave: Postgres refusing a statement, a lost connection, a timeout. */
export class StoreError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** Runs `p`, marking a rejection as the store's. */
export async function fromStore<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw err instanceof StoreError ? err : new StoreError(err);
  }
}

/** `text` with any database URL, which may carry a password, masked. */
export const maskUrls = (text: string): string => text.replace(/postgres(?:ql)?:\/\/\S+/g, "<url>");

/** A pool of two connections to Postgres at `url`. */
export function connectPg(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 2, statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS, connectionTimeoutMillis: STATEMENT_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
  // A connection that breaks, idle or in use, must not crash the bridge (GA-BRIDGE-10): the pool
  // drops it, the query in flight rejects, and the next query makes a new connection.
  pool.on("error", () => undefined);
  pool.on("connect", (c) => { c.on("error", () => undefined); });
  const on = (c: pg.Pool | pg.PoolClient): Tx => ({
    async query<R>(sql: string, params?: unknown[]) {
      return { rows: (await fromStore(c.query(sql, params))).rows as R[] };
    },
    async exec(sql: string) {
      await fromStore(c.query(sql));
    },
  });
  return {
    ...on(pool),
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      const c = await fromStore(pool.connect());
      let failed = false;
      try {
        await fromStore(c.query("BEGIN"));
        const result = await fn(on(c));
        await fromStore(c.query("COMMIT"));
        return result;
      } catch (err) {
        failed = true;
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        // A connection that failed is not used again.
        c.release(failed);
      }
    },
    close: () => pool.end(),
  };
}
