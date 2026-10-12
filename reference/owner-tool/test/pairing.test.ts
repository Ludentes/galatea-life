import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { DESCRIBE_WITHIN_S } from "../src/commands/pairing.js";
import { Lost } from "../src/link.js";
import { DEVICES, fakeDeps, noSecretIn, ok, refused, TRANSPORT } from "./fakes.js";

const NEW = "sim-bridge:new";
const newTarget = (extra: Record<string, unknown> = {}) => ({ id: NEW, adopted: false, class: null, proposed_class: "light", class_evidence: "protocol",
  capabilities: ["onoff"], actions: [], name: NEW, aliases: [], room: null, ...extra });
const joined = (device = NEW, bridge = "sim-bridge") => ({ bridge, what: "joined", device, cause: "device" });
const closed = (devices: string[], window_s = 120) => ({ bridge: "sim-bridge", what: "window_closed", transport: TRANSPORT.id, devices, window_s, cause: "bridge" });

/** A join whose bridge, once the window opens, has `device` join; the steward describes it on its next describe. */
function joining(o: { describe?: boolean } = {}) {
  const a = fakeDeps();
  a.applier.queue("provision", () => {
    a.applier.feed(joined());
    if (o.describe !== false) {
      a.steward.targets = [...a.steward.targets, newTarget()];
      a.steward.revision++;
    }
    return ok({ request_id: "r1", op: "join", status: "accepted" });
  });
  return a;
}

