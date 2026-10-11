import type { Clock } from "@ludentes/galatea-life-test-clock";
import { getMeta, setMeta, type Store } from "../core/store.js";
import type { HeldApply, Outcome } from "../dispatch/records.js";
import type { Mutation } from "../mutations.js";
import type { Liveness } from "../state/liveness.js";
import { ending } from "./engine.js";

/** What the heating cap asks of the applier around it. */
export interface CapPorts {
  store: Store;
  clock: Clock;
  mutation?: Mutation;
  /** An adopted socket: whether it reports its own state (`open` when it never does); undefined for any other device. */
  socket(device: string): { open: boolean } | undefined;
  /** A closed socket's latest reported `on`, never an assumed one. */
  reportedOn(device: string): unknown;
  /** The cap of a socket whose load is `heating` now, in seconds; undefined for any other load (applier, *Loads*). */
  maxOn(device: string): number | undefined;
  /** The socket's `onoff.turn_off` as dispatch reads it; undefined when it offers none. */
  turnOff(device: string): { toggles: boolean; idempotent: boolean; ack_within_s: number } | undefined;
  liveness(device: string): Liveness | undefined;
  /**
   * Dispatches the socket's `onoff.turn_off` through the dispatcher, under no client, cause `load_cap`:
   * its run, named by the socket, the on-time it ends and the attempt (the maintainer's ruling 2).
   */
  capOff(device: string, since: number, attempt: number): HeldApply;
  /** Raises a notice; with a `key`, once while it stands. */
  notice(n: Record<string, unknown> & { cause: string; text: string }, key?: string): string | undefined;
  /** A later notice replaces those raised with `key`: the untaken ones go. */
  withdraw(key: string): void;
  /** What `key` said has cleared: a later `raise` with it is a new notice. */
  clear(key: string): void;
}

/**
 * A cap at work on one socket: its turn-off's attempt in flight, or waiting to be sent again, or done
 * (landed, or not to be sent again), until the socket's on-time resets. `stuck` is what stopped a cap
 * that could not act, or ended `refused` or `skipped` for a missing target or action: when that changes
 * while the socket stays on, the cap is armed again. `said` is what the standing failed notice says.
 */
type Cap = { attempt: number; began: number; state: "flight" | "wait" | "done"; apply_id?: string; timer?: number; stuck?: string;
  said?: string };

/** The meta key of the clock's last reading the caps took (the maintainer's ruling 5). */
const CLOCK_KEY = "caps_clock_ms";
/** How often, at most, the clock's reading is kept while an on-time is counted, besides a step and an on-time's write. */
const CLOCK_EVERY_MS = 10_000;

/** The key a socket's failed turn-off notice stands under: a newer one replaces an untaken older. */
const failedKey = (device: string) => `load_cap:failed:${device}`;
/** The key of a socket's notice that its cap cannot act (GA-SAFE-13): said once while it stands. */
export const cannotKey = (device: string) => `load_cap:cannot:${device}`;

/**
 * The heating cap (applier, *Loads*, GA-LOAD-2). Each adopted socket's on-time: a closed one's from its
 * first report of `on`, reset only by a report of `off`; an open one's from the first `onoff.turn_on`
 * the applier sends that ends `sent` or `unanswered`, reset only by an `onoff.turn_off` that ends
 * `sent`. Kept on the applier's clock and in the store, so it counts across a restart, downtime
 * included; a backward step of the clock never lowers the time counted. A socket whose load is
 * `heating` on for its `max_on_s` is turned off by the applier itself, with cause `load_cap` and no
 * client: retried at least every `ack_within_s` while it is not `dead` until it reports `off` (an open
 * one, until a turn-off ends `sent`), at once on its return from `dead`; one that may have run sent
 * once if declared not idempotent; never a toggle (GA-SAFE-13). A turn-off that does not land is a notice. Every method is
 * one step: synchronous, in memory, its writes behind.
 */
