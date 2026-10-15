import { describe, expect, it } from "vitest";
import { fingerprintOf, Home, MAX_UNLISTED, type HeldDevice, type HeldTransport, type HomeHooks, type NoticeAsk } from "../src/model/home.js";
import type { Declarations } from "../src/model/declarations.js";
import type { DeviceDoc } from "../src/bus/wire.js";
import { type Mutation, mutantOf } from "../src/mutations.js";
import { FakeClock } from "./fake-clock.js";

const B = { id: "hall", identity: "hall-bridge" };
const wire = (ms: number) => new Date(ms).toISOString();
/** Hooks for a home whose test raises no notice. */
const NO_NOTICES = { notice: () => undefined, clearNotice: () => undefined, standingNotices: () => [] };

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, stableIdentifier: `test:${id}`, transport: "radio", model: { vendor: "demo", model: id }, capabilities: ["onoff"],
  actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, confirms: true }], feedback: "closed",
  reachMs: 1000, proposedClass: "light", classEvidence: "protocol", ...extra,
});

function setup(mutation?: Mutation, standing: string[] = [], extra: Partial<HomeHooks> = {}) {
  const clock = new FakeClock();
  const events: { type: string; body: Record<string, unknown>; eventsOnly?: boolean }[] = [];
  const changed: HeldDevice[][] = [];
  const modelledTransports: HeldTransport[][] = [];
  const snapshots: string[] = [];
  const gone: string[] = [];
  const facts: string[] = [];
  const replies: [string, Record<string, unknown>][] = [];
  const provisioning: [string, { type: string; body: Record<string, unknown> }][] = [];
  const connsChanged: [string, { kind: string; entity: string; keys: string[] }[]][] = [];
  const announced: [string, string, string[]][] = [];
  /** The notices raised, keyed or not, and the keys standing, as `Notices` would hold them. */
  const notices: (NoticeAsk & { key?: string })[] = [];
  const keys = new Set(standing);
  const home = new Home(() => clock.now(), {
    emit: (type, body, o) => events.push({ type, body, ...(o?.eventsOnly ? { eventsOnly: true } : {}) }),
    modelChanged: (d, t) => { changed.push(d); modelledTransports.push(t); },
    transportsGone: (t) => void gone.push(...t.map((x) => x.id)),
    factsChanged: (d) => void facts.push(...d.map((x) => x.id)),
    snapshot: (b) => snapshots.push(b.id),
    notice: (n, key) => {
      if (key !== undefined && keys.has(key)) return;
      if (key !== undefined) keys.add(key);
      notices.push({ ...n, ...(key !== undefined ? { key } : {}) });
    },
    clearNotice: (key) => void keys.delete(key),
    withdrawNotice: (key) => {
      keys.delete(key);
      notices.splice(0, notices.length, ...notices.filter((n) => n.key !== key));
    },
    standingNotices: (prefix) => [...keys].filter((k) => k.startsWith(prefix)),
    log: () => undefined,
    // The hook holds the requests whose ids begin with "held-".
    reply: (b, body) => { replies.push([b, body]); return String(body.requestId).startsWith("held-"); },
    provisioning: (b, e) => void provisioning.push([b, e]),
    connectionsChanged: (b, rows) => void connsChanged.push([b, rows]),
    announced: (b, device, names) => void announced.push([b, device, names]),
    ...extra,
  }, mutantOf(mutation));
  home.follow(new Map([[B.id, B]]));
  /** The owner's adoptions and declarations, as a committed configure gives them. */
  const own = (adoptions: [string, string | null][], declarations: [string, Declarations][] = []) =>
    home.setOwner({ adoptions: new Map(adoptions.map(([id, cls]) => [id, { class: cls }])), declarations: new Map(declarations) });
  const send = (path: string, body: unknown, retained = false) =>
    home.message(B.identity, path, Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), retained);
  const status = (extra: Record<string, unknown> = {}, roster = [{ id: "lamp" }]) => ({
    bridgeId: B.identity, instanceId: "11111111-1111-4111-8111-111111111111", v: 1, state: "online", version: "1",
    levels: ["Serve"], faults: [], ungoverned: [], blocked: [], transports: [{ id: "radio", kind: "zigbee", state: "up", since: wire(clock.now()) }],
    devices: roster.map((r) => ({ transport: "radio", basis: "report", cadenceMs: null, basisMaxAgeMs: 60_000,
      timestamp: wire(clock.now()), lastCheckIn: wire(clock.now()), observable: true, since: wire(clock.now()), ...r })),
    publishedAt: wire(clock.now()), ...extra,
  });
  const lamp = () => home.stateOf(home.devices.get("hall:lamp")!);
  const faults = () => events.filter((e) => e.type === "bridge_fault").map((e) => e.body.what);
  /** A bridge with a lamp, heard live. */
  const heard = () => {
    send("devices", { devices: [entry("lamp")] }, true);
    home.listening(B.id);
    send("status", status());
  };
  const describe = (id = "hall:lamp") => home.describeDevice(home.devices.get(id)!);
  return { clock, home, events, changed, modelledTransports, snapshots, gone, facts, notices, keys, own, send, status, lamp, faults, heard,
    describe, replies, provisioning, connsChanged, announced };
}

