import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateError, StateStore } from "../src/state-store.js";

describe("StateStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-bridge-state-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("starts empty when there is no state file yet", () => {
    const s = StateStore.load(join(dir, "fresh"));
    expect(s.state).toEqual({ v: 1, lastCheckIn: {} });
  });

  it("keeps what it saved across a load, and leaves no temporary file", async () => {
    const s = StateStore.load(dir);
    s.state.lastCheckIn.computer = "2026-09-28T12:00:00.000Z";
    await s.save();
    expect(StateStore.load(dir).state.lastCheckIn).toEqual({ computer: "2026-09-28T12:00:00.000Z" });
    expect(readdirSync(dir)).toEqual(["state.json"]);
    expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });

  it("writes saves in the order asked, the last one winning", async () => {
    const s = StateStore.load(dir);
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      s.state.lastCheckIn.computer = `2026-09-28T12:00:0${i}.000Z`;
      saves.push(s.save());
    }
    await Promise.all(saves);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).lastCheckIn.computer).toBe("2026-09-28T12:00:04.000Z");
  });

  it("refuses a state file that is not JSON, never starting empty in its place", () => {
    writeFileSync(join(dir, "state.json"), "{ half");
    expect(() => StateStore.load(dir)).toThrow(StateError);
  });

  it("refuses a state file of another shape", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 2, lastCheckIn: {} }));
    expect(() => StateStore.load(dir)).toThrow(/not a state file/);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: { computer: "yesterday" } }));
    expect(() => StateStore.load(dir)).toThrow(/not a time/);
  });

  it("refuses a lastCheckIn that is a time but not wire time", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: { computer: "Mon, 28 Sep 2026 12:00:00 GMT" } }));
    expect(() => StateStore.load(dir)).toThrow(/not a time/);
  });

  it("reads a file plan 3a's bridge wrote, with no tokens and no otherAdmins, and keeps both once saved", async () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: {} }));
    const s = StateStore.load(dir);
    expect(s.state.tokens).toBeUndefined();
    s.state.tokens = { accounts: { 1000: { token: "liza", name: "liza", interactive: true } }, given: ["liza", "olga"] };
    s.state.otherAdmins = { computer: [{ vendor: "os", label: "root" }] };
    await s.save();
    expect(StateStore.load(dir).state).toEqual(s.state);
  });

  it("refuses a token table it did not write, and otherAdmins of another shape", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: {},
      tokens: { accounts: { 1000: { token: "liza", name: "liza", interactive: true } }, given: [] } }));
    expect(() => StateStore.load(dir)).toThrow(/never given/);
    writeFileSync(join(dir, "state.json"), JSON.stringify({ v: 1, lastCheckIn: {}, otherAdmins: { computer: "unknown" } }));
    expect(() => StateStore.load(dir)).toThrow(/not a list of administrators/);
  });

  it("refuses a directory it cannot make, and a file where the directory should be", () => {
    writeFileSync(join(dir, "file"), "");
    expect(() => StateStore.load(join(dir, "file", "state"))).toThrow(/cannot make/);
    expect(() => StateStore.load(join(dir, "file"))).toThrow(/cannot make/);
  });

  it("refuses a directory other accounts can write to", () => {
    chmodSync(dir, 0o770);
    expect(() => StateStore.load(dir)).toThrow(/writable by other accounts/);
    chmodSync(dir, 0o755);
    expect(StateStore.load(dir).state).toEqual({ v: 1, lastCheckIn: {} });
  });

  it("refuses a state file it cannot read", () => {
    writeFileSync(join(dir, "state.json"), "{}", { mode: 0o000 });
    // Root reads any file, so the check means something only for another user.
    if (process.getuid?.() === 0) return;
    expect(() => StateStore.load(dir)).toThrow(/cannot read/);
  });
});