export class LoadCaps {
  /** Each socket on, and since when on the applier's clock. */
  private readonly on = new Map<string, number>();
  private readonly caps = new Map<string, Cap>();
  /** The clock's time when last read: a step backward since is not lost from any on-time. */
  private last?: number;
  /**
   * Each socket's last attempt on its on-time: a cap armed again on the same on-time goes on from it, so
   * each attempt is a new command with a new id, never one already sent (the maintainer's ruling 2).
   */
  private readonly tried = new Map<string, { since: number; attempt: number }>();
  /** Each counted socket's cap as the last tick judged it: a configuration change that sets a new one is said. */
  private readonly judged = new Map<string, number | undefined>();

  constructor(private readonly o: CapPorts) {}

  /** Whether the clock's last reading has a write on its way. */
  private clockQueued = false;
  /** The reading last handed to the store. */
  private keptClock = -Infinity;

  /**
   * Loads what a restart keeps (applier, *Restarts*): each socket's on-time, so the downtime counts
   * towards its cap; each cap at work, its run, attempt and state; and the clock's last reading.
   */
  async load(): Promise<void> {
    // `forgets-an-on-time`: the on-times are not read back.
    if (this.o.mutation !== "forgets-an-on-time") {
      const rows = await this.o.store.query<{ device: string; since_ms: number | string; attempt: number | null }>(
        "SELECT device, since_ms, attempt FROM load_on");
      for (const r of rows.rows) {
        this.on.set(r.device, Number(r.since_ms));
        // The cap's last attempt on this on-time, kept apart from its row (the 7b preflight's I1).
        if (r.attempt !== null) this.tried.set(r.device, { since: Number(r.since_ms), attempt: r.attempt });
      }
    }
    // `forgets-a-cap`: the caps at work are not read back.
    if (this.o.mutation !== "forgets-a-cap") {
      const rows = await this.o.store.query<{ device: string; apply_id: string | null; attempt: number; state: Cap["state"];
        began_ms: number | string; said: string | null; stuck: string | null; since_ms: number | string | null }>(
        "SELECT device, apply_id, attempt, state, began_ms, said, stuck, since_ms FROM load_caps");
      for (const r of rows.rows) {
        this.caps.set(r.device, { attempt: r.attempt, began: Number(r.began_ms), state: r.state, ...(r.apply_id !== null ? { apply_id: r.apply_id } : {}),
          ...(r.said !== null ? { said: r.said } : {}), ...(r.stuck !== null ? { stuck: r.stuck } : {}) });
        const t = this.tried.get(r.device);
        if (r.since_ms !== null && (!t || t.attempt < r.attempt)) this.tried.set(r.device, { since: Number(r.since_ms), attempt: r.attempt });
      }
    }
    const last = await getMeta(this.o.store, CLOCK_KEY);
    if (last !== undefined) this.last = Number(last);
  }

  /**
   * Every module has loaded: the clock read against its last reading, a step back since moving every
   * on-time back (the maintainer's ruling 5); each cap waiting to send again armed again from when its last
   * attempt began, at once if that is past (the maintainer's ruling 7). A cap in flight is the dispatcher's,
   * whose resume ends its step through `capEnded`.
   */
  resume(): void {
    this.observe();
    for (const [device, cap] of this.caps) if (cap.state === "wait") this.arm(device, cap);
  }

  /** Whether `applyId` is a cap's turn-off still at work: the dispatcher keeps it past its hour (GA-LOAD-2). */
  runs(applyId: string): boolean {
    for (const c of this.caps.values()) if (c.apply_id === applyId && c.state !== "done") return true;
    return false;
  }

  /** Since when a socket has been on, on the applier's clock; undefined when it is not counted as on. */
  onSince(device: string): number | undefined {
    return this.on.get(device);
  }

  /** A closed socket's `on` was reported: `on` starts its on-time, unless one runs; `off` resets it. */
  reported(device: string): void {
    const s = this.o.socket(device);
    if (!s || s.open) return;
    const now = this.observe();
    const on = this.o.reportedOn(device);
    if (on === true) this.start(device, now);
    else if (on === false) this.reset(device);
  }

