import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** A stand-in for mpv's JSON IPC server: enough of it to drive the player's tests exactly. */
export class FakeMpv {
  readonly received: unknown[][] = [];
  readonly props = new Map<string, unknown>([
    ["pause", false], ["volume", 100], ["idle-active", true], ["media-title", null],
  ]);
  loadDelayMs = 10;
  failLoad = false;
  failLoadCommand = false;
  silent = false;
  #clients = new Set<Socket>();
  #observed = new Map<string, number[]>();

  private constructor(readonly path: string, private readonly server: Server) {}

  static async start(): Promise<FakeMpv> {
    const path = join(mkdtempSync(join(tmpdir(), "fake-mpv-")), "sock");
    const server = createServer();
    const fake = new FakeMpv(path, server);
    server.on("connection", (s) => fake.#accept(s));
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return fake;
  }

  emit(msg: object): void {
    const line = JSON.stringify(msg) + "\n";
    for (const c of this.#clients) c.write(line);
  }

  /** A raw line, as is: for a line mpv would never send. */
  emitRaw(line: string): void {
    for (const c of this.#clients) c.write(line);
  }

  /** The player changing a property by itself, as a person at the keyboard would. */
  setProp(name: string, value: unknown): void {
    this.props.set(name, value);
    for (const id of this.#observed.get(name) ?? []) {
      this.emit({ event: "property-change", id, name, data: value });
    }
  }

  async close(): Promise<void> {
    for (const c of this.#clients) c.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  #accept(socket: Socket): void {
    this.#clients.add(socket);
    socket.on("close", () => this.#clients.delete(socket));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.#handle(socket, JSON.parse(line) as { command: unknown[]; request_id?: number });
      }
    });
  }

  #reply(socket: Socket, id: number | undefined, error: string, data?: unknown): void {
    socket.write(JSON.stringify({ error, data, request_id: id ?? 0 }) + "\n");
  }

  #handle(socket: Socket, msg: { command: unknown[]; request_id?: number }): void {
    const [name, ...args] = msg.command;
    this.received.push(msg.command);
    if (this.silent) return;
    switch (name) {
      case "observe_property": {
        const [id, prop] = args as [number, string];
        this.#observed.set(prop, [...(this.#observed.get(prop) ?? []), id]);
        this.#reply(socket, msg.request_id, "success");
        this.emit({ event: "property-change", id, name: prop, data: this.props.get(prop) ?? null });
        return;
      }
      case "get_property": {
        const prop = args[0] as string;
        if (!this.props.has(prop)) return this.#reply(socket, msg.request_id, "property not found");
        return this.#reply(socket, msg.request_id, "success", this.props.get(prop));
      }
      case "set_property": {
        const [prop, value] = args as [string, unknown];
        this.#reply(socket, msg.request_id, "success");
        this.setProp(prop, value);
        return;
      }
      case "loadfile": {
        const file = args[0] as string;
        if (this.failLoadCommand) {
          this.#reply(socket, msg.request_id, "error");
          return;
        }
        this.#reply(socket, msg.request_id, "success");
        this.emit({ event: "start-file" });
        setTimeout(() => {
          if (this.failLoad) {
            this.emit({ event: "end-file", reason: "error" });
            return;
          }
          this.setProp("idle-active", false);
          this.setProp("media-title", basename(file));
          this.emit({ event: "file-loaded" });
        }, this.loadDelayMs);
        return;
      }
      default:
        this.#reply(socket, msg.request_id, "invalid parameter");
    }
  }
}
