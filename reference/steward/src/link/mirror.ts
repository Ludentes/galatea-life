import { validate } from "@ludentes/galatea-life-schemas";
import type { Sensor } from "../gate/occupancy.js";
import type { Described } from "../gate/reasons.js";
import type { DeviceView } from "../house/define.js";

type Body = Record<string, any>;

/** The standard's stateless actions beside `power`'s, for a device whose declaration does not say (applier, *Capabilities and actions*). */
const STATELESS = new Set(["cover.stop", "media.duck", "media.announce", "notify.notify"]);

/** What the applier says of itself in `describe` (the design, *The mirror*). */
export interface ApplierFacts {
  applier_id: string;
  standard_version: string;
  levels: string[];
  ungoverned: unknown[];
  revision: number;
  test_run_id?: string;
}

/**
 * The steward's copy of its applier's model and state (the design, *The mirror*): every device the
 * applier describes, as it describes it, and every value with its liveness. Its methods are
 * synchronous: the link reads the applier outside the steward's steps and hands each answer to a
 * step, which calls one of these.
 */
export class Mirror {
  /** `logger`: where the mirror's own lines go (a device left out as malformed), injected (the milestone 7+10+11 review, M6). */
  constructor(private readonly logger: (line: string) => void) {}

  applier?: ApplierFacts;
  readonly devices = new Map<string, Body>();
  /** Each target's state as the applier gave it (its values, liveness and the rest of the record), moved by events since. */
  readonly state = new Map<string, Body & { values: Body[]; liveness?: string }>();
  private transports: unknown[] = [];
  private latches: unknown[] = [];
  /**
   * The applier's safety rules as `describe` lists them (applier, *Safety rules*): whether each
   * declares a latch, and the devices its actions name, by id (GA-LEASE-6).
   */
  readonly safetyRules = new Map<string, { latch: boolean; devices: string[] }>();
  /**
   * Since when each device has been `live` without a break, as far as this life has seen: a device
   * first seen live is live from then, so after a start no room is `vacant` for one hold (the
   * design, *Occupancy and sessions*).
   */
  private readonly liveSince = new Map<string, number>();
  /** The malformed devices already said, by id and errors. */
  private readonly malformed = new Set<string>();
  /** The last time each occupancy and motion key read true, by `target\u0000key`. */
  private readonly lastTrue = new Map<string, number>();

  /**
   * Takes a `describe`. Returns whether the applier's model moved: its revision is not the one last
   * read (the first read included), so the house revision moves with it (GA-HOUSE-1).
   */
  setDescribe(d: Body): boolean {
    const moved = this.applier?.revision !== d.revision;
    this.applier = { applier_id: String(d.applier_id ?? ""), standard_version: String(d.standard_version ?? ""),
      levels: Array.isArray(d.levels) ? d.levels : [], ungoverned: Array.isArray(d.ungoverned) ? d.ungoverned : [],
      revision: Number(d.revision), ...(typeof d.test_run_id === "string" ? { test_run_id: d.test_run_id } : {}) };
    this.safetyRules.clear();
    for (const r of Array.isArray(d.safety_rules) ? d.safety_rules as Body[] : []) {
      if (typeof r?.id !== "string") continue;
      const devices = (Array.isArray(r.actions) ? r.actions as Body[] : []).map((a) => a?.target).filter((t): t is string => typeof t === "string");
      this.safetyRules.set(r.id, { latch: r.latch !== undefined && r.latch !== null, devices: [...new Set(devices)].sort() });
    }
    this.devices.clear();
    for (const dev of Array.isArray(d.devices) ? d.devices as Body[] : []) {
      if (typeof dev?.id !== "string") continue;
      // A device missing what `applier/device.json` requires is malformed: not described, said once,
      // never read with defaults (the milestone review, M4).
      const errors = validate("applier/device.json", dev);
      if (errors.length) {
        const said = `${dev.id}\u0000${errors.join("; ")}`;
        if (!this.malformed.has(said)) this.logger(`the applier describes ${dev.id} malformed, so it is left out: ${errors.join("; ")}`);
        this.malformed.add(said);
        continue;
      }
      this.devices.set(dev.id, dev);
    }
    return moved;
  }

  /**
   * Takes a `state`, read at `now`: each target's record as the applier gives it, and its transports
   * and latches. A device live before and live now stays live since when it was; one newly live is
   * live from now.
   */
  setState(s: Body, now = 0): void {
    this.state.clear();
    for (const [id, t] of Object.entries((s.targets ?? {}) as Record<string, Body>)) {
      const values: Body[] = Array.isArray(t.values) ? t.values : [];
      this.state.set(id, { ...t, values, liveness: t.liveness });
      this.live(id, t.liveness, now);
      for (const v of values) this.sawValue(id, v.key, v.value, v.basis_time, now);
    }
    for (const id of [...this.liveSince.keys()]) if (!this.state.has(id)) this.liveSince.delete(id);
    this.transports = Array.isArray(s.transports) ? s.transports : [];
    this.latches = Array.isArray(s.latches) ? s.latches : [];
  }