describe("Home", () => {
  it("maps a bridge's device to {bridge id}:{device id}, and keeps every good entry beside a bad one (GA-BUS-1)", () => {
    const { home, send, changed, faults } = setup();
    send("devices", { devices: [entry("lamp"), { id: "ghost" }, entry("tv", { feedback: "open" })] });
    expect([...home.devices.keys()]).toEqual(["hall:lamp", "hall:tv"]);
    expect(changed.flat().map((d) => d.id)).toEqual(["hall:lamp", "hall:tv"]);
    expect(faults()).toEqual(["devices[1] (ghost) has no stableIdentifier, transport, capabilities, actions"]);
    send("devices", { devices: [entry("lamp"), entry("tv", { feedback: "open" })] });
    expect(changed).toHaveLength(1);
  });

  it("models no device or transport whose id would pass 128 characters: one fault each while it stands, the rest kept", () => {
    const { home, send, faults, status } = setup();
    const long = "d".repeat(124);
    send("devices", { devices: [entry("lamp"), entry(long)] });
    send("devices", { devices: [entry("lamp"), entry(long), entry("d".repeat(123))] });
    expect([...home.devices.keys()]).toEqual(["hall:lamp", `hall:${"d".repeat(123)}`]);
    expect(faults()).toEqual([`device ${long} would have the id hall:${long}, longer than 128 characters; not modelled`]);
    home.listening(B.id);
    const radio = { kind: "zigbee", state: "up", since: wire(0) };
    send("status", status({ transports: [{ id: "radio", ...radio }, { id: "t".repeat(124), ...radio }] }));
    send("status", status({ transports: [{ id: "radio", ...radio }, { id: "t".repeat(124), ...radio }] }));
    expect(home.transports().map((t) => t.id)).toEqual(["hall:radio"]);
    expect(faults().filter((f) => String(f).startsWith("transport"))).toHaveLength(1);
  });

  it("never models the replaced hardware under an id past 128 characters: its next document raises the fault", () => {
    const { home, send, changed, faults } = setup();
    const edge = "d".repeat(123);
    send("devices", { devices: [entry(edge), entry("lamp-2")] });
    const before = changed.length;
    home.setOwner({ adoptions: new Map([[`hall:${edge}`, { class: "light" }]]), declarations: new Map() },
      { forgotten: [], replaced: [{ device: "hall:lamp-2", replaces: `hall:${edge}` }], routed: [] });
    expect([...home.devices.keys()]).toEqual([`hall:${edge}`]);
    expect(changed.slice(before)).toEqual([]);
    send("devices", { devices: [entry(edge, { reachMs: 5 }), entry("lamp-2")] });
    expect(faults()).toEqual([`device ${edge} would have the id hall:${edge}/2, longer than 128 characters; not modelled`]);
  });

  it("takes a document the store gave back with its keys reordered as unchanged: no model change, nothing written (lesson 16)", () => {
    const { send, changed } = setup();
    send("devices", { devices: [entry("lamp")] });
    const [held] = changed.flat();
    const reordered = Object.fromEntries(Object.entries(held!.doc).reverse()) as typeof held.doc;
    const again = setup();
    again.home.load([{ ...held!, doc: reordered }]);
    again.send("devices", { devices: [entry("lamp")] });
    expect(again.changed).toEqual([]);
  });

  it("maps a bridge device by the id map, not the formula; a device new to the model whose {bridge}:{device} is taken gets /2; describe gives the owner's replaced identifiers", () => {
    const { home, send } = setup();
    // As a replacement leaves it: hall:lamp is the hardware the bridge calls lamp-2.
    home.load([{ id: "hall:lamp", bridge: B.id, bridge_device: "lamp-2", doc: {} as HeldDevice["doc"] }]);
    send("devices", { devices: [entry("lamp-2"), entry("lamp")] });
    expect(home.idOf(B.id, "lamp-2")).toBe("hall:lamp");
    expect(home.idOf(B.id, "lamp")).toBe("hall:lamp/2");
    expect(home.devices.get("hall:lamp")!.doc.stable_identifier).toBe("test:lamp-2");
    expect(home.devices.get("hall:lamp/2")!.bridge_device).toBe("lamp");
    home.setOwner({ adoptions: new Map(), declarations: new Map(), previous: new Map([["hall:lamp", ["test:lamp"]]]) });
    expect(home.describeDevice(home.devices.get("hall:lamp")!).previous_identifiers).toEqual(["test:lamp"]);
  });

  it("forgets a device the owner forgot: out of the model and the id map; one listed again meanwhile stays, and its row is written again", () => {
    const { home, send, changed } = setup();
    send("devices", { devices: [entry("lamp"), entry("fan")] });
    expect(home.infos().get("hall:lamp")!.in_devices).toBe(true);
    send("devices", { devices: [entry("fan")] });
    expect(home.infos().get("hall:lamp")!.in_devices).toBe(false);
    const forget = (forgotten: string[]) => home.setOwner({ adoptions: new Map(), declarations: new Map() }, { forgotten, replaced: [], routed: [] });
    expect(forget(["hall:lamp", "hall:nowhere"])).toEqual([]);
    expect([...home.devices.keys()]).toEqual(["hall:fan"]);
    expect(home.idOf(B.id, "lamp")).toBeUndefined();
    const before = changed.length;
    // Kept, so the configure's model event says it is unadopted, not forgotten.
    expect(forget(["hall:fan"])).toEqual(["hall:fan"]);
    expect([...home.devices.keys()]).toEqual(["hall:fan"]);
    expect(changed.slice(before).flat().map((d) => d.id)).toEqual(["hall:fan"]);
  });

  it("reads a device naming a transport its bridge does not list dead, with a fault while it stands (slice 2a's M7)", () => {
    const { send, status, lamp, faults, heard } = setup();
    heard();
    expect(lamp().liveness).toBe("live");
    send("devices", { devices: [entry("lamp", { transport: "elsewhere" })] });
    expect(lamp().liveness).toBe("dead");
    send("status", status());
    expect(faults()).toEqual(['device lamp names transport "elsewhere", which its bridge does not list']);
    send("devices", { devices: [entry("lamp")] });
    send("status", status());
    expect(lamp().liveness).toBe("live");
  });

  it("drops a transport from the model once its status omits it and no device names it", () => {
    const { send, status, gone, heard } = setup();
    heard();
    send("status", status({ transports: [{ id: "radio", kind: "zigbee", state: "up", since: wire(0) }, { id: "ir", kind: "ir", state: "up", since: wire(0) }] }));
    send("status", status());
    expect(gone).toEqual(["hall:ir"]);
  });

  it("re-points a replaced id at its new hardware; the old hardware, still listed, is a new device with an id of its own (GA-ADOPT-2)", () => {
    const { home, send, changed, heard, lamp } = setup();
    heard();
    send("devices", { devices: [entry("lamp"), entry("lamp-2")] });
    const before = changed.length;
    home.setOwner({ adoptions: new Map([["hall:lamp", { class: "light" }]]), declarations: new Map() },
      { forgotten: [], replaced: [{ device: "hall:lamp-2", replaces: "hall:lamp" }], routed: [] });
    expect([...home.devices.keys()].sort()).toEqual(["hall:lamp", "hall:lamp/2"]);
    expect([home.idOf(B.id, "lamp-2"), home.idOf(B.id, "lamp")]).toEqual(["hall:lamp", "hall:lamp/2"]);
    expect(home.describeDevice(home.devices.get("hall:lamp")!)).toMatchObject({ stable_identifier: "test:lamp-2",
      bridge_device: { bridge: B.identity, id: "lamp-2" }, adopted: true });
    expect(changed.slice(before).flat().map((d) => d.id)).toEqual(["hall:lamp/2"]);
    // A report of the new hardware is the id's now.
    send("devices/lamp-2/status", { deviceId: "lamp-2", on: true, timestamp: wire(0), available: true });
    expect(lamp().values).toEqual([{ key: "on", value: true, basis_time: wire(0) }]);
  });

  it("keeps an arrival showing a held device's identifier a device of its own: a route_conflict event, and on its own bridge a notice (GA-BUS-11)", () => {
    const { home, send, events, notices, own } = setup();
    home.follow(new Map([[B.id, B], ["porch", { id: "porch", identity: "porch-bridge" }]]));
    send("devices", { devices: [entry("lamp")] });
    own([["hall:lamp", "light"]]);
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" })] });
    home.message("porch-bridge", "devices", Buffer.from(JSON.stringify({ devices: [entry("0x01", { stableIdentifier: "test:lamp" })] })), false);
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" })] });
    expect([...home.devices.keys()].sort()).toEqual(["hall:lamp", "hall:lamp-2", "porch:0x01"]);
    expect(home.describeDevice(home.devices.get("hall:lamp-2")!).adopted).toBe(false);
    // One event per identifier and set of bridges, not one per copy: a third copy on a bridge already
    // named says nothing more.
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" }), entry("lamp-3", { stableIdentifier: "test:lamp" })] });
    expect(events.filter((e) => e.type === "route_conflict").map((e) => e.body)).toEqual([
      { stable_identifier: "test:lamp", bridges: ["hall"], devices: ["hall:lamp", "hall:lamp-2"] },
      { stable_identifier: "test:lamp", bridges: ["hall", "porch"], devices: ["hall:lamp", "hall:lamp-2", "porch:0x01"] }]);
    expect(notices.map((n) => n.devices)).toEqual([["hall:lamp", "hall:lamp-2"], ["hall:lamp", "hall:lamp-2", "hall:lamp-3"]]);
  });

  const PORCH = { id: "porch", identity: "porch-bridge" };
  /** A home with a second bridge, porch, and what porch sends. */
  function twoBridges(mutation?: Mutation) {
    const s = setup(mutation);
    s.home.follow(new Map([[B.id, B], [PORCH.id, PORCH]]));
    const porch = (path: string, body: unknown, retained = false) => s.home.message(PORCH.identity, path, Buffer.from(JSON.stringify(body)), retained);
    const copy = (extra: Record<string, unknown> = {}) => porch("devices", { devices: [entry("0x01", { stableIdentifier: "test:lamp", ...extra })] });
    const owner = (adoptions: [string, string][] = [], routes: [string, string][] = []) => ({ adoptions: new Map(adoptions.map(([id, c]) =>
      [id, { class: c }])), declarations: new Map(), routes: new Map(routes) });
    return { ...s, porch, copy, owner };
  }

  it("folds another bridge's copy of an unadopted device into it: one device, whose steps refuse(duplicate_route), and one route_conflict (GA-BUS-11)", () => {
    const { home, send, copy, porch, events, changed } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    expect(home.exposed().map((d) => d.id)).toEqual(["hall:lamp"]);
    expect(home.devices.get("porch:0x01")!.into).toBe("hall:lamp");
    expect(changed.at(-1)!.map((d) => [d.id, d.into])).toEqual([["porch:0x01", "hall:lamp"]]);
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(true);
    expect(home.gateDevice("porch:0x01")).toBeUndefined();
    expect([...home.infos().keys()]).toEqual(["hall:lamp"]);
    expect(home.infos().get("hall:lamp")!.copies).toEqual(["porch"]);
    // A changed document of the copy stays folded, and says no more.
    copy({ reachMs: 5 });
    expect(home.devices.get("porch:0x01")!.into).toBe("hall:lamp");
    expect(events.filter((e) => e.type === "route_conflict").map((e) => e.body)).toEqual([
      { stable_identifier: "test:lamp", bridges: ["hall", "porch"], devices: ["hall:lamp"] }]);
    // The copy's readings are no one's events, and it has no verdict of its own.
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(0) });
    home.listening(PORCH.id);
    expect(events.filter((e) => e.type === "state" || (e.type === "liveness" && e.body.target === "porch:0x01"))).toEqual([]);
  });

  it("keeps its steps refused until a route names its own bridge", () => {
    const { home, send, copy, owner } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    home.setOwner(owner([["hall:lamp", "light"]]));
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(true);
    home.setOwner(owner([["hall:lamp", "light"]], [["test:lamp", "hall"]]));
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(false);
  });

  it("moves the id onto the route's copy, and folds the hardware it had under the copy's id", () => {
    const { home, send, copy, owner } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    const rows = home.routeRows(r);
    expect(rows.map((x) => [x.id, x.bridge, x.bridge_device, x.into])).toEqual([
      ["hall:lamp", "porch", "0x01", undefined], ["porch:0x01", "hall", "lamp", "hall:lamp"]]);
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, rows);
    expect(home.idOf("porch", "0x01")).toBe("hall:lamp");
    expect(home.idOf("hall", "lamp")).toBe("porch:0x01");
    expect(home.exposed().map((d) => d.id)).toEqual(["hall:lamp"]);
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(false);
    expect(home.routeRows(r)).toEqual([]);
  });

  it("places exactly the rows the route wrote, each with the document its hardware has now", () => {
    const { home, send, copy, owner, changed } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    const rows = home.routeRows(r);
    // While the route's write set waits for its commit, the copy's document changes.
    copy({ reachMs: 7 });
    const before = changed.length;
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, rows);
    expect(home.devices.get("hall:lamp")).toMatchObject({ bridge: "porch", bridge_device: "0x01" });
    expect(home.devices.get("hall:lamp")!.doc.reach_ms).toBe(7);
    // The newer document is written behind under the row's id.
    expect(changed.slice(before).flat().map((d) => [d.id, d.doc.reach_ms])).toEqual([["hall:lamp", 7]]);
  });

  it("keeps a moved id's verdict, and says each value its new hardware reports otherwise as a state event", () => {
    const { home, send, copy, owner, porch, events, status } = twoBridges();
    send("devices", { devices: [entry("lamp")] }, true);
    copy();
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(0) });
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, home.routeRows(r));
    const after = events.slice(mark);
    expect(after.filter((e) => e.type === "state")).toMatchObject([{ body: { target: "hall:lamp", key: "on", value: true } }]);
    // Live on the hall bridge, dead on the porch bridge, which was never heard: one liveness event, live to dead.
    expect(after.filter((e) => e.type === "liveness").map((e) => e.body)).toEqual([{ target: "hall:lamp", old: "live", new: "dead" }]);
  });

  it("says a key the old route never held as the device's word, one it held otherwise as external, when a route moves the id", () => {
    const { home, send, copy, owner, porch, events, status } = twoBridges();
    send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power"] })] }, true);
    copy({ capabilities: ["onoff", "sensor"], sensorKeys: ["power"] });
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    porch("devices/0x01/status", { deviceId: "0x01", on: true, power: 3, timestamp: wire(0) });
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, home.routeRows(r));
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]))
      .toEqual([["on", true, "external"], ["power", 3, "device"]]);
  });

  it("says a key first reported over a new route as the device's word when the same set adopts it; its change after, external (GA-EVT-1)", () => {
    const { home, send, copy, owner, porch, events, status, clock } = twoBridges();
    send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power"] })] }, true);
    copy({ capabilities: ["onoff", "sensor"], sensorKeys: ["power"] });
    for (const [b, at] of [[B, send], [PORCH, porch]] as const) {
      home.listening(b.id);
      at("status", status({ bridgeId: b.identity }));
      at("reply", { requestId: "s-1", op: "snapshot", status: "ok", data: {} });
    }
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    porch("devices/0x01/status", { deviceId: "0x01", on: false, power: 3, timestamp: wire(0) });
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    const rows = home.routeRows(r);
    home.setOwner(owner([["hall:lamp", "light"]], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, rows);
    clock.advance(1000);
    porch("devices/0x01/status", { deviceId: "0x01", power: 4, timestamp: wire(clock.now()) });
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]))
      .toEqual([["power", 3, "device"], ["power", 4, "external"]]);
  });

  it("takes a held value the new route re-reports unchanged after a move as no change, a different one as a change (code review r2 I1)", () => {
    const { home, send, copy, owner, porch, events, status, clock } = twoBridges();
    send("devices", { devices: [entry("lamp")] }, true);
    copy();
    for (const [b, at] of [[B, send], [PORCH, porch]] as const) {
      home.listening(b.id);
      at("status", status({ bridgeId: b.identity }));
      at("reply", { requestId: "s-1", op: "snapshot", status: "ok", data: {} });
    }
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    home.setOwner(owner([["hall:lamp", "light"]], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, home.routeRows(r));
    clock.advance(1000);
    porch("devices/0x01/status", { deviceId: "0x01", on: false, timestamp: wire(clock.now()) });
    clock.advance(1000);
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(clock.now()) });
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause])).toEqual([["on", true, "external"]]);
  });

  it("takes a folded copy's values as first values when it is shown again (code review r2 M4)", () => {
    const { home, send, copy, porch, events, clock } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(clock.now()) });
    const mark = events.length;
    send("devices", { devices: [] });
    home.setOwner({ adoptions: new Map(), declarations: new Map() }, { forgotten: ["hall:lamp"], replaced: [], routed: [] });
    expect(home.exposed().map((d) => d.id)).toEqual(["porch:0x01"]);
    clock.advance(1000);
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(clock.now()) });
    porch("devices/0x01/status", { deviceId: "0x01", on: false, timestamp: wire(clock.now()) });
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.target, e.body.value, e.body.cause]))
      .toEqual([["porch:0x01", true, "device"], ["porch:0x01", false, "external"]]);
  });

  it("keeps a device's held keys across a route move whose old bridge is no longer registered: a key held otherwise is external (code review CR1)", () => {
    const { home, send, copy, owner, porch, events, status } = twoBridges();
    send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power"] })] }, true);
    copy({ capabilities: ["onoff", "sensor"], sensorKeys: ["power"] });
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    // The owner unregisters the old bridge: its view of the lamp is gone.
    home.follow(new Map([[PORCH.id, PORCH]]));
    porch("devices/0x01/status", { deviceId: "0x01", on: true, power: 3, timestamp: wire(0) }, true);
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, home.routeRows(r));
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]))
      .toEqual([["on", true, "external"], ["power", 3, "device"]]);
  });

  it("keeps a device's last values across a route move whose old bridge is no longer registered: an equal value says nothing (code review CR1)", () => {
    const { home, send, copy, owner, porch, events, status } = twoBridges();
    send("devices", { devices: [entry("lamp")] }, true);
    copy();
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(0) });
    home.follow(new Map([[PORCH.id, PORCH]]));
    porch("devices/0x01/status", { deviceId: "0x01", on: false, timestamp: wire(0) });
    const mark = events.length;
    const r = { stable_identifier: "test:lamp", device: "hall:lamp", bridge: "porch" };
    home.setOwner(owner([], [["test:lamp", "porch"]]), { forgotten: [], replaced: [], routed: [r] }, home.routeRows(r));
    expect(events.slice(mark).filter((e) => e.type === "state")).toEqual([]);
    porch("devices/0x01/status", { deviceId: "0x01", on: true, timestamp: wire(1000) });
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]))
      .toEqual([["on", true, "external"]]);
  });

  it("folds a copy that arrived beside an adopted device into it once its adoption is deleted: one device again", () => {
    const { home, send, copy, owner } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    home.setOwner(owner([["hall:lamp", "light"]]));
    copy();
    expect(home.exposed().map((d) => d.id).sort()).toEqual(["hall:lamp", "porch:0x01"]);
    home.setOwner(owner());
    expect(home.exposed().map((d) => d.id)).toEqual(["hall:lamp"]);
    expect(home.devices.get("porch:0x01")!.into).toBe("hall:lamp");
  });

  it("counts only copies still in their bridge's devices: one that left makes no duplicate route", () => {
    const { home, send, copy, porch } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(true);
    porch("devices", { devices: [] });
    expect(home.gateDevice("hall:lamp")!.duplicateRoute).toBe(false);
    expect(home.infos().get("hall:lamp")!.copies).toBeUndefined();
  });

  it("folds nothing when one document shows an identifier twice: that bridge admitted the hardware anew", () => {
    const { home, send, porch } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    porch("devices", { devices: [entry("0x01", { stableIdentifier: "test:lamp" }), entry("0x02", { stableIdentifier: "test:lamp" })] });
    expect(home.exposed().map((d) => d.id).sort()).toEqual(["hall:lamp", "porch:0x01", "porch:0x02"]);
  });

  it("shows a folded copy again once it no longer shares the identifier, or its device is forgotten", () => {
    const { home, send, copy, changed } = twoBridges();
    send("devices", { devices: [entry("lamp")] });
    copy();
    copy({ stableIdentifier: "test:other" });
    expect(home.exposed().map((d) => d.id)).toEqual(["hall:lamp", "porch:0x01"]);
    expect(changed.at(-1)!.map((d) => [d.id, d.into])).toEqual([["porch:0x01", undefined]]);
    copy();
    expect(home.devices.get("porch:0x01")!.into).toBe("hall:lamp");
    send("devices", { devices: [] });
    home.setOwner({ adoptions: new Map(), declarations: new Map() }, { forgotten: ["hall:lamp"], replaced: [], routed: [] });
    expect(home.exposed().map((d) => d.id)).toEqual(["porch:0x01"]);
  });

  it("says a route conflict again once it ended and came back", () => {
    const { send, events } = setup();
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" })] });
    send("devices", { devices: [entry("lamp"), entry("lamp-2")] });
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" })] });
    expect(events.filter((e) => e.type === "route_conflict")).toHaveLength(2);
  });

  const GATE = (extra: Record<string, unknown> = {}) => entry("gate", { capabilities: ["cover"], proposedClass: "gate",
    actions: [{ action: "cover.close", idempotent: false, stateless: false, confirms: true }], ...extra });
  const remote = [{ vendor: "demo", label: "remote" }];

  it("describes a device's awaited_keys, undescribed and settings as its bridge gives them, absent where it gives none (GA-DESC-19)", () => {
    const { send, describe } = setup();
    send("devices", { devices: [entry("lamp", { awaitedKeys: ["power"], settings: ["org.galatea.test.lamp.fade"],
      undescribed: [{ name: "dp108", firstSeen: wire(0) }] })] });
    expect(describe()).toMatchObject({ awaited_keys: ["power"], settings: ["org.galatea.test.lamp.fade"],
      undescribed: [{ name: "dp108", first_seen: wire(0) }] });
    send("devices", { devices: [entry("lamp")] });
    for (const k of ["awaited_keys", "settings", "undescribed"]) expect(describe()).not.toHaveProperty(k);
  });

  it("takes a change of awaited_keys or settings as a model change, and of undescribed alone as none (GA-DESC-19)", () => {
    const { send, changed, facts } = setup();
    send("devices", { devices: [entry("lamp")] });
    send("devices", { devices: [entry("lamp", { awaitedKeys: ["power"] })] });
    send("devices", { devices: [entry("lamp", { awaitedKeys: ["power"], settings: ["org.galatea.test.lamp.fade"] })] });
    expect(changed).toHaveLength(3);
    send("devices", { devices: [entry("lamp", { awaitedKeys: ["power"], settings: ["org.galatea.test.lamp.fade"],
      undescribed: [{ name: "dp108", firstSeen: wire(0) }] })] });
    expect(changed).toHaveLength(3);
    expect(facts).toEqual(["hall:lamp"]);
  });

  it("relays its bridge's undescribed event as its own, once per name, kept in events only, and announces a name first met in a devices document (GA-DESC-19)", () => {
    const { send, events, announced } = setup();
    const undescribed = () => events.filter((e) => e.type === "undescribed").map((e) => ({ ...e.body, eventsOnly: e.eventsOnly }));
    send("devices", { devices: [entry("lamp", { undescribed: [{ name: "dp108", firstSeen: wire(0) }] })] }, true);
    expect(undescribed()).toEqual([{ target: "hall:lamp", name: "dp108", eventsOnly: true }]);
    const event = (seq: number, name: string) => send("event", { seq, instanceId: "11111111-1111-4111-8111-111111111111", type: "undescribed",
      device: "lamp", name });
    event(0, "dp108");
    event(1, "dp109");
    event(2, "dp109");
    send("devices", { devices: [entry("lamp", { undescribed: [{ name: "dp108", firstSeen: wire(0) }, { name: "dp109", firstSeen: wire(0) }] })] });
    expect(undescribed()).toEqual([{ target: "hall:lamp", name: "dp108", eventsOnly: true }, { target: "hall:lamp", name: "dp109", eventsOnly: true }]);
    expect(announced).toEqual([["hall", "lamp", ["dp108"]], ["hall", "lamp", ["dp109"]]]);
  });

  it("announces no name again that the store says it announced before a restart (GA-DESC-19, GA-PERSIST-1)", () => {
    const { home, send, events } = setup();
    home.loadAnnounced([{ bridge: "hall", bridge_device: "lamp", name: "dp108" }]);
    send("devices", { devices: [entry("lamp", { undescribed: [{ name: "dp108", firstSeen: wire(0) }, { name: "dp109", firstSeen: wire(0) }] })] }, true);
    expect(events.filter((e) => e.type === "undescribed").map((e) => e.body.name)).toEqual(["dp109"]);
  });

  it("takes an undescribed event of a device it does not hold, or of a bad name, as a bridge fault", () => {
    const { send, faults, events } = setup();
    send("devices", { devices: [entry("lamp")] });
    send("event", { seq: 0, instanceId: "11111111-1111-4111-8111-111111111111", type: "undescribed", device: "ghost", name: "dp1" });
    send("event", { seq: 1, instanceId: "11111111-1111-4111-8111-111111111111", type: "undescribed", device: "lamp", name: "no spaces" });
    expect(faults()).toEqual(["an undescribed event on ghost, a device its devices document does not hold", "an undescribed event on lamp whose name is not of its form"]);
    expect(events.filter((e) => e.type === "undescribed")).toEqual([]);
  });

  it("relays nothing under drops-the-undescribed-event", () => {
    const { send, events } = setup("drops-the-undescribed-event");
    send("devices", { devices: [entry("lamp", { undescribed: [{ name: "dp108", firstSeen: wire(0) }] })] });
    send("event", { seq: 0, instanceId: "11111111-1111-4111-8111-111111111111", type: "undescribed", device: "lamp", name: "dp109" });
    expect(events.filter((e) => e.type === "undescribed")).toEqual([]);
  });

  it("takes a change of other_admins alone as state: an other_admins event, written behind, no model change (GA-DESC-2)", () => {
    const { send, changed, facts, events } = setup();
    send("devices", { devices: [GATE()] });
    send("devices", { devices: [GATE({ otherAdmins: remote })] });
    expect(changed).toHaveLength(1);
    expect(facts).toEqual(["hall:gate"]);
    expect(events.filter((e) => e.type === "other_admins").map((e) => e.body)).toEqual([{ target: "hall:gate", other_admins: remote }]);
  });

  it("says a second door: an admin added to an adopted device above reversible, and its [] after, replacing it; a lapse to unknown and [] again say nothing (GA-ADOPT-3)", () => {
    const { send, notices, own } = setup();
    send("devices", { devices: [GATE(), entry("lamp")] });
    own([["hall:gate", "gate"], ["hall:lamp", "light"]]);
    send("devices", { devices: [GATE({ otherAdmins: remote }), entry("lamp", { otherAdmins: remote })] });
    expect(notices).toEqual([expect.objectContaining({ cause: "other_admin", devices: ["hall:gate"], key: "other_admin:hall:gate" })]);
    send("devices", { devices: [GATE({ otherAdmins: [] }), entry("lamp")] });
    expect(notices).toEqual([expect.objectContaining({ cause: "other_admin", devices: ["hall:gate"], text: expect.stringMatching(/no other admin/) })]);
    send("devices", { devices: [GATE({ otherAdmins: "unknown" }), entry("lamp")] });
    send("devices", { devices: [GATE({ otherAdmins: [] }), entry("lamp")] });
    expect(notices).toHaveLength(1);
    // A read that finds an admin after the lapse is said again.
    send("devices", { devices: [GATE({ otherAdmins: "unknown" }), entry("lamp")] });
    send("devices", { devices: [GATE({ otherAdmins: remote }), entry("lamp")] });
    expect(notices).toHaveLength(2);
  });

  it("judges a device at its adoption: an admin or unknown, with an action above reversible, is a notice; none under hides-a-second-door (GA-ADOPT-3)", () => {
    for (const mutation of [undefined, "hides-a-second-door" as const]) {
      const { home, send, notices, own } = setup(mutation);
      send("devices", { devices: [GATE({ otherAdmins: "unknown" }), entry("lamp", { otherAdmins: "unknown" })] });
      own([["hall:gate", "gate"], ["hall:lamp", "light"]]);
      home.adopted(["hall:gate", "hall:lamp"]);
      expect(notices.map((n) => n.devices), String(mutation)).toEqual(mutation ? [] : [["hall:gate"]]);
    }
  });

  it("judges a device at the higher of its tiers before and after the change set that adopted it (GA-ADOPT-3)", () => {
    const { home, send, notices, own } = setup();
    send("devices", { devices: [entry("heater", { otherAdmins: "unknown" })] });
    // The replacement's change set also dropped the heating load that made turn_on confirm.
    const before = { adoptions: new Map([["hall:heater", { class: "socket" }]]), declarations: new Map([["hall:heater", { load: "heating" as const }]]) };
    own([["hall:heater", "socket"]]);
    home.adopted(["hall:heater"]);
    expect(notices).toEqual([]);
    home.adopted(["hall:heater"], before);
    expect(notices.map((n) => n.devices)).toEqual([["hall:heater"]]);
  });

  it("judges a device adopted in the same set that lowers its extension action, the tier before its adoption counting (GA-ADOPT-3)", () => {
    const { home, send, notices, own } = setup();
    const X = "org.galatea.test.box";
    send("devices", { devices: [entry("box", { otherAdmins: [{ vendor: "demo", label: "cloud" }], actions: [{ action: `${X}.go`, idempotent: false, stateless: true, confirms: true }],
      extensions: [{ capability: X, actions: [{ action: `${X}.go`, schema: { type: "object" } }], keys: [] }] })] });
    const before = { adoptions: new Map(), declarations: new Map() };
    own([["hall:box", "light"]], [["hall:box", { tiers: { [`${X}.go`]: "reversible" }, tier_basis: { [`${X}.go`]: home.fingerprint("hall:box", `${X}.go`)! } }]]);
    home.adopted(["hall:box"]);
    expect(notices).toEqual([]);
    home.adopted(["hall:box"], before);
    expect(notices.map((n) => n.devices)).toEqual([["hall:box"]]);
  });

  it("gives a plugin's action the floor its manifest requests, a standard action's and an extension action's (applier, *Default tiers*)", () => {
    const { send, describe } = setup();
    const X = "org.galatea.test.box";
    send("devices", { devices: [entry("box", { capabilities: ["media"], actions: [
      { action: "media.pause", idempotent: true, stateless: false, confirms: true, requestedTier: "no_voice", toolHash: "a".repeat(64) },
      { action: `${X}.go`, idempotent: false, stateless: true, confirms: true, requestedTier: "reversible" },
      { action: `${X}.stop`, idempotent: false, stateless: true, confirms: true, requestedTier: "no_voice" }],
      extensions: [{ capability: X, actions: [{ action: `${X}.go`, schema: { type: "object" } }, { action: `${X}.stop`, schema: { type: "object" } }], keys: [] }] })] });
    expect(describe("hall:box").actions.map((a: { action: string; tier: string }) => [a.action, a.tier]))
      .toEqual([["media.pause", "no_voice"], [`${X}.go`, "confirm"], [`${X}.stop`, "no_voice"]]);
  });

  it("reads a hosted device's tiers through the computer its bridge names as host, its proposal standing for the owner's flag (applier, *Plugins' actions*)", () => {
    const { send, describe, own } = setup();
    const X = "org.galatea.test.box";
    const pc = (extra: Record<string, unknown> = {}) => entry("pc", { capabilities: ["power"], proposedClass: "computer",
      actions: [{ action: "power.sleep", idempotent: true, stateless: true, confirms: true }], ...extra });
    const box = entry("box", { host: "pc", capabilities: ["media", "power"], actions: [
      { action: "power.shutdown", idempotent: false, stateless: true, confirms: true, requestedTier: "reversible" },
      { action: `${X}.go`, idempotent: false, stateless: true, confirms: true, requestedTier: "reversible" }],
      extensions: [{ capability: X, actions: [{ action: `${X}.go`, schema: { type: "object" } }], keys: [] }] });
    const tiers = (id: string) => describe(id).actions.map((a: { action: string; tier: string }) => [a.action, a.tier]);
    send("devices", { devices: [pc({ proposedInfrastructure: true }), box] });
    expect([tiers("hall:pc"), tiers("hall:box")]).toEqual([[["power.sleep", "no_voice"]], [["power.shutdown", "no_voice"], [`${X}.go`, "no_voice"]]]);
    // The owner's flag, set false, outranks the proposal: the box's shutdown takes the computer row.
    own([["hall:pc", "computer"], ["hall:box", null]], [["hall:pc", { infrastructure: false }]]);
    expect([tiers("hall:pc"), tiers("hall:box")]).toEqual([[["power.sleep", "reversible"]], [["power.shutdown", "confirm"], [`${X}.go`, "confirm"]]]);
  });

  it("counts an admin added against the last list known, across an unknown (GA-ADOPT-3)", () => {
    const { send, notices, own } = setup();
    const remote = [{ vendor: "demo", label: "remote" }];
    send("devices", { devices: [GATE({ otherAdmins: [] })] });
    own([["hall:gate", "gate"]]);
    send("devices", { devices: [GATE({ otherAdmins: remote })] });
    send("devices", { devices: [GATE({ otherAdmins: "unknown" })] });
    send("devices", { devices: [GATE({ otherAdmins: remote })] });
    expect(notices).toHaveLength(1);
  });

  it("judges an adopted device the start-up could not see once its document arrives (GA-ADOPT-3)", () => {
    const { home, send, notices, own } = setup();
    own([["hall:gate", "gate"]]);
    home.adopted(["hall:gate"]);
    expect(notices).toEqual([]);
    send("devices", { devices: [GATE({ otherAdmins: "unknown" })] });
    expect(notices.map((n) => n.devices)).toEqual([["hall:gate"]]);
  });

  it("says an open loop: an adopted device's transport first reading unknown, once, and an adoption on one; neither under its mutation (GA-ADOPT-6)", () => {
    const unknown = (s: ReturnType<typeof setup>) => s.send("status", s.status({ transports: [{ id: "radio", kind: "zigbee", state: "unknown", since: wire(0) }] }));
    const up = (s: ReturnType<typeof setup>) => s.send("status", s.status());
    const open = (s: ReturnType<typeof setup>) => s.notices.filter((n) => n.cause === "open_loop").map((n) => n.devices);
    for (const mutation of [undefined, "upgrades-a-mute-device-quietly" as const, "adopts-a-mute-device-quietly" as const]) {
      const s = setup(mutation);
      s.heard();
      s.send("devices", { devices: [entry("lamp"), entry("fan")] });
      s.own([["hall:lamp", "light"]]);
      unknown(s);
      up(s);
      unknown(s);
      expect(open(s), `${mutation}: upgrade`).toEqual(mutation === "upgrades-a-mute-device-quietly" ? [] : [["hall:lamp"]]);
      s.own([["hall:lamp", "light"], ["hall:fan", "socket"]]);
      s.home.adopted(["hall:fan"]);
      expect(open(s).slice(-1), `${mutation}: adoption`).toEqual(mutation === "adopts-a-mute-device-quietly" ? [["hall:lamp"]]
        : [["hall:fan"]]);
    }
  });

  it("clears an id's open_loop key when new hardware on a transport that answers takes it, so its first unknown is said (GA-ADOPT-6)", () => {
    const s = setup();
    s.heard();
    s.send("devices", { devices: [entry("lamp")] });
    s.own([["hall:lamp", "light"]]);
    s.send("status", s.status({ transports: [{ id: "radio", kind: "zigbee", state: "unknown", since: wire(0) }] }));
    expect(s.keys.has("open_loop:hall:lamp")).toBe(true);
    s.send("status", s.status());
    // New hardware took the id on a transport that is up: the old hardware's key no longer stands.
    s.home.adopted(["hall:lamp"]);
    expect(s.keys.has("open_loop:hall:lamp")).toBe(false);
    s.send("status", s.status({ transports: [{ id: "radio", kind: "zigbee", state: "unknown", since: wire(0) }] }));
    expect(s.notices.filter((n) => n.cause === "open_loop")).toHaveLength(2);
  });

  it("merges a claimant into the adopted device under merges-a-claimant", () => {
    const { home, send, own } = setup("merges-a-claimant");
    send("devices", { devices: [entry("lamp")] });
    own([["hall:lamp", "light"]]);
    send("devices", { devices: [entry("lamp"), entry("lamp-2", { stableIdentifier: "test:lamp" })] });
    expect([...home.devices.keys()]).toEqual(["hall:lamp"]);
  });

  it("drops the whole document under one-bad-entry-silences", () => {
    const { home, send } = setup("one-bad-entry-silences");
    send("devices", { devices: [entry("lamp"), { id: "ghost" }] });
    expect(home.devices.size).toBe(0);
  });

  it("keeps two bridges' devices of one id apart (lesson 12)", () => {
    const { home, send } = setup();
    home.follow(new Map([[B.id, B], ["porch", { id: "porch", identity: "porch-bridge" }]]));
    send("devices", { devices: [entry("0x01")] });
    home.message("porch-bridge", "devices", Buffer.from(JSON.stringify({ devices: [entry("0x01")] })), false);
    expect([...home.devices.keys()].sort()).toEqual(["hall:0x01", "porch:0x01"]);
  });

  it("reads a device dead until its bridge's status arrives live, then live; a retained one never (GA-BUS-8)", () => {
    const { home, send, status, lamp, events } = setup();
    send("devices", { devices: [entry("lamp")] }, true);
    home.listening(B.id);
    send("status", status(), true);
    expect(lamp().liveness).toBe("dead");
    send("status", status());
    expect(lamp().liveness).toBe("live");
    expect(events.filter((e) => e.type === "liveness").map((e) => e.body)).toEqual([{ target: "hall:lamp", old: "dead", new: "live" }]);
    // Dead only because the applier started listening: no fault (lesson 15).
    expect(events.filter((e) => e.type === "bridge_fault")).toEqual([]);
  });

  it("takes a topic that does not come back after a reconnection as no retraction (lessons 3 and 4)", () => {
    const { home, lamp, events, heard } = setup();
    heard();
    const before = events.length;
    home.lost();
    home.listening(B.id);
    expect(home.devices.has("hall:lamp")).toBe(true);
    expect(lamp().liveness).toBe("dead");
    expect(events.slice(before).filter((e) => e.type !== "liveness" && e.type !== "transport" && e.type !== "state")).toEqual([]);
  });

  it("gives each value its observation's time, reports a change once, with its cause, and nothing for the same again (GA-STATE-1, lesson 16)", () => {
    const { clock, send, lamp, events, heard } = setup();
    heard();
    const at = clock.now() - 5000;
    const report = { deviceId: "lamp", state: "on", on: true, timestamp: wire(at), available: true };
    send("devices/lamp/status", report, true);
    send("devices/lamp/status", report);
    expect(lamp().values).toEqual([{ key: "on", value: true, basis_time: wire(at) }]);
    // A first value, none held before, is the device's word (the plug rehearsal's F3).
    expect(events.filter((e) => e.type === "state").map((e) => e.body)).toEqual([
      { target: "hall:lamp", key: "on", value: true, basis_time: wire(at), cause: "device" },
    ]);
  });

  it("takes a self_changing key's change as the device's own", () => {
    const { clock, send, events, home, status } = setup();
    send("devices", { devices: [entry("lamp", { selfChanging: ["mode"] })] });
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", mode: "auto", timestamp: wire(clock.now()), available: true });
    expect(events.find((e) => e.type === "state")?.body.cause).toBe("device");
  });

  it("lets the topic win over a status naming another device, as a fault (lesson 11)", () => {
    const { clock, send, lamp, faults, heard } = setup();
    heard();
    send("devices/lamp/status", { deviceId: "kettle", on: true, timestamp: wire(clock.now()), available: true });
    expect(lamp().values).toHaveLength(1);
    expect(faults()).toEqual(['devices/lamp/status names device "kettle"']);
  });

  it("reads a device dead when unavailable, its status cleared, out of devices, or out of the roster (GA-STATE-2)", () => {
    for (const leave of ["unavailable", "cleared", "doc", "roster"] as const) {
      const { clock, send, lamp, status, heard } = setup();
      heard();
      if (leave === "unavailable") send("devices/lamp/status", { deviceId: "lamp", timestamp: wire(clock.now()), available: false });
      if (leave === "cleared") send("devices/lamp/status", "", true);
      if (leave === "doc") send("devices", { devices: [] });
      if (leave === "roster") send("status", status({}, []));
      expect(lamp().liveness, leave).toBe("dead");
    }
  });

  it("does not take a status with no reading, a re-interview's, as the device leaving or dead (GA-STATE-2)", () => {
    const { clock, home, send, lamp, heard, faults, events } = setup();
    heard();
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true }, true);
    const before = events.length;
    clock.advance(1000);
    send("devices/lamp/status", { deviceId: "lamp", timestamp: wire(clock.now()), available: true }, true);
    expect(lamp().liveness).toBe("live");
    expect(home.devices.has("hall:lamp")).toBe(true);
    expect(faults()).toEqual([]);
    expect(events.slice(before).filter((e) => e.type === "liveness")).toEqual([]);
  });

  it("does not take a roster entry dropped for a bad field as the device leaving (GA-BUS-1)", () => {
    const { send, lamp, status, heard, faults } = setup();
    heard();
    send("status", status({}, [{ id: "lamp", lastCheckIn: "garbage" } as never]));
    expect(lamp().liveness).toBe("live");
    expect(faults()).toEqual(["status devices[0] (lamp): a bad lastCheckIn"]);
  });

  it("does not move the model at every status when one lists a transport id twice", () => {
    const { clock, send, status, modelledTransports, faults } = setup();
    const twice = () => status({ transports: [{ id: "radio", kind: "zigbee", state: "up", since: wire(clock.now()) },
      { id: "radio", kind: "matter", state: "up", since: wire(clock.now()) }] });
    send("status", twice());
    send("status", twice());
    send("status", twice());
    expect(modelledTransports.flat()).toHaveLength(1);
    expect(faults()).toEqual(["status transports[1] (radio) repeats an id"]);
  });

  it("reads a device dead when its transport is down, or the broker is lost", () => {
    const { clock, home, send, lamp, status, heard, events } = setup();
    heard();
    send("status", status({ transports: [{ id: "radio", kind: "zigbee", state: "down", since: wire(clock.now()) }] }));
    expect(lamp().liveness).toBe("dead");
    expect(events.filter((e) => e.type === "transport").map((e) => e.body.state)).toEqual(["up", "down"]);
    send("status", status());
    expect(lamp().liveness).toBe("live");
    home.lost();
    expect(lamp().liveness).toBe("dead");
  });

  it("reads a closed device stale past its bound and slack, judged from last_check_in, not arrival (GA-STATE-5, GA-BUS-10)", () => {
    const { clock, home, send, lamp, status, heard } = setup();
    heard();
    clock.advance(20_000);
    send("status", status({}, [{ id: "lamp", lastCheckIn: wire(clock.now() - 72_000) }]));
    home.tick();
    expect(lamp().liveness).toBe("stale");
    send("status", status());
    expect(lamp().liveness).toBe("live");
  });

  it("reads it live on arrival under fresh-by-arrival", () => {
    const { clock, send, lamp, status, heard } = setup("fresh-by-arrival");
    heard();
    send("status", status({}, [{ id: "lamp", lastCheckIn: wire(clock.now() - 72_000) }]));
    expect(lamp().liveness).toBe("live");
  });

  it("reads a closed device with no known bound stale, and live under live-before-known", () => {
    for (const mutation of [undefined, "live-before-known"] as const) {
      const { send, lamp, status, heard } = setup(mutation);
      heard();
      send("status", status({}, [{ id: "lamp", basisMaxAgeMs: null }]));
      expect(lamp().liveness).toBe(mutation ? "live" : "stale");
      expect(lamp().fresh_s).toBeNull();
    }
  });

  it("takes a value stamped more than 5 s ahead as a fault of unknown age, stale until a good one (GA-BUS-2)", () => {
    const { clock, send, lamp, faults, heard } = setup();
    heard();
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now() + 6000), available: true });
    expect(lamp().liveness).toBe("stale");
    expect(faults()).toHaveLength(1);
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    expect(lamp().liveness).toBe("live");
  });

  it("trusts the fast clock under trusts-a-fast-clock", () => {
    const { clock, send, lamp, faults, heard } = setup("trusts-a-fast-clock");
    heard();
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now() + 6000), available: true });
    expect(lamp().liveness).toBe("live");
    expect(faults()).toEqual([]);
  });

  it("asks for a snapshot on a seq gap and a new instance, and survives what is not JSON (GA-BUS-6, lesson 10)", () => {
    const { send, snapshots, faults, heard, lamp } = setup();
    heard();
    expect(snapshots).toEqual(["hall"]);
    const instanceId = "11111111-1111-4111-8111-111111111111";
    send("event", { seq: 1, instanceId, type: "joined" });
    send("event", { seq: 3, instanceId, type: "joined" });
    send("event", "{");
    expect(snapshots).toEqual(["hall", "hall"]);
    expect(faults()).toEqual(["event is not JSON"]);
    expect(lamp().liveness).toBe("live");
  });

  it("takes an unknown enumerated value as the least it can mean; rejects-unknown-kind drops the message (GA-BUS-3)", () => {
    for (const mutation of [undefined, "rejects-unknown-kind"] as const) {
      const { clock, home, send, status, heard } = setup(mutation);
      heard();
      send("status", status({ state: "hibernating", transports: [{ id: "radio", kind: "lora", state: "up", since: wire(clock.now()) }] }));
      expect(home.transports()).toEqual([{ id: "hall:radio", kind: mutation ? "zigbee" : "other", up: true, state: "up", bridge: "hall" }]);
    }
  });

  it("describes a device valid against applier/device.json", async () => {
    const { validate } = await import("@ludentes/galatea-life-schemas");
    const { heard, own, describe } = setup();
    heard();
    const d = describe();
    expect(validate("applier/device.json", d)).toEqual([]);
    expect(d).toMatchObject({ id: "hall:lamp", adopted: false, class: null, proposed_class: "light", protocol: "zigbee",
      transport: "hall:radio", bridge_device: { bridge: "hall-bridge", id: "lamp" }, fresh_s: 60, fresh_basis: "declared" });
    own([["hall:lamp", "light"]]);
    expect(describe()).toMatchObject({ adopted: true, class: "light" });
  });

  it("keeps a live lamp live when a status or a devices document carries no list (GA-BUS-1, lesson 4)", () => {
    const { send, lamp, status, heard, faults } = setup();
    heard();
    send("status", status({ devices: "oops", transports: "oops" }));
    expect(lamp().liveness).toBe("live");
    send("devices", { devices: "oops" });
    expect(lamp().liveness).toBe("live");
    expect(faults()).toEqual(["status has no transports list", "status has no devices list", "devices has no devices list"]);
  });

  it("reads a transport a well-formed list omits as down, and a missing list as no change", () => {
    const { send, lamp, status, heard, events } = setup();
    heard();
    send("status", status({ transports: [] }));
    expect(lamp().liveness).toBe("dead");
    expect(events.filter((e) => e.type === "transport").map((e) => e.body.state)).toEqual(["up", "down"]);
    send("status", status());
    expect(lamp().liveness).toBe("live");
    send("status", status({ transports: undefined }));
    expect(lamp().liveness).toBe("live");
  });

  it("keeps memory in step with the store when a hook throws, and calls that the applier's bug, not a bridge fault", () => {
    let boom = true;
    const clock = new FakeClock();
    const events: { type: string; body: Record<string, unknown> }[] = [];
    const logs: string[] = [];
    const home = new Home(() => clock.now(), {
      ...NO_NOTICES,
      emit: (type, body) => { if (boom && type === "state") throw new Error("emit broke"); events.push({ type, body }); },
      modelChanged: () => { if (boom) throw new Error("store broke"); },
      snapshot: () => undefined, log: (l) => logs.push(l),
    });
    home.follow(new Map([[B.id, B]]));
    const send = (path: string, body: unknown) => home.message(B.identity, path, Buffer.from(JSON.stringify(body)), false);
    send("devices", { devices: [entry("lamp")] });
    expect(home.devices.size).toBe(0);
    expect(logs.some((l) => l.includes("applier bug") && l.includes("store broke"))).toBe(true);
    expect(events.filter((e) => e.type === "bridge_fault")).toEqual([]);
    boom = false;
    send("devices", { devices: [entry("lamp")] });
    expect(home.devices.size).toBe(1);
    boom = true;
    const report = { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true };
    send("devices/lamp/status", report);
    expect(home.stateOf(home.devices.get("hall:lamp")!).values).toEqual([]);
    boom = false;
    send("devices/lamp/status", report);
    expect(events.filter((e) => e.type === "state")).toHaveLength(1);
    expect(events.filter((e) => e.type === "bridge_fault")).toEqual([]);
  });

  it("holds a new transport only once the model change was taken, and reads a kept one down until its bridge says", () => {
    let boom = true;
    const clock = new FakeClock();
    const taken: HeldTransport[][] = [];
    const home = new Home(() => clock.now(), {
      ...NO_NOTICES,
      emit: () => undefined,
      modelChanged: (_d, t) => { if (boom) throw new Error("store broke"); taken.push(t); },
      snapshot: () => undefined, log: () => undefined,
    });
    home.follow(new Map([[B.id, B]]));
    home.listening(B.id);
    const status = { bridgeId: B.identity, instanceId: "11111111-1111-4111-8111-111111111111", v: 1, state: "online", version: "1",
      levels: ["Serve"], faults: [], ungoverned: [], blocked: [], transports: [{ id: "radio", kind: "zigbee", state: "up", since: wire(clock.now()) }],
      devices: [], publishedAt: wire(clock.now()) };
    const send = () => home.message(B.identity, "status", Buffer.from(JSON.stringify(status)), false);
    send();
    expect(home.transports()).toEqual([]);
    boom = false;
    send();
    expect(taken).toEqual([[{ id: "hall:radio", bridge: "hall", bridge_transport: "radio", kind: "zigbee" }]]);
    expect(home.transports()).toMatchObject([{ id: "hall:radio", up: true }]);
    send();
    expect(taken).toHaveLength(1);
    const again = new Home(() => clock.now(), { ...NO_NOTICES, emit: () => undefined, modelChanged: () => undefined,
      snapshot: () => undefined, log: () => undefined });
    again.load([], taken[0]!);
    again.follow(new Map([[B.id, B]]));
    expect(again.transports()).toEqual([{ id: "hall:radio", kind: "zigbee", up: false, state: "down", bridge: "hall" }]);
  });

  it("raises a status's parse faults once while they stand, and again after they cleared", () => {
    const { send, status, heard, faults } = setup();
    heard();
    const bad = () => status({}, [{ id: "lamp", lastCheckIn: "garbage" } as never]);
    send("status", bad());
    send("status", bad());
    expect(faults()).toHaveLength(1);
    send("status", status());
    send("status", bad());
    expect(faults()).toHaveLength(2);
  });

  it("raises a fast value's fault once while it stands", () => {
    const { clock, send, faults, heard } = setup();
    heard();
    const fast = (d: number) => send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now() + d), available: true });
    fast(6000);
    fast(7000);
    expect(faults()).toHaveLength(1);
    fast(0);
    fast(6000);
    expect(faults()).toHaveLength(2);
  });

  it("clears a device's fast flag on a correctly stamped report of any key (GA-BUS-2)", () => {
    const { clock, send, lamp, heard } = setup();
    heard();
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now() + 6000), available: true });
    expect(lamp().liveness).toBe("stale");
    send("devices/lamp/status", { deviceId: "lamp", level: 5, timestamp: wire(clock.now()), available: true });
    expect(lamp().liveness).toBe("live");
  });

  it("announces values that arrived before their device was known when the document adds it", () => {
    const { clock, home, send, status, events } = setup();
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    expect(events.filter((e) => e.type === "state")).toEqual([]);
    send("devices", { devices: [entry("lamp")] });
    expect(events.filter((e) => e.type === "state").map((e) => e.body)).toEqual([
      { target: "hall:lamp", key: "on", value: true, basis_time: wire(clock.now()), cause: "device" },
    ]);
  });

  it("takes a key's first value, none held before, as the device's word, not a hand: cause device; its next change external (the plug rehearsal's F3)", () => {
    const { clock, send, events, heard } = setup();
    heard();
    // A just-joined device's interview reads, or any retained status after the applier's restart: nothing known before.
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true }, true);
    clock.advance(1000);
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now()), available: true });
    expect(events.filter((e) => e.type === "state").map((e) => [e.body.value, e.body.cause])).toEqual([[true, "device"], [false, "external"]]);
  });

  it("takes an adopted device's first value from a retained status, as after the applier's restart, as the device's word", () => {
    const { clock, send, events, heard, own } = setup();
    heard();
    own([["hall:lamp", "light"]]);
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true }, true);
    expect(events.filter((e) => e.type === "state").map((e) => [e.body.value, e.body.cause])).toEqual([[true, "device"]]);
  });

  it("gives values that arrived before their device was known the cause device when the document adds it, a later change external", () => {
    const { clock, home, send, status, events } = setup();
    home.listening(B.id);
    send("status", status());
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    send("devices", { devices: [entry("lamp")] });
    clock.advance(1000);
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now()), available: true });
    expect(events.filter((e) => e.type === "state").map((e) => [e.body.value, e.body.cause])).toEqual([[true, "device"], [false, "external"]]);
  });

  it("keeps how a value arrived while its device is not described: an adopted device's first value in the load is the device's word (code review CR2)", () => {
    const { clock, home, send, status, events, own } = setup();
    own([["hall:lamp", "light"]]);
    home.listening(B.id);
    // Before the bridge's first live status: the load after the applier's start, whatever the flag says.
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    send("status", status());
    send("devices", { devices: [entry("lamp")] });
    expect(events.filter((e) => e.type === "state").map((e) => [e.body.value, e.body.cause])).toEqual([[true, "device"]]);
  });

  it("takes a live status that came before an adopted device's description, its bridge's snapshot answered, as the device's word: a first value (applier 0.17)", () => {
    const { clock, home, send, status, events, own } = setup();
    own([["hall:lamp", "light"]]);
    home.listening(B.id);
    send("status", status());
    send("reply", { requestId: "s-1", op: "snapshot", status: "ok", data: {} });
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true }, true);
    send("devices", { devices: [entry("lamp")] }, true);
    expect(events.filter((e) => e.type === "state").map((e) => [e.body.value, e.body.cause])).toEqual([[true, "device"]]);
  });

  /**
   * A home with an adopted lamp sensing power and energy, its bridge heard live and its snapshot answered,
   * its `on` held: what comes now is live, from the running instance. `reading` is the apply's hook.
   */
  function settled(mutation?: Mutation, reading?: HomeHooks["reading"]) {
    const s = setup(mutation, [], reading ? { reading } : {});
    s.send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power", "energy"] })] }, true);
    s.own([["hall:lamp", "light"]]);
    s.home.listening(B.id);
    s.send("status", s.status());
    s.send("reply", { requestId: "s-1", op: "snapshot", status: "ok", data: {} });
    s.send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(s.clock.now()), available: true });
    const mark = s.events.length;
    const states = () => s.events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]);
    const verdicts = () => s.events.slice(mark).filter((e) => e.type === "liveness").map((e) => e.body.new);
    const read = (values: Record<string, unknown>, retained = false, available = true) =>
      s.send("devices/lamp/status", { deviceId: "lamp", timestamp: wire(s.clock.now()), available, ...values }, retained);
    return { ...s, states, verdicts, read };
  }

  it("takes a key first reported live on an adopted device, from the running instance, as the device's word; its next change external (applier 0.17)", () => {
    const { states, read, clock } = settled();
    read({ power: 3 });
    clock.advance(1000);
    read({ power: 4 });
    expect(states()).toEqual([["power", 3, "device"], ["power", 4, "external"]]);
    // `externalises-a-live-first-value`: a live one on an adopted device a hand, a retained one still the device's word.
    const live = settled("externalises-a-live-first-value");
    live.read({ power: 3 });
    live.read({ energy: 7 }, true);
    expect(live.states()).toEqual([["power", 3, "external"], ["energy", 7, "device"]]);
  });

  it("takes a held key's changed value, live, as a hand: external; device under devices-a-changed-value (GA-EVT-1)", () => {
    for (const mutation of [undefined, "devices-a-changed-value"] as const) {
      const { states, read, clock } = settled(mutation);
      clock.advance(1000);
      read({ on: true });
      expect([mutation, states()]).toEqual([mutation, [["on", true, mutation ? "device" : "external"]]]);
    }
  });

  it("takes every first value as the device's word under its own rule, and as a hand under externalises-a-first-value (GA-EVT-1)", () => {
    for (const mutation of [undefined, "externalises-a-first-value"] as const) {
      const { states, read } = settled(mutation);
      read({ power: 3 }, true);
      read({ energy: 7 });
      const cause = mutation ? "external" : "device";
      expect([mutation, states()]).toEqual([mutation, [["power", 3, cause], ["energy", 7, cause]]]);
    }
  });

  it("takes a key first reported as its device comes back from dead as the device's word, and a held key changed there as a hand (applier 0.17)", () => {
    const { states, verdicts, read, clock } = settled();
    clock.advance(1000);
    read({}, false, false);
    clock.advance(60_000);
    // Back: a key never held, and the held on, changed while the device was away.
    read({ power: 3, on: true });
    expect([verdicts(), states()]).toEqual([["dead", "live"], [["power", 3, "device"], ["on", true, "external"]]]);
  });

  it("takes a key first reported after a reconnection, a new instance, or a running bridge's silence as the device's word alike (applier 0.17)", () => {
    for (const how of ["reconnection", "new instance", "silence"] as const) {
      const { home, states, read, send, status, clock } = settled();
      if (how === "reconnection") {
        home.lost();
        home.listening(B.id);
      }
      if (how === "new instance") send("lwt", { bridgeId: B.identity, instanceId: "11111111-1111-4111-8111-111111111111" });
      if (how === "silence") {
        clock.advance(31_000);
        home.tick();
      }
      send("status", status(how === "new instance" ? { instanceId: "22222222-2222-4222-8222-222222222222" } : {}));
      clock.advance(20_000);
      read({ power: 3 });
      expect([how, states()]).toEqual([how, [["power", 3, "device"]]]);
    }
  });

  it("gives a first value an apply's correlation claims that apply's cause, not device (GA-EVT-1)", () => {
    const cause = { apply: "a-1", step: 0 };
    const { states, read } = settled(undefined, (_t, key) => key === "power" ? { cause, own: true } : undefined);
    read({ power: 3, energy: 7 });
    expect(states()).toEqual([["power", 3, cause], ["energy", 7, "device"]]);
  });

  it("reports \"unknown\" as the device's word, and neither sets nor clears a held value: the held value again is silent, another external (applier 0.17)", () => {
    const { states, read, clock } = settled();
    clock.advance(1000);
    // Never held: "unknown", then a first value.
    read({ power: "unknown" });
    read({ power: 3 });
    // Held off: "unknown" between, then off again (no change), then on (a change); the laundering case.
    read({ on: "unknown" });
    read({ on: false });
    read({ on: "unknown" });
    clock.advance(1000);
    read({ on: true });
    expect(states()).toEqual([["power", "unknown", "device"], ["power", 3, "device"], ["on", "unknown", "device"], ["on", "unknown", "device"],
      ["on", true, "external"]]);
  });

  it("judges an exposed id's report against what it holds, not its bridge view's fact (code re-review m1)", () => {
    const { home, states, read, clock } = settled();
    clock.advance(1000);
    read({ power: 3 });
    // The id's held values go, its bridge view's facts stay: a fact equal to the report is no held value.
    (home as unknown as { held: Map<string, Map<string, unknown>> }).held.delete("hall:lamp");
    read({ power: 3 });
    clock.advance(1000);
    read({ power: 4 });
    expect(states()).toEqual([["power", 3, "device"], ["power", 3, "device"], ["power", 4, "external"]]);
  });

  it("keeps a held value across a status that leaves the key out, a broker loss, a bridge's new instance and a re-interview: the same value is silent, a change external (applier 0.17)", () => {
    for (const how of ["left out", "broker loss", "new instance", "re-interview"] as const) {
      const { home, states, read, send, status, clock } = settled();
      if (how === "left out") read({ power: 3 });
      if (how === "broker loss") {
        home.lost();
        home.listening(B.id);
        send("status", status());
      }
      if (how === "new instance") {
        send("lwt", { bridgeId: B.identity, instanceId: "11111111-1111-4111-8111-111111111111" });
        send("status", status({ instanceId: "22222222-2222-4222-8222-222222222222" }));
      }
      // A re-interview's status carries no reading.
      if (how === "re-interview") read({});
      clock.advance(1000);
      read({ on: false }, how === "broker loss");
      read({ on: true });
      const want = how === "left out" ? [["power", 3, "device"], ["on", true, "external"]] : [["on", true, "external"]];
      expect([how, states()]).toEqual([how, want]);
    }
  });

  it("takes a held value re-reported unchanged by a bridge re-registered under a new identity as no change (code review r2 I1)", () => {
    const { home, states, read, clock } = settled();
    const B2 = { id: "hall", identity: "hall-bridge-2" };
    home.follow(new Map([[B2.id, B2]]));
    home.listening(B2.id);
    const send2 = (path: string, body: unknown, retained = false) => home.message(B2.identity, path, Buffer.from(JSON.stringify(body)), retained);
    send2("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power", "energy"] })] }, true);
    send2("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now()), available: true }, true);
    clock.advance(1000);
    send2("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    expect(states()).toEqual([["on", true, "external"]]);
    void read;
  });

  it("forgets a forgotten device's held values: the same id listed again takes its bridge's values as first values, a change after external (applier 0.17)", () => {
    const { home, send, events, heard, clock } = setup();
    heard();
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    send("devices", { devices: [] });
    home.setOwner({ adoptions: new Map(), declarations: new Map() }, { forgotten: ["hall:lamp"], replaced: [], routed: [] });
    const mark = events.length;
    send("devices", { devices: [entry("lamp")] });
    clock.advance(1000);
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now()), available: true });
    expect(events.slice(mark).filter((e) => e.type === "state").map((e) => [e.body.target, e.body.value, e.body.cause]))
      .toEqual([["hall:lamp", true, "device"], ["hall:lamp", false, "external"]]);
  });

  it("takes a replacement's first reports under the id as first values, not the old hardware's changes (applier 0.17, GA-ADOPT-2)", () => {
    const { home, send, events, heard, clock } = setup();
    heard();
    send("devices", { devices: [entry("lamp"), entry("lamp-2")] });
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now()), available: true });
    home.setOwner({ adoptions: new Map([["hall:lamp", { class: "light" }]]), declarations: new Map() },
      { forgotten: [], replaced: [{ device: "hall:lamp-2", replaces: "hall:lamp" }], routed: [] });
    const mark = events.length;
    clock.advance(1000);
    send("devices/lamp-2/status", { deviceId: "lamp-2", on: true, timestamp: wire(clock.now()), available: true });
    clock.advance(1000);
    send("devices/lamp-2/status", { deviceId: "lamp-2", on: false, timestamp: wire(clock.now()), available: true });
    expect(events.slice(mark).filter((e) => e.type === "state" && e.body.target === "hall:lamp").map((e) => [e.body.value, e.body.cause]))
      .toEqual([[true, "device"], [false, "external"]]);
  });

  it("raises the missed-device notice from a live devices document answering the reconnection's snapshot (GA-BUS-6, code review r2 M1)", () => {
    const { home, send, heard, notices, status } = setup();
    heard();
    send("reply", { requestId: "r", op: "snapshot", status: "ok", data: {} });
    home.lost();
    home.listening(B.id);
    send("status", status());
    send("devices", { devices: [entry("lamp"), entry("fan")] });
    expect(notices.map((n) => [n.cause, n.devices])).toEqual([["missed_device", ["hall:fan"]]]);
  });

  /** A home whose state events throw while `boom()` is true, its lamp sensing power, and what it emitted. */
  function failing() {
    let boom = true;
    const clock = new FakeClock();
    const events: { type: string; body: Record<string, unknown> }[] = [];
    const home = new Home(() => clock.now(), {
      ...NO_NOTICES,
      emit: (type, body) => { if (boom && type === "state") throw new Error("emit broke"); events.push({ type, body }); },
      modelChanged: () => undefined, snapshot: () => undefined, log: () => undefined,
    });
    home.follow(new Map([[B.id, B]]));
    const send = (path: string, body: unknown, retained = false) => home.message(B.identity, path, Buffer.from(JSON.stringify(body)), retained);
    // Before the description: the value is dropped when its announce fails.
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["power"] })] });
    // Live on the described device: its first announce fails too.
    send("devices/lamp/status", { deviceId: "lamp", power: 3, timestamp: wire(clock.now()), available: true });
    boom = false;
    clock.advance(1000);
    const states = () => events.filter((e) => e.type === "state").map((e) => [e.body.key, e.body.value, e.body.cause]);
    return { clock, send, states };
  }

  it("takes a different value after a failed announce as a change, not a first value again (code review CR5)", () => {
    const { clock, send, states } = failing();
    send("devices/lamp/status", { deviceId: "lamp", on: false, power: 4, timestamp: wire(clock.now()), available: true }, true);
    expect(states()).toEqual([["on", false, "external"], ["power", 4, "external"]]);
  });

  it("takes the same value again after a failed announce as still first: it was never said (code review CR5)", () => {
    const { clock, send, states } = failing();
    send("devices/lamp/status", { deviceId: "lamp", on: true, power: 3, timestamp: wire(clock.now()), available: true });
    expect(states()).toEqual([["on", true, "device"], ["power", 3, "device"]]);
  });

  it("changes to stale by tick alone, and to dead after 30 s of silence", () => {
    const { clock, home, send, lamp, status, heard, events } = setup();
    heard();
    send("status", status({}, [{ id: "lamp", lastCheckIn: wire(clock.now()) }]));
    clock.advance(72_000);
    expect(lamp().liveness).toBe("stale");
    home.tick();
    expect(events.filter((e) => e.type === "liveness").map((e) => e.body.new)).toEqual(["live", "dead"]);
    const again = setup();
    again.heard();
    again.clock.advance(31_000);
    again.home.tick();
    expect(again.lamp().liveness).toBe("dead");
  });

  it("forgets a removed bridge and one whose identity changed, their devices staying dead", () => {
    const { home, send, lamp, heard, events } = setup();
    heard();
    home.follow(new Map());
    expect(home.bridge(B.id)).toBeUndefined();
    expect(lamp().liveness).toBe("dead");
    home.follow(new Map([[B.id, B]]));
    home.listening(B.id);
    expect(lamp().liveness).toBe("dead");
    home.follow(new Map([[B.id, { id: B.id, identity: "other-bridge" }]]));
    send("status", { bridgeId: B.identity });
    expect(home.bridge(B.id)?.identity).toBe("other-bridge");
    expect(lamp().liveness).toBe("dead");
    expect(events.filter((e) => e.type === "liveness").map((e) => e.body.new)).toEqual(["live", "dead"]);
  });

  it("takes a throwing snapshot or event hook as the applier's bug on every path, never a fault or an escape", () => {
    const clock = new FakeClock();
    const events: { type: string; body: Record<string, unknown> }[] = [];
    const logs: string[] = [];
    let boomEmit = false;
    const home = new Home(() => clock.now(), {
      ...NO_NOTICES,
      emit: (type, body) => { if (boomEmit && type === "liveness") throw new Error("emit broke"); events.push({ type, body }); },
      modelChanged: () => undefined,
      snapshot: () => { throw new Error("snapshot broke"); },
      log: (l) => logs.push(l),
    });
    home.follow(new Map([[B.id, B]]));
    const send = (path: string, body: unknown) => home.message(B.identity, path, Buffer.from(JSON.stringify(body)), false);
    send("devices", { devices: [entry("lamp")] });
    home.listening(B.id);
    const st = { bridgeId: B.identity, instanceId: "11111111-1111-4111-8111-111111111111", v: 1, state: "online", ungoverned: [],
      transports: [{ id: "radio", kind: "zigbee", state: "up" }], devices: [{ id: "lamp", basisMaxAgeMs: 60_000, lastCheckIn: wire(clock.now()) }],
      publishedAt: wire(clock.now()) };
    send("status", st);
    expect(logs.some((l) => l.includes("applier bug") && l.includes("snapshot broke"))).toBe(true);
    expect(events.filter((e) => e.type === "bridge_fault")).toEqual([]);
    expect(home.stateOf(home.devices.get("hall:lamp")!).liveness).toBe("live");
    boomEmit = true;
    clock.advance(31_000);
    expect(() => home.tick()).not.toThrow();
    expect(() => home.lost()).not.toThrow();
    expect(events.filter((e) => e.type === "bridge_fault")).toEqual([]);
  });

  it("changes to stale by tick alone, the bridge staying alive on statuses that carry the old check-in", () => {
    const { clock, home, send, status, heard, events } = setup();
    heard();
    const checkedIn = wire(clock.now());
    for (let i = 0; i < 3; i++) {
      clock.advance(20_000);
      send("status", status({}, [{ id: "lamp", lastCheckIn: checkedIn }]));
    }
    clock.advance(12_000);
    expect(events.filter((e) => e.type === "liveness").map((e) => e.body.new)).toEqual(["live"]);
    home.tick();
    expect(events.filter((e) => e.type === "liveness").map((e) => e.body)).toEqual([
      { target: "hall:lamp", old: "dead", new: "live" }, { target: "hall:lamp", old: "live", new: "stale" },
    ]);
  });

  it("keeps a held-before-known value only once its event went out", () => {
    let boom = true;
    const clock = new FakeClock();
    const events: { type: string; body: Record<string, unknown> }[] = [];
    const home = new Home(() => clock.now(), {
      ...NO_NOTICES,
      emit: (type, body) => { if (boom && type === "state") throw new Error("emit broke"); events.push({ type, body }); },
      modelChanged: () => undefined, snapshot: () => undefined, log: () => undefined,
    });
    home.follow(new Map([[B.id, B]]));
    const send = (path: string, body: unknown) => home.message(B.identity, path, Buffer.from(JSON.stringify(body)), false);
    const report = { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true };
    send("devices/lamp/status", report);
    send("devices", { devices: [entry("lamp")] });
    expect(home.stateOf(home.devices.get("hall:lamp")!).values).toEqual([]);
    boom = false;
    send("devices/lamp/status", report);
    expect(events.filter((e) => e.type === "state")).toHaveLength(1);
  });

  it("never takes a value from a fast clock as the last seen (GA-BUS-2)", () => {
    const { clock, send, lamp, events, heard } = setup();
    heard();
    const good = wire(clock.now());
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: good, available: true });
    send("devices/lamp/status", { deviceId: "lamp", on: false, timestamp: wire(clock.now() + 6000), available: true });
    expect(lamp().values).toEqual([{ key: "on", value: true, basis_time: good }]);
    expect(lamp().liveness).toBe("stale");
    expect(events.filter((e) => e.type === "state")).toHaveLength(1);
  });
});

