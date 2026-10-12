import { randomUUID } from "node:crypto";
import { type Ctx, type Exit, need, Usage } from "../context.js";
import { Lost, type Body } from "../link.js";
import { EventFeed, MAX_WAIT_S, waitForTarget } from "../poll.js";
import { jsonLine, noChannelLines, shellQuote } from "../print.js";
import { sendAtRevision } from "../revision.js";
import { vocabulary } from "../vocabulary.js";
import type { Applier, Change, Steward } from "../servers.js";

/** A join window's length when `--for` is not given (the design, *The commands*). */
export const JOIN_WINDOW_S = 120;
/** The longest `--for` the tool sends; a bridge caps it lower (the Zigbee bridge at 254 s). */
export const MAX_JOIN_WINDOW_S = 3600;
/** A device joined and not described this long after it joined is said so (the design, *Pairing*, step 5). */
export const DESCRIBE_WITHIN_S = 120;
/** How long past the window's own length the tool waits for its `window_closed` (the controller's ruling). */
export const CLOSE_GRACE_S = 30;
/** How long `adopt` waits for the steward to show the device adopted (the design, *Pairing*, step 2). */
export const ADOPTED_WITHIN_S = 30;
/** While a device waits to be described, the events are read between waits on the steward of at most this long. */
const DESCRIBE_POLL_S = 5;

/** `--tier action=tier`, each one a `tier` change. */
export function parseTiers(device: string, tiers: string[]): Change[] {
  const TIERS = vocabulary().tiers;
  return tiers.map((t) => {
    const m = /^([^=\s]+)=(\S+)$/.exec(t);
    if (!m) throw new Usage(`--tier is action=tier: ${JSON.stringify(t)} is not`);
    if (!TIERS.includes(m[2])) throw new Usage(`a tier is one of ${TIERS.join(", ")}: ${JSON.stringify(m[2])} is not`);
    return { op: "upsert", kind: "tier", value: { device, action: m[1], tier: m[2] } };
  });
}

/** An id as the standards have it (`common.json`'s `id`): what a new room's id must be. */
const ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/**
 * `galatea adopt <device> --class C [--name N --room R] [--tier action=tier]...` (the design,
 * *Pairing*). Step 1, the applier's `configure` of the `adopt` change and any `tier` changes, at the
 * revision it read, `stale_revision` retried twice. With a name and a room: step 2, the steward's
 * `describe { since_revision, wait_s }` until it shows the device adopted (30 s); step 3, the
 * steward's `define` of the room if it is new and the target with its name and room, and nothing else
 * (an upsert merges, GA-DEF-14: what `describe` shows of the target is never sent back). A device the
 * applier does not describe, a bad class, tier or room, and a steward not reached are refused before
 * anything is sent. A failure after step 1 leaves the device adopted and unnamed: it ends 1 and
 * prints the line to run again (adopting it again with the same class changes nothing).
 */
