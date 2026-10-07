import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorsOwn, proofOf, tokenFault, TOKEN_HORIZON_MS, TOKEN_SKEW_MS, type Token } from "../src/gate/token.js";

const KEY = "a-token-key-of-the-steward";
const NOW = Date.parse("2030-01-01T08:00:00Z");
const step = { target: "hall:gate", action: "cover.close", args: {}, via: "app" as const, brain: false, for: { person: "demo" } };

/** A token for `step`, signed with `key`, as the steward issues one. */
function token(extra: Partial<Token> = {}, key = KEY): Token {
  const t = { token_id: "t-1", issuer: "steward", ...step, expires: new Date(NOW + 60_000).toISOString(), ...extra };
  const { proof: _p, ...unsigned } = t as Token;
  return { ...unsigned, proof: extra.proof ?? proofOf(unsigned, key) };
}

const check = (t: unknown, o: { client?: string; key?: string; now?: number; used?: boolean } = {}) =>
  tokenFault(t, step, { client: o.client ?? "steward", key: "key" in o ? o.key : KEY, now: o.now ?? NOW, used: () => o.used ?? false });

describe("the confirmation token (GA-TOKEN-2)", () => {
  it("proves with HMAC-SHA256 over the RFC 8785 form without proof, as base64url without padding", () => {
    const t = token();
    // Keys sorted, no spaces: the canonical form the binding names.
    const form = `{"action":"cover.close","args":{},"brain":false,"expires":"${t.expires}","for":{"person":"demo"},`
      + `"issuer":"steward","target":"hall:gate","token_id":"t-1","via":"app"}`;
    expect(t.proof).toBe(createHmac("sha256", KEY).update(form).digest("base64url"));
    expect(t.proof).not.toMatch(/=/);
    expect(check(t)).toBeUndefined();
  });

  it("leaves a key whose value is undefined out of the canonical form, as RFC 8785 serialises JSON", () => {
    const t = token();
    const { proof: _p, ...unsigned } = t;
    expect(proofOf({ ...unsigned, extra: undefined } as never, KEY)).toBe(t.proof);
  });

  it("counts a token for another target, action, args, via, brain or for as none", () => {
    for (const [field, value] of [["target", "hall:lamp"], ["action", "cover.open"], ["args", { position: 3 }], ["via", "voice"],
      ["brain", true], ["for", { person: "guest" }]] as const) {
      expect(check(token({ [field]: value })), field).toMatch(/names another/);
    }
  });

  it("counts a token expired past the 5 s skew as none, and one within it as a token", () => {
    expect(check(token({ expires: new Date(NOW - TOKEN_SKEW_MS - 1000).toISOString() }))).toMatch(/expired/);
    expect(check(token({ expires: new Date(NOW - TOKEN_SKEW_MS + 1000).toISOString() }))).toBeUndefined();
  });

  it("counts a token expiring more than 300 s ahead as none, and one at 300 s as a token", () => {
    expect(check(token({ expires: new Date(NOW + TOKEN_HORIZON_MS + 1000).toISOString() }))).toMatch(/300 s/);
    expect(check(token({ expires: new Date(NOW + TOKEN_HORIZON_MS).toISOString() }))).toBeUndefined();
  });

  it("counts a token issued by another client, or proved with another key, or sent by a client with no key, as none", () => {
    expect(check(token({ issuer: "other" }))).toMatch(/issued by other/);
    expect(check(token({}, "another-key-entirely-here"))).toMatch(/does not verify/);
    expect(check(token({ proof: "x".repeat(43) }))).toMatch(/does not verify/);
    expect(check(token(), { key: undefined })).toMatch(/no token key/);
  });

  it("counts a used token as none, and a token of any other shape too", () => {
    expect(check(token(), { used: true })).toMatch(/already used/);
    expect(check({ ...token(), extra: 1 })).toMatch(/shape/);
    expect(check("a token")).toMatch(/shape/);
    const { proof: _p, ...bare } = token();
    expect(check(bare)).toMatch(/shape/);
  });

  it("takes a token whose for names a rule, or a run with no person and no endpoint, as an author's confirmation (GA-PLAN-8)", () => {
    expect(authorsOwn({ rule: "evening" })).toBe(true);
    expect(authorsOwn({ run: "r-1" })).toBe(true);
    expect(authorsOwn({ run: "r-1", schedule: "s" })).toBe(true);
    expect(authorsOwn({ run: "r-1", endpoint: "hall-panel" })).toBe(false);
    expect(authorsOwn({ run: "r-1", person: "demo" })).toBe(false);
    expect(authorsOwn({ person: "demo" })).toBe(false);
  });
});
