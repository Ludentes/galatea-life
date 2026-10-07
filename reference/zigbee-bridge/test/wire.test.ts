import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { MqttWire, refusedFilters } from "../src/wire.js";

describe("refusedFilters", () => {
  it("names only the filters whose reason code is a refusal", () => {
    expect(refusedFilters(["a/+", "b/#"], [1, 0x87])).toEqual(["b/#"]);
  });

  it("names none when every filter was granted", () => {
    expect(refusedFilters(["a/+", "b/#"], [0, 1])).toEqual([]);
  });

  it("counts a filter the SUBACK gave no code for as refused", () => {
    expect(refusedFilters(["a/+", "b/#"], [1])).toEqual(["b/#"]);
  });
});

describe("MqttWire's protocol", () => {
  it("connects with MQTT 5, never 3.1.1 (the bridge's binding, GA-BRIDGE-18)", async () => {
    const sockets: Socket[] = [];
    const server = createServer();
    let wire: MqttWire | undefined;
    // A bare listener: it reads the first CONNECT, answers a CONNACK so that the connect resolves, then all is closed.
    const connect = new Promise<{ name: string; level: number; type: number }>((resolve) => {
      server.on("connection", (socket) => {
        sockets.push(socket);
        socket.on("error", () => {});
        let got = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          got = Buffer.concat([got, chunk]);
          // The fixed header's remaining length is a variable-length integer.
          let at = 1;
          while (at < got.length && got[at]! & 0x80) at++;
          at++;
          if (got.length < at + 7) return;
          const nameLength = got.readUInt16BE(at);
          resolve({ type: got[0]! >> 4, name: got.subarray(at + 2, at + 2 + nameLength).toString(), level: got[at + 2 + nameLength]! });
          // MQTT 5 CONNACK: no session present, reason 0, no properties.
          socket.write(Buffer.from([0x20, 0x03, 0x00, 0x00, 0x00]));
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    void MqttWire.connect({ url: `mqtt://127.0.0.1:${port}`, username: "u", clientId: "wire-test" })
      .then((w) => { wire = w; });
    try {
      expect(await connect).toEqual({ type: 1, name: "MQTT", level: 5 });
      await vi.waitFor(() => expect(wire).toBeDefined());
    } finally {
      await wire?.drop();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});
