import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { herdsmanNetwork, NETWORK_FILE, networkProblem, readNetwork, type Network } from "../src/herdsman/network.js";

/** A made-up network: no bench's. */
const NETWORK: Network = {
  panID: 0x1a2b, extendedPanID: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], channel: 15,
  networkKey: [0x3a, 0x91, 0x07, 0xc4, 0x5e, 0x22, 0xf0, 0x18, 0x6b, 0xd9, 0x40, 0xa7, 0x13, 0x8e, 0x55, 0xec],
  coordinator: "0x00124b0012345678",
};

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function dir(content?: string, mode = 0o600): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "zigbee-network-"));
  dirs.push(d);
  if (content !== undefined) {
    await writeFile(join(d, NETWORK_FILE), content);
    await chmod(join(d, NETWORK_FILE), mode);
  }
  return d;
}

describe("readNetwork", () => {
  it("reads the owner's network", async () => {
    expect(await readNetwork(await dir(JSON.stringify(NETWORK)))).toEqual({ network: NETWORK });
  });

  it("is no_network when the file is missing: the bridge never forms one", async () => {
    expect(await readNetwork(await dir())).toEqual({ fault: "no_network",
      detail: "no network.json: the owner forms the network (zigbee-bridge form)" });
  });

  it("refuses a file other accounts can read", async () => {
    expect(await readNetwork(await dir(JSON.stringify(NETWORK), 0o640))).toEqual({ fault: "invalid_network",
      detail: "network.json can be read by other accounts: it holds the network key" });
  });

  it("refuses a file that is no JSON without quoting it", async () => {
    const text = `{"networkKey": [${NETWORK.networkKey.join(",")}`;
    const read = await readNetwork(await dir(text));
    expect(read).toEqual({ fault: "invalid_network", detail: "network.json is no JSON" });
  });

  it("never quotes the key in a fault", async () => {
    const read = await readNetwork(await dir(JSON.stringify({ ...NETWORK, coordinator: NETWORK.networkKey })));
    expect(read).toEqual({ fault: "invalid_network", detail: "network.json: coordinator is no IEEE address" });
    expect(JSON.stringify(read)).not.toContain(NETWORK.networkKey.join(","));
  });
});

describe("networkProblem", () => {
  it.each([
    [{ panID: 0 }, "panID is not 1 to 65534"],
    [{ panID: 0xffff }, "panID is not 1 to 65534"],
    [{ panID: 0x1a62 }, "panID is herdsman's default"],
    [{ extendedPanID: [1, 2, 3] }, "extendedPanID is not 8 bytes"],
    [{ extendedPanID: [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd] }, "extendedPanID is herdsman's default"],
    [{ channel: 10 }, "channel is not 11 to 26"],
    [{ channel: 27 }, "channel is not 11 to 26"],
    [{ networkKey: [...NETWORK.networkKey.slice(0, 15), 256] }, "networkKey is not 16 bytes"],
    [{ networkKey: [0x01, 0x03, 0x05, 0x07, 0x09, 0x0b, 0x0d, 0x0f, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0a, 0x0c, 0x0d] },
      "networkKey is the key everyone knows"],
    [{ coordinator: "0x00124B0012345678" }, "coordinator is no IEEE address"],
  ])("refuses %j", (over, why) => {
    expect(networkProblem({ ...NETWORK, ...over })).toBe(why);
  });

  it("takes a network that is whole", () => {
    expect(networkProblem(NETWORK)).toBeUndefined();
  });
});

describe("herdsmanNetwork", () => {
  it("gives herdsman the one channel and never distributes the key in clear", () => {
    expect(herdsmanNetwork(NETWORK)).toEqual({ panID: NETWORK.panID, extendedPanID: NETWORK.extendedPanID, channelList: [15],
      networkKey: NETWORK.networkKey, networkKeyDistribute: false });
  });
});
