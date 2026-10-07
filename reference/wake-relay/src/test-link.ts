import type { Entry } from "./config.js";
import type { Link } from "./link.js";
import { WAKE_PORT } from "./packet.js";

/** The harness asked for an op this test transport cannot play; the reply says so (`unsupported`). */
export class UnsupportedOp extends Error {}

/** A packet as the harness reads it on `received`: the wave 0 shape, the packet in `args` as hex. */
export interface Sent {
  device: string;
  action: "power.wake";
  args: { interface: string; port: number; packet: string };
}

/**
 * The test transport's interface (GA-BRIDGE-16): the harness sets the carrier and whether the
 * gateway answers, and reads every packet on `received`. It starts with a carrier and an
 * answering gateway, as a healthy LAN would.
 */
export class TestLink implements Link {
  private hasCarrier = true;
  private gatewayAnswers = true;

  constructor(private readonly iface: string, private readonly onSent: (sent: Sent) => Promise<void>) {}

  /** The harness's `link` op, and `transportState` read as the interface: up is a carrier and a gateway that answers, down no carrier. */
  control(msg: Record<string, unknown>): void {
    switch (msg.op) {
      case "link":
        this.hasCarrier = msg.carrier as boolean;
        this.gatewayAnswers = msg.gatewayAnswers as boolean;
        return;
      case "transportState":
        if (msg.state === "unknown") throw new UnsupportedOp("a wake relay's transport is never unknown");
        this.hasCarrier = msg.state === "up";
        this.gatewayAnswers = msg.state === "up";
        return;
      default:
        throw new UnsupportedOp(`${String(msg.op)} has no meaning for a wake relay`);
    }
  }

  async carrier(): Promise<boolean> {
    return this.hasCarrier;
  }

  async arp(): Promise<boolean> {
    return this.hasCarrier && this.gatewayAnswers;
  }

  async send(entry: Entry, packet: Buffer): Promise<void> {
    await this.onSent({ device: entry.id, action: "power.wake",
      args: { interface: this.iface, port: WAKE_PORT, packet: packet.toString("hex") } });
  }

  async close(): Promise<void> {}
}
