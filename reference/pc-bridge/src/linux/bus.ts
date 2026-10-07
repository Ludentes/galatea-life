import dbus from "dbus-next";
import { bounded } from "./run.js";

/** How long a bus call, or the connection, may take: a bus that does not answer never stalls the bridge. */
export const BUS_CALL_MS = 5_000;

/**
 * A signal as the bus delivered it. `sender` is the sending connection's unique name (`:1.5`), or
 * `org.freedesktop.DBus` for the bus daemon's own, as the daemon stamps it: never the sender's own
 * word. A match rule filters only broadcasts, and the stock bus policy lets any client send a signal
 * straight to any other, so a signal's meaning is taken only with its sender checked (review C1).
 */
export interface BusSignal {
  sender: string;
  path: string;
  interface: string;
  member: string;
  body: unknown[];
}

/**
 * A method call another connection made to this one, as the bus delivered it (plan 4b): `sender` is
 * the caller's unique name as the bus daemon stamped it, never the caller's own word, and
 * `signature` the body's D-Bus signature. Each is answered once, by `reply` or `fail`; an answer
 * the bus cannot send (the caller gone) is dropped.
 */
export interface BusCall {
  sender: string;
  path: string;
  interface: string;
  member: string;
  signature: string;
  body: unknown[];
  reply(signature?: string, body?: unknown[]): void;
  /** A D-Bus error: its name (`org.galatea.PcBridge1.Error.Refused`) and its text. */
  fail(name: string, text: string): void;
}

/**
 * The system bus as the Linux backend uses it: bounded method calls, the signals its match rules
 * ask for, and word of the connection's loss; and, for the helper endpoint and the helper (plan
 * 4b), a well-known name owned and the calls made to an object path. `dbusNextBus` is the real one,
 * over dbus-next; the unit tests hand the backend a fake.
 */
