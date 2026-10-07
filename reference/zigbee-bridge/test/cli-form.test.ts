import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Endpoint } from "zigbee-herdsman/dist/controller/model/endpoint.js";
import { form, run } from "../src/herdsman/cli.js";
import type { Prediction } from "../src/herdsman/network-guard.js";
import { NETWORK_FILE, networkProblem, newNetwork, readNetwork, writeNetwork } from "../src/herdsman/network.js";
import { BACKUP_FILE, DATABASE_FILE } from "../src/herdsman/stack.js";
import { InstanceLock } from "../src/instance-lock.js";
import { type FakeStack, stacks } from "./herdsman-fakes.js";

/**
 * `zigbee-bridge form` (plan 2c-3): forming a network writes to the coordinator, so it is graded here,
 * against a stack in memory, and on the bench only in the final destructive suite.
 */

/** The coordinator's IEEE address, made up. */
const FORMED_BY = "0x00124b00aabbccdd";

let dir: string;
let lines: { out: string[]; err: string[] };
const say = { out: (l: string) => lines.out.push(l), err: (l: string) => lines.err.push(l) };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zigbee-form-"));
  await chmod(dir, 0o700);
  lines = { out: [], err: [] };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What the network guard reads from a coordinator that holds no network: herdsman would form one. */
const none = async (): Promise<Prediction> => ({ strategy: "startCommissioning", channel: null, coordinator: FORMED_BY });
/** What it reads from a coordinator that holds a network on channel 15: another data directory's, a lost one's, another controller's. */
const holds = async (): Promise<Prediction> => ({ strategy: "startCommissioning", channel: 15, coordinator: FORMED_BY });

/** Stacks whose herdsman forms the network (`reset`) on a coordinator of FORMED_BY, unless `prepare` says otherwise. */
const forming = (prepare: (s: FakeStack) => void = () => {}) => stacks((s) => {
  s.result = "reset";
  s.coordinator = () => ({ deviceIeeeAddress: FORMED_BY }) as Endpoint;
  // herdsman writes the coordinator's backup as it forms.
  const start = s.start.bind(s);
  s.start = async () => {
    const r = await start();
    if (r === "reset") await writeFile(join(dir, BACKUP_FILE), "{}", { mode: 0o600 });
    return r;
  };
  prepare(s);
});

