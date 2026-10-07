import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export type Body = Record<string, any>;

/**
 * What a call came back with (the design, *Connecting*): the body; a refusal returned whole (a tool
 * result with `isError`, `{ error, message }` and anything else the server put in it); or a call the
 * server holds (`define` held past 10 s answers an MCP protocol error whose `data.pending` is true).
 */
export type Reply =
  | { kind: "ok"; body: Body }
  | { kind: "refused"; error: string; message: string; body: Body }
  | { kind: "held"; message: string };

/** The server could not be reached: no session was opened. Nothing was sent. `certificate` when its TLS certificate was not validated. */
export class Unreachable extends Error {
  constructor(message: string, readonly certificate = false) {
    super(message);
  }
}

/** Whether a failure was a certificate's: a TLS validation code anywhere in its causes. */
function certificateFailure(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; e && i < 6; i++) {
    const code = String((e as { code?: unknown }).code ?? "");
    if (/CERT|SIGNATURE|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT/.test(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A session was opened, then a call was lost: no answer, a timeout, or a protocol error that says
 * nothing of what was asked. `answered` when the server did answer, with an internal error and no
 * `data`: the applier answers a `configure` that outlasted its gate so, and keeps it queued (review M2).
 */
export class Lost extends Error {
  constructor(message: string, readonly answered = false) {
    super(message);
  }
}

/** The server answered that it took nothing of the call: an internal error whose `data.pending` is false (the steward's store down). */
export class NotTaken extends Error {}

/** A URL the tool refuses before trying it: not a URL, or plain `http` off loopback. */
export class BadUrl extends Error {}

/**
 * A URL's hostname that is this host's loopback: `localhost`, an IPv4 literal in 127.0.0.0/8, or
 * `::1` (with or without its brackets). A DNS name is never loopback, however it begins: a name like
 * `127.example.net` resolves wherever its owner says (review I1).
 */
export function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const kind = isIP(bare);
  if (kind === 4) return bare.split(".")[0] === "127";
  if (kind === 6) return bare === "::1";
  return false;
}

/**
 * A server's URL as the tool accepts it: `https`, validated against the CA it is given, or plain
 * `http` only on this host's loopback, as the servers serve it there (GA-SEC-1, GA-SEC-2).
 */
export function checkUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadUrl(`the ${what}'s URL is not a URL`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return url;
  throw new BadUrl(`refusing to reach the ${what} at ${url.protocol}//${url.host}: off loopback it must be https`);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The bearer never appears in a message the tool says: a library's text is cleaned of it before it is passed on. */
const scrub = (text: string, secret: string): string => (secret ? text.split(secret).join("<credential>") : text);

export interface LinkOptions {
  /** The server's name in what the tool says: `applier` or `steward`. */
  what: string;
  url: URL;
  bearer: string;
  /** PEM of the CA the server's certificate is validated against, this link alone; the system's store when absent. */
  ca?: string;
  /** The SDK's version negotiation; `legacy` only for a test of the fallback. */
  era?: "auto" | "legacy";
}

/**
 * One MCP session to one server with one bearer credential and one CA (the design, *Connecting*):
 * MCP over Streamable HTTP at revision 2026-07-28 with the SDK's fallback, as the harness's `McpSeam`
 * and the steward's `McpApplierPort` use it. The CA is trusted through this link's own `undici`
 * `Agent`, on undici's own `fetch` given to the transport: no process-wide TLS setting changes, and
 * certificate validation is never turned off.
 */
export class Link {
  private constructor(private readonly client: Client, private readonly o: LinkOptions, private readonly agent?: Agent) {}

  static async connect(o: LinkOptions): Promise<Link> {
    const agent = o.url.protocol === "https:" ? new Agent({ connect: o.ca ? { ca: o.ca } : {} }) : undefined;
    const fetch = (async (input: string | URL, init?: RequestInit) =>
      undiciFetch(input as any, { ...(init as any), ...(agent ? { dispatcher: agent } : {}) })) as unknown as typeof globalThis.fetch;
    const client = new Client({ name: "galatea-owner-tool", version: "0.0.0" }, { versionNegotiation: { mode: o.era ?? "auto" } });
    try {
      await client.connect(new StreamableHTTPClientTransport(o.url, {
        fetch,
        requestInit: { headers: { Authorization: `Bearer ${o.bearer}` } },
      }));
    } catch (err) {
      await agent?.close().catch(() => undefined);
      throw new Unreachable(`the ${o.what} at ${o.url.origin} could not be reached: ${scrub(causeText(err), o.bearer)}`, certificateFailure(err));
    }
    return new Link(client, o, agent);
  }

  get what(): string {
    return this.o.what;
  }

  /** The MCP revision the session was reached at. */
  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  /** One tool call: its body, its refusal whole, or a held result; anything else is `Lost`. */
  async call(tool: string, args: Body = {}, timeoutMs = 60_000): Promise<Reply> {
    let r: { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
    try {
      r = (await this.client.callTool({ name: tool, arguments: args }, { timeout: timeoutMs })) as typeof r;
    } catch (err) {
      if (err instanceof ProtocolError) {
        const pending = (err.data as Body | undefined)?.pending;
        if (pending === true) return { kind: "held", message: scrub(err.message, this.o.bearer) };
        if (pending === false) throw new NotTaken(`the ${this.o.what}'s ${tool}: nothing was taken: ${scrub(err.message, this.o.bearer)}`);
        throw new Lost(`the ${this.o.what}'s ${tool}: ${scrub(err.message, this.o.bearer)}`, true);
      }
      throw new Lost(`the ${this.o.what}'s ${tool}: ${scrub(causeText(err), this.o.bearer)}`);
    }
    let body = r.structuredContent as Body | undefined;
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (body === undefined && text !== undefined) {
      try {
        body = JSON.parse(text) as Body;
      } catch {
        throw new Lost(`the ${this.o.what}'s ${tool} answered a text that is not JSON`);
      }
    }
    body ??= {};
    if (r.isError) return { kind: "refused", error: String(body.error), message: String(body.message), body };
    return { kind: "ok", body };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.agent?.close().catch(() => undefined);
  }
}

/** An error's message with its causes, so a TLS refusal (the cause of a failed fetch) is said, not just "fetch failed". */
function causeText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 4; i++) {
    const t = errorText(e);
    if (t && !parts.includes(t)) parts.push(t);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(": ") || "no answer";
}
