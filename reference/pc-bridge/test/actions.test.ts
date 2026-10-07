import { validate } from "@ludentes/galatea-life-schemas";
import { describe, expect, it } from "vitest";
import { LOCK_MS, NOTIFY_MS } from "../src/bridge.js";
import { ack, ACK, at, BASE, breakable, bridge, changedOnDisk, command, COMMAND, computer, cstatus, CSTATUS, people, useBridges } from "./computer.js";
import { osSession, settle } from "./fakes.js";

useBridges();

describe("session.lock's declaration", () => {
  it("declares account as the tokens accounts lists, a retired one leaving them", async () => {
    const { wire, port, store } = await bridge({ before: people });
    const lockArgs = () => computer(wire).actions.find((a: { action: string }) => a.action === "session.lock").args;
    expect(lockArgs()).toEqual({ account: ["liza", "u1001"] });
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    await changedOnDisk(port, store);
    expect(lockArgs()).toEqual({ account: ["u1001"] });
  });
});

describe("session.lock", () => {
  const lock = (token: unknown) => command({ action: "session.lock", value: token });

  it.each([
    ["a token accounts does not list", "olga"],
    ["no token", undefined],
    ["an object in place of the token", { account: "liza" }],
  ])("refuses %s at once, invalid_request, asking the OS nothing", async (_name, token) => {
    const { wire, port } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; } });
    await wire.deliver(COMMAND, lock(token));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "invalid_request" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("refuses a retired token", async () => {
    const { wire, port } = await bridge({ before: people });
    port.listed = port.listed.slice(1);
    port.deleted = [1000];
    await port.changed();
    await wire.deliver(COMMAND, lock("liza"));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "invalid_request" });
  });

  it("acks an account with no session applied after a fresh observation still finds none, its key none, the status before the ack", async () => {
    const { wire, port } = await bridge({ before: people });
    const mark = wire.calls.length;
    const seen = port.observations;
    await wire.deliver(COMMAND, lock("liza"));
    expect(port.observations).toBeGreaterThan(seen);
    expect(wire.calls.slice(mark)).toEqual([`publish ${CSTATUS}`, `publish ${ACK}`]);
    expect(cstatus(wire)["session.liza"]).toBe("none");
    expect(ack(wire).result).toBe("applied");
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("asks the OS to lock a session opened since the last observation, and acks the lock it took", async () => {
    const { wire, port } = await bridge({ before: people });
    // The person logs in after the last observation, which read no session; the OS has not reported it yet.
    port.sessions = [osSession()];
    await wire.deliver(COMMAND, lock("liza"));
    expect(port.asked).toContain("lock 2");
    expect(ack(wire).result).toBe("applied");
    expect(cstatus(wire)["session.liza"]).toBe("locked");
  });

  it("acks failed(no_graphical_session) when the fresh observation finds only an SSH login opened since", async () => {
    const { wire, port } = await bridge({ before: people });
    port.sessions = [osSession({ graphical: false })];
    await wire.deliver(COMMAND, lock("liza"));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_graphical_session" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("does not spin when the observer is gone at a lock on an account with no session, and acks unreachable at 5 s, asking the OS nothing", async () => {
    const { wire, port, clock } = await bridge({ before: people });
    let reads = 0;
    port.observerPresent = () => {
      reads += 1;
      if (reads > 10_000) throw new Error("check() is spinning");
      return port.present;
    };
    // Gone, and not yet seen gone: the host still reads up at the receipt.
    port.present = false;
    wire.hand(COMMAND, lock("liza"));
    await settle();
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(LOCK_MS);
    expect(reads).toBeLessThan(100);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "unreachable" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  }, 2_000);

  it("acks a lock on an account with no session unreachable when a leave comes before the fresh observation", async () => {
    const { wire, port } = await bridge({ before: people });
    port.observeHeld = new Promise(() => {});
    wire.hand(COMMAND, lock("liza"));
    await settle();
    expect(wire.all(ACK)).toEqual([]);
    await port.emit({ kind: "suspend", announced: true });
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "unreachable" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("acks an account on SSH alone failed(no_graphical_session) at once, asking the OS nothing", async () => {
    const { wire, port } = await bridge({ before: (p) => { people(p); p.sessions = [osSession({ graphical: false })]; } });
    await wire.deliver(COMMAND, lock("liza"));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_graphical_session" });
    expect(validate("bridge/ack.json", ack(wire))).toEqual([]);
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("locks every graphical session of the account, not its SSH login, and acks applied once the OS reports them, the fresh key first", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" }), osSession({ id: "4", remote: true, seat0Active: false }), osSession({ id: "ssh", graphical: false }),
        osSession({ id: "7", osId: 1001, seat0Active: false })];
    } });
    const mark = wire.calls.length;
    await clock.advance(200);
    const cmd = lock("liza");
    await wire.deliver(COMMAND, cmd);
    expect(port.asked).toContain("lock 2,4");
    expect(ack(wire)).toMatchObject({ commandId: cmd.commandId, result: "applied" });
    const after = wire.calls.slice(mark);
    expect(after.slice(-2)).toEqual([`publish ${CSTATUS}`, `publish ${ACK}`]);
    expect(cstatus(wire)).toMatchObject({ "session.liza": "locked", "session.u1001": "unknown" });
    expect(cstatus(wire).timestamps["session.liza"]).toBe(at(clock));
  });

  it("reads the key back before the ack even when the lock leaves it as it was (a disconnected session)", async () => {
    const { wire, port } = await bridge({ before: (p) => { people(p); p.sessions = [osSession({ state: "disconnected" })]; } });
    const mark = wire.calls.length;
    await wire.deliver(COMMAND, lock("liza"));
    expect(port.asked).toContain("lock 2");
    expect(wire.calls.slice(mark).slice(-2)).toEqual([`publish ${CSTATUS}`, `publish ${ACK}`]);
    expect(cstatus(wire)["session.liza"]).toBe("disconnected");
    expect(ack(wire).result).toBe("applied");
  });

  it("acks failed(not_locked) when the OS does not report the lock within 5 s of the receipt", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(LOCK_MS - 1);
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(1);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "not_locked" });
    // The lock is not asked again, and a later lock by the OS changes the key, not the ack.
    port.sessions[0]!.state = "locked";
    await port.changed();
    expect(wire.all(ACK)).toHaveLength(1);
    expect(port.asked.filter((a) => a.startsWith("lock"))).toHaveLength(1);
  });

  it("acks applied when a slow locker reports within the 5 s", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    wire.hand(COMMAND, lock("liza"));
    await clock.advance(3000);
    port.sessions[0]!.state = "locked";
    await port.changed();
    expect(ack(wire).result).toBe("applied");
  });

  it("is failed(unreachable) while the host is down, asking the OS nothing", async () => {
    const { wire, port } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; } });
    port.present = false;
    await port.changed();
    await wire.deliver(COMMAND, lock("liza"));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "unreachable" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toEqual([]);
  });

  it("acks a lock still waiting at a suspend failed(no_confirmation), after the UNSUBACK and before the graceful offline", async () => {
    const { wire, port } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    let unsuback!: () => void;
    wire.unsubscribeHeld = new Promise((r) => { unsuback = r; });
    const suspending = port.emit({ kind: "suspend", announced: true });
    await settle();
    expect(wire.all(ACK)).toEqual([]);
    unsuback();
    await suspending;
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation" });
    const order = wire.calls.filter((c) => c === `publish ${ACK}` || c === `publish ${BASE}/status` || c.startsWith("unsubscribe")).slice(-3);
    expect(order).toEqual([`unsubscribe ${BASE}/devices/+/command ${BASE}/request/+`, `publish ${ACK}`, `publish ${BASE}/status`]);
  });

  it("acks no_confirmation at once when a leave began while the OS was taking the lock", async () => {
    let release!: () => void;
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.lockTakes = false;
      p.lockHeld = new Promise((r) => { release = r; });
    } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    const suspending = port.emit({ kind: "suspend", announced: true });
    await settle();
    release();
    await suspending;
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(wire.last(`${BASE}/status`)!.payload).toMatchObject({ state: "offline", graceful: true });
  });

  it("answers a lock waiting at a suspend the OS did not announce no_confirmation, its timer cleared, and a redelivery gets that ack", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    const cmd = lock("liza");
    wire.hand(COMMAND, cmd);
    await settle();
    await port.emit({ kind: "suspend", announced: false });
    expect(clock.pending).toBe(0);
    expect(ack(wire)).toMatchObject({ commandId: cmd.commandId, result: "failed", reason: "no_confirmation" });
    await port.emit({ kind: "resume", asleepMs: 60_000 });
    const acks = wire.all(ACK).length;
    await wire.deliver(COMMAND, cmd);
    expect(wire.all(ACK)).toHaveLength(acks + 1);
    expect(ack(wire)).toMatchObject({ commandId: cmd.commandId, result: "failed", reason: "no_confirmation" });
    expect(port.asked.filter((a) => a.startsWith("lock"))).toHaveLength(1);
  });

  it.each([
    ["with the OS reporting the change meanwhile", true],
    ["with no report from the OS", false],
  ])("observes afresh when an observation was in flight at the ask, and acks the lock the OS took applied (%s)", async (_name, reported) => {
    const { wire, port, clock } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; } });
    let release!: () => void;
    port.observeHeld = new Promise((r) => { release = r; });
    // An observation begins, reading the session active, and waits on the OS.
    await clock.advance(10_000);
    const cmd = lock("liza");
    wire.hand(COMMAND, cmd);
    await settle();
    expect(port.asked).toContain("lock 2");
    if (reported) await port.changed();
    release();
    port.observeHeld = undefined;
    await settle();
    expect(ack(wire)).toMatchObject({ commandId: cmd.commandId, result: "applied" });
    expect(cstatus(wire)["session.liza"]).toBe("locked");
  });

  it("does not spin when the observer is lost while the OS takes the lock, and acks not_locked at 5 s", async () => {
    let release!: () => void;
    const { wire, port, clock } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.lockHeld = new Promise((r) => { release = r; });
    } });
    // A check that re-loops with no observation never yields: the guard makes it throw instead of hanging the run.
    let reads = 0;
    port.observerPresent = () => {
      reads += 1;
      if (reads > 10_000) throw new Error("check() is spinning");
      return port.present;
    };
    wire.hand(COMMAND, lock("liza"));
    await settle();
    port.present = false;
    release();
    await settle();
    await clock.advance(LOCK_MS);
    expect(reads).toBeLessThan(100);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "not_locked" });
  }, 2_000);

  it("is not applied while a graphical session the account opened after the ask reads unlocked", async () => {
    let release!: () => void;
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession()];
      p.lockHeld = new Promise((r) => { release = r; });
    } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    // A second graphical session opens while the OS takes the lock of the first.
    port.sessions.push(osSession({ id: "5", seat0Active: false }));
    release();
    await settle();
    await port.changed();
    expect(port.sessions[0]!.state).toBe("locked");
    expect(wire.all(ACK)).toEqual([]);
    port.sessions[1]!.state = "locked";
    await port.changed();
    expect(ack(wire).result).toBe("applied");
    expect(cstatus(wire)["session.liza"]).toBe("locked");
  });

  it("acks applied only once the fresh key has gone out, a token save holding it back", async () => {
    const disk = breakable();
    disk.set(false);
    const { wire, port, clock } = await bridge({ store: disk.store, before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    // The observation that reports the lock also gives a token, whose save fails.
    disk.set(true);
    port.listed.push({ osId: 1002, name: "olga", primaryGid: 1002 });
    port.sessions[0]!.state = "locked";
    await port.changed();
    expect(wire.all(ACK)).toEqual([]);
    disk.set(false);
    const mark = wire.calls.length;
    await clock.advance(1000);
    await disk.store.flush();
    await settle();
    expect(ack(wire).result).toBe("applied");
    expect(cstatus(wire)["session.liza"]).toBe("locked");
    const after = wire.calls.slice(mark).filter((c) => c === `publish ${CSTATUS}` || c === `publish ${ACK}`);
    expect(after).toEqual([`publish ${CSTATUS}`, `publish ${ACK}`]);
  });

  it("acks no_confirmation when the OS reported the lock but the key is still held back at 5 s", async () => {
    const disk = breakable();
    disk.set(false);
    const { wire, port, clock } = await bridge({ store: disk.store, before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    disk.set(true);
    port.listed.push({ osId: 1002, name: "olga", primaryGid: 1002 });
    port.sessions[0]!.state = "locked";
    await port.changed();
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(LOCK_MS);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(wire.all(ACK)).toHaveLength(1);
  });

  it("is not applied when the account's graphical sessions close after the ask and only its SSH login remains", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession(), osSession({ id: "ssh", graphical: false })];
      p.lockTakes = false;
    } });
    wire.hand(COMMAND, lock("liza"));
    await settle();
    port.sessions = [osSession({ id: "ssh", graphical: false })];
    await port.changed();
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_graphical_session" });
  });

  it("takes no observation begun before the ask as the OS's word on the lock", async () => {
    const { wire, port, clock } = await bridge({ before: (p) => { people(p); p.sessions = [osSession()]; p.lockTakes = false; } });
    // An observation reads the session locked, and its answer is still on the way when the person unlocks and the lock is asked.
    port.sessions[0]!.state = "locked";
    let release!: () => void;
    port.observeHeld = new Promise((r) => { release = r; });
    await clock.advance(10_000);
    port.sessions[0]!.state = "active";
    wire.hand(COMMAND, lock("liza"));
    await settle();
    release();
    port.observeHeld = undefined;
    await settle();
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(LOCK_MS);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "not_locked" });
  });
});

