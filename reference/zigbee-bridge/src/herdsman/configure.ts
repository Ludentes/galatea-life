import type { Clock } from "@ludentes/galatea-life-test-clock";
import { Zcl } from "zigbee-herdsman";
import type { Definition } from "zigbee-herdsman-converters";
import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { configureVersion } from "./describe.js";
import { lostDetail, statusName } from "./execute.js";
import { type ConfigureMethod, configuring, type Gate } from "./guard.js";
import type { Override, ReportSetUp } from "./overrides.js";

/**
 * Running `configure` (the design, *Running configure*): a definition's `configure` (binds, reporting,
 * reads) runs on the device opened for it (`guard.ts`'s `configuring`), each call through the run's
 * gate, and the run closes when `configure` returns, or after CONFIGURE_MS. Once it succeeded, the
 * definition's version is kept in herdsman's device meta (`meta.configured`, as zigbee2mqtt keeps it),
 * which herdsman's own database persists, so that a restart does not configure again; the freshness
 * bound comes from the reporting it set up (`describe.ts`'s `boundOf`).
 */

/** How long one `configure` may run before its gate closes: each call waits up to CONFIGURE_CALL_MS, and a configure makes a few. */
export const CONFIGURE_MS = 60_000;

/**
 * How long herdsman waits for the answer to one of configure's reporting set-ups and reads, each sent
 * once (`disableRecovery`), instead of herdsman's 10 s and its recovery (a route discovery, a
 * network-address request, the coordinator's association table changed, the frame sent again): on
 * Z-Stack every frame holds the device's place in herdsman's adapter queue until it ends, and an action
 * on the same device waits behind it (plan 2c-3 review I1). A device awake answers within a second or
 * two; a sleeping one is not configured now but at its next message.
 */
export const CONFIGURE_CALL_MS = 5_000;

/** A failed `configure` is tried again at the device's next message, no sooner than this after the last try (the design). */
export const CONFIGURE_RETRY_MS = 600_000;

/**
 * How many times a `configure` that fails is tried at a definition's version in one run of the bridge,
 * as zigbee2mqtt gives up after three: after that, not until the bridge restarts or the device is
 * interviewed again, since every try holds the device's place in herdsman's queue (plan 2c-3 review M4).
 */
export const CONFIGURE_TRIES = 3;

/** How a run of `configure` ended. */
export type Configured =
  /** It succeeded: the version is kept in herdsman's device meta. */
  | { outcome: "configured" }
  /** It needed a call the guard does not open (a write, a command, a bind to a group): it would be refused again. */
  | { outcome: "refused" }
  /** It failed (a sleeping device, a device that refused a reporting set-up), or ran out of time: tried again later. */
  | { outcome: "failed"; detail: string };

/** One call configure made through its gate. */
export interface ConfigureCall {
  call: ConfigureMethod;
  cluster: unknown;
  /** The options herdsman was given (a reporting set-up's and a read's); none for a bind. */
  options?: Record<string, unknown>;
}

/** Where a call's options go: `configureReporting(cluster, items, options)` and `read(cluster, attributes, options)`; a bind has none. */
const OPTIONS_AT: Partial<Record<ConfigureMethod, number>> = { configureReporting: 2, read: 2 };

/**
 * Runs the definition's `configure` on herdsman's own model of the device, opened for it, with the
 * coordinator's endpoint as its binds' target, then the override's own reports (`Override.reports`),
 * each a reporting set-up on the first endpoint that serves its cluster, through the same gate; a
 * report whose cluster no endpoint serves is left out, and gives no bound. The version kept is
 * `configureVersion`'s, so a changed table configures again. Each reporting set-up and read goes with
 * `sendPolicy: "immediate"`, so that herdsman never queues it for a sleeping device to send after the
 * run closed, sent once, and waited for CONFIGURE_CALL_MS at most, whatever the converter gave. A
 * bind is a ZDO request, which takes no options: herdsman sends it as its own. On success the version is written to herdsman's device meta and saved. `calls` gets
 * each call made, in order; `opened` gets the run's gate, which the caller closes to cut the run
 * short (the controller closed): a run cut short has failed, and writes nothing.
 */
export async function runConfigure(definition: Definition, model: Zh.Device, coordinator: Zh.Endpoint,
  o: { clock: Clock; calls?: ConfigureCall[]; opened?(gate: Gate<ConfigureMethod>): void; override?: Override }): Promise<Configured> {
  const reports = o.override?.reports ?? [];
  if (!definition.configure && !reports.length) return { outcome: "configured" };
  const configure = async (device: Zh.Device, coordinatorEndpoint: Zh.Endpoint) => {
    await definition.configure?.(device, coordinatorEndpoint, definition);
    for (const r of reports) await setUp(device, r);
  };
  const gate: Gate<ConfigureMethod> = async (_endpoint, method, args, send) => {
    const a = [...args];
    const at = OPTIONS_AT[method];
    if (at !== undefined) {
      const given = a[at];
      a[at] = { ...(given && typeof given === "object" && !Array.isArray(given) ? given : {}), sendPolicy: "immediate", disableRecovery: true,
        timeout: CONFIGURE_CALL_MS };
    }
    o.calls?.push({ call: method, cluster: a[0], ...(at !== undefined ? { options: a[at] as Record<string, unknown> } : {}) });
    return send(a);
  };
  o.opened?.(gate);
  let handle = 0;
  const late = new Promise<"late">((resolve) => {
    handle = o.clock.setTimeout(() => resolve("late"), CONFIGURE_MS);
  });
  let ended: "late" | { error: unknown } | undefined;
  let cut = false;
  try {
    // A configure that throws at once fails as one that rejects.
    const run = Promise.resolve().then(() => configure(configuring(model, gate), configuring(coordinator, gate)))
      .then(() => undefined, (error: unknown) => ({ error }));
    ended = await Promise.race([run, late]);
  } finally {
    o.clock.clear(handle);
    cut = gate.closed === true;
    // The run ends with configure's return: nothing it sends later reaches herdsman.
    gate.closed = true;
  }
  if (cut) return { outcome: "failed", detail: "the controller closed while configure ran" };
  if (gate.refused) return { outcome: "refused" };
  if (ended === "late") return { outcome: "failed", detail: `configure did not end within ${CONFIGURE_MS} ms` };
  if (ended) return { outcome: "failed", detail: failureOf(ended.error) };
  model.meta.configured = configureVersion(definition, o.override);
  model.save();
  return { outcome: "configured" };
}

/** One of the override's reports, set up on the first endpoint (of the device opened for the run) that serves its cluster. */
async function setUp(device: Zh.Device, r: ReportSetUp): Promise<void> {
  const ep = device.endpoints.find((e) => e.supportsInputCluster(r.cluster));
  if (!ep) {
    console.error(`zigbee: ${device.ieeeAddr}: no endpoint serves ${r.cluster}: its report is not set up, and gives no bound`);
    return;
  }
  // herdsman takes the attribute by name, as the converters' own reporting helpers give it.
  await ep.configureReporting(r.cluster, [{ attribute: r.attribute as never, minimumReportInterval: r.minimumReportInterval,
    maximumReportInterval: r.maximumReportInterval, reportableChange: r.reportableChange }]);
}

/** Why configure failed, never in herdsman's words (spike S8): a ZCL status by its name, else the doer's own text. */
function failureOf(error: unknown): string {
  if (error instanceof Zcl.StatusError) return `the device answered ${statusName(error.code)}`;
  return lostDetail(error);
}
