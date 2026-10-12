import { type Ctx, type Exit, need, Refusal, Usage } from "../context.js";
import { clean, deviceDetail, deviceLine, jsonLine } from "../print.js";
import { EventFeed, INTERRUPTED, interruption } from "../poll.js";
import { OWNER_APP } from "../servers.js";
import { Lost } from "../link.js";

type Body = Record<string, any>;

/** The steward's liveness of each target it can say, from its `state`; nothing when it cannot. */
async function livenessOf(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const st = need(await (await ctx.steward()).state({ targets: ids }), "steward", "state");
  return new Map(Object.entries((st.targets ?? {}) as Record<string, Body>).map(([id, t]) => [id, String(t.liveness)]));
}

/**
 * `galatea devices [--all]`: the applier's devices, each with its bridge, adopted or not, the class
 * proposed and its evidence, its liveness (the steward's `state`), and the steward's name and room.
 * `--all` adds every capability and action with its tier. The applier's list is the substance: with
 * the steward not reached it is still printed, without names, and the command ends 2; with the
 * steward's `state` failing, without liveness, ending 1 (review M5).
 */
export async function devices(ctx: Ctx, all: boolean): Promise<Exit> {
  const model = need(await (await ctx.applier()).describe(), "applier", "describe");
  const devs: Body[] = model.devices ?? [];
  let exit: Exit = 0;
  let house: Body | undefined;
  let stewardError: string | undefined;
  try {
    house = need(await (await ctx.steward()).describe(), "steward", "describe");
  } catch (err) {
    stewardError = (err as Error).message;
    exit = 2;
  }
  const targets = new Map<string, Body>((house?.targets ?? []).map((t: Body) => [t.id, t]));
  let live = new Map<string, string>();
  let livenessError: string | undefined;
  if (house) {
    try {
      live = await livenessOf(ctx, devs.map((d) => d.id).filter((id) => targets.has(id)));
    } catch (err) {
      livenessError = (err as Error).message;
      exit = 1;
    }
  }
  if (ctx.json) {
    ctx.say.out(jsonLine({ devices: devs.map((d) => ({ ...d, liveness: live.get(d.id) ?? null,
      steward: targets.has(d.id) ? { name: targets.get(d.id)!.name, room: targets.get(d.id)!.room ?? null } : null })),
    ...(stewardError ? { steward_error: stewardError } : {}), ...(livenessError ? { liveness_error: livenessError } : {}) }));
  } else {
    if (stewardError) ctx.say.err(`steward: not reached: ${stewardError}`);
    if (livenessError) ctx.say.err(`liveness not read: ${livenessError}`);
    if (!devs.length) ctx.say.out("the applier describes no device");
    for (const d of devs) {
      ctx.say.out(deviceLine(d, house ? targets.get(d.id) ?? null : undefined, live.get(d.id)));
      if (all) for (const l of deviceDetail(d)) ctx.say.out(l);
    }
  }
  return exit;
}

/** An ask put on `owner-app` that waits: its event as the steward kept it, and the steps no later `answer` answered. */
export interface OpenAsk {
  event: Body;
  waiting: string[];
}

/** The asks put on `owner-app` within the window whose steps no later `answer` event answered all of, oldest first. */
export function openAskList(events: Body[]): OpenAsk[] {
  const open: OpenAsk[] = [];
  events.forEach((e, i) => {
    if (e.type !== "ask" || e.endpoint !== OWNER_APP) return;
    const answered = new Set<string>();
    for (const later of events.slice(i + 1)) {
      if (later.type === "answer" && later.plan_id === e.plan_id) for (const s of Object.keys(later.answers ?? {})) answered.add(s);
    }
    const waiting = ((e.step_ids ?? []) as string[]).filter((s) => !answered.has(s));
    if (waiting.length) open.push({ event: e, waiting });
  });
  return open;
}

/** How many asks on `owner-app` wait (`openAskList`), as `status` counts them. */
export function openAsks(events: Body[]): number {
  return openAskList(events).length;
}

