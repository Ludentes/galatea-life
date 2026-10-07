import { type Ctx, type Exit, need, Usage } from "../context.js";
import { jsonLine } from "../print.js";
import { sendAtRevision } from "../revision.js";
import { vocabulary } from "../vocabulary.js";
import type { Change } from "../servers.js";

/** `--tier action=tier`, each one a `tier` change. */
export function parseTiers(device: string, tiers: string[]): Change[] {
  const TIERS = vocabulary().tiers;
  return tiers.map((t) => {
    const m = /^([^=\s]+)=(\S+)$/.exec(t);
    if (!m) throw new Usage(`--tier is action=tier: ${JSON.stringify(t)} is not`);
    if (!TIERS.includes(m[2])) throw new Usage(`a tier is one of ${TIERS.join(", ")}: ${JSON.stringify(m[2])} is not`);
    return { op: "upsert", kind: "tier", value: { device, action: m[1], tier: m[2] } };
  });
}

/**
 * `galatea adopt <device> --class C [--tier action=tier]...` (plan A: no name or room yet). The
 * applier's `configure` of the `adopt` change and any `tier` changes, at the revision it read,
 * `stale_revision` retried twice (the design, *Pairing*, step 1). A device the applier does not
 * describe is refused before anything is sent.
 */
export async function adopt(ctx: Ctx, device: string | undefined, cls: string | undefined, tiers: string[]): Promise<Exit> {
  if (!device) throw new Usage("galatea adopt <device> --class C [--tier action=tier]...: name the device");
  if (!cls) throw new Usage("--class is needed: the class the device is adopted as (galatea devices shows the proposed one)");
  const { classes } = vocabulary();
  if (!classes.includes(cls)) throw new Usage(`a class is one of ${classes.join(", ")}: ${JSON.stringify(cls)} is not`);
  const tierChanges = parseTiers(device, tiers);
  const model = need(await (await ctx.applier()).describe(), "applier", "describe");
  const d = (model.devices ?? []).find((x: { id: string }) => x.id === device);
  if (!d) throw new Usage(`the applier describes no device ${device} (galatea devices lists them)`);
  for (const c of tierChanges) {
    const action = (c.value as { action: string }).action;
    if (!(d.actions ?? []).some((a: { action: string }) => a.action === action)) throw new Usage(`${device} offers no action ${action}`);
  }
  const body = await sendAtRevision(ctx, "applier", "configure",
    [{ op: "upsert", kind: "adopt", value: { device, class: cls } }, ...tierChanges], { dryRun: false });
  if (ctx.json) {
    ctx.say.out(jsonLine(body));
  } else {
    ctx.say.out(`adopted ${device} as ${cls}${d.adopted ? " (it was adopted already)" : ""}, revision ${body.revision}`);
    for (const c of tierChanges) ctx.say.out(`  ${(c.value as { action: string }).action} at ${(c.value as { tier: string }).tier}`);
  }
  return 0;
}
