import { canonical } from "../core/canonical.js";
import type { Mutation } from "../mutations.js";
import type { Condition, Reading } from "../house/model.js";
import { windowHolds } from "./window.js";

/** A value as the mirror holds it: an `assumed` one is the applier's guess from its last command (applier GA-STATE-4). */
export interface Value { value: unknown; assumed: boolean }

/** What a rule reads of one device: whether it is `live`, a key's value, and whether a key is a retired account's. */
export interface DeviceRead {
  live: boolean;
  value(key: string): Value | undefined;
  /** A `session.<token>` key whose token the computer's `accounts` no longer lists (bridge GA-BRIDGE-52). */
  retired(key: string): boolean;
}

/** What a rule's evaluation reads: each device, the instant and the home's timezone. */
export interface View {
  device(id: string): DeviceRead | undefined;
  now: number;
  tz: string;
  mutation?: Mutation;
  /** Reads an `assumed` value as observed: a scenario's `if` under `branches-on-an-assumed-value`, set where that mutation is compared. */
  readsAssumed?: boolean;
}

const compare = (op: Reading["op"], a: unknown, b: unknown): boolean => {
  if (op === "eq") return canonical(a) === canonical(b);
  if (op === "ne") return canonical(a) !== canonical(b);
  if (typeof a !== "number" || typeof b !== "number") return false;
  return op === "gt" ? a > b : op === "ge" ? a >= b : op === "lt" ? a < b : a <= b;
};

/**
 * Whether a reading holds (steward, *Rules*): never on a device that is not `live` (GA-RULE-2), nor on
 * a retired account's key, `not_in` included (GA-RULE-4), nor on an `assumed` value (GA-RULE-2).
 * `not_in` holds when the key reads none of its values, a key reading `unknown` (unless listed) and an
 * absent key included (GA-RULE-4); a comparison never holds on an absent key, and an order (`gt`,
 * `ge`, `lt`, `le`) only between numbers. Mutations: `rule-on-stale-reading` reads a device that is
 * not live; `rule-on-an-assumed-value` an assumed value; `fires-on-a-retired-token` a retired key as
 * absent; `not-in-skips-unknown` reads `not_in` false on an absent or `unknown` key.
 */
export function readingHolds(r: Reading, v: View): boolean {
  const d = v.device(r.target);
  if (!d) return false;
  if (!d.live && v.mutation !== "rule-on-stale-reading") return false;
  if (d.retired(r.key) && v.mutation !== "fires-on-a-retired-token") return false;
  const x = d.retired(r.key) ? undefined : d.value(r.key);
  if (x?.assumed && v.mutation !== "rule-on-an-assumed-value" && !v.readsAssumed) return false;
  if (r.not_in) {
    if ((x === undefined || x.value === "unknown") && v.mutation === "not-in-skips-unknown") return false;
    return x === undefined || !r.not_in.some((y) => canonical(y) === canonical(x.value));
  }
  return x !== undefined && compare(r.op, x.value, r.value);
}

/** Whether one condition holds: a reading, or a time window (GA-RULE-3). */
export function conditionHolds(c: Condition, v: View): boolean {
  return "between" in c ? windowHolds(c.between, v.now, v.tz, v.mutation) : readingHolds(c, v);
}

/** Whether a rule's conditions hold, taken whole (GA-RULE-2): every one, none given holding too. */
export function conditionsHold(cs: Condition[] | undefined, v: View): boolean {
  return (cs ?? []).every((c) => conditionHolds(c, v));
}
