import { describe, expect, it } from "vitest";
import type { Mutation } from "../src/mutations.js";
import { body, DEVICES, flush, home, rule } from "./safe-home.js";

// covers: GA-SAFE-6's computer clauses (the broker's host's administrators, applier_host, the notice
// when one is added or applier_host cleared), GA-CFG-3's applier_host, and the admin notice naming the
// rules whose latch no longer binds that admin; within one life (what is seen is seeded again at a
// restart, GA-PERSIST-1's, slice 7's).

const root = { vendor: "os", label: "root" };
/** A PC whose bridge runs on the broker's own host: it proposes that it carries the broker. */
const pc = (o: Record<string, unknown> = {}) => ({ id: "pc", stableIdentifier: "test:pc", transport: "radio", capabilities: ["power"], actions: [
  { action: "power.sleep", idempotent: true, stateless: false, confirms: true }],
feedback: "closed", reachMs: 0, proposedClass: "computer", classEvidence: "protocol", otherAdmins: [root], proposedInfrastructure: true, ...o });
const desk = (o: Record<string, unknown> = {}) => ({ ...pc(o), id: "desk", stableIdentifier: "test:desk" });
type Home = Awaited<ReturnType<typeof home>>;
const outcome = async (m: Home, changes: unknown[]) => {
  const r = await m.configure(changes);
  return r.ok ? "accepted" : r.message as string;
};
const accepting = rule({ accepts_other_admins: true });
const host = (device: string, on = true) => ({ op: "upsert", kind: "applier_host", value: { device, applier_host: on } });

describe("the broker's host's administrators (GA-SAFE-6)", () => {
  it.each([[undefined, false], ["ignores-the-broker-hosts-admins" as const, true]])("make a rule actuating any device need accepts_other_admins (mutation %s)", async (mutation, taken) => {
    const m = await home({ mutation, extra: [pc()] });
    const r = await outcome(m, [rule()]);
    if (taken) expect(r).toBe("accepted");
    else expect(r).toMatch(/hall:pc carries the broker and has administrators, who reach every device it actuates.*accepts_other_admins: true, or the computer adopted and marked applier_host if the applier itself runs on it \(GA-SAFE-6\)/);
    expect(await outcome(m, [accepting])).toBe("accepted");
  });

  it("say a rule set while the broker's host's proposal arrived during its commit", async () => {
    const m = await home({ extra: [pc({ proposedInfrastructure: undefined })] });
    const store = m.store as unknown as { write: (fn: unknown, o?: unknown) => Promise<unknown> };
    const write = store.write.bind(store);
    let armed = true;
    store.write = (fn, o) => {
      if (armed && String(fn).includes("safety_latches WHERE rule_id")) {
        armed = false;
        // The PC bridge's re-published document now proposes that it carries the broker.
        m.send("devices", { devices: [...DEVICES, pc()] }, true);
      }
      return write(fn, o);
    };
    body(await m.configure([rule()]));
    await flush();
    expect(armed).toBe(false);
    const said = (await m.notices("other_admin")).filter((n: any) => n.rule_id === "leak-closes-valve");
    expect(said).toMatchObject([{ devices: ["hall:pc", "hall:valve"] }]);
    expect(said[0].text).toMatch(/hall:pc carries the broker, and has "root" as administrator/);
    // A second rule, planned after it came, is refused.
    expect(await outcome(m, [rule({ id: "probe-2" })])).toMatch(/hall:pc carries the broker/);
  });

  // One home per test: several in one outlast the test's bound under a parallel run.
  it.each([[[{ vendor: "tuya", label: "cloud" }], false], ["unknown", true], [[], false]] as const)(
    "count an os entry or unknown, not another vendor's (other admins %j)", async (admins, counts) => {
      const m = await home({ extra: [pc({ otherAdmins: admins })] });
      expect(await outcome(m, [rule()]) === "accepted").toBe(!counts);
    });

  it("follow the owner's infrastructure, which outranks the proposal either way", async () => {
    const m = await home({ extra: [pc({ proposedInfrastructure: undefined })] });
    expect(await outcome(m, [rule()])).toBe("accepted");
    body(await m.configure([{ op: "delete", kind: "safety_rule", value: { id: "leak-closes-valve" } }]));
    body(await m.configure([{ op: "upsert", kind: "infrastructure", value: { device: "hall:pc", infrastructure: true } }]));
    expect(await outcome(m, [rule()])).toMatch(/carries the broker/);
  });

  it("take the owner's infrastructure: false over the proposal", async () => {
    const p = await home({ extra: [pc()] });
    body(await p.configure([{ op: "upsert", kind: "infrastructure", value: { device: "hall:pc", infrastructure: false } }]));
    expect(await outcome(p, [rule()])).toBe("accepted");
    expect(body(await p.a.call(p.owner, "describe", {})).devices.find((d: any) => d.id === "hall:pc"))
      .toMatchObject({ infrastructure: false, proposed_infrastructure: true });
  });

  it("count on a computer not adopted yet, its proposal included", async () => {
    const m = await home({ extra: [pc()] });
    body(await m.configure([{ op: "delete", kind: "adopt", value: { device: "hall:pc" } }]));
    expect(await outcome(m, [rule()])).toMatch(/hall:pc carries the broker/);
  });

  it.each([[undefined, true], ["counts-the-applier-hosts-admins" as const, false]])("leave the applier_host's out (mutation %s)", async (mutation, taken) => {
    const m = await home({ mutation, extra: [pc()] });
    body(await m.configure([host("hall:pc")]));
    expect(body(await m.a.call(m.owner, "describe", {})).devices.find((d: any) => d.id === "hall:pc")).toMatchObject({ applier_host: true });
    expect(await outcome(m, [rule()]) === "accepted").toBe(taken);
  });

  it("are an other_admin notice for each rule without accepts_other_admins when applier_host is cleared, or an administrator added", async () => {
    const m = await home({ extra: [pc()] });
    body(await m.configure([host("hall:pc"), rule(), { op: "upsert", kind: "safety_rule", value: { id: "leak-closes-shared",
      trigger: { device: "hall:leak", key: "leak", op: "eq", value: true }, actions: [{ target: "hall:shared", action: "valve.close" }], accepts_other_admins: true } }]));
    const said = async () => (await m.notices("other_admin")).filter((n: any) => n.rule_id).map((n: any) => `${n.rule_id} ${n.devices.join(",")}: ${n.text}`);
    expect(await said()).toEqual([]);
    body(await m.configure([{ op: "delete", kind: "applier_host", value: { device: "hall:pc" } }]));
    expect(await said()).toEqual(["leak-closes-valve hall:pc,hall:valve: hall:pc carries the broker, and has \"root\" as administrator, who reaches "
      + "every device the applier governs. Safety rule leak-closes-valve still runs, but its latch no longer binds that administrator: they can undo what it does."]);
    // The rule still runs.
    expect(body(await m.a.call(m.owner, "describe", {})).safety_rules.map((r: any) => r.id)).toContain("leak-closes-valve");
    // An administrator added to the broker's host: said again, for that one only.
    m.send("devices", { devices: [...DEVICES, pc({ otherAdmins: [root, { vendor: "os", label: "dmitry" }] })] }, true);
    await flush();
    expect((await said()).at(-1)).toMatch(/has "dmitry" as administrator/);
    expect(await said()).toHaveLength(2);
    // The same list again says nothing.
    m.send("devices", { devices: [...DEVICES, pc({ otherAdmins: [root, { vendor: "os", label: "dmitry" }] })] }, true);
    await flush();
    expect(await said()).toHaveLength(2);
  });
});

