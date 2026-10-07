import { createHash } from "node:crypto";
import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Definition } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import type { KeyMap } from "./describe.js";
import { answering, guard, messageExchange } from "./guard.js";
import { redact } from "./log.js";
import type { Override } from "./overrides.js";

/**
 * The converter pipeline (the design, *The converter pipeline*): every message a device sends goes
 * through every `fromZigbee` converter of its definition whose cluster and type match, since the
 * converters' side effects need it; what they return from the message itself becomes readings and
 * occurrences under the device's keys, and what no key describes is named (GA-BRIDGE-76).
 */

/** A message as herdsman 10.10.0 emits it (`Controller`'s `message` event), with the fields the pipeline reads. */
export interface Message {
  type: string;
  device: Zh.Device;
  endpoint: Zh.Endpoint;
  cluster: string | number;
  data: unknown;
  linkquality?: number;
  groupID?: number;
  meta?: { zclTransactionSequenceNumber?: number; rawData?: Buffer };
}

/** What a device's message gave, or a converter's later publish resting on one. */
export interface Heard {
  hardwareId: string;
  /** When the message reached the bridge: the readings' time, a later publish's too (GA-BRIDGE-1). */
  time: number;
  /** Readings by key: what the converters returned from the message itself. */
  readings: Record<string, unknown>;
  /** Occurrences of `event` keys (GA-BRIDGE-75). */
  occurrences: { key: string; value: unknown }[];
  /**
   * The message: its endpoint, cluster, transaction number and a hash of its bytes, so that the
   * core's repeat check (`[frameId, key, value]`) never takes two messages with one number for one
   * (plan 2c-1 review I2).
   */
  frameId: string;
  /** The device's own names of data no key describes (GA-BRIDGE-76). */
  undescribed: string[];
  /** A message the device sent: a check-in (GA-BRIDGE-37); a converter's later publish is none. */
  checkIn: boolean;
}

/** A described device, as the pipeline reads its messages. */
export interface PipelineEntry {
  definition: Definition;
  /** How each converter property becomes a reading, by property (`Described.keys`). */
  keys: Map<string, KeyMap>;
  override?: Override;
}

/** A frame repeated within this, with the same transaction and the same bytes, is one message (GA-BRIDGE-75; spike S7). */
export const REPEAT_MS = 10_000;
/** Clusters whose reports carry the device's housekeeping, which herdsman answers itself: never named undescribed. */
const HOUSEKEEPING = new Set(["genBasic", "genTime", "genOta", "genPollCtrl"]);

type Converter = Definition["fromZigbee"][number];

export interface PipelineOptions {
  clock: Clock;
  /** A converter's publish after its message was handled: a timer's, or one that waited on something. */
  late(heard: Heard): void;
  /** A converter said the device's exposes changed: it is described again. */
  exposesChanged(hardwareId: string): void;
  /** The converters may answer the message as the guard's answers say (plan 2c-3); otherwise they send nothing. */
  answers?: boolean;
}

/**
 * The definition as the converters get it: its `publishDuplicateTransaction` set, which turns off the
 * converters' own repeat check by transaction number alone (`hasAlreadyProcessedMessage`, the only
 * reader of that flag in 26.114.0). The pipeline's check, by the frame's bytes too, is the only one
 * (GA-BRIDGE-75; plan 2c-1 review I2).
 */
export function forConverters(definition: Definition): Definition {
  return { ...definition, meta: { ...definition.meta, publishDuplicateTransaction: true } };
}

/** The message's name: its endpoint, cluster, transaction number and the first 16 hex digits of its bytes' SHA-256. */
export function frameIdOf(m: Message): string {
  const tsn = m.meta?.zclTransactionSequenceNumber;
  const raw = m.meta?.rawData;
  const bytes = raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "-";
  return `${m.endpoint.ID}/${String(m.cluster)}/${tsn ?? "-"}/${bytes}`;
}

export class Pipeline {
  private readonly entries = new Map<string, PipelineEntry>();
  /** The definitions as the converters get them, by device. */
  private readonly models = new Map<string, Definition>();
  /** What the converters returned for each device, from its messages only: their `meta.state`. */
  private readonly states = new Map<string, Record<string, unknown>>();
  /** Each message's identity, with when it was taken, for REPEAT_MS. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly o: PipelineOptions) {}

  /** Reads the device's messages by `entry` from now on. */
  set(hardwareId: string, entry: PipelineEntry): void {
    this.entries.set(hardwareId, entry);
    this.models.set(hardwareId, forConverters(entry.definition));
  }

  /** Forgets the device: its messages are read no more. */
  delete(hardwareId: string): void {
    this.entries.delete(hardwareId);
    this.models.delete(hardwareId);
    this.states.delete(hardwareId);
  }

  has(hardwareId: string): boolean {
    return this.entries.has(hardwareId);
  }

  /** The converters' state for the device, as its messages built it. */
  state(hardwareId: string): Record<string, unknown> {
    let s = this.states.get(hardwareId);
    if (!s) this.states.set(hardwareId, (s = {}));
    return s;
  }

