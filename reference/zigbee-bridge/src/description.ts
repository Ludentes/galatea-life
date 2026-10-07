/**
 * The port's check of a description (the design, *The doer port*): the shape `Description` gives,
 * which a doer that builds descriptions from a third party's data (the herdsman doer, from the
 * converters) can get wrong. A description that fails it is never taken; its extensions' names are
 * checked separately (`extensionProblems`), since a bad extension is left out, not the device.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");
const optionalStrings = (v: unknown): boolean => v === undefined || strings(v);
/** A bound or a cadence: a finite number of milliseconds, at least 0, or null where none is known. */
const msOrNull = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** A command argument's constraint (`ArgConstraint`): "any", a list of scalars, or `{ min?, max?, step? }` in finite numbers, a step above 0. */
const constraint = (v: unknown): boolean => v === "any"
  || (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x))))
  || (isObject(v) && Object.entries(v).every(([k, x]) => (k === "min" || k === "max" || k === "step")
    && (x === undefined || (typeof x === "number" && Number.isFinite(x) && (k !== "step" || x > 0)))));
const optionalBoolean = (v: unknown): boolean => v === undefined || typeof v === "boolean";
/** A name from the doer, as a fault quotes it: at most 64 characters. */
const quoted = (v: string): string => (v.length > 64 ? `${v.slice(0, 61)}...` : v);

/** What is wrong with an action's shape, or undefined when nothing is. */
function actionProblem(a: Record<string, unknown> & { action: string }): string | undefined {
  const name = quoted(a.action);
  if (typeof a.idempotent !== "boolean" || typeof a.stateless !== "boolean" || typeof a.confirms !== "boolean") {
    return `${name} does not say whether it is idempotent, stateless and confirmed`;
  }
  if (!optionalBoolean(a.toggles) || !optionalBoolean(a.wholeState)) return `${name}: toggles or wholeState is no boolean`;
  if (a.args !== undefined) {
    if (!isObject(a.args)) return `${name}: args is no map of constraints`;
    for (const [arg, c] of Object.entries(a.args)) if (!constraint(c)) return `${name}: the argument ${quoted(arg)} has no constraint`;
  }
  if (a.confirmedBy !== undefined && (!isObject(a.confirmedBy) || typeof a.confirmedBy.key !== "string" || !("value" in a.confirmedBy))) {
    return `${name}: confirmedBy is not { key, value }`;
  }
  return undefined;
}

/** What is wrong with a description's shape, or undefined when nothing is. */
export function descriptionProblem(d: unknown): string | undefined {
  if (!isObject(d)) return "it is no object";
  if (typeof d.hardwareId !== "string" || !d.hardwareId) return "hardwareId is no name";
  if (typeof d.stableIdentifier !== "string") return "stableIdentifier is no string";
  // The blocklist and `remove { identifier }` name hardware by its stableIdentifier, which is the doer's id for it.
  if (d.stableIdentifier !== d.hardwareId) return "stableIdentifier is not the hardware id";
  if (!isObject(d.model) || typeof d.model.vendor !== "string" || typeof d.model.model !== "string") return "model is not { vendor, model }";
  if (!strings(d.capabilities)) return "capabilities is no list of names";
  if (!optionalStrings(d.sensorKeys)) return "sensorKeys is no list of names";
  if (!Array.isArray(d.actions)) return "actions is no list";
  for (const a of d.actions) {
    if (!isObject(a) || typeof a.action !== "string") return "an action has no name";
    const wrong = actionProblem(a as Record<string, unknown> & { action: string });
    if (wrong) return wrong;
  }
  if (d.feedback !== "closed" && d.feedback !== "open") return "feedback is neither closed nor open";
  // Fails closed: a reach the doer cannot give is no reach the core may offer an action on (GA-BRIDGE-7).
  if (typeof d.reachMs !== "number" || !Number.isFinite(d.reachMs) || d.reachMs < 0) return "reachMs is no number of milliseconds";
  if (d.proposedClass !== null && typeof d.proposedClass !== "string") return "proposedClass is neither a class nor null";
  if (!["protocol", "model_db", "none"].includes(d.classEvidence as string)) return "classEvidence is not protocol, model_db or none";
  if (d.otherAdmins !== "unknown" && !(Array.isArray(d.otherAdmins)
    && d.otherAdmins.every((x) => isObject(x) && typeof x.vendor === "string" && typeof x.label === "string"))) {
    return "otherAdmins is neither unknown nor a list of { vendor, label }";
  }
  if (d.extensions !== undefined && !Array.isArray(d.extensions)) return "extensions is no list";
  for (const k of ["personal", "selfChanging", "settings"] as const) if (!optionalStrings(d[k])) return `${k} is no list of keys`;
  if (d.pinRequired !== undefined && typeof d.pinRequired !== "boolean") return "pinRequired is no boolean";
  if (!optionalBoolean(d.router)) return "router is no boolean";
  if (typeof d.basis !== "string") return "basis is no string";
  if (!msOrNull(d.cadenceMs)) return "cadenceMs is neither a number of milliseconds nor null";
  if (!msOrNull(d.basisMaxAgeMs)) return "basisMaxAgeMs is neither a number of milliseconds nor null";
  return undefined;
}
