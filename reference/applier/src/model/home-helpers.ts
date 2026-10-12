// The home's free helpers and bounds: ids, fingerprints, notice keys (moved from home.ts; Home stays whole).
import { createHash } from "node:crypto";
import { canonical } from "../core/canonical.js";
import { sets } from "../gate/actions.js";
import type { DeviceDoc } from "../bus/wire.js";
import { defaultAckWithinS } from "./declarations.js";
import type { HeldDevice, NoticeAsk } from "./home.js";

/** The bridge event types that are one `provision` event each (the design, *The `provision` event*); `interviewed` is not one. */
export const PROVISION_EVENTS = new Set(["joined", "left", "window_closed", "commissioned", "commission_failed", "connected",
  "connect_failed", "blocked_rejoin"]);

/**
 * An action's declarations on `doc`, hashed (GA-DESC-18): what the action does and how a step of it is
 * judged and acked. These wire fields, a fixed list under a version tag so that a later build parsing
 * more of a document moves no fingerprint: the action's entry (idempotent, stateless, toggles,
 * whole_state, confirms, args, confirmed_by, and a plugin's requested tier and tool hash where it has
 * them), its extension schema, the key it sets (its extension
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
      args: a.args ?? null, confirmed_by: a.confirmed_by ?? null,
      // A plugin's manifest and tool, where it has them: absent on any other action, so its fingerprint is unchanged (GA-DESC-11).
      ...(a.requested_tier !== undefined ? { requested_tier: a.requested_tier } : {}), ...(a.tool_hash !== undefined ? { tool_hash: a.tool_hash } : {}) } : null,
    schema: ext?.schema ?? null,
    key: key === undefined ? null : { key, kind: extKey?.kind ?? null, schema: extKey?.schema ?? null,
      personal: doc.personal.includes(key), self_changing: doc.self_changing.includes(key) },
    feedback: doc.feedback, reach_ms: doc.reach_ms ?? null })).digest("hex").slice(0, 32);
}

/** The applier's id for a bridge's device: `{bridge id}:{bridge device id}`, never the device id alone (lesson 12). */
export const deviceId = (bridge: string, device: string) => `${bridge}:${device}`;

/** The longest id the applier gives (applier, *Identifiers and revision*): a bridge's own id may fill it, so `{bridge}:{id}` may not. */
export const MAX_ID = 128;

/** How many device topics of one bridge, listed nowhere, the home keeps facts for (a bridge publishing on bogus ids). */
export const MAX_UNLISTED = 1024;

/**
 * How a value reached the applier, as it observes it, never by a message's retain flag (applier,
 * *Causes*, GA-EVT-1): `load`, while it loads statuses after it connects or restarts (its bridge not
 * heard live since); `snapshot`, in a bridge's answer to `snapshot`, or among a new instance's first
 * statuses before that answer (its bridge found dead since it was live, or a snapshot asked); `route`,
 * over a new route as a `configure` route moves the device; `live`, any other.
 */
export type Arrival = "load" | "snapshot" | "route" | "live";

/**
 * Whether a key's value is its first (applier, *Causes*; the plug rehearsal's F3, and the maintainer's
 * ruling of 2026-10-11), the one rule every call site asks: the applier held no value for that key of
 * the device on any route (`held`), and no hand can be told, since it arrived as the applier observed
 * a load, a snapshot or a route move, or the device is not adopted (its interview reads). A first value
 * is the device's word, cause `device`, unless an apply claims it; a key first reported live on an
 * adopted device is a change like any other.
 */
export function firstValue(o: { held: boolean; arrival: Arrival; adopted: boolean }): boolean {
  return !o.held && (o.arrival !== "live" || !o.adopted);
}

/** A device fault's `code` is kept to this many characters in its notice and key. */
export const MAX_FAULT_CODE = 128;

/** At most this many device-fault notices of one bridge stand at once. */
export const MAX_DEVICE_FAULTS = 64;

/** How long after asking for a snapshot a `devices` document counts as its answer: the request's expiry. */
export const SNAPSHOT_ANSWER_MS = 10_000;

/**
 * An action's `ack_within_s`: the owner's as given, floored only by twice the reach plus 10 where the
 * reach is known (GA-CFG-3; a reach may grow after the owner set it), else the default.
 */
export function ackWithinS(owner: number | undefined, cls: string | null, action: string, reachS: number | undefined): number {
  if (owner === undefined) return defaultAckWithinS(cls, action, reachS);
  return reachS === undefined ? owner : Math.max(owner, 2 * reachS + 10);
}

/** The bound every device starts a life with (`fresh_s: null`, `fresh_basis: unknown`). */
export const UNKNOWN_BOUND = "null/unknown";

/** The key of a device's `open_loop` notice: said once while it is adopted. */
export const openLoopKey = (device: string) => `open_loop:${device}`;

/** The `open_loop` notice (GA-ADOPT-6). */
export const openLoop = (d: HeldDevice): NoticeAsk => ({ cause: "open_loop", devices: [d.id],
  text: `${d.id} is on a transport that can answer nothing: if it stops working, nothing will show. It stays live, and its commands end sent.` });

/** The key of the `other_admin` notice a device's other admins stand under, until its `[]` or it is no longer adopted. */
export const adminKey = (device: string) => `other_admin:${device}`;

/** The prefix of the keys of a bridge's device-fault notices. */
export const faultPrefix = (bridge: string) => `bridge_fault:${bridge}:`;