export interface Bus {
  /** One method call; resolves with the reply's body, or rejects with the bus's error or at the bound. */
  call(destination: string, path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<unknown[]>;
  /** Asks the bus daemon for the signals a match rule names (`org.freedesktop.DBus.AddMatch`). */
  addMatch(rule: string): Promise<void>;
  onSignal(handler: (s: BusSignal) => void): void;
  /** The connection failed or closed; nothing more comes on it. */
  onClose(handler: (err: Error) => void): void;
  /**
   * Asks the bus daemon for a well-known name, never queued (`DO_NOT_QUEUE`): resolves whether this
   * connection owns it now; rejects when the bus's policy refuses it, or at the bound.
   */
  requestName(name: string): Promise<boolean>;
  /** The method calls made to this connection on `path`; a call on any other path is the library's to refuse. */
  onCall(path: string, handler: (c: BusCall) => void): void;
  /** This connection's unique name (`:1.42`), as the bus daemon gave it at connect. */
  uniqueName(): string;
  close(): void;
}

/** `RequestName`'s flag: fail at once rather than wait in the queue for a name another owns. */
const DO_NOT_QUEUE = 0x4;
/** `RequestName`'s answers that leave this connection the owner: `PRIMARY_OWNER`, `ALREADY_OWNER`. */
const OWNER_REPLIES: readonly number[] = [1, 4];

/** A property as the bus gives it: dbus-next wraps each in a Variant. */
export function unwrap(v: unknown): unknown {
  return v !== null && typeof v === "object" && "signature" in v && "value" in v ? (v as { value: unknown }).value : v;
}

/**
 * Connects to the system bus (or `address`, a D-Bus address) through dbus-next, over a plain
 * socket: its optional native module is not installed (the root `package.json` ignores it). dbus-next
 * leaves a call pending for ever when the connection fails, and says so only by an `error` event,
 * so the connection is bounded, and so is every call.
 */
export async function dbusNextBus(o: { address?: string; timeoutMs?: number; make?: () => dbus.MessageBus } = {}): Promise<Bus> {
  const ms = o.timeoutMs ?? BUS_CALL_MS;
  // dbus-next reads the system bus's address from the environment only.
  const saved = process.env.DBUS_SYSTEM_BUS_ADDRESS;
  if (o.address !== undefined) process.env.DBUS_SYSTEM_BUS_ADDRESS = o.address;
  const bus = (o.make ?? (() => dbus.systemBus()))();
  if (o.address !== undefined) {
    if (saved === undefined) delete process.env.DBUS_SYSTEM_BUS_ADDRESS;
    else process.env.DBUS_SYSTEM_BUS_ADDRESS = saved;
  }
  let closed = false;
  const closeHandlers: ((err: Error) => void)[] = [];
  const signalHandlers: ((s: BusSignal) => void)[] = [];
  const fail = (err: Error) => {
    if (closed) return;
    closed = true;
    for (const h of closeHandlers) h(err);
  };
  const connected = new Promise<void>((resolve, reject) => {
    bus.once("connect", () => resolve());
    bus.once("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  try {
    await bounded(connected, ms, "the system bus");
  } catch (err) {
    closed = true;
    bus.disconnect();
    throw err;
  }
  bus.on("error", (err: unknown) => fail(err instanceof Error ? err : new Error(String(err))));
  // dbus-next 0.10.2 does not pass on its connection's `end` (the bus daemon closing the socket
  // cleanly), so the loss would show only at the next call: heard here at once (review M4).
  (bus as unknown as { _connection?: { on?: (event: string, h: () => void) => void } })._connection?.on?.("end", () =>
    fail(new Error("the system bus ended the connection")));
  bus.on("message", (m: dbus.Message) => {
    // A signal (type 4 on the wire; dbus-next's SIGNAL); method returns and calls are dbus-next's own.
    if (m.type !== dbus.MessageType.SIGNAL) return;
    const s: BusSignal = { sender: m.sender ?? "", path: m.path, interface: m.interface, member: m.member, body: m.body ?? [] };
    for (const h of signalHandlers) h(s);
  });
  // Each call waiting, so that a close settles it at once (the port's `close`).
  const pending = new Set<(err: Error) => void>();
  const call = async (destination: string, path: string, iface: string, member: string, signature?: string, body?: unknown[]) => {
    if (closed) throw new Error("the system bus connection is closed");
    const msg = new dbus.Message({ destination, path, interface: iface, member, ...(signature ? { signature, body: body ?? [] } : {}) });
    let cut!: (err: Error) => void;
    const closing = new Promise<never>((_resolve, reject) => { cut = reject; });
    pending.add(cut);
    try {
      const reply = await bounded(Promise.race([bus.call(msg), closing]), ms, `${iface}.${member}`);
      return reply?.body ?? [];
    } finally {
      pending.delete(cut);
    }
  };
  // An answer that cannot be sent (the connection closed, a body that does not fit its signature) is dropped, never thrown.
  const send = (m: dbus.Message) => {
    if (closed) return;
    try {
      bus.send(m);
    } catch {
      // Dropped: the caller's own bound ends its wait.
    }
  };
  return {
    call,
    async addMatch(rule) {
      await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [rule]);
    },
    onSignal: (h) => void signalHandlers.push(h),
    onClose: (h) => void closeHandlers.push(h),
    async requestName(name) {
      const [code] = await call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "su", [name, DO_NOT_QUEUE]);
      return OWNER_REPLIES.includes(Number(code));
    },
    onCall(path, handler) {
      bus.addMethodHandler((m: dbus.Message) => {
        if (m.path !== path) return false;
        let answered = false;
        const once = (make: () => dbus.Message) => {
          if (answered) return;
          answered = true;
          // A call sent with NO_REPLY_EXPECTED gets none.
          if ((m.flags & dbus.MessageFlag.NO_REPLY_EXPECTED) !== 0) return;
          send(make());
        };
        handler({
          sender: m.sender ?? "", path: m.path, interface: m.interface ?? "", member: m.member, signature: m.signature ?? "", body: m.body ?? [],
          reply: (signature = "", body = []) => once(() => dbus.Message.newMethodReturn(m, signature, body)),
          // dbus-next 0.10.2's typings take the message as a string here; its code takes the message.
          fail: (name, text) => once(() => dbus.Message.newError(m as unknown as string, name, text)),
        });
        return true;
      });
    },
    uniqueName: () => (bus as unknown as { name?: string | null }).name ?? "",
    close() {
      closed = true;
      for (const cut of pending) cut(new Error("the system bus connection is closed"));
      pending.clear();
      bus.disconnect();
    },
  };
}
