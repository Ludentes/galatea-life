import { createHmac } from "node:crypto";
import { validate, type ApplierToken } from "@ludentes/galatea-life-schemas";
import { canonical } from "../core/canonical.js";
import { sameSecret } from "../core/secret.js";

/**
 * The confirmation token (applier, *Clients and tokens*, *The MCP binding*): a client's proof that a
 * person confirmed this exact action. Checked at plan and again at dispatch; the check is a pure
 * function of the token, the step, the sending client's key and the clock.
 */
export type Token = ApplierToken;
/** What a token must name exactly as the step does (GA-TOKEN-2). */
export type Asked = { target: string; action: string; args: unknown; via: string; brain: boolean; for: unknown };

/** How far past its `expires` a token still stands, on the applier's clock (applier, *Constants*). */
export const TOKEN_SKEW_MS = 5_000;
/** A token expiring further ahead than this is none: no person's yes is meant to wait so long (GA-TOKEN-2). */
export const TOKEN_HORIZON_MS = 300_000;
const NAMED = ["target", "action", "args", "via", "brain", "for"] as const;

/**
 * The proof of a token: HMAC-SHA256, keyed by the client's token key (its UTF-8 bytes), over the
 * token without `proof` in RFC 8785 form, as base64url without padding. `canonical` is that form
 * for JSON values: keys sorted by their UTF-16 code units, and ECMAScript's own number and string
 * serialisation, which RFC 8785 adopts.
 */
export function proofOf(unsigned: Omit<Token, "proof">, key: string): string {
  return createHmac("sha256", key).update(canonical(unsigned)).digest("base64url");
}

export interface TokenCheck {
  /** The client that sent the step, which must be the token's `issuer`. */
  client: string;
  /** That client's token key; a client registered without one issues no token that stands. */
  key?: string;
  now: number;
  /** Whether `(issuer, token_id)` was already used (GA-TOKEN-4). */
  used(issuer: string, tokenId: string): boolean;
}

/**
 * Why `token` counts as no token for `step`, or undefined when it stands (GA-TOKEN-2): a token of
 * another shape, issued by another client, whose proof does not verify with the sending client's
 * key, naming another target, action, args, `via`, `brain` or `for`, expired past the skew,
 * expiring more than 300 s ahead, or already used.
 */
export function tokenFault(token: unknown, step: Asked, o: TokenCheck): string | undefined {
  if (validate("applier/token.json", token).length) return "the token is not of the token's shape";
  const t = token as Token;
  if (t.issuer !== o.client) return `the token was issued by ${t.issuer}, not by ${o.client}, which sent it`;
  if (o.key === undefined) return `${o.client} has no token key`;
  const { proof, ...unsigned } = t;
  if (!sameSecret(proof, proofOf(unsigned, o.key))) return "the token's proof does not verify";
  const differs = NAMED.filter((f) => canonical(t[f]) !== canonical(step[f]));
  if (differs.length) return `the token names another ${differs.join(", ")}`;
  const expires = Date.parse(t.expires);
  if (!(expires + TOKEN_SKEW_MS >= o.now)) return "the token expired";
  if (expires > o.now + TOKEN_HORIZON_MS) return "the token expires more than 300 s ahead";
  if (o.used(t.issuer, t.token_id)) return "the token was already used";
  return undefined;
}

/**
 * Whether a token's `for` is an author's confirmation, never a person's yes: it names a `rule`, or a
 * `run` with neither a `person` nor an `endpoint` (GA-PLAN-8). A run started at an endpoint with no
 * person (a hall panel) was asked there.
 */
export function authorsOwn(forWhom: unknown): boolean {
  if (typeof forWhom !== "object" || forWhom === null) return false;
  const f = forWhom as Record<string, unknown>;
  return f.rule !== undefined || (f.run !== undefined && f.person === undefined && f.endpoint === undefined);
}
