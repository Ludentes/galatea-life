import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The shortest owner's configuration credential the applier starts with: 16 characters, twice the
 * client credential's schema minimum, since the owner's reaches everything (the whole-applier review's M7).
 */
export const OWNER_CREDENTIAL_MIN_LENGTH = 16;

/** A secret as the store keeps it: the lowercase hex of its SHA-256 (the whole-applier review's M6). */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Whether two credentials are the same, compared in constant time for their length, so the time a
 * refusal takes says nothing about how much of a guess was right. A different length is a miss.
 */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
