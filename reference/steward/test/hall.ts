import { FakeClock } from "./fake-clock.js";
import { SECRETS, up } from "./house.js";
import { DEVICES, setup } from "./setup.js";

type Body = Record<string, any>;

export const MOTION = "sim-bridge:motion";
export const PLUG = "sim-bridge:plug";
export const LOOSE = "sim-bridge:loose";
export const FAN = "sim-bridge:fan";
export const sensor = (id: string, key: string) => ({ id, label: id, class: "sensor", capabilities: ["sensor"], sensor_keys: [key], adopted: true,
  fresh_s: 60, fresh_slack_s: 11, actions: [] });
export const PLUG_DEVICE = { id: PLUG, label: "plug", class: "socket", capabilities: ["onoff", "sensor"], sensor_keys: ["power"], adopted: true,
  actions: [{ action: "onoff.turn_on", tier: "reversible" }, { action: "onoff.turn_off", tier: "reversible" }] };
export const LOOSE_DEVICE = { id: LOOSE, label: "loose", class: "light", capabilities: ["onoff"], adopted: false,
  actions: [{ action: "onoff.turn_on", tier: "reversible" }] };
/** A fan whose power code toggles, on a closed-loop device: its `turn_off` has direction other (GA-LEASE-7). */
export const FAN_DEVICE = { id: FAN, label: "fan", class: "socket", capabilities: ["onoff"], adopted: true,
  actions: [{ action: "onoff.turn_off", tier: "reversible", toggles: true }] };
export const HALL_DEVICES = [...DEVICES, sensor(MOTION, "motion"), PLUG_DEVICE, LOOSE_DEVICE, FAN_DEVICE];

export const iso = (ms: number) => new Date(ms).toISOString();
/** The applier's `state` with the hall's motion sensor live and reading `motion` as of `at`. */
export const hallState = (motion: boolean, at: number) => ({ targets: { [MOTION]: { values: [{ key: "motion", value: motion, basis_time: iso(at) }],
  liveness: "live", fresh_s: 60, fresh_basis: "declared" } }, transports: [], latches: [] });

/**
 * The furnished house with a live motion sensor in the hall beside the lamp; the plug, the fan and a
 * loose lamp roomless, and `extraDevices` beside them. The devices and the sensor's state go to `setup` (R-9): with `sync: false` the
 * steward is handed neither state until the test reads its gap; with `define: false` (a restart over a
 * kept store) the hall is as the store keeps it.
 */
export async function hall(o: Parameters<typeof setup>[0] & { extraDevices?: Body[] } = {}) {
  const clock = o.clock ?? new FakeClock();
  const t = await setup({ ...o, clock, devices: [...(o.devices ?? HALL_DEVICES), ...(o.extraDevices ?? [])], state: o.state ?? hallState(false, clock.now()) });
  if (o.define !== false) await t.define([up("target", { id: MOTION, room: "hall" })]);
  const at = () => iso(t.clock.now());
  const motion = async (v: boolean) => {
    t.applier.emit({ type: "state", target: MOTION, key: "motion", value: v, cause: "device", time: at() });
    await t.pump();
  };
  const outside = async (target: string, k: string, value: unknown, cause = "external") => {
    t.applier.emit({ type: "state", target, key: k, value, cause, time: at() });
    await t.pump();
  };
  const leases = async () => (await t.ok(SECRETS.owner, "state")).leases as Body;
  return { ...t, motion, outside, leases, at };
}