  /**
   * Any step ended: on an open socket, a `turn_on` that ended `sent` or `unanswered`, either of which
   * may have turned it on, starts its on-time from its dispatch; a `turn_off` that ended `sent` resets it.
   */
  ended(device: string, action: string, outcome: Outcome["outcome"], dispatchedMs: number): void {
    if (!this.o.socket(device)?.open) return;
    const now = this.observe();
    if (action === "onoff.turn_on" && (outcome === "sent" || outcome === "unanswered")) {
      // `never-caps-a-silent-heater`: an open socket's on-time is never counted. A dispatch read before a
      // backward step the clock took since is no later than now.
      if (this.o.mutation !== "never-caps-a-silent-heater") this.start(device, Math.min(dispatchedMs, now));
    } else if (action === "onoff.turn_off" && outcome === "sent") this.reset(device);
  }

  /**
   * The owner's configuration changed: a closed socket newly adopted that reports `on` starts its
   * on-time now; a socket no longer adopted is counted no more, and a cap whose load is no longer
   * `heating` stops; a cap stopped by what this change altered is armed again; a lower `max_on_s`, or
   * a load made `heating`, is judged at once, and a socket it finds on past its cap is said to be turned
   * off now, so the owner is not surprised.
   */
  configured(): void {
    const now = this.observe();
    for (const device of [...this.on.keys()]) if (!this.o.socket(device)) this.reset(device);
    for (const device of [...this.caps.keys()]) if (this.o.maxOn(device) === undefined) this.endCap(device);
    for (const [device, since] of this.on) {
      const max = this.o.maxOn(device);
      if (max === undefined || max === this.judged.get(device) || this.caps.has(device) || now - since < max * 1000) continue;
      this.o.notice({ cause: "load_cap", devices: [device], text: `${device} has been on for ${Math.floor((now - since) / 1000)} s, past the `
        + `heating cap of ${max} s it now has: the applier turns it off now.` });
    }
    this.rearm([...this.caps.keys()]);
    this.tick();
  }

  /** Adopted sockets the applier holds, as a configuration change or a start finds them: a closed one reporting `on` is counted. */
  seen(devices: string[]): void {
    const now = this.observe();
    for (const device of devices) if (this.o.socket(device)?.open === false && this.o.reportedOn(device) === true) {
      this.start(device, now);
    }
  }

  /**
   * Whether each of `devices`, a socket whose load is `heating`, has a cap that can act: one whose
   * turn-off is a toggle, or not offered, is a notice, once while it stands (GA-SAFE-13), at its
   * adoption or when its declarations change; one that can act again, or is no longer heating, clears
   * it. `adopted` names those adopted just now: `adopts-an-uncappable-socket-quietly` says nothing of them.
   */
  judge(devices: string[], adopted: string[] = []): void {
    for (const device of devices) {
      const t = this.o.turnOff(device);
      if (!this.o.socket(device) || this.o.maxOn(device) === undefined || (t && !t.toggles)) {
        this.o.clear(cannotKey(device));
        continue;
      }
      if (this.o.mutation === "adopts-an-uncappable-socket-quietly" && adopted.includes(device)) continue;
      this.o.notice({ cause: "load_cap", devices: [device], text: `${device}'s heating cap cannot act: its onoff.turn_off `
        + `${t ? "is declared toggles: true, a code the applier never sends on its own" : "is not offered"}, so nothing turns it off `
        + "after its max_on_s. Declare what its load is, or have its bridge declare a discrete turn-off." }, cannotKey(device));
    }
  }

