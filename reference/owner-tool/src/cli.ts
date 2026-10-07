import { parseArgs } from "node:util";
import { credential, registerBridge } from "./commands/register.js";
import { configure, define } from "./commands/changes.js";
import { adopt } from "./commands/pairing.js";
import { devices, status } from "./commands/reading.js";
import { type Ctx, type Deps, type Exit, FileProblem, Held, Refusal, Usage } from "./context.js";
import { BadUrl, Lost, NotTaken, Unreachable } from "./link.js";
import { jsonLine } from "./print.js";

export const USAGE = `galatea <command> [flags] [--json] [--install DIR] [--applier URL] [--steward URL]

  status                                  both servers, their transports, devices not live, open asks
  devices [--all]                         the applier's devices, with the steward's names and rooms
  register bridge <id> [--identity I]     registers a bridge with the applier
  credential <id> --kind K [--endpoint E] [--confirm-on E2]
                                          defines a credential at the steward, its secret from secrets/mcp/<id>
  configure <file|-> [--dry-run]          any applier change set
  define <file|-> [--dry-run]             any steward change set, at owner-app
  adopt <device> --class C [--tier action=tier]...
                                          adopts a device, raising any tiers

Exit: 0 done, 1 failed under way, 2 refused before anything was done.`;

/** The flags every command takes; `--install`, `--applier` and `--steward` are main.ts's, declared here so they parse. */
const COMMON = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  install: { type: "string" },
  applier: { type: "string" },
  steward: { type: "string" },
} as const;

const FLAGS = {
  status: {},
  devices: { all: { type: "boolean" } },
  register: { identity: { type: "string" } },
  credential: { kind: { type: "string" }, endpoint: { type: "string" }, "confirm-on": { type: "string" } },
  configure: { "dry-run": { type: "boolean" } },
  define: { "dry-run": { type: "boolean" } },
  adopt: { class: { type: "string" }, tier: { type: "string", multiple: true } },
} as const;

type Command = keyof typeof FLAGS;

/**
 * Parses `argv` (without node and the script), runs one command, and maps what it threw to an exit
 * (the design, *Connecting*): a bad flag, a file refused, a server not reached, or a refusal before
 * anything was done, 2; a refusal after something was done, a lost call or a held one, 1.
 */
export async function run(argv: string[], deps: Deps): Promise<Exit> {
  const name = argv[0];
  if (!name || name === "--help" || name === "-h" || name === "help") {
    (name ? deps.say.out : deps.say.err)(USAGE);
    return name ? 0 : 2;
  }
  if (!(name in FLAGS)) {
    deps.say.err(`galatea: no command ${JSON.stringify(name)}\n\n${USAGE}`);
    return 2;
  }
  const command = name as Command;
  let parsed;
  try {
    parsed = parseArgs({ args: argv.slice(1), options: { ...COMMON, ...FLAGS[command] }, allowPositionals: true, strict: true });
  } catch (err) {
    deps.say.err(`galatea ${command}: ${(err as Error).message}`);
    return 2;
  }
  const v = parsed.values as Record<string, any>;
  const p = parsed.positionals;
  if (v.help) {
    deps.say.out(USAGE);
    return 0;
  }
  const ctx: Ctx = { ...deps, json: v.json === true, done: false };
  try {
    switch (command) {
      case "status": return none(p, command) ?? await status(ctx);
      case "devices": return none(p, command) ?? await devices(ctx, v.all === true);
      case "register":
        if (p[0] === "bridge" && p.length <= 2) return await registerBridge(ctx, p[1], v.identity);
        throw new Usage("galatea register bridge <id> [--identity I] (the steward is registered by the installation's galatea-register-steward)");
      case "credential":
        if (p.length > 1) throw new Usage("galatea credential takes one credential id");
        return await credential(ctx, p[0], { kind: v.kind, endpoint: v.endpoint, confirmOn: v["confirm-on"] });
      case "configure":
      case "define":
        if (p.length > 1) throw new Usage(`galatea ${command} takes one file, or -`);
        return await (command === "configure" ? configure : define)(ctx, p[0], v["dry-run"] === true);
      case "adopt":
        if (p.length > 1) throw new Usage("galatea adopt takes one device");
        return await adopt(ctx, p[0], v.class, v.tier ?? []);
    }
  } catch (err) {
    return failed(ctx, command, err);
  }
}

function none(p: string[], command: string): undefined {
  if (p.length) throw new Usage(`galatea ${command} takes no argument (${JSON.stringify(p[0])})`);
  return undefined;
}

function failed(ctx: Ctx, command: string, err: unknown): Exit {
  const say = (line: string) => ctx.say.err(`galatea ${command}: ${line}`);
  if (err instanceof Refusal) {
    if (ctx.json) ctx.say.out(jsonLine(err.reply.body));
    say(err.message);
    return ctx.done ? 1 : 2;
  }
  if (err instanceof Usage || err instanceof FileProblem || err instanceof Unreachable || err instanceof BadUrl) {
    say(err.message);
    return 2;
  }
  if (err instanceof NotTaken) {
    // The server took nothing of the call: as a refusal, 2 unless something was done before it (the maintainer's ruling, review M2).
    say(err.message);
    return ctx.done ? 1 : 2;
  }
  if (err instanceof Held || err instanceof Lost) {
    say(err.message);
    return 1;
  }
  say(`failed: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
}
