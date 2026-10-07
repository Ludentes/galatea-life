import dbus from "dbus-next";
import type { HelperValues, Urgency } from "../port.js";
import type { Bus, BusCall, BusSignal } from "../linux/bus.js";
import { ENDPOINT_IFACE, ENDPOINT_NAME, ENDPOINT_PATH, HELPER_IFACE, HELPER_PATH, REFUSED } from "../linux/endpoint.js";
import type { Runner } from "../linux/run.js";
import { activeApp, idleHint, idleMs, notifyArgs, pipeWire } from "./reads.js";

/** How often the helper reads its session. */
export const READ_MS = 2_000;
/** A report goes out when a value changed, and at least this often. */
export const REPORT_EVERY_MS = 60_000;

const DBUS = "org.freedesktop.DBus";

export interface SessionHelperOptions {
  /** The system bus, where the service's endpoint is. */
  system: Bus;
  /** The session's bus, where the desktop's idle monitor and notification service are; none when it could not be reached. */
  session?: Bus;
  run: Runner;
  sessionId: string;
  /** The idle threshold, the bridge's setting (300 s by default). */
  idleAfterS: number;
  /** The keys the service declared: `app`, `camera_in_use`, `microphone_in_use`; nothing else is read. */
  keys: string[];
  /** The start token the service handed this helper (`readToken`), presented in `Hello(s)` (review N1). */
  token: string;
  /** The session's display variables, as the service gave them. */
  env: Record<string, string | undefined>;
  log(line: string): void;
  /** The helper is done (the service gone or refusing it, a bus lost): its process exits with this code. */
  exit(code: number): void;
  readMs?: number;
  reportEveryMs?: number;
  now?: () => number;
}

/**
 * The session helper (*Processes*, *Starting a process in a session*): it holds no credential and
 * starts nothing. It says `Hello` to the service's endpoint with its start token, then reports its session's activity and
 * the declared personal keys (`Report`) when they change and at least every minute, and shows a
 * `notify` the service asks of it (`Notify` on its own object, from the endpoint's owner only)
 * through the session's `org.freedesktop.Notifications`. It ends when the service refuses it, when
 * the endpoint's owner leaves or changes (a restarted service starts helpers of its own), or when
 * either bus is lost. A read that fails is no report of that key, never a crash.
 */
export class SessionHelper {
  private owner: string | null = null;
  private last = "";
  private lastAt = 0;
  private timer?: NodeJS.Timeout;
  private done = false;

  constructor(private readonly o: SessionHelperOptions) {}

  /** Learns the endpoint's owner, takes `Notify` calls, says `Hello`, and starts reading; ends the helper if any of it fails. */
  async start(): Promise<void> {
    const { system } = this.o;
    system.onClose((err) => this.end(1, `system bus lost: ${err.message}`));
    this.o.session?.onClose((err) => this.end(1, `session bus lost: ${err.message}`));
    system.onSignal((s) => this.onSignal(s));
    system.onCall(HELPER_PATH, (c) => void this.onNotify(c));
    try {
      await system.addMatch(`type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${ENDPOINT_NAME}'`);
      const [owner] = await system.call(DBUS, "/org/freedesktop/DBus", DBUS, "GetNameOwner", "s", [ENDPOINT_NAME]);
      this.owner = String(owner);
      await system.call(ENDPOINT_NAME, ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [this.o.token]);
    } catch (err) {
      return this.end(1, `the service's endpoint: ${(err as Error).message}`);
    }
    await this.tick();
  }

  /** The endpoint's owner leaving or changing, from the bus daemon only, ends the helper. */
  private onSignal(s: BusSignal): void {
    if (s.sender !== DBUS || s.member !== "NameOwnerChanged" || s.body[0] !== ENDPOINT_NAME) return;
    if (s.body[2] !== this.owner) this.end(0, "the service left the bus");
  }

