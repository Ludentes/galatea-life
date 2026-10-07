/** The machine as the OS names it: its identifier (`/etc/machine-id` on Linux) and its maker's names. */
export interface Identity {
  machineId: string;
  vendor: string;
  model: string;
}

/**
 * What the OS announces about power. `announced: false` is a suspend or shutdown the OS gave the
 * bridge no warning of; only the scripted OS can say so, since a real one freezes the process.
 * `resume` carries the time asleep as the OS measured it.
 */
export type PowerEvent =
  | { kind: "suspend"; announced: boolean }
  | { kind: "shutdown"; announced: boolean }
  | { kind: "resume"; asleepMs: number };

/**
 * An interactive account as the OS lists it: its own identity for it (the uid), its name, its
 * primary group, its home directory, and its `PATH` as its login shell gives it: the search order in
 * which the core resolves a plugin's interpreter for it (GA-BRIDGE-68), and the `PATH` its plugins'
 * servers get.
 */
export interface OsAccount {
  osId: number;
  name: string;
  primaryGid: number;
  home: string;
  path: string[];
}

/** What a look at one path finds: whether it is there, and whether it is a file the OS would run. */
export interface PathInfo {
  exists: boolean;
  executable: boolean;
}

/**
 * The interactive accounts the OS lists now (the port filters out service accounts), and, of the
 * osIds the core asked about, those the OS reports gone now on its own authority (a local account no
 * longer in `/etc/passwd`): read afresh at each observation, never remembered, so that a deletion
 * made while the bridge was stopped, or one a crash kept from the disk, is reported again. An
 * account in neither keeps its token: a lapse, or a directory that cannot answer, is never a
 * deletion (GA-BRIDGE-52).
 */
export interface AccountsReading {
  listed: OsAccount[];
  deleted: number[];
}

/**
 * A login session as the OS reports it (logind's on Linux); a closed one is not listed. `graphical`
 * is logind's `Type` x11, wayland or mir; `seat0Active` marks the session active at the console;
 * `startedAt` is ms since the epoch.
 */
export interface OsSession {
  id: string;
  osId: number;
  graphical: boolean;
  remote: boolean;
  seat0Active: boolean;
  state: "active" | "locked" | "disconnected";
  idleHint: boolean;
  startedAt: number;
}

/** One observation of the host: the computer's check-in. */
export interface Observation {
  accounts: AccountsReading;
  sessions: OsSession[];
}

/**
 * The OS's raw administrator facts, which the core reduces (*The core*): the groups with their
 * members (primary groups included), each account's sudo answer, and the identities polkit's
 * administrator rules name, resolved by the OS: `unix-user:<name>` to the account, `unix-group:<name>`
 * to the group, any identity it cannot resolve given as written (an identity the OS answers is not
 * there names no one, and may be left out); with whether a rules file is there that the backend
 * does not recognise. `incomplete`, when not empty, says why the OS cannot enumerate the set in full
 * (a directory named in `nsswitch.conf`, a member that could not be looked up): the core then adds
 * `unknown` (GA-BRIDGE-53).
 */
export interface AdminFacts {
  groups: { name: string; gid: number; members: { osId: number; name: string }[] }[];
  sudo: { osId: number; name: string; root: "yes" | "no" | "cannotTell" }[];
  polkit: {
    users: { osId: number; name: string }[];
    groups: { name: string; gid: number }[];
    unresolved: string[];
    unrecognised: boolean;
  };
  incomplete?: string[];
}

/**
 * A connection to the helper endpoint, as the OS identifies it: the uid and pid the bus reports for
 * the caller, and logind's session for that pid (null when it is in none). Never what the helper says.
 */
export interface HelperConnection {
  conn: number;
  pid: number;
  osId: number;
  session: string | null;
}

/** What a helper reads in its session; the idle threshold is the helper's to apply. */
export interface HelperValues {
  activity?: "active" | "idle";
  app?: string | null;
  camera_in_use?: boolean;
  microphone_in_use?: boolean;
}

/**
 * A connection made, a report on it naming the session it is for, a message on it the endpoint could
 * not read (`malformed`: a call it does not offer, arguments of the wrong types), or the connection
 * gone (every one that closes, one the bridge closed included); or a helper process the port started
 * that ended (`exited`), on its own or stopped by the port because it did not connect within the
 * port's bound (plan 4b): the core's word that a helper that never bound is not coming, and that a
 * bound one's process is gone. An `exited` for a pid the core no longer holds (one it stopped) means
 * nothing.
 */
