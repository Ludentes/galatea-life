import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { activeApp, escapeMarkup, idleHint, idleMs, notifyArgs, pipeWire, PW_DUMP_MAX, readPipeWire } from "../src/helper/reads.js";
import { SessionHelper } from "../src/helper/session-helper.js";
import { RunError } from "../src/linux/run.js";
import { FakeBusError, FakeLogindBus, FakeRunner } from "./linux-fakes.js";

/**
 * `pw-dump.json` holds two graphs in `pw-dump`'s format: `idle`, the development machine's own
 * (Ubuntu 24.04, PipeWire 1.0), its nodes kept with their states and the properties the helper
 * reads, device names and anything personal replaced; `busy`, the same with four nodes added by hand
 * (`galatea.synthetic`): a camera running, a recording stream, a capture of a sink's monitor and a
 * level meter.
 */
const PW = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/pw-dump.json", import.meta.url)), "utf8")) as { idle: unknown[]; busy: unknown[] };
const node = (id: number, cls: string, state: string, props: Record<string, unknown> = {}) =>
  ({ id, type: "PipeWire:Interface:Node", info: { state, props: { "media.class": cls, ...props } } });

describe("PipeWire's graph", () => {
  it("reads this machine's graph, nothing running, as neither in use", () => {
    expect(readPipeWire(JSON.stringify(PW.idle))).toEqual({ camera_in_use: false, microphone_in_use: false });
  });

  it("reads a running camera and a running recording stream as in use", () => {
    expect(readPipeWire(JSON.stringify(PW.busy))).toEqual({ camera_in_use: true, microphone_in_use: true });
  });

  it("does not take a capture of what the speakers play, nor a level meter, nor an idle or suspended node, for the microphone", () => {
    expect(readPipeWire(JSON.stringify([
      node(1, "Stream/Input/Audio", "running", { "stream.capture.sink": true }),
      node(2, "Stream/Input/Audio", "running", { "stream.monitor": "true" }),
      node(3, "Stream/Input/Audio", "idle"),
      node(4, "Audio/Source", "running"),
      node(5, "Video/Source", "suspended"),
      { id: 6, type: "PipeWire:Interface:Port", info: { state: "running", props: { "media.class": "Video/Source" } } },
    ]))).toEqual({ camera_in_use: false, microphone_in_use: false });
  });

  it("gives no reading for output that is not a graph", () => {
    expect(readPipeWire("")).toBeUndefined();
    expect(readPipeWire("{\"a\":1}")).toBeUndefined();
    expect(readPipeWire("[{\"id\":1")).toBeUndefined();
  });

  it("runs pw-dump with the session's runtime directory and room for a large graph, and reads nothing when it fails", async () => {
    const runner = new FakeRunner().on("pw-dump", { stdout: JSON.stringify(PW.busy) });
    expect(await pipeWire(runner.run, "/run/user/1000")).toEqual({ camera_in_use: true, microphone_in_use: true });
    expect(runner.calls[0]).toEqual({ file: "pw-dump", args: [], env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
    expect(PW_DUMP_MAX).toBe(16 * 1024 * 1024);
    expect(await pipeWire(runner.run, undefined)).toBeUndefined();
    runner.on("pw-dump", { code: 1, stderr: "pw-dump: can't connect: Host is down" });
    expect(await pipeWire(runner.run, "/run/user/1000")).toBeUndefined();
    runner.on("pw-dump", new RunError("timeout", "pw-dump did not finish"));
    expect(await pipeWire(runner.run, "/run/user/1000")).toBeUndefined();
    expect(await pipeWire(new FakeRunner().run, "/run/user/1000")).toBeUndefined();
  });
});

describe("the focused application on X11", () => {
  const display = { DISPLAY: ":1", XAUTHORITY: "/run/user/1000/gdm/Xauthority" };

  it("is the focused window's class, read with the session's display", async () => {
    const runner = new FakeRunner()
      .on("xprop -root -notype _NET_ACTIVE_WINDOW", { stdout: "_NET_ACTIVE_WINDOW: window id # 0x3a00007\n" })
      .on("xprop -id 0x3a00007 -notype WM_CLASS", { stdout: 'WM_CLASS = "gnome-terminal-server", "Gnome-terminal"\n' });
    expect(await activeApp(runner.run, display)).toBe("Gnome-terminal");
    expect(runner.calls[0]!.env).toEqual(display);
  });

  it("is null with no window focused (as this machine gave it, locked)", async () => {
    const runner = new FakeRunner().on("xprop -root -notype _NET_ACTIVE_WINDOW", { stdout: "_NET_ACTIVE_WINDOW: window id # 0x0\n" });
    expect(await activeApp(runner.run, display)).toBeNull();
  });

  it("is no reading with no display, no xprop, a property not set, or a window gone between the reads", async () => {
    expect(await activeApp(new FakeRunner().run, {})).toBeUndefined();
    expect(await activeApp(new FakeRunner().run, display)).toBeUndefined();
    const unset = new FakeRunner().on("xprop -root -notype _NET_ACTIVE_WINDOW", { stdout: "_NET_ACTIVE_WINDOW:  not found.\n" });
    expect(await activeApp(unset.run, display)).toBeUndefined();
    const gone = new FakeRunner()
      .on("xprop -root -notype _NET_ACTIVE_WINDOW", { stdout: "_NET_ACTIVE_WINDOW: window id # 0x3a00007\n" })
      .on("xprop -id 0x3a00007 -notype WM_CLASS", { code: 1, stderr: "X Error of failed request:  BadWindow (invalid Window parameter)\n" });
    expect(await activeApp(gone.run, display)).toBeUndefined();
  });
});

describe("idleness", () => {
  /** A session bus that answers only the names in `answers`. */
  const sessionBus = (answers: Record<string, unknown[] | Error>) => {
    const bus = new FakeLogindBus();
    const asked: string[] = [];
    bus.call = async (destination, path, iface, member) => {
      asked.push(`${destination} ${path} ${member}`);
      const a = answers[`${destination} ${path}`];
      if (!a) throw new FakeBusError("org.freedesktop.DBus.Error.ServiceUnknown", `${destination} is not there`);
      if (a instanceof Error) throw a;
      return a;
    };
    return { bus, asked };
  };

  it("is Mutter's idle time where GNOME gives it", async () => {
    const { bus } = sessionBus({ "org.gnome.Mutter.IdleMonitor /org/gnome/Mutter/IdleMonitor/Core": [301_000n] });
    expect(await idleMs(bus)).toBe(301_000);
  });

  it("is no reading without Mutter: the freedesktop screensaver's idle time is not asked, its unit differing between desktops (review M3)", async () => {
    const { bus, asked } = sessionBus({
      "org.freedesktop.ScreenSaver /ScreenSaver": [4_000], "org.freedesktop.ScreenSaver /org/freedesktop/ScreenSaver": [4],
    });
    expect(await idleMs(bus)).toBeUndefined();
    expect(asked).toEqual(["org.gnome.Mutter.IdleMonitor /org/gnome/Mutter/IdleMonitor/Core GetIdletime"]);
  });

  it("is no reading with no session bus", async () => {
    expect(await idleMs(undefined)).toBeUndefined();
  });

  it("falls back to logind's IdleHint for the helper's own session, read-only", async () => {
    const bus = new FakeLogindBus();
    bus.sessions = [{ id: "2", uid: 1000, idleHint: true }];
    expect(await idleHint(bus, "2")).toBe(true);
    expect(bus.calls).toEqual([
      'org.freedesktop.login1.Manager.GetSession /org/freedesktop/login1 ["2"]',
      'org.freedesktop.DBus.Properties.Get /org/freedesktop/login1/session/_32 ["org.freedesktop.login1.Session","IdleHint"]',
    ]);
    expect(await idleHint(bus, "9")).toBeUndefined();
  });
});

describe("the helper's reading", () => {
  const helper = (keys: string[], runner: FakeRunner) => {
    const system = new FakeLogindBus();
    system.sessions = [{ id: "2", uid: 1000, idleHint: false }];
    return new SessionHelper({
      system, run: runner.run, sessionId: "2", idleAfterS: 300, keys, env: { XDG_RUNTIME_DIR: "/run/user/1000", DISPLAY: ":1" },
      token: "0".repeat(64), log: () => {}, exit: () => {},
    });
  };

  it("reads only the keys the service declared", async () => {
    const runner = new FakeRunner().on("pw-dump", { stdout: JSON.stringify(PW.busy) });
    expect(await helper(["microphone_in_use"], runner).read()).toEqual({ activity: "active", microphone_in_use: true });
    expect(await helper(["camera_in_use"], runner).read()).toEqual({ activity: "active", camera_in_use: true });
    const quiet = new FakeRunner();
    expect(await helper([], quiet).read()).toEqual({ activity: "active" });
    expect(quiet.calls).toEqual([]);
  });

  it("leaves out a key whose read fails, the others reported", async () => {
    const runner = new FakeRunner().on("pw-dump", { code: 1, stderr: "pw-dump: can't connect" });
    expect(await helper(["app", "camera_in_use", "microphone_in_use"], runner).read()).toEqual({ activity: "active" });
  });
});

describe("a notification's arguments", () => {
  const v = (signature: string, value: unknown) => ({ signature, value });

  it("put the source first, as the summary, the rest as the body, the urgency as a hint, shown by the desktop's rule", () => {
    expect(notifyArgs("От: Дмитрий (гость)\nОткрой дверь", "warning", v)).toEqual([
      "Galatea", 0, "", "От: Дмитрий (гость)", "Открой дверь", [], { urgency: { signature: "y", value: 1 } }, -1,
    ]);
    expect((notifyArgs("От: неизвестный отправитель\nx", "critical", v)[6] as { urgency: { value: number } }).urgency.value).toBe(2);
    expect((notifyArgs("От: Galatea\nx", "info", v)[6] as { urgency: { value: number } }).urgency.value).toBe(1);
  });

  it("escape the body, which a notification service may read as markup, so a sender's text cannot carry a link", () => {
    expect(escapeMarkup('<a href="http://x">click</a> & <b>')).toBe('&lt;a href="http://x"&gt;click&lt;/a&gt; &amp; &lt;b&gt;');
    expect(notifyArgs("От: Galatea\n<a href=\"x\">y</a>", "info", v)[4]).toBe("&lt;a href=\"x\"&gt;y&lt;/a&gt;");
  });
});
