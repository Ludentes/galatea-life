import { timingSafeEqual } from "node:crypto";

/**
 * Whether two credentials are the same, compared in constant time for their length, so the time a
 * refusal takes says nothing about how much of a guess was right. A different length is a miss.
 */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
