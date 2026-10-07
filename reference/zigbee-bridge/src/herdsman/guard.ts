import type { Zh } from "zigbee-herdsman-converters/lib/types";
import { redact } from "./log.js";

/**
 * The guard on herdsman's models (the maintainer's ruling of 2026-10-04, the bench read-only; plan
 * 2c-1 review I1, confirmed by the maintainer on 2026-10-05). Every converter call (a `fromZigbee`
 * converter, an `onEvent` hook, resolving a definition) gets the device, its endpoints and its groups
 * through this guard, which lets a converter read and keep herdsman's model and refuses, at once and
 * without awaiting anything, every method that sends a frame or changes herdsman's model of the
 * network. herdsman's own answers to a device's frames (a Default Response, a Read Response, an IAS
 * enrolment) are herdsman's, made on its own models, and stay.
 *
 * The guard is opened for three things only, each for one exchange, through that exchange's gate: an
 * action the applier asked for, carried out by its converter (`execute.ts`), gets the device `live`,
 * whose endpoints' `command`, `write` and `read` (LIVE) go to herdsman (plan 2c-2); a definition's
 * `configure` (`configure.ts`) gets it `configuring`, whose endpoints' binds to an endpoint, reporting
 * set-ups and reads (CONFIGURE) go to herdsman (plan 2c-3); and a removal the applier asked for
 * (`provision.ts`) gets it `removing`, whose own `removeFromNetwork` (REMOVE), or with `force` its
 * `removeFromDatabase` alone (FORCED), goes to herdsman (plan 3b). And a converter may answer a device by
 * itself only with one of the ANSWERS, each while the exchange it answers is open: a message the device
 * sent, a read it made, its announce (`answering`, plan 2c-3). Every other method that sends, an
 * unlisted one among them, is refused as the guard refuses it.
 */

/** A call the guard refused: the promise the converter gets rejects with this. */
export class Refused extends Error {}

type Kind = "Device" | "Endpoint" | "Group";

/** The endpoint methods a live run may make: an action's own command, write and read. Nothing else is opened. */
export const LIVE: ReadonlySet<string> = new Set(["command", "write", "read"]);
export type LiveMethod = "command" | "write" | "read";

/**
 * The endpoint methods a definition's `configure` may make (plan 2c-3): a bind of a cluster to an
 * endpoint (the coordinator's), a reporting set-up, and a read (the Tuya magic packet, an initial
 * value). No write and no command: a `configure` that needs one is refused, and the device keeps no
 * bound (the design, *Running configure*).
 */
export const CONFIGURE: ReadonlySet<string> = new Set(["bind", "configureReporting", "read"]);
export type ConfigureMethod = "bind" | "configureReporting" | "read";

/**
 * The device methods a removal may make (plan 3b): herdsman's Leave Request without rejoin, which
 * deletes herdsman's record once the device answered. Nothing of its endpoints.
 */
export const REMOVE: ReadonlySet<string> = new Set(["removeFromNetwork"]);
/** The device methods a removal with `force` may make: herdsman's record dropped, without a frame. */
export const FORCED: ReadonlySet<string> = new Set(["removeFromDatabase"]);
export type RemovalMethod = "removeFromNetwork" | "removeFromDatabase";

/**
 * A removal's gate: `send` makes the call on herdsman's own device. Closed once the removal's call
 * ended, so a model kept from it opens nothing more.
 */
export type RemovalGate = ((device: Zh.Device, method: RemovalMethod, args: unknown[], send: (args: unknown[]) => Promise<unknown>)
  => Promise<unknown>) & { closed?: boolean };

/**
 * A frame a converter sends a device by itself, answering it, that the guard lets through (plan 2c-3),
 * decided one by one: what the device sent that it answers (`to`), and the one call that answers it.
 * None changes a state the applier holds (GA-BRIDGE-32).
 */
export interface Answer {
  /** A message of `type` on `cluster`; a read of `cluster`'s attributes (of `attribute` alone, where given); or an event of the device's. */
  to: { message: string; type: string } | { read: string; attribute?: number } | { event: "deviceAnnounce" };
  /** The call: an endpoint's cluster command, or its read response. */
  method: "command" | "readResponse";
  cluster: string;
  /** The command, for a cluster command. */
  command?: string;
  /** The attributes a read response may carry, by id; any of the cluster's where none is given. */
  attributes?: number[];
  /** Why the device needs it, as the converters say. */
  why: string;
}

