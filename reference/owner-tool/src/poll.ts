import { need } from "./context.js";
import type { Body, Reply } from "./link.js";
import type { Steward } from "./servers.js";

/** The longest wait either server's long-poll takes (`events` and `describe`, 0 to 30 s). */
export const MAX_WAIT_S = 30;

const bounded = (s: number): number => Math.min(MAX_WAIT_S, Math.max(0, Math.ceil(s)));

/** A server whose `events` the tool reads on: the applier's (GA-CFG-1) or the steward's (*Causes and history*), both alike. */
export interface EventSource {
  events(a: { cursor?: string; wait_s?: number }): Promise<Reply>;
}

/**
 * A server's `events` read on from a cursor (applier, *Events and history*; the steward's work as
 * the applier's): `start` takes the cursor now, before anything is asked, so nothing that follows is
 * missed; `at` starts from a cursor given; `next` long-polls after it and moves it. A refusal
 * (`cursor_expired`) is thrown as the server's.
 */
export class EventFeed {
  private constructor(private readonly source: EventSource, private at: string, private readonly what: string) {}

  static async start(source: EventSource, what: "applier" | "steward" = "applier"): Promise<EventFeed> {
    const body = need(await source.events({}), what, "events");
    return new EventFeed(source, String(body.cursor), what);
  }

  /** A feed that reads on from `cursor`, one the owner kept from an earlier read. */
  static from(source: EventSource, cursor: string, what: "applier" | "steward" = "applier"): EventFeed {
    return new EventFeed(source, cursor, what);
  }

  get cursor(): string {
    return this.at;
  }

  /** The events after the cursor, waiting up to `wait_s` (bounded to 0..30) for the first. */
  async next(wait_s: number): Promise<Body[]> {
    const body = need(await this.source.events({ cursor: this.at, wait_s: bounded(wait_s) }), this.what, "events");
    if (typeof body.cursor === "string") this.at = body.cursor;
    return Array.isArray(body.events) ? body.events : [];
  }
}

/**
 * Waits on the steward's `describe { since_revision, wait_s }` (steward, *describe*) until `found`
 * picks something from its model, or `until` (ms, on `now`) passes. The first read never waits, so a
 * model that shows it already answers at once (review I2: a change that moved no revision would
 * otherwise hold the whole wait); each later one waits on the revision last read, the wait bounded by
 * what is left and by 30 s. The model's revision moves with the applier's (GA-HOUSE-1), so an adoption wakes it.
 */
export async function waitForTarget<T>(steward: Steward, now: () => number, o: { until: number; found: (model: Body) => T | undefined }):
Promise<{ value?: T; revision: number; model: Body }> {
  let since: number | undefined;
  for (;;) {
    const left = (o.until - now()) / 1000;
    const model = need(await steward.describe(since === undefined ? {} : { since_revision: since, wait_s: bounded(left) }), "steward", "describe");
    const value = o.found(model);
    const revision = Number(model.revision);
    if (value !== undefined || now() >= o.until) return { value, revision, model };
    since = revision;
  }
}

/** What a wait raced with Ctrl-C answers when the owner interrupted it. */
export const INTERRUPTED = Symbol("interrupted");

/** The owner's Ctrl-C while a command waits: `race` ends a wait on it; `dispose` gives SIGINT back. */
export interface Interruption {
  readonly fired: boolean;
  /** `p`, unless Ctrl-C comes first; `p` is then left behind, its failure dropped. */
  race<T>(p: Promise<T>): Promise<T | typeof INTERRUPTED>;
  dispose(): void;
}

/** Listens for Ctrl-C through `onInterrupt` (only `main.ts` touches the process's signals) until disposed. */
export function interruption(onInterrupt: (handler: () => void) => () => void): Interruption {
  let fired = false;
  let resolve!: (v: typeof INTERRUPTED) => void;
  const interrupted = new Promise<typeof INTERRUPTED>((r) => { resolve = r; });
  const dispose = onInterrupt(() => {
    fired = true;
    resolve(INTERRUPTED);
  });
  return {
    get fired() {
      return fired;
    },
    race<T>(p: Promise<T>) {
      p.catch(() => undefined);
      return Promise.race([p, interrupted]);
    },
    dispose,
  };
}
