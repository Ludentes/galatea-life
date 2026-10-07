import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENDPOINT_IFACE, ENDPOINT_NAME, ENDPOINT_PATH, REFUSED } from "../src/linux/endpoint.js";
import { dropArgs, launch } from "../src/linux/launch.js";
import { parseShowEnvironment, scopeProcs, unquoteSystemdValue } from "../src/linux/session-env.js";
import { HELPER_CONNECT_MS, IDLE_AFTER_S, LinuxOs, type LinuxOsOptions } from "../src/linux-os.js";
import type { InhibitorChild } from "../src/linux/power.js";
import type { HelperMessage, ServerProcess, ServerSpec } from "../src/port.js";
import { fakeRoot, FakeLogindBus, FakeRunner, LOGIN_DEFS, LOGIND_OWNER, NSSWITCH_FILES, PASSWD } from "./linux-fakes.js";

/**
 * The Linux backend's processes (plan 4b) as this account, with no root: logind and the bus faked,
 * the cgroup file system a temporary directory, the drop to the account left out (`dropFor` gives
 * none; the real drop's command line is `linux-launch.test.ts`'s), and the processes real ones: a
 * stand-in that writes what it was started with. Nothing is shown on any desktop.
 */
const STAND_IN = fileURLToPath(new URL("./fixtures/stand-in.mjs", import.meta.url));
const SHOW_ENVIRONMENT = readFileSync(fileURLToPath(new URL("./fixtures/show-environment.txt", import.meta.url)), "utf8");

