/**
 * Each standard action's keys: the key its ack is matched on (`standard/applier.md`, the capability
 * table; applier GA-EVT-3), and for `media.launch` the keys it reports with `playing`.
 */
const SETS: Record<string, string[]> = {
  "onoff.turn_on": ["on"], "onoff.turn_off": ["on"], "level.set_level": ["level"], "color.set_color": ["color"],
  "climate.set_mode": ["mode"], "climate.set_setpoint": ["setpoint"],
  "cover.open": ["position"], "cover.close": ["position"], "cover.set_position": ["position"],
  "media.pause": ["playing"], "media.resume": ["playing"], "media.set_volume": ["volume"], "media.launch": ["playing", "title", "started_at"],
  "valve.open": ["open"], "valve.close": ["open"], "lock.lock": ["locked"], "lock.unlock": ["locked"],
};

/** The state keys `device`'s actions set: the key each one's ack is matched on (applier GA-EVT-3), an extension action's `confirmed_by.key` (GA-LEASE-2). */
export function keysSetBy(device: { actions?: unknown[] }): Set<string> {
  const out = new Set<string>();
  for (const a of (device.actions ?? []) as { action?: string; confirmed_by?: { key?: string } }[]) {
    for (const k of SETS[String(a.action)] ?? []) out.add(k);
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
