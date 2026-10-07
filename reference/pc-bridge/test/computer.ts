import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { COMPUTER, PcBridge, type PcBridgeOptions } from "../src/bridge.js";
import { StateStore } from "../src/state-store.js";
import { FakeClock, FakePort, FakeWire, settle } from "./fakes.js";

/** What the tests of the computer's people share: a bridge on fakes, its topics, and readers of what it published. */
export const ROOT = "home";
export const BASE = `${ROOT}/bridges/desk-pc`;
export const COMMAND = `${BASE}/devices/${COMPUTER}/command`;
export const ACK = `${BASE}/devices/${COMPUTER}/ack`;
export const CSTATUS = `${BASE}/devices/${COMPUTER}/status`;

let dir: string;
const bridges: PcBridge[] = [];

/** Registers the file's hooks: a fresh state directory for each test, and every bridge it started stopped after it. */
export function useBridges(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-bridge-people-"));
  });
  afterEach(async () => {
    for (const b of bridges.splice(0)) await b.stop();
    rmSync(dir, { recursive: true, force: true });
  });
}

export function stateDir(): string {
  return dir;
}

type Extra = Partial<PcBridgeOptions> & { before?: (port: FakePort, wire: FakeWire) => void; port?: FakePort };

/** A bridge on fakes, not yet waited for: `started` settles when its start does. */
export function starting(extra: Extra = {}) {
  const clock = (extra.clock as FakeClock | undefined) ?? new FakeClock();
  const wire = new FakeWire();
  const port = extra.port ?? new FakePort();
  port.pluginsPath ??= join(dir, "plugins");
  extra.before?.(port, wire);
  const store = extra.store ?? StateStore.load(dir);
  const b = new PcBridge({ bridgeId: "desk-pc", instanceId: extra.instanceId ?? randomUUID(), root: ROOT, clock, port, wire, store,
    ...(extra.brokerHost !== undefined ? { brokerHost: extra.brokerHost } : {}), ...(extra.runId ? { runId: extra.runId } : {}) });
  bridges.push(b);
  return { b, clock, wire, port, store, started: b.start() };
}

export async function bridge(extra: Extra = {}) {
  const { started, ...r } = starting(extra);
  await started;
  return r;
}

/** A state store whose saves fail while `broken` is set, as on a full disk. */
export function breakable(): { store: StateStore; set(broken: boolean): void } {
  const store = StateStore.load(dir);
  const save = store.save.bind(store);
  let broken = true;
  store.save = () => (broken ? Promise.reject(new Error("ENOSPC: no space left on device")) : save());
  return { store, set: (b) => { broken = b; } };
}

/** Takes a bridge out of the afterEach list, for a test that stops it itself. */
export function own(b: PcBridge): void {
  bridges.splice(bridges.indexOf(b), 1);
}

export const command = (value: Record<string, unknown>) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 10_000, value,
});
export const computer = (wire: FakeWire) => wire.last(`${BASE}/devices`)!.payload.devices[0];
export const cstatus = (wire: FakeWire) => wire.last(CSTATUS)!.payload;
export const faults = (wire: FakeWire) => wire.last(`${BASE}/status`)!.payload.faults;
export const ack = (wire: FakeWire) => wire.last(ACK)!.payload;
export const at = (clock: FakeClock) => new Date(clock.now()).toISOString();

/** The OS reports a change that gives or retires a token: the bridge writes it to disk, a real write, before `devices`. */
export async function changedOnDisk(port: FakePort, store: StateStore): Promise<void> {
  await port.changed();
  await store.flush();
  await settle();
}

/** Two people: liza at the console, and an account whose name fails the token rule. */
export function people(port: FakePort): void {
  port.listed = [{ osId: 1000, name: "liza", primaryGid: 1000 }, { osId: 1001, name: "John.Doe", primaryGid: 1001 }];
}