  /** `Notify(s text, s urgency)` from the endpoint's owner: shown, then answered; from anyone else, refused. */
  private async onNotify(c: BusCall): Promise<void> {
    if (c.sender !== this.owner) return c.fail("org.freedesktop.DBus.Error.AccessDenied", "only the service asks a helper to show anything");
    if (c.interface !== HELPER_IFACE || c.member !== "Notify" || c.signature !== "ss") {
      return c.fail("org.freedesktop.DBus.Error.UnknownMethod", "Notify(ss) is the helper's one method");
    }
    const [text, urgency] = c.body as [string, string];
    if (!["info", "warning", "critical"].includes(urgency)) return c.fail("org.freedesktop.DBus.Error.InvalidArgs", `no urgency ${urgency}`);
    if (!this.o.session) return c.fail("org.freedesktop.DBus.Error.Failed", "no session bus to show it on");
    try {
      await this.o.session.call("org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications", "Notify",
        "susssasa{sv}i", notifyArgs(text, urgency as Urgency, (signature, value) => new dbus.Variant(signature, value)));
      c.reply();
    } catch (err) {
      c.fail("org.freedesktop.DBus.Error.Failed", `the session's notification service: ${(err as Error).message}`);
    }
  }

  /** What the helper reads now: the activity, and each declared key it could read. */
  async read(): Promise<HelperValues> {
    const values: HelperValues = {};
    const idle = await idleMs(this.o.session);
    if (idle !== undefined) values.activity = idle >= this.o.idleAfterS * 1000 ? "idle" : "active";
    else {
      const hint = await idleHint(this.o.system, this.o.sessionId);
      if (hint !== undefined) values.activity = hint ? "idle" : "active";
    }
    if (this.o.keys.includes("camera_in_use") || this.o.keys.includes("microphone_in_use")) {
      const pw = await pipeWire(this.o.run, this.o.env.XDG_RUNTIME_DIR);
      if (pw && this.o.keys.includes("camera_in_use")) values.camera_in_use = pw.camera_in_use;
      if (pw && this.o.keys.includes("microphone_in_use")) values.microphone_in_use = pw.microphone_in_use;
    }
    if (this.o.keys.includes("app")) {
      const app = await activeApp(this.o.run, { ...(this.o.env.DISPLAY ? { DISPLAY: this.o.env.DISPLAY } : {}),
        ...(this.o.env.XAUTHORITY ? { XAUTHORITY: this.o.env.XAUTHORITY } : {}) });
      if (app !== undefined) values.app = app;
    }
    return values;
  }

  /** One read, reported when it changed or the last report is a minute old; then the next, in READ_MS. */
  private async tick(): Promise<void> {
    if (this.done) return;
    try {
      const values = await this.read();
      const text = JSON.stringify(values);
      const now = (this.o.now ?? Date.now)();
      if (text !== this.last || now - this.lastAt >= (this.o.reportEveryMs ?? REPORT_EVERY_MS)) {
        await this.report(values);
        this.last = text;
        this.lastAt = now;
      }
    } catch (err) {
      if ((err as { type?: string }).type === REFUSED) return this.end(1, "the service refused this helper");
      this.o.log(`report: ${(err as Error).message}`);
    }
    if (this.done) return;
    this.timer = setTimeout(() => void this.tick(), this.o.readMs ?? READ_MS);
  }

  private async report(values: HelperValues): Promise<void> {
    const v = (signature: string, value: unknown) => new dbus.Variant(signature, value);
    const body: Record<string, unknown> = {};
    if (values.activity) body.activity = v("s", values.activity);
    if (values.app !== undefined) body.app = v("s", values.app ?? "");
    if (values.camera_in_use !== undefined) body.camera_in_use = v("b", values.camera_in_use);
    if (values.microphone_in_use !== undefined) body.microphone_in_use = v("b", values.microphone_in_use);
    await this.o.system.call(ENDPOINT_NAME, ENDPOINT_PATH, ENDPOINT_IFACE, "Report", "sa{sv}", [this.o.sessionId, body]);
  }

  /** Ends the helper once: its reads stop, both buses close, and it exits. */
  end(code: number, why: string): void {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.o.log(why);
    this.o.system.close();
    this.o.session?.close();
    this.o.exit(code);
  }
}
