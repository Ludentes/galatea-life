import { createHash } from "node:crypto";
import { validate } from "@ludentes/galatea-life-schemas";
import type { Bridge, Config } from "../config/config.js";
import { loadIn, tierIn, type DeviceInfo, type Effects, type Routed } from "../config/configure.js";
import { canonical, storable } from "../core/canonical.js";
import { sets } from "../gate/actions.js";
import type { Mutation } from "../mutations.js";
import { BridgeRules, SKEW_MS, type Outcome } from "../bus/bridge-rules.js";
import {
  parseAck, parseDevices, parseDeviceStatus, parseEvent, parseStatus, parseTime,
  type Ack, type BridgeEvent, type BridgeFault, type ConfirmedBy, type DeviceDoc, type Protocol, type RosterFacts, type TransportFacts,
} from "../bus/wire.js";
import type { GateDevice } from "../gate/plan.js";
import { FRESH_SLACK_S, liveness, type Liveness } from "../state/liveness.js";
import {
  DEFAULT_MAX_ON_S, defaultAckWithinS, mayBeIdempotent, standardKeys, statelessOf, union, type Declarations, type Tier,
} from "./declarations.js";

export { canonical };

/**
 * A device the applier holds: its id, the bridge device it maps to, and the bridge's last word on it.
 * `into` marks a copy folded into another device (GA-BUS-11): the same hardware, reported by another
 * bridge, held under an id of its own but exposed only as the device `into` names.
 */
export type HeldDevice = { id: string; bridge: string; bridge_device: string; doc: DeviceDoc; into?: string };
/** A transport of the model: its id, the bridge's own id for it, and its kind. Whether it is up is state, not kept. */
export type HeldTransport = { id: string; bridge: string; bridge_transport: string; kind: Protocol };
/**
 * One device's or transport's `connections` as its bridge last gave them (slice 5b): the keys by which
 * the finder can hear it, kept per registered bridge, apart from the model.
 */
export type ConnectionRow = { kind: "device" | "transport"; entity: string; keys: string[] };

type Value = { value: string | number | boolean; basis: number };
/** What a bridge said of one of its devices, kept by the bridge's own id, whether or not it is in the model yet. */
type DeviceFacts = {
  values: Map<string, Value>;
  unavailable: boolean;
  cleared: boolean;
  /** A reading stamped ahead of the applier's clock, until a correctly stamped report of the device (GA-BUS-2). */
  fast: boolean;
};

type BridgeView = {
  config: Bridge;
  rules: BridgeRules;
  transports: Map<string, TransportFacts>;
  roster: Map<string, RosterFacts>;
  /** Ids in the latest roster, dropped entries included; undefined before the first status. */
  rosterListed?: Set<string>;
  /** Ids in the latest `devices` document, dropped entries included; undefined before the first. */
  docListed?: Set<string>;
  /** Ids in the latest well-formed `transports` list of its status; undefined before the first in this life. */
  statusTransports?: Set<string>;
  facts: Map<string, DeviceFacts>;
  /** Devices whose latest check-in was stamped ahead of the applier's clock. */
  fastCheckIn: Set<string>;
  /** The faults now standing, by source: each is raised once, and again only after it cleared. */
  standing: Map<string, Set<string>>;
  /** The keys of the device-fault notices its `faults` now hold (GA-BUS-12). */
  deviceFaults: Set<string>;
  /** Whether a `devices` document was heard from it in this life. */
  heardDevices: boolean;
  /** Until when a `devices` document is the answer to the applier's `snapshot` (GA-BUS-6). */
  snapshotUntil?: number;
  /**
   * The ways its doer changes a device unseen, from its latest status taken (GA-BRIDGE-32): the
   * applier's own for GA-DESC-6. Kept while the bridge is dead, since its doer may run on.
   */
  ungoverned: string[];
  /** The levels its latest status taken claims (bridge, *Conformance levels*), live or retained; none before one. */
  levels: string[];
  /** The `bridgeType` its latest status taken gives, if any. */
  bridge_type?: string;
};

/** The bridge event types that are one `provision` event each (the design, *The `provision` event*); `interviewed` is not one. */
export const PROVISION_EVENTS = new Set(["joined", "left", "window_closed", "commissioned", "commission_failed", "connected",
  "connect_failed", "blocked_rejoin"]);

/** What provisioning reads of a registered bridge: alive, its claimed levels and type, and its identity on the bus. */
export type BridgeFacts = { alive: boolean; levels: string[]; bridge_type?: string; identity: string };

/** What the owner configured that the home reads: adoptions, declarations, and each device's replaced identifiers. */
export type Owner = Pick<Config, "adoptions" | "declarations" | "safe"> & { previous?: ReadonlyMap<string, string[]>;
  routes?: ReadonlyMap<string, string> };

/** A notice the home asks for: `notice_id` is the applier's to give. */
export type NoticeAsk = { cause: string; devices?: string[]; text: string };

/**
 * An action's declarations on `doc`, hashed (GA-DESC-18): what the action does and how a step of it is
 * judged and acked. These wire fields, a fixed list under a version tag so that a later build parsing
 * more of a document moves no fingerprint: the action's entry (idempotent, stateless, toggles,
 * whole_state, confirms, args, confirmed_by), its extension schema, the key it sets (its extension
 * kind and schema, and whether the bridge marks it personal or self-changing), and the device's
 * feedback and reach. A description, another key or another action changes none of it.
 */
export function fingerprintOf(doc: DeviceDoc, action: string): string {
  const a = doc.actions.find((x) => x.action === action);
  const key = a && sets(action, {}, a.confirmed_by)?.key;
  const ext = doc.extensions?.flatMap((e) => e.actions).find((x) => x.action === action);
  const extKey = key === undefined ? undefined : doc.extensions?.flatMap((e) => e.keys).find((k) => k.key === key);
  return createHash("sha256").update(canonical({ v: 1,
    action: a ? { idempotent: a.idempotent, stateless: a.stateless, toggles: a.toggles, whole_state: a.whole_state, confirms: a.confirms,
      args: a.args ?? null, confirmed_by: a.confirmed_by ?? null } : null,
    schema: ext?.schema ?? null,
    key: key === undefined ? null : { key, kind: extKey?.kind ?? null, schema: extKey?.schema ?? null,
      personal: doc.personal.includes(key), self_changing: doc.self_changing.includes(key) },
    feedback: doc.feedback, reach_ms: doc.reach_ms ?? null })).digest("hex").slice(0, 32);
}

export interface HomeHooks {
  /** Serves an event (and hands it to the writer); `eventsOnly`, never in `history` (GA-EVT-5). */
  emit(type: string, body: Record<string, unknown>, keep?: { eventsOnly?: boolean }): void;
  /**
   * Devices appeared or changed in a bridge's `devices`, or transports appeared or changed their
   * kind in its `status`: a model change, written behind.
   */
  modelChanged(devices: HeldDevice[], transports: HeldTransport[]): void;
  /** Transports left the model: no device names them, and their bridge lists them no more. A model change, written behind. */
  transportsGone(transports: HeldTransport[]): void;
  /** Devices whose document changed only in its state (`other_admins`): written behind, no model change (GA-DESC-2). */
  factsChanged(devices: HeldDevice[]): void;
  /** Asks a bridge for a snapshot (GA-BUS-6); the bus sends it if it can. */
  snapshot(bridge: Bridge): void;
  /** Raises a notice; with a `key`, once while it stands. */
  notice(n: NoticeAsk, key?: string): void;
  /** What `key` said has cleared. */
  clearNotice(key: string): void;
  /** A later notice replaces those raised with `key`: the untaken ones go, and the key no longer stands. */
  withdrawNotice(key: string): void;
  /** The notice keys standing under `prefix`, as the store kept them across a restart. */
  standingNotices(prefix: string): string[];
  log(line: string): void;
  /**
   * An ack on `devices/{device}/ack` of `bridge`, its `source` that bridge's: the step that command
   * went out for takes it. Returns the bridge's faults it is (a `sent` it could not give, an ack on
   * another device's topic).
   */
  ack?(bridge: string, device: string, ack: Ack): string[];
  /**
   * A reading of an exposed device, `changed` when it moved from `old`: a waiting step may take it
   * as its ack, and the cause of a change is the apply it moves towards, `own` when the key is the
   * one that apply's action sets (GA-EVT-1, GA-EVT-6); undefined when no apply claims it.
   */
  reading?(target: string, key: string, value: unknown, old: unknown, basis: number, changed: boolean):
    { cause: Record<string, unknown> | string; own: boolean } | undefined;
  /** A bridge alive until now was found dead: a closed device's step waiting on it ends at once (GA-APPLY-8). */
  bridgeDead?(bridge: string, planned: boolean): void;
  /** A device's effective bound changed, or became known: a `freshness` event (GA-SAFE-10 reads it). */
  boundChanged?(id: string): void;
  /** The `ungoverned` paths a registered bridge declares changed: `describe` changes with them (GA-DESC-6), a model change. */
  ungovernedChanged?(bridge: string): void;
  /**
   * Readings of an exposed device taken, each with its `basis_time`, a fast clock's left out (GA-BUS-2):
   * a safety rule reading one fires on a new one, whatever the device's liveness (GA-SAFE-11).
   */
  reported?(target: string, readings: { key: string; basis: number }[]): void;
  /**
   * Devices whose declarations a bridge's `devices` document changed, once the model holds the new
   * ones: a safety rule that no longer fits them is disabled (GA-SAFE-13).
   */
  declared?(ids: string[]): void;
  /** An exposed device's liveness verdict changed (applier, *State and liveness*): a latch reading it may clear (GA-SAFE-7). */
  livenessChanged?(id: string, old: Liveness, next: Liveness): void;
  /**
   * The safety rules that actuate `id` without `accepts_other_admins`: an admin added to it leaves them
   * running, and its notice says their latch no longer binds that admin (applier, *Other admins*).
   */
  unaccepting?(id: string): string[];
  /** A bridge's `devices` document is held, its devices and their admins with it: the broker's host may have changed (GA-SAFE-6). */
  held?(): void;
  /**
   * A bridge's `reply` with a string `requestId`, offered first whatever its `op` (slice 5a's
   * provisioning): true when the hook holds that request, and the reply is then its alone.
   */
  reply?(bridge: string, body: Record<string, unknown>): boolean;
  /** A bridge event in `PROVISION_EVENTS`, taken once by its `seq` (slice 5a's provisioning). */
  provisioning?(bridge: string, e: BridgeEvent): void;
  /**
   * A bridge's connections changed (slice 5b): all its rows now, none once it is no longer registered.
   * Written behind and droppable (the maintainer's ruling K5); never a model change.
   */
  connectionsChanged?(bridge: string, rows: ConnectionRow[]): void;
}

/** What dispatch reads of a device for one of its actions (applier, *Apply and outcomes*). */
export type DispatchTarget = {
  bridge: Bridge;
  bridge_device: string;
  feedback: "open" | "closed";
  stateless: boolean;
  confirms: boolean;
  /** The action's effective `idempotent` (GA-DESC-4): only such an action is ever reissued (GA-APPLY-6). */
  idempotent: boolean;
  /** Whether its code carries the device's whole state, so its command carries the assumed state (GA-APPLY-16). */
  whole_state: boolean;
  ack_within_s: number;
  /** Whether its `notify` lists `from` among its args (GA-APPLY-14). */
  from: boolean;
  /** A stateful extension action's key and value that confirm it (GA-EVT-3). */
  confirmed_by?: ConfirmedBy;
};

