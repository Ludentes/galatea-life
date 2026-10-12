import pg from "pg";
import { fromServer, fromStore, type Db, type Tx } from "../core/db.js";

/** Every statement's bound, on the server and on the client, so a hung store fails a try. */
export const STATEMENT_TIMEOUT_MS = 5000;

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
