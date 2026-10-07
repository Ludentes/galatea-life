import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MpvEvent, PropertyChange } from "../src/ipc.js";
import { startMpv, type MpvHandle } from "../src/mpv-process.js";
import { makeVideo } from "./media.js";

// No skip: the verification gate runs with mpv installed, and a missing mpv must fail loudly.
execFileSync("mpv", ["--version"], { stdio: "ignore" });

const TEST_ARGS = ["--vo=null", "--ao=null", "--no-config"];
let mpv: MpvHandle | undefined;
afterEach(async () => { await mpv?.stop(); mpv = undefined; });

function waitFor<T>(emitter: NodeJS.EventEmitter, name: string, pred: (v: T) => boolean, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} within ${ms} ms`)), ms);
    const on = (v: T) => {
      if (!pred(v)) return;
      clearTimeout(timer);
      emitter.off(name, on);
      resolve(v);
    };
    emitter.on(name, on);
  });
}

describe("the real mpv", () => {
  it("starts idle, its socket closed to every other account", async () => {
    mpv = await startMpv({ extraArgs: TEST_ARGS, runtimeDir: mkdtempSync(join(tmpdir(), "rt-")) });
    expect(statSync(mpv.dir).mode & 0o777).toBe(0o700);
    expect(statSync(mpv.socketPath).mode & 0o077).toBe(0);
    expect(await mpv.ipc.command(["get_property", "idle-active"])).toBe(true);
  });

  it("loads a file, reports it loaded, its title, and a pause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-"));
    const file = join(dir, "Test Pattern (2026).mkv");
    makeVideo(file);
    mpv = await startMpv({ extraArgs: TEST_ARGS });
    const order: string[] = [];
    mpv.ipc.on("event", (e: MpvEvent) => order.push(e.event));
    const loaded = waitFor<MpvEvent>(mpv.ipc, "event", (e) => e.event === "file-loaded");
    await mpv.ipc.command(["loadfile", file, "replace"]);
    await loaded;
    expect(order).toContain("start-file");
    expect(order.indexOf("start-file")).toBeLessThan(order.indexOf("file-loaded"));
    expect(await mpv.ipc.command(["get_property", "media-title"])).toBe("Test Pattern (2026).mkv");

    await mpv.ipc.observe(1, "pause");
    const paused = waitFor<PropertyChange>(mpv.ipc, "property", (p) => p.name === "pause" && p.data === true);
    await mpv.ipc.command(["set_property", "pause", true]);
    await paused;
  });

  it("reports a file it cannot play as end-file with reason error", async () => {
    mpv = await startMpv({ extraArgs: TEST_ARGS });
    const ended = waitFor<MpvEvent>(mpv.ipc, "event", (e) => e.event === "end-file");
    await mpv.ipc.command(["loadfile", "/nonexistent/film.mkv", "replace"]);
    expect((await ended).reason).toBe("error");
  });

  it.each([
    ["an EDL", "# mpv EDL v0"],
    ["a playlist", "#EXTM3U"],
  ])("does not follow %s inside a file to a file outside the folder", async (_what, header) => {
    // Final review I2: mpv follows EDL and playlist references by content, whatever the file's
    // name, which would take it outside the configured folders (GA-BRIDGE-54).
    const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "Outside.mkv");
    makeVideo(outside, 5);
    const inside = join(mkdtempSync(join(tmpdir(), "media-")), "Inside.mkv");
    writeFileSync(inside, `${header}\n${outside}\n`);
    mpv = await startMpv({ extraArgs: TEST_ARGS });
    const first = waitFor<MpvEvent>(mpv.ipc, "event", (e) => e.event === "file-loaded" || (e.event === "end-file" && e.reason === "error"));
    await mpv.ipc.command(["loadfile", inside, "replace"]);
    expect(await first).toMatchObject({ event: "end-file", reason: "error" });
  });

  it("caps the volume a keyboard's volume keys reach at 100", async () => {
    // Final review M10: the keys send `add volume`, which mpv clamps at --volume-max (130 by default).
    const file = join(mkdtempSync(join(tmpdir(), "media-")), "Film.mkv");
    makeVideo(file, 5);
    mpv = await startMpv({ extraArgs: TEST_ARGS });
    const loaded = waitFor<MpvEvent>(mpv.ipc, "event", (e) => e.event === "file-loaded");
    await mpv.ipc.command(["loadfile", file, "replace"]);
    await loaded;
    await mpv.ipc.command(["set_property", "volume", 95]);
    await mpv.ipc.command(["add", "volume", 20]);
    expect(await mpv.ipc.command(["get_property", "volume"])).toBe(100);
  });

  it("stops, and removes its socket directory", async () => {
    mpv = await startMpv({ extraArgs: TEST_ARGS });
    const dir = mpv.dir;
    await mpv.stop();
    mpv = undefined;
    expect(() => statSync(dir)).toThrow();
  });
});
