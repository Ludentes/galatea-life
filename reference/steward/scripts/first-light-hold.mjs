// The hold policy a first-light run sets and puts back. Side-effect-free and small on purpose: the script is a
// plain .mjs against a live install and shares none of the harness's helpers.
//
// A run shortens the hold windows to 20 s so a step's wait stays short, and keeps presence from renewing or
// ending a hold. Each field is set in its own `define`, so a refusal names the field it refused (`data.field`);
// teardown writes back, field by field, the values `describe` showed before the run, never `null`.

export const RUN_HOLD = { on_s: 20, off_s: 20, other_s: 20, fixed_s: 20, load_cap_s: 20, presence_renews: false, vacant_ends: false };
/** The run lifts the cap explicitly, so a cap an owner set earlier cannot cut a run's hold short. */
export const RUN_CAP_S = 0;

const { presence_renews, vacant_ends, ...windows } = RUN_HOLD;
const RUN_SETS = { ...windows, cap_s: RUN_CAP_S, presence_renews, vacant_ends };
const homeHold = (field, value) => ({ op: "upsert", kind: "home", value: { hold: { [field]: value } } });

/** The define ops that set the run's policy: one per field. */
export function setOps() {
  return Object.entries(RUN_SETS).map(([field, value]) => homeHold(field, value));
}

/** The define ops that restore what the run set, from `describe`'s `home.hold` read before it: one per field
 * (all the run sets, or just `fields`, the ones it got to). */
export function holdOps(recorded, fields = Object.keys(RUN_SETS)) {
  return fields.map((field) => {
    const value = recorded?.[field];
    if (value === undefined || value === null) throw new Error(`the recorded hold has no ${field} to restore`);
    return homeHold(field, value);
  });
}

/** What a set's answer means: `ok`; a refusal naming a field (`invalid_request`, `data.field`) is `refused`, the
 * run stopping cleanly; anything else is `failed`. `result` is the MCP seam's `{ ok, error, message, body }`. */
export function judgeSet(result) {
  if (result.ok) return { kind: "ok" };
  const field = result.body?.data?.field;
  if (result.error === "invalid_request" && typeof field === "string") return { kind: "refused", field, message: result.message };
  return { kind: "failed", error: result.error, message: result.message };
}