export type HelperMessage =
  | { kind: "connected"; from: HelperConnection }
  | { kind: "report"; from: HelperConnection; session: string; values: HelperValues }
  | { kind: "malformed"; from: HelperConnection; detail: string }
  | { kind: "gone"; from: HelperConnection }
  | { kind: "exited"; pid: number };

export type Urgency = "info" | "warning" | "critical";

/**
 * One plugin version's server, as the core asks the port to start it (GA-BRIDGE-42, GA-BRIDGE-49):
 * as the account `osId`, in `session` (a `needsSession` plugin's chosen graphical session) or as a
 * background process (null), by `argv` (the interpreter's absolute path from the record, or the
 * package's own command, then the rest of the manifest's `command`, each file of the package as an
 * absolute path), in the version's directory, with `env` and nothing else: the core builds it from
 * nothing (GA-BRIDGE-48). `noNewPrivs` is always true: on Linux, `setpriv --no-new-privs`.
 */
export interface ServerSpec {
  plugin: string;
  version: string;
  osId: number;
  session: string | null;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  noNewPrivs: true;
}

/** How a server's process ended: its exit code, or the signal that ended it. */
export interface ServerExit {
  code: number | null;
  signal: string | null;
}

/**
 * A server the port started. Its standard input and output are the MCP transport and nothing else
 * (its standard error is the port's to log); the core speaks MCP over them itself, so the port
 * knows nothing of MCP.
 */
export interface ServerProcess {
  pid: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  /** Settles once, when the process has exited, however it ended (a crash, a signal, `stop`); never rejects. */
  exited: Promise<ServerExit>;
  /**
   * Ends it and everything it started: asks the whole of it to exit (on Linux, SIGTERM to its
   * process group, so that a player it started goes with it), then forces what is left (SIGKILL to
   * the group) once the port's own grace has passed. The group is signalled whether or not the
   * server itself has exited: one that crashed leaves its player running, and the core stops it
   * before a restart. Resolves once the server has exited, never before; may be called any number of
   * times, and after the process ended on its own. Plan 4's Linux backend keeps this.
   */
  stop(): Promise<void>;
}

/**
 * The one interface the bridge's core calls. Every method returns what the OS reports, never what
 * a helper says; a helper's word reaches the core only through `onHelper`, tagged with the OS's
 * identity for its connection. The Linux backend implements it with logind and the OS's tools; the
 * scripted backend from the harness's control messages.
 *
 * What the core may do at once, which every backend supports:
 * - `observe` may be called while another is pending (a resume's and a tick's); each settles on its own.
 * - `sleep`, `shutdown`, `cancelShutdown`, `stepClock`, `admins`, `lock`, the helper calls and
 *   `notify` may be called while an `observe` is pending, and while one another is.
 * - `canWrite`, `exists` and `makeRootOnlyDir` may be called at any time, several at once, while any
 *   other call is pending; `pluginsDir` returns at once and never changes.
 * - `startServer` and `displayEnv` may be called at any time, several at once (the servers of several
 *   plugins, or of two versions of one during a swap); each server's `stop` and `exited` may be used
 *   while any other call is pending. `close` does not stop the servers: the core stops each first.
 * - `close` may be called while any call is pending: it settles them (rejecting is enough) and resolves
 *   without waiting on the OS; the core ignores what they return after it.
 * - The `onPower` handler's promise never rejects, and a suspend is held until it settles or until the
 *   OS's own limit (logind's InhibitDelayMaxSec), whichever comes first.
 * - The `onChange`, `onAdminsChange` and `onHelper` handlers return at once; the core does its work
 *   after they return.
 */