  /**
   * Devices whose declarations or adoption changed: a cap of theirs that could not act, or ended
   * `refused` or `skipped` for a missing target or action, is armed again when what stopped it changed,
   * the next tick beginning it while the socket is still on (GA-LOAD-2; GA-SAFE-13 makes a cap that
   * cannot act a notice, not an exemption).
   */
  rearm(devices: string[]): void {
    let any = false;
    for (const device of devices) {
      const cap = this.caps.get(device);
      if (cap?.state !== "done" || cap.stuck === undefined || cap.stuck === this.stuckOn(device)) continue;
      this.endCap(device);
      any = true;
    }
    if (any) this.tick();
  }

  /** Each socket on past its cap is turned off. */
  tick(): void {
    const now = this.observe();
    this.judged.clear();
    for (const [device, since] of this.on) {
      const max = this.o.maxOn(device);
      this.judged.set(device, max);
      if (max === undefined || this.caps.has(device) || now - since < max * 1000) continue;
      this.begin(device);
    }
  }

  /** A socket's liveness changed: a turn-off waiting for it goes at once on its return from `dead`. */
  livenessChanged(device: string, old?: Liveness, next?: Liveness): void {
    if (old === "dead" && next !== "dead" && this.caps.get(device)?.state === "wait") this.resend(device);
  }

  /**
   * A cap's turn-off has its final outcome, judged by GA-SAFE-12's classes as a safety rule's is.
   * `acked` (the socket reports `off`), `delivered`, and `sent` on an open socket, landed. One that did
   * not run (`skipped(dead)`, `unreachable`, a `failed` saying it was not carried out) is sent again
   * whatever its idempotency, no sooner than its `ack_within_s` after the last began and at once on the
   * socket's return from `dead`. One that may have run (`failed(no_ack)`, `unanswered`, `sent` on a
   * closed socket) is sent again only if declared idempotent. One `refused`, or `skipped` or `failed`
   * for good, waits for what stopped it to change (`rearm`). Each that did not land is said in one
   * standing notice per socket, a new one only when what it says changes.
   */
  capEnded(run: HeldApply, i: number): void {
    const device = run.load_cap;
    const cap = device === undefined ? undefined : this.caps.get(device);
    if (device === undefined || !cap || cap.state !== "flight") return;
    cap.apply_id ??= run.apply_id;
    const o = run.outcomes[i];
    if (cap.apply_id !== run.apply_id || !o || o.outcome === "dispatched") return;
    const open = this.o.socket(device)?.open === true;
    let kind = o.outcome === "sent" && !open ? "may_have_run" : o.outcome === "refused" ? "final" : ending(o);
    if (kind === "landed") {
      cap.state = "done";
      this.o.clear(failedKey(device));
      this.keepCap(device);
      return;
    }
    const t = this.o.turnOff(device);
    // A turn-off gone, or now a toggle: the cap cannot act until that changes.
    if (!t || t.toggles) kind = "final";
    const idempotent = t !== undefined && (t.idempotent || this.o.mutation === "retries-a-pulse-off");
    const again = kind === "nothing_ran" || ((kind === "may_have_run" || kind === "unanswered") && idempotent);
    const why = `${o.outcome}${o.reason ? ` (${o.reason})` : ""}`;
    const said = `${why}:${again}`;
    if (cap.said !== said) this.o.withdraw(failedKey(device));
    cap.said = said;
    this.o.notice({ cause: "load_cap", devices: [device], outcomes: [o], text: `${device}'s heating cap sent onoff.turn_off, which ended ${why}: `
      + (again ? kind === "nothing_ran" ? "it was not carried out, and is sent again while the socket is not dead, until it is off."
        : "it is sent again until the socket is off."
        : kind === "final" ? "it is not sent again until what stopped it changes, and the socket may still be on."
          : "it may have run, and is not sent again, being declared not idempotent: the socket may still be on.") }, failedKey(device));
    if (!again) {
      cap.state = "done";
      if (kind === "final") cap.stuck = this.stuckOn(device);
      this.keepCap(device);
      return;
    }
    cap.state = "wait";
    this.keepCap(device);
    this.arm(device, cap);
  }

