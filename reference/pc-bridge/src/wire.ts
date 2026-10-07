import { connect, type IClientOptions, type MqttClient } from "mqtt";

/** A message as the bridge needs it: its retain flag, and the Message Expiry left on delivery. */
export interface Delivery {
  topic: string;
  payload: Buffer;
  retained: boolean;
  expirySeconds?: number;
}

/** The broker refused a subscribe or a publish on `topic` (GA-BRIDGE-20). */
export class Refused extends Error {
  constructor(readonly topic: string, readonly code: number) {
    super(`the broker refused ${topic} (0x${code.toString(16).padStart(2, "0")})`);
  }
}

/** The bridge's side of the broker; the MQTT client in production, a fake in its unit tests. */
export interface Wire {
  /** Whether the client is connected now; while it is not, a publish waits in its queue until it is. */
  connected(): boolean;
  publish(topic: string, payload: unknown, retain: boolean): Promise<void>;
  /** Subscribes with Retain Handling 2 (GA-BRIDGE-19); returns the filters the broker refused (GA-BRIDGE-20). */
  subscribe(filters: string[]): Promise<string[]>;
  /** Unsubscribes and waits for the UNSUBACK (GA-BRIDGE-22). */
  unsubscribe(filters: string[]): Promise<void>;
  onMessage(handler: (d: Delivery) => void): void;
  /** Called on every reconnection the client makes by itself: the session is clean, so the subscriptions need renewing, and the broker fired the will, so `lwt` needs clearing. */
  onReconnect(handler: () => void): void;
  /** A clean disconnect (reason 0x00): the broker discards the will. */
  end(): Promise<void>;
  /** The connection cut with no DISCONNECT, as a frozen or killed process leaves it: the broker publishes the will. */
  drop(): Promise<void>;
  /**
   * Connects again after `end` or `drop`, with the same options and handlers; rejects when this
   * attempt fails, never trying again by itself (the bridge's own backoff does).
   */
  reopen(): Promise<void>;
  /** Cuts a connection attempt still under way, whose `reopen` then rejects; a connection made is left alone. */
  abort(): Promise<void>;
}

export interface MqttWireOptions {
  url: string;
  username: string;
  password?: string;
  ca?: Buffer;
  clientId: string;
  /** The bridge's will on `lwt`; the scripted OS's own connection has none. */
  will?: { topic: string; payload: unknown };
}

/**
 * The filters a SUBACK refused (reason code 0x80 or above), matched by position; a filter the
 * SUBACK gave no code for counts as refused (GA-BRIDGE-20).
 */
export function refusedFilters(filters: string[], codes: readonly number[]): string[] {
  return filters.filter((_, i) => (codes[i] ?? 0x80) >= 0x80);
}

/** MQTT 5: a clean session, keepalive 10 s, the will on `lwt` with no delay (GA-BRIDGE-18). */
export class MqttWire implements Wire {
  private client!: MqttClient;
  private messageHandler?: (d: Delivery) => void;
  private reconnectHandler?: () => void;

  private constructor(private readonly o: MqttWireOptions) {}

