import { expect } from "vitest";
import { Applier, type BusPort, type ToolResult } from "../src/applier.js";
import type { Puback } from "../src/bus/client.js";
import { Store } from "../src/core/store.js";
import { proofOf } from "../src/gate/token.js";
import type { Mutation } from "../src/mutations.js";
import { memoryDb } from "./db.js";
import { FakeClock } from "./fake-clock.js";

export const OWNER = "owner-credential";
export const T = "2030-01-01T08:00:00.000Z";
export const body = (r: ToolResult) => { if (!r.ok) throw new Error(`${r.error}: ${r.message}`); return r.body as Record<string, any>; };

export type Sent = { bridge: string; device: string; body: Record<string, any> };

function fakeBus() {
  const sent: Sent[] = [];
  const bus: BusPort = { follow: () => undefined, snapshot: async () => ({ kind: "ok" }), request: async () => ({ kind: "ok" }),
    command: (b, device, cmd) => { sent.push({ bridge: b.id, device, body: cmd }); return Promise.resolve<Puback>({ kind: "ok" }); } };
  return { bus, sent };
}

const alone = { otherAdmins: [] };
export const leak = { id: "leak", stableIdentifier: "test:leak", transport: "radio", capabilities: ["sensor"], sensorKeys: ["leak"], actions: [],
  feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", ...alone };
export const V = "org.galatea.test.vendor";
/** The valve's own countdown, an extension action whose effect the applier cannot know (GA-SAFE-7). */
export const COUNTDOWN = `${V}.countdown`;
const valve = { id: "valve", stableIdentifier: "test:valve", transport: "radio", capabilities: ["valve"], actions: [
  { action: "valve.open", idempotent: true, stateless: false, confirms: true },
  { action: "valve.close", idempotent: true, stateless: false, confirms: true },
  { action: COUNTDOWN, idempotent: false, stateless: true, confirms: true }],
extensions: [{ capability: V, actions: [{ action: COUNTDOWN, schema: { type: "object" } }], keys: [] }],
feedback: "closed", reachMs: 0, proposedClass: "water_valve", classEvidence: "protocol", ...alone };
// A momentary relay: each command one pulse, never idempotent (GA-SAFE-5).
export const pulse = { id: "pulse", stableIdentifier: "test:pulse", transport: "radio", capabilities: ["onoff"], actions: [
  { action: "onoff.turn_off", idempotent: false, stateless: false, confirms: true }],
feedback: "closed", reachMs: 0, proposedClass: "socket", classEvidence: "protocol", ...alone };
const tv = { id: "tv", stableIdentifier: "test:tv", transport: "radio", capabilities: ["onoff"], actions: [
  { action: "onoff.turn_off", idempotent: false, stateless: false, confirms: false, toggles: true }],
feedback: "open", reachMs: 0, proposedClass: "tv", classEvidence: "protocol", ...alone };
const ac = { id: "ac", stableIdentifier: "test:ac", transport: "radio", capabilities: ["climate"], actions: [
  { action: "climate.set_mode", idempotent: true, stateless: false, confirms: false }],
feedback: "open", reachMs: 0, proposedClass: "ac", classEvidence: "protocol", ...alone };
const button = { id: "button", stableIdentifier: "test:button", transport: "radio", capabilities: ["sensor"], sensorKeys: ["battery"], actions: [],
  extensions: [{ capability: V, actions: [], keys: [{ key: `${V}.press`, kind: "event", schema: { type: "string" } }] }],
  feedback: "closed", reachMs: 0, proposedClass: "sensor", classEvidence: "protocol", ...alone };
const shared = { ...valve, id: "shared", stableIdentifier: "test:shared", otherAdmins: "unknown" };
// A thermostat that reports its mode, and takes only some of the vocabulary's: its own args (M2).
export const thermo = { id: "thermo", stableIdentifier: "test:thermo", transport: "radio", capabilities: ["climate"], actions: [
  { action: "climate.set_mode", idempotent: true, stateless: false, confirms: true, args: { mode: ["heat", "off"] } }],
feedback: "closed", reachMs: 0, proposedClass: "ac", classEvidence: "protocol", ...alone };
export const DEVICES = [leak, valve, pulse, tv, ac, button, shared, thermo];
// A plug whose turn_on and turn_off are discrete and idempotent: a heater's socket (GA-LOAD-2).
export const heater = { id: "heater", stableIdentifier: "test:heater", transport: "radio", capabilities: ["onoff"], actions: [
  { action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true },
  { action: "onoff.turn_off", idempotent: true, stateless: false, confirms: true }],
feedback: "closed", reachMs: 0, proposedClass: "socket", classEvidence: "protocol", ...alone };
// A radio plug that reports nothing: its codes are discrete, so it can be capped (applier, *Loads*).
export const rf = { ...heater, id: "rf", stableIdentifier: "test:rf", feedback: "open",
  actions: heater.actions.map((a) => ({ ...a, confirms: false })) };
export const status = (ids: string[], extra: Record<string, unknown> = {}) => ({ bridgeId: "hall-bridge", instanceId: "11111111-1111-4111-8111-111111111111",
  v: 1, state: "online", version: "1", levels: ["Serve"], faults: [], ungoverned: [], blocked: [],
  transports: [{ id: "radio", kind: "zigbee", state: "up", since: T }],
  devices: ids.map((id) => ({ id, transport: "radio", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000, timestamp: T,
    lastCheckIn: T, observable: true, since: T })), publishedAt: T, ...extra });

export const LEAK = { device: "hall:leak", key: "leak", op: "eq", value: true };
export const rule = (extra: Record<string, unknown> = {}) => ({ op: "upsert", kind: "safety_rule", value: { id: "leak-closes-valve", trigger: LEAK,
  actions: [{ target: "hall:valve", action: "valve.close" }], notice: { text: "A leak closed the valve." }, ...extra } });

/**
 * A home for the Safe tests: an applier that can claim Safe, a bridge with a leak sensor, a valve, a
 * pulse relay, an IR TV whose turn_off toggles, an IR air conditioner, a button whose press is an event,
 * and a valve whose other admins are not known; the owner's box set and every device adopted, each
 * socket with a load, unless `fresh` is false.
 */
export async function home(o: { mutation?: Mutation; db?: Awaited<ReturnType<typeof memoryDb>>; fresh?: boolean; box?: boolean;
  /** False: the test calls `a.load()` and `a.resume()` itself. */
  start?: boolean;
  /** Devices the bridge reports beside `DEVICES`. */
  extra?: Record<string, unknown>[];
  /** Where the clock starts: a restarted home's continues the first life's. */
  at?: number } = {}) {
  const devices = [...DEVICES, ...(o.extra ?? [])] as (typeof DEVICES[number] & { id: string; proposedClass: string })[];
  const clock = new FakeClock(o.at);
  const db = o.db ?? await memoryDb();
  const store = await Store.open(db, clock, (err) => { throw err; });
  const fb = fakeBus();
  const a = new Applier({ store, clock, ownerCredential: OWNER, applierId: "demo-applier", runId: "run-1", mutation: o.mutation, bus: fb.bus,
    levels: ["Act", "Safe"] });
  if (o.start !== false) await a.start();
  const owner = a.caller(OWNER);
  const configure = async (changes: unknown[]) => {
    const { revision } = body(await a.call(owner, "describe", {}));
    return a.call(owner, "configure", { changes, expected_revision: revision, dry_run: false });
  };
  const send = (path: string, b: unknown, retained = false) => a.home.message("hall-bridge", path, Buffer.from(JSON.stringify(b)), retained);
  const report = (device: string, values: Record<string, unknown>, at = clock.now()) =>
    send(`devices/${device}/status`, { deviceId: device, ...values, timestamp: new Date(at).toISOString() });
  const ack = (s: Sent, result: string, extra: Record<string, unknown> = {}) => send(`devices/${s.device}/ack`, { commandId: s.body.commandId,
    source: "hall-bridge", result, ...extra, timestamp: new Date(clock.now()).toISOString() });
  if (o.fresh !== false) {
    body(await configure([{ op: "upsert", kind: "bridge", value: { id: "hall", identity: "hall-bridge" } },
      { op: "upsert", kind: "client", value: { id: "h", credential: "h-credential", kind: "steward", token_key: TOKEN_KEY } },
      ...(o.box === false ? [] : [{ op: "upsert", kind: "box", value: true }])]));
    send("devices", { devices }, true);
    a.listening("hall");
    send("status", status(devices.map((d) => d.id)));
    body(await configure(devices.map((d) => ({ op: "upsert", kind: "adopt", value: { device: `hall:${d.id}`, class: d.proposedClass,
      ...(d.proposedClass === "socket" ? { declarations: { load: "other" } } : {}) } }))));
  }
  const h = a.caller("h-credential");
  /** A client's apply of one action; `token` signs one for it, `for` names whose step it is. */
  const apply = async (target: string, action: string, o: { args?: Record<string, unknown>; for?: unknown; token?: boolean } = {}) => {
    const asked = { target, action, args: o.args ?? {}, via: "app", brain: false, for: o.for ?? { person: "demo" } };
    return body(await a.call(h, "apply", { idempotency_key: crypto.randomUUID(),
      request: { actions: [{ ...asked, ...(o.token ? { token: signed(asked, clock.now()) } : {}) }] } }));
  };
  const plan = async (target: string, action: string, args: Record<string, unknown> = {}) => body(await a.call(h, "plan", {
    actions: [{ target, action, args, via: "app", brain: false, for: { person: "demo" } }] })).steps[0];
  const cursor = async () => body(await a.call(owner, "events", {})).cursor as string;
  const events = async (c: string, type: string) => body(await a.call(owner, "events", { cursor: c })).events.filter((e: any) => e.type === type);
  const notices = async (cause: string) => body(await a.call(owner, "events", {})).notices.filter((n: any) => n.cause === cause);
  return { a, db, store, clock, owner, configure, send, report, ack, apply, plan, cursor, events, notices, ...fb };
}

/** The harness client's token key: its tokens stand. */
export const TOKEN_KEY = "h-token-key-of-the-steward";

/** A token for the step `a`, as the steward signs it. */
export function signed(a: Record<string, unknown>, now: number) {
  const unsigned = { token_id: `t-${crypto.randomUUID()}`, issuer: "h", target: a.target, action: a.action, args: a.args, via: a.via,
    brain: a.brain, for: a.for, expires: new Date(now + 60_000).toISOString() };
  return { ...unsigned, proof: proofOf(unsigned as never, TOKEN_KEY) };
}

/** Lets the PUBACKs and dispatches waiting on them run. */
export const flush = () => new Promise((r) => setImmediate(r));

export const refused = async (p: Promise<ToolResult>, pattern: RegExp) => {
  const r = await p;
  expect(r.ok ? "accepted" : r.message).toMatch(pattern);
};
