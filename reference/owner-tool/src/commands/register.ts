import { type Ctx, type Exit, Usage } from "../context.js";
import { changeLines, jsonLine } from "../print.js";
import { sendAtRevision } from "../revision.js";
import { vocabulary } from "../vocabulary.js";

/** A credential id the tool reads a file for: a plain file name under `secrets/mcp`, no path in it. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
/** The installation's own files under `secrets/mcp`, which no credential defined at the steward is. */
const OWN_FILES = new Set(["applier-owner", "steward-owner", "steward-at-applier", "steward-token-key"]);
/** The least secret the steward takes (`define.credential`'s schema). */
const MIN_SECRET = 16;
const KINDS = ["app", "panel", "brain", "front"] as const;

function said(ctx: Ctx, body: Record<string, any>, line: string): Exit {
  if (ctx.json) ctx.say.out(jsonLine(body));
  else ctx.say.out(`${line}${body.revision !== undefined ? `, revision ${body.revision}` : ""}`);
  return 0;
}

/** `galatea register bridge <id> [--identity I]`: the applier's `configure { bridge }`, the identity the id unless given. */
export async function registerBridge(ctx: Ctx, id: string | undefined, identity: string | undefined): Promise<Exit> {
  if (!id) throw new Usage("galatea register bridge <id> [--identity I]: name the bridge");
  const { bridgeId, identity: IDENTITY } = vocabulary();
  if (!bridgeId.test(id)) {
    throw new Usage(`the applier's bridge id matches ${bridgeId.source}: ${JSON.stringify(id)} does not (an identity like bridge_zigbee is registered as \`galatea register bridge zigbee --identity bridge_zigbee\`)`);
  }
  const ident = identity ?? id;
  if (!IDENTITY.test(ident)) throw new Usage(`a broker identity matches ${IDENTITY.source}: ${JSON.stringify(ident)} does not`);
  const body = await sendAtRevision(ctx, "applier", "configure", [{ op: "upsert", kind: "bridge", value: { id, identity: ident } }], { dryRun: false });
  return said(ctx, body, `registered bridge ${id} (broker identity ${ident}) at the applier`);
}

/**
 * `galatea credential <id> --kind K [--endpoint E] [--confirm-on E2]`: the steward's `define` of a
 * credential, its secret read from `secrets/mcp/<id>`. `--endpoint` for an app or a panel only (and
 * needed there); `--confirm-on` for a brain only. The secret leaves only inside the define.
 */
export async function credential(ctx: Ctx, id: string | undefined, o: { kind?: string; endpoint?: string; confirmOn?: string }): Promise<Exit> {
  if (!id) throw new Usage("galatea credential <id> --kind K [--endpoint E] [--confirm-on E2]: name the credential");
  if (!CREDENTIAL_ID.test(id) || id === "." || id === "..") throw new Usage(`a credential id is a plain file name under secrets/mcp (A-Z, a-z, 0-9, ., _ and -, at most 64): ${JSON.stringify(id)} is not one`);
  if (OWN_FILES.has(id)) throw new Usage(`${id} is one of the installation's own secrets, not a credential to define at the steward`);
  if (!o.kind || !(KINDS as readonly string[]).includes(o.kind)) throw new Usage(`--kind is one of ${KINDS.join(", ")}`);
  const appLike = o.kind === "app" || o.kind === "panel";
  if (appLike && !o.endpoint) throw new Usage(`an ${o.kind} credential names its one endpoint: --endpoint E`);
  if (!appLike && o.endpoint) throw new Usage(`--endpoint is for an app or a panel credential; a ${o.kind} credential names none (the endpoint names its served_by)`);
  if (o.confirmOn && o.kind !== "brain") throw new Usage("--confirm-on is for a brain credential only");
  const secret = ctx.secret(id);
  if (secret.length < MIN_SECRET) throw new Usage(`secrets/mcp/${id} is shorter than ${MIN_SECRET} characters (galatea-secret ${id} makes one)`);
  const value = { id, kind: o.kind, secret, ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(o.confirmOn ? { confirm_on: o.confirmOn } : {}) };
  const body = await sendAtRevision(ctx, "steward", "define", [{ op: "upsert", kind: "credential", value }], { dryRun: false });
  if (ctx.json) ctx.say.out(jsonLine(body));
  else for (const l of changeLines(body, `defined the ${o.kind} credential ${id} at the steward`)) ctx.say.out(l);
  return 0;
}
