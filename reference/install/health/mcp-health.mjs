#!/usr/bin/env node
// An MCP server's health check (the install-core design, *The applier and the steward as
// services*), run by the service's own node:
//   node mcp-health.mjs <port> [ca]
// An HTTPS request to its own https://127.0.0.1:<port>/mcp, the certificate validated against the
// installation's CA (default /run/tls/ca.pem). Healthy (exit 0) when any HTTP status comes back within
// 3 s, so a stuck event loop is unhealthy, which a port check would miss, and the certificate has more
// than 14 days left. It sends no credential.
import { readFileSync } from "node:fs";
import { request } from "node:https";

const [port, caPath = "/run/tls/ca.pem"] = process.argv.slice(2);
const DEADLINE_MS = 3_000;
const MIN_DAYS = 14;

function fail(why) {
  console.error(`unhealthy: ${why}`);
  process.exit(1);
}
if (!/^\d+$/.test(port ?? "")) fail("usage: mcp-health.mjs <port> [ca]");
let ca;
try {
  ca = readFileSync(caPath, "utf8");
} catch (err) {
  fail(`no CA at ${caPath} (${err.code ?? err.message})`);
}

const timer = setTimeout(() => fail(`no answer within ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
const req = request({ host: "127.0.0.1", port: Number(port), path: "/mcp", method: "GET", ca, agent: false,
  headers: { accept: "application/json, text/event-stream" } }, (res) => {
  const cert = res.socket.getPeerCertificate();
  const days = (Date.parse(cert.valid_to) - Date.now()) / 86_400_000;
  res.resume();
  clearTimeout(timer);
  if (!(days > MIN_DAYS)) fail(`its certificate has ${Math.floor(days)} days left; run bin/galatea-certs`);
  console.log(`healthy: HTTP ${res.statusCode}, certificate ${Math.floor(days)} days left`);
  process.exit(0);
});
req.on("error", (err) => fail(err.code ?? err.message));
req.end();