  /** Takes one event from the applier's log, read at `now`: a value or a liveness moves; nothing else here does. */
  applyEvent(e: Body, now = 0): void {
    if (typeof e.target !== "string") return;
    const t = this.state.get(e.target) ?? { values: [] };
    if (e.type === "state" && typeof e.key === "string") {
      t.values = [...t.values.filter((v) => v.key !== e.key), { key: e.key, value: e.value, basis_time: e.basis_time }];
      this.sawValue(e.target, e.key, e.value, e.basis_time, now);
    } else if (e.type === "liveness") {
      t.liveness = e.new;
      this.live(e.target, e.new, now);
    } else return;
    this.state.set(e.target, t);
  }

  private live(id: string, liveness: unknown, now: number): void {
    if (liveness !== "live") this.liveSince.delete(id);
    else if (!this.liveSince.has(id)) this.liveSince.set(id, now);
  }

  /** Keeps when an occupancy or motion key last read true, at its `basis_time`, else `now`. */
  private sawValue(id: string, key: unknown, value: unknown, basis: unknown, now: number): void {
    if ((key !== "occupancy" && key !== "motion") || value !== true) return;
    const at = typeof basis === "string" && !Number.isNaN(Date.parse(basis)) ? Date.parse(basis) : now;
    const k = `${id}\u0000${key}`;
    this.lastTrue.set(k, Math.max(this.lastTrue.get(k) ?? at, at));
  }

  /**
   * The occupancy and motion sensors among `ids` (steward, *Occupancy*): each adopted device whose
   * sensor keys name `occupancy` or `motion`, one entry per key, with its value, when that last read
   * true, since when it has been live, and its effective `fresh_s` (from `state`, else `describe`) and
   * `fresh_slack_s`.
   */
  sensors(ids: string[]): Sensor[] {
    const out: Sensor[] = [];
    for (const id of ids) {
      const d = this.devices.get(id);
      if (!d || d.adopted !== true) continue;
      const keys: unknown[] = Array.isArray(d.sensor_keys) ? d.sensor_keys : d.sensor_key !== undefined ? [d.sensor_key] : [];
      const fresh = this.fresh(id);
      for (const key of ["occupancy", "motion"] as const) {
        if (!keys.includes(key)) continue;
        out.push({ id, key, value: this.value(id, key), lastTrueMs: this.lastTrue.get(`${id}\u0000${key}`), liveSinceMs: this.liveSince.get(id),
          freshS: fresh, slackS: typeof d.fresh_slack_s === "number" ? d.fresh_slack_s : null });
      }
    }
    return out;
  }

  /** A device's effective `fresh_s`: from `state`, else from `describe`; null when neither knows one. */
  fresh(id: string): number | null {
    const t = this.state.get(id);
    const d = this.devices.get(id);
    return typeof t?.fresh_s === "number" ? t.fresh_s : t?.fresh_s === null ? null : typeof d?.fresh_s === "number" ? d.fresh_s : null;
  }

  /** The latches the applier's last `state` listed held, each `{ rule_id, devices }` (GA-SAFE-9, GA-LEASE-6). */
  heldLatches(): { rule_id: string; devices: string[] }[] {
    return (this.latches as Body[]).filter((l) => typeof l?.rule_id === "string")
      .map((l) => ({ rule_id: l.rule_id as string, devices: (Array.isArray(l.devices) ? l.devices : []).filter((x: unknown): x is string => typeof x === "string") }));
  }

  /** A value the applier reported for `key` on `target`, or undefined. */
  value(target: string, key: string): unknown {
    return this.state.get(target)?.values.find((v) => v.key === key)?.value;
  }

  /**
   * The applier's `state`, as the mirror holds it, for `wanted` targets or all: each record with the
   * fields `state` gives filled where the follower saw only an event, and a personal key's value
   * `withheld` (GA-AUTH-7). Who reads beyond the floor is slice 8's; until then no one does.
   */
  stateView(wanted?: string[]): { targets: Record<string, Body>; transports: unknown[]; latches: unknown[] } {
    const targets: Record<string, Body> = {};
    for (const [id, t] of [...this.state].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (wanted && !wanted.includes(id)) continue;
      const personal: unknown[] = Array.isArray(this.devices.get(id)?.personal) ? this.devices.get(id)!.personal : [];
      targets[id] = { last_check_in: null, fresh_s: null, fresh_basis: "unknown", other_admins: [], ...t, liveness: t.liveness ?? "stale",
        values: t.values.map((v) => (personal.includes(v.key) ? { ...v, value: "withheld" } : v)) };
    }
    return { targets, transports: this.transports, latches: this.latches };
  }