const until = async (cond: () => boolean, what = "condition", ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`not met: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

interface Rig {
  os: LinuxOs;
  bus: FakeLogindBus;
  runner: FakeRunner;
  seen: HelperMessage[];
  lines: string[];
  dir: string;
  cgroup: string;
  out: string;
  started(): Record<string, unknown> | undefined;
}

const rigs: Rig[] = [];
const servers: ServerProcess[] = [];
/** Every helper a rig started: whatever a test left running is ended by its group, the stand-in's child with it. */
const helperPids: number[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const pid of helperPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Ended already.
    }
  }
  for (const r of rigs.splice(0)) {
    await r.os.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

async function rig(o: Partial<LinuxOsOptions> = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "galatea-proc-"));
  const root = fakeRoot({
    "/etc/passwd": PASSWD, "/etc/group": "root:x:0:\nliza:x:1000:\n", "/etc/login.defs": LOGIN_DEFS, "/etc/nsswitch.conf": NSSWITCH_FILES,
    "/etc/machine-id": "0123456789abcdef0123456789abcdef\n", "/proc/uptime": "100.00 400.00\n", "/usr/bin/pipewire": "",
  });
  const cgroup = join(dir, "cgroup");
  for (const scope of ["user-1000.slice/session-2.scope", "user-1001.slice/session-8.scope"]) {
    mkdirSync(join(cgroup, "user.slice", scope), { recursive: true });
    writeFileSync(join(cgroup, "user.slice", scope, "cgroup.procs"), "");
  }
  const bus = new FakeLogindBus();
  bus.sessions = [
    { id: "2", uid: 1000, type: "x11", seat: "seat0" },
    { id: "5", uid: 1001, type: "tty", remote: true },
    { id: "8", uid: 1001, type: "wayland", seat: "seat0" },
  ];
  bus.seat0Active = "2";
  const runner = new FakeRunner()
    .on(/^getent (passwd|group) -- /, { code: 2 })
    .on(/^setpriv --reuid=/, { stdout: "/usr/bin:/bin\n" })
    .on("systemctl --user --machine=liza@.host show-environment", { stdout: SHOW_ENVIRONMENT })
    .on("systemctl --user --machine=dima@.host show-environment", { stdout: "XDG_RUNTIME_DIR=/run/user/1001\nWAYLAND_DISPLAY=wayland-0\n" });
  const spawnInhibitor = (): InhibitorChild => ({ exited: new Promise(() => {}), release: () => {} });
  const out = join(dir, "started.json");
  const seen: HelperMessage[] = [];
  const lines: string[] = [];
  const os = new LinuxOs({
    root: root.root, run: runner.run, bus: async () => bus, euid: 0, spawnInhibitor, sampleMs: 3_600_000, busRetryMs: 20,
    log: (l) => lines.push(l), cgroupRoot: cgroup, dropFor: () => [], helperCommand: [process.execPath, STAND_IN, out], graceMs: 300, ...o,
  });
  os.onHelper((m) => seen.push(m));
  const start = os.startHelper.bind(os);
  os.startHelper = async (id) => {
    const pid = await start(id);
    helperPids.push(pid);
    return pid;
  };
  await os.open();
  const r: Rig = {
    os, bus, runner, seen, lines, dir, cgroup, out,
    started: () => (existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> : undefined),
  };
  rigs.push(r);
  // The fake root's files go with the rig's directory.
  const cleanup = root.cleanup;
  const close = os.close.bind(os);
  os.close = async () => {
    await close();
    cleanup();
  };
  return r;
}

const procsOf = (r: Rig, uid: number, session: string) => readFileSync(join(r.cgroup, "user.slice", `user-${uid}.slice`, `session-${session}.scope`, "cgroup.procs"), "utf8");

describe("the session's display variables", () => {
  it("reads systemctl's quoting: as it is, or $'…' with C escapes and octal", () => {
    expect(unquoteSystemdValue(":1")).toBe(":1");
    expect(unquoteSystemdValue("$'https://debuginfod.ubuntu.com '")).toBe("https://debuginfod.ubuntu.com ");
    expect(unquoteSystemdValue("$'a\\'b\\\\c\\\"d'")).toBe("a'b\\c\"d");
    expect(unquoteSystemdValue("$'line\\nnext\\ttab\\033[0m'")).toBe("line\nnext\ttab\x1b[0m");
    expect(unquoteSystemdValue("$'/home/ліза/.Xauthority'")).toBe("/home/ліза/.Xauthority");
    expect(unquoteSystemdValue("$'\\320\\273'")).toBe("л");
  });

  it("keeps the five names of a user manager's environment and nothing else", () => {
    expect(parseShowEnvironment(SHOW_ENVIRONMENT)).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DISPLAY: ":1",
      XAUTHORITY: "/run/user/1000/gdm/Xauthority",
    });
    expect(parseShowEnvironment("WAYLAND_DISPLAY=wayland-0\nDISPLAY=\nnot a line\n=x\n")).toEqual({ WAYLAND_DISPLAY: "wayland-0" });
  });

  it("asks the session account's user manager as root, and gives its display variables", async () => {
    const r = await rig();
    expect(await r.os.displayEnv("2")).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DISPLAY: ":1",
      XAUTHORITY: "/run/user/1000/gdm/Xauthority",
    });
    expect(r.runner.lines()).toContain("systemctl --user --machine=liza@.host show-environment");
    expect(await r.os.displayEnv("8")).toEqual({ XDG_RUNTIME_DIR: "/run/user/1001", WAYLAND_DISPLAY: "wayland-0" });
  });

  it("throws for a session with no display, one logind does not know, a read that fails, and a manager with no display", async () => {
    const r = await rig();
    await expect(r.os.displayEnv("5")).rejects.toThrow("session 5 has no graphical display (Type tty)");
    await expect(r.os.displayEnv("9")).rejects.toThrow("logind knows no session 9");
    r.runner.on("systemctl --user --machine=liza@.host show-environment", { code: 1, stderr: "Failed to connect to bus: No medium found" });
    await expect(r.os.displayEnv("2")).rejects.toThrow("systemctl --user show-environment for liza: Failed to connect to bus: No medium found");
    r.runner.on("systemctl --user --machine=liza@.host show-environment", { stdout: "XDG_RUNTIME_DIR=/run/user/1000\n" });
    await expect(r.os.displayEnv("2")).rejects.toThrow("session 2: liza's user manager has no display");
  });
});

describe("the session scope", () => {
  it("is logind's Scope where it gives one, else session-<id>.scope, under the account's slice", () => {
    expect(scopeProcs("/sys/fs/cgroup", 1000, "2", "session-2.scope")).toBe("/sys/fs/cgroup/user.slice/user-1000.slice/session-2.scope/cgroup.procs");
    expect(scopeProcs("/sys/fs/cgroup", 1000, "c3", "")).toBe("/sys/fs/cgroup/user.slice/user-1000.slice/session-c3.scope/cgroup.procs");
    expect(() => scopeProcs("/sys/fs/cgroup", 1000, "2", "../../system.slice/x.scope")).toThrow(/not a scope's name/);
    expect(() => scopeProcs("/sys/fs/cgroup", 1000, "2", "session-2.service")).toThrow(/not a scope's name/);
  });
});

describe("startHelper", () => {
  it("moves the launcher into the session's scope and resolves with its pid before the helper runs, then runs it", async () => {
    const r = await rig();
    const pid = await r.os.startHelper("2");
    // Resolved: the pid is in the scope, and the helper has not run yet.
    expect(procsOf(r, 1000, "2")).toBe(`${pid}\n`);
    expect(r.started()).toBeUndefined();
    await until(() => r.started() !== undefined, "the helper ran");
    const s = r.started()!;
    expect(s.argv).toEqual(["--session", "2", "--idle-after", String(IDLE_AFTER_S), "--keys", "camera_in_use,microphone_in_use", "--token-fd", "4"]);
    // The start token on fd 4, read to its end and closed by the helper, and nowhere else (review N1).
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.tokenFdOpen).toBe(false);
    expect(JSON.stringify([s.argv, s.env])).not.toContain(s.token as string);
    expect(s.env).toEqual({
      HOME: "/home/liza", PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DISPLAY: ":1",
      XAUTHORITY: "/run/user/1000/gdm/Xauthority",
    });
    expect(s.cwd).toBe("/");
    await r.os.stopHelper(pid);
  });

  it("drops to the session's account by default: setpriv --init-groups with its uid and gid", async () => {
    const asked: [number, number][] = [];
    const r = await rig({ dropFor: (uid, gid) => {
      asked.push([uid, gid]);
      return [];
    } });
    const pid = await r.os.startHelper("8");
    expect(asked).toEqual([[1001, 1001]]);
    expect(dropArgs(1001, 1001)).toEqual(["/usr/bin/setpriv", "--reuid=1001", "--regid=1001", "--init-groups", "--no-new-privs", "--"]);
    await r.os.stopHelper(pid);
  });

  it("stops a helper that has not called the endpoint within its bound, and reports its end", async () => {
    const r = await rig({ helperConnectMs: 300 });
    const pid = await r.os.startHelper("2");
    await until(() => r.seen.some((m) => m.kind === "exited"), "the helper's end", 5_000);
    expect(r.seen).toEqual([{ kind: "exited", pid }]);
    expect(alive(pid)).toBe(false);
    expect(r.lines.some((l) => l === `helper 2: pid ${pid} did not connect within 300 ms; stopped`)).toBe(true);
    expect(HELPER_CONNECT_MS).toBe(10_000);
  });

  it("takes the floor before the spawn, and resolves with the pid before it releases the launcher (reviews M5, N2)", async () => {
    const order: string[] = [];
    const r = await rig({ launch: async (o) => {
      const l = await launch({ ...o, onSpawn: (pid) => {
        order.push("spawned");
        o.onSpawn?.(pid);
      } });
      const release = l.release.bind(l);
      return { ...l, release: () => {
        order.push("released");
        return release();
      } };
    } });
    const call = r.bus.call.bind(r.bus);
    r.bus.call = (...a) => {
      if (a[3] === "ListNames") order.push("names listed");
      return call(...a);
    };
    const pid = await r.os.startHelper("2");
    order.push("resolved");
    await until(() => r.started() !== undefined, "the helper ran");
    expect(order).toEqual(["names listed", "spawned", "resolved", "released"]);
    await r.os.stopHelper(pid);
  });

  it("fences the pid from its spawn: a connection identified while the launcher is moved is not passed on (review N2)", async () => {
    let answer: unknown;
    const r: Rig = await rig({ writeProcs: async (path, pid) => {
      writeFileSync(path, `${pid}\n`);
      // A stale connection with the reused pid, identified in the session before the start resolves.
      r.bus.connections.set(":1.31", { uid: 1000, pid });
      r.bus.sessionOfPid.set(pid, "2");
      answer = await r.bus.callIn(":1.31", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [""]);
    } });
    const pid = await r.os.startHelper("2");
    expect(answer).toMatchObject({ error: REFUSED });
    expect(r.seen).toEqual([{ kind: "malformed", from: { conn: 1, pid, osId: 1000, session: "2" },
      detail: `pid ${pid}'s connection :1.31 presented a wrong token` }]);
    await r.os.stopHelper(pid);
  });

  it("refuses a connection with the helper's pid that does not present its start's token, however new its name, and takes the helper's own (reviews I1, N1)", async () => {
    const r = await rig();
    // The fake bus lists :1.29 before the spawn: the floor.
    r.bus.connections.set(":1.29", { uid: 1001, pid: 4242 });
    const pid = await r.os.startHelper("2");
    await until(() => r.started() !== undefined, "the helper ran");
    const token = r.started()!.token as string;
    r.bus.sessionOfPid.set(pid, "2");
    // Older than the floor: refused, its token right or not.
    r.bus.connections.set(":1.20", { uid: 1000, pid });
    expect(await r.bus.callIn(":1.20", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [token])).toMatchObject({ error: REFUSED });
    expect(r.seen).toEqual([{ kind: "malformed", from: { conn: 1, pid, osId: 1000, session: "2" },
      detail: `pid ${pid}'s connection :1.20 is older than its helper (not after :1.29)` }]);
    expect(r.lines.join("\n")).not.toContain(token);
    await r.os.stopHelper(pid);

    // A second start: a name above the floor, said after the release (the review's late Hello), without the token.
    const s2 = await rig();
    const pid2 = await s2.os.startHelper("2");
    await until(() => s2.started() !== undefined, "the helper ran");
    const token2 = s2.started()!.token as string;
    s2.bus.sessionOfPid.set(pid2, "2");
    s2.bus.connections.set(":1.50", { uid: 1000, pid: pid2 });
    expect(await s2.bus.callIn(":1.50", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", ["0".repeat(64)])).toMatchObject({ error: REFUSED });
    expect(s2.seen.at(-1)).toMatchObject({ kind: "malformed", detail: `pid ${pid2}'s connection :1.50 presented a wrong token` });
    // Spent: the right token after a wrong one is refused too, and the helper is started again by the core.
    s2.bus.connections.set(":1.51", { uid: 1000, pid: pid2 });
    expect(await s2.bus.callIn(":1.51", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [token2])).toMatchObject({ error: REFUSED });
    await s2.os.stopHelper(pid2);

    // A third: the helper's own connection with its token is taken.
    const s3 = await rig();
    const pid3 = await s3.os.startHelper("2");
    await until(() => s3.started() !== undefined, "the helper ran");
    s3.bus.sessionOfPid.set(pid3, "2");
    s3.bus.connections.set(":1.60", { uid: 1000, pid: pid3 });
    expect(await s3.bus.callIn(":1.60", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [s3.started()!.token as string])).toEqual({ reply: [], signature: "" });
    expect(s3.seen).toEqual([{ kind: "connected", from: { conn: 1, pid: pid3, osId: 1000, session: "2" } }]);
    await s3.os.stopHelper(pid3);
  });

  it("gives each start its own token", async () => {
    const r = await rig();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const pid = await r.os.startHelper("2");
      await until(() => r.started() !== undefined, "the helper ran");
      tokens.push(r.started()!.token as string);
      await r.os.stopHelper(pid);
      rmSync(r.out);
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("starts no helper it cannot fence off from older connections: the bus lists no names (review I1)", async () => {
    const r = await rig();
    r.bus.failing.set("ListNames", new Error("the bus did not answer"));
    await expect(r.os.startHelper("2")).rejects.toThrow("the bus did not answer");
    expect(procsOf(r, 1000, "2")).toBe("");
    await new Promise((res) => setTimeout(res, 100));
    expect(r.started()).toBeUndefined();
  });

  it("leaves a helper that called the endpoint running past the bound", async () => {
    // The helper's connection opens and calls with its token as it is released, not once the stand-in
    // has run: under load that could be past the bound.
    let hello: Promise<unknown> | undefined;
    const r = await rig({ helperConnectMs: 300, launch: async (o) => {
      const l = await launch(o);
      const release = l.release.bind(l);
      return { ...l, release: () => {
        r.bus.connections.set(":1.40", { uid: 1000, pid: l.pid });
        r.bus.sessionOfPid.set(l.pid, "2");
        hello = r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [o.token!]);
        return release();
      } };
    } });
    const pid = await r.os.startHelper("2");
    await until(() => hello !== undefined, "the helper released");
    expect(await hello).toEqual({ reply: [], signature: "" });
    await new Promise((res) => setTimeout(res, 600));
    expect(alive(pid)).toBe(true);
    expect(r.seen).toEqual([{ kind: "connected", from: { conn: 1, pid, osId: 1000, session: "2" } }]);
    await r.os.stopHelper(pid);
    expect(r.seen.at(-1)).toEqual({ kind: "exited", pid });
  });

  it("stops a helper with its whole group, and reports a helper that ends on its own", async () => {
    const r = await rig();
    const pid = await r.os.startHelper("2");
    await until(() => r.started() !== undefined, "the helper ran");
    const child = r.started()!.child as number;
    await r.os.stopHelper(pid);
    expect(alive(pid)).toBe(false);
    await until(() => !alive(child), "the helper's own child ended");
    const again = await r.os.startHelper("2");
    await until(() => alive(again) && r.started() !== undefined);
    process.kill(again, "SIGKILL");
    await until(() => r.seen.some((m) => m.kind === "exited" && m.pid === again), "its end reported");
  });

  it("rejects, with nothing running, when the move into the scope fails or the display cannot be read", async () => {
    const r = await rig();
    rmSync(join(r.cgroup, "user.slice", "user-1000.slice"), { recursive: true });
    await expect(r.os.startHelper("2")).rejects.toThrow(/moving the launcher into .*session-2\.scope\/cgroup\.procs: ENOENT/);
    r.runner.on("systemctl --user --machine=dima@.host show-environment", { code: 1, stderr: "Failed to connect to bus" });
    await expect(r.os.startHelper("8")).rejects.toThrow(/show-environment for dima/);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.started()).toBeUndefined();
    await expect(r.os.startHelper("9")).rejects.toThrow("logind knows no session 9");
  });

  it("stops what it started in a session logind removes, and takes no word of a removal another connection forges", async () => {
    const r = await rig();
    const pid = await r.os.startHelper("2");
    const removed = (sender: string) => r.bus.emit({
      sender, path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "SessionRemoved",
      body: ["2", "/org/freedesktop/login1/session/_32"],
    });
    removed(":1.99");
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(pid)).toBe(true);
    removed(LOGIND_OWNER);
    await until(() => !alive(pid), "the helper stopped");
    await until(() => r.seen.some((m) => m.kind === "exited" && m.pid === pid), "its end reported");
  });
});

