import { Zcl } from "zigbee-herdsman";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import type { HardwareId } from "../port.js";
import { Expired, type LiveRun } from "./execute.js";

/**
 * A mains device that stops answering goes `dead` (the maintainer's ruling of 2026-10-12; first
 * light's FL-GAP-4; the plan `docs/plans/2026-10-12-zigbee-bridge-mains-dead.md`): a device the rule
 * covers (`active`) is told unavailable once POLL_MISSES polls or COMMAND_MISSES commands in a row get
 * no answer (`noAnswer`), and available again at the next frame heard from it. Every answer, and every
 * frame heard, starts both rows again. A device the rule does not cover, a battery device, keeps
 * today's behaviour: stale on silence, never `dead`. Nothing is kept: a restart starts every row at zero.
 */

/**
 * Polls in a row with no answer that make a covered device unavailable: about 10 min at POLL_MS (the
 * maintainer, 2026-10-12). A poll counts as unanswered only when its retry, sent POLL_RETRY_MS later
 * with herdsman's recovery, went unanswered too.
 */
export const POLL_MISSES = 2;
/**
 * How long after an unanswered poll of a covered device its retry is sent, with herdsman's recovery
 * (route discovery, an address check): zigbee2mqtt's ping retry (`pingQueueExecuteNext`), a compatible decision.
 */
export const POLL_RETRY_MS = 3_000;
/**
 * Commands in a row with no answer that make a covered device unavailable (the maintainer, 2026-10-12).
 * Only a command sent with herdsman's recovery counts: one sent once without it (an action that is not
 * idempotent) may have failed on a stale route that recovery would have mended.
 */
export const COMMAND_MISSES = 3;

/**
 * The build's own mutation of the rule, honoured here (`UNCLAIMED_MUTATIONS` in `../mutation.ts`):
 * the rule keyed to whether the doer polls the device, not to the device, so the polled button
 * pusher, on a battery, goes dead too.
 */
export type AvailabilityMutation = "marks-a-battery-device-dead";

/**
 * Whether the rule covers the device: zigbee2mqtt's own test for an *active* device
 * (`Availability.isActiveDevice`), a compatible decision. A router not on a battery, or any device
 * whose power source herdsman knows and is not a battery (the mains, a DC source). Keyed to what the
 * device is, never to whether the doer polls it.
 */
export function active(device: Pick<Zh.Device, "type" | "powerSource">): boolean {
  const power = device.powerSource;
  return (device.type === "Router" && power !== "Battery") || (power !== undefined && power !== "Unknown" && power !== "Battery");
}

/**
 * The Z-Stack data-confirm statuses that say the device did not take the frame: no MAC ack from the
 * next hop, no route to it, a frame held for it that expired, no APS ack. Every other status (the
 * coordinator's own congestion: `MAC_CHANNEL_ACCESS_FAILURE`, `BUFFER_FULL`, `MAC_NO_RESOURCES`; and
 * herdsman's own `'TIMEOUT'`, made up when no data confirm came) is about the coordinator, not the
 * device, and counts neither way.
 */
export const NO_ANSWER_STATUSES: readonly string[] = ["MAC_NO_ACK", "NWK_NO_ROUTE", "MAC_TRANSACTION_EXPIRED", "APS_NO_ACK"];

/**
 * Whether a call's failure says the device did not answer: a data confirm with one of
 * NO_ANSWER_STATUSES, or herdsman's cluster waitress giving up on the response
 * (`Timeout after <n>ms [address=…]`). A status the device sent back is an answer; the command's own
 * time running out, the coordinator's own trouble (a congestion status, herdsman's `'TIMEOUT'`, a
 * data request the coordinator did not take: `SRSP - AF - dataRequest after 6000ms`), or any other
 * error says nothing either way. ⚠️ Read from herdsman 10.10.0's Z-Stack wording: another adapter's
 * errors count neither way until its wording is added.
 */
