// The applier's URL check, in a module that imports nothing, so the entry points' settings can use it
// without loading the MCP client or undici. `link/port.ts` re-exports it.

/** A URL's host on this host's loopback, as `URL.hostname` gives it (`[::1]` for IPv6). */
export const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);

/**
 * The applier's URL as GA-SEC-2 allows it: `https`, its certificate validated against the system's
 * store or the CA the link was given, or plain `http` only when both ends are on this host's
 * loopback. Anything else is refused before a connection is tried, never retried insecurely.
 */
export function checkApplierUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GALATEA_APPLIER_URL is not a URL");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return url;
  throw new Error(`refusing to reach the applier at ${url.protocol}//${url.host}: off loopback it must be https (GA-SEC-2)`);
}
