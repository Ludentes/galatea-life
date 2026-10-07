import { timingSafeEqual } from "node:crypto";
import type { HelperConnection, HelperMessage, HelperValues, Urgency } from "../port.js";
import { unwrap, type Bus, type BusCall, type BusSignal } from "./bus.js";
import { LOGIN1 } from "./logind.js";

/** The helper endpoint's well-known name on the system bus, owned by the service alone (its bus policy, GA-BRIDGE-64). */
export const ENDPOINT_NAME = "org.galatea.PcBridge1";
/** The object the helpers call, and its interface: `Hello(s token)`, then `Report(s session, a{sv} values)`. */
export const ENDPOINT_PATH = "/org/galatea/PcBridge1";
export const ENDPOINT_IFACE = "org.galatea.PcBridge1";
/** The object each helper exports on its own connection, which the service calls: `Notify(s text, s urgency)`. */
export const HELPER_PATH = "/org/galatea/PcBridge1/Helper";
export const HELPER_IFACE = "org.galatea.PcBridge1.Helper";
/** The answer to every call from a connection the core refused, for as long as it stays on the bus. */
export const REFUSED = "org.galatea.PcBridge1.Error.Refused";
/** The answer to a call whose caller could not be identified now (logind not answering): no word reaches the core. */
export const UNAVAILABLE = "org.galatea.PcBridge1.Error.Unavailable";

const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const LOGIN1_PATH = "/org/freedesktop/login1";

/** Every connection's departure, as the bus daemon announces it; taken only from the daemon (review C1). */
export const ENDPOINT_MATCH = `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged'`;

/** The keys a report may carry, each passed on as the helper sent it; the core checks their types. */
const REPORT_KEYS: readonly (keyof HelperValues)[] = ["activity", "app", "camera_in_use", "microphone_in_use"];
/** A report larger than this is no helper's: it is named, not passed on. */
const MAX_REPORT_KEYS = 16;
const MAX_STRING = 1024;

/** A unique name's place in the order the bus daemon gives them out (`:<major>.<minor>`, both rising). */
export type Serial = readonly [number, number];

/** A helper the service has started: the floor of names taken before its spawn, and its token, null once spent. */
interface Start {
  floor: Serial;
  token: Buffer | null;
}

