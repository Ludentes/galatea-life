import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";

/** mpv answered a command with an error string other than "success". */
export class MpvError extends Error {
  constructor(readonly mpvError: string, command: unknown[]) {
    super(`mpv: ${mpvError} (${JSON.stringify(command)})`);
  }
}

export interface PropertyChange { id: number; name: string; data: unknown }
export interface MpvEvent { event: string; [k: string]: unknown }

interface Pending { command: unknown[]; resolve(v: unknown): void; reject(e: Error): void }

/** mpv's JSON IPC over its Unix socket: commands matched by request id, events emitted. */
export class MpvIpc extends EventEmitter {
  #buf = "";
  #next = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  private constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#read(chunk));
    socket.on("close", () => {
      this.#closed = true;
      for (const p of this.#pending.values()) p.reject(new Error("mpv's socket closed"));
      this.#pending.clear();
      this.emit("close");
    });
    socket.on("error", () => { /* "close" follows, and rejects what is pending */ });
  }

  static connect(path: string): Promise<MpvIpc> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve(new MpvIpc(socket));
      });
      socket.once("error", reject);
    });
  }

  command(args: unknown[]): Promise<unknown> {
    // Once closed, nothing would ever answer or reject what is added to the pending map.
    if (this.#closed) return Promise.reject(new Error("mpv's socket closed"));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { command: args, resolve, reject });
      this.socket.write(JSON.stringify({ command: args, request_id: id }) + "\n");
    });
  }

  async observe(id: number, name: string): Promise<void> {
    await this.command(["observe_property", id, name]);
  }

  close(): void {
    this.#closed = true;
    this.socket.destroy();
  }

  #read(chunk: string): void {
    this.#buf += chunk;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Not a line of mpv's protocol: skipped, never thrown out of the socket's handler.
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: Record<string, unknown>): void {
    if (typeof msg.event === "string") {
      if (msg.event === "property-change") {
        this.emit("property", { id: msg.id as number, name: msg.name as string, data: msg.data ?? null });
      } else {
        this.emit("event", msg as MpvEvent);
      }
      return;
    }
    const id = msg.request_id;
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (msg.error === "success") pending.resolve(msg.data ?? null);
    else pending.reject(new MpvError(String(msg.error), pending.command));
  }
}
