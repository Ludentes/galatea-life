import type { Clock } from "@ludentes/galatea-life-test-clock";
import type { Admission, Description, HardwareId } from "./port.js";
import type { DeviceStore } from "./store.js";

/** A device's check-in is saved at most this often while running, and at every leave (GA-BRIDGE-31). */
export const SAVE_MS = 60_000;
/** A store write that failed is tried again after 1 s, then 2, 4 … never more than this apart. */
export const STORE_RETRY_MS = 1_000;
export const STORE_RETRY_CEILING_MS = 60_000;

/** What the keeping needs of a device: its id, its latest check-in, and what of it was written. */
export interface CheckIns {
  id: string;
  lastCheckIn: number | null;
  /** The check-in last written to the store, and whether a newer one waits to be. */
  savedAt: number | null;
  unsaved: boolean;
}

/** Hardware admitted or described while the store was away, with how it came and its latest description. */
export interface Held {
  how: Admission;
  d?: Description;
  /** The device of the hardware this admission takes out of use, already out of `devices`: the retry's `previous`. */
  previous?: string;
}

export interface KeepingOptions {
  store: DeviceStore;
  clock: Clock;
  /** Whether the bridge is running: a retry is armed only then. */
  running(): boolean;
  /** The devices the bridge has now, whose check-ins it saves. */
  devices(): Iterable<CheckIns>;
  /** `store_fault` named with its detail, or cleared with null; the bridge publishes a change. */
  fault(detail: string | null): void;
  /** Queues the retry on the bridge's event chain, so it runs between the doer's events, never inside one. */
  enqueue(fn: () => Promise<void>): void;
  /** Admits hardware held back for the store, and takes its description, as the doer's events would. */
  readmit(hw: HardwareId, held: Held): Promise<void>;
}

const message = (err: unknown) => String((err as Error)?.message ?? err);

/** A device's unsaved check-in is due for writing: never written, SAVE_MS newer than the store's, or the clock stepped back. */
const saveDue = (d: CheckIns): boolean =>
  d.unsaved && d.lastCheckIn !== null && (d.savedAt === null || d.lastCheckIn - d.savedAt >= SAVE_MS || d.lastCheckIn < d.savedAt);

/**
 * The bridge's store bookkeeping (the design, *The store*): what waits for the store while it is
 * away, and the retry that writes it when it is back. A store fault stops the bridge's writes, not
 * its serving: admissions are held back, removals and settings kept unwritten, check-ins saved at
 * most every SAVE_MS, and the store tried again on a backoff, in the order *The store* gives.
 */
export class Keeping {
  /** Hardware admitted or described while the store was away: admitted only once the store has it. */
  readonly held = new Map<HardwareId, Held>();
  /** Hardware that left while the store was away, with the id it had: its removal is written when the store is back. */
  readonly removals = new Map<HardwareId, string>();
  /** Settings observed and not yet written, by device and key (GA-BRIDGE-74). */
  private readonly settingsDue = new Map<string, { deviceId: string; key: string; value: unknown; at: number }>();
  /** Awaited keys reported for the first time and not yet written, by device and key (GA-BRIDGE-80): written with the settings. */
  private readonly reportedDue = new Map<string, { deviceId: string; key: string; at: number }>();
  /** Devices interviewed again whose kept settings are not yet forgotten in the store (GA-BRIDGE-79). */
  private readonly forgetDue = new Set<string>();
  /** Undescribed names added or gone and not yet written, by device and name (GA-BRIDGE-76): written with the settings. */
  private readonly unnamedDue = new Map<string, { deviceId: string; name: string; at: number | null }>();
  private retryMs = STORE_RETRY_MS;
  private timer: number | null = null;
  /**
   * A store retry is due: from its scheduling until the retry starts, not only until its timer fires,
   * so that a doer event queued ahead of the retry is held for it too.
   */
  private due = false;
  /** The check-in write running, if any, and whether the last one failed. */
  private saving?: Promise<void>;
  private saveFailed = false;
  /** The running write must leave nothing unsaved: a leave or the store's retry asked for every check-in. */
  private saveAll = false;
  /** The settings' write running, if any. */
  private settingsSaving?: Promise<void>;

  constructor(private readonly o: KeepingOptions) {}

  get retryDue(): boolean {
    return this.due;
  }