describe("Home: the roster held (the whole-applier review's M1)", () => {
  it("holds only the devices the latest roster lists: one gone from it, fast or not, is dropped", () => {
    const { home, send, status, clock } = setup();
    send("devices", { devices: [entry("lamp")] }, true);
    home.listening(B.id);
    const ahead = wire(clock.now() + 600_000);
    send("status", status({}, [{ id: "lamp" }, { id: "ghost-1" }, { id: "ghost-2", lastCheckIn: ahead }]));
    const v = (home as unknown as { bridges: Map<string, { roster: Map<string, unknown>; fastCheckIn: Set<string> }> }).bridges.get(B.id)!;
    expect([...v.roster.keys()].sort()).toEqual(["ghost-1", "ghost-2", "lamp"]);
    expect([...v.fastCheckIn]).toEqual(["ghost-2"]);
    send("status", status({}, [{ id: "lamp" }]));
    expect([...v.roster.keys()]).toEqual(["lamp"]);
    expect([...v.fastCheckIn]).toEqual([]);
  });
});

describe("Home: occurrences (GA-EVT-8)", () => {
  const V = "org.galatea.test.vibration";
  const sensor = (extra: Record<string, unknown> = {}) => entry("shaker", { capabilities: ["sensor"], sensorKeys: ["battery"], actions: [],
    extensions: [{ capability: V, actions: [], keys: [{ key: `${V}.alarm`, kind: "event", schema: { type: "boolean" } },
      { key: `${V}.sensitivity`, schema: { type: "string" } }] }], ...extra });
  const occurrence = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, instanceId: "11111111-1111-4111-8111-111111111111",
    type: "occurrence", device: "shaker", key: `${V}.alarm`, value: true, timestamp: wire(0), ...extra });
  function heardSensor(mutation?: Mutation, extra: Record<string, unknown> = {}) {
    const s = setup(mutation);
    s.send("devices", { devices: [sensor(extra)] }, true);
    s.home.listening(B.id);
    s.send("status", s.status({}, [{ id: "shaker" }]));
    s.send("event", occurrence(1, { type: "joined" }));
    return s;
  }
  const kinds = (events: { type: string }[]) => events.map((e) => e.type);

  it("takes each occurrence of a declared event key as one occurrence event, cause device, never a state value; a repeated seq is one", () => {
    const { send, events, home, clock } = heardSensor();
    const before = events.length;
    clock.advance(1000);
    send("event", occurrence(2, { timestamp: wire(500) }));
    send("event", occurrence(2, { timestamp: wire(500) }));
    send("event", occurrence(3, { value: false, timestamp: wire(900) }));
    expect(events.slice(before)).toEqual([
      { type: "occurrence", body: { target: "hall:shaker", key: `${V}.alarm`, value: true, basis_time: wire(500), cause: "device" } },
      { type: "occurrence", body: { target: "hall:shaker", key: `${V}.alarm`, value: false, basis_time: wire(900), cause: "device" } },
    ]);
    expect(home.stateOf(home.devices.get("hall:shaker")!).values).toEqual([]);
  });

  it("moves no liveness and no freshness by an occurrence; the check-in that carried it moves last_check_in through the roster", () => {
    const { send, events, home, clock, status } = heardSensor();
    clock.advance(1000);
    const before = events.length;
    send("event", occurrence(2, { timestamp: wire(clock.now()) }));
    expect(kinds(events.slice(before))).toEqual(["occurrence"]);
    send("status", status({}, [{ id: "shaker", lastCheckIn: wire(clock.now()) }]));
    expect(home.stateOf(home.devices.get("hall:shaker")!).last_check_in).toBe(wire(clock.now()));
  });

  it("takes an occurrence of a key the device does not declare an event, of a device not in the model, or ill formed, as a fault, and no event", () => {
    const { send, events, faults } = heardSensor();
    const before = events.filter((e) => e.type === "occurrence").length;
    send("event", occurrence(2, { key: `${V}.sensitivity` }));
    send("event", occurrence(3, { key: "battery" }));
    send("event", occurrence(4, { device: "ghost" }));
    send("event", occurrence(5, { value: { nested: true } }));
    send("event", occurrence(6, { timestamp: "yesterday" }));
    expect(events.filter((e) => e.type === "occurrence")).toHaveLength(before);
    expect(faults()).toEqual([
      `an occurrence of ${V}.sensitivity on shaker, which it does not declare an event key`,
      "an occurrence of battery on shaker, which it does not declare an event key",
      "an occurrence on ghost, a device its devices document does not hold",
      `an occurrence of ${V}.alarm on shaker whose value is not a scalar`,
      `an occurrence of ${V}.alarm on shaker whose timestamp "yesterday" is not a time`,
    ]);
  });

  it("drops an event key from a device's status as a fault: it is never a reading", () => {
    const { send, home, faults, clock } = heardSensor();
    send("devices/shaker/status", { deviceId: "shaker", battery: 80, [`${V}.alarm`]: true, [`${V}.sensitivity`]: "high", timestamp: wire(clock.now()) });
    expect(home.stateOf(home.devices.get("hall:shaker")!).values.map((v) => v.key)).toEqual(["battery", `${V}.sensitivity`]);
    expect(faults()).toEqual([`devices/shaker/status: ${V}.alarm is an event key, never a reading`]);
  });

  it("never holds an event key's value: one a status brought before the device was described, nor a state key its bridge re-declares an event (GA-EVT-8)", () => {
    const early = setup();
    early.home.listening(B.id);
    early.send("status", early.status({}, [{ id: "shaker" }]));
    early.send("devices/shaker/status", { deviceId: "shaker", battery: 80, [`${V}.alarm`]: true, timestamp: wire(0) });
    early.send("devices", { devices: [sensor()] }, true);
    expect(early.home.stateOf(early.home.devices.get("hall:shaker")!).values.map((x) => x.key)).toEqual(["battery"]);
    expect(early.events.filter((e) => e.type === "state").map((e) => e.body.key)).toEqual(["battery"]);
    expect(early.faults()).toContain(`devices/shaker: ${V}.alarm is an event key; its value is dropped, never a reading`);

    const { send, home, clock } = heardSensor();
    send("devices/shaker/status", { deviceId: "shaker", [`${V}.sensitivity`]: "high", timestamp: wire(clock.now()) });
    expect(home.stateOf(home.devices.get("hall:shaker")!).values.map((x) => x.key)).toContain(`${V}.sensitivity`);
    send("devices", { devices: [sensor({ extensions: [{ capability: V, actions: [], keys: [{ key: `${V}.alarm`, kind: "event", schema: { type: "boolean" } },
      { key: `${V}.sensitivity`, kind: "event", schema: { type: "string" } }] }] })] }, true);
    expect(home.stateOf(home.devices.get("hall:shaker")!).values.map((x) => x.key)).not.toContain(`${V}.sensitivity`);
  });

  it("tells whether a device's key is personal now, as the owner declared it since (GA-EVT-5)", () => {
    const { home, own } = heardSensor();
    expect(home.personalNow("hall:shaker", `${V}.alarm`)).toBe(false);
    own([["hall:shaker", "sensor"]], [["hall:shaker", { personal: [`${V}.alarm`] }]]);
    expect(home.personalNow("hall:shaker", `${V}.alarm`)).toBe(true);
    expect(home.personalNow("hall:ghost", `${V}.alarm`)).toBe(false);
  });

  it("gives an occurrence of a key in the device's personal as events only (GA-EVT-5)", () => {
    const { send, events } = heardSensor(undefined, { personal: [`${V}.alarm`] });
    send("event", occurrence(2));
    expect(events.filter((e) => e.type === "occurrence")).toEqual([{ type: "occurrence", eventsOnly: true,
      body: { target: "hall:shaker", key: `${V}.alarm`, value: true, basis_time: wire(0), cause: "device" } }]);
  });

  it("gives it to history too under history-keeps-a-personal-occurrence, and stores it as state under stores-an-occurrence-as-state", () => {
    const kept = heardSensor("history-keeps-a-personal-occurrence", { personal: [`${V}.alarm`] });
    kept.send("event", occurrence(2));
    expect(kept.events.filter((e) => e.type === "occurrence")).toEqual([{ type: "occurrence",
      body: { target: "hall:shaker", key: `${V}.alarm`, value: true, basis_time: wire(0), cause: "device" } }]);
    const stored = heardSensor("stores-an-occurrence-as-state");
    stored.send("event", occurrence(2));
    expect(stored.home.stateOf(stored.home.devices.get("hall:shaker")!).values).toMatchObject([{ key: `${V}.alarm`, value: true }]);
  });
});

