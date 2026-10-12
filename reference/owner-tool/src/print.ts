/** The plain-line and JSON renderings (the design, *The package*). Nothing here is given a secret to render. */

type Body = Record<string, any>;

/** One JSON document on one line, as `--json` prints a body. */
export const jsonLine = (v: unknown): string => JSON.stringify(v);

/** A configure's or a define's answer: its revision, or a dry run's diff, line by line, then `noChannelLines`. */
export function changeLines(body: Body, what: string): string[] {
  // Both servers answer a dry run that changes nothing with the diff "no change".
  const lines = typeof body.diff === "string"
    ? body.diff === "" || body.diff === "no change" ? [`${what}: the dry run changes nothing`] : [`${what}, a dry run:`, ...body.diff.split("\n").map((l: string) => `  ${l}`)]
    : [`${what}: revision ${body.revision}`];
  return [...lines, ...noChannelLines(body)];
}

/**
 * The line a define's answer earns when the house after it has no `notify` channel (steward 0.11,
 * GA-NOTE-1: `no_notify_channel: true`): the steward holds every notice until one is set.
 */
export function noChannelLines(body: Body): string[] {
  return body.no_notify_channel === true ? ["  no notify channel: notices are held until notice_channels names a device that offers notify"] : [];
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

/** A word as a shell takes it back: bare when it is plain, else in single quotes (a printed line to run again). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9._:/=@+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * Third-party text (a bridge's or plugin's `detail`, a reason, an id, an event's field) as a plain
 * line shows it: a newline as `\\n`, every other C0 or C1 control character and DEL as `\\xNN`, so
 * nothing a device or plugin says can drive the owner's terminal (review M6). `--json` escapes them already.
 */
export function clean(text: string): string {
  return text.replace(/\n/g, "\\n").replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