  /** One message: undefined when the device is not described, or the message repeats one taken within REPEAT_MS. */
  async message(m: Message): Promise<Heard | undefined> {
    const hw = m.device.ieeeAddr;
    const entry = this.entries.get(hw);
    if (!entry) return undefined;
    const now = this.o.clock.now();
    if (this.repeated(m, now)) return undefined;
    const heard: Heard = { hardwareId: hw, time: now, readings: {}, occurrences: [], frameId: frameIdOf(m), undescribed: [], checkIn: true };
    const converters = entry.definition.fromZigbee.filter((c) => matches(c, m));
    const attributes = attributesOf(entry.override, m);
    // A duplicate of a reading the device sends by another path is dropped, its message still a check-in (GA-BRIDGE-76).
    heard.undescribed.push(...undescribedData(entry.definition, m, converters.length > 0, attributes)
      .filter((n) => !entry.override?.duplicates?.includes(n)));
    let handled = false;
    const output: Record<string, unknown> = {};
    const publish = (payload: Record<string, unknown>) => {
      if (!handled) {
        Object.assign(output, payload);
        return;
      }
      const later: Heard = { ...heard, readings: {}, occurrences: [], undescribed: [], checkIn: false };
      const dropped = new Set(entry.override?.dropLate ?? []);
      this.map(entry, Object.fromEntries(Object.entries(payload).filter(([k]) => !dropped.has(k))), later);
      if (Object.keys(later.readings).length || later.occurrences.length || later.undescribed.length) this.o.late(later);
    };
    const state = this.state(hw);
    // The converters get the device guarded: nothing they call sends a device a frame (plan 2c-1 review I1), but
    // an answer to this message the guard lets through, while the message is read (plan 2c-3).
    const ex = this.o.answers ? messageExchange(m.cluster, m.type) : undefined;
    const open = <T>(v: T): T => (ex ? answering(v, ex) : guard(v));
    const device = open(m.device);
    const msg = { ...m, device, endpoint: open(m.endpoint) };
    const meta = { device, state, deviceExposesChanged: () => this.o.exposesChanged(hw) };
    const model = this.models.get(hw)!;
    const options = entry.override?.options ?? {};
    try {
      for (const c of converters) {
        try {
          const r = await c.convert(model, msg as never, publish as never, options as never, meta as never);
          if (r && typeof r === "object") Object.assign(output, r);
        } catch (err) {
          // One converter's fault drops its own output, never the device's other messages (GA-BRIDGE-9).
          console.error(`zigbee: ${hw}: a converter of ${String(m.cluster)} ${m.type} threw: ${redact(String((err as Error)?.message ?? err))}`);
        }
      }
    } finally {
      // The message is read: its answers close.
      if (ex) ex.closed = true;
    }
    handled = true;
    Object.assign(output, attributes.output);
    Object.assign(state, output);
    this.map(entry, output, heard);
    return heard;
  }

  /** Converter outputs to readings, occurrences and undescribed names, by the entry's keys. */
  private map(entry: PipelineEntry, output: Record<string, unknown>, heard: Heard): void {
    for (const [property, value] of Object.entries(output)) {
      const k = entry.keys.get(property);
      if (!k) {
        heard.undescribed.push(property);
        continue;
      }
      const v = k.from(value);
      if (v === undefined) continue;
      if (k.kind === "event") heard.occurrences.push({ key: k.key, value: v });
      else heard.readings[k.key] = v;
    }
  }

  /** Whether the message repeats one taken within REPEAT_MS: the same device, endpoint, cluster, transaction and bytes. */
  private repeated(m: Message, now: number): boolean {
    for (const [id, at] of this.seen) if (now - at > REPEAT_MS || now < at) this.seen.delete(id);
    const tsn = m.meta?.zclTransactionSequenceNumber;
    const raw = m.meta?.rawData;
    if (tsn === undefined || !raw) return false;
    const id = `${m.device.ieeeAddr}/${m.endpoint.ID}/${String(m.cluster)}/${tsn}/${raw.toString("hex")}`;
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

/** Whether a converter takes the message: its cluster, and its type or one of its types. */
function matches(c: Converter, m: Message): boolean {
  return c.cluster === m.cluster && (Array.isArray(c.type) ? (c.type as readonly string[]).includes(m.type) : c.type === m.type);
}

/**
 * The attributes of a report or read response that the override table maps to a converter property
 * (`Override.attributes`), as if a converter had returned them, and their names.
 */
function attributesOf(override: Override | undefined, m: Message): { output: Record<string, unknown>; names: Set<string> } {
  const output: Record<string, unknown> = {};
  const names = new Set<string>();
  const data = m.data;
  if (!override?.attributes || (m.type !== "attributeReport" && m.type !== "readResponse") || !data || typeof data !== "object") {
    return { output, names };
  }
  for (const [attribute, value] of Object.entries(data)) {
    const name = `${String(m.cluster)}.${attribute}`;
    if (!Object.hasOwn(override.attributes, name)) continue;
    output[override.attributes[name]!] = value;
    names.add(attribute);
  }
  return { output, names };
}

/**
 * The data in a message no converter can describe: a Tuya datapoint the definition has no entry for
 * (`dp<N>`), and an attribute report on a cluster no converter takes (`<cluster>.<attribute>`),
 * housekeeping clusters and the attributes the override table maps aside.
 */
function undescribedData(definition: Definition, m: Message, taken: boolean, mapped: { names: Set<string> }): string[] {
  const names: string[] = [];
  const data = m.data as { dpValues?: { dp: number }[] } | null;
  const known = definition.meta?.tuyaDatapoints;
  if (m.cluster === "manuSpecificTuya" && Array.isArray(data?.dpValues) && known) {
    for (const v of data.dpValues) if (!known.some((d) => d[0] === v.dp)) names.push(`dp${v.dp}`);
  }
  if (!taken && m.type === "attributeReport" && !HOUSEKEEPING.has(String(m.cluster)) && data && typeof data === "object") {
    for (const attribute of Object.keys(data)) if (!mapped.names.has(attribute)) names.push(`${String(m.cluster)}.${attribute}`);
  }
  return names;
}
