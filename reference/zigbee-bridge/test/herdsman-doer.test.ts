import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKUP_AGE_MS, BACKUP_MS, BACKUP_RETRY_MS, HerdsmanDoer, PING_MS, START_MS } from "../src/herdsman/doer.js";
import { BackupUnreadable, type Prediction } from "../src/herdsman/network-guard.js";
import type { NetworkRead } from "../src/herdsman/network.js";
import { EXCHANGE_MS } from "../src/transport.js";
import { FakeClock, settle } from "./fakes.js";
import { core, type FakeStack, NETWORK, RESUMES, stacks } from "./herdsman-fakes.js";

/**
 * The close a doer's first controller sends once it resumed (plan 3b review I2): a bridge that stopped
 * without closing its join window may have left the coordinator permitting joins.
 */
const START_CLOSE = "permitJoin 0";

const COORDINATOR = "tcp://coordinator.invalid:6638";
const DATA = "/data/zigbee";

const doers: HerdsmanDoer[] = [];
afterEach(async () => {
  for (const d of doers.splice(0)) await d.stop();
});

interface Setup {
  /** What reading network.json finds, each try. */
  read?: () => NetworkRead;
  /** What the guard reads from the coordinator at each try: a prediction, or a throw. */
  predict?: (n: number) => Prediction;
  prepare?: (s: FakeStack, n: number) => void;
  /** The hardware the core refuses to admit now. */
  refuse?: (hw: string) => boolean;
  /** The devices the store keeps, given at the start. */
  kept?: string[];
  /** When the coordinator's backup was last written; just now unless given. */
  backupTakenAt?: (clock: FakeClock) => Promise<number | undefined>;
}

async function started(o: Setup = {}) {
  const clock = new FakeClock();
  const { made, make } = stacks(o.prepare);
  const predictions: { coordinator: string; backupPath: string }[] = [];
  const doer = new HerdsmanDoer({
    clock, coordinator: COORDINATOR, dataDir: DATA, makeStack: make,
    readNetwork: async () => (o.read ? o.read() : { network: NETWORK }),
    predict: async (coordinator, _n, backupPath) => {
      predictions.push({ coordinator, backupPath });
      return o.predict ? o.predict(predictions.length - 1) : RESUMES;
    },
    backupTakenAt: () => (o.backupTakenAt ? o.backupTakenAt(clock) : Promise.resolve(clock.now())),
  });
  doers.push(doer);
  const { events, seen } = core(o.refuse);
  await doer.start(events, new Map((o.kept ?? []).map((hw) => [hw, {}])));
  await settle();
  return { clock, doer, made, seen, predictions };
}

const transports = (seen: unknown[][]) => seen.filter((e) => e[0] === "transport").map((e) => [e[1], e[3]]);
const faults = (seen: unknown[][]) => seen.filter((e) => e[0] === "fault").map((e) => [e[1], e[2]]);

