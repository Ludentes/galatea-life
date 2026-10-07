import type { Entry } from "./config.js";

/**
 * The LAN interface as the relay uses it: the OS in production (`LinuxLink`), the harness's
 * scripted interface under a run (`TestLink`).
 */
export interface Link {
  /** Whether the interface has a carrier now. */
  carrier(): Promise<boolean>;
  /** One ARP exchange with the gateway: true when it answered. */
  arp(): Promise<boolean>;
  /** Sends the magic packet out of the interface; resolves once it has left, throws if it could not. */
  send(entry: Entry, packet: Buffer): Promise<void>;
  close(): Promise<void>;
}
