/** The plain-line and JSON renderings (the design, *The package*). Nothing here is given a secret to render. */

type Body = Record<string, any>;

/** One JSON document on one line, as `--json` prints a body. */
export const jsonLine = (v: unknown): string => JSON.stringify(v);

/** A configure's or a define's answer: its revision, or a dry run's diff, line by line. */
export function changeLines(body: Body, what: string): string[] {
  // Both servers answer a dry run that changes nothing with the diff "no change".
  if (typeof body.diff === "string") return body.diff === "" || body.diff === "no change" ? [`${what}: the dry run changes nothing`] : [`${what}, a dry run:`, ...body.diff.split("\n").map((l: string) => `  ${l}`)];
  return [`${what}: revision ${body.revision}`];
}

/** The bridge a device came through: the bridge it names, else its id's prefix. */
export const bridgeOf = (d: Body): string => d.bridge_device?.bridge ?? String(d.id).split(":")[0];

/**
 * One device's line: id, bridge, adopted with its class or the class proposed and its evidence,
 * liveness, and the steward's name and room. `t` is the steward's target, `null` when the steward
 * does not hold the device, `undefined` when the steward was not reached.
 */
export function deviceLine(d: Body, t: Body | null | undefined, liveness: string | undefined): string {
  const parts = [d.id, `bridge ${bridgeOf(d)}`];
  if (d.adopted) parts.push(`adopted, class ${d.class ?? "none"}`);
  else parts.push(`not adopted, proposed ${d.proposed_class ?? "no class"}${d.class_evidence ? ` (${d.class_evidence})` : ""}`);
  parts.push(liveness ?? "liveness not known");
  if (t === undefined) {
    parts.push("steward not reached");
  } else if (t === null) {
    parts.push("not at the steward");
  } else {
    // The steward names a device the owner did not name by its bridge's label, else its id: such a
    // name is not the owner's (a name the owner set equal to the label reads as none).
    const label = t.label ?? d.label;
    const named = t.name === undefined || t.name === d.id ? "no name" : t.name === label ? `no name (label «${label}»)` : `«${t.name}»`;
    parts.push(t.room ? `${named} in ${t.room}` : `${named}, no room`);
  }
  return parts.join("  ");
}

/** `--all`'s lines under a device: its capabilities, and each action with its tier. */
export function deviceDetail(d: Body): string[] {
  const lines = [`    capabilities: ${(d.capabilities ?? []).join(", ") || "none"}`];
  for (const a of d.actions ?? []) lines.push(`    ${a.action}  ${a.tier}`);
  return lines;
}
