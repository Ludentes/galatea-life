import type { Reply } from "./link.js";
import type { Applier, Steward } from "./servers.js";

/** Where a command writes what it has to say: a line to its output, a line to its error. */
export interface Say {
  out(line: string): void;
  err(line: string): void;
}

/** A command's end, as the Zigbee bridge's command line has it: 0 done, 1 failed under way, 2 refused before anything was done. */
export type Exit = 0 | 1 | 2;

/**
 * What `main.ts` hands `run`: the links, opened on first use, and the files, read when asked. Each
 * may throw: `Unreachable` or `BadUrl` for a server, `FileProblem` for a file.
 */
export interface Deps {
  say: Say;
  applier(): Promise<Applier>;
  steward(): Promise<Steward>;
  /** A secret from the installation's `secrets/mcp/<name>`, its file this account's alone. */
  secret(name: string): string;
  /** A change set's text: a file, or standard input for `-`. */
  input(path: string): Promise<string>;
  /** Now, in milliseconds (the reading commands' windows). */
  now(): number;
}

/** What a command works with: the dependencies, `--json`, and whether anything was done yet. */
export interface Ctx extends Deps {
  json: boolean;
  /** Set once a change was accepted by a server: a refusal after it ends 1, not 2. */
  done: boolean;
}

/** A refusal a server returned, whole. */
export class Refusal extends Error {
  constructor(readonly server: string, readonly tool: string, readonly reply: Extract<Reply, { kind: "refused" }>) {
    super(`the ${server} refused ${tool}: ${reply.error}: ${reply.message}`);
  }
}

/** A call the server holds: what was asked is judged when the server's store answers. */
export class Held extends Error {}

/** A command line the tool refuses: a bad flag, a missing argument, a value of the wrong form. */
export class Usage extends Error {}

/** A file the tool refuses: missing, unreadable, someone else's or reachable by other accounts, empty, or not JSON. */
export class FileProblem extends Error {}

/** The body of an accepted reply; a refusal is thrown as `Refusal`, a held call as `Held`. */
export function need(reply: Reply, server: string, tool: string): Record<string, any> {
  if (reply.kind === "ok") return reply.body;
  if (reply.kind === "held") {
    throw new Held(`the ${server} holds the ${tool} (${reply.message}): it will be judged at its revision when the ${server}'s store answers; `
      + `read the ${server}'s describe before trying again`);
  }
  throw new Refusal(server, tool, reply);
}
