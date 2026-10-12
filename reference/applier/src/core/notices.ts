import { randomUUID } from "node:crypto";
import type { Clock } from "./clock.js";
import { Mutant } from "../mutations.js";
import { wellFormed } from "./canonical.js";
import type { Store } from "./store.js";

/**
 * A notice (applier, *Safety rules*, *Notices*): `{ notice_id, cause, rule_id?, devices?, text,
 * outcomes? }`. An unknown cause is shown all the same.
 */
export type Notice = { notice_id: string; cause: string; devices?: string[]; text: string } & Record<string, unknown>;

type Held = { notice: Notice; ms: number; key?: string; taken: boolean; standing: boolean };
type Row = { id: string; raised_ms: number | string; key: string | null; body: Notice; taken: boolean; standing: boolean };

/**
 * The notices the applier holds. Each is carried in every `events` response until a client lists it
 * in `notice_taken`, and is never dropped (applier, *Events and history*); each is kept across a
 * restart (GA-PERSIST-1). A notice raised with a `key` is raised once while its condition stands
 * (GA-BUS-12): a second `raise` with the key is nothing until `clear(key)`, taken or not. Every
 * method is a step: memory first, then the write set, which is never dropped (the backlog cap).
 */
export class Notices {
  private readonly held = new Map<string, Held>();

  constructor(private readonly store: Store, private readonly clock: Clock, private readonly mutant: Mutant = Mutant.none) {}

  /** Loads the notices kept: the ones not taken, and the taken ones whose condition still stands. */
  async load(): Promise<void> {
    // `forgets-a-notice`: the notices kept before the restart are not read back.
    if (this.mutant.forgetsANotice) return;
    const rows = await this.store.query<Row>("SELECT id, raised_ms, key, body, taken, standing FROM notices ORDER BY raised_ms, id");
    for (const r of rows.rows) {
      this.held.set(r.id, { notice: { ...r.body, notice_id: r.id }, ms: Number(r.raised_ms), ...(r.key ? { key: r.key } : {}),
        taken: r.taken, standing: r.standing });
    }
  }

  /** Whether a notice with `key` stands. */
  standing(key: string): boolean {
    return [...this.held.values()].some((h) => h.key === key && h.standing);
  }

  /** The keys standing that start with `prefix`. */
  standingKeys(prefix: string): string[] {
    return [...new Set([...this.held.values()].filter((h) => h.standing && h.key?.startsWith(prefix)).map((h) => h.key!))];
  }

  /** Raises a notice, or, with a `key` that stands, nothing. */
  raise(n: Omit<Notice, "notice_id">, rawKey?: string): Notice | undefined {
    // Whatever the notice holds, the store can keep it: its text may carry an owner's or a bridge's strings.
    const key = rawKey === undefined ? undefined : wellFormed(rawKey);
    if (key !== undefined && this.standing(key)) return undefined;
    const notice = wellFormed({ ...n, notice_id: randomUUID() }) as Notice;
    const ms = Math.floor(this.clock.now());
    this.held.set(notice.notice_id, { notice, ms, ...(key !== undefined ? { key } : {}), taken: false, standing: key !== undefined });
    void this.store.write((tx) => tx.query(
      "INSERT INTO notices (id, raised_ms, key, body, taken, standing) VALUES ($1, $2, $3, $4, false, $5) ON CONFLICT (id) DO NOTHING",
      [notice.notice_id, ms, key ?? null, JSON.stringify(notice), key !== undefined]).then(() => undefined));
    return notice;
  }

  /** What `key` said has cleared: a later `raise` with it is a new notice. A notice not taken stays listed. */
  clear(key: string): void {
    let any = false;
    for (const [id, h] of this.held) {
      if (h.key !== key || !h.standing) continue;
      any = true;
      h.standing = false;
      if (h.taken) this.held.delete(id);
    }
    if (!any) return;
    void this.store.write(async (tx) => {
      await tx.query("UPDATE notices SET standing = false WHERE key = $1", [key]);
      await tx.query("DELETE FROM notices WHERE key = $1 AND taken", [key]);
    });
  }

  /**
   * A later notice replaces the ones raised with `key`: those no client has taken leave `notices`, and
   * the key no longer stands (GA-ADOPT-3's `[]` replaces an untaken `other_admin` notice).
   */
  withdraw(key: string): void {
    const ids = [...this.held].filter(([, h]) => h.key === key && !h.taken).map(([id]) => id);
    for (const id of ids) this.held.delete(id);
    if (ids.length) void this.store.write((tx) => tx.query("DELETE FROM notices WHERE id = ANY($1)", [ids]).then(() => undefined));
    this.clear(key);
  }

  /** A client delivered these: they leave `notices`. An id the applier does not hold is nothing. */
  take(ids: string[]): void {
    const taken = ids.filter((id) => {
      const h = this.held.get(id);
      if (!h || h.taken) return false;
      h.taken = true;
      if (!h.standing) this.held.delete(id);
      return true;
    });
    if (!taken.length) return;
    void this.store.write(async (tx) => {
      await tx.query("UPDATE notices SET taken = true WHERE id = ANY($1)", [taken]);
      await tx.query("DELETE FROM notices WHERE id = ANY($1) AND NOT standing", [taken]);
    });
  }

  /** Every notice not taken, oldest first. */
  list(): Notice[] {
    return [...this.held.values()].filter((h) => !h.taken).sort((a, b) => a.ms - b.ms).map((h) => h.notice);
  }
}