describe("HerdsmanDoer: the controller's life", () => {
  it("starts herdsman only after the guard read that it would resume the owner's network, and is up on its first exchange", async () => {
    const { made, seen, predictions } = await started();
    expect(predictions).toEqual([{ coordinator: COORDINATOR, backupPath: `${DATA}/coordinator_backup.json` }]);
    expect(made).toHaveLength(1);
    expect(made[0]!.options).toEqual({ coordinator: COORDINATOR, dataDir: DATA, network: NETWORK });
    expect(made[0]!.started).toBe(true);
    expect(transports(seen)).toEqual([["down", undefined], ["up", undefined]]);
    expect(faults(seen)).toEqual([]);
  });

  it("never starts herdsman without the owner's network: no_network, down, tried again on the backoff", async () => {
    const missing: NetworkRead = { fault: "no_network", detail: "no network.json: the owner forms the network (zigbee-bridge form)" };
    let read = missing;
    const { clock, made, seen } = await started({ read: () => read });
    expect(made).toEqual([]);
    expect(faults(seen)).toEqual([["no_network", missing.detail]]);
    expect(transports(seen)).toEqual([["down", undefined], ["down", EXCHANGE_MS]]);
    read = { network: NETWORK };
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(1);
    expect(faults(seen)).toEqual([["no_network", missing.detail], ["no_network", null]]);
    expect(transports(seen).at(-1)).toEqual(["up", undefined]);
  });

  it("clears no_network once network.json is there, though the coordinator is not read yet", async () => {
    let read: NetworkRead = { fault: "invalid_network", detail: "network.json is no JSON" };
    let answers = false;
    const { clock, made, seen } = await started({ read: () => read,
      predict: () => { if (!answers) throw new Error("the coordinator was not read within 20000 ms"); return RESUMES; } });
    read = { network: NETWORK };
    await clock.advance(EXCHANGE_MS);
    expect(made).toEqual([]);
    expect(faults(seen)).toEqual([["invalid_network", "network.json is no JSON"], ["invalid_network", null]]);
    answers = true;
    await clock.advance(2 * EXCHANGE_MS);
    expect(made).toHaveLength(1);
  });

  it.each([
    [{ strategy: "startCommissioning" }, "herdsman would form a new network: the coordinator holds another network, or none"],
    [{ strategy: "restoreBackup" }, "herdsman would restore the coordinator from its backup, which forms a network first"],
    [{ coordinator: "0x00124b0087654321" }, "another coordinator answers than the one the network was formed on"],
    [{ channel: 25 }, "the coordinator's network is on another channel than network.json: herdsman would move it"],
  ] as [Partial<Prediction>, string][])("never starts herdsman when the guard reads %j: state_mismatch until it would resume", async (over, why) => {
    let p: Prediction = { ...RESUMES, ...over };
    const { clock, made, seen } = await started({ predict: () => p });
    expect(made).toEqual([]);
    expect(faults(seen)).toEqual([["state_mismatch", why]]);
    p = RESUMES;
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(1);
    expect(faults(seen).at(-1)).toEqual(["state_mismatch", null]);
  });

  it("takes a coordinator that was not read for a failed try, with no fault", async () => {
    const { made, seen } = await started({ predict: () => { throw new Error("the coordinator was not read within 20000 ms"); } });
    expect(made).toEqual([]);
    expect(faults(seen)).toEqual([]);
    expect(transports(seen)).toEqual([["down", undefined], ["down", EXCHANGE_MS]]);
  });

  it("names a damaged coordinator backup in invalid_backup, quoting nothing of it, until the coordinator is read", async () => {
    let damaged = true;
    const { seen, clock } = await started({ predict: () => {
      if (damaged) throw new BackupUnreadable();
      return RESUMES;
    } });
    expect(faults(seen)).toEqual([["invalid_backup", "the coordinator's backup file is damaged, or of a format herdsman does not read"]]);
    expect(JSON.stringify(seen)).not.toContain("3a91");
    damaged = false;
    await clock.advance(EXCHANGE_MS);
    await settle();
    expect(faults(seen).at(-1)).toEqual(["invalid_backup", null]);
  });

  it("clears invalid_backup once the backup is read, though herdsman's start then fails", async () => {
    let damaged = true;
    const { seen, clock } = await started({
      predict: () => { if (damaged) throw new BackupUnreadable(); return RESUMES; },
      prepare: (s) => { s.result = Promise.reject(new Error("the coordinator did not start")); },
    });
    expect(faults(seen)).toEqual([["invalid_backup", "the coordinator's backup file is damaged, or of a format herdsman does not read"]]);
    damaged = false;
    await clock.advance(EXCHANGE_MS);
    await settle();
    expect(faults(seen).at(-1)).toEqual(["invalid_backup", null]);
  });

  it("redacts herdsman's words in its own error lines: a failed read and a failed start (re-review N4)", async () => {
    const KEY_HEX = "3a9107c45e22f0186bd940a7138e55ec";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      let n = 0;
      await started({
        predict: () => { if (n++ === 0) throw new Error(`read failed: ${KEY_HEX}`); return RESUMES; },
        prepare: (s) => { s.result = Promise.reject(new Error(`start failed: ${KEY_HEX}`)); },
      }).then(async ({ clock }) => { await clock.advance(EXCHANGE_MS); await settle(); });
      expect(lines.some((l) => l.startsWith("herdsman: the coordinator was not read"))).toBe(true);
      expect(lines.some((l) => l.startsWith("herdsman: start:"))).toBe(true);
      expect(lines.join("\n")).not.toContain(KEY_HEX);
    } finally {
      spy.mockRestore();
    }
  });

  it("closes a start that formed a network anyway, as state_mismatch", async () => {
    const { made, seen } = await started({ prepare: (s) => { s.result = "reset"; } });
    expect(made[0]!.closed).toBe(1);
    expect(faults(seen)).toEqual([["state_mismatch", "herdsman's start reset a network instead of resuming the owner's"]]);
  });

  it("closes a start that takes longer than START_MS, and tries again on the backoff", async () => {
    const clock = new FakeClock();
    const { made, make } = stacks((s, n) => { if (n === 0) s.result = new Promise(() => {}); });
    const doer = new HerdsmanDoer({ clock, coordinator: COORDINATOR, dataDir: DATA, makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES });
    doers.push(doer);
    const { events, seen } = core();
    const starting = doer.start(events);
    await settle();
    await clock.advance(START_MS);
    await starting;
    expect(made[0]!.closed).toBe(1);
    expect(faults(seen)).toEqual([]);
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(2);
    expect(transports(seen).at(-1)).toEqual(["up", undefined]);
  });
});