/** The answers the guard lets through (plan 2c-3). Every other frame a converter sends by itself is refused. */
export const ANSWERS: readonly Answer[] = [
  { to: { message: "manuSpecificTuya", type: "commandMcuGatewayConnectionStatus" }, method: "command", cluster: "manuSpecificTuya",
    command: "mcuGatewayConnectionStatus", why: "a Tuya device asks whether its gateway is connected" },
  { to: { message: "manuSpecificTuya", type: "commandMcuSyncTime" }, method: "command", cluster: "manuSpecificTuya", command: "mcuSyncTime",
    why: "a Tuya device asks for the time" },
  { to: { read: "genBasic", attribute: 0xf000 }, method: "readResponse", cluster: "genBasic", attributes: [0xf000],
    why: "a Legrand device reads its security attribute, and may leave when nobody answers" },
  { to: { read: "genTime" }, method: "readResponse", cluster: "genTime", why: "a device reads the time, in a form of its own" },
  { to: { event: "deviceAnnounce" }, method: "command", cluster: "manuSpecificTuya", command: "dataQuery",
    why: "a Tuya device reports nothing after an announce until it is queried" },
];

/**
 * How long herdsman waits for an answer's own acknowledgement, the answer sent once (`disableRecovery`),
 * instead of herdsman's 10 s and its recovery: on Z-Stack the frame holds the device's place in
 * herdsman's adapter queue until it ends, and an action on the same device waits behind it (plan 2c-3
 * review I1). The device has just spoken, so it is awake.
 */
export const ANSWER_MS = 3_000;

/** One exchange a converter may answer in: the answers it opens, the read's transaction number, and whether it has ended. */
export interface Exchange {
  answers: readonly Answer[];
  /** A read's transaction number: its response must carry it. */
  tsn?: number;
  closed?: boolean;
}

/** The exchange for a message the device sent: the answers to its cluster and type. */
export function messageExchange(cluster: string | number, type: string): Exchange {
  return { answers: ANSWERS.filter((a) => "message" in a.to && a.to.message === cluster && a.to.type === type) };
}

/** The exchange for a read the device made: the answers to a read of its cluster, of the attributes it asked. */
export function readExchange(cluster: string, attributes: number[], tsn: number): Exchange {
  return { tsn, answers: ANSWERS.filter((a) => "read" in a.to && a.to.read === cluster
    && (a.to.attribute === undefined || attributes.includes(a.to.attribute))) };
}

/** The exchange for an event of the device's, its converters' `onEvent`: the answers to it. */
export function eventExchange(type: string): Exchange {
  return { answers: ANSWERS.filter((a) => "event" in a.to && a.to.event === type) };
}

/** Whether `call` is one of the exchange's answers: its cluster and command, or its read response's cluster, transaction and attributes. */
function answers(ex: Exchange, method: string, args: unknown[]): Answer | undefined {
  return ex.answers.find((a) => {
    if (a.method !== method || args[0] !== a.cluster) return false;
    if (method === "command") return args[1] === a.command;
    const given = args[2];
    if (args[1] !== ex.tsn || !given || typeof given !== "object") return false;
    return !a.attributes || Object.keys(given).every((k) => a.attributes!.includes(Number(k)));
  });
}

/**
 * What a live run does with an allowed call: `send` makes it on herdsman's own endpoint, with the
 * arguments the gate gives it (the run records it, and adds its options). Once the run has ended its
 * gate is `closed`: a call a converter makes later, from a timer or through an endpoint it kept, is
 * refused as the guard refuses it, never reaching the gate (plan 2c-2 review I2). `refused` counts
 * the calls of the run the guard refused for what they are (not for the run having ended), so that a
 * run can tell a converter that needed more than it was opened for (plan 2c-3).
 */
export type Gate<M extends string = LiveMethod> = ((endpoint: Zh.Endpoint, method: M, args: unknown[], send: (args: unknown[]) => Promise<unknown>)
  => Promise<unknown>) & { closed?: boolean; refused?: number };

/**
 * How entities are wrapped: guarded, cached for the process; or opened for one exchange (a live run,
 * a `configure`, a device's frame its converters may answer), whose `opened` endpoint methods go
 * through its gate where `allows` says so. `why` is what the log says of any other call, and `ended`
 * of a call through a closed gate. `answerReads` says a read handler set through it may answer.
 */
interface Mode {
  proxies: WeakMap<object, object>;
  made: WeakSet<object>;
  gate?: Gate<string>;
  opened?: ReadonlySet<string>;
  /** Whose methods `opened` names: an endpoint's, unless a removal opens the device's own. */
  openedOn?: Kind;
  allows?(method: string, args: unknown[]): boolean;
  why: string;
  ended?: string;
  answerReads?: boolean;
}

