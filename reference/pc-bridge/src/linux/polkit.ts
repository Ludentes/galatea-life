import { readdir } from "node:fs/promises";
import { posix } from "node:path";
import { under } from "./etc.js";
import type { Runner } from "./run.js";

/**
 * The directories polkitd reads `.rules` files from, in its order (polkit(8) as Debian 13's
 * polkitd 126 gives it; polkit 124, Ubuntu 24.04's, reads the first and the last only).
 */
export const RULES_DIRS: readonly string[] = [
  "/etc/polkit-1/rules.d",
  "/run/polkit-1/rules.d",
  "/usr/local/share/polkit-1/rules.d",
  "/usr/share/polkit-1/rules.d",
];

/**
 * A stock rules file the backend recognises (*The OS port*): where it is, the package that ships
 * it, and the identities its rules give an administrator's rights, or rights as good as root's,
 * written by hand from the file as that package ships it. `review` carries each "as good as root"
 * judgement (a rule that grants actions, not an administrator rule), which the maintainer reviewed
 * and agreed (2026-10-01) before the Linux backend ships; `source` says where the file was read.
 */
export interface StockRules {
  path: string;
  package: string;
  identities: readonly string[];
  source: string;
  review?: string;
}

const DIR = "/usr/share/polkit-1/rules.d";
const DEBIAN_13 = "Debian 13 (packages.debian.org file lists; polkit 126-2's source)";
const UBUNTU_2404 = "Ubuntu 24.04, as installed on the build machine";
const DEBIAN_13_GNOME = "Debian 13 GNOME, as installed in the VM run (plan 4b, *The desktop run*)";

/**
 * The table. Debian 13 ships two rules files in its base packages: polkitd's `50-default.rules`
 * (built with `privileged_group=sudo`) and systemd's `systemd-networkd.rules`; Debian 12's
 * `49-polkit-pkla-compat.rules` (polkitd-pkla) is gone from Debian 13. A GNOME desktop adds more,
 * and the build machine's are here as it has them. The VM run (plan 4b, *The desktop run*) found a
 * stock Debian 13 GNOME install adds two more, gdm3's `20-gdm.rules` and malcontent's
 * `com.endlessm.ParentalControls.rules`, here since; any file not here reads `unknown` until the
 * table learns it: a stated limit.
 */
export const STOCK_RULES: readonly StockRules[] = [
  { path: `${DIR}/50-default.rules`, package: "polkitd", identities: ["unix-group:sudo"], source: `${DEBIAN_13}; ${UBUNTU_2404}` },
  { path: `${DIR}/49-ubuntu-admin.rules`, package: "polkitd", identities: ["unix-group:sudo", "unix-group:admin"], source: `${UBUNTU_2404} (Debian's source installs it only on Ubuntu)` },
  {
    path: `${DIR}/systemd-networkd.rules`, package: "systemd", identities: [], source: `${DEBIAN_13}; ${UBUNTU_2404}`,
    review: "user systemd-network may set the hostname and timezone and read the product UUID: not as good as root",
  },
  {
    path: `${DIR}/20-gdm.rules`, package: "gdm3", identities: [], source: `${DEBIAN_13_GNOME}: gdm3 48.0-2`,
    review: "user Debian-gdm may modify NetworkManager's system connections (settings.modify.system) when local and active: not as good as root, as for netdev",
  },
  {
    path: `${DIR}/com.endlessm.ParentalControls.rules`, package: "malcontent", identities: [], source: `${DEBIAN_13_GNOME}: malcontent 0.13.0-2+deb13u1`,
    review: "group sudo may read its own and any account's parental controls (AppFilter, SessionLimits) when local and active: not as good as root, and sudo is administrators already",
  },
  {
    path: `${DIR}/20-gnome-initial-setup.rules`, package: "gnome-initial-setup", identities: ["unix-user:gnome-initial-setup"], source: UBUNTU_2404,
    review: "user gnome-initial-setup gets org.freedesktop.accounts.* (make an administrator, set passwords) with no password: as good as root",
  },
  {
    path: `${DIR}/20-gnome-remote-desktop.rules`, package: "gnome-remote-desktop", identities: [], source: UBUNTU_2404,
    review: "user gnome-remote-desktop may enable the system remote-desktop daemon: not as good as root",
  },
  {
    path: `${DIR}/com.ubuntu.desktop.rules`, package: "policykit-desktop-privileges", identities: ["unix-group:sudo"], source: UBUNTU_2404,
    review: "group sudo: mounting internal drives, fstab, apt upgrades, the clock (administrators already); group lpadmin: printer administration through cups-pk-helper, not as good as root",
  },
  {
    path: `${DIR}/gamemode.rules`, package: "gamemode-daemon", identities: [], source: UBUNTU_2404,
    review: "group gamemode: the CPU governor, GPU clocks and gamemode's fixed sysctl helper: not as good as root",
  },
  { path: `${DIR}/gnome-control-center.rules`, package: "gnome-control-center-data", identities: ["unix-group:sudo"], source: UBUNTU_2404 },
  {
    path: `${DIR}/org.a11y.brlapi.rules`, package: "brltty", identities: [], source: UBUNTU_2404,
    review: "group brlapi: writing to a braille display: not as good as root",
  },
  {
    path: `${DIR}/org.freedesktop.bolt.rules`, package: "bolt", identities: ["unix-group:sudo"], source: UBUNTU_2404,
    review: "group sudo (administrators already) authorises Thunderbolt devices, which have DMA: as good as root",
  },
  { path: `${DIR}/org.freedesktop.Flatpak.rules`, package: "flatpak", identities: ["unix-group:sudo"], source: UBUNTU_2404 },
  { path: `${DIR}/org.freedesktop.fwupd.rules`, package: "fwupd", identities: ["unix-group:sudo"], source: UBUNTU_2404 },
  {
    path: `${DIR}/org.freedesktop.GeoClue2.rules`, package: "geoclue-2.0", identities: [], source: UBUNTU_2404,
    review: "user geoclue: modem control and location: not as good as root",
  },
  {
    path: `${DIR}/org.freedesktop.NetworkManager.rules`, package: "network-manager", identities: ["unix-group:sudo"], source: UBUNTU_2404,
    review: "group netdev: system connection settings (settings.modify.system), judged not as good as root; group sudo is administrators already",
  },
  { path: `${DIR}/org.freedesktop.packagekit.rules`, package: "packagekit", identities: ["unix-group:sudo"], source: UBUNTU_2404 },
  { path: `${DIR}/org.gtk.vfs.file-operations.rules`, package: "gvfs-backends", identities: ["unix-group:sudo"], source: UBUNTU_2404 },
  { path: `${DIR}/sssd-pcsc.rules`, package: "sssd-common", identities: ["unix-user:root"], source: UBUNTU_2404 },
  {
    path: `${DIR}/xrdp-colord.rules`, package: "xrdp", identities: [], source: UBUNTU_2404,
    review: "any active session may manage colord's devices and profiles: not as good as root, and names no identity",
  },
];

