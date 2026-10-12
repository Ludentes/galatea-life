import { describe, expect, it, vi } from "vitest";
import { lasting, memoryDb } from "./db.js";
import { FakeApplier } from "./fake-applier.js";
import { FakeClock } from "./fake-clock.js";
import { BASELINE, SECRETS, up } from "./house.js";
import { describeOf, DEVICES, quiet, setup } from "./setup.js";

type Body = Record<string, any>;
const CHANNEL = "sim-bridge:channel";
const SPEAKER = "sim-bridge:speaker";
const SPEAKER_DEVICE = { id: SPEAKER, label: "speaker", class: "speaker", capabilities: ["media"], adopted: true,
  actions: [{ action: "media.announce", tier: "reversible" }, { action: "media.pause", tier: "reversible" }] };
const WITH_SPEAKER = [...DEVICES, SPEAKER_DEVICE];
/** The baseline without its notice channel: a first change set that names none. */
const SILENT = BASELINE.map((c) => (c.kind === "home" ? up("home", { timezone: "Europe/Moscow" }) : c));
const LEAK = { notice_id: "n-leak", cause: "safety_rule", rule_id: "leak", target: "sim-bridge:valve", text: "Протечка в ванной" };

describe("notice channels (GA-DEF-8, GA-NOTE-1)", () => {
  it("takes a first change set naming no channel, and answers it no_notify_channel: true", async () => {
    const { define } = await setup({ define: false, devices: WITH_SPEAKER });
    expect(await define(SILENT)).toEqual({ revision: expect.any(Number), no_notify_channel: true });
  });

  it("answers no_notify_channel: true to a define that sets announcing channels alone, and nothing once a notify channel is set", async () => {
    const { define } = await setup({ define: false, devices: WITH_SPEAKER });
    expect((await define([...SILENT, up("home", { notice_channels: [SPEAKER] })])).no_notify_channel).toBe(true);
    expect(await define([up("home", { notice_channels: [SPEAKER, CHANNEL] })])).toEqual({ revision: expect.any(Number) });
  });

  it("says no_notify_channel on a dry run whose house would have none, and on a define that changes nothing", async () => {
    const { ok, define } = await setup({ define: false, devices: WITH_SPEAKER });
    const r = await ok(SECRETS.owner, "define", { endpoint: "owner-app", changes: SILENT, dry_run: true,
      expected_revision: (await ok(SECRETS.owner, "describe")).revision });
    expect(r.no_notify_channel).toBe(true);
    await define(SILENT);
    expect((await define(SILENT)).no_notify_channel).toBe(true);
  });

  it("under hides-no-notify-channel, says nothing of it", async () => {
    const { define } = await setup({ define: false, devices: WITH_SPEAKER, mutation: "hides-no-notify-channel" });
    expect(await define([...SILENT, up("home", { notice_channels: [SPEAKER] })])).toEqual({ revision: expect.any(Number) });
  });

  it("shows held_notices in describe while no adopted channel offers notify, and none once one does", async () => {
    const { ok, define, applier, pump } = await setup({ define: false, devices: WITH_SPEAKER });
    await define(SILENT);
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(0);
    applier.raise({ ...LEAK });
    await pump();
    await vi.waitFor(async () => expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(1));
    await define([up("home", { notice_channels: [SPEAKER] })]);
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(1);
    await define([up("home", { notice_channels: [CHANNEL] })]);
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBeUndefined();
  });

  it("shows held_notices again when the notify channel leaves adoption", async () => {
    const { ok, steward } = await setup({ devices: WITH_SPEAKER });
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBeUndefined();
    steward.onDescribe(describeOf(WITH_SPEAKER.map((d: Body) => (d.id === CHANNEL ? { ...d, adopted: false } : d)), 2));
    // Held: the two notices of GA-NOTE-4, the channel's loss and the list's last notify channel's.
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(2);
  });

  it("under hides-the-held-notices, shows no held_notices", async () => {
    const { ok, define } = await setup({ define: false, devices: WITH_SPEAKER, mutation: "hides-the-held-notices" });
    await define(SILENT);
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBeUndefined();
  });
});

