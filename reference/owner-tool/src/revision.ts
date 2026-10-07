import { type Ctx, need } from "./context.js";
import { Lost, type Reply } from "./link.js";
import type { Change } from "./servers.js";

/** How many times a change refused `stale_revision` is sent again after reading the revision again (the design, *Pairing*). */
export const STALE_RETRIES = 2;

/** The revision a server describes now. */
export async function applierRevision(ctx: Ctx): Promise<number> {
  return Number(need(await (await ctx.applier()).describe(), "applier", "describe").revision);
}

export async function stewardRevision(ctx: Ctx): Promise<number> {
  return Number(need(await (await ctx.steward()).describe(), "steward", "describe").revision);
}

/**
 * Sends a change set at the revision just read; `stale_revision` is read again and sent again, at
 * most `STALE_RETRIES` times. With `pinned`, the owner's own `expected_revision` is sent once: a
 * stale one is the owner's to look at, not the tool's to retry. An accepted change that is not a dry
 * run marks the run as having done something.
 */
export async function sendAtRevision(ctx: Ctx, server: "applier" | "steward", tool: string, changes: Change[], o: { dryRun: boolean; pinned?: number }):
Promise<Record<string, any>> {
  const send = async (rev: number): Promise<Reply> => server === "applier"
    ? (await ctx.applier()).configure({ changes, expected_revision: rev, dry_run: o.dryRun })
    : (await ctx.steward()).define({ changes, expected_revision: rev, dry_run: o.dryRun });
  for (let attempt = 0; ; attempt++) {
    const rev = o.pinned ?? (server === "applier" ? await applierRevision(ctx) : await stewardRevision(ctx));
    let reply: Reply;
    try {
      reply = await send(rev);
    } catch (err) {
      // A change sent and then lost may have been taken: the owner looks before sending it again (review M2).
      if (err instanceof Lost && !o.dryRun) {
        throw new Lost(`${err.message}: the change may still take effect; check with ${server === "applier" ? "galatea devices" : "galatea status (the steward's revision)"} before sending it again`,
          err.answered);
      }
      throw err;
    }
    if (reply.kind === "refused" && reply.error === "stale_revision" && o.pinned === undefined && attempt < STALE_RETRIES) continue;
    const body = need(reply, server, tool);
    if (!o.dryRun) ctx.done = true;
    return body;
  }
}
