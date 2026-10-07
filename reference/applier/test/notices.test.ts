import { describe, expect, it } from "vitest";
import { Notices } from "../src/core/notices.js";
import { Store } from "../src/core/store.js";
import { lasting, memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

async function setup(mutation?: "forgets-a-notice") {
  const clock = new FakeClock();
  const db = lasting(await memoryDb());
  const store = await Store.open(db, clock, (err) => { throw err; });
  const notices = new Notices(store, clock);
  await notices.load();
  /** The notices a restart finds, once everything handed over has committed. */
  const again = async () => {
    await store.settled();
    const next = new Notices(await Store.open(db, clock, (err) => { throw err; }), clock, mutation);
    await next.load();
    return next;
  };
  return { clock, db, store, notices, again };
}

const fault = { cause: "bridge_fault", devices: ["b:lamp"], text: "the lamp has no PIN" };

describe("Notices", () => {
  it("lists a notice until it is taken, oldest first, and keeps it across a restart", async () => {
    const { clock, notices, again } = await setup();
    const a = notices.raise(fault)!;
    clock.advance(1000);
    const b = notices.raise({ cause: "store", text: "the store is away" })!;
    expect(a).toEqual({ ...fault, notice_id: a.notice_id });
    expect(notices.list()).toEqual([a, b]);
    expect((await again()).list()).toEqual([a, b]);
    notices.take([a.notice_id, "no-such-notice"]);
    expect(notices.list()).toEqual([b]);
    expect((await again()).list()).toEqual([b]);
  });

  it.each([undefined, "forgets-a-notice"] as const)("carries an untaken notice across a restart; mutation %s forgets it (GA-SAFE-8)", async (mutation) => {
    const { notices, again } = await setup(mutation);
    const a = notices.raise(fault)!;
    expect((await again()).list()).toEqual(mutation ? [] : [a]);
  });

  it("raises a keyed notice once while it stands, taken or not, across a restart, and again once it cleared", async () => {
    const { notices, again } = await setup();
    const first = notices.raise(fault, "k")!;
    expect(notices.raise(fault, "k")).toBeUndefined();
    notices.take([first.notice_id]);
    expect(notices.raise(fault, "k")).toBeUndefined();
    const later = await again();
    expect(later.list()).toEqual([]);
    expect(later.standing("k")).toBe(true);
    expect(later.raise(fault, "k")).toBeUndefined();
    later.clear("k");
    const second = later.raise(fault, "k")!;
    expect(second.notice_id).not.toBe(first.notice_id);
    expect(later.list()).toEqual([second]);
  });

  it("keeps an untaken keyed notice listed after its condition cleared", async () => {
    const { notices, again } = await setup();
    const n = notices.raise(fault, "k")!;
    notices.clear("k");
    expect(notices.list()).toEqual([n]);
    const later = await again();
    expect(later.list()).toEqual([n]);
    expect(later.standingKeys("")).toEqual([]);
  });

  it("withdraws the untaken notices of a key for a later one, across a restart; a taken one is not listed anyway", async () => {
    const { notices, again } = await setup();
    const taken = notices.raise(fault, "k")!;
    notices.take([taken.notice_id]);
    notices.clear("k");
    const untaken = notices.raise(fault, "k")!;
    const other = notices.raise(fault, "other")!;
    notices.withdraw("k");
    expect(notices.list()).toEqual([other]);
    expect(notices.standing("k")).toBe(false);
    const later = await again();
    expect(later.list()).toEqual([other]);
    expect(later.standing("k")).toBe(false);
    expect(untaken.notice_id).not.toBe(taken.notice_id);
  });

  it("names the keys that stand under a prefix", async () => {
    const { notices } = await setup();
    notices.raise(fault, "bridge_fault:b:lamp:no_pin");
    notices.raise(fault, "bridge_fault:c:lamp:no_pin");
    expect(notices.standingKeys("bridge_fault:b:")).toEqual(["bridge_fault:b:lamp:no_pin"]);
  });
});