/** The applies the steward sent for notices. */
const noticeApplies = (applier: FakeApplier) => applier.applies.filter((a) => String(a.idempotency_key).startsWith("notices:"));
/** The notices each notify of the notice applies carried, by id. */
const notified = (applier: FakeApplier) => noticeApplies(applier).flatMap((a) => (a.request.actions as Body[]).map((x) => `${x.for.notice} ${x.args.text}`));

describe("held notices (GA-NOTE-1, GA-PERSIST-2)", () => {
  it("holds a notice raised before any channel is set, and delivers it at once when a notify channel is set", async () => {
    const { define, applier, pump, clock } = await setup({ define: false, devices: WITH_SPEAKER });
    applier.answerOutcome = "delivered";
    await define(SILENT);
    applier.raise({ ...LEAK });
    await pump();
    clock.advance(0);
    await quiet({ settled: async () => undefined });
    expect(noticeApplies(applier)).toEqual([]);
    await define([up("home", { notice_channels: [CHANNEL] })]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toEqual(["n-leak Протечка в ванной"]); });
    await pump();
    expect(applier.taken).toEqual(["n-leak"]);
  });

  it("delivers held notices at once when the notify channel is adopted again", async () => {
    const { steward, applier, pump, clock } = await setup({ devices: WITH_SPEAKER });
    applier.answerOutcome = "delivered";
    const away = WITH_SPEAKER.map((d: Body) => (d.id === CHANNEL ? { ...d, adopted: false } : d));
    steward.onDescribe(describeOf(away, 2));
    applier.raise({ ...LEAK });
    await pump();
    clock.advance(0);
    expect(noticeApplies(applier)).toEqual([]);
    steward.onDescribe(describeOf(WITH_SPEAKER, 3));
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toContain("n-leak Протечка в ванной"); });
  });

  it("coalesces held notices per kind and target, the latest kept with its count, and takes every one it folded", async () => {
    const { ok, define, applier, pump, clock } = await setup({ define: false, devices: WITH_SPEAKER });
    applier.answerOutcome = "delivered";
    await define(SILENT);
    applier.raise({ ...LEAK, notice_id: "n-1", text: "Первая протечка" });
    applier.raise({ ...LEAK, notice_id: "n-2", text: "Вторая протечка" });
    applier.raise({ ...LEAK, notice_id: "n-3", cause: "window_closed", target: undefined, text: "Окно закрыто" });
    await pump();
    await vi.waitFor(async () => expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(2));
    await define([up("home", { notice_channels: [CHANNEL] })]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier).sort()).toEqual(["n-1 Вторая протечка (2 times)", "n-3 Окно закрыто"]); });
    await pump();
    expect([...applier.taken].sort()).toEqual(["n-1", "n-2", "n-3"]);
  });

  it("judges a notify channel by its actions alone, sending on one whose capabilities do not name notify and holding for one that names it with no notify action (the code review, CR5)", async () => {
    // The channel's capabilities and actions disagree: notify.notify among its actions decides, in holding and in sending.
    const odd = DEVICES.map((d: Body) => (d.id === CHANNEL ? { ...d, capabilities: ["media"] } : d));
    const a = await setup({ devices: odd });
    a.applier.answerOutcome = "delivered";
    a.applier.raise({ ...LEAK });
    await a.pump();
    await vi.waitFor(() => { a.clock.advance(0); expect(notified(a.applier)).toEqual(["n-leak Протечка в ванной"]); });
    const mute = [...DEVICES.map((d: Body) => (d.id === CHANNEL ? { ...d, actions: [{ action: "media.announce", tier: "reversible" }] } : d))];
    // The home's channel set, naming notify among its capabilities but offering only media.announce: held, nothing sent.
    const b = await setup({ devices: mute });
    b.applier.raise({ ...LEAK });
    await b.pump();
    await vi.waitFor(async () => expect((await b.ok(SECRETS.owner, "describe")).held_notices).toBe(1));
    b.clock.advance(120_000);
    await b.pump();
    expect(noticeApplies(b.applier)).toEqual([]);
  });

  it("makes no attempt, and writes nothing, while it holds; the channel's arrival tries at once (the code review, CR6)", async () => {
    const { define, applier, pump, clock, store } = await setup({ define: false, devices: WITH_SPEAKER });
    applier.answerOutcome = "delivered";
    await define(SILENT);
    applier.raise({ ...LEAK });
    await pump();
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      await pump();
    }
    await store.settled();
    const attempts = async () => (await store.query<{ attempts: number }>("SELECT attempts FROM notices WHERE notice_id = 'n-leak'")).rows[0]?.attempts;
    expect(await attempts()).toBe(0);
    await define([up("home", { notice_channels: [CHANNEL] })]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toEqual(["n-leak Протечка в ванной"]); });
  });

  it("coalesces nothing while a notify channel is set", async () => {
    const { applier, pump, clock } = await setup({ devices: WITH_SPEAKER });
    applier.emitsOutcomes = false;
    applier.raise({ ...LEAK, notice_id: "n-1", text: "Первая протечка" });
    applier.raise({ ...LEAK, notice_id: "n-2", text: "Вторая протечка" });
    await pump();
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier).sort()).toEqual(["n-1 Первая протечка", "n-2 Вторая протечка"]); });
  });

  it("keeps a held notice across a restart, delivered once the channel is set (GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const applier = new FakeApplier();
    applier.answerOutcome = "delivered";
    const a = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER });
    await a.define(SILENT);
    applier.raise({ ...LEAK });
    await a.pump();
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER });
    await b.define([up("home", { notice_channels: [CHANNEL] })]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toEqual(["n-leak Протечка в ванной"]); });
  });

  it("keeps a steward's own held notice across a restart (GA-PERSIST-2)", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const applier = new FakeApplier();
    applier.answerOutcome = "delivered";
    const a = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER });
    await a.define(SILENT);
    (a.steward as any).notices.own("steward:test", "test_cause", "Своё уведомление");
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER });
    await b.define([up("home", { notice_channels: [CHANNEL] })]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toEqual(["steward:test Своё уведомление"]); });
  });

  it("under loses-an-early-notice, takes a notice raised before any channel is set, never delivering it", async () => {
    const { define, applier, pump, clock } = await setup({ define: false, devices: WITH_SPEAKER, mutation: "loses-an-early-notice" });
    applier.answerOutcome = "delivered";
    applier.raise({ ...LEAK });
    await pump();
    await pump();
    expect(applier.taken).toEqual(["n-leak"]);
    await define([...SILENT, up("home", { notice_channels: [CHANNEL] })]);
    clock.advance(60_000);
    expect(noticeApplies(applier)).toEqual([]);
  });

  it("under forgets-an-unsent-notice, loses a held notice at a restart", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const applier = new FakeApplier();
    applier.answerOutcome = "delivered";
    const a = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER, mutation: "forgets-an-unsent-notice" });
    await a.define(SILENT);
    applier.raise({ ...LEAK });
    await a.pump();
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, applier, define: false, devices: WITH_SPEAKER, mutation: "forgets-an-unsent-notice" });
    await b.pump();
    expect(applier.taken).toEqual(["n-leak"]);
    await b.define([up("home", { notice_channels: [CHANNEL] })]);
    clock.advance(60_000);
    expect(noticeApplies(applier)).toEqual([]);
  });
});

