// The kinds of access: clients, bridges and the applier's hosts.
import { hashSecret, sameSecret } from "../../core/secret.js";
import type { Bridge, Client } from "../config.js";
import { bad, checked, declared, deleting, device, idOf, type Kind, tidy } from "./common.js";

export const accessKinds: Record<string, Kind> = {
  client(draft, change, ctx) {
    if (change.op === "delete") {
      const id = (change.value as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string" || !draft.clients.has(id)) return bad(`no client ${String(id)}`);
      draft.clients.delete(id);
      return `- client ${id}`;
    }
    const c = checked<Omit<Client, "credential_sha256"> & { credential: string }>("applier/configure.client.json", change.value);
    // Only its SHA-256 is held (the whole-applier review's M6).
    const hash = hashSecret(c.credential);
    const next: Client = { id: c.id, credential_sha256: hash, kind: c.kind, ...(c.token_key ? { token_key: c.token_key } : {}) };
    if (sameSecret(c.credential, ctx.ownerCredential)) bad("a client may not hold the owner's credential");
    // Two secrets, so a leaked bearer does not also mint a person's yes (the design's token_key).
    if (c.token_key !== undefined && c.token_key === c.credential) bad("a client's token key may not be its credential");
    for (const other of draft.clients.values()) {
      if (other.id !== c.id && sameSecret(other.credential_sha256, hash)) bad(`client ${other.id} already holds that credential`);
    }
    const held = draft.clients.get(c.id);
    draft.clients.set(c.id, next);
    if (held && JSON.stringify(held) === JSON.stringify(next)) return undefined;
    return `${held ? "~" : "+"} client ${c.id} (${c.kind})`;
  },
  bridge(draft, change, ctx) {
    if (change.op === "delete") {
      const id = idOf(change.value);
      if (!draft.bridges.has(id)) bad(`no bridge ${id}`);
      draft.bridges.delete(id);
      return `- bridge ${id}`;
    }
    const b = checked<Bridge>("applier/configure.bridge.json", change.value);
    // One identity, one bridge: messages are routed by identity, so a second bridge on it would never be
    // fed, and deleting either would unsubscribe the topics the other hears.
    if (ctx.ownIdentity !== undefined && b.identity === ctx.ownIdentity) bad(`identity ${b.identity} is the applier's own`);
    for (const other of draft.bridges.values()) {
      if (other.id !== b.id && other.identity === b.identity) bad(`bridge ${other.id} already holds identity ${b.identity}`);
    }
    const held = draft.bridges.get(b.id);
    draft.bridges.set(b.id, { id: b.id, identity: b.identity });
    if (held && held.identity === b.identity) return undefined;
    return `${held ? "~" : "+"} bridge ${b.id}`;
  },
  /**
   * `applier_host` (applier, *Devices*): the computer the applier itself runs on; its administrators are
   * not the other admins of the broker it carries (GA-SAFE-6). That it names an adopted computer, and
   * no second one, is checked on the whole set (`consistent`, GA-CFG-3). Its delete clears it.
   */
  applier_host(draft, change, ctx) {
    if (change.op === "delete") {
      const { device: id } = deleting(change.value, ["device"]);
      device(ctx, id);
      const d = draft.declarations.get(id);
      if (d?.applier_host === undefined) return undefined;
      delete d.applier_host;
      tidy(draft, id);
      return `- applier_host ${id}`;
    }
    const v = checked<{ device: string; applier_host: boolean }>("applier/configure.applier_host.json", change.value);
    device(ctx, v.device);
    const d = declared(draft, v.device);
    if ((d.applier_host ?? false) === v.applier_host) return undefined;
    if (v.applier_host) d.applier_host = true;
    else delete d.applier_host;
    tidy(draft, v.device);
    return `~ applier_host ${v.device} ${v.applier_host}`;
  },
};
