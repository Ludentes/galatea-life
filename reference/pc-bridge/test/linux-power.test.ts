import { afterEach, describe, expect, it, vi } from "vitest";
import type { PowerEvent } from "../src/port.js";
import {
  ANNOUNCED_MAX_MS, INHIBIT_ARGS, Inhibitor, PowerWatch, readUptimeMs, runShutdown, shutdownArgs, SleepMeter, stepClock, UNANNOUNCED_MS,
  type InhibitorChild,
} from "../src/linux/power.js";
import { RunError } from "../src/linux/run.js";
import { fakeRoot, FakeRunner } from "./linux-fakes.js";

const until = async (cond: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A fake `systemd-inhibit`: each spawn is a child a test can end, as a kill from outside would. */
class FakeInhibit {
  readonly children: { released: boolean; end(o?: { missing: boolean }): void }[] = [];
  missing = false;
  readonly spawn = (): InhibitorChild => {
    let end!: (o: { missing: boolean }) => void;
    const exited = new Promise<{ missing: boolean }>((r) => { end = r; });
    const c = { released: false, end: (o = { missing: false }) => end(o) };
    this.children.push(c);
    if (this.missing) end({ missing: true });
    return { exited, release: () => { c.released = true; end({ missing: false }); } };
  };
  held(): number {
    return this.children.filter((c) => !c.released).length;
  }
}

describe("the delay lock", () => {
  it("asks systemd-inhibit for a delay lock on sleep and shutdown, held by a child reading the bridge's pipe", () => {
    expect(INHIBIT_ARGS).toEqual(["--what=sleep:shutdown", "--mode=delay", "--who=galatea-pc-bridge", "--why=The PC bridge acknowledges and goes offline first", "cat"]);
  });

  it("is held once however often it is taken, released once, and taken again", () => {
    const f = new FakeInhibit();
    const lock = new Inhibitor({ spawn: f.spawn });
    lock.take();
    lock.take();
    expect(f.children).toHaveLength(1);
    expect(lock.held()).toBe(true);
    lock.release();
    expect(f.children[0]!.released).toBe(true);
    expect(lock.held()).toBe(false);
    lock.take();
    expect(f.children).toHaveLength(2);
    lock.close();
  });

  it("takes the lock again after a second when its process ends on its own, not after a release", async () => {
    const f = new FakeInhibit();
    const lock = new Inhibitor({ spawn: f.spawn, retryMs: 20 });
    lock.take();
    f.children[0]!.end();
    await until(() => f.children.length === 2);
    lock.release();
    await new Promise((r) => setTimeout(r, 60));
    expect(f.children).toHaveLength(2);
    lock.close();
  });

  it("says once that systemd-inhibit is not installed, and tries no more", async () => {
    const f = new FakeInhibit();
    f.missing = true;
    const lines: string[] = [];
    const lock = new Inhibitor({ spawn: f.spawn, retryMs: 10, log: (l) => lines.push(l) });
    lock.take();
    await new Promise((r) => setTimeout(r, 50));
    lock.take();
    expect(f.children).toHaveLength(1);
    expect(lines).toEqual(["systemd-inhibit is not installed: suspends and shutdowns are not held"]);
  });
});

describe("the time asleep", () => {
  const roots: { cleanup(): void }[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) r.cleanup();
  });

  it("reads /proc/uptime's first field in ms, and refuses what is not a number", async () => {
    const r = fakeRoot({ "/proc/uptime": "35412.27 270116.51\n" });
    roots.push(r);
    expect(await readUptimeMs(r.root)).toBe(35_412_270);
    r.write("/proc/uptime", "garbage\n");
    await expect(readUptimeMs(r.root)).rejects.toThrow(/garbage/);
  });

  it("is uptime's growth less the monotonic clock's between two samples, never below zero", async () => {
    let up = 1_000_000;
    let mono = 50_000;
    const m = new SleepMeter({ uptimeMs: async () => up, monoMs: () => mono });
    expect(await m.gap()).toBe(0);
    up += 1_000;
    mono += 1_000;
    expect(await m.gap()).toBe(0);
    // Asleep 3 h: uptime counted it, the monotonic clock did not.
    up += 10_801_000;
    mono += 1_000;
    expect(await m.gap()).toBe(10_800_000);
    up += 990;
    mono += 1_000;
    expect(await m.gap()).toBe(0);
  });
});

