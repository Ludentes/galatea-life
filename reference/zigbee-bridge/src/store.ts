import type { Db } from "./db.js";

/** A device as the store keeps it: the hardware it is, and which admission of that hardware. */
export interface StoredDevice {
  deviceId: string;
  hardwareId: string;
  /** Counts the hardware's admissions, so that a re-admission gets a new id (GA-BRIDGE-35). */
  admission: number;
  /** When its latest check-in reached the bridge, as last saved (GA-BRIDGE-31, GA-BRIDGE-37). */
  lastCheckIn: number | null;
}

/** A setting's last observed value, and the time of the observation (GA-BRIDGE-74). */
export interface StoredSetting {
  value: unknown;
  at: number;
}

/**
 * What the core asks of the store; `Store` in production, an in-memory one in the core's unit tests.
 * Admissions and removals come one at a time, from the core's event chain. The check-in and settings
 * saves (`Keeping`) run beside that chain, each one at a time with itself, so a save can overlap an
 * admission or a removal: each call is one statement or one transaction of its own, and memory
 * changes only once its write succeeded, so no call depends on another's order.
 */
export interface DeviceStore {
  device(hardwareId: string): StoredDevice | undefined;
  /** Every hardware's device now. */
  devices(): StoredDevice[];
  /**
   * A new admission of the hardware, whose device the caller holds as `previous` (null for none): a
   * device id never given before. A try whose answer was lost, but which the store took, is found
   * at the next call and returned, not admitted twice.
   */
  admit(hardwareId: string, previous?: string | null): Promise<StoredDevice>;
  /** The hardware's device left: it stops being the hardware's device, and its row stays, so that its id is never given again. */
  remove(hardwareId: string): Promise<void>;
  saveCheckIns(entries: { deviceId: string; at: number }[]): Promise<void>;
  /** The device's settings as last saved: those that drive its declarations (GA-BRIDGE-74). */
  settings(deviceId: string): Record<string, StoredSetting>;
  saveSettings(entries: { deviceId: string; key: string; value: unknown; at: number }[]): Promise<void>;
  /** Forgets every kept setting of the device: it was interviewed again (GA-BRIDGE-79). */
  forgetSettings(deviceId: string): Promise<void>;
  /** The awaited keys the device has reported once, sorted (GA-BRIDGE-80): never held back again. */
  reported(deviceId: string): string[];
  /** Writes keys reported for the first time; a key written already keeps its first time. */
  saveReported(entries: { deviceId: string; key: string; at: number }[]): Promise<void>;
  /** The device's undescribed names, in the order first seen, each with when (GA-BRIDGE-76). */
  undescribed(deviceId: string): { name: string; at: number }[];
  /** Writes names newly undescribed, and forgets those now described; a name written already keeps its first time. */
  saveUndescribed(added: { deviceId: string; name: string; at: number }[], gone: { deviceId: string; name: string }[]): Promise<void>;
  meta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;
  /** The hardware a device id was given to, whether it is that hardware's device now or not; undefined for an id never given. */
  hardwareOf(deviceId: string): string | undefined;
  /** The id of the hardware's latest admission, whether it is in use now or not; undefined for hardware never admitted. */
  lastDeviceOf(hardwareId: string): string | undefined;
  /** The blocklist (GA-BRIDGE-27, 31): each hardware id kept out of the network, with when it was put there. */
  blocked(): { hardwareId: string; since: number }[];
  /** Puts the hardware on the blocklist; already there, it keeps its first time. */
  block(hardwareId: string, at: number): Promise<void>;
  /** Takes the hardware off the blocklist, whether it was there or not. */
  unblock(hardwareId: string): Promise<void>;
}

/**
 * The schema's migrations, in order, each applied once. They name no schema: the tables land in the
 * one the installation made for the bridge's role (`bridge_zigbee`), which its search path finds
 * first because it bears the role's name (the storage design, *Inside a build*).
 */
