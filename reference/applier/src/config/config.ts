import type { Tx } from "../core/db.js";
import { getMeta, setMeta } from "../core/store.js";
import { canonical } from "../core/canonical.js";
import type { Declarations } from "../model/declarations.js";
import type { SafetyRule } from "../safety/language.js";

export type Level = "Act" | "Safe";
/** A client: its bearer credential is held only as its SHA-256 (`hashSecret`), in memory and in the store. */
export type Client = { id: string; credential_sha256: string; token_key?: string; kind: "steward" | "parent" };
export type Bridge = { id: string; identity: string };
/** The owner's adoption of a device (applier, *Adoption*): its class is the owner's. */
export type Adoption = { class: string | null };
export type Config = {
  clients: Map<string, Client>; bridges: Map<string, Bridge>; adoptions: Map<string, Adoption>;
  /** The owner's declarations, by device id (applier, *Action declarations*, *configure*). */
  declarations: Map<string, Declarations>;
  /** The identifiers of the hardware each device replaced, oldest first (applier, *Adoption*). */
  previous: Map<string, string[]>;
  /** The bridge that carries each stable identifier two bridges report (GA-BUS-11): the owner's route. */
  routes: Map<string, string>;
  timeSource?: string;
  /** The owner's safety rules, by id (applier, *Safety rules*). */
  rules: Map<string, SafetyRule>;
  /**
   * The safety rules a change of their devices' declarations disabled, with why (GA-SAFE-13): kept,
   * firing no more, until the owner sets the rule again.
   */
  disabled: Map<string, string>;
  /** The owner's word that the box passes GA-BOX-1 (applier, *Bridges*): an applier over bridges claims Safe only with it (GA-DESC-6). */
  box: boolean;
  /**
   * The owner's ignored candidate keys (applier, *Discovery*, GA-DISC-3): kept across a restart, and
   * never the model (`modelKey` leaves them out).
   */
  ignored_keys: Set<string>;
  /**
   * Whether this build can claim Safe: then a socket whose load was never configured is taken as
   * `heating` (GA-DESC-8). The build's, never stored; set by the applier on every configuration it holds.
   */
  safe?: boolean;
};

export function emptyConfig(): Config {
  return { clients: new Map(), bridges: new Map(), adoptions: new Map(), declarations: new Map(), previous: new Map(), routes: new Map(),
    rules: new Map(), disabled: new Map(), box: false, ignored_keys: new Set() };
}

export function copyConfig(c: Config): Config {
  return { clients: new Map(c.clients), bridges: new Map(c.bridges), adoptions: new Map(c.adoptions),
    declarations: new Map([...c.declarations].map(([id, d]) => [id, structuredClone(d)])),
    previous: new Map([...c.previous].map(([id, p]) => [id, [...p]])), routes: new Map(c.routes), timeSource: c.timeSource,
    rules: new Map([...c.rules].map(([id, r]) => [id, structuredClone(r)])), disabled: new Map(c.disabled), box: c.box,
    ignored_keys: new Set(c.ignored_keys), ...(c.safe !== undefined ? { safe: c.safe } : {}) };
}

export async function loadConfig(q: Pick<Tx, "query">, o: { forgetsIgnores?: boolean } = {}): Promise<Config> {
  const c = emptyConfig();
  const clients = await q.query<{ id: string; credential_sha256: string; token_key: string | null; kind: Client["kind"] }>(
    "SELECT id, credential_sha256, token_key, kind FROM clients ORDER BY id");
  for (const r of clients.rows) {
    c.clients.set(r.id, { id: r.id, credential_sha256: r.credential_sha256, kind: r.kind, ...(r.token_key ? { token_key: r.token_key } : {}) });
  }
  const bridges = await q.query<Bridge>("SELECT id, identity FROM bridges ORDER BY id");
  for (const r of bridges.rows) c.bridges.set(r.id, { id: r.id, identity: r.identity });
  const adoptions = await q.query<{ device: string; class: string | null }>("SELECT device, class FROM adoptions ORDER BY device");
  for (const r of adoptions.rows) c.adoptions.set(r.device, { class: r.class });
  const declarations = await q.query<{ device: string; body: Declarations }>("SELECT device, body FROM declarations ORDER BY device");
  for (const r of declarations.rows) c.declarations.set(r.device, r.body);
  const previous = await q.query<{ device: string; identifiers: string[] }>("SELECT device, identifiers FROM previous_identifiers ORDER BY device");
  for (const r of previous.rows) c.previous.set(r.device, r.identifiers);
  const routes = await q.query<{ stable_identifier: string; bridge: string }>("SELECT stable_identifier, bridge FROM routes ORDER BY stable_identifier");
  for (const r of routes.rows) c.routes.set(r.stable_identifier, r.bridge);
  const rules = await q.query<{ id: string; body: SafetyRule; disabled: string | null }>("SELECT id, body, disabled FROM safety_rules ORDER BY id");
  for (const r of rules.rows) {
    c.rules.set(r.id, r.body);
    if (r.disabled !== null) c.disabled.set(r.id, r.disabled);
  }
  c.timeSource = await getMeta(q, "time_source");
  c.box = (await getMeta(q, "box")) === "1";
  // `forgets-an-ignore`: the owner's ignores are not read back.
  if (!o.forgetsIgnores) {
    const ignored = await q.query<{ key: string }>("SELECT key FROM ignored_keys ORDER BY key");
    for (const r of ignored.rows) c.ignored_keys.add(r.key);
  }
  return c;
}