/**
 * `galatea status`: both servers reached and each one's revision, every transport (up, state, its
 * bridge), the notices the steward holds while no channel offers `notify` (its `held_notices`), the
 * devices not live, and the open asks on `owner-app` counted. Each read is its own: a
 * server not reached, or a later read of a reached server that fails, is said, and everything else
 * reached is still shown (review I2). It ends 2 when a server was not reached, 1 when a server was
 * reached but a later read of it failed, 0 otherwise.
 */
export async function status(ctx: Ctx): Promise<Exit> {
  const out: Body = {};
  let unreached = false;
  let unread = false;
  const reach = async <T>(what: string, f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f();
    } catch (err) {
      unreached = true;
      if (ctx.json) out[`${what}_error`] = (err as Error).message;
      else ctx.say.err(`${what}: not reached: ${(err as Error).message}`);
      return undefined;
    }
  };
  /** A read of a reached server: its value, or the failure said in its place. */
  const read = async <T>(f: () => Promise<T>): Promise<{ value: T } | { error: string }> => {
    try {
      return { value: await f() };
    } catch (err) {
      unread = true;
      return { error: (err as Error).message };
    }
  };
  const model = await reach("applier", async () => need(await (await ctx.applier()).describe(), "applier", "describe"));
  if (model) {
    out.applier = model;
    if (!ctx.json) {
      ctx.say.out(`applier ${model.applier_id}: reached, standard ${model.standard_version}, revision ${model.revision}`);
      for (const t of model.transports ?? []) ctx.say.out(`  transport ${t.id} (${t.kind}): ${t.up ? "up" : "down"}, state ${t.state}, bridge ${t.bridge}`);
      if (!(model.transports ?? []).length) ctx.say.out("  no transport: no bridge registered or connected yet");
    }
  }
  const house = await reach("steward", async () => need(await (await ctx.steward()).describe(), "steward", "describe"));
  if (house) {
    out.steward = house;
    if (!ctx.json) {
      ctx.say.out(`steward ${house.steward_id}: reached, standard ${house.standard_version}, revision ${house.revision}`);
      // Shown only while no adopted channel offers notify (GA-NOTE-1); --json carries it in the steward's body.
      if (house.held_notices !== undefined) {
        ctx.say.out(`  notices held: ${house.held_notices} (no notify channel: notice_channels names no device that offers notify)`);
      }
    }
    const adopted = (house.targets ?? []).filter((t: Body) => t.adopted !== false).map((t: Body) => t.id as string);
    const live = await read(() => livenessOf(ctx, adopted));
    if ("value" in live) {
      const notLive = adopted.filter((id: string) => live.value.get(id) !== "live").map((id: string) => ({ id, liveness: live.value.get(id) ?? null }));
      out.not_live = notLive;
      if (!ctx.json) {
        ctx.say.out(notLive.length ? `  not live: ${notLive.map((x: Body) => `${x.id} (${x.liveness ?? "not known"})`).join(", ")}`
          : `  every adopted device is live (${adopted.length})`);
      }
    } else {
      out.not_live = null;
      out.not_live_error = live.error;
      if (!ctx.json) ctx.say.out(`  not live: not read (${live.error})`);
    }
    const asks = await read(async () => askWindow(ctx, Number(house.home?.ask_expiry_s ?? 300)));
    if ("value" in asks) {
      out.open_asks = openAsks(asks.value.events);
      if (asks.value.partial) out.open_asks_partial = true;
      if (!ctx.json) {
        ctx.say.out(`  open asks on owner-app: ${out.open_asks}${asks.value.partial ? ` (counted from the first ${HISTORY_PAGES} pages of history only)` : ""}`);
      }
    } else {
      out.open_asks = null;
      out.open_asks_error = asks.error;
      if (!ctx.json) ctx.say.out(`  open asks on owner-app: not read (${asks.error})`);
    }
  }
  if (ctx.json) ctx.say.out(jsonLine(out));
  return unreached ? 2 : unread ? 1 : 0;
}