describe("join", () => {
  it("opens a window on the only transport, the cursor taken first, and shows the device joined and described", async () => {
    const a = joining();
    // The window closes at the first events read after the window opened.
    let reads = 0;
    const events = a.applier.defaults.events;
    a.applier.defaults.events = (x) => {
      if (++reads === 2) a.applier.feed(closed([NEW]));
      return events(x);
    };
    expect(await run(["join"], a.deps)).toBe(0);
    expect(a.applier.tools().slice(0, 3)).toEqual(["describe", "events", "provision"]);
    expect(a.steward.tools()[0]).toBe("describe");
    const p = a.applier.calls.find((c) => c.tool === "provision")!.args;
    expect(p.join).toEqual({ transport: "sim-bridge", window_s: 120 });
    expect(typeof p.idempotency_key).toBe("string");
    expect(a.out).toEqual([
      "join window open on sim-bridge (bridge sim-bridge) for 120 s; galatea close --transport sim-bridge closes it",
      `joined: ${NEW}`,
      `described: ${NEW}  proposed light (protocol)  capabilities: onoff`,
      `  galatea adopt ${NEW} --class light`,
      "window closed on sim-bridge after 120 s; 1 joined:",
      `  ${NEW}  described`,
    ]);
  });

  it("takes --transport and --for, and refuses a window that is not a whole number of seconds", async () => {
    const a = fakeDeps();
    a.applier.transports = [TRANSPORT, { ...TRANSPORT, id: "other", bridge: "other" }];
    expect(await run(["join", "--transport", "sim-bridge", "--for", "30", "--no-wait"], a.deps)).toBe(0);
    expect(a.applier.calls.find((c) => c.tool === "provision")!.args.join).toEqual({ transport: "sim-bridge", window_s: 30 });
    for (const bad of ["0", "-1", "2.5", "x", "100000"]) {
      const b = fakeDeps();
      expect(await run(["join", "--for", bad], b.deps)).toBe(2);
      expect(b.applier.tools()).not.toContain("provision");
    }
  });

  it("refuses several transports and none given, a transport not described, and no transport, naming them", async () => {
    const a = fakeDeps();
    a.applier.transports = [TRANSPORT, { ...TRANSPORT, id: "zigbee:coordinator", bridge: "zigbee" }];
    expect(await run(["join"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/sim-bridge, zigbee:coordinator/);
    expect(await run(["join", "--transport", "nope"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/no transport nope.*sim-bridge, zigbee:coordinator/);
    const b = fakeDeps();
    b.applier.transports = [];
    expect(await run(["join"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toMatch(/describes no transport/);
    expect([...a.applier.tools(), ...b.applier.tools()]).not.toContain("provision");
  });

  it("maps the reply: failed(busy) ends 1 saying a window is open; invalid_request ends 2; not_claimed refused ends 2; unreachable ends 1", async () => {
    const cases: [ReturnType<typeof ok>, number, RegExp][] = [
      [ok({ request_id: "r", op: "join", status: "failed", reason: "busy" }), 1, /a join window is already open on sim-bridge.*galatea close --transport sim-bridge/],
      [ok({ request_id: "r", op: "join", status: "invalid_request", reason: "bad" }), 2, /the bridge refused the join: invalid_request \(bad\)/],
      [refused("not_claimed", "bridge sim-bridge's status does not claim Provision"), 2, /not_claimed/],
      [ok({ request_id: "r", op: "join", status: "unreachable" }), 1, /did not answer.*may still open/],
    ];
    for (const [reply, code, said] of cases) {
      const a = fakeDeps();
      a.applier.queue("provision", reply);
      expect(await run(["join"], a.deps)).toBe(code);
      expect(a.err.join("\n")).toMatch(said);
      expect(a.applier.tools().filter((t) => t === "events")).toHaveLength(1);
    }
  });

  it("sends a lost join once more with the same idempotency key", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      throw new Lost("the applier's provision: socket hang up");
    });
    expect(await run(["join", "--no-wait"], a.deps)).toBe(0);
    const keys = a.applier.calls.filter((c) => c.tool === "provision").map((c) => c.args.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("returns once the window is open with --no-wait, reading nothing more", async () => {
    const a = fakeDeps();
    expect(await run(["join", "--no-wait"], a.deps)).toBe(0);
    expect(a.applier.tools()).toEqual(["describe", "events", "provision"]);
    expect(a.steward.calls).toEqual([]);
    expect(a.out).toEqual(["join window open on sim-bridge (bridge sim-bridge) for 120 s; galatea close --transport sim-bridge closes it"]);
  });

  it(`says a device joined and not described within ${DESCRIBE_WITHIN_S} s, and not before`, async () => {
    const a = joining({ describe: false });
    let joinedAt = 0;
    let saidAt = 0;
    const out = a.deps.say.out;
    a.deps.say.out = (l) => {
      if (l.startsWith("joined:")) joinedAt = a.clock.now();
      if (l.startsWith("joined, not described")) saidAt = a.clock.now();
      out(l);
    };
    const events = a.applier.defaults.events;
    a.applier.defaults.events = (x) => {
      if (saidAt && !a.applier.log.some((e) => e.what === "window_closed")) a.applier.feed(closed([NEW]));
      return events(x);
    };
    expect(await run(["join"], a.deps)).toBe(0);
    expect(saidAt - joinedAt).toBeGreaterThanOrEqual(DESCRIBE_WITHIN_S * 1000);
    expect(saidAt - joinedAt).toBeLessThan((DESCRIBE_WITHIN_S + 6) * 1000);
    expect(a.out).toContain(`joined, not described: ${NEW}: its interview may have failed; it stays unadopted`);
    expect(a.out.at(-1)).toBe(`  ${NEW}  not described`);
  });

  it("waits for a device still being described after the window closes, then ends", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      a.applier.feed(joined(), closed([NEW], 60));
      return ok({ request_id: "r1", op: "join", status: "accepted" });
    });
    let n = 0;
    const describe = a.steward.defaults.describe;
    a.steward.defaults.describe = (x) => {
      if (++n === 3) {
        a.steward.targets = [...a.steward.targets, newTarget({ proposed_class: null, class_evidence: undefined })];
        a.steward.revision++;
      }
      return describe(x);
    };
    expect(await run(["join", "--for", "60"], a.deps)).toBe(0);
    expect(a.out).toContain(`  galatea adopt ${NEW} --class CLASS`);
    expect(a.out.join("\n")).toMatch(/no class proposed; CLASS is one of .*light/);
    expect(a.out.slice(-2)).toEqual(["window closed on sim-bridge after 60 s; 1 joined:", `  ${NEW}  described`]);
  });

  it("takes only provision events of the window's bridge, and a device the window_closed names that it did not see join", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      a.applier.feed(joined("zigbee:x", "zigbee"), { type: "model", device: "sim-bridge:lamp" }, closed(["sim-bridge:lamp"]),
        { ...closed(["zigbee:y"]), bridge: "zigbee" });
      return ok({ request_id: "r1", op: "join", status: "accepted" });
    });
    expect(await run(["join"], a.deps)).toBe(0);
    expect(a.out.join("\n")).not.toMatch(/zigbee:/);
    expect(a.out).toContain("joined: sim-bridge:lamp");
    expect(a.out).toContain("described: sim-bridge:lamp  proposed light (protocol)  capabilities: onoff");
  });

  it("closes the window on Ctrl-C, then ends 0 with what it listed", async () => {
    const a = fakeDeps();
    let polls = 0;
    a.applier.defaults.events = (x) => {
      if (x.cursor === undefined) return ok({ events: [], cursor: "0", notices: [] });
      if (++polls === 2) {
        setTimeout(() => a.interrupt(), 5);
        return new Promise<never>(() => undefined) as never;
      }
      return ok({ events: [], cursor: "0", notices: [] });
    };
    expect(await run(["join"], a.deps)).toBe(0);
    const provisions = a.applier.calls.filter((c) => c.tool === "provision").map((c) => c.args);
    expect(provisions[1]).toMatchObject({ join_close: { transport: "sim-bridge" } });
    expect(a.out.slice(-2)).toEqual(["interrupted: closed the join window on sim-bridge", "window closed on sim-bridge; 0 joined"]);
    expect(a.handlers.size).toBe(0);
  });

  it("closes a window Ctrl-C came while it was being opened, --no-wait too", async () => {
    for (const flags of [[], ["--no-wait"]]) {
      const a = fakeDeps();
      a.applier.queue("provision", () => {
        a.interrupt();
        return ok({ request_id: "r1", op: "join", status: "accepted" });
      });
      expect(await run(["join", ...flags], a.deps)).toBe(0);
      expect(a.applier.tools().filter((t) => t === "provision")).toHaveLength(2);
      expect(a.applier.calls.at(-1)!.args).toMatchObject({ join_close: { transport: "sim-bridge" } });
      expect(a.out).toContain("interrupted: closed the join window on sim-bridge");
      expect(a.handlers.size).toBe(0);
    }
  });

  it("ends 1 when Ctrl-C's close is not taken, saying how to close it", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", ok({ request_id: "r1", op: "join", status: "accepted" }), ok({ request_id: "r2", op: "join_close", status: "unreachable" }));
    a.applier.defaults.events = (x) => {
      if (x.cursor === undefined) return ok({ events: [], cursor: "0", notices: [] });
      setTimeout(() => a.interrupt(), 5);
      return new Promise<never>(() => undefined) as never;
    };
    expect(await run(["join"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/galatea close --transport sim-bridge/);
  });

  it("stops waiting for window_closed 30 s after the window should have closed, and ends 1", async () => {
    const a = fakeDeps();
    expect(await run(["join", "--for", "10"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/no window_closed heard/);
    expect(a.clock.now() - Date.parse("2026-10-07T12:00:00Z")).toBeLessThanOrEqual(70_000);
  });

  it("ends 1 when the events read fails after the window opened, saying how to close it", async () => {
    const a = fakeDeps();
    a.applier.queue("events", ok({ events: [], cursor: "0", notices: [] }), refused("cursor_expired", "gone"));
    expect(await run(["join"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/the applier refused events: cursor_expired/);
    expect(a.err.join("\n")).toMatch(/may still be open; galatea close --transport sim-bridge closes it/);
  });

  it("streams one JSON document per line with --json: the servers' bodies and the tool's own lines", async () => {
    const a = joining();
    let reads = 0;
    const events = a.applier.defaults.events;
    a.applier.defaults.events = (x) => {
      if (x.cursor !== undefined && ++reads === 2) a.applier.feed(closed([NEW]));
      return events(x);
    };
    expect(await run(["join", "--json"], a.deps)).toBe(0);
    const docs = a.out.map((l) => JSON.parse(l));
    expect(docs[0]).toEqual({ request_id: "r1", op: "join", status: "accepted" });
    expect(docs[1]).toMatchObject({ type: "provision", what: "joined", device: NEW });
    expect(docs[2]).toMatchObject({ id: NEW, proposed_class: "light" });
    expect(docs.find((d) => d.what === "window_closed")).toBeTruthy();
    expect(docs.at(-1)).toEqual({ galatea: "window_closed", transport: "sim-bridge", window_s: 120, devices: [{ id: NEW, described: true }] });
  });

  it("is refused before anything when the steward cannot be reached (it is needed to describe what joins)", async () => {
    const { Unreachable } = await import("../src/link.js");
    const a = fakeDeps({ stewardFails: new Unreachable("the steward at https://127.0.0.1:18444 could not be reached: ECONNREFUSED") });
    expect(await run(["join"], a.deps)).toBe(2);
    expect(a.applier.tools()).not.toContain("provision");
  });
});

describe("join, the review's findings", () => {
  it("I1: Ctrl-C after this window's window_closed, while a device is still being described, sends no join_close", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      a.applier.feed(joined(), closed([NEW], 60));
      return ok({ request_id: "r1", op: "join", status: "accepted" });
    });
    a.steward.defaults.describe = (x) => {
      if (x.since_revision !== undefined) {
        setTimeout(() => a.interrupt(), 5);
        return new Promise<never>(() => undefined) as never;
      }
      return ok({ revision: 10, targets: [], rooms: [] });
    };
    expect(await run(["join", "--for", "60"], a.deps)).toBe(0);
    expect(a.applier.calls.filter((c) => c.tool === "provision").map((c) => Object.keys(c.args).filter((k) => k !== "idempotency_key")[0])).toEqual(["join"]);
    expect(a.out).toContain("interrupted: the window had closed already; nothing to close");
    expect(a.out.slice(-2)).toEqual(["window closed on sim-bridge after 60 s; 1 joined:", `  ${NEW}  not described`]);
    expect(a.handlers.size).toBe(0);
  });

  it("M1: a second Ctrl-C while the close hangs ends 1 at once, with the galatea close line", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", ok({ request_id: "r1", op: "join", status: "accepted" }), () => new Promise<never>(() => undefined) as never);
    a.applier.defaults.events = (x) => {
      if (x.cursor === undefined) return ok({ events: [], cursor: "0", notices: [] });
      setTimeout(() => a.interrupt(), 5);
      return new Promise<never>(() => undefined) as never;
    };
    let code: number | undefined;
    void run(["join"], a.deps).then((c) => { code = c; });
    await new Promise((r) => setTimeout(r, 30));
    a.interrupt();
    await new Promise((r) => setTimeout(r, 30));
    expect(code).toBe(1);
    expect(a.err.join("\n")).toMatch(/interrupted again.*galatea close --transport sim-bridge closes it/);
    expect(a.handlers.size).toBe(0);
  });

  it("M1: a second Ctrl-C while the window is being opened ends 1 at once, with the galatea close line", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      setTimeout(() => { a.interrupt(); a.interrupt(); }, 5);
      return new Promise<never>(() => undefined) as never;
    });
    expect(await run(["join"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/interrupted again.*galatea close --transport sim-bridge closes it/);
  });

  it("M2: a window_closed carrying another request's id is not this window's; one carrying ours ends it", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      a.applier.feed({ ...closed([], 120), request_id: "r0" });
      return ok({ request_id: "r1", op: "join", status: "accepted" });
    });
    let polls = 0;
    const events = a.applier.defaults.events;
    a.applier.defaults.events = (x) => {
      if (x.cursor !== undefined && ++polls === 2) a.applier.feed({ ...closed([], 60), request_id: "r1" });
      return events(x);
    };
    expect(await run(["join", "--for", "60"], a.deps)).toBe(0);
    expect(polls).toBe(2);
    expect(a.out.at(-1)).toBe("window closed on sim-bridge after 60 s; 0 joined");
  });

  it("M3: a join lost twice ends 1 with the close hint", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => { throw new Lost("lost 1"); }, () => { throw new Lost("lost 2"); });
    expect(await run(["join"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/a window may be open; galatea close --transport sim-bridge closes it/);
  });

  it("M3: a join lost twice after Ctrl-C sends join_close", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => { a.interrupt(); throw new Lost("lost 1"); }, () => { throw new Lost("lost 2"); });
    expect(await run(["join"], a.deps)).toBe(0);
    expect(a.applier.calls.at(-1)!.args).toMatchObject({ join_close: { transport: "sim-bridge" } });
    expect(a.out).toContain("interrupted: closed the join window on sim-bridge");
  });

  it("M4: Ctrl-C while opening and an unreachable reply still sends join_close", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", () => {
      a.interrupt();
      return ok({ request_id: "r1", op: "join", status: "unreachable" });
    });
    expect(await run(["join"], a.deps)).toBe(0);
    expect(a.applier.calls.at(-1)!.args).toMatchObject({ join_close: { transport: "sim-bridge" } });
    expect(a.out).toContain("interrupted: closed the join window on sim-bridge");
  });
});

