// The hold's negative subjects (steward, *Negative subjects*: GA-LEASE-2, GA-LEASE-7, GA-LEASE-8,
// GA-PERSIST-2): each mutation's case beside its conforming answer, through `underMutation` (R-35).
import { describe, expect, it } from "vitest";
import type { RequestError } from "../src/core/errors.js";
import { planDefine } from "../src/house/define.js";
import { HOLD_DEFAULTS, type HoldPolicy } from "../src/house/model.js";
import { judgeHold, type HoldState, type RoomNow } from "../src/leases/hold.js";
import { MUTATIONS, type Mutation } from "../src/mutations.js";
import { baseline, context, SECRETS, up } from "./house.js";
import { setup } from "./setup.js";
import { coveredIn, SUBJECT_MUTATIONS, underMutation, type Pointer, type Scenario } from "./under-mutation.js";

const S = 1000;
const P: HoldPolicy = { ...HOLD_DEFAULTS, vacant_ends: false };
const V: HoldPolicy = { ...P, vacant_ends: true };
const hall = (o: Partial<RoomNow> = {}): RoomNow => ({ room: "hall", sources: ["m"], adopted: ["m"], busy: false, occupancy: "unknown", ...o });
const hold = (o: Partial<HoldState> = {}): HoldState => ({ kind: "person", direction: "on", changeMs: 0, quietFromMs: 0, floorMs: null,
  fixedFromMs: 0, vacantAtChange: false, seenNotVacant: false, room: "hall", sources: ["m"], adopted: ["m"], ...o });
const busy = hall({ busy: true });
const roomless = { room: null, sources: [], adopted: [] };

/** A scenario's answer as the conforming build gives it, then under `m`. */
const both = async <O>(s: Scenario<O>, m: Mutation) => [await s(), await underMutation(s, m)];
/** A hold judged at `now`: the reason it ends, or (`judged`) when it shows its end or is judged again. */
const ends = (h: HoldState, p: HoldPolicy, r: RoomNow, now: number) => (m?: Mutation) => judgeHold(h, p, r, now, m).end?.why;
const judged = <K extends "expiresMs" | "timerAtMs">(k: K, h: HoldState, p: HoldPolicy, r: RoomNow, now: number) =>
  (m?: Mutation) => judgeHold(h, p, r, now, m)[k];
/** How `define` answers: undefined when it takes the change set, else its refusal's code, field and whether it names schedule_ends. */
const refusal = (f: () => unknown) => {
  try {
    f();
    return undefined;
  } catch (e) {
    const r = e as RequestError;
    return { code: r.code, field: r.data?.field, names: /schedule_ends/.test(r.message) };
  }
};
const defined = (changes: unknown[]) => (m?: Mutation) => refusal(() => planDefine(baseline(), changes as never, context(m ? { mutation: m } : {})));
/** `off_s` after the owner set it to 1200 and then defined it null. */
const nulled = (m?: Mutation) => planDefine(planDefine(baseline(), [up("home", { hold: { off_s: 1200 } })], context()).draft,
  [up("home", { hold: { off_s: null } })], context(m ? { mutation: m } : {})).draft.home.hold.off_s;
/** Whether `describe` shows the owner the home's hold policy. */
const showsHold = async (m?: Mutation) => "hold" in (await (await setup({ mutation: m })).ok(SECRETS.owner, "describe")).home;

const HOLD_SUBJECTS: Mutation[] = ["ends-a-hold-while-busy", "never-ends-a-quiet-hold", "same-window-both-ways", "renews-on-a-dead-sensor",
  "vacant-ends-a-remote-hold", "ends-a-hold-before-the-ack", "renews-a-capped-heater", "ends-without-a-reason", "roomless-on-window",
  "renews-when-told-not-to", "fixed-expires", "grants-no-direction", "gap-end-without-time", "hides-the-hold-policy", "refuses-a-short-hold",
  "refuses-a-flag-unnamed", "restarts-the-quiet", "sensor-reading-holds", "metering-holds", "unadopted-holds",
  "ignores-the-cap", "misses-a-vacancy", "quiet-without-its-moment", "floor-waits-past-sent", "ends-a-hold-late", "null-keeps-the-window",
  "keeps-a-removed-hold", "missed-change-full-window"];

