// A person's stand-in for the bridge: starts the installed package's server as the manifest says,
// in this desktop session, and sends it what you type.
//   pnpm --filter @ludentes/galatea-life-plugin-mpv try <installed package directory>
// Then type: tools | state | launch <title words> [--movie|--episode] | pause | resume | volume <n> | quit
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Manifest } from "../src/manifest.js";
import { toolHash } from "../src/tools.js";

const dir = resolve(process.argv[2] ?? "");
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
const uri = manifest.devices[0]!.stateUri;
const keep = ["HOME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"];
const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
const [interpreter, ...args] = manifest.command;

// The 2025 era, so that the SDK's stdio transport starts the server once (a pinned or `auto`
// client probes on a second start); the automated tests cover 2026-07-28.
const client = new Client({ name: "try", version: "0" }, { capabilities: {} });
client.setNotificationHandler("notifications/resources/updated" as never, (async () => {
  const s = (await client.readResource({ uri })).contents[0] as { text: string };
  console.log(`  (state changed) ${s.text}`);
}) as never);
await client.connect(new StdioClientTransport({ command: interpreter!, args, cwd: dir, env }));
await (client as unknown as { subscribeResource(p: { uri: string }): Promise<unknown> }).subscribeResource({ uri });

const tools = (await client.listTools()).tools;
const pinned = tools.every((t) => manifest.toolHashes[t.name] === toolHash(t)) && tools.length === Object.keys(manifest.toolHashes).length;
console.log(`server up; tools ${pinned ? "match" : "DO NOT match"} the manifest's hashes`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const [cmd, ...rest] = (await rl.question("> ")).trim().split(/\s+/);
  try {
    if (cmd === "quit" || cmd === undefined) break;
    if (cmd === "tools") console.log(tools.map((t) => `${t.name}: ${t.description}`).join("\n"));
    else if (cmd === "state") console.log(((await client.readResource({ uri })).contents[0] as { text: string }).text);
    else {
      const call =
        cmd === "launch"
          ? { name: "launch", arguments: { search: {
              title: rest.filter((w) => !w.startsWith("--")).join(" "),
              ...(rest.includes("--movie") ? { kind: "movie" } : rest.includes("--episode") ? { kind: "episode" } : {}),
            } } }
          : cmd === "volume"
            ? { name: "set_volume", arguments: { volume: Number(rest[0]) } }
            : { name: cmd, arguments: {} };
      const r = await client.callTool(call);
      console.log(`${r.isError ? "FAILED" : "ok"}: ${(r.content as { text: string }[])[0]?.text}`);
    }
  } catch (e) {
    console.log(`error: ${(e as Error).message}`);
  }
}
rl.close();
await client.close();