/** herdsman 10.10.0's methods a converter may use: they read or keep herdsman's model, and send nothing. */
export const QUIET: Readonly<Record<Kind, ReadonlySet<string>>> = {
  Device: new Set(["getEndpoint", "getEndpointByDeviceType", "save", "addCustomCluster", "hasPendingRequests", "toDatabaseEntry"]),
  Endpoint: new Set(["getDevice", "supportsInputCluster", "supportsOutputCluster", "getInputClusters", "getOutputClusters", "toDatabaseRecord",
    "saveClusterAttributeKeyValue", "getClusterAttributeValue", "hasPendingRequests", "checkStatus", "hasBind", "getBindIndex", "addBinding", "save",
    "getOptionsWithDefaults", "ensureManufacturerCodeIsUniqueAndGet", "getCluster"]),
  Group: new Set(["toDatabaseRecord", "save", "hasMember", "getOptionsWithDefaults"]),
};

/** herdsman 10.10.0's methods that send a frame (or wait on one): refused. */
export const SENDS: Readonly<Record<Kind, readonly string[]>> = {
  Device: ["interview", "interviewQuirks", "interviewInternal", "updateNodeDescriptor", "updateActiveEndpoints", "requestNetworkAddress",
    "removeFromNetwork", "lqi", "routingTable", "bindingTable", "clearAllBindings", "ping", "onZclData", "checkOta", "updateOta"],
  Endpoint: ["sendPendingRequests", "sendRequest", "report", "write", "writeResponse", "read", "readResponse", "updateSimpleDescriptor", "bind",
    "unbind", "defaultResponse", "configureReporting", "readReportingConfig", "writeStructured", "command", "commandResponse", "addToGroup",
    "removeFromGroup", "removeFromAllGroups", "zclCommand", "zclCommandBroadcast"],
  Group: ["removeFromNetwork", "write", "read", "command"],
};

/** herdsman 10.10.0's methods that send nothing but change its model of the network, which no converter of this plan's needs: refused. */
export const MODEL: Readonly<Record<Kind, readonly string[]>> = {
  Device: ["resetTransient", "createEndpoint", "changeIeeeAddress", "updateGenBasic", "implicitCheckin", "updateLastSeen",
    "resetPendingRequestTimeout", "undelete", "removeFromDatabase", "findMatchingOtaImage", "abortOta", "scheduleOta", "unscheduleOta"],
  Endpoint: ["saveClusterAttributeReportConfig", "saveBindings", "clearBindings", "addBindingInternal", "removeFromAllGroupsDatabase"],
  Group: ["removeFromDatabase", "addMember", "removeMember"],
};

/** Why the guard refuses a call, as its log line says. */
const NOT_LIVE = "the doer sends a device nothing but an action's command, write or read";
const RUN_ENDED = "the action's run has ended";
const NOT_CONFIGURE = "configure sends a device nothing but a bind to an endpoint, a reporting set-up or a read";
const CONFIGURE_ENDED = "configure has ended";
/** A bind to a group, or to anything but an endpoint, would make herdsman create a group in its model (`Endpoint.bind`). */
const NOT_ENDPOINT = "configure binds a cluster to an endpoint only, never to a group";
const NOT_ANSWER = "a converter answers a device by itself only as the doer's answers say";
const EXCHANGE_ENDED = "the exchange it answers has ended";
const NOT_REMOVAL = "a removal sends a device nothing but its Leave Request, or with force drops herdsman's record";
const REMOVAL_ENDED = "the removal has ended";

const GUARDED: Mode = { proxies: new WeakMap(), made: new WeakSet(), why: NOT_LIVE };
/** Every refusal so far: a read handler that was refused answered nothing. */
let refusals = 0;

/** herdsman's model a value is, by its class's name (as the converters tell them), or none. */
function kindOf(v: object): Kind | undefined {
  const name = (v as { constructor?: { name?: unknown } }).constructor?.name;
  return name === "Device" || name === "Endpoint" || name === "Group" ? name : undefined;
}

/** The entity, or array of them, through the guard; any other value as it is. */
export function guard<T>(v: T): T {
  return wrap(v, GUARDED);
}

/**
 * The entity live, for one run of an action's converter (plan 2c-2): as the guard gives it, but that
 * its endpoints' LIVE methods go through `gate`. Every entity it gives (an endpoint, the device
 * again) is live for the same run.
 */
export function live<T>(v: T, gate: Gate): T {
  return wrap(v, { proxies: new WeakMap(), made: new WeakSet(), gate: gate as Gate<string>, opened: LIVE, why: NOT_LIVE, ended: RUN_ENDED });
}

