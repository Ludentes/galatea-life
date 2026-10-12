// The kinds of a device's declarations: tiers, loads, caps, freshness, ack bounds and key lists.
import type { Load, Tier } from "../../model/declarations.js";
import { checked, deleteTier, deleting, device, keyKind, type Kind, setAckWithin, setFreshS, setInfrastructure, setLoad, setMaxOn, setTier, tidy } from "./common.js";

export const declarationsKinds: Record<string, Kind> = {
  tier(draft, change, ctx) {
    if (change.op === "delete") {
      // The owner's value deleted: the action falls back to its default, a standard one's as an extension one's (GA-DESC-14).
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      device(ctx, id!);
      return deleteTier(draft, id!, action!, ctx.mutant);
    }
    const v = checked<{ device: string; action: string; tier: Tier }>("applier/configure.tier.json", change.value);
    return setTier(draft, v.device, device(ctx, v.device), v.action, v.tier, ctx);
  },
  load(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (!d?.load) return undefined;
      delete d.load;
      tidy(draft, id);
      return `- load ${id}`;
    }
    const v = checked<{ device: string; load: Load }>("applier/configure.load.json", change.value);
    device(ctx, v.device);
    return setLoad(draft, v.device, v.load, ctx.mutant, ctx.devices);
  },
  /**
   * `max_on_s` (applier, *Loads*, GA-LOAD-2): how long a heating load may be on continuously before the
   * applier turns it off; Safe, so `not_claimed` below it (GA-LVL-1). Its delete gives the default back.
   */
  max_on_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.max_on_s === undefined) return undefined;
      delete d.max_on_s;
      tidy(draft, id);
      return `- max_on_s ${id}`;
    }
    const v = checked<{ device: string; max_on_s: number }>("applier/configure.max_on_s.json", change.value);
    device(ctx, v.device);
    return setMaxOn(draft, v.device, v.max_on_s);
  },
  infrastructure(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      return setInfrastructure(draft, id, false);
    }
    const v = checked<{ device: string; infrastructure: boolean }>("applier/configure.infrastructure.json", change.value);
    device(ctx, v.device);
    return setInfrastructure(draft, v.device, v.infrastructure);
  },
  fresh_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.fresh_s === undefined) return undefined;
      delete d.fresh_s;
      tidy(draft, id);
      return `- fresh_s ${id}`;
    }
    const v = checked<{ device: string; fresh_s: number }>("applier/configure.fresh_s.json", change.value);
    device(ctx, v.device);
    return setFreshS(draft, v.device, v.fresh_s);
  },
  ack_within_s(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.ack_within_s?.[action!] === undefined) return undefined;
      delete d.ack_within_s![action!];
      tidy(draft, id);
      return `- ack_within_s ${id} ${action}`;
    }
    const v = checked<{ device: string; action: string; ack_within_s: number }>("applier/configure.ack_within_s.json", change.value);
    return setAckWithin(draft, v.device, device(ctx, v.device), v.action, v.ack_within_s);
  },
  personal: (draft, change, ctx) => keyKind(draft, change, ctx, "personal"),
  self_changing: (draft, change, ctx) => keyKind(draft, change, ctx, "self_changing"),
};