describe("the helper endpoint in the backend", () => {
  it("owns the endpoint's name on the bus it connects, and passes the helpers' word on, the backend's refusal answered Refused", async () => {
    const r = await rig();
    expect(r.bus.owned).toEqual([ENDPOINT_NAME]);
    r.bus.connections.set(":1.41", { uid: 1000, pid: 4242 });
    r.bus.sessionOfPid.set(4242, "2");
    r.os.onHelper((m) => {
      r.seen.push(m);
      if (m.kind === "connected") void r.os.closeHelper(m.from.conn);
    });
    expect(await r.bus.callIn(":1.41", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello")).toMatchObject({ error: REFUSED });
    await until(() => r.seen.length === 2);
    expect(r.seen.map((m) => m.kind)).toEqual(["connected", "gone"]);
  });

  it("runs on without helpers when the bus's policy refuses it the name, saying so", async () => {
    const bus = new FakeLogindBus();
    bus.refuseNames = true;
    const r = await rig({ bus: async () => bus });
    expect(r.os.observerPresent()).toBe(true);
    expect(r.lines.some((l) => /^helper endpoint: .*not allowed to own .*; no helper can connect$/.test(l))).toBe(true);
  });

  it("has the helper on a connection show a notification, and fails for one it does not know", async () => {
    const r = await rig();
    const asked: unknown[] = [];
    r.bus.peer = (destination, member, body) => {
      asked.push([destination, member, body]);
      return [];
    };
    r.bus.connections.set(":1.40", { uid: 1000, pid: 4243 });
    r.bus.sessionOfPid.set(4243, "2");
    await r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [""]);
    await r.os.notify(1, "От: Galatea\nпроверка", "critical");
    expect(asked).toEqual([[":1.40", "Notify", ["От: Galatea\nпроверка", "critical"]]]);
    await expect(r.os.notify(7, "x", "info")).rejects.toThrow("no helper connection 7");
  });

  it("takes every helper connection as gone when the system bus is lost: a fault, never an exit", async () => {
    const r = await rig();
    r.bus.connections.set(":1.40", { uid: 1000, pid: 4243 });
    r.bus.sessionOfPid.set(4243, "2");
    await r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [""]);
    r.bus.lose();
    expect(r.seen.map((m) => m.kind)).toEqual(["connected", "gone"]);
    await expect(r.os.notify(1, "x", "info")).rejects.toThrow();
  });
});