/** The applier's id for a bridge's device: `{bridge id}:{bridge device id}`, never the device id alone (lesson 12). */
export const deviceId = (bridge: string, device: string) => `${bridge}:${device}`;
/** The longest id the applier gives (applier, *Identifiers and revision*): a bridge's own id may fill it, so `{bridge}:{id}` may not. */
export const MAX_ID = 128;

/** How many device topics of one bridge, listed nowhere, the home keeps facts for (a bridge publishing on bogus ids). */
export const MAX_UNLISTED = 1024;
/** A device fault's `code` is kept to this many characters in its notice and key. */
export const MAX_FAULT_CODE = 128;
/** At most this many device-fault notices of one bridge stand at once. */
export const MAX_DEVICE_FAULTS = 64;
/** How long after asking for a snapshot a `devices` document counts as its answer: the request's expiry. */
const SNAPSHOT_ANSWER_MS = 10_000;

/**
 * The home as the bridges report it: each registered bridge's liveness and facts, and the devices
 * of the model. Every method is one step: synchronous, in memory, and it hands what must be kept
 * to its hooks. A message that throws is a `bridge_fault`, never an exit (design, *Error handling*).
 */
export class Home {
  readonly devices = new Map<string, HeldDevice>();
  /**
   * The id map (the bridge standard, *Ids*): each bridge's own device ids to the applier's. A device
   * new to the model gets `{bridge}:{device}`; a replacement re-points an id at other hardware, so
   * the map, not the formula, says which id a bridge device has. Kept in the store as `devices`.
   */
  private readonly ids = new Map<string, Map<string, string>>();
  /** The last list of other admins each device showed, kept across an `unknown`, so an admin is added only once. */
  private readonly lastAdmins = new Map<string, { vendor: string; label: string }[]>();
  /** Adopted devices judged for a second door before the model held them: judged when their document arrives. */
  private readonly unjudged = new Set<string>();
  /** Each identifier whose `route_conflict` has been told, with the bridges it named, until the conflict ends. */
  private readonly conflicted = new Map<string, string>();
  /** The transports of the model, by id, kept across a restart and a bridge's removal. */
  private readonly modelTransports = new Map<string, HeldTransport>();
  private readonly bridges = new Map<string, BridgeView>();
  private readonly verdicts = new Map<string, Liveness>();
  /** The bridges alive at the last step, so one found dead is told once (GA-APPLY-8). */
  private readonly aliveBridges = new Set<string>();
  /** Each device's effective bound as last reported, once its first is known in this life. */
  private readonly bounds = new Map<string, string>();
  private brokerUp = false;
  /** The owner's adoptions and declarations, as last committed. */
  private owner: Owner = { adoptions: new Map(), declarations: new Map() };
  /** Each bridge's connections, by `{kind}\u0000{entity}` (slice 5b): kept across a restart, apart from the model. */
  private readonly conns = new Map<string, Map<string, ConnectionRow>>();

  constructor(private readonly now: () => number, private readonly hooks: HomeHooks, private readonly mutation?: Mutation) {}

  /**
   * The devices and transports kept in the store, as a start finds them: the devices dead and the
   * transports down until their bridges are heard.
   */
  load(devices: HeldDevice[], transports: HeldTransport[] = []): void {
    for (const d of devices) {
      this.hold(d);
      this.verdicts.set(d.id, "dead");
    }
    for (const t of transports) this.modelTransports.set(t.id, t);
  }

  /** The connections the store kept, as a start finds them (slice 5b). */
  loadConnections(rows: { bridge: string; kind: string; entity: string; keys: string[] }[]): void {
    for (const r of rows) {
      if ((r.kind !== "device" && r.kind !== "transport") || !Array.isArray(r.keys)) continue;
      const m = this.conns.get(r.bridge) ?? new Map<string, ConnectionRow>();
      m.set(`${r.kind}\u0000${r.entity}`, { kind: r.kind, entity: r.entity, keys: r.keys.filter((k) => typeof k === "string") });
      this.conns.set(r.bridge, m);
    }
  }

  /** Each bridge's connections as last seen, live or dead, kept across a restart (GA-DISC-2). */
  connections(): Map<string, ConnectionRow[]> {
    return new Map([...this.conns].map(([b, m]) => [b, [...m.values()].map((r) => ({ ...r, keys: [...r.keys] }))]));
  }

  /**
   * Replaces a bridge's rows of `kind`: `given` names each entity's keys now (none drops its row), and
   * `keep`, when set, the entities of that kind whose rows stay as they are; every other row of that
   * kind goes. A change is handed to the writer behind (the maintainer's ruling K5) and moves no revision.
   */
  private takeConnections(bridge: string, kind: ConnectionRow["kind"], given: Map<string, string[]>, keep?: Set<string>): void {
    const m = this.conns.get(bridge) ?? new Map<string, ConnectionRow>();
    const before = JSON.stringify([...m.entries()].sort());
    for (const [k, r] of [...m]) if (r.kind === kind && !given.has(r.entity) && !keep?.has(r.entity)) m.delete(k);
    for (const [entity, keys] of given) {
      if (keys.length) m.set(`${kind}\u0000${entity}`, { kind, entity, keys: [...keys] });
      else m.delete(`${kind}\u0000${entity}`);
    }
    if (m.size) this.conns.set(bridge, m);
    else this.conns.delete(bridge);
    if (JSON.stringify([...m.entries()].sort()) === before || !this.hooks.connectionsChanged) return;
    const hook = this.hooks.connectionsChanged;
    this.hook("connectionsChanged", () => hook(bridge, [...m.values()]));
  }

  /**
   * The registered bridges changed: new ones are watched, removed ones forgotten (their devices stay,
   * dead, until the owner forgets them; the transports they name stay listed, down).
   */
  follow(bridges: Map<string, Bridge>): void {
    for (const [id, view] of this.bridges) {
      const b = bridges.get(id);
      if (!b || b.identity !== view.config.identity) {
        this.bridges.delete(id);
        // A bridge no longer registered holds nothing the finder hears: its connections go (slice 5b).
        if (!b && this.conns.has(id)) {
          this.conns.delete(id);
          if (this.hooks.connectionsChanged) {
            const hook = this.hooks.connectionsChanged;
            this.hook("connectionsChanged", () => hook(id, []));
          }
        }
        if (view.ungoverned.length && this.hooks.ungovernedChanged) this.hook("ungovernedChanged", () => this.hooks.ungovernedChanged!(id));
      }
    }
    for (const [id, b] of bridges) {
      if (!this.bridges.has(id)) {
        const kept = [...this.modelTransports.values()].filter((t) => t.bridge === id)
          .map((t): [string, TransportFacts] => [t.bridge_transport, { id: t.bridge_transport, kind: t.kind, state: "down" }]);
        this.bridges.set(id, { config: b, rules: this.rules(b), transports: new Map(kept), roster: new Map(),
          facts: new Map(), fastCheckIn: new Set(), standing: new Map(),
          deviceFaults: new Set(this.hooks.standingNotices(faultPrefix(id))), heardDevices: false, ungoverned: [], levels: [] });
      }
    }
    this.pruneTransports();
    this.reverdict();
  }

  /**
   * A transport leaves the model once no device names it and its bridge lists it no more: its bridge
   * is not registered, or its latest status's well-formed list omits it. Until then `describe` lists
   * it, so no device's `transport` names nothing.
   */
  private pruneTransports(): void {
    const named = new Set([...this.devices.values()].map((d) => `${d.bridge}\u0000${d.doc.transport}`));
    const gone = [...this.modelTransports.values()].filter((t) => {
      if (named.has(`${t.bridge}\u0000${t.bridge_transport}`)) return false;
      const v = this.bridges.get(t.bridge);
      return !v || (v.statusTransports !== undefined && !v.statusTransports.has(t.bridge_transport));
    });
    if (!gone.length || !this.hook("transportsGone", () => this.hooks.transportsGone(gone))) return;
    for (const t of gone) {
      this.modelTransports.delete(t.id);
      this.bridges.get(t.bridge)?.transports.delete(t.bridge_transport);
    }
  }

  private rules(b: Bridge): BridgeRules {
    return new BridgeRules(b.identity, this.now(), {
      trustsRetained: this.mutation === "trusts-retained-online",
      takesBadStatus: this.mutation === "plans-for-a-faulted-bridge",
      ignoresGaps: this.mutation === "ignores-seq-gap",
      trustsFastClock: this.mutation === "trusts-a-fast-clock",
    });
  }

  /** The applier's id for a bridge's device, once the model holds it. */
  idOf(bridge: string, device: string): string | undefined {
    return this.ids.get(bridge)?.get(device);
  }

  /**
   * The applier's id for a bridge's device: the model's, or the one the id map would give it now if
   * it joined, without holding it (a `provision` event naming a device not modelled yet).
   */
  idFor(bridge: string, device: string): string {
    return this.idOf(bridge, device) ?? this.mint(bridge, device);
  }

  /** A registered bridge's facts for provisioning, from its latest status taken; undefined when it is not registered. */
  bridgeFacts(id: string): BridgeFacts | undefined {
    const v = this.bridges.get(id);
    if (!v) return undefined;
    return { alive: this.brokerUp && v.rules.alive, levels: [...v.levels], ...(v.bridge_type !== undefined ? { bridge_type: v.bridge_type } : {}),
      identity: v.config.identity };
  }

  /** A transport of the model by the applier's id. */
  transportHeld(id: string): HeldTransport | undefined {
    return this.modelTransports.get(id);
  }

  /** A device of the model by the applier's id, the copy that carries it: never one folded into another. */
  deviceAt(id: string): HeldDevice | undefined {
    const d = this.devices.get(id);
    return d && d.into === undefined ? d : undefined;
  }

  private heldAt(v: BridgeView, device: string): HeldDevice | undefined {
    const id = this.idOf(v.config.id, device);
    return id === undefined ? undefined : this.devices.get(id);
  }

  /** Puts a device in the model and the id map. */
  private hold(d: HeldDevice): void {
    this.devices.set(d.id, d);
    let m = this.ids.get(d.bridge);
    if (!m) this.ids.set(d.bridge, m = new Map());
    m.set(d.bridge_device, d.id);
  }

  /**
   * An id for a bridge's device new to the model: `{bridge}:{device}`, or, where a replacement gave
   * that id to other hardware, the first free `{bridge}:{device}/{n}`. A bridge's device id never
   * holds `/`, so a minted id is never another device's `{bridge}:{device}`.
   */
  private mint(bridge: string, device: string): string {
    const base = deviceId(bridge, device);
    if (!this.devices.has(base)) return base;
    for (let n = 2; ; n++) if (!this.devices.has(`${base}/${n}`)) return `${base}/${n}`;
  }

