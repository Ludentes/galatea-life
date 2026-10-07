import { canonical } from "../core/canonical.js";
import { RequestError } from "../core/errors.js";
import type { Home } from "../model/home.js";
import type { Mutation } from "../mutations.js";
import { Discovery, type Listed } from "./discovery.js";

/** The operations of *Provisioning*, in the text's order. */
export const OPS = ["join", "join_close", "commission", "connect", "remove", "unblock", "install", "uninstall"] as const;

/** What provisioning reads of the model: resolving an operation, and turning a bridge's ids into the applier's. */
export type HomeView = Pick<Home, "transportHeld" | "deviceAt" | "bridgeFacts" | "idFor">;

type Args = Record<string, any>;

/**
 * The one operation `a` names, resolved to the bridge that owns what it names and its wire body, in
 * the bridge's camel case and its own ids (the design, *A `provision` request's life*, step 3). An id
 * the model does not hold, a `near` on another bridge than its transport, and an operation not built
 * here are `invalid_request`; a bridge not registered is `not_claimed`; the level is the caller's to check,
 * but for `connect`, whose checks are its own, in the design's order (*`connect`*): the candidate listed
 * now (`listed`, the one place that decides), else `invalid_request`; the bridge this applier's, claiming
 * Provision, its `bridgeType` matched with `connect: true`, else `not_claimed`; the address the listed
 * one exactly, present where it has one and absent where it has none, else `invalid_request`.
 */
export function opFor(a: Args, home: HomeView, listed: () => Listed[] = () => [], mutation?: Mutation):
{ op: string; bridge: string; wire: Record<string, unknown> } {
  const named = OPS.filter((o) => a[o] !== undefined);
  if (named.length !== 1) throw new RequestError("invalid_request", "provision names exactly one operation");
  const op = named[0]!;
  if (op === "install" || op === "uninstall") {
    throw new RequestError("invalid_request", `${op} is not built in this applier: the PC build adds it with GA-PROV-4`);
  }
  const v = a[op] as Args;
  // A bridge not registered with this applier claims no level: `not_claimed`, as GA-DISC-4 says of an
  // unknown bridge. The model may still hold a transport or device of a bridge the owner deleted.
  const bridge = (id: string) => {
    if (!home.bridgeFacts(id)) throw new RequestError("not_claimed", `bridge ${id} is not registered with this applier`);
    return id;
  };
  const transport = (id: string) => {
    const t = home.transportHeld(id);
    if (!t) throw new RequestError("invalid_request", `no transport ${id}`);
    bridge(t.bridge);
    return t;
  };
  const device = (id: string) => {
    const d = home.deviceAt(id);
    if (!d) throw new RequestError("invalid_request", `no device ${id}`);
    bridge(d.bridge);
    return d;
  };
  switch (op) {
    case "join": {
      const t = transport(v.transport);
      const near = v.near === undefined ? undefined : device(v.near);
      if (near && near.bridge !== t.bridge) throw new RequestError("invalid_request", `${v.near} is not on ${t.id}'s bridge`);
      return { op, bridge: t.bridge, wire: { transport: t.bridge_transport, windowMs: v.window_s * 1000,
        ...(near ? { near: near.bridge_device } : {}) } };
    }
    case "join_close": {
      const t = transport(v.transport);
      return { op, bridge: t.bridge, wire: { transport: t.bridge_transport } };
    }
    case "commission": {
      const t = transport(v.transport);
      return { op, bridge: t.bridge, wire: { transport: t.bridge_transport, code: v.code,
        ...(v.accept_unattested !== undefined ? { acceptUnattested: v.accept_unattested } : {}) } };
    }
    case "remove": {
      const common = { blockRejoin: v.block_rejoin, ...(v.force !== undefined ? { force: v.force } : {}) };
      if (v.device !== undefined) {
        const d = device(v.device);
        return { op, bridge: d.bridge, wire: { device: d.bridge_device, ...common } };
      }
      return { op, bridge: bridge(v.bridge), wire: { identifier: v.identifier, ...common } };
    }
    case "unblock":
      return { op, bridge: bridge(v.bridge), wire: { identifier: v.identifier } };
    case "connect": {
      const c = Discovery.listed(listed(), v.candidate);
      if (!c) throw new RequestError("invalid_request", `candidate ${v.candidate} is not listed`);
      const facts = home.bridgeFacts(v.bridge);
      // `connects-to-the-wrong-bridge`: a match saying connect: false is taken too.
      const takes = facts !== undefined && facts.levels.includes("Provision")
        && c.matches.some((m) => m.bridge_type === facts.bridge_type && (m.connect || mutation === "connects-to-the-wrong-bridge"));
      if (!takes) throw new RequestError("not_claimed", `bridge ${v.bridge} cannot take candidate ${v.candidate}`);
      const same = mutation === "ignores-the-address" || (c.address === undefined ? v.address === undefined
        : v.address !== undefined && canonical(v.address) === canonical(c.address));
      if (!same) {
        throw new RequestError("invalid_request", c.address === undefined ? `candidate ${v.candidate} has no address`
          : `the address is not candidate ${v.candidate}'s as listed now`);
      }
      // `ignores-the-address`: the list's current address is sent instead of the owner's.
      const address = mutation === "ignores-the-address" ? c.address : v.address;
      return { op, bridge: v.bridge, wire: { ...(address !== undefined ? { address } : {}), keys: c.keys } };
    }
  }
}