describe("zigbee-bridge form", () => {
  it("forms a network on the channel: a fresh key, written with the coordinator's address, readable by its owner alone", async () => {
    const { made, make } = forming();
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(0);
    expect(made).toHaveLength(1);
    expect(made[0]!.calls).toEqual(["start", "close"]);
    const read = await readNetwork(dir);
    if (!("network" in read)) throw new Error(read.detail);
    expect(read.network).toMatchObject({ channel: 20, coordinator: FORMED_BY });
    // herdsman was given that network to form.
    expect(made[0]!.options.network).toMatchObject({ panID: read.network.panID, extendedPanID: read.network.extendedPanID,
      networkKey: read.network.networkKey, channel: 20 });
    expect((await stat(join(dir, NETWORK_FILE))).mode & 0o777).toBe(0o600);
    expect(lines.out).toEqual([`formed a network on channel 20, PAN id 0x${read.network.panID.toString(16).padStart(4, "0")}, coordinator ${FORMED_BY}`]);
    // The key is said nowhere, in no form.
    const said = [...lines.out, ...lines.err].join("\n");
    expect(said).not.toContain(Buffer.from(read.network.networkKey).toString("hex"));
    expect(said).not.toContain(read.network.networkKey.join(","));
  });

  it("refuses a channel outside 11 to 26, before anything is started", async () => {
    const { made, make } = forming();
    for (const channel of [10, 27, 15.5]) {
      expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel, say, makeStack: make, predict: none })).toBe(2);
    }
    expect(made).toEqual([]);
    expect(lines.err).toEqual(Array(3).fill("refusing to form: the channel is 11 to 26 (zigbee-bridge form --channel N)"));
  });

  it("refuses where a network, a coordinator backup or herdsman's database is already there, before anything is started", async () => {
    for (const name of [NETWORK_FILE, BACKUP_FILE, DATABASE_FILE]) {
      const { made, make } = forming();
      await writeFile(join(dir, name), "{}", { mode: 0o600 });
      expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(2);
      expect(made).toEqual([]);
      expect(lines.err.at(-1)).toBe(`refusing to form: ${name} is there already: a network was formed here (the owner removes the data directory's files to form again)`);
      await rm(join(dir, name));
    }
  });

  it("refuses a second form: the first one's network is never lost", async () => {
    const { make } = forming();
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(0);
    const first = await readFile(join(dir, NETWORK_FILE), "utf8");
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 21, say, makeStack: make, predict: none })).toBe(2);
    expect(await readFile(join(dir, NETWORK_FILE), "utf8")).toBe(first);
  });

  it("refuses while the bridge runs on the data directory: the coordinator takes one client", async () => {
    const bridge = await InstanceLock.acquire(dir);
    const { made, make } = forming();
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(2);
    expect(made).toEqual([]);
    expect(lines.err.at(-1)).toBe(`refusing to form: another bridge is running on ${dir}: stop the bridge first (its stop writes the coordinator's backup)`);
    await bridge.release();
  });

  it("refuses a data directory other accounts can read", async () => {
    await chmod(dir, 0o755);
    const { made, make } = forming();
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(2);
    expect(made).toEqual([]);
    expect(lines.err.at(-1)).toMatch(/^refusing to form: .* can be read by other accounts/);
  });

  it("writes no network when herdsman resumed or restored one instead, or its start failed, and closes it each time", async () => {
    for (const result of ["resumed", "restored"]) {
      const { made, make } = forming((s) => { s.result = result; });
      expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(1);
      expect(made[0]!.calls).toEqual(["start", "close"]);
      expect(lines.err.at(-1)).toBe(`zigbee-bridge form: herdsman's start ${result} a network instead of forming one; network.json is not written`);
    }
    const { made, make } = forming((s) => { s.result = Promise.reject(new Error("no answer from 0x00124b00aabbccdd")); });
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(1);
    expect(made[0]!.calls).toEqual(["start", "close"]);
    await expect(stat(join(dir, NETWORK_FILE))).rejects.toThrow();
  });

  it("takes the coordinator's backup when herdsman wrote none as it formed", async () => {
    const { made, make } = stacks((s) => {
      s.result = "reset";
      s.coordinator = () => ({ deviceIeeeAddress: FORMED_BY }) as Endpoint;
    });
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(0);
    expect(made[0]!.calls).toEqual(["start", "backup", "close"]);
  });

  it("is run from the command line with the data directory and the coordinator from the environment", async () => {
    const { made, make } = forming();
    const env = { GALATEA_STATE_DIR: dir, GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:1" };
    expect(await run(["form"], env, say, { makeStack: make, predict: none })).toBe(2);
    expect(await run(["form", "--channel", "x"], env, say, { makeStack: make, predict: none })).toBe(2);
    expect(await run(["forms", "--channel", "20"], env, say, { makeStack: make, predict: none })).toBe(2);
    expect(await run(["form", "--channel", "20"], { GALATEA_STATE_DIR: dir }, say, { makeStack: make, predict: none })).toBe(2);
    expect(await run(["form", "--channel", "20"], {}, say, { makeStack: make, predict: none })).toBe(2);
    expect(made).toEqual([]);
    expect(await run(["form", "--channel", "20"], env, say, { makeStack: make, predict: none })).toBe(0);
    expect(made[0]!.options.coordinator).toBe("tcp://127.0.0.1:1");
  });
});

describe("zigbee-bridge form, after herdsman formed", () => {
  it("writes no network.json when herdsman names no coordinator", async () => {
    const { make } = forming((s) => { s.coordinator = () => undefined; });
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: none })).toBe(1);
    await expect(stat(join(dir, NETWORK_FILE))).rejects.toThrow();
    expect(lines.err).toEqual(["zigbee-bridge form: herdsman named no coordinator; network.json is not written"]);
  });

  it("never writes network.json over one there", async () => {
    await writeFile(join(dir, NETWORK_FILE), "the owner's", { mode: 0o600 });
    await expect(writeNetwork(dir, { ...newNetwork(20), coordinator: FORMED_BY })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(dir, NETWORK_FILE), "utf8")).toBe("the owner's");
  });
});

