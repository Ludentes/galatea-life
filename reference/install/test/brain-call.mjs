#!/usr/bin/env node
// The first-light test's stand-in for a coding agent (plan C1): started by the agent-brain's own
// launcher (reference/agent-brain/bin/galatea-agent-brain) in place of the agent tool, as the brain's
// account, in the steward's image (which has the MCP client). It reads the server from .mcp.json in
// its working directory as an agent tool does, expanding ${VAR} and ${VAR:-default} from the
// environment the launcher set, and trusts the CA only through NODE_EXTRA_CA_CERTS (Node's own fetch).
// Its request, on standard input, is { tool, args } and carries no credential. Prints one line of
// JSON: { ok, body } or { ok: false, error }.
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { tool, args } = JSON.parse(input);
const out = (o) => {
  console.log(JSON.stringify(o));
  process.exit(0);
};
const expand = (s) => s.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, dflt) => process.env[name] || dflt || "");
const server = JSON.parse(readFileSync(".mcp.json", "utf8")).mcpServers.galatea;
const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expand(v)]));
const client = new Client({ name: "galatea-first-light-brain", version: "0.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(expand(server.url)), { requestInit: { headers } }));
} catch (err) {
  out({ ok: false, error: `${err?.message ?? err}: ${err?.cause?.code ?? err?.cause?.message ?? ""}` });
}
try {
  const r = await client.callTool({ name: tool, arguments: args ?? {} });
  const text = r.content?.find((c) => c.type === "text")?.text;
  const body = r.structuredContent ?? (text ? JSON.parse(text) : {});
  out(r.isError ? { ok: false, error: body.error, body } : { ok: true, body });
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) });
}