/**
 * The entity opened for one run of a definition's `configure` (plan 2c-3): as the guard gives it, but
 * that its endpoints' CONFIGURE methods go through `gate`, a bind only to an endpoint. Every entity it
 * gives is opened for the same run.
 */
export function configuring<T>(v: T, gate: Gate<ConfigureMethod>): T {
  return wrap(v, { proxies: new WeakMap(), made: new WeakSet(), gate: gate as Gate<string>, opened: CONFIGURE, why: NOT_CONFIGURE,
    ended: CONFIGURE_ENDED });
}

/**
 * The device opened for one removal (plan 3b): as the guard gives it, but that its own
 * `removeFromNetwork` (REMOVE), or for a removal with `force` its `removeFromDatabase` alone (FORCED),
 * goes through `gate` until the gate is closed. Every other method, its endpoints' among them, is
 * refused as the guard refuses it.
 */
export function removing<T>(v: T, gate: RemovalGate, force: boolean): T {
  return wrap(v, { proxies: new WeakMap(), made: new WeakSet(), gate: gate as unknown as Gate<string>, opened: force ? FORCED : REMOVE,
    openedOn: "Device", why: NOT_REMOVAL, ended: REMOVAL_ENDED });
}

/**
 * The entity opened for one exchange's answers (plan 2c-3): as the guard gives it, but that an
 * endpoint's command or read response that is one of the exchange's answers goes to herdsman, sent at
 * once (`sendPolicy: "immediate"`), once, waited for ANSWER_MS at most, until the exchange is closed. A read handler a converter sets
 * through it may answer the device's later reads, each its own exchange.
 */
export function answering<T>(v: T, ex: Exchange): T {
  let mode = exchanges.get(ex);
  if (!mode) exchanges.set(ex, (mode = answeringMode(ex)));
  return wrap(v, mode);
}

/** Each exchange's one mode: everything it gives (the device, an endpoint, the device again) is opened for the same exchange. */
const exchanges = new WeakMap<Exchange, Mode>();

function answeringMode(ex: Exchange): Mode {
  const gate: Gate<string> = async (endpoint, method, args, send) => {
    const a = [...args];
    const given = a[3];
    // command(cluster, command, payload, options); readResponse(cluster, transactionSequenceNumber, attributes, options)
    a[3] = { ...(given && typeof given === "object" && !Array.isArray(given) ? given : {}), sendPolicy: "immediate", disableRecovery: true,
      timeout: ANSWER_MS };
    const answer = answers(ex, method, args)!;
    console.error(`zigbee: ${endpoint.deviceIeeeAddress}/${endpoint.ID}: answered ${answer.cluster}.${answer.command ?? "readResponse"}: ${answer.why}`);
    return send(a);
  };
  Object.defineProperty(gate, "closed", { get: () => ex.closed === true });
  return { proxies: new WeakMap(), made: new WeakSet(), gate, opened: new Set(ex.answers.map((a) => a.method)),
    allows: (method, args) => answers(ex, method, args) !== undefined, why: NOT_LIVE, ended: EXCHANGE_ENDED, answerReads: true };
}

function wrap<T>(v: T, mode: Mode): T {
  if (Array.isArray(v)) return v.map((x: unknown) => wrap(x, mode)) as T;
  if (!v || typeof v !== "object" || mode.made.has(v)) return v;
  const kind = kindOf(v);
  if (!kind) return v;
  let p = mode.proxies.get(v);
  if (!p) {
    p = entityProxy(v, kind, mode);
    mode.proxies.set(v, p);
    mode.made.add(p);
  }
  return p as T;
}

/** Who a refused call was for, as the log names it: the device, its endpoint, or the group. */
function nameOf(t: object, kind: Kind): string {
  const e = t as { ieeeAddr?: string; deviceIeeeAddress?: string; ID?: number; groupID?: number };
  return kind === "Device" ? String(e.ieeeAddr) : kind === "Endpoint" ? `${e.deviceIeeeAddress}/${e.ID}` : `group ${e.groupID}`;
}

/** A refused call: logged by its method and cluster (never its payload), and a promise rejected at once, handled if nobody awaits it. */
function refuse(t: object, kind: Kind, method: string, args: unknown[], why: string): Promise<never> {
  refusals += 1;
  const cluster = typeof args[0] === "string" || typeof args[0] === "number" ? ` ${String(args[0])}` : "";
  console.error(redact(`zigbee: ${nameOf(t, kind)}: refused ${kind.toLowerCase()}.${method}${cluster}: ${why}`));
  const p = Promise.reject(new Refused(`refused: ${kind.toLowerCase()}.${method}`));
  // A converter that fires and forgets (a timer's query) leaves no unhandled rejection; one that awaits sees the refusal.
  p.catch(() => {});
  return p;
}

