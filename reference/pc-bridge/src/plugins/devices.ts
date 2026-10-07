import type { OtherAdmin } from "../state-store.js";
import type { ManifestDevice } from "./manifest.js";
import { currentVersion, deviceIdOf, type InstalledVersion, type PluginsState } from "./record.js";
import type { DeviceView } from "./server.js";

const wireTime = (ms: number) => new Date(ms).toISOString();

/** The computer a plugin device is hosted by, as the bridge declares it. */
export interface HostComputer {
  id: string;
  stableIdentifier: string;
  transport: string;
}

/** Keys the applier's standard declares `personal` on every device that reports them, a plugin device included. */
const PERSONAL_SENSORS = ["app", "camera_in_use", "microphone_in_use"];
/** Keys the applier's standard declares `self_changing` on a player. */
const PLAYER_SELF_CHANGING = ["playing", "title", "started_at"];

/** One installed version's device, with what its entry needs. */
export interface PluginDevice {
  id: string;
  plugin: string;
  version: string;
  key: string;
  installed: InstalledVersion;
  declared: ManifestDevice;
  stagedFor?: string;
}

/**
 * Every device of every installed version, by id: a version other than its plugin's current one
 * is staged, each of its devices whose key the current version has naming that device in
 * `stagedFor`; and after a swap, each device of the current version whose key the version it
 * replaced had keeps `stagedFor` naming the device it replaced (GA-BRIDGE-69).
 */
export function pluginDevices(state: PluginsState): PluginDevice[] {
  const out: PluginDevice[] = [];
  for (const [plugin, p] of Object.entries(state.installed)) {
    const current = currentVersion(p);
    const currentKeys = new Set(current ? p.versions[current]!.manifest.devices.map((d) => d.key) : []);
    for (const [version, v] of Object.entries(p.versions)) {
      for (const d of v.manifest.devices) {
        const staged = version !== current && currentKeys.has(d.key);
        const kept = version === current && p.replaced?.keys.includes(d.key);
        const stagedFor = staged ? deviceIdOf(plugin, current!, d.key) : kept ? deviceIdOf(plugin, p.replaced!.version, d.key) : undefined;
        out.push({ id: deviceIdOf(plugin, version, d.key), plugin, version, key: d.key, installed: v, declared: d,
          ...(stagedFor ? { stagedFor } : {}) });
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const same = (a: OtherAdmin, b: OtherAdmin) => a.vendor === b.vendor && a.label === b.label;

/**
 * A plugin device's `otherAdmins` (GA-BRIDGE-53): the computer's administrators; the account its
 * plugin runs as, unless listed already or its token retired (a deleted account runs nothing); and
 * each entry of the manifest's `otherAdmins`, the app's own network control. Never `ungoverned`.
 */
export function pluginAdmins(admins: OtherAdmin[], v: InstalledVersion, held: (token: string) => boolean): OtherAdmin[] {
  const out = [...admins];
  const account = { vendor: "os", label: v.account };
  if (held(v.account) && !out.some((a) => same(a, account))) out.push(account);
  for (const a of v.manifest.otherAdmins ?? []) if (!out.some((x) => same(x, a))) out.push({ vendor: a.vendor, label: a.label });
  return out;
}

/** The accounts of plugins that declare `needsSession`, whose servers run in the account's session: the computer lists them too (GA-BRIDGE-53). */
export function sessionAccounts(state: PluginsState, held: (token: string) => boolean): string[] {
  const out = new Set<string>();
  for (const p of Object.values(state.installed)) {
    for (const v of Object.values(p.versions)) if (v.manifest.needsSession === true && held(v.account)) out.add(v.account);
  }
  return [...out].sort();
}

/**
 * A plugin device's entry in `devices` (*Plugin devices*, GA-BRIDGE-38, GA-BRIDGE-69): hosted by the
 * computer, on its transport, `stableIdentifier` `<computer>/<plugin id>/<key>`; the fixed
 * `feedback: closed`, `reachMs` 0, `model` `{ vendor: <plugin id>, model: <key> }` and
 * `classEvidence: none`; the manifest's declarations, each action with its tool's hash and no tool
 * name; `personal` and `selfChanging` with the declarations the applier's standard makes; the
 * extensions whose capability the device lists; and `stagedFor` on a staged device.
 */
export function pluginEntry(d: PluginDevice, computer: HostComputer, otherAdmins: OtherAdmin[]): Record<string, unknown> {
  const m = d.installed.manifest;
  const dec = d.declared;
  const union = (declared: string[] | undefined, standard: string[]) => [...new Set([...(declared ?? []), ...standard])];
  const personal = union(dec.personal, PERSONAL_SENSORS.filter((k) => dec.sensorKeys.includes(k)));
  const selfChanging = union(dec.selfChanging, dec.proposedClass === "player" ? PLAYER_SELF_CHANGING : []);
  return {
    id: d.id,
    stableIdentifier: `${computer.stableIdentifier}/${d.plugin}/${d.key}`,
    transport: computer.transport,
    host: computer.id,
    plugin: d.plugin,
    version: d.version,
    model: { vendor: d.plugin, model: d.key },
    capabilities: dec.capabilities,
    sensorKeys: dec.sensorKeys,
    actions: dec.actions.map(({ tool, ...a }) => ({ ...a, toolHash: m.toolHashes[tool] })),
    feedback: "closed",
    reachMs: 0,
    proposedClass: dec.proposedClass,
    classEvidence: "none",
    otherAdmins,
    personal,
    selfChanging,
    extensions: (m.extensions ?? []).filter((e) => dec.capabilities.includes(e.capability)),
    ...(d.stagedFor ? { stagedFor: d.stagedFor } : {}),
  };
}

/** A plugin device as the roster shows it: its last successful state read, and whether it is observable, since when. */
export interface Observation {
  lastCheckIn: number | null;
  observable: boolean;
  since: number;
}

/**
 * A plugin device's roster entry (GA-BRIDGE-13): polled at its manifest's cadence, its bound three
 * times that; its last check-in its last successful state read in this instance (the host's
 * `observation`); observable while its server serves and that read is within the bound.
 */
export function pluginRoster(d: PluginDevice, transport: string, o: Observation): Record<string, unknown> {
  const at = o.lastCheckIn !== null ? wireTime(o.lastCheckIn) : null;
  return {
    id: d.id, transport, basis: "poll", cadenceMs: d.declared.cadenceMs, basisMaxAgeMs: 3 * d.declared.cadenceMs,
    timestamp: at, lastCheckIn: at, observable: o.observable, since: wireTime(o.since),
  };
}

/**
 * A plugin device's retained status (*State*): while its server serves, `available: true` with
 * its readings, `timestamp` the read they came from (or the serving, before its first); once it
 * cannot serve, `available: false` since then; a version not run, `available: false` at its
 * install. Never restamped but by a read: a re-publish carries the same time.
 */
export function pluginStatus(d: PluginDevice, view: DeviceView): Record<string, unknown> {
  if (view?.available) return { deviceId: d.id, timestamp: wireTime(view.at), available: true, ...view.values };
  if (view) return { deviceId: d.id, timestamp: wireTime(view.at), available: false };
  return { deviceId: d.id, timestamp: d.installed.installedAt, available: false };
}

/** One `account_deleted` entry per device of a version whose account's token was retired (GA-BRIDGE-67). */
export function accountFaults(devices: PluginDevice[], retired: (token: string) => boolean): { code: string; device: string; detail: string }[] {
  return devices.filter((d) => retired(d.installed.account))
    .map((d) => ({ code: "account_deleted", device: d.id, detail: `${d.installed.account}'s account was deleted` }));
}
