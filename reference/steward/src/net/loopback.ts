/**
 * Whether an address is this host's loopback, where plain HTTP may be served. A module of its own,
 * importing nothing, so the entry points' settings can use it without loading the MCP server.
 */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