describe("Home: declarations", () => {
  const gate = entry("gate", { capabilities: ["cover"], proposedClass: "gate", actions: ["cover.open", "cover.close"]
    .map((action) => ({ action, idempotent: false, stateless: false, confirms: true })) });
  const socket = (id: string) => entry(id, { proposedClass: "socket", actions: ["onoff.turn_on", "onoff.turn_off"]
    .map((action) => ({ action, idempotent: true, stateless: false, confirms: true })) });
  const tiers = (d: Record<string, unknown>) => Object.fromEntries((d.actions as { action: string; tier: string }[]).map((a) => [a.action, a.tier]));

  it("gives each action its tier from the table and the owner's, re-applied when a load changes (GA-DESC-3, GA-DESC-13)", () => {
    const { send, own, describe } = setup();
    send("devices", { devices: [gate, socket("heater"), entry("lamp")] });
    own([["hall:gate", "gate"], ["hall:heater", "socket"], ["hall:lamp", "light"]],
      [["hall:heater", { load: "lighting" }], ["hall:lamp", { tiers: { "onoff.turn_on": "confirm" } }]]);
    expect(tiers(describe("hall:gate"))).toEqual({ "cover.open": "no_voice", "cover.close": "confirm" });
    expect(tiers(describe("hall:heater"))).toEqual({ "onoff.turn_on": "reversible", "onoff.turn_off": "reversible" });
    expect(describe("hall:heater")).toMatchObject({ load: "lighting", infrastructure: false });
    expect(tiers(describe("hall:lamp"))).toEqual({ "onoff.turn_on": "confirm" });
    own([["hall:heater", "socket"]], [["hall:heater", { load: "heating", infrastructure: true }]]);
    expect(tiers(describe("hall:heater"))).toEqual({ "onoff.turn_on": "confirm", "onoff.turn_off": "no_voice" });
  });

  it("gives an extension action, on any device, confirm or its floor where higher: the highest tier any row naming its class, flag or load gives any action (GA-DESC-3)", () => {
    const { send, own, describe } = setup();
    const X = "org.galatea.test.box";
    const boxed = (id: string) => entry(id, { actions: [{ action: `${X}.go`, idempotent: false, stateless: true, confirms: true }],
      extensions: [{ capability: X, actions: [{ action: `${X}.go`, schema: {} }], keys: [] }] });
    const ids = ["plain", "lock", "valve", "gate", "boiler", "heater", "rack"];
    send("devices", { devices: ids.map(boxed) });
    own([["hall:plain", null], ["hall:lock", "door_lock"], ["hall:valve", "water_valve"], ["hall:gate", "gate"], ["hall:boiler", "boiler"],
      ["hall:heater", "socket"], ["hall:rack", "socket"]], [["hall:heater", { load: "heating" }], ["hall:rack", { infrastructure: true }]]);
    expect(Object.fromEntries(ids.map((id) => [id, tiers(describe(`hall:${id}`))[`${X}.go`]]))).toEqual({ plain: "confirm",
      lock: "no_voice", valve: "no_voice", gate: "no_voice", boiler: "confirm", heater: "confirm", rack: "no_voice" });
  });

  it("keeps a tier below a new load under keeps-a-tier-below-a-new-load", () => {
    const { send, own, describe } = setup("keeps-a-tier-below-a-new-load");
    send("devices", { devices: [socket("heater")] });
    own([["hall:heater", "socket"]], [["hall:heater", { load: "heating" }]]);
    expect(tiers(describe("hall:heater"))["onoff.turn_on"]).toBe("reversible");
  });

  it("lists notify and media.announce as never idempotent, whatever the bridge says (GA-DESC-4)", () => {
    const { send, describe } = setup();
    send("devices", { devices: [entry("speaker", { capabilities: ["media", "notify"], actions: ["media.announce", "notify.notify", "media.pause"]
      .map((action) => ({ action, idempotent: true, stateless: action !== "media.pause", confirms: true })) })] });
    const idem = Object.fromEntries((describe("hall:speaker").actions as { action: string; idempotent: boolean }[]).map((a) => [a.action, a.idempotent]));
    expect(idem).toEqual({ "media.announce": false, "notify.notify": false, "media.pause": true });
  });

  it("describes a device's extensions, valid against applier/device.json, each key's kind filled; an extension action never idempotent, whatever its bridge says (GA-DESC-1, GA-DESC-4)", async () => {
    const { validate } = await import("@ludentes/galatea-life-schemas");
    const { send, describe } = setup();
    const PUSH = "org.galatea.test.pusher";
    send("devices", { devices: [entry("pusher", { actions: [...entry("pusher").actions,
      { action: `${PUSH}.set_mode`, idempotent: true, stateless: false, confirms: false, confirmedBy: { key: `${PUSH}.mode`, value: { arg: "mode" } } }],
    extensions: [{ capability: PUSH, description: "Its settings.", actions: [{ action: `${PUSH}.set_mode`, description: "Sets the mode.",
      schema: { type: "object" } }], keys: [{ key: `${PUSH}.mode`, description: "The mode.", schema: { type: "string" } }] }] })] });
    const d = describe("hall:pusher");
    expect(validate("applier/device.json", d)).toEqual([]);
    expect(d.extensions).toEqual([{ capability: PUSH, description: "Its settings.", actions: [{ action: `${PUSH}.set_mode`,
      description: "Sets the mode.", schema: { type: "object" } }], keys: [{ key: `${PUSH}.mode`, kind: "state", description: "The mode.",
      schema: { type: "string" } }] }]);
    expect((d.actions as Record<string, unknown>[]).find((a) => a.action === `${PUSH}.set_mode`)).toMatchObject({ idempotent: false,
      confirmed_by: { key: `${PUSH}.mode`, value: { arg: "mode" } } });
    expect((d.actions as Record<string, unknown>[]).find((a) => a.action === "onoff.turn_on")).toMatchObject({ idempotent: true });
  });

  it("gives an extension action the default ack_within_s of its own capability, read to the last dot, never the first segment's", () => {
    const { send, describe } = setup();
    send("devices", { devices: [entry("blind", { capabilities: ["cover"], reachMs: 0, actions: [{ action: "cover.demo.tilt", idempotent: false,
      stateless: true, confirms: true }], extensions: [{ capability: "cover.demo", actions: [{ action: "cover.demo.tilt", schema: {} }], keys: [] }] })] });
    expect((describe("hall:blind").actions as Record<string, unknown>[])[0]).toMatchObject({ action: "cover.demo.tilt", ack_within_s: 10 });
  });

  it("takes a device on an ir transport as open, as a fault once while its bridge says closed (GA-DESC-7)", () => {
    const { send, status, home, faults, describe } = setup();
    send("devices", { devices: [entry("tv", { transport: "blaster" })] }, true);
    home.listening(B.id);
    send("status", status({ transports: [{ id: "blaster", kind: "ir", state: "unknown", since: wire(0) }] }, [{ id: "tv" }]));
    send("devices", { devices: [entry("tv", { transport: "blaster" })] });
    send("devices", { devices: [entry("tv", { transport: "blaster" })] });
    expect(describe("hall:tv")).toMatchObject({ protocol: "ir", feedback: "open" });
    expect(faults()).toEqual(["tv is on an ir transport and declared closed; taken as open"]);
    expect(home.stateOf(home.devices.get("hall:tv")!).liveness).toBe("live");
  });

  it("raises the ir fault when a status gives the transport's kind after the only devices document", () => {
    const { send, status, home, faults } = setup();
    send("devices", { devices: [entry("tv", { transport: "blaster" })] }, true);
    home.listening(B.id);
    send("status", status({ transports: [{ id: "blaster", kind: "ir", state: "unknown", since: wire(0) }] }, [{ id: "tv" }]));
    expect(faults()).toEqual(["tv is on an ir transport and declared closed; taken as open"]);
  });

  it("holds every personal and self_changing key the standard, the bridge and the owner declare (GA-DESC-9)", () => {
    const { send, own, describe } = setup();
    send("devices", { devices: [entry("desk", { capabilities: ["sensor", "media"], sensorKeys: ["app", "temperature"], actions: [],
      personal: ["temperature"], selfChanging: ["temperature"] })] });
    own([], [["hall:desk", { personal: ["volume"], self_changing: ["volume"] }]]);
    expect(describe("hall:desk")).toMatchObject({ personal: ["app", "speech", "temperature", "volume"], self_changing: ["speech", "temperature", "volume"] });
  });

  it("takes a bridge's self_changing sensor key as the device's own on an adopted device heard live, its `on` a hand's (FL-GAP-2)", () => {
    const { clock, send, events, own, home, status } = setup();
    send("devices", { devices: [entry("lamp", { capabilities: ["onoff", "sensor"], sensorKeys: ["occupancy", "battery"],
      selfChanging: ["occupancy", "battery"] })] }, true);
    home.listening(B.id);
    send("status", status());
    own([["hall:lamp", "light"]]);
    const report = (r: Record<string, unknown>) => {
      clock.advance(1000);
      send("devices/lamp/status", { deviceId: "lamp", timestamp: wire(clock.now()), available: true, ...r });
    };
    report({ on: false, occupancy: false, battery: 90 });
    report({ on: false, occupancy: true, battery: 90 });
    report({ on: false, occupancy: false, battery: 89 });
    report({ on: true, occupancy: false, battery: 89 });
    const causes = events.filter((e) => e.type === "state").map((e) => [e.body.key, e.body.cause]);
    const readings = causes.filter(([k]) => k !== "on");
    expect(readings).toHaveLength(5);
    expect(new Set(readings.map(([, c]) => c))).toEqual(new Set(["device"]));
    expect(causes.filter(([k]) => k === "on").at(-1)).toEqual(["on", "external"]);
  });

  it("takes an owner's self_changing key's change as the device's own", () => {
    const { clock, send, events, own, heard } = setup();
    heard();
    own([], [["hall:lamp", { self_changing: ["on"] }]]);
    send("devices/lamp/status", { deviceId: "lamp", on: true, timestamp: wire(clock.now()), available: true });
    expect(events.filter((e) => e.type === "state").map((e) => e.body.cause)).toEqual(["device"]);
  });

  it("says nothing of a reach its bridge did not give, as a fault, and bounds the ack by the class alone", () => {
    const { send, describe, faults } = setup();
    const { reachMs: _r, ...noReach } = entry("lamp");
    send("devices", { devices: [noReach] });
    const d = describe();
    expect(d.reach_s).toBeUndefined();
    expect((d.actions as { ack_within_s: number }[])[0]!.ack_within_s).toBe(10);
    expect(faults()).toEqual(["devices[0] (lamp) has no valid reachMs"]);
  });

  it("gives the owner's ack_within_s, never below twice the reach plus 10", () => {
    const { send, own, describe } = setup();
    send("devices", { devices: [entry("lamp", { reachMs: 30_000 })] });
    expect((describe().actions as { ack_within_s: number }[])[0]!.ack_within_s).toBe(70);
    own([], [["hall:lamp", { ack_within_s: { "onoff.turn_on": 120 } }]]);
    expect((describe().actions as { ack_within_s: number }[])[0]!.ack_within_s).toBe(120);
    // Below that floor (a reach that grew since): the floor.
    own([], [["hall:lamp", { ack_within_s: { "onoff.turn_on": 20 } }]]);
    expect((describe().actions as { ack_within_s: number }[])[0]!.ack_within_s).toBe(70);
  });

  it("gives the owner's ack_within_s as given below the class default, never raised to it (GA-CFG-3)", () => {
    const { send, own, describe } = setup();
    send("devices", { devices: [gate] });
    own([["hall:gate", "gate"]], [["hall:gate", { ack_within_s: { "cover.close": 30 } }]]);
    const ack = Object.fromEntries((describe("hall:gate").actions as { action: string; ack_within_s: number }[]).map((a) => [a.action, a.ack_within_s]));
    expect(ack).toEqual({ "cover.open": 90, "cover.close": 30 });
  });
});