  /** A device as `define` reads it (GA-DEF-8, GA-DEF-9, GA-DEF-10), or undefined when the applier describes none. */
  deviceView(id: string): DeviceView | undefined {
    const d = this.devices.get(id);
    if (!d) return undefined;
    return { adopted: d.adopted === true, internal: d.internal === true,
      actions: (Array.isArray(d.actions) ? d.actions as Body[] : []).map((a) => String(a.action)) };
  }

  /** The first reason, before `dead`, the applier's last description gives a step it could not plan (GA-STW-4's order). */
  described(target: string, action: string): Described | undefined {
    const d = this.devices.get(target);
    if (!d) return "unknown_target";
    if (!(Array.isArray(d.actions) ? d.actions as Body[] : []).some((a) => a.action === action)) return "unsupported_action";
    return d.adopted === true ? undefined : "not_adopted";
  }

  /** `action` as `target`'s description declares it, or undefined. */
  private declared(target: string, action: string): Body | undefined {
    const d = this.devices.get(target);
    return (Array.isArray(d?.actions) ? d!.actions as Body[] : []).find((x) => x.action === action);
  }

  /** Whether `target` declares `action` `idempotent: true` (applier, *Capabilities and actions*); not said is not idempotent. */
  idempotent(target: string, action: string): boolean {
    return this.declared(target, action)?.idempotent === true;
  }

  /**
   * Whether `action` on `target` can never run from authored work: declared `toggles: true` on a
   * `feedback: open` device, so a rule's or a schedule's step on it ends `skipped(toggle_only)` (GA-SCN-4).
   */
  toggleOnly(target: string, action: string): boolean {
    return this.declared(target, action)?.toggles === true && this.devices.get(target)?.feedback === "open";
  }

  /** `action`'s `ack_within_s` as `target` declares it (a described device always does). */
  ackWithinS(target: string, action: string): number {
    const s = this.declared(target, action)?.ack_within_s;
    // Declared, as it must be (0 read as 0); 10 s only for an action no longer described.
    return typeof s === "number" ? s : 10;
  }

  /**
   * The longest `ack_within_s` `target` declares for any action: a safety rule's actuation names a
   * key and a value, not an action, so its bound is the device's longest (GA-LEASE-6).
   */
  longestAckS(target: string): number {
    const actions = Array.isArray(this.devices.get(target)?.actions) ? this.devices.get(target)!.actions as Body[] : [];
    return Math.max(10, ...actions.map((a) => (typeof a.ack_within_s === "number" ? a.ack_within_s : 0)));
  }

  /** An action's tier as the applier last described it, for a step it could not plan. */
  tierOf(target: string, action: string): "reversible" | "confirm" | "no_voice" {
    const a = (Array.isArray(this.devices.get(target)?.actions) ? this.devices.get(target)!.actions as Body[] : []).find((x) => x.action === action);
    return a?.tier === "confirm" || a?.tier === "no_voice" ? a.tier : "reversible";
  }

  /**
   * Whether `action` on `target` is stateless, as its declaration says, else as the applier's
   * capability table has it (applier, *Capabilities and actions*): a stateless action takes no lease
   * (GA-LEASE-1).
   */
  stateless(target: string, action: string): boolean {
    const a = (Array.isArray(this.devices.get(target)?.actions) ? this.devices.get(target)!.actions as Body[] : []).find((x) => x.action === action);
    return typeof a?.stateless === "boolean" ? a.stateless : STATELESS.has(action) || action.startsWith("power.");
  }

  /**
   * Whether `action` on `target` never reports receipt, so `sent` is all it can end (applier,
   * *Outcomes*): declared `confirms: false`, or on an open-loop device.
   */
  noReceipt(target: string, action: string): boolean {
    const d = this.devices.get(target);
    const a = (Array.isArray(d?.actions) ? d!.actions as Body[] : []).find((x) => x.action === action);
    return a?.confirms === false || d?.feedback === "open";
  }

  /** Whether the applier's `standard_version` is below `v` (`major.minor`); one not given counts as below. */
  older(v: string): boolean {
    const [a, b] = (this.applier?.standard_version ?? "").split(".").map(Number);
    const [x, y] = v.split(".").map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return true;
    return a! < x! || (a === x && b! < y!);
  }

  /** Whether the applier reports a `test_run_id`: the harness drives it (GA-HARN-2). */
  get underHarness(): boolean {
    return this.applier?.test_run_id !== undefined;
  }
}