const MIGRATIONS: [name: string, sql: string][] = [
  ["0001_bridge", `
    -- Every id ever given stays, so that none is given twice (GA-BRIDGE-35); present marks the one in use.
    CREATE TABLE devices (
      device_id text PRIMARY KEY,
      hardware_id text NOT NULL,
      admission integer NOT NULL,
      last_check_in timestamptz,
      present boolean NOT NULL DEFAULT true,
      UNIQUE (hardware_id, admission)
    );
    CREATE UNIQUE INDEX devices_present ON devices (hardware_id) WHERE present;
    CREATE TABLE blocked (hardware_id text PRIMARY KEY, since timestamptz NOT NULL);
    CREATE TABLE settings (
      device_id text NOT NULL REFERENCES devices,
      key text NOT NULL,
      value jsonb NOT NULL,
      observed_at timestamptz NOT NULL,
      PRIMARY KEY (device_id, key)
    );
    CREATE TABLE meta (key text PRIMARY KEY, value text NOT NULL);
  `],
  ["0002_reported_keys", `
    -- The awaited keys each device has reported once (GA-BRIDGE-80): declared from then on, across restarts.
    CREATE TABLE reported_keys (
      device_id text NOT NULL REFERENCES devices,
      key text NOT NULL,
      first_at timestamptz NOT NULL,
      PRIMARY KEY (device_id, key)
    );
  `],
  ["0003_undescribed", `
    -- Data each device sent that no key describes, in the order first seen (GA-BRIDGE-76): kept across restarts (GA-BRIDGE-31).
    CREATE TABLE undescribed (
      device_id text NOT NULL REFERENCES devices,
      name text NOT NULL,
      first_seen timestamptz NOT NULL,
      seq bigserial NOT NULL,
      PRIMARY KEY (device_id, name)
    );
  `],
];

/**
 * The id for a new admission of `hardwareId`: the hardware id itself, made safe for a topic, or the
 * first of `<it>-2`, `<it>-3` … that `used` does not hold. `used` holds every id the bridge ever gave.
 */
