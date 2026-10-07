import tls from "node:tls";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

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

export const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);

/**
 * The applier's URL as GA-SEC-2 allows it: `https`, its certificate validated against the system's
 * store or the CA the steward was given, or plain `http` only when both ends are on this host's
 * loopback. Anything else is refused before a connection is tried, never retried insecurely.
 */
export function checkApplierUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("GALATEA_APPLIER_URL is not a URL");
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return url;
  throw new Error(`refusing to reach the applier at ${url.protocol}//${url.host}: off loopback it must be https (GA-SEC-2)`);
}

/**
 * `GALATEA_APPLIER_CA`: a CA the applier's certificate may be validated against, beside the
 * system's store (GA-SEC-2). Process-wide: the applier link is the steward's one TLS client.
 */
export function trustApplierCa(pem: string): void {
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), pem]);
}

/** The mutation `trusts-any-applier`: the applier's certificate is not validated at all. */
export function trustAnyApplier(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/**
 * One MCP session to the applier, with its bearer. It negotiates revision 2026-07-28 first and
 * falls back to the 2025 handshake only where the applier does not serve it (GA-BIND-2);
 * `legacy` speaks only the 2025 handshake (the mutation `calls-its-applier-at-2025`).
 */
export class McpApplierPort implements ApplierPort {
  private constructor(private readonly client: Client) {}

  static async connect(url: URL, bearer: string, opts: { legacy?: boolean } = {}): Promise<McpApplierPort> {
    const client = new Client({ name: "galatea-reference-steward", version: "0.0.0" },
      { versionNegotiation: { mode: opts.legacy ? "legacy" : "auto" } });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    return new McpApplierPort(client);
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

  close(): Promise<void> {
    return this.client.close();
  }
}
