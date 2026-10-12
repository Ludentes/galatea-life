import type { Bridge } from "../config/config.js";

/**
 * What the broker made of a command or a request (GA-BUS-9): delivered to a subscriber (`ok`); no
 * subscriber, the bridge between connections (`0x10`); refused, with its reason code (`0x87`, not
 * authorised, or another failure); the connection lost before any PUBACK (`lost`: it may have been
 * delivered); or not published at all, the broker being away (`offline`).
 */
export type Puback = { kind: "ok" } | { kind: "no_subscribers" } | { kind: "refused"; code: number } | { kind: "lost" } | { kind: "offline" };

/** What the applier asks of its MQTT client; `Bus` in `bus/client.ts`. */
export interface BusPort {
  follow(bridges: Map<string, Bridge>): void;
  snapshot(bridge: Bridge): Promise<Puback>;
  /** A request other than a snapshot (slice 5a's provisioning): its body carries its `requestId` and `issuedAt`. */
  request(bridge: Bridge, op: string, body: Record<string, unknown>): Promise<Puback>;
  command(bridge: Bridge, device: string, body: Record<string, unknown>, expiryS: number): Promise<Puback>;
}
