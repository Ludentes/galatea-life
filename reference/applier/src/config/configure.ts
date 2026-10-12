import { RequestError } from "../core/errors.js";
import { VALVES } from "../model/declarations.js";
import type { Mutant } from "../mutations.js";
import { argsFault, sets } from "../gate/actions.js";
import { actuated, devicesOf, reads, type SafetyRule } from "../safety/language.js";
import { type Config, copyConfig } from "./config.js";
import { bad, brokerAdmins, type Change, claimsOf, type Ctx, type DeviceInfo, type Effects, judgeTiers, type Kind, loadIn, SAFE_KINDS, stateKeys, tidy, type Work } from "./kinds/common.js";
import { discoveryKinds } from "./kinds/discovery.js";
import { accessKinds } from "./kinds/access.js";
import { devicesKinds } from "./kinds/devices.js";
import { declarationsKinds } from "./kinds/declarations.js";
import { safetyKinds } from "./kinds/safety.js";
import { harnessKinds } from "./kinds/harness.js";

// The API that configure.ts held before its kinds moved to kinds/*.ts.
export { ACK_MAX_S, ACK_MIN_S, IGNORE_KINDS, brokerAdmins, claimsOf, dropTiers, fallenTiers, loadIn, tierIn, type Change, type Seen, type DeviceInfo, type Effects, type Replacement, type Routed } from "./kinds/common.js";

/** Every kind, by its name: each family's in kinds/<family>.ts. */
const KINDS: Record<string, Kind> = {
  ...discoveryKinds,
  ...accessKinds,
  ...devicesKinds,
  ...declarationsKinds,
  ...safetyKinds,
  ...harnessKinds,
};

/** What holds across the whole set: a load only on an adopted socket, `opens_with` only on a water or gas valve. */
function consistent(draft: Config, mutant: Mutant): void {
  for (const id of [...draft.declarations.keys()]) tidy(draft, id);
  for (const [id, d] of draft.declarations) {
    const cls = draft.adoptions.get(id)?.class ?? null;
    if (d.load !== undefined && cls !== "socket") bad(`${id} declares a load but is no longer a socket`);
    // A cap is the heating load's: none on a load that is not heating (applier, *Devices*).
    if (d.max_on_s !== undefined && loadIn(draft, id) !== "heating") bad(`${id} declares max_on_s, which only a heating load carries`);
    if (d.opens_with !== undefined && !VALVES.has(cls ?? "")) bad(`${id} declares opens_with but is no longer a water or gas valve`);
    // GA-CFG-3: the applier runs on one computer. `marks-two-applier-hosts` takes it on anything, twice.
    if (d.applier_host && cls !== "computer" && !mutant.marksTwoApplierHosts) bad(`applier_host is set only on an adopted computer, and ${id} is not one (GA-CFG-3)`);
  }
  const hosts = [...draft.declarations].filter(([, d]) => d.applier_host).map(([id]) => id);
  if (hosts.length > 1 && !mutant.marksTwoApplierHosts) bad(`applier_host is set on ${hosts.join(" and ")}: the applier runs on one computer (GA-CFG-3)`);
  // A safety rule reads and actuates adopted devices only: a forget or an adoption's delete of one it names is refused (GA-ADOPT-1).
  for (const r of draft.rules.values()) {
    const lost = devicesOf(r).filter((id) => !draft.adoptions.has(id));
    if (lost.length) bad(`safety rule ${r.id} names ${lost.join(", ")}, which would not be adopted: delete or change the rule first`);
  }
}

/**
 * Why a safety rule no longer fits its devices' declarations, or undefined (applier, *Safety rules*,
 * *The applier's own actuations*): every key it reads one the device reports as state, never an event
 * key (GA-EVT-8); every action one its device offers, never one declared `toggles: true` (GA-SAFE-13),
 * with args the vocabulary and the device's own `args` and `confirmed_by` take, as a client's plan is
 * checked (`refuse(invalid_args)`). A device the model does not hold is no fault of its declarations:
 * its adoption is judged apart. `configure` refuses a rule with such a fault, and a change of the
 * declarations that gives one disables it (GA-SAFE-13). `toggles` is `toggles-by-safety-rule`'s switch.
 */
/**
 * The first key a rule or its latch reads that its device does not declare, with whether its bridge
 * awaits it (GA-SAFE-14), as a refusal's `data` gives them; an event key is GA-EVT-8's, not this.
 */