export async function adopt(ctx: Ctx, device: string | undefined, cls: string | undefined, tiers: string[],
  naming: { name?: string; room?: string } = {}): Promise<Exit> {
  if (!device) throw new Usage("galatea adopt <device> --class C [--name N --room R] [--tier action=tier]...: name the device");
  if (!cls) throw new Usage("--class is needed: the class the device is adopted as (galatea devices shows the proposed one)");
  const { classes } = vocabulary();
  if (!classes.includes(cls)) throw new Usage(`a class is one of ${classes.join(", ")}: ${JSON.stringify(cls)} is not`);
  if ((naming.name === undefined) !== (naming.room === undefined)) throw new Usage("--name and --room go together: give both, or neither");
  if (naming.name === "") throw new Usage("--name is not empty");
  const tierChanges = parseTiers(device, tiers);

  // With a name, the steward first: not reached, or a room that cannot be made, refuses before the applier's change.
  let named: { steward: Steward; name: string; room: { id: string; isNew: boolean } } | undefined;
  if (naming.name !== undefined && naming.room !== undefined) {
    const steward = await ctx.steward();
    const model = need(await steward.describe(), "steward", "describe");
    named = { steward, name: naming.name, room: findRoom(model, naming.room) };
  }

  const applierModel = need(await (await ctx.applier()).describe(), "applier", "describe");
  const d = (applierModel.devices ?? []).find((x: { id: string }) => x.id === device);
  if (!d) throw new Usage(`the applier describes no device ${device} (galatea devices lists them)`);
  for (const c of tierChanges) {
    const action = (c.value as { action: string }).action;
    if (!(d.actions ?? []).some((a: { action: string }) => a.action === action)) throw new Usage(`${device} offers no action ${action}`);
  }
  const body = await sendAtRevision(ctx, "applier", "configure",
    [{ op: "upsert", kind: "adopt", value: { device, class: cls } }, ...tierChanges], { dryRun: false });
  if (ctx.json) {
    ctx.say.out(jsonLine(body));
  } else {
    ctx.say.out(`adopted ${device} as ${cls}${d.adopted ? " (it was adopted already)" : ""}, revision ${body.revision}`);
    for (const c of tierChanges) ctx.say.out(`  ${(c.value as { action: string }).action} at ${(c.value as { tier: string }).tier}`);
  }
  if (!named) return 0;

  const again = ["galatea", "adopt", device, "--class", cls, "--name", named.name, "--room", naming.room!, ...tiers.flatMap((t) => ["--tier", t])]
    .map(shellQuote).join(" ");
  try {
    const seen = await waitForTarget(named.steward, ctx.now, { until: ctx.now() + ADOPTED_WITHIN_S * 1000,
      found: (m) => (m.targets ?? []).find((t: Body) => t.id === device && t.adopted === true) as Body | undefined });
    if (!seen.value) throw new NotSeen(`the steward does not show ${device} adopted after ${ADOPTED_WITHIN_S} s`);
    const changes: Change[] = [
      ...(named.room.isNew ? [{ op: "upsert" as const, kind: "room", value: { id: named.room.id, name: named.room.id } }] : []),
      { op: "upsert", kind: "target", value: { id: device, name: named.name, room: named.room.id } },
    ];
    const defined = await sendAtRevision(ctx, "steward", "define", changes, { dryRun: false });
    if (ctx.json) ctx.say.out(jsonLine(defined));
    else {
      ctx.say.out(`named ${device} «${named.name}» in ${named.room.id}${named.room.isNew ? " (a new room)" : ""}, revision ${defined.revision}`);
      for (const l of noChannelLines(defined)) ctx.say.out(l);
    }
    return 0;
  } catch (err) {
    if (err instanceof NotSeen) ctx.say.err(`galatea adopt: ${err.message}`);
    ctx.say.err(`galatea adopt: ${device} is adopted and not named; to name it, run again: ${again}`);
    if (err instanceof NotSeen) return 1;
    throw err;
  }
}

class NotSeen extends Error {}

/** `--room R`: a room the steward has, by its id or else its name; otherwise a new one, R its id and its name, R then of an id's form. */
function findRoom(model: Body, r: string): { id: string; isNew: boolean } {
  const rooms: { id: string; name?: string }[] = model.rooms ?? [];
  const byId = rooms.find((x) => x.id === r);
  if (byId) return { id: byId.id, isNew: false };
  const byName = rooms.filter((x) => x.name === r);
  if (byName.length === 1) return { id: byName[0].id, isNew: false };
  if (byName.length > 1) throw new Usage(`${byName.length} rooms are named ${JSON.stringify(r)}: give the room's id (${byName.map((x) => x.id).join(", ")})`);
  if (!ID.test(r)) {
    throw new Usage(`no room ${JSON.stringify(r)}, and a new room's id is 1 to 128 of A-Z a-z 0-9 . _ : / -: `
      + "give such an id, or define the room with its name first (galatea define)");
  }
  return { id: r, isNew: true };
}