  /**
   * The owner's configuration changed (committed): the devices it forgot leave the model, the ids it
   * re-pointed follow their new hardware, and verdicts and bounds follow at once. Returns the forgets
   * that did not take, since their bridge listed the device again.
   */
  setOwner(owner: Owner, effects: Effects = { forgotten: [], replaced: [], routed: [] }, placed: HeldDevice[] = []): string[] {
    const kept = this.forget(effects.forgotten);
    for (const r of effects.replaced) this.repoint(r.device, r.replaces);
    this.place(placed);
    const unadopted = [...this.owner.adoptions.keys()].filter((id) => !owner.adoptions.has(id));
    // A device no longer adopted owes no `other_admin` notice, and a later adoption says its open loop again.
    for (const id of this.owner.adoptions.keys()) {
      if (owner.adoptions.has(id)) continue;
      this.hook("clearNotice", () => {
        this.hooks.clearNotice(adminKey(id));
        this.hooks.clearNotice(openLoopKey(id));
      });
    }
    this.owner = owner;
    // Only a change that took devices away can leave a transport named by none; at start, the bridges are not followed yet.
    if (effects.forgotten.length || effects.replaced.length || effects.routed.length || unadopted.length) {
      this.pruneTransports();
      this.settleFolds();
      this.refold();
      this.settleConflicts();
    }
    this.reverdict();
    return kept;
  }

  /** The devices the model exposes: every device it holds but the copies folded into another (GA-BUS-11). */
  exposed(): HeldDevice[] {
    return [...this.devices.values()].filter((d) => d.into === undefined);
  }

  /** The copies folded into `id`. */
  private copiesOf(id: string): HeldDevice[] {
    return [...this.devices.values()].filter((d) => d.into === id);
  }

  /**
   * The device a copy newly showing `sid` on `bridge` folds into (GA-BUS-11): the one exposed device
   * another bridge reports with it, when it is not adopted, and nothing shows it on `bridge` itself
   * (hardware admitted anew there, GA-BRIDGE-35). An adopted device keeps its bridge: beside it the
   * copy is a device of its own. `id` is the copy's own; an adopted copy never folds.
   */
  private host(bridge: string, id: string, sid: string, twice = false): string | undefined {
    if (this.owner.adoptions.has(id) || this.mutation === "merges-a-claimant") return undefined;
    const same = [...this.devices.values()].filter((d) => d.id !== id && d.doc.stable_identifier === sid);
    // `twice`: the arriving document itself shows `sid` more than once.
    if (twice || same.some((d) => d.bridge === bridge)) return undefined;
    const shown = same.filter((d) => d.into === undefined);
    if (shown.length !== 1 || this.owner.adoptions.has(shown[0]!.id)) return undefined;
    return shown[0]!.id;
  }

  /**
   * The rows a route leaves (GA-BUS-11): `r.device` takes the copy on `r.bridge`, the hardware it had
   * becomes a copy folded into it under the id that copy had, and every other bridge's exposed copy
   * folds into it too. Pure: `configure` writes these rows, then `setOwner` places the same.
   */
  routeRows(r: Routed): HeldDevice[] {
    const p = this.devices.get(r.device);
    // An adopted device keeps its bridge: no route moves it, and `configure` refuses one (GA-BUS-11).
    if (!p || this.owner.adoptions.has(p.id)) return [];
    const same = [...this.devices.values()].filter((d) => d.doc.stable_identifier === r.stable_identifier && d.id !== p.id);
    const rows: HeldDevice[] = [];
    let host = p;
    const t = p.bridge === r.bridge ? undefined
      : same.find((d) => d.bridge === r.bridge && d.into === undefined) ?? same.find((d) => d.bridge === r.bridge && d.into === p.id);
    if (t) {
      host = { id: p.id, bridge: t.bridge, bridge_device: t.bridge_device, doc: t.doc };
      rows.push(host, { id: t.id, bridge: p.bridge, bridge_device: p.bridge_device, doc: p.doc, into: p.id });
    }
    for (const d of same) {
      if (d === t || d.bridge === host.bridge || d.into === p.id || this.owner.adoptions.has(d.id)) continue;
      rows.push({ ...d, into: p.id });
    }
    return rows;
  }

  /**
   * Puts the rows a route wrote in the model: each id names its row's hardware now. A row takes the
   * document its hardware has now, which a `devices` document may have changed while the write set
   * waited for its commit; that newer document is written behind. An id that stays exposed keeps its
   * verdict and bound, so `reverdict` says a change as one event, and each value its new hardware
   * reports otherwise than its old is a `state` event; an id folded now leaves them.
   */
  private place(rows: HeldDevice[]): void {
    const olds = new Map(rows.map((r) => [r.id, this.devices.get(r.id)]));
    const docs = new Map(rows.map((r) => {
      const now = this.devices.get(this.idOf(r.bridge, r.bridge_device) ?? "");
      return [r.id, now && now.bridge === r.bridge && now.bridge_device === r.bridge_device ? now.doc : r.doc];
    }));
    for (const r of rows) {
      const was = olds.get(r.id);
      if (was) this.ids.get(was.bridge)?.delete(was.bridge_device);
    }
    const newer: HeldDevice[] = [];
    for (const r of rows) {
      const doc = docs.get(r.id)!;
      const row = { ...r, doc };
      if (canonical(doc) !== canonical(r.doc)) newer.push(row);
      this.hold(row);
      if (row.into !== undefined) {
        this.verdicts.delete(r.id);
        this.bounds.delete(r.id);
        continue;
      }
      const was = olds.get(r.id);
      if (!was || this.feedbackOf(row) === "open") continue;
      const before = this.bridges.get(was.bridge)?.facts.get(was.bridge_device)?.values;
      for (const [key, x] of this.bridges.get(row.bridge)?.facts.get(row.bridge_device)?.values ?? []) {
        if (before?.get(key)?.value !== x.value) this.announce(row, key, x);
      }
    }
    if (newer.length) this.hook("modelChanged", () => this.hooks.modelChanged(newer, []));
  }

  /**
   * A device no longer adopted that shows the identifier of the one other exposed device, on another
   * bridge, folds into it, the later into the earlier (GA-BUS-11): what `host` would have done had
   * neither been adopted when the later arrived. A model change, written behind.
   */
  private refold(): void {
    for (const d of this.exposed().reverse()) {
      const into = this.host(d.bridge, d.id, d.doc.stable_identifier);
      if (into === undefined || this.owner.routes?.has(d.doc.stable_identifier)) continue;
      const folded = { ...d, into };
      if (this.hook("modelChanged", () => this.hooks.modelChanged([folded], []))) {
        this.hold(folded);
        this.verdicts.delete(d.id);
        this.bounds.delete(d.id);
      }
    }
  }

  /**
   * A folded copy that no longer shares its device's identifier, whose device left the model or is
   * folded itself, or that is now on its device's own bridge, is a device of its own again: a model
   * change, written behind.
   */
  private settleFolds(): void {
    for (const x of [...this.devices.values()]) {
      if (x.into === undefined) continue;
      const host = this.devices.get(x.into);
      if (host && host.into === undefined && host.doc.stable_identifier === x.doc.stable_identifier && host.bridge !== x.bridge) continue;
      const shown: HeldDevice = { id: x.id, bridge: x.bridge, bridge_device: x.bridge_device, doc: x.doc };
      if (this.hook("modelChanged", () => this.hooks.modelChanged([shown], []))) this.hold(shown);
    }
  }

  /** Whether a device's copies make its steps `refuse(duplicate_route)`: one on another bridge, and no route to its own (GA-BUS-11). */
  private duplicateRoute(d: HeldDevice): boolean {
    return this.liveCopiesOf(d.id).some((x) => x.bridge !== d.bridge) && this.owner.routes?.get(d.doc.stable_identifier) !== d.bridge;
  }

  /** The folded copies of `id` still in their bridge's `devices`: a copy that left is no second route. */
  private liveCopiesOf(id: string): HeldDevice[] {
    return this.copiesOf(id).filter((x) => this.inDevices(x));
  }

  /** What `configure` must know of each device the model exposes. */
  infos(): Map<string, DeviceInfo> {
    return new Map(this.exposed().map((d) => [d.id, {
      capabilities: d.doc.capabilities, sensor_keys: d.doc.sensor_keys, actions: d.doc.actions.map((a) => a.action),
      ...(d.doc.reach_ms !== undefined ? { reach_s: d.doc.reach_ms / 1000 } : {}),
      personal: d.doc.personal, self_changing: d.doc.self_changing, in_devices: this.inDevices(d),
      stable_identifier: d.doc.stable_identifier, bridge: d.bridge,
      ...(this.liveCopiesOf(d.id).length ? { copies: this.liveCopiesOf(d.id).map((x) => x.bridge) } : {}),
      fingerprints: Object.fromEntries(d.doc.actions.map((a) => [a.action, fingerprintOf(d.doc, a.action)])),
      extension_keys: { state: (d.doc.extensions ?? []).flatMap((e) => e.keys.filter((k) => k.kind === "state").map((k) => k.key)),
        event: (d.doc.extensions ?? []).flatMap((e) => e.keys.filter((k) => k.kind === "event").map((k) => k.key)) },
      toggles: d.doc.actions.filter((a) => a.toggles).map((a) => a.action),
      args: Object.fromEntries(d.doc.actions.map((a) => [a.action, { ...(a.args ? { args: a.args } : {}),
        ...(a.confirmed_by ? { confirmed_by: a.confirmed_by } : {}) }])),
      other_admins: d.doc.other_admins,
      proposed_class: d.doc.proposed_class,
      ...(d.doc.proposed_infrastructure ? { proposed_infrastructure: true } : {}),
    }]));
  }

  /**
   * An action's declarations as they stand, as a fingerprint (GA-DESC-18, `fingerprintOf`); undefined
   * for a device not held.
   */
  fingerprint(id: string, action: string): string | undefined {
    const d = this.devices.get(id);
    return d && fingerprintOf(d.doc, action);
  }

  /**
   * Whether a device is still in its bridge's `devices` document: true too while this life has not
   * heard that document, since nothing says it left; false once its bridge is no longer registered.
   */
  private inDevices(d: HeldDevice): boolean {
    const v = this.bridges.get(d.bridge);
    if (!v) return false;
    return v.docListed === undefined || v.docListed.has(d.bridge_device);
  }

  /**
   * The owner forgot these devices: they leave the model and the id map. One its bridge listed again
   * while the forget waited for its commit stays, unadopted, and its row is written again, since the
   * forget's write set deleted it. Returns those kept.
   */
  private forget(ids: string[]): string[] {
    const kept: string[] = [];
    for (const id of ids) {
      const d = this.devices.get(id);
      if (!d) continue;
      if (this.inDevices(d)) {
        this.hook("modelChanged", () => this.hooks.modelChanged([d], []));
        kept.push(id);
        continue;
      }
      this.devices.delete(id);
      this.ids.get(d.bridge)?.delete(d.bridge_device);
      this.verdicts.delete(id);
      this.bounds.delete(id);
    }
    return kept;
  }

