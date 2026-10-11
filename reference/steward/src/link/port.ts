import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

type Body = Record<string, any>;

/**
 * What the steward asks of its one applier (the design, *A port, for tests*): the MCP client below,
 * or an in-memory fake. It reads the applier's model, its state, its events and its history, plans,
 * and applies.
 */
export interface ApplierPort {
  describe(): Promise<Body>;
  state(): Promise<Body>;
  /** The applier's `plan` of an inline request (applier, *Plans*): read and discarded, never applied (GA-STW-10). */
  plan(request: Body): Promise<Body>;
  /** The applier's `apply { request, idempotency_key }`, waiting at most `timeoutMs` for its answer. */
  apply(body: Body, timeoutMs: number): Promise<Body>;
  /** `cursor` undefined: the current cursor and no events. `taken`: the notices the steward delivered, sent as `notice_taken` (GA-NOTE-1). */
  events(cursor: string | undefined, waitS: number, taken?: string[]): Promise<{ events: Body[]; cursor: string; notices?: Body[] }>;
  /** The applier's `history { from, to }` (applier, *Events and history*): what it kept, oldest first. */
  history(range: { from: string; to: string }): Promise<{ events: Body[] }>;
  close(): Promise<void>;
  /** The MCP revision the session was reached at. */
  readonly protocolVersion?: string;
}

/** A call the link never made: no session to the applier was up (the design, *The applier call*). */
export class NotSent extends Error {}

/** A request error the applier answered (`{ error, message }`). */
export class ApplierRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(`the applier answered ${code}: ${message}`);
  }
}

export { checkApplierUrl, isLoopback } from "../net/applier-url.js";

/**
 * How one link validates its applier's certificate (GA-SEC-2): against `ca` alone when it is given
 * (`GALATEA_APPLIER_CA`), else against the system's store; `insecure`, the mutation
 * `trusts-any-applier`, not at all. The trust is the link's own undici agent, handed to the MCP
 * transport through its `fetch`: nothing else in the process trusts more than the system's store.
 */
export function linkFetch(opts: { ca?: string; insecure?: boolean }): { fetch: FetchLike; agent: Agent } {
  const agent = new Agent({ connect: opts.insecure ? { rejectUnauthorized: false } : opts.ca ? { ca: opts.ca } : {} });
  const fetch: FetchLike = async (url, init) => {
    try {
      return (await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent })) as unknown as Response;
    } catch (err) {
      // undici says only "fetch failed"; the cause (a refused certificate, a refused connection) is what the log needs.
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      if (err instanceof TypeError && cause) throw new TypeError(`${err.message}: ${cause.code ?? cause.message}`, { cause });
      throw err;
    }
  };
  return { fetch, agent };
}

/**
 * One MCP session to the applier, with its bearer. It negotiates revision 2026-07-28 first and
 * falls back to the 2025 handshake only where the applier does not serve it (GA-BIND-2);
 * `legacy` speaks only the 2025 handshake (the mutation `calls-its-applier-at-2025`).
 */
export class McpApplierPort implements ApplierPort {
  private constructor(private readonly client: Client, private readonly agent: Agent) {}

  /** `ca` and `insecure` as `linkFetch` takes them: this session's trust, and no other's. */
  static async connect(url: URL, bearer: string, opts: { legacy?: boolean; ca?: string; insecure?: boolean } = {}): Promise<McpApplierPort> {
    const client = new Client({ name: "galatea-reference-steward", version: "0.0.0" },
      { versionNegotiation: { mode: opts.legacy ? "legacy" : "auto" } });
    const { fetch, agent } = linkFetch(opts);
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { fetch, requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    } catch (err) {
      await client.close().catch(() => undefined);
      await agent.destroy().catch(() => undefined);
      throw err;
    }
    return new McpApplierPort(client, agent);
  }

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  private async call(tool: string, args: Body = {}, timeoutMs = 60_000): Promise<Body> {
    const r = (await this.client.callTool({ name: tool, arguments: args }, { timeout: timeoutMs })) as
      { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
    let body = r.structuredContent as Body | undefined;
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (body === undefined && text !== undefined) body = JSON.parse(text) as Body;
    if (r.isError) throw new ApplierRefused(String(body?.error), String(body?.message));
    return body ?? {};
  }

  describe(): Promise<Body> {
    return this.call("describe");
  }

  state(): Promise<Body> {
    return this.call("state");
  }

  plan(request: Body): Promise<Body> {
    return this.call("plan", request);
  }

  apply(body: Body, timeoutMs: number): Promise<Body> {
    return this.call("apply", body, timeoutMs);
  }

  async events(cursor: string | undefined, waitS: number, taken: string[] = []): Promise<{ events: Body[]; cursor: string; notices?: Body[] }> {
    // The long-poll's own wait, and a margin for the answer to travel.
    const r = await this.call("events", { ...(cursor === undefined ? {} : { cursor, wait_s: waitS }), ...(taken.length ? { notice_taken: taken } : {}) },
      (waitS + 30) * 1000);
    return r as { events: Body[]; cursor: string; notices?: Body[] };
  }

  async history(range: { from: string; to: string }): Promise<{ events: Body[] }> {
    const r = await this.call("history", range);
    return { events: Array.isArray(r.events) ? r.events as Body[] : [] };
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      // Destroyed, not closed: a long-poll still open would hold a close for its whole wait.
      await this.agent.destroy().catch(() => undefined);
    }
  }
}