describe("HerdsmanDoer: the coordinator's link (GA-BRIDGE-10, 11, 23)", () => {
  it("closes the controller on a failed health exchange, and builds a new one on the backoff", async () => {
    const { clock, made, seen } = await started({ prepare: (s, n) => { if (n === 0) s.pings = [true, false]; } });
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(1);
    expect(made[0]!.closed).toBe(1);
    // Still up: an exchange succeeded within the 30 s window.
    expect(transports(seen).at(-1)).toEqual(["up", undefined]);
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(2);
    expect(made[1]!.started).toBe(true);
  });

  it("is down at once on herdsman's disconnect, and tries again on the backoff", async () => {
    const { clock, made, seen } = await started();
    made[0]!.events.disconnected();
    await settle();
    expect(made[0]!.closed).toBe(1);
    expect(transports(seen).at(-1)).toEqual(["down", EXCHANGE_MS]);
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(2);
    expect(transports(seen).at(-1)).toEqual(["up", undefined]);
  });

  it("does not hear an old controller: its late disconnect, during the rebuild, does not throw away the new one", async () => {
    const { clock, made, seen } = await started();
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(2);
    made[0]!.events.disconnected();
    await settle();
    expect(made[1]!.closed).toBe(0);
    expect(transports(seen).at(-1)).toEqual(["up", undefined]);
  });

  it("takes a message from a device for an exchange", async () => {
    const { clock, made, seen } = await started({ prepare: (s) => { s.pings = [true, false, false, false]; } });
    // The health exchange fails from here on; the devices keep talking.
    for (let i = 0; i < 4; i++) {
      await clock.advance(EXCHANGE_MS - 1);
      made.at(-1)!.events.heard("0xa4c1380000000001");
    }
    expect(transports(seen).filter(([s]) => s === "down")).toHaveLength(1);
    // No health exchange was due: each message was one.
    expect(made).toHaveLength(1);
    expect(made[0]!.pings).toHaveLength(3);
  });

  it("closes the controller when it stops, and a start under way", async () => {
    const { doer, made } = await started();
    await doer.stop();
    expect(made[0]!.closed).toBe(1);
    const clock = new FakeClock();
    const { made: held, make } = stacks((s) => { s.result = new Promise(() => {}); });
    const second = new HerdsmanDoer({ clock, coordinator: COORDINATOR, dataDir: DATA, makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES });
    void second.start(core().events);
    await settle();
    await second.stop();
    expect(held[0]!.closed).toBe(1);
  });
});

describe("HerdsmanDoer: the coordinator's backup at a stop", () => {
  it("asks herdsman for a fresh backup before it closes, while the link is up", async () => {
    const { doer, made } = await started();
    await doer.stop();
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup", "close"]);
  });

  it("takes no backup when the link is not up: the controller was closed on the failed exchange", async () => {
    const { doer, made } = await started({ prepare: (s) => { s.pings = [false]; } });
    await doer.stop();
    expect(made.flatMap((m) => m.calls).filter((c) => c === "backup")).toEqual([]);
  });

  it("takes no backup while the controller is there but the link is not up: a stop during its first exchange", async () => {
    const clock = new FakeClock();
    const { made, make } = stacks((s) => { s.pings = [new Promise(() => {})]; });
    const doer = new HerdsmanDoer({ clock, coordinator: COORDINATOR, dataDir: DATA, makeStack: make,
      readNetwork: async () => ({ network: NETWORK }), predict: async () => RESUMES });
    void doer.start(core().events);
    await settle();
    expect(made).toHaveLength(1);
    expect(made[0]!.calls).toEqual(["start", START_CLOSE]);
    await doer.stop();
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "close"]);
  });

  it("closes after BACKUP_MS of its clock when the backup does not answer", async () => {
    const { doer, made, clock } = await started({ prepare: (s) => { s.backupResult = new Promise(() => {}); } });
    let stopped = false;
    const stopping = doer.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    await clock.advance(BACKUP_MS);
    await stopping;
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup", "close"]);
  });
});