  /**
   * A replacement (GA-ADOPT-2): the id `to` now names the hardware that was `from`, and `from` is no
   * more. The replaced hardware, if its bridge still lists it, is a new device again, unadopted,
   * under an id of its own: it never takes its old one back.
   */
  private repoint(from: string, to: string): void {
    const n = this.devices.get(from);
    if (!n) return;
    const o = this.devices.get(to);
    this.devices.delete(from);
    this.verdicts.delete(from);
    this.bounds.delete(from);
    if (o) this.ids.get(o.bridge)?.delete(o.bridge_device);
    this.hold({ id: to, bridge: n.bridge, bridge_device: n.bridge_device, doc: n.doc });
    this.bounds.delete(to);
    if (o && this.inDevices(o)) {
      const again = { ...o, id: this.mint(o.bridge, o.bridge_device) };
      // Past 128 characters it is not modelled: its bridge's next document raises the fault.
      if (again.id.length > MAX_ID) return;
      this.hold(again);
      this.hook("modelChanged", () => this.hooks.modelChanged([again], []));
    }
  }

  bridge(id: string): Bridge | undefined {
    return this.bridges.get(id)?.config;
  }

  /** A device's latest reported value of `key`: none for an open device, whose state is assumed (GA-STATE-4). */
  reportedValue(id: string, key: string): unknown {
    const d = this.devices.get(id);
    if (!d || d.into !== undefined || this.feedbackOf(d) === "open") return undefined;
    return this.bridges.get(d.bridge)?.facts.get(d.bridge_device)?.values.get(key)?.value;
  }

  /** The `basis_time` of a device's latest reported value of `key`, as `reportedValue` reads it: none for an open device. */
  reportedBasis(id: string, key: string): number | undefined {
    const d = this.devices.get(id);
    if (!d || d.into !== undefined || this.feedbackOf(d) === "open") return undefined;
    return this.bridges.get(d.bridge)?.facts.get(d.bridge_device)?.values.get(key)?.basis;
  }

  /** Whether a device's transport reads `unknown`: a transmitter that can answer nothing (GA-ADOPT-6). */
  onUnknownTransport(id: string): boolean {
    const d = this.devices.get(id);
    return d !== undefined && this.bridges.get(d.bridge)?.transports.get(d.doc.transport)?.state === "unknown";
  }

  /** Every `ungoverned` path the registered bridges declare, each under its bridge: the applier's own (GA-DESC-6). */
  ungoverned(): { bridge: string; path: string }[] {
    return [...this.bridges.values()].flatMap((v) => v.ungoverned.map((path) => ({ bridge: v.config.id, path })));
  }

  /** The broker is up, and every subscription of `bridge` was granted: listening begins. */
  listening(bridge: string): void {
    const v = this.bridges.get(bridge);
    if (!v) return;
    this.brokerUp = true;
    this.raise(v, "subscription", []);
    this.apply(v, v.rules.listening(this.now()));
  }

  /** The broker is lost: every bridge is dead, and needs a live status to come back (GA-BUS-7, GA-BUS-8). */
  lost(): void {
    if (this.mutation === "plans-through-broker-loss") return;
    this.brokerUp = false;
    for (const v of this.bridges.values()) this.apply(v, v.rules.lost(this.now()));
    this.reverdict();
  }

  /** The periodic check: bridges 30 s silent, devices past their bound. */
  tick(): void {
    for (const v of this.bridges.values()) this.apply(v, v.rules.tick(this.now()));
    this.reverdict();
  }