  /** A waiting turn-off is sent again no sooner than its `ack_within_s` after its last attempt began; a dead socket waits for its return. */
  private arm(device: string, cap: Cap): void {
    if (cap.timer !== undefined) this.o.clock.clear(cap.timer);
    cap.timer = undefined;
    const t = this.o.turnOff(device);
    if (this.o.liveness(device) === "dead" || !t) return;
    const at = Math.max(this.o.clock.now(), cap.began + Math.round(t.ack_within_s * 1000));
    cap.timer = this.o.clock.setTimeout(() => {
      cap.timer = undefined;
      this.resend(device);
    }, at - this.o.clock.now());
  }

  /**
   * Keeps a cap at work, written behind: its run, attempt, state, when its attempt began, what its notice
   * said, what stopped it, and the on-time it ends; its row deleted once it stops. An upsert, safe twice.
   */
  private keepCap(device: string): void {
    const cap = this.caps.get(device);
    const since = this.tried.get(device)?.since ?? this.on.get(device);
    void this.o.store.write((tx) => (cap
      ? tx.query("INSERT INTO load_caps (device, apply_id, attempt, state, began_ms, said, stuck, since_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
        + "ON CONFLICT (device) DO UPDATE SET apply_id = EXCLUDED.apply_id, attempt = EXCLUDED.attempt, state = EXCLUDED.state, "
        + "began_ms = EXCLUDED.began_ms, said = EXCLUDED.said, stuck = EXCLUDED.stuck, since_ms = EXCLUDED.since_ms",
      [device, cap.apply_id ?? null, cap.attempt, cap.state, Math.floor(cap.began), cap.said ?? null, cap.stuck ?? null,
        since === undefined ? null : Math.floor(since)])
      : tx.query("DELETE FROM load_caps WHERE device = $1", [device])).then(() => undefined));
  }

  /**
   * The clock read: a step backward since it was last read moves every on-time back with it, before
   * anything starts one at the new time, so none is lowered and none counted twice.
   */
  private observe(): number {
    const now = this.o.clock.now();
    if (this.last !== undefined && now < this.last) {
      const back = this.last - now;
      for (const [device, since] of this.on) this.keep(device, since - back);
    }
    const stepped = this.last !== undefined && now < this.last;
    this.last = now;
    // Kept on a step back, with every on-time written, and at most each 10 s while one is counted; not
    // on every read (the 7b preflight's M3). A start that finds the clock earlier than the reading kept
    // moves the on-times back by that much: a step inside the last 10 s is counted short by up to it.
    if (this.on.size && (stepped || now - this.keptClock >= CLOCK_EVERY_MS)) this.keepClock();
    return now;
  }

  /**
   * The clock's last reading, written behind and coalesced: one write on its way at a time, writing the
   * latest reading when it runs; the next may be queued once it has committed or was dropped.
   */
  private keepClock(): void {
    if (this.clockQueued) return;
    this.clockQueued = true;
    this.keptClock = this.last ?? this.o.clock.now();
    void this.o.store.write((tx) => setMeta(tx, CLOCK_KEY, String(Math.floor(this.last ?? this.o.clock.now()))), { droppable: true })
      .then(() => { this.clockQueued = false; });
  }

  /** What a cap that cannot act or was refused depends on: its socket's adoption, its turn-off, its place in the model. */
  private stuckOn(device: string): string {
    const t = this.o.turnOff(device);
    return JSON.stringify([this.o.socket(device) ?? null, t ? [t.toggles, t.idempotent] : null, this.o.liveness(device) !== undefined]);
  }

  /** A socket's on-time starts at `at`, unless one runs. */
  private start(device: string, at: number): void {
    if (this.on.has(device)) return;
    this.keep(device, Math.floor(at));
  }

  /**
   * A socket's on-time is `since`. A clock read can be fractional (an SNTP clock's is), and the store's
   * column is a bigint, which Postgres refuses a fraction for: the row keeps the whole millisecond at
   * or before it, so a restart never counts less.
   */
  private keep(device: string, since: number): void {
    this.on.set(device, since);
    void this.o.store.write((tx) => tx.query("INSERT INTO load_on (device, since_ms) VALUES ($1, $2) "
      + "ON CONFLICT (device) DO UPDATE SET since_ms = EXCLUDED.since_ms", [device, Math.floor(since)]).then(() => undefined));
    this.keepClock();
  }

