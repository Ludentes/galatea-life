import { describe, expect, it } from "vitest";
import { magicPacket, WAKE_PORT } from "../src/packet.js";

describe("magicPacket", () => {
  it("is six 0xFF bytes and the MAC sixteen times, 102 bytes", () => {
    const p = magicPacket("D4A651A1B2C3");
    expect(p.length).toBe(102);
    expect(p.subarray(0, 6).equals(Buffer.alloc(6, 0xff))).toBe(true);
    for (let i = 0; i < 16; i++) expect(p.subarray(6 + i * 6, 12 + i * 6).toString("hex")).toBe("d4a651a1b2c3");
  });

  it("goes to the discard port", () => {
    expect(WAKE_PORT).toBe(9);
  });
});