/** The transport a window is opened or closed on: the one given, or the only one the applier describes. */
function pickTransport(model: Body, given: string | undefined): Body {
  const transports: Body[] = model.transports ?? [];
  const ids = transports.map((t) => t.id).join(", ");
  if (given !== undefined) {
    const t = transports.find((x) => x.id === given);
    if (!t) throw new Usage(`the applier describes no transport ${given} (it describes: ${ids || "none"})`);
    return t;
  }
  if (transports.length === 0) throw new Usage("the applier describes no transport: register a bridge, and wait for its status");
  if (transports.length > 1) throw new Usage(`the applier describes several transports; name one with --transport: ${ids}`);
  return transports[0];
}

/**
 * One `provision` operation with its own `idempotency_key` (GA-PROV-3), sent once more with the same
 * key when the first call was lost, so a retried call does the work once (the controller's ruling).
 */
async function provisionOnce(applier: Applier, op: Record<string, unknown>): Promise<Body> {
  const args = { ...op, idempotency_key: randomUUID() };
  let reply;
  try {
    reply = await applier.provision(args);
  } catch (err) {
    if (!(err instanceof Lost)) throw err;
    reply = await applier.provision(args);
  }
  return need(reply, "applier", "provision");
}

/** A `provision` reply's status that is not what was asked: said with its reason, 2 for `invalid_request`, else 1 (the design, *Pairing*, step 2). */
function notTaken(ctx: Ctx, body: Body, what: string, extra = ""): Exit {
  if (ctx.json) ctx.say.out(jsonLine(body));
  const reason = body.reason ? ` (${body.reason})` : "";
  const line = body.status === "unreachable"
    ? `the bridge did not answer the ${what} in time; it may still take effect${extra}`
    : `the bridge refused the ${what}: ${body.status}${reason}${extra}`;
  ctx.say.err(`galatea: ${line}`);
  return body.status === "invalid_request" ? 2 : 1;
}

const taken = (body: Body): boolean => body.status === "accepted" || body.status === "ok";

/** `galatea close [--transport T]`: `provision { join_close }` (the design, *The commands*). */
export async function close(ctx: Ctx, given: string | undefined): Promise<Exit> {
  const applier = await ctx.applier();
  const t = pickTransport(need(await applier.describe(), "applier", "describe"), given);
  const body = await provisionOnce(applier, { join_close: { transport: t.id } });
  if (!taken(body)) return notTaken(ctx, body, "close");
  ctx.say.out(ctx.json ? jsonLine(body) : `closed the join window on ${t.id}`);
  return 0;
}

/** `galatea remove <device> [--block]`: `provision { remove }`, `block_rejoin` false without `--block` (the design, *The commands*). */
export async function remove(ctx: Ctx, device: string | undefined, block: boolean): Promise<Exit> {
  if (!device) throw new Usage("galatea remove <device> [--block]: name the device");
  const body = await provisionOnce(await ctx.applier(), { remove: { device, block_rejoin: block } });
  if (!taken(body)) return notTaken(ctx, body, "remove");
  ctx.say.out(ctx.json ? jsonLine(body) : body.status === "ok"
    ? `removed ${device}${block ? "; its rejoin is refused" : ""}`
    : `removing ${device}: its bridge took the request${block ? "; its rejoin is refused" : ""}`);
  return 0;
}

/** `--for S`: a whole number of seconds, 1 to an hour. */
function windowSeconds(raw: string | undefined): number {
  if (raw === undefined) return JOIN_WINDOW_S;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_JOIN_WINDOW_S) throw new Usage(`--for is a whole number of seconds, 1 to ${MAX_JOIN_WINDOW_S}: ${JSON.stringify(raw)} is not`);
  return n;
}

/** What the owner did to end a wait: Ctrl-C. */
const INTERRUPTED = Symbol("interrupted");

/**
 * `galatea join [--transport T] [--for S] [--no-wait]` (the design, *Pairing*): the transport picked
 * from the applier's `transports`; the applier's `events` cursor taken; the window opened with
 * `provision { join }` and an idempotency key; then each `provision` event of the window's bridge
 * read from that cursor: a `joined` printed, and the device waited for on the steward's `describe`
 * until it is described (its adopt line printed) or 120 s pass (said so); the window's
 * `window_closed` ends it, once every device joined is described or given up on, printing them all.
 * Ctrl-C closes the window (`join_close`) first.
 */