/** `dpkg-query -S <path>`'s answer: the packages that own the path, and whether a diversion moves it. */
export function parseDpkgSearch(stdout: string, path: string): { packages: string[]; diverted: boolean } {
  let packages: string[] = [];
  let diverted = false;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diversion by ")) {
      if (line.endsWith(`: ${path}`)) diverted = true;
      continue;
    }
    const m = line.match(/^(.+?): (\/.*)$/);
    if (m && m[2] === path) packages = m[1]!.split(", ").map((p) => p.replace(/:[^:]+$/, "").trim());
  }
  return { packages, diverted };
}

/**
 * `dpkg --verify <package>`'s answer (dpkg(1), `--verify-format rpm`): one line per file that fails
 * a check, `??5?????? c /etc/x` (`c` for a conffile) or `missing   /usr/x`; the paths it names.
 */
export function parseDpkgVerify(stdout: string): Set<string> {
  const out = new Set<string>();
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\S+\s+(?:c\s+)?(\/.*)$/);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** What polkit's directories give: the identities recognised files name, and a reason for each file (or directory) not recognised. */
export interface PolkitScan {
  identities: string[];
  unrecognised: string[];
}

/**
 * Scans polkit's rules directories (*The OS port*): a `.rules` file is recognised when it is in the
 * stock table, the table's package owns it (`dpkg-query -S`, with no diversion), and dpkg's record
 * shows it unmodified (`dpkg --verify` on that package); its identities are then the table's. Any
 * other file, a directory that cannot be read (a non-root run cannot read `/etc/polkit-1/rules.d`),
 * or dpkg not answering, is unrecognised. A directory that is not there holds nothing.
 */
export async function scanPolkit(root: string, run: Runner, table: readonly StockRules[] = STOCK_RULES): Promise<PolkitScan> {
  const identities: string[] = [];
  const unrecognised: string[] = [];
  const verified = new Map<string, Promise<Set<string> | undefined>>();
  const verify = (pkg: string) => {
    let v = verified.get(pkg);
    if (!v) {
      v = run("dpkg", ["--verify", pkg]).then(
        (r) => (r.code === 0 || (r.code === 1 && r.stdout.trim() !== "") ? parseDpkgVerify(r.stdout) : undefined),
        () => undefined,
      );
      verified.set(pkg, v);
    }
    return v;
  };
  for (const dir of RULES_DIRS) {
    let names: string[];
    try {
      names = (await readdir(under(root, dir))).sort();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      unrecognised.push(`${dir}: cannot be read (${code ?? err})`);
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".rules"))) {
      const path = posix.join(dir, name);
      const stock = table.find((t) => t.path === path);
      if (!stock) {
        unrecognised.push(`${path}: not a stock file the backend knows`);
        continue;
      }
      let owner: { packages: string[]; diverted: boolean };
      try {
        const r = await run("dpkg-query", ["-S", path]);
        owner = r.code === 0 ? parseDpkgSearch(r.stdout, path) : { packages: [], diverted: false };
      } catch (err) {
        unrecognised.push(`${path}: dpkg-query did not answer (${(err as Error).message})`);
        continue;
      }
      if (owner.diverted || !owner.packages.includes(stock.package)) {
        unrecognised.push(`${path}: ${owner.diverted ? "diverted" : `not owned by ${stock.package}`}`);
        continue;
      }
      const modified = await verify(stock.package);
      if (!modified) {
        unrecognised.push(`${path}: dpkg --verify ${stock.package} did not answer`);
        continue;
      }
      if (modified.has(path)) {
        unrecognised.push(`${path}: modified since ${stock.package} installed it`);
        continue;
      }
      identities.push(...stock.identities);
    }
  }
  return { identities: [...new Set(identities)], unrecognised };
}