  /** One message from a bridge's tree, by the identity in its topic; `path` is what follows `{b}/`. */
  message(identity: string, path: string, payload: Buffer, retained: boolean): void {
    const v = [...this.bridges.values()].find((x) => x.config.identity === identity);
    if (!v) return;
    try {
      this.ingest(v, path, payload, retained);
    } catch (err) {
      // A bug met on a bridge's message: the step ends, the bridge is told of it as a fault, the applier runs on.
      // A hook's own failure never gets here: `emitEvent` and `modelChanged` catch it (an applier bug, not the bridge's).
      this.fault(v, `${path} could not be taken: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.reverdict();
  }

  private ingest(v: BridgeView, path: string, payload: Buffer, retained: boolean): void {
    const device = /^devices\/([^/]+)\/status$/.exec(path)?.[1];
    if (!payload.length) {
      // Empty is never a value: a cleared will, or a device's status cleared (GA-STATE-2). Nothing else.
      if (path === "lwt") this.apply(v, v.rules.will(undefined, this.now()));
      if (device) this.facts(v, device).cleared = true;
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(payload.toString());
    } catch {
      return this.fault(v, `${path} is not JSON`);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return this.fault(v, `${path} is not an object`);
    const b = body as Record<string, unknown>;
    if (this.mutation === "rejects-unknown-kind") {
      const schema = path === "status" ? "bridge/status.json" : path === "devices" ? "bridge/devices.json" : undefined;
      const errors = schema ? validate(schema, b) : [];
      if (errors.length) return this.fault(v, `${path} rejected whole: ${errors[0]}`);
    }
    if (path === "status") return this.onStatus(v, b, retained);
    if (path === "lwt") return this.apply(v, v.rules.will(typeof b.instanceId === "string" ? b.instanceId : undefined, this.now()));
    if (path === "devices") return this.onDevices(v, b, retained);
    if (device) return this.onDeviceStatus(v, device, b);
    const acked = /^devices\/([^/]+)\/ack$/.exec(path)?.[1];
    if (acked) return this.onAck(v, acked, b);
    if (path === "event") {
      const e = parseEvent(b);
      for (const f of e.faults) this.fault(v, f);
      if (!e.value) return;
      const o = v.rules.event(e.value);
      // A repeated seq is the same event, said once (GA-BUS-6).
      if (o.take && e.value.type === "occurrence") this.occurrence(v, e.value.body);
      if (o.take && PROVISION_EVENTS.has(e.value.type) && this.hooks.provisioning) {
        const hook = this.hooks.provisioning;
        const ev = e.value;
        this.hook("provisioning", () => hook(v.config.id, ev));
      }
      this.apply(v, o);
    }
    if (path === "reply") {
      // Routed on its requestId first: a request the applier holds owns its reply, whatever its op says
      // (the hook takes a mismatched op as a fault of the bridge's).
      if (typeof b.requestId === "string" && this.hooks.reply) {
        const hook = this.hooks.reply;
        let held = false;
        this.hook("reply", () => { held = hook(v.config.id, b); });
        if (held) return;
      }
      // A snapshot's reply ends its answer: the bridge re-publishes, then replies (GA-BRIDGE-30).
      if (b.op === "snapshot") {
        v.snapshotUntil = undefined;
        return;
      }
      // Any other reply names no request this applier holds: a late one, or another life's.
      if (typeof b.requestId !== "string") return this.fault(v, "a reply without a requestId");
    }
  }

  /**
   * An ack (bridge, *Commands*): its `source` must be the `bridgeId` whose topic carried it, or it is
   * a fault and no ack (GA-BUS-13). A command's ack is taken only from the bridge it went to, which
   * the dispatcher checks: a folded copy's bridge was sent nothing, so its acks are no one's (GA-BUS-11).
   */
  private onAck(v: BridgeView, device: string, body: Record<string, unknown>): void {
    const { value: ack, faults } = parseAck(body);
    const source = `devices/${device}/ack`;
    if (ack && ack.source !== v.config.identity && this.mutation !== "trusts-a-foreign-ack") {
      // The text names neither the source nor the command: one fault stands per device while it lasts.
      faults.push(`devices/${device}/ack names a source that is not this bridge's id`);
    } else if (ack && this.hooks.ack) {
      const hook = this.hooks.ack;
      let more: string[] = [];
      this.hook("ack", () => { more = hook(v.config.id, device, ack); });
      faults.push(...more);
    }
    this.raise(v, source, faults);
  }

  private onStatus(v: BridgeView, body: Record<string, unknown>, retained: boolean): void {
    const { value: s, faults } = parseStatus(body);
    const o = v.rules.status(s, retained, this.now());
    if (o.take) {
      this.raise(v, "status", faults);
      this.takeStatus(v, s.transports, s.roster, s.listed);
      // A readable transports list replaces the transport rows; one missing or unreadable keeps them (the spec review's M4).
      if (s.transports) this.takeConnections(v.config.id, "transport", new Map(s.transports.map((t) => [t.id, t.connections ?? []])));
      this.takeFaults(v, s.faults);
      v.levels = s.levels;
      if (s.bridge_type !== undefined) v.bridge_type = s.bridge_type;
      else delete v.bridge_type;
      if (JSON.stringify(s.ungoverned) !== JSON.stringify(v.ungoverned)) {
        v.ungoverned = s.ungoverned;
        if (this.hooks.ungovernedChanged) this.hook("ungovernedChanged", () => this.hooks.ungovernedChanged!(v.config.id));
      }
    }
    this.apply(v, o);
  }

  /**
   * The entries of a status's `faults`: each a `bridge_fault` event while it stands, and one naming
   * an adopted device a notice with cause `bridge_fault`, once while the entry stands (GA-BUS-12).
   */
  private takeFaults(v: BridgeView, faults: BridgeFault[]): void {
    this.raise(v, "status faults", faults.map((f) => `status fault ${f.code}${f.device ? ` on device ${f.device}` : ""}`));
    if (this.mutation === "swallows-device-fault") return;
    const now = new Map<string, { id: string; code: string }>();
    for (const f of faults) {
      if (f.device === undefined) continue;
      const id = this.idOf(v.config.id, f.device);
      const code = f.code.slice(0, MAX_FAULT_CODE);
      if (id !== undefined && this.owner.adoptions.has(id)) now.set(`${faultPrefix(v.config.id)}${f.device}:${code}`, { id, code });
    }
    // What cleared goes first, so its room is free for what is new.
    for (const key of [...v.deviceFaults]) {
      if (now.has(key)) continue;
      if (this.hook("clearNotice", () => this.hooks.clearNotice(key))) v.deviceFaults.delete(key);
    }
    let over = false;
    for (const [key, f] of now) {
      if (v.deviceFaults.has(key)) continue;
      // A broken bridge does not grow the notice store without end: past the cap, a fault of it, once.
      if (v.deviceFaults.size >= MAX_DEVICE_FAULTS) {
        over = true;
        continue;
      }
      if (this.hook("notice", () => this.hooks.notice({ cause: "bridge_fault", devices: [f.id],
        text: `Bridge ${v.config.id} reports a fault on ${f.id}: ${f.code}.` }, key))) v.deviceFaults.add(key);
    }
    this.raise(v, "device faults", over ? [`more than ${MAX_DEVICE_FAULTS} device faults standing; the rest are not shown`] : []);
  }

  private takeStatus(v: BridgeView, listedTransports: TransportFacts[] | undefined, roster: RosterFacts[], listed: string[] | undefined): void {
    const now = this.now();
    // A transport whose id would pass 128 characters is not modelled: a fault, which drops only it.
    const transports = listedTransports?.filter((t) => deviceId(v.config.id, t.id).length <= MAX_ID);
    if (listedTransports) {
      this.raise(v, "transport ids", listedTransports.filter((t) => !transports!.includes(t))
        .map((t) => `transport ${t.id} would have the id ${deviceId(v.config.id, t.id)}, longer than ${MAX_ID} characters; not modelled`));
    }
    if (transports) {
      // A transport new to the model, or of another kind, is a model change; whether it is up is state.
      // Memory follows the store: a change the hook did not take is not held, and the next status retries.
      const modelled = transports.filter((t) => v.transports.get(t.id)?.kind !== t.kind)
        .map((t): HeldTransport => ({ id: deviceId(v.config.id, t.id), bridge: v.config.id, bridge_transport: t.id, kind: t.kind }));
      const refused = modelled.length && !this.hook("modelChanged", () => this.hooks.modelChanged([], modelled))
        ? new Set(modelled.map((t) => t.bridge_transport)) : new Set<string>();
      for (const t of modelled) if (!refused.has(t.bridge_transport)) this.modelTransports.set(t.id, t);
      // A transport a well-formed list omits is down: its devices are dead. A missing list says nothing.
      const named = new Set(transports.map((t) => t.id));
      const omitted = [...v.transports.values()].filter((t) => !named.has(t.id)).map((t) => ({ ...t, state: "down" as const }));
      for (const t of [...transports, ...omitted]) {
        if (refused.has(t.id)) continue;
        const held = v.transports.get(t.id);
        if (!held || held.state !== t.state || held.kind !== t.kind) {
          if (!this.emitEvent("transport", { transport: deviceId(v.config.id, t.id), up: t.state === "up", state: t.state })) continue;
        }
        v.transports.set(t.id, t);
        if (t.state === "unknown" && held?.state !== "unknown") this.mute(v, t.id);
      }
      // A transport's kind known or changed now may put a device the bridge declares closed on ir (GA-DESC-7).
      if (modelled.length) this.raise(v, "feedback", this.irClosed(v));
      v.statusTransports = named;
      this.pruneTransports();
      this.raise(v, "transport named", this.strays(v));
    }
    for (const e of roster) {
      // `fresh-by-arrival`: the check-in is when the status arrived, not what the bridge says (GA-BUS-10).
      const entry = this.mutation === "fresh-by-arrival" ? { ...e, last_check_in: now } : e;
      const fast = entry.last_check_in !== null && entry.last_check_in > now + SKEW_MS && this.mutation !== "trusts-a-fast-clock";
      if (fast && !v.fastCheckIn.has(e.id)) this.fault(v, `device ${e.id} checked in ${Math.round((entry.last_check_in! - now) / 1000)} s ahead of the applier's clock`);
      if (fast) v.fastCheckIn.add(e.id);
      else v.fastCheckIn.delete(e.id);
      v.roster.set(e.id, entry);
    }
    if (listed) v.rosterListed = new Set(listed);
  }

  /**
   * A `devices` document. One the applier did not hear live (retained on subscribing, or the answer
   * to its snapshot) is re-sent: an unadopted device new to the model in it is a notice it missed,
   * with cause `missed_device` (GA-BUS-6; `window_closed` is GA-PROV-2's, for closed join windows),
   * except in the first document of a bridge whose devices the model does not hold yet, which is the
   * owner's registration of it. The notice is raised before the device rows go to the writer, so a
   * crash between the two leaves a duplicate, never a loss.
   */
  private onDevices(v: BridgeView, body: Record<string, unknown>, retained: boolean): void {
    if (this.mutation === "one-bad-entry-silences") {
      const errors = validate("bridge/devices.json", body);
      if (errors.length) return this.fault(v, `devices dropped whole: ${errors[0]}`);
    }
    const { value, faults } = parseDevices(body);
    this.raise(v, "devices", faults);
    // Each entry taken replaces its device's row; an entry dropped as malformed keeps its row (GA-BUS-1),
    // and a device the document no longer lists loses its row. No list at all says nothing (slice 5b).
    if (value.listed) {
      const malformed = new Set(value.listed.filter((id) => !value.connections.has(id)));
      this.takeConnections(v.config.id, "device", value.connections, malformed);
    }
    const resent = retained || (v.snapshotUntil !== undefined && this.now() <= v.snapshotUntil);
    const registering = !v.heardDevices && ![...this.devices.values()].some((d) => d.bridge === v.config.id);
    v.heardDevices = true;
    const changed: HeldDevice[] = [];
    // A document that changed only in `other_admins` changed the device's state, not the model (GA-DESC-2).
    const admins: HeldDevice[] = [];
    // A device whose id would pass 128 characters is not modelled: a fault of its own, which drops only it.
    const long: string[] = [];
    const shows = new Map<string, number>();
    for (const doc of value.devices) shows.set(doc.stable_identifier, (shows.get(doc.stable_identifier) ?? 0) + 1);
    for (const doc of value.devices) {
      const held = this.heldAt(v, doc.id);
      if (held && canonical(held.doc) === canonical(doc)) continue;
      const id = held?.id ?? this.claimed(doc) ?? this.mint(v.config.id, doc.id);
      if (id.length > MAX_ID) {
        long.push(`device ${doc.id} would have the id ${id}, longer than ${MAX_ID} characters; not modelled`);
        continue;
      }
      // A device newly showing an identifier another bridge's unadopted device shows is that device (GA-BUS-11).
      const into = !held || held.doc.stable_identifier !== doc.stable_identifier ? this.host(v.config.id, id, doc.stable_identifier, shows.get(doc.stable_identifier)! > 1) : held.into;
      const next: HeldDevice = { id, bridge: v.config.id, bridge_device: doc.id, doc, ...(into !== undefined ? { into } : {}) };
      // `plans-on-a-stale-declaration`: a change of declarations alone taken as no model change.
      const asIs = (x: DeviceDoc) => this.mutation === "plans-on-a-stale-declaration"
        ? { ...x, other_admins: [], actions: [], capabilities: [], extensions: undefined } : { ...x, other_admins: [] };
      (held && canonical(asIs(held.doc)) === canonical(asIs(doc)) ? admins : changed).push(next);
    }
    const missed = changed.filter((d) => !this.devices.has(d.id) && !this.owner.adoptions.has(d.id) && d.into === undefined).map((d) => d.id);
    if (resent && !registering && missed.length) {
      this.hook("notice", () => this.hooks.notice({ cause: "missed_device", devices: missed,
        text: `Bridge ${v.config.id} holds ${missed.length === 1 ? "a device" : "devices"} the applier had not seen, not adopted: ${missed.join(", ")}.` }));
    }
    // Memory follows the store: nothing is held until the hook took it, so the next document retries.
    if (changed.length && !this.hook("modelChanged", () => this.hooks.modelChanged(changed, []))) return;
    if (admins.length && !this.hook("factsChanged", () => this.hooks.factsChanged(admins))) admins.length = 0;
    const was = new Map([...changed, ...admins].map((d) => [d.id, this.devices.get(d.id)?.doc.other_admins]));
    for (const d of admins) this.hold(d);
    for (const d of changed) {
      const fresh = !this.devices.has(d.id);
      const claims = fresh || this.devices.get(d.id)!.doc.stable_identifier !== d.doc.stable_identifier;
      this.hold(d);
      this.dropEventValues(v, d);
      if (claims) this.conflicts(d);
      if (fresh && this.unjudged.delete(d.id)) this.adopted([d.id], undefined, true);
      // Values that arrived before the device was known are its first news; an open device has none (GA-STATE-4).
      // A folded copy's are no one's news: its device has its own route.
      if (fresh && d.into === undefined) {
        const values = v.facts.get(d.bridge_device)?.values;
        if (values && this.feedbackOf(d) === "open") values.clear();
        for (const [key, x] of [...(values ?? [])]) if (!this.announce(d, key, x)) values!.delete(key);
      }
    }
    this.settleFolds();
    this.settleConflicts();
    const redeclared = changed.filter((d) => d.into === undefined).map((d) => d.id);
    if (redeclared.length && this.hooks.declared) {
      const hook = this.hooks.declared;
      this.hook("declared", () => hook(redeclared));
    }
    for (const d of [...changed, ...admins]) {
      const before = was.get(d.id);
      if (before !== undefined && canonical(before) !== canonical(d.doc.other_admins)) this.adminsChanged(d, before);
    }
    if ((changed.length || admins.length) && this.hooks.held) {
      const hook = this.hooks.held;
      this.hook("held", () => hook());
    }
    if (value.listed) v.docListed = new Set(value.listed);
    this.raise(v, "device ids", long);
    this.raise(v, "feedback", this.irClosed(v));
    this.raise(v, "transport named", this.strays(v));
  }

  /**
   * The devices of a bridge that name a transport its latest status does not list (slice 2a's M7):
   * each reads dead, a transport known to nobody reaching it no more than a down one, and is a fault
   * while it stands. Nothing is said before a status has listed the bridge's transports in this life.
   */
  private strays(v: BridgeView): string[] {
    if (v.statusTransports === undefined) return [];
    return [...this.devices.values()].filter((d) => d.bridge === v.config.id && !v.statusTransports!.has(d.doc.transport))
      .map((d) => `device ${d.bridge_device} names transport ${JSON.stringify(d.doc.transport)}, which its bridge does not list`);
  }

  /**
   * A device's `other_admins` changed: an `other_admins` event. On an adopted device with an action
   * above `reversible`, an admin added is a notice with cause `other_admin` (GA-ADOPT-3), and so is a
   * list become `[]` after such a notice, which replaces it if no client took it. A `[]` lapsing to
   * `unknown` says nothing more, and a `[]` found again after it neither.
   */
  private adminsChanged(d: HeldDevice, before: DeviceDoc["other_admins"]): void {
    this.emitEvent("other_admins", { target: d.id, other_admins: d.doc.other_admins });
    const now = d.doc.other_admins;
    // An `unknown` between two reads is the bridge's lost view: an admin is added against the last list known.
    const known = Array.isArray(before) ? before : this.lastAdmins.get(d.id) ?? [];
    if (Array.isArray(now)) this.lastAdmins.set(d.id, now);
    else if (Array.isArray(before)) this.lastAdmins.set(d.id, before);
    if (!this.owner.adoptions.has(d.id)) return;
    if (Array.isArray(now) && now.some((a) => !known.some((b) => b.vendor === a.vendor && b.label === a.label))) {
      if (this.door(d)) this.adminNotice(d);
      return;
    }
    const key = adminKey(d.id);
    if (Array.isArray(now) && !now.length && this.hooks.standingNotices(key).includes(key)) {
      this.hook("notice", () => {
        this.hooks.withdrawNotice(key);
        this.hooks.notice({ cause: "other_admin", devices: [d.id], text: `${d.id} now has no other admin its protocol shows.` });
      });
    }
  }

  /**
   * Whether a device has an action whose effective tier is above `reversible`: a door worth guarding.
   * With `before`, the tier is also judged as it stood before the change set that adopted the device,
   * so a change in the same set that lowers it does not hide the door (GA-ADOPT-3).
   */
  private door(d: HeldDevice, before?: Owner): boolean {
    return d.doc.actions.some((a) => tierIn(this.owner, d.id, a.action, false, fingerprintOf(d.doc, a.action)) !== "reversible"
      || (before?.adoptions.has(d.id) === true && tierIn(before, d.id, a.action, false, fingerprintOf(d.doc, a.action)) !== "reversible"));
  }

  /** A notice raised afresh under its key: the key's earlier notice, taken or not, no longer holds it back. */
  private renotice(n: NoticeAsk, key: string): void {
    this.hook("notice", () => {
      this.hooks.clearNotice(key);
      this.hooks.notice(n, key);
    });
  }

  /** A notice that a device with an action above `reversible` has another admin, or may have one (GA-ADOPT-3). */
  private adminNotice(d: HeldDevice): void {
    if (this.mutation === "hides-a-second-door") return;
    const key = adminKey(d.id);
    const who = Array.isArray(d.doc.other_admins) ? d.doc.other_admins.map((a) => `${a.vendor} ${JSON.stringify(a.label)}`).join(", ")
      : "an admin its protocol cannot rule out";
    // A safety rule actuating it without accepts_other_admins keeps running, its latch no longer binding that admin.
    const rules = this.hooks.unaccepting?.(d.id) ?? [];
    this.renotice({ cause: "other_admin", devices: [d.id], text: `${d.id} has another admin beside this applier (${who}), `
      + "and an action above reversible: whoever holds that admin can act on it without this applier's gate."
      + (rules.length ? ` Safety rule${rules.length > 1 ? "s" : ""} ${rules.join(", ")} still run${rules.length > 1 ? "" : "s"} on it, `
        + `but ${rules.length > 1 ? "their latches no longer bind" : "its latch no longer binds"} that admin.` : "") }, key);
  }

  /**
   * Devices the owner has just adopted, a replacement's new hardware included, or, once (`sweep`),
   * every device already adopted when the applier starts supporting adoption: each with an action
   * above `reversible` and another admin, or `other_admins: unknown`, is a notice (GA-ADOPT-3); and,
   * at an adoption, one on an `unknown` transport is an `open_loop` notice (GA-ADOPT-6). `before` is
   * the configuration before the change set, whose tiers count too. A device the model does not hold
   * yet (its row lost past the backlog cap) is judged when its document arrives.
   */
  adopted(ids: string[], before?: Owner, sweep = false): void {
    for (const id of ids) {
      if (!this.owner.adoptions.has(id)) continue;
      const d = this.devices.get(id);
      if (!d) {
        this.unjudged.add(id);
        continue;
      }
      const alone = Array.isArray(d.doc.other_admins) && !d.doc.other_admins.length;
      if (!alone && this.door(d, before)) this.adminNotice(d);
      else this.hook("clearNotice", () => this.hooks.clearNotice(adminKey(id)));
      if (sweep || this.mutation === "adopts-a-mute-device-quietly") continue;
      const t = this.bridges.get(d.bridge)?.transports.get(d.doc.transport);
      // A key the id's earlier hardware left standing would hold back the first unknown of this one's.
      if (t?.state === "unknown") this.renotice(openLoop(d), openLoopKey(id));
      else this.hook("clearNotice", () => this.hooks.clearNotice(openLoopKey(id)));
    }
  }

  /**
   * A transport first reading `unknown`, a transmitter that can answer nothing (a bridge upgraded
   * under it): each adopted device on it is an `open_loop` notice, once while its key stands, across
   * restarts too (GA-ADOPT-6).
   */
  private mute(v: BridgeView, transport: string): void {
    if (this.mutation === "upgrades-a-mute-device-quietly") return;
    for (const d of this.devices.values()) {
      if (d.bridge !== v.config.id || d.doc.transport !== transport || !this.owner.adoptions.has(d.id)) continue;
      this.hook("notice", () => this.hooks.notice(openLoop(d), openLoopKey(d.id)));
    }
  }

  /** `merges-a-claimant`: a device new to the model takes the id of an adopted device showing its identifier. */
  private claimed(doc: DeviceDoc): string | undefined {
    if (this.mutation !== "merges-a-claimant") return undefined;
    return [...this.devices.values()].find((d) => d.doc.stable_identifier === doc.stable_identifier && this.owner.adoptions.has(d.id))?.id;
  }

  /**
   * A device newly showing an identifier the model already holds (GA-BUS-11): it stays a device of
   * its own, never merged into the one it claims to be, and a `route_conflict` event names the
   * identifier, every bridge reporting it and their devices. When one of those is of its own bridge
   * (a device evicted and admitted anew, GA-BRIDGE-35), it is also a notice with cause
   * `route_conflict`: the owner sees that the dead device and the arrival are one piece of hardware.
   */
  /** A conflict whose identifier fewer than two devices show has ended: told again if it comes back. */
  private settleConflicts(): void {
    for (const sid of this.conflicted.keys()) {
      if ([...this.devices.values()].filter((x) => x.doc.stable_identifier === sid).length < 2) this.conflicted.delete(sid);
    }
  }

  private conflicts(d: HeldDevice): void {
    const sid = d.doc.stable_identifier;
    const others = [...this.devices.values()].filter((x) => x.id !== d.id && x.doc.stable_identifier === sid);
    if (!others.length) return;
    const bridges = [...new Set([...others, d].map((x) => x.bridge))].sort();
    // One event per identifier while its bridges stay the same (GA-META-2's "not one per poll"): a
    // further copy on a bridge already named says nothing more; a new bridge is news.
    if (this.conflicted.get(sid) !== bridges.join(" ")
      && this.emitEvent("route_conflict", { stable_identifier: sid, bridges,
        devices: [...others, d].filter((x) => x.into === undefined).map((x) => x.id) })) {
      this.conflicted.set(sid, bridges.join(" "));
    }
    const kin = others.filter((x) => x.bridge === d.bridge && x.into === undefined).map((x) => x.id);
    if (!kin.length) return;
    this.hook("notice", () => this.hooks.notice({ cause: "route_conflict", devices: [...kin, d.id],
      text: `Bridge ${d.bridge} admitted ${d.id} with the identifier ${JSON.stringify(sid)}, which ${kin.join(" and ")} already `
        + `shows: one piece of hardware, admitted anew. Adopting ${d.id} with replaces naming ${kin[0]} gives it that device's id `
        + "and declarations." }));
  }

  /** The devices of a bridge on an `ir` transport that it declares `closed`: each is taken as `open` (GA-DESC-7). */
  private irClosed(v: BridgeView): string[] {
    return [...this.devices.values()].filter((d) => d.bridge === v.config.id && d.doc.feedback === "closed"
      && this.protocolOf(d) === "ir").map((d) => `${d.bridge_device} is on an ir transport and declared closed; taken as open`);
  }

  /**
   * A `state` event (applier, *Causes*): the apply it moves towards, given by `by`; else `device` for
   * a `self_changing` key, `external` for any other. A `self_changing` key keeps an apply's cause only
   * when it is the key that apply's action sets (GA-EVT-6).
   */
  private announce(d: HeldDevice, key: string, x: Value, by?: { cause: Record<string, unknown> | string; own: boolean }): boolean {
    const self = this.keysOf(d).self_changing.includes(key);
    const cause = by && (!self || by.own) ? by.cause : self ? "device" : "external";
    return this.emitEvent("state", { target: d.id, key, value: x.value, basis_time: new Date(x.basis).toISOString(), cause });
  }

  /**
   * An occurrence on the bridge's `event` topic (applier, *Occurrences*): one `occurrence` event of a
   * key the device declares of `kind` `event`, cause `device`, its `basis_time` the bridge's
   * `timestamp`, and never a state value; it moves no liveness and no freshness, the roster's check-in
   * doing that (GA-EVT-8). A key in the device's `personal` is kept in `events` only (GA-EVT-5). A folded
   * copy's is no one's (GA-BUS-11); anything ill formed, or of a key or device not declared, is a fault.
   */
  private occurrence(v: BridgeView, b: Record<string, unknown>): void {
    const device = typeof b.device === "string" ? b.device : "?";
    const held = this.heldAt(v, device);
    if (!held) return this.fault(v, `an occurrence on ${device}, a device its devices document does not hold`);
    if (held.into !== undefined) return;
    const key = typeof b.key === "string" ? b.key : "?";
    const what = `an occurrence of ${key} on ${device}`;
    if (!held.doc.extensions?.some((e) => e.keys.some((k) => k.key === key && k.kind === "event"))) {
      return this.fault(v, `${what}, which it does not declare an event key`);
    }
    const value = b.value;
    if (!(typeof value === "number" && Number.isFinite(value)) && typeof value !== "boolean" && !(typeof value === "string" && storable(value))) {
      return this.fault(v, `${what} whose value is not a scalar`);
    }
    const at = parseTime(b.timestamp);
    if (at === undefined) return this.fault(v, `${what} whose timestamp ${JSON.stringify(b.timestamp)} is not a time`);
    if (at > this.now() + SKEW_MS && this.mutation !== "trusts-a-fast-clock") return this.fault(v, `${what} observed ahead of the applier's clock`);
    const body = { target: held.id, key, value, basis_time: new Date(at).toISOString(), cause: "device" };
    const personal = this.keysOf(held).personal.includes(key) && this.mutation !== "history-keeps-a-personal-occurrence";
    this.hook("emit occurrence", () => this.hooks.emit("occurrence", body, personal ? { eventsOnly: true } : undefined));
    // `stores-an-occurrence-as-state`: the alarm taken as a value the device holds.
    if (this.mutation === "stores-an-occurrence-as-state") {
      const x: Value = { value, basis: at };
      this.facts(v, held.bridge_device).values.set(key, x);
      this.announce(held, key, x);
    }
  }

  /**
   * A key its declarations now give `kind: event` is never a value the device holds (GA-EVT-8): one a
   * status brought before the device was described, or a state key its bridge re-declares an event,
   * is dropped with a fault, before it can be first news, returned by `state` or judged `already`.
   */
  private dropEventValues(v: BridgeView, d: HeldDevice): void {
    const values = v.facts.get(d.bridge_device)?.values;
    if (!values || this.mutation === "stores-an-occurrence-as-state") return;
    for (const e of d.doc.extensions ?? []) {
      for (const k of e.keys) {
        if (k.kind !== "event" || !values.delete(k.key)) continue;
        this.fault(v, `devices/${d.bridge_device}: ${k.key} is an event key; its value is dropped, never a reading`);
      }
    }
  }

  /** Whether `key` is in the device's `personal` as it stands now, the owner's included (GA-EVT-5's read-time filter). */
  personalNow(id: string, key: string): boolean {
    const d = this.devices.get(id);
    return d !== undefined && this.keysOf(d).personal.includes(key);
  }

  private onDeviceStatus(v: BridgeView, topicDevice: string, body: Record<string, unknown>): void {
    const { value: s, faults: parsed } = parseDeviceStatus(body);
    const faults = parsed.map((f) => `devices/${topicDevice}/status: ${f}`);
    // The topic wins; a body naming another device is the bridge's fault (lesson 11).
    if (s.device_id !== topicDevice) faults.push(`devices/${topicDevice}/status names device ${JSON.stringify(s.device_id)}`);
    const held = this.heldAt(v, topicDevice);
    // A bridge publishes no reading of an open device: its state is the applier's, assumed (GA-STATE-4).
    if (held && this.feedbackOf(held) === "open" && s.readings.length) {
      faults.push(`devices/${topicDevice}/status: readings of a device that is feedback open`);
      s.readings = [];
    }
    // A key of kind event is never a reading: its value comes as an occurrence, once (GA-EVT-8, GA-BRIDGE-75).
    const events = new Set(held?.doc.extensions?.flatMap((e) => e.keys.filter((k) => k.kind === "event").map((k) => k.key)) ?? []);
    if (events.size) {
      for (const r of s.readings) if (events.has(r.key)) faults.push(`devices/${topicDevice}/status: ${r.key} is an event key, never a reading`);
      s.readings = s.readings.filter((r) => !events.has(r.key));
    }
    const facts = this.facts(v, topicDevice);
    facts.cleared = false;
    if (s.available !== undefined) facts.unavailable = !s.available;
    const now = this.now();
    let anyFast = false;
    for (const r of s.readings) {
      const fast = r.basis > now + SKEW_MS && this.mutation !== "trusts-a-fast-clock";
      if (fast) {
        anyFast = true;
        faults.push(`devices/${topicDevice}/status: ${r.key} observed ahead of the applier's clock`);
      }
      // A value from a fast clock never becomes the last seen (GA-BUS-2); the device's flag holds it stale.
      if (fast) continue;
      const before = facts.values.get(r.key);
      const x: Value = { value: r.value, basis: r.basis };
      const changed = !before || before.value !== r.value;
      // Only the exposed device's own bridge acks a step or causes a change: a folded copy's reports are no one's (GA-BUS-11).
      let by: ReturnType<NonNullable<HomeHooks["reading"]>>;
      if (held && held.into === undefined && this.hooks.reading) {
        const hook = this.hooks.reading;
        this.hook("reading", () => { by = hook(held.id, r.key, r.value, before?.value, r.basis, changed); });
      }
      // Re-published unchanged data is silent (lesson 16): only a changed value is a change.
      if (held && held.into === undefined && changed && !this.announce(held, r.key, x, by)) continue;
      facts.values.set(r.key, x);
    }
    // Only a correctly stamped report of the device, of any key, ends its fast clock (GA-BUS-2).
    if (s.readings.length) facts.fast = anyFast;
    const taken = s.readings.filter((r) => facts.values.get(r.key)?.basis === r.basis);
    if (held && held.into === undefined && taken.length && this.hooks.reported) {
      const hook = this.hooks.reported;
      this.hook("reported", () => hook(held.id, taken.map((r) => ({ key: r.key, basis: r.basis }))));
    }
    this.raise(v, `devices/${topicDevice}/status`, faults);
  }

  private facts(v: BridgeView, device: string): DeviceFacts {
    let f = v.facts.get(device);
    if (!f) {
      this.makeRoom(v, device);
      v.facts.set(device, f = { values: new Map(), unavailable: false, cleared: false, fast: false });
    }
    return f;
  }

  /** Keeps at most `MAX_UNLISTED` device topics of a bridge that it lists nowhere: the oldest go first. */
  private makeRoom(v: BridgeView, device: string): void {
    const listed = (id: string) => this.idOf(v.config.id, id) !== undefined || !!v.docListed?.has(id) || !!v.rosterListed?.has(id);
    if (listed(device)) return;
    const unlisted = [...v.facts.keys()].filter((id) => !listed(id));
    if (unlisted.length < MAX_UNLISTED) return;
    for (const id of unlisted.slice(0, unlisted.length - MAX_UNLISTED + 1)) {
      v.facts.delete(id);
      v.standing.delete(`devices/${id}/status`);
    }
    this.raise(v, "unlisted", [`more than ${MAX_UNLISTED} device topics its devices document does not list`]);
  }

  /**
   * A fault the bus met on a bridge's subscription: raised once while it stands, however often the
   * bus asks again (standing ruling 5), and cleared when the bridge is listening.
   */
  bridgeFault(bridge: string, what: string): void {
    const v = this.bridges.get(bridge);
    if (v) this.raise(v, "subscription", [what]);
  }

  /**
   * What the broker made of a command or a request to `bridge` (GA-BUS-9): a `0x87` refusal, not
   * authorized, is the bridge's fault, raised once while it stands at `source` (`command` or
   * `request`), and cleared by a success. Any other refusal is the applier's own condition (a quota,
   * a packet id in use): logged, and no fault of the bridge's.
   */
  published(bridge: string, source: "command" | "request", refusedCode: number | undefined): void {
    const v = this.bridges.get(bridge);
    if (!v) return;
    const hex = refusedCode === undefined ? "" : `0x${refusedCode.toString(16).padStart(2, "0")}`;
    if (refusedCode !== undefined && refusedCode !== 0x87) {
      this.hook("log", () => this.hooks.log(`the broker refused a ${source} to bridge ${v.config.id} (${hex})`));
      return;
    }
    this.raise(v, `${source} refused`, refusedCode === undefined ? [] : [`the broker refused a ${source} to this bridge (${hex})`]);
  }

  private fault(v: BridgeView, what: string): void {
    this.hook("log", () => this.hooks.log(`bridge ${v.config.id}: ${what}`));
    this.emitEvent("bridge_fault", { bridge: v.config.id, what });
  }

  /** Raises each fault not already standing at `source`; what a message no longer carries has cleared. */
  private raise(v: BridgeView, source: string, faults: string[]): void {
    const before = v.standing.get(source) ?? new Set<string>();
    for (const f of faults) if (!before.has(f)) this.fault(v, f);
    // A source with nothing standing is forgotten, so bogus topics do not grow the map.
    if (faults.length) v.standing.set(source, new Set(faults));
    else v.standing.delete(source);
  }

  /** Runs a hook; its exception is the applier's bug, logged, never a fault of a bridge. False when it threw. */
  private hook(what: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      try {
        this.hooks.log(`applier bug: ${what} threw: ${err instanceof Error ? err.message : String(err)}`);
      } catch { /* the log itself is gone: nothing left to tell */ }
      return false;
    }
  }