export async function join(ctx: Ctx, o: { transport?: string; for?: string; noWait: boolean }): Promise<Exit> {
  const window_s = windowSeconds(o.for);
  const applier = await ctx.applier();
  const t = pickTransport(need(await applier.describe(), "applier", "describe"), o.transport);
  // The steward describes what joins: reached before the window opens, so a steward down refuses before anything.
  let steward: Steward | undefined;
  let model: Body | undefined;
  if (!o.noWait) {
    steward = await ctx.steward();
    model = need(await steward.describe(), "steward", "describe");
  }
  const feed = await EventFeed.start(applier);
  const closeHint = `; galatea close --transport ${shellQuote(t.id)} closes it`;
  // Ctrl-C is the tool's from just before the window is asked for: one that comes while it opens closes it
  // once open (or once its answer is unknown); a second ends the tool at once (review M1).
  const ctl = new Interrupts();
  const dispose = ctx.onInterrupt(() => ctl.fire());
  const w = new Watch(ctx, t, model ?? { revision: 0, targets: [] }, ctl);
  try {
    let body: Body | typeof SECOND;
    try {
      body = await ctl.unlessSecond(provisionOnce(applier, { join: { transport: t.id, window_s } }));
    } catch (err) {
      // Lost twice: the window may be open (review M3).
      if (!(err instanceof Lost)) throw err;
      if (ctl.count) return await w.interrupted(applier);
      ctx.say.err(`galatea join: the join was lost; a window may be open${closeHint}`);
      throw err;
    }
    if (body === SECOND) return w.again();
    if (!taken(body)) {
      // Asked to stop, and the window may be opening: closed all the same (review M4).
      if (ctl.count && body.status === "unreachable") return await w.interrupted(applier);
      if (body.status === "failed" && body.reason === "busy") {
        if (ctx.json) ctx.say.out(jsonLine(body));
        ctx.say.err(`galatea join: a join window is already open on ${t.id}${closeHint}`);
        return 1;
      }
      return notTaken(ctx, body, "join", body.status === "unreachable" ? `, a window may still open${closeHint}` : "");
    }
    ctx.done = true;
    w.requestId = typeof body.request_id === "string" ? body.request_id : undefined;
    const opened = ctx.now();
    ctx.say.out(ctx.json ? jsonLine(body) : `join window open on ${t.id} (bridge ${t.bridge}) for ${window_s} s${closeHint}`);
    if (ctl.count) return await w.interrupted(applier);
    if (o.noWait) return 0;
    return await watch(ctx, { applier, steward: steward!, feed, w, interrupted: ctl.first, opened, window_s, closeHint });
  } finally {
    dispose();
  }
}

const SECOND = Symbol("interrupted again");

/** The owner's Ctrl-Cs: the first asks `join` to close its window; a second, while it does, ends the tool at once (review M1). */
class Interrupts {
  count = 0;
  private resolveFirst!: () => void;
  private resolveSecond!: () => void;
  readonly first = new Promise<typeof INTERRUPTED>((r) => { this.resolveFirst = () => r(INTERRUPTED); });
  private readonly second = new Promise<typeof SECOND>((r) => { this.resolveSecond = () => r(SECOND); });

  fire(): void {
    this.count++;
    if (this.count === 1) this.resolveFirst();
    else this.resolveSecond();
  }

  /** `p`, unless a second Ctrl-C comes first; `p` is then left behind, its failure dropped. */
  unlessSecond<T>(p: Promise<T>): Promise<T | typeof SECOND> {
    p.catch(() => undefined);
    return Promise.race([p, this.second]);
  }
}

