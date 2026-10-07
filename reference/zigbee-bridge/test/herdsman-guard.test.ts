import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZnpAdapterManager } from "zigbee-herdsman/dist/adapter/z-stack/adapter/manager.js";
import { NvItemsIds } from "zigbee-herdsman/dist/adapter/z-stack/constants/common.js";
import * as Structs from "zigbee-herdsman/dist/adapter/z-stack/structs/index.js";
import { Znp } from "zigbee-herdsman/dist/adapter/z-stack/znp/index.js";
import { BackupUnreadable, predict, startRefusal, type Prediction } from "../src/herdsman/network-guard.js";
import type { Network } from "../src/herdsman/network.js";

/** A made-up network: no bench's. */
const NETWORK: Network = {
  panID: 0x1a2b, extendedPanID: [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], channel: 15,
  networkKey: [0x3a, 0x91, 0x07, 0xc4, 0x5e, 0x22, 0xf0, 0x18, 0x6b, 0xd9, 0x40, 0xa7, 0x13, 0x8e, 0x55, 0xec],
  coordinator: "0x00124b0012345678",
};
const RESUMES: Prediction = { strategy: "startup", channel: 15, coordinator: "0x00124b0012345678" };

describe("startRefusal", () => {
  it("lets herdsman start only to resume the network on its channel, on its coordinator", () => {
    expect(startRefusal(RESUMES, NETWORK)).toBeUndefined();
    expect(startRefusal({ ...RESUMES, coordinator: "0x00124B0012345678" }, NETWORK)).toBeUndefined();
  });

  it.each([
    [{ coordinator: "0x00124b0087654321" }, "another coordinator answers than the one the network was formed on"],
    [{ coordinator: "0x00124b0087654321", strategy: "startCommissioning" },
      "another coordinator answers than the one the network was formed on"],
    [{ channel: 25 }, "the coordinator's network is on another channel than network.json: herdsman would move it"],
    [{ strategy: "restoreBackup" }, "herdsman would restore the coordinator from its backup, which forms a network first"],
    [{ strategy: "startCommissioning", channel: null }, "herdsman would form a new network: the coordinator holds another network, or none"],
    [{ strategy: "refused" }, "the coordinator holds another network than network.json"],
  ] as [Partial<Prediction>, string][])("refuses %j", (over, why) => {
    expect(startRefusal({ ...RESUMES, ...over }, NETWORK)).toBe(why);
  });
});

describe("predict", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  });

  /** A coordinator's TCP port that accepts and never answers, as one another client holds may. */
  async function silent(): Promise<{ path: string; sockets: Socket[]; closed: Socket[] }> {
    const sockets: Socket[] = [];
    const closed: Socket[] = [];
    const server = createServer((s) => {
      sockets.push(s);
      s.on("error", () => {});
      s.on("close", () => closed.push(s));
      s.resume();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as { port: number };
    return { path: `tcp://127.0.0.1:${port}`, sockets, closed };
  }

  it("throws when the coordinator does not answer in time, a failed try and no mismatch, and closes its connection", async () => {
    const { path, sockets, closed } = await silent();
    await expect(predict(path, NETWORK, "/nonexistent/backup.json", 500)).rejects.toThrow(/not read within 500 ms/);
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets).toHaveLength(1);
    expect(closed).toEqual(sockets);
  });

  it("refuses a backup herdsman cannot take, of any shape, before it opens the coordinator, quoting nothing of it (re-review N3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zigbee-guard-"));
    const shapes = {
      truncated: '{"metadata": {"format": "zigpy/open-coordinator-backup", "version": 1}, "network_key": {"key": "3a91',
      "unified, fields missing": JSON.stringify({ metadata: { format: "zigpy/open-coordinator-backup", version: 1 } }),
      "unified, devices not a list": JSON.stringify({ metadata: { format: "zigpy/open-coordinator-backup", version: 1 },
        coordinator_ieee: "00124b0012345678", pan_id: "1a2b", extended_pan_id: "123456789abcdef0", nwk_update_id: 0,
        security_level: 5, channel: 15, channel_mask: [15], network_key: { key: "3a91075c02e74418bd600f9e732ac581", sequence_number: 0,
          frame_counter: 0 }, devices: {} }),
      "version 2": JSON.stringify({ metadata: { format: "zigpy/open-coordinator-backup", version: 2 } }),
      "unknown format": "{}",
    };
    try {
      for (const [name, text] of Object.entries(shapes)) {
        const { path, sockets } = await silent();
        await writeFile(join(dir, "backup.json"), text);
        const err = await predict(path, NETWORK, join(dir, "backup.json"), 2_000).then(() => undefined, (e: unknown) => e);
        expect(err, name).toBeInstanceOf(BackupUnreadable);
        expect(String((err as Error).message), name).not.toContain("3a91");
        expect(sockets, name).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when nothing listens", async () => {
    const { path } = await silent();
    await new Promise((r) => servers.pop()!.close(r));
    await expect(predict(path, NETWORK, "/nonexistent/backup.json", 5_000)).rejects.toThrow();
  });

  it("reads through the parts of herdsman 10.10.0 its own start uses", () => {
    const manager = ZnpAdapterManager.prototype as unknown as Record<string, unknown>;
    expect(typeof manager.determineStrategy).toBe("function");
    expect(typeof manager.parseConfigNetworkOptions).toBe("function");
    expect(typeof Znp.prototype.open).toBe("function");
    expect(typeof Znp.prototype.requestWithReply).toBe("function");
    expect(NvItemsIds.NIB).toBe(33);
    expect(typeof Structs.nib).toBe("function");
  });
});
