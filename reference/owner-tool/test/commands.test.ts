import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { HISTORY_PAGES, openAsks } from "../src/commands/reading.js";
import { Lost, NotTaken, Unreachable } from "../src/link.js";
import { DEVICES, fakeDeps, noSecretIn, ok, refused, SECRETS } from "./fakes.js";

describe("the command line", () => {
  it("says the usage, 2 with no command and 0 when asked", async () => {
    const a = fakeDeps();
    expect(await run([], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/galatea <command>/);
    const b = fakeDeps();
    expect(await run(["--help"], b.deps)).toBe(0);
    expect(b.out.join("\n")).toMatch(/register bridge/);
  });

  it("refuses an unknown command and an unknown flag with 2, calling nothing", async () => {
    const a = fakeDeps();
    expect(await run(["frobnicate"], a.deps)).toBe(2);
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--name", "Лампа"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/--name/);
    expect(a.applier.calls).toEqual([]);
  });

  it("says a server not reached and ends 2", async () => {
    const a = fakeDeps({ applierFails: new Unreachable("the applier at https://127.0.0.1:18443 could not be reached: ECONNREFUSED") });
    expect(await run(["devices"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/could not be reached/);
  });

  it("says a missing secret file and ends 2", async () => {
    const a = fakeDeps();
    expect(await run(["credential", "nobody", "--kind", "brain"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/secrets\/mcp\/nobody cannot be read/);
    expect(a.steward.calls).toEqual([]);
  });
});

describe("register bridge", () => {
  it("configures the bridge at the revision it read, identity the id unless given", async () => {
    const a = fakeDeps();
    expect(await run(["register", "bridge", "sim-bridge"], a.deps)).toBe(0);
    expect(a.applier.calls).toEqual([{ tool: "describe", args: {} }, { tool: "configure",
      args: { changes: [{ op: "upsert", kind: "bridge", value: { id: "sim-bridge", identity: "sim-bridge" } }], expected_revision: 4, dry_run: false } }]);
    expect(a.out).toEqual(["registered bridge sim-bridge (broker identity sim-bridge) at the applier, revision 5"]);
    const b = fakeDeps();
    expect(await run(["register", "bridge", "zigbee", "--identity", "bridge_zigbee", "--json"], b.deps)).toBe(0);
    expect(b.applier.calls[1].args.changes[0].value).toEqual({ id: "zigbee", identity: "bridge_zigbee" });
    expect(b.out).toEqual(['{"revision":5}']);
  });

  it("refuses an id the applier would not take, naming the --identity way", async () => {
    const a = fakeDeps();
    expect(await run(["register", "bridge", "bridge_zigbee"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/--identity bridge_zigbee/);
    expect(a.applier.calls).toEqual([]);
  });

  it("retries stale_revision twice after reading again, then gives up with 2", async () => {
    const a = fakeDeps();
    a.applier.queue("configure", refused("stale_revision"), refused("stale_revision"));
    expect(await run(["register", "bridge", "sim-bridge"], a.deps)).toBe(0);
    expect(a.applier.tools()).toEqual(["describe", "configure", "describe", "configure", "describe", "configure"]);
    const b = fakeDeps();
    b.applier.queue("configure", refused("stale_revision"), refused("stale_revision"), refused("stale_revision", "moved again"));
    expect(await run(["register", "bridge", "sim-bridge", "--json"], b.deps)).toBe(2);
    expect(b.applier.tools().filter((t) => t === "configure")).toHaveLength(3);
    expect(b.err.join("\n")).toMatch(/the applier refused configure: stale_revision: moved again/);
    expect(b.out).toEqual(['{"error":"stale_revision","message":"moved again"}']);
  });

  it("does not retry another refusal", async () => {
    const a = fakeDeps();
    a.applier.queue("configure", refused("invalid_request", "bad identity"));
    expect(await run(["register", "bridge", "sim-bridge"], a.deps)).toBe(2);
    expect(a.applier.tools()).toEqual(["describe", "configure"]);
  });
});

describe("register steward", () => {
  it("is not a command: the installation's galatea-register-steward registers the steward", async () => {
    const a = fakeDeps();
    expect(await run(["register", "steward"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/galatea-register-steward/);
    expect(await run(["register"], a.deps)).toBe(2);
    expect(a.applier.calls).toEqual([]);
  });
});

describe("credential", () => {
  it("defines a brain credential at owner-app with its secret from its file, and never says the secret", async () => {
    const a = fakeDeps();
    expect(await run(["credential", "brain_agent", "--kind", "brain", "--confirm-on", "owner-app"], a.deps)).toBe(0);
    expect(a.secretReads).toEqual(["brain_agent"]);
    expect(a.steward.calls[1]).toEqual({ tool: "define", args: { changes: [{ op: "upsert", kind: "credential",
      value: { id: "brain_agent", kind: "brain", secret: SECRETS.brain_agent, confirm_on: "owner-app" } }], expected_revision: 10, dry_run: false } });
    expect(a.out).toEqual(["defined the brain credential brain_agent at the steward: revision 11"]);
    expect(noSecretIn(a.all())).toBe(true);
  });

  it("refuses the flags the steward would refuse, before reading any file", async () => {
    const cases = [
      ["credential", "brain_agent"],
      ["credential", "brain_agent", "--kind", "robot"],
      ["credential", "brain_agent", "--kind", "brain", "--endpoint", "owner-chat"],
      ["credential", "brain_agent", "--kind", "app"],
      ["credential", "brain_agent", "--kind", "app", "--endpoint", "x", "--confirm-on", "owner-app"],
      ["credential", "../applier-owner", "--kind", "brain"],
      ["credential", "steward-owner", "--kind", "brain"],
    ];
    for (const c of cases) {
      const a = fakeDeps();
      expect(await run(c, a.deps), c.join(" ")).toBe(2);
      expect(a.steward.calls).toEqual([]);
      // No file read either (review M8).
      expect(a.secretReads, c.join(" ")).toEqual([]);
    }
  });

  it("refuses a secret shorter than the steward takes", async () => {
    SECRETS.short = "sh0rtQ";
    try {
      const a = fakeDeps();
      expect(await run(["credential", "short", "--kind", "brain"], a.deps)).toBe(2);
      expect(a.err.join("\n")).toMatch(/shorter than 16/);
      expect(noSecretIn(a.all())).toBe(true);
    } finally {
      delete SECRETS.short;
    }
  });
});

describe("configure and define", () => {
  const home = JSON.stringify([{ op: "upsert", kind: "home", value: { notice_channels: ["sim-bridge:channel"] } }]);

  it("sends the file's changes at the revision read, the steward's at owner-app", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    expect(await run(["define", "home.json"], a.deps)).toBe(0);
    expect(a.steward.calls[1].args).toEqual({ changes: JSON.parse(home), expected_revision: 10, dry_run: false });
    expect(a.out).toEqual(["the steward's define: revision 11"]);
    const b = fakeDeps({ inputs: { "-": JSON.stringify({ changes: [{ op: "upsert", kind: "bridge", value: { id: "a", identity: "a" } }] }) } });
    expect(await run(["configure", "-"], b.deps)).toBe(0);
    expect(b.applier.calls[1].tool).toBe("configure");
  });

  it("prints a dry run's diff, and it is not something done", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    expect(await run(["define", "home.json", "--dry-run"], a.deps)).toBe(0);
    expect(a.steward.calls[1].args.dry_run).toBe(true);
    expect(a.out).toEqual(["the steward's define, a dry run:", "  home: x"]);
    const b = fakeDeps({ inputs: { "home.json": home } });
    expect(await run(["configure", "home.json", "--dry-run", "--json"], b.deps)).toBe(0);
    expect(b.out).toEqual(['{"diff":"adopt: x"}']);
  });

  it("says a dry run that changes nothing as such, as both servers answer it (review M10)", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    a.steward.queue("define", ok({ diff: "no change" }));
    expect(await run(["define", "home.json", "--dry-run"], a.deps)).toBe(0);
    expect(a.out).toEqual(["the steward's define: the dry run changes nothing"]);
  });

  it("sends a pinned expected_revision once, never retried", async () => {
    const a = fakeDeps({ inputs: { "set.json": JSON.stringify({ changes: JSON.parse(home), expected_revision: 3 }) } });
    a.steward.queue("define", refused("stale_revision"));
    expect(await run(["define", "set.json"], a.deps)).toBe(2);
    expect(a.steward.calls).toEqual([{ tool: "define", args: { changes: JSON.parse(home), expected_revision: 3, dry_run: false } }]);
  });

  it("refuses a change set object with any key but changes and expected_revision, naming the key only (review M1)", async () => {
    const changes = [{ op: "upsert", kind: "home", value: { timezone: "UTC" } }];
    const a = fakeDeps({ inputs: { "set.json": JSON.stringify({ changes, dry_run: true, endpoint: "owner-app" }) } });
    expect(await run(["define", "set.json"], a.deps)).toBe(2);
    expect(a.steward.calls).toEqual([]);
    expect(a.err.join("\n")).toMatch(/dry_run.*--dry-run/);
    const b = fakeDeps({ inputs: { "set.json": JSON.stringify({ changes, "secret-valued-key": 1 }) } });
    expect(await run(["configure", "set.json"], b.deps)).toBe(2);
    expect(b.err.join("\n")).toMatch(/secret-valued-key/);
    expect(b.applier.calls).toEqual([]);
  });

  it("refuses a file that is not a change set, without quoting it", async () => {
    for (const text of ["{ not json secret-text", '{"op":"upsert"}', '[{"op":"replace","kind":"home"}]', "[]"]) {
      const a = fakeDeps({ inputs: { "x.json": text } });
      expect(await run(["define", "x.json"], a.deps)).toBe(2);
      expect(a.all()).not.toContain("secret-text");
      expect(a.steward.calls).toEqual([]);
    }
    const b = fakeDeps();
    expect(await run(["define"], b.deps)).toBe(2);
    expect(await run(["define", "missing.json"], b.deps)).toBe(2);
  });

  it("says a held define will be judged at its revision, and ends 1", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    a.steward.queue("define", { kind: "held", message: "the store did not answer" });
    expect(await run(["define", "home.json"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/holds the define .* judged at its revision/);
  });

  it("says a configure the applier failed may still take effect, and ends 1 (review M2)", async () => {
    const a = fakeDeps({ inputs: { "set.json": home } });
    a.applier.queue("configure", () => { throw new Lost("the applier's configure: internal error", true); });
    expect(await run(["configure", "set.json"], a.deps)).toBe(1);
    expect(a.err.join("\n")).toMatch(/internal error: the change may still take effect; check with galatea devices before sending it again/);
  });

  it("says a define the steward did not take changed nothing, and ends 2 (review M2)", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    a.steward.queue("define", () => { throw new NotTaken("the steward's define: nothing was taken: the store did not answer"); });
    expect(await run(["define", "home.json"], a.deps)).toBe(2);
    expect(a.err.join("\n")).toMatch(/nothing was taken/);
  });

  it("does not say a read's failure may take effect", async () => {
    const a = fakeDeps();
    a.applier.queue("describe", () => { throw new Lost("the applier's describe: internal error", true); });
    expect(await run(["register", "bridge", "sim-bridge"], a.deps)).toBe(1);
    expect(a.err.join("\n")).not.toMatch(/may still take effect/);
  });

  it("ends 1 when the call is lost under way", async () => {
    const a = fakeDeps({ inputs: { "home.json": home } });
    a.steward.queue("define", () => { throw new Lost("the steward's define: socket hang up"); });
    expect(await run(["define", "home.json"], a.deps)).toBe(1);
  });

  it("never says a credential's secret it sends", async () => {
    const secret = "a-brain-secret-in-a-change-set";
    const set = JSON.stringify([{ op: "upsert", kind: "credential", value: { id: "b", kind: "brain", secret } }]);
    const a = fakeDeps({ inputs: { "c.json": set } });
    a.steward.queue("define", refused("invalid_request", "the secret is another credential's"));
    expect(await run(["define", "c.json", "--json"], a.deps)).toBe(2);
    expect(await run(["define", "c.json"], a.deps)).toBe(0);
    expect(a.all()).not.toContain(secret);
  });
});

describe("adopt", () => {
  it("configures the adopt and any raised tiers in one change set", async () => {
    const a = fakeDeps();
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light", "--tier", "onoff.turn_on=confirm", "--tier", "onoff.turn_off=confirm"], a.deps)).toBe(0);
    expect(a.applier.calls.map((c) => c.tool)).toEqual(["describe", "describe", "configure"]);
    expect(a.applier.calls[2].args).toEqual({ expected_revision: 4, dry_run: false, changes: [
      { op: "upsert", kind: "adopt", value: { device: "sim-bridge:lamp", class: "light" } },
      { op: "upsert", kind: "tier", value: { device: "sim-bridge:lamp", action: "onoff.turn_on", tier: "confirm" } },
      { op: "upsert", kind: "tier", value: { device: "sim-bridge:lamp", action: "onoff.turn_off", tier: "confirm" } }] });
    expect(a.out).toEqual(["adopted sim-bridge:lamp as light, revision 5", "  onoff.turn_on at confirm", "  onoff.turn_off at confirm"]);
    expect(a.steward.calls).toEqual([]);
  });

  it("refuses before anything is sent: no class, a bad class or tier, a device or action the applier does not describe", async () => {
    const cases = [
      ["adopt", "sim-bridge:lamp"],
      ["adopt", "sim-bridge:lamp", "--class", "lamp"],
      ["adopt", "sim-bridge:lamp", "--class", "light", "--tier", "onoff.turn_on"],
      ["adopt", "sim-bridge:lamp", "--class", "light", "--tier", "onoff.turn_on=maybe"],
      ["adopt", "sim-bridge:lamp", "--class", "light", "--tier", "media.announce=confirm"],
      ["adopt", "sim-bridge:nothing", "--class", "light"],
      ["adopt", "--class", "light"],
    ];
    for (const c of cases) {
      const a = fakeDeps();
      expect(await run(c, a.deps), c.join(" ")).toBe(2);
      expect(a.applier.calls.filter((x) => x.tool === "configure"), c.join(" ")).toEqual([]);
    }
  });

  it("says an adopted device was adopted already", async () => {
    const a = fakeDeps();
    expect(await run(["adopt", "sim-bridge:channel", "--class", "channel"], a.deps)).toBe(0);
    expect(a.out[0]).toBe("adopted sim-bridge:channel as channel (it was adopted already), revision 5");
  });

  it("retries stale_revision twice", async () => {
    const a = fakeDeps();
    a.applier.queue("configure", refused("stale_revision"));
    expect(await run(["adopt", "sim-bridge:lamp", "--class", "light"], a.deps)).toBe(0);
    expect(a.applier.tools()).toEqual(["describe", "describe", "configure", "describe", "configure"]);
  });
});

describe("devices", () => {
  it("lists each device with its bridge, adoption, liveness, name and room", async () => {
    const a = fakeDeps();
    expect(await run(["devices"], a.deps)).toBe(0);
    expect(a.out).toEqual([
      "sim-bridge:channel  bridge sim-bridge  adopted, class channel  live  «Канал», no room",
      "sim-bridge:lamp  bridge sim-bridge  not adopted, proposed light (protocol)  dead  no name, no room",
    ]);
    expect(a.steward.calls.find((c) => c.tool === "state")?.args).toEqual({ targets: ["sim-bridge:channel", "sim-bridge:lamp"] });
  });

  it("adds capabilities and actions with --all, and one JSON document with --json", async () => {
    const a = fakeDeps();
    expect(await run(["devices", "--all"], a.deps)).toBe(0);
    expect(a.out).toContain("    onoff.turn_on  reversible");
    expect(a.out).toContain("    capabilities: onoff");
    const b = fakeDeps();
    expect(await run(["devices", "--json"], b.deps)).toBe(0);
    expect(b.out).toHaveLength(1);
    const doc = JSON.parse(b.out[0]);
    expect(doc.devices[1]).toMatchObject({ id: "sim-bridge:lamp", liveness: "dead", steward: { name: "sim-bridge:lamp", room: null } });
  });
});

describe("devices' names (review M10)", () => {
  it("shows a name only when the owner gave one, not the bridge's label or the id the steward defaults to", async () => {
    const a = fakeDeps();
    a.steward.queue("describe", ok({ steward_id: "steward", standard_version: "0.10", revision: 10, home: {}, targets: [
      { ...DEVICES[0], label: "Notifier", name: "Notifier", room: null },
      { ...DEVICES[1], label: "Lamp 1", name: "Торшер", room: "kitchen" }] }));
    expect(await run(["devices"], a.deps)).toBe(0);
    expect(a.out[0]).toMatch(/  no name \(label «Notifier»\), no room$/);
    expect(a.out[1]).toMatch(/  «Торшер» in kitchen$/);
  });
});

describe("devices with the steward not reached (review M5)", () => {
  it("lists the applier's devices without names, says the steward was not reached, and ends 2", async () => {
    const a = fakeDeps({ stewardFails: new Unreachable("the steward at https://127.0.0.1:18444 could not be reached: ECONNREFUSED") });
    expect(await run(["devices"], a.deps)).toBe(2);
    expect(a.out).toEqual([
      "sim-bridge:channel  bridge sim-bridge  adopted, class channel  liveness not known  steward not reached",
      "sim-bridge:lamp  bridge sim-bridge  not adopted, proposed light (protocol)  liveness not known  steward not reached",
    ]);
    expect(a.err.join("\n")).toMatch(/steward: not reached: .*ECONNREFUSED/);
    const b = fakeDeps({ stewardFails: new Unreachable("down") });
    expect(await run(["devices", "--json"], b.deps)).toBe(2);
    const doc = JSON.parse(b.out[0]);
    expect(doc.steward_error).toBe("down");
    expect(doc.devices.map((d: { id: string; steward: unknown; liveness: unknown }) => [d.id, d.steward, d.liveness]))
      .toEqual([["sim-bridge:channel", null, null], ["sim-bridge:lamp", null, null]]);
  });

  it("lists them without liveness when the steward's state fails, and ends 1", async () => {
    const a = fakeDeps();
    a.steward.queue("state", () => { throw new Lost("the steward's state: socket hang up"); });
    expect(await run(["devices"], a.deps)).toBe(1);
    expect(a.out[0]).toMatch(/^sim-bridge:channel .* liveness not known/);
    expect(a.err.join("\n")).toMatch(/liveness not read: the steward's state: socket hang up/);
  });

  it("still ends 2 when the applier is not reached", async () => {
    const a = fakeDeps({ applierFails: new Unreachable("down") });
    expect(await run(["devices"], a.deps)).toBe(2);
    expect(a.out).toEqual([]);
  });
});

describe("status", () => {
  it("shows both servers, the transports, the devices not live and the open asks", async () => {
    const a = fakeDeps();
    a.steward.queue("history", ok({ events: [
      { seq: 1, type: "ask", plan_id: "p1", step_ids: ["s1"], endpoint: "owner-app" },
      { seq: 2, type: "ask", plan_id: "p2", step_ids: ["s1", "s2"], endpoint: "owner-app" },
      { seq: 3, type: "ask", plan_id: "p3", step_ids: ["s1"], endpoint: "kitchen-voice" },
      { seq: 4, type: "answer", plan_id: "p1", answers: { s1: "yes" } },
      { seq: 5, type: "answer", plan_id: "p2", answers: { s1: "no" } },
    ] }));
    a.steward.queue("state", ok({ targets: { "sim-bridge:channel": { liveness: "stale" } }, transports: [], latches: [] }));
    expect(await run(["status"], a.deps)).toBe(0);
    expect(a.out).toEqual([
      "applier applier: reached, standard 0.15, revision 4",
      "  transport sim-bridge (zigbee): up, state up, bridge sim-bridge",
      "steward steward: reached, standard 0.10, revision 10",
      "  not live: sim-bridge:channel (stale)",
      "  open asks on owner-app: 1",
    ]);
    // Only adopted devices are asked after: an unadopted joiner can do nothing (GA-ADOPT-1).
    expect(a.steward.calls.find((c) => c.tool === "state")!.args).toEqual({ targets: ["sim-bridge:channel"] });
    const h = a.steward.calls.find((c) => c.tool === "history")!.args;
    expect(h).toEqual({ from: "2026-10-07T11:55:00.000Z", to: "2026-10-07T12:01:00.000Z" });
  });

  it("shows the server it reached when the other is not, and ends 2", async () => {
    const a = fakeDeps({ stewardFails: new Unreachable("the steward at https://127.0.0.1:18444 could not be reached: ECONNREFUSED") });
    expect(await run(["status"], a.deps)).toBe(2);
    expect(a.out[0]).toMatch(/^applier applier: reached/);
    expect(a.err.join("\n")).toMatch(/steward: not reached/);
    const b = fakeDeps({ applierFails: new Unreachable("down") });
    expect(await run(["status", "--json"], b.deps)).toBe(2);
    const doc = JSON.parse(b.out[0]);
    expect(doc.applier_error).toBe("down");
    expect(doc.steward.revision).toBe(10);
    expect(doc.open_asks).toBe(0);
  });

  it("keeps what it reached when the steward's history fails, and ends 1 (review I2)", async () => {
    const a = fakeDeps();
    a.steward.queue("history", () => { throw new Lost("the steward's history: the store is unreachable"); });
    expect(await run(["status"], a.deps)).toBe(1);
    expect(a.out).toContain("steward steward: reached, standard 0.10, revision 10");
    expect(a.out).toContain("  open asks on owner-app: not read (the steward's history: the store is unreachable)");
    expect(a.out[0]).toMatch(/^applier applier: reached/);
    const b = fakeDeps();
    b.steward.queue("history", () => { throw new Lost("the steward's history: the store is unreachable"); });
    expect(await run(["status", "--json"], b.deps)).toBe(1);
    const doc = JSON.parse(b.out[0]);
    expect(doc.applier.revision).toBe(4);
    expect(doc.steward.revision).toBe(10);
    expect(doc.open_asks).toBeNull();
    expect(doc.open_asks_error).toMatch(/store is unreachable/);
    expect(doc.not_live).toEqual([{ id: "sim-bridge:channel", liveness: "live" }].filter((x) => x.liveness !== "live"));
  });

  it("keeps what it reached when the steward's state fails or is refused (review I2)", async () => {
    const a = fakeDeps();
    a.steward.queue("state", () => { throw new Lost("the steward's state: socket hang up"); });
    expect(await run(["status", "--json"], a.deps)).toBe(1);
    const doc = JSON.parse(a.out[0]);
    expect(doc.not_live).toBeNull();
    expect(doc.not_live_error).toMatch(/socket hang up/);
    expect(doc.open_asks).toBe(0);
    const b = fakeDeps();
    b.steward.queue("state", refused("invalid_request", "no"));
    expect(await run(["status"], b.deps)).toBe(1);
    expect(b.out).toContain("  not live: not read (the steward refused state: invalid_request: no)");
    expect(b.out).toContain("  open asks on owner-app: 0");
  });

  it("reads history on with after_seq while it says more, an answer on a later page closing an ask (review M3)", async () => {
    const a = fakeDeps();
    a.steward.queue("history",
      ok({ events: [{ seq: 1, type: "ask", plan_id: "p1", step_ids: ["s1"], endpoint: "owner-app" }], more: true }),
      ok({ events: [{ seq: 7, type: "state" }], more: true }),
      ok({ events: [{ seq: 9, type: "answer", plan_id: "p1", answers: { s1: "yes" } }] }));
    expect(await run(["status"], a.deps)).toBe(0);
    expect(a.out).toContain("  open asks on owner-app: 0");
    const pages = a.steward.calls.filter((c) => c.tool === "history").map((c) => c.args.after_seq);
    expect(pages).toEqual([undefined, 1, 7]);
  });

  it("stops at HISTORY_PAGES pages and says the count is of what it read (review M3)", async () => {
    const a = fakeDeps();
    let seq = 0;
    for (let i = 0; i < HISTORY_PAGES + 2; i++) a.steward.queue("history", () => ok({ events: [{ seq: ++seq, type: "ask", plan_id: `p${seq}`, step_ids: ["s1"], endpoint: "owner-app" }], more: true }));
    expect(await run(["status"], a.deps)).toBe(0);
    expect(a.steward.calls.filter((c) => c.tool === "history")).toHaveLength(HISTORY_PAGES);
    expect(a.out).toContain(`  open asks on owner-app: ${HISTORY_PAGES} (counted from the first ${HISTORY_PAGES} pages of history only)`);
    const b = fakeDeps();
    for (let i = 0; i < HISTORY_PAGES; i++) b.steward.queue("history", () => ok({ events: [{ seq: i + 1, type: "state" }], more: true }));
    expect(await run(["status", "--json"], b.deps)).toBe(0);
    expect(JSON.parse(b.out[0])).toMatchObject({ open_asks: 0, open_asks_partial: true });
  });

  it("counts an ask open until every step it asked is answered", () => {
    expect(openAsks([{ type: "ask", endpoint: "owner-app", plan_id: "p", step_ids: ["s1"] }])).toBe(1);
    expect(openAsks([{ type: "answer", plan_id: "p", answers: { s1: "yes" } }, { type: "ask", endpoint: "owner-app", plan_id: "p", step_ids: ["s1"] }])).toBe(1);
  });
});