export function noAnswer(error: unknown): boolean {
  if (error instanceof Zcl.StatusError || error instanceof Expired) return false;
  const text = String((error as Error)?.message ?? "");
  const confirm = /Data request failed with error: '([A-Z_]+)'/.exec(text);
  if (confirm) return NO_ANSWER_STATUSES.includes(confirm[1]!);
  return /\bTimeout after \d+ms \[address=/.test(text);
}

/**
 * Whether a command's live run reached the device, by its first decisive call in order: one that got
 * its answer (whatever status it carries), or a status error, `answered`; one that failed by
 * `noAnswer`, `unanswered`. A frame that waits on no answer, a call never made, one the converter did
 * not wait for, or the stack's own error decides nothing: undefined when no call decides.
 */
export function reachOf(run: LiveRun): "answered" | "unanswered" | undefined {
  for (const c of run.calls) {
    if ("value" in c.outcome && c.answer !== "none") return "answered";
    if (!("error" in c.outcome)) continue;
    if (c.outcome.error instanceof Zcl.StatusError) return "answered";
    if (noAnswer(c.outcome.error)) return "unanswered";
  }
  return undefined;
}

/** What the count asks of its owner: whether the rule covers the device now, how to tell the core, and the time. */
export interface AvailabilityOptions {
  covers(hw: HardwareId): boolean;
  /** Tells the core the device is unavailable (false) or available again (true); false when the word reached nobody (the doer stopped). */
  tell(hw: HardwareId, available: boolean): boolean;
  /** The doer's clock. */
  now(): number;
}

/**
 * Each covered device's rows of unanswered polls and commands, when it was last heard, and the
 * devices told unavailable. A device is recorded unavailable only once the core was told so.
 */
export class Availability {
  private readonly rows = new Map<HardwareId, { polls: number; commands: number }>();
  private readonly gone = new Set<HardwareId>();
  /** When each device last answered or was heard, on the doer's clock. */
  private readonly heardAt = new Map<HardwareId, number>();

  constructor(private readonly o: AvailabilityOptions) {}

  /** Whether the device was told unavailable and has not been heard since. */
  isGone(hw: HardwareId): boolean {
    return this.gone.has(hw);
  }

  /**
   * A poll (its retry with recovery included), or a command, begun at `since`, that got no answer:
   * not counted when the device was heard after it began, since it answered something meanwhile. The
   * device is told unavailable once its row reaches the threshold.
   */
  missed(hw: HardwareId, what: "poll" | "command", since: number): void {
    // Heard after it began (later than its first moment: one heard in that same moment may have come before it).
    if (!this.o.covers(hw) || (this.heardAt.get(hw) ?? Number.NEGATIVE_INFINITY) > since) return;
    const row = this.rows.get(hw) ?? { polls: 0, commands: 0 };
    if (what === "poll") row.polls += 1;
    else row.commands += 1;
    this.rows.set(hw, row);
    if (this.gone.has(hw)) return;
    const said = row.polls >= POLL_MISSES ? `${row.polls} polls` : row.commands >= COMMAND_MISSES ? `${row.commands} commands` : undefined;
    // Recorded only once the core heard it: a word that reached nobody is said again at the next miss.
    if (!said || !this.o.tell(hw, false)) return;
    this.gone.add(hw);
    console.error(`zigbee: ${hw}: ${said} in a row got no answer: available: false until it is heard`);
  }

  /** The device answered, or a frame was heard from it: both rows start again, and a device told unavailable is available again. */
  heard(hw: HardwareId): void {
    this.heardAt.set(hw, this.o.now());
    this.rows.delete(hw);
    // A return that reached nobody is said again at the next frame.
    if (!this.gone.has(hw) || !this.o.tell(hw, true)) return;
    this.gone.delete(hw);
    console.error(`zigbee: ${hw}: heard again: available: true`);
  }

  /** The device is gone from the doer: its rows forgotten, and hardware let in again starts at zero. */
  forget(hw: HardwareId): void {
    this.rows.delete(hw);
    this.gone.delete(hw);
    this.heardAt.delete(hw);
  }
}
