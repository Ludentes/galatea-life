import { type Ctx, type Exit, FileProblem, Usage } from "../context.js";
import { changeLines, jsonLine } from "../print.js";
import { sendAtRevision } from "../revision.js";
import type { Change } from "../servers.js";

/**
 * A change set's file: the `changes` array alone, or `{ changes, expected_revision? }` and no other key. Nothing of
 * its text is said back, since a credential's secret may be in it (the steward keeps only its digest).
 */
export function parseChangeSet(text: string, what: string): { changes: Change[]; pinned?: number } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new FileProblem(`${what} is not JSON`);
  }
  const set = Array.isArray(v) ? { changes: v } : v as { changes?: unknown; expected_revision?: unknown };
  if (!set || typeof set !== "object" || !Array.isArray(set.changes)) {
    throw new FileProblem(`${what} is neither an array of changes nor an object with \`changes\``);
  }
  if (!Array.isArray(v)) {
    // A request body copied from the standard carries dry_run, endpoint and the like: each is refused, not
    // dropped, so a file that says dry_run is never sent for real (review M1). The key is named, never its value.
    for (const key of Object.keys(set)) {
      if (key === "changes" || key === "expected_revision") continue;
      const named = JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
      throw new FileProblem(key === "dry_run" ? `${what} says dry_run: the tool takes --dry-run instead`
        : `${what} has ${named}: a change set file holds only changes and expected_revision (the tool sends the rest)`);
    }
  }
  for (const c of set.changes as unknown[]) {
    const x = c as Change;
    if (!x || typeof x !== "object" || (x.op !== "upsert" && x.op !== "delete") || typeof x.kind !== "string") {
      throw new FileProblem(`${what}: every change is { op: upsert or delete, kind, value }`);
    }
  }
  const pinned = (set as { expected_revision?: unknown }).expected_revision;
  if (pinned !== undefined && !Number.isInteger(pinned)) throw new FileProblem(`${what}: expected_revision is an integer`);
  return { changes: set.changes as Change[], ...(pinned !== undefined ? { pinned: pinned as number } : {}) };
}

/** `galatea configure <file|-> [--dry-run]`: any applier change set (the design, *The commands*). */
export async function configure(ctx: Ctx, file: string | undefined, dryRun: boolean): Promise<Exit> {
  return changeSet(ctx, "applier", "configure", file, dryRun);
}

/** `galatea define <file|-> [--dry-run]`: any steward change set, at `owner-app`. */
export async function define(ctx: Ctx, file: string | undefined, dryRun: boolean): Promise<Exit> {
  return changeSet(ctx, "steward", "define", file, dryRun);
}

async function changeSet(ctx: Ctx, server: "applier" | "steward", tool: string, file: string | undefined, dryRun: boolean): Promise<Exit> {
  if (!file) throw new Usage(`galatea ${tool} <file|-> [--dry-run]: name the change set's file, or - for standard input`);
  const what = file === "-" ? "the change set on standard input" : `the change set ${file}`;
  const set = parseChangeSet(await ctx.input(file), what);
  if (!set.changes.length) throw new Usage(`${what} holds no change`);
  const body = await sendAtRevision(ctx, server, tool, set.changes, { dryRun, pinned: set.pinned });
  if (ctx.json) ctx.say.out(jsonLine(body));
  else for (const l of changeLines(body, `the ${server}'s ${tool}`)) ctx.say.out(l);
  return 0;
}