describe("zigbee-bridge form, on a coordinator that holds a network (plan 2c-3 review I2)", () => {
  it("refuses, naming the network's channel, and never starts herdsman, which would wipe it (the review's probe)", async () => {
    const { made, make } = forming();
    const asked: { coordinator: string; channel: number; backupPath: string }[] = [];
    const predict = async (coordinator: string, n: { channel: number }, backupPath: string) => {
      asked.push({ coordinator, channel: n.channel, backupPath });
      return holds();
    };
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict })).toBe(2);
    expect(made).toEqual([]);
    expect(asked).toEqual([{ coordinator: "tcp://127.0.0.1:1", channel: 20, backupPath: join(dir, BACKUP_FILE) }]);
    expect(lines.err).toEqual(["refusing to form: the coordinator holds a network on channel 15: forming replaces it, and every device "
      + "paired to it must be paired again (zigbee-bridge form --channel N --replace-network)"]);
    await expect(stat(join(dir, NETWORK_FILE))).rejects.toThrow();
  });

  it("replaces it when the owner says --replace-network, and says what it replaced", async () => {
    const { made, make } = forming();
    expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: holds, replaceNetwork: true }))
      .toBe(0);
    expect(made[0]!.calls).toEqual(["start", "close"]);
    expect(lines.err).toEqual(["zigbee-bridge form: replacing the network the coordinator holds on channel 15, as --replace-network says"]);
    expect((await readNetwork(dir) as { network: { channel: number } }).network.channel).toBe(20);
  });

  it("refuses when the coordinator cannot be read: whether it holds a network is not known", async () => {
    const { made, make } = forming();
    const unread = async (): Promise<Prediction> => { throw new Error("the coordinator was not read within 20000 ms"); };
    for (const replaceNetwork of [false, true]) {
      expect(await form({ dataDir: dir, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make, predict: unread, replaceNetwork }))
        .toBe(2);
    }
    expect(made).toEqual([]);
    expect(lines.err).toEqual(Array(2).fill("refusing to form: the coordinator was not read (the coordinator was not read within 20000 ms)"));
  });

  it("refuses a data directory that does not exist, and makes none: a mistyped GALATEA_STATE_DIR forms nothing", async () => {
    const { made, make } = forming();
    const missing = join(dir, "zigbee-typo");
    let read = 0;
    expect(await form({ dataDir: missing, coordinator: "tcp://127.0.0.1:1", channel: 20, say, makeStack: make,
      predict: async () => { read += 1; return none(); } })).toBe(2);
    expect({ made, read }).toEqual({ made: [], read: 0 });
    await expect(stat(missing)).rejects.toThrow();
    expect(lines.err).toEqual([`refusing to form: ${missing} does not exist (the owner makes it, mode 0700, and sets GALATEA_STATE_DIR to it)`]);
  });

  it("takes --replace-network from the command line, before or after the channel", async () => {
    const env = { GALATEA_STATE_DIR: dir, GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:1" };
    const { made, make } = forming();
    expect(await run(["form", "--channel", "20"], env, say, { makeStack: make, predict: holds })).toBe(2);
    expect(await run(["form", "--channel", "20", "--replace"], env, say, { makeStack: make, predict: holds })).toBe(2);
    expect(await run(["form", "--channel", "20", "--replace-network", "--replace-network"], env, say, { makeStack: make, predict: holds })).toBe(2);
    expect(made).toEqual([]);
    expect(await run(["form", "--replace-network", "--channel", "20"], env, say, { makeStack: make, predict: holds })).toBe(0);
    expect(made).toHaveLength(1);
    await rm(join(dir, NETWORK_FILE));
    await rm(join(dir, BACKUP_FILE));
    expect(await run(["form", "--channel", "21", "--replace-network"], env, say, { makeStack: make, predict: holds })).toBe(0);
    expect(made).toHaveLength(2);
  });
});

describe("newNetwork", () => {
  it("draws a network the bridge reads, never herdsman's defaults nor the key everyone knows", () => {
    // A source that gives the defaults first: each is drawn again.
    const given = [Buffer.from([0xff, 0xff]), Buffer.from([0x1a, 0x62]), Buffer.from([0x1a, 0x2b]), Buffer.alloc(8, 0xdd), Buffer.alloc(8, 0x12),
      Buffer.from([0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0d]), Buffer.alloc(16, 0x3a)];
    const n = newNetwork(25, () => given.shift()!);
    expect(n).toEqual({ panID: 0x1a2b, extendedPanID: Array(8).fill(0x12), channel: 25, networkKey: Array(16).fill(0x3a) });
    expect(networkProblem({ ...n, coordinator: FORMED_BY })).toBeUndefined();
    expect(given).toEqual([]);
  });

  it("draws a fresh network each time", () => {
    const a = newNetwork(15);
    const b = newNetwork(15);
    expect(a.networkKey).not.toEqual(b.networkKey);
    expect(networkProblem({ ...a, coordinator: FORMED_BY })).toBeUndefined();
  });
});

describe("the zigbee-bridge command", () => {
  /** As the entry point's refusals are run (`main-refusals.test.ts`): from its source, `.js` specifiers mapped to `.ts`. */
  const HOOK = `import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) {" +
  " if (s.startsWith('.') && s.endsWith('.js')) return n(s.slice(0, -3) + '.ts', c); throw e; } }"));`;
  const command = (args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types", "--import", `data:text/javascript,${encodeURIComponent(HOOK)}`,
      join(import.meta.dirname, "../src/cli.ts"), ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.on("exit", (code) => resolve({ code, out }));
  });

  it("refuses a form it cannot do, exiting 2, before it reaches a coordinator", async () => {
    const env = { GALATEA_STATE_DIR: dir, GALATEA_ZIGBEE_COORDINATOR: "tcp://127.0.0.1:1" };
    expect(await command(["form", "--channel", "30"], env)).toEqual({ code: 2, out: "refusing to form: the channel is 11 to 26 (zigbee-bridge form --channel N)\n" });
    expect(await command(["form"], env)).toEqual({ code: 2, out: "usage: zigbee-bridge form --channel N [--replace-network] | zigbee-bridge backup --out FILE\n" });
    await writeFile(join(dir, NETWORK_FILE), "{}", { mode: 0o600 });
    const r = await command(["form", "--channel", "20"], env);
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to form: network.json is there already");
  }, 30_000);
});