describe("notify", () => {
  const notify = (value: unknown) => command({ action: "notify.notify", value });

  async function sessions() {
    const r = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2" }), osSession({ id: "7", osId: 1001, seat0Active: false }), osSession({ id: "8", osId: 1001, state: "locked", seat0Active: false }),
        osSession({ id: "9", seat0Active: false })];
    } });
    await r.port.helperConnects("2", 11);
    await r.port.helperConnects("7", 12);
    await r.port.helperConnects("8", 13);
    return r;
  }

  it("is shown in every unlocked session with a helper running, the source first, and acked applied", async () => {
    const { wire, port } = await sessions();
    await wire.deliver(COMMAND, notify({ text: "Ужин готов", urgency: "info", from: { endpoint: "Дмитрий", role: "guest" } }));
    expect(port.notified).toEqual([
      { conn: 11, text: "От: Дмитрий (гость)\nУжин готов", urgency: "info" },
      { conn: 12, text: "От: Дмитрий (гость)\nУжин готов", urgency: "info" },
    ]);
    expect(ack(wire).result).toBe("applied");
  });

  it("marks a notify without from as from an unknown sender", async () => {
    const { wire, port } = await sessions();
    await wire.deliver(COMMAND, notify({ text: "Привет", urgency: "warning" }));
    expect(port.notified[0]!.text).toBe("От: неизвестный отправитель\nПривет");
  });

  it("is acked applied when one helper shows it and another fails, and failed(not_shown) when all fail", async () => {
    const { wire, port } = await sessions();
    port.notifyFails = new Set([11]);
    await wire.deliver(COMMAND, notify({ text: "x", urgency: "info" }));
    expect(ack(wire).result).toBe("applied");
    port.notifyFails = new Set([11, 12]);
    await wire.deliver(COMMAND, notify({ text: "x", urgency: "info" }));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "not_shown", detail: "org.freedesktop.Notifications is not there" });
  });

  it("acks no_confirmation, never not_shown, when no helper showed it and one did not answer within 2 s", async () => {
    const { wire, port, clock } = await sessions();
    port.notifyHangs = new Set([11, 12]);
    wire.hand(COMMAND, notify({ text: "x", urgency: "info" }));
    await settle();
    await clock.advance(NOTIFY_MS - 1);
    expect(wire.all(ACK)).toEqual([]);
    await clock.advance(1);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation", detail: `the helper did not answer within ${NOTIFY_MS} ms` });
    expect(validate("bridge/ack.json", ack(wire))).toEqual([]);
    port.notifyHangs = new Set([11]);
    wire.hand(COMMAND, notify({ text: "x", urgency: "info" }));
    await settle();
    await clock.advance(NOTIFY_MS);
    expect(wire.all(ACK).map((a) => a.payload.result)).toEqual(["failed", "applied"]);
  });

  it("acks no_confirmation when one helper failed and the other did not answer", async () => {
    const { wire, port, clock } = await sessions();
    port.notifyFails = new Set([11]);
    port.notifyHangs = new Set([12]);
    wire.hand(COMMAND, notify({ text: "x", urgency: "info" }));
    await settle();
    await clock.advance(NOTIFY_MS);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation", detail: `the helper did not answer within ${NOTIFY_MS} ms` });
  });

  it("does not hold a leave on a helper that does not answer, acking no_confirmation", async () => {
    const { wire, port } = await sessions();
    port.notifyHangs = new Set([11, 12]);
    wire.hand(COMMAND, notify({ text: "x", urgency: "info" }));
    await settle();
    await port.emit({ kind: "suspend", announced: true });
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(wire.last(`${BASE}/status`)!.payload).toMatchObject({ state: "offline", graceful: true });
  });

  it("is failed(not_shown) when every session is locked or has no helper, never applied", async () => {
    const { wire, port } = await bridge({ before: (p) => {
      people(p);
      p.sessions = [osSession({ id: "2", state: "locked" }), osSession({ id: "3", state: "disconnected" }), osSession({ id: "9" })];
    } });
    await port.helperConnects("2", 11);
    await port.helperConnects("3", 12);
    await wire.deliver(COMMAND, notify({ text: "x", urgency: "critical" }));
    expect(port.notified).toEqual([]);
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "not_shown" });
    expect(validate("bridge/ack.json", ack(wire))).toEqual([]);
  });

  it.each([
    ["a bare text", "hi"],
    ["an urgency of its own", { text: "hi", urgency: "loud" }],
    ["a from of no shape", { text: "hi", urgency: "info", from: { person: "Дмитрий" } }],
  ])("refuses %s invalid_request, showing nothing", async (_name, value) => {
    const { wire, port } = await sessions();
    await wire.deliver(COMMAND, notify(value));
    expect(ack(wire)).toMatchObject({ result: "failed", reason: "invalid_request" });
    expect(port.notified).toEqual([]);
  });
});