/**
 * The most pages of `history` read for the open asks: the steward answers at most 10 000 events a
 * page, `more: true` past it, and the caller reads on with `after_seq` (review M3). Past this many
 * the count is of what was read, and says so.
 */
export const HISTORY_PAGES = 10;

/**
 * The steward's events over the last `expiry` seconds, page by page. The window is by the tool's own
 * clock, a minute's margin past now: a tool on a machine whose clock is off by more shifts it (review
 * M4, left as it is).
 */
export async function askWindow(ctx: Ctx, expiry: number): Promise<{ events: Body[]; partial: boolean }> {
  const now = ctx.now();
  const range = { from: new Date(now - expiry * 1000).toISOString(), to: new Date(now + 60_000).toISOString() };
  const events: Body[] = [];
  let after: number | undefined;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const hist = need(await (await ctx.steward()).history({ ...range, ...(after !== undefined ? { after_seq: after } : {}) }), "steward", "history");
    const got: Body[] = hist.events ?? [];
    events.push(...got);
    if (hist.more !== true || !got.length) return { events, partial: false };
    after = Number(got.at(-1)!.seq);
  }
  return { events, partial: true };
}

/** How long one read of `galatea events` waits for the first event (the steward's longest long-poll). */
export const EVENTS_WAIT_S = 30;

/** How far back `galatea history` reads without `--from`: a day. */
export const HISTORY_DEFAULT_S = 86_400;

/** An event's plain line: its time, `#seq` and type, then every other field as `key=value`, an object or array as JSON. */
export function eventLine(e: Body): string {
  const rest = Object.entries(e).filter(([k]) => k !== "seq" && k !== "time" && k !== "type")
    .map(([k, v]) => `${clean(k)}=${clean(v !== null && typeof v === "object" ? JSON.stringify(v) : String(v))}`);
  return [clean(String(e.time ?? "-")), `#${clean(String(e.seq ?? "-"))}`, clean(String(e.type ?? "event")), rest.join(" ")].filter((x) => x !== "").join("  ");
}

const SPAN = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** RFC 3339 with its offset (a `Z` or `+hh:mm`), as the standards write times. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * `--from`/`--to`: an RFC 3339 time with its offset, or a span ago, a whole number of seconds,
 * minutes, hours or days (`90s`, `15m`, `2h`, `7d`). A time without an offset is refused: whose
 * clock it is on would be a guess.
 */
export function parseTime(raw: string, now: number, flag: string): number {
  const span = SPAN.exec(raw);
  if (span) return now - Number(span[1]) * UNIT_MS[span[2]];
  const t = RFC3339.test(raw) ? Date.parse(raw) : NaN;
  if (Number.isNaN(t)) {
    throw new Usage(`${flag} is an RFC 3339 time with its offset (2026-10-07T10:00:00Z) or a span ago (90s, 15m, 2h, 7d): ${JSON.stringify(raw)} is not`);
  }
  return t;
}

/** The cursor said at the end of a read, so the owner can read on from it. */
function sayCursor(ctx: Ctx, cursor: string, prefix = ""): void {
  ctx.say.out(ctx.json ? jsonLine({ galatea: "cursor", cursor }) : `${prefix}cursor ${cursor}: galatea events --cursor ${cursor} reads on`);
}

/**
 * `galatea events [--cursor C] [--follow]` (the design, *The commands*): the steward's events from
 * now (its current cursor, taken first) or after a cursor kept from an earlier read. Without
 * `--follow`, one long-poll of up to 30 s, its events printed; with it, read on as they come until
 * Ctrl-C, which ends it 0. Either way the cursor reached is said last. Past an expired cursor
 * `--follow` says events were missed and reads on from now; a single read ends with the refusal.
 */
