import { readFileSync } from "node:fs";
import { connectAsync, type IClientOptions, type MqttClient } from "mqtt";

/** A message as the relay needs it: its retain flag, and the Message Expiry left on delivery. */
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

/** The relay's side of the broker; the MQTT client in production, a fake in its unit tests. */
export interface Wire {
  /** Whether the client is connected now; while it is not, a publish waits in its queue until it is. */
  connected(): boolean;
  publish(topic: string, payload: unknown, retain: boolean): Promise<void>;
  /** Subscribes with Retain Handling 2 (GA-BRIDGE-19); returns the filters the broker refused (GA-BRIDGE-20). */
  subscribe(filters: string[]): Promise<string[]>;
  /** Unsubscribes and waits for the UNSUBACK (GA-BRIDGE-22). */
  unsubscribe(filters: string[]): Promise<void>;
  onMessage(handler: (d: Delivery) => void): void;
  /** Called on every reconnection after the first connect: the session is clean, so the subscriptions need renewing, and the broker fired the will, so `lwt` needs clearing. */
  onReconnect(handler: () => void): void;
  /** A clean disconnect (reason 0x00): the broker discards the will; waits for what is unacknowledged. */
  end(): Promise<void>;
  /** The connection cut with no DISCONNECT and nothing waited for: the broker publishes the will. */
  drop(): Promise<void>;
}

export interface MqttWireOptions {
  url: string;
  username: string;
  password?: string;
  ca?: Buffer;
  clientId: string;
  will: { topic: string; payload: unknown };
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
  private constructor(private readonly client: MqttClient) {}

  static async connect(o: MqttWireOptions): Promise<MqttWire> {
    const opts: IClientOptions = {
      protocolVersion: 5,
      clientId: o.clientId,
      username: o.username,
      keepalive: 10,
      clean: true,
      reconnectPeriod: 1000,
      // The relay subscribes again itself on a reconnection, before it re-publishes `status` (GA-BRIDGE-18).
      resubscribe: false,
      will: { topic: o.will.topic, payload: Buffer.from(JSON.stringify(o.will.payload)), qos: 1, retain: true,
        properties: { willDelayInterval: 0 } },
    };
    if (o.password !== undefined) opts.password = o.password;
    if (o.ca) opts.ca = o.ca;
    const client = await connectAsync(o.url, opts);
    client.on("error", (err) => console.error(`mqtt: ${err.message}`));
    return new MqttWire(client);
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
    this.client.on("message", (topic, payload, packet) => {
      const expiry = packet.properties?.messageExpiryInterval;
      handler({ topic, payload, retained: packet.retain, ...(expiry !== undefined ? { expirySeconds: expiry } : {}) });
    });
  }

  /** The first connect has happened by the time `connect` resolves, so every later one is a reconnection. */
  onReconnect(handler: () => void): void {
    this.client.on("connect", () => handler());
  }

  async end(): Promise<void> {
    await this.client.endAsync();
  }

  /**
   * Ends the client at once, rejecting every publish still waiting on it. MQTT.js keeps a QoS 1
   * publish pending across a forced end unless it will never reconnect, so the handler awaiting it
   * would wait forever. A clean end already under way (waiting for those publishes) is not ended
   * again by MQTT.js: its stream is destroyed here instead.
   */
  async drop(): Promise<void> {
    const client = this.client;
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
}

export function readSecret(path: string | undefined): string | undefined {
  return path === undefined ? undefined : readFileSync(path, "utf8").trim();
}