/** `join`'s wait on its window, from the events and the steward's describe, until it closes or the owner interrupts. */
async function watch(ctx: Ctx, o: { applier: Applier; steward: Steward; feed: EventFeed; w: Watch; interrupted: Promise<typeof INTERRUPTED>;
  opened: number; window_s: number; closeHint: string }): Promise<Exit> {
  const { applier, steward, feed, w, window_s, closeHint } = o;
  const t = w.transport;
  /** A call raced with Ctrl-C; one left behind by it is never awaited, so its failure is dropped. */
  const raced = <T>(p: Promise<T>): Promise<T | typeof INTERRUPTED> => {
    p.catch(() => undefined);
    return Promise.race([p, o.interrupted]);
  };
  try {
    const deadline = o.opened + (window_s + CLOSE_GRACE_S) * 1000;
    for (;;) {
      if (w.closed && w.pending.size === 0) break;
      if (!w.closed) {
        if (ctx.now() >= deadline) {
          w.summary();
          ctx.say.err(`galatea join: no window_closed heard from ${t.id} ${CLOSE_GRACE_S} s after the window's ${window_s} s${closeHint}`);
          return 1;
        }
        const wait = w.pending.size ? 0 : Math.min(MAX_WAIT_S, (deadline - ctx.now()) / 1000);
        const events = await raced(feed.next(wait));
        if (events === INTERRUPTED) return await w.interrupted(applier);
        for (const e of events) w.event(e);
      }
      if (w.pending.size) {
        const due = Math.min(...w.pending.values()) + DESCRIBE_WITHIN_S * 1000;
        const wait = Math.min(w.closed ? MAX_WAIT_S : DESCRIBE_POLL_S, Math.max(0, (due - ctx.now()) / 1000));
        const m = await raced(steward.describe({ since_revision: w.revision, wait_s: Math.ceil(wait) }));
        if (m === INTERRUPTED) return await w.interrupted(applier);
        w.described(need(m, "steward", "describe"));
        w.overdue();
      }
    }
    w.summary();
    return 0;
  } catch (err) {
    ctx.say.err(`galatea join: the window on ${t.id} may still be open${closeHint}`);
    throw err;
  }
}

/** What `join` has seen of its window: the devices joined, those still waited for, and how it closed. */
class Watch {
  /** Each device listed, in the order it joined, and whether it was described. */
  readonly devices = new Map<string, boolean>();
  /** Each device joined and not yet described, with when it joined (the tool's clock). */
  readonly pending = new Map<string, number>();
  closed?: Body;
  revision: number;
  /** The request that opened the window, as `provision` answered it. */
  requestId?: string;

  constructor(private readonly ctx: Ctx, private readonly t: Body, private model: Body, private readonly ctl: Interrupts) {
    this.revision = Number(model.revision);
  }

  get transport(): Body {
    return this.t;
  }

  /** A `provision` event of the window's bridge: `joined`, or its `window_closed`; anything else is not this window's. */
  event(e: Body): void {
    if (e.type !== "provision" || e.bridge !== this.t.bridge) return;
    if (e.what === "joined" && typeof e.device === "string") {
      if (this.ctx.json) this.ctx.say.out(jsonLine(e));
      this.joined(e.device);
    } else if (e.what === "window_closed" && (e.transport === undefined || e.transport === this.t.id)
      // One that names another request closed another window (review M2); one that names none is taken as this one's.
      && (e.request_id === undefined || this.requestId === undefined || e.request_id === this.requestId)) {
      if (this.ctx.json) this.ctx.say.out(jsonLine(e));
      this.closed = e;
      // A device the window_closed names that was not seen join (its event missed) is this window's too.
      for (const d of Array.isArray(e.devices) ? e.devices : []) if (typeof d === "string") this.joined(d);
    }
  }

  private joined(device: string): void {
    if (this.devices.has(device)) return;
    this.devices.set(device, false);
    this.pending.set(device, this.ctx.now());
    if (!this.ctx.json) this.ctx.say.out(`joined: ${device}`);
    // The model in hand may describe it already (it joined before, or was described before its event came).
    this.check(this.model);
  }

  /** A steward's model: each device waited for that it lists is described now. */
  described(model: Body): void {
    this.model = model;
    this.revision = Number(model.revision);
    this.check(model);
  }

  private check(model: Body): void {
    for (const id of [...this.pending.keys()]) {
      const target = (model.targets ?? []).find((x: Body) => x.id === id);
      if (!target) continue;
      this.pending.delete(id);
      this.devices.set(id, true);
      this.show(target);
    }
  }