  /**
   * The first connection, tried until the broker answers, 1 s, 2 s, 4 s … 60 s apart: a broker not
   * up yet is a recoverable fault, which never makes the bridge exit (GA-BRIDGE-10).
   */
  static async connect(o: MqttWireOptions): Promise<MqttWire> {
    const wire = new MqttWire(o);
    for (let wait = 1000; ; wait = Math.min(wait * 2, 60_000)) {
      try {
        await wire.reopen();
        return wire;
      } catch (err) {
        console.error(`connect: ${err}; trying again in ${wait / 1000} s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async reopen(): Promise<void> {
    const o = this.o;
    // A client still connected or reconnecting would fight the new one (same clientId) for the session.
    if (this.client && !this.client.disconnected) await cut(this.client);
    const opts: IClientOptions = {
      protocolVersion: 5,
      clientId: o.clientId,
      username: o.username,
      keepalive: 10,
      clean: true,
      reconnectPeriod: 1000,
      // The bridge subscribes again itself on a reconnection, before it re-publishes `status` (GA-BRIDGE-18).
      resubscribe: false,
    };
    if (o.will) {
      opts.will = { topic: o.will.topic, payload: Buffer.from(JSON.stringify(o.will.payload)), qos: 1, retain: true,
        properties: { willDelayInterval: 0 } };
    }
    if (o.password !== undefined) opts.password = o.password;
    if (o.ca) opts.ca = o.ca;
    // Held from the start, so that `abort` and `drop` reach an attempt the broker does not answer.
    const client = connect(o.url, opts);
    this.client = client;
    client.on("error", (err) => console.error(`mqtt: ${err.message}`));
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        client.off("connect", ok);
        client.off("error", done);
        client.off("close", closed);
        client.off("end", ended);
        if (!err) return resolve();
        // One attempt only: MQTT.js would otherwise try again every reconnectPeriod, unseen.
        client.end(true);
        reject(err);
      };
      const ok = () => done();
      const closed = () => done(new Error(`could not connect to ${o.url}`));
      const ended = () => done(new Error("the connection attempt was cut"));
      client.on("connect", ok);
      client.on("error", done);
      client.on("close", closed);
      client.on("end", ended);
    });
    client.on("message", (topic, payload, packet) => {
      const expiry = packet.properties?.messageExpiryInterval;
      this.messageHandler?.({ topic, payload, retained: packet.retain,
        ...(expiry !== undefined ? { expirySeconds: expiry } : {}) });
    });
    // The first connect has happened by now, so every later one is a reconnection.
    client.on("connect", () => this.reconnectHandler?.());
  }

  async abort(): Promise<void> {
    if (this.client && !this.client.connected && !this.client.disconnected) await cut(this.client);
  }

  connected(): boolean {
    return this.client.connected;
  }

  async publish(topic: string, payload: unknown, retain: boolean): Promise<void> {
    const body = payload === "" ? "" : JSON.stringify(payload);
    try {
      await this.client.publishAsync(topic, body, { qos: 1, retain });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number" && code >= 0x80) throw new Refused(topic, code);
      throw err;
    }
  }

  async subscribe(filters: string[]): Promise<string[]> {
    try {
      await this.client.subscribeAsync(filters, { qos: 1, rh: 2 });
      return [];
    } catch (err) {
      // MQTT.js rejects the whole subscribe when any reason code is a refusal, carrying the SUBACK.
      const codes = (err as { packet?: { granted?: unknown } }).packet?.granted;
      if (Array.isArray(codes) && codes.every((c) => typeof c === "number")) return refusedFilters(filters, codes);
      throw err;
    }
  }

  async unsubscribe(filters: string[]): Promise<void> {
    await this.client.unsubscribeAsync(filters);
  }

  onMessage(handler: (d: Delivery) => void): void {
    this.messageHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  async end(): Promise<void> {
    await this.client.endAsync();
  }

  async drop(): Promise<void> {
    // Forced: the stream is destroyed with no DISCONNECT packet, so the broker fires the will.
    await cut(this.client);
  }
}

/**
 * Ends a client at once, rejecting every publish still waiting on it. MQTT.js keeps a QoS 1
 * publish pending across a forced end unless it will never reconnect, so the handler awaiting it
 * would wait forever, and every later leave with it. A clean end already under way (waiting for
 * those publishes) is not ended again by MQTT.js: its stream is destroyed here instead.
 */
async function cut(client: MqttClient): Promise<void> {
  client.options.reconnectPeriod = 0;
  if (!client.disconnecting) {
    await client.endAsync(true);
    return;
  }
  for (const [id, pending] of Object.entries(client.outgoing)) {
    delete client.outgoing[Number(id)];
    pending.cb?.(new Error("Connection closed"));
  }
  client.stream?.destroy();
}
