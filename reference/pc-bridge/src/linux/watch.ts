import { watch, type FSWatcher } from "node:fs";
import { posix } from "node:path";
import { DIRECTORY_CONFIG_PATHS, under } from "./etc.js";
import { RULES_DIRS } from "./polkit.js";

/** A burst of changes (useradd writes passwd, shadow, group and their backups) is one change. */
export const WATCH_DEBOUNCE_MS = 200;

/** What changes in `/etc` mean: the accounts (`onChange`), the administrators (`onAdminsChange`), or both. */
const ETC_ACCOUNTS: readonly string[] = ["passwd", "login.defs", "nsswitch.conf"];
const ETC_ADMINS: readonly string[] = ["group", "passwd", "sudoers", "nsswitch.conf"];
/** The directory configurations in `/etc` itself, and the directories holding the others: both kinds of change (review N1). */
const ETC_DIRECTORY: readonly string[] = [...DIRECTORY_CONFIG_PATHS].filter((p) => posix.dirname(p) === "/etc").map((p) => posix.basename(p));
const DIRECTORY_DIRS: readonly string[] = [...new Set([...DIRECTORY_CONFIG_PATHS].filter((p) => posix.dirname(p) !== "/etc")
  .flatMap((p) => (p.endsWith(".d") ? [posix.dirname(p), p] : [posix.dirname(p)])))];

/**
 * inotify, through `fs.watch`, on the files the backend reads (*The OS port*): `/etc` for
 * `passwd`, `group`, `login.defs`, `nsswitch.conf` and `sudoers` (watched as a directory, since
 * each is replaced by a rename, which a watch on the file would lose), `/etc/sudoers.d`, and
 * polkit's rules directories. A directory that is not there, or cannot be watched (a non-root run
 * cannot watch `/etc/polkit-1/rules.d`), is tried again at each `ensure`: the 24 h re-read covers
 * what no watch saw. A watch that fails is dropped and tried again the same way; nothing throws.
 */
export class Watches {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<() => void, NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly o: {
    root: string;
    onAccounts: () => void;
    onAdmins: () => void;
    debounceMs?: number;
    log?: (line: string) => void;
  }) {}

  private fire(h: () => void): void {
    if (this.closed || this.timers.has(h)) return;
    this.timers.set(h, setTimeout(() => {
      this.timers.delete(h);
      if (!this.closed) h();
    }, this.o.debounceMs ?? WATCH_DEBOUNCE_MS));
  }

  private add(dir: string, on: (name: string | null) => void): void {
    if (this.watchers.has(dir) || this.closed) return;
    try {
      const w = watch(under(this.o.root, dir), { persistent: false }, (_event, name) => on(name === null ? null : String(name)));
      w.on("error", (err) => {
        (this.o.log ?? console.error)(`watch ${dir}: ${err}`);
        w.close();
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      // Not there, or not ours to watch: tried again at the next ensure.
    }
  }

  /** Installs every watch not yet in place; called at start and at each administrators' read. */
  ensure(): void {
    this.add("/etc", (name) => {
      const directory = name !== null && ETC_DIRECTORY.includes(name);
      if (name === null || directory || ETC_ACCOUNTS.includes(name)) this.fire(this.o.onAccounts);
      if (name === null || directory || ETC_ADMINS.includes(name)) this.fire(this.o.onAdmins);
    });
    // `realm join` writes sssd.conf and leaves nsswitch.conf alone: a directory configured is a change.
    for (const dir of DIRECTORY_DIRS) {
      this.add(dir, () => {
        this.fire(this.o.onAccounts);
        this.fire(this.o.onAdmins);
      });
    }
    this.add("/etc/sudoers.d", () => this.fire(this.o.onAdmins));
    for (const dir of RULES_DIRS) this.add(dir, () => this.fire(this.o.onAdmins));
  }

  /** The directories watched now, for the by-hand read. */
  watched(): string[] {
    return [...this.watchers.keys()];
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