  /** A device described: its id, the class proposed and why, its capabilities, and the adopt line to run. */
  private show(d: Body): void {
    const say = this.ctx.say.out;
    if (this.ctx.json) return say(jsonLine(d));
    if (d.adopted) return say(`described: ${d.id}  adopted already, class ${d.class ?? "none"}`);
    const proposed = d.proposed_class ? `proposed ${d.proposed_class}${d.class_evidence ? ` (${d.class_evidence})` : ""}` : "no class proposed";
    say(`described: ${d.id}  ${proposed}  capabilities: ${(d.capabilities ?? []).join(", ") || "none"}`);
    say(`  galatea adopt ${shellQuote(d.id)} --class ${d.proposed_class ?? "CLASS"}`);
    if (!d.proposed_class) say(`  (no class proposed; CLASS is one of ${vocabulary().classes.join(", ")})`);
  }

  /** Each device waited for past its 120 s: said so, and no longer waited for. */
  overdue(): void {
    const now = this.ctx.now();
    for (const [id, at] of [...this.pending]) {
      if (now - at < DESCRIBE_WITHIN_S * 1000) continue;
      this.pending.delete(id);
      this.ctx.say.out(this.ctx.json ? jsonLine({ galatea: "not_described", device: id, after_s: DESCRIBE_WITHIN_S })
        : `joined, not described: ${id}: its interview may have failed; it stays unadopted`);
    }
  }

  /** Every device listed, and the window's effective length when its `window_closed` said it. */
  summary(): void {
    const window_s = typeof this.closed?.window_s === "number" ? this.closed.window_s : undefined;
    if (this.ctx.json) {
      this.ctx.say.out(jsonLine({ galatea: "window_closed", transport: this.t.id, ...(window_s !== undefined ? { window_s } : {}),
        devices: [...this.devices].map(([id, described]) => ({ id, described })) }));
      return;
    }
    const n = this.devices.size;
    this.ctx.say.out(`window closed on ${this.t.id}${window_s !== undefined ? ` after ${window_s} s` : ""}; ${n} joined${n ? ":" : ""}`);
    for (const [id, described] of this.devices) this.ctx.say.out(`  ${id}  ${described ? "described" : "not described"}`);
  }

  /** A second Ctrl-C: the tool ends at once, saying how to close the window it may leave open. */
  again(): Exit {
    this.ctx.say.err(`galatea join: interrupted again; the window on ${this.t.id} may be open; galatea close --transport ${shellQuote(this.t.id)} closes it`);
    return 1;
  }

  /**
   * Ctrl-C: the window closed with `join_close`, then what was listed; 1 when the close was not taken.
   * Once this window's `window_closed` came, nothing is closed: a window open now is another's (review I1).
   */
  async interrupted(applier: Applier): Promise<Exit> {
    if (this.closed) {
      if (this.ctx.json) this.ctx.say.out(jsonLine({ galatea: "interrupted", join_close: null }));
      else this.ctx.say.out("interrupted: the window had closed already; nothing to close");
      this.summary();
      return 0;
    }
    let body: Body | typeof SECOND;
    try {
      body = await this.ctl.unlessSecond(provisionOnce(applier, { join_close: { transport: this.t.id } }));
    } catch (err) {
      this.ctx.say.err(`galatea join: interrupted, and the close failed: ${err instanceof Error ? err.message : String(err)}; `
        + `galatea close --transport ${shellQuote(this.t.id)} closes it`);
      return 1;
    }
    if (body === SECOND) return this.again();
    if (this.ctx.json) this.ctx.say.out(jsonLine({ galatea: "interrupted", join_close: body }));
    if (!taken(body)) {
      this.ctx.say.err(`galatea join: interrupted, and the bridge did not take the close (${body.status}${body.reason ? `, ${body.reason}` : ""}); `
        + `galatea close --transport ${shellQuote(this.t.id)} closes it`);
      return 1;
    }
    if (!this.ctx.json) this.ctx.say.out(`interrupted: closed the join window on ${this.t.id}`);
    this.summary();
    return 0;
  }
}
