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

/** SQLSTATE classes that pass: connection, rollback, resources (a full disk), object state, operator (a shutdown), system. */
const PASSING = new Set(["08", "40", "53", "55", "57", "58"]);

/**
 * A failure the store's driver gave: Postgres refusing a statement, a lost connection, a timeout.
 * Anything else a write set throws is a bug in the applier (the design, *Error handling*). The
 * driver's error is the `cause`; its SQLSTATE and severity stay visible to `isFault`.
 */
export class StoreError extends Error {
  readonly code?: string;
  readonly severity?: string;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    const e = cause as { code?: unknown; severity?: unknown } | null;
    if (typeof e?.code === "string") this.code = e.code;
    if (typeof e?.severity === "string") this.severity = e.severity;
  }
}

/** `err` marked as the store's, once. */
export const storeError = (err: unknown): StoreError => err instanceof StoreError ? err : new StoreError(err);

/** Runs `p`, marking a rejection as the store's. */
export async function fromStore<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw storeError(err);
  }
}

/** `text` with any database URL, which may carry a password, masked. */
export const maskUrls = (text: string): string => text.replace(/postgres(?:ql)?:\/\/\S+/g, "<url>");

/** Whether Postgres itself answered `err` (it carries a severity and a SQLSTATE). */
const fromServer = (err: unknown) => {
  const e = err as { severity?: unknown; code?: unknown } | null;
  return typeof e?.severity === "string" && typeof e.code === "string";
};

/**
 * Whether `err` is Postgres refusing a statement for a reason that recurs on every try: a
 * constraint, a missing table, a privilege. A lost connection, a timeout, a server shutting down or
 * a full disk pass, and are retried.
 */
export function isFault(err: unknown): boolean {
  return fromServer(err) && !PASSING.has((err as { code: string }).code.slice(0, 2));
}

/** A pool of two connections to Postgres at `url`: one for the writer's transactions, one for reads. */
export function connectPg(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 2, statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS, connectionTimeoutMillis: STATEMENT_TIMEOUT_MS, idleTimeoutMillis: 30_000 });
  // A connection that breaks, idle or in use, must not crash the applier: the pool drops it, the
  // query in flight rejects, and the next query makes a new connection.
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
      let failed: unknown;
      try {
        await fromStore(c.query("BEGIN"));
        // What `fn` throws is left as it is: a store error it met is marked already, and anything
        // else is a bug.
        const result = await fn(on(c));
        await fromStore(c.query("COMMIT"));
        return result;
      } catch (err) {
        failed = err;
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        // A connection that failed for any reason but a refused statement is not used again.
        c.release(failed !== undefined && !fromServer(failed));
      }
    },
    close: () => pool.end(),
  };
}
