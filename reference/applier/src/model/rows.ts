import type { Tx } from "../core/db.js";
import type { HeldDevice, HeldTransport } from "./home.js";

/**
 * A bridge's devices as the model holds them, written behind. A row is found by its bridge device, not
 * by its id: a replacement may have re-pointed the id at other hardware while this write waited in
 * line, and then the row of that bridge device, whatever its id, takes the new document. A device
 * whose id another bridge device took meanwhile is written nothing: the model mints it a new id and
 * writes it again. Safe to run twice, and never a fault of the store.
 */
export async function saveDevices(tx: Tx, devices: HeldDevice[]): Promise<void> {
  for (const d of devices) {
    const doc = JSON.stringify(d.doc);
    const r = await tx.query("UPDATE devices SET doc = $3, folded_into = $4 WHERE bridge = $1 AND bridge_device = $2 RETURNING id",
      [d.bridge, d.bridge_device, doc, d.into ?? null]);
    if (r.rows.length) continue;
    await tx.query("INSERT INTO devices (id, bridge, bridge_device, doc, folded_into) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [d.id, d.bridge, d.bridge_device, doc, d.into ?? null]);
  }
}

/** Devices the owner forgot: their rows, and so their place in the id map, go. Safe to run twice. */
export async function forgetDevices(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length) await tx.query("DELETE FROM devices WHERE id = ANY($1)", [ids]);
}

/**
 * Replacements (GA-ADOPT-2): each `to.id` now names the bridge device `to` describes, and `from`, the
 * id that hardware had, is no more. Whatever row held that bridge device goes first, so the id map
 * never holds it twice. Safe to run twice.
 */
export async function repointDevices(tx: Tx, moves: { from: string; to: HeldDevice }[]): Promise<void> {
  for (const { from, to } of moves) {
    await tx.query("DELETE FROM devices WHERE id = $1 OR (bridge = $2 AND bridge_device = $3 AND id <> $4)",
      [from, to.bridge, to.bridge_device, to.id]);
    await tx.query("INSERT INTO devices (id, bridge, bridge_device, doc, folded_into) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO UPDATE "
      + "SET bridge = EXCLUDED.bridge, bridge_device = EXCLUDED.bridge_device, doc = EXCLUDED.doc, folded_into = EXCLUDED.folded_into",
      [to.id, to.bridge, to.bridge_device, JSON.stringify(to.doc), to.into ?? null]);
  }
}

/**
 * The rows a route leaves (GA-BUS-11), each whole: its id, the bridge device it now names, and the
 * device it is folded into. Whatever rows held those ids or those bridge devices go first, so a swap
 * of two ids lands whole. Safe to run twice.
 */
export async function placeDevices(tx: Tx, rows: HeldDevice[]): Promise<void> {
  for (const d of rows) {
    await tx.query("DELETE FROM devices WHERE id = $1 OR (bridge = $2 AND bridge_device = $3)", [d.id, d.bridge, d.bridge_device]);
  }
  for (const d of rows) {
    await tx.query("INSERT INTO devices (id, bridge, bridge_device, doc, folded_into) VALUES ($1, $2, $3, $4, $5)",
      [d.id, d.bridge, d.bridge_device, JSON.stringify(d.doc), d.into ?? null]);
  }
}

/** Transports that left the model. Safe to run twice. */
export async function forgetTransports(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length) await tx.query("DELETE FROM transports WHERE id = ANY($1)", [ids]);
}

/** The transports of the model; a kind changed is an update. Safe to run twice. */
export async function saveTransports(tx: Tx, transports: HeldTransport[]): Promise<void> {
  for (const t of transports) {
    await tx.query("INSERT INTO transports (id, bridge, bridge_transport, kind) VALUES ($1, $2, $3, $4) "
      + "ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind", [t.id, t.bridge, t.bridge_transport, t.kind]);
  }
}
