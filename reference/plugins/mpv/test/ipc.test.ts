import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MpvError, MpvIpc, type PropertyChange } from "../src/ipc.js";
import { FakeMpv } from "./fake-mpv.js";

let fake: FakeMpv;
let ipc: MpvIpc;

beforeEach(async () => {
  fake = await FakeMpv.start();
  ipc = await MpvIpc.connect(fake.path);
});
afterEach(async () => {
  ipc.close();
  await fake.close();
});

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("MpvIpc", () => {
  it("answers each command with its own data, matched by request id", async () => {
    fake.props.set("volume", 42);
    const [a, b] = await Promise.all([
      ipc.command(["get_property", "volume"]),
      ipc.command(["get_property", "pause"]),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(false);
  });

  it("rejects a command mpv answers with an error", async () => {
    await expect(ipc.command(["get_property", "no-such"])).rejects.toBeInstanceOf(MpvError);
    await expect(ipc.command(["get_property", "no-such"])).rejects.toMatchObject({ mpvError: "property not found" });
  });

  it("emits an observed property's changes, its current value first", async () => {
    const seen: PropertyChange[] = [];
    ipc.on("property", (p: PropertyChange) => seen.push(p));
    await ipc.observe(7, "pause");
    fake.setProp("pause", true);
    await tick();
    expect(seen).toEqual([
      { id: 7, name: "pause", data: false },
      { id: 7, name: "pause", data: true },
    ]);
  });

  it("emits other events by name", async () => {
    const events: string[] = [];
    ipc.on("event", (e: { event: string }) => events.push(e.event));
    fake.emit({ event: "file-loaded" });
    await tick();
    expect(events).toEqual(["file-loaded"]);
  });

  it("rejects what is pending, and emits close, when the socket closes", async () => {
    let closed = false;
    ipc.on("close", () => { closed = true; });
    fake.silent = true;
    const pending = ipc.command(["get_property", "volume"]);
    await tick();
    await fake.close();
    await expect(pending).rejects.toThrow("closed");
    expect(closed).toBe(true);
  });

  it("rejects at once a command sent after the socket closed", async () => {
    // Final review C1: a command sent after "close" used to be added to the pending map after
    // the close handler had cleared it, so it never settled.
    const closed = new Promise<void>((resolve) => ipc.once("close", () => resolve()));
    await fake.close();
    await closed;
    const late = ipc.command(["quit"]);
    const outcome = await Promise.race([
      late.then(() => "resolved", (e: Error) => e.message),
      tick(500).then(() => "unsettled"),
    ]);
    expect(outcome).toMatch(/closed/);
  });

  it("skips a line that is not JSON, and reads the lines after it", async () => {
    // Final review M6: JSON.parse used to throw inside the socket's data handler, uncaught.
    const events: string[] = [];
    ipc.on("event", (e: { event: string }) => events.push(e.event));
    fake.emitRaw("not json {\n");
    fake.emit({ event: "file-loaded" });
    await tick();
    expect(events).toEqual(["file-loaded"]);
  });

  it("fails to connect to a path with no mpv", async () => {
    await expect(MpvIpc.connect("/nonexistent/mpv.sock")).rejects.toThrow();
  });
});