describe("a channel that stops qualifying (GA-NOTE-4)", () => {
  const PAGER = "sim-bridge:pager";
  const PAGER_DEVICE = { id: PAGER, label: "pager", class: "channel", capabilities: ["notify"], adopted: true, actions: [{ action: "notify.notify", tier: "reversible" }] };
  const ALL = [...WITH_SPEAKER, PAGER_DEVICE];
  const without = (id: string, change: Body) => ALL.map((d: Body) => (d.id === id ? { ...d, ...change } : d));
  const raised = async (ok: (s: string, t: string, a?: Body) => Promise<Body>, cursor: string) =>
    ((await ok(SECRETS.owner, "events", { cursor })).events as Body[]).filter((e) => e.type === "notice" && e.change === "raised" && e.cause === "channel_lost");

  async function listed() {
    const s = await setup({ devices: ALL });
    s.applier.answerOutcome = "delivered";
    await s.define([up("home", { notice_channels: [CHANNEL, PAGER] })]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    return { ...s, cursor: String(cursor) };
  }

  it("raises a notice naming a channel that leaves adoption, delivered on the channel that remains, once", async () => {
    const { steward, ok, cursor, applier, clock } = await listed();
    steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 2));
    steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 3));
    const r = await raised(ok, cursor);
    expect(r.map((e) => [e.target, e.text])).toEqual([[PAGER, expect.stringContaining(PAGER)]]);
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toEqual([`${r[0]!.notice_id} ${r[0]!.text}`]); });
    expect(noticeApplies(applier)[0]!.request.actions.map((a: Body) => a.target)).toEqual([CHANNEL]);
  });

  it("raises one for a channel that no longer offers notify nor media.announce, and none for one gone from the list by define", async () => {
    const { steward, ok, cursor, define } = await listed();
    steward.onDescribe(describeOf(without(PAGER, { capabilities: ["onoff"], actions: [{ action: "onoff.turn_on", tier: "reversible" }] }), 2));
    expect((await raised(ok, cursor)).map((e) => e.target)).toEqual([PAGER]);
    await define([up("home", { notice_channels: [CHANNEL] })]);
    steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 3));
    expect((await raised(ok, cursor)).map((e) => e.target)).toEqual([PAGER]);
  });

  it("raises it again once the channel qualified in between", async () => {
    const { steward, ok, cursor } = await listed();
    steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 2));
    steward.onDescribe(describeOf(ALL, 3));
    steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 4));
    expect((await raised(ok, cursor)).map((e) => e.target)).toEqual([PAGER, PAGER]);
  });

  it("raises a notice when the list loses its last adopted notify channel, held until one returns", async () => {
    const { steward, ok, cursor, applier, clock, define } = await listed();
    await define([up("home", { notice_channels: [CHANNEL, SPEAKER] })]);
    steward.onDescribe(describeOf(without(CHANNEL, { adopted: false }), 2));
    const r = await raised(ok, cursor);
    expect(r.map((e) => e.target)).toEqual([CHANNEL, undefined]);
    expect((await ok(SECRETS.owner, "describe")).held_notices).toBe(2);
    clock.advance(0);
    expect(noticeApplies(applier)).toEqual([]);
    steward.onDescribe(describeOf(ALL, 3));
    await vi.waitFor(() => { clock.advance(0); expect(notified(applier)).toHaveLength(2); });
  });

  it("raises none for a list the owner leaves without a notify channel by define: its answer says so", async () => {
    const { ok, cursor, define } = await listed();
    await define([up("home", { notice_channels: [SPEAKER] })]);
    expect(await raised(ok, cursor)).toEqual([]);
  });

  it("keeps what it told across a restart, raising nothing again for the same loss", async () => {
    const db = lasting(await memoryDb());
    const clock = new FakeClock();
    const applier = new FakeApplier();
    const a = await setup({ db, clock, applier, devices: ALL });
    await a.define([up("home", { notice_channels: [CHANNEL, PAGER] })]);
    a.steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 2));
    await a.store.settled();
    a.steward.stop();
    await a.store.close();
    const b = await setup({ db, clock, applier, define: false, devices: without(PAGER, { adopted: false }), applierRevision: 2 });
    const r = ((await b.ok(SECRETS.owner, "events", { cursor: "0" })).events as Body[]).filter((e) => e.type === "notice" && e.change === "raised" && e.cause === "channel_lost");
    expect(r).toHaveLength(1);
  });

  it("under keeps-a-dead-channel-quiet, raises nothing", async () => {
    const s = await setup({ devices: ALL, mutation: "keeps-a-dead-channel-quiet" });
    await s.define([up("home", { notice_channels: [CHANNEL, PAGER] })]);
    const { cursor } = await s.ok(SECRETS.owner, "events");
    s.steward.onDescribe(describeOf(without(PAGER, { adopted: false }), 2));
    expect(await raised(s.ok, String(cursor))).toEqual([]);
  });
});
