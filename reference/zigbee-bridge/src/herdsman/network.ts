import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The network the owner formed (the design, *The network guard*): the bridge's private
 * `network.json`, written by `zigbee-bridge form` and never by the bridge itself. It holds the
 * network key in clear, so it is readable by its owner alone, and nothing read from it is ever
 * quoted in a fault or a log.
 */
export interface Network {
  panID: number;
  extendedPanID: number[];
  /** The one channel the network was formed on (11 to 26). */
  channel: number;
  networkKey: number[];
  /** The coordinator's IEEE address when the network was formed: another coordinator is a mismatch (GA-BRIDGE-12). */
  coordinator: string;
}

/** The file, in the bridge's private data directory beside herdsman's own files. */
export const NETWORK_FILE = "network.json";

/** herdsman's default network key, which everyone knows: never a formed network's (GA-BRIDGE-24). */
const WELL_KNOWN_KEY = [0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0d];
/** herdsman's default extended PAN id. */
const DEFAULT_EXTENDED_PAN_ID = [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd];
/** herdsman's default PAN id, a well-known default like its extended one (GA-BRIDGE-24). */
const DEFAULT_PAN_ID = 0x1a62;

/** What reading the file found: the network, or the fault the bridge shows (`no_network`, `invalid_network`). */
export type NetworkRead = { network: Network } | { fault: "no_network" | "invalid_network"; detail: string };

const bytes = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** What is wrong with the file's content, never quoting it; undefined when nothing is. */
export function networkProblem(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "it is no object";
  const n = v as Record<string, unknown>;
  if (!Number.isInteger(n.panID) || (n.panID as number) < 1 || (n.panID as number) > 0xfffe) return "panID is not 1 to 65534";
  if (!bytes(n.extendedPanID, 8)) return "extendedPanID is not 8 bytes";
  if (n.panID === DEFAULT_PAN_ID) return "panID is herdsman's default";
  if (same(n.extendedPanID, DEFAULT_EXTENDED_PAN_ID)) return "extendedPanID is herdsman's default";
  if (!Number.isInteger(n.channel) || (n.channel as number) < 11 || (n.channel as number) > 26) return "channel is not 11 to 26";
  if (!bytes(n.networkKey, 16)) return "networkKey is not 16 bytes";
  if (same(n.networkKey, WELL_KNOWN_KEY)) return "networkKey is the key everyone knows";
  if (typeof n.coordinator !== "string" || !/^0x[0-9a-f]{16}$/.test(n.coordinator)) return "coordinator is no IEEE address";
  return undefined;
}

/** Reads the owner's network from the data directory: a missing file is `no_network`, never a reason to form one. */
export async function readNetwork(dir: string): Promise<NetworkRead> {
  const path = join(dir, NETWORK_FILE);
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { fault: "no_network", detail: "no network.json: the owner forms the network (zigbee-bridge form)" };
    }
    return { fault: "invalid_network", detail: `network.json cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (mode & 0o077) return { fault: "invalid_network", detail: "network.json can be read by other accounts: it holds the network key" };
  let v: unknown;
  try {
    v = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    // The parser's message may quote the text, the key among it: only its kind is said.
    const code = (err as NodeJS.ErrnoException).code;
    return { fault: "invalid_network", detail: code ? `network.json cannot be read (${code})` : "network.json is no JSON" };
  }
  const wrong = networkProblem(v);
  if (wrong) return { fault: "invalid_network", detail: `network.json: ${wrong}` };
  const n = v as Network;
  return { network: { panID: n.panID, extendedPanID: [...n.extendedPanID], channel: n.channel, networkKey: [...n.networkKey],
    coordinator: n.coordinator } };
}

/** herdsman's `network` options for the network: the key never distributed in clear (`networkKeyDistribute`). */
export function herdsmanNetwork(n: Network): { panID: number; extendedPanID: number[]; channelList: number[]; networkKey: number[];
  networkKeyDistribute: boolean } {
  return { panID: n.panID, extendedPanID: [...n.extendedPanID], channelList: [n.channel], networkKey: [...n.networkKey],
    networkKeyDistribute: false };
}

/**
 * A new network on `channel` (the design, *The network guard*: forming is an owner act): a fresh
 * 16-byte network key, a PAN id of 1 to 65534 and an extended PAN id, each drawn from `random` until it
 * is none herdsman uses by default nor the key everyone knows (GA-BRIDGE-24). Its coordinator is not
 * known until herdsman formed it.
 */
export function newNetwork(channel: number, random: (n: number) => Buffer = randomBytes): Omit<Network, "coordinator"> {
  const draw = (n: number, ok: (b: number[]) => boolean): number[] => {
    for (;;) {
      const b = [...random(n)];
      if (b.length === n && ok(b)) return b;
    }
  };
  const pan = draw(2, (b) => { const v = (b[0]! << 8) | b[1]!; return v >= 1 && v <= 0xfffe && v !== DEFAULT_PAN_ID; });
  return {
    panID: (pan[0]! << 8) | pan[1]!,
    extendedPanID: draw(8, (b) => !same(b, DEFAULT_EXTENDED_PAN_ID) && b.some((x) => x !== 0)),
    channel,
    networkKey: draw(16, (b) => !same(b, WELL_KNOWN_KEY) && b.some((x) => x !== 0)),
  };
}

/**
 * Writes the owner's network to the data directory, readable by its owner alone, and never over one
 * there already: the file of a network formed before is never lost to a second form. The network the
 * coordinator holds is `form`'s to keep (`cli.ts`), which reads the coordinator first.
 */
export async function writeNetwork(dir: string, network: Network): Promise<void> {
  const wrong = networkProblem(network);
  if (wrong) throw new Error(`the network to write is wrong: ${wrong}`);
  await writeFile(join(dir, NETWORK_FILE), `${JSON.stringify(network, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}
