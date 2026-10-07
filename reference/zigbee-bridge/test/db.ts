import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { fromStore, StoreError, type Db, type Tx } from "../src/db.js";
import { Store } from "../src/store.js";

type MemoryDb = Db & { trouble: { down: boolean; loseCommit: boolean }; end(): Promise<void>; dumpDataDir: PGlite["dumpDataDir"] };

/**
 * A fresh Postgres in process (PGlite 0.5.8 is Postgres 18.3), with `Store.open`'s migrations already
 * applied. Each call gets its own database, loaded from a template migrated once for the run
 * (`migratedTemplate`): starting a PGlite from a data directory is about a quarter of starting a
 * blank one. `blankDb` is the same without the migrations. `trouble.down` makes every call fail as a
 * store that went away; clearing it brings the store back. `trouble.loseCommit` makes the next
 * transaction commit and then fail, as a commit whose answer was lost. `close` leaves the database as
 * the next process would find it, and `end` really closes it.
 */
export async function memoryDb(): Promise<MemoryDb> {
  return wrap(new PGlite({ loadDataDir: await migratedTemplate() }));
}

/** A fresh Postgres with nothing in it, as an installation first finds it. */
export async function blankDb(): Promise<MemoryDb> {
  return wrap(new PGlite());
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

/** The data directory of a `blankDb` that `Store.open` brought up to date. */
export async function buildTemplate(): Promise<Blob> {
  const db = await blankDb();
  await Store.open(db);
  const dir = await db.dumpDataDir("none");
  await db.end();
  return dir;
}

function wrap(pglite: PGlite): MemoryDb {
  const trouble = { down: false, loseCommit: false };
  const check = () => {
    if (trouble.down) throw new StoreError(new Error("the store is unreachable"));
  };
  const on = (t: Pick<PGlite, "query" | "exec">): Tx => ({
    async query<R>(sql: string, params?: unknown[]) {
      check();
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
      const result = await fromStore(pglite.transaction((t) => fn(on(t))));
      if (trouble.loseCommit) {
        trouble.loseCommit = false;
        throw new StoreError(new Error("the connection closed before the commit's answer"));
      }
      return result;
    },
    close: async () => undefined,
    end: () => pglite.close(),
    dumpDataDir: (c) => pglite.dumpDataDir(c),
  };
}
