import { test } from "vitest";
import assert from "node:assert/strict";
import { RUN_HOLD, RUN_CAP_S, setOps, holdOps, judgeSet, ownSwitches } from "../scripts/first-light-hold.mjs";

const recorded = { on_s: 3600, off_s: 600, other_s: 3600, fixed_s: 3600, load_cap_s: 3600, cap_s: 43200,
  presence_renews: true, vacant_ends: true, schedule_ends: false, owner_work_passes_guest_holds: true, owner_work_passes_holds: true };
const home = (hold) => ({ op: "upsert", kind: "home", value: { hold } });

test("a run's hold: 20 s windows, presence neither renewing nor ending them, the home's switch off", () => {
  assert.deepEqual(RUN_HOLD, { on_s: 20, off_s: 20, other_s: 20, fixed_s: 20, load_cap_s: 20, presence_renews: false, vacant_ends: false,
    owner_work_passes_holds: false });
  assert.equal(RUN_CAP_S, 0);
});
test("the run sets one field per define, the home's switch last", () => {
  assert.deepEqual(setOps().map((o) => Object.keys(o.value.hold)), [["on_s"], ["off_s"], ["other_s"], ["fixed_s"], ["load_cap_s"], ["cap_s"],
    ["presence_renews"], ["vacant_ends"], ["owner_work_passes_holds"]]);
  assert.deepEqual(Object.assign({}, ...setOps().map((o) => o.value.hold)), { ...RUN_HOLD, cap_s: 0 });
});
test("teardown restores each field the run set as recorded, never the guest flag or schedule_ends", () => {
  const ops = holdOps(recorded);
  assert.deepEqual(ops, [
    home({ on_s: 3600 }), home({ off_s: 600 }), home({ other_s: 3600 }), home({ fixed_s: 3600 }), home({ load_cap_s: 3600 }),
    home({ cap_s: 43200 }), home({ presence_renews: true }), home({ vacant_ends: true }), home({ owner_work_passes_holds: true }),
  ]);
  assert.deepEqual(ops.at(-1), home({ owner_work_passes_holds: true }));
  assert.ok(!JSON.stringify(ops).includes("owner_work_passes_guest_holds") && !JSON.stringify(ops).includes("schedule_ends"));
  const { owner_work_passes_holds: _o, ...older } = recorded;
  assert.throws(() => holdOps(older), /owner_work_passes_holds/);
});

test("a restore never writes null: a field missing from the record is an error", () => {
  const { cap_s: _c, ...partial } = recorded;
  assert.throws(() => holdOps(partial), /cap_s/);
  assert.throws(() => holdOps({ ...recorded, on_s: null }), /on_s/);
});

test("a refusal naming a field stops the run cleanly; anything else is a failure", () => {
  assert.deepEqual(judgeSet({ ok: true, body: {} }), { kind: "ok" });
  assert.deepEqual(judgeSet({ ok: false, error: "invalid_request", message: "no", body: { data: { field: "cap_s" } } }), { kind: "refused", field: "cap_s", message: "no" });
  assert.equal(judgeSet({ ok: false, error: "invalid_request", message: "x", body: {} }).kind, "failed");
  assert.equal(judgeSet({ ok: false, error: "stale_revision", message: "x", body: { data: { field: "cap_s" } } }).kind, "failed");
});

test("a restore of the fields the run got to set writes only those", () => {
  assert.deepEqual(holdOps(recorded, ["on_s", "off_s"]), [home({ on_s: 3600 }), home({ off_s: 600 })]);
  assert.deepEqual(holdOps(recorded, []), []);
});
test("the targets and rules with their own switch set, which stop a run before its first check", () => {
  const describe = { targets: [{ id: "lamp", owner_work_passes_holds: true }, { id: "plug", owner_work_passes_holds: false }, { id: "sensor" }],
    rules: [{ id: "bench-switch-off", passes_holds: true }, { id: "empty-off" }, { id: "night", passes_holds: false }] };
  assert.deepEqual(ownSwitches(describe), ["target lamp", "rule bench-switch-off"]);
  assert.deepEqual(ownSwitches({ targets: [], rules: [] }), []);
  assert.deepEqual(ownSwitches({}), []);
});