  private emitEvent(type: string, body: Record<string, unknown>): boolean {
    return this.hook(`emit ${type}`, () => this.hooks.emit(type, body));
  }

  private apply(v: BridgeView, o: Outcome): void {
    for (const f of o.faults) this.fault(v, f);
    if (o.snapshot && this.hook("snapshot", () => this.hooks.snapshot(v.config))) v.snapshotUntil = this.now() + SNAPSHOT_ANSWER_MS;
  }

  /** Emits a `liveness` event for every device whose verdict changed, and a `freshness` event for every changed bound. */
  private reverdict(): void {
    // The applier losing its broker is no bridge found dead: a step in flight waits for its bound
    // (GA-BUS-9), though every bridged device reads dead meanwhile (GA-BUS-7).
    if (!this.brokerUp) this.aliveBridges.clear();
    for (const [id, v] of this.bridges) {
      const alive = this.brokerUp && v.rules.alive;
      if (alive) this.aliveBridges.add(id);
      else if (this.aliveBridges.delete(id) && this.hooks.bridgeDead) {
        const hook = this.hooks.bridgeDead;
        const planned = !this.brokerUp || v.rules.planned;
        this.hook("bridgeDead", () => hook(id, planned));
      }
    }
    for (const d of this.exposed()) {
      const next = this.liveness(d);
      // A device new to the model starts dead: it becomes live only when its bridge says so.
      const old = this.verdicts.get(d.id) ?? "dead";
      // A verdict whose event did not go out is not taken: the next step tries again.
      if (old === next) {
        this.rebound(d);
        continue;
      }
      if (!this.emitEvent("liveness", { target: d.id, old, new: next })) continue;
      this.verdicts.set(d.id, next);
      if (this.hooks.livenessChanged) {
        const hook = this.hooks.livenessChanged;
        this.hook("livenessChanged", () => hook(d.id, old, next));
      }
      this.rebound(d);
    }
  }

