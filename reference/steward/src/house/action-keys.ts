import { sets, type ConfirmedBy, type Match } from "@ludentes/galatea-life-schemas";

/**
 * The key a standard action sets, as the shared table gives it (`standard/applier.md`, the capability
 * table; applier GA-EVT-3), and for `media.launch` the keys it reports with `playing`. `session.lock`'s
 * key is its argument's (`setByAnAction`).
 */
function standardKeys(action: string): string[] {
  if (action === "media.launch") return ["playing", "title", "started_at"];
  if (action === "session.lock") return [];
  const s = sets(action, {});
  return s ? [s.key] : [];
}

/** The state keys `device`'s actions set: the key each one's ack is matched on (applier GA-EVT-3), an extension action's `confirmed_by.key` (GA-LEASE-2). */
export function keysSetBy(device: { actions?: unknown[] }): Set<string> {
  const out = new Set<string>();
  for (const a of (device.actions ?? []) as { action?: string; confirmed_by?: { key?: string } }[]) {
    for (const k of standardKeys(String(a.action))) out.add(k);
    if (typeof a.confirmed_by?.key === "string") out.add(a.confirmed_by.key);
  }
  return out;
}

/** Whether a key is one an action of the device sets; `session.<account>` for `session.lock` (GA-LEASE-2). */
export function setByAnAction(device: { actions?: unknown[] } | undefined, key: string): boolean {
  if (!device) return false;
  if (key.startsWith("session.") && (device.actions ?? []).some((a) => (a as { action?: string }).action === "session.lock")) return true;
  return keysSetBy(device).has(key);
}

/** The report a step's ack is matched on: its key, how a report matches it, kept as data (persisted with a hold), and the value it set where one is named. */
export type Expect = { key: string; match: Match; value?: unknown };

/** `c` as a `confirmed_by`, or undefined: a key, and a scalar or `{ arg }` value. */
function confirmedBy(c: { key?: unknown; value?: unknown } | undefined): ConfirmedBy | undefined {
  if (typeof c?.key !== "string") return undefined;
  const v = c.value;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { key: c.key, value: v };
  if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { arg?: unknown }).arg === "string") return { key: c.key, value: { arg: (v as { arg: string }).arg } };
  return undefined;
}

/**
 * The report a step's ack is matched on (applier GA-EVT-3), which ends a hold's floor for passing
 * (GA-LEASE-10, GA-LEASE-12; R-6): what the shared table says the action sets, matched as the applier
 * matches its ack (within a numeric key's tolerance, a colour whatever its case, `session.lock` by
 * `locked`, `disconnected` or `none`), or an extension action's `confirmed_by`. None for an action
 * declared `toggles`, nor where none is known (an argument not given, `media.launch`, an extension
 * action with no `confirmed_by`).
 */
export function reportOf(action: string, args: Record<string, unknown>,
  declared?: { toggles?: unknown; confirmed_by?: { key?: unknown; value?: unknown } }): Expect | undefined {
  if (declared?.toggles === true) return undefined;
  if (action === "session.lock" && typeof args.account !== "string") return undefined;
  const s = sets(action, args, confirmedBy(declared?.confirmed_by));
  if (!s || (s.match.kind !== "one_of" && s.value === undefined)) return undefined;
  return { key: s.key, match: s.match, ...(s.value !== undefined ? { value: s.value } : {}) };
}
