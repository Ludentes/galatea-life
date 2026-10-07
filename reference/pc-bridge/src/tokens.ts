/**
 * The token table (GA-BRIDGE-52): one token per OS account, keyed by the OS's own identity for it
 * (the uid on Linux, written as a decimal string), fixed when the bridge first sees the account and
 * kept across the bridge's restarts and the account's renames. `given` holds every token ever given,
 * so that none is given twice, a retired one included. Pure: the bridge keeps the table in its state
 * file and saves it.
 */
export interface TokenEntry {
  token: string;
  /** The account's current OS name: the label `accounts` declares, never part of a key. */
  name: string;
  /**
   * An interactive account has a key and an `accounts` entry; a service account has a token only
   * because the administrators' reduction named it (root, a service account granted sudo).
   */
  interactive: boolean;
}

export interface TokenTable {
  accounts: Record<string, TokenEntry>;
  given: string[];
}

/** What a token may be: a name that already fits it, or the `u` form. */
export const TOKEN = /^[a-z0-9_-]{1,32}$/;
/** Names never taken as they are: the `u` and `g` forms, and the `unknown` of an incomplete admin list. */
const RESERVED = /^(?:[ug][0-9]+|unknown)$/;

export function emptyTokens(): TokenTable {
  return { accounts: {}, given: [] };
}

/**
 * The token for a new account: its name when the name fits the token rule, is not reserved and was
 * never given; else `u<osId>` when never given; else `u<n>` for the smallest `n` above the osId never
 * given (a new account under the uid of a retired one whose `u` form was given).
 */
export function deriveToken(osId: number, name: string, given: ReadonlySet<string>): string {
  if (TOKEN.test(name) && !RESERVED.test(name) && !given.has(name)) return name;
  if (!given.has(`u${osId}`)) return `u${osId}`;
  for (let n = osId + 1; ; n++) if (!given.has(`u${n}`)) return `u${n}`;
}

/**
 * An account seen now, from a listing or from the administrators' facts: a new one gets its token,
 * a known one keeps it, its label following a rename. A service account seen as interactive becomes
 * interactive; never the other way, since an account missing from the interactive listing keeps its
 * key (a lapse). Returns whether the table changed.
 */
export function see(table: TokenTable, osId: number, name: string, interactive: boolean): boolean {
  const known = table.accounts[String(osId)];
  if (known) {
    const next = { ...known, name, interactive: known.interactive || interactive };
    if (next.name === known.name && next.interactive === known.interactive) return false;
    table.accounts[String(osId)] = next;
    return true;
  }
  const token = deriveToken(osId, name, new Set(table.given));
  table.accounts[String(osId)] = { token, name, interactive };
  table.given.push(token);
  return true;
}

/** An account the OS reports deleted: its token retires, kept in `given`, never given again. Returns whether it had one. */
export function retire(table: TokenTable, osId: number): boolean {
  if (!table.accounts[String(osId)]) return false;
  delete table.accounts[String(osId)];
  return true;
}

export function tokenOf(table: TokenTable, osId: number): string | undefined {
  return table.accounts[String(osId)]?.token;
}

/** The interactive accounts by osId, each with its token. */
export function interactive(table: TokenTable): { osId: number; token: string; name: string }[] {
  return Object.entries(table.accounts)
    .filter(([, e]) => e.interactive)
    .map(([id, e]) => ({ osId: Number(id), token: e.token, name: e.name }))
    .sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
}

/** The computer's `accounts` declaration, `{ <token>: <label> }`, one entry per interactive account, by token. */
export function accountsOf(table: TokenTable): Record<string, string> {
  return Object.fromEntries(interactive(table).map((a) => [a.token, a.name]));
}

/** Throws with what is wrong when `value` is not a token table this bridge wrote. */
export function checkTokens(value: unknown): TokenTable {
  const t = value as Partial<TokenTable> | null;
  if (!t || typeof t !== "object" || !t.accounts || typeof t.accounts !== "object" || Array.isArray(t.accounts) || !Array.isArray(t.given)) {
    throw new Error("tokens is not a token table");
  }
  const given = new Set<string>();
  for (const g of t.given) {
    if (typeof g !== "string" || !TOKEN.test(g)) throw new Error(`tokens.given holds ${JSON.stringify(g)}, not a token`);
    if (given.has(g)) throw new Error(`tokens.given holds ${g} twice`);
    given.add(g);
  }
  const held = new Set<string>();
  for (const [id, e] of Object.entries(t.accounts)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(id)) throw new Error(`tokens.accounts is keyed by ${JSON.stringify(id)}, not an OS id`);
    if (!e || typeof e !== "object" || typeof e.token !== "string" || typeof e.name !== "string" || typeof e.interactive !== "boolean") {
      throw new Error(`tokens.accounts.${id} is not a token entry`);
    }
    if (!given.has(e.token)) throw new Error(`tokens.accounts.${id} holds ${e.token}, never given`);
    if (held.has(e.token)) throw new Error(`the token ${e.token} is held twice`);
    held.add(e.token);
  }
  return t as TokenTable;
}