describe("Home: bounds and open devices", () => {
  it("makes an owner's fresh_s the effective bound, over a declared one or none, with a freshness event (GA-STATE-6)", () => {
    const { clock, home, send, own, status, lamp, events, describe } = setup();
    send("devices", { devices: [entry("lamp")] }, true);
    home.listening(B.id);
    send("status", status());
    // The first bound in a life is a change from unknown, reported as events are (C10).
    expect(events.filter((e) => e.type === "freshness").map((e) => e.body)).toEqual([
      { target: "hall:lamp", fresh_s: 60, fresh_basis: "declared" }]);
    own([], [["hall:lamp", { fresh_s: 20 }]]);
    expect(describe()).toMatchObject({ fresh_s: 20, fresh_basis: "configured" });
    expect(lamp()).toMatchObject({ fresh_s: 20, fresh_basis: "configured" });
    expect(events.filter((e) => e.type === "freshness").map((e) => e.body).slice(1)).toEqual([
      { target: "hall:lamp", fresh_s: 20, fresh_basis: "configured", declared_fresh_s: 60 }]);
    clock.advance(32_000);
    send("status", status({}, [{ id: "lamp", lastCheckIn: wire(clock.now() - 32_000) }]));
    expect(lamp().liveness).toBe("stale");
    own([], []);
    expect(lamp()).toMatchObject({ fresh_s: 60, fresh_basis: "declared", liveness: "live" });
    expect(events.filter((e) => e.type === "freshness")).toHaveLength(3);
  });

  it("says nothing of a bound while none is known: unknown is where a life starts", () => {
    const { send, events } = setup();
    send("devices", { devices: [entry("lamp")] }, true);
    expect(events.filter((e) => e.type === "freshness")).toEqual([]);
  });

  it("gives an open device no bound, keeping the owner's fresh_s for when it is closed (C7)", () => {
    const { home, send, own, status, events, describe } = setup();
    send("devices", { devices: [entry("tv", { feedback: "open" })] }, true);
    home.listening(B.id);
    send("status", status({}, [{ id: "tv", basisMaxAgeMs: null, lastCheckIn: null }]));
    own([], [["hall:tv", { fresh_s: 20 }]]);
    expect(describe("hall:tv")).toMatchObject({ fresh_s: null, fresh_basis: "unknown" });
    expect(home.stateOf(home.devices.get("hall:tv")!)).toMatchObject({ fresh_s: null, fresh_basis: "unknown" });
    expect(events.filter((e) => e.type === "freshness")).toEqual([]);
    // Closed later: the owner's value takes effect.
    send("devices", { devices: [entry("tv", { feedback: "closed" })] });
    expect(describe("hall:tv")).toMatchObject({ fresh_s: 20, fresh_basis: "configured" });
  });

  it("gives a device whose bridge knows no bound the owner's, live by it (GA-STATE-6)", () => {
    const { home, send, own, status, lamp } = setup();
    send("devices", { devices: [entry("lamp")] }, true);
    home.listening(B.id);
    send("status", status({}, [{ id: "lamp", basisMaxAgeMs: null }]));
    expect(lamp()).toMatchObject({ liveness: "stale", fresh_basis: "unknown" });
    own([], [["hall:lamp", { fresh_s: 600 }]]);
    expect(lamp()).toMatchObject({ liveness: "live", fresh_s: 600, fresh_basis: "configured" });
  });

  it("reads by the declared bound under ignores-owner-bound", () => {
    const { heard, own, lamp } = setup("ignores-owner-bound");
    heard();
    own([], [["hall:lamp", { fresh_s: 20 }]]);
    expect(lamp()).toMatchObject({ fresh_s: 60, fresh_basis: "declared" });
  });

  it("keeps an open device live on an up or unknown transport, dead when down, and takes no reading of it (GA-STATE-4)", () => {
    for (const mutation of [undefined, "kills-a-mute-transmitters-devices"] as const) {
      const { home, send, status, faults, clock } = setup(mutation);
      send("devices", { devices: [entry("tv", { feedback: "open" })] }, true);
      home.listening(B.id);
      const tv = () => home.stateOf(home.devices.get("hall:tv")!);
      for (const [state, want] of [["up", "live"], ["unknown", mutation ? "dead" : "live"], ["down", "dead"]] as const) {
        send("status", status({ transports: [{ id: "radio", kind: "other", state, since: wire(clock.now()) }] },
          [{ id: "tv", basisMaxAgeMs: null, lastCheckIn: null }]));
        expect(tv().liveness, `${mutation}: ${state}`).toBe(want);
      }
      send("devices/tv/status", { deviceId: "tv", on: true, timestamp: wire(clock.now()), available: true });
      expect(tv().values).toEqual([]);
      expect(faults()).toEqual(["devices/tv/status: readings of a device that is feedback open"]);
    }
  });
});

