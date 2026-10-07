import { readFileSync, statSync } from "node:fs";

/** The broker credential on Linux (*Plugins on Linux*): `root:root`, mode 0600, read by the service. */
export const LINUX_CREDENTIAL = "/etc/galatea-pc-bridge/credential";
/** The service's state directory on Linux, beside the plugins directory. */
export const LINUX_STATE_DIR = "/var/lib/galatea-pc-bridge/state";

/** The credential cannot be used: the bridge refuses to start and says why, never what it holds. */
export class CredentialError extends Error {}

/**
 * The broker password from a file: a regular file owned by this process's account (root, for the
 * service) that no other account can read or write (GA-BRIDGE-64), its text without the trailing
 * newline. A credential another account can read lets that account publish as the bridge, so a
 * file with any group or other bit is refused, not used.
 */
export function readCredential(path: string, euid: number = process.geteuid!()): string {
  let st;
  try {
    st = statSync(path);
  } catch (err) {
    throw new CredentialError(`${path}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
  if (!st.isFile()) throw new CredentialError(`${path} is not a file`);
  if (st.uid !== euid) throw new CredentialError(`${path} is owned by uid ${st.uid}, not by this process's account (uid ${euid})`);
  if ((st.mode & 0o077) !== 0) {
    throw new CredentialError(`${path} has mode ${(st.mode & 0o777).toString(8).padStart(4, "0")}; other accounts must not reach it (0600)`);
  }
  const text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  if (!text) throw new CredentialError(`${path} is empty`);
  return text;
}
