import { Zcl } from "zigbee-herdsman";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { lostDetail } from "./execute.js";

/**
 * Polling an awake device (the design, *Freshness*; bridge 0.6, *The roster and freshness*): a device
 * the bridge can reach within POLL_REACH_MS (a router, a device on mains, an end device that answers
 * within seconds, the button pusher) is read at POLL_MS, and declared `basis: poll`, `cadenceMs`
 * POLL_MS, `basisMaxAgeMs` three times that (GA-BRIDGE-13). The read is the doer's own, never a
 * converter's: one attribute of genBasic, which every Zigbee device serves and which a Tuya device
 * answers though it answers no read of its datapoints. Its answer is a Read Attributes Response, a
 * message the device's application sends, so it comes through the pipeline as a check-in
 * (GA-BRIDGE-37); a device that answers with an error status has answered too. A device heard from
 * within POLL_MS is not read: its message was the check-in a read would bring.
 */

/** The poll's cadence: a read every five minutes (⚠️ a guess: cheap for a router, small for the button pusher's battery). */
export const POLL_MS = 300_000;
/** The bound a poll gives: three times its cadence, the most GA-BRIDGE-13 allows. */
export const POLL_BOUND_MS = 3 * POLL_MS;
/**
 * How long herdsman waits for a poll's answer, the read sent once (`disableRecovery`) and at once
 * (`sendPolicy: "immediate"`): on Z-Stack a frame holds the device's place in herdsman's adapter queue
 * until it ends, so an action on the same device waits behind it at most this (as a configure's call).
 */
export const POLL_CALL_MS = 5_000;
/** The longest reach of a device the bridge polls: one whose answer comes within a poll's own wait. */
export const POLL_REACH_MS = POLL_CALL_MS;
/** The cluster and attribute a poll reads: genBasic's ZCL version, mandatory on every device. */
export const POLL_READ = { cluster: "genBasic", attribute: "zclVersion" } as const;

/** The endpoint a poll reads: the device's first that serves genBasic; none for a device that lists none. */
export function pollEndpoint(device: Zh.Device): Zh.Endpoint | undefined {
  return device.endpoints.find((ep) => ep.supportsInputCluster(POLL_READ.cluster));
}

/** Whether the bridge polls a device of this reach: one it reaches within POLL_REACH_MS that serves genBasic. */
export function polls(device: Zh.Device, reachMs: number): boolean {
  return reachMs <= POLL_REACH_MS && pollEndpoint(device) !== undefined;
}

/** How a poll ended: the device answered (an error status is an answer), or it did not, with why in the doer's own words. */
export type Polled = { answered: true } | { answered: false; detail: string };

/**
 * One poll: the read, on herdsman's own model of the device. Its answer reaches the core as the
 * device's message, not from here.
 */
export async function poll(model: Zh.Device): Promise<Polled> {
  const ep = pollEndpoint(model);
  if (!ep) return { answered: false, detail: "the device serves no genBasic" };
  try {
    await ep.read(POLL_READ.cluster, [POLL_READ.attribute], { sendPolicy: "immediate", disableRecovery: true, timeout: POLL_CALL_MS });
    return { answered: true };
  } catch (err) {
    // A status the device sent back is its application's answer: a check-in all the same.
    if (err instanceof Zcl.StatusError) return { answered: true };
    return { answered: false, detail: lostDetail(err) };
  }
}
