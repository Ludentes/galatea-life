import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Bus, BusCall, BusSignal } from "../src/linux/bus.js";
import { RunError, type RunOptions, type RunResult, type Runner } from "../src/linux/run.js";

/**
 * A fake `/`: a temporary directory holding the files a test names, by their absolute paths
 * (`/etc/passwd`). `cleanup` removes it. Nothing is read from, or written to, the machine's own `/`.
 */
export function fakeRoot(files: Record<string, string>): { root: string; write(path: string, text: string): void; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "galatea-root-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** What a fake command answers: a result, an error of the runner's (`missing`, `timeout`), or one that never finishes. */
export type Answer = Partial<RunResult> | RunError | "hang";

/** A call the fake runner saw. */
export interface Call {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The runner the Linux backend is handed in unit tests: each call is answered by the last rule
 * whose command line (`file args…`, joined by spaces) the rule's pattern matches (so a test adds
 * a specific answer over a helper's general ones), in the real tool's
 * output format; a call no rule answers is a missing command. A `hang` never settles, as a tool that
 * hangs, and is ended only by the caller's own bound (the fake honours `timeoutMs`).
 */
export class FakeRunner {
  readonly calls: Call[] = [];
  private readonly rules: [RegExp | string, Answer | ((c: Call) => Answer)][] = [];

  on(pattern: RegExp | string, answer: Answer | ((c: Call) => Answer)): this {
    this.rules.push([pattern, answer]);
    return this;
  }

  readonly run: Runner = (file: string, args: readonly string[], o: RunOptions = {}) => {
    const call: Call = { file, args: [...args], ...(o.env ? { env: o.env } : {}) };
    this.calls.push(call);
    const line = [file, ...args].join(" ");
    const rule = this.rules.findLast(([p]) => (typeof p === "string" ? p === line : p.test(line)));
    if (!rule) return Promise.reject(new RunError("missing", `${file}: not installed`));
    const answer = typeof rule[1] === "function" ? rule[1](call) : rule[1];
    if (answer === "hang") {
      return new Promise<RunResult>((_resolve, reject) => {
        setTimeout(() => reject(new RunError("timeout", `${file} did not finish`)), o.timeoutMs ?? 5_000);
      });
    }
    if (answer instanceof RunError) return Promise.reject(answer);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...answer });
  };

  /** The command lines run, for assertions. */
  lines(): string[] {
    return this.calls.map((c) => [c.file, ...c.args].join(" "));
  }
}

/** A passwd file in the real format: `name:x:uid:gid:gecos:home:shell`. */
export function passwd(...entries: [name: string, uid: number, gid: number, home: string, shell: string][]): string {
  return entries.map(([n, u, g, h, s]) => `${n}:x:${u}:${g}:,,,:${h}:${s}`).join("\n") + "\n";
}

/** Debian 13's `/etc/passwd` head, with made-up people: root, system accounts, two people, a service account. */
export const PASSWD = passwd(
  ["root", 0, 0, "/root", "/bin/bash"],
  ["daemon", 1, 1, "/usr/sbin", "/usr/sbin/nologin"],
  ["systemd-network", 998, 998, "/", "/usr/sbin/nologin"],
  ["polkitd", 996, 996, "/", "/usr/sbin/nologin"],
  ["liza", 1000, 1000, "/home/liza", "/bin/bash"],
  ["dima", 1001, 1001, "/home/dima", "/usr/bin/zsh"],
  ["backup-svc", 1002, 1002, "/var/lib/backup", "/usr/sbin/nologin"],
  ["gnome-initial-setup", 119, 65534, "/run/gnome-initial-setup/", "/bin/false"],
);

/** Debian 13's `/etc/login.defs`, the lines the backend reads among others. */
export const LOGIN_DEFS = [
  "# /etc/login.defs - Configuration control definitions for the login package.",
  "MAIL_DIR        /var/mail",
  "#",
  "# Min/max values for automatic uid selection in useradd(8)",
  "#",
  "UID_MIN\t\t\t 1000",
  "UID_MAX\t\t\t60000",
  "# System accounts",
  "#SYS_UID_MIN\t\t  101",
  "#SYS_UID_MAX\t\t  999",
  "",
].join("\n");

