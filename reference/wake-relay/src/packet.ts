/** Wake-on-LAN's magic packet: six 0xFF bytes, then the MAC sixteen times (102 bytes). */
export function magicPacket(mac: string): Buffer {
  if (!/^[0-9A-F]{12}$/.test(mac)) throw new Error(`not a canonical MAC: ${mac}`);
  const target = Buffer.from(mac, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => target)]);
}

/** The UDP port the packet is sent to: 9, the discard port, as most senders use. */
export const WAKE_PORT = 9;