describe("Home: bus faults", () => {
  it("raises a refused subscription's fault once while it stands, and again after the bridge was listening (B3)", () => {
    const { home, faults } = setup();
    home.bridgeFault(B.id, "galatea/bridges/hall-bridge/status refused (0x87)");
    home.bridgeFault(B.id, "galatea/bridges/hall-bridge/status refused (0x87)");
    expect(faults()).toEqual(["galatea/bridges/hall-bridge/status refused (0x87)"]);
    home.listening(B.id);
    home.bridgeFault(B.id, "galatea/bridges/hall-bridge/status refused (0x87)");
    expect(faults()).toHaveLength(2);
  });
});

describe("Home: notices", () => {
  const withFault = (status: (e?: Record<string, unknown>) => Record<string, unknown>, faults: unknown[]) => status({ faults });

  it("raises a bridge_fault notice for a faults entry naming an adopted device, once while it stands (GA-BUS-12)", () => {
    const { send, status, heard, own, notices, events, keys } = setup();
    heard();
    own([["hall:lamp", "light"]]);
    send("status", withFault(status, [{ code: "no_pin", device: "lamp" }, { code: "no_pin", device: "ghost" }, { code: "overheated" }]));
    send("status", withFault(status, [{ code: "no_pin", device: "lamp" }]));
    expect(notices).toEqual([{ cause: "bridge_fault", devices: ["hall:lamp"], text: "Bridge hall reports a fault on hall:lamp: no_pin.",
      key: "bridge_fault:hall:lamp:no_pin" }]);
    expect(events.filter((e) => e.type === "bridge_fault").map((e) => e.body.what)).toEqual([
      "status fault no_pin on device lamp", "status fault no_pin on device ghost", "status fault overheated"]);
    send("status", withFault(status, []));
    expect(keys.size).toBe(0);
    send("status", withFault(status, [{ code: "no_pin", device: "lamp" }]));
    expect(notices).toHaveLength(2);
  });

  it("bounds a bridge's device-fault notices: codes cut to 128 characters, at most 64 standing (notice growth)", () => {
    const { send, status, heard, own, notices, faults } = setup();
    heard();
    own([["hall:lamp", "light"]]);
    const long = "x".repeat(300);
    send("status", withFault(status, [{ code: long, device: "lamp" }]));
    expect(notices[0]!.key).toBe(`bridge_fault:hall:lamp:${"x".repeat(128)}`);
    expect(notices[0]!.text).toBe(`Bridge hall reports a fault on hall:lamp: ${"x".repeat(128)}.`);
    const many = Array.from({ length: 70 }, (_, i) => ({ code: `c${i}`, device: "lamp" }));
    send("status", withFault(status, many));
    expect(notices.slice(1)).toHaveLength(64);
    expect(faults().filter((f) => /more than 64/.test(String(f)))).toHaveLength(1);
    send("status", withFault(status, many));
    expect(notices.slice(1)).toHaveLength(64);
    expect(faults().filter((f) => /more than 64/.test(String(f)))).toHaveLength(1);
  });

  it("raises none for an unadopted device, none twice across a restart while it stands, and none under swallows-device-fault", () => {
    const unadopted = setup();
    unadopted.heard();
    unadopted.send("status", withFault(unadopted.status, [{ code: "no_pin", device: "lamp" }]));
    expect(unadopted.notices).toEqual([]);
    // The key stood when the last life ended: the store kept it.
    const restarted = setup(undefined, ["bridge_fault:hall:lamp:no_pin"]);
    restarted.own([["hall:lamp", "light"]]);
    restarted.send("devices", { devices: [entry("lamp")] }, true);
    restarted.home.listening(B.id);
    restarted.send("status", withFault(restarted.status, [{ code: "no_pin", device: "lamp" }]));
    expect(restarted.notices).toEqual([]);
    restarted.send("status", withFault(restarted.status, []));
    expect(restarted.keys.size).toBe(0);
    const swallowed = setup("swallows-device-fault");
    swallowed.heard();
    swallowed.own([["hall:lamp", "light"]]);
    swallowed.send("status", withFault(swallowed.status, [{ code: "no_pin", device: "lamp" }]));
    expect(swallowed.notices).toEqual([]);
  });

  it("raises a notice for an unadopted device it missed, from a re-sent devices document only (GA-BUS-6)", () => {
    const { send, heard, notices, snapshots, status, clock } = setup();
    heard();
    // The bridge's first live status asked for a snapshot; its reply ends the answer.
    expect(snapshots).toEqual(["hall"]);
    send("reply", { requestId: "r", op: "snapshot", status: "ok", data: {} });
    // Live, as a join: slice 5's window notice says it, not this one.
    send("devices", { devices: [entry("lamp"), entry("kettle")] });
    expect(notices).toEqual([]);
    // Retained on subscribing again after the applier was away: missed.
    send("devices", { devices: [entry("lamp"), entry("kettle"), entry("fan")] }, true);
    expect(notices).toEqual([{ cause: "missed_device", devices: ["hall:fan"],
      text: "Bridge hall holds a device the applier had not seen, not adopted: hall:fan." }]);
    // The answer to a snapshot, until its reply.
    send("status", status({ instanceId: "22222222-2222-4222-8222-222222222222" }));
    expect(snapshots).toEqual(["hall", "hall"]);
    send("devices", { devices: [entry("lamp"), entry("kettle"), entry("fan"), entry("heater")] });
    expect(notices.map((n) => n.devices)).toEqual([["hall:fan"], ["hall:heater"]]);
    send("reply", { requestId: "r", op: "snapshot", status: "ok", data: {} });
    send("devices", { devices: [entry("lamp"), entry("kettle"), entry("fan"), entry("heater"), entry("pump")] });
    expect(notices).toHaveLength(2);
    // Unanswered, a snapshot's window closes with its request's 10 s expiry.
    send("status", status({ instanceId: "33333333-3333-4333-8333-333333333333" }));
    clock.advance(10_001);
    send("status", status({ instanceId: "33333333-3333-4333-8333-333333333333" }));
    send("devices", { devices: [entry("lamp"), entry("kettle"), entry("fan"), entry("heater"), entry("pump"), entry("oven")] });
    expect(notices).toHaveLength(2);
  });

  it("raises the missed notice before the device rows go to the writer: a failed hand-over leaves a duplicate, never a loss (C11)", () => {
    const order: string[] = [];
    let refuse = false;
    const home = new Home(() => 0, {
      emit: () => undefined,
      modelChanged: (d) => { order.push(`model ${d.map((x) => x.id).join(",")}`); if (refuse) throw new Error("the writer is gone"); },
      snapshot: () => undefined,
      notice: (n) => void order.push(`notice ${n.cause} ${n.devices?.join(",")}`),
      clearNotice: () => undefined, standingNotices: () => [], log: () => undefined,
    });
    home.follow(new Map([[B.id, B]]));
    const send = (body: unknown, retained: boolean) => home.message(B.identity, "devices", Buffer.from(JSON.stringify(body)), retained);
    send({ devices: [entry("lamp")] }, false);
    refuse = true;
    send({ devices: [entry("lamp"), entry("fan")] }, true);
    expect(order).toEqual(["model hall:lamp", "notice missed_device hall:fan", "model hall:fan"]);
    expect(home.devices.has("hall:fan")).toBe(false);
  });

  it("raises none for the devices of a bridge the owner just registered", () => {
    const { send, notices } = setup();
    send("devices", { devices: [entry("lamp"), entry("kettle")] }, true);
    expect(notices).toEqual([]);
  });

  it("keeps facts for at most MAX_UNLISTED device topics a bridge lists nowhere, the oldest going first", () => {
    const { home, heard, send, faults, clock } = setup();
    heard();
    for (let i = 0; i <= MAX_UNLISTED; i++) send(`devices/bogus${i}/status`, { deviceId: `bogus${i}`, on: true, timestamp: wire(clock.now()), available: true });
    send("devices", { devices: [entry("lamp"), entry("bogus0"), entry(`bogus${MAX_UNLISTED}`)] });
    // The first went, the last stayed: its value is its first news now.
    expect(home.stateOf(home.devices.get("hall:bogus0")!).values).toEqual([]);
    expect(home.stateOf(home.devices.get(`hall:bogus${MAX_UNLISTED}`)!).values).toHaveLength(1);
    expect(faults()).toEqual([`more than ${MAX_UNLISTED} device topics its devices document does not list`]);
  });
});

