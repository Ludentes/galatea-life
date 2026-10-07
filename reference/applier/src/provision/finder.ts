import type { Clock } from "@ludentes/galatea-life-test-clock";
import { BridgeRules } from "../bus/bridge-rules.js";
import { parseTime, type Status } from "../bus/wire.js";
import type { Mutation } from "../mutations.js";

/** A candidate as `candidates` gives it (applier, *Discovery*): the finder's entry in snake case. */
export type Candidate = {
  id: string;
  sources: string[];
  keys: string[];
  address?: Record<string, unknown>;
  first_seen?: string;
  last_seen?: string;
  hints: Record<string, unknown>;
  matches: { bridge_type: string; connect: boolean }[];
};

export type FinderView = {
  finder: "none" | "live" | "dead";
  sources: unknown[];
  faults: unknown[];
  candidates: Candidate[];
};

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string" && !x.includes("\u0000") && x.isWellFormed();
const strings = (x: unknown): string[] | undefined => (Array.isArray(x) && x.every(isStr) ? [...x] : undefined);

/**
 * A finder `status` as `BridgeRules` reads a bridge's: the `finderId` stands for the identity (never
 * checked), and `graceful: true` alone is a planned death, a finder's status having no `state`.
 */
export function finderStatus(b: Record<string, unknown>): Status {
  return {
    bridge_id: isStr(b.finderId) ? b.finderId : "",
    instance_id: isStr(b.instanceId) ? b.instanceId : "",
    v: b.v,
    graceful: b.graceful === true,
    published_at: parseTime(b.publishedAt),
    transports: [], roster: [], listed: [], faults: [], ungoverned: [], levels: [],
  };
}

/** A finder's `faults`, each an object with a string `code`; the rest of each kept as given. */
function faultsOf(x: unknown): Record<string, unknown>[] {
  return Array.isArray(x) ? x.filter((f): f is Record<string, unknown> => isObject(f) && isStr(f.code)) : [];
}

/**
 * The candidates of a list, each kept only with a string `id`, a list of string `keys` and a list of
 * `matches` each with a string `bridgeType` and a boolean `connect`; the others dropped, and `drop`
 * told of each (the maintainer's ruling K6). Undefined when `list` is not a list: the last one stands.
 */
export function parseCandidates(list: unknown, drop: (id: string, why: string) => void): Candidate[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: Candidate[] = [];
  for (const [i, c] of list.entries()) {
    const id = isObject(c) && isStr(c.id) ? c.id : `#${i}`;
    if (!isObject(c) || !isStr(c.id)) { drop(id, "no id"); continue; }
    const keys = strings(c.keys);
    if (!keys) { drop(id, "no list of string keys"); continue; }
    const matches = Array.isArray(c.matches) && c.matches.every((m) => isObject(m) && isStr(m.bridgeType) && typeof m.connect === "boolean")
      ? (c.matches as { bridgeType: string; connect: boolean }[]).map((m) => ({ bridge_type: m.bridgeType, connect: m.connect })) : undefined;
    if (!matches) { drop(id, "no list of matches"); continue; }
    out.push({
      id: c.id, sources: strings(c.sources) ?? [], keys,
      ...(isObject(c.address) ? { address: { ...c.address } } : {}),
      ...(isStr(c.firstSeen) ? { first_seen: c.firstSeen } : {}),
      ...(isStr(c.lastSeen) ? { last_seen: c.lastSeen } : {}),
      hints: isObject(c.hints) ? { ...c.hints } : {},
      matches,
    });
  }
  return out;
}

/**
 * The box's finder as the applier reads it (applier, *Discovery*; bridge, *The finder's topics*):
 * judged as a bridge is, by `BridgeRules`, with no identity check, and none of its faults ever a
 * `bridge_fault`: a skewed `publishedAt` is `clock` in its faults, and the rest only logged.
 */
export class Finder {
  private readonly rules: BridgeRules;
  private heard = false;
  private latest?: { sources: unknown[]; faults: Record<string, unknown>[] };
  private list: Candidate[] = [];
  private everLive = false;
  /** The ids of malformed entries already logged, so each is logged once while it stays malformed. */
  private dropped = new Set<string>();

  constructor(private readonly o: { clock: Clock; log: (line: string) => void; mutation?: Mutation }) {
    this.rules = new BridgeRules("", o.clock.now(), { anyIdentity: true });
  }

  /** One message on `{root}/finder/{path}`. */
  message(path: string, payload: Buffer, retained: boolean): void {
    if (!payload.length) {
      // An empty retained payload clears a topic: a will cleared, never a death; a list cleared, none.
      if (path === "candidates") this.list = [];
      return;
    }
    let b: unknown;
    try {
      b = JSON.parse(payload.toString());
    } catch {
      return this.o.log(`the finder's ${path} is not JSON`);
    }
    if (!isObject(b)) return this.o.log(`the finder's ${path} is not an object`);
    this.heard = true;
    const now = this.o.clock.now();
    if (path === "status") {
      const o = this.rules.status(finderStatus(b), retained, now);
      for (const f of o.faults) this.o.log(`the finder: ${f}`);
      if (o.take) this.latest = { sources: Array.isArray(b.sources) ? b.sources : [], faults: faultsOf(b.faults) };
      this.everLive ||= this.rules.alive;
    } else if (path === "lwt") {
      this.rules.will(isStr(b.instanceId) ? b.instanceId : undefined, now);
    } else if (path === "candidates") {
      const seen = new Set<string>();
      const list = parseCandidates(b.candidates, (id, why) => {
        seen.add(id);
        if (!this.dropped.has(id)) this.o.log(`the finder's candidate ${id} dropped: ${why}`);
      });
      this.dropped = seen;
      if (list) this.list = list;
      else this.o.log("the finder's candidates is not a list; the last list stands");
    }
  }

  /** Every finder subscription granted: until a live status, the finder is dead (GA-BUS-8). */
  listening(): void {
    this.rules.listening(this.o.clock.now());
  }

  /** The broker is lost: the finder is dead until a live status (GA-BUS-7, 8). */
  lost(): void {
    this.rules.lost(this.o.clock.now());
  }

  /** The periodic check: 30 s without a status is a death. */
  tick(): void {
    this.rules.tick(this.o.clock.now());
  }

  /** A finder topic the broker refused: logged, never a `bridge_fault` (the spec review's M5). */
  refused(reason: string): void {
    this.o.log(`the finder's topics were not granted: ${reason}`);
  }

  view(): FinderView {
    const live = this.rules.alive || (this.o.mutation === "trusts-a-dead-finder" && this.everLive);
    return {
      finder: !this.heard ? "none" : live ? "live" : "dead",
      sources: this.latest?.sources ?? [],
      faults: [...(this.latest?.faults ?? []), ...(this.rules.skewed ? [{ code: "clock" }] : [])],
      candidates: this.list,
    };
  }
}
