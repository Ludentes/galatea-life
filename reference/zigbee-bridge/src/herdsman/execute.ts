import { Zcl } from "zigbee-herdsman";
import type { Definition, Tz } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import type { ProtocolResult } from "../port.js";
import { type Gate, type LiveMethod, live } from "./guard.js";
import { type Answer, answerOf, converterFor } from "./recording.js";

/**
 * Command results (the design, *Command results*): an action's converter runs `convertSet` against
 * the device live (`guard.ts`), whose endpoints' command, write and read go to herdsman, each
 * recorded with what came of it. The converter's own return, optimistic state, is discarded: the
 * `ProtocolResult` comes from the record (spike S8). The read-back runs `convertGet` the same way;
 * its answer comes as a message, through the pipeline.
 */

/** One call of a live run, as the converter made it: what herdsman waits on, and what came of it. */
export interface Made {
  call: LiveMethod;
  cluster: unknown;
  /** The command's name, or the attributes written or read. */
  what: unknown;
  answer: Answer;
  /**
   * The call's own value (a Default Response's `{cmdId, statusCode}`, a cluster response's payload,
   * the attributes read), its error, none yet (a call the converter did not wait for), or, for a call
   * the command's time had run out before, none made.
   */
  outcome: { value: unknown } | { error: unknown } | { pending: true } | { notMade: "expired" };
}

/** A live run: its calls in order, and the converter's own throw, if it threw. */
export interface LiveRun {
  calls: Made[];
  threw?: unknown;
}

export interface RunOptions {
  /** The doer's clock. */
  now(): number;
  /** The command's end on that clock: a call is made only before it, with what remains as herdsman's timeout (GA-BRIDGE-7). */
  deadline: number;
  /** herdsman sends the frame once, never retrying it (`disableRecovery`): an action that is not idempotent. */
  once: boolean;
  /** The converters' options for the model (`Override.options`). */
  options?: Record<string, unknown>;
  /** The converters' state for the device, as its messages built it. */
  state?: Record<string, unknown>;
}

/** Why a call was not made: the command's time ran out before the converter made it. */
export class Expired extends Error {}

/** Where a call's options go: `command(cluster, command, payload, options)`, `write` and `read(cluster, attributes, options)`. */
const OPTIONS_AT: Record<LiveMethod, number> = { command: 3, write: 2, read: 2 };

/**
 * A live call's options: the converter's, then the doer's, which win (spike S8). What remains of the
 * command's time is herdsman's timeout; `sendPolicy: "immediate"`, so that herdsman never queues it
 * for a sleeping device to send after the command's time (GA-BRIDGE-7); and `disableRecovery` for an
 * action that is not idempotent, so herdsman sends it once (the design, *Command results*).
 */
export function liveOptions(given: unknown, o: Pick<RunOptions, "now" | "deadline" | "once">): Record<string, unknown> {
  const own = given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  return { ...own, timeout: Math.max(1, o.deadline - o.now()), sendPolicy: "immediate", ...(o.once ? { disableRecovery: true } : {}) };
}

/** The run's gate: each call recorded in order, made only before the deadline, with the doer's options. */
function gateFor(device: Zh.Device, calls: Made[], o: RunOptions): Gate {
  return async (_endpoint, method, args, send) => {
    const at = OPTIONS_AT[method];
    const a = [...args];
    const expired = o.now() >= o.deadline;
    if (!expired) a[at] = liveOptions(a[at], o);
    const made: Made = { call: method, cluster: a[0], what: a[1], answer: answerOf(device, method, a[0], a[1], a[at] as Record<string, unknown>),
      outcome: expired ? { notMade: "expired" } : { pending: true } };
    calls.push(made);
    if (expired) throw new Expired("the command's time ran out before this call");
    try {
      const value = await send(a);
      made.outcome = { value };
      return value;
    } catch (error) {
      made.outcome = { error };
      throw error;
    }
  };
}

/** The `meta` a converter's `convertSet` or `convertGet` is given, for one property's value. */
function metaFor(definition: Definition, device: Zh.Device, property: string, value: unknown, o: RunOptions): Tz.Meta {
  return { message: { [property]: value }, device, mapped: definition, options: { ...o.options }, state: o.state ?? {}, endpoint_name: undefined,
    publish: () => {}, deviceExposesChanged: () => {} } as Tz.Meta;
}

/**
 * Runs the converter's `convertSet` for `{ [property]: value }` on the device live, its first
 * endpoint as the dry run takes it (`recording.ts`). Every call is recorded; the converter's return
 * is discarded.
 */
export async function runSet(definition: Definition, device: Zh.Device, property: string, value: unknown, o: RunOptions): Promise<LiveRun> {
  const converter = converterFor(definition, property);
  if (!converter) return { calls: [], threw: new Error(`no converter takes ${property}`) };
  const calls: Made[] = [];
  const gate = gateFor(device, calls, o);
  const d = live(device, gate);
  const entity = d.endpoints[0];
  try {
    if (!entity) return { calls, threw: new Error("the device has no endpoint") };
    await converter.convertSet!(entity, property, value, metaFor(definition, d, property, value, o));
    return { calls };
  } catch (threw) {
    return { calls, threw };
  } finally {
    // The run ends with the converter's set: nothing it sends later reaches herdsman (plan 2c-2 review I2).
    gate.closed = true;
  }
}

