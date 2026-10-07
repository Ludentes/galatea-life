import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backup, BACKUP_FORMAT, run } from "../src/herdsman/cli.js";
import { NETWORK_FILE } from "../src/herdsman/network.js";
import { BACKUP_FILE, DATABASE_FILE } from "../src/herdsman/stack.js";
import { PINS_FILE } from "../src/entry.js";
import { InstanceLock } from "../src/instance-lock.js";
import { NETWORK } from "./herdsman-fakes.js";

/** `zigbee-bridge backup` (plan 2c-3): the data directory, in one file for the owner to keep, never while the bridge runs. */

let dir: string;
let out: string;
let lines: { out: string[]; err: string[] };
const say = { out: (l: string) => lines.out.push(l), err: (l: string) => lines.err.push(l) };
const NOW = Date.parse("2026-10-05T12:00:00Z");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zigbee-backup-"));
  await chmod(dir, 0o700);
  out = join(await mkdtemp(join(tmpdir(), "zigbee-kept-")), "kept.json");
  lines = { out: [], err: [] };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(join(out, ".."), { recursive: true, force: true });
});

/** The data directory as a bridge leaves it: the owner's network, the coordinator's backup, herdsman's database, and `pins` if given. */
async function formed(pins?: string): Promise<void> {
  await writeFile(join(dir, NETWORK_FILE), JSON.stringify(NETWORK), { mode: 0o600 });
  await writeFile(join(dir, BACKUP_FILE), "{\"coordinator\":true}", { mode: 0o600 });
  await utimes(join(dir, BACKUP_FILE), new Date(NOW - 60_000), new Date(NOW - 60_000));
  await writeFile(join(dir, DATABASE_FILE), "{\"id\":1}\n", { mode: 0o600 });
  if (pins !== undefined) await writeFile(join(dir, PINS_FILE), pins, { mode: 0o600 });
}

describe("zigbee-bridge backup", () => {
  it("copies the network, the coordinator's backup, herdsman's database and the PINs into one file the owner alone can read", async () => {
    await formed("{\"0x00000000000a0005\":\"40719263\"}");
    expect(await backup({ dataDir: dir, out, say, now: () => NOW })).toBe(0);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(await readFile(out, "utf8"));
    expect(kept).toEqual({ format: BACKUP_FORMAT, version: 1, takenAt: "2026-10-05T12:00:00.000Z", files: {
      [NETWORK_FILE]: JSON.stringify(NETWORK), [BACKUP_FILE]: "{\"coordinator\":true}", [DATABASE_FILE]: "{\"id\":1}\n",
      [PINS_FILE]: "{\"0x00000000000a0005\":\"40719263\"}" } });
    expect(lines.out).toEqual([`backed up ${NETWORK_FILE}, ${BACKUP_FILE}, ${DATABASE_FILE}, ${PINS_FILE} to ${out}`,
      "the coordinator's backup was written 2026-10-05T11:59:00.000Z"]);
    // What it says quotes neither the key nor a PIN.
    const said = [...lines.out, ...lines.err].join("\n");
    expect(said).not.toContain("40719263");
    expect(said).not.toContain(NETWORK.networkKey.join(","));
  });

  it("refuses while the bridge runs on the data directory, writing nothing: the bridge's stop writes the coordinator's backup", async () => {
    await formed();
    const bridge = await InstanceLock.acquire(dir);
    expect(await backup({ dataDir: dir, out, say })).toBe(2);
    await expect(stat(out)).rejects.toThrow();
    expect(lines.err).toEqual([`refusing to back up: another bridge is running on ${dir}: stop the bridge first (its stop writes the coordinator's backup)`]);
    await bridge.release();
  });

  it("refuses where the owner's network is missing or cannot be read, and a data directory other accounts can read", async () => {
    expect(await backup({ dataDir: dir, out, say })).toBe(2);
    expect(lines.err.at(-1)).toBe("refusing to back up: no network.json: the owner forms the network (zigbee-bridge form)");
    await formed();
    await chmod(join(dir, NETWORK_FILE), 0o644);
    expect(await backup({ dataDir: dir, out, say })).toBe(2);
    expect(lines.err.at(-1)).toBe("refusing to back up: network.json can be read by other accounts: it holds the network key");
    await chmod(join(dir, NETWORK_FILE), 0o600);
    await chmod(dir, 0o750);
    expect(await backup({ dataDir: dir, out, say })).toBe(2);
    expect(lines.err.at(-1)).toMatch(/^refusing to back up: .* can be read by other accounts/);
    await expect(stat(out)).rejects.toThrow();
  });

  it("never writes over a file there, and says so", async () => {
    await formed();
    await writeFile(out, "the owner's", { mode: 0o600 });
    expect(await backup({ dataDir: dir, out, say })).toBe(1);
    expect(await readFile(out, "utf8")).toBe("the owner's");
    expect(lines.err).toEqual([`zigbee-bridge backup: ${out} was not written (EEXIST)`]);
  });

  it("backs up what is there, and says when there is no coordinator backup", async () => {
    await formed();
    await rm(join(dir, BACKUP_FILE));
    expect(await backup({ dataDir: dir, out, say })).toBe(0);
    expect(Object.keys(JSON.parse(await readFile(out, "utf8")).files)).toEqual([NETWORK_FILE, DATABASE_FILE]);
    expect(lines.err).toEqual(["zigbee-bridge backup: there is no coordinator backup: start the bridge and stop it, which writes one"]);
  });

  it("is run from the command line with the data directory from the environment", async () => {
    await formed();
    expect(await run(["backup"], { GALATEA_STATE_DIR: dir }, say)).toBe(2);
    expect(await run(["backup", "--to", out], { GALATEA_STATE_DIR: dir }, say)).toBe(2);
    expect(lines.err).toEqual(Array(2).fill("usage: zigbee-bridge form --channel N [--replace-network] | zigbee-bridge backup --out FILE"));
    expect(await run(["backup", "--out", out], { GALATEA_STATE_DIR: dir }, say)).toBe(0);
    expect(JSON.parse(await readFile(out, "utf8")).format).toBe(BACKUP_FORMAT);
  });
});