export function undeclaredRead(r: SafetyRule, devices: ReadonlyMap<string, DeviceInfo>): { key: string; device: string; awaited: boolean } | undefined {
  for (const t of reads(r)) {
    const info = devices.get(t.device);
    if (!info || info.extension_keys?.event.includes(t.key)) continue;
    if (!stateKeys(info).includes(t.key)) return { key: t.key, device: t.device, awaited: info.awaited_keys?.includes(t.key) ?? false };
  }
  return undefined;
}

/** The state keys a device declares: its capabilities', its sensor keys and its extensions' `state` keys. */

export function declarationFault(r: SafetyRule, devices: ReadonlyMap<string, DeviceInfo>, o: { toggles?: boolean; keys?: boolean } = {}): string | undefined {
  for (const t of reads(r)) {
    const info = devices.get(t.device);
    if (!info) continue;
    if (info.extension_keys?.event.includes(t.key)) {
      return `${t.device}'s ${t.key} is an event key, an occurrence and never a value a rule can read (GA-EVT-8)`;
    }
    if (o.keys !== false && !stateKeys(info).includes(t.key)) return `${t.device} reports no state key ${t.key}`;
  }
  for (const a of r.actions) {
    const info = devices.get(a.target);
    if (!info) continue;
    if (!info.actions.includes(a.action)) return `${a.target} offers no ${a.action}`;
    const own = info.args?.[a.action];
    const fault = argsFault(a.action, a.args ?? {}, own?.args, own?.confirmed_by);
    if (fault) return `${a.target} ${a.action}: ${fault}`;
    if (info.toggles?.includes(a.action) && !o.toggles) {
      return `${a.target}'s ${a.action} is declared toggles: true, which the applier never sends on its own (GA-SAFE-13)`;
    }
  }
  return undefined;
}

/**
 * A safety rule as the set leaves the model (applier, *Safety rules*): every device it reads or
 * actuates adopted (GA-ADOPT-1) and the applier's own; its declarations fitting it
 * (`declarationFault`); on a device with no other admin, or `other_admins: unknown`, unless the rule
 * says `accepts_other_admins` (GA-SAFE-6); an order compares a number; and no two rules set one key of
 * one device to different values (GA-SAFE-11).
 */
function checkRule(draft: Config, r: SafetyRule, ctx: Work): void {
  const named = (id: string): DeviceInfo => {
    const info = ctx.devices.get(id);
    if (!info) return bad(`safety rule ${r.id}: no device ${id}`);
    if (!draft.adoptions.has(id)) bad(`safety rule ${r.id}: ${id} is not adopted (GA-ADOPT-1)`);
    return info;
  };
  for (const t of reads(r)) {
    named(t.device);
    if (t.op !== "eq" && t.op !== "ne" && typeof t.value !== "number") bad(`safety rule ${r.id}: ${t.op} compares a number, not ${JSON.stringify(t.value)}`);
  }
  for (const a of r.actions) named(a.target);
  // A key its device does not declare: a rule on a reading that never comes never fires (GA-SAFE-14).
  // `accepts-a-safety-rule-on-an-undeclared-key` takes it.
  const lax = ctx.mutant.acceptsASafetyRuleOnAnUndeclaredKey;
  const missing = lax ? undefined : undeclaredRead(r, ctx.devices);
  if (missing) {
    throw new RequestError("invalid_request", `safety rule ${r.id}: ${missing.device} declares no state key ${missing.key}`
      + `${missing.awaited ? ", which its bridge awaits: it has not reported it yet" : ""}`, missing);
  }
  const fault = declarationFault(r, ctx.devices, { toggles: ctx.mutant.togglesBySafetyRule, keys: !lax });
  if (fault) bad(`safety rule ${r.id}: ${fault}`);
  // The broker's host's administrators reach every device a rule actuates (GA-SAFE-6). `ignores-the-broker-hosts-admins` leaves them out.
  const broker = ctx.mutant.ignoresTheBrokerHostsAdmins ? [] : brokerAdmins(draft, ctx.devices, ctx.mutant);
  if (broker.length && r.accepts_other_admins !== true && actuated(r).length) {
    bad(`safety rule ${r.id}: ${broker.map((b) => b.computer).join(", ")} carries the broker and has `
      + `${broker.some((b) => b.admins === "unknown") ? "administrators not known" : "administrators"}, who reach every device it actuates `
      + "and can undo the rule; the rule needs accepts_other_admins: true, or the computer adopted and marked applier_host "
      + "if the applier itself runs on it (GA-SAFE-6)");
  }
  for (const id of actuated(r)) {
    const admins = ctx.devices.get(id)?.other_admins;
    const other = admins === "unknown" || (Array.isArray(admins) && admins.length > 0);
    if (other && r.accepts_other_admins !== true) {
      bad(`safety rule ${r.id}: ${id} has ${admins === "unknown" ? "other admins not known" : "another admin"}, who can undo the rule; `
        + "the rule needs accepts_other_admins: true (GA-SAFE-6)");
    }
  }
  // Two rules setting one key of one device to different values would undo each other (GA-SAFE-11).
  for (const other of draft.rules.values()) {
    if (other.id === r.id) continue;
    for (const a of r.actions) {
      const mine = sets(a.action, a.args ?? {});
      if (mine?.value === undefined) continue;
      for (const b of other.actions) {
        const theirs = b.target === a.target ? sets(b.action, b.args ?? {}) : undefined;
        if (theirs?.key === mine.key && theirs.value !== undefined && JSON.stringify(theirs.value) !== JSON.stringify(mine.value)) {
          bad(`safety rules ${r.id} and ${other.id} set ${a.target}'s ${mine.key} to different values (GA-SAFE-11)`);
        }
      }
    }
  }
}

