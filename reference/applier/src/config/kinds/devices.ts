// The kinds of the model's devices: adoption, replacement, forgetting and routes.
import { RequestError } from "../../core/errors.js";
import { type AdoptValue, bad, checked, claimsOf, declare, deleting, device, drop, type Kind, replace, SAFE_DECLARATIONS } from "./common.js";

export const devicesKinds: Record<string, Kind> = {
  /**
   * `adopt { device, class, declarations?, replaces? }` (applier, *Adoption*): a device the model
   * holds, with the owner's class and declarations, each declaration checked as its kind is.
   * A null class is only for a plugin device or a wake relay's entry, which the PC slice brings: it
   * is refused here until then. Its delete makes the device unadopted again.
   */
  adopt(draft, change, ctx) {
    if (change.op === "delete") {
      // The device goes back to unadopted, every action refused again; the owner's declarations,
      // made for the class it had, go with the adoption.
      const { device: id } = deleting(change.value, ["device"]);
      if (!draft.adoptions.has(id)) bad(`${id} is not adopted`);
      drop(draft, id, { retired: false });
      return `- adopt ${id}`;
    }
    const raw = (change.value as { declarations?: unknown } | undefined)?.declarations;
    for (const f of SAFE_DECLARATIONS) {
      if (raw && typeof raw === "object" && Object.hasOwn(raw, f) && !claimsOf(draft, ctx).includes("Safe")) {
        throw new RequestError("not_claimed", `declarations.${f} needs the Safe level, which this applier does not claim`);
      }
    }
    const a = checked<AdoptValue>("applier/configure.adopt.json", change.value);
    const info = device(ctx, a.device);
    if (a.class === null) bad(`a class may be null only for a plugin device or a wake relay's entry, and ${a.device} is neither`);
    if (a.replaces !== undefined) return replace(draft, { ...a, replaces: a.replaces }, info, ctx);
    const held = draft.adoptions.get(a.device);
    // GA-BUS-11: a copy another bridge shows beside an adopted device stays a device of its own, never
    // merged; adopting it too would give one piece of hardware two ids. An adoption with replaces moves
    // the adopted device onto it.
    const copy = held ? undefined : [...ctx.devices].find(([id, d]) => id !== a.device && d.bridge !== info.bridge
      && d.stable_identifier === info.stable_identifier)?.[0];
    if (copy) bad(`${a.device} shows the identifier ${JSON.stringify(info.stable_identifier)} that ${copy} shows on another bridge: `
      + `one piece of hardware on two bridges; an adopted device keeps its bridge, and an adoption of ${a.device} with replaces `
      + `${copy} moves it here`);
    // Route first: the one device two bridges report is adopted only once the owner says which carries it.
    if (!held && info.copies?.length && !draft.routes.has(info.stable_identifier)) {
      bad(`${a.device} is one device that bridges ${[info.bridge, ...info.copies].join(", ")} report: route it first `
        + `(a route of ${JSON.stringify(info.stable_identifier)} to one of them), then adopt it`);
    }
    draft.adoptions.set(a.device, { class: a.class });
    const lines = held && held.class === a.class ? [] : [`${held ? "~" : "+"} adopt ${a.device} (${a.class})`];
    lines.push(...declare(draft, a.device, info, a.declarations ?? {}, ctx.mutant, ctx));
    return lines.join("\n") || undefined;
  },
  /**
   * `forget { device }` (applier, *configure*): removes an unadopted or `left` device from the model,
   * its adoption, declarations and replaced identifiers with it; refused while its bridge's `devices`
   * still lists it, or before this life has heard that document (GA-ADOPT-1). The PC slice adds the
   * `wake_via` refusal and GA-PROV-4's exception, and slice 6 the safety rule's.
   */
  forget(draft, change, ctx) {
    if (change.op === "delete") bad("a forget is not undone: the device comes back new when its bridge lists it again");
    const { device: id } = checked<{ device: string }>("applier/configure.forget.json", change.value);
    const info = device(ctx, id);
    if (ctx.replaced.some((r) => r.replaces === id)) bad(`${id} is replaced in this change set: it names the new hardware now`);
    if (info.in_devices) bad(`${id} is still in its bridge's devices, or its bridge has not said otherwise: remove it there first`);
    drop(draft, id, { retired: true });
    ctx.devices.delete(id);
    ctx.forgotten.push(id);
    return `- device ${id}`;
  },
  /**
   * `route { stable_identifier, bridge }` (GA-BUS-11): the bridge that carries hardware two bridges
   * report. The identifier's one device takes the copy on that bridge, and the copies on other bridges
   * fold into it. Refused for a bridge not registered, for one that shows no copy, for one that shows
   * two (hardware admitted anew there, which `replaces` takes), and while a device showing the
   * identifier is adopted: an adopted device keeps its bridge, and a route never moves it (an adoption
   * with replaces does). Its delete names the identifier alone, and is refused while its device is
   * adopted, since route first is what let it be adopted.
   */
  route(draft, change, ctx) {
    if (change.op === "delete") {
      const sid = (change.value as { stable_identifier?: unknown } | undefined)?.stable_identifier;
      if (typeof sid !== "string" || !draft.routes.has(sid)) return bad(`no route for ${JSON.stringify(sid)}`);
      const shown = [...ctx.devices].filter(([, d]) => d.stable_identifier === sid).map(([id]) => id);
      const adopted = shown.find((id) => draft.adoptions.has(id));
      if (adopted) bad(`${adopted} is adopted: its route stays while it is (route first)`);
      draft.routes.delete(sid);
      ctx.unrouted.push(...shown);
      return `- route ${sid}`;
    }
    const r = checked<{ stable_identifier: string; bridge: string }>("applier/configure.route.json", change.value);
    if (!draft.bridges.has(r.bridge)) bad(`no bridge ${r.bridge}`);
    const group = [...ctx.devices].filter(([, d]) => d.stable_identifier === r.stable_identifier);
    if (!group.length) bad(`no device shows ${JSON.stringify(r.stable_identifier)}`);
    const held = draft.routes.get(r.stable_identifier);
    const adopted = group.find(([id]) => draft.adoptions.has(id))?.[0];
    if (adopted && held === r.bridge) return undefined;
    if (adopted) bad(`${adopted} is adopted: an adopted device keeps its bridge (GA-BUS-11), so no route moves it; `
      + "an adoption with replaces moves it to other hardware");
    const on = [...group.filter(([, d]) => d.bridge === r.bridge).map(([id]) => id),
      ...group.flatMap(([id, d]) => (d.copies ?? []).filter((b) => b === r.bridge).map(() => `a copy folded into ${id}`))];
    if (!on.length) bad(`bridge ${r.bridge} shows no device with ${JSON.stringify(r.stable_identifier)}`);
    if (on.length > 1) bad(`bridge ${r.bridge} shows ${JSON.stringify(r.stable_identifier)} twice (${on.join(", ")}): `
      + "hardware admitted anew there, which an adoption with replaces takes");
    const device = (group.find(([, d]) => d.bridge === r.bridge) ?? group[0]!)[0];
    draft.routes.set(r.stable_identifier, r.bridge);
    ctx.routed.push({ stable_identifier: r.stable_identifier, device, bridge: r.bridge });
    return held === r.bridge ? undefined : `${held ? "~" : "+"} route ${r.stable_identifier} ${r.bridge}`;
  },
};
