import type { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import type { Endpoint } from "zigbee-herdsman/dist/controller/model/endpoint.js";
import type { DoerEvents } from "../src/port.js";
import type { Prediction } from "../src/herdsman/network-guard.js";
import type { Network } from "../src/herdsman/network.js";
import type { Stack, StackEvents, StackOptions } from "../src/herdsman/stack.js";

/** A made-up network: no bench's. */
export const NETWORK: Network = {
  panID: 0x1a2b, extendedPanID: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], channel: 15,
  networkKey: [0x3a, 0x91, 0x07, 0xc4, 0x5e, 0x22, 0xf0, 0x18, 0x6b, 0xd9, 0x40, 0xa7, 0x13, 0x8e, 0x55, 0xec],
  coordinator: "0x00124b0012345678",
};
/** What the guard reads from a coordinator that holds the owner's network. */
export const RESUMES: Prediction = { strategy: "startup", channel: 15, coordinator: NETWORK.coordinator };

/** A herdsman stack in memory: its start's result, its answers to the health exchange, its database, and every close. */
export class FakeStack implements Stack {
  /** What `start` resolves; a promise holds it, as a start under way. */
  result: string | Promise<string> = "resumed";
  /** The answers to the health exchange, in order (a promise is one under way); true once they run out. */
  pings: (boolean | Promise<boolean>)[] = [];
  /** herdsman's database: the devices it has. */
  readonly had = new Set<string>();
  started = false;
  /** herdsman's database is open: from the first line of its start until the close. */
  opened = false;
  closed = 0;

  constructor(readonly options: StackOptions, readonly events: StackEvents) {}

  /** What the stack was asked, in order: `start`, `backup`, `permitJoin <seconds>[ <near>]`, `close`. */
  readonly calls: string[] = [];
  /** What `backup` resolves; a promise that never settles is a backup that does not answer. */
  backupResult: boolean | Promise<boolean> = true;
  /** Runs inside the start, its database open, before the start resolves: a device rejoining then. */
  midStart?: () => Promise<void>;
  /** herdsman's models of the devices it has, for their converters. */
  lookup?: (ieee: string) => Device | undefined;
  /** The coordinator's endpoint in herdsman's model, once started. */
  coordinator?: () => Endpoint | undefined;

  async start(): Promise<string> {
    this.calls.push("start");
    this.opened = true;
    await this.midStart?.();
    const r = await this.result;
    this.started = true;
    return r;
  }

  async ping(): Promise<boolean> {
    return await (this.pings.shift() ?? true);
  }

  async backup(): Promise<boolean> {
    this.calls.push("backup");
    return await this.backupResult;
  }

  /** What `permitJoin` does, after it is recorded in `calls` as `permitJoin <seconds>[ <near>]`: resolves unless set. */
  permitResult: () => Promise<void> = async () => {};

  async permitJoin(seconds: number, near?: string): Promise<void> {
    this.calls.push(`permitJoin ${seconds}${near !== undefined ? ` ${near}` : ""}`);
    await this.permitResult();
  }

  async close(): Promise<void> {
    this.calls.push("close");
    this.closed += 1;
    this.started = false;
    this.opened = false;
  }

  /** As herdsman's: its database is read from the moment its start opens it. */
  has(ieee: string): boolean {
    return this.opened && this.had.has(ieee);
  }

  devices(): string[] {
    return this.started ? [...this.had] : [];
  }

  device(ieee: string): Device | undefined {
    return this.has(ieee) ? this.lookup?.(ieee) : undefined;
  }

  coordinatorEndpoint(): Endpoint | undefined {
    return this.started ? this.coordinator?.() : undefined;
  }
}

/** Every stack the doer made, in order, each made as `prepare` sets it up. */
export function stacks(prepare: (s: FakeStack, n: number) => void = () => {}) {
  const made: FakeStack[] = [];
  const make = (o: StackOptions, events: StackEvents) => {
    const s = new FakeStack(o, events);
    prepare(s, made.length);
    made.push(s);
    return s;
  };
  return { made, make };
}

/** The core as the doer sees it: every event, as one line each; `mayAdmit` answers as `refuse` says. */
export function core(refuse: (hw: string) => boolean = () => false): { events: DoerEvents; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const on = (name: string) => (...args: unknown[]) => { seen.push([name, ...args]); };
  const events: DoerEvents = {
    described: on("described"), observed: on("observed"), occurred: on("occurred"), undescribed: on("undescribed"),
    admitted: on("admitted"), interviewed: on("interviewed"), left: on("left"), transport: on("transport"), fault: on("fault"),
    ungoverned: on("ungoverned"),
    mayAdmit: (hw) => {
      seen.push(["mayAdmit", hw]);
      return !refuse(hw);
    },
  };
  return { events, seen };
}
