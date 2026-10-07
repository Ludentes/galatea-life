---
title: The PC reference build — design
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/specs/2026-09-27-conformance-harness-wave-0-design.md
  - docs/specs/2026-09-25-pc-design.md
  - standard/bridge.md
  - standard/applier.md
---

# The PC reference build — design

Classification: **architectural**. Nothing under `reference/` exists, and this build adds three
new subjects (a PC bridge, a wake relay, a plugin) and the harness's Host-level tests. It is the PC
workstream of the roadmap, beside the core. It changes no
standard.

## What this build delivers

1. **A reference PC bridge for Linux**, claiming Serve and Host: the computer (power, sessions,
   the session helper, `notify`, `otherAdmins`), plugin hosting (install, activation, pinning,
   staged versions, the server's lifecycle), graded to a Host claim.
2. **A wake relay**, claiming Serve: Wake-on-LAN for the entries its owner configured.
3. **An mpv plugin**: a manifest and an MCP server driving mpv, the first plugin the bridge hosts.
4. **The PC harness**: the scripted OS behind the test transport, the Host and computer
   requirement tests, the test plugin, and the real-OS run.

Done when a `run` and a `negatives` of the PC bridge both pass at Serve and Host, the real-OS run
included, a `run` and a `negatives` of the wake relay pass at Serve, and the maintainer has graded
GA-BRIDGE-56 (a `judged` requirement) from the notification hook's record. Graded by the bridge's requirements: Serve, and the
PC's GA-BRIDGE-42 to 70 (GA-BRIDGE-71 to 73 are the IR transmitter's, not the PC's, though the
roadmap's range names them). HS19 to HS25 need the core's steward, applier and brain, so they are
replayed once those exist (story replay, the old T-6); until then the requirement tests are the
grade.

Out of this build, and why:
- **Windows** (the maintainer, 2026-09-27: Linux first). The Windows backend needs native calls
  (WTS, `CreateProcessAsUser` with a filtered token, a named pipe's access list) through an FFI such
  as Koffi, and a service wrapper (WinSW), since Node is not a Windows service by itself. It gets a
  design of its own once this one has a Host claim; the OS port below is its seam.
- **The applier's side of computers** (`wake_via`, *Waking*, adoption and `activate`): the core's
  applier. The harness plays the applier here.
- **HS26** (a NAS, long jobs): waits on the discussion with the Galatea brain project.
- **GA-BRIDGE-50's sandbox** (a SHOULD): after the Host claim.
- **The bench** (Wake-on-LAN through a suspend, a Modern Standby laptop, Windows' `LogonTime`,
  every ⚠️ constant): measured once the bridge runs on real machines; listed at the end.

## Decisions of the maintainer (2026-09-27)

- Linux first; Windows in a later design.
- The first plugin drives mpv. HS19 names Kodi; with mpv in Kodi's place it drives the same way,
  except that mpv has no library, so `media.launch` picks from folders the plugin is configured
  with (*The mpv plugin*).
- The Linux real-OS run happens on the home server.
- The mpv plugin's id is `org.galatea.mpv`.
- Each bridge implements the binding's Serve level itself: no shared bridge library. The PC bridge
  and the wake relay are separate packages with no code in common, as every build is.

## Approaches considered

**A. One bridge core over an OS port, with a scripted OS as a backend** (chosen). Everything the
standard decides (tokens, the combined session key, the helper binding's rules, `otherAdmins`,
acks, plugin hosting) is platform-free code above one interface, the OS port. A Linux backend
implements it with logind and the OS's tools; a scripted backend implements it from the harness's
control messages, which is what the bridge's *Conformance* asks ("the test transport stands in for
the OS"). The same core is graded through the scripted OS for logic, and on a real OS for
privileges. Windows later is one more backend.

**B. A bridge per OS.** Each backend owns its logic. Rejected: the token and session rules alone are
pages of MUSTs, and two copies would drift; the scripted OS would grade neither.

**C. Grade only on real machines.** No scripted OS; every test drives a VM. Rejected: suspends,
deleted directory accounts, forged helpers and a crash loop of five starts are slow or impossible
to stage on a real OS, and the standard already names what only a real OS can show.

## Where it lives

| Path | Package | Holds |
|---|---|---|
| `reference/pc-bridge/` | `@ludentes/galatea-life-pc-bridge` | The system service, the session helper (a second entry point), the OS port and its Linux and scripted backends, `subject.json` |
| `reference/wake-relay/` | `@ludentes/galatea-life-wake-relay` | The wake relay, `subject.json` |
| `reference/plugins/mpv/` | `@ludentes/galatea-life-plugin-mpv` | The manifest, the MCP server, the packaging script that makes the plugin's package |
| [`conformance/harness/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/harness) | `@ludentes/galatea-life-harness` | The PC requirement tests, beside wave 0's, under `tests/bridge/pc/` |
| [`conformance/sim/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/sim) | `@ludentes/galatea-life-sim` | The test plugin, and the harness's side of the scripted OS |
| a real-OS folder in the conformance tree (to come) | — | The VM's build script and the real-OS run's driver |

TypeScript and pnpm throughout, in the root workspace wave 0 creates. A build imports only
`@ludentes/galatea-life-schemas` (the generated types) and `@ludentes/galatea-life-test-clock`, never another build, never the
harness. The scripted backend lives in the bridge, since it is the bridge's test transport
(GA-BRIDGE-16); the harness only sends it messages.

Libraries: MQTT.js 5 (the binding), the MCP TypeScript SDK's v2 line,
`@modelcontextprotocol/client` for the bridge's client to plugin servers and
`@modelcontextprotocol/server` for the mpv plugin's server, never v1's `@modelcontextprotocol/sdk`,
which does not speak 2026-07-28, dbus-next (logind, systemd and the helper endpoint), Ajv through
`@ludentes/galatea-life-schemas`. No native module. dbus-next has had no release since 2021; it is pinned, the
first spike confirms it does what this build needs, and the one thing it would need file-descriptor
passing for, logind's inhibitor, is held through `systemd-inhibit` instead (*The OS port*). Node is
the OS's package: Debian 13's Node 20, which the MCP SDK supports.

## The PC bridge

### Processes

- **The system service**, a systemd unit running as root: holds the broker connection, runs every
  action, owns the token store, hosts the plugins, and starts one helper in each graphical session.
- **The session helper**, the same package's second entry point, started by the service in each
  graphical session as that session's user (*Starting a process in a session*). It reports
  `active` or `idle`, the personal keys where it can read them, and shows notifications. It holds
  no credential and never starts a plugin's server (GA-BRIDGE-42).

As plan 4b builds it: the unit is `reference/pc-bridge/system/galatea-pc-bridge.service` and the bus
policy `reference/pc-bridge/system/org.galatea.PcBridge1.conf`; there is no installer yet, and the
VM run copies them to `/etc/systemd/system/` and `/usr/share/dbus-1/system.d/`, with the built
package in `/usr/lib/galatea-pc-bridge`. The unit runs `dist/main.js` as root, restarts it on a
crash but not on exit 2 (a refusal to start, which a restart does not mend), sends SIGTERM to the
bridge alone (`KillMode=mixed`) so that it stops its servers and helpers in its own order, and
leaves out the sandboxing that would reach what it starts (its comment says which and why). Its
bounding set drops only the root powers neither it nor `sudo` uses (`CAP_SYS_MODULE`, `CAP_SYSLOG`,
`CAP_SYS_TIME`, `CAP_SYS_RAWIO`, `CAP_MKNOD`; the review's fix wave), which its children, accounts
with `no_new_privs`, could never gain. It keeps `ProtectKernelModules`, `ProtectKernelLogs` and
`ProtectClock`: in the VM run (plan 4b, *The desktop run*), each alone and then all three
together, the helper's move held, and a server with no session, left in the service's cgroup,
opened `/dev/dri` and `/dev/snd`. `ProtectClock` adds its rtc device allow-list only beside another
device rule (systemd's `unit.c`, v255 and v257), so the unit carries none: adding a `DeviceAllow=`
or `DevicePolicy=` would close the device policy for every server left in its cgroup. `ProtectKernelTunables`
stays out (it makes `/sys` read-only, and with it the cgroup move). The
helper is the package's `galatea-pc-helper` bin (`dist/helper.js`), which the unit never runs. A
helper ends when the endpoint's owner leaves or changes, so a service that crashed leaves no
helper behind; a `needsSession` server it started stays in its session's scope until the session
ends (a stated limit, for the VM run to see).

### The OS port

The one interface the core calls. Every method returns what the OS reports, never what a helper
says; a helper's word reaches the core only through the helper endpoint, tagged with the OS's
identity for its connection.

- **Identity:** the machine's identifier (`/etc/machine-id`); whether the broker's address is one
  of the host's own (GA-BRIDGE-65).
- **Accounts:** the interactive accounts, those with a uid from `UID_MIN` to `UID_MAX` of
  `/etc/login.defs` and a shell other than `nologin` or `false`, with the OS's identity for each
  (uid) and their names. The core passes each observation the uids it holds tokens for, and the
  port answers which of them are gone now, read afresh each time and never remembered, so a
  deletion made while the bridge was stopped, or one a crash kept from the disk, is reported again.
  A deletion is reported only for a local account gone from `/etc/passwd`.
  NSS gives no authoritative "not found" (`getent` exits 2 alike for an account that does not exist
  and an sssd that is offline with no cache), so a directory account that stops resolving is "cannot
  tell", never a deletion: a stated limit of the Linux backend. As plan 4a builds it: where
  `/etc/nsswitch.conf` names no directory for `passwd` (only `files`, `systemd` and the like), a
  known uid gone from `/etc/passwd` is a deletion; where it names one (`sss`, `ldap`, `winbind`),
  nothing is ever reported deleted, and a directory account is listed when the core knows it or it
  has a session, looked up through `getent passwd`, with `UID_MIN` its only bound.
- **Sessions:** logind's sessions with `Type`, `Class`, `State`, `Remote`, `LockedHint`, `IdleHint`,
  `Seat`, `Timestamp`, and which session is active on `seat0`; changes as logind signals them. A
  session of `Class` `greeter` (GDM's login screen) is no account's session. As plan 4a builds it:
  only a `Class` of `user` or `user-…` (systemd 256's `user-early`, `user-incomplete`) is an
  account's session, and a `closing` one is none; `LockedHint` reads `locked`; a graphical session
  on a seat whose `State` is `online` (not `active`: another session holds the seat) reads
  `disconnected`; any other reads `active`, and `IdleHint` gives idleness. The start is
  `Timestamp`'s microseconds, which a clock stepped back may put after now.
- **Administrators:** raw facts, which the core reduces (*The core*), so that the reduction is
  graded through the scripted OS and only the reading of the OS on the real one:
  - the groups, each with its gid and members (from `/etc/group` and each account's primary gid);
  - for each account but root, a service account included (GA-BRIDGE-53 names "every account
    sudo lets run any command as root"; plan 4a follows it over "interactive"), whether sudo lets
    it run at least one command as root (`yes`,
    `no`, `cannot tell`), from `sudo -l -U <account>`: sudo evaluates its own aliases, so the
    backend does not; a grant with a digest, or a `Runas` it cannot read as root or not, is `cannot
    tell`; sudo not installed is `no` for every account; sudo lists another account's rules to
    root only, so a run that is not root reads `cannot tell` for each and runs no sudo;
  - polkit: the identities its administrator rules name, resolved by the OS (a `unix-user:` to the
    account's uid, a `unix-group:` to the group's gid, one that does not resolve given as written
    where `/etc/nsswitch.conf` names a directory, and dropped where it names none and NSS itself
    answers it is not there (plan 4a's fix wave, ratified by the maintainer 2026-10-01), since the local
    files are then the whole answer and a group created later is a change of `/etc/group`: stock
    Ubuntu's rules name `unix-group:admin`, which no install since 12.04 has),
    and whether a rules file is present that the backend does not recognise. A file is recognised
    when a package owns it, dpkg's own record shows it unmodified (`dpkg --verify` on its package),
    and its name is in a table of stock files with a hand-written reduction (Debian's
    `addAdminRule` names `unix-group:sudo`; a rule that grants one action to a group names that
    group only where the action is as good as root, as systemd's `manage-units`). Any other file
    is unrecognised. So a stock system gives a clean list,
    a package update needs no new table, and a stock file the table does not name reads `unknown`
    until it learns it: a stated limit. The table, and each "as good as root" judgement in it, is
    reviewed by the maintainer before the Linux backend ships (plan 4a's table agreed 2026-10-01; the
    two files a stock Debian 13 GNOME install adds, gdm3's `20-gdm.rules` and malcontent's
    `com.endlessm.ParentalControls.rules`, found in plan 4b's desktop run and judged not as good as
    root, agreed 2026-10-01). Plan 4a's table, in
    `src/linux/polkit.ts`, is keyed by path and owning package, each entry carrying its judgement
    for that review; it reads `/etc/polkit-1/rules.d`, `/run/polkit-1/rules.d`,
    `/usr/local/share/polkit-1/rules.d` and `/usr/share/polkit-1/rules.d` (polkit(8) on Debian 13),
    and a directory there that cannot be read (the first, to anyone but root) is unrecognised.
    Debian 13 ships no `49-polkit-pkla-compat.rules` (`polkitd-pkla` is bookworm's and sid's).

  Re-read at start, on a change of `/etc/group`, `/etc/passwd`, `/etc/sudoers*` or the polkit
  directories (inotify), and every 24 h. A read that fails gives `cannot tell` for what it covers.
- **Power:** `sleep` through logind's `Suspend`; `shutdown` through `shutdown +N` with `delay_s`
  rounded up to whole minutes, `shutdown now` without it; `cancel` through `shutdown -c`, with
  whether anything was scheduled read from logind's `ScheduledShutdown`. A `delay` inhibitor is held
  at all times by a child process, `systemd-inhibit --what=sleep:shutdown --mode=delay` around a
  process that waits, and released by ending that child only after the terminal ack and the graceful
  `offline` are published, on `PrepareForSleep(true)` and `PrepareForShutdown(true)` (GA-BRIDGE-22);
  it is taken again at resume. On `PrepareForSleep(false)`, a clock step (`chronyc makestep`, else
  `timedatectl` with systemd-timesyncd restarted), at most 10 s, before the first `status`
  (GA-BRIDGE-59). The resume reports the time asleep, measured as the growth of `/proc/uptime`
  (which counts suspend) less that of Node's monotonic clock (which does not), both sampled every
  second so that a suspend no one announced is measured too. As plan 4a builds it: the inhibitor's
  child is `cat` on a pipe, released by closing it; taken at start and again one second after it
  ends on its own; a `PrepareForShutdown(false)` (a shutdown withdrawn) is a resume with nothing
  asleep; a gap of 1 s or more with nothing announced is a suspend no one announced, reported as
  its resume only; `ScheduledShutdown` reads nothing scheduled as the empty type (systemd 255
  gives `("", 2^64-1)`). Every command and bus call is bounded (5 s by default; the clock step
  10 s).
- **Locking:** `loginctl lock-session <id>` for each graphical session of the account.
- **The helper endpoint** (*The helper endpoint*).
- **Starting a process in a session** and **starting a plugin's server** (*Plugins on Linux*):
  `startServer(spec)` with the plugin, the version, the account's uid, the session or none, the
  argv, the environment and the directory the core gives, and `noNewPrivs` always true; it resolves
  with the process (its stdin and stdout, the MCP transport, which the port knows nothing of; its
  pid; `exited`, which settles once and never rejects; `stop()`, which asks, then forces after the
  port's grace, and resolves only once the process has exited) or rejects with nothing left
  running. `displayEnv(session)` gives that session's display variables, of the five names only,
  for a `needsSession` server, or throws. Any number of these may be pending at once (plan 3d). Each
  account also carries its home directory, the server's `HOME`.
- **Files:** whether an account can write a path without elevation (the path's owner, group and
  mode, checked for that uid and its groups; the core asks for each directory above it itself);
  whether a path exists and is executable, so that the core resolves a command's name in the
  account's `PATH`, the rule graded through the scripted OS; each account's `PATH` as its login
  shell gives it, read with the accounts; the plugins directory, and making it writable only by
  root. Unpacking and hashing a package are the core's own work, in Node (plan 3c). As plan 4a
  builds it: the write check follows each link of the final component, and a path is writable when
  the target, or the directory holding the target or any link on the way, lets the account write
  or replace it (a sticky directory only to its owner or the file's); ACLs and capabilities are not
  read, a stated limit; a check that fails for any reason but a missing path reads writable. The
  `PATH` is the login shell's `printenv PATH` under `setpriv --reuid --regid --init-groups` as
  root, with no PAM and no new session (the process's own account runs its
  login shell itself; any other account without root has none), absolute entries only, kept 10
  minutes. `makeRootOnlyDir` refuses a link or a non-directory and an ancestor others can write.
- **Personal keys:** fixed at start, before any helper runs: `camera_in_use` and
  `microphone_in_use` where PipeWire is installed (`/usr/bin/pipewire`), `app` only where GDM runs
  X11 alone (`WaylandEnable=false` in `[daemon]` of `/etc/gdm3/daemon.conf` or `custom.conf`).

The scripted backend implements the same methods from the harness's messages (*The scripted OS*).

### The helper endpoint

A name on the **system D-Bus**, `org.galatea.PcBridge1` (the name is this build's), whose bus policy
file lets only root own it and any user call it. The bus daemon, not the helper, says who is
calling: the service asks it for the caller's uid and pid
(`GetConnectionUnixUser`, `GetConnectionUnixProcessID`), then asks logind which session that pid is
in (`GetSessionByPID`, which reads the pid's cgroup; the helper is in its session's scope, *Starting
a process in a session*). So no other process can bind the endpoint, and every report carries the
OS's identity (GA-BRIDGE-61, GA-BRIDGE-64). A helper is bound only where both agree: the pid is one
the service started as that session's helper, and logind puts that pid in that session with that
uid. Any other caller (a process of the session the service did not start, a plugin server or a
child of one), and any report for a session other than the caller's, is refused and named as a
`helper_refused` fault on the computer.

Chosen over a Unix socket because Node cannot read `SO_PEERCRED` without a native module, and the
bus gives the same answer with none. A spike checks it first (*Order of work*).

As plan 4b builds it: the endpoint is the object `/org/galatea/PcBridge1`, interface
`org.galatea.PcBridge1`, with two methods: `Hello(s token)`, a helper's first call (its start
token, below), and `Report(s session,
a{sv} values)`, with `activity` (`active` or `idle`), `app` (a string, empty for no focused
window), `camera_in_use` and `microphone_in_use` (booleans), each optional, at most 16 keys and
1024 characters a string. The bus daemon's `GetConnectionUnixUser` and
`GetConnectionUnixProcessID`, then logind's `GetSessionByPID` (none is a session of `null`), are
asked once for each connection, before its first call is passed on, and every message to the core
carries them; a lookup that fails answers the call `org.galatea.PcBridge1.Error.Unavailable` and
passes nothing on. Any other method, or a report over the bounds, reaches the core as the port's
`malformed`, a `helper_refused` fault on the computer. A connection the core refuses is answered
`org.galatea.PcBridge1.Error.Refused` from then on, and the helper ends on it. A connection's
`NameOwnerChanged` taken from the bus daemon only is the helper gone. `notify` goes the other way,
as a method call from the service to the helper's unique name, object
`/org/galatea/PcBridge1/Helper`, `org.galatea.PcBridge1.Helper.Notify(s text, s urgency)`, chosen
over a signal because a call is answered, so a notification service that is not there is the
action's failure, and a signal could be sent by anyone; the helper takes the call only from the
endpoint's owner, and the bus policy lets only root make it. The system bus's default policy
refuses a method call to a connection that owns no name, root's included, so the policy file has
one more rule than *The helper endpoint* above names: root may send to interface
`org.galatea.PcBridge1.Helper`. The port gains two messages for the core: `malformed` and the
helper process's `exited`, which a helper that dies before it connects needs to be started again.

As the review's fix waves build it: the pid the bus daemon gives is the one that opened the
connection, at connect, and that process may have exited and its number gone to the next helper
the service starts, while another process (a plugin server of the session's account) holds the
connection still. A unique name is given at the bus's `Hello`, not at connect, so the order of names
does not order connections either: a connection opened before the helper's spawn can say its bus
`Hello` after the release and get a newer name. So each start has a token: 32 random bytes, which
the service hands the helper on an inherited descriptor (fd 4 through the launcher, written and
closed by the service before the release; never on argv, in the environment or on disk). The helper
reads it at once at start, closes the descriptor, and presents it in `Hello(s)`. The endpoint passes
a connection with a started helper's pid on only when its first call carries that start's token,
compared in constant time and spent at its first use, right or wrong; anything else is refused and
named `helper_refused`. Beside it, a second layer: the highest unique name on the bus is taken
before the spawn (`ListNames`, or the highest the daemon has announced, the later; both dbus-daemon
and dbus-broker give `:<n>.<m>` in rising order), the pid is expected from its spawn, before it is
in the session, and a connection whose name is not newer, or cannot be read, is refused. A bus that
cannot list its names starts no helper. Where the bus daemon gives a pidfd (`GetConnectionCredentials`'
`ProcessFD`, dbus 1.15 and dbus-broker), it would say whether the opener is the started process
itself: a later hardening. Debian 13's dbus (1.16) gives it (read on a stock Debian 13 host,
2026-10-01). A helper whose process ends
while its first call is being identified is closed, not named. Since any account may connect, a
refusal changes the computer's status at most once every 10 s, the latest one named then.

A stated limit, **for the maintainer**: a process of the helper's own account that can trace the
helper, or open its descriptors through `/proc` (where `kernel.yama.ptrace_scope` is 0), can read
its token or act on its connection, and so act as the helper: report the session's activity and
personal keys, and receive its notifications. A plugin's server runs as the session's account, so
nothing in this build separates it from the helper; separating a plugin server from its session's
account is beyond this build, a standards candidate. Debian 13's `ptrace_scope` is 0 by default
(read on a stock Debian 13 host, 2026-10-01), so the limit holds on a stock install.

### Starting a process in a session

A child of the root service is in the service's cgroup, not the session's, whatever its uid, so
logind would put it in no session. The helper and a `needsSession` plugin's server are therefore
started in three steps:

1. The service spawns, as root (Node's `spawn` with no `uid`/`gid`, which would drop the
   supplementary groups before `setpriv` could set them), a launcher that blocks reading a line
   from file descriptor 3: `sh -c 'read -r _ <&3 && exec setpriv --reuid=<uid> --regid=<gid>
   --init-groups --no-new-privs -- <command> 3<&-'`, so the command does not inherit the pipe.
2. The service moves the launcher's pid into the session's scope. systemd's `AttachProcessesToUnit`
   refuses a unit without `Delegate=`, which a logind session scope lacks, so the service writes the
   pid into the scope's `cgroup.procs`
   (`/sys/fs/cgroup/user.slice/user-<uid>.slice/session-<id>.scope/cgroup.procs`), as root.
3. The service writes `"\n"`; the launcher drops to the account, with its groups (mpv needs
   `audio`, `video`, `render`), and runs the command, in the session. For the helper, the port's
   `startHelper` resolves with the launcher's pid before this step, so the core knows the pid before
   the helper can connect.

The environment is built by the service (*Plugins on Linux*); the session's display variables
(`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`) are
read from the account's user manager (`systemctl --user --machine=<account>@.host
show-environment`, as root), where GNOME puts them. `XAUTHORITY` is needed on an X11 session, for
example under GDM, which keeps the X cookie outside `~/.Xauthority`: without it a client such as
mpv cannot open its window. Neither the session leader (GDM's root worker) nor any process in the
session's scope carries them, and GNOME's shell runs under `user@<uid>.service`, not in the scope.
The user manager is one per account, so an account with two graphical sessions gets the latest
one's display, not necessarily the chosen session's (GA-BRIDGE-42): a stated limit of the Linux
backend, and a standards candidate. When
the session ends (logind's `SessionRemoved`), the service stops what it started there. The first
spike checks all of this (*Order of work*), including that systemd leaves the moved pid in the
scope. The helper
reads idleness from the session's idle monitor (GNOME's `org.gnome.Mutter.IdleMonitor`), and
falls back to logind's `IdleHint` (the review's fix wave dropped the freedesktop
`ScreenSaver.GetSessionIdleTime`, whose unit differs between desktops). It shows a
`notify` through `org.freedesktop.Notifications`, the source first ("От: Дмитрий (гость)"), and an
unknown sender marked as such (GA-BRIDGE-56).

The personal keys, on Linux: `camera_in_use` and `microphone_in_use` from PipeWire's graph in the
console session (a video source or an audio input stream running); `app` only where the desktop
gives the focused window (X11's `_NET_ACTIVE_WINDOW`; GNOME on Wayland gives none), and otherwise
not declared. A key the bridge cannot read is left out of `sensorKeys`, never reported empty.

As plan 4b builds it (`src/linux/launch.ts`, `src/linux-os.ts`, `src/helper/`):
- The launcher is `/bin/sh -c 'read -r _ <&3 && exec /usr/bin/setpriv --reuid=<uid> --regid=<gid>
  --init-groups --no-new-privs -- /usr/bin/env -i "$@" 3<&-' galatea-launcher <NAME=value…>
  <argv…>`: the environment's words and the argv as positional parameters, never in the script,
  which holds only numbers; every program by absolute path, since the environment's `PATH` is the
  account's and root must not run a program the account could have put there. `env -i` gives the
  command exactly the environment the core built, nothing a shell exports (dash's `PWD`; bash's
  `SHLVL`, `PWD` and `_` where `/bin/sh` is bash; the review's fix wave), and the launcher itself
  runs with none; a command whose first word holds `=`, which `env` would misread, is refused. The
  words are in `/proc/<pid>/cmdline` for the moment before the command runs: they carry no
  credential (GA-BRIDGE-48). It is spawned detached, its own process group, with no `uid` or
  `gid`. A write into `cgroup.procs` that fails, a launcher
  that ends before its line, or one that has not become its command within 5 s kills its group and
  rejects (the server's case; a helper's is the connect bound below). The scope is logind's
  session `Scope` property where it gives one, else `session-<id>.scope`; a name that is not a
  plain unit name is refused.
- `startHelper` resolves with the launcher's pid, then, on the next turn, once the endpoint has
  listed the bus's names (above), releases it; a helper that
  has not called the endpoint within 10 s is stopped, and the end of its process, however it came,
  is the port's `exited`, so the core starts it again with its backoff. A failure before the pid
  (no session in logind, no display, a failed write) rejects, and the core's backoff applies the
  same way. The helper's environment is `HOME`, the system's `PATH`, `LANG=C.UTF-8` and the session's
  display variables; its argv is `node dist/helper.js --session <id> --idle-after <s> --keys
  <declared keys>`, the threshold 300 s (the standard's default). Its working directory is `/`.
- `startServer` refuses `noNewPrivs` other than `true`, uid 0, and a `needsSession` server whose
  account is not the session's; it resolves once the launcher has become the server (its
  `/proc/<pid>/cmdline` no longer the launcher's, setpriv's or env's). `stop` is 3d's: SIGTERM to
  the group, SIGKILL after 3 s. A `SessionRemoved` from logind stops every helper and `needsSession`
  server started in that session. Stated limits (the review's M7): a descendant that leaves the
  group (`setsid`) is not reached by the stop, and lives until the service stops (its cgroup) or,
  for a `needsSession` server's, until the session ends; and the group's number, signalled as root,
  could be another group's if it empties during the grace and is reused. Stopping by cgroup (a
  transient scope of each server's own, or a delegated sub-cgroup of the service's, and
  `cgroup.kill`) or by pidfd would close both: a later plan's.
- `displayEnv` throws for a session whose `Type` is not `x11` or `wayland`, a `systemctl` that fails,
  and an environment with neither `DISPLAY` nor `WAYLAND_DISPLAY`. systemctl quotes a value it must
  as systemd's `shell_maybe_quote` does, as `$'…'` with C escapes (`\\`, `\'`, `\"`, `\a` to `\v`,
  three octal digits), which the parser reads; on the development machine one value of the
  account's own environment came quoted so.
- Idleness: the helper reads the idle time every 2 s, from Mutter's `GetIdletime` (ms), and
  reports `idle` from the threshold on; without Mutter, logind's `IdleHint` for its own session,
  read-only. The freedesktop `ScreenSaver.GetSessionIdleTime` is not asked: KDE answers in ms, the
  old draft said seconds, and a desktop answering in seconds would read `active` for good (the
  review's fix wave). It reports on a change and at least every 60 s.
- A `notify`: `Notify("Galatea", 0, "", <first line>, <the rest>, [], {urgency}, -1)`, the first
  line (the source) the summary, the rest the body with `&`, `<` and `>` escaped, since a
  notification service may read the body as markup; the urgency hint is 1 for `info` and `warning`
  and 2 for `critical` (the specification has no level between normal and critical).
- The personal keys: `pw-dump` (with the session's `XDG_RUNTIME_DIR`, its output read up to 16 MiB;
  the development machine's graph is about 260 KB) gives the graph; a node's `info.state` is one of
  `creating`, `suspended`, `idle`, `running` and `error`, and PipeWire makes a node `running` while a
  link through it is active. `camera_in_use` is a `Video/Source` node `running`;
  `microphone_in_use` a `Stream/Input/Audio` node `running`, leaving out a capture of a sink's
  monitor (`stream.capture.sink`) and a level meter (`stream.monitor`). `app` is the focused
  window's `WM_CLASS` class from `xprop` (`_NET_ACTIVE_WINDOW` on the root window), an empty string
  for no focused window. A read that fails is no report of that key.

### The core

Platform-free, and all of it graded through the scripted OS:

- **The binding** at Serve: `status`, `lwt`, `devices`, each device's `status`, commands and acks,
  requests and replies, events, the roster, liveness, GA-BRIDGE-16's test transport and run id. It
  is this bridge's own (*Decisions of the maintainer*).
- **The computer:** its check-in every 10 s from the port's session observation (GA-BRIDGE-37),
  the token store, the combined session key, `accounts`, `otherAdmins`, `proposedInfrastructure`,
  and the actions with their acks.
- **The administrators set:** from the port's raw facts, root; every member of `sudo`, `wheel`,
  `admin` and `docker` and every identity polkit names, a group named as a group with its `g` token
  (a gid is never taken for a uid); every account whose sudo answer is `yes`; one `unknown` entry
  where any answer is `cannot tell` or polkit has an unrecognised file. A change is an
  `other_admins_changed` event, and the set is re-read every 24 h whether or not the OS reported a
  change (GA-BRIDGE-53).
- **The token store:** a JSON file in the state directory, written atomically, keyed by uid,
  holding each token, every token ever given (so none is given twice), and retired ones
  (GA-BRIDGE-52).
- **The plugin host:** install, reinstall, uninstall, activation, staged versions, verification of
  files and tools, the server's lifecycle and backoff, state reads and subscriptions, command
  dispatch to tools, faults. Its record of each installed version (the package's `sha256`, the
  manifest as installed, the interpreter's absolute path, the account, the files' hashes, the
  activation) is kept in the state directory, and a request in flight is kept there too, so a
  restart ends it once (GA-BRIDGE-31, GA-BRIDGE-68).
- **Suspend-aware timers:** the servers' 10 s, 120 s and backoff times run on the core's own
  clock: the subject's time source (`@ludentes/galatea-life-test-clock` under a run, else Node's monotonic
  clock) less, at each resume, the part of the time asleep **that the source counted**. That is
  the smaller of the time asleep the port reports and the source's own growth across the suspend:
  zero for Node's monotonic clock, which stops in suspend; the time asleep for test-clock on a real
  OS, whose offset the SNTP poll brings forward at wake. The core freezes these timers when the port
  announces a suspend and thaws them after the resume is applied, so a sleep does not find every
  server hung (GA-BRIDGE-58). Under the scripted OS the harness orders a suspend as: `power
  suspend`, wait for the reply, step the clock by N, `power resume` with `suspendedMs` N; the
  source grew by N, N is taken off, and the step fires none of these timers. Built in plan 3d as
  `SuspendClock` over the bridge's clock: the bridge freezes it at every suspend the port reports,
  announced or not, and thaws it after the resume's clock step; a resume no suspend announced takes
  off at most the source's growth since the clock last looked at it, a stated limit.

### Plugins on Linux

- **Install directory:** `/var/lib/galatea-pc-bridge/plugins/<id>/<version>/`, owned by root, mode
  0755, files 0644, or 0755 where the archive marks them executable (a package's own command), so
  that only the service can write it (GA-BRIDGE-70). Under a run through the scripted OS, which is
  not root, it is `$GALATEA_STATE_DIR/plugins/`. A package is unpacked under the directory's
  `.staging/`, mode 0700, and renamed into place once it checks; the next start empties `.staging/`
  and removes any version directory the record does not name.
- **The broker credential:** `/etc/galatea-pc-bridge/credential`, `root:root` mode 0600, read by the
  service, which runs as root; an administrator reads it through sudo (GA-BRIDGE-64).
- **Fetching:** HTTPS or, under a run, the harness's HTTP server; the archive is a `.tar.gz`,
  checked against `sha256` before it is unpacked, with no path leaving the directory. At most 5
  redirects, each to a URL the first could have been; a package over 100 MiB, or one that unpacks
  to over 512 MiB or 20,000 entries, is refused. Only files and directories unpack: a link, a
  device, a FIFO, an absolute path, a `..`, a path twice, or a path both a file and a directory
  refuses the whole package. The unpacker is the bridge's own (gzip from Node, the ustar and pax
  headers read by hand), so that one pass hashes each file and nothing is written outside.
- **The interpreter:** resolved in the account's `PATH` as a login shell of that account gives it,
  checked with the port's write check against the file, each directory on its path, and each
  earlier directory in `PATH`; recorded as an absolute path and started by it (GA-BRIDGE-68).
- **Starting the server:** as the chosen account, never root, through `setpriv --no-new-privs`
  (GA-BRIDGE-49), with an environment built from nothing but `HOME`, `PATH`, `LANG`, the session's
  display variables for `needsSession`, and the plugin's directory: never the broker credential or
  a token (GA-BRIDGE-48). Its stdio is the MCP transport; the bridge is its client. As plan 3d
  builds it: `HOME` the account's home, `PATH` the account's as its login shell gives it, `LANG`
  `C.UTF-8` (no locale of the service's leaks in), `GALATEA_PLUGIN_DIR` the version's directory,
  which is also its working directory; the argv is the interpreter's absolute path from the record
  (or the package's own command), then the manifest's other elements, each file of the package as
  an absolute path. The files are hashed again at each start, and a file changed, missing or added
  is `pin_mismatch` (GA-BRIDGE-43, GA-BRIDGE-45), kept in the record with its time until a
  reinstall that verifies. The server is its own process group, so that `stop` (SIGTERM to the
  group, whether or not the server itself has exited, then SIGKILL to what is left of it after
  3 s) ends a player it started with it, one a crashed server left running included; the core
  stops a crashed server's process so before it starts it again.
- **MCP:** the client reads `tools/list` and compares each tool's hash (RFC 8785 canonical JSON,
  SHA-256) with the manifest as installed, at every start and on `list_changed` (GA-BRIDGE-44);
  declares no `elicitation` or `sampling` capability, and ends an action whose tool asks for either
  `failed(no_confirmation)` (GA-BRIDGE-47), in either form it takes: a request
  (`elicitation/create`, `sampling/createMessage`) before 2026-07-28, caught by the client's
  `fallbackRequestHandler`; an `input_required` result from it on, which the client, with
  `inputRequired: { autoFulfill: false }`, rejects as `UnsupportedResultType`; and the `-32021`
  refusal an SDK-built server gives itself. It speaks the revisions before 2026-07-28 and the one
  from it on (`versionNegotiation: { mode: "auto" }`), since the lifecycle words differ
  (`initialize` or `server/discover`, `ping` or `server/discover`, `resources/subscribe` or
  `subscriptions/listen`), over a transport of the bridge's own: the SDK's stdio transport starts
  the server a second time to probe the era, and the bridge starts servers through its launcher
  (*Starting a process in a session*). The era found is kept with the version as installed, and a
  version whose kept era is before 2026-07-28 is spoken to in it at once, with no probe. The tool
  hashes are taken over the tools as the server wrote them on the wire, since the SDK's parsed view
  drops a field it does not know and would hide a change. State reads bypass the SDK's cache.
- **Size caps**, the bridge's own, since the standard bounds only ids, keys and versions: a string
  reading over 1 KiB is left out and named as a fault, as a value failing its type is; a state
  object over 64 KiB is a failed read; an ack's `detail` is cut at 1 KiB, the cut marked; a manifest
  over 256 KiB, more than 64 tools, or a description over 2 KiB is `invalid_manifest`; image, audio
  and embedded resource content in a tool result is dropped, since nothing on the binding carries
  it. The stdio transport's own ceiling, 10 MB a message, closes a flooding server, which the
  bridge then treats as one that stopped (GA-BRIDGE-58).

## The wake relay

A small bridge of its own at Serve, run on the box. Its configuration lists entries (a MAC, a label)
and the LAN interface. Each entry is a device as *The wake relay* declares it: `feedback: open`,
`internal: true`, `proposedClass` null, one action `power.wake`, `confirms: false`, acked `sent`
once the magic packet (UDP broadcast to port 9, the MAC sixteen times after six `0xFF`) has left the
interface. Its transport is `up` while the interface has a carrier (`/sys/class/net/<if>/carrier`)
and the gateway answered an `arping` within the last 30 s, probed every 10 s (GA-BRIDGE-23,
GA-BRIDGE-55). The relay runs with `CAP_NET_RAW` for `arping`, not as root. Under a run, its
test transport replaces the interface: the harness sets the carrier and the gateway's answers with
the `link` op, and reads each packet sent on `received` (*The scripted OS*).

## The mpv plugin

- **Manifest:** `id` `org.galatea.mpv` (the maintainer, 2026-09-27; fixed from the first install), one device `player`,
  class `player`, `needsSession: true`, `command: ["node", "server.js"]` (Node from the OS's
  package, in `/usr/bin`; `server.js` is one file bundled with esbuild, the MCP SDK inside it, since
  a server starts only from its package's own files), `hosts: []`, `cadenceMs` 5000, `otherAdmins`
  absent: mpv's IPC socket is
  created by the server in the account's runtime directory, mode 0600, so no network control
  exists.
- **Actions:** `media.launch(search: { title: any, kind: [movie, episode] })`, not idempotent;
  `media.pause`, `media.resume`, `media.set_volume(volume: 0–100)`; the keys `playing`, `volume`,
  `title`, `started_at`. `media.launch` picks the best match for `title` among the files under the
  folders in the plugin's own configuration (`~/.config/galatea-mpv/folders`, default `~/Videos`),
  and fails the tool with the reason when nothing matches. It never takes a path or a URL
  (GA-BRIDGE-54: the manifest's word, and here also its code).
- **The server** starts mpv idle (`--idle --force-window=no --input-ipc-server=…`), drives it by
  its JSON IPC, observes `pause`, `volume` and `path`, serves the state resource, and notifies on a
  change. `started_at` is the time mpv reported the file loaded. It is served with the SDK's
  `serveStdio`, which answers both eras; a server merely connected to a stdio transport speaks the
  2025 era only. Before 2026-07-28 it notifies only a resource the client subscribed to, since the
  SDK leaves that to the server; from 2026-07-28 the SDK's `subscriptions/listen` filters.
- **Its own tests** (vitest) run against a real mpv with `--vo=null --ao=null`, no screen needed.

## The PC harness

### The scripted OS

The bridge's test transport under `GALATEA_TEST_TRANSPORT` swaps the Linux backend for the scripted
one. New ops on the control topic, added to the wave 0 design's table before they are used, as it
asks:

| `op` | Fields | What the scripted OS does |
|---|---|---|
| `account` | `osId`, `name`, `interactive`, `primaryGid`, `path` (its `PATH`; plan 3c's), `state` (`present`, `renamed`, `deleted`, `absent`, `lookupFails`) | An account appears, is renamed, is deleted authoritatively, lapses from a listing, or its directory cannot answer |
| `session` | `id`, `osId`, `graphical`, `remote`, `seat0Active`, `state` (`active`, `locked`, `disconnected`, `closed`), `idleHint`, `startedAt` | A session opens, changes or closes, as the OS reports it (a remote graphical session stands in for Remote Desktop) |
| `helper` | `session`, `action` (`start`, `stop`, `report`, `forge`), `values`, `from` (`helper`, `sessionProcess`, `pluginServer`), `claims` (the session a `forge` reports for) | The helper the bridge started connects, goes, reports for its own session, or reports for the session `claims` names; or another process of the session, or a plugin server, connects (and, for `report`, reports) on a connection of its own |
| `admins` | `groups` (`[{ name, gid, members }]`, members as osIds), `sudo` (`[{ osId, root: yes/no/cannotTell }]`), `polkit` (`{ identities, unrecognised }`), `reported` | The OS's raw administrator facts change, and the OS reports the change or not |
| `file` | `path`, `exists`, `executable`, `writableBy` (osIds) | A file or directory as the write check and `PATH` resolution see it |
| `power` | `event` (`suspend`, `resume`, `shutdown`), `announced`, `suspendedMs` | The OS suspends or shuts down, announced or not; the time asleep |
| `lockBehaviour` | `session`, `result` (`locks`, `ignores`), `afterMs` | How a session's locker answers the next lock |
| `clock` | `steppable` | Whether the OS can step its clock at resume |
| `link` | `carrier`, `gatewayAnswers` | The wake relay's interface: carrier present, and whether the gateway answers `arping` |

The scripted OS plays the OS on an MQTT connection of its own, apart from the bridge's, so that it
stays up while the bridge is suspended and the harness can resume it. It also plays wave 0's
`transportState`: `down` is the OS's observer gone (logind off the bus), the host transport `down`
at once; `up` brings it back, observed at once. It answers every other wave 0 op (`join`, `report`,
`checkIn`, `silence`, `commandResult`, `link`) `unsupported`: no device joins a PC's host.

What the OS was asked, the bridge publishes on the transport's `received` topic in wave 0's shape
`{ device, action, args }`, `device` being the computer (or the relay's entry) and `action` one of:

| `action` | `args` |
|---|---|
| `os.lock` | `{ sessions }` |
| `os.sleep` | `{}` |
| `os.shutdown` | `{ delayS }` when a delay is given, `{}` otherwise |
| `os.cancel` | `{}` |
| `os.notify` | `{ session, text, urgency }`: the text as shown, the notification hook |
| `os.helper_start` | `{ session }`: the bridge started a helper there, so the harness may play its `helper start` |
| `os.helper_stop` | `{ session }`: the bridge stopped the helper it started there |
| `os.step_clock` | `{}`: asked at each resume, whether or not the clock could step (GA-BRIDGE-59) |
| `os.server_start` | `{ plugin, version, account, session, noNewPrivs, env, argv }` |
| `power.wake` (relay) | `{ interface, port, packet }`: the payload as hex |

An action's name fits wave 0's `action` pattern, `^[a-z_]+\.[a-z_]+$`, hence `os.step_clock` and
`os.server_start`.

Under the scripted OS a plugin server is a real process the bridge starts as the harness's own
user, without `setpriv`; its start is reported as above, and the test plugin also reports it
itself (*The test plugin*). `os.server_start`'s `account` is the account's osId; `displayEnv` gives
no variables for a session the scripted OS knows, so a `needsSession` server started there has no
display (plan 3d), and refuses one it does not.

### The test plugin

A plugin in `@ludentes/galatea-life-sim`, served as a package by the harness's HTTP server. It talks to the
harness directly over that HTTP server, never through the bridge, which is the subject being graded
and gives a plugin no broker credential (GA-BRIDGE-48): the harness bakes the server's URL and a
per-test nonce into each package it builds. At start the plugin posts how it was started (account,
uid, groups, `no_new_privs` from `/proc/self/status`, its logind session, environment,
arguments), which is how GA-BRIDGE-42, 48 and 49 are graded on the real OS; it then long-polls for
its behaviour: tools added, removed or changed after start (with or without `list_changed`); a file
changed on disk; `isError`; an elicitation; a crash, a hang, a start that never serves, or a server
that serves only after N tries; state values, including ones that fail their type; a subscription
offered or not. The same channel serves the scripted and the real OS. Its versions and manifests
are built by the harness for each test (a staged version, an interpreter by name, a bad `id`).

### The requirement tests

One module per requirement, as wave 0 registers them, for GA-BRIDGE-42 to 70 and the Serve
requirements the computer and the relay add. The harness plays the applier: it sends `install`,
`activate`, commands, and reads acks, `devices`, statuses and events. Tests of a subject's timers
step the clock; tests of a broker bound wait in real time.

### The real-OS run

The requirements the standard grades only on a real OS: GA-BRIDGE-48, 49, 64, 70, GA-BRIDGE-61's
binding of a helper, and GA-BRIDGE-53's enumeration, the `unknown` entry included.

- **Where:** a Debian 13 VM with GNOME, under KVM on the home server, built by a script in
  the conformance tree's real-OS folder (to come; cloud image, cloud-init, two accounts: `ga-admin` in `sudo`, with GDM's
  autologin giving it the graphical session on the console; `ga-user` not an administrator,
  reached over SSH, which gives it a logind session of its own that is not graphical). Never on the
  home server's own OS: the run edits sudoers, polkit and group membership. The VM is disposable,
  reverted to a snapshot before each run.
- **The subject contract, over SSH:** wave 0's harness owns a local subject's process; here the
  bridge is a systemd unit in the VM. A harness command of its own, `real-os`, added to wave 0's
  commands before it is used, installs the bridge's package over SSH and writes a unit drop-in
  carrying the environment `subject.json` would (`GALATEA_TEST_RUN_ID`, `GALATEA_TIME_SOURCE`,
  `GALATEA_BROKER` and its credential, `GALATEA_MUTATION` for a negative), with no
  `GALATEA_TEST_TRANSPORT`, so the Linux backend runs; the run-id guard applies as in any run.
  Restart is `systemctl restart`, a crash `systemctl kill -s KILL`. The harness runs on the
  developer's machine, its broker and HTTP server reachable from the VM. `real-os` grades only the
  requirements below, and its `pass` is the only one they can have.
- **How its report joins the others:** `real-os` writes a report of its own, in wave 0's shape. In
  `run`, GA-BRIDGE-48, 49, 64 and 70 read `untested` with the reason `real-os`; GA-BRIDGE-53 and 61
  are graded there on what the scripted OS can show (the reduction, the refusals) and carry a note
  that their other part is `real-os`'s. The verdict for a PC bridge takes the `run`, `negatives`
  and `real-os` reports together: an id graded only by `real-os` takes its grade from it; GA-BRIDGE-53
  and 61 `pass` only where both reports pass them; `--complete` accepts an `untested` whose reason
  is `real-os` when a `real-os` report is given. This rule goes into wave 0's report section
  before it is used, as the ops do.
- **What it does:** installs two test plugins through the bridge, one `needsSession` as `ga-admin`
  and one without a session as `ga-user`, and reads what each reports of its start. As `ga-user`
  over SSH it reads the install directory's, the credential's and the bus policy's permissions,
  tries to own the bus name, and, once `ga-admin`'s session has gone idle (the VM's idle delay set
  short), runs a helper of its own that reports that session `active`: its key must stay `idle`,
  and a `helper_refused` fault must name the report. As the
  harness's admin step, it grants `ga-user` one command, `/usr/bin/less`, as root through sudo
  (expect `ga-user`'s token, as GA-BRIDGE-53 and its row `trusts-a-one-command-grant` say); adds a
  polkit rule that decides by the time of day (expect `unknown`); and adds `ga-user` to `sudo`
  (expect its token, with the one-command grant removed first). The standard's *Conformance* says
  `unknown` for the one-command grant; that contradicts GA-BRIDGE-53, and this build follows the
  requirement (*Standards fixes this build may show*).
- **First:** check the home server's OS, KVM, free memory and disk, and that a VM beside its other services
  does not starve it (its detector's GPU or accelerator is not shared with the VM). Nothing is
  installed on the box before the maintainer agrees.

### Negative subjects

The standard lists 99 negative rows for GA-BRIDGE-42 to 70. Each becomes a mutation in the PC
bridge (or the relay, for GA-BRIDGE-55: `relay-up-without-arp`, `relay-entry-closed`), named as the
row names it, on only under a run id, written with the test of its requirement. `negatives` runs
them as wave 0 describes. A row that only Windows can show (`misses-a-debug-privilege`) is
`not_applicable` to a Linux build and has no mutation; the plan counts the rows that apply.
Rows written for Remote Desktop run through remote graphical sessions of the scripted OS.

## Order of work

Wave 0 is not built yet. Everything that does not need the harness goes first:

1. **Spikes, throwaway:**
   - the helper endpoint on the system bus with dbus-next: owning the name, the caller's uid and pid,
     logind's session for it;
   - starting a process in a session: the fd-3 launcher, its pid written into
     `session-N.scope`'s `cgroup.procs` and left there by systemd, then `GetSessionByPID` on it, its
     groups after `setpriv --init-groups`, and the display variables from the user manager;
   - the delay inhibitor through `systemd-inhibit`, released after an MQTT publish;
   - mpv's IPC under `--vo=null`;
   - the MCP SDK: done as research: v2 speaks
     both eras, subscriptions work in both, and an SDK-built server refuses input requests itself;
     left for plan 4, a raw `elicitation/create` or `input_required` from a server not built on the
     SDK, and the bridge's own transport starting a server once.

   Each gives an answer, or changes this design.
2. **The mpv plugin**, with its own tests.
3. **The wake relay**, with unit tests of the packet and the transport's state.
4. **The PC bridge's core and scripted backend**, with unit tests of the token rules, the session
   key, the administrators set and the plugin host's state machine.
5. **The Linux backend**, tried by hand in the VM.
6. **Once wave 0's core exists:** the scripted OS's ops and `received` actions in the wave 0 table,
   `real-os` in its commands and its report rule, the test plugin, the requirement tests and the negatives, then the
   real-OS run.

Too much for one plan. Five plans, each ending in something tested:
1. The spikes and the mpv plugin (steps 1 and 2).
2. The wake relay, with its own Serve binding (step 3).
3. The PC bridge's core and scripted backend, with its unit tests (step 4), in three plans (the
   maintainer, 2026-09-28): 3a, the binding, the computer's power and the scripted OS they need,
   graded by a harness `run` at Serve; 3b, the computer's accounts, sessions, administrators,
   helpers, `session.lock`, `notify` and `proposedInfrastructure`; and the plugin host in two
   (the maintainer, 2026-09-30): 3c, the packages (`install`, `uninstall` and `activate`, the
   manifest's check, the fetch and the unpack, the record, and the plugin devices, served by no
   server yet, so `available: false`); 3d, the servers (starting them, the MCP client, tool
   pinning, commands, state, and the swap to a staged version), and the servers' suspend-aware
   clock.
4. The Linux backend and the VM (step 5), in two plans (the controller's split, 2026-10-01):
   4a, what the backend reads and asks of the OS (identity, accounts, sessions, power, the clock,
   administrators, locking, files, the credential and `main`'s choice), built and tested without
   root on the development machine; 4b, the processes (the helper endpoint on the system bus, the
   helper, the launcher, `startHelper`, `notify`, `startServer`, `displayEnv`, the unit and bus
   policy files), then the VM run on the maintainer's go.
5. The PC harness: ops, the test plugin, the requirement tests, the negatives and the real-OS run
   (step 6), gated on wave 0.

## Error handling

- The bridge's state directory unreadable or corrupt at start: it refuses to start and says why;
  it never starts with an empty token store, which would give tokens again.
- The token store cannot be written (a full disk): no `devices` or computer status carrying a new
  or retired token goes out until a save succeeds, the save is tried again with a backoff of 1 s to
  60 s, and meanwhile a `faults` entry of the bridge's own code `state_unsaved` names it.
- The session observation fails (logind unreachable): no check-in, so the computer reads as the
  standard says for a silent device, and the failure is a `faults` entry.
- The administrators read fails in part: only `otherAdmins` is affected, with its `unknown` entry
  (*The OS port*); the check-in goes on. `sudo` not installed is no failure: it grants nothing.
- A plugin server's faults are the standard's (`pin_mismatch`, `crash_loop`, `account_deleted`).
- The helper crashes: its session reads `unknown` until the service starts it again, with backoff.
- A throw nobody expected while a command or request is handled (plan 4b's desktop run found one):
  the command is still acked once, `failed(no_confirmation)`, since something may have been
  transmitted, its `detail` the error's message cut at 1 KiB, and a plugin's stateful action still
  gets its read-back (GA-BRIDGE-34); the request is replied `failed(bridge_error)`; both are logged,
  never an exit. Both reasons ruled by the maintainer 2026-10-01: kept, with a named reason for the
  bridge's own failure at the standard's next revision. A known limit: an `install` or `uninstall` whose work had started (a fetch, a
  removal) before the throw is replied `failed`, yet its `installed`, `install_failed` or
  `uninstalled` may still follow.
- `@ludentes/galatea-life-schemas` carries every schema it loads, the bridge-type manifest's as a copy of
  [`conformance/galatea-bridge.schema.json`](https://github.com/Ludentes/galatea-life-standard/blob/main/conformance/galatea-bridge.schema.json), so a `pnpm deploy` bundle validates; a failed load is
  tried again at the next call.

## Testing

- Unit tests (vitest) for each package's logic.
- The harness's `run` and `negatives` through the scripted OS: the grade of the logic.
- The real-OS run in the VM: the grade of the privileges.
- A manual check on a real laptop, written as a step-by-step guide in `docs/` at the end: install,
  a session locked and unlocked, a `notify`, a sleep with the lid, a wake through the relay, the mpv
  plugin installed and a film launched.

## The bench

Measured when the bridge runs on real machines, recorded, not claimed: Wake-on-LAN through a
suspend and from off on each of the maintainer's PCs; whether a Modern Standby laptop announces its
sleep; the delay inhibitor holding long enough for the ack on each OS; how long a screen locker
takes (the 5 s guess); the 10 s clock step at resume. Windows' `LogonTime` waits for the Windows
design.

## Standards fixes this build may show

None made now (spec review has stopped). Candidates, to be confirmed by the build:
- The bridge's *Conformance* expects `unknown` for a one-command sudo grant; GA-BRIDGE-53 and its
  row `trusts-a-one-command-grant` expect the account's token. This build follows the requirement.
- The roadmap's "GA-BRIDGE-42 to 73" for the PC (71 to 73 are the IR transmitter's).
- How a Linux bridge reports a key the desktop does not give (`app` on Wayland), which the standard
  does not say.
- A directory account's deletion, which Linux's NSS cannot tell apart from an unreachable
  directory. Plan 4a never reports one where a directory is configured.
- How a bridge tells a configured directory from a named one: Ubuntu's desktop names `sss` in
  `nsswitch.conf` with sssd installed and not set up. Plan 4a counts a directory module only when
  configured (sss by `sssd.conf` or a file in `conf.d`, ldap by `nslcd.conf`, `libnss-ldap.conf`
  or an `ldap.conf` in `/etc`, `/etc/ldap` or `/etc/openldap`, winbind by `smb.conf`, nis by `yp.conf` or `defaultdomain`, any other module
  always), one rule for deletions (GA-BRIDGE-52) and administrators (GA-BRIDGE-53); the standard
  says neither.
- A polkit identity that names no account or group on the machine (stock Ubuntu's
  `unix-group:admin`): the standard's "every identity polkit's administrator rules name" does not
  say whether it is `unknown`. Plan 4a drops it where no directory is configured.
- A group member in `/etc/group` that names no account: plan 4a leaves it out, with a note.
- Linux's `disconnected`: the standard names no Linux state for it; plan 4a reads a graphical
  session on a seat another session holds as `disconnected`.
- sudo's "every account": the standard reads as every account, service accounts included, and the
  design said interactive; plan 4a asks for every account but root, eight at a time.
- Sizes: no bound on a string reading, an ack's `detail`, a `notify` text, a state object, a
  manifest or the `devices` document; this build's caps (*Plugins on Linux*) are a proposal.
  Long descriptions and titles also reach an LLM, so their bound is a safety matter as well as a
  size one.
- From MCP 2026-07-28 a tool asks for input by an `input_required` result, not a request; GA-BRIDGE-47
  covers it in meaning, but names only elicitation and sampling.
- Two graphical sessions of one account on Linux, where the display of the chosen session cannot be
  told from the user manager's.
- `args` constraints have no JSON form in the standard (it writes `season: 1–99`, `any`,
  `[episode, movie]`); the mpv plugin writes `"any"`, `{ "min": 0, "max": 100 }`, an array of
  strings, and an object for an object's fields.
  Nor has an optional argument one: the PC bridge
  writes `power.shutdown`'s `delay_s?` as `{ "min": 0, "optional": true }`.
- A tool hash's text is not given ("a SHA-256"); the mpv plugin writes lowercase hex.
- `confirmedBy` on a stateful action: bridge.md *The manifest* says each stateful action has
  `confirmedBy`, while its table limits `confirmedBy` to extension actions. The mpv manifest's
  standard-capability `media.*` actions declare `confirms: true` and no `confirmedBy`. Plan 3's
  validator must accept that until the standard settles it.
- A reply to an unknown op: the text answers it `invalid_request`, but `bridge/reply.json`'s `op`
  is an enum of the known ops, so the reply cannot validate. The wake relay echoes the op anyway.
- A LAN has no transport `kind`: the protocol enum has neither `lan` nor `ip`; the wake relay
  writes `other`.
- A wake relay's entry has no display name: the `devices` document carries none, so the owner's
  device id is the entry's only name.
- `notify`'s action string: the applier's table writes `notify(...)` under the capability
  `notify`, and wave 0's `action` pattern needs `capability.action`, so the computer declares
  `notify.notify`. The standard never spells it.
- `other_admins_changed` names no device in the standard (`{ seq, instanceId, type, ... }`); the PC
  bridge adds `device`, and from plan 3c sends one event for each device whose set changed, the
  computer's and each plugin device's.
- A failed read of the administrators has no fault code; the PC bridge names it `admins_unread` on
  the computer, beside the `unknown` entry GA-BRIDGE-53 asks for.
- A state file that cannot be written has no fault code either; the PC bridge names it
  `state_unsaved` while its token table is not on disk, and holds back the `devices` and status that
  would carry a token not yet kept (GA-BRIDGE-31, GA-BRIDGE-52).
- A `notify` handed to a helper that never answers (its 2 s run out, or the bridge left first):
  GA-BRIDGE-62 names only `applied` and `failed(not_shown)`, but the text may be on the screen, so
  the PC bridge acks `failed(no_confirmation)` (*Commands*: once transmitted, a command that cannot
  finish is `no_confirmation`), keeping `not_shown` for a notification nothing could show.
  `notify` is not idempotent, and a `not_shown` would invite a second copy.
- A late `no_graphical_session`: GA-BRIDGE-66 wants it within 1 s of the receipt, read from the
  sessions at hand; when the account's graphical sessions close while the bridge waits for their
  lock, and only an SSH login is left, the PC bridge acks it then, up to 5 s after the receipt,
  rather than `applied` or `not_locked`. The same holds for a lock on an account the last
  observation showed no session, whose fresh observation finds only an SSH login.
- A lock on an account with no session in the last observation, with no fresh observation within
  5 s (the observer gone, or the OS not answering): nothing was asked of the OS, so the PC bridge
  acks `failed(unreachable)`; GA-BRIDGE-66 does not name this case.
- The first start on a disk that cannot be written publishes `status` with no `devices` before it:
  the token table is not on disk, so `devices` is held back, and the roster names a computer no
  `devices` lists yet. GA-BRIDGE-38 bends in that degraded state, which the `state_unsaved` fault
  names.
- A bound for the port's contract, for plan 4: `startHelper` settles within a limit, since a
  launcher that never settles holds that session's helper back for good.
- `install_failed`'s reasons (GA-BRIDGE-68) name no fetch that fails (an unreachable host, a
  non-2xx status, `http:` outside a run, too many redirects), no archive that is not a well-formed
  package, no local write that fails, and no state file that cannot be written. Plan 3c ends them
  `fetch_failed`, `invalid_package`, `io_error` and `state_unsaved`, and answers an `activate` or a
  request it could not keep on disk `failed(state_unsaved)`. A plugins directory the bridge cannot
  make has no code either: plan 3c names the fault `plugins_unready`, answers `install` and
  `uninstall` `failed(plugins_unready)` while it stands, and ends an install a restart cut short
  `install_failed(restart)` with `plugins_unready` in its detail.
- No bound on a package's size; plan 3c's (100 MiB fetched, 512 MiB and 20,000 entries unpacked,
  5 redirects) are a proposal.
- After a restart GA-BRIDGE-68 ends a request cut short `installed` or `install_failed(restart)`,
  "at once if [its 600 s] passed": so `restart`, not `timeout`, for one whose 600 s passed while the
  bridge was down, and `restart` too for a resumed install that fails for another reason (plan 3c
  carries that reason in `detail`). Worth saying in the text.
- An `uninstall` for another host: GA-BRIDGE-68 answers an `install` for another host
  `invalid_request` and says nothing of `uninstall`; plan 3c answers it the same.
- `bridge/devices.json`'s `action` pattern, `^[a-z_]+\.[a-z_]+$`, refuses every extension action
  (`org.example.steam.launch`), so no plugin device with one validates; plan 3c widens the schema
  with `extensionAction`. The text shows the form by example only: plan 3c takes an extension
  action to be its capability's name, then `.`, then the action (`^[a-z_]+$`), and its keys the
  same. The maintainer kept the widening (2026-10-01); the form goes into the standard at its next
  review.
- `bridge/device-status.json` requires a `timestamp`, and a plugin device whose server has never
  run has no observation; plan 3c stamps its `available: false` with the install's time. Its roster
  entry is `poll` at the manifest's `cadenceMs`, bound three times it, `lastCheckIn: null`,
  `observable: false`; the standard says neither.
- A command's first element: the text allows an interpreter by name; plan 3c also takes a path
  with a `/` as a file of the package, which must be marked executable, and refuses any later
  element that names a script (`.js`, `.py` and the like) outside the package. It refuses an
  interpreter whose directory, or any directory above it, the account can write, stricter than the
  text's "each directory on its path", since a writable parent lets the account rename the
  directory away.
- The charset of an `id`, a `key` and a `version`, `[A-Za-z0-9._-]`, lets `.` and `..` through,
  though each becomes a directory's name or part of one; plan 3c refuses those two as
  `invalid_manifest` and takes any other value, a leading dot included.
- An extension action's string (`org.example.library.scan`) is refused by `bridge/command.json`'s
  action pattern too; plan 3c's fix wave widened that schema as it did `bridge/devices.json`.
  `applier/device.json`, `steward/request.json` and `harness/test-received.json` still refuse it,
  to settle with the standard's reading of an extension capability (the text calls
  `org.example.steam.launch` an extension capability, plan 3c reads it as capability
  `org.example.steam` and action `launch`).
- GA-BRIDGE-68's "exactly one terminal event": the PC bridge saves each end before its event and
  forgets it only once the broker took the event, so a crash between the broker's PUBACK and that
  forgetting sends the same end again after the restart, with a new `instanceId` and `seq`. MQTT
  gives no better without the applier dropping a second event for a `requestId` it has seen ended;
  the text should say at least once, and that the applier drops a repeat.
- A plugin with several devices has served (GA-BRIDGE-58) at the first state read that succeeds,
  of any of its devices; the standard's "each device available within 1 s of its server having
  served" then shows a device whose own first read has not yet come back as `available: true` with
  no readings. Plan 3d does so, the device's own read following within 10 s (GA-BRIDGE-60). The text
  could say whether "served" is per server or per device. Plan 3d keeps availability per server but
  the roster per device: a device's `lastCheckIn` is its own last successful read, `null` before
  its first, since the standard makes each read the device's check-in (GA-BRIDGE-37), and its
  server's having served is no read of it.
- A server that serves, then crashes, over and over: its backoff resets once it has served, and
  failures after serving do not count toward `crash_loop` (GA-BRIDGE-58), so it is started again
  every second or so for good, with no notice to the owner. The text could set a floor, for
  example counting a failure soon after serving, or a notice for a server that fails after serving
  N times within an hour.
- A reading that fails its declared type, or is over the size cap, has no fault code; plan 3d
  names it `reading_dropped` on the device, the other readings published.
- `crash_loop`'s count: the text counts starts that fail "each one exiting, stopping answering or
  not serving within its start bound". Plan 3d also counts a start that could not be made (the
  interpreter gone, the account missing from the listing), and does not count the end of a
  `needsSession` server's session, after which it waits for the next session with no backoff.
- A tool call has no answer bound of its own in the standard; the 10 s answer (GA-BRIDGE-58) names
  a state read and a probe. Plan 3d bounds a call by the command's own `resultWithinMs` and acks one
  that outlasts it `failed(no_confirmation)`, the server not counted as failed, since a long tool
  (a launch that loads a film) is not a hung server.
- A success's `detail`: the text gives `isError`'s text to the ack and says nothing of a success's.
  A tool's text on success is often the device's state (the mpv plugin's is), personal keys and
  all, and an ack goes to whoever may read acks, so plan 3d acks a success with no `detail`; the
  state goes out in the status, where the manifest declared it.
- The read-back (GA-BRIDGE-34) of a plugin device must be out by `issuedAt + resultWithinMs - 1 s`,
  and a read takes time; plan 3d starts it 1 s before that (a guess). A read-back is published even
  when nothing changed, since the applier waits for it.
- A request from the server during a tool call (an elicitation or sampling request of the 2025
  era): GA-BRIDGE-47 refuses it; plan 3d also ends the tool call `failed(no_confirmation)` whatever
  the tool then answers, since a tool that asked for input did not do what it was asked.
- The console session on Linux: GA-BRIDGE-42's "console session" is read as the account's session
  that is active on `seat0`, as `session.lock` reads it (GA-BRIDGE-66). Two graphical sessions on
  other seats fall to "the one the OS started first".
- A swap whose save fails: GA-BRIDGE-69 wants the old version removed once the new server has
  served; plan 3d keeps both, the old one's devices removed only once the record without it is on
  disk, and tries the swap again at each check (every second). The text does not say what a swap
  that cannot be kept does meanwhile.
- A cadence read that changed nothing: the text makes each read a check-in (GA-BRIDGE-37) and says
  nothing of republishing the status; plan 3d does not republish it (the roster's `lastCheckIn`
  carries the check-in), and always republishes a command's read, which the applier waits for.
- Activating a later version while no version is active: the standard's staged swap starts from a
  running server. The maintainer ruled (2026-09-30, M6) that it is a switch-over all the same: the
  later version's server starts, and once it has served the earlier version is removed, its
  devices leaving as GA-BRIDGE-21 says and no `uninstalled` sent. The text could say so, and say
  how the applier withdraws such a switch-over: with no old server running there is no "running
  version" whose `activate` cancels the pending one, so today only an uninstall withdraws it.
- A manifest's `command` is checked by a rule of thumb (an element with a `/` or a script's
  extension must be a file of the package), so `["python3", "-m", "http.server"]` and
  `["python3", "-c", "…"]` pass although they name no file of the package; and `hosts` entries are
  not checked as host names. Neither reaches past the plugin's own account, but the text says
  "every other file it names is inside the package", which no bridge can check in general.
- `notify`'s three urgencies on Linux: the notification specification has `low`, `normal` and
  `critical`, so plan 4b shows `info` and `warning` alike, as `normal`; the standard does not say
  how a bridge maps them where the desktop has fewer levels.
- `microphone_in_use`: the standard does not say whether a capture of what the speakers play
  (screen recording) or a level meter is the microphone in use. Plan 4b counts neither.
- `app` with no window focused (a locked screen, an empty desktop): the standard does not say
  whether it is null or the key goes unreported. Plan 4b reports null.
- The helper's identity after the service restarts: GA-BRIDGE-61 binds the helper "the service
  started", which a restarted service did not; plan 4b's helper ends when the endpoint's owner
  changes, and the new service starts its own. The standard does not say what a helper does when
  its service goes.
- The helper and a plugin's server of the same account (GA-BRIDGE-61, GA-BRIDGE-64): plan 4b's
  re-review fix binds the helper by a start token handed on an inherited descriptor, but a process
  of the session's account that can trace the helper or open its descriptors through `/proc`
  (`kernel.yama.ptrace_scope` 0) can act as it, and a plugin's server is such a process. The
  standard does not say whether a plugin server must be kept from its session's helper; keeping it
  so needs a separate account or sandbox for servers, beyond this build. For the maintainer.

## Decisions this design makes, for the maintainer to overrule

- One core over an OS port; the scripted OS is a backend of the bridge.
- The helper endpoint is a system D-Bus name, not a Unix socket.
- Plugin servers and helpers start through a root launcher moved into the session's scope, then
  `setpriv`, not `systemd-run`.
- The administrators' reduction lives in the core, above the port; the port gives raw facts.
- A one-command sudo grant lists the account (GA-BRIDGE-53), against the *Conformance* prose.
- Stock polkit rules are recognised by dpkg's record and a table of names; anything else is
  `unknown`.
- The real-OS run is a harness command of its own, driving a systemd unit over SSH, with its
  report joined to `run`'s by a rule added to wave 0.
- A key the desktop does not give is not declared, rather than reported null.
- The real-OS run is a VM on the home server, never the box itself.