  /**
   * A change of a device's effective bound is a `freshness` event (applier, *Events and history*),
   * saying the declared bound beside an owner's. Each life starts from unknown, as `state` gives it
   * before the first roster, so the first bound known in a life is a change too.
   */
  private rebound(d: HeldDevice): void {
    const { fresh_s, fresh_basis } = this.bound(d);
    const key = `${fresh_s}/${fresh_basis}`;
    const old = this.bounds.get(d.id) ?? UNKNOWN_BOUND;
    if (old === key) return;
    const declared = this.declaredS(d);
    if (!this.emitEvent("freshness", { target: d.id, fresh_s, fresh_basis,
      ...(fresh_basis === "configured" ? { declared_fresh_s: declared } : {}) })) return;
    this.bounds.set(d.id, key);
    if (this.hooks.boundChanged) {
      const hook = this.hooks.boundChanged;
      this.hook("boundChanged", () => hook(d.id));
    }
  }

  liveness(d: HeldDevice): Liveness {
    const v = this.bridges.get(d.bridge);
    if (!v) return "dead";
    const facts = v.facts.get(d.bridge_device);
    const roster = v.roster.get(d.bridge_device);
    const transport = v.transports.get(d.doc.transport)?.state;
    return liveness({
      feedback: this.feedbackOf(d),
      bridgeAlive: this.brokerUp && v.rules.alive,
      gone: !!facts?.unavailable || !!facts?.cleared || (v.docListed !== undefined && !v.docListed.has(d.bridge_device))
        || (v.rosterListed !== undefined && !v.rosterListed.has(d.bridge_device)),
      // `kills-a-mute-transmitters-devices`: a transmitter that can answer nothing is taken as down.
      transport: transport === "unknown" && this.mutation === "kills-a-mute-transmitters-devices" ? "down" : transport,
      freshS: this.bound(d).fresh_s,
      lastCheckIn: roster?.last_check_in ?? null,
      fastClock: v.fastCheckIn.has(d.bridge_device) || !!facts?.fast,
    }, this.now(), { liveBeforeKnown: this.mutation === "live-before-known" });
  }

  /** The bridge's declared bound in seconds, or null (GA-STATE-5). An open device has none. */
  private declaredS(d: HeldDevice): number | null {
    if (this.feedbackOf(d) === "open") return null;
    const max = this.bridges.get(d.bridge)?.roster.get(d.bridge_device)?.basis_max_age_ms;
    return max === undefined || max === null ? null : max / 1000;
  }

  /** The effective bound: none for an open device; the owner's, over a declared one or none (GA-STATE-6), else the bridge's. */
  bound(d: HeldDevice): { fresh_s: number | null; fresh_basis: "declared" | "configured" | "unknown" } {
    // An open device has no check-ins and no bound; the owner's is kept, and counts once it is closed.
    if (this.feedbackOf(d) === "open") return { fresh_s: null, fresh_basis: "unknown" };
    const owner = this.owner.declarations.get(d.id)?.fresh_s;
    if (owner !== undefined && this.mutation !== "ignores-owner-bound") return { fresh_s: owner, fresh_basis: "configured" };
    const declared = this.declaredS(d);
    return { fresh_s: declared, fresh_basis: declared === null ? "unknown" : "declared" };
  }

  private protocolOf(d: HeldDevice): Protocol {
    return this.bridges.get(d.bridge)?.transports.get(d.doc.transport)?.kind
      ?? this.modelTransports.get(deviceId(d.bridge, d.doc.transport))?.kind ?? "other";
  }

