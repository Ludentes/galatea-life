import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The entry point's parts a service manager meets (plans 2 and 4): the broker and the coordinator
 * named by the environment, the private data directory, and a stop that comes before the bridge
 * announced itself. In a module of their own so that they are tested without a process.
 */

/** How long a stop before the announcement waits for the clean disconnect before it cuts the connection. */
export const UNANNOUNCED_END_MS = 2_000;

/**
 * The subject contract's GALATEA_BROKER: its user name is the bridge's identity. A text that is no
 * URL, or that names no identity, is refused with a reason that never repeats the text, which may
 * carry a password.
 */
export function brokerFromEnv(text: string): { url: string; username: string } | { refused: string } {
  let u: URL;
  let username: string;
  try {
    u = new URL(text);
    username = decodeURIComponent(u.username);
  } catch {
    return { refused: "GALATEA_BROKER is no URL" };
  }
  if (!username) return { refused: "GALATEA_BROKER names no identity" };
  return { url: `${u.protocol}//${u.host}`, username };
}

/**
 * A stop before the bridge announced itself: its connection carries the will, which would announce,
 * retained, a bridge that never was. A clean disconnect makes the broker discard it. The end is
 * bounded, since it waits for every unacknowledged publish, and the connection is cut after it.
 */
export async function endUnannounced(wire: { end(): Promise<void>; drop(): Promise<void> }, ms = UNANNOUNCED_END_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), ms); });
  const outcome = await Promise.race([wire.end().then(() => "ended" as const, () => "failed" as const), late]);
  clearTimeout(timer);
  if (outcome !== "ended") await wire.drop().catch(() => {});
}

/**
 * GALATEA_ZIGBEE_COORDINATOR: the coordinator herdsman reaches, `tcp://host:port` (the design, *What
 * it is*: a coordinator on the LAN). Anything else is refused, the text never repeated.
 */
export function coordinatorFromEnv(text: string | undefined): { coordinator: string } | { refused: string } {
  if (!text) return { refused: "GALATEA_ZIGBEE_COORDINATOR names no coordinator (tcp://host:port)" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { refused: "GALATEA_ZIGBEE_COORDINATOR is no URL" };
  }
  const port = Number(u.port);
  if (u.protocol !== "tcp:" || !u.hostname || !Number.isInteger(port) || port < 1 || port > 65535 || u.username || u.password
    || (u.pathname !== "" && u.pathname !== "/") || u.search || u.hash) {
    return { refused: "GALATEA_ZIGBEE_COORDINATOR is not tcp://host:port" };
  }
  return { coordinator: `tcp://${u.hostname}:${port}` };
}

/**
 * The data directory holds the network key (`network.json`) and herdsman's backup of the
 * coordinator, which carries it in clear: no other account may read it, nor list it. Undefined when
 * it is the bridge's alone.
 */
export function privateDirProblem(dir: string): string | undefined {
  const mode = statSync(dir).mode;
  if (mode & 0o077) {
    return `${dir} can be read by other accounts (mode ${(mode & 0o777).toString(8)}): it holds the network key and the coordinator's backup`;
  }
  return undefined;
}

/** The owner's PINs for locks' remote operation, in the bridge's private data directory (GA-BRIDGE-36). */
export const PINS_FILE = "pins.json";

/** A device id as the core gives a Zigbee device: its IEEE address, and `-n` for a later admission of the hardware. */
const DEVICE_ID = /^0x[0-9a-f]{16}(-[1-9][0-9]*)?$/;

/** A PIN as a Zigbee Door Lock takes it: 1 to 32 printable ASCII characters, sent as its octets. */
const PIN = /^[\x21-\x7e]{1,32}$/;

/**
 * The owner's PINs, by the device id `devices` gives each lock (GA-BRIDGE-36): the bridge's own
 * configuration, `pins.json` in its private data directory, an object of device ids to PINs, set by
 * the owner outside the binding. No file is no PIN. A file other accounts can read, or that is not
 * such an object, or that names a lock by anything but a device id, is refused, never quoting a PIN
 * or a key that is no device id; a device id may be named. The core keys each PIN
 * by its device id, so a new admission of the lock's hardware, which gets a new id, is never handed
 * it (GA-BRIDGE-35).
 */
export function readPins(dir: string): { pins: Map<string, string> } | { refused: string } {
  const path = join(dir, PINS_FILE);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pins: new Map() };
    return { refused: `${PINS_FILE} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (mode & 0o077) return { refused: `${PINS_FILE} can be read by other accounts: it holds the locks' PINs` };
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // The parser's message may quote the text, a PIN among it: only its kind is said.
    const code = (err as NodeJS.ErrnoException).code;
    return { refused: code ? `${PINS_FILE} cannot be read (${code})` : `${PINS_FILE} is no JSON` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { refused: `${PINS_FILE} is no object of device ids to PINs` };
  const pins = new Map<string, string>();
  for (const [id, pin] of Object.entries(v)) {
    // A key in no device id's form may be a PIN put in the wrong place: refused, never quoted (plan 2c-2 review M5).
    if (!DEVICE_ID.test(id)) {
      return { refused: `${PINS_FILE} names a lock by something that is no device id (0x and 16 lower-case hex digits, then -n for a later admission)` };
    }
    if (typeof pin !== "string" || !PIN.test(pin)) return { refused: `${PINS_FILE}: the PIN for ${id} is not 1 to 32 printable ASCII characters` };
    pins.set(id, pin);
  }
  return { pins };
}

/**
 * The owner's switch that withholds every action (`GALATEA_ZIGBEE_NO_ACTIONS`), for read-only work
 * on a real network: 1 withholds them, unset or 0 does not, and anything else is refused rather than
 * guessed (plan 2c-2 review M6).
 */
export function noActionsFromEnv(value: string | undefined): { noActions: boolean } | { refused: string } {
  if (value === undefined || value === "" || value === "0") return { noActions: false };
  if (value === "1") return { noActions: true };
  return { refused: "GALATEA_ZIGBEE_NO_ACTIONS is 1 (withhold every action) or 0" };
}

/**
 * A password the install keeps in a file (plan 4a): `GALATEA_CREDENTIAL_FILE` for the broker, as the
 * PC bridge reads its own, and `GALATEA_DATABASE_PASSWORD_FILE` for the store. The file must be this
 * account's and no other's (0600), as the install's secrets are. Its text is never said.
 */
export function readSecret(path: string, what: string, euid: number | undefined = process.geteuid?.()): { secret: string } | { refused: string } {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    return { refused: `${what} ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (!st.isFile()) return { refused: `${what} ${path} is not a file` };
  if (euid !== undefined && st.uid !== euid) return { refused: `${what} ${path} is owned by uid ${st.uid}, not by this account (uid ${euid})` };
  if (st.mode & 0o077) {
    return { refused: `${what} ${path} can be reached by other accounts (mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}); it must be this account's alone (0600)` };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch (err) {
    return { refused: `${what} ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (!text) return { refused: `${what} ${path} is empty` };
  return { secret: text };
}

/** GALATEA_DATABASE_URL with the store's password put in, encoded; the URL is never repeated, as it may carry one. */
export function databaseUrlWithPassword(text: string, password: string): { url: string } | { refused: string } {
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { refused: "GALATEA_DATABASE_URL is no URL" };
  }
  if (!u.username) return { refused: "GALATEA_DATABASE_URL names no user for its password" };
  u.password = encodeURIComponent(password);
  return { url: u.toString() };
}