describe("startServer", () => {
  const spec = (r: Rig, over: Partial<ServerSpec> = {}): ServerSpec => ({
    plugin: "org.galatea.test", version: "1.0.0", osId: 1000, session: null, argv: [process.execPath, STAND_IN, r.out, "--echo"],
    env: { HOME: "/home/liza", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GALATEA_PLUGIN_DIR: r.dir }, cwd: r.dir, noNewPrivs: true, ...over,
  });

  it("runs a background server with the environment given and nothing else, in its directory, its stdio the transport", async () => {
    const r = await rig();
    const server = await r.os.startServer(spec(r));
    servers.push(server);
    await until(() => r.started() !== undefined, "the server ran");
    const s = r.started()!;
    expect(s.env).toEqual({ HOME: "/home/liza", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", GALATEA_PLUGIN_DIR: r.dir });
    expect(s.cwd).toBe(r.dir);
    expect(procsOf(r, 1000, "2")).toBe("");
    const echoed = new Promise<string>((res) => server.stdout.once("data", (d: Buffer) => res(d.toString())));
    server.stdin.write("ping\n");
    expect(await echoed).toBe("ping\n");
  });

  it("moves a needsSession server into its session's scope, and refuses a session of another account", async () => {
    const r = await rig();
    const server = await r.os.startServer(spec(r, { session: "2" }));
    servers.push(server);
    expect(procsOf(r, 1000, "2")).toBe(`${server.pid}\n`);
    await expect(r.os.startServer(spec(r, { session: "8" }))).rejects.toThrow("session 8 is uid 1001's, not 1000's");
  });

  it("refuses a server without no_new_privs, and one as root", async () => {
    const r = await rig();
    await expect(r.os.startServer({ ...spec(r), noNewPrivs: false as unknown as true })).rejects.toThrow(/only with no_new_privs/);
    await expect(r.os.startServer(spec(r, { osId: 0 }))).rejects.toThrow(/never runs as root/);
    expect(r.started()).toBeUndefined();
  });

  it("rejects a server whose interpreter is gone, nothing left running", async () => {
    const r = await rig();
    await expect(r.os.startServer(spec(r, { argv: ["/nonexistent/python3", "server.py"] })))
      .rejects.toThrow(/org\.galatea\.test 1\.0\.0: it ended before it ran \(exit code 127/);
  });

  it("stops a server with whatever it started (SIGTERM to its group, SIGKILL after the grace)", async () => {
    const r = await rig();
    const server = await r.os.startServer(spec(r));
    await until(() => r.started() !== undefined, "the server ran");
    const child = r.started()!.child as number;
    await server.stop();
    expect(await server.exited).toEqual({ code: null, signal: "SIGTERM" });
    await until(() => !alive(child), "its player ended");
  });

  it("stops a needsSession server when logind removes its session", async () => {
    const r = await rig();
    const server = await r.os.startServer(spec(r, { session: "2" }));
    servers.push(server);
    r.bus.emit({
      sender: LOGIND_OWNER, path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "SessionRemoved",
      body: ["2", "/org/freedesktop/login1/session/_32"],
    });
    expect((await server.exited).signal).toBe("SIGTERM");
  });

  it("drops to the account through the real setpriv with --init-groups by default, which needs root", async () => {
    if (process.getuid!() === 0 || !existsSync("/usr/bin/setpriv")) return;
    const r = await rig({ dropFor: undefined });
    await expect(r.os.startServer(spec(r))).rejects.toThrow(/ended before it ran/);
  });
});