  /** A socket's on-time resets: it is off, and its cap, if one was at work, is done. */
  private reset(device: string): void {
    this.endCap(device);
    if (!this.on.delete(device)) return;
    void this.o.store.write((tx) => tx.query("DELETE FROM load_on WHERE device = $1", [device]).then(() => undefined));
  }

  /** The applier stops (an embedding host's stop): every cap's timer is cleared; the caps stay as the store keeps them. */
  stop(): void {
    for (const cap of this.caps.values()) {
      if (cap.timer !== undefined) this.o.clock.clear(cap.timer);
      cap.timer = undefined;
    }
  }

  /** A cap's work ends: its standing failed notice, still listed until taken, is said again on the next one. */
  private endCap(device: string): void {
    const cap = this.caps.get(device);
    if (!cap) return;
    if (cap.timer !== undefined) this.o.clock.clear(cap.timer);
    this.caps.delete(device);
    this.o.clear(failedKey(device));
    this.keepCap(device);
  }

  /**
   * A heating load on for its cap: its turn-off goes, unless it cannot act, a toggle or no turn-off at
   * all, which the applier never sends on its own (GA-SAFE-13) and which is a notice instead.
   */
  private begin(device: string): void {
    // `leaves-heat-on`: the cap never acts.
    if (this.o.mutation === "leaves-heat-on") return;
    // Its run and its own record commit together, or neither does.
    this.o.store.group(() => this.beginNow(device));
  }

  private beginNow(device: string): void {
    const since = this.on.get(device);
    const last = this.tried.get(device);
    const cap: Cap = { attempt: last !== undefined && last.since === since ? last.attempt : 0, began: 0, state: "flight" };
    this.caps.set(device, cap);
    const t = this.o.turnOff(device);
    if (!t || t.toggles) {
      cap.state = "done";
      cap.stuck = this.stuckOn(device);
      this.o.notice({ cause: "load_cap", devices: [device], text: `${device} has been on past its heating cap, which cannot act: `
        + `its turn-off ${t ? "is a toggle, which the applier never sends on its own" : "is not offered"}. It may still be on.` }, cannotKey(device));
      this.keepCap(device);
      return;
    }
    this.send(device, cap);
  }

  /** A waiting turn-off's time came, or its socket returned: sent again while the load is heating, on, and its socket not `dead`. */
  private resend(device: string): void {
    const cap = this.caps.get(device);
    if (!cap || cap.state !== "wait") return;
    if (cap.timer !== undefined) this.o.clock.clear(cap.timer);
    cap.timer = undefined;
    if (this.o.maxOn(device) === undefined || !this.on.has(device)) {
      this.endCap(device);
      return;
    }
    if (this.o.liveness(device) === "dead") return;
    // Its run and its own record commit together, or neither does.
    this.o.store.group(() => this.send(device, cap));
  }

  /** The cap's next attempt: its run, named by the socket, its on-time and the attempt, and the cap's row with it. */
  private send(device: string, cap: Cap): void {
    cap.attempt++;
    cap.began = this.o.clock.now();
    cap.state = "flight";
    cap.apply_id = undefined;
    const since = this.on.get(device) ?? cap.began;
    this.tried.set(device, { since, attempt: cap.attempt });
    // Kept with the on-time, so a cap stopped and armed again after a restart goes on from it.
    void this.o.store.write((tx) => tx.query("UPDATE load_on SET attempt = $2 WHERE device = $1", [device, cap.attempt]).then(() => undefined));
    const run = this.o.capOff(device, since, cap.attempt);
    if (cap.state === "flight") cap.apply_id ??= run.apply_id;
    this.keepCap(device);
  }
}