describe("PowerWatch", () => {
  function setup(o: { preparing?: () => Promise<boolean | undefined> } = {}) {
    const f = new FakeInhibit();
    const inhibitor = new Inhibitor({ spawn: f.spawn });
    inhibitor.take();
    let up = 0;
    let mono = 0;
    const meter = new SleepMeter({ uptimeMs: async () => up, monoMs: () => mono });
    const events: PowerEvent[] = [];
    let settleSuspend: (() => void) | undefined;
    const lines: string[] = [];
    const watch = new PowerWatch({
      inhibitor,
      meter,
      mono: () => mono,
      handler: () => async (e) => {
        events.push(e);
        if (e.kind !== "resume") await new Promise<void>((r) => { settleSuspend = r; });
      },
      log: (l) => lines.push(l),
      ...o,
    });
    return {
      f, watch, events, lines,
      advance(awake: number, asleep = 0) { up += awake + asleep; mono += awake; },
      settle() { settleSuspend?.(); },
      failUptime() { meter["read"].uptimeMs = async () => { throw new Error("EACCES"); }; },
    };
  }

  it("holds a suspend until the core's handler settles, then releases the lock; at resume takes it again and reports the time asleep", async () => {
    const t = setup();
    await t.watch.tick();
    const announced = t.watch.announce("sleep", true);
    await until(() => t.events.length === 1);
    expect(t.events[0]).toEqual({ kind: "suspend", announced: true });
    // The handler (the ack, the graceful offline) has not settled: the lock is still held.
    expect(t.f.held()).toBe(1);
    t.settle();
    await announced;
    expect(t.f.held()).toBe(0);
    t.advance(200, 7_200_000);
    await t.watch.announce("sleep", false);
    expect(t.f.held()).toBe(1);
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 7_200_000 });
  });

  it("counts the ticks that ran asleep-side before logind's PrepareForSleep(false) arrived", async () => {
    const t = setup();
    await t.watch.tick();
    const announced = t.watch.announce("sleep", true);
    await until(() => t.events.length === 1);
    t.settle();
    await announced;
    t.advance(100, 60_000);
    await t.watch.tick();
    t.advance(1_000);
    await t.watch.tick();
    // No resume from the ticks: the suspend was announced.
    expect(t.events).toHaveLength(1);
    await t.watch.announce("sleep", false);
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 60_000 });
  });

  it("reports a suspend nobody announced as a resume with its time asleep, measured by the second's sample", async () => {
    const t = setup();
    await t.watch.tick();
    t.advance(1_000);
    await t.watch.tick();
    t.advance(1_000, UNANNOUNCED_MS - 1);
    await t.watch.tick();
    expect(t.events).toEqual([]);
    t.advance(1_000, 90_000);
    await t.watch.tick();
    expect(t.events).toEqual([{ kind: "resume", asleepMs: 90_000 }]);
    // The lock was never released.
    expect(t.f.children).toHaveLength(1);
  });

  it("holds a shutdown until the handler settles, and a shutdown called off takes the lock again and resumes with nothing asleep", async () => {
    const t = setup();
    const announced = t.watch.announce("shutdown", true);
    await until(() => t.events.length === 1);
    expect(t.events[0]).toEqual({ kind: "shutdown", announced: true });
    expect(t.f.held()).toBe(1);
    t.settle();
    await announced;
    expect(t.f.held()).toBe(0);
    await t.watch.announce("shutdown", false);
    expect(t.f.held()).toBe(1);
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 0 });
  });

  it("takes the lock again and reports a resume when logind's resume never comes, once a minute has passed awake (review M11)", async () => {
    const t = setup();
    await t.watch.tick();
    const announced = t.watch.announce("sleep", true);
    await until(() => t.events.length === 1);
    t.settle();
    await announced;
    expect(t.f.held()).toBe(0);
    t.advance(100, 30_000);
    await t.watch.tick();
    t.advance(ANNOUNCED_MAX_MS - 1_000);
    await t.watch.tick();
    expect(t.events).toHaveLength(1);
    expect(t.f.held()).toBe(0);
    t.advance(1_000);
    await t.watch.tick();
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 30_000 });
    expect(t.f.held()).toBe(1);
    expect(t.lines.some((l) => /no resume from logind/.test(l))).toBe(true);
  });

  it("at the bound, waits while logind says it is still preparing, and ends once it is not or cannot say (review N4)", async () => {
    let preparing: boolean | undefined | Error = true;
    const t = setup({
      preparing: async () => {
        if (preparing instanceof Error) throw preparing;
        return preparing;
      },
    });
    await t.watch.tick();
    const announced = t.watch.announce("shutdown", true);
    await until(() => t.events.length === 1);
    t.settle();
    await announced;
    t.advance(ANNOUNCED_MAX_MS);
    await t.watch.tick();
    t.advance(30_000);
    await t.watch.tick();
    // A shutdown whose stop phase runs long: no resume, the lock still released, said once.
    expect(t.events).toHaveLength(1);
    expect(t.f.held()).toBe(0);
    expect(t.lines.filter((l) => /still preparing/.test(l))).toHaveLength(1);
    preparing = false;
    t.advance(1_000);
    await t.watch.tick();
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 0 });
    expect(t.f.held()).toBe(1);
    // logind not to be asked (the bus away), or failing: the pure bound.
    for (const answer of [undefined, new Error("org.freedesktop.DBus.Error.NoReply")]) {
      preparing = answer;
      const again = t.watch.announce("sleep", true);
      await until(() => t.events.length === 3);
      t.settle();
      await again;
      t.advance(ANNOUNCED_MAX_MS);
      await t.watch.tick();
      expect(t.events[3]!.kind).toBe("resume");
      expect(t.f.held()).toBe(1);
      t.events.splice(2);
    }
  });

  it("keeps an announcement open when the bus comes back while logind is still preparing, and ends it once it is not", async () => {
    let preparing: boolean | undefined = true;
    const t = setup({ preparing: async () => preparing });
    await t.watch.tick();
    const announced = t.watch.announce("shutdown", true);
    await until(() => t.events.length === 1);
    t.settle();
    await announced;
    // The bus back during a long shutdown: no resume, the lock as it is.
    await t.watch.recover();
    expect(t.events).toHaveLength(1);
    expect(t.f.held()).toBe(0);
    expect(t.lines.some((l) => /still preparing/.test(l))).toBe(true);
    preparing = false;
    await t.watch.recover();
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 0 });
    expect(t.f.held()).toBe(1);
  });

  it("ends an announcement still open when logind's word may have been lost (the bus again), as a resume (review M11)", async () => {
    const t = setup();
    await t.watch.tick();
    const announced = t.watch.announce("shutdown", true);
    await until(() => t.events.length === 1);
    t.settle();
    await announced;
    await t.watch.recover();
    expect(t.events[1]).toEqual({ kind: "resume", asleepMs: 0 });
    expect(t.f.held()).toBe(1);
    // Nothing open: nothing to end.
    await t.watch.recover();
    expect(t.events).toHaveLength(2);
  });

  it("skips a tick while an announcement is being handled", async () => {
    const t = setup();
    const announced = t.watch.announce("sleep", true);
    await until(() => t.events.length === 1);
    t.advance(1_000, 5_000);
    await t.watch.tick();
    t.settle();
    await announced;
    expect(t.events).toHaveLength(1);
  });

  it("takes an unreadable /proc/uptime as no time asleep, logged, never an exit", async () => {
    const t = setup();
    await t.watch.tick();
    t.failUptime();
    await t.watch.tick();
    expect(t.events).toEqual([]);
    expect(t.lines).toEqual(["time asleep: Error: EACCES"]);
  });
});

