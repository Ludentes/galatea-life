import { readFileSync } from "node:fs";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import { fromStore, StoreError, type Db, type Tx } from "../src/core/db.js";
import { migrationsFrom } from "../src/adapters/migrations.js";
import { migrate } from "../src/core/migrate.js";
import { Store } from "../src/core/store.js";
import { FakeClock } from "./fake-clock.js";

/**
 * A fresh Postgres in process (PGlite 0.5.8 is Postgres 18.3), with the installation's `reader`
 * role and every migration already applied, so `Store.open` finds nothing to do. Each call gets its
 * own database, loaded from a template migrated once for the run (`migratedTemplate`): starting a
 * PGlite from a data directory is about a quarter of starting a blank one. `blankDb` is the same
 * without the migrations. `trouble.down` makes every call fail as a store that went away;
 * `trouble.fault`, a SQLSTATE, makes it fail as a statement Postgres refuses for good. Both, and
 * PGlite's own failures, come as a `StoreError`, as `connectPg`'s do. Clearing them brings the store
 * back. `trouble.failOn`, a pattern, fails only a statement matching it, as a store that went away
 * (a lock the store cannot get, a connection lost on that statement): the transaction holding it
 * rolls back, and the writer tries it again.
 */
/** The package's migrations, as an entry point reads them. */
export const migrations = migrationsFrom(new URL("../migrations/", import.meta.url));

export type Trouble = { down: boolean; fault?: string; failOn?: RegExp };

export async function memoryDb(): Promise<Db & { trouble: Trouble }> {
  return wrap(opened(new PGlite({ loadDataDir: await migratedTemplate() })));
}

/** A fresh Postgres with only the `reader` role: no migrations, as an installation first finds it. */
export async function blankDb(): Promise<Db & { trouble: Trouble }> {
  const pglite = opened(new PGlite());
  await pglite.exec("CREATE ROLE reader");
  return wrap(pglite);
}

/**
 * Every PGlite a test opened and has not closed. Each holds its own Postgres in WebAssembly memory,
 * and a test rarely closes its store (`lasting` keeps the database across a restart), so a file of
 * a hundred tests grew one worker past 9 GB. `closeOpened`, after each test (`test/close-dbs.ts`),
 * closes them. A database still inside a transaction (a test that ended with a write set waiting
 * on its clock) is left to the garbage collector: closing it under the transaction hangs the worker.
 * One still committing (the writer runs behind) is waited for, up to half a second of real time:
 * without the wait, 54 of `dispatch.test.ts`'s 86 were left, and its worker stayed at 12 GB.
 */
const open = new Map<PGlite, { inTransaction: number }>();

function opened(pglite: PGlite): PGlite {
  open.set(pglite, { inTransaction: 0 });
  return pglite;
}

export async function closeOpened(): Promise<void> {
  const all = [...open];
  open.clear();
  await Promise.all(all.map(async ([p, s]) => {
    // A write set the test left committing (the writer runs behind) ends within milliseconds; one
    // waiting on the test's clock never does, and is left.
    for (let waited = 0; s.inTransaction && waited < 500; waited += 10) await new Promise((r) => setTimeout(r, 10));
    if (!s.inTransaction) await p.close().catch(() => undefined);
  }));
}

let template: Promise<Blob> | undefined;

/**
 * The data directory every `memoryDb` starts from: the file `global-setup.ts` made once for the run,
 * or, in a worker started without it, `buildTemplate`'s, made once for the worker.
 */
export function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const { inject } = await import("vitest");
    const file = inject("pgliteTemplate");
    return file ? new Blob([readFileSync(file)]) : buildTemplate();
  })();
  return template;
}

/** The data directory of a `blankDb` that `migrate` brought up to date. */
export async function buildTemplate(): Promise<Blob> {
  const db = await blankDb();
  await migrate(db, migrations);
  const dir = await db.dumpDataDir("none");
  await db.close();
  return dir;
}

function wrap(pglite: PGlite): Db & { trouble: Trouble; dumpDataDir: PGlite["dumpDataDir"] } {
  const trouble: Trouble = { down: false };
  const check = () => {
    if (trouble.down) throw new StoreError(new Error("the store is unreachable"));
    if (trouble.fault) {
      throw new StoreError(Object.assign(new Error(`the store refuses the statement (${trouble.fault})`), { severity: "ERROR", code: trouble.fault }));
    }
  };
  const on = (t: PGlite | Transaction): Tx => ({
    async query<R>(sql: string, params?: unknown[]) {
      check();
      if (trouble.failOn?.test(sql)) throw new StoreError(new Error("the store is unreachable"));
      return { rows: (await fromStore(t.query<R>(sql, params))).rows };
    },
    async exec(sql: string) {
      check();
      await fromStore(t.exec(sql));
    },
  });
  return {
    trouble,
    ...on(pglite),
    async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      check();
      // As in `connectPg`: what `fn` throws is left as it is; PGlite's own failures are the store's.
      let thrown: { err: unknown } | undefined;
      const state = open.get(pglite);
      if (state) state.inTransaction++;
      try {
        return await pglite.transaction(async (t) => {
          try {
            return await fn(on(t));
          } catch (err) {
            thrown = { err };
            throw err;
          }
        });
      } catch (err) {
        throw thrown && thrown.err === err ? err : new StoreError(err);
      } finally {
        if (state) state.inTransaction--;
      }
    },
    close: () => pglite.close(),
    dumpDataDir: (c) => pglite.dumpDataDir(c),
  };
}

/** A store on a fresh `memoryDb`. A fault fails the test that met it. */
export const memoryStore = async (clock: Clock = new FakeClock()): Promise<Store> =>
  Store.open(await memoryDb(), clock, (err) => { throw err; }, { migrations });

/** The database, surviving its store's close, as the next process would find it. */
export const lasting = <T extends { close(): Promise<void> }>(db: T): T => ({ ...db, close: async () => undefined });
