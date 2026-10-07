import { AdapterBackup } from "zigbee-herdsman/dist/adapter/z-stack/adapter/adapter-backup.js";
import { ZnpAdapterManager } from "zigbee-herdsman/dist/adapter/z-stack/adapter/manager.js";
import { NvItemsIds } from "zigbee-herdsman/dist/adapter/z-stack/constants/common.js";
import * as Structs from "zigbee-herdsman/dist/adapter/z-stack/structs/index.js";
import { Subsystem } from "zigbee-herdsman/dist/adapter/z-stack/unpi/constants.js";
import { Znp } from "zigbee-herdsman/dist/adapter/z-stack/znp/index.js";
import { herdsmanNetwork, type Network } from "./network.js";

/**
 * The network guard (the design, *The network guard*; spike S4). herdsman's start decides, inside
 * `Controller.start()`, whether to resume the coordinator's network, restore it from a backup, or
 * form a new one, and a restore and a form both commission a network first. So the guard asks
 * before herdsman starts: it reads the coordinator through herdsman's own Z-Stack classes (a ping,
 * the version, the device's own information and NV reads, nothing written) and runs herdsman's own
 * decision on the owner's network and the backup. herdsman is started only when it would resume
 * that network, on its channel, on the coordinator it was formed on (GA-BRIDGE-12).
 */

/** herdsman's start strategy, as its Z-Stack manager names it, or `refused` where it would throw. */
export type Strategy = "startup" | "restoreBackup" | "startCommissioning" | "refused";

/** What herdsman would do at its start, read from the coordinator before it is called. */
export interface Prediction {
  strategy: Strategy;
  /** The channel of the coordinator's network, or null when it holds none. */
  channel: number | null;
  /** The coordinator's IEEE address, as it answers now. */
  coordinator: string;
}

/**
 * Why herdsman may not be started, as the `state_mismatch` fault says it, or undefined when it would
 * only resume the owner's network on its channel. The coordinator is compared first: another
 * coordinator is a mismatch whatever its network.
 */
export function startRefusal(p: Prediction, n: Network): string | undefined {
  if (p.coordinator.toLowerCase() !== n.coordinator) return "another coordinator answers than the one the network was formed on";
  switch (p.strategy) {
    case "startup":
      return p.channel === n.channel ? undefined
        : "the coordinator's network is on another channel than network.json: herdsman would move it";
    case "restoreBackup":
      return "herdsman would restore the coordinator from its backup, which forms a network first";
    case "startCommissioning":
      return "herdsman would form a new network: the coordinator holds another network, or none";
    case "refused":
      return "the coordinator holds another network than network.json";
  }
}

/** herdsman's own refusals in its start's decision: a configuration the coordinator and backup disagree with, a backup too new. */
const REFUSALS = /configuration-adapter mismatch|cannot be restored/;

/**
 * herdsman's backup file is there but herdsman cannot take it (damaged, a shape or version it does not
 * read): every start would fail on it until the owner mends it. Its message is fixed, since herdsman's
 * can quote the file, the key among it.
 */
export class BackupUnreadable extends Error {
  constructor() {
    super("the coordinator's backup file is damaged, or of a format herdsman does not read");
    this.name = "BackupUnreadable";
  }
}

/**
 * Reads the backup file as herdsman's start does (`AdapterBackup.getStoredBackup`, the file alone: no
 * coordinator), so that any shape it cannot take is found, whatever herdsman's error (re-review N3).
 */
function checkBackup(backupPath: string): void {
  try {
    new AdapterBackup(undefined as never, undefined as never, backupPath).getStoredBackup();
  } catch {
    throw new BackupUnreadable();
  }
}

/** How long the reading may take, the TCP connection included, before the try counts as failed. */
export const PREDICT_MS = 20_000;

/** The manager's parts the prediction uses: private in herdsman's types, the same code its start runs. */
interface ManagerInternals {
  nv: { init(): Promise<void>; readItem(id: number, offset: number, struct: typeof Structs.nib): Promise<{ nwkLogicalChannel: number } | null> };
  nwkOptions: unknown;
  parseConfigNetworkOptions(o: ReturnType<typeof herdsmanNetwork>): Promise<unknown>;
  determineStrategy(): Promise<Exclude<Strategy, "refused">>;
}

/**
 * Reads what herdsman would do at its start on the coordinator at `path` (`tcp://host:port`), with
 * the owner's network and herdsman's backup file. A throw means the coordinator was not read (it
 * did not answer, or another client holds it): a failed try, not a mismatch, but `BackupUnreadable`
 * for a backup file herdsman cannot take, found before the coordinator is opened. herdsman's own
 * decision refusing is `refused`.
 */
export async function predict(path: string, n: Network, backupPath: string, ms = PREDICT_MS): Promise<Prediction> {
  checkBackup(backupPath);
  const znp = new Znp(path, 115200, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the coordinator was not read within ${ms} ms`)), ms);
  });
  const reading = read(znp, n, backupPath);
  // Too late, its failure (the connection closed under it) is no one's to handle.
  reading.catch(() => {});
  try {
    return await Promise.race([reading, late]);
  } finally {
    clearTimeout(timer);
    await znp.close().catch(() => {});
    // herdsman's close leaves the socket open while its own open is still under way: the coordinator
    // takes one client at a time, so the socket is destroyed here, whatever the open reached.
    (znp as unknown as { socketPort?: { destroy(): void } }).socketPort?.destroy();
  }
}

async function read(znp: Znp, n: Network, backupPath: string): Promise<Prediction> {
  await znp.open();
  const version = (await znp.requestWithReply(Subsystem.SYS, "version", {})).payload as { product: number };
  const info = (await znp.requestWithReply(Subsystem.UTIL, "getDeviceInfo", {})).payload as { ieeeaddr: string };
  const network = herdsmanNetwork(n);
  // The manager is herdsman's own; the adapter it is given is used only by a start, never here.
  const manager = new ZnpAdapterManager({} as never, znp, { backupPath, version: version.product, greenPowerGroup: 0x0b84,
    networkOptions: network, adapterOptions: { disableLED: false } }) as unknown as ManagerInternals;
  manager.nwkOptions = await manager.parseConfigNetworkOptions(network);
  await manager.nv.init();
  const nib = await manager.nv.readItem(NvItemsIds.NIB, 0, Structs.nib);
  let strategy: Strategy;
  try {
    strategy = await manager.determineStrategy();
  } catch (err) {
    // herdsman refuses a network that matches its backup but not the configuration; any other throw
    // is the reading failing (the connection lost under it), not a mismatch.
    if (!REFUSALS.test(String((err as Error)?.message ?? err))) throw err;
    strategy = "refused";
  }
  return { strategy, channel: nib ? nib.nwkLogicalChannel : null, coordinator: info.ieeeaddr };
}