  /**
   * The leave: what waits for the store is written once more, without the bridge's events (it is
   * going): the removals, and the held new admissions that take a device's id out of use, so that
   * the next start never gives the newcomer that id, nor the PIN configured for it (GA-BRIDGE-35,
   * 36). Then every check-in. What still fails is lost with the process: the doer's report at the
   * next start is all that remains (plan 2b).
   */
  async leaving(): Promise<void> {
    for (const [hw] of [...this.removals]) {
      try {
        await this.o.store.remove(hw);
        this.removals.delete(hw);
      } catch (err) {
        console.error(`leave: a removal not written: ${err}`);
        break;
      }
    }
    for (const [hw, held] of [...this.held]) {
      if (held.previous === undefined) continue;
      try {
        await this.o.store.admit(hw, held.previous);
        this.held.delete(hw);
      } catch (err) {
        console.error(`leave: a new admission of ${hw} not written: ${err}`);
        break;
      }
    }
    await this.saveCheckIns();
  }

  /** The retry is disarmed: the bridge is leaving. */
  stop(): void {
    if (this.timer !== null) this.o.clock.clear(this.timer);
    this.timer = null;
    this.due = false;
  }

  /** A setting's last observed value, kept across restarts (GA-BRIDGE-74): written by `flushSettings`. */
  setting(deviceId: string, key: string, value: unknown, at: number): void {
    this.settingsDue.set(`${deviceId}\u0000${key}`, { deviceId, key, value, at });
  }

  /** An awaited key the device reported for the first time, kept across restarts (GA-BRIDGE-80): written by `flushSettings`. */
  reported(deviceId: string, key: string, at: number): void {
    const k = `${deviceId}\u0000${key}`;
    if (!this.reportedDue.has(k)) this.reportedDue.set(k, { deviceId, key, at });
  }

  /** Every kept setting of the device forgotten, before any observed after (GA-BRIDGE-79): written by `flushSettings`. */
  forgetSettings(deviceId: string): void {
    for (const [k, s] of this.settingsDue) if (s.deviceId === deviceId) this.settingsDue.delete(k);
    this.forgetDue.add(deviceId);
  }

  /** A name undescribed for the first time (`at`), or described now (null), kept across restarts (GA-BRIDGE-76): written by `flushSettings`. */
  undescribed(deviceId: string, name: string, at: number | null): void {
    this.unnamedDue.set(`${deviceId}\u0000${name}`, { deviceId, name, at });
  }

  /** Writes the settings observed, the keys reported and the names undescribed, unless the store's retry carries them. */
  flushSettings(): void {
    if (this.writesDue() && !this.due) this.track(this.saveSettings());
  }

  private writesDue(): boolean {
    return this.forgetDue.size > 0 || this.settingsDue.size > 0 || this.reportedDue.size > 0 || this.unnamedDue.size > 0;
  }

  /** A device's check-in (GA-BRIDGE-37), kept across a restart (GA-BRIDGE-31). */
  checkedIn(dev: CheckIns, at: number): void {
    if (dev.lastCheckIn !== null && dev.lastCheckIn > at) return;
    dev.lastCheckIn = at;
    dev.unsaved = true;
    // Not on every message: a crash loses at most SAVE_MS of it, and a leave saves the last. While the
    // store is away, its retry carries the save, never each message (the backoff of *The store*). Keyed
    // on the retry, not the fault: with no retry due, nothing else would save the check-in.
    if (this.due || this.saving) return;
    if (saveDue(dev)) this.track(this.saveCheckIns(false));
  }

  /**
   * Writes the check-ins newer than the store's; one write at a time. With `all` (a leave, the store's
   * retry) every one is written, those that came during a write included; without it (a check-in that
   * fell due), a check-in that came during the write is written after it only when it is due itself,
   * so that a slow store still sees one write per SAVE_MS, never one after another.
   */
  saveCheckIns(all = true): Promise<void> {
    if (all) this.saveAll = true;
    if (!this.saving) {
      this.saving = this.saveLoop().finally(() => {
        this.saving = undefined;
        this.saveAll = false;
      });
      return this.saving;
    }
    // A save is running, and may already have made its last pass: a full one follows it, so that
    // nothing unsaved is left when it ends (the leave writes every check-in).
    return all ? this.saving.then(() => this.saveCheckIns(true)) : this.saving;
  }

