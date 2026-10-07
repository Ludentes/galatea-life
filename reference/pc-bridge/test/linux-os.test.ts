import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectPersonalKeys, LINUX_PLUGINS_DIR, LinuxOs, type LinuxOsOptions } from "../src/linux-os.js";
import type { InhibitorChild } from "../src/linux/power.js";
import { RunError } from "../src/linux/run.js";
import type { PowerEvent } from "../src/port.js";
import {
  fakeRoot, FakeLogindBus, FakeRunner, LOGIN_DEFS, logindOwnerChanged, NSSWITCH_FILES, PASSWD, prepareForShutdown, prepareForSleep, sessionChanged,
} from "./linux-fakes.js";

const until = async (cond: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const GROUP = "root:x:0:\nsudo:x:27:liza\nliza:x:1000:\ndima:x:1001:\n";

interface Rig {
  os: LinuxOs;
  bus: FakeLogindBus;
  runner: FakeRunner;
  inhibitors: { released: boolean; end(): void }[];
  lines: string[];
  root: ReturnType<typeof fakeRoot>;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.os.close();
    r.root.cleanup();
  }
});

/** A Linux backend over a fake root, a fake runner, a fake logind and a fake systemd-inhibit. */
async function rig(o: Partial<LinuxOsOptions> & { files?: Record<string, string>; open?: boolean } = {}): Promise<Rig> {
  const root = fakeRoot({
    "/etc/passwd": PASSWD, "/etc/group": GROUP, "/etc/login.defs": LOGIN_DEFS, "/etc/nsswitch.conf": NSSWITCH_FILES,
    "/etc/machine-id": "0123456789abcdef0123456789abcdef\n", "/proc/uptime": "100.00 400.00\n", ...o.files,
  });
  const bus = new FakeLogindBus();
  bus.sessions = [
    { id: "2", uid: 1000, type: "wayland", seat: "seat0" },
    { id: "5", uid: 1001, type: "tty", remote: true },
  ];
  bus.seat0Active = "2";
  const runner = new FakeRunner()
    .on(/^getent (passwd|group) -- /, { code: 2 })
    .on(/^setpriv --reuid=1000 /, { stdout: "/usr/local/bin:/usr/bin:/bin\n" })
    .on(/^setpriv --reuid=1001 /, { stdout: "/usr/bin:/bin\n" });
  const inhibitors: Rig["inhibitors"] = [];
  const spawnInhibitor = (): InhibitorChild => {
    let end!: (x: { missing: boolean }) => void;
    const exited = new Promise<{ missing: boolean }>((r) => { end = r; });
    const c = { released: false, end: () => end({ missing: false }) };
    inhibitors.push(c);
    return { exited, release: () => { c.released = true; end({ missing: false }); } };
  };
  const lines: string[] = [];
  const os = new LinuxOs({
    root: root.root, run: runner.run, bus: async () => bus, euid: 0, spawnInhibitor, sampleMs: 3_600_000, busRetryMs: 20,
    log: (l) => lines.push(l), ...o,
  });
  const r = { os, bus, runner, inhibitors, lines, root };
  rigs.push(r);
  if (o.open !== false) await os.open();
  return r;
}

