import { describe, expect, it } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { SECRETS, up } from "./house.js";
import { LAMP, setup } from "./setup.js";

const offRule = (o: Record<string, unknown> = {}) => ({ id: "off", name: "Гасить", conditions: [{ target: LAMP, key: "on", op: "eq", value: true }],
  actions: [{ target: LAMP, action: "onoff.turn_off", args: {} }], ...o });

describe("the owner's switches (GA-LEASE-8, GA-LEASE-12)", () => {
  it("shows every switch false where never set", async () => {
    const t = await setup();
    await t.define([up("rule", offRule())]);
    const d = await t.ok(SECRETS.owner, "describe");
    expect(d.home.hold.owner_work_passes_holds).toBe(false);
    expect(d.rules.find((r: any) => r.id === "off").passes_holds).toBe(false);
    expect(d.targets.length).toBeGreaterThan(0);
    for (const x of d.targets) expect(x.owner_work_passes_holds).toBe(false);
    expect(d.standard_version).toBe("0.13");
  });

  it("takes each switch from the owner and shows it as set", async () => {
    const db = lasting(await memoryDb());
    const t = await setup({ db });
    await t.define([up("rule", offRule({ passes_holds: true })), up("target", { id: LAMP, owner_work_passes_holds: true }),
      up("home", { hold: { owner_work_passes_holds: true } })]);
    const d = await t.ok(SECRETS.owner, "describe");
    expect(d.rules.find((r: any) => r.id === "off").passes_holds).toBe(true);
    expect(d.targets.find((x: any) => x.id === LAMP).owner_work_passes_holds).toBe(true);
    expect(d.home.hold.owner_work_passes_holds).toBe(true);
    // Definitions persist (GA-PERSIST-2): a second steward on the same db, as restarts.test.ts starts one.
    const u = await setup({ db, clock: t.clock, define: false, applier: t.applier });
    const e = await u.ok(SECRETS.owner, "describe");
    expect(e.targets.find((x: any) => x.id === LAMP).owner_work_passes_holds).toBe(true);
    expect(e.rules.find((r: any) => r.id === "off").passes_holds).toBe(true);
    expect(e.home.hold.owner_work_passes_holds).toBe(true);
    await t.define([up("home", { hold: { owner_work_passes_holds: null } }), up("target", { id: LAMP, owner_work_passes_holds: null })]);
    const f = await t.ok(SECRETS.owner, "describe");
    expect(f.home.hold.owner_work_passes_holds).toBe(false);
    expect(f.targets.find((x: any) => x.id === LAMP).owner_work_passes_holds).toBe(false);
  });

  it("keeps a rule's mark across an upsert that leaves it out, and the owner's whole redefinition may clear it", async () => {
    const t = await setup();
    await t.define([up("rule", offRule({ passes_holds: true }))]);
    await t.define([up("rule", { id: "off", name: "Гасить свет" })]);
    expect((await t.ok(SECRETS.owner, "describe")).rules.find((r: any) => r.id === "off").passes_holds).toBe(true);
    await t.define([up("rule", offRule({ passes_holds: false }))]);
    expect((await t.ok(SECRETS.owner, "describe")).rules.find((r: any) => r.id === "off").passes_holds).toBe(false);
  });

  it("never refuses the home's switch; refuses it under refuses-the-owner-switch", async () => {
    const t = await setup({ mutation: "refuses-the-owner-switch" });
    const r = await t.call(SECRETS.owner, "define", { endpoint: "owner-app", changes: [up("home", { hold: { owner_work_passes_holds: true } })],
      expected_revision: (await t.ok(SECRETS.owner, "describe")).revision, dry_run: false });
    expect(r).toMatchObject({ ok: false, error: "invalid_request", data: { field: "owner_work_passes_holds" } });
    // Under the mutation the switch left false or cleared still passes.
    await t.define([up("home", { hold: { owner_work_passes_holds: false } })]);
  });
});