/**
 * The converter that reads a property back, the one zigbee2mqtt's `get` finds: the first whose keys
 * name the property, or that names none, whether or not it has a `convertSet` (so not always the one
 * the set went to), and only if it has a `convertGet`. A Tuya datapoint has none: the button
 * pusher's echo is its observation (the design, *Command results*).
 */
export function getterFor(definition: Definition, property: string): Tz.Converter | undefined {
  const c = definition.toZigbee.find((x) => (!x.key || x.key.includes(property)) && !x.endpoints);
  return c?.convertGet ? c : undefined;
}

/**
 * Reads the properties back (GA-BRIDGE-34): each converter's `convertGet` once, for the first of its
 * properties, on the device live. The answers come as the device's messages; the runs say what was
 * sent. A property no converter reads is not read.
 */
export async function runGet(definition: Definition, device: Zh.Device, properties: string[], o: RunOptions): Promise<LiveRun[]> {
  const byConverter = new Map<Tz.Converter, string>();
  for (const p of properties) {
    const c = getterFor(definition, p);
    if (c && !byConverter.has(c)) byConverter.set(c, p);
  }
  const runs: LiveRun[] = [];
  for (const [converter, property] of byConverter) {
    const calls: Made[] = [];
    const gate = gateFor(device, calls, o);
    const d = live(device, gate);
    const entity = d.endpoints[0];
    try {
      if (!entity) continue;
      await converter.convertGet!(entity, property, metaFor(definition, d, property, undefined, o));
      runs.push({ calls });
    } catch (threw) {
      runs.push({ calls, threw });
    } finally {
      // As for a set: the run ends with the converter's get (plan 2c-2 review I2).
      gate.closed = true;
    }
  }
  return runs;
}

/** A ZCL status by its name (`UNSUP_COMMAND`), or its number where herdsman has no name for it. */
export function statusName(code: number): string {
  return (Zcl.Status as unknown as Record<number, string>)[code] ?? `status ${code}`;
}

/** The status a call's own answer refuses with: a Default Response's `statusCode`, or a cluster response's `status`; undefined for success. */
function refusalOf(c: Made): number | undefined {
  if (!("value" in c.outcome)) return undefined;
  const v = c.outcome.value as { statusCode?: unknown; status?: unknown } | undefined;
  const code = c.answer === "defaultResponse" ? v?.statusCode : c.answer === "response" ? v?.status : undefined;
  return typeof code === "number" && code !== Zcl.Status.SUCCESS ? code : undefined;
}

/**
 * What became of a delivery, never in herdsman's words: herdsman's error text quotes the frame's
 * payload, a lock's PIN among it (spike S8). A data-confirm failure gives the status it names, a
 * timeout says so, and anything else a fixed text.
 */
export function lostDetail(error: unknown): string {
  if (error instanceof Expired) return "the command's time ran out before the converter's next call";
  const text = String((error as Error)?.message ?? "");
  const confirm = /Data request failed with error: '([A-Z_]+)'/.exec(text);
  if (confirm) return `the delivery failed: ${confirm[1]}`;
  if (/\bTimeout\b/.test(text)) return "the device did not answer in time";
  return "the stack failed after the command was handed to it";
}

/**
 * The protocol's word on a live run (the design, *Command results*; spike S8):
 * - no call made: `notSent`, `expired` if the command's time ran out before the first, else
 *   `unreachable` (the converter threw, or sent nothing);
 * - the first call that failed decides: herdsman's `ZclStatusError` (a Write Response's status, or
 *   one herdsman raised before sending, a read-only attribute's) is `refused` with the status's name,
 *   any other error `lost`;
 * - a call whose own answer carries a failure status (a Default Response's, a cluster response's) is
 *   `refused`, though the converter went on as if it succeeded;
 * - a refusal is `refused` only from the converter's last call sent; with a later call sent, the
 *   device may have acted, so `lost` (plan 2c-2 review M1);
 * - a converter that stopped after a call (threw, or ran out of time before its next), or returned
 *   before a call's answer came, is `lost`;
 * - otherwise `transmitted` where any call waits on no answer, else `confirmed`.
 */
export function resultOf(run: LiveRun): ProtocolResult {
  const made = run.calls.filter((c) => !("notMade" in c.outcome));
  if (made.length === 0) {
    if (run.calls.length) return { kind: "notSent", reason: "expired", detail: "the command's time ran out before anything was sent" };
    return { kind: "notSent", reason: "unreachable", detail: "the converter sent nothing" };
  }
  for (const [i, c] of made.entries()) {
    // A refusal is the word only from the converter's last call sent: after a later one, the device may have acted (plan 2c-2 review M1).
    const refusal = (code: number): ProtocolResult => (i === made.length - 1 ? { kind: "refused", reason: "refused", detail: statusName(code) }
      : { kind: "lost", detail: `the device refused one call (${statusName(code)}), and a later one was sent` });
    if ("error" in c.outcome) {
      const e = c.outcome.error;
      if (e instanceof Zcl.StatusError) return refusal(e.code);
      return { kind: "lost", detail: lostDetail(e) };
    }
    const refused = refusalOf(c);
    if (refused !== undefined) return refusal(refused);
  }
  if (made.some((c) => "pending" in c.outcome)) return { kind: "lost", detail: "the converter did not wait for the answer" };
  if (run.threw !== undefined || made.length < run.calls.length) {
    return { kind: "lost", detail: run.threw instanceof Expired ? lostDetail(run.threw) : "the converter stopped after sending" };
  }
  return made.some((c) => c.answer === "none") ? { kind: "transmitted" } : { kind: "confirmed" };
}