describe("LinuxOs: identity and observation", () => {
  it("reads the identity from the root's files", async () => {
    const { os } = await rig();
    expect(await os.identity()).toEqual({ machineId: "0123456789abcdef0123456789abcdef", vendor: "unknown", model: "unknown" });
  });

  it("observes logind's sessions and the accounts, each with its home and login PATH", async () => {
    const { os } = await rig();
    expect(os.observerPresent()).toBe(true);
    const o = await os.observe([1000, 1003]);
    expect(o.sessions.map((s) => [s.id, s.osId, s.graphical, s.seat0Active, s.state])).toEqual([
      ["2", 1000, true, true, "active"], ["5", 1001, false, false, "active"],
    ]);
    expect(o.accounts).toEqual({
      listed: [
        { osId: 1000, name: "liza", primaryGid: 1000, home: "/home/liza", path: ["/usr/local/bin", "/usr/bin", "/bin"] },
        { osId: 1001, name: "dima", primaryGid: 1001, home: "/home/dima", path: ["/usr/bin", "/bin"] },
      ],
      deleted: [1003],
    });
  });

  it("is not present, and observes nothing, while logind is not on the bus; its arrival is a change", async () => {
    const r = await rig();
    let changes = 0;
    r.os.onChange(() => changes++);
    r.bus.logindPresent = false;
    r.bus.emit(logindOwnerChanged(":1.5", ""));
    expect(r.os.observerPresent()).toBe(false);
    await expect(r.os.observe([])).rejects.toThrow(/logind is not on the system bus/);
    r.bus.logindPresent = true;
    r.bus.logindOwner = ":1.77";
    r.bus.emit(logindOwnerChanged("", ":1.77"));
    expect(r.os.observerPresent()).toBe(true);
    expect(changes).toBe(2);
  });

  it("is not present when logind leaves as the bridge connects, and asks its owner once (review N3)", async () => {
    const r = await rig({ open: false });
    r.bus.onReply = () => {
      r.bus.onReply = undefined;
      r.bus.logindPresent = false;
      r.bus.emit(logindOwnerChanged(":1.5", ""));
    };
    await r.os.open();
    expect(r.os.observerPresent()).toBe(false);
    expect(r.bus.calls.filter((c) => c.includes("GetNameOwner"))).toHaveLength(1);
  });

  it("takes a bus that cannot be reached as absent, tries again, and reports the change once it connects", async () => {
    const bus = new FakeLogindBus();
    let tries = 0;
    const r = await rig({ bus: async () => {
      tries++;
      if (tries < 3) throw new Error("connect ENOENT /var/run/dbus/system_bus_socket");
      return bus;
    }, open: false });
    let changes = 0;
    r.os.onChange(() => changes++);
    await r.os.open();
    expect(r.os.observerPresent()).toBe(false);
    await until(() => r.os.observerPresent());
    expect(tries).toBe(3);
    expect(changes).toBeGreaterThanOrEqual(1);
    expect(r.lines.filter((l) => l.startsWith("system bus:"))).toHaveLength(2);
  });

  it("takes the bus's loss as absent at once, a change, and connects again", async () => {
    const r = await rig();
    let changes = 0;
    r.os.onChange(() => changes++);
    const second = new FakeLogindBus();
    second.sessions = r.bus.sessions;
    (r.os as unknown as { o: LinuxOsOptions }).o.bus = async () => second;
    r.bus.lose();
    expect(r.os.observerPresent()).toBe(false);
    expect(changes).toBe(1);
    await until(() => r.os.observerPresent());
    expect((await r.os.observe([])).sessions).toHaveLength(2);
  });

  it("reports a session's change and an account file's change as a change", async () => {
    const r = await rig();
    let changes = 0;
    r.os.onChange(() => changes++);
    r.bus.emit(sessionChanged("2"));
    expect(changes).toBe(1);
    r.root.write("/etc/passwd", `${PASSWD}olga:x:1004:1004::/home/olga:/bin/bash\n`);
    await until(() => changes === 2);
  });

  it("settles an observation still waiting on the bus when it closes", async () => {
    const r = await rig();
    r.bus.failing.set("ListSessions", "hang");
    const started = Date.now();
    const pending = r.os.observe([]).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    await r.os.close();
    expect(String(await pending)).toMatch(/closed/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.os.observerPresent()).toBe(false);
  });
});