/**
 * Applies a change set to a copy of the configuration. Every change is checked before anything is
 * kept, so a set is applied whole or refused whole (GA-CFG-2). `current` is never changed.
 */
export function planChanges(current: Config, changes: Change[], ctx: Ctx): { draft: Config; diff: string[] } & Required<Effects> {
  const draft = copyConfig(current);
  const diff: string[] = [];
  const work: Work = { ...ctx, devices: new Map(ctx.devices ?? []), forgotten: [], replaced: [], routed: [], unrouted: [], cleared: [], ruled: [] };
  changes.forEach((change, i) => {
    try {
      // A rule's delete is taken whatever is claimed: an owner whose claim lapsed can still remove one.
      const removal = change.kind === "safety_rule" && change.op === "delete";
      if (SAFE_KINDS.has(change.kind) && !removal && !claimsOf(draft, ctx).includes("Safe")) {
        throw new RequestError("not_claimed", `${change.kind} needs the Safe level, which this applier does not claim`);
      }
      const kind = Object.hasOwn(KINDS, change.kind) ? KINDS[change.kind] : undefined;
      if (!kind) bad(`kind ${change.kind} is not configurable on this applier`);
      work.at = i;
      const line = kind!(draft, change, work);
      if (line) diff.push(line);
    } catch (err) {
      if (err instanceof RequestError) throw new RequestError(err.code, `changes[${i}]: ${err.message}`, err.data);
      throw err;
    }
  });
  consistent(draft, ctx.mutant);
  // Every tier the set gave is judged against the floor the whole set leaves (GA-DESC-14).
  judgeTiers(draft, work);
  // A heating load's cap would have to press a toggle (applier, *The applier's own actuations*, GA-SAFE-13): refused when this
  // set makes the load heating, sets its max_on_s ("a socket whose onoff.turn_off is declared toggles: true cannot carry one",
  // *Loads*), or moves it to new hardware; a re-taught code under a load already heating is a notice instead.
  for (const [id, d] of draft.declarations) {
    const was = current.declarations.get(id);
    const capSet = d.max_on_s !== undefined && d.max_on_s !== was?.max_on_s;
    if (!capSet && (d.load !== "heating" || (was?.load === "heating" && !work.replaced.some((r) => r.replaces === id)))) continue;
    if (work.devices.get(id)?.toggles?.includes("onoff.turn_off") && !ctx.mutant.togglesACapOff) {
      bad(capSet ? `${id}'s onoff.turn_off is declared toggles: true, so it cannot carry a max_on_s: the applier never sends a toggle on its own (GA-SAFE-13)`
        : `${id}'s onoff.turn_off is declared toggles: true, so a heating load's cap could never turn it off: the applier never sends a toggle on its own (GA-SAFE-13)`);
    }
  }
  for (const id of new Set(work.ruled)) {
    const r = draft.rules.get(id);
    if (r) checkRule(draft, r, work);
  }
  return { draft, diff, forgotten: work.forgotten, replaced: work.replaced, routed: work.routed, unrouted: work.unrouted, cleared: work.cleared };
}
