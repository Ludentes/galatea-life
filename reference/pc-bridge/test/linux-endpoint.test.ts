import { describe, expect, it } from "vitest";
import {
  ENDPOINT_IFACE, ENDPOINT_MATCH, ENDPOINT_NAME, ENDPOINT_PATH, HELPER_IFACE, HELPER_PATH, HelperEndpoint, REFUSED, UNAVAILABLE,
} from "../src/linux/endpoint.js";
import type { HelperMessage } from "../src/port.js";
import { FakeBusError, FakeLogindBus } from "./linux-fakes.js";

const settle = () => new Promise((r) => setImmediate(r));

/** An endpoint over the fake system bus: one helper `:1.40` (pid 700, uid 1000, session 2) and a stranger `:1.41` (pid 701, same uid and session). */
async function rig(o: { open?: boolean; then?: (m: HelperMessage, e: HelperEndpoint) => void } = {}) {
  const bus = new FakeLogindBus();
  bus.sessions = [{ id: "2", uid: 1000, type: "wayland", seat: "seat0" }];
  bus.connections.set(":1.40", { uid: 1000, pid: 700 });
  bus.connections.set(":1.41", { uid: 1000, pid: 701 });
  bus.sessionOfPid.set(700, "2");
  bus.sessionOfPid.set(701, "2");
  const seen: HelperMessage[] = [];
  const lines: string[] = [];
  const endpoint: HelperEndpoint = new HelperEndpoint({ bus, emit: (m) => {
    seen.push(m);
    o.then?.(m, endpoint);
  }, log: (l) => lines.push(l) });
  bus.onSignal((s) => endpoint.onSignal(s));
  if (o.open !== false) await endpoint.open();
  const hello = (sender: string, token = "") => bus.callIn(sender, ENDPOINT_PATH, ENDPOINT_IFACE, "Hello", "s", [token]);
  const report = (sender: string, session: string, values: Record<string, unknown>) =>
    bus.callIn(sender, ENDPOINT_PATH, ENDPOINT_IFACE, "Report", "sa{sv}", [session, values]);
  return { bus, endpoint, seen, lines, hello, report };
}

const v = (signature: string, value: unknown) => ({ signature, value });

