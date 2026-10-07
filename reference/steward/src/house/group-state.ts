import type { Mirror } from "../link/mirror.js";
import type { Group } from "./model.js";

/**
 * A group's `on` (GA-GRP-1): over its members with `onoff`, infrastructure ones included (steward,
 * *The house model*), true when any (`any`) or all (`all`) of them read `on` true, as the applier last
 * reported each; null when no member has `onoff`, or none of them has a reading yet. Once one has, a
 * member with no reading is not on (ruled 2026-10-04).
 */
export function groupOn(g: Group, m: Mirror): boolean | null {
  const onoff = g.members.filter((id) => {
    const caps = m.devices.get(id)?.capabilities;
    return Array.isArray(caps) && caps.includes("onoff");
  });
  if (!onoff.some((id) => m.value(id, "on") !== undefined)) return null;
  const on = onoff.map((id) => m.value(id, "on") === true);
  return g.aggregate === "any" ? on.some(Boolean) : on.every(Boolean);
}
