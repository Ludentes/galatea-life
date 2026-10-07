import type { Urgency } from "../port.js";
import { unwrap, type Bus } from "../linux/bus.js";
import type { Runner } from "../linux/run.js";

/**
 * What the session helper reads in its session (*Starting a process in a session*), each read on its
 * own: one that fails is no reading (undefined), never a throw, so a report carries what could be
 * read and leaves out the rest.
 */

/** A PipeWire graph larger than this is not read: 16 MiB. */
export const PW_DUMP_MAX = 16 * 1024 * 1024;

const truthy = (v: unknown) => v === true || v === "true";

/**
 * The camera and the microphone from PipeWire's graph (`pw-dump`'s JSON: an array of objects, a
 * node's `info.state` and `info.props`): `camera_in_use` when a camera's node (`media.class`
 * `Video/Source`) is `running`, which PipeWire makes it while any stream reads it;
 * `microphone_in_use` when an application's recording stream (`Stream/Input/Audio`) is `running`,
 * leaving out a capture of what the speakers play (`stream.capture.sink`) and a level meter
 * (`stream.monitor`, pavucontrol's and the like). `idle` and `suspended` are not in use. Undefined
 * for output that is not such a graph.
 */
export function readPipeWire(text: string): { camera_in_use: boolean; microphone_in_use: boolean } | undefined {
  let graph: unknown;
  try {
    graph = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(graph)) return undefined;
  let camera = false;
  let microphone = false;
  for (const o of graph as { type?: unknown; info?: { state?: unknown; props?: Record<string, unknown> } }[]) {
    if (o?.type !== "PipeWire:Interface:Node" || o.info?.state !== "running") continue;
    const p = o.info.props ?? {};
    if (p["media.class"] === "Video/Source") camera = true;
    if (p["media.class"] === "Stream/Input/Audio" && !truthy(p["stream.capture.sink"]) && !truthy(p["stream.monitor"])) microphone = true;
  }
  return { camera_in_use: camera, microphone_in_use: microphone };
}

/** `pw-dump` in the session (its socket found through `XDG_RUNTIME_DIR`), read as `readPipeWire` reads it. */
export async function pipeWire(run: Runner, runtimeDir: string | undefined): Promise<ReturnType<typeof readPipeWire>> {
  if (!runtimeDir) return undefined;
  try {
    const r = await run("pw-dump", [], { env: { XDG_RUNTIME_DIR: runtimeDir }, maxBytes: PW_DUMP_MAX });
    return r.code === 0 ? readPipeWire(r.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The focused application on X11 (`_NET_ACTIVE_WINDOW` on the root window, then that window's
 * `WM_CLASS`, its class: `xprop`'s `WM_CLASS = "instance", "Class"`): the class, or null with no
 * window focused (`window id # 0x0`). Undefined when it cannot be read (no `xprop`, no display, a
 * window gone between the two reads).
 */
export async function activeApp(run: Runner, display: { DISPLAY?: string; XAUTHORITY?: string }): Promise<string | null | undefined> {
  if (!display.DISPLAY) return undefined;
  const env = { DISPLAY: display.DISPLAY, ...(display.XAUTHORITY ? { XAUTHORITY: display.XAUTHORITY } : {}) };
  try {
    const root = await run("xprop", ["-root", "-notype", "_NET_ACTIVE_WINDOW"], { env });
    const id = /window id # (0x[0-9a-fA-F]+)/.exec(root.stdout)?.[1];
    if (root.code !== 0 || !id) return undefined;
    if (Number(id) === 0) return null;
    const w = await run("xprop", ["-id", id, "-notype", "WM_CLASS"], { env });
    const strings = [...w.stdout.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    if (w.code !== 0 || !/^WM_CLASS = /m.test(w.stdout) || strings.length === 0) return undefined;
    return strings.at(-1)!;
  } catch {
    return undefined;
  }
}

/**
 * How long the session has had no input, in ms: GNOME's `org.gnome.Mutter.IdleMonitor`
 * (`GetIdletime`, ms). Undefined when it does not answer, and the helper falls back to logind's
 * `IdleHint`. The freedesktop `org.freedesktop.ScreenSaver.GetSessionIdleTime` is not asked: its
 * unit differs between desktops (ms in KDE's, seconds in the old draft's), and a wrong unit reads a
 * session `active` for good, worse than no reading (review M3).
 */
export async function idleMs(session: Bus | undefined): Promise<number | undefined> {
  if (!session) return undefined;
  try {
    const [t] = await session.call("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime");
    const ms = Number(t);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  } catch {
    // Not GNOME: logind's IdleHint instead.
  }
  return undefined;
}

/** logind's `IdleHint` for the helper's own session, read-only, the fallback where the desktop gives no idle time. */
export async function idleHint(system: Bus, sessionId: string): Promise<boolean | undefined> {
  try {
    const [path] = await system.call("org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "GetSession", "s", [sessionId]);
    const [v] = await system.call("org.freedesktop.login1", String(path), "org.freedesktop.DBus.Properties", "Get", "ss", ["org.freedesktop.login1.Session", "IdleHint"]);
    const hint = unwrap(v);
    return typeof hint === "boolean" ? hint : undefined;
  } catch {
    return undefined;
  }
}

/** The urgency hint of the notification specification: 0 low, 1 normal, 2 critical. `info` is normal, so the desktop shows it. */
export const URGENCY: Record<Urgency, number> = { info: 1, warning: 1, critical: 2 };

/** Text for a body that the notification service may read as markup (`body-markup`): `&`, `<` and `>` escaped. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The arguments of `org.freedesktop.Notifications.Notify` (`susssasa{sv}i`) for a `notify`'s text as
 * the core wrote it, the source first: its first line ("От: …", an unknown sender marked) the
 * summary, the rest the body, escaped; the urgency as a hint; the server's own expiry (-1).
 */
export function notifyArgs(text: string, urgency: Urgency, variant: (signature: string, value: unknown) => unknown): unknown[] {
  const cut = text.indexOf("\n");
  const summary = cut < 0 ? text : text.slice(0, cut);
  const body = cut < 0 ? "" : text.slice(cut + 1);
  return ["Galatea", 0, "", summary, escapeMarkup(body), [], { urgency: variant("y", URGENCY[urgency]) }, -1];
}
