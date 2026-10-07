import { Zcl } from "zigbee-herdsman";
import type { Definition, Tz } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";

/**
 * The recording endpoint (the design, *Describing a device*, *Command results*): a converter's
 * `convertSet` is run against proxies of a device and its endpoints that record every call it makes
 * and, in a dry run, send nothing. The shape of the calls says how the protocol answers the action
 * (`confirms`).
 */

/** How herdsman waits on a call: a cluster's own response, a Default Response, a Write or Read Response, nothing, or a call that is no request of these. */
export type Answer = "response" | "defaultResponse" | "writeResponse" | "readResponse" | "none" | "other";

/** One call a converter made, as recorded. */
export interface Call {
  /** The method: `command`, `write`, `read`, or any other the converter reached (`device.<name>` for the device's). */
  call: string;
  cluster?: unknown;
  /** The command's name, or the attributes written or read. */
  what?: unknown;
  /** The options the converter passed, as herdsman takes them (the call's last argument). */
  options?: Record<string, unknown>;
  answer: Answer;
}

/** The endpoint's methods a converter may use that send nothing: everything else it calls is recorded, and sent nowhere. */
const QUIET_ENDPOINT = new Set(["getClusterAttributeValue", "supportsInputCluster", "supportsOutputCluster", "getInputClusters",
  "getOutputClusters"]);
/** The device's methods a converter may use that send nothing (`getEndpoint` gives a recording endpoint). */
const QUIET_DEVICE = new Set(["getEndpointByDeviceType"]);

/** The options a call carries: its last argument, when that is an object and not the call's own payload. */
function optionsOf(call: string, args: unknown[]): Record<string, unknown> | undefined {
  // command(cluster, command, payload, options); write(cluster, attributes, options); read(cluster, attributes, options)
  const at = call === "command" ? 3 : call === "write" || call === "read" ? 2 : -1;
  const o = at >= 0 ? args[at] : undefined;
  return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
}

/**
 * How herdsman 10.10.0 waits on the call (`Endpoint.zclCommand`, `getOptionsWithDefaults`): a
 * cluster command whose definition names a response waits for it; one that names none waits for a
 * Default Response unless `disableDefaultResponse`; a write waits for its Write Response and a read
 * for its Read Response; `disableResponse` waits for nothing. A command herdsman does not know is
 * `other`, as is every call that is none of the three.
 */
export function answerOf(device: Zh.Device, call: string, cluster: unknown, what: unknown, options: Record<string, unknown> | undefined): Answer {
  if (call !== "command" && call !== "write" && call !== "read") return "other";
  if (options?.disableResponse === true) return "none";
  if (call === "write") return "writeResponse";
  if (call === "read") return "readResponse";
  try {
    const manufacturerCode = typeof options?.manufacturerCode === "number" ? options.manufacturerCode : undefined;
    const c = Zcl.Utils.getCluster(cluster as string | number, manufacturerCode, device.customClusters);
    const command = Zcl.Utils.getClusterCommand(c, what as string | number);
    if (command.response !== undefined) return "response";
    return options?.disableDefaultResponse === true ? "none" : "defaultResponse";
  } catch {
    return "other";
  }
}

/**
 * What a converter writes to a dry device or endpoint, kept on the dry copy: its own assignments, and
 * a copy of herdsman's `meta`, which a converter changes in place (`entity.meta.onLevelSupported =
 * false`). herdsman's model is never written (plan 2c-1 review M3).
 */
function dryWrites<T extends object>(t: T): { set: NonNullable<ProxyHandler<T>["set"]>; read(k: string | symbol): { value: unknown } | undefined } {
  const written = new Map<string | symbol, unknown>();
  return {
    read(k) {
      if (written.has(k)) return { value: written.get(k) };
      if (k !== "meta") return undefined;
      const meta = (Reflect.get(t, k, t) ?? {}) as Record<string, unknown>;
      let copy: unknown;
      try {
        copy = structuredClone(meta);
      } catch {
        copy = { ...meta };
      }
      written.set(k, copy);
      return { value: copy };
    },
    set(_t, k, value) {
      written.set(k, value);
      return true;
    },
  };
}

/**
 * A device and its endpoints as a dry run gives them to a converter: every call that is not plainly
 * quiet is recorded and resolved at once (a read with nothing), never reaching herdsman, and every
 * assignment stays on the dry copy. Their IEEE address reads as `<ieee>~dry`, so that what a
 * converter keeps in its own store, keyed by it (a light's brightness to restore), is never the real
 * device's.
 */