/** The serial of a unique name, or null for a name not of that form. */
export function serialOf(name: string): Serial | null {
  const m = /^:(\d{1,9})\.(\d{1,15})$/.exec(name);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const after = (a: Serial, b: Serial) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const shown = (s: Serial) => `:${s[0]}.${s[1]}`;

/** One connection that has called the endpoint, by its unique name. */
interface Caller {
  conn: number;
  name: string;
  /** The OS's identity for it, once the bus daemon and logind gave it. */
  from?: HelperConnection;
  /** Its calls are handled one after another, in the order the bus delivered them. */
  chain: Promise<void>;
  /** The core was told it connected: its end is then reported. */
  announced: boolean;
  /** The core refused it: every later call is refused, and nothing more of it reaches the core. */
  refused: boolean;
}

export interface EndpointOptions {
  bus: Bus;
  emit(m: HelperMessage): void;
  log(line: string): void;
}

/**
 * The helper endpoint (*The helper endpoint*): the service owns `org.galatea.PcBridge1` on the system
 * bus, and each helper calls `Hello`, then `Report`. For each calling connection the endpoint asks
 * the bus daemon for its uid and pid (`GetConnectionUnixUser`, `GetConnectionUnixProcessID`), and
 * logind for the session of that pid (`GetSessionByPID`), once, and tags everything it passes on
 * with that identity, never with what the caller says: `connected` at its first call, then each
 * report, each call it could not read (`malformed`), and `gone` when the bus daemon announces the
 * connection's end (`NameOwnerChanged`, from the daemon only). The core judges the binding
 * (`Helpers`). A connection the core refuses is answered `Refused` from then on, until it leaves.
 * The bus daemon's pid is the one that opened the connection, which may have exited and its number
 * gone to the helper the service starts next (review I1), and a unique name is given at the bus's
 * `Hello`, not at connect, so a name's order does not order connections (review N1). A connection
 * with a started helper's pid is passed on only when its name is newer than the floor taken before
 * that helper's spawn AND its first call is `Hello` with the token the service handed that start on
 * an inherited descriptor; the token is spent at its first use, right or wrong. Anything else is
 * refused here and named (`malformed`). The token is never logged.
 * `notify` calls the helper's own object on its unique name; only root may (the bus policy).
 */
export class HelperEndpoint {
  private readonly callers = new Map<string, Caller>();
  private readonly byConn = new Map<number, Caller>();
  private next = 1;
  private owned = false;
  /** The highest unique name the bus daemon has announced since the endpoint opened. */
  private highest: Serial = [0, 0];
  /**
   * The helpers the service has started, by pid: the highest unique name on the bus before the spawn,
   * and the start's token. A connection with that pid and a name not after the floor was opened by
   * another process that held the pid before (review I1); one without the token is not the started
   * process's, whatever its name (review N1).
   */
  private readonly started = new Map<number, Start>();

  constructor(private readonly o: EndpointOptions) {}

  /**
   * Watches connections leave, takes the calls on the endpoint's path, then asks for the name; resolves
   * whether the name is the service's now. A refusal (the bus policy, another owner) rejects.
   */
  async open(): Promise<boolean> {
    await this.o.bus.addMatch(ENDPOINT_MATCH);
    this.o.bus.onCall(ENDPOINT_PATH, (c) => this.take(c));
    this.owned = await this.o.bus.requestName(ENDPOINT_NAME);
    return this.owned;
  }

  /** Whether the service owns the endpoint's name on this connection. */
  isOwned(): boolean {
    return this.owned;
  }

  /**
   * The highest unique name on the bus now (the daemon's `ListNames`, or the highest it has
   * announced, the later): taken before a helper's spawn, it is the last that cannot be that
   * helper's (review N2). Rejects when the bus cannot list its names, and no helper is then started.
   */
  async floor(): Promise<Serial> {
    const [names] = await this.o.bus.call(DBUS, DBUS_PATH, DBUS, "ListNames");
    let floor = this.highest;
    for (const n of [...(Array.isArray(names) ? names : []), this.o.bus.uniqueName()]) {
      const s = typeof n === "string" ? serialOf(n) : null;
      if (s && after(s, floor)) floor = s;
    }
    return floor;
  }

  /**
   * The service has spawned a helper as this pid, with that floor and token (called at the spawn,
   * before the launcher is moved into the session: review N2). No connection of that pid is its
   * unless its name is after the floor and its first call presents the token.
   */
  expect(pid: number, floor: Serial, token: string): void {
    this.started.set(pid, { floor, token: Buffer.from(token, "utf8") });
  }

  /** The helper of this pid has ended: its pid is no longer the service's to judge here. */
  forget(pid: number): void {
    this.started.delete(pid);
  }

  /** A signal on the bus: a connection's start or end, taken only from the bus daemon (a forged one from another connection is nothing). */
  onSignal(s: BusSignal): void {
    if (s.sender !== DBUS || s.path !== DBUS_PATH || s.interface !== DBUS || s.member !== "NameOwnerChanged") return;
    const [name, , owner] = s.body as [unknown, unknown, unknown];
    if (typeof owner === "string" && owner !== "") {
      const serial = serialOf(owner);
      if (serial && after(serial, this.highest)) this.highest = serial;
    }
    if (typeof name !== "string" || !name.startsWith(":") || owner !== "") return;
    const c = this.callers.get(name);
    if (!c) return;
    this.callers.delete(name);
    // Its calls still in hand finish first; then its end, once.
    c.chain = c.chain.then(() => {
      this.byConn.delete(c.conn);
      if (c.announced && !c.refused && c.from) this.o.emit({ kind: "gone", from: c.from });
    });
  }

  /**
   * The core refused that connection: it is answered `Refused` until it leaves, and its end is
   * reported now, as the port's contract has a closed connection go. A bus connection cannot be cut
   * from outside it; a helper of the bridge's own exits on its first `Refused`.
   */
  close(conn: number): void {
    const c = this.byConn.get(conn);
    if (!c || c.refused) return;
    c.refused = true;
    if (c.announced && c.from) {
      const from = c.from;
      setImmediate(() => this.o.emit({ kind: "gone", from }));
    }
  }

  /** Every connection known is gone: the endpoint's own connection to the bus was lost. */
  lost(): void {
    for (const c of this.callers.values()) {
      if (c.announced && !c.refused && c.from) this.o.emit({ kind: "gone", from: c.from });
    }
    this.callers.clear();
    this.byConn.clear();
    this.owned = false;
  }

  /** Has the helper on that connection show the text: a call to its own object, answered once it handed it to its session. */
  async notify(conn: number, text: string, urgency: Urgency): Promise<void> {
    const c = this.byConn.get(conn);
    if (!c || !c.announced || c.refused) throw new Error(`no helper connection ${conn}`);
    await this.o.bus.call(c.name, HELPER_PATH, HELPER_IFACE, "Notify", "ss", [text, urgency]);
  }

  private take(call: BusCall): void {
    let c = this.callers.get(call.sender);
    if (!c) {
      c = { conn: this.next++, name: call.sender, chain: Promise.resolve(), announced: false, refused: false };
      this.callers.set(call.sender, c);
      this.byConn.set(c.conn, c);
    }
    const caller = c;
    caller.chain = caller.chain.then(() => this.handle(caller, call)).catch((err: unknown) => {
      this.o.log(`helper endpoint: ${call.sender}: ${(err as Error).message}`);
      call.fail(UNAVAILABLE, "the service could not take this call");
    });
  }

  private async handle(c: Caller, call: BusCall): Promise<void> {
    if (c.refused) return call.fail(REFUSED, "this connection is not a helper of the service");
    if (!c.from) {
      const from = await this.identify(c);
      if (!from) return call.fail(UNAVAILABLE, "the service could not tell who is calling; try again");
      c.from = from;
      const why = this.fence(c.name, from.pid, call);
      if (why !== undefined) {
        // Named, never bound: the bus daemon's pid is the opener's at connect, which may be gone and its number reused.
        c.refused = true;
        this.o.emit({ kind: "malformed", from, detail: why });
        return call.fail(REFUSED, "this connection is not the helper the service started");
      }
    }
    if (!c.announced) {
      c.announced = true;
      this.o.emit({ kind: "connected", from: c.from });
      // The core may refuse it as it hears of it.
      if (c.refused) return call.fail(REFUSED, "this connection is not a helper of the service");
    }
    const what = `${call.interface}.${call.member}(${call.signature})`;
    if (call.interface === ENDPOINT_IFACE && call.member === "Hello" && call.signature === "s") return call.reply();
    if (call.interface === ENDPOINT_IFACE && call.member === "Report" && call.signature === "sa{sv}") {
      const [session, raw] = call.body as [string, Record<string, unknown>];
      const keys = Object.keys(raw ?? {});
      const tooLong = keys.find((k) => typeof unwrap(raw[k]) === "string" && (unwrap(raw[k]) as string).length > MAX_STRING);
      if (keys.length > MAX_REPORT_KEYS || tooLong !== undefined || session.length > MAX_STRING) {
        this.o.emit({ kind: "malformed", from: c.from, detail: `a report too large (${keys.length} keys${tooLong ? `, ${tooLong} over ${MAX_STRING} characters` : ""})` });
        return call.fail("org.freedesktop.DBus.Error.LimitsExceeded", "the report is too large");
      }
      const values: Record<string, unknown> = {};
      for (const k of REPORT_KEYS) {
        if (!(k in raw)) continue;
        const v = unwrap(raw[k]);
        // No null in D-Bus: an `app` of "" is no focused window.
        values[k] = k === "app" && v === "" ? null : v;
      }
      this.o.emit({ kind: "report", from: c.from, session, values: values as HelperValues });
      return call.reply();
    }
    this.o.emit({ kind: "malformed", from: c.from, detail: `a call the endpoint does not offer: ${what}` });
    return call.fail("org.freedesktop.DBus.Error.UnknownMethod", `${what} is not offered; Hello(s) and Report(sa{sv}) are`);
  }

  /**
   * Why a connection with a started helper's pid, at its first call, cannot be that helper's (reviews
   * I1, N1); undefined when it can be, or when the pid is no started helper's (the core judges it).
   * The start's token is spent here, whatever the answer.
   */
  private fence(name: string, pid: number, call: BusCall): string | undefined {
    const start = this.started.get(pid);
    if (!start) return undefined;
    const token = start.token;
    start.token = null;
    const serial = serialOf(name);
    if (!serial) return `pid ${pid}'s connection ${name} has no unique name the endpoint can read`;
    if (!after(serial, start.floor)) return `pid ${pid}'s connection ${name} is older than its helper (not after ${shown(start.floor)})`;
    if (token === null) return `pid ${pid}'s connection ${name} came after its start's token was spent`;
    if (call.interface !== ENDPOINT_IFACE || call.member !== "Hello" || call.signature !== "s" || typeof call.body[0] !== "string") {
      return `pid ${pid}'s connection ${name} did not present its start's token`;
    }
    const presented = Buffer.from(call.body[0], "utf8");
    if (presented.length !== token.length || !timingSafeEqual(presented, token)) return `pid ${pid}'s connection ${name} presented a wrong token`;
    return undefined;
  }

  /**
   * The OS's identity for a connection: its uid and pid from the bus daemon, its session from logind
   * (null when its pid is in none). Undefined when it cannot be told now: the caller gone, the bus
   * daemon or logind not answering.
   */
  private async identify(c: Caller): Promise<HelperConnection | undefined> {
    try {
      const [uid] = await this.o.bus.call(DBUS, DBUS_PATH, DBUS, "GetConnectionUnixUser", "s", [c.name]);
      const [pid] = await this.o.bus.call(DBUS, DBUS_PATH, DBUS, "GetConnectionUnixProcessID", "s", [c.name]);
      if (typeof uid !== "number" || typeof pid !== "number") throw new Error(`the bus daemon gave uid ${String(uid)}, pid ${String(pid)}`);
      return { conn: c.conn, pid, osId: uid, session: await this.sessionOf(pid) };
    } catch (err) {
      this.o.log(`helper endpoint: cannot identify ${c.name}: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** logind's session for a pid, by the pid's cgroup; null when it is in none. Any other failure throws. */
  private async sessionOf(pid: number): Promise<string | null> {
    let path: unknown;
    try {
      [path] = await this.o.bus.call(LOGIN1, LOGIN1_PATH, "org.freedesktop.login1.Manager", "GetSessionByPID", "u", [pid]);
    } catch (err) {
      const type = (err as { type?: string }).type ?? "";
      if (/NoSessionForPID/.test(type)) return null;
      throw err;
    }
    const [id] = await this.o.bus.call(LOGIN1, String(path), "org.freedesktop.DBus.Properties", "Get", "ss", ["org.freedesktop.login1.Session", "Id"]);
    const v = unwrap(id);
    return typeof v === "string" && v !== "" ? v : null;
  }
}