describe("Home: an action's declarations, fingerprinted (GA-DESC-18)", () => {
  const P = "org.galatea.test.pusher";
  const doc = (): DeviceDoc => ({ id: "pusher", stable_identifier: "test:pusher", transport: "radio", capabilities: ["onoff"], sensor_keys: [],
    actions: [{ action: "onoff.turn_on", idempotent: true, stateless: false, toggles: false, whole_state: false, confirms: true },
      { action: `${P}.set_mode`, idempotent: false, stateless: false, toggles: false, whole_state: false, confirms: false,
        confirmed_by: { key: `${P}.mode`, value: { arg: "mode" } } }],
    feedback: "closed", reach_ms: 0, proposed_class: "socket", class_evidence: "protocol", other_admins: [], self_changing: [], personal: [],
    internal: false, extensions: [{ capability: P, description: "Its settings.", actions: [{ action: `${P}.set_mode`, description: "Sets its mode.",
      schema: { type: "object", properties: { mode: { enum: ["click", "switch"] } } } }],
    keys: [{ key: `${P}.mode`, kind: "state", description: "Its mode.", schema: { type: "string" } },
      { key: `${P}.other`, kind: "state", schema: { type: "string" } }] }] });
  const changed = (edit: (d: DeviceDoc) => void, action = `${P}.set_mode`) => {
    const d = doc();
    edit(d);
    return fingerprintOf(d, action) !== fingerprintOf(doc(), action);
  };

  it("moves with what the action does and how it is judged: its entry, its schema, its confirmed_by key's kind, schema and marks, the device's feedback and reach", () => {
    expect(changed((d) => { d.actions[1]!.confirms = true; })).toBe(true);
    expect(changed((d) => { d.extensions![0]!.actions[0]!.schema = { type: "object" }; })).toBe(true);
    expect(changed((d) => { d.extensions![0]!.keys[0]!.kind = "event"; })).toBe(true);
    expect(changed((d) => { d.self_changing = [`${P}.mode`]; })).toBe(true);
    expect(changed((d) => { d.personal = [`${P}.mode`]; })).toBe(true);
    expect(changed((d) => { d.reach_ms = 500; })).toBe(true);
    expect(changed((d) => { d.actions = d.actions.slice(0, 1); })).toBe(true);
  });

  it("stays where only something the action does not read changes: a description, another key, another action", () => {
    expect(changed((d) => { d.extensions![0]!.description = "Other words."; })).toBe(false);
    expect(changed((d) => { d.extensions![0]!.actions[0]!.description = "Other words."; })).toBe(false);
    expect(changed((d) => { d.extensions![0]!.keys[0]!.description = "Other words."; })).toBe(false);
    expect(changed((d) => { d.extensions![0]!.keys[1]!.schema = { type: "number" }; })).toBe(false);
    expect(changed((d) => { d.actions[0]!.idempotent = false; })).toBe(false);
    expect(changed((d) => { d.self_changing = [`${P}.other`]; })).toBe(false);
  });

  it("keeps a bridge's latest levels and type, retained or live, and hands on replies and provisioning events (slice 5a)", () => {
    const { home, send, status, replies, provisioning, faults } = setup();
    expect(home.bridgeFacts(B.id)).toMatchObject({ alive: false, levels: [], identity: B.identity });
    send("status", status({ levels: ["Serve", "Provision"], bridgeType: "test" }), true);
    expect(home.bridgeFacts(B.id)).toMatchObject({ alive: false, levels: ["Serve", "Provision"], bridge_type: "test" });
    home.listening(B.id);
    send("status", status({ levels: ["Serve"] }));
    expect(home.bridgeFacts(B.id)).toMatchObject({ alive: true, levels: ["Serve"] });
    expect(home.bridgeFacts(B.id)).not.toHaveProperty("bridge_type");
    expect(home.bridgeFacts("nowhere")).toBeUndefined();
    send("reply", { requestId: "held-1", op: "join", status: "accepted" });
    send("reply", { requestId: "s1", op: "snapshot", status: "ok" });
    send("reply", { op: "join", status: "accepted" });
    // Routed on its requestId first (the 5a preflight's M5): a reply to a held request is that request's, whatever its op says.
    send("reply", { requestId: "held-2", op: "snapshot", status: "ok" });
    expect(replies.map(([, r]) => r.requestId)).toEqual(["held-1", "s1", "held-2"]);
    expect(faults()).toContainEqual(expect.stringMatching(/reply without a requestId/));
    const ev = (seq: number, type: string) => ({ seq, instanceId: "11111111-1111-4111-8111-111111111111", type, device: "lamp" });
    send("event", ev(1, "joined"));
    send("event", ev(1, "joined"));   // the same seq: said once
    send("event", ev(2, "interviewed"));
    send("event", ev(3, "window_closed"));
    expect(provisioning.map(([b, e]) => [b, e.type])).toEqual([[B.id, "joined"], [B.id, "window_closed"]]);
  });

  it("finds a transport and a carrying device by the applier's id, and gives the id a bridge's device will get before the model holds it", () => {
    const { home, heard } = setup();
    expect(home.idFor(B.id, "kettle")).toBe(`${B.id}:kettle`);
    heard();
    expect(home.transportHeld("hall:radio")).toMatchObject({ bridge: B.id, bridge_transport: "radio" });
    expect(home.transportHeld("hall:nothing")).toBeUndefined();
    expect(home.deviceAt("hall:lamp")).toMatchObject({ bridge: B.id, bridge_device: "lamp" });
    expect(home.deviceAt("hall:nothing")).toBeUndefined();
    expect(home.idFor(B.id, "lamp")).toBe("hall:lamp");
  });
});

