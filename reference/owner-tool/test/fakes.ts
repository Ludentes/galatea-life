import type { Deps } from "../src/context.js";
import { FileProblem } from "../src/context.js";
import type { Reply } from "../src/link.js";
import type { Applier, Change, Steward } from "../src/servers.js";

type Body = Record<string, any>;
export const ok = (body: Body): Reply => ({ kind: "ok", body });
export const refused = (error: string, message = "no", extra: Body = {}): Reply => ({ kind: "refused", error, message, body: { error, message, ...extra } });

/** A fake server: every call recorded; each reply taken from a queue for its tool, else from a default. */
class Fake {
  calls: { tool: string; args: Body }[] = [];
  queued = new Map<string, (Reply | (() => Reply | Promise<Reply>))[]>();
  constructor(readonly defaults: Record<string, (args: Body) => Reply>) {}
  queue(tool: string, ...replies: (Reply | (() => Reply | Promise<Reply>))[]): this {
    this.queued.set(tool, [...(this.queued.get(tool) ?? []), ...replies]);
    return this;
  }
  async reply(tool: string, args: Body = {}): Promise<Reply> {
    this.calls.push({ tool, args });
    const q = this.queued.get(tool);
    const next = q?.shift();
    if (next) return typeof next === "function" ? next() : next;
    const d = this.defaults[tool];
    if (!d) throw new Error(`the fake has no reply for ${tool}`);
    return d(args);
  }
  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }
}

export const DEVICES = [
  { id: "sim-bridge:channel", class: "channel", adopted: true, capabilities: ["notify"], feedback: "none", bridge_device: { bridge: "sim-bridge", id: "channel" },
    actions: [{ action: "notify.notify", tier: "reversible", idempotent: false, stateless: true, ack_within_s: 5 }] },
  { id: "sim-bridge:lamp", class: null, proposed_class: "light", class_evidence: "protocol", adopted: false, capabilities: ["onoff"], feedback: "state",
    actions: [{ action: "onoff.turn_on", tier: "reversible", idempotent: true, stateless: false, ack_within_s: 5 },
      { action: "onoff.turn_off", tier: "reversible", idempotent: true, stateless: false, ack_within_s: 5 }] },
];

export class FakeApplier extends Fake implements Applier {
  revision = 4;
  constructor() {
    super({
      describe: () => ok({ applier_id: "applier", standard_version: "0.15", levels: ["Act"], revision: this.revision, devices: DEVICES,
        transports: [{ id: "sim-bridge", kind: "zigbee", up: true, state: "up", bridge: "sim-bridge" }] }),
      configure: (a) => ok(a.dry_run ? { diff: "adopt: x" } : { revision: ++this.revision }),
    });
  }
  describe(): Promise<Reply> {
    return this.reply("describe");
  }
  configure(a: { changes: Change[]; expected_revision?: number; dry_run: boolean }): Promise<Reply> {
    return this.reply("configure", a);
  }
}

export class FakeSteward extends Fake implements Steward {
  revision = 10;
  constructor() {
    super({
      describe: () => ok({ steward_id: "steward", standard_version: "0.10", revision: this.revision, home: { ask_expiry_s: 300 },
        targets: [{ ...DEVICES[0], name: "Канал", room: null }, { ...DEVICES[1], name: "sim-bridge:lamp", room: null }] }),
      state: (a) => ok({ targets: Object.fromEntries((a.targets ?? []).map((id: string) => [id, { liveness: id.endsWith("lamp") ? "dead" : "live" }])),
        transports: [], latches: [] }),
      history: () => ok({ events: [] }),
      define: (a) => ok(a.dry_run ? { diff: "home: x" } : { revision: ++this.revision }),
    });
  }
  describe(a: { since_revision?: number; wait_s?: number } = {}): Promise<Reply> {
    return this.reply("describe", a);
  }
  state(a: { targets?: string[] } = {}): Promise<Reply> {
    return this.reply("state", a);
  }
  history(a: { from: string; to: string; targets?: string[]; after_seq?: number }): Promise<Reply> {
    return this.reply("history", a);
  }
  define(a: { changes: Change[]; expected_revision: number; dry_run: boolean }): Promise<Reply> {
    return this.reply("define", a);
  }
}

export const SECRETS: Record<string, string> = {
  "applier-owner": "applier-owner-secret-0123456789",
  "steward-owner": "steward-owner-secret-0123456789",
  "steward-at-applier": "steward-at-applier-secret-0123",
  "steward-token-key": "steward-token-key-secret-01234",
  brain_agent: "brain-agent-secret-0123456789ab",
};

/** Deps over the fakes, with what was said kept. */
export function fakeDeps(o: { applier?: FakeApplier; steward?: FakeSteward; inputs?: Record<string, string>; now?: number;
  applierFails?: Error; stewardFails?: Error } = {}) {
  const applier = o.applier ?? new FakeApplier();
  const steward = o.steward ?? new FakeSteward();
  const out: string[] = [];
  const err: string[] = [];
  /** Every secret file a command asked for, by name, in order. */
  const secretReads: string[] = [];
  const deps: Deps = {
    say: { out: (l) => void out.push(l), err: (l) => void err.push(l) },
    applier: async () => {
      if (o.applierFails) throw o.applierFails;
      return applier;
    },
    steward: async () => {
      if (o.stewardFails) throw o.stewardFails;
      return steward;
    },
    secret: (name) => {
      secretReads.push(name);
      const s = SECRETS[name];
      if (s === undefined) throw new FileProblem(`secrets/mcp/${name} cannot be read (ENOENT)`);
      return s;
    },
    input: async (path) => {
      const t = o.inputs?.[path];
      if (t === undefined) throw new FileProblem(`${path} cannot be read (ENOENT)`);
      return t;
    },
    now: () => o.now ?? Date.parse("2026-10-07T12:00:00Z"),
  };
  return { deps, applier, steward, out, err, secretReads, all: () => [...out, ...err].join("\n") };
}

/** No secret of the installation in anything said. */
export function noSecretIn(text: string): boolean {
  return Object.values(SECRETS).every((s) => !text.includes(s));
}