/** Debian 13's default `/etc/nsswitch.conf`: local files only. */
export const NSSWITCH_FILES = [
  "# /etc/nsswitch.conf",
  "passwd:         files systemd",
  "group:          files systemd",
  "shadow:         files systemd",
  "hosts:          files mdns4_minimal [NOTFOUND=return] dns",
  "",
].join("\n");

/** sssd configured, as `realm join` leaves it: with `sss` named, a directory (review N1). */
export const SSSD_CONF = { "/etc/sssd/sssd.conf": "[sssd]\ndomains = corp.example\nservices = nss, pam\n" };

/** The same with sssd, as `realm join` leaves it (and as Ubuntu's desktop names it, sssd or not). */
export const NSSWITCH_SSS = NSSWITCH_FILES.replace("passwd:         files systemd", "passwd:         files systemd sss")
  .replace("group:          files systemd", "group:          files systemd sss");

/** A logind session as the fake bus holds it: its id, uid and the properties GetAll gives. */
export interface FakeSession {
  id: string;
  uid: number;
  user?: string;
  type?: string;
  class?: string;
  state?: string;
  remote?: boolean;
  lockedHint?: boolean;
  idleHint?: boolean;
  seat?: string;
  timestampUs?: bigint;
  /** logind's `Scope` property (plan 4b): `session-<id>.scope` unless a test says otherwise ("" for none). */
  scope?: string;
}

/** A connection on the fake bus as the bus daemon knows it (plan 4b): its uid and pid. */
export interface FakeConnection {
  uid: number;
  pid: number;
}

/** What an incoming call was answered: a reply's body, or an error's name and text. */
export type CallAnswer = { reply: unknown[]; signature: string } | { error: string; text: string };

/** A bus error as dbus-next gives one: its D-Bus error name in `type`. */
export class FakeBusError extends Error {
  constructor(readonly type: string, text: string) {
    super(text);
  }
}

/**
 * The system bus with logind on it, answering as dbus-next gives the replies: properties wrapped in
 * Variants (`{ signature, value }`), 64-bit numbers as BigInt, a closed session's object an
 * `UnknownObject` error. A test changes its state and emits signals itself; every call is recorded.
 */
export class FakeLogindBus implements Bus {
  readonly calls: string[] = [];
  readonly matches: string[] = [];
  sessions: FakeSession[] = [];
  seat0Active = "";
  hasSeat0 = true;
  logindPresent = true;
  /** logind's unique name on the bus, which `GetNameOwner` gives while it is present. */
  logindOwner = LOGIND_OWNER;
  scheduled: [string, bigint] = ["", 18446744073709551615n];
  /** logind's PreparingForSleep and PreparingForShutdown properties. */
  preparingForSleep = false;
  preparingForShutdown = false;
  /** A member name here fails with this error, or never answers ("hang"). */
  failing = new Map<string, Error | "hang">();
  /**
   * Runs as a member's reply is made, before the caller sees it: a signal it emits arrives in the
   * same socket read as the reply, ahead of the caller's continuation (review N3).
   */
  onReply?: (member: string) => void;
  closed = false;
  /** The bus daemon's connections, by unique name (plan 4b): `GetConnectionUnixUser` and `ProcessID` answer from here. */
  readonly connections = new Map<string, FakeConnection>();
  /** logind's session for each pid (plan 4b): `GetSessionByPID` answers from here, `NoSessionForPID` for one not in it. */
  readonly sessionOfPid = new Map<number, string>();
  /** The names this connection owns, and those the bus's policy refuses it (plan 4b). */
  readonly owned: string[] = [];
  refuseNames = false;
  /** Answers a call to another connection (a helper's `Notify`), by its unique name and member (plan 4b). */
  peer?: (destination: string, member: string, body: unknown[]) => unknown[] | Promise<unknown[]>;
  private readonly callHandlers = new Map<string, (c: BusCall) => void>();
  private signalHandlers: ((s: BusSignal) => void)[] = [];
  private closeHandlers: ((err: Error) => void)[] = [];
  private hung: ((err: Error) => void)[] = [];

