import type { Principal } from "../auth/principal.js";
import { canonical } from "../core/canonical.js";
import { RequestError } from "../core/errors.js";
import type { House } from "./model.js";

/**
 * The kinds a `define` through a brain may change (ruled, Q4): scenarios, rules, schedules and their
 * exceptions, names (a target's), rooms and groups. Never persons, endpoints, voice records,
 * credentials, the home's settings, nor a lifted narrowing (GA-DEF-3).
 */
export const BRAIN_KINDS: ReadonlySet<string> = new Set(["room", "target", "group", "scenario", "rule", "rule_exception", "schedule",
  "schedule_exception"]);

/**
 * The steward's policy for `define` through a brain (ruled, Q4): the `owner` role only, and only the
 * kinds of `BRAIN_KINDS`. Anything else is `not_permitted` (GA-DEF-3), a kind the steward does not know
 * included, before the change set is read.
 */
export function brainMayDefine(p: Principal, changes: { kind: string }[]): void {
  if (p.role !== "owner") {
    throw new RequestError("not_permitted", `define through a brain is taken from the owner role only (ruled; GA-DEF-3): here ${p.role}`);
  }
  changes.forEach((c, i) => {
    if (!BRAIN_KINDS.has(c.kind)) throw new RequestError("not_permitted", `change ${i + 1} (${c.kind}): through a brain, a ${c.kind} is never changed (GA-DEF-3)`);
  });
}

/** An object's content without its marks, so a mark alone is no change. */
const content = (x: unknown, ...without: string[]) => {
  if (x === undefined) return undefined;
  const copy = { ...(x as Record<string, unknown>) };
  for (const k of ["brain_authored", ...without]) delete copy[k];
  return canonical(copy);
};

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Marks what a brain's change set created or changed as `brain_authored` (GA-DEF-7), on `after`, the
 * model as the change set leaves it. A scenario, rule or schedule new or changed is marked; one
 * upserted unchanged keeps the mark it had. A rule's exceptions and a schedule's are not its content:
 * an exception never marks its rule or its schedule. A schedule's date a brain moved is marked, a skip
 * never (steward, *Authored work*). A device a brain put in a room it was not in carries
 * `room_brain_authored`, and a group's members that joined it through a brain are its `brain_joined`,
 * those already in it keeping what they had. The owner's own change set marks nothing, and clears
 * the marks of what it upserts, since an upsert rebuilds the object whole.
 */
export function markBrain(before: House, after: House): void {
  for (const [id, sc] of after.scenarios) {
    const was = before.scenarios.get(id);
    if (!was || content(was) !== content(sc)) sc.brain_authored = true;
    else if (was.brain_authored) sc.brain_authored = true;
  }
  for (const [id, r] of after.rules) {
    const was = before.rules.get(id);
    if (!was || content(was, "exceptions") !== content(r, "exceptions")) r.brain_authored = true;
    else if (was.brain_authored) r.brain_authored = true;
  }
  for (const [id, s] of after.schedules) {
    const was = before.schedules.get(id);
    if (!was || content(was, "exceptions") !== content(s, "exceptions")) s.brain_authored = true;
    else if (was.brain_authored) s.brain_authored = true;
    for (const x of s.exceptions) {
      const same = was?.exceptions.find((y) => y.date === x.date && content(y) === content(x));
      if (same) {
        if (same.brain_authored) x.brain_authored = true;
      } else if (x.action === "move") x.brain_authored = true;
    }
  }
  for (const [id, t] of after.targets) {
    const was = before.targets.get(id);
    if (t.room == null) delete t.room_brain_authored;
    else if ((was?.room ?? null) !== t.room) t.room_brain_authored = true;
    else if (was?.room_brain_authored) t.room_brain_authored = true;
  }
  for (const [id, g] of after.groups) {
    const was = before.groups.get(id);
    const joined = g.members.filter((m) => !was?.members.includes(m) || was.brain_joined?.includes(m)).sort(byCodePoint);
    if (joined.length) g.brain_joined = joined;
    else delete g.brain_joined;
  }
}

/** Where a device joined through a brain (GA-DEF-7): the room a brain put it in, and the groups it joined through one. */
export function joinedThroughBrain(h: House, device: string): { room: string | null; groups: string[] } {
  const t = h.targets.get(device);
  return { room: t?.room_brain_authored && t.room ? t.room : null,
    groups: [...h.groups.values()].filter((g) => g.brain_joined?.includes(device)).map((g) => g.id).sort(byCodePoint) };
}

/** Whether `describe` shows a device `brain_authored`: it is in a room or a group it joined through a brain. */
export function deviceMarked(h: House, device: string): boolean {
  const j = joinedThroughBrain(h, device);
  return j.room !== null || j.groups.length > 0;
}