  /** Every `ir` device is `open`, whatever its bridge says (GA-DESC-7). */
  feedbackOf(d: HeldDevice): "open" | "closed" {
    return this.protocolOf(d) === "ir" ? "open" : d.doc.feedback;
  }

  /** `personal` and `self_changing`: the standard's, the bridge's and the owner's (GA-DESC-9). */
  keysOf(d: HeldDevice): { personal: string[]; self_changing: string[] } {
    const std = standardKeys(this.owner.adoptions.get(d.id)?.class ?? null, d.doc.capabilities,
      d.doc.actions.map((a) => a.action), d.doc.sensor_keys);
    const own = this.owner.declarations.get(d.id);
    return {
      personal: union(std.personal, d.doc.personal, own?.personal),
      self_changing: union(std.self_changing, d.doc.self_changing, own?.self_changing),
    };
  }

  /** A device in `describe` (applier/device.json), with the owner's class and declarations. */
  describeDevice(d: HeldDevice): Record<string, unknown> {
    const v = this.bridges.get(d.bridge);
    const doc = d.doc;
    const adoption = this.owner.adoptions.get(d.id);
    const own = this.owner.declarations.get(d.id) ?? {};
    const cls = adoption?.class ?? null;
    const sensor = doc.capabilities.includes("sensor") && doc.sensor_keys.length > 0;
    const { fresh_s, fresh_basis } = this.bound(d);
    const reachS = doc.reach_ms === undefined ? undefined : doc.reach_ms / 1000;
    const keys = this.keysOf(d);
    return {
      id: d.id,
      label: doc.id,
      class: cls,
      capabilities: doc.capabilities,
      ...(sensor ? { sensor_key: doc.sensor_keys[0], sensor_keys: doc.sensor_keys } : {}),
      proposed_class: doc.proposed_class,
      class_evidence: doc.class_evidence,
      protocol: this.protocolOf(d),
      stable_identifier: doc.stable_identifier,
      previous_identifiers: this.owner.previous?.get(d.id) ?? [],
      adopted: adoption !== undefined,
      other_admins: doc.other_admins,
      transport: deviceId(d.bridge, doc.transport),
      bridge_device: { bridge: v?.config.identity ?? d.bridge, id: doc.id },
      ...(reachS !== undefined ? { reach_s: reachS } : {}),
      feedback: this.feedbackOf(d),
      // A socket always declares one on a build that can claim Safe: `heating` where never configured (GA-DESC-8).
      ...(loadIn(this.owner, d.id) ? { load: loadIn(this.owner, d.id) } : {}),
      // A heating load carries its cap, the owner's or the default (applier, *Loads*).
      ...(loadIn(this.owner, d.id) === "heating" ? { max_on_s: own.max_on_s ?? DEFAULT_MAX_ON_S } : {}),
      fresh_s,
      fresh_slack_s: FRESH_SLACK_S,
      fresh_basis,
      self_changing: keys.self_changing,
      personal: keys.personal,
      infrastructure: own.infrastructure === true,
      ...(doc.proposed_infrastructure ? { proposed_infrastructure: true } : {}),
      ...(own.applier_host ? { applier_host: true } : {}),
      ...(doc.internal ? { internal: true } : {}),
      ...(doc.extensions ? { extensions: doc.extensions } : {}),
      actions: doc.actions.map((a) => ({
        action: a.action,
        ...this.declarationOf(d, a),
        ...(a.toggles ? { toggles: true } : {}), ...(a.whole_state ? { whole_state: true } : {}),
        ack_within_s: ackWithinS(own.ack_within_s?.[a.action], cls ?? doc.proposed_class, a.action, reachS),
        confirms: a.confirms,
        ...(own.witnesses?.[a.action] ? { witness: own.witnesses[a.action] } : {}),
        ...(a.confirmed_by ? { confirmed_by: a.confirmed_by } : {}),
      })),
    };
  }

  /**
   * What the gate reads of a device (applier, *Reason order*): each action's effective tier and
   * declaration, whether it is adopted, its liveness, and its observed values; none for an open
   * device, whose state is assumed (GA-STATE-4). Undefined for an id the model does not expose.
   */
  /**
   * An action's effective declaration, the one `describe` gives and the gate reads: its tier (GA-DESC-3);
   * `idempotent` as the bridge says, lowered where the capability's column says never and for an
   * extension action (GA-DESC-4), and for an action that toggles, so it is never reissued (GA-PLAN-8);
   * `stateless` from the column.
   */
  private declarationOf(d: HeldDevice, a: DeviceDoc["actions"][number]): { tier: Tier; idempotent: boolean; stateless: boolean } {
    return {
      tier: tierIn(this.owner, d.id, a.action, this.mutation === "keeps-a-tier-below-a-new-load", fingerprintOf(d.doc, a.action)),
      idempotent: a.idempotent && !a.toggles && mayBeIdempotent(a.action),
      stateless: statelessOf(a.action, a.stateless),
    };
  }

  /**
   * What dispatch reads of an exposed device for `action`: the bridge that carries it and its own id
   * there (a route's, never a folded copy's: GA-BUS-11), its feedback, the action's declaration, its
   * effective `idempotent` and `ack_within_s`, and whether its `notify` lists `from`. Undefined when
   * either is not in the model.
   */
  target(id: string, action: string): DispatchTarget | undefined {
    const d = this.devices.get(id);
    const bridge = d && this.bridges.get(d.bridge)?.config;
    const a = d?.doc.actions.find((x) => x.action === action);
    if (!d || d.into !== undefined || !bridge || !a) return undefined;
    const own = this.owner.declarations.get(d.id);
    const reachS = d.doc.reach_ms === undefined ? undefined : d.doc.reach_ms / 1000;
    const { stateless, idempotent } = this.declarationOf(d, a);
    return {
      bridge, bridge_device: d.bridge_device, feedback: this.feedbackOf(d), stateless, confirms: a.confirms, idempotent,
      whole_state: a.whole_state,
      ack_within_s: ackWithinS(own?.ack_within_s?.[action], this.owner.adoptions.get(d.id)?.class ?? d.doc.proposed_class, action, reachS),
      from: a.args !== undefined && Object.hasOwn(a.args, "from"),
      ...(a.confirmed_by ? { confirmed_by: a.confirmed_by } : {}),
    };
  }

  /**
   * The bridge of a device that reads `dead` only because that bridge's death was planned, a graceful
   * `offline` or the applier's loss of its broker; undefined otherwise (GA-SAFE-10's grace).
   */
  deathPlanned(id: string): string | undefined {
    const d = this.devices.get(id);
    if (!d || this.verdicts.get(id) !== "dead" || this.aliveBridges.has(d.bridge)) return undefined;
    const v = this.bridges.get(d.bridge);
    return v && (!this.brokerUp || v.rules.planned) ? d.bridge : undefined;
  }

  /**
   * A closed device's effective bound, and the one its bridge declares; undefined for an open device,
   * which has none and is `live` while its bridge is, or one the model does not hold (GA-SAFE-10).
   */
  boundOf(id: string): { fresh_s: number | null; declared: number | null } | undefined {
    const d = this.devices.get(id);
    if (!d || d.into !== undefined || this.feedbackOf(d) === "open") return undefined;
    return { fresh_s: this.bound(d).fresh_s, declared: this.declaredS(d) };
  }

  gateDevice(id: string): GateDevice | undefined {
    const d = this.devices.get(id);
    if (!d || d.into !== undefined) return undefined;
    const open = this.feedbackOf(d) === "open";
    const values = open ? [] : [...(this.bridges.get(d.bridge)?.facts.get(d.bridge_device)?.values ?? new Map<string, Value>())];
    return {
      actions: new Map(d.doc.actions.map((a) => {
        const { tier, stateless } = this.declarationOf(d, a);
        return [a.action, { tier, stateless, toggles: a.toggles, ...(a.args ? { args: a.args } : {}),
          ...(a.confirmed_by ? { confirmed_by: a.confirmed_by } : {}) }];
      })),
      adopted: this.owner.adoptions.has(d.id),
      liveness: this.liveness(d),
      feedback: open ? "open" : "closed",
      duplicateRoute: this.duplicateRoute(d),
      values: new Map(values.map(([key, x]) => [key, x.value])),
    };
  }

  /** A device in `state` (applier/state.response.json). */
  stateOf(d: HeldDevice): Record<string, unknown> {
    const v = this.bridges.get(d.bridge);
    const facts = v?.facts.get(d.bridge_device);
    const checkIn = v?.roster.get(d.bridge_device)?.last_check_in ?? null;
    const { fresh_s, fresh_basis } = this.bound(d);
    return {
      values: [...(facts?.values ?? new Map<string, Value>()).entries()]
        .map(([key, x]) => ({ key, value: x.value, basis_time: new Date(x.basis).toISOString() })),
      liveness: this.liveness(d),
      last_check_in: checkIn === null ? null : new Date(checkIn).toISOString(),
      fresh_s,
      fresh_basis,
      other_admins: d.doc.other_admins,
    };
  }

  /**
   * Every transport of the model, as `describe` and `state` list them: a registered bridge's as its
   * status gives them, and those of a bridge no longer registered, down, while a device names them.
   */
  transports(): Record<string, unknown>[] {
    const heard = [...this.bridges.values()].flatMap((v) => [...v.transports.values()].map((t) => ({
      id: deviceId(v.config.id, t.id), kind: t.kind, up: t.state === "up", state: t.state, bridge: v.config.id,
    })));
    const left = [...this.modelTransports.values()].filter((t) => !this.bridges.has(t.bridge))
      .map((t) => ({ id: t.id, kind: t.kind, up: false, state: "down", bridge: t.bridge }));
    return [...heard, ...left];
  }
}

/**
 * An action's `ack_within_s`: the owner's as given, floored only by twice the reach plus 10 where the
 * reach is known (GA-CFG-3; a reach may grow after the owner set it), else the default.
 */
function ackWithinS(owner: number | undefined, cls: string | null, action: string, reachS: number | undefined): number {
  if (owner === undefined) return defaultAckWithinS(cls, action, reachS);
  return reachS === undefined ? owner : Math.max(owner, 2 * reachS + 10);
}

/** The bound every device starts a life with (`fresh_s: null`, `fresh_basis: unknown`). */
const UNKNOWN_BOUND = "null/unknown";

/** The key of a device's `open_loop` notice: said once while it is adopted. */
const openLoopKey = (device: string) => `open_loop:${device}`;

/** The `open_loop` notice (GA-ADOPT-6). */
const openLoop = (d: HeldDevice): NoticeAsk => ({ cause: "open_loop", devices: [d.id],
  text: `${d.id} is on a transport that can answer nothing: if it stops working, nothing will show. It stays live, and its commands end sent.` });

/** The key of the `other_admin` notice a device's other admins stand under, until its `[]` or it is no longer adopted. */
const adminKey = (device: string) => `other_admin:${device}`;

/** The prefix of the keys of a bridge's device-fault notices. */
const faultPrefix = (bridge: string) => `bridge_fault:${bridge}:`;