describe("adopt again, the review's I2", () => {
  it("does not wait on the steward when it shows the device adopted already (the printed line run again)", async () => {
    const a = fakeDeps();
    a.applier.devices = a.applier.devices.map((d) => (d.id === "sim-bridge:lamp" ? { ...d, adopted: true, class: "light" } : d));
    a.steward.targets = a.steward.targets.map((t) => (t.id === "sim-bridge:lamp" ? { ...t, adopted: true, class: "light" } : t));
    a.applier.defaults.configure = () => ok({ revision: a.applier.revision });
    const start = a.deps.now();
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(0);
    expect(a.steward.calls[1].args).toEqual({});
    expect(a.deps.now() - start).toBeLessThan(1000);
  });
});

describe("close", () => {
  it("sends join_close on the only transport, or the one given", async () => {
    const a = fakeDeps();
    expect(await run(["close"], a.deps)).toBe(0);
    expect(a.applier.calls.at(-1)!.args).toMatchObject({ join_close: { transport: "sim-bridge" } });
    expect(a.out).toEqual(["closed the join window on sim-bridge"]);
    const b = fakeDeps();
    expect(await run(["close", "--transport", "sim-bridge", "--json"], b.deps)).toBe(0);
    expect(JSON.parse(b.out[0])).toMatchObject({ op: "join_close", status: "ok" });
  });

  it("ends 1 on a failed close and 2 on one refused", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", ok({ request_id: "r", op: "join_close", status: "failed", reason: "radio" }));
    expect(await run(["close"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/failed \(radio\)/);
    const b = fakeDeps();
    b.applier.queue("provision", refused("invalid_request", "no transport"));
    expect(await run(["close"], b.deps)).toBe(2);
  });
});

describe("remove", () => {
  it("removes a device, block_rejoin false unless --block", async () => {
    const a = fakeDeps();
    a.applier.queue("provision", ok({ request_id: "r", op: "remove", status: "accepted" }));
    expect(await run(["remove", "sim-bridge:lamp"], a.deps)).toBe(0);
    const p = a.applier.calls.at(-1)!.args;
    expect(p.remove).toEqual({ device: "sim-bridge:lamp", block_rejoin: false });
    expect(typeof p.idempotency_key).toBe("string");
    expect(a.out).toEqual(["removing sim-bridge:lamp: its bridge took the request"]);
    const b = fakeDeps();
    b.applier.queue("provision", ok({ request_id: "r", op: "remove", status: "ok" }));
    expect(await run(["remove", "sim-bridge:lamp", "--block"], b.deps)).toBe(0);
    expect(b.applier.calls.at(-1)!.args.remove).toEqual({ device: "sim-bridge:lamp", block_rejoin: true });
    expect(b.out).toEqual(["removed sim-bridge:lamp; its rejoin is refused"]);
  });

  it("needs one device, and maps the reply as join does", async () => {
    const a = fakeDeps();
    expect(await run(["remove"], a.deps)).toBe(2);
    expect(await run(["remove", "a", "b"], a.deps)).toBe(2);
    expect(a.applier.calls).toEqual([]);
    a.applier.queue("provision", ok({ request_id: "r", op: "remove", status: "failed", reason: "unknown_device" }));
    expect(await run(["remove", "sim-bridge:lamp"], a.deps)).toBe(1);
    a.applier.queue("provision", refused("invalid_request", "no device sim-bridge:x"));
    expect(await run(["remove", "sim-bridge:x"], a.deps)).toBe(2);
  });
});

describe("adopt with a name and a room", () => {
  /** The applier's adopt makes the steward see the lamp adopted, at its next revision. */
  function adopting(o: { seen?: boolean } = {}) {
    const a = fakeDeps();
    const configure = a.applier.defaults.configure;
    a.applier.defaults.configure = (x) => {
      if (o.seen !== false) {
        a.steward.targets = a.steward.targets.map((t) => (t.id === "sim-bridge:lamp" ? { ...t, adopted: true, class: "light", aliases: ["лампочка"] } : t));
        a.steward.revision++;
      }
      return configure(x);
    };
    return a;
  }

  it("needs both or neither, and a new room's id of the id's form, refused before anything", async () => {
    for (const args of [["--name", "Лампа"], ["--room", "kitchen"], ["--name", "Лампа", "--room", "Кухня"], ["--name", "", "--room", "kitchen"]]) {
      const a = fakeDeps();
      expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", ...args], a.deps)).toBe(2);
      expect(a.applier.tools()).not.toContain("configure");
      expect(a.steward.tools()).not.toContain("define");
    }
  });

  it("adopts, waits until the steward sees it adopted, then makes the room and names it there, sending only name and room (GA-DEF-14 merges)", async () => {
    const a = adopting();
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(0);
    expect(a.applier.tools()).toEqual(["describe", "describe", "configure"]);
    expect(a.steward.calls.map((c) => [c.tool, c.args.since_revision, c.args.wait_s])).toEqual([
      ["describe", undefined, undefined], ["describe", undefined, undefined], ["describe", undefined, undefined], ["define", undefined, undefined]]);
    expect(a.steward.calls.at(-1)!.args).toEqual({ expected_revision: 11, dry_run: false, changes: [
      { op: "upsert", kind: "room", value: { id: "kitchen", name: "kitchen" } },
      { op: "upsert", kind: "target", value: { id: "sim-bridge:lamp", name: "Лампа", room: "kitchen" } }] });
    expect(a.out).toEqual(["adopted sim-bridge:lamp as light, revision 5", "named sim-bridge:lamp «Лампа» in kitchen (a new room), revision 12"]);
  });

  it("under the steward's merge, naming keeps the target's aliases and changes only name and room (GA-DEF-14)", async () => {
    const a = adopting();
    a.steward.seed("target", { id: "sim-bridge:lamp", name: "old", aliases: ["лампочка"], room: "hall" });
    a.steward.rooms = [{ id: "hall", name: "Прихожая" }];
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(0);
    expect(a.steward.item("target", "sim-bridge:lamp")).toEqual({ id: "sim-bridge:lamp", name: "Лампа", aliases: ["лампочка"], room: "kitchen" });
    expect(a.steward.item("room", "kitchen")).toEqual({ id: "kitchen", name: "kitchen" });
  });

  it("finds an existing room by its id or its name, and makes none", async () => {
    for (const room of ["kitchen", "Кухня"]) {
      const a = adopting();
      a.steward.rooms = [{ id: "kitchen", name: "Кухня" }];
      expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", room], a.deps)).toBe(0);
      expect(a.steward.calls.at(-1)!.args.changes).toEqual([
        { op: "upsert", kind: "target", value: { id: "sim-bridge:lamp", name: "Лампа", room: "kitchen" } }]);
      expect(a.out[1]).toBe("named sim-bridge:lamp «Лампа» in kitchen, revision 12");
    }
  });

  it("names it before the home has a channel, saying notices are held (steward 0.11: no_notify_channel)", async () => {
    const a = adopting();
    a.steward.queue("define", () => ok({ revision: 12, no_notify_channel: true }));
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(0);
    expect(a.out).toEqual(["adopted sim-bridge:lamp as light, revision 5", "named sim-bridge:lamp «Лампа» in kitchen (a new room), revision 12",
      "  no notify channel: notices are held until notice_channels names a device that offers notify"]);
  });

  it("ends 1 after the applier's change when the steward refuses, printing the line to run again", async () => {
    const a = adopting();
    a.steward.queue("define", refused("invalid_request", "target sim-bridge:lamp: no room kitchen"));
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа у окна", "--room", "kitchen", "--tier", "onoff.turn_on=confirm"], a.deps)).toBe(1);
    const err = a.err.join("\n");
    expect(err).toMatch(/the steward refused define: invalid_request: target sim-bridge:lamp: no room kitchen/);
    expect(err).toMatch(/sim-bridge:lamp is adopted and not named; to name it, run again: galatea adopt sim-bridge:lamp --class light --name 'Лампа у окна' --room kitchen --tier onoff.turn_on=confirm/);
  });

  it("ends 1 with the same line when the steward does not see the device adopted within 30 s", async () => {
    const a = adopting({ seen: false });
    const start = a.deps.now();
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(1);
    expect(a.deps.now() - start).toBe(30_000);
    expect(a.err.join("\n")).toMatch(/does not show sim-bridge:lamp adopted after 30 s[\s\S]*run again: galatea adopt sim-bridge:lamp --class light --name 'Лампа' --room kitchen/);
    expect(a.steward.tools()).not.toContain("define");
  });

  it("retries the steward's stale_revision twice", async () => {
    const a = adopting();
    a.steward.queue("define", refused("stale_revision"), refused("stale_revision"));
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(0);
    expect(a.steward.tools().filter((t) => t === "define")).toHaveLength(3);
  });

  it("is refused before anything when the steward cannot be reached", async () => {
    const { Unreachable } = await import("../src/link.js");
    const a = fakeDeps({ stewardFails: new Unreachable("the steward could not be reached") });
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen"], a.deps)).toBe(2);
    expect(a.applier.tools()).not.toContain("configure");
  });

  it("prints both bodies with --json, and no secret anywhere", async () => {
    const a = adopting();
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа", "--room", "kitchen", "--json"], a.deps)).toBe(0);
    expect(a.out).toEqual(['{"revision":5}', '{"revision":12}']);
    expect(noSecretIn(a.all())).toBe(true);
    expect(DEVICES[1].adopted).toBe(false);
  });
});