describe("shutdown", () => {
  it("rounds the delay up to whole minutes, now without one", () => {
    expect(shutdownArgs()).toEqual(["now"]);
    expect(shutdownArgs(0)).toEqual(["now"]);
    expect(shutdownArgs(1)).toEqual(["+1"]);
    expect(shutdownArgs(60)).toEqual(["+1"]);
    expect(shutdownArgs(61)).toEqual(["+2"]);
    expect(shutdownArgs(120)).toEqual(["+2"]);
  });

  it("resolves once shutdown accepted, and throws its own words when it refused", async () => {
    const runner = new FakeRunner()
      .on("shutdown +2", { stdout: "", stderr: "Shutdown scheduled for Wed 2026-09-30 18:02:00 CDT, use 'shutdown -c' to cancel.\n" })
      .on("shutdown now", { code: 1, stderr: "Call to PowerOff failed: Access denied\n" });
    await runShutdown(runner.run, ["+2"]);
    await expect(runShutdown(runner.run, ["now"])).rejects.toThrow("Call to PowerOff failed: Access denied");
  });
});

describe("stepClock", () => {
  const fastClock = () => {
    let t = 0;
    return { mono: () => t, now: () => t, delay: async (ms: number) => { t += ms; } };
  };

  it("steps through chronyc where chrony answers 200 OK", async () => {
    const runner = new FakeRunner().on("chronyc makestep", { stdout: "200 OK\n" });
    expect(await stepClock(runner.run, fastClock())).toBe(true);
    expect(runner.lines()).toEqual(["chronyc makestep"]);
  });

  it("else restarts timesyncd and waits for its next NTP message, within 10 s", async () => {
    let polls = 0;
    const before = "{ Leap=0, Version=4, Mode=4, Stratum=2, Precision=-25, RootDelay=7.614ms, RootDispersion=625us, Reference=91EE5050, OriginateTimestamp=Wed 2026-09-30 17:26:45 CDT, ReceiveTimestamp=Wed 2026-09-30 17:26:45 CDT, TransmitTimestamp=Wed 2026-09-30 17:26:45 CDT, DestinationTimestamp=Wed 2026-09-30 17:26:45 CDT, Ignored=no, PacketCount=6, Jitter=2.148ms }";
    const runner = new FakeRunner()
      .on("chronyc makestep", { code: 1, stdout: "506 Cannot talk to daemon\n" })
      .on("timedatectl show -p NTP --value", { stdout: "yes\n" })
      .on("systemctl restart systemd-timesyncd", {})
      .on("timedatectl show-timesync -p NTPMessage --value", () => {
        polls++;
        if (polls === 1) return { stdout: `${before}\n` };
        return { stdout: polls < 4 ? "\n" : `${before.replace("PacketCount=6", "PacketCount=1")}\n` };
      });
    expect(await stepClock(runner.run, fastClock())).toBe(true);
    expect(runner.lines().slice(0, 4)).toEqual([
      "chronyc makestep", "timedatectl show -p NTP --value", "timedatectl show-timesync -p NTPMessage --value", "systemctl restart systemd-timesyncd",
    ]);
  });

  it("gives up after 10 s of no new message", async () => {
    const runner = new FakeRunner()
      .on("timedatectl show -p NTP --value", { stdout: "yes\n" })
      .on("systemctl restart systemd-timesyncd", {})
      .on("timedatectl show-timesync -p NTPMessage --value", { stdout: "\n" });
    const clock = fastClock();
    expect(await stepClock(runner.run, clock)).toBe(false);
    expect(clock.now()).toBeGreaterThanOrEqual(10_000);
  });

  it("measures its 10 s on the monotonic clock, so the wall clock it steps forward does not end it (review M1)", async () => {
    let stepped = false;
    let wall = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => wall);
    try {
      const runner = new FakeRunner()
        .on("timedatectl show -p NTP --value", { stdout: "yes\n" })
        .on("timedatectl show-timesync -p NTPMessage --value", () => ({ stdout: stepped ? "{new}\n" : "{old}\n" }))
        .on("systemctl restart systemd-timesyncd", () => {
          // timesyncd steps the wall clock an hour forward at its first answer.
          stepped = true;
          wall += 3_600_000;
          return { code: 0 };
        });
      expect(await stepClock(runner.run, { delay: async () => {} })).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("does nothing where NTP is off or neither tool is there, and never throws", async () => {
    expect(await stepClock(new FakeRunner().on("timedatectl show -p NTP --value", { stdout: "no\n" }).run, fastClock())).toBe(false);
    expect(await stepClock(new FakeRunner().run, fastClock())).toBe(false);
    const failing = new FakeRunner()
      .on("chronyc makestep", new RunError("timeout", "chronyc did not finish"))
      .on("timedatectl show -p NTP --value", { stdout: "yes\n" })
      .on("systemctl restart systemd-timesyncd", { code: 1, stderr: "Access denied" });
    expect(await stepClock(failing.run, fastClock())).toBe(false);
  });
});
