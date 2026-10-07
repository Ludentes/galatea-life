import type { OsSession } from "../port.js";
import { unwrap, type Bus, type BusSignal } from "./bus.js";

export const LOGIN1 = "org.freedesktop.login1";
const LOGIN1_PATH = "/org/freedesktop/login1";
const MANAGER = "org.freedesktop.login1.Manager";
const SESSION = "org.freedesktop.login1.Session";
const SEAT = "org.freedesktop.login1.Seat";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const DBUS = "org.freedesktop.DBus";

/** A session as logind reports it (org.freedesktop.login1(5)), the properties the design lists. */
export interface LogindSession {
  id: string;
  uid: number;
  type: string;
  class: string;
  state: string;
  remote: boolean;
  lockedHint: boolean;
  idleHint: boolean;
  seat: string;
  /** µs since the epoch, when the session began. */
  timestampUs: number;
}

/** What one read of logind finds: its sessions, and the session active on `seat0` (null with no seat0 or none active). */
export interface LogindReading {
  sessions: LogindSession[];
  seat0Active: string | null;
}

/** What a signal from logind or the bus daemon means to the backend. */
export type LogindEvent =
  | { kind: "changed" }
  | { kind: "presence" }
  | { kind: "sleep"; start: boolean }
  | { kind: "shutdown"; start: boolean };

/**
 * The signals the backend asks the bus for: everything logind sends, and logind's arrival or loss on
 * the bus. Each rule names its sender; a signal sent straight to the bridge passes no rule, so
 * `Logind.accept` checks every sender again.
 */
export const MATCH_RULES: readonly string[] = [
  `type='signal',sender='${LOGIN1}'`,
  `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${LOGIN1}'`,
];

/** A session's `Class` that is a person's login: `user` and its variants (systemd 256's `user-early`, `user-incomplete`, `user-light`). */
function personal(sessionClass: string): boolean {
  return /^user(-|$)/.test(sessionClass);
}

/** logind's `Type` that has a display (GA-BRIDGE-52). */
export const GRAPHICAL_TYPES: readonly string[] = ["x11", "wayland", "mir"];

/**
 * logind's reading as the port's sessions (*The OS port*):
 * - only a person's sessions: `Class` `user` or a variant of it, never `greeter` (GDM's login
 *   screen), `lock-screen`, `background` or systemd 256's `manager` sessions of `user@.service`;
 *   and none `closing` (logged out, its processes lingering);
 * - `locked` where `LockedHint` says so; a graphical session on a seat that is not in the
 *   foreground (logind's `State` `online`: another session holds the seat, as after a switch of
 *   user) `disconnected`, since no one can be at it; any other `active`: a session with no seat (an
 *   SSH login) is always `active` in logind, its idleness in `IdleHint`;
 * - `seat0Active` for the session logind names active on `seat0`, the console session.
 */
export function toOsSessions(r: LogindReading): OsSession[] {
  return r.sessions
    .filter((s) => personal(s.class) && s.state !== "closing")
    .map((s) => {
      const graphical = GRAPHICAL_TYPES.includes(s.type);
      const state: OsSession["state"] = s.lockedHint ? "locked" : graphical && s.seat !== "" && s.state === "online" ? "disconnected" : "active";
      return {
        id: s.id,
        osId: s.uid,
        graphical,
        remote: s.remote,
        seat0Active: r.seat0Active !== null && s.id === r.seat0Active,
        state,
        idleHint: s.idleHint,
        startedAt: Math.floor(s.timestampUs / 1000),
      };
    });
}

/** A bus error naming an object that is no longer there (a session that closed between two calls). */
function gone(err: unknown): boolean {
  const type = (err as { type?: string }).type ?? "";
  return /UnknownObject|NoSuchSession|NoSuchSeat/.test(type) || /Unknown object|No session|No seat/.test(String(err));
}