export function deviceIdFor(hardwareId: string, used: ReadonlySet<string>): string {
  const base = hardwareId.replace(/[+#/]/g, "_");
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

const at = (v: unknown): number | null => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());

/**
 * What the bridge keeps in Postgres (the design, *The store*). Reads happen at open, and again after
 * a write whose answer was lost; every other call writes, and throws a `StoreError` when the store
 * is away, having changed nothing in memory.
 */
export class Store implements DeviceStore {
  private present = new Map<string, StoredDevice>();
  private used = new Set<string>();
  private kept = new Map<string, Record<string, StoredSetting>>();
  private reportedKeys = new Map<string, Set<string>>();
  private unnamed = new Map<string, { name: string; at: number }[]>();
  /** Every device id ever given, with its hardware; and each hardware's latest admission. */
  private owners = new Map<string, string>();
  private latest = new Map<string, { deviceId: string; admission: number }>();
  private blocklist = new Map<string, number>();
  /** A write failed, and may have been taken: memory is read again from the store before the next admission. */
  private stale = false;

  private constructor(private readonly db: Db) {}

  /** Applies the migrations not yet applied, then reads every device and setting. */
  static async open(db: Db): Promise<Store> {
    await db.transaction(async (tx) => {
      await tx.exec("CREATE TABLE IF NOT EXISTS migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await tx.query<{ name: string }>("SELECT name FROM migrations")).rows.map((r) => r.name));
      for (const [name, sql] of MIGRATIONS) {
        if (done.has(name)) continue;
        await tx.exec(sql);
        await tx.query("INSERT INTO migrations (name) VALUES ($1)", [name]);
      }
    });
    const store = new Store(db);
    await store.reload();
    return store;
  }

  /** Reads every device and setting into memory, replacing what memory held. */
  private async reload(): Promise<void> {
    const rows = await this.db.query<{ device_id: string; hardware_id: string; admission: number; last_check_in: unknown; present: boolean }>(
      "SELECT device_id, hardware_id, admission, last_check_in, present FROM devices");
    const settings = await this.db.query<{ device_id: string; key: string; value: unknown; observed_at: unknown }>(
      "SELECT device_id, key, value, observed_at FROM settings");
    const blocked = await this.db.query<{ hardware_id: string; since: unknown }>("SELECT hardware_id, since FROM blocked");
    const reportedRows = await this.db.query<{ device_id: string; key: string }>("SELECT device_id, key FROM reported_keys");
    const unnamedRows = await this.db.query<{ device_id: string; name: string; first_seen: unknown }>(
      "SELECT device_id, name, first_seen FROM undescribed ORDER BY seq");
    const present = new Map<string, StoredDevice>();
    const used = new Set<string>();
    const owners = new Map<string, string>();
    const latest = new Map<string, { deviceId: string; admission: number }>();
    for (const r of rows.rows) {
      used.add(r.device_id);
      owners.set(r.device_id, r.hardware_id);
      const last = latest.get(r.hardware_id);
      if (!last || r.admission > last.admission) latest.set(r.hardware_id, { deviceId: r.device_id, admission: r.admission });
      if (r.present) {
        present.set(r.hardware_id, { deviceId: r.device_id, hardwareId: r.hardware_id, admission: r.admission,
          lastCheckIn: at(r.last_check_in) });
      }
    }
    const kept = new Map<string, Record<string, StoredSetting>>();
    for (const r of settings.rows) {
      const of = kept.get(r.device_id) ?? {};
      of[r.key] = { value: r.value, at: at(r.observed_at)! };
      kept.set(r.device_id, of);
    }
    this.present = present;
    this.used = used;
    this.owners = owners;
    this.latest = latest;
    this.kept = kept;
    const reported = new Map<string, Set<string>>();
    for (const r of reportedRows.rows) reported.set(r.device_id, (reported.get(r.device_id) ?? new Set()).add(r.key));
    this.reportedKeys = reported;
    const unnamed = new Map<string, { name: string; at: number }[]>();
    for (const r of unnamedRows.rows) unnamed.set(r.device_id, [...(unnamed.get(r.device_id) ?? []), { name: r.name, at: at(r.first_seen)! }]);
    this.unnamed = unnamed;
    this.blocklist = new Map(blocked.rows.map((r) => [r.hardware_id, at(r.since)!]));
    this.stale = false;
  }

  /** The device the hardware is now, if it has been admitted. */
  device(hardwareId: string): StoredDevice | undefined {
    return this.present.get(hardwareId);
  }

  devices(): StoredDevice[] {
    return [...this.present.values()];
  }

  /**
   * A new admission of the hardware: a device id never given before, written before it is used. An
   * earlier admission of the same hardware stops being the hardware's device. After a try whose
   * answer was lost, the store is read again first: a device of the hardware that is not `previous`
   * is that try's, taken by the store, and is returned.
   */
  async admit(hardwareId: string, previous: string | null = this.present.get(hardwareId)?.deviceId ?? null): Promise<StoredDevice> {
    if (this.stale) {
      await this.reload();
      const landed = this.present.get(hardwareId);
      if (landed && landed.deviceId !== previous) return landed;
    }
    const deviceId = deviceIdFor(hardwareId, this.used);
    const admission = (this.present.get(hardwareId)?.admission ?? await this.lastAdmission(hardwareId)) + 1;
    try {
      await this.db.transaction(async (tx) => {
        await tx.query("UPDATE devices SET present = false WHERE hardware_id = $1 AND present", [hardwareId]);
        await tx.query("INSERT INTO devices (device_id, hardware_id, admission) VALUES ($1, $2, $3)", [deviceId, hardwareId, admission]);
      });
    } catch (err) {
      // The commit may have been taken with its answer lost: the next admission reads the store first.
      this.stale = true;
      throw err;
    }
    const d: StoredDevice = { deviceId, hardwareId, admission, lastCheckIn: null };
    this.used.add(deviceId);
    this.owners.set(deviceId, hardwareId);
    this.latest.set(hardwareId, { deviceId, admission });
    this.present.set(hardwareId, d);
    return d;
  }

  async remove(hardwareId: string): Promise<void> {
    await this.db.query("UPDATE devices SET present = false WHERE hardware_id = $1 AND present", [hardwareId]);
    this.present.delete(hardwareId);
  }

  /** Writes each device's latest check-in. */
  async saveCheckIns(entries: { deviceId: string; at: number }[]): Promise<void> {
    if (!entries.length) return;
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        await tx.query("UPDATE devices SET last_check_in = $2 WHERE device_id = $1", [e.deviceId, new Date(e.at).toISOString()]);
      }
    });
    for (const e of entries) {
      for (const d of this.present.values()) if (d.deviceId === e.deviceId) d.lastCheckIn = e.at;
    }
  }

  settings(deviceId: string): Record<string, StoredSetting> {
    return { ...(this.kept.get(deviceId) ?? {}) };
  }

  /** Writes each setting's last observed value, with its observation's time. */
  async saveSettings(entries: { deviceId: string; key: string; value: unknown; at: number }[]): Promise<void> {
    if (!entries.length) return;
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        await tx.query(`INSERT INTO settings (device_id, key, value, observed_at) VALUES ($1, $2, $3::jsonb, $4)
          ON CONFLICT (device_id, key) DO UPDATE SET value = $3::jsonb, observed_at = $4`,
        [e.deviceId, e.key, JSON.stringify(e.value), new Date(e.at).toISOString()]);
      }
    });
    for (const e of entries) {
      const of = this.kept.get(e.deviceId) ?? {};
      of[e.key] = { value: e.value, at: e.at };
      this.kept.set(e.deviceId, of);
    }
  }

  reported(deviceId: string): string[] {
    return [...(this.reportedKeys.get(deviceId) ?? [])].sort();
  }

  async saveReported(entries: { deviceId: string; key: string; at: number }[]): Promise<void> {
    if (!entries.length) return;
    await this.db.transaction(async (tx) => {
      for (const e of entries) {
        await tx.query("INSERT INTO reported_keys (device_id, key, first_at) VALUES ($1, $2, $3) ON CONFLICT (device_id, key) DO NOTHING",
          [e.deviceId, e.key, new Date(e.at).toISOString()]);
      }
    });
    for (const e of entries) this.reportedKeys.set(e.deviceId, (this.reportedKeys.get(e.deviceId) ?? new Set()).add(e.key));
  }

  undescribed(deviceId: string): { name: string; at: number }[] {
    return [...(this.unnamed.get(deviceId) ?? [])];
  }

  async saveUndescribed(added: { deviceId: string; name: string; at: number }[], gone: { deviceId: string; name: string }[]): Promise<void> {
    if (!added.length && !gone.length) return;
    await this.db.transaction(async (tx) => {
      for (const g of gone) await tx.query("DELETE FROM undescribed WHERE device_id = $1 AND name = $2", [g.deviceId, g.name]);
      for (const a of added) {
        await tx.query("INSERT INTO undescribed (device_id, name, first_seen) VALUES ($1, $2, $3) ON CONFLICT (device_id, name) DO NOTHING",
          [a.deviceId, a.name, new Date(a.at).toISOString()]);
      }
    });
    for (const g of gone) this.unnamed.set(g.deviceId, (this.unnamed.get(g.deviceId) ?? []).filter((u) => u.name !== g.name));
    for (const a of added) {
      const of = this.unnamed.get(a.deviceId) ?? [];
      if (!of.some((u) => u.name === a.name)) this.unnamed.set(a.deviceId, [...of, { name: a.name, at: a.at }]);
    }
  }

  async forgetSettings(deviceId: string): Promise<void> {
    await this.db.query("DELETE FROM settings WHERE device_id = $1", [deviceId]);
    this.kept.delete(deviceId);
  }

  async meta(key: string): Promise<string | undefined> {
    return (await this.db.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [key])).rows[0]?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.db.query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [key, value]);
  }

  hardwareOf(deviceId: string): string | undefined {
    return this.owners.get(deviceId);
  }

  lastDeviceOf(hardwareId: string): string | undefined {
    return this.latest.get(hardwareId)?.deviceId;
  }

  blocked(): { hardwareId: string; since: number }[] {
    return [...this.blocklist].map(([hardwareId, since]) => ({ hardwareId, since }));
  }

  async block(hardwareId: string, at: number): Promise<void> {
    await this.db.query("INSERT INTO blocked (hardware_id, since) VALUES ($1, $2) ON CONFLICT (hardware_id) DO NOTHING",
      [hardwareId, new Date(at).toISOString()]);
    if (!this.blocklist.has(hardwareId)) this.blocklist.set(hardwareId, at);
  }

  async unblock(hardwareId: string): Promise<void> {
    await this.db.query("DELETE FROM blocked WHERE hardware_id = $1", [hardwareId]);
    this.blocklist.delete(hardwareId);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  private async lastAdmission(hardwareId: string): Promise<number> {
    const r = await this.db.query<{ n: number | null }>("SELECT max(admission) AS n FROM devices WHERE hardware_id = $1", [hardwareId]);
    return r.rows[0]?.n ?? 0;
  }
}
