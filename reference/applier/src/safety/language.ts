/**
 * The safety rule language this build takes (provisional until the standard names one; applier,
 * *Safety rules*, gives only `{ id, trigger, conditions, actions, latch?, notice? }`): comparisons of
 * one key of one of the applier's own devices with a constant, joined by `all` and `any`. Nothing
 * else: no time, no arithmetic, no key against key, no `not`, no occurrence, no liveness term, no
 * other applier's device. What it leaves out, and why, is in the design's *Safe*.
 */

export type Op = "eq" | "ne" | "lt" | "le" | "gt" | "ge";
export type Scalar = string | number | boolean;
/** One comparison: the device's reported value of `key` against `value`. */
export type Term = { device: string; key: string; op: Op; value: Scalar };
export type Expr = Term | { all: Expr[] } | { any: Expr[] };
/** One actuation: an action of the applier's own device, as a request would name it. */
export type RuleAction = { target: string; action: string; args?: Record<string, unknown> };
export type SafetyRule = {
  id: string;
  trigger: Expr;
  conditions?: Expr;
  actions: RuleAction[];
  /** Held from firing until its condition is true on reported values (GA-SAFE-7): slice 6b. */
  latch?: { condition: Expr };
  notice?: { text: string };
  /** The owner's word that another controller of an actuated device may undo the rule (GA-SAFE-6). */
  accepts_other_admins?: boolean;
};

const isTerm = (e: Expr): e is Term => "key" in e;

/** Every comparison in `e`. */
export function terms(e: Expr | undefined): Term[] {
  if (!e) return [];
  if (isTerm(e)) return [e];
  return ("all" in e ? e.all : e.any).flatMap((x) => terms(x));
}

/**
 * Whether `e` holds on the values `read` gives. A key with no value holds no comparison, `ne`
 * included: what is not known never satisfies a condition (an `assumed` value is not known, GA-SAFE-11).
 * An order compares numbers only.
 */
export function evaluate(e: Expr, read: (device: string, key: string) => unknown): boolean {
  if (!isTerm(e)) return "all" in e ? e.all.every((x) => evaluate(x, read)) : e.any.some((x) => evaluate(x, read));
  const v = read(e.device, e.key);
  if (v === undefined || v === null) return false;
  switch (e.op) {
    case "eq": return v === e.value;
    case "ne": return v !== e.value;
    default: {
      if (typeof v !== "number" || typeof e.value !== "number") return false;
      return e.op === "lt" ? v < e.value : e.op === "le" ? v <= e.value : e.op === "gt" ? v > e.value : v >= e.value;
    }
  }
}

/**
 * Whether `e` holds, three-valued (Kleene): `undefined` where the keys it reads leave it undetermined.
 * A key with no report is unknown; a reported `null` is a known value that holds no comparison, as
 * `evaluate` reads it. `all` is false on any false term, `any` true on any true one, whatever is unknown
 * (the maintainer's ruling 8, the 7b preflight's M1).
 */
export function evaluate3(e: Expr, read: (device: string, key: string) => unknown): boolean | undefined {
  if (!isTerm(e)) {
    const xs = ("all" in e ? e.all : e.any).map((x) => evaluate3(x, read));
    const decisive = "all" in e ? false : true;
    if (xs.includes(decisive)) return decisive;
    return xs.includes(undefined) ? undefined : !decisive;
  }
  return read(e.device, e.key) === undefined ? undefined : evaluate(e, read);
}

/** The keys a rule reads, by device: its trigger's, its conditions' and its latch's. */
export function reads(r: SafetyRule): Term[] {
  return [...terms(r.trigger), ...terms(r.conditions), ...terms(r.latch?.condition)];
}

/** The devices a rule names: those it reads and those it actuates. */
export function devicesOf(r: SafetyRule): string[] {
  return [...new Set([...reads(r).map((t) => t.device), ...r.actions.map((a) => a.target)])];
}

/** The devices a rule actuates. */
export const actuated = (r: SafetyRule): string[] => [...new Set(r.actions.map((a) => a.target))];
