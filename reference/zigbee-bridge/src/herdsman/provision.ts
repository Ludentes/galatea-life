import type { Device } from "zigbee-herdsman/dist/controller/model/device.js";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { type RemovalGate, removing } from "./guard.js";

/**
 * The herdsman doer's provisioning (the design, *Provisioning (`provision.ts`)*; plan 3b): what its
 * join windows send, how long it waits on herdsman for them, and a removal's one call to herdsman.
 */

/**
 * herdsman's removal of its model of a device, through the guard opened for that removal alone
 * (`removing`): its Leave Request (`removeFromNetwork`), or with `force` its record dropped without a
 * frame (`removeFromDatabase`). The gate closes once the call ended, whatever came of it; `opened`
 * sees the gate (tests). Rejects as herdsman does.
 */
export async function removeDevice(model: Device, force: boolean, opened?: (gate: RemovalGate) => void): Promise<void> {
  const gate: RemovalGate = (device, method, args, send) => {
    console.error(`herdsman: ${device.ieeeAddr}: ${method === "removeFromNetwork" ? "Leave Request sent, without rejoin"
      : "dropped from herdsman's database, without a frame"}`);
    return send(args);
  };
  opened?.(gate);
  const d = removing(model as unknown as Zh.Device, gate, force);
  try {
    await (force ? d.removeFromDatabase() : d.removeFromNetwork());
  } finally {
    gate.closed = true;
  }
}

/** The longest permit herdsman sends: a uint8 of seconds, 255 meaning "for ever" to many stacks. */
export const PERMIT_MAX_S = 254;

/**
 * How long the doer waits for herdsman's permit, or its close, before it gives up on it: herdsman
 * sends a permit at a router as a ZDO request awaiting its answer (on Z-Stack its 6 s request and
 * its 10 s wait for the response), then Green Power's commissioning mode, awaiting a ZCL answer for
 * 10 s; twice that and a little more. The core's next window call waits behind it.
 */
export const PERMIT_MS = 30_000;

/** The permit's seconds for a window of `windowMs` (the core's, at most its 254 s cap): whole seconds, rounded up, at least 1. */
export function permitSeconds(windowMs: number): number {
  return Math.min(PERMIT_MAX_S, Math.max(1, Math.ceil(windowMs / 1000)));
}