describe("LinuxOs: power", () => {
  it("holds the delay lock from the start, releases it only once the core's suspend handler settled, and takes it again at resume", async () => {
    const r = await rig();
    expect(r.inhibitors).toHaveLength(1);
    const events: PowerEvent[] = [];
    let settle!: () => void;
    r.os.onPower(async (e) => {
      events.push(e);
      if (e.kind === "suspend") await new Promise<void>((res) => { settle = res; });
    });
    r.bus.emit(prepareForSleep(true));
    await until(() => events.length === 1);
    expect(events[0]).toEqual({ kind: "suspend", announced: true });
    expect(r.inhibitors[0]!.released).toBe(false);
    settle();
    await until(() => r.inhibitors[0]!.released);
    r.root.write("/proc/uptime", "3700.00 400.00\n");
    r.bus.emit(prepareForSleep(false));
    await until(() => events.length === 2);
    expect(events[1]!.kind).toBe("resume");
    expect((events[1] as { asleepMs: number }).asleepMs).toBeGreaterThan(3_590_000);
    expect(r.inhibitors).toHaveLength(2);
  });

  it("ignores power, session and presence signals another connection forges (review C1): the lock held, present, no change", async () => {
    const r = await rig();
    const events: PowerEvent[] = [];
    let changes = 0;
    r.os.onPower(async (e) => void events.push(e));
    r.os.onChange(() => changes++);
    r.bus.emit(prepareForShutdown(true, ":1.99"));
    r.bus.emit(prepareForSleep(true, ":1.99"));
    r.bus.emit(sessionChanged("2", ":1.99"));
    r.bus.emit(logindOwnerChanged(":1.5", "", ":1.99"));
    await new Promise((res) => setTimeout(res, 50));
    expect(events).toEqual([]);
    expect(r.inhibitors[0]!.released).toBe(false);
    expect(r.os.observerPresent()).toBe(true);
    expect(changes).toBe(0);
    // logind's own still act.
    r.bus.emit(prepareForShutdown(true));
    await until(() => r.inhibitors[0]!.released);
    expect(events).toEqual([{ kind: "shutdown", announced: true }]);
  });

  it("takes the delay lock again when the bus comes back with a suspend still announced (review M11)", async () => {
    const r = await rig();
    const events: PowerEvent[] = [];
    r.os.onPower(async (e) => void events.push(e));
    r.bus.emit(prepareForSleep(true));
    await until(() => r.inhibitors[0]!.released);
    const second = new FakeLogindBus();
    (r.os as unknown as { o: LinuxOsOptions }).o.bus = async () => second;
    r.bus.lose();
    await until(() => r.os.observerPresent());
    await until(() => events.length === 2);
    expect(events[1]!.kind).toBe("resume");
    expect(r.inhibitors).toHaveLength(2);
    expect(r.inhibitors[1]!.released).toBe(false);
  });

  it("reports no resume when the bus comes back during a long shutdown, logind still preparing for it", async () => {
    const r = await rig();
    const events: PowerEvent[] = [];
    r.os.onPower(async (e) => void events.push(e));
    r.bus.emit(prepareForShutdown(true));
    await until(() => r.inhibitors[0]!.released);
    const second = new FakeLogindBus();
    second.preparingForShutdown = true;
    (r.os as unknown as { o: LinuxOsOptions }).o.bus = async () => second;
    r.bus.lose();
    await until(() => r.os.observerPresent());
    await until(() => second.calls.some((c) => c.includes("PreparingForShutdown")));
    await new Promise((res) => setTimeout(res, 50));
    expect(events).toEqual([{ kind: "shutdown", announced: true }]);
    expect(r.inhibitors).toHaveLength(1);
  });

  it("keeps a shutdown announced past the bound while logind is still preparing for it (review N4)", async () => {
    let mono = 0;
    const r = await rig({ mono: () => mono });
    const events: PowerEvent[] = [];
    r.os.onPower(async (e) => void events.push(e));
    r.bus.emit(prepareForShutdown(true));
    await until(() => r.inhibitors[0]!.released);
    const tick = () => (r.os as unknown as { power: { tick(): Promise<void> } }).power.tick();
    r.bus.preparingForShutdown = true;
    mono += 120_000;
    await tick();
    expect(events).toHaveLength(1);
    expect(r.inhibitors).toHaveLength(1);
    r.bus.preparingForShutdown = false;
    await tick();
    expect(events[1]).toEqual({ kind: "resume", asleepMs: 0 });
    expect(r.inhibitors).toHaveLength(2);
  });

  it("holds a shutdown the same way", async () => {
    const r = await rig();
    const events: PowerEvent[] = [];
    r.os.onPower(async (e) => void events.push(e));
    r.bus.emit(prepareForShutdown(true));
    await until(() => r.inhibitors[0]!.released);
    expect(events).toEqual([{ kind: "shutdown", announced: true }]);
  });

  it("sleeps through logind, shuts down through shutdown with the delay in whole minutes", async () => {
    const r = await rig();
    r.runner.on(/^shutdown /, {});
    await r.os.sleep();
    expect(r.bus.calls.at(-1)).toBe("org.freedesktop.login1.Manager.Suspend /org/freedesktop/login1 [false]");
    await r.os.shutdown(61);
    await r.os.shutdown();
    expect(r.runner.lines().filter((l) => l.startsWith("shutdown"))).toEqual(["shutdown +2", "shutdown now"]);
  });

  it("cancels only what logind shows scheduled, and when logind cannot say, cancels and answers false", async () => {
    const r = await rig();
    r.runner.on("shutdown -c", {});
    expect(await r.os.cancelShutdown()).toBe(false);
    expect(r.runner.lines()).not.toContain("shutdown -c");
    r.bus.scheduled = ["poweroff", 1_790_000_120_000_000n];
    expect(await r.os.cancelShutdown()).toBe(true);
    expect(r.runner.lines().filter((l) => l === "shutdown -c")).toHaveLength(1);
    r.bus.failing.set("Get", new Error("no reply"));
    expect(await r.os.cancelShutdown()).toBe(false);
    expect(r.runner.lines().filter((l) => l === "shutdown -c")).toHaveLength(2);
  });

  it("throws a refused cancel of a scheduled shutdown", async () => {
    const r = await rig();
    r.bus.scheduled = ["poweroff", 1_790_000_120_000_000n];
    r.runner.on("shutdown -c", { code: 1, stderr: "Failed to cancel shutdown: Access denied" });
    await expect(r.os.cancelShutdown()).rejects.toThrow("Failed to cancel shutdown: Access denied");
  });

  it("steps the clock through the runner", async () => {
    const r = await rig();
    r.runner.on("chronyc makestep", { stdout: "200 OK\n" });
    expect(await r.os.stepClock()).toBe(true);
  });
});

