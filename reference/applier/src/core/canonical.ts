/**
 * JSON with object keys sorted: a document the store gave back (jsonb reorders keys) compares equal
 * to the one given. A key whose value is undefined is left out, as JSON has no undefined, so this is
 * RFC 8785's form for any JSON value (the token's proof relies on it).
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether Postgres can keep every string in `value`, keys included: U+0000 fits neither `text` nor
 * `jsonb`, and `jsonb` refuses a lone surrogate. A statement refused for them would stop the writer,
 * and the applier with it, so nothing a client or a bridge sends that fails this reaches the store.
 */
export function storable(value: unknown): boolean {
  if (typeof value === "string") return !value.includes("\u0000") && value.isWellFormed();
  if (Array.isArray(value)) return value.every(storable);
  if (value && typeof value === "object") return Object.entries(value).every(([k, v]) => storable(k) && storable(v));
  return true;
}