describe("Home: connections (slice 5b)", () => {
  it("keeps a bridge's connections apart from the model: a malformed entry and a status without transports keep theirs", () => {
    const { home, send, status, changed, events, connsChanged } = setup();
    home.listening(B.id);
    send("status", status({ transports: [{ id: "radio", kind: "zigbee", state: "up", since: wire(0), connections: ["zigbee:pan-1"] }] }));
    send("devices", { devices: [entry("lamp", { connections: ["mac:01"] }), entry("plug", { connections: ["mac:02"] })] });
    const models = changed.length;
    const modelEvents = events.filter((e) => e.type === "model").length;
    send("devices", { devices: [entry("lamp", { connections: ["mac:01", "ip:192.0.2.5"] }), { id: "plug" }] });
    send("status", status({ transports: undefined }));
    expect(home.connections().get(B.id)).toEqual(expect.arrayContaining([
      { kind: "device", entity: "lamp", keys: ["mac:01", "ip:192.0.2.5"] },
      { kind: "device", entity: "plug", keys: ["mac:02"] },
      { kind: "transport", entity: "radio", keys: ["zigbee:pan-1"] }]));
    expect(home.connections().get(B.id)).toHaveLength(3);
    // A change of connections alone is no model change.
    expect(changed).toHaveLength(models);
    expect(events.filter((e) => e.type === "model")).toHaveLength(modelEvents);
    send("devices", { devices: [entry("lamp", { connections: ["mac:01"] })] });
    expect(home.connections().get(B.id)!.some((c) => c.entity === "plug")).toBe(false);
    send("status", status());
    expect(home.connections().get(B.id)!.some((c) => c.kind === "transport")).toBe(false);
    expect(connsChanged.at(-1)).toEqual([B.id, [{ kind: "device", entity: "lamp", keys: ["mac:01"] }]]);
    // Nothing changed, nothing written.
    const writes = connsChanged.length;
    send("devices", { devices: [entry("lamp", { connections: ["mac:01"] })] });
    expect(connsChanged).toHaveLength(writes);
  });

  it("loads kept rows, keeps a dead bridge's, and drops a bridge no longer registered", () => {
    const { home, connsChanged } = setup();
    home.loadConnections([{ bridge: B.id, kind: "device", entity: "spare", keys: ["mac:09"] }, { bridge: B.id, kind: "bogus", entity: "x", keys: [] }]);
    expect(home.connections().get(B.id)).toEqual([{ kind: "device", entity: "spare", keys: ["mac:09"] }]);
    home.follow(new Map());
    expect(home.connections().has(B.id)).toBe(false);
    expect(connsChanged.at(-1)).toEqual([B.id, []]);
  });
});
