/** The broker, as `GALATEA_BROKER` names it, split into what the bus needs. */
export type BrokerUrl = { url: string; identity: string; password?: string };

/**
 * Parses `GALATEA_BROKER`: `mqtt[s]://<identity>[:<password>]@host:port`. It throws an error that
 * carries nothing of the value, since the value may carry the password (Node's own URL error would
 * print it whole).
 */
export function brokerFromUrl(raw: string): BrokerUrl {
  let parsed: BrokerUrl;
  try {
    const u = new URL(raw);
    if (u.protocol !== "mqtt:" && u.protocol !== "mqtts:") throw new Error("another protocol");
    parsed = { url: `${u.protocol}//${u.host}`, identity: decodeURIComponent(u.username),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}) };
  } catch {
    throw new Error("GALATEA_BROKER is not a valid URL");
  }
  if (!parsed.identity) throw new Error("GALATEA_BROKER names no identity");
  return parsed;
}

/**
 * Whether a broker URL is plain TCP to a host off loopback: then the applier refuses `box: true`, since
 * anyone on the path could read and forge its commands (GA-DESC-6).
 */
export function plainOffLoopback(url: string): boolean {
  const u = new URL(url);
  if (u.protocol !== "mqtt:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || /^127\./.test(host));
}
