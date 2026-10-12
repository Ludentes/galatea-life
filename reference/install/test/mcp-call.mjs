#!/usr/bin/env node
// The install tests' MCP client, run in the steward's image (Stack.mcp): one tool call, its request
// on standard input as JSON { url, credential, tool, args, ca, plain }, so no credential is on a
// command line. Prints one line of JSON: { ok, body } or { ok: false, error }. The CA is this call's
// trust alone, in its own undici agent; `plain` rewrites the URL to http://.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch } from "undici";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { url, credential, tool, args, ca, plain } = JSON.parse(input);
const out = (o) => {
  console.log(JSON.stringify(o));
  process.exit(0);
};
const target = new URL(url);
if (plain) target.protocol = "http:";
const agent = new Agent({ connect: { ca } });
const fetch = async (u, init) => {
  try {
    return await undiciFetch(u, { ...init, dispatcher: agent });
  } catch (err) {
    const cause = err?.cause;
    throw new Error(`${err.message}: ${cause?.code ?? cause?.message ?? ""}`);
  }
};
const client = new Client({ name: "galatea-install-test", version: "0.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(target, { fetch, requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) });
}
try {
  const r = await client.callTool({ name: tool, arguments: args ?? {} });
  const text = r.content?.find((c) => c.type === "text")?.text;
  const body = r.structuredContent ?? (text ? JSON.parse(text) : {});
  out(r.isError ? { ok: false, error: body.error, body } : { ok: true, body });
} catch (err) {
  out({ ok: false, error: String(err?.message ?? err) });
}
