#!/usr/bin/env node
// Registers the steward at the applier (the install-core design, *Credentials*), run by
// bin/galatea-register-steward in a one-off container of the steward's image, so it resolves the
// image's MCP client and undici. From read-only binds under /run/register it reads the applier's
// owner credential (`owner`), the steward's credential (`credential`) and token key (`token-key`), and
// the installation's CA (`ca.pem`). It reads the applier's `describe` for its revision and sends one
// `configure` upserting the client { id: steward, credential, token_key, kind: steward }: first as a
// dry run, and only when that shows a change, for real. It prints the diff, never a value. No model is
// in the loop, and no credential is on a command line.
import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch } from "undici";

const DIR = "/run/register";
const url = new URL(process.env.GALATEA_APPLIER_URL ?? "https://applier:18443/mcp");
const read = (name) => readFileSync(`${DIR}/${name}`, "utf8").replace(/\r?\n$/, "");

function fail(why) {
  console.error(`register-steward: ${why}`);
  process.exit(1);
}

let owner, credential, tokenKey, ca;
try {
  [owner, credential, tokenKey, ca] = [read("owner"), read("credential"), read("token-key"), read("ca.pem")];
} catch (err) {
  fail(`a file is missing under ${DIR} (${err.code ?? err.message})`);
}
if (!owner || !credential || !tokenKey) fail("an empty credential or key");

// This link's trust alone: the installation's CA, in its own agent.
const agent = new Agent({ connect: { ca } });
const fetch = (u, init) => undiciFetch(u, { ...init, dispatcher: agent });
const client = new Client({ name: "galatea-register-steward", version: "0.0.0" });
async function call(tool, args = {}) {
  const r = await client.callTool({ name: tool, arguments: args });
  const text = r.content?.find((c) => c.type === "text")?.text;
  const body = r.structuredContent ?? (text ? JSON.parse(text) : {});
  if (r.isError) throw Object.assign(new Error(`${tool}: ${body.error}: ${body.message}`), { code: body.error });
  return body;
}

try {
  await client.connect(new StreamableHTTPClientTransport(url, { fetch, requestInit: { headers: { Authorization: `Bearer ${owner}` } } }));
} catch (err) {
  const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
  fail(`the applier at ${url.host} is out of reach: ${cause}`);
}
const changes = [{ op: "upsert", kind: "client", value: { id: "steward", credential, kind: "steward", token_key: tokenKey } }];
try {
  for (let attempt = 1; ; attempt++) {
    const { revision } = await call("describe");
    try {
      const { diff } = await call("configure", { changes, expected_revision: revision, dry_run: true });
      if (diff === "no change") {
        console.log("register-steward: no change (the steward is registered with these files)");
        break;
      }
      await call("configure", { changes, expected_revision: revision, dry_run: false });
      console.log(`register-steward: ${diff}`);
      break;
    } catch (err) {
      // Another change landed between the describe and the configure: read the revision again.
      if (err.code !== "stale_revision" || attempt === 5) throw err;
    }
  }
} catch (err) {
  fail(err.message);
} finally {
  await client.close().catch(() => undefined);
  await agent.destroy().catch(() => undefined);
}