describe("HerdsmanDoer: joins and leaves", () => {
  const SENSOR = "0xa4c1380000000001";
  const PUSHER = "0xa4c1380000000002";
  const STRANGER = "0xa4c1380000000003";
  const of = (seen: unknown[][], ...names: string[]) => seen.filter((e) => names.includes(e[0] as string));

  it("lets in a device herdsman's database still has without asking the core: herdsman admits nothing new for it", async () => {
    const { made, seen } = await started({ prepare: (s) => { s.had.add(SENSOR); }, refuse: () => true });
    expect(await made[0]!.events.joining(SENSOR)).toBe(true);
    expect(of(seen, "mayAdmit")).toEqual([]);
  });

  it("lets in a device herdsman's database has while herdsman's start is still under way", async () => {
    let answer: boolean | undefined;
    // herdsman's join handler is wired before its start resolves (plan 2b review I1).
    const { seen } = await started({ prepare: (s) => {
      s.had.add(SENSOR);
      s.midStart = async () => { answer = await s.events.joining(SENSOR); };
    }, refuse: () => true });
    expect(answer).toBe(true);
    expect(of(seen, "mayAdmit")).toEqual([]);
  });

  it("asks the core for other hardware, and refuses what it refuses: herdsman then removes it", async () => {
    const { made, seen } = await started({ refuse: (hw) => hw === PUSHER });
    expect(await made[0]!.events.joining(PUSHER)).toBe(false);
    expect(await made[0]!.events.joining(STRANGER)).toBe(true);
    expect(of(seen, "mayAdmit")).toEqual([["mayAdmit", PUSHER], ["mayAdmit", STRANGER]]);
  });

  it("reports a device herdsman let in as an association, its successful interview, and its leave", async () => {
    const { made, seen } = await started();
    made[0]!.events.joined(STRANGER);
    made[0]!.events.interviewed(STRANGER, "started");
    made[0]!.events.interviewed(STRANGER, "failed");
    made[0]!.events.interviewed(STRANGER, "successful");
    made[0]!.events.left(STRANGER);
    expect(of(seen, "admitted", "interviewed", "left")).toEqual([["admitted", STRANGER, "association"], ["interviewed", STRANGER],
      ["left", STRANGER]]);
  });

  it("reports, as it starts, hardware the store keeps that herdsman no longer has as left: a leave the store missed", async () => {
    const { seen } = await started({ kept: [SENSOR, PUSHER], prepare: (s) => { s.had.add(SENSOR); } });
    expect(of(seen, "left")).toEqual([["left", PUSHER]]);
  });

  it("reports, after a rebuild, a device that left while the link was down", async () => {
    const { clock, made, seen } = await started({ kept: [SENSOR], prepare: (s, n) => { if (n === 0) s.had.add(SENSOR); } });
    made[0]!.events.joined(PUSHER);
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(EXCHANGE_MS);
    expect(made).toHaveLength(2);
    expect(of(seen, "left")).toEqual([["left", SENSOR], ["left", PUSHER]]);
  });

  it("hears no admission or leave from an old controller", async () => {
    const { clock, made, seen } = await started();
    made[0]!.events.disconnected();
    await settle();
    await clock.advance(EXCHANGE_MS);
    made[0]!.events.joined(STRANGER);
    made[0]!.events.left(SENSOR);
    expect(of(seen, "admitted", "left")).toEqual([]);
  });
});