export interface OsPort {
  identity(): Promise<Identity>;
  /** Whether the OS's own source of observations is there at all (logind on the bus); its loss is `down` at once. */
  observerPresent(): boolean;
  /**
   * One observation of the host, the computer's check-in; throws when the OS could not be read.
   * `known` is every osId the core holds a token for: the reading's `deleted` answers which of them
   * the OS reports gone now.
   */
  observe(known: readonly number[]): Promise<Observation>;
  /** The OS reports a change worth observing at once: the observer lost or regained, a session or an account changed. */
  onChange(handler: () => void): void;
  /** A suspend, shutdown or resume; the OS holds a suspend until the returned promise settles. */
  onPower(handler: (e: PowerEvent) => Promise<void>): void;
  /** Resolves once the OS has accepted the sleep. */
  sleep(): Promise<void>;
  /** Resolves once the OS has accepted the shutdown: at once, or after `delayS` with its own warning. */
  shutdown(delayS?: number): Promise<void>;
  /** Withdraws a scheduled shutdown; resolves whether one was scheduled. */
  cancelShutdown(): Promise<boolean>;
  /** Has the OS step its clock to its time source; resolves whether it did. */
  stepClock(): Promise<boolean>;
  /** The administrator facts; throws when they could not be read. */
  admins(): Promise<AdminFacts>;
  /** The OS reports a change of the administrator facts (a group, sudo's or polkit's files). */
  onAdminsChange(handler: () => void): void;
  /** The sensor keys this backend's helpers can read (`app`, `camera_in_use`, `microphone_in_use`). */
  personalKeys(): string[];
  /** Whether `host` (the broker's) names this machine: loopback, or one of its own addresses (GA-BRIDGE-65). */
  isOwnAddress(host: string): Promise<boolean>;
  /** Asks the OS to lock these sessions; the outcome is read from later observations. */
  lock(sessionIds: string[]): Promise<void>;
  /**
   * Starts the session helper in that session, as its account; resolves with its pid before the
   * launcher is released to run it (*Starting a process in a session*), so that the core has the pid
   * before the helper can connect. Its connection's message may still reach the core first; the core
   * judges it once the start has settled. Settles within the port's own bound (plan 4b: each step of
   * the start bounded), and a helper that has not connected within the port's connect bound (plan 4b:
   * 10 s) is stopped; the end of the helper's process, however it came, is reported as `exited`.
   */
  startHelper(sessionId: string): Promise<number>;
  /** Stops a helper the bridge started. */
  stopHelper(pid: number): Promise<void>;
  /** Ends a connection the bridge refused. */
  closeHelper(conn: number): Promise<void>;
  onHelper(handler: (m: HelperMessage) => void): void;
  /** Has the helper on that connection show a notification; resolves once it handed it to the session's notification service. */
  notify(conn: number, text: string, urgency: Urgency): Promise<void>;
  /**
   * Whether that account can write the path without elevation: the file or directory itself, by its
   * owner, group and mode, for the uid and its groups. The core asks it of each directory on a path
   * itself (GA-BRIDGE-68); a path that is not there is not writable. A symbolic link is followed:
   * the Linux port (plan 4) resolves the path with `realpath` and answers for the target, and the
   * target's own chain of directories, so a link into a directory the account can write is writable
   * (`/usr/bin/python3` → `/etc/alternatives/python3` → `/usr/bin/python3.12`).
   */
  canWrite(osId: number, path: string): Promise<boolean>;
  /**
   * Whether the path is there, and whether it is a file the OS would run: all `PATH` resolution reads.
   * A symbolic link answers for its target, resolved as `canWrite` resolves it (the Linux port's `realpath`).
   */
  exists(path: string): Promise<PathInfo>;
  /** The directory plugins are installed in, `<id>/<version>/` under it (GA-BRIDGE-70). */
  pluginsDir(): string;
  /** Makes the directory, or takes the one there, writable by the bridge's service alone: on Linux owned by root, mode 0755 (GA-BRIDGE-70). */
  makeRootOnlyDir(path: string): Promise<void>;
  /**
   * The display variables of that graphical session, for a `needsSession` server: those of
   * `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` it
   * has. On Linux (plan 4) read from the account's user manager (`systemctl --user
   * --machine=<account>@.host show-environment`, as root), where GNOME puts them; the core keeps only
   * these names, whatever else comes back. Throws when they cannot be read.
   */
  displayEnv(sessionId: string): Promise<Record<string, string>>;
  /**
   * Starts a plugin's server as `spec` says: on Linux (plan 4) through the launcher of *Starting a
   * process in a session*, moved into the session's scope when `spec.session` names one, then
   * `setpriv --reuid --regid --init-groups --no-new-privs`. Resolves once the process runs; rejects
   * when it could not be started (the interpreter gone, the launcher refused), nothing left running.
   */
  startServer(spec: ServerSpec): Promise<ServerProcess>;
  close(): Promise<void>;
}
