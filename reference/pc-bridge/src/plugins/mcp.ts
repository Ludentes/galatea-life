import { createHash } from "node:crypto";
import {
  Client, type JSONRPCMessage, ProtocolError, ProtocolErrorCode, ReadBuffer, SdkError, SdkErrorCode, serializeMessage, STDIO_DEFAULT_MAX_BUFFER_SIZE,
  type Transport,
} from "@modelcontextprotocol/client";
import canonicalize from "canonicalize";
import { capText } from "./state.js";
import type { ServerProcess } from "../port.js";

/** The first MCP revision without `initialize`, `ping` and `resources/subscribe` (`server/discover`, `subscriptions/listen`). */
export const MODERN_ERA = "2026-07-28";
/** A stdio server that answers no `server/discover` within this is a 2025-era one (the SDK's probe; real time, at connect only). */
export const PROBE_MS = 10_000;
/** No SDK timeout of its own: every bound is the caller's, on the core's clock, through the signal it passes. */
const NO_TIMEOUT = 2_147_483_647;
/** How many pages of `tools/list` are read before the list counts as a mismatch: more tools than any manifest may name. */
const TOOLS_PAGES = 8;
/** The requests by which a 2025-era server asks for input (GA-BRIDGE-47). */
const INPUT_REQUESTS = new Set(["elicitation/create", "sampling/createMessage"]);
/** An SDK-built server's own refusal of a tool that asks a client with no such capability for input. */
const MISSING_CLIENT_CAPABILITY = -32021;

/** The fields of a tool that the manifest's `toolHashes` pin (GA-BRIDGE-44). */
const HASHED = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

/**
 * A tool's hash as the manifest carries it: SHA-256, lowercase hex, over the RFC 8785 canonical JSON
 * of those of its `name`, `title`, `description`, `inputSchema`, `outputSchema` and `annotations`
 * it has, read from the wire as the server sent them (the SDK's parsed view drops fields it does not
 * know, which would hide a change).
 */
export function toolHash(tool: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const k of HASHED) if (tool[k] !== undefined) picked[k] = tool[k];
  return createHash("sha256").update(canonicalize(picked)!).digest("hex");
}

/** At most this many of a mismatch's problems are named, the rest counted. */
export const MISMATCH_NAMED = 5;
/** A tool's name as a mismatch names it: the server's own text, cut. */
const NAME_MAX_BYTES = 64;

/**
 * The live tools against the manifest's `toolHashes`: a live tool it does not name, one it names
 * and the server lacks, a tool listed twice, or a changed hash is a mismatch (GA-BRIDGE-44). Null
 * when they agree, else what differs: the first MISMATCH_NAMED problems, each tool's name cut, the
 * rest counted, the whole within 1 KiB, since the text is the server's and goes into the record,
 * every status's faults and acks.
 */
export function compareTools(live: Record<string, unknown>[], pinned: Record<string, string>): string | null {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const t of live) {
    const name = typeof t.name === "string" ? t.name : String(JSON.stringify(t.name));
    const shown = capText(name, NAME_MAX_BYTES);
    if (seen.has(name)) problems.push(`tool ${shown} is listed twice`);
    seen.add(name);
    if (!Object.hasOwn(pinned, name)) problems.push(`tool ${shown} is not in the manifest`);
    else if (toolHash(t) !== pinned[name]) problems.push(`tool ${shown} is not the one the manifest pins`);
  }
  for (const name of Object.keys(pinned)) if (!seen.has(name)) problems.push(`tool ${name} is missing`);
  if (!problems.length) return null;
  const more = problems.length > MISMATCH_NAMED ? `; and ${problems.length - MISMATCH_NAMED} more` : "";
  return capText(problems.slice(0, MISMATCH_NAMED).join("; ") + more);
}

/**
 * The bridge's own stdio transport over a server's pipes (never the SDK's, which spawns the server
 * itself, and a second time to probe the era): newline-delimited JSON-RPC, a message over the
 * 10 MB ceiling closing it as a flood. It also keeps the raw `tools` of each `tools/list` answer,
 * so that the tools are hashed as the server wrote them.
 */
