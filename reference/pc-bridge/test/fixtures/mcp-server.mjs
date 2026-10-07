// A plugin's MCP server whose behaviour the test sets: the PC bridge's own test server (plan 3d).
// Imported by the tests to serve in-process over a pair of streams, and run as a package's server
// (`node server.mjs`), where `fixture.json` beside it names the test's control port.
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { inputRequired, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const MODERN = "2026-07-28";

/**
 * What the server does, all of it the test's to set:
 * - `era`: `both` (the SDK's `serveStdio`, which answers either) or `legacy` (a plain `connect`, 2025 only);
 * - `tools`: what `tools/list` answers; `listChanged`: whether it offers tool changes;
 * - `state`: each resource's content, an object (served as JSON) or a string (served as it is);
 *   `subscribe`: whether it offers resource subscriptions (2025) and honours them (both eras);
 *   `hang`, offered but never acknowledged (`resources/subscribe`, `subscriptions/listen`);
 * - `readFails`: how many reads fail first, with an error (`Infinity`: it never serves);
 * - `calls`: by tool, `{ result, text, sets }`: `ok`, `error` (isError), `sdk-input` (the SDK's own
 *   input request), `raw-elicit` and `raw-sampling` (a 2025 request to the client), `raw-input` (a
 *   2026 `input_required` result), `hang`; `sets` names a resource the call's arguments are merged into;
 * - `exitAtStart`: exit with this code before any answer.
 */
export const DEFAULTS = {
  era: "both", tools: [], listChanged: true, state: {}, subscribe: true, readFails: 0, calls: {}, exitAtStart: undefined,
};

export class Fixture {
  constructor(behaviour = {}) {
    this.b = { ...DEFAULTS, ...structuredClone(behaviour) };
    /** Every call and read, as the test reads them back. */
    this.log = [];
    /** The answers the client gave to the requests this server sent it. */
    this.answers = [];
    this.instances = new Set();
    this.hung = false;
    /** Input held while the server sleeps with the OS, read when it wakes. */
    this.held = undefined;
    this.nextRaw = 1;
  }

  /** Serves one connection on `stdin`/`stdout`; `exit(code)` ends the process (or its in-process stand-in). */
  serve(stdin, stdout, exit) {
    this.exit = exit;
    if (this.b.exitAtStart !== undefined) {
      setImmediate(() => exit(this.b.exitAtStart));
      return { close: async () => {} };
    }
    // A hung server reads nothing more: its input is dropped from the moment it hangs. A sleeping
    // one reads nothing until it wakes, then all of it.
    const gate = new Transform({ transform: (chunk, _enc, done) => {
      if (this.held) this.held.push(chunk);
      done(null, this.hung || this.held ? undefined : chunk);
    } });
    this.gate = gate;
    stdin.pipe(gate);
    const transport = new Intercept(new StdioServerTransport(gate, stdout), this);
    transport.onEnded = () => exit(0);
    if (this.b.era === "legacy") {
      const server = this.instance();
      void server.connect(transport);
      return { close: () => server.close() };
    }
    return serveStdio(() => this.instance(), { transport });
  }

  /** One server instance, as `serveStdio` makes one per connection. */
  instance() {
    const server = new Server({ name: "org.example.fixture", version: "1.0.0" },
      { capabilities: { tools: { listChanged: this.b.listChanged }, resources: { subscribe: Boolean(this.b.subscribe) } } });
    const subscribed = new Set();
    this.instances.add({ server, subscribed });
    server.setRequestHandler("tools/list", async () => ({ tools: this.b.tools }));
    server.setRequestHandler("tools/call", async (req) => {
      const { name } = req.params;
      const args = req.params.arguments ?? {};
      this.log.push({ call: name, args });
      const c = this.b.calls[name] ?? { result: "ok" };
      if (c.result === "hang") return new Promise(() => {});
      if (c.result === "error") return { isError: true, content: [{ type: "text", text: c.text ?? "it failed" }] };
      if (c.result === "sdk-input") {
        return inputRequired({ inputRequests: { confirm: inputRequired.elicit({ message: "Sure?", requestedSchema: { type: "object", properties: {} } }) } });
      }
      if (c.sets) this.set(c.sets, { ...(typeof this.b.state[c.sets] === "object" ? this.b.state[c.sets] : {}), ...args });
      return { content: [{ type: "text", text: c.text ?? "done" }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
    });
    server.setRequestHandler("resources/read", async (req) => {
      const { uri } = req.params;
      this.log.push({ read: uri });
      if (this.b.readFails > 0) {
        this.b.readFails -= 1;
        throw new ProtocolError(ProtocolErrorCode.InternalError, "not ready yet");
      }
      if (!Object.hasOwn(this.b.state, uri)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `unknown resource: ${uri}`);
      const v = this.b.state[uri];
      return { contents: [{ uri, mimeType: "application/json", text: typeof v === "string" ? v : JSON.stringify(v) }] };
    });
    if (this.b.subscribe) {
      server.setRequestHandler("resources/subscribe", async (req) => {
        subscribed.add(req.params.uri);
        return {};
      });
      server.setRequestHandler("resources/unsubscribe", async (req) => {
        subscribed.delete(req.params.uri);
        return {};
      });
    }
    return server;
  }

  /** A resource's content changes, and each connection that listens for it is told. */
  set(uri, value) {
    this.b.state[uri] = value;
    for (const { server, subscribed } of this.instances) {
      const era = server.getNegotiatedProtocolVersion();
      if (era === undefined || !this.b.subscribe) continue;
      if (era < MODERN && !subscribed.has(uri)) continue;
      server.sendResourceUpdated({ uri }).catch(() => {});
    }
  }

  /** Its tools change, announced (`notifications/tools/list_changed`) or not. */
  setTools(tools, announce) {
    this.b.tools = tools;
    if (!announce) return;
    for (const { server } of this.instances) server.sendToolListChanged().catch(() => {});
  }

  /** Changes what a later call or read does. */
  behave(over) {
    Object.assign(this.b, over);
  }

  /** Stops answering anything, the process still running. */
  hang() {
    this.hung = true;
  }

  /** Sleeps with the OS: reads nothing until `wake`. */
  sleep() {
    this.held ??= [];
  }

  /** Wakes: reads what came while it slept. */
  wake() {
    const held = this.held ?? [];
    this.held = undefined;
    for (const chunk of held) this.gate?.push(chunk);
  }

  crash(code = 1) {
    this.exit(code);
  }

  /** Writes more than the bridge's 10 MB ceiling with no end of line. */
  flood() {
    this.raw?.(Buffer.alloc(11 * 1024 * 1024, 0x61));
  }
}

/** The server's transport, with the raw exchanges the SDK would not make: a 2025 request for input, a 2026 `input_required`. */
class Intercept {
  constructor(inner, fixture) {
    this.inner = inner;
    this.f = fixture;
    this.pending = new Map();
    fixture.raw = (buf) => inner._stdout.write(buf);
    inner.onclose = () => {
      this.onclose?.();
      this.onEnded?.();
    };
    inner.onerror = (e) => this.onerror?.(e);
    inner.onmessage = (m, extra) => {
      if (this.intercept(m)) return;
      this.onmessage?.(m, extra);
    };
  }

  start() { return this.inner.start(); }
  send(m, o) { return this.inner.send(m, o); }
  close() { return this.inner.close(); }
  get setProtocolVersion() { return this.inner.setProtocolVersion?.bind(this.inner); }
  get setSupportedProtocolVersions() { return this.inner.setSupportedProtocolVersions?.bind(this.inner); }

  intercept(m) {
    // A subscription never acknowledged.
    if (this.f.b.subscribe === "hang" && (m.method === "resources/subscribe" || m.method === "subscriptions/listen")) return true;
    // The client's answer to a request this fixture sent raw.
    if (m.id !== undefined && this.pending.has(m.id) && m.method === undefined) {
      const callId = this.pending.get(m.id);
      this.pending.delete(m.id);
      this.f.answers.push(m);
      // The tool acted anyway, after the refusal.
      void this.inner.send({ jsonrpc: "2.0", id: callId, result: { content: [{ type: "text", text: "acted anyway" }] } });
      return true;
    }
    if (m.method !== "tools/call") return false;
    const c = this.f.b.calls[m.params?.name];
    if (!c || !["raw-elicit", "raw-sampling", "raw-input"].includes(c.result)) return false;
    this.f.log.push({ call: m.params.name, args: m.params.arguments ?? {} });
    if (c.result === "raw-input") {
      void this.inner.send({ jsonrpc: "2.0", id: m.id, result: { resultType: "input_required",
        inputRequests: { confirm: { method: "elicitation/create", params: { mode: "form", message: "Sure?", requestedSchema: { type: "object", properties: {} } } } } } });
      return true;
    }
    const id = `fixture-${this.f.nextRaw++}`;
    this.pending.set(id, m.id);
    const request = c.result === "raw-elicit"
      ? { method: "elicitation/create", params: { message: "Sure?", requestedSchema: { type: "object", properties: {} } } }
      : { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "hi" } }], maxTokens: 10 } };
    void this.inner.send({ jsonrpc: "2.0", id, ...request });
    return true;
  }
}

// Run as a package's server: the behaviour and the control port from fixture.json; the test drives
// it over that connection, one JSON line per method call, and reads how it was started.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const { control, behaviour } = JSON.parse(readFileSync(join(here, "fixture.json"), "utf8"));
  const fixture = new Fixture(behaviour);
  const socket = connect(control, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(JSON.stringify({ started: { pid: process.pid, env: process.env, argv: process.argv.slice(1), cwd: process.cwd() } }) + "\n");
  socket.unref();
  let buf = "";
  socket.on("data", (d) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const { method, args } = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      fixture[method](...(args ?? []));
    }
  });
  fixture.serve(process.stdin, process.stdout, (code) => process.exit(code));
}