export function dryDevice(device: Zh.Device, calls: Call[]): Zh.Device {
  const endpoints = new Map<Zh.Endpoint, Zh.Endpoint>();
  const record = (call: string, args: unknown[]) => {
    const options = optionsOf(call, args);
    calls.push({ call, cluster: args[0], what: args[1], ...(options ? { options } : {}), answer: answerOf(device, call, args[0], args[1], options) });
    return Promise.resolve(call === "read" ? {} : undefined);
  };
  let proxy: Zh.Device;
  const endpoint = (e: Zh.Endpoint): Zh.Endpoint => {
    let p = endpoints.get(e);
    if (!p) {
      const writes = dryWrites(e);
      p = new Proxy(e, {
        set: writes.set,
        get(t, k) {
          if (k === "getDevice") return () => proxy;
          if (k === "deviceIeeeAddress") return `${t.deviceIeeeAddress}~dry`;
          const w = writes.read(k);
          if (w) return w.value;
          const v = Reflect.get(t, k, t) as unknown;
          // The constructor unbound: converters tell an endpoint from a group by its constructor's name (spike S5).
          if (typeof v !== "function" || k === "constructor") return v;
          if (typeof k === "string" && QUIET_ENDPOINT.has(k)) return (v as (...a: unknown[]) => unknown).bind(t);
          return (...args: unknown[]) => record(String(k), args);
        },
      });
      endpoints.set(e, p);
    }
    return p;
  };
  const writes = dryWrites(device);
  proxy = new Proxy(device, {
    set: writes.set,
    get(t, k) {
      if (k === "getEndpoint") return (id: number) => {
        const e = t.getEndpoint(id);
        return e && endpoint(e);
      };
      if (k === "endpoints") return t.endpoints.map(endpoint);
      if (k === "ieeeAddr") return `${t.ieeeAddr}~dry`;
      const w = writes.read(k);
      if (w) return w.value;
      const v = Reflect.get(t, k, t) as unknown;
      if (typeof v !== "function" || k === "constructor") return v;
      if (typeof k === "string" && QUIET_DEVICE.has(k)) return (v as (...a: unknown[]) => unknown).bind(t);
      return (...args: unknown[]) => record(`device.${String(k)}`, args);
    },
  });
  return proxy;
}

/** The converter a key of a set goes to, as the converters order them: the first whose keys name it, or that names none. */
export function converterFor(definition: Definition, key: string): Tz.Converter | undefined {
  return definition.toZigbee.find((c) => (!c.key || c.key.includes(key)) && !c.endpoints && c.convertSet !== undefined);
}

/** How long a dry run may take before it counts as a throw: a converter that waits on something no recording answers. */
export const DRY_RUN_MS = 2_000;

/** What a dry run of one set found: the calls it made, or why it could not be run. */
export type DryRun = { calls: Call[] } | { threw: string };

/**
 * Runs `convertSet` for `{ [key]: value }` against the dry device's first endpoint. Nothing reaches
 * herdsman: a converter that calls anything but a quiet method is recorded, and its result is that
 * call's record.
 */
export async function dryRun(definition: Definition, device: Zh.Device, key: string, value: unknown): Promise<DryRun> {
  const converter = converterFor(definition, key);
  if (!converter) return { threw: `no converter takes ${key}` };
  const calls: Call[] = [];
  const dry = dryDevice(device, calls);
  const entity = dry.endpoints[0];
  if (!entity) return { threw: "the device has no endpoint" };
  const meta: Tz.Meta = { message: { [key]: value }, device: dry, mapped: definition, options: {}, state: {}, endpoint_name: undefined,
    publish: () => {}, deviceExposesChanged: () => {} };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(converter.convertSet!(entity, key, value, meta)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no end within ${DRY_RUN_MS} ms`)), DRY_RUN_MS);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    return { threw: String((err as Error)?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
  return { calls };
}

/**
 * Whether an action is confirmed by the protocol, from the dry runs of every value tried
 * (*Describing a device*): true when every call waits on an answer, false when one waits on none
 * (a Tuya datapoint, a `disableDefaultResponse` command), and undefined, an action not offered, when
 * a run threw, made no call, or made a call that is none of a command, a write or a read.
 */
export function confirmsOf(runs: DryRun[]): boolean | undefined {
  if (!runs.length) return undefined;
  let confirms = true;
  for (const r of runs) {
    if ("threw" in r || r.calls.length === 0) return undefined;
    for (const c of r.calls) {
      if (c.answer === "other") return undefined;
      if (c.answer === "none") confirms = false;
    }
  }
  return confirms;
}
