// The kinds of the Safe level: witnesses, safety rules, `box` and latches cleared.
import { RequestError } from "../../core/errors.js";
import { numberArg } from "../../gate/actions.js";
import { canonical } from "../../core/canonical.js";
import type { Witness } from "../../safety/witnesses.js";
import type { SafetyRule } from "../../safety/language.js";
import { bad, checked, declared, deleting, device, type Kind, offered, stateKeys, tidy } from "./common.js";

export const safetyKinds: Record<string, Kind> = {
  /**
   * `witness` (applier, *Safety rules*, GA-WIT-1): the sensor that says whether a device's action did
   * what it asked, its expectation and its `within_s`, on an action the device offers, over a device
   * the model holds that reports a sensor key, read on the key it names, one of the sensor's, or else
   * on its first, which is kept as its key from then on, so a restart cannot lose what it read (the
   * whole-applier review's M8); `toward` names an argument of
   * the action that takes a number. Safe, so `not_claimed` below it (GA-LVL-1). Its delete names the
   * device and the action.
   */
  witness(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id, action } = deleting(change.value, ["device", "action"]);
      device(ctx, id!);
      const d = draft.declarations.get(id!);
      if (d?.witnesses?.[action!] === undefined) return undefined;
      delete d.witnesses[action!];
      tidy(draft, id!);
      return `- witness ${id} ${action}`;
    }
    const v = checked<Witness & { device: string; action: string }>("applier/configure.witness.json", change.value);
    offered(device(ctx, v.device), v.device, v.action);
    const sensor = device(ctx, v.sensor);
    const keys = sensor.sensor_keys;
    if (v.key !== undefined && !keys.includes(v.key)) {
      // A key it declares, but not among its sensor keys (a lamp's `on`): no GA-SAFE-14 refusal, which is for an undeclared key.
      if (stateKeys(sensor).includes(v.key)) bad(`${v.sensor}'s ${v.key} is not among its sensor keys, which a witness reads`);
      // GA-SAFE-14: named, with whether its bridge awaits it.
      const awaited = sensor.awaited_keys?.includes(v.key) ?? false;
      throw new RequestError("invalid_request", `${v.sensor} declares no sensor key ${v.key} for a witness to read`
        + `${awaited ? ", which its bridge awaits: it has not reported it yet" : ""}`, { key: v.key, device: v.sensor, awaited });
    }
    if (!keys.length) {
      const awaited = sensor.awaited_keys ?? [];
      bad(`${v.sensor} declares no sensor key a witness could read${awaited.length
        ? `; its bridge awaits ${awaited.join(", ")}, not reported yet: name one as the witness's key once it is` : ""}`);
    }
    if (typeof v.expect === "object" && "toward" in v.expect && !numberArg(v.action, v.expect.toward.arg)) {
      bad(`${v.action} takes no number ${v.expect.toward.arg} for a witness to move towards`);
    }
    const next: Witness = { sensor: v.sensor, key: v.key ?? keys[0]!, expect: v.expect, within_s: v.within_s };
    const d = declared(draft, v.device);
    if (canonical(d.witnesses?.[v.action]) === canonical(next)) return undefined;
    (d.witnesses ??= {})[v.action] = next;
    return `~ witness ${v.device} ${v.action} ${v.sensor}`;
  },
  /**
   * `safety_rule` (applier, *Safety rules*), in the language of `safety/language.ts`; checked whole once
   * the set is applied (`checkRule`). Its delete names its id.
   */
  safety_rule(draft, change, ctx) {
    if (change.op === "delete") {
      const { id } = deleting(change.value, ["id"]);
      if (!draft.rules.delete(id)) bad(`no safety rule ${id}`);
      draft.disabled.delete(id);
      return `- safety_rule ${id}`;
    }
    const r = checked<SafetyRule>("applier/configure.safety_rule.json", change.value);
    const held = draft.rules.get(r.id);
    // A rule a declaration change disabled runs again only when the owner sets it again, checked as new (GA-SAFE-13).
    if (held && JSON.stringify(held) === JSON.stringify(r) && !draft.disabled.has(r.id)) return undefined;
    draft.rules.set(r.id, r);
    draft.disabled.delete(r.id);
    ctx.ruled.push(r.id);
    return `${held ? "~" : "+"} safety_rule ${r.id}`;
  },
  /**
   * `box` (applier, *Bridges*): the owner's word that the box passes GA-BOX-1, without which an applier
   * over bridges claims no Safe (GA-DESC-6); refused while its own broker connection is plain TCP off
   * loopback, which it can see. Its delete is `false`.
   */
  box(draft, change, ctx) {
    const on = change.op === "delete" ? false : checked<boolean>("applier/configure.box.json", change.value);
    if (on && ctx.plainOffLoopback) bad("box is refused while this applier reaches its broker over plain TCP off loopback (GA-DESC-6)");
    if (draft.box === on) return undefined;
    draft.box = on;
    return `~ box ${on}`;
  },
  /**
   * `clear_latch` (applier, *Latches*): the owner clears a held latch, for a sensor that will never
   * report again; it changes no configuration, but is a model change (applier, *Identifiers and
   * revision*). It has no delete.
   */
  clear_latch(_draft, change, ctx) {
    if (change.op === "delete") bad("clear_latch has no delete: an upsert names the rule whose latch it clears");
    const { rule_id } = checked<{ rule_id: string }>("applier/configure.clear_latch.json", change.value);
    if (!ctx.latches?.has(rule_id) || ctx.cleared.includes(rule_id)) bad(`no latch of safety rule ${rule_id} is held`);
    ctx.cleared.push(rule_id);
    return `- latch ${rule_id}`;
  },
};
