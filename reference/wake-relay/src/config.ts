import { readFileSync } from "node:fs";

/** One configured computer: a device id the owner chose, and its MAC in canonical form. */
export interface Entry {
  id: string;
  mac: string;
}

export interface BrokerConfig {
  url: string;
  username: string;
  passwordFile?: string;
  caFile?: string;
}

export interface RelayConfig {
  interface: string;
  gateway?: string;
  entries: Entry[];
  broker?: BrokerConfig;
  root?: string;
}

export class ConfigError extends Error {}

/** A device id: safe in a topic (no `+`, `#` or `/`, GA-BRIDGE-18), at most 40 characters. */
const ID = /^[A-Za-z0-9._-]{1,40}$/;
/** A Linux interface name, never starting with `-`, which `arping` would read as an option. */
const IFACE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,14}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** `d4:a6:51:a1:b2:c3`, `D4-A6-51-A1-B2-C3`, `d4a651a1b2c3` or `d4a6.51a1.b2c3`. */
const MAC_FORMS = [/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/, /^[0-9A-Fa-f]{2}(-[0-9A-Fa-f]{2}){5}$/, /^[0-9A-Fa-f]{12}$/,
  /^[0-9A-Fa-f]{4}(\.[0-9A-Fa-f]{4}){2}$/];

/** A MAC as twelve upper-case hex digits, the finder's canonical form without its `mac:` prefix. */
export function canonicalMac(text: string): string {
  if (!MAC_FORMS.some((form) => form.test(text))) throw new ConfigError(`not a MAC address: ${JSON.stringify(text)}`);
  const mac = text.replace(/[:.-]/g, "").toUpperCase();
  if (mac === "000000000000" || mac === "FFFFFFFFFFFF") throw new ConfigError(`not a computer's MAC address: ${text}`);
  return mac;
}

function isIpv4(text: string): boolean {
  const m = text.match(IPV4);
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseConfig(value: unknown): RelayConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfigError("the configuration is not an object");
  const c = value as Record<string, unknown>;
  if (!str(c.interface) || !IFACE.test(c.interface)) throw new ConfigError("`interface` must name the LAN interface, as `eth0`");
  if (c.gateway !== undefined && (!str(c.gateway) || !isIpv4(c.gateway))) throw new ConfigError("`gateway` must be an IPv4 address");
  if (!Array.isArray(c.entries) || c.entries.length === 0) throw new ConfigError("`entries` must list at least one computer");
  const ids = new Set<string>();
  const macs = new Set<string>();
  const entries = c.entries.map((raw, i): Entry => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (!str(e.id) || !ID.test(e.id)) throw new ConfigError(`entries[${i}].id must be 1 to 40 of [A-Za-z0-9._-]`);
    if (!str(e.mac)) throw new ConfigError(`entries[${i}].mac is missing`);
    const mac = canonicalMac(e.mac);
    if (ids.has(e.id)) throw new ConfigError(`the id ${e.id} is listed twice`);
    if (macs.has(mac)) throw new ConfigError(`the MAC ${e.mac} is listed twice`);
    ids.add(e.id);
    macs.add(mac);
    return { id: e.id, mac };
  });
  const out: RelayConfig = { interface: c.interface, entries };
  if (c.gateway !== undefined) out.gateway = c.gateway as string;
  if (c.root !== undefined) {
    if (!str(c.root)) throw new ConfigError("`root` must be the deployment's topic root");
    out.root = c.root;
  }
  if (c.broker !== undefined) {
    const b = c.broker as Record<string, unknown>;
    if (!b || !str(b.url) || !str(b.username)) throw new ConfigError("`broker` needs `url` and `username`");
    out.broker = { url: b.url, username: b.username };
    if (b.passwordFile !== undefined) {
      if (!str(b.passwordFile)) throw new ConfigError("`broker.passwordFile` must be a path");
      out.broker.passwordFile = b.passwordFile;
    }
    if (b.caFile !== undefined) {
      if (!str(b.caFile)) throw new ConfigError("`broker.caFile` must be a path");
      out.broker.caFile = b.caFile;
    }
  }
  return out;
}

export function loadConfig(path: string): RelayConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path} is not JSON: ${(err as Error).message}`);
  }
  return parseConfig(json);
}