describe("applier_host (GA-CFG-3)", () => {
  it.each([[undefined, false], ["marks-two-applier-hosts" as const, true]])("is refused on a device that is no computer, and on a second computer (mutation %s)", async (mutation, taken) => {
    const m = await home({ mutation: mutation as Mutation | undefined, extra: [pc(), desk()] });
    const plug = await outcome(m, [host("hall:pulse")]);
    if (taken) expect(plug).toBe("accepted");
    else expect(plug).toMatch(/applier_host is set only on an adopted computer, and hall:pulse is not one \(GA-CFG-3\)/);
    if (taken) body(await m.configure([{ op: "delete", kind: "applier_host", value: { device: "hall:pulse" } }]));
    body(await m.configure([host("hall:pc")]));
    const second = await outcome(m, [host("hall:desk")]);
    if (taken) expect(second).toBe("accepted");
    else expect(second).toMatch(/applier_host is set on hall:pc and hall:desk: the applier runs on one computer \(GA-CFG-3\)/);
  });

  it("moves from one computer to another in one set", async () => {
    const m = await home({ extra: [pc(), desk()] });
    body(await m.configure([host("hall:pc")]));
    expect(await outcome(m, [host("hall:pc", false), host("hall:desk")])).toBe("accepted");
    const d = body(await m.a.call(m.owner, "describe", {})).devices;
    expect([d.find((x: any) => x.id === "hall:pc").applier_host, d.find((x: any) => x.id === "hall:desk").applier_host]).toEqual([undefined, true]);
  });
});

describe("an admin added to a device a safety rule actuates (applier, *Other admins*)", () => {
  it("says the rule still runs and its latch no longer binds that admin", async () => {
    const m = await home();
    body(await m.configure([rule()]));
    const valve = DEVICES.find((d) => d.id === "valve")!;
    m.send("devices", { devices: DEVICES.map((d) => d === valve ? { ...d, otherAdmins: [{ vendor: "tuya", label: "cloud" }] } : d) }, true);
    await flush();
    const [n] = (await m.notices("other_admin")).filter((x: any) => x.devices.includes("hall:valve"));
    expect(n.text).toMatch(/Safety rule leak-closes-valve still runs on it, but its latch no longer binds that admin\.$/);
  });
});