  async call(destination: string, path: string, iface: string, member: string, _signature?: string, body: unknown[] = []): Promise<unknown[]> {
    this.calls.push(`${iface}.${member} ${path}${body.length ? ` ${JSON.stringify(body)}` : ""}`);
    if (this.closed) throw new Error("the system bus connection is closed");
    const f = this.failing.get(member);
    // A call that never answers, settled only by a close, as the real bus's close settles it.
    if (f === "hang") return new Promise((_resolve, reject) => void this.hung.push(reject));
    if (f) throw f;
    const v = (signature: string, value: unknown) => ({ signature, value });
    if (member === "NameHasOwner") return [this.logindPresent];
    if (destination === "org.freedesktop.DBus" && (member === "GetConnectionUnixUser" || member === "GetConnectionUnixProcessID")) {
      const c = this.connections.get(String(body[0]));
      if (!c) throw new FakeBusError("org.freedesktop.DBus.Error.NameHasNoOwner", `Could not get UID of name '${String(body[0])}': no such name`);
      return [member === "GetConnectionUnixUser" ? c.uid : c.pid];
    }
    if (destination === "org.freedesktop.DBus" && member === "ListNames") {
      return [["org.freedesktop.DBus", this.uniqueName(), ...this.connections.keys()]];
    }
    if (destination.startsWith(":")) {
      if (!this.peer) throw new FakeBusError("org.freedesktop.DBus.Error.ServiceUnknown", `The name ${destination} was not provided`);
      return this.peer(destination, member, body);
    }
    if (member === "GetNameOwner") {
      if (!this.logindPresent) throw new FakeBusError("org.freedesktop.DBus.Error.NameHasNoOwner", "Could not get owner of name 'org.freedesktop.login1': no such name");
      const reply = [this.logindOwner];
      this.onReply?.(member);
      return reply;
    }
    if (destination !== "org.freedesktop.login1") throw new FakeBusError("org.freedesktop.DBus.Error.ServiceUnknown", "no such name");
    if (!this.logindPresent) throw new FakeBusError("org.freedesktop.DBus.Error.ServiceUnknown", "The name org.freedesktop.login1 was not provided");
    if (member === "ListSessions") {
      return [this.sessions.map((s) => [s.id, s.uid, s.user ?? `user${s.uid}`, s.seat ?? "", `/org/freedesktop/login1/session/_3${s.id}`])];
    }
    if ((member === "GetAll" || member === "Get") && path.startsWith("/org/freedesktop/login1/session/")) {
      const s = this.sessions.find((x) => `/org/freedesktop/login1/session/_3${x.id}` === path);
      if (!s) throw new FakeBusError("org.freedesktop.DBus.Error.UnknownObject", `Unknown object '${path}'.`);
      const all: Record<string, { signature: string; value: unknown }> = {
        Id: v("s", s.id), Type: v("s", s.type ?? "x11"), Class: v("s", s.class ?? "user"), State: v("s", s.state ?? "active"),
        Remote: v("b", s.remote ?? false), LockedHint: v("b", s.lockedHint ?? false), IdleHint: v("b", s.idleHint ?? false),
        Seat: v("(so)", [s.seat ?? "", s.seat ? `/org/freedesktop/login1/seat/${s.seat}` : "/"]),
        Timestamp: v("t", s.timestampUs ?? 1_790_000_000_000_000n), User: v("(uo)", [s.uid, `/org/freedesktop/login1/user/_${s.uid}`]),
        Active: v("b", s.state === "active"), Scope: v("s", s.scope ?? `session-${s.id}.scope`),
      };
      if (member === "GetAll") return [all];
      const one = all[String(body[1])];
      if (!one) throw new FakeBusError("org.freedesktop.DBus.Error.UnknownProperty", `Unknown property ${String(body[1])}`);
      return [one];
    }
    if (member === "GetSession") {
      const s = this.sessions.find((x) => x.id === body[0]);
      if (!s) throw new FakeBusError("org.freedesktop.login1.NoSuchSession", `No session '${String(body[0])}' known`);
      return [`/org/freedesktop/login1/session/_3${s.id}`];
    }
    if (member === "GetSessionByPID") {
      const id = this.sessionOfPid.get(Number(body[0]));
      if (id === undefined) throw new FakeBusError("org.freedesktop.login1.NoSessionForPID", `PID ${String(body[0])} does not belong to any known session`);
      return [`/org/freedesktop/login1/session/_3${id}`];
    }
    if (member === "Get" && path === "/org/freedesktop/login1/seat/seat0") {
      if (!this.hasSeat0) throw new FakeBusError("org.freedesktop.DBus.Error.UnknownObject", `Unknown object '${path}'.`);
      return [v("(so)", [this.seat0Active, this.seat0Active ? `/org/freedesktop/login1/session/_3${this.seat0Active}` : "/"])];
    }
    if (member === "Get" && body[1] === "ScheduledShutdown") return [v("(st)", this.scheduled)];
    if (member === "Get" && body[1] === "PreparingForSleep") return [v("b", this.preparingForSleep)];
    if (member === "Get" && body[1] === "PreparingForShutdown") return [v("b", this.preparingForShutdown)];
    if (member === "Suspend") return [];
    throw new FakeBusError("org.freedesktop.DBus.Error.UnknownMethod", `${iface}.${member}`);
  }

