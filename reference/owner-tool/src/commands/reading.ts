import { type Ctx, type Exit, need } from "../context.js";
import { deviceDetail, deviceLine, jsonLine } from "../print.js";

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

/** The asks put on `owner-app` within the last `ask_expiry_s` whose steps no `answer` event answered since. */
export function openAsks(events: Body[]): number {
  let open = 0;
  events.forEach((e, i) => {
    if (e.type !== "ask" || e.endpoint !== "owner-app") return;
    const answered = new Set<string>();
    for (const later of events.slice(i + 1)) {
      if (later.type === "answer" && later.plan_id === e.plan_id) for (const s of Object.keys(later.answers ?? {})) answered.add(s);
    }
    if ((e.step_ids ?? []).some((s: string) => !answered.has(s))) open++;
  });
  return open;
}

/**
 * `galatea status`: both servers reached and each one's revision, every transport (up, state, its
 * bridge), the devices not live, and the open asks on `owner-app` counted. Each read is its own: a
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
    if (!ctx.json) ctx.say.out(`steward ${house.steward_id}: reached, standard ${house.standard_version}, revision ${house.revision}`);
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
async function askWindow(ctx: Ctx, expiry: number): Promise<{ events: Body[]; partial: boolean }> {
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