  private async saveLoop(): Promise<void> {
    for (let first = true; ; first = false) {
      const due = [...this.o.devices()].filter((d) => d.unsaved && d.lastCheckIn !== null && (first || this.saveAll || saveDue(d)))
        .map((d) => ({ d, at: d.lastCheckIn! }));
      // Nothing left to write now, written, gone with its device or not yet due: no failed save waits for the store.
      if (!due.length) {
        this.saveFailed = false;
        return;
      }
      for (const { d } of due) d.unsaved = false;
      try {
        await this.o.store.saveCheckIns(due.map(({ d, at }) => ({ deviceId: d.id, at })));
      } catch (err) {
        for (const { d } of due) d.unsaved = true;
        this.saveFailed = true;
        this.failed(err);
        return;
      }
      // What was written, not what is current: a check-in that came during the write keeps its `unsaved`.
      for (const { d, at } of due) d.savedAt = at;
      this.saveFailed = false;
      this.ok();
    }
  }

  /** Writes every setting observed and not yet written; one write at a time, and one observed during it after it. */
  private saveSettings(): Promise<void> {
    if (!this.settingsSaving) this.settingsSaving = this.settingsLoop().finally(() => { this.settingsSaving = undefined; });
    return this.settingsSaving;
  }

  private async settingsLoop(): Promise<void> {
    while (this.writesDue()) {
      const forget = [...this.forgetDue];
      this.forgetDue.clear();
      const due = [...this.settingsDue];
      const reported = [...this.reportedDue];
      const unnamed = [...this.unnamedDue];
      for (const [k] of due) this.settingsDue.delete(k);
      for (const [k] of reported) this.reportedDue.delete(k);
      for (const [k] of unnamed) this.unnamedDue.delete(k);
      try {
        for (const deviceId of forget) await this.o.store.forgetSettings(deviceId);
        await this.o.store.saveSettings(due.map(([, s]) => s));
        await this.o.store.saveReported(reported.map(([, r]) => r));
        await this.o.store.saveUndescribed(
          unnamed.filter(([, u]) => u.at !== null).map(([, u]) => ({ deviceId: u.deviceId, name: u.name, at: u.at! })),
          unnamed.filter(([, u]) => u.at === null).map(([, u]) => ({ deviceId: u.deviceId, name: u.name })));
      } catch (err) {
        // Kept for the retry, unless a newer value of the same setting or name came during the write;
        // a key reported or a name added is written again harmlessly, keeping its first time.
        for (const deviceId of forget) if (![...this.settingsDue.values()].some((s) => s.deviceId === deviceId)) this.forgetDue.add(deviceId);
        for (const [k, s] of due) if (!this.settingsDue.has(k)) this.settingsDue.set(k, s);
        for (const [k, r] of reported) if (!this.reportedDue.has(k)) this.reportedDue.set(k, r);
        for (const [k, u] of unnamed) if (!this.unnamedDue.has(k)) this.unnamedDue.set(k, u);
        this.failed(err);
        return;
      }
      this.ok();
    }
  }

  /** A store write failed: `store_fault`, serving goes on from memory, and the store is tried again on a backoff. */
  failed(err: unknown): void {
    console.error(`store: ${message(err)}`);
    this.o.fault(message(err));
    if (this.due || !this.o.running()) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(wait * 2, STORE_RETRY_CEILING_MS);
    this.due = true;
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null;
      this.o.enqueue(() => this.retry());
    }, wait);
  }

  /**
   * A store write succeeded: the fault clears, and the backoff starts again, only once nothing waits
   * for the store: no admission held back, no removal or setting unwritten, and no failed check-in save.
   */
  ok(): void {
    if (this.held.size || this.removals.size || this.writesDue() || this.saveFailed) return;
    this.retryMs = STORE_RETRY_MS;
    this.o.fault(null);
  }

  /**
   * The store again, in order: the removals, so that no device outlives its leave; the admissions held
   * back, each with its description; the settings; the check-ins. A write that fails again stops it,
   * on the next backoff.
   */
  private async retry(): Promise<void> {
    this.due = false;
    for (const [hw] of [...this.removals]) {
      try {
        await this.o.store.remove(hw);
      } catch (err) {
        this.failed(err);
        return;
      }
      this.removals.delete(hw);
    }
    for (const [hw, held] of [...this.held]) {
      this.held.delete(hw);
      await this.o.readmit(hw, held);
      if (this.held.has(hw)) return;
    }
    if (this.writesDue()) {
      await this.saveSettings();
      if (this.writesDue()) return;
    }
    await this.saveCheckIns();
    // A save that failed again left its check-in unsaved, and its backoff stands.
    if (!this.saveFailed) this.ok();
  }

  /** Logs a write's failure instead of leaving it unhandled. */
  private track(p: Promise<unknown>): void {
    p.catch((err) => console.error(err));
  }
}
