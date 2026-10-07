import type { Body, Link, Reply } from "./link.js";

/** A change in a change set: `{ op, kind, value }`, as both servers take them. */
export interface Change {
  op: "upsert" | "delete";
  kind: string;
  value?: unknown;
}

/**
 * The applier, as the owner's configuration credential reaches it (GA-CFG-1, GA-PROV-1): `describe`
 * and `configure` in plan A. The commands take this interface, so their tests use a fake.
 */
export interface Applier {
  describe(): Promise<Reply>;
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply>;
}

/**
 * The steward, as the owner's app credential reaches it at endpoint `owner-app` (steward, *Clients,
 * endpoints and principals*): `describe` (with its wait), `state`, `history` and `define` in plan A.
 */
export interface Steward {
  describe(a?: { since_revision?: number; wait_s?: number }): Promise<Reply>;
  state(a?: { targets?: string[] }): Promise<Reply>;
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply>;
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply>;
}

/** The owner's own endpoint at the steward, which every call of the tool names. */
export const OWNER_APP = "owner-app";

export class McpApplier implements Applier {
  constructor(private readonly link: Link) {}
  describe(): Promise<Reply> {
    return this.link.call("describe");
  }
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply> {
    return this.link.call("configure", a as unknown as Body);
  }
}

export class McpSteward implements Steward {
  constructor(private readonly link: Link) {}
  describe(a: { since_revision?: number; wait_s?: number } = {}): Promise<Reply> {
    // The long-poll's own wait, and a margin for the answer to travel.
    return this.link.call("describe", a, ((a.wait_s ?? 0) + 30) * 1000);
  }
  state(a: { targets?: string[] } = {}): Promise<Reply> {
    return this.link.call("state", a);
  }
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply> {
    return this.link.call("history", a);
  }
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply> {
    return this.link.call("define", { endpoint: OWNER_APP, ...a });
  }
}