export class StreamTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  /** Why it closed, once it has: `flood`, the server's output ended, or the bridge closed it. */
  closedBy?: string;
  private readonly buffer: ReadBuffer;
  private readonly listIds = new Set<string | number>();
  /** The raw tools of each `tools/list` answer since `takeTools`. */
  private tools: Record<string, unknown>[][] = [];
  private readonly onData = (chunk: Buffer) => this.read(chunk);
  private readonly onEnd = () => void this.shut("the server's output ended");

  constructor(private readonly p: Pick<ServerProcess, "stdin" | "stdout">, maxMessageBytes = STDIO_DEFAULT_MAX_BUFFER_SIZE) {
    this.buffer = new ReadBuffer({ maxBufferSize: maxMessageBytes });
  }

  async start(): Promise<void> {
    this.p.stdout.on("data", this.onData);
    this.p.stdout.on("end", this.onEnd);
    this.p.stdout.on("close", this.onEnd);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closedBy !== undefined) throw new Error(`the transport is closed: ${this.closedBy}`);
    if ("method" in message && "id" in message && message.method === "tools/list") this.listIds.add(message.id);
    await new Promise<void>((resolve, reject) => {
      this.p.stdin.write(serializeMessage(message), (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    await this.shut("closed by the bridge");
  }

  /** The raw tools of every `tools/list` answer since the last take. */
  takeTools(): Record<string, unknown>[] {
    const all = this.tools.flat();
    this.tools = [];
    return all;
  }

  private read(chunk: Buffer): void {
    if (this.closedBy !== undefined) return;
    try {
      this.buffer.append(chunk);
    } catch (err) {
      // Over the ceiling with no end of line: a flood, treated as a server that stopped (GA-BRIDGE-58).
      this.onerror?.(err as Error);
      void this.shut("flood");
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (err) {
        // A line that is JSON but no JSON-RPC message: reported, and the next one read.
        this.onerror?.(err as Error);
        continue;
      }
      if (message === null) return;
      if ("id" in message && message.id !== undefined && this.listIds.delete(message.id) && "result" in message) {
        const tools = (message.result as { tools?: unknown }).tools;
        if (Array.isArray(tools)) this.tools.push(tools.filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null));
      }
      this.onmessage?.(message);
      if (this.closedBy !== undefined) return;
    }
  }

  private async shut(why: string): Promise<void> {
    if (this.closedBy !== undefined) return;
    this.closedBy = why;
    this.p.stdout.off("data", this.onData);
    this.p.stdout.off("end", this.onEnd);
    this.p.stdout.off("close", this.onEnd);
    this.buffer.clear();
    this.p.stdin.end();
    this.onclose?.();
  }
}

/** What a tool call came to: its text, `isError` with its text, a request for input (GA-BRIDGE-47), or a protocol failure. */
export type ToolOutcome =
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string }
  | { kind: "input"; text: string }
  | { kind: "failed"; text: string };

export interface McpSessionOptions {
  /** The era found at an earlier start and kept with the version: a 2025 one is not probed again. */
  era?: string;
  /** The server announced a change of its tools (`notifications/tools/list_changed`). */
  onToolsChanged(): void;
  /** The server announced a change of a resource (`notifications/resources/updated`). */
  onResourceUpdated(uri: string): void;
  /** The server sent a request for input (elicitation or sampling), refused here and never relayed. */
  onInputRequest(method: string): void;
  /** The connection closed: the server's output ended, a flood, or the bridge closed it. */
  onClosed(why: string): void;
}

/**
 * The bridge as the MCP client of one server (GA-BRIDGE-44, GA-BRIDGE-47): both eras (`auto`
 * version negotiation over the bridge's own transport, which probes in place and starts nothing),
 * no `elicitation` or `sampling` capability, `input_required` never fulfilled, every request from
 * the server refused. No SDK timeout: each call takes the caller's signal, on the core's clock.
 */