/** A call refused for what it is: counted against an open run's gate, if any (`Gate.refused`). */
function counted(mode: Mode, t: object, kind: Kind, method: string, args: unknown[], why: string): Promise<never> {
  if (mode.gate) mode.gate.refused = (mode.gate.refused ?? 0) + 1;
  return refuse(t, kind, method, args, why);
}

/**
 * A converter's read handler (`customReadResponse`), which herdsman calls with its own endpoint for a
 * device's read: run with that endpoint guarded, or, where the handler was set through an exchange's
 * answers (`answerReads`), opened for the read's own answers until the handler returns (plan 2c-3).
 * One whose answer was refused answered nothing, so it says false, and herdsman answers the device
 * itself.
 */
function readHandler(handler: (frame: unknown, endpoint: Zh.Endpoint) => boolean, answerReads: boolean)
  : (frame: unknown, endpoint: Zh.Endpoint) => boolean {
  return (frame, endpoint) => {
    const before = refusals;
    const ex = answerReads ? readExchangeOf(frame) : undefined;
    try {
      const answered = handler(frame, ex ? answering(endpoint, ex) : guard(endpoint));
      return refusals === before ? answered : false;
    } finally {
      if (ex) ex.closed = true;
    }
  };
}

/** A device's read, as herdsman hands it to a read handler: its cluster, the attributes asked, its transaction number. */
function readExchangeOf(frame: unknown): Exchange {
  const f = frame as { cluster?: { name?: unknown }; header?: { transactionSequenceNumber?: unknown }; payload?: unknown };
  const cluster = typeof f.cluster?.name === "string" ? f.cluster.name : "";
  const tsn = typeof f.header?.transactionSequenceNumber === "number" ? f.header.transactionSequenceNumber : -1;
  const asked = Array.isArray(f.payload) ? f.payload.map((i: { attrId?: unknown }) => i.attrId).filter((x): x is number => typeof x === "number") : [];
  return readExchange(cluster, asked, tsn);
}

/** What a guarded entity gives as its `constructor`: its class's name, nothing else. */
const STAND_INS: Readonly<Record<Kind, Readonly<{ name: Kind }>>> = {
  Device: Object.freeze({ name: "Device" }), Endpoint: Object.freeze({ name: "Endpoint" }), Group: Object.freeze({ name: "Group" }),
};

function entityProxy(target: object, kind: Kind, mode: Mode): object {
  return new Proxy(target, {
    get(t, k) {
      // herdsman keeps private fields: every read and call is made on the model itself.
      const v = Reflect.get(t, k, t) as unknown;
      // A stand-in for the class, carrying its name alone: converters tell a device, an endpoint and a
      // group apart by it, and herdsman's class would give its statics, the adapter (every send method)
      // and any device's model unguarded (plan 2c-3 review M2).
      if (k === "constructor") return STAND_INS[kind];
      if (typeof v === "function") {
        const f = v as (...a: unknown[]) => unknown;
        if (typeof k === "string" && QUIET[kind].has(k)) return (...args: unknown[]) => wrap(f.apply(t, args), mode);
        // Opened for one exchange only: the methods it opens (an endpoint's, or a removal's device's own), through its gate.
        if (mode.gate && mode.opened && kind === (mode.openedOn ?? "Endpoint") && typeof k === "string" && mode.opened.has(k)) {
          const gate = mode.gate;
          return (...args: unknown[]) => (gate.closed ? refuse(t, kind, k, args, mode.ended ?? mode.why)
            : k === "bind" && !(args[1] && typeof args[1] === "object" && kindOf(args[1]) === "Endpoint") ? counted(mode, t, kind, k, args, NOT_ENDPOINT)
            : mode.allows && !mode.allows(k, args) ? counted(mode, t, kind, k, args, NOT_ANSWER)
            : gate(t as Zh.Endpoint, k, args, async (a) => f.apply(t, a)));
        }
        return (...args: unknown[]) => counted(mode, t, kind, String(k), args, mode.why);
      }
      if (k === "binds" && Array.isArray(v)) return v.map((b: { target?: unknown }) => ({ ...b, target: wrap(b.target, mode) }));
      return wrap(v, mode);
    },
    set(t, k, value) {
      const v = k === "customReadResponse" && typeof value === "function"
        ? readHandler(value as (f: unknown, e: Zh.Endpoint) => boolean, mode.answerReads === true) : value;
      return Reflect.set(t, k, v, t);
    },
  });
}
