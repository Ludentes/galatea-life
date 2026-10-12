import type { ToolInputSchema } from "@ludentes/galatea-life-schemas";
/** Who calls: the owner's configuration credential, a client's, or neither (applier, *Clients and tokens*). */
export type Caller = { kind: "owner" } | { kind: "client"; id: string } | { kind: "anonymous" };

/** An operation's answer: its body, or a request error with its code, message and data. */
export type ToolResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: string; message: string; data?: Record<string, unknown> };

/**
 * One operation a binding lists: its name, whether it changes nothing, a line saying what it does,
 * and its request schema, self-contained, since MCP clients resolve no `$ref`.
 */
export interface Tool {
  name: string;
  readOnly: boolean;
  summary: string;
  inputSchema: ToolInputSchema;
}

/**
 * What a binding (the MCP server) asks of an applier: resolve a bearer to its caller, and answer an
 * operation for that caller. `Applier` is one; a meta-applier or a host's own wrapper can be another.
 */
export interface ApplierService {
  /** The caller a bearer credential names, resolved on every request (GA-AUTH-3). */
  caller(bearer: string | undefined): Caller;
  /** Answers operation `tool` with `args` for `caller`. */
  call(caller: Caller, tool: string, args: unknown): Promise<ToolResult>;
}