describe("HelperEndpoint", () => {
  it("watches connections leave from the bus daemon, takes calls on its path, and owns its name", async () => {
    const r = await rig();
    expect(r.bus.matches).toEqual([ENDPOINT_MATCH]);
    expect(ENDPOINT_MATCH).toBe("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'");
    expect(r.bus.owned).toEqual([ENDPOINT_NAME]);
    expect(r.endpoint.isOwned()).toBe(true);
  });

  it("rejects when the bus's policy refuses it the name", async () => {
    const r = await rig({ open: false });
    r.bus.refuseNames = true;
    await expect(r.endpoint.open()).rejects.toThrow(/not allowed to own/);
    expect(r.endpoint.isOwned()).toBe(false);
  });

  it("tags a caller with the uid and pid the bus daemon gives and the session logind gives for that pid, once", async () => {
    const r = await rig();
    expect(await r.hello(":1.40")).toEqual({ reply: [], signature: "" });
    expect(await r.report(":1.40", "2", { activity: v("s", "idle") })).toEqual({ reply: [], signature: "" });
    const from = { conn: 1, pid: 700, osId: 1000, session: "2" };
    expect(r.seen).toEqual([
      { kind: "connected", from },
      { kind: "report", from, session: "2", values: { activity: "idle" } },
    ]);
    expect(r.bus.calls.filter((c) => /GetConnectionUnix|GetSessionByPID/.test(c))).toEqual([
      'org.freedesktop.DBus.GetConnectionUnixUser /org/freedesktop/DBus [":1.40"]',
      'org.freedesktop.DBus.GetConnectionUnixProcessID /org/freedesktop/DBus [":1.40"]',
      "org.freedesktop.login1.Manager.GetSessionByPID /org/freedesktop/login1 [700]",
    ]);
  });

  it("passes on the session a report names as the helper wrote it, beside the OS's own, for the core to judge", async () => {
    const r = await rig();
    await r.report(":1.41", "7", { activity: v("s", "active") });
    expect(r.seen).toEqual([
      { kind: "connected", from: { conn: 1, pid: 701, osId: 1000, session: "2" } },
      { kind: "report", from: { conn: 1, pid: 701, osId: 1000, session: "2" }, session: "7", values: { activity: "active" } },
    ]);
  });

  it("gives a caller in no session the session null", async () => {
    const r = await rig();
    r.bus.connections.set(":1.42", { uid: 1001, pid: 702 });
    await r.hello(":1.42");
    expect(r.seen).toEqual([{ kind: "connected", from: { conn: 1, pid: 702, osId: 1001, session: null } }]);
  });

  it("passes no word of a caller it cannot identify (gone already, logind not answering), and asks again at its next call", async () => {
    const r = await rig();
    r.bus.failing.set("GetSessionByPID", new FakeBusError("org.freedesktop.DBus.Error.ServiceUnknown", "logind is away"));
    expect(await r.hello(":1.40")).toMatchObject({ error: UNAVAILABLE });
    expect(r.seen).toEqual([]);
    expect(r.lines[0]).toMatch(/cannot identify :1\.40: logind is away/);
    r.bus.failing.delete("GetSessionByPID");
    await r.hello(":1.40");
    expect(r.seen).toEqual([{ kind: "connected", from: { conn: 1, pid: 700, osId: 1000, session: "2" } }]);
    expect(await r.hello(":1.99")).toMatchObject({ error: UNAVAILABLE });
  });

  it("reads a report's values: app \"\" as no focused window, unknown keys left out, the core judging types", async () => {
    const r = await rig();
    await r.report(":1.40", "2", {
      activity: v("s", "active"), app: v("s", ""), camera_in_use: v("b", true), microphone_in_use: v("s", "yes"), battery: v("u", 80),
    });
    expect(r.seen.at(-1)).toMatchObject({ kind: "report", values: { activity: "active", app: null, camera_in_use: true, microphone_in_use: "yes" } });
    expect(Object.keys((r.seen.at(-1) as { values: object }).values)).not.toContain("battery");
  });

  it("names a call it does not offer, or one of the wrong signature, as malformed, and answers it with an error, never a throw", async () => {
    const r = await rig();
    expect(await r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Report", "s", ["2"])).toMatchObject({ error: "org.freedesktop.DBus.Error.UnknownMethod" });
    expect(await r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Shutdown")).toMatchObject({ error: "org.freedesktop.DBus.Error.UnknownMethod" });
    // Hello carries a token now (review N1): one without it is not offered.
    expect(await r.bus.callIn(":1.40", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello")).toMatchObject({ error: "org.freedesktop.DBus.Error.UnknownMethod" });
    const from = { conn: 1, pid: 700, osId: 1000, session: "2" };
    expect(r.seen).toEqual([
      { kind: "connected", from },
      { kind: "malformed", from, detail: "a call the endpoint does not offer: org.galatea.PcBridge1.Report(s)" },
      { kind: "malformed", from, detail: "a call the endpoint does not offer: org.galatea.PcBridge1.Shutdown()" },
      { kind: "malformed", from, detail: "a call the endpoint does not offer: org.galatea.PcBridge1.Hello()" },
    ]);
  });

  it("names a report too large as malformed, and passes none of it on", async () => {
    const r = await rig();
    expect(await r.report(":1.40", "2", { app: v("s", "x".repeat(1025)) })).toMatchObject({ error: "org.freedesktop.DBus.Error.LimitsExceeded" });
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, v("b", true)]));
    await r.report(":1.40", "2", many);
    expect(r.seen.map((m) => m.kind)).toEqual(["connected", "malformed", "malformed"]);
    expect(r.seen[1]).toMatchObject({ detail: "a report too large (1 keys, app over 1024 characters)" });
  });

  it("refuses every later call of a connection the core refused, reports it gone at once, and passes nothing more of it on", async () => {
    // The core refuses the stranger as it hears of it, as Helpers does.
    const r = await rig({ then: (m, e) => {
      if (m.kind === "connected" && m.from.pid === 701) e.close(m.from.conn);
    } });
    expect(await r.report(":1.41", "2", { activity: v("s", "active") })).toMatchObject({ error: REFUSED });
    await settle();
    const from = { conn: 1, pid: 701, osId: 1000, session: "2" };
    expect(r.seen).toEqual([{ kind: "connected", from }, { kind: "gone", from }]);
    expect(await r.hello(":1.41")).toMatchObject({ error: REFUSED });
    // Its real end changes nothing more, and the helper beside it is taken as before.
    r.bus.connectionGone(":1.41");
    await r.hello(":1.40");
    await settle();
    expect(r.seen.map((m) => m.kind)).toEqual(["connected", "gone", "connected"]);
  });

  it("reports a connection gone when the bus daemon says it left, after its calls in hand, and only for one it announced", async () => {
    const r = await rig();
    await r.hello(":1.40");
    r.bus.connectionGone(":1.40");
    r.bus.connectionGone(":1.77");
    await settle();
    const from = { conn: 1, pid: 700, osId: 1000, session: "2" };
    expect(r.seen).toEqual([{ kind: "connected", from }, { kind: "gone", from }]);
  });

  it("takes no word of a connection's end that another connection forges (review C1)", async () => {
    const r = await rig();
    await r.hello(":1.40");
    r.bus.connectionGone(":1.40", ":1.41");
    r.endpoint.onSignal({ sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged",
      body: [":1.40", ":1.40", ":1.50"] });
    await settle();
    expect(r.seen.map((m) => m.kind)).toEqual(["connected"]);
    await expect(r.endpoint.notify(1, "x", "info")).rejects.toThrow(/ServiceUnknown|not provided/);
  });

  it("has a helper show a notification by calling its own object on its connection, and fails for one not connected", async () => {
    const r = await rig();
    const asked: unknown[] = [];
    r.bus.peer = (destination, member, body) => {
      asked.push([destination, member, body]);
      return [];
    };
    await r.hello(":1.40");
    await r.endpoint.notify(1, "От: Galatea\nТекст", "warning");
    expect(asked).toEqual([[":1.40", "Notify", ["От: Galatea\nТекст", "warning"]]]);
    expect(r.bus.calls.at(-1)).toBe(`${HELPER_IFACE}.Notify ${HELPER_PATH} ["От: Galatea\\nТекст","warning"]`);
    await expect(r.endpoint.notify(2, "x", "info")).rejects.toThrow("no helper connection 2");
    r.bus.peer = () => { throw new FakeBusError("org.freedesktop.DBus.Error.Failed", "org.freedesktop.Notifications is not there"); };
    await expect(r.endpoint.notify(1, "x", "info")).rejects.toThrow(/Notifications is not there/);
  });

  const TOKEN = "a".repeat(64);
  /** pid 700 started as a helper: the floor taken (the bus's names: :1.40 and :1.41 among them), its token handed to it. */
  const started = async (r: Awaited<ReturnType<typeof rig>>, token = TOKEN) => {
    const floor = await r.endpoint.floor();
    r.endpoint.expect(700, floor, token);
    r.bus.connections.set(":1.42", { uid: 1000, pid: 700 });
    r.bus.connections.set(":1.43", { uid: 1000, pid: 700 });
    return floor;
  };

  it("binds a started pid's connection only when it presents its start's token in Hello (review N1)", async () => {
    const r = await rig();
    await started(r);
    expect(r.bus.calls).toContain("org.freedesktop.DBus.ListNames /org/freedesktop/DBus");
    expect(await r.hello(":1.42", TOKEN)).toEqual({ reply: [], signature: "" });
    expect(r.seen).toEqual([{ kind: "connected", from: { conn: 1, pid: 700, osId: 1000, session: "2" } }]);
    // The token is no one's to log.
    expect(r.lines.join("\n")).not.toContain(TOKEN);
  });

  it("refuses a newer connection with the started pid that presents a wrong token, and spends the token on it (review N1)", async () => {
    const r = await rig();
    await started(r);
    expect(await r.hello(":1.42", "b".repeat(64))).toMatchObject({ error: REFUSED });
    expect(r.seen).toEqual([{ kind: "malformed", from: { conn: 1, pid: 700, osId: 1000, session: "2" },
      detail: "pid 700's connection :1.42 presented a wrong token" }]);
    expect(await r.report(":1.42", "2", { activity: v("s", "idle") })).toMatchObject({ error: REFUSED });
    // Spent at its first use, right or wrong: the right one, after, is refused too.
    expect(await r.hello(":1.43", TOKEN)).toMatchObject({ error: REFUSED });
    expect(r.seen.at(-1)).toMatchObject({ kind: "malformed", detail: "pid 700's connection :1.43 came after its start's token was spent" });
    expect(r.seen.map((m) => m.kind)).toEqual(["malformed", "malformed"]);
  });

  it("refuses a started pid's connection whose first call is not Hello with a token, or a token of another length (review N1)", async () => {
    const r = await rig();
    await started(r);
    expect(await r.report(":1.42", "2", { activity: v("s", "idle") })).toMatchObject({ error: REFUSED });
    expect(r.seen.at(-1)).toMatchObject({ kind: "malformed", detail: "pid 700's connection :1.42 did not present its start's token" });
    const again = await rig();
    await started(again);
    expect(await again.bus.callIn(":1.42", ENDPOINT_PATH, ENDPOINT_IFACE, "Hello")).toMatchObject({ error: REFUSED });
    expect(again.seen.at(-1)).toMatchObject({ detail: "pid 700's connection :1.42 did not present its start's token" });
    const short = await rig();
    await started(short);
    expect(await short.hello(":1.42", TOKEN.slice(1))).toMatchObject({ error: REFUSED });
    expect(short.seen.at(-1)).toMatchObject({ detail: "pid 700's connection :1.42 presented a wrong token" });
  });

  it("refuses a connection older than the floor, its token right or not, and one whose name it cannot read (review I1)", async () => {
    const r = await rig();
    // :1.40 was on the bus before the service started pid 700 (its pid a dead opener's, reused by the helper).
    await started(r);
    expect(await r.hello(":1.40", TOKEN)).toMatchObject({ error: REFUSED });
    expect(r.seen).toEqual([{ kind: "malformed", from: { conn: 1, pid: 700, osId: 1000, session: "2" },
      detail: "pid 700's connection :1.40 is older than its helper (not after :1.41)" }]);
    const odd = await rig();
    await started(odd);
    odd.bus.connections.set("odd", { uid: 1000, pid: 700 });
    expect(await odd.hello("odd", TOKEN)).toMatchObject({ error: REFUSED });
    expect(odd.seen.at(-1)).toMatchObject({ kind: "malformed", detail: "pid 700's connection odd has no unique name the endpoint can read" });
  });

  it("takes the highest name the bus daemon announced, where it is above ListNames' (review I1)", async () => {
    const announced = (r: Awaited<ReturnType<typeof rig>>) => {
      r.bus.emit({ sender: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged",
        body: [":1.60", "", ":1.60"] });
      // A forger's announcement counts for nothing.
      r.bus.emit({ sender: ":1.41", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged",
        body: [":1.90", "", ":1.90"] });
    };
    const r = await rig();
    announced(r);
    r.endpoint.expect(700, await r.endpoint.floor(), TOKEN);
    r.bus.connections.set(":1.55", { uid: 1000, pid: 700 });
    expect(await r.hello(":1.55", TOKEN)).toMatchObject({ error: REFUSED });
    const s = await rig();
    announced(s);
    s.endpoint.expect(700, await s.endpoint.floor(), TOKEN);
    s.bus.connections.set(":1.61", { uid: 1000, pid: 700 });
    expect(await s.hello(":1.61", TOKEN)).toEqual({ reply: [], signature: "" });
  });

  it("cannot take a floor when the bus cannot list its names, and forgets a pid it is told to (review I1)", async () => {
    const r = await rig();
    r.bus.failing.set("ListNames", new FakeBusError("org.freedesktop.DBus.Error.Failed", "no"));
    await expect(r.endpoint.floor()).rejects.toThrow("no");
    r.endpoint.expect(700, [1, 41], TOKEN);
    r.endpoint.forget(700);
    // A pid the endpoint does not expect is the core's to judge.
    expect(await r.hello(":1.40")).toEqual({ reply: [], signature: "" });
    expect(r.seen.map((m) => m.kind)).toEqual(["connected"]);
  });

  it("takes every connection as gone when its own connection to the bus is lost", async () => {
    const r = await rig();
    await r.hello(":1.40");
    await r.hello(":1.41");
    r.endpoint.lost();
    expect(r.seen.filter((m) => m.kind === "gone").map((m) => (m as { from: { conn: number } }).from.conn)).toEqual([1, 2]);
    expect(r.endpoint.isOwned()).toBe(false);
  });
});
