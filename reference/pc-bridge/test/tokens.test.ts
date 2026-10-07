import { describe, expect, it } from "vitest";
import { accountsOf, checkTokens, deriveToken, emptyTokens, retire, see, tokenOf } from "../src/tokens.js";

describe("deriveToken", () => {
  it.each([
    ["a name that fits", 1000, "liza", [], "liza"],
    ["a name with a capital", 1001, "John.Doe", [], "u1001"],
    ["a name with a dot", 1002, "john.doe", [], "u1002"],
    ["a Cyrillic name", 1003, "ольга", [], "u1003"],
    ["a name longer than 32", 1004, "a".repeat(33), [], "u1004"],
    ["a name in the u form", 1005, "u7", [], "u1005"],
    ["a name in the g form", 1006, "g27", [], "u1006"],
    ["the name unknown", 1007, "unknown", [], "u1007"],
    ["a name given before", 1008, "liza", ["liza"], "u1008"],
    ["a u form given before", 1009, "liza", ["liza", "u1009"], "u1010"],
    ["the next u forms given too", 1009, "x.y", ["u1009", "u1010", "u1011"], "u1012"],
  ])("%s", (_name, osId, name, given, token) => {
    expect(deriveToken(osId, name, new Set(given))).toBe(token);
  });
});

describe("the token table", () => {
  it("fixes a token at first sight and keeps it through a rename, the label following", () => {
    const t = emptyTokens();
    expect(see(t, 1000, "liza", true)).toBe(true);
    expect(see(t, 1000, "liza", true)).toBe(false);
    expect(see(t, 1000, "elizaveta", true)).toBe(true);
    expect(tokenOf(t, 1000)).toBe("liza");
    expect(accountsOf(t)).toEqual({ liza: "elizaveta" });
  });

  it("never gives a renamed account's old name to a new account", () => {
    const t = emptyTokens();
    see(t, 1000, "liza", true);
    see(t, 1000, "elizaveta", true);
    see(t, 1001, "liza", true);
    expect(accountsOf(t)).toEqual({ liza: "elizaveta", u1001: "liza" });
  });

  it("retires a deleted account's token for good: a new account under its uid or its name gets another", () => {
    const t = emptyTokens();
    see(t, 1000, "liza", true);
    expect(retire(t, 1000)).toBe(true);
    expect(retire(t, 1000)).toBe(false);
    expect(accountsOf(t)).toEqual({});
    see(t, 1000, "liza", true);
    expect(tokenOf(t, 1000)).toBe("u1000");
    retire(t, 1000);
    see(t, 1000, "liza", true);
    expect(tokenOf(t, 1000)).toBe("u1001");
    expect(t.given).toEqual(["liza", "u1000", "u1001"]);
  });

  it("gives a service account a token that accounts does not list, and lists it once it is interactive", () => {
    const t = emptyTokens();
    see(t, 0, "root", false);
    see(t, 998, "backup", false);
    expect(accountsOf(t)).toEqual({});
    expect(tokenOf(t, 0)).toBe("root");
    expect(see(t, 998, "backup", true)).toBe(true);
    expect(see(t, 998, "backup", false)).toBe(false);
    expect(accountsOf(t)).toEqual({ backup: "backup" });
  });

  it("lists accounts by token", () => {
    const t = emptyTokens();
    see(t, 1002, "zoe", true);
    see(t, 1001, "anna", true);
    expect(Object.keys(accountsOf(t))).toEqual(["anna", "zoe"]);
  });
});

describe("checkTokens", () => {
  it("takes a table this bridge wrote", () => {
    const t = emptyTokens();
    see(t, 1000, "liza", true);
    retire(t, 1000);
    see(t, 1001, "Ivan", true);
    expect(checkTokens(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it.each([
    ["not an object", 5, /not a token table/],
    ["no given", { accounts: {} }, /not a token table/],
    ["a given that is not a token", { accounts: {}, given: ["Liza"] }, /not a token/],
    ["a token given twice", { accounts: {}, given: ["liza", "liza"] }, /twice/],
    ["a key that is not an OS id", { accounts: { liza: { token: "liza", name: "liza", interactive: true } }, given: ["liza"] }, /not an OS id/],
    ["an entry without its flag", { accounts: { 1000: { token: "liza", name: "liza" } }, given: ["liza"] }, /not a token entry/],
    ["a token never given", { accounts: { 1000: { token: "liza", name: "liza", interactive: true } }, given: [] }, /never given/],
    ["a token held twice", { accounts: { 1000: { token: "liza", name: "liza", interactive: true },
      1001: { token: "liza", name: "liza", interactive: true } }, given: ["liza"] }, /held twice/],
  ])("refuses %s", (_name, value, error) => {
    expect(() => checkTokens(value)).toThrow(error);
  });
});
