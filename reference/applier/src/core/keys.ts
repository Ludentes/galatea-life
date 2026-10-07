import { RequestError } from "./errors.js";

/** How long an idempotency key is held from its first use: "within 3600 s" (GA-APPLY-4, GA-PROV-3). */
export const KEY_HELD_MS = 3_600_000;

/**
 * A key in use: the body it came with, and its record once the request it claimed is kept; `done`
 * resolves when that request returns or fails.
 */
export type KeyClaim<R> = {
  scope: string;
  key: string;
  body: string;
  record?: R;
  created_ms?: number;
  done: Promise<void>;
  settle: () => void;
  settled?: boolean;
};

const keyOf = (scope: string, key: string) => `${scope}\u0000${key}`;

/**
 * Idempotency keys (slice 4c's semantics, generic in their record): each scope's keys apart, a body
 * compared as given (the caller's RFC 8785 serialisation without the key), and a key free again
 * `KEY_HELD_MS` after its first use whatever its record says. Every method is one step, in memory;
 * the records are the caller's to keep.
 */
export class Keys<R> {
  private readonly keys = new Map<string, KeyClaim<R>>();

  constructor(private readonly now: () => number) {}

  /**
   * A key as a request finds it: `held`, the record of the request made with it in the last 3600 s,
   * with the same body, once that request has returned; `wait`, while the request that claimed it
   * still runs, kept or not; or `new`, claimed now, which `release` gives up unless it was kept. The
   * same key with another body is `idempotency_conflict`, while the key is in use either way.
   */
  claim(scope: string, key: string, body: string): { kind: "held"; record: R } | { kind: "wait"; done: Promise<void> }
    | { kind: "new"; claim: KeyClaim<R> } {
    const k = keyOf(scope, key);
    const c = this.keys.get(k);
    if (c && c.created_ms !== undefined && c.created_ms + KEY_HELD_MS <= this.now()) this.keys.delete(k);
    else if (c) {
      if (c.body !== body) throw new RequestError("idempotency_conflict", "this idempotency_key was used with another body in the last 3600 s");
      return c.record !== undefined && c.settled ? { kind: "held", record: c.record } : { kind: "wait", done: c.done };
    }
    let settle!: () => void;
    const done = new Promise<void>((r) => { settle = r; });
    const fresh: KeyClaim<R> = { scope, key, body, done, settle };
    this.keys.set(k, fresh);
    return { kind: "new", claim: fresh };
  }

  /** The request that claimed `c` is kept with `record`, first used at `createdMs`. */
  kept(c: KeyClaim<R>, record: R, createdMs: number): void {
    c.record = record;
    c.created_ms = createdMs;
  }

  /** The request that claimed `c` returned or failed: a request waiting on it goes on, and a key never kept is free again. */
  release(c: KeyClaim<R>): void {
    const k = keyOf(c.scope, c.key);
    if (c.record === undefined && this.keys.get(k) === c) this.keys.delete(k);
    c.settled = true;
    c.settle();
  }

  /** Gives up a claim whether or not it was kept: its request was never made. */
  forget(c: KeyClaim<R>): void {
    c.record = undefined;
    this.release(c);
  }

  /** A key a start found kept: held from `createdMs` with `record`. */
  hold(scope: string, key: string, body: string, record: R, createdMs: number): void {
    this.keys.set(keyOf(scope, key), { scope, key, body, record, created_ms: createdMs, done: Promise.resolve(),
      settle: () => undefined, settled: true });
  }

  /** Forgets each key past its 3600 s. */
  prune(nowMs: number): void {
    for (const [k, c] of this.keys) if (c.created_ms !== undefined && c.created_ms + KEY_HELD_MS <= nowMs) this.keys.delete(k);
  }
}