/** Writes the whole configuration, as one write set; it is safe to run twice. `now` stamps an ignored key first added. */
export async function saveConfig(tx: Tx, c: Config, now = 0): Promise<void> {
  await tx.query("DELETE FROM clients");
  await tx.query("DELETE FROM bridges");
  await tx.query("DELETE FROM adoptions");
  await tx.query("DELETE FROM declarations");
  await tx.query("DELETE FROM previous_identifiers");
  await tx.query("DELETE FROM routes");
  await tx.query("DELETE FROM safety_rules");
  for (const x of c.clients.values()) {
    await tx.query("INSERT INTO clients (id, credential_sha256, token_key, kind) VALUES ($1, $2, $3, $4)",
      [x.id, x.credential_sha256, x.token_key ?? null, x.kind]);
  }
  for (const x of c.bridges.values()) {
    await tx.query("INSERT INTO bridges (id, identity) VALUES ($1, $2)", [x.id, x.identity]);
  }
  for (const [device, a] of c.adoptions) {
    await tx.query("INSERT INTO adoptions (device, class) VALUES ($1, $2)", [device, a.class]);
  }
  for (const [device, d] of c.declarations) {
    await tx.query("INSERT INTO declarations (device, body) VALUES ($1, $2)", [device, JSON.stringify(d)]);
  }
  for (const [device, p] of c.previous) {
    await tx.query("INSERT INTO previous_identifiers (device, identifiers) VALUES ($1, $2)", [device, JSON.stringify(p)]);
  }
  for (const [sid, bridge] of c.routes) {
    await tx.query("INSERT INTO routes (stable_identifier, bridge) VALUES ($1, $2)", [sid, bridge]);
  }
  for (const [id, r] of c.rules) {
    await tx.query("INSERT INTO safety_rules (id, body, disabled) VALUES ($1, $2, $3)", [id, JSON.stringify(r), c.disabled.get(id) ?? null]);
  }
  if (c.timeSource) await setMeta(tx, "time_source", c.timeSource);
  else await tx.query("DELETE FROM meta WHERE key = 'time_source'");
  await setMeta(tx, "box", c.box ? "1" : "0");
  // The ignores, in the owner's own write set (GA-DISC-3): a key kept keeps when it was added.
  await tx.query("DELETE FROM ignored_keys WHERE NOT (key = ANY($1))", [[...c.ignored_keys]]);
  for (const k of c.ignored_keys) {
    await tx.query("INSERT INTO ignored_keys (key, added_ms) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [k, Math.floor(now)]);
  }
}

/** What `describe` shows of the configuration: a change to it is a model change (GA-DESC-2). */
export function modelKey(c: Config): string {
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Secrets are not the model: rotating a credential or a token key must not stale plans in flight.
  const clients = sorted(c.clients).map(([id, cl]) => [id, cl.kind]);
  // Declarations compare in canonical form: the store's jsonb gives their keys back in its own order.
  return JSON.stringify([clients, sorted(c.bridges), sorted(c.adoptions), canonical(sorted(c.declarations)), sorted(c.previous),
    sorted(c.routes), c.box, canonical(sorted(c.rules)), sorted(c.disabled)]);
}