describe("LinuxOs: administrators, locking, keys and files", () => {
  it("reads the administrator facts, logging why they are incomplete once until that changes", async () => {
    const r = await rig({ euid: 1000 });
    const facts = await r.os.admins();
    expect(facts.sudo.every((s) => s.root === "cannotTell")).toBe(true);
    await r.os.admins();
    expect(r.lines.filter((l) => l.startsWith("administrators:"))).toEqual(["administrators: sudo: not root, so no account's rules can be listed"]);
  });

  it("reports a change of an administrators' file", async () => {
    const r = await rig();
    let changes = 0;
    r.os.onAdminsChange(() => changes++);
    r.root.write("/etc/group", `${GROUP}docker:x:990:dima\n`);
    await until(() => changes === 1);
  });

  it("locks each session through loginctl, and names each one the OS refused", async () => {
    const r = await rig();
    r.runner.on("loginctl lock-session -- 2", {}).on("loginctl lock-session -- 7", { code: 1, stderr: "Failed to issue method call: No session '7' known\n" });
    await r.os.lock(["2"]);
    await expect(r.os.lock(["2", "7"])).rejects.toThrow("loginctl lock-session: 7: Failed to issue method call: No session '7' known");
    expect(r.runner.lines().filter((l) => l.startsWith("loginctl"))).toEqual(["loginctl lock-session -- 2", "loginctl lock-session -- 2", "loginctl lock-session -- 7"]);
  });

  it("settles a call waiting on a command at once when it closes, and runs none after (review M5)", async () => {
    const r = await rig();
    r.runner.on("loginctl lock-session -- 2", "hang");
    const started = Date.now();
    const pending = r.os.lock(["2"]).catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    await r.os.close();
    expect(String(await pending)).toMatch(/closed/);
    expect(Date.now() - started).toBeLessThan(1_000);
    const before = r.runner.calls.length;
    await expect(r.os.lock(["2"])).rejects.toThrow(/closed/);
    expect(r.runner.calls.length).toBe(before);
  });

  it("checks writes with the account's groups from the root's files", async () => {
    const myGid = process.getgid!();
    const base = mkdtempSync(join(tmpdir(), "galatea-os-"));
    chmodSync(base, 0o755);
    try {
      const f = join(base, "python3");
      writeFileSync(f, "");
      chmodSync(f, 0o775);
      const files = {
        "/etc/passwd": `${PASSWD}colleague:x:54322:54322::/home/colleague:/bin/bash\nstranger:x:54321:54321::/home/stranger:/bin/bash\n`,
        "/etc/group": `${GROUP}mine:x:${myGid}:colleague\n`,
      };
      const { os } = await rig({ files });
      expect(await os.canWrite(54322, f)).toBe(true);
      expect(await os.canWrite(54321, f)).toBe(false);
      expect(await os.canWrite(0, "/nonexistent")).toBe(true);
      expect(await os.exists(f)).toEqual({ exists: true, executable: true });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("gives an account not in /etc/passwd its groups through NSS, and answers writable when it cannot (review M7)", async () => {
    const myGid = process.getgid!();
    const base = mkdtempSync(join(tmpdir(), "galatea-os-"));
    chmodSync(base, 0o755);
    try {
      const f = join(base, "python3");
      writeFileSync(f, "");
      chmodSync(f, 0o775);
      const r = await rig();
      r.runner
        .on("getent passwd -- 1500001", { stdout: "olga@corp.example:*:1500001:1500001:Olga:/home/olga:/bin/bash\n" })
        .on("id -G -- olga@corp.example", { stdout: `1500001 ${myGid}\n` })
        .on("getent passwd -- 1500002", { stdout: "ivan@corp.example:*:1500002:1500002:Ivan:/home/ivan:/bin/bash\n" })
        .on("id -G -- ivan@corp.example", { stdout: "1500002\n" })
        .on("getent passwd -- 1500003", new RunError("timeout", "getent did not finish"));
      // A directory account in the file's group: writable, as the kernel would let it.
      expect(await r.os.canWrite(1500001, f)).toBe(true);
      expect(await r.os.canWrite(1500002, f)).toBe(false);
      // Its groups unknown: writable, the answer that refuses.
      expect(await r.os.canWrite(1500003, f)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("installs plugins under /var/lib/galatea-pc-bridge/plugins, a directory only root makes", async () => {
    const { os } = await rig({ euid: 1000 });
    expect(os.pluginsDir()).toBe(LINUX_PLUGINS_DIR);
    expect(LINUX_PLUGINS_DIR).toBe("/var/lib/galatea-pc-bridge/plugins");
    await expect(os.makeRootOnlyDir("/nonexistent/plugins")).rejects.toThrow(/not root/);
  });

  it("answers isOwnAddress from the shared check", async () => {
    const { os } = await rig();
    expect(await os.isOwnAddress("127.0.0.1")).toBe(true);
  });
});

describe("detectPersonalKeys", () => {
  const roots: { cleanup(): void }[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) r.cleanup();
  });
  const found = (paths: string[]) => async (p: string) => paths.includes(p);

  it("declares the camera and microphone where PipeWire is, and app only where GDM runs X11 alone", async () => {
    const plain = fakeRoot({});
    roots.push(plain);
    expect(await detectPersonalKeys(plain.root, found([]))).toEqual([]);
    expect(await detectPersonalKeys(plain.root, found(["/usr/bin/pipewire"]))).toEqual(["camera_in_use", "microphone_in_use"]);
    const x11 = fakeRoot({ "/etc/gdm3/daemon.conf": "# GDM configuration storage\n\n[daemon]\n# Uncomment the line below to force the login screen to use Xorg\nWaylandEnable=false\n\n[security]\n" });
    roots.push(x11);
    expect(await detectPersonalKeys(x11.root, found(["/usr/bin/pipewire"]))).toEqual(["app", "camera_in_use", "microphone_in_use"]);
    const commented = fakeRoot({ "/etc/gdm3/custom.conf": "[daemon]\n#WaylandEnable=false\n" });
    roots.push(commented);
    expect(await detectPersonalKeys(commented.root, found([]))).toEqual([]);
    const otherSection = fakeRoot({ "/etc/gdm3/custom.conf": "[daemon]\n\n[debug]\nWaylandEnable=false\n" });
    roots.push(otherSection);
    expect(await detectPersonalKeys(otherSection.root, found([]))).toEqual([]);
  });

  it("gives the backend's keys, fixed at open", async () => {
    const { os } = await rig({ files: { "/usr/bin/pipewire": "" } });
    expect(os.personalKeys()).toEqual(["camera_in_use", "microphone_in_use"]);
  });
});