/**
 * logind over the system bus: its presence, its sessions and `seat0`, its signals, `Suspend` and
 * `ScheduledShutdown`. Every call is the bus's, so each is bounded.
 */
export class Logind {
  /**
   * logind's unique name on the bus (`:1.5`), null while it owns no name: the only sender whose
   * signals are logind's. Read from the bus daemon (`GetNameOwner`) and followed through the daemon's
   * own `NameOwnerChanged`.
   */
  owner: string | null = null;

  /** How many `NameOwnerChanged` for logind were taken: a reply asked before the last one is older. */
  private learnt = 0;

  constructor(private readonly bus: Bus) {}

  /**
   * Whether logind owns its name on the bus, asked of the bus daemon; learns its unique name. A
   * `NameOwnerChanged` that arrives while the call is out (the same socket read as the reply) is
   * newer than the reply, which is then dropped (review N3).
   */
  async present(): Promise<boolean> {
    const asked = this.learnt;
    let owner: string | null;
    try {
      const [name] = await this.bus.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetNameOwner", "s", [LOGIN1]);
      owner = typeof name === "string" && name !== "" ? name : null;
    } catch (err) {
      if (!/NameHasNoOwner/.test((err as { type?: string }).type ?? String(err))) throw err;
      owner = null;
    }
    if (this.learnt === asked) this.owner = owner;
    return this.owner !== null;
  }

  /** Asks the bus for logind's signals, then who logind is: a change between the two is in the signals. */
  async watch(): Promise<void> {
    for (const rule of MATCH_RULES) await this.bus.addMatch(rule);
    await this.present();
  }

  /**
   * What a signal means, taken only from its rightful sender (review C1): `NameOwnerChanged` for
   * logind's name only from the bus daemon, which also moves `owner`; logind's own signals only from
   * logind's current unique name. Anything else, a forged `PrepareForShutdown` from another local
   * account included, means nothing.
   */
  accept(s: BusSignal): LogindEvent | undefined {
    if (s.interface === DBUS && s.member === "NameOwnerChanged") {
      if (s.sender !== DBUS || s.path !== "/org/freedesktop/DBus" || s.body[0] !== LOGIN1) return undefined;
      const next = s.body[2];
      this.learnt++;
      this.owner = typeof next === "string" && next !== "" ? next : null;
      return { kind: "presence" };
    }
    if (this.owner === null || s.sender !== this.owner) return undefined;
    return classify(s);
  }

  /** A session that closes while it is read is left out; any other failure fails the read. */
  async read(): Promise<LogindReading> {
    const [list] = await this.bus.call(LOGIN1, LOGIN1_PATH, MANAGER, "ListSessions");
    const rows = (list as [string, number, string, string, string][] | undefined) ?? [];
    const read = await Promise.all(rows.map(async ([id, uid, , , path]) => {
      try {
        const [all] = await this.bus.call(LOGIN1, path, PROPERTIES, "GetAll", "s", [SESSION]);
        const p = all as Record<string, unknown>;
        const v = (k: string) => unwrap(p[k]);
        const seat = v("Seat") as [string, string] | undefined;
        const ts = v("Timestamp");
        const s: LogindSession = {
          id,
          uid,
          type: String(v("Type") ?? ""),
          class: String(v("Class") ?? ""),
          state: String(v("State") ?? ""),
          remote: v("Remote") === true,
          lockedHint: v("LockedHint") === true,
          idleHint: v("IdleHint") === true,
          seat: seat?.[0] ?? "",
          timestampUs: typeof ts === "bigint" ? Number(ts) : Number(ts ?? 0),
        };
        return s;
      } catch (err) {
        if (gone(err)) return undefined;
        throw err;
      }
    }));
    let seat0Active: string | null = null;
    try {
      const [active] = await this.bus.call(LOGIN1, `${LOGIN1_PATH}/seat/seat0`, PROPERTIES, "Get", "ss", [SEAT, "ActiveSession"]);
      const [id] = (unwrap(active) as [string, string] | undefined) ?? [""];
      seat0Active = id || null;
    } catch (err) {
      // A machine with no seat0 (a server, a container) has no console session.
      if (!gone(err)) throw err;
    }
    return { sessions: read.filter((s): s is LogindSession => s !== undefined), seat0Active };
  }