export class McpSession {
  private readonly client: Client;
  private readonly transport: StreamTransport;
  /** A request for input came while these tool calls ran: each ends `input`. */
  private readonly calls = new Set<{ asked: boolean }>();
  private listening?: { close(): Promise<void> };
  private toolsChain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly o: McpSessionOptions, p: Pick<ServerProcess, "stdin" | "stdout">, maxMessageBytes?: number) {
    this.transport = new StreamTransport(p, maxMessageBytes);
    this.client = new Client({ name: "galatea-pc-bridge", version: "0.1.0" }, {
      capabilities: {},
      versionNegotiation: { mode: "auto", probe: { timeoutMs: PROBE_MS } },
      inputRequired: { autoFulfill: false },
      listMaxPages: TOOLS_PAGES,
    });
    this.client.fallbackRequestHandler = async (request) => {
      if (INPUT_REQUESTS.has(request.method)) {
        for (const c of this.calls) c.asked = true;
        o.onInputRequest(request.method);
      }
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `the bridge answers no ${request.method}`);
    };
    this.client.setNotificationHandler("notifications/tools/list_changed", async () => o.onToolsChanged());
    this.client.setNotificationHandler("notifications/resources/updated", async (n) => o.onResourceUpdated(n.params.uri));
    this.client.onerror = (err) => console.error(`mcp: ${err.message ?? err}`);
    this.transport.onclose = undefined;
  }

  /**
   * Connects over the server's pipes: resolves once the server has started (its first successful
   * answer to `initialize`, or to `server/discover` from 2026-07-28), rejects when it closed first
   * or `signal` aborted.
   */
  static async connect(p: Pick<ServerProcess, "stdin" | "stdout">, o: McpSessionOptions, signal: AbortSignal, maxMessageBytes?: number): Promise<McpSession> {
    const s = new McpSession(o, p, maxMessageBytes);
    // The client wraps the transport's onclose on connect: the session's own watcher goes on top of it.
    const connected = s.client.connect(s.transport, {
      signal, timeout: NO_TIMEOUT, ...(o.era !== undefined && o.era < MODERN_ERA ? { prior: { kind: "legacy" as const } } : {}),
    });
    // The SDK's era probe keeps its own time: an abort closes the transport, which ends whatever step the handshake is at.
    const cut = () => void s.transport.close();
    signal.addEventListener("abort", cut, { once: true });
    try {
      await connected;
    } catch (err) {
      await s.transport.close().catch(() => {});
      throw err;
    } finally {
      signal.removeEventListener("abort", cut);
    }
    if (signal.aborted) {
      await s.transport.close().catch(() => {});
      throw signal.reason ?? new Error("aborted");
    }
    const inner = s.transport.onclose;
    s.transport.onclose = () => {
      inner?.();
      o.onClosed(s.transport.closedBy ?? "closed");
    };
    // Closed during the handshake's last turn: told now.
    if (s.transport.closedBy !== undefined) o.onClosed(s.transport.closedBy);
    return s;
  }

  /** The revision negotiated: `2025-11-25` or earlier, or `2026-07-28` on. */
  get era(): string {
    return this.client.getNegotiatedProtocolVersion() ?? "unknown";
  }

  get modern(): boolean {
    return this.era >= MODERN_ERA;
  }

  get closedBy(): string | undefined {
    return this.transport.closedBy;
  }

  /** The live tools, as the server wrote them, compared with the pinned hashes: null when they agree (GA-BRIDGE-44). */
  checkTools(pinned: Record<string, string>, signal: AbortSignal): Promise<string | null> {
    const run = this.toolsChain.then(async () => {
      this.transport.takeTools();
      await this.client.listTools(undefined, { signal, timeout: NO_TIMEOUT, cacheMode: "refresh" });
      return compareTools(this.transport.takeTools(), pinned);
    });
    this.toolsChain = run.catch(() => {});
    return run;
  }

  /**
   * Subscribes to the state resources and to tool changes where the server offers them:
   * `resources/subscribe` for each before 2026-07-28, one `subscriptions/listen` from it on. True
   * when change notifications for the resources will come; the cadence read carries the state either
   * way (*State*).
   */
  async subscribe(uris: string[], signal: AbortSignal): Promise<boolean> {
    if (this.modern) {
      const sub = await this.client.listen({ toolsListChanged: true, resourceSubscriptions: uris }, { signal, timeout: NO_TIMEOUT });
      this.listening = sub;
      return (sub.honoredFilter.resourceSubscriptions ?? []).length > 0;
    }
    if (!this.client.getServerCapabilities()?.resources?.subscribe) return false;
    for (const uri of uris) await this.client.subscribeResource({ uri }, { signal, timeout: NO_TIMEOUT });
    return true;
  }

  /** A state resource's text: the first text content of `resources/read`, never from the SDK's cache. */
  async read(uri: string, signal: AbortSignal): Promise<string> {
    const r = await this.client.readResource({ uri }, { signal, timeout: NO_TIMEOUT, cacheMode: "bypass" });
    const text = r.contents.find((c): c is typeof c & { text: string } => "text" in c && typeof c.text === "string");
    if (!text) throw new Error(`${uri} has no text content`);
    return text.text;
  }

  /** The probe of a server that has served: `ping` before 2026-07-28, `server/discover` from it (GA-BRIDGE-58). */
  async probe(signal: AbortSignal): Promise<void> {
    if (this.modern) await this.client.discover({ signal, timeout: NO_TIMEOUT });
    else await this.client.ping({ signal, timeout: NO_TIMEOUT });
  }

  /**
   * Calls a tool (GA-BRIDGE-46: the caller calls only the manifest's tool for a command's action).
   * Only text content is kept; image, audio and embedded resources are dropped. A request for input
   * while it ran, an `input_required` result, or an SDK server's own `-32021` refusal of one, is
   * `input` (GA-BRIDGE-47); any other protocol failure is `failed`: the tool may have run either way.
   */
  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolOutcome> {
    const call = { asked: false };
    this.calls.add(call);
    try {
      const r = await this.client.callTool({ name, arguments: args }, { signal, timeout: NO_TIMEOUT });
      const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text).join("\n");
      if (call.asked) return { kind: "input", text: "the tool asked for input, which the bridge never relays" };
      return r.isError ? { kind: "error", text } : { kind: "ok", text };
    } catch (err) {
      if (call.asked || (err instanceof SdkError && err.code === SdkErrorCode.UnsupportedResultType)
        || (err instanceof ProtocolError && err.code === MISSING_CLIENT_CAPABILITY)) {
        return { kind: "input", text: "the tool asked for input, which the bridge never relays" };
      }
      return { kind: "failed", text: String((err as Error).message ?? err) };
    } finally {
      this.calls.delete(call);
    }
  }

  /**
   * Ends the connection, waiting on nothing the server does: the transport first, which ends the
   * server's input and fails every request still open, so that neither the client's close nor the
   * subscription's, which asks the server to cancel it, can wait on a server that died meanwhile.
   */
  async close(): Promise<void> {
    const listening = this.listening;
    this.listening = undefined;
    await this.transport.close();
    await this.client.close().catch(() => {});
    void listening?.close().catch(() => {});
  }
}