describe("HerdsmanDoer: its own coordinator backup (plan 2c-3)", () => {
  const backups = (made: FakeStack[]) => made.flatMap((m) => m.calls).filter((c) => c === "backup").length;

  it("takes a backup after a successful exchange when the file is a day old or missing, and none while it is fresh", async () => {
    let takenAt: number | undefined;
    const { clock, made } = await started({ backupTakenAt: async () => takenAt });
    // Missing: taken after the first exchange.
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup"]);
    takenAt = clock.now();
    await clock.advance(BACKUP_RETRY_MS);
    await settle();
    expect(backups(made)).toBe(1);
    // A day old: taken at the next exchange.
    takenAt = clock.now() - BACKUP_AGE_MS;
    await clock.advance(EXCHANGE_MS);
    await settle();
    expect(backups(made)).toBe(2);
  });

  it("takes none after a failed exchange, and none while the controller is down", async () => {
    const { made } = await started({ backupTakenAt: async () => undefined, prepare: (s) => { s.pings = [false]; } });
    expect(backups(made)).toBe(0);
  });

  it("tries one at most every BACKUP_RETRY_MS, gives up waiting on one after BACKUP_MS, and says so", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let finish!: (ok: boolean) => void;
    const { clock, doer, made } = await started({ backupTakenAt: async () => undefined,
      prepare: (s) => { s.backupResult = new Promise((r) => { finish = r; }); } });
    expect(backups(made)).toBe(1);
    await clock.advance(BACKUP_MS);
    await settle();
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain("herdsman: the coordinator's backup was not refreshed; tried again within the hour");
    // herdsman's backup ends, failed, after the doer stopped waiting on it.
    finish(false);
    await settle();
    await clock.advance(BACKUP_RETRY_MS - BACKUP_MS - 1);
    await settle();
    expect(backups(made)).toBe(1);
    made[0]!.backupResult = new Promise(() => {});
    await clock.advance(EXCHANGE_MS);
    await settle();
    expect(backups(made)).toBe(2);
    // The stop waits for the one under way, as long as BACKUP_MS.
    const stopping = doer.stop();
    await settle();
    await clock.advance(BACKUP_MS);
    await stopping;
    expect(backups(made)).toBe(2);
    errors.mockRestore();
  });

  it("starts no second backup while herdsman's last is still under way, though the doer gave up waiting on it (plan 2c-3 review M1)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { clock, doer, made } = await started({ backupTakenAt: async () => undefined,
      prepare: (s) => { s.backupResult = new Promise(() => {}); } });
    expect(backups(made)).toBe(1);
    await clock.advance(BACKUP_MS);
    await settle();
    // Past the retry interval, herdsman's backup still runs: no second beside it.
    await clock.advance(BACKUP_RETRY_MS);
    await settle();
    expect(backups(made)).toBe(1);
    // Nor at the stop, which waits on the one under way.
    const stopping = doer.stop();
    await settle();
    await clock.advance(BACKUP_MS);
    await stopping;
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup", "close"]);
    errors.mockRestore();
  });

  it("takes the stop's backup from the current controller, not a dropped one's still under way (plan 2c-3 review M1)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let fresh = false;
    const { clock, doer, made } = await started({ backupTakenAt: async (c) => (fresh ? c.now() : undefined),
      prepare: (s, n) => { if (n === 0) { s.backupResult = new Promise(() => {}); s.pings = [true, false]; } } });
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup"]);
    fresh = true;
    // The next exchange fails: the controller is dropped and, after the backoff, built again.
    for (let i = 0; i < 4 && made.length < 2; i++) { await clock.advance(EXCHANGE_MS); await settle(); }
    expect(made.length).toBe(2);
    expect(made[1]!.started).toBe(true);
    const stopping = doer.stop();
    await settle();
    await clock.advance(BACKUP_MS);
    await stopping;
    const said = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();
    expect({ current: made[1]!.calls, said: said.filter((l) => l.includes("not refreshed at the stop")) })
      .toEqual({ current: ["start", "backup", "close"], said: [] });
  });

  it("takes no backup on a controller dropped while the backup's age was read (plan 2c-3 review M5)", async () => {
    let age!: (at: number | undefined) => void;
    const { clock, made } = await started({ backupTakenAt: () => new Promise((r) => { age = r; }) });
    expect(made[0]!.calls).toEqual(["start", START_CLOSE]);
    made[0]!.events.disconnected();
    await settle();
    expect(made[0]!.closed).toBe(1);
    age(undefined);
    await settle();
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "close"]);
    void clock;
  });

  it("waits at a stop for its own backup under way, taking no second", async () => {
    let finish!: (ok: boolean) => void;
    const { doer, made } = await started({ backupTakenAt: async () => undefined,
      prepare: (s) => { s.backupResult = new Promise((r) => { finish = r; }); } });
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup"]);
    const stopping = doer.stop();
    await settle();
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup"]);
    finish(true);
    await stopping;
    expect(made[0]!.calls).toEqual(["start", START_CLOSE, "backup", "close"]);
  });

  it("raises BACKUP_MS above the 9.3 s the bench's backup took, and keeps the exchange's own deadline below it", () => {
    expect(BACKUP_MS).toBeGreaterThanOrEqual(3 * 9_300);
    expect(PING_MS).toBeLessThan(BACKUP_MS);
  });
});