  async addMatch(rule: string): Promise<void> {
    this.matches.push(rule);
  }

  onSignal(h: (s: BusSignal) => void): void {
    this.signalHandlers.push(h);
  }

  onClose(h: (err: Error) => void): void {
    this.closeHandlers.push(h);
  }

  close(): void {
    this.closed = true;
    for (const reject of this.hung.splice(0)) reject(new Error("the system bus connection is closed"));
  }

  async requestName(name: string): Promise<boolean> {
    this.calls.push(`org.freedesktop.DBus.RequestName ${name}`);
    if (this.refuseNames) throw new FakeBusError("org.freedesktop.DBus.Error.AccessDenied", `Connection ":1.1" is not allowed to own the service "${name}" due to security policies in the configuration file`);
    if (!this.owned.includes(name)) this.owned.push(name);
    return true;
  }

  onCall(path: string, handler: (c: BusCall) => void): void {
    this.callHandlers.set(path, handler);
  }

  uniqueName(): string {
    return ":1.1";
  }

  /**
   * Another connection calls this one, as the bus delivers it: `sender` stamped by the daemon.
   * Resolves with the answer, or never, while the handler gives none.
   */
  callIn(sender: string, path: string, iface: string, member: string, signature = "", body: unknown[] = []): Promise<CallAnswer> {
    return new Promise<CallAnswer>((resolve) => {
      const h = this.callHandlers.get(path);
      if (!h) return resolve({ error: "org.freedesktop.DBus.Error.UnknownMethod", text: `no object at ${path}` });
      h({
        sender, path, interface: iface, member, signature, body,
        reply: (sig = "", b = []) => resolve({ reply: b, signature: sig }),
        fail: (error, text) => resolve({ error, text }),
      });
    });
  }

  /** The bus daemon announces a connection's end (or a forger sends it, from `sender`). */
  connectionGone(name: string, sender = BUS_DAEMON): void {
    this.connections.delete(name);
    this.emit({ sender, path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", body: [name, name, ""] });
  }

  emit(s: BusSignal): void {
    for (const h of this.signalHandlers) h(s);
  }

  /** The connection lost, as dbus-next's `error` event reports it. */
  lose(err = new Error("read ECONNRESET")): void {
    this.closed = true;
    for (const h of this.closeHandlers) h(err);
  }
}

/** logind's unique name on the fake bus, the sender of its signals. */
export const LOGIND_OWNER = ":1.5";
/** The bus daemon's name, the sender of `NameOwnerChanged`. */
export const BUS_DAEMON = "org.freedesktop.DBus";

/** logind's power signals as the bus delivers them, from logind unless a test forges them from another sender. */
export const prepareForSleep = (start: boolean, sender = LOGIND_OWNER): BusSignal =>
  ({ sender, path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "PrepareForSleep", body: [start] });
export const prepareForShutdown = (start: boolean, sender = LOGIND_OWNER): BusSignal =>
  ({ sender, path: "/org/freedesktop/login1", interface: "org.freedesktop.login1.Manager", member: "PrepareForShutdown", body: [start] });
/** A session's property change (`LockedHint`), as logind sends it. */
export const sessionChanged = (id: string, sender = LOGIND_OWNER): BusSignal => ({
  sender, path: `/org/freedesktop/login1/session/_3${id}`, interface: "org.freedesktop.DBus.Properties", member: "PropertiesChanged",
  body: ["org.freedesktop.login1.Session", { LockedHint: { signature: "b", value: true } }, []],
});
/** logind's name changing hands, as the bus daemon announces it: `oldOwner` to `newOwner` ("" for none). */
export const logindOwnerChanged = (oldOwner: string, newOwner: string, sender = BUS_DAEMON): BusSignal => ({
  sender, path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged",
  body: ["org.freedesktop.login1", oldOwner, newOwner],
});