export async function events(ctx: Ctx, o: { follow: boolean; cursor?: string }): Promise<Exit> {
  if (o.cursor !== undefined && !/^\S+$/.test(o.cursor)) throw new Usage("--cursor is a cursor an earlier galatea events said");
  const steward = await ctx.steward();
  let feed = o.cursor !== undefined ? EventFeed.from(steward, o.cursor, "steward") : await EventFeed.start(steward, "steward");
  if (o.follow) ctx.say.err(`galatea events: following from cursor ${feed.cursor}; Ctrl-C ends it`);
  const stop = interruption(ctx.onInterrupt);
  // The cursor said when Ctrl-C ends a read is the one from before it: what that read was bringing is read again, never skipped.
  let said = feed.cursor;
  try {
    for (;;) {
      said = feed.cursor;
      if (stop.fired) break;
      let got;
      try {
        got = await stop.race(feed.next(EVENTS_WAIT_S));
      } catch (err) {
        // A lost call (a steward restarting) ends the read, 1, with the cursor to read on from: the ruling, not a retry.
      if (err instanceof Lost) {
        ctx.say.err(`galatea events: lost the steward's events; cursor ${feed.cursor}: galatea events --cursor ${feed.cursor} reads on`);
        throw err;
      }
      if (!(o.follow && err instanceof Refusal && err.reply.error === "cursor_expired")) throw err;
        ctx.say.err(`galatea events: events after cursor ${feed.cursor} were missed (${err.reply.error}: ${err.reply.message}); reading on from now`);
        feed = await EventFeed.start(steward, "steward");
        said = feed.cursor;
        continue;
      }
      if (got === INTERRUPTED) break;
      for (const e of got) ctx.say.out(ctx.json ? jsonLine(e) : eventLine(e));
      if (!o.follow) {
        if (!got.length && !ctx.json) ctx.say.out(`no event in ${EVENTS_WAIT_S} s`);
        sayCursor(ctx, feed.cursor);
        return 0;
      }
    }
    sayCursor(ctx, said, "interrupted; ");
    return 0;
  } finally {
    stop.dispose();
  }
}

/**
 * `galatea history [<target>] [--from T] [--to T]` (the design, *The commands*): the steward's
 * `history` from `--from` (default a day ago) to `--to` (default a minute past now, the tool's clock),
 * for one target or all, each event printed as its page comes, read on with `after_seq` while the
 * steward says `more`, at most `HISTORY_PAGES` pages; past them the cap is said, with how to narrow.
 */
export async function history(ctx: Ctx, target: string | undefined, o: { from?: string; to?: string }): Promise<Exit> {
  const now = ctx.now();
  const from = o.from === undefined ? now - HISTORY_DEFAULT_S * 1000 : parseTime(o.from, now, "--from");
  const to = o.to === undefined ? now + 60_000 : parseTime(o.to, now, "--to");
  if (from >= to) throw new Usage(`--from (${new Date(from).toISOString()}) is not before --to (${new Date(to).toISOString()})`);
  const range = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(target !== undefined ? { targets: [target] } : {}) };
  const steward = await ctx.steward();
  let after: number | undefined;
  let count = 0;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const hist = need(await steward.history({ ...range, ...(after !== undefined ? { after_seq: after } : {}) }), "steward", "history");
    const got: Body[] = hist.events ?? [];
    for (const e of got) ctx.say.out(ctx.json ? jsonLine(e) : eventLine(e));
    count += got.length;
    if (hist.more !== true || !got.length) {
      if (!count && !ctx.json) ctx.say.out(`no event${target !== undefined ? ` for ${target}` : ""} from ${range.from} to ${range.to}`);
      return 0;
    }
    after = Number(got.at(-1)!.seq);
  }
  if (ctx.json) ctx.say.out(jsonLine({ galatea: "history_partial", pages: HISTORY_PAGES, events: count, after_seq: after }));
  ctx.say.err(`galatea history: stopped after ${HISTORY_PAGES} pages (${count} events), the last seq ${after}; narrow it with --from, --to or a target`);
  return 0;
}
