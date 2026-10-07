import { join } from "node:path";
import { Controller, Zdo } from "zigbee-herdsman";
import { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import type { Endpoint } from "zigbee-herdsman/dist/controller/model/endpoint.js";
import { Group } from "zigbee-herdsman/dist/controller/model/group.js";
import { redact } from "./log.js";
import { herdsmanNetwork, type Network } from "./network.js";
import type { Message } from "./pipeline.js";

/**
 * The stack below the herdsman doer: one herdsman `Controller` and what the doer needs of it. A seam,
 * so that the doer's controller life, link and joins are tested without a coordinator.
 */

/** How far herdsman's interview of a device got, as herdsman says it. */
export type Interview = "started" | "successful" | "failed";

/** What the stack tells the doer. */
export interface StackEvents {
  /**
   * herdsman's trust-centre indication, before herdsman lets the hardware in, for every device that
   * comes in, known or not: true lets it in. False makes herdsman send it a Leave Request without
   * rejoin: a refusal is a removal (plan 2a's bench).
   */
  joining(ieee: string): Promise<boolean>;
  /**
   * herdsman let in a device it did not have, or had deleted on a leave: a new admission. It raises
   * nothing for hardware it has (spike S7): the doer's join handler reports that itself.
   */
  joined(ieee: string): void;
  /** herdsman's interview of a device: `started`, then `successful` or `failed`. */
  interviewed(ieee: string, status: Interview): void;
  /** herdsman deleted the device: it left, or was removed. */
  left(ieee: string): void;
  /** A message from the device: the coordinator is talking (GA-BRIDGE-23). */
  heard(ieee: string): void;
  /** The message itself, for the converter pipeline (plan 2c): after `heard`. */
  message?(m: Message): void;
  /** herdsman heard the device announce itself: its converters' `deviceAnnounce`. */
  announced?(ieee: string): void;
  /** herdsman lost its link to the coordinator; it never reconnects on its own. */
  disconnected(): void;
}

export interface Stack {
  /** Starts herdsman, resolving its start's result (`resumed`, `reset` or `restored`). Called once. */
  start(): Promise<string>;
  /** The health exchange: a ZDO Node Descriptor request to the coordinator itself (GA-BRIDGE-23); true on its answer within `ms`. */
  ping(ms: number): Promise<boolean>;
  /** Writes a fresh backup of the coordinator (NV reads over its link; no frame to the network): true when written. */
  backup(): Promise<boolean>;
  /**
   * herdsman's permit-join (plan 3b): `seconds` (1 to 254; 0 closes it, house-wide), broadcast, or at
   * the router `near` names, which herdsman must have as a router. Rejects as herdsman does, and
   * while the controller is not started.
   */
  permitJoin(seconds: number, near?: string): Promise<void>;
  /** Closes the stack without sending a frame, a start under way aborted; herdsman's caches are reset for the next stack. */
  close(): Promise<void>;
  /** Whether herdsman's database has the device now (deleted ones are not had). */
  has(ieee: string): boolean;
  /** Every device herdsman's database has, the coordinator left out. */
  devices(): string[];
  /** herdsman's own model of a device it has, for its converters; undefined once the stack closed. */
  device(ieee: string): Device | undefined;
  /** The coordinator's first endpoint in herdsman's model, the target of a `configure`'s binds; undefined until the start is done. */
  coordinatorEndpoint(): Endpoint | undefined;
}

export interface StackOptions {
  /** The coordinator, as herdsman's serial port path names it: `tcp://host:port`. */
  coordinator: string;
  /** The bridge's private data directory: herdsman's database and the coordinator's backup. */
  dataDir: string;
  network: Network;
}

export type MakeStack = (o: StackOptions, events: StackEvents) => Stack;

/** herdsman's own files in the data directory. */
export const DATABASE_FILE = "database.db";
export const BACKUP_FILE = "coordinator_backup.json";

/** The parts of herdsman's controller the quiet close reaches past its types. */
interface ControllerInternals {
  adapterDisconnected: boolean;
  /** Set by the first line of `start`, before its join handler is wired. */
  database?: unknown;
  /** herdsman's daily backup and five-minute database save, set at the end of `start`. */
  backupTimer?: ReturnType<typeof setInterval>;
  databaseSaveTimer?: ReturnType<typeof setInterval>;
  /** herdsman's own count of a permit it sent, which its quiet stop leaves running. */
  permitJoinTimer?: ReturnType<typeof setTimeout>;
  adapter?: { stop(): Promise<void>; znp?: { socketPort?: { destroy(): void } } };
}

/** The stack over herdsman 10.10.0's `Controller`. */
export class HerdsmanStack implements Stack {
  readonly controller: Controller;
  private started = false;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(private readonly o: StackOptions, events: StackEvents) {
    this.controller = new Controller({
      network: herdsmanNetwork(o.network),
      serialPort: { path: o.coordinator, adapter: "zstack" },
      databasePath: join(o.dataDir, DATABASE_FILE),
      databaseBackupPath: join(o.dataDir, `${DATABASE_FILE}.backup`),
      backupPath: join(o.dataDir, BACKUP_FILE),
      adapter: { disableLED: false },
      acceptJoiningDeviceHandler: (ieee) => events.joining(ieee),
    });
    this.controller.on("deviceJoined", ({ device }) => events.joined(device.ieeeAddr));
    this.controller.on("deviceInterview", ({ status, device }) => events.interviewed(device.ieeeAddr, status));
    this.controller.on("deviceLeave", ({ ieeeAddr }) => events.left(ieeeAddr));
    this.controller.on("message", (m) => {
      events.heard(m.device.ieeeAddr);
      events.message?.(m as unknown as Message);
    });
    this.controller.on("deviceAnnounce", ({ device }) => events.announced?.(device.ieeeAddr));
    this.controller.on("adapterDisconnected", () => events.disconnected());
  }

  /**
   * herdsman checks the abort only between its first steps: a start past them when the stack closes
   * finishes anyway, reloading herdsman's static caches from this controller's database and setting
   * its timers, whose database save would write that old snapshot over the next stack's file. Such a
   * start is undone as it ends (plan 2b re-review N6).
   */
  async start(): Promise<string> {
    try {
      const result = await this.controller.start(this.abort.signal);
      if (!this.closed) {
        this.started = true;
        // herdsman's daily backup timer runs from each start, so a controller rebuilt more often than
        // daily never takes one: the doer takes its own, by the file's age, and herdsman's is off (plan 2c-3).
        clearInterval((this.controller as unknown as ControllerInternals).backupTimer);
      }
      return result;
    } finally {
      if (this.closed) this.undoLateStart();
    }
  }

  private undoLateStart(): void {
    const c = this.controller as unknown as ControllerInternals;
    clearInterval(c.backupTimer);
    clearInterval(c.databaseSaveTimer);
    Device.resetCache();
    Group.resetCache();
  }

  async ping(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); });
    const asked = this.controller.sendRaw({ profileId: Zdo.ZDO_PROFILE_ID, clusterKey: Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
      ieeeAddress: this.o.network.coordinator, networkAddress: 0, zdoParams: [0] })
      .then((r) => Array.isArray(r) && r[0] === Zdo.Status.SUCCESS, () => false);
    try {
      return await Promise.race([asked, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async backup(): Promise<boolean> {
    try {
      await this.controller.backup();
      return true;
    } catch (err) {
      console.error(`herdsman: backup: ${redact(String((err as Error)?.message ?? err))}`);
      return false;
    }
  }

  /**
   * herdsman's `permitJoin`, given herdsman's own model of the router `near` names. herdsman sends the
   * permit (and Green Power's commissioning mode) to it alone, or broadcasts both without one; a
   * close (0) is always broadcast.
   */
  async permitJoin(seconds: number, near?: string): Promise<void> {
    if (!this.started || this.closed) throw new Error("no controller is started");
    let router: Device | undefined;
    if (near !== undefined) {
      router = this.device(near);
      if (router?.type !== "Router") throw new Error(`${near} is no router herdsman has`);
    }
    await this.controller.permitJoin(seconds, router);
  }

  /**
   * herdsman's own `stop()` sends a permit-join 0 broadcast, stops touchlink and reads a backup from
   * the coordinator, unless it believes the adapter disconnected: then it only saves its database
   * and resets its caches. The close makes it believe so, then closes the adapter's connection, so
   * no frame is sent (the bench is never written to; a half-open link would hang the stop). A start
   * under way is aborted at herdsman's next step.
   */
  async close(): Promise<void> {
    this.abort.abort();
    const c = this.controller as unknown as ControllerInternals;
    c.adapterDisconnected = true;
    try {
      await this.controller.stop();
    } catch (err) {
      // A start that never reached its adapter or database: nothing to save.
      console.error(`herdsman: stop: ${redact(String((err as Error)?.message ?? err))}`);
    }
    await c.adapter?.stop().catch((err) => console.error(`herdsman: closing the adapter: ${redact(String((err as Error)?.message ?? err))}`));
    // A close while herdsman's connection is still opening leaves its socket open (as the guard's):
    // the coordinator takes one client at a time.
    c.adapter?.znp?.socketPort?.destroy();
    // herdsman's count of a permit outlives its quiet stop: a closed controller raises nothing later.
    clearTimeout(c.permitJoinTimer);
    // herdsman keeps its devices in static caches: the next stack reads them again from the database.
    Device.resetCache();
    Group.resetCache();
    this.started = false;
    this.closed = true;
  }

  /**
   * From the moment herdsman's start opens its database, not only once the start is done: its join
   * handler is wired before the start resolves (after the adapter starts, before a first backup and
   * the coordinator's address), and a device it has that rejoins then must be known (plan 2b review I1).
   */
  has(ieee: string): boolean {
    if (this.closed || (this.controller as unknown as ControllerInternals).database === undefined) return false;
    return this.controller.getDeviceByIeeeAddr(ieee) !== undefined;
  }

  devices(): string[] {
    if (!this.started) return [];
    return this.controller.getDevices().filter((d) => d.type !== "Coordinator").map((d) => d.ieeeAddr);
  }

  device(ieee: string): Device | undefined {
    if (!this.has(ieee)) return undefined;
    return this.controller.getDeviceByIeeeAddr(ieee);
  }

  coordinatorEndpoint(): Endpoint | undefined {
    if (!this.started || this.closed) return undefined;
    return this.controller.getDevicesByType("Coordinator")[0]?.endpoints[0];
  }
}

export const herdsmanStack: MakeStack = (o, events) => new HerdsmanStack(o, events);