  /**
   * One session's account, `Type` and `Scope` (its systemd scope unit, `session-2.scope`, "" where it
   * has none), by its id (plan 4b); undefined when logind knows no such session.
   */
  async session(id: string): Promise<{ uid: number; type: string; scope: string } | undefined> {
    let path: unknown;
    try {
      [path] = await this.bus.call(LOGIN1, LOGIN1_PATH, MANAGER, "GetSession", "s", [id]);
    } catch (err) {
      if (gone(err)) return undefined;
      throw err;
    }
    let all: unknown;
    try {
      [all] = await this.bus.call(LOGIN1, String(path), PROPERTIES, "GetAll", "s", [SESSION]);
    } catch (err) {
      if (gone(err)) return undefined;
      throw err;
    }
    const p = all as Record<string, unknown>;
    const user = unwrap(p.User) as [number, string] | undefined;
    if (!user || typeof user[0] !== "number") throw new Error(`logind gives session ${id} no account`);
    return { uid: user[0], type: String(unwrap(p.Type) ?? ""), scope: String(unwrap(p.Scope) ?? "") };
  }

  /** `Suspend(false)`: not interactive, so polkit asks no one; resolves once logind accepted it. */
  async suspend(): Promise<void> {
    await this.bus.call(LOGIN1, LOGIN1_PATH, MANAGER, "Suspend", "b", [false]);
  }

  /**
   * Whether a shutdown is scheduled: `ScheduledShutdown` is `(type, µs)`, its type empty when none
   * is (its time then 0, or 2^64-1 as systemd 255 gives it).
   */
  async scheduledShutdown(): Promise<boolean> {
    const [value] = await this.bus.call(LOGIN1, LOGIN1_PATH, PROPERTIES, "Get", "ss", [MANAGER, "ScheduledShutdown"]);
    const [type] = (unwrap(value) as [string, unknown] | undefined) ?? [""];
    return type !== "";
  }

  /**
   * Whether logind is still preparing for a sleep or a shutdown (`PreparingForSleep`,
   * `PreparingForShutdown`): read-only `Get`s, asked before an announcement logind never ended is
   * taken as over (review N4).
   */
  async preparing(): Promise<boolean> {
    for (const name of ["PreparingForShutdown", "PreparingForSleep"]) {
      const [value] = await this.bus.call(LOGIN1, LOGIN1_PATH, PROPERTIES, "Get", "ss", [MANAGER, name]);
      if (unwrap(value) === true) return true;
    }
    return false;
  }
}

/** What a signal means: a change worth observing at once, logind's presence changed, or a power announcement. */
export function classify(s: Omit<BusSignal, "sender">): LogindEvent | undefined {
  if (s.interface === DBUS && s.member === "NameOwnerChanged" && s.body[0] === LOGIN1) return { kind: "presence" };
  if (s.interface === MANAGER) {
    if (s.member === "PrepareForSleep") return { kind: "sleep", start: s.body[0] === true };
    if (s.member === "PrepareForShutdown") return { kind: "shutdown", start: s.body[0] === true };
    if (/^(Session|User|Seat)(New|Removed)$/.test(s.member)) return { kind: "changed" };
    return undefined;
  }
  // A session's or a seat's properties (LockedHint, IdleHint, State, ActiveSession); the manager's own are not an observation.
  if (s.interface === PROPERTIES && s.member === "PropertiesChanged" && /^\/org\/freedesktop\/login1\/(session|seat)\//.test(s.path)) {
    return { kind: "changed" };
  }
  return undefined;
}
