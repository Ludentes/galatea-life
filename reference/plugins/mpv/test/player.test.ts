import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MpvIpc } from "../src/ipc.js";
import { Player, ToolFailure } from "../src/player.js";
import { FakeMpv } from "./fake-mpv.js";

let fake: FakeMpv;
let ipc: MpvIpc;
let clock: number;
const now = () => new Date(clock);
const t0 = Date.UTC(2026, 8, 27, 20, 0, 0, 0);

async function player(files: Record<string, string> = { film: "/v/Film.mkv" }, confirmMs = 2_000): Promise<Player> {
  return Player.attach(ipc, { findFile: async (s) => files[s.title ?? ""], confirmMs, now });
}
const sent = (name: string) => fake.received.filter((c) => c[0] === name);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  clock = t0;
  fake = await FakeMpv.start();
  ipc = await MpvIpc.connect(fake.path);
});
afterEach(async () => {
  ipc.close();
  await fake.close();
});

describe("Player", () => {
  it("starts with mpv's volume, not playing, and no title", async () => {
    fake.props.set("volume", 64.4);
    const p = await player();
    expect(p.state()).toEqual({ playing: false, volume: 64 });
  });

  it("launches the file the library picks, and reports it playing with its title and start", async () => {
    const p = await player();
    let changes = 0;
    p.on("change", () => { changes++; });
    const s = await p.launch({ title: "film" });
    expect(sent("loadfile")).toEqual([["loadfile", "/v/Film.mkv", "replace"]]);
    expect(s).toEqual({ playing: true, volume: 100, title: "Film.mkv", started_at: "2026-09-27T20:00:00.000Z" });
    expect(p.state()).toEqual(s);
    expect(changes).toBeGreaterThan(0);
  });

  it("gives a new started_at to each launch, the same film included", async () => {
    const p = await player();
    const a = await p.launch({ title: "film" });
    clock += 60_000;
    const b = await p.launch({ title: "film" });
    expect(b.started_at).not.toBe(a.started_at);
  });

  it("fails a launch nothing matches, sending mpv nothing", async () => {
    const p = await player();
    await expect(p.launch({ title: "nothing" })).rejects.toBeInstanceOf(ToolFailure);
    expect(sent("loadfile")).toEqual([]);
  });

  it("fails a launch mpv cannot play", async () => {
    fake.failLoad = true;
    const p = await player();
    await expect(p.launch({ title: "film" })).rejects.toThrow(/could not play/);
    expect(p.state().playing).toBe(false);
  });

  it("fails a launch mpv does not confirm in time", async () => {
    fake.loadDelayMs = 1_000;
    const p = await player(undefined, 100);
    await expect(p.launch({ title: "film" })).rejects.toThrow(/did not confirm/);
  });

  it("unpauses a paused player on launch", async () => {
    fake.props.set("pause", true);
    const p = await player();
    const s = await p.launch({ title: "film" });
    expect(sent("set_property")).toContainEqual(["set_property", "pause", false]);
    expect(s.playing).toBe(true);
  });

  it("pauses and resumes, each confirmed", async () => {
    const p = await player();
    await p.launch({ title: "film" });
    expect((await p.pause()).playing).toBe(false);
    expect((await p.resume()).playing).toBe(true);
  });

  it("fails pause and resume with nothing loaded", async () => {
    const p = await player();
    await expect(p.pause()).rejects.toBeInstanceOf(ToolFailure);
    await expect(p.resume()).rejects.toBeInstanceOf(ToolFailure);
    expect(sent("set_property")).toEqual([]);
  });

  it("sets the volume, and refuses one outside 0 to 100 or not whole, sending nothing", async () => {
    const p = await player();
    expect((await p.setVolume(30)).volume).toBe(30);
    await expect(p.setVolume(101)).rejects.toBeInstanceOf(ToolFailure);
    await expect(p.setVolume(-1)).rejects.toBeInstanceOf(ToolFailure);
    await expect(p.setVolume(2.5)).rejects.toBeInstanceOf(ToolFailure);
    expect(sent("set_property")).toEqual([["set_property", "volume", 30]]);
  });

  it("follows a change made at mpv itself", async () => {
    const p = await player();
    await p.launch({ title: "film" });
    let changed = false;
    p.on("change", () => { changed = true; });
    fake.setProp("pause", true);
    await tick();
    expect(changed).toBe(true);
    expect(p.state().playing).toBe(false);
  });

  it("cancels the pending load and leaves no unhandled rejection when mpv rejects loadfile", async () => {
    fake.failLoadCommand = true;
    const p = await player(undefined, 50);
    const baseline = ipc.listenerCount("event");
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    await expect(p.launch({ title: "film" })).rejects.toBeTruthy();
    await tick(150);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(ipc.listenerCount("event")).toBe(baseline);
  });

  it("serialises concurrent launches, each resolving with its own title", async () => {
    const p = await player({ film: "/v/Film.mkv", show: "/v/Show.mkv" });
    const [a, b] = await Promise.all([p.launch({ title: "film" }), p.launch({ title: "show" })]);
    expect(a.title).toBe("Film.mkv");
    expect(b.title).toBe("Show.mkv");
  });

  it("follows a load it did not start: title and started_at describe the same item", async () => {
    // Final review I3: the title used to be set by launch alone, so a file dropped on mpv's window
    // kept the old title under the new started_at.
    const p = await player();
    await p.launch({ title: "film" });
    clock += 60_000;
    fake.emit({ event: "end-file", reason: "stop" });
    fake.emit({ event: "start-file" });
    fake.setProp("media-title", "Dropped.mkv");
    fake.emit({ event: "file-loaded" });
    await tick();
    expect(p.state()).toMatchObject({ title: "Dropped.mkv", started_at: "2026-09-27T20:01:00.000Z" });
    // A title that changes once loaded (the file's own metadata) is followed too.
    fake.setProp("media-title", "Dropped, Its Metadata Title");
    await tick();
    expect(p.state().title).toBe("Dropped, Its Metadata Title");
  });

  it("bounds every command it sends by confirmMs, and the next action still runs", async () => {
    // Final review I4: an mpv that never answers used to block the serial queue for good.
    const p = await player(undefined, 100);
    fake.silent = true;
    await expect(p.setVolume(30)).rejects.toThrow(/did not answer/);
    await expect(p.launch({ title: "film" })).rejects.toBeInstanceOf(ToolFailure);
    fake.silent = false;
    expect((await p.setVolume(40)).volume).toBe(40);
  });

  it("cuts a title to 1 KiB of UTF-8, never inside a character", async () => {
    // Final review M9.
    const name = `a${"é".repeat(600)}.mkv`;
    const p = await player({ long: `/v/${name}` });
    const { title } = await p.launch({ title: "long" });
    expect(Buffer.byteLength(title!)).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(title!)).toBeGreaterThan(1020);
    expect(name.startsWith(title!)).toBe(true);
  });

  it("keeps the title and started_at after mpv goes idle", async () => {
    const p = await player();
    const s = await p.launch({ title: "film" });
    fake.setProp("idle-active", true);
    fake.emit({ event: "end-file", reason: "eof" });
    await tick();
    expect(p.state()).toEqual({ playing: false, volume: 100, title: s.title, started_at: s.started_at });
  });
});