/** The subjects whose mutated-against-conforming case is already in another test file, beside the test it breaks. */
const HOLDS = { file: "./holds.test.ts", it: "runs the three mutations at their sites" };
const TABLE = { file: "./lease-table.test.ts", it: "drops end, end_time and direction under their mutations" };
const READINGS = { file: "./hold-leases.test.ts", it: "takes a hold on a sensor reading, a metering key or a device not adopted only under their mutations" };
const ELSEWHERE: Partial<Record<Mutation, Pointer>> = {
  "never-ends-a-quiet-hold": { file: "./holds.test.ts", it: "gives a finite end under never-ends-a-quiet-hold with no cap, so the grant stands (R-50)" },
  "quiet-without-its-moment": HOLDS, "keeps-a-removed-hold": HOLDS, "missed-change-full-window": HOLDS,
  "grants-no-direction": TABLE, "ends-without-a-reason": TABLE, "gap-end-without-time": TABLE,
  "ends-a-hold-late": { file: "./lease-table.test.ts", it: "arms a hold's timer 30 s late under ends-a-hold-late, and no other lease's" },
  "floor-waits-past-sent": { file: "./hold-leases.test.ts", it: "ends the floor at sent, and only past it under floor-waits-past-sent" },
  "sensor-reading-holds": READINGS, "metering-holds": READINGS, "unadopted-holds": READINGS,
  "renews-on-a-dead-sensor": { file: "./hold-leases.test.ts",
    it: "anchors fixed_s where the hall's only source went dead; under renews-on-a-dead-sensor the dead source keeps the quiet window" },
  "restarts-the-quiet": { file: "./hold-restarts.test.ts", it: "under restarts-the-quiet holds a whole on_s from the restart instead" },
};

describe("the hold's negative subjects", () => {
  it("are all declared, all in subject.json, twenty-eight", () => {
    expect(HOLD_SUBJECTS).toHaveLength(28);
    for (const m of HOLD_SUBJECTS) expect([MUTATIONS.includes(m), SUBJECT_MUTATIONS.includes(m)], m).toEqual([true, true]);
  });

  it("those run elsewhere are run there", () => coveredIn(ELSEWHERE));

  it("each moves judgeHold where its row says", async () => {
    expect(await both(ends(hold(), P, busy, 3600 * S), "ends-a-hold-while-busy")).toEqual([undefined, "window"]);
    expect(await both(ends(hold(), P, hall(), 3600 * S), "never-ends-a-quiet-hold")).toEqual(["quiet", undefined]);
    expect(await both(ends(hold({ direction: "off" }), P, hall(), 600 * S), "same-window-both-ways")).toEqual(["quiet", undefined]);
    expect(await both(ends(hold({ vacantAtChange: true }), V, hall({ occupancy: "vacant" }), 100 * S), "vacant-ends-a-remote-hold"))
      .toEqual([undefined, "vacant"]);
    expect(await both(ends(hold({ floorMs: 70 * S }), { ...P, on_s: 1 }, hall(), 2 * S), "ends-a-hold-before-the-ack")).toEqual([undefined, "quiet"]);
    expect(await both(ends(hold({ kind: "load_cap", direction: undefined }), P, busy, 3600 * S), "renews-a-capped-heater")).toEqual(["window", undefined]);
    expect(await both(ends(hold(roomless), { ...P, fixed_s: 600 }, hall(roomless), 600 * S), "roomless-on-window")).toEqual(["window", undefined]);
    expect(await both(ends(hold(), { ...P, presence_renews: false }, busy, 3600 * S), "renews-when-told-not-to")).toEqual(["window", undefined]);
    expect(await both(judged("expiresMs", hold({ floorMs: 70 * S }), { ...P, on_s: 1 }, hall(), 2 * S), "fixed-expires")).toEqual([70 * S, 1 * S]);
    expect(await both(ends(hold(), { ...P, cap_s: 7200 }, busy, 7200 * S), "ignores-the-cap")).toEqual(["cap", undefined]);
    expect(await both(judged("timerAtMs", hold(), V, hall({ vacantAtMs: 500 * S }), 100 * S), "misses-a-vacancy")).toEqual([500 * S, 3600 * S]);
  });

  it("each moves define where its row says", async () => {
    expect(await both(nulled, "null-keeps-the-window")).toEqual([HOLD_DEFAULTS.off_s, 1200]);
    expect(await both(defined([up("home", { hold: { on_s: 20, off_s: 20, other_s: 20, fixed_s: 20 } })]), "refuses-a-short-hold"))
      .toEqual([undefined, expect.objectContaining({ code: "invalid_request" })]);
    expect(await both(defined([up("home", { hold: { schedule_ends: true } })]), "refuses-a-flag-unnamed"))
      .toEqual([{ code: "invalid_request", field: "schedule_ends", names: true }, { code: "invalid_request", field: undefined, names: false }]);
  });

  it("hides-the-hold-policy leaves hold out of the owner's describe", async () => {
    expect(await both(showsHold, "hides-the-hold-policy")).toEqual([true, false]);
  });
});
